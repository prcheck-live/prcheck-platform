import { config, RepoConfig } from './config';
import { event, pool } from './db';
import { assess, dispose } from './decide';
import { waitForCommit } from './environment';
import { put } from './evidence-store';
import { commentMarkdown, publish } from './report';
import { changedFiles, jiraKeyFrom } from './sources/github';
import { fetchIssue } from './sources/jira';
import { selectPolicies } from './sources/policies';
import { teamResults } from './sources/xray';
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
    await publish({ assessmentId: id, repo: req.repo, prNumber: req.prNumber, sha: req.headSha, disposition: 'AWAITING_ASSESSMENT', because: 'QIVVRA is assessing this commit' });
  } catch (e) {
    // A reporting failure must never lose the assessment; the final report is attempted at the end.
    await event(id, 'report', `Could not post the pending status: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
  }
  return id;
}

export async function runAssessment(id: string, req: AssessmentRequest) {
  const { repo, headSha: sha } = req;
  try {
    // 1. Gather: GitHub, Jira, Xray and the policy repo, linked by the Jira key
    await status(id, 'gathering');
    const jiraKey = jiraKeyFrom(repo.jira_project, req.title, req.headRef);
    const files = await changedFiles(repo, req.baseRef, sha);
    await event(id, 'gather', `${files.files.length} changed files from ${files.source}`);
    const jira = jiraKey ? await fetchIssue(repo, jiraKey) : null;
    await event(id, 'gather', jira ? `${jira.key} "${jira.summary}" (${jira.status}, ${jira.acceptanceCriteria.length} ACs)` : `No Jira issue for ${jiraKey ?? 'this PR'}`);
    const team = await teamResults(repo, sha, repo.jira_project);
    await event(id, 'gather', team ? `Team tests: ${team.passed}/${team.total} passed (${team.source})` : 'No team test results for this commit');
    const snapshot = selectPolicies(repo, files.files, jiraKey);
    const obligationCount = snapshot.policies.reduce((n, p) => n + p.obligations.length, 0);
    await event(id, 'gather', `${snapshot.policies.length} policies, ${obligationCount} obligations selected (policy repo ${snapshot.policyRepoCommit})`,
      { policies: snapshot.policies.map((p) => `${p.id}@${p.version}`) });

    // 2. Freeze the context. Everything later is judged against exactly this.
    const context = {
      kind: 'qivvra.context/v1', assessmentId: id, repository: repo.github, prNumber: req.prNumber, headSha: sha,
      baseRef: req.baseRef, headRef: req.headRef ?? null, title: req.title ?? null,
      changedFiles: files, jira, teamResults: team, policySnapshot: snapshot, frozenAt: new Date().toISOString(),
    };
    const contextDigest = await put('context', JSON.stringify(context, null, 2));
    await pool.query('UPDATE assessments SET jira_key = $1, context_digest = $2 WHERE id = $3', [jiraKey, contextDigest, id]);
    await event(id, 'freeze', `Context frozen ${contextDigest.slice(0, 19)}…`);

    // 3. Environment: QE must be running this exact commit
    await status(id, 'awaiting_environment');
    const env = await waitForCommit(repo.environment.base_url, sha, repo.environment.wait_for_commit_seconds);
    await event(id, 'environment', env.confirmed ? `${repo.environment.name} runs ${sha}` : `${repo.environment.name} did not report ${sha}`, { observed: env.observed });

    // 4. Verify (skipped if the environment is wrong: such evidence would be about another build)
    let evidence = null, evidenceDigest: string | null = null;
    if (env.confirmed) {
      await status(id, 'verifying');
      const run = await runVerifiers(repo, id, sha);
      evidence = run.record;
      evidenceDigest = await put('evidence', run.raw);
      const states = Object.values(evidence.checks).map((c) => c.state);
      await event(id, 'verify', `${states.length} checks: ${states.filter((s) => s === 'SUPPORTED').length} supported, ${states.filter((s) => s === 'VIOLATED').length} violated, ${states.filter((s) => s === 'NOT_ASSESSED').length} not assessed`);
      await pool.query('UPDATE assessments SET evidence_digest = $1 WHERE id = $2', [evidenceDigest, id]);
    }

    // 5. Decide
    await status(id, 'deciding');
    const results = assess(snapshot, evidence);
    const decision = env.confirmed ? dispose(results) : { disposition: 'INDETERMINATE' as const, because: `${repo.environment.name} is not running ${sha}` };
    for (const r of results) {
      await pool.query(
        `INSERT INTO obligation_results (assessment_id, obligation_id, policy_id, policy_version, authority, severity, statement, evidence_check, state, reason, excepted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, r.obligationId, r.policyId, r.policyVersion, r.authority, r.severity, r.statement, r.check, r.state, r.reason, r.exceptedBy]);
    }
    await event(id, 'decide', `${decision.disposition}: ${decision.because}`);

    // 6. Report back to the PR
    const reportInput = {
      assessmentId: id, repo, prNumber: req.prNumber, sha, disposition: decision.disposition, because: decision.because,
      jira, team, results, digests: { context: contextDigest, evidence: evidenceDigest, policySnapshot: snapshot.snapshotDigest },
      policyCommit: snapshot.policyRepoCommit, verifierCommit: evidence?.verifiers.commit ?? null,
    };
    const reportDigest = await put('report', commentMarkdown(reportInput));
    const published = await publish(reportInput);
    await event(id, 'report', `Status "${published.status.state}" and PR comment sent via ${published.channel}`);

    const count = (s: string) => results.filter((r) => r.state === s).length;
    await pool.query(
      `UPDATE assessments SET status = 'done', disposition = $1, report_digest = $2, finished_at = now(), summary = $3 WHERE id = $4`,
      [decision.disposition, reportDigest, {
        because: decision.because, obligations: results.length, supported: count('SUPPORTED'), violated: count('VIOLATED'),
        insufficient: count('INSUFFICIENT'), notAssessed: count('NOT_ASSESSED'), teamTests: team ? { passed: team.passed, total: team.total } : null,
      }, id]);
    return decision;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await event(id, 'error', message.slice(0, 500));
    await pool.query("UPDATE assessments SET status = 'failed', disposition = 'INDETERMINATE', error = $1, finished_at = now() WHERE id = $2", [message, id]);
    await publish({ assessmentId: id, repo, prNumber: req.prNumber, sha, disposition: 'INDETERMINATE', because: 'QIVVRA could not complete the assessment', results: [], jira: null, team: null,
      digests: { context: '', evidence: null, policySnapshot: '' }, policyCommit: null, verifierCommit: null }).catch(() => undefined);
    return { disposition: 'INDETERMINATE' as const, because: message };
  }
}

/** One assessment at a time per engine: environments are shared, and runs must not interleave. */
let queue: Promise<unknown> = Promise.resolve();
export function enqueue(id: string, req: AssessmentRequest) {
  queue = queue.then(() => runAssessment(id, req));
  return queue;
}
export { config };
