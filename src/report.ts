import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config, RepoConfig } from './config';
import { Disposition, label, ObligationResult } from './decide';
import { githubApi, githubToken } from './sources/github';
import type { JiraIssue } from './sources/jira';
import type { TeamResults } from './sources/xray';

const CONTEXT = 'qivvra/assurance';
const MARKER = '<!-- qivvra-assessment -->';

export interface ReportInput {
  assessmentId: string; repo: RepoConfig; prNumber: number; sha: string;
  disposition: Disposition; because: string;
  jira: JiraIssue | null; team: TeamResults | null; results: ObligationResult[];
  digests: { context: string; evidence: string | null; policySnapshot: string };
  policyCommit: string | null; verifierCommit: string | null;
}

const ICON: Record<string, string> = { SUPPORTED: '✅', VIOLATED: '❌', INSUFFICIENT: '⚠️', CONFLICTED: '⚠️', NOT_ASSESSED: '⏸️' };

export function commentMarkdown(r: ReportInput): string {
  const open = r.results.filter((x) => x.state !== 'SUPPORTED');
  const supported = r.results.length - open.length;
  const team = r.team
    ? `Team tests on this commit: **${r.team.passed}/${r.team.total} passed**${r.jira && r.team.byIssue[r.jira.key] ? ` (${r.jira.key}: ${r.team.byIssue[r.jira.key].passed}/${r.team.byIssue[r.jira.key].total})` : ''}.`
    : 'Team test results for this commit were not found.';
  const lines = [
    MARKER,
    `## QIVVRA: ${label(r.disposition)}`,
    '',
    `Commit \`${r.sha.slice(0, 7)}\` · ${r.jira ? `${r.jira.key} "${r.jira.summary}" (${r.jira.acceptanceCriteria.length} acceptance criteria)` : 'no Jira issue found'}`,
    '',
    `${team} QIVVRA assessed **${r.results.length} obligations** from the policy repository: ${supported} supported, ${open.length} open.`,
    '',
  ];
  if (open.length) {
    lines.push('### What blocks this change', '', '| | Obligation | Owner | Evidence |', '|---|---|---|---|');
    for (const o of open) {
      const why = (o.reason ?? '').split('\n')[0].replace(/^Error:\s*/, '').replace(/\|/g, '/');
      lines.push(`| ${ICON[o.state]} ${o.state} | **${o.obligationId}** ${o.statement} | ${o.owner} | \`${o.check}\`: ${why} |`);
    }
    lines.push('');
  }
  lines.push('<details><summary>All obligations</summary>', '', '| | Obligation | Policy | Check |', '|---|---|---|---|');
  for (const o of r.results) lines.push(`| ${ICON[o.state]} | ${o.obligationId} ${o.statement} | ${o.policyId} v${o.policyVersion} | \`${o.check}\` |`);
  lines.push('', '</details>', '',
    `<sub>Assessment [${r.assessmentId}](${config.server.public_url}/assessments/${r.assessmentId}) · context \`${r.digests.context.slice(0, 19)}…\` · evidence \`${(r.digests.evidence ?? 'none').slice(0, 19)}…\` · policy snapshot \`${r.digests.policySnapshot.slice(0, 19)}…\` (policies ${r.policyCommit ?? '?'}, verifiers ${r.verifierCommit ?? '?'})</sub>`);
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

  if (!githubToken(r.repo)) {
    const dir = join(config.outbox, r.assessmentId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `status-${r.disposition.toLowerCase()}.json`), JSON.stringify({ repo: r.repo.github, sha: r.sha, ...status }, null, 2));
    if (comment) writeFileSync(join(dir, 'pr-comment.md'), comment);
    return { channel: 'outbox', dir, status };
  }
  await githubApi(`/repos/${r.repo.github}/statuses/${r.sha}`, { method: 'POST', body: status }, r.repo);
  if (comment) {
    const existing = (await githubApi(`/repos/${r.repo.github}/issues/${r.prNumber}/comments?per_page=100`, {}, r.repo)) as Array<{ id: number; body: string }>;
    const mine = existing.find((c) => c.body.startsWith(MARKER));
    if (mine) await githubApi(`/repos/${r.repo.github}/issues/comments/${mine.id}`, { method: 'PATCH', body: { body: comment } }, r.repo);
    else await githubApi(`/repos/${r.repo.github}/issues/${r.prNumber}/comments`, { method: 'POST', body: { body: comment } }, r.repo);
  }
  return { channel: 'github', status };
}
