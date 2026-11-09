import { config, RepoConfig } from './config';
import { event, pool } from './db';
import { buildMission, runFunctionalMission, type FunctionalRecord } from './agent-core';
import { assess, dispose, disposeAll } from './decide';
import { waitForCommit } from './environment';
import { put } from './evidence-store';
import { commentMarkdown, publish } from './report';
import { changedFiles, commitSubject, jiraKeyFrom } from './sources/github';
import { fetchIssue } from './sources/jira';
import { requiredEvidence, selectPolicies } from './sources/policies';
import { syncVerifierRequests } from './suites';
import { dispatchSuite, dispatchVerifiers } from './agent-missions';
import { runRegressionMission, selectRegression, type RegressionRecord } from './regression';
import { collectImports, requiredImports, waitForImports, type ImportResult } from './imports';
import { teamResults, waitForTeamResults } from './sources/xray';
import { runVerifiers } from './verify';

export interface AssessmentRequest {
  repo: RepoConfig; prNumber: number; headSha: string; baseRef: string; headRef?: string; title?: string; trigger: string;
}

const status = (id: string, s: string) => pool.query('UPDATE assessments SET status = $1 WHERE id = $2', [s, id]);

/** Creates the assessment row and returns its id; the work itself runs in runAssessment. */
export async function createAssessment(req: AssessmentRequest): Promise<string> {
  const id = 'ASM-' + (await pool.query("SELECT nextval('assessment_seq') AS n")).rows[0].n;
  const jiraKey = jiraKeyFrom(req.repo.jira_project, req.title, req.headRef);
  await pool.query(
    `INSERT INTO assessments (id, repository, pr_number, head_sha, base_ref, head_ref, title, jira_key, status, disposition, triggered_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued','AWAITING_ASSESSMENT',$9)`,
    [id, req.repo.key, req.prNumber, req.headSha, req.baseRef, req.headRef ?? null, req.title ?? null, jiraKey, req.trigger]);
  await event(id, 'intake', `PR #${req.prNumber} ${req.repo.github} @ ${req.headSha} (${jiraKey ?? 'no Jira key'})`, { trigger: req.trigger });
  try {
    await publish({ assessmentId: id, repo: req.repo, prNumber: req.prNumber, sha: req.headSha, disposition: 'AWAITING_ASSESSMENT', because: 'PRCheck.live is assessing this commit' });
  } catch (e) {
    // A reporting failure must never lose the assessment; the final report is attempted at the end.
    await event(id, 'report', `Could not post the pending status: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
  }
  return id;
}

export async function runAssessment(id: string, req: AssessmentRequest) {
  const { repo, headSha: sha } = req;
  try {
    // GitHub statuses need the full commit hash; /version, verifiers and team results use the short one.
    const short = sha.slice(0, 7);

    // 1. Gather: GitHub, Jira and the policy repo, linked by the Jira key
    await status(id, 'gathering');
    const jiraKey = jiraKeyFrom(repo.jira_project, req.title, req.headRef);
    const files = await changedFiles(repo, req.baseRef, sha);
    const headCommit = await commitSubject(repo, sha);
    await event(id, 'gather', `${files.files.length} changed files from ${files.source}${headCommit ? ` · "${headCommit}"` : ''}`);
    const jira = jiraKey ? await fetchIssue(repo, jiraKey) : null;
    await event(id, 'gather', jira ? `${jira.key} "${jira.summary}" (${jira.status}, ${jira.acceptanceCriteria.length} ACs)` : `No Jira issue for ${jiraKey ?? 'this PR'}`);
    const snapshot = selectPolicies(repo, files.files, jiraKey);
    const obligationCount = snapshot.policies.reduce((n, p) => n + p.obligations.length, 0);
    await event(id, 'gather', `${snapshot.policies.length} policies, ${obligationCount} obligations selected (policy repo ${snapshot.policyRepoCommit})`,
      { policies: snapshot.policies.map((p) => `${p.id}@${p.version}`) });
    // New or changed rules whose verifier is not approved yet: requested from the agent core, NOT ASSESSED meanwhile
    const pendingVerifiers = await syncVerifierRequests(repo, snapshot);
    const waiting = Object.values(pendingVerifiers);
    if (waiting.length) await event(id, 'gather', `${waiting.length} obligation${waiting.length > 1 ? 's wait' : ' waits'} for a verifier: ${waiting.map((w) => `${w.obligation} (${w.status})`).join(', ')}`);
    const sentV = await dispatchVerifiers(repo, 'engine').catch(() => []);
    if (sentV.length) await event(id, 'agent-core', `${sentV.length} verifier mission${sentV.length > 1 ? 's' : ''} sent to the agent core`);

    // 2. Environment: QE must be running this exact commit (the deploy usually finishes after the webhook)
    await status(id, 'awaiting_environment');
    const env = await waitForCommit(repo.environment.base_url, short, repo.environment.wait_for_commit_seconds);
    await event(id, 'environment', env.confirmed ? `${repo.environment.name} runs ${short}` : `${repo.environment.name} did not report ${short}`, { observed: env.observed });

    // 3. The team's own results for this commit (Xray input). Waiting here also keeps PRCheck.live's
    //    verifiers from running against QE while the team's suite is still using it.
    const team = env.confirmed ? await waitForTeamResults(repo, short) : await teamResults(repo, short, repo.jira_project);
    await event(id, 'gather', team ? `Team tests: ${team.passed}/${team.total} passed (${team.source})` : 'No team test results for this commit');

    // 4. Freeze the context. Everything later is judged against exactly this.
    const context = {
      kind: 'prcheck.context/v1', assessmentId: id, repository: repo.github, prNumber: req.prNumber, headSha: sha,
      baseRef: req.baseRef, headRef: req.headRef ?? null, title: req.title ?? null,
      changedFiles: files, headCommit, jira, teamResults: team, policySnapshot: snapshot, environment: env, frozenAt: new Date().toISOString(),
    };
    const contextDigest = await put('context', JSON.stringify(context, null, 2));
    await pool.query('UPDATE assessments SET jira_key = $1, context_digest = $2 WHERE id = $3', [jiraKey, contextDigest, id]);
    await event(id, 'freeze', `Context frozen ${contextDigest.slice(0, 19)}…`);

    // 5. Verify (skipped if the environment is wrong: such evidence would be about another build)
    let evidence = null, evidenceDigest: string | null = null;
    if (env.confirmed) {
      await status(id, 'verifying');
      const run = await runVerifiers(repo, id, short);
      evidence = run.record;
      evidenceDigest = await put('evidence', run.raw);
      const states = Object.values(evidence.checks).map((c) => c.state);
      await event(id, 'verify', `${states.length} checks: ${states.filter((s) => s === 'SUPPORTED').length} supported, ${states.filter((s) => s === 'VIOLATED').length} violated, ${states.filter((s) => s === 'NOT_ASSESSED').length} not assessed`);
      await pool.query('UPDATE assessments SET evidence_digest = $1 WHERE id = $2', [evidenceDigest, id]);
    }

    // 5b. Functional lane: the story's acceptance criteria, checked by approved agent-generated checks
    const required = requiredEvidence(repo, snapshot.profile);
    let functional: FunctionalRecord | null = null, functionalDigest: string | null = null;
    if (env.confirmed && repo.functional && jira) {
      const run = await runFunctionalMission(repo, buildMission(repo, id, sha, jira, files.files));
      functional = run.record;
      functionalDigest = await put('functional', run.raw);
      const c = functional.criteria, n = (s: string) => c.filter((x) => x.state === s).length;
      await event(id, 'functional', `${jira.key}: ${c.length} acceptance criteria: ${n('SUPPORTED')} supported, ${n('FAILED')} failed, ${n('NOT_ASSESSED') + n('INCONCLUSIVE')} not yet verified`,
        { core: functional.core, suite: functional.suite?.digest ?? null });
      await pool.query('UPDATE assessments SET functional_digest = $1 WHERE id = $2', [functionalDigest, id]);
      // Criteria without current checks: ask the agent core for them (they count only after proof and approval)
      const missing = functional.criteria.filter((c) => c.suiteStatus === 'none' || c.suiteStatus === 'stale').map((c) => ({ id: `AC${c.position}`, text: c.text }));
      const sentS = missing.length ? await dispatchSuite(repo, jira.key, missing, 'engine').catch(() => null) : null;
      if (sentS) await event(id, 'agent-core', `Suite mission sent to the agent core for ${jira.key} ${missing.map((c) => c.id).join(', ')}`);
    } else if (env.confirmed && required.includes('functional')) {
      await event(id, 'functional', !repo.functional ? 'Functional lane required by the profile but not configured' : 'No Jira story linked: no acceptance criteria to verify');
    }

    // 5c. Regression lane: earlier stories that share a component with this change, re-verified on the same build
    let regression: RegressionRecord | null = null, regressionDigest: string | null = null;
    if (env.confirmed && repo.functional) {
      const imp = await (await import('./regression')).withImpact(repo, selectRegression(repo, snapshot, jira?.key ?? null), files.files, sha);
      const selection = imp.selection;
      if (imp.note) await event(id, 'regression', imp.note);
      await event(id, 'regression', selection.selected.length
        ? `${selection.selected.length} earlier stor${selection.selected.length === 1 ? 'y' : 'ies'} selected (${selection.confidence === 'mapped' ? `components ${selection.changedComponents.join(', ')}` : 'impact unknown: full regression'}): ${selection.selected.map((s) => s.story).join(', ')}`
        : 'No earlier story shares a component with this change', { selection });
      const run = await runRegressionMission(repo, { assessmentId: id, sha, selection, channels: buildMission(repo, id, sha, jira ?? { key: '', summary: '', acceptanceCriteria: [] } as any, files.files).channels });
      regression = run.record;
      regressionDigest = await put('regression', run.raw);
      const all = regression.stories.flatMap((s) => s.criteria), n = (st: string) => all.filter((c) => c.state === st).length;
      if (selection.selected.length) await event(id, 'regression', `${all.length} earlier-story criteria: ${n('SUPPORTED')} supported, ${n('FAILED')} broken, ${n('NOT_ASSESSED') + n('INCONCLUSIVE')} not yet verified`);
      await pool.query('UPDATE assessments SET regression_digest = $1 WHERE id = $2', [regressionDigest, id]);
    }

    // 5d. Imported evidence: results from other tools the profile requires, for this commit
    let imported: ImportResult[] | null = null;
    if (env.confirmed && repo.imports) {
      const specs = requiredImports(repo, snapshot.profile);
      if (specs.length) {
        await waitForImports(repo, sha, specs);
        imported = await collectImports(repo, sha, specs);
        await event(id, 'imported', imported.map((x) => `${x.title}: ${x.state === 'SUPPORTED' ? 'within gate' : x.state === 'FAILED' ? 'outside gate' : 'not received'} (${x.summary})`).join('; '));
      } else imported = [];
    }

    // 6. Decide: every lane the profile requires must be complete ("nothing pending")
    await status(id, 'deciding');
    const results = assess(snapshot, evidence, pendingVerifiers);
    const policyDecision = env.confirmed ? dispose(results) : { disposition: 'INDETERMINATE' as const, because: `${repo.environment.name} is not running ${short}` };
    const decision = env.confirmed
      ? disposeAll(policyDecision, results, required, { story: jira?.key ?? null, configured: !!repo.functional, criteria: functional?.criteria ?? null },
        { configured: !!repo.functional, confidence: regression?.selection.confidence ?? null, stories: regression ? regression.stories.map((s) => ({ story: s.story, because: s.because, criteria: s.criteria })) : null },
        { configured: !!repo.imports, results: imported })
      : { ...policyDecision, lanes: { required, policy: { ...policyDecision, obligations: results.length, supported: 0 }, functional: null, regression: null, imported: null, pending: [] } };
    for (const x of imported ?? []) {
      await pool.query(
        `INSERT INTO imported_results (assessment_id, import_id, title, format, owner, state, summary, gate, measured, findings, digest, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, x.id, x.title, x.format, x.owner, x.state, x.summary, x.gate, x.measured, JSON.stringify(x.findings), x.digest, x.reason]);
    }
    for (const s of regression?.stories ?? []) for (const c of s.criteria) {
      await pool.query(
        `INSERT INTO regression_results (assessment_id, criterion_id, story, position, text, suite_status, checks, state, reason, selected_because)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [id, c.criterionId, s.story, c.position, c.text, c.suiteStatus, c.checks, c.state, c.reason, s.because]);
    }
    for (const c of functional?.criteria ?? []) {
      await pool.query(
        `INSERT INTO criterion_results (assessment_id, criterion_id, story, position, text, text_digest, suite_status, checks, state, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, c.criterionId, c.story, c.position, c.text, c.textDigest, c.suiteStatus, c.checks, c.state, c.reason]);
    }
    for (const r of results) {
      await pool.query(
        `INSERT INTO obligation_results (assessment_id, obligation_id, policy_id, policy_version, authority, severity, statement, evidence_check, state, reason, excepted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, r.obligationId, r.policyId, r.policyVersion, r.authority, r.severity, r.statement, r.check, r.state, r.reason, r.exceptedBy]);
    }
    await event(id, 'decide', `${decision.disposition}: ${decision.because}`);

    // 7. Report back to the PR
    const reportInput = {
      assessmentId: id, repo, prNumber: req.prNumber, sha, disposition: decision.disposition, because: decision.because,
      jira, team, results, criteria: functional?.criteria ?? null, regression: regression?.stories ?? null, imported, lanes: decision.lanes,
      digests: { context: contextDigest, evidence: evidenceDigest, functional: functionalDigest, regression: regressionDigest, policySnapshot: snapshot.snapshotDigest },
      policyCommit: snapshot.policyRepoCommit, verifierCommit: evidence?.verifiers.commit ?? null,
    };
    const reportDigest = await put('report', commentMarkdown(reportInput));
    const published = await publish(reportInput);
    await event(id, 'report', `Status "${published.status.state}" and PR comment sent via ${published.channel}`);

    const count = (s: string) => results.filter((r) => r.state === s).length;
    await pool.query(
      `UPDATE assessments SET status = 'done', disposition = $1, report_digest = $2, finished_at = now(), summary = $3, lanes = $5 WHERE id = $4`,
      [decision.disposition, reportDigest, {
        because: decision.because, obligations: results.length, supported: count('SUPPORTED'), violated: count('VIOLATED'),
        insufficient: count('INSUFFICIENT'), notAssessed: count('NOT_ASSESSED'), teamTests: team ? { passed: team.passed, total: team.total } : null,
        criteria: decision.lanes.functional ? { total: decision.lanes.functional.criteria, supported: decision.lanes.functional.supported, failed: decision.lanes.functional.failed, pending: decision.lanes.functional.pending } : null,
      }, id, decision.lanes]);
    return decision;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await event(id, 'error', message.slice(0, 500));
    await pool.query("UPDATE assessments SET status = 'failed', disposition = 'INDETERMINATE', error = $1, finished_at = now() WHERE id = $2", [message, id]);
    await publish({ assessmentId: id, repo, prNumber: req.prNumber, sha, disposition: 'INDETERMINATE', because: 'PRCheck.live could not complete the assessment', results: [], criteria: null, regression: null, imported: null, lanes: null, jira: null, team: null,
      digests: { context: '', evidence: null, functional: null, regression: null, policySnapshot: '' }, policyCommit: null, verifierCommit: null }).catch(() => undefined);
    return { disposition: 'INDETERMINATE' as const, because: message };
  }
}

/** One assessment at a time per engine: environments are shared, and runs must not interleave. */
let queue: Promise<unknown> = Promise.resolve();
export function enqueue(id: string, req: AssessmentRequest) {
  queue = queue.then(() => runAssessment(id, req));
  return queue;
}
/** Anything else that uses QE (proof runs) waits its turn behind assessments, and they behind it. */
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.catch(() => undefined);
  return p;
}
export { config };
