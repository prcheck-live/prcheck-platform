/**
 * API behind the QIVVRA UI. Everything here needs a signed-in user, and every
 * response is filtered by that user's role and application scope on the server.
 */
import express, { Request, Response, Router } from 'express';
import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { access, Account, ACCOUNTS, can, checkCredentials, checkPassword, clearSession, issueSession, requirePerm, requireUser, seesApp } from './auth';
import { config, path, RepoConfig } from './config';
import { event, pool } from './db';
import { get } from './evidence-store';
import { createAssessment, enqueue } from './pipeline';
import { applications } from './applications';

export const ui = Router();
ui.use(express.json({ limit: '100kb' }));

const publicAccount = (a: Account) => ({ ...a });
const appOf = (repoKey: string) => config.repositories[repoKey]?.app ?? repoKey;
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
  fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'INTERNAL', message: String(e?.message ?? e) }); });

/* ---------- Sign-in ---------- */
let failures = 0;
ui.post('/login/password', (req, res) => {
  const { email, password } = req.body ?? {};
  if (!checkPassword(email, password)) { failures++; return res.status(401).json({ error: 'INVALID_CREDENTIALS', attempts: failures }); }
  const a = ACCOUNTS.find((x) => x.email === String(email).trim().toLowerCase())!;
  res.json({ next: 'code', account: { name: a.name, email: a.email, initials: a.initials } });
});
ui.post('/login', (req, res) => {
  const { email, password, code, remember } = req.body ?? {};
  const a = checkCredentials(email, password, code);
  if (!a) return res.status(401).json({ error: 'INVALID_CODE' });
  failures = 0;
  issueSession(res, a, !!remember);
  res.json({ account: publicAccount(a), access: access(a) });
});
ui.post('/logout', (_req, res) => { clearSession(res); res.json({ ok: true }); });

ui.use(requireUser);

ui.get('/me', (req, res) => {
  const a = req.user!;
  res.json({ account: publicAccount(a), access: access(a), perms: { run: can(a, 'run'), requestRerun: can(a, 'requestRerun'), admin: can(a, 'admin'), platform: can(a, 'platform') } });
});

/* ---------- Changes: one per pull request, one revision per head commit ---------- */
function loadJson(digest: string | null) {
  if (!digest) return { data: null, integrity: 'missing' as const };
  try {
    const raw = get(digest);
    return raw === null ? { data: null, integrity: 'missing' as const } : { data: JSON.parse(raw), integrity: 'sealed' as const };
  } catch { return { data: null, integrity: 'mismatch' as const }; }
}

function verifierCatalog(repo: RepoConfig) {
  try { return parse(readFileSync(join(path(repo.policies.path), 'catalog', 'verifiers.yaml'), 'utf8')).verifiers; } catch { return {}; }
}

async function changesFor(user: Account, only?: { repository: string; pr: number }) {
  const rows = (await pool.query(
    `SELECT * FROM assessments ${only ? 'WHERE repository = $1 AND pr_number = $2' : ''} ORDER BY created_at`, only ? [only.repository, only.pr] : [])).rows;
  const visible = rows.filter((a) => seesApp(user, appOf(a.repository)));
  const ids = visible.map((a) => a.id);
  const [obls, events, reqs] = ids.length ? await Promise.all([
    pool.query('SELECT * FROM obligation_results WHERE assessment_id = ANY($1) ORDER BY obligation_id', [ids]),
    pool.query('SELECT assessment_id, step, message, at FROM assessment_events WHERE assessment_id = ANY($1) ORDER BY id', [ids]),
    pool.query('SELECT * FROM change_requests WHERE assessment_id = ANY($1) ORDER BY created_at', [ids]),
  ]) : [{ rows: [] }, { rows: [] }, { rows: [] }];

  const byChange = new Map<string, any>();
  for (const a of visible) {
    const key = `${a.repository}#${a.pr_number}`;
    const repo = config.repositories[a.repository];
    if (!byChange.has(key)) byChange.set(key, {
      key, repository: a.repository, app: appOf(a.repository), github: repo?.github ?? a.repository, prNumber: a.pr_number,
      environment: repo ? { name: repo.environment.name, baseUrl: repo.environment.base_url } : null,
      catalog: repo ? verifierCatalog(repo) : {}, assessments: [], requests: [] as unknown[],
      sources: repo ? { policies: repo.policies.repository ?? repo.policies.path, verifiers: repo.verifiers.repository ?? repo.verifiers.path } : null,
    });
    const ctx = loadJson(a.context_digest), ev = loadJson(a.evidence_digest);
    const c = ctx.data;
    byChange.get(key).assessments.push({
      id: a.id, status: a.status, disposition: a.disposition, summary: a.summary, error: a.error, trigger: a.triggered_by,
      headSha: a.head_sha, baseRef: a.base_ref, headRef: a.head_ref, title: a.title, jiraKey: a.jira_key,
      createdAt: a.created_at, finishedAt: a.finished_at,
      digests: { context: a.context_digest, evidence: a.evidence_digest, report: a.report_digest },
      integrity: { context: ctx.integrity, evidence: ev.integrity },
      context: c ? { files: c.changedFiles?.files ?? [], headCommit: c.headCommit ?? null, jira: c.jira, team: c.teamResults, environment: c.environment, policy: c.policySnapshot } : null,
      evidence: ev.data ? { checks: ev.data.checks, verifierCommit: ev.data.verifiers?.commit ?? null, environmentConfirmed: ev.data.environmentConfirmed, run: ev.data.run, target: ev.data.target } : null,
      obligations: obls.rows.filter((o) => o.assessment_id === a.id),
      events: events.rows.filter((e) => e.assessment_id === a.id).map((e) => ({ step: e.step, message: e.message, at: e.at })),
    });
  }
  for (const r of reqs.rows) {
    const ch = byChange.get(`${r.repository}#${r.pr_number}`);
    if (ch) ch.requests.push({
      id: Number(r.id), kind: r.kind, assessmentId: r.assessment_id, headSha: r.head_sha, obligationId: r.obligation_id, note: r.note, eta: r.eta,
      status: r.status, by: { email: r.created_by, name: r.created_name }, at: r.created_at,
      resolved: r.resolved_at ? { email: r.resolved_by, name: r.resolved_name, at: r.resolved_at, note: r.resolution } : null,
    });
  }
  return [...byChange.values()];
}

ui.get('/changes', handle(async (req, res) => {
  if (access(req.user!).scope === 'none') return res.status(403).json({ error: 'FORBIDDEN', message: 'Admins configure QIVVRA but do not see change evidence' });
  res.json({ changes: await changesFor(req.user!), now: new Date().toISOString() });
}));

async function visibleAssessment(req: Request, res: Response) {
  const a = (await pool.query('SELECT * FROM assessments WHERE id = $1', [req.params.id])).rows[0];
  if (!a || !seesApp(req.user!, appOf(a.repository)) || access(req.user!).scope === 'none') { res.status(404).json({ error: 'NOT_FOUND' }); return null; }
  return a;
}

/** Assurance Lead re-runs assurance on a revision: a fresh, independent assessment of the same commit. */
ui.post('/assessments/:id/rerun', requirePerm('run'), handle(async (req, res) => {
  const a = await visibleAssessment(req, res); if (!a) return;
  const repo = config.repositories[a.repository];
  const r = { repo, prNumber: a.pr_number, headSha: a.head_sha, baseRef: a.base_ref, headRef: a.head_ref ?? undefined, title: a.title ?? undefined, trigger: `ui:${req.user!.email}` };
  const id = await createAssessment(r);
  await event(id, 'intake', `Re-run started by ${req.user!.name} (${req.user!.sysRole})`);
  // Any open re-run request for this revision is answered by this run.
  const closed = await pool.query(`UPDATE change_requests SET status = 'done', resolved_by = $4, resolved_name = $5, resolved_at = now(), resolution = $6
    WHERE kind = 'rerun' AND status = 'open' AND repository = $1 AND pr_number = $2 AND head_sha = $3 RETURNING created_name`,
    [a.repository, a.pr_number, a.head_sha, req.user!.email, req.user!.name, `Re-run ${id}`]);
  if (closed.rowCount) await event(id, 'request', `Answers the re-run request${closed.rowCount > 1 ? 's' : ''} from ${[...new Set(closed.rows.map((x) => x.created_name))].join(', ')}`);
  enqueue(id, r);
  res.status(202).json({ assessmentId: id });
}));

/* ---------- Contributor requests: re-run, acknowledge, dispute. None of them can change a verdict. ---------- */
const who = (req: Request) => `${req.user!.name} (${req.user!.tagRole})`;
const clean = (v: unknown, max = 1000) => String(v ?? '').trim().slice(0, max);

/** Contributors cannot run assurance; they ask an Assurance Lead to. One open request per revision. */
ui.post('/assessments/:id/request-rerun', requirePerm('requestRerun'), handle(async (req, res) => {
  const a = await visibleAssessment(req, res); if (!a) return;
  const open = (await pool.query("SELECT created_name FROM change_requests WHERE kind = 'rerun' AND status = 'open' AND repository = $1 AND pr_number = $2 AND head_sha = $3",
    [a.repository, a.pr_number, a.head_sha])).rows[0];
  if (open) return res.status(409).json({ error: 'ALREADY_REQUESTED', message: `${open.created_name} already requested a re-run of ${a.head_sha.slice(0, 7)}` });
  const note = clean(req.body?.note);
  const r = await pool.query(`INSERT INTO change_requests (repository, pr_number, head_sha, assessment_id, kind, note, created_by, created_name)
    VALUES ($1,$2,$3,$4,'rerun',$5,$6,$7) RETURNING id`, [a.repository, a.pr_number, a.head_sha, a.id, note || null, req.user!.email, req.user!.name]);
  await event(a.id, 'request', `Re-run requested by ${who(req)}${note ? `: ${note}` : ''}`);
  res.status(201).json({ id: Number(r.rows[0].id) });
}));

async function openFinding(req: Request, res: Response) {
  const a = await visibleAssessment(req, res); if (!a) return null;
  const o = (await pool.query('SELECT obligation_id, state FROM obligation_results WHERE assessment_id = $1 AND obligation_id = $2', [a.id, req.params.obl])).rows[0];
  if (!o) { res.status(404).json({ error: 'NOT_FOUND', message: `No obligation ${req.params.obl} in ${a.id}` }); return null; }
  if (o.state === 'SUPPORTED') { res.status(400).json({ error: 'NOT_A_FINDING', message: `${o.obligation_id} is supported; there is nothing to acknowledge or dispute` }); return null; }
  return a;
}

/** "Seen, fix in progress": shows on the Assurance Lead's queue and the gap. Replaces the Contributor's earlier note for the same finding. */
ui.post('/assessments/:id/findings/:obl/acknowledge', requirePerm('requestRerun'), handle(async (req, res) => {
  const a = await openFinding(req, res); if (!a) return;
  const note = clean(req.body?.note), eta = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.eta ?? '')) ? req.body.eta : null;
  if (!note) return res.status(400).json({ error: 'NOTE_REQUIRED', message: 'Say what is being done about it' });
  const existing = (await pool.query("SELECT id FROM change_requests WHERE kind = 'acknowledge' AND status = 'open' AND repository = $1 AND pr_number = $2 AND head_sha = $3 AND obligation_id = $4",
    [a.repository, a.pr_number, a.head_sha, req.params.obl])).rows[0];
  if (existing) await pool.query('UPDATE change_requests SET note = $2, eta = $3, created_by = $4, created_name = $5, created_at = now() WHERE id = $1', [existing.id, note, eta, req.user!.email, req.user!.name]);
  else await pool.query(`INSERT INTO change_requests (repository, pr_number, head_sha, assessment_id, obligation_id, kind, note, eta, created_by, created_name)
    VALUES ($1,$2,$3,$4,$5,'acknowledge',$6,$7,$8,$9)`, [a.repository, a.pr_number, a.head_sha, a.id, req.params.obl, note, eta, req.user!.email, req.user!.name]);
  await event(a.id, 'request', `${req.params.obl} acknowledged by ${who(req)}: ${note}${eta ? ` (fix expected ${eta})` : ''}`);
  res.status(201).json({ ok: true });
}));

/** "I think this check is wrong": the Assurance Lead must review the verifier and answer. The verdict stands meanwhile. */
ui.post('/assessments/:id/findings/:obl/dispute', requirePerm('requestRerun'), handle(async (req, res) => {
  const a = await openFinding(req, res); if (!a) return;
  const reason = clean(req.body?.reason);
  if (reason.length < 15) return res.status(400).json({ error: 'REASON_REQUIRED', message: 'Explain why the check is wrong (at least 15 characters)' });
  const open = (await pool.query("SELECT created_name FROM change_requests WHERE kind = 'dispute' AND status = 'open' AND repository = $1 AND pr_number = $2 AND head_sha = $3 AND obligation_id = $4",
    [a.repository, a.pr_number, a.head_sha, req.params.obl])).rows[0];
  if (open) return res.status(409).json({ error: 'ALREADY_DISPUTED', message: `${open.created_name} already disputed ${req.params.obl}; the Assurance Lead is reviewing it` });
  await pool.query(`INSERT INTO change_requests (repository, pr_number, head_sha, assessment_id, obligation_id, kind, note, created_by, created_name)
    VALUES ($1,$2,$3,$4,$5,'dispute',$6,$7,$8)`, [a.repository, a.pr_number, a.head_sha, a.id, req.params.obl, reason, req.user!.email, req.user!.name]);
  await event(a.id, 'request', `${req.params.obl} disputed by ${who(req)}: ${reason}`);
  res.status(201).json({ ok: true });
}));

/** The Assurance Lead answers a dispute: the finding stands, or the check will be corrected (in the verifiers repository, by pull request). */
ui.post('/requests/:rid/resolve', requirePerm('run'), handle(async (req, res) => {
  const outcome = req.body?.outcome, note = clean(req.body?.note);
  if (!['upheld', 'check_changed'].includes(outcome)) return res.status(400).json({ error: 'BAD_OUTCOME' });
  if (note.length < 5) return res.status(400).json({ error: 'NOTE_REQUIRED', message: 'Explain the decision' });
  const r = (await pool.query("SELECT * FROM change_requests WHERE id = $1", [req.params.rid])).rows[0];
  if (!r || !seesApp(req.user!, appOf(r.repository))) return res.status(404).json({ error: 'NOT_FOUND' });
  if (r.kind !== 'dispute' || r.status !== 'open') return res.status(400).json({ error: 'NOT_OPEN', message: 'Only an open dispute can be resolved' });
  await pool.query('UPDATE change_requests SET status = $2, resolved_by = $3, resolved_name = $4, resolved_at = now(), resolution = $5 WHERE id = $1',
    [r.id, outcome, req.user!.email, req.user!.name, note]);
  await event(r.assessment_id, 'request', `Dispute on ${r.obligation_id} ${outcome === 'upheld' ? 'answered: the finding stands' : 'accepted: the check will be corrected'} by ${who(req)}: ${note}`);
  res.json({ ok: true });
}));

/* ---------- Platform: integrations, policies and profile (Admin, Assurance Lead) ---------- */
function gitCommit(dir: string) { try { return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } }
function yamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? yamlFiles(p) : /\.ya?ml$/.test(n) && !n.startsWith('_') ? [p] : []; });
}

ui.get('/platform', requirePerm('platform'), handle(async (_req, res) => {
  const repos = await Promise.all(Object.values(config.repositories).map(async (r) => {
    const polDir = path(r.policies.path), verDir = r.verifiers.path ? path(r.verifiers.path) : null;
    const policies = yamlFiles(join(polDir, 'policies')).map((f) => parse(readFileSync(f, 'utf8')));
    const profileId = (() => { try { return parse(readFileSync(join(polDir, 'catalog', 'components.yaml'), 'utf8')).repositories?.[r.key]?.profile; } catch { return null; } })();
    const profile = (() => { try { return profileId ? parse(readFileSync(join(polDir, 'profiles', `${profileId}.yaml`), 'utf8')) : null; } catch { return null; } })();
    const exceptions = yamlFiles(join(polDir, 'exceptions')).map((f) => parse(readFileSync(f, 'utf8')));
    let qe: unknown = null;
    try { qe = await (await fetch(new URL('/version', r.environment.base_url), { signal: AbortSignal.timeout(2000) })).json(); } catch { qe = null; }
    const last = (await pool.query("SELECT max(created_at) AS at, count(*)::int AS n FROM assessments WHERE repository = $1", [r.key])).rows[0];
    const webhook = (await pool.query("SELECT max(received_at) AS at, count(*)::int AS n FROM webhook_deliveries")).rows[0];
    return {
      key: r.key, app: r.app ?? r.key, github: r.github, jiraProject: r.jira_project, origin: r.origin ?? 'file', status: r.status ?? 'active',
      policySource: r.policies.repository ?? r.policies.path, verifierSource: r.verifiers.repository ?? r.verifiers.path,
      sources: r.sources, environment: { ...r.environment, version: qe },
      policyRepo: { path: r.policies.path, commit: gitCommit(polDir), policies, profile, exceptions },
      verifiers: { adapter: r.verifiers.adapter, commit: verDir ? gitCommit(verDir) : null, catalog: verifierCatalog(r) },
      assessments: { count: last.n, lastAt: last.at }, webhooks: { count: webhook.n, lastAt: webhook.at },
    };
  }));
  const evidence = (await pool.query('SELECT count(*)::int AS n, coalesce(sum(bytes),0)::bigint AS b FROM evidence_objects')).rows[0];
  res.json({
    engine: { publicUrl: config.server.public_url, webhookUrl: `${config.server.public_url}/webhooks/github`, reporting: process.env.QIVVRA_GITHUB_TOKEN ? 'GitHub API' : 'Outbox (no token)', engineCommit: gitCommit(config.root) },
    evidence: { objects: evidence.n, bytes: Number(evidence.b), store: config.evidence_store },
    repos,
  });
}));

ui.use('/applications', applications);

ui.get('/users', requirePerm('admin'), (_req, res) => res.json({ users: ACCOUNTS.map(publicAccount) }));
