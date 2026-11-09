/**
 * The agent core, over its mission protocol (docs/agent-core-protocol.md, prcheck.agent-core/v1).
 *
 *   impact    which earlier stories a change can affect (myDelta). Synchronous, with a timeout; PRCheck.live
 *             only ever ADDS stories to its own component-overlap selection, never removes one.
 *   verifier  a check for an obligation no active verifier covers (new or changed rule).
 *   suite     checks for a story's acceptance criteria, first time or after a Lead returned them.
 *
 * Deliveries are applied to the verifiers or suites repository as commits authored by the agent core,
 * always with status "generated". They count only after PRCheck.live proves them and a Lead approves them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { parse, stringify } from 'yaml';
import { config, path, RepoConfig } from './config';
import { event, pool } from './db';
import { commit, GenEntry, readGenerated, serial, suitesRepoDir, verifiersDir, writeGenerated } from './suites';

export const PROTOCOL = 'prcheck.agent-core/v1';
const CORE_AUTHOR = { name: 'myDiya agent core', email: 'agent-core@ascendqe.com' };
export const coreConnected = (r: RepoConfig) => !!r.agent_core?.url;

async function call(r: RepoConfig, method: 'GET' | 'POST', p: string, body?: unknown) {
  const res = await fetch(new URL(p, r.agent_core!.url), {
    method, signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json', ...((r.secrets?.AGENT_CORE_TOKEN ?? process.env.PRCHECK_AGENT_CORE_TOKEN) ? { authorization: `Bearer ${r.secrets?.AGENT_CORE_TOKEN ?? process.env.PRCHECK_AGENT_CORE_TOKEN}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p}: HTTP ${res.status}${json?.message ? ` ${json.message}` : json?.error ? ` ${json.error}` : ''}`);
  return json;
}

/** The core's identity, checked against the protocol and the version the application pins. */
export async function coreInfo(r: RepoConfig): Promise<{ name: string; version: string; protocol: string; missions: string[]; agents: string[]; implementation?: string }> {
  const info = await call(r, 'GET', '/v1/info');
  if (info.protocol !== PROTOCOL) throw new Error(`The core speaks ${info.protocol ?? 'an unknown protocol'}, not ${PROTOCOL}`);
  if (r.agent_core?.version && !String(info.version).startsWith(r.agent_core.version)) throw new Error(`The core is version ${info.version}; this application pins ${r.agent_core.version}`);
  return info;
}

/* ---------- Impact (synchronous) ---------- */
export async function runImpact(r: RepoConfig, payload: object, timeoutMs = 60_000): Promise<{ result: any; core: any; agents: string[] } | null> {
  const info = await coreInfo(r);
  const { id } = await call(r, 'POST', '/v1/missions', { protocol: PROTOCOL, kind: 'impact', payload });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = await call(r, 'GET', `/v1/missions/${id}`);
    if (m.status === 'delivered') return { result: m.result, core: m.core ?? info, agents: m.agents ?? [] };
    if (m.status === 'failed') throw new Error(m.error ?? 'impact mission failed');
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`impact mission ${id} did not finish in ${timeoutMs / 1000} s`);
}

/* ---------- Generation (asynchronous) ---------- */
const openStatuses = ['queued', 'running', 'delivered'];
async function hasOpen(app: string, subject: string) {
  return (await pool.query('SELECT 1 FROM agent_missions WHERE application = $1 AND subject = $2 AND status = ANY($3)', [app, subject, openStatuses])).rowCount! > 0;
}

/** Sends a generation mission and follows it in the background. Returns null when one is already open for the subject. */
export async function dispatch(r: RepoConfig, kind: 'verifier' | 'suite', subject: string, payload: object, by: string): Promise<number | null> {
  if (!coreConnected(r) || await hasOpen(r.key, subject)) return null;
  const row = (await pool.query(`INSERT INTO agent_missions (application, kind, subject, status, requested_by, payload) VALUES ($1,$2,$3,'queued',$4,$5) RETURNING id`,
    [r.key, kind, subject, by, payload])).rows[0].id as number;
  try {
    const info = await coreInfo(r);
    const { id } = await call(r, 'POST', '/v1/missions', { protocol: PROTOCOL, kind, payload });
    await pool.query('UPDATE agent_missions SET core_mission_id = $2, core_version = $3 WHERE id = $1', [row, id, info.version]);
    follow(r, row);
  } catch (e) {
    await pool.query("UPDATE agent_missions SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [row, String((e as Error).message).slice(0, 500)]);
  }
  return row;
}

function follow(r: RepoConfig, row: number) {
  const tick = async () => {
    const m = (await pool.query('SELECT * FROM agent_missions WHERE id = $1', [row])).rows[0];
    if (!m || !openStatuses.includes(m.status)) return;
    try {
      const core = await call(r, 'GET', `/v1/missions/${m.core_mission_id}`);
      if (core.status === 'failed') { await pool.query("UPDATE agent_missions SET status = 'failed', error = $2, agents = $3, finished_at = now() WHERE id = $1", [row, core.error ?? 'failed', core.agents ?? []]); return; }
      if (core.status === 'delivered') {
        const sha = await serial(() => apply(r, m, core));
        await pool.query("UPDATE agent_missions SET status = 'applied', commit_sha = $2, agents = $3, finished_at = now() WHERE id = $1", [row, sha, core.agents ?? []]);
        return;
      }
      if (core.status !== m.status) await pool.query('UPDATE agent_missions SET status = $2, agents = $3 WHERE id = $1', [row, core.status, core.agents ?? []]);
    } catch (e) {
      await pool.query("UPDATE agent_missions SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [row, String((e as Error).message).slice(0, 500)]);
      return;
    }
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 500);
}

/** After a restart, keep following missions that were still open. */
export async function resumeMissions() {
  const open = (await pool.query('SELECT id, application FROM agent_missions WHERE status = ANY($1) AND core_mission_id IS NOT NULL', [openStatuses])).rows;
  for (const m of open) if (config.repositories[m.application]) follow(config.repositories[m.application], Number(m.id));
}

/** Writes a delivery into the repository: the files, and the manifest entries with status "generated". */
async function apply(r: RepoConfig, m: any, core: any): Promise<string | null> {
  const res = core.result ?? {}, by = { core: core.core?.name ?? 'mydiya-agent-core', version: core.core?.version ?? '?', agents: core.agents ?? [] };
  if (m.kind === 'verifier') {
    const dir = verifiersDir(r);
    for (const f of res.files ?? []) { if (!/^generated\/[\w.-]+$/.test(f.path)) throw new Error(`A verifier must be delivered into generated/, not ${f.path}`); write(join(dir, f.path), f.content); }
    const { doc, entries } = readGenerated(r);
    for (const d of res.entries ?? []) {
      let e = entries.find((x: GenEntry) => x.check === d.check);
      if (!e) { e = { obligation: d.obligation ?? '?', policy: d.policy ?? '?', check: d.check, status: 'generated' }; entries.push(e); }
      if (e.status === 'approved') continue;
      Object.assign(e, { file: d.file, status: 'generated', fault: d.fault, generated_by: by, mission: core.id });
      delete e.proof;
    }
    writeGenerated(r, doc);
    return commit(dir, `Deliver ${(res.entries ?? []).map((d: any) => d.check).join(', ')} (agent core mission ${core.id}, ${by.version})`, CORE_AUTHOR, r, 'VERIFIERS');
  }
  if (m.kind === 'suite') {
    const dir = suitesRepoDir(r), story = m.payload.story;
    for (const f of res.files ?? []) { if (!/^functional\/[\w.-]+\.spec\.ts$/.test(f.path)) throw new Error(`A suite spec must be delivered into functional/, not ${f.path}`); write(join(dir, f.path), f.content); }
    const mf = join(dir, 'functional', 'suites', `${story}.yaml`);
    const raw = existsSync(mf) ? readFileSync(mf, 'utf8') : null;
    const head = raw ? raw.split('\n').filter((l) => l.startsWith('#')).join('\n') : `# Suite for ${story}, generated by the agent core.`;
    const man = raw ? parse(raw) : { apiVersion: 'prcheck/v1', kind: 'FunctionalSuite', story, spec: (res.files ?? [])[0]?.path, criteria: [] };
    man.generated_by = by;
    for (const c of res.criteria ?? []) {
      let e = man.criteria.find((x: any) => x.id === c.id);
      if (!e) { e = { id: c.id }; man.criteria.push(e); }
      Object.assign(e, { checks: c.checks, fault: c.fault, status: 'generated', note: c.note, mission: core.id });
      delete e.proof; delete e.approved_by; delete e.approved_at;
    }
    writeFileSync(mf, `${head}\n${stringify(man, { lineWidth: 0 })}`);
    return commit(dir, `Deliver ${story} ${(res.criteria ?? []).map((c: any) => c.id).join(', ')} checks (agent core mission ${core.id}, ${by.version})`, CORE_AUTHOR, r, 'SUITES');
  }
  return null;
}
function write(f: string, content: string) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, content); }

/* ---------- What to ask for ---------- */
function catalogText(r: RepoConfig, check: string): string | null {
  try { const [v, c] = check.split('/'); return parse(readFileSync(join(path(r.policies.path), 'catalog', 'verifiers.yaml'), 'utf8')).verifiers?.[v]?.checks?.[c] ?? null; } catch { return null; }
}

/** Every verifier waiting for the core (requested, or returned by a Lead) gets a mission, once. */
export async function dispatchVerifiers(r: RepoConfig, by: string) {
  if (!coreConnected(r)) return [];
  const sent: number[] = [];
  for (const e of readGenerated(r).entries.filter((x: GenEntry) => x.status === 'requested' || x.status === 'returned')) {
    const id = await dispatch(r, 'verifier', e.check, {
      application: r.key, obligation: e.obligation, policy: e.policy, check: e.check, expectation: catalogText(r, e.check),
      qeUrl: r.environment.base_url, channels: r.channels ?? null, identities: r.verifier_env ?? [], feedback: e.status === 'returned' ? e.feedback ?? null : null,
    }, by);
    if (id) sent.push(id);
  }
  return sent;
}

/** Checks for some of a story's criteria: missing, stale, or returned by a Lead with feedback. */
export async function dispatchSuite(r: RepoConfig, story: string, criteria: Array<{ id: string; text: string }>, by: string, feedback?: string) {
  if (!coreConnected(r) || !criteria.length) return null;
  const dir = suitesRepoDir(r), mf = join(dir, 'functional', 'suites', `${story}.yaml`);
  const man = existsSync(mf) ? parse(readFileSync(mf, 'utf8')) : null;
  const specPath = man?.spec ?? `functional/${story}.spec.ts`;
  return dispatch(r, 'suite', `${story}-${criteria.map((c) => c.id).join('+')}`, {
    application: r.key, story, criteria: criteria.map((c) => c.id), texts: Object.fromEntries(criteria.map((c) => [c.id, c.text])),
    spec: { path: specPath, content: existsSync(join(dir, specPath)) ? readFileSync(join(dir, specPath), 'utf8') : '' },
    qeUrl: r.environment.base_url, channels: r.channels ?? null, identities: r.verifier_env ?? [], feedback: feedback ?? null,
  }, by);
}

export async function missionsFor(app: string) {
  return (await pool.query('SELECT id, kind, subject, core_mission_id, status, core_version, agents, requested_by, requested_at, finished_at, commit_sha, error FROM agent_missions WHERE application = $1 ORDER BY id DESC LIMIT 50', [app])).rows;
}
export { event };
