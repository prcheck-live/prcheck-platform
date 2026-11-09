import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config, RepoConfig } from './config';
import type { CriterionResult } from './agent-core';
import type { RegressionStory } from './regression';
import type { ImportResult } from './imports';
import { Disposition, label, LaneSummary, ObligationResult } from './decide';
import { githubApi, githubToken } from './sources/github';
import type { JiraIssue } from './sources/jira';
import type { TeamResults } from './sources/xray';

const CONTEXT = 'prcheck/assurance';
/** Informational: the functional lane on its own. The required check stays prcheck/assurance, which covers every lane. */
const FUNCTIONAL_CONTEXT = 'prcheck/functional';
const REGRESSION_CONTEXT = 'prcheck/regression';
const IMPORTED_CONTEXT = 'prcheck/imported-evidence';
const MARKER = '<!-- prcheck-assessment -->';

export interface ReportInput {
  assessmentId: string; repo: RepoConfig; prNumber: number; sha: string;
  disposition: Disposition; because: string;
  jira: JiraIssue | null; team: TeamResults | null; results: ObligationResult[];
  criteria: CriterionResult[] | null; regression: RegressionStory[] | null; imported: ImportResult[] | null; lanes: LaneSummary | null;
  digests: { context: string; evidence: string | null; functional: string | null; regression: string | null; policySnapshot: string };
  policyCommit: string | null; verifierCommit: string | null;
}

const ICON: Record<string, string> = { SUPPORTED: '✅', VIOLATED: '❌', FAILED: '❌', INCONCLUSIVE: '⚠️', INSUFFICIENT: '⚠️', CONFLICTED: '⚠️', NOT_ASSESSED: '⏸️' };

export function commentMarkdown(r: ReportInput): string {
  const open = r.results.filter((x) => x.state !== 'SUPPORTED');
  const supported = r.results.length - open.length;
  const team = r.team
    ? `Team tests on this commit: **${r.team.passed}/${r.team.total} passed**${r.jira && r.team.byIssue[r.jira.key] ? ` (${r.jira.key}: ${r.team.byIssue[r.jira.key].passed}/${r.team.byIssue[r.jira.key].total})` : ''}.`
    : 'Team test results for this commit were not found.';
  const lines = [
    MARKER,
    `## PRCheck.live: ${label(r.disposition)}`,
    '',
    `Commit \`${r.sha.slice(0, 7)}\` · ${r.jira ? `${r.jira.key} "${r.jira.summary}" (${r.jira.acceptanceCriteria.length} acceptance criteria)` : 'no Jira issue found'}`,
    '',
    `${team} PRCheck.live assessed **${r.results.length} obligations** from the policy repository: ${supported} supported, ${open.length} open.`,
    '',
  ];
  const fn = r.lanes?.functional;
  if (r.lanes) {
    const lane = (name: string, ok: boolean, bad: boolean, text: string) => `| ${bad ? '❌' : ok ? '✅' : '⏸️'} | ${name} | ${text} |`;
    lines.push('| | Lane | Result |', '|---|---|---|',
      lane('Policy', r.lanes.policy.disposition === 'READY' || r.lanes.policy.disposition === 'READY_WITH_EXCEPTIONS', r.lanes.policy.disposition === 'NOT_READY', `${r.lanes.policy.supported}/${r.lanes.policy.obligations} obligations supported`),
      ...(fn ? [lane(`Functional${fn.story ? ` (${fn.story})` : ''}`, fn.ran && !fn.failed && !fn.pending, fn.failed > 0, fn.ran ? `${fn.supported}/${fn.criteria} acceptance criteria supported${fn.pending ? `, ${fn.pending} not yet verified` : ''}` : fn.because)] : []),
      ...(r.lanes.regression ? [(rg => lane(`Regression${rg.stories.length ? ` (${rg.stories.map((x) => x.story).join(', ')})` : ''}`, rg.ran && !rg.failed && !rg.pending, rg.failed > 0,
        rg.ran ? (rg.stories.length ? `${rg.supported}/${rg.criteria} earlier-story criteria still met${rg.pending ? `, ${rg.pending} not yet verified` : ''}` : rg.because) : rg.because))(r.lanes.regression)] : []),
      ...(r.lanes.imported ? [(im => lane('Imported evidence', im.ran && !im.failed && !im.pending && im.total > 0, im.failed > 0,
        im.items.length ? im.items.map((x) => `${x.state === 'SUPPORTED' ? '✓' : x.state === 'FAILED' ? '✕' : '…'} ${x.title}: ${x.summary}`).join('<br>') : im.because))(r.lanes.imported)] : []),
      '');
    if (r.lanes.pending.length) lines.push(`**Pending, so this cannot be READY:** ${r.lanes.pending.join('; ')}.`, '');
  }
  if (open.length) {
    lines.push('### What blocks this change', '', '| | Obligation | Owner | Evidence |', '|---|---|---|---|');
    for (const o of open) {
      const why = (o.reason ?? '').split('\n')[0].replace(/^Error:\s*/, '').replace(/\|/g, '/');
      lines.push(`| ${ICON[o.state]} ${o.state} | **${o.obligationId}** ${o.statement} | ${o.owner} | \`${o.check}\`: ${why} |`);
    }
    lines.push('');
  }
  const crit = r.criteria ?? [];
  const openCrit = crit.filter((c) => c.state !== 'SUPPORTED');
  if (openCrit.length) {
    lines.push(`### Story promises not met${r.jira ? ` (${r.jira.key})` : ''}`, '', '| | Acceptance criterion | Evidence |', '|---|---|---|');
    for (const c of openCrit) lines.push(`| ${ICON[c.state]} ${c.state.replace('_', ' ')} | **AC${c.position}** ${c.text.replace(/\|/g, '/')} | ${(c.reason ?? '').split('\n')[0].replace(/^Error:\s*/, '').replace(/\|/g, '/')} |`);
    lines.push('');
  }
  const broken = (r.regression ?? []).flatMap((s) => s.criteria.filter((c) => c.state !== 'SUPPORTED').map((c) => ({ s, c })));
  if (broken.length) {
    lines.push('### Earlier stories this change affects', '', '| | Criterion | Why re-verified | Evidence |', '|---|---|---|---|');
    for (const { s, c } of broken) lines.push(`| ${ICON[c.state]} ${c.state.replace('_', ' ')} | **${c.story} AC${c.position}** ${c.text.replace(/\|/g, '/')} | ${s.because.replace(/\|/g, '/')} | ${(c.reason ?? '').split('\n')[0].replace(/^Error:\s*/, '').replace(/\|/g, '/')} |`);
    lines.push('');
  }
  const imBad = (r.imported ?? []).filter((x) => x.state !== 'SUPPORTED');
  if (imBad.length) {
    lines.push('### Required results from other tools', '', '| | Result | Owner | Evidence |', '|---|---|---|---|');
    for (const x of imBad) lines.push(`| ${x.state === 'FAILED' ? '❌ OUTSIDE GATE' : '⏸️ NOT RECEIVED'} | **${x.title}** (${x.format}) | ${x.owner ?? ''} | ${(x.reason ?? x.summary).replace(/\|/g, '/')}${x.findings.filter((f) => !f.suppressed).slice(0, 3).map((f) => `<br>${f.level}: ${f.text.replace(/\|/g, '/')}${f.where ? ` (${f.where})` : ''}`).join('')} |`);
    lines.push('');
  }
  if (crit.length) {
    lines.push('<details><summary>All acceptance criteria</summary>', '', '| | Criterion | Checks |', '|---|---|---|');
    for (const c of crit) lines.push(`| ${ICON[c.state]} | AC${c.position} ${c.text.replace(/\|/g, '/')} | ${c.checks.map((x) => `\`${x}\``).join(' ') || c.suiteStatus} |`);
    lines.push('', '</details>', '');
  }
  lines.push('<details><summary>All obligations</summary>', '', '| | Obligation | Policy | Check |', '|---|---|---|---|');
  for (const o of r.results) lines.push(`| ${ICON[o.state]} | ${o.obligationId} ${o.statement} | ${o.policyId} v${o.policyVersion} | \`${o.check}\` |`);
  lines.push('', '</details>', '',
    `<sub>Assessment [${r.assessmentId}](${config.server.public_url}/assessments/${r.assessmentId}) · context \`${r.digests.context.slice(0, 19)}…\` · evidence \`${(r.digests.evidence ?? 'none').slice(0, 19)}…\` · functional \`${(r.digests.functional ?? 'none').slice(0, 19)}…\` · regression \`${(r.digests.regression ?? 'none').slice(0, 19)}…\` · policy snapshot \`${r.digests.policySnapshot.slice(0, 19)}…\` (policies ${r.policyCommit ?? '?'}, verifiers ${r.verifierCommit ?? '?'})</sub>`);
  return lines.join('\n');
}

function statusFor(d: Disposition, because: string) {
  const state = d === 'READY' || d === 'READY_WITH_EXCEPTIONS' ? 'success' : d === 'AWAITING_ASSESSMENT' ? 'pending' : d === 'INDETERMINATE' ? 'error' : 'failure';
  return { state, description: `${label(d)}: ${because}`.slice(0, 140) };
}

/** Posts the commit status (the required check) and upserts one PR comment. Without a token, writes to the outbox. */
export async function publish(r: ReportInput | { assessmentId: string; repo: RepoConfig; prNumber: number; sha: string; disposition: 'AWAITING_ASSESSMENT'; because: string }) {
  const status = { ...statusFor(r.disposition, r.because), context: CONTEXT, target_url: `${config.server.public_url}/assessments/${r.assessmentId}` };
  const comment = 'results' in r ? commentMarkdown(r) : null;

  const fn = 'lanes' in r && r.lanes?.functional ? r.lanes.functional : null;
  const rg = 'lanes' in r && r.lanes?.regression ? r.lanes.regression : null;
  const rgStatus = rg ? {
    state: rg.failed ? 'failure' : rg.ran && !rg.pending ? 'success' : 'error',
    description: (rg.ran ? (rg.stories.length ? `${rg.supported}/${rg.criteria} earlier-story criteria still met${rg.failed ? `, ${rg.failed} broken` : ''}${rg.pending ? `, ${rg.pending} not verified` : ''}` : rg.because) : rg.because).slice(0, 140),
    context: REGRESSION_CONTEXT, target_url: `${config.server.public_url}/assessments/${r.assessmentId}`,
  } : null;
  const imL = 'lanes' in r && r.lanes?.imported ? r.lanes.imported : null;
  const imStatus = imL && imL.total ? {
    state: imL.failed ? 'failure' : imL.ran && !imL.pending ? 'success' : 'error',
    description: (imL.failed ? `${imL.failed} result${imL.failed > 1 ? 's' : ''} outside the gate` : imL.pending ? `waiting for ${imL.pending} result${imL.pending > 1 ? 's' : ''}` : `${imL.supported}/${imL.total} required results within their gates`).slice(0, 140),
    context: IMPORTED_CONTEXT, target_url: `${config.server.public_url}/assessments/${r.assessmentId}`,
  } : null;
  const fnStatus = fn ? {
    state: fn.failed ? 'failure' : fn.ran && !fn.pending ? 'success' : 'error',
    description: (fn.ran ? `${fn.supported}/${fn.criteria} acceptance criteria supported${fn.failed ? `, ${fn.failed} failed` : ''}${fn.pending ? `, ${fn.pending} not verified` : ''}` : fn.because).slice(0, 140),
    context: FUNCTIONAL_CONTEXT, target_url: status.target_url,
  } : null;

  if (!githubToken(r.repo)) {
    const dir = join(config.outbox, r.assessmentId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `status-${r.disposition.toLowerCase()}.json`), JSON.stringify({ repo: r.repo.github, sha: r.sha, ...status }, null, 2));
    if (fnStatus) writeFileSync(join(dir, 'status-functional.json'), JSON.stringify({ repo: r.repo.github, sha: r.sha, ...fnStatus }, null, 2));
    if (rgStatus) writeFileSync(join(dir, 'status-regression.json'), JSON.stringify({ repo: r.repo.github, sha: r.sha, ...rgStatus }, null, 2));
    if (imStatus) writeFileSync(join(dir, 'status-imported-evidence.json'), JSON.stringify({ repo: r.repo.github, sha: r.sha, ...imStatus }, null, 2));
    if (comment) writeFileSync(join(dir, 'pr-comment.md'), comment);
    return { channel: 'outbox', dir, status };
  }
  await githubApi(`/repos/${r.repo.github}/statuses/${r.sha}`, { method: 'POST', body: status }, r.repo);
  if (fnStatus) await githubApi(`/repos/${r.repo.github}/statuses/${r.sha}`, { method: 'POST', body: fnStatus }, r.repo);
  if (rgStatus) await githubApi(`/repos/${r.repo.github}/statuses/${r.sha}`, { method: 'POST', body: rgStatus }, r.repo);
  if (imStatus) await githubApi(`/repos/${r.repo.github}/statuses/${r.sha}`, { method: 'POST', body: imStatus }, r.repo);
  if (comment) {
    const existing = (await githubApi(`/repos/${r.repo.github}/issues/${r.prNumber}/comments?per_page=100`, {}, r.repo)) as Array<{ id: number; body: string }>;
    const mine = existing.find((c) => c.body.startsWith(MARKER));
    if (mine) await githubApi(`/repos/${r.repo.github}/issues/comments/${mine.id}`, { method: 'PATCH', body: { body: comment } }, r.repo);
    else await githubApi(`/repos/${r.repo.github}/issues/${r.prNumber}/comments`, { method: 'POST', body: { body: comment } }, r.repo);
  }
  return { channel: 'github', status };
}
