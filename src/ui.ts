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
  const [obls, events] = ids.length ? await Promise.all([
    pool.query('SELECT * FROM obligation_results WHERE assessment_id = ANY($1) ORDER BY obligation_id', [ids]),
    pool.query('SELECT assessment_id, step, message, at FROM assessment_events WHERE assessment_id = ANY($1) ORDER BY id', [ids]),
  ]) : [{ rows: [] }, { rows: [] }];

  const byChange = new Map<string, any>();
  for (const a of visible) {
    const key = `${a.repository}#${a.pr_number}`;
    const repo = config.repositories[a.repository];
    if (!byChange.has(key)) byChange.set(key, {
      key, repository: a.repository, app: appOf(a.repository), github: repo?.github ?? a.repository, prNumber: a.pr_number,
      environment: repo ? { name: repo.environment.name, baseUrl: repo.environment.base_url } : null,
      catalog: repo ? verifierCatalog(repo) : {}, assessments: [],
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
  enqueue(id, r);
  res.status(202).json({ assessmentId: id });
}));

/** Contributors cannot run assurance; they ask an Assurance Lead to. */
ui.post('/assessments/:id/request-rerun', requirePerm('requestRerun'), handle(async (req, res) => {
  const a = await visibleAssessment(req, res); if (!a) return;
  await event(a.id, 'request', `Re-run requested by ${req.user!.name} (${req.user!.tagRole})`);
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
    const profile = (() => { try { return parse(readFileSync(join(polDir, 'profiles', 'payments-critical.yaml'), 'utf8')); } catch { return null; } })();
    const exceptions = yamlFiles(join(polDir, 'exceptions')).map((f) => parse(readFileSync(f, 'utf8')));
    let qe: unknown = null;
    try { qe = await (await fetch(new URL('/version', r.environment.base_url), { signal: AbortSignal.timeout(2000) })).json(); } catch { qe = null; }
    const last = (await pool.query("SELECT max(created_at) AS at, count(*)::int AS n FROM assessments WHERE repository = $1", [r.key])).rows[0];
    const webhook = (await pool.query("SELECT max(received_at) AS at, count(*)::int AS n FROM webhook_deliveries")).rows[0];
    return {
      key: r.key, app: r.app ?? r.key, github: r.github, jiraProject: r.jira_project,
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

ui.get('/users', requirePerm('admin'), (_req, res) => res.json({ users: ACCOUNTS.map(publicAccount) }));
