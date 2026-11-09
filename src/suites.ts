/**
 * Trust graduation for agent-generated checks: generated → proven → approved.
 *
 * Two kinds of checks are produced by the agent core and reviewed here by an Assurance Lead:
 *   - verifiers for new or changed policy obligations (policy lane), in the verifiers repository's
 *     generated/ folder until approved, then moved into verifiers/ where they count;
 *   - functional checks per acceptance criterion (functional lane), listed in the suites repository's
 *     functional/suites/<story>.yaml with a status per criterion.
 *
 * PRCheck.live itself never writes test code. It raises requests for missing verifiers, proves what
 * the agent core produced (repeated passes on QE, plus the core's fault proof), and records the Lead's
 * decision as a commit in the repository and a row in suite_reviews. Nothing counts until approved.
 */
import express, { Request, Response, Router } from 'express';
import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { parse, stringify } from 'yaml';
import { criterionDigest } from './agent-core';
import { obligationsIn } from './applications';
import { requirePerm, seesApp } from './auth';
import { config, gitAuth, path, RepoConfig } from './config';
import { pool } from './db';
import { fetchIssue } from './sources/jira';
import type { PolicySnapshot } from './sources/policies';

const run = promisify(execFile);
const PROOF_RUNS = 3;

export type Status = 'requested' | 'generated' | 'proven' | 'approved' | 'returned';
export interface Fault { seeded: string; result: 'FAILED'; by?: string }
export interface Proof { qe: string; at: string; runs: number; passed: number; by: string }
export interface GenEntry {
  obligation: string; policy: string; check: string; file?: string; status: Status;
  requested_at?: string; policy_commit?: string | null;
  generated_by?: { core?: string; version?: string; agents?: string[] }; fault?: Fault; proof?: Proof;
  approved_by?: string; approved_at?: string; feedback?: string;
}

/* ---------- Repositories ---------- */
export const verifiersDir = (r: RepoConfig) => path(r.verifiers.path!);
export const suitesRepoDir = (r: RepoConfig) => path(r.functional?.path ?? r.verifiers.path!);
const genFile = (r: RepoConfig) => join(verifiersDir(r), 'generated', 'manifest.yaml');

export function readGenerated(r: RepoConfig): { doc: any; entries: GenEntry[] } {
  const f = genFile(r);
  if (!existsSync(f)) return { doc: { apiVersion: 'prcheck/v1', kind: 'GeneratedVerifiers', entries: [] }, entries: [] };
  const doc = parse(readFileSync(f, 'utf8')) ?? {};
  doc.entries = doc.entries ?? [];
  return { doc, entries: doc.entries };
}
export function writeGenerated(r: RepoConfig, doc: any) {
  const f = genFile(r);
  mkdirSync(join(f, '..'), { recursive: true });
  const head = existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('#')).join('\n') : '# Verifiers the agent core generated for new or changed policy obligations.';
  writeFileSync(f, `${head}\n${stringify(doc, { lineWidth: 0 })}`);
}

/** Commits a decision to the repository it changes, as the person who made it; pushes when the repository is remote. */
export async function commit(dir: string, message: string, who: { name: string; email: string }, repo: RepoConfig, which: 'VERIFIERS' | 'SUITES') {
  const paths = ['generated', 'verifiers', 'functional'].filter((p) => existsSync(join(dir, p)));
  await run('git', ['-C', dir, 'add', '-A', '--', ...paths]);
  const staged = await run('git', ['-C', dir, 'diff', '--cached', '--quiet']).then(() => false, () => true);
  if (!staged) return null;
  await run('git', ['-C', dir, '-c', `user.name=${who.name}`, '-c', `user.email=${who.email}`, 'commit', '-q', '-m', message]);
  const sha = (await run('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'])).stdout.trim();
  const pull = which === 'VERIFIERS' ? repo.verifiers.pull : repo.functional?.pull;
  if (pull) await run('git', [...gitAuth(repo, which === 'SUITES' && repo.secrets?.SUITES_GIT_TOKEN ? 'SUITES' : 'VERIFIERS'), '-C', dir, 'push', '-q']);
  return sha;
}

/** The checks the active verifiers define, by commit (listing them starts Playwright, so it is cached). */
const listed = new Map<string, Set<string>>();
async function activeChecks(r: RepoConfig): Promise<Set<string>> {
  const dir = verifiersDir(r);
  const head = (await run('git', ['-C', dir, 'rev-parse', 'HEAD']).catch(() => ({ stdout: String(Date.now()) }))).stdout.trim();
  const key = `${dir}@${head}`;
  if (!listed.has(key)) {
    const { stdout } = await run('npx', ['playwright', 'test', '--list', '--reporter=list'], { cwd: dir, timeout: 120_000, env: { ...process.env, BASE_URL: 'http://127.0.0.1:9' } });
    listed.set(key, new Set([...stdout.matchAll(/\b(V\d+\/[a-z0-9-]+)/gi)].map((m) => m[1])));
  }
  return listed.get(key)!;
}

let lock: Promise<unknown> = Promise.resolve();
export const serial = <T>(fn: () => Promise<T>): Promise<T> => { const p = lock.then(fn, fn); lock = p.catch(() => undefined); return p; };

/**
 * New rules get verifiers on the fly: every obligation whose check no active verifier defines is
 * requested from the agent core (an entry in generated/manifest.yaml, which the core watches).
 * Returns the obligations still waiting, keyed by check, so the assessment marks them NOT ASSESSED.
 */
export async function syncVerifierRequests(r: RepoConfig, snapshot: Pick<PolicySnapshot, 'policies' | 'policyRepoCommit'>, who = { name: 'PRCheck.live', email: 'engine@prcheck.live' }) {
  return serial(async () => {
    const active = await activeChecks(r);
    const { doc, entries } = readGenerated(r);
    const pending: Record<string, GenEntry> = {};
    let added = 0;
    for (const p of snapshot.policies) for (const o of p.obligations) {
      const check = `${o.verifier}/${o.check}`;
      if (active.has(check)) continue;
      let e = entries.find((x) => x.check === check);
      if (!e) {
        e = { obligation: o.id, policy: p.id, check, status: 'requested', requested_at: new Date().toISOString(), policy_commit: snapshot.policyRepoCommit };
        entries.push(e); added++;
      }
      pending[check] = e;
    }
    if (added) {
      writeGenerated(r, doc);
      await commit(verifiersDir(r), `Request ${added} verifier${added > 1 ? 's' : ''} from the agent core: ${Object.values(pending).filter((e) => e.status === 'requested').map((e) => e.obligation).join(', ')}`, who, r, 'VERIFIERS');
    }
    return pending;
  });
}

/* ---------- Reading what the Lead reviews ---------- */
/** The source of one test, so the Lead reads the code before approving it. */
function testSource(file: string, title: string): string | null {
  if (!existsSync(file)) return null;
  const src = readFileSync(file, 'utf8');
  const at = src.indexOf(`test('${title}'`);
  if (at < 0) return null;
  const next = src.indexOf('\ntest(', at + 1);
  return src.slice(at, next < 0 ? undefined : next).trimEnd();
}
function specHelpers(file: string): string | null {
  if (!existsSync(file)) return null;
  const src = readFileSync(file, 'utf8'), first = src.indexOf('\ntest(');
  return first > 0 ? src.slice(0, first).trim() : null;
}

async function qeVersion(r: RepoConfig): Promise<string | null> {
  try { return (await (await fetch(new URL('/version', r.environment.base_url), { signal: AbortSignal.timeout(4000) })).json()).gitSha ?? null; } catch { return null; }
}

async function overview(r: RepoConfig) {
  // Verifiers for new rules
  const { entries } = readGenerated(r);
  const polDir = path(r.policies.path);
  const allObls = obligationsIn(polDir);
  const active = await activeChecks(r).catch(() => new Set<string>());
  const missing = allObls.filter((o) => !active.has(o.check) && !entries.some((e) => e.check === o.check));
  const verifiers = entries.map((e) => {
    const file = e.file ? join(verifiersDir(r), e.status === 'approved' ? e.file.replace(/^generated\//, 'verifiers/') : e.file) : null;
    const pol = allObls.find((o) => o.id === e.obligation);
    return { ...e, statement: pol ? polStatement(polDir, e.policy, e.obligation) : null, active: active.has(e.check),
      code: file ? testSource(file, e.check) : null, helpers: file && e.status !== 'approved' ? specHelpers(file) : null };
  });
  // Functional suites per story
  const sdir = join(suitesRepoDir(r), 'functional', 'suites');
  const stories = [];
  if (r.functional && existsSync(sdir)) {
    for (const n of require('fs').readdirSync(sdir).filter((x: string) => /\.ya?ml$/.test(x)).sort()) {
      const m = parse(readFileSync(join(sdir, n), 'utf8'));
      const issue = await fetchIssue(r, m.story).catch(() => null);
      const spec = join(suitesRepoDir(r), m.spec);
      stories.push({
        story: m.story, summary: issue?.summary ?? null, file: `functional/suites/${n}`, spec: m.spec, generatedBy: m.generated_by ?? null,
        criteria: (m.criteria ?? []).map((c: any) => {
          const idx = Number(String(c.id).replace(/\D/g, '')) - 1, text = issue?.acceptanceCriteria[idx] ?? null;
          return { ...c, text, stale: text !== null && criterionDigest(text) !== c.text_digest,
            code: (c.checks ?? []).map((k: string) => ({ check: k, source: testSource(spec, k) })) };
        }),
      });
    }
  }
  const am = await import('./agent-missions');
  const missions = await am.missionsFor(r.key);
  let core: unknown = null;
  if (am.coreConnected(r)) { try { core = await am.coreInfo(r); } catch (e) { core = { error: String((e as Error).message) }; } }
  return { key: r.key, name: r.app ?? r.key, qe: await qeVersion(r), verifiers, missing, stories, missions, core,
    repos: { verifiers: r.verifiers.repository ?? r.verifiers.path, suites: r.functional ? (r.functional.repository ?? r.functional.path) : null } };
}
function polStatement(dir: string, policy: string, obligation: string): string | null {
  try {
    const f = require('fs').readdirSync(join(dir, 'policies'), { recursive: true }).map((x: string) => join(dir, 'policies', x)).find((x: string) => x.endsWith('.yaml') && x.includes(policy));
    return (parse(readFileSync(f, 'utf8')).obligations ?? []).find((o: any) => o.id === obligation)?.statement ?? null;
  } catch { return null; }
}

/* ---------- Proof: the check passes every time on the QE build, and the agent core showed it fails on a broken one ---------- */
async function proofRuns(r: RepoConfig, cfg: string, target: string, checks: string[], qe: string) {
  const dir = cfg === 'playwright.generated.config.ts' ? verifiersDir(r) : suitesRepoDir(r);
  const grep = checks.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const env = {
    ...process.env, ...Object.fromEntries((r.verifier_env ?? []).filter((k) => r.secrets?.[k] !== undefined).map((k) => [k, r.secrets![k]])),
    BASE_URL: r.environment.base_url, EXPECTED_SHA: qe.slice(0, 7),
  };
  const runs: Array<Record<string, string>> = [];
  for (let i = 0; i < PROOF_RUNS; i++) {
    const out = join(config.root, 'data', 'proofs', `${Date.now()}-${i}`);
    mkdirSync(out, { recursive: true });
    await run('npx', ['playwright', 'test', '-c', cfg, target, '--grep', grep], { cwd: dir, timeout: 600_000, env: { ...env, EVIDENCE_DIR: out } }).catch(() => undefined);
    const f = join(out, 'functional.json');
    const ev = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { checks: {} };
    runs.push(Object.fromEntries(checks.map((c) => [c, ev.checks[c]?.state ?? 'NOT_RUN'])));
  }
  return runs;
}

/* ---------- API (mounted at /api/ui/suites, Assurance Lead) ---------- */
export const suites = Router();
suites.use(express.json({ limit: '50kb' }));
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
  fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'INTERNAL', message: String(e?.message ?? e).slice(0, 400) }); });
const review = (app: string, kind: string, subject: string, action: string, result: string, data: object, who: string) =>
  pool.query('INSERT INTO suite_reviews (application, kind, subject, action, result, data, by_email) VALUES ($1,$2,$3,$4,$5,$6,$7)', [app, kind, subject, action, result, data, who]);

suites.get('/', requirePerm('run'), handle(async (req, res) => {
  const apps = Object.values(config.repositories).filter((r) => seesApp(req.user!, r.key) && r.verifiers.path);
  const reviews = (await pool.query('SELECT * FROM suite_reviews ORDER BY id DESC LIMIT 100')).rows;
  res.json({ applications: await Promise.all(apps.map(overview)), reviews });
}));

function appFor(req: Request, res: Response): RepoConfig | null {
  const r = config.repositories[req.params.app];
  if (!r || !seesApp(req.user!, r.key)) { res.status(404).json({ error: 'NOT_FOUND' }); return null; }
  return r;
}
const who = (req: Request) => ({ name: req.user!.name, email: req.user!.email });

/** Verifier for a new rule: prove, approve (moves it into verifiers/, where it counts), or return it to the agent core. */
suites.post('/:app/verifiers/:action', requirePerm('run'), handle(async (req, res) => {
  const r = appFor(req, res); if (!r) return;
  const { check, note } = req.body ?? {};
  const action = req.params.action;
  await serial(async () => {
    const { doc, entries } = readGenerated(r);
    const e = entries.find((x) => x.check === check);
    if (!e) return res.status(404).json({ error: 'NOT_FOUND', message: `No generated verifier ${check}` });
    if (action === 'prove') {
      if (!['generated', 'proven'].includes(e.status) || !e.file) return res.status(409).json({ error: 'NOT_GENERATED', message: `${check} is ${e.status}: the agent core has not delivered it yet` });
      const qe = await qeVersion(r);
      if (!qe) return res.status(409).json({ error: 'QE_DOWN', message: `${r.environment.base_url} does not report its build` });
      const runs = await (await import('./pipeline')).exclusive(() => proofRuns(r, 'playwright.generated.config.ts', e.file!.replace(/^generated\//, ''), [check], qe));
      const passed = runs.filter((x) => x[check] === 'SUPPORTED').length;
      const ok = passed === PROOF_RUNS && !!e.fault;
      e.proof = { qe, at: new Date().toISOString(), runs: PROOF_RUNS, passed, by: req.user!.email };
      if (ok) e.status = 'proven';
      writeGenerated(r, doc);
      const sha = await commit(verifiersDir(r), `Proof of ${check} for ${e.obligation}: ${passed}/${PROOF_RUNS} passes on QE ${qe}${ok ? ', proven' : ''}`, who(req), r, 'VERIFIERS');
      await review(r.key, 'verifier', check, 'prove', ok ? 'proven' : 'not_proven', { runs, qe, commit: sha, fault: e.fault ?? null }, req.user!.email);
      return res.json({ status: e.status, proof: e.proof, runs, proven: ok,
        message: ok ? `Proven: passed ${PROOF_RUNS} of ${PROOF_RUNS} runs on ${qe}, and the agent core showed it fails on a broken build.`
          : !e.fault ? 'Not proven: the agent core has not shown this check fails on a broken build.' : `Not proven: passed ${passed} of ${PROOF_RUNS} runs on ${qe}.` });
    }
    if (action === 'approve') {
      if (e.status !== 'proven') return res.status(409).json({ error: 'NOT_PROVEN', message: 'Only a proven verifier can be approved' });
      if (!note || String(note).trim().length < 5) return res.status(400).json({ error: 'NOTE_REQUIRED', message: 'Say what you reviewed (at least 5 characters)' });
      // A spec file moves into verifiers/ as a whole, so every check in it must be proven, and all are approved together.
      const siblings = entries.filter((x) => x.file === e.file && x.status !== 'approved');
      const unproven = siblings.filter((x) => x.status !== 'proven');
      if (unproven.length) return res.status(409).json({ error: 'SIBLINGS_NOT_PROVEN', message: `${e.file} also holds ${unproven.map((x) => `${x.check} (${x.status})`).join(', ')}. Prove ${unproven.length > 1 ? 'them' : 'it'} first: the file is approved as a whole.` });
      const from = join(verifiersDir(r), e.file!), to = join(verifiersDir(r), e.file!.replace(/^generated\//, 'verifiers/'));
      if (existsSync(to)) return res.status(409).json({ error: 'EXISTS', message: `${to} already exists in verifiers/` });
      renameSync(from, to);
      for (const x of siblings) Object.assign(x, { status: 'approved', approved_by: req.user!.email, approved_at: new Date().toISOString().slice(0, 10), feedback: String(note).trim() });
      writeGenerated(r, doc);
      const names = siblings.map((x) => x.check), obls = siblings.map((x) => x.obligation);
      const sha = await commit(verifiersDir(r), `Approve verifier${names.length > 1 ? 's' : ''} ${names.join(', ')} for ${obls.join(', ')}\n\n${String(note).trim()}\nApproved by ${req.user!.name} (Assurance Lead)`, who(req), r, 'VERIFIERS');
      for (const x of siblings) await review(r.key, 'verifier', x.check, 'approve', 'approved', { note, commit: sha, file: e.file }, req.user!.email);
      return res.json({ status: e.status, commit: sha, approved: names, message: `${names.join(' and ')} now count${names.length > 1 ? '' : 's'}: ${obls.join(' and ')} ${obls.length > 1 ? 'are' : 'is'} assessed on the next assessment.` });
    }
    if (action === 'return') {
      if (!note || String(note).trim().length < 10) return res.status(400).json({ error: 'NOTE_REQUIRED', message: 'Tell the agent core what to change (at least 10 characters)' });
      if (e.status === 'approved') return res.status(409).json({ error: 'APPROVED', message: 'Approved verifiers are changed by pull request to the verifiers repository' });
      Object.assign(e, { status: 'returned', feedback: String(note).trim() });
      delete e.proof;
      writeGenerated(r, doc);
      const sha = await commit(verifiersDir(r), `Return ${check} to the agent core: ${String(note).trim()}`, who(req), r, 'VERIFIERS');
      await review(r.key, 'verifier', check, 'return', 'returned', { note, commit: sha }, req.user!.email);
      const sent = await (await import('./agent-missions')).dispatchVerifiers(r, req.user!.email);
      return res.json({ status: e.status, commit: sha, missions: sent, message: sent.length ? 'Returned to the agent core with your note. A mission is on its way; the regenerated check appears here when it is delivered.' : 'Returned to the agent core with your note. It regenerates the check.' });
    }
    return res.status(400).json({ error: 'BAD_ACTION' });
  });
}));

/** Functional checks for one acceptance criterion: prove, approve, or return. */
suites.post('/:app/stories/:story/:ac/:action', requirePerm('run'), handle(async (req, res) => {
  const r = appFor(req, res); if (!r) return;
  if (!r.functional) return res.status(404).json({ error: 'NO_SUITES' });
  const { story, ac, action } = req.params, note = String(req.body?.note ?? '').trim();
  const f = join(suitesRepoDir(r), 'functional', 'suites', `${story}.yaml`);
  if (!existsSync(f)) return res.status(404).json({ error: 'NOT_FOUND', message: `No suite for ${story}` });
  await serial(async () => {
    const raw = readFileSync(f, 'utf8'), m = parse(raw), head = raw.split('\n').filter((l) => l.startsWith('#')).join('\n');
    const c = (m.criteria ?? []).find((x: any) => x.id === ac);
    if (!c) return res.status(404).json({ error: 'NOT_FOUND', message: `${story} has no ${ac} in its suite` });
    const save = async (msg: string) => { writeFileSync(f, `${head}\n${stringify(m, { lineWidth: 0 })}`); return commit(suitesRepoDir(r), msg, who(req), r, 'SUITES'); };
    const subject = `${story}-${ac}`;
    if (action === 'prove') {
      if (!['generated', 'proven'].includes(c.status)) return res.status(409).json({ error: 'NOT_GENERATED', message: `${ac} checks are ${c.status}` });
      const qe = await qeVersion(r);
      if (!qe) return res.status(409).json({ error: 'QE_DOWN', message: `${r.environment.base_url} does not report its build` });
      const runs = await (await import('./pipeline')).exclusive(() => proofRuns(r, 'playwright.functional.config.ts', m.spec, c.checks, qe));
      const passed = runs.filter((x) => c.checks.every((k: string) => x[k] === 'SUPPORTED')).length;
      const ok = passed === PROOF_RUNS && !!c.fault;
      c.proof = { qe, at: new Date().toISOString(), runs: PROOF_RUNS, passed, by: req.user!.email };
      if (ok) c.status = 'proven';
      const sha = await save(`Proof of ${story} ${ac}: ${passed}/${PROOF_RUNS} passes on QE ${qe}${ok ? ', proven' : ''}`);
      await review(r.key, 'criterion', subject, 'prove', ok ? 'proven' : 'not_proven', { runs, qe, commit: sha, fault: c.fault ?? null }, req.user!.email);
      return res.json({ status: c.status, proof: c.proof, runs, proven: ok,
        message: ok ? `Proven: passed ${PROOF_RUNS} of ${PROOF_RUNS} runs on ${qe}, and the agent core showed they fail on a broken build.`
          : !c.fault ? 'Not proven: the agent core has not shown these checks fail on a broken build.' : `Not proven: passed ${passed} of ${PROOF_RUNS} runs on ${qe}. If this build does not meet ${ac} yet, prove on a build that does.` });
    }
    if (action === 'approve') {
      if (c.status !== 'proven') return res.status(409).json({ error: 'NOT_PROVEN', message: 'Only proven checks can be approved' });
      if (note.length < 5) return res.status(400).json({ error: 'NOTE_REQUIRED', message: 'Say what you reviewed (at least 5 characters)' });
      const issue = await fetchIssue(r, story);
      const text = issue?.acceptanceCriteria[Number(ac.replace(/\D/g, '')) - 1];
      if (!text) return res.status(409).json({ error: 'NO_CRITERION', message: `${story} has no ${ac} in Jira now` });
      Object.assign(c, { status: 'approved', text_digest: criterionDigest(text), approved_by: req.user!.email, approved_at: new Date().toISOString().slice(0, 10) });
      const sha = await save(`Approve ${story} ${ac} checks: ${c.checks.join(', ')}\n\n${note}\nApproved by ${req.user!.name} (Assurance Lead)`);
      await review(r.key, 'criterion', subject, 'approve', 'approved', { note, commit: sha, text_digest: c.text_digest }, req.user!.email);
      return res.json({ status: c.status, commit: sha, message: `${story} ${ac} now counts on the next assessment.` });
    }
    if (action === 'return') {
      if (note.length < 10) return res.status(400).json({ error: 'NOTE_REQUIRED', message: 'Tell the agent core what to change (at least 10 characters)' });
      if (c.status === 'approved') return res.status(409).json({ error: 'APPROVED', message: 'Approved checks are changed by pull request to the suites repository' });
      c.status = 'returned'; c.feedback = note; delete c.proof;
      const sha = await save(`Return ${story} ${ac} checks to the agent core: ${note}`);
      await review(r.key, 'criterion', subject, 'return', 'returned', { note, commit: sha }, req.user!.email);
      const issue = await fetchIssue(r, story).catch(() => null), text = issue?.acceptanceCriteria[Number(ac.replace(/\D/g, '')) - 1] ?? '';
      const sent = await (await import('./agent-missions')).dispatchSuite(r, story, [{ id: ac, text }], req.user!.email, note);
      return res.json({ status: c.status, commit: sha, missions: sent ? [sent] : [], message: sent ? 'Returned to the agent core with your note. A mission is on its way; the regenerated checks appear here when they are delivered.' : 'Returned to the agent core with your note. It regenerates the checks.' });
    }
    return res.status(400).json({ error: 'BAD_ACTION' });
  });
}));

/** Requests verifiers for every obligation in the policy repository that has none yet, without waiting for an assessment. */
suites.post('/:app/verifiers-request', requirePerm('run'), handle(async (req, res) => {
  const r = appFor(req, res); if (!r) return;
  const dir = path(r.policies.path);
  const byPolicy = new Map<string, Array<{ id: string; statement: string; verifier: string; check: string }>>();
  for (const o of obligationsIn(dir)) {
    const [verifier, check] = o.check.split('/');
    byPolicy.set(o.policy, [...(byPolicy.get(o.policy) ?? []), { id: o.id, statement: '', verifier, check }]);
  }
  const commitId = (await run('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']).catch(() => ({ stdout: '' }))).stdout.trim() || null;
  const pending = await syncVerifierRequests(r, { policyRepoCommit: commitId, policies: [...byPolicy].map(([id, obligations]) => ({ id, obligations })) as any }, who(req));
  const sent = await (await import('./agent-missions')).dispatchVerifiers(r, req.user!.email);
  res.json({ pending: Object.values(pending).map((e) => ({ obligation: e.obligation, check: e.check, status: e.status })), missions: sent });
}));
