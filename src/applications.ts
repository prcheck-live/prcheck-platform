/**
 * Onboarding an application: what an Admin gives PRCheck.live, how each part is tested
 * before it is saved, and how saved applications join the ones in prcheck.config.yaml.
 *
 * An application is valid only when every connection works for real: the GitHub
 * repository answers, the Jira project exists, the policy repository validates and
 * registers this application, the verifiers cover the policy's obligations, and
 * the QE environment reports its commit at /version.
 */
import express, { Request, Response, Router } from 'express';
import { execFile } from 'child_process';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs';
import { isAbsolute, join } from 'path';
import { promisify } from 'util';
import { parse } from 'yaml';
import { requirePerm } from './auth';
import { config, path as cfgPath, registerRepo, RepoConfig } from './config';
import { pool } from './db';
import { open, seal } from './secrets';
import { githubApi } from './sources/github';
import { commitLabel, XRAY_CLOUD, xrayGraphql, xrayToken } from './sources/xray';

const run = promisify(execFile);

/* ---------- What the Admin gives ---------- */
export interface Draft {
  key: string;
  name: string;
  /** org: the organisation's GitHub App / token on the engine; token: a token for this repository; local-git: demo. ('api' = org, older drafts.) */
  github: { repository: string; base_branch: string; adapter: 'org' | 'token' | 'api' | 'local-git'; token?: string; path?: string };
  jira: { project: string; adapter: 'cloud' | 'file'; base_url?: string; email?: string; token?: string; path?: string };
  /** cloud: Xray Cloud API; junit: result files on the engine host (demo). */
  xray: { adapter?: 'cloud' | 'junit'; base_url?: string; client_id?: string; client_secret?: string; path?: string; wait_seconds: number };
  policies: { source: string; token?: string };
  verifiers: { source: string; token?: string };
  environment: { name: string; base_url: string; wait_for_commit_seconds: number; log_path?: string };
  /** What the functional and regression lanes test on the QE build: UI, API and MCP. */
  channels?: {
    ui?: { enabled?: boolean; url?: string; browsers?: string[] };
    api?: { enabled?: boolean; base_url?: string; spec?: string };
    mcp?: { enabled?: boolean; url?: string; token?: string };
  };
  /**
   * Functional and regression automation. The suites that decide the verdict live in a repository
   * PRCheck.live owns; the team's automation repository is optional and read-only (the agents learn from it).
   */
  automation?: {
    suites?: { source?: string; token?: string };
    core?: { adapter?: 'frozen-suites' | 'agent-core'; version?: string; budget_seconds?: number; url?: string; token?: string };
    team?: { source?: string; token?: string };
    /** Where the team's CI writes results from other tools: <path>/<commit>/<id>.json */
    imports?: { path?: string; wait_seconds?: number };
  };
  identities: Array<{ name: string; value?: string }>;
}
export const STEPS = ['application', 'github', 'jira', 'xray', 'policies', 'verifiers', 'environment', 'channels', 'automation', 'identities'] as const;
type Step = typeof STEPS[number];
type Status = 'pass' | 'warn' | 'fail';
interface Check { label: string; status: Status; detail?: string }
export interface StepResult { step: Step; status: Status; checks: Check[]; found?: Record<string, unknown> }

/** Values that are secrets: never stored in `config`, never returned to the browser. */
function secretsOf(d: Draft): Record<string, string> {
  const s: Record<string, string> = {};
  if (d.github?.token) s.GITHUB_TOKEN = d.github.token;
  if (d.jira?.token) s.JIRA_TOKEN = d.jira.token;
  if (d.xray?.client_secret) s.XRAY_CLIENT_SECRET = d.xray.client_secret;
  if (d.policies?.token) s.POLICIES_GIT_TOKEN = d.policies.token;
  if (d.verifiers?.token) s.VERIFIERS_GIT_TOKEN = d.verifiers.token;
  if (d.automation?.suites?.token) s.SUITES_GIT_TOKEN = d.automation.suites.token;
  if (d.automation?.team?.token) s.TEAM_GIT_TOKEN = d.automation.team.token;
  if (d.channels?.mcp?.token) s.MCP_TOKEN = d.channels.mcp.token;
  if (d.automation?.core?.token) s.AGENT_CORE_TOKEN = d.automation.core.token;
  for (const i of d.identities ?? []) if (i.name && i.value) s[i.name] = i.value;
  return s;
}
function withoutSecrets(d: Draft): Draft {
  return {
    ...d,
    github: { ...d.github, token: undefined }, xray: { ...d.xray, client_secret: undefined },
    jira: { ...d.jira, token: undefined }, policies: { ...d.policies, token: undefined }, verifiers: { ...d.verifiers, token: undefined },
    channels: d.channels ? { ...d.channels, mcp: d.channels.mcp ? { ...d.channels.mcp, token: undefined } : undefined } : undefined,
    automation: d.automation ? { ...d.automation, suites: { ...d.automation.suites, token: undefined }, team: { ...d.automation.team, token: undefined }, core: { ...d.automation.core, token: undefined } } : undefined,
    identities: (d.identities ?? []).map((i) => ({ name: i.name })),
  };
}

const isUrl = (s: string) => /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(s);
type Src = 'policies' | 'verifiers' | 'suites' | 'team';
const checkoutDir = (key: string, which: Src) => join(config.root, 'data', 'checkouts', key, which);
const localPath = (p: string) => (isAbsolute(p) ? p : cfgPath(p));
const srcOf = (d: Draft, which: Src) => ((which === 'suites' ? d.automation?.suites?.source : which === 'team' ? d.automation?.team?.source : d[which]?.source) ?? '').trim();
const sourceDir = (d: Draft, which: Src) => (isUrl(srcOf(d, which)) ? checkoutDir(d.key, which) : localPath(srcOf(d, which)));
const SRC_TOKEN: Record<Src, string> = { policies: 'POLICIES_GIT_TOKEN', verifiers: 'VERIFIERS_GIT_TOKEN', suites: 'SUITES_GIT_TOKEN', team: 'TEAM_GIT_TOKEN' };

export function toRepoConfig(d: Draft, secrets: Record<string, string>, status: 'active' | 'paused'): RepoConfig {
  return {
    key: d.key, app: d.name, origin: 'ui', status, secrets,
    github: d.github.repository, base_branch: d.github.base_branch, jira_project: d.jira.project,
    sources: {
      github: d.github.adapter === 'local-git' ? { adapter: 'local-git', path: localPath(d.github.path ?? '') } : { adapter: 'api' },
      jira: d.jira.adapter === 'cloud' ? { adapter: 'cloud', base_url: d.jira.base_url, email: d.jira.email } : { adapter: 'file', path: localPath(d.jira.path ?? '') },
      xray: d.xray.adapter === 'cloud'
        ? { adapter: 'cloud', base_url: d.xray.base_url || XRAY_CLOUD, client_id: d.xray.client_id, wait_seconds: d.xray.wait_seconds }
        : { adapter: 'junit', path: localPath(d.xray.path ?? ''), wait_seconds: d.xray.wait_seconds },
    },
    policies: { path: sourceDir(d, 'policies'), pull: isUrl(d.policies.source), repository: d.policies.source },
    environment: { name: d.environment.name || 'qe', base_url: d.environment.base_url, wait_for_commit_seconds: d.environment.wait_for_commit_seconds, ...(d.environment.log_path ? { log_path: localPath(d.environment.log_path) } : {}) },
    verifiers: { adapter: 'local-playwright', path: sourceDir(d, 'verifiers'), pull: isUrl(d.verifiers.source), repository: d.verifiers.source },
    verifier_env: (d.identities ?? []).map((i) => i.name).filter(Boolean),
    ...(srcOf(d, 'suites') ? { functional: {
      adapter: d.automation?.core?.adapter ?? 'frozen-suites', path: sourceDir(d, 'suites'), pull: isUrl(srcOf(d, 'suites')),
      repository: srcOf(d, 'suites'), budget_seconds: d.automation?.core?.budget_seconds ?? 600, core_version: d.automation?.core?.version,
    } } : {}),
    ...(d.automation?.core?.adapter === 'agent-core' && d.automation.core.url ? { agent_core: { url: d.automation.core.url, ...(d.automation.core.version ? { version: d.automation.core.version } : {}) } } : {}),
    ...(d.automation?.imports?.path ? { imports: { adapter: 'files' as const, path: localPath(d.automation.imports.path), wait_seconds: d.automation.imports.wait_seconds ?? 120 } } : {}),
    ...(srcOf(d, 'team') ? { team_automation: { path: sourceDir(d, 'team'), repository: srcOf(d, 'team'), pull: isUrl(srcOf(d, 'team')) } } : {}),
    channels: channelsOf(d),
  };
}

/** The channels in the engine's form: only the enabled ones, with the UI defaulting to the QE URL. */
function channelsOf(d: Draft): RepoConfig['channels'] {
  const c = d.channels ?? {};
  return {
    ...(c.ui?.enabled ? { ui: { url: c.ui.url || d.environment?.base_url, browsers: c.ui.browsers?.length ? c.ui.browsers : ['chromium'] } } : {}),
    ...(c.api?.enabled ? { api: { base_url: c.api.base_url || d.environment?.base_url, ...(c.api.spec ? { spec: c.api.spec } : {}) } } : {}),
    ...(c.mcp?.enabled ? { mcp: { url: c.mcp.url! } } : {}),
  };
}

/** Applications saved in the UI join the ones in the config file when the engine starts. */
export async function loadApplications() {
  const rows = (await pool.query('SELECT * FROM applications ORDER BY created_at')).rows;
  for (const r of rows) {
    if (config.repositories[r.key]?.origin === 'file') { console.warn(`application ${r.key}: defined in prcheck.config.yaml, the onboarded copy is ignored`); continue; }
    try { registerRepo(toRepoConfig(r.config, open(r.secrets), r.status)); }
    catch (e) { console.error(`application ${r.key} not loaded: ${(e as Error).message}`); }
  }
  if (rows.length) console.log(`loaded ${rows.length} onboarded application(s)`);
}

/* ---------- Connection tests, one per wizard step ---------- */
const pass = (label: string, detail?: string): Check => ({ label, status: 'pass', detail });
const warn = (label: string, detail?: string): Check => ({ label, status: 'warn', detail });
const fail = (label: string, detail?: string): Check => ({ label, status: 'fail', detail });
const worst = (cs: Check[]): Status => (cs.some((c) => c.status === 'fail') ? 'fail' : cs.some((c) => c.status === 'warn') ? 'warn' : 'pass');
const tail = (e: any) => String(e?.stderr || e?.stdout || e?.message || e).trim().split('\n').slice(-4).join(' ').slice(0, 400);

function gitHeader(token?: string) {
  return token ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`] : [];
}

/** Clones (or updates) a policy or verifier repository given by URL; a local path is used as it is. */
async function ensureCheckout(d: Draft, which: Src, token: string | undefined, checks: Check[], install = true): Promise<string | null> {
  const src = srcOf(d, which);
  if (!src) { checks.push(fail('Repository', 'Enter a Git URL or a path to a checkout on the engine host')); return null; }
  const dir = sourceDir(d, which);
  try {
    if (isUrl(src)) {
      if (existsSync(join(dir, '.git'))) {
        await run('git', [...gitHeader(token), '-C', dir, 'pull', '--ff-only', '-q'], { timeout: 120_000 });
        checks.push(pass('Repository reachable', `${src} (updated)`));
      } else {
        mkdirSync(join(dir, '..'), { recursive: true });
        await run('git', [...gitHeader(token), 'clone', '-q', src, dir], { timeout: 300_000 });
        checks.push(pass('Repository cloned', src));
      }
    } else {
      if (!existsSync(join(dir, '.git'))) { checks.push(fail('Repository', `${dir} is not a Git checkout`)); return null; }
      checks.push(pass('Checkout found', dir));
      checks.push(warn('Updates', 'A local checkout is used as it is. Give a Git URL so PRCheck.live pulls the latest approved main before every assessment.'));
    }
  } catch (e) { checks.push(fail('Repository', tail(e))); return null; }
  if (install && existsSync(join(dir, 'package.json')) && !existsSync(join(dir, 'node_modules'))) {
    try { await run('npm', [existsSync(join(dir, 'package-lock.json')) ? 'ci' : 'install', '--no-audit', '--no-fund', '--silent'], { cwd: dir, timeout: 600_000 }); checks.push(pass('Dependencies installed')); }
    catch (e) { checks.push(fail('Dependencies', tail(e))); return null; }
  }
  return dir;
}
async function commitOf(dir: string) { try { return (await run('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'])).stdout.trim(); } catch { return null; } }

function yamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? yamlFiles(p) : /\.ya?ml$/.test(n) && !n.startsWith('_') ? [p] : []; });
}
export function obligationsIn(policyDir: string) {
  return yamlFiles(join(policyDir, 'policies')).flatMap((f) => {
    try { const p = parse(readFileSync(f, 'utf8')); return (p.obligations ?? []).map((o: any) => ({ id: o.id, policy: p.id, check: `${o.evidence?.verifier}/${o.evidence?.check}` })); }
    catch { return []; }
  });
}

/** Environment variables the verifiers read for their test logins, found in their source. */
const STANDARD_ENV = new Set(['BASE_URL', 'EXPECTED_SHA', 'LOG_PATH', 'EVIDENCE_DIR', 'CI', 'ASSESSMENT_ID']);
function envVarsIn(dir: string): string[] {
  const out = new Set<string>();
  const walk = (d: string) => { for (const n of readdirSync(d)) {
    if (n === 'node_modules' || n.startsWith('.')) continue;
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|js|mjs)$/.test(n)) for (const m of readFileSync(p, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) if (!STANDARD_ENV.has(m[1])) out.add(m[1]);
  } };
  if (existsSync(dir)) walk(dir);
  return [...out].sort();
}

/**
 * The logins the verifiers need, declared by the verifiers repository itself in
 * identities.yaml (name, role, purpose). The Admin supplies only the values.
 * Without that file, the names are read from the code (process.env.X).
 */
export interface Identity { name: string; role?: string; purpose?: string; secret?: boolean }
function identitiesIn(dir: string): { declared: boolean; list: Identity[] } {
  const f = join(dir, 'identities.yaml');
  if (existsSync(f)) {
    try {
      const doc = parse(readFileSync(f, 'utf8'));
      return { declared: true, list: (doc.identities ?? []).filter((i: any) => i?.env).map((i: any) => ({ name: String(i.env), role: i.role, purpose: i.purpose, secret: !!i.secret })) };
    } catch { /* fall through to the code scan */ }
  }
  return { declared: false, list: envVarsIn(dir).map((name) => ({ name, secret: /PASS|TOKEN|SECRET/.test(name) })) };
}

/** Logins needed by the verifiers and by the assurance suites, declared by each repository. */
function neededIdentities(d: Draft): { declared: boolean; list: Identity[] } | null {
  const out = new Map<string, Identity>(); let declared = true, any = false;
  for (const which of ['verifiers', 'suites'] as const) {
    if (!srcOf(d, which)) continue;
    const dir = sourceDir(d, which);
    if (!existsSync(dir)) { if (which === 'verifiers') return null; continue; }
    any = true;
    const ids = identitiesIn(dir); declared = declared && ids.declared;
    for (const i of ids.list) if (!out.has(i.name)) out.set(i.name, i);
  }
  return any ? { declared, list: [...out.values()] } : null;
}

/** The evidence classes the application's profile requires (profiles/<id>.yaml, required_evidence). */
function profileRequires(d: Draft): string[] | null {
  const dir = srcOf(d, 'policies') ? sourceDir(d, 'policies') : null;
  if (!dir || !existsSync(dir)) return null;
  try {
    const entry = parse(readFileSync(join(dir, 'catalog', 'components.yaml'), 'utf8')).repositories?.[d.key];
    const req = entry ? parse(readFileSync(join(dir, 'profiles', `${entry.profile}.yaml`), 'utf8'))?.required_evidence : null;
    if (!req) return ['policy'];
    return Array.isArray(req) ? req : Object.entries(req).filter(([, v]) => v === 'required' || v === true).map(([k]) => k);
  } catch { return null; }
}

/** Results from other tools the application's profile requires (profiles/<id>.yaml, imported_evidence). */
function profileImports(d: Draft): Array<{ id: string; title: string; format: string; gate?: Record<string, number> }> {
  const dir = srcOf(d, 'policies') ? sourceDir(d, 'policies') : null;
  if (!dir || !existsSync(dir)) return [];
  try {
    const entry = parse(readFileSync(join(dir, 'catalog', 'components.yaml'), 'utf8')).repositories?.[d.key];
    return entry ? parse(readFileSync(join(dir, 'profiles', `${entry.profile}.yaml`), 'utf8'))?.imported_evidence ?? [] : [];
  } catch { return []; }
}

/** What an existing automation repository holds, read the way the agents read it. Nothing is run or changed. */
function analyseAutomation(dir: string) {
  const files: string[] = [];
  const walk = (p: string, depth: number) => { if (depth > 6) return; for (const n of readdirSync(p)) {
    if (['node_modules', 'dist', 'build', 'target', 'test-results', 'playwright-report'].includes(n) || n.startsWith('.')) continue;
    const f = join(p, n); if (statSync(f).isDirectory()) walk(f, depth + 1); else files.push(f);
  } };
  walk(dir, 0);
  const rel = (f: string) => f.slice(dir.length + 1);
  const pkg = (() => { try { const j = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); return { ...j.dependencies, ...j.devDependencies } as Record<string, string>; } catch { return {}; } })();
  const pom = existsSync(join(dir, 'pom.xml')) ? readFileSync(join(dir, 'pom.xml'), 'utf8') : '';
  const frameworks = [
    pkg['@playwright/test'] && `Playwright ${pkg['@playwright/test'].replace(/^[^\d]*/, '')}`, pkg.cypress && 'Cypress', pkg.webdriverio && 'WebdriverIO',
    pkg.supertest && 'SuperTest', pkg['@modelcontextprotocol/sdk'] && 'MCP SDK', /rest-assured/.test(pom) && 'REST Assured', /selenium/.test(pom) && 'Selenium',
    files.some((f) => /pytest\.ini$|conftest\.py$/.test(f)) && 'pytest',
  ].filter(Boolean) as string[];
  const specs = files.filter((f) => /\.(spec|test|cy)\.(ts|js|mjs)$|Test\.java$|(^|\/)test_[^/]+\.py$|\.feature$/.test(f));
  const text = specs.slice(0, 400).map((f) => readFileSync(f, 'utf8')).join('\n');
  const tags = [...new Set([...text.matchAll(/@(smoke|regression|critical|e2e|sanity|api|ui|mcp)\b/gi)].map((m) => '@' + m[1].toLowerCase()))].sort();
  const channels = [/\bpage\.(goto|click|fill|getBy)|cy\.visit|browser\.url/.test(text) && 'UI', /\brequest\.(get|post|put|delete|patch)|request\(app\)|given\(\)|axios|fetch\(/.test(text) && 'API',
    /tools\/(list|call)|McpClient|@modelcontextprotocol/.test(text) && 'MCP'].filter(Boolean) as string[];
  const language = specs.some((f) => f.endsWith('.ts')) ? 'TypeScript' : specs.some((f) => /\.m?js$/.test(f)) ? 'JavaScript' : specs.some((f) => f.endsWith('.java')) ? 'Java' : specs.some((f) => f.endsWith('.py')) ? 'Python' : '—';
  const ci = files.filter((f) => /\.github\/workflows\/|Jenkinsfile$|\.gitlab-ci\.yml$|azure-pipelines\.yml$/.test(rel(f))).map(rel);
  return { frameworks, language, specs: specs.length, specFolders: [...new Set(specs.map((f) => rel(f).split('/').slice(0, -1).join('/') || '.'))].slice(0, 6), tags, channels, ci };
}

/** Speaks MCP's streamable HTTP transport: initialize, then tools/list. Accepts JSON or event-stream replies. */
async function mcpProbe(url: string, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const read = async (res: globalThis.Response) => {
    const body = await res.text();
    const json = (res.headers.get('content-type') ?? '').includes('text/event-stream')
      ? body.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).pop() ?? 'null' : body;
    return JSON.parse(json);
  };
  const init = await fetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'PRCheck.live', version: '1.0' } } }) });
  if (init.status === 401 || init.status === 403) throw new Error(`HTTP ${init.status}: the server refused the token`);
  if (!init.ok) throw new Error(`initialize: HTTP ${init.status}`);
  const session = init.headers.get('mcp-session-id');
  const hello = await read(init);
  if (!hello?.result) throw new Error(`initialize: ${JSON.stringify(hello?.error ?? hello).slice(0, 160)}`);
  const h2 = { ...headers, ...(session ? { 'mcp-session-id': session } : {}), 'mcp-protocol-version': hello.result.protocolVersion ?? '2025-06-18' };
  await fetch(url, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: AbortSignal.timeout(8000) }).catch(() => undefined);
  const list = await read(await fetch(url, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), signal: AbortSignal.timeout(8000) }));
  const tools = (list?.result?.tools ?? []).map((t: { name: string }) => t.name);
  return { server: hello.result.serverInfo ?? {}, protocol: hello.result.protocolVersion, tools };
}

async function existingSecrets(key: string): Promise<Record<string, string>> {
  const r = await pool.query('SELECT secrets FROM applications WHERE key = $1', [key]);
  return r.rowCount ? open(r.rows[0].secrets) : {};
}

export async function testStep(step: Step, d: Draft, editing: string | null): Promise<StepResult> {
  const checks: Check[] = [];
  const found: Record<string, unknown> = {};
  const secrets = { ...(editing ? await existingSecrets(editing) : {}), ...secretsOf(d) };

  switch (step) {
    case 'application': {
      if (!/^[a-z][a-z0-9-]{1,39}$/.test(d.key ?? '')) checks.push(fail('Application key', 'Lower-case letters, digits and hyphens, starting with a letter (for example vendorpay)'));
      else if (config.repositories[d.key] && (config.repositories[d.key].origin === 'file' || d.key !== editing)) checks.push(fail('Application key', `${d.key} is already onboarded${config.repositories[d.key].origin === 'file' ? ' in prcheck.config.yaml' : ''}`));
      else checks.push(pass('Application key', `${d.key}: the policy repository must register this key`));
      checks.push(d.name?.trim() ? pass('Display name', d.name.trim()) : fail('Display name', 'Enter the name people know the application by'));
      break;
    }
    case 'github': {
      const g = d.github ?? {} as Draft['github'];
      if (!/^[\w.-]+\/[\w.-]+$/.test(g.repository ?? '')) { checks.push(fail('Repository', 'Use owner/name, for example ascendqe-demo/vendorpay-app')); break; }
      const other = Object.values(config.repositories).find((r) => r.github.toLowerCase() === g.repository.toLowerCase() && r.key !== d.key);
      if (other) { checks.push(fail('Repository', `${g.repository} is already onboarded as ${other.app ?? other.key}`)); break; }
      if (!g.base_branch) { checks.push(fail('Base branch', 'Enter the branch pull requests merge into')); break; }
      if (g.adapter !== 'local-git') {
        const own = g.adapter === 'token';
        if (own && !secrets.GITHUB_TOKEN) { checks.push(fail('Access token', 'Enter a token with access to this repository')); break; }
        if (!own && !process.env.PRCHECK_GITHUB_TOKEN) { checks.push(fail('Organisation connection', 'PRCheck.live has no organisation connection yet (PRCHECK_GITHUB_TOKEN). Choose "Access token for this repository", or install the PRCheck.live GitHub App first.')); break; }
        checks.push(pass('Credentials', own ? 'Access token for this repository' : 'Organisation connection'));
        const auth = { secrets: (own ? { GITHUB_TOKEN: secrets.GITHUB_TOKEN } : {}) as Record<string, string> };
        try {
          const repo = await githubApi(`/repos/${g.repository}`, {}, auth);
          checks.push(pass('Repository reachable', `${repo.full_name} · ${repo.private ? 'private' : 'public'}`));
          const perms = repo.permissions ?? {};
          checks.push(perms.push || perms.admin || perms.maintain ? pass('Can post statuses and comments') : warn('Permissions', 'The token may not be able to post commit statuses; check its permissions'));
        } catch (e) { checks.push(fail('Repository', tail(e))); break; }
        try { await githubApi(`/repos/${g.repository}/branches/${encodeURIComponent(g.base_branch)}`, {}, auth); checks.push(pass('Base branch', g.base_branch)); }
        catch { checks.push(fail('Base branch', `${g.base_branch} not found`)); }
      } else {
        const dir = localPath(g.path ?? '');
        try { await run('git', ['-C', dir, 'rev-parse', '--verify', '-q', g.base_branch]); checks.push(pass('Local clone', `${dir} · ${g.base_branch}`)); checks.push(warn('Demo mode', 'Changed files come from a local clone; statuses go to GitHub only if the engine has a token')); }
        catch { checks.push(fail('Local clone', `${dir} is not a Git checkout with branch ${g.base_branch}`)); }
      }
      found.webhookUrl = `${config.server.public_url}/webhooks/github`;
      found.events = ['pull_request'];
      found.requiredCheck = 'prcheck/assurance';
      found.webhookSecret = process.env.WEBHOOK_SECRET ? 'set on the engine (WEBHOOK_SECRET)' : 'missing';
      if (!process.env.WEBHOOK_SECRET) checks.push(fail('Webhook secret', 'Set WEBHOOK_SECRET on the engine; GitHub signs every delivery with it'));
      break;
    }
    case 'jira': {
      const j = d.jira ?? {} as Draft['jira'];
      if (!/^[A-Z][A-Z0-9]{1,9}$/.test(j.project ?? '')) { checks.push(fail('Project key', 'Upper-case letters and digits, for example VP')); break; }
      checks.push(pass('Project key', `Pull request titles or branches must name an issue like ${j.project}-123`));
      if (j.adapter === 'cloud') {
        if (!/^https:\/\/[\w.-]+/.test(j.base_url ?? '')) { checks.push(fail('Site URL', 'For example https://yourcompany.atlassian.net')); break; }
        if (!j.email) { checks.push(fail('Service account email')); break; }
        const token = secrets.JIRA_TOKEN;
        if (!token) { checks.push(fail('API token', 'Enter an API token for the service account')); break; }
        try {
          const res = await fetch(`${j.base_url!.replace(/\/+$/, '')}/rest/api/3/project/${j.project}`, { headers: { authorization: 'Basic ' + Buffer.from(`${j.email}:${token}`).toString('base64'), accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
          if (res.ok) { const p = await res.json(); checks.push(pass('Project found', `${p.key} · ${p.name}`)); found.projectName = p.name; }
          else checks.push(fail('Jira', res.status === 401 ? 'The email or API token was rejected' : res.status === 404 ? `Project ${j.project} not found, or the account cannot see it` : `HTTP ${res.status}`));
        } catch (e) { checks.push(fail('Jira', tail(e))); }
      } else {
        const dir = localPath(j.path ?? '');
        if (!existsSync(dir)) { checks.push(fail('Fixture folder', `${dir} not found`)); break; }
        const issues = readdirSync(dir).filter((n) => n.startsWith(`${j.project}-`) && n.endsWith('.json'));
        checks.push(issues.length ? pass('Issue files', `${issues.length} issue(s), for example ${issues[0].replace('.json', '')}`) : warn('Issue files', `No ${j.project}-*.json files yet`));
        checks.push(warn('Demo mode', 'Stories come from files. Connect Jira Cloud for real projects.'));
      }
      break;
    }
    case 'xray': {
      const x = d.xray ?? {} as Draft['xray'];
      if (x.adapter === 'cloud') {
        const base = x.base_url || XRAY_CLOUD;
        if (!x.client_id) { checks.push(fail('Client ID', 'From Xray: Global settings → API Keys')); break; }
        if (!secrets.XRAY_CLIENT_SECRET) { checks.push(fail('Client secret', 'Enter the client secret of that API key')); break; }
        let token: string;
        try { token = await xrayToken(base, x.client_id, secrets.XRAY_CLIENT_SECRET); checks.push(pass('Authenticated', base)); }
        catch (e) { const m = tail(e); checks.push(fail('Xray Cloud', m === 'fetch failed' ? `Could not reach ${base}` : m)); break; }
        const project = d.jira?.project;
        if (project) {
          try {
            const r = await xrayGraphql(base, token, 'query($jql: String, $limit: Int!) { getTestExecutions(jql: $jql, limit: $limit) { total } getTests(jql: $jql, limit: $limit) { total } }',
              { jql: `project = "${project}"`, limit: 1 });
            checks.push(pass('Project readable', `${project}: ${r.getTests?.total ?? 0} test cases, ${r.getTestExecutions?.total ?? 0} test executions`));
          } catch (e) { checks.push(fail('Project', tail(e))); break; }
        }
        checks.push(warn('Team CI convention', `Import each commit's results as a Test Execution labelled ${commitLabel('<sha>')} (for example ${commitLabel('684fa4f')}), so PRCheck.live finds the right run`));
      } else {
        if (!x.path) { checks.push(fail('Results folder', "Where the team's CI writes <commit>/junit.xml")); break; }
        const dir = localPath(x.path);
        try { mkdirSync(dir, { recursive: true }); accessSync(dir, constants.R_OK | constants.W_OK); checks.push(pass('Results folder', dir)); }
        catch (e) { checks.push(fail('Results folder', tail(e))); break; }
        const commits = readdirSync(dir).filter((n) => existsSync(join(dir, n, 'junit.xml')));
        checks.push(commits.length ? pass('Team results', `${commits.length} commit(s) with results`) : warn('Team results', 'None yet; they appear when the team CI runs on a pull request'));
        checks.push(warn('Demo mode', 'JUnit files on the engine host. Connect Xray Cloud for real projects.'));
      }
      const w = Number(x.wait_seconds);
      checks.push(Number.isInteger(w) && w >= 0 && w <= 3600 ? pass('Wait for results', `${w} s`) : fail('Wait for results', '0 to 3600 seconds'));
      checks.push(pass('Role', "Shown as context only; the team's results never decide the disposition"));
      break;
    }
    case 'policies': {
      const dir = await ensureCheckout(d, 'policies', secrets.POLICIES_GIT_TOKEN, checks);
      if (!dir) break;
      for (const f of ['catalog/components.yaml', 'catalog/verifiers.yaml', 'scripts/select.ts']) if (!existsSync(join(dir, f))) checks.push(fail('Policy repository layout', `${f} is missing`));
      if (worst(checks) === 'fail') break;
      try { await run('npx', ['tsx', 'scripts/validate.ts'], { cwd: dir, timeout: 120_000 }); checks.push(pass('Policies validate')); }
      catch (e) { checks.push(fail('Policies validate', tail(e))); }
      const catalog = parse(readFileSync(join(dir, 'catalog/components.yaml'), 'utf8'));
      const entry = catalog.repositories?.[d.key];
      if (!entry) { checks.push(fail('Application registered', `catalog/components.yaml has no "${d.key}". Registered: ${Object.keys(catalog.repositories ?? {}).join(', ') || 'none'}. Ask the policy owners to add it by pull request.`)); break; }
      checks.push(pass('Application registered', `${Object.keys(entry.components ?? {}).length} component(s) mapped to code paths`));
      if (entry.github && d.github?.repository && entry.github.toLowerCase() !== d.github.repository.toLowerCase())
        checks.push(warn('GitHub repository', `The catalog says ${entry.github}, you entered ${d.github.repository}`));
      if (entry.jira_project && d.jira?.project && entry.jira_project !== d.jira.project)
        checks.push(warn('Jira project', `The catalog says ${entry.jira_project}, you entered ${d.jira.project}`));
      const profileFile = join(dir, 'profiles', `${entry.profile}.yaml`);
      checks.push(existsSync(profileFile) ? pass('Assurance profile', entry.profile) : fail('Assurance profile', `profiles/${entry.profile}.yaml not found`));
      const obls = obligationsIn(dir);
      found.profile = entry.profile;
      found.policies = new Set(obls.map((o) => o.policy)).size;
      found.obligations = obls.length;
      found.commit = await commitOf(dir);
      checks.push(pass('Rules', `${found.policies} policies, ${obls.length} obligations at commit ${found.commit}`));
      break;
    }
    case 'verifiers': {
      const dir = await ensureCheckout(d, 'verifiers', secrets.VERIFIERS_GIT_TOKEN, checks);
      if (!dir) break;
      if (!existsSync(join(dir, 'playwright.config.ts'))) { checks.push(fail('Playwright project', 'playwright.config.ts is missing')); break; }
      checks.push(existsSync(join(dir, 'reporters', 'evidence-reporter.ts')) ? pass('Evidence reporter', 'Results are sealed as PRCheck.live evidence') : fail('Evidence reporter', 'reporters/evidence-reporter.ts is missing; start from the PRCheck.live verifier template'));
      let titles: string[] = [];
      try {
        const { stdout } = await run('npx', ['playwright', 'test', '--list', '--reporter=list'], { cwd: dir, timeout: 120_000, env: { ...process.env, BASE_URL: 'http://127.0.0.1:9' } });
        titles = [...new Set([...stdout.matchAll(/\b(V\d+\/[a-z0-9-]+)/gi)].map((m) => m[1]))];
        checks.push(titles.length ? pass('Checks found', `${titles.length} checks in ${new Set(titles.map((t) => t.split('/')[0])).size} verifiers`) : fail('Checks found', 'No checks named like V1/some-check'));
      } catch (e) { checks.push(fail('Playwright', tail(e))); break; }
      if (!titles.some((t) => /^V1\//.test(t))) checks.push(fail('Environment check (V1)', 'Without V1, PRCheck.live cannot prove which commit it tested'));
      // Coverage against the policies, when the policy step already has a checkout
      const pdir = d.policies?.source ? sourceDir(d, 'policies') : null;
      if (pdir && existsSync(pdir)) {
        const obls = obligationsIn(pdir);
        const missing = obls.filter((o) => !titles.includes(o.check));
        found.coverage = { obligations: obls.length, covered: obls.length - missing.length, missing: missing.map((o) => `${o.id} → ${o.check}`) };
        checks.push(!obls.length ? warn('Coverage', 'No obligations found in the policy repository')
          : missing.length ? warn('Coverage', `${obls.length - missing.length}/${obls.length} obligations have a check. Missing: ${missing.slice(0, 5).map((o) => `${o.id} (${o.check})`).join(', ')}${missing.length > 5 ? '…' : ''}. Those will be NOT ASSESSED.`)
          : pass('Coverage', `All ${obls.length} obligations have a check`));
      } else checks.push(warn('Coverage', 'Test the policy repository first to check coverage'));
      const ids = identitiesIn(dir);
      found.identities = ids.list;
      checks.push(ids.declared ? pass('Test identities declared', `${ids.list.length} in identities.yaml: ${ids.list.map((i) => i.name).join(', ')}`)
        : ids.list.length ? warn('Test identities', `No identities.yaml; ${ids.list.length} found in the code. Declare them with role and purpose in identities.yaml.`) : warn('Test identities', 'The verifiers declare none'));
      found.commit = await commitOf(dir);
      break;
    }
    case 'environment': {
      const e = d.environment ?? {} as Draft['environment'];
      let url: URL;
      try { url = new URL('/version', e.base_url); } catch { checks.push(fail('Base URL', 'For example https://qe.vendorpay.internal or http://localhost:3000')); break; }
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const v = await res.json().catch(() => null);
        if (res.ok && v?.gitSha) { checks.push(pass('Reports its commit', `${v.app ?? ''} ${v.version ?? ''} running ${v.gitSha}`.trim())); found.version = v; }
        else checks.push(fail('/version', `Must return JSON with gitSha (got HTTP ${res.status}${v ? ' ' + JSON.stringify(v).slice(0, 120) : ''}). PRCheck.live only verifies a build it can prove is the pull request's commit.`));
      } catch (err) { checks.push(fail('Reachable', `${url} · ${tail(err)}`)); }
      const w = Number(e.wait_for_commit_seconds);
      checks.push(Number.isInteger(w) && w >= 0 && w <= 7200 ? pass('Wait for deploy', `${w} s`) : fail('Wait for deploy', '0 to 7200 seconds'));
      if (e.log_path) checks.push(existsSync(localPath(e.log_path)) ? pass('Application log', localPath(e.log_path)) : warn('Application log', `${localPath(e.log_path)} not found yet; the log check is NOT ASSESSED until it exists`));
      else checks.push(warn('Application log', 'None given; log-masking checks will be NOT ASSESSED'));
      break;
    }
    case 'channels': {
      const c = d.channels ?? {};
      if (!c.ui?.enabled && !c.api?.enabled && !c.mcp?.enabled) { checks.push(fail('Channels', 'Choose at least one channel the application offers: UI, API or MCP')); break; }
      const reach = async (label: string, u: string) => {
        try { const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(5000) }); if (res.status >= 500) checks.push(fail(label, `${u} answered HTTP ${res.status}`)); else checks.push(pass(label, `${u} · HTTP ${res.status}`)); return res; }
        catch (e) { checks.push(fail(label, `${u} · ${tail(e)}`)); return null; }
      };
      if (c.ui?.enabled) {
        const u = c.ui.url || d.environment?.base_url;
        if (!u) checks.push(fail('UI URL', 'Enter the QE address of the user interface'));
        else {
          const res = await reach('UI reachable', u);
          if (res && !(res.headers.get('content-type') ?? '').includes('html') && res.status < 300) checks.push(warn('UI', 'The address did not return a web page'));
        }
        const b = (c.ui.browsers ?? []).filter((x) => ['chromium', 'firefox', 'webkit'].includes(x));
        checks.push(b.length ? pass('Browsers', b.join(', ')) : fail('Browsers', 'Choose at least one browser'));
      }
      if (c.api?.enabled) {
        const u = c.api.base_url || d.environment?.base_url;
        if (!u) checks.push(fail('API base URL', 'Enter the QE address of the API'));
        else await reach('API reachable', u);
        if (c.api.spec) {
          try {
            const raw = isUrl(c.api.spec) || /^https?:/.test(c.api.spec) ? await (await fetch(c.api.spec, { signal: AbortSignal.timeout(8000) })).text() : readFileSync(localPath(c.api.spec), 'utf8');
            const doc = parse(raw);
            const paths = Object.keys(doc?.paths ?? {});
            if (doc?.openapi || doc?.swagger) { checks.push(pass('API specification', `${doc.info?.title ?? 'OpenAPI'} ${doc.openapi ?? doc.swagger} · ${paths.length} paths`)); found.apiPaths = paths.length; }
            else checks.push(fail('API specification', 'Not an OpenAPI or Swagger document'));
          } catch (e) { checks.push(fail('API specification', tail(e))); }
        } else checks.push(warn('API specification', 'None given. The agents learn the API from the running application and the team\'s API tests; an OpenAPI document gives them every endpoint.'));
      }
      if (c.mcp?.enabled) {
        if (!/^https?:\/\//.test(c.mcp.url ?? '')) checks.push(fail('MCP endpoint', 'Enter the QE address of the MCP server, for example https://qe.vendorpay.internal/mcp'));
        else {
          try {
            const m = await mcpProbe(c.mcp.url!, secrets.MCP_TOKEN);
            checks.push(pass('MCP server', `${m.server.name ?? 'server'} ${m.server.version ?? ''} · protocol ${m.protocol}`.trim()));
            checks.push(m.tools.length ? pass('Tools', `${m.tools.length}: ${m.tools.slice(0, 8).join(', ')}${m.tools.length > 8 ? '…' : ''}`) : warn('Tools', 'The server lists no tools'));
            found.mcpTools = m.tools;
          } catch (e) { checks.push(fail('MCP server', tail(e))); }
        }
      }
      found.channels = channelsOf(d);
      break;
    }
    case 'automation': {
      const a = d.automation ?? {};
      const required = profileRequires(d);
      const needsFn = !!required?.includes('functional');
      // 1. The suites that decide: owned by PRCheck.live, never the team's repository
      if (!srcOf(d, 'suites')) {
        checks.push(needsFn ? fail('Assurance suites repository', 'The application\'s profile requires the functional lane. Give the repository where PRCheck.live keeps its approved suites.')
          : warn('Assurance suites repository', 'None: only the policy lane runs. The profile does not require the functional lane.'));
      } else {
        const own = [srcOf(d, 'team'), d.github?.repository ?? '', d.github?.path ?? ''].filter(Boolean).map((x) => x.toLowerCase().replace(/\.git$/, ''));
        const s = srcOf(d, 'suites').toLowerCase().replace(/\.git$/, '');
        if (own.some((o) => s === o || s.endsWith('/' + o) || o.endsWith(s))) { checks.push(fail('Independence', 'The assurance suites cannot live in the application team\'s repository: a team could then weaken the checks on its own change.')); break; }
        const dir = await ensureCheckout(d, 'suites', secrets.SUITES_GIT_TOKEN, checks);
        if (dir) {
          const cfgOk = existsSync(join(dir, 'playwright.functional.config.ts')), repOk = existsSync(join(dir, 'reporters', 'functional-reporter.ts'));
          checks.push(cfgOk && repOk ? pass('Suite runner', 'playwright.functional.config.ts and the functional evidence reporter')
            : fail('Suite runner', `${!cfgOk ? 'playwright.functional.config.ts' : 'reporters/functional-reporter.ts'} is missing; start from the PRCheck.live suite template`));
          const mdir = join(dir, 'functional', 'suites');
          const manifests = existsSync(mdir) ? readdirSync(mdir).filter((n) => /\.ya?ml$/.test(n)) : [];
          if (cfgOk && manifests.length) {
            let listed: string[] = [];
            try {
              const { stdout } = await run('npx', ['playwright', 'test', '-c', 'playwright.functional.config.ts', '--list', '--reporter=list'], { cwd: dir, timeout: 120_000, env: { ...process.env, BASE_URL: 'http://127.0.0.1:9' } });
              listed = [...new Set([...stdout.matchAll(/\b(F-[A-Za-z0-9]+\/[A-Za-z0-9-]+)/g)].map((m) => m[1]))];
            } catch (e) { checks.push(fail('Suites', tail(e))); }
            const stories: string[] = [];
            for (const f of manifests) {
              try {
                const m = parse(readFileSync(join(mdir, f), 'utf8'));
                const crit = m.criteria ?? [];
                const by = (st: string) => crit.filter((c: any) => c.status === st).length;
                const missing = crit.flatMap((c: any) => c.checks ?? []).filter((k: string) => !listed.includes(k));
                if (missing.length) checks.push(fail(`Suite ${m.story}`, `Checks named in the manifest are not in the code: ${missing.slice(0, 4).join(', ')}`));
                stories.push(`${m.story} (${crit.length} criteria: ${by('approved')} approved${by('proven') ? `, ${by('proven')} proven` : ''}${by('generated') ? `, ${by('generated')} generated` : ''})`);
              } catch (e) { checks.push(fail(`Suite ${f}`, tail(e))); }
            }
            checks.push(pass('Story suites', `${manifests.length}: ${stories.join('; ')}`));
            found.suites = stories;
          } else if (cfgOk) checks.push(warn('Story suites', 'None yet. Each story stays NOT ASSESSED, and its changes cannot be READY, until the agent core generates a suite and an Assurance Lead approves it.'));
          checks.push(pass('Ownership', 'Only PRCheck.live and its Assurance Leads may push here (protect main with CODEOWNERS)'));
          found.suitesCommit = await commitOf(dir);
        }
      }
      // 2. The agent core that generates and heals suites
      const core = a.core ?? {};
      if ((core.adapter ?? 'frozen-suites') === 'agent-core') {
        if (!/^https?:\/\//.test(core.url ?? '')) checks.push(fail('Agent core', 'Enter the address of the myDiya agent core, for example https://agent-core.ascendqe.internal'));
        else {
          try {
            const res = await fetch(new URL('/v1/info', core.url), { headers: secrets.AGENT_CORE_TOKEN ? { authorization: `Bearer ${secrets.AGENT_CORE_TOKEN}` } : {}, signal: AbortSignal.timeout(6000) });
            if (res.status === 401 || res.status === 403) throw new Error(`HTTP ${res.status}: the core refused the token`);
            const info = await res.json();
            if (info.protocol !== 'prcheck.agent-core/v1') checks.push(fail('Agent core', `Speaks ${info.protocol ?? 'an unknown protocol'}, not prcheck.agent-core/v1`));
            else if (core.version && !String(info.version).startsWith(core.version)) checks.push(fail('Agent core version', `The core is ${info.version}; you pinned ${core.version}`));
            else {
              checks.push(pass('Agent core', `${info.name} ${info.version}${info.implementation === 'reference' ? ' (reference implementation)' : ''} · protocol ${info.protocol}`));
              checks.push(pass('Missions', `${(info.missions ?? []).join(', ')} · agents ${(info.agents ?? []).join(', ')}`));
              checks.push(pass('Trust', 'Everything the core delivers is "generated": it counts only after PRCheck.live proves it and an Assurance Lead approves it'));
              found.core = info;
            }
          } catch (e) { checks.push(fail('Agent core', tail(e))); }
        }
      } else checks.push(pass('Agent core', `Not connected: approved suites from the repository${core.version ? ` · core ${core.version}` : ''}. New rules and stories wait for checks delivered by hand.`));
      const b = Number(core.budget_seconds ?? 600);
      checks.push(Number.isInteger(b) && b >= 60 && b <= 3600 ? pass('Time budget', `${b} s per pull request`) : fail('Time budget', '60 to 3600 seconds'));
      // 3. The team's automation repository: optional, read-only, context for the agents
      if (srcOf(d, 'team')) {
        const tdir = await ensureCheckout(d, 'team', secrets.TEAM_GIT_TOKEN, checks, false);
        if (tdir) {
          const an = analyseAutomation(tdir);
          found.team = an;
          checks.push(an.specs ? pass('Team automation analysed', `${an.frameworks.join(', ') || 'framework not recognised'} · ${an.language} · ${an.specs} test files in ${an.specFolders.join(', ')}${an.channels.length ? ` · channels ${an.channels.join(', ')}` : ''}${an.tags.length ? ` · tags ${an.tags.join(' ')}` : ''}`)
            : warn('Team automation', 'No test files found'));
          checks.push(pass('Read-only', 'PRCheck.live never pushes to it, and its results never decide the verdict'));
        }
      } else checks.push(pass('Team automation', 'None: the agents work from the stories, the API specification and the running application'));
      // 4. Results from other tools the profile requires (security scan, dependency audit, performance)
      const imports = profileImports(d);
      const ip = a.imports?.path?.trim();
      if (!imports.length) checks.push(ip ? warn('Results from other tools', 'The profile requires none; the folder is not used') : pass('Results from other tools', 'The profile requires none'));
      else if (!ip) checks.push(required?.includes('imported') ? fail('Results from other tools', `The profile requires ${imports.map((x) => x.title).join(', ')}. Give the folder the team's CI writes them to.`) : warn('Results from other tools', `${imports.length} listed in the profile but no folder given; they will not be collected`));
      else {
        const dir = localPath(ip);
        try { mkdirSync(dir, { recursive: true }); accessSync(dir, constants.R_OK); checks.push(pass('Results folder', dir)); }
        catch (e) { checks.push(fail('Results folder', tail(e))); }
        checks.push(pass('Required results', imports.map((x) => `${x.title} (${x.format}${x.gate ? `, gate ${Object.entries(x.gate).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''})`).join('; ')));
        const commits = existsSync(dir) ? readdirSync(dir).filter((n) => imports.every((x) => existsSync(join(dir, n, `${x.id}.json`)))) : [];
        checks.push(commits.length ? pass('Results received', `${commits.length} commit(s) with every required result`) : warn('Results received', `None yet. The team's CI writes <commit>/${imports[0].id}.json and the others for each pull request commit`));
        const w = Number(a.imports?.wait_seconds ?? 120);
        checks.push(Number.isInteger(w) && w >= 0 && w <= 3600 ? pass('Wait for results', `${w} s`) : fail('Wait for results', '0 to 3600 seconds'));
      }
      if (required) found.required = required;
      found.identities = neededIdentities(d)?.list ?? [];
      break;
    }
    case 'identities': {
      const ids = neededIdentities(d);
      if (!ids) { checks.push(fail('Verifiers repository', 'Test the verifiers repository step first: it declares which logins are needed')); break; }
      const needed = ids.list;
      found.identities = needed;
      if (!needed.length) { checks.push(pass('Test identities', 'The verifiers need none')); break; }
      for (const n of needed) {
        const typed = (d.identities ?? []).find((i) => i.name === n.name)?.value;
        checks.push(secrets[n.name] ? pass(n.name, `${n.role ?? ''}${typed ? ' · will be stored encrypted' : ' · stored value kept'}`.replace(/^ · /, '')) : fail(n.name, `Enter the ${n.secret ? 'secret' : 'login'}${n.role ? ` for ${n.role}` : ''}`));
      }
      break;
    }
  }
  return { step, status: worst(checks), checks, found };
}

/* ---------- API (mounted at /api/ui/applications) ---------- */
export const applications = Router();
applications.use(express.json({ limit: '200kb' }));
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
  fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'INTERNAL', message: String(e?.message ?? e) }); });
const audit = (actor: string, action: string, target: string, data: object = {}) =>
  pool.query('INSERT INTO platform_audit (actor, action, target, data) VALUES ($1,$2,$3,$4)', [actor, action, target, data]);

/** Every application, from the config file and onboarded. Admin and Assurance Lead. */
applications.get('/', requirePerm('platform'), handle(async (_req, res) => {
  const rows = new Map((await pool.query('SELECT key, status, created_by, created_at, updated_by, updated_at FROM applications')).rows.map((r) => [r.key, r]));
  res.json({ applications: Object.values(config.repositories).map((r) => {
    const row = rows.get(r.key);
    return { key: r.key, name: r.app ?? r.key, github: r.github, jiraProject: r.jira_project, environment: r.environment.base_url,
      origin: r.origin ?? 'file', status: r.status ?? 'active',
      createdBy: row?.created_by ?? null, createdAt: row?.created_at ?? null, updatedBy: row?.updated_by ?? null, updatedAt: row?.updated_at ?? null };
  }) });
}));

applications.get('/audit', requirePerm('admin'), handle(async (_req, res) => {
  res.json({ events: (await pool.query('SELECT actor, action, target, data, at FROM platform_audit ORDER BY id DESC LIMIT 50')).rows });
}));

/** An onboarded application's settings, for editing. Secrets are reported as set, never returned. */
applications.get('/:key', requirePerm('admin'), handle(async (req, res) => {
  const r = (await pool.query('SELECT * FROM applications WHERE key = $1', [req.params.key])).rows[0];
  if (!r) return res.status(404).json({ error: 'NOT_FOUND', message: config.repositories[req.params.key] ? 'Defined in prcheck.config.yaml; edit that file' : 'Unknown application' });
  res.json({ draft: r.config, status: r.status, secretsSet: Object.keys(open(r.secrets)) });
}));

applications.post('/test', requirePerm('admin'), handle(async (req, res) => {
  const { step, draft, editing } = req.body ?? {};
  if (!STEPS.includes(step)) return res.status(400).json({ error: 'BAD_STEP' });
  res.json(await testStep(step, draft ?? {}, editing ?? null));
}));

async function save(req: Request, res: Response, editing: string | null) {
  const d: Draft = req.body?.draft;
  if (!d) return res.status(400).json({ error: 'BAD_REQUEST' });
  if (editing && d.key !== editing) return res.status(400).json({ error: 'BAD_REQUEST', message: 'The application key cannot change' });
  // Everything is tested again on the server: the wizard's earlier results are not trusted.
  const results: StepResult[] = [];
  for (const s of STEPS) results.push(await testStep(s, d, editing));
  if (results.some((r) => r.status === 'fail')) return res.status(422).json({ error: 'CHECKS_FAILED', results });
  // The verifiers repository decides which logins exist; keep exactly those.
  d.identities = (neededIdentities(d)?.list ?? []).map((n) => ({ name: n.name, value: (d.identities ?? []).find((i) => i.name === n.name)?.value }));
  const secrets = { ...(editing ? await existingSecrets(editing) : {}), ...secretsOf(d) };
  // Keep only the secrets the saved settings use.
  const keep = new Set(['POLICIES_GIT_TOKEN', 'VERIFIERS_GIT_TOKEN', ...d.identities.map((i) => i.name)]);
  if (srcOf(d, 'suites')) keep.add('SUITES_GIT_TOKEN');
  if (srcOf(d, 'team')) keep.add('TEAM_GIT_TOKEN');
  if (d.channels?.mcp?.enabled) keep.add('MCP_TOKEN');
  if (d.automation?.core?.adapter === 'agent-core') keep.add('AGENT_CORE_TOKEN');
  if (d.github.adapter === 'token') keep.add('GITHUB_TOKEN');
  if (d.jira.adapter === 'cloud') keep.add('JIRA_TOKEN');
  if (d.xray.adapter === 'cloud') keep.add('XRAY_CLIENT_SECRET');
  for (const k of Object.keys(secrets)) if (!keep.has(k)) delete secrets[k];
  const stored = withoutSecrets(d);
  const actor = req.user!.email;
  const status = editing ? (await pool.query('SELECT status FROM applications WHERE key = $1', [editing])).rows[0]?.status ?? 'active' : 'active';
  if (editing) await pool.query('UPDATE applications SET name = $2, config = $3, secrets = $4, updated_by = $5, updated_at = now() WHERE key = $1', [d.key, d.name, stored, seal(secrets), actor]);
  else await pool.query('INSERT INTO applications (key, name, config, secrets, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$5)', [d.key, d.name, stored, seal(secrets), actor]);
  registerRepo(toRepoConfig(d, secrets, status));
  await audit(actor, editing ? 'application.updated' : 'application.created', d.key, { github: d.github.repository, secrets: Object.keys(secrets) });
  res.status(editing ? 200 : 201).json({
    key: d.key, results,
    github: { webhookUrl: `${config.server.public_url}/webhooks/github`, events: ['pull_request'], contentType: 'application/json', requiredCheck: 'prcheck/assurance', repository: d.github.repository, base: d.github.base_branch },
  });
}
applications.post('/', requirePerm('admin'), handle((req, res) => save(req, res, null)));
applications.put('/:key', requirePerm('admin'), handle(async (req, res) => {
  if (!(await pool.query('SELECT 1 FROM applications WHERE key = $1', [req.params.key])).rowCount) return res.status(404).json({ error: 'NOT_FOUND' });
  return save(req, res, req.params.key);
}));

/** Pause: webhooks for the application are acknowledged and ignored. Nothing is deleted. */
applications.post('/:key/status', requirePerm('admin'), handle(async (req, res) => {
  const status = req.body?.status;
  if (!['active', 'paused'].includes(status)) return res.status(400).json({ error: 'BAD_STATUS' });
  const r = await pool.query('UPDATE applications SET status = $2, updated_by = $3, updated_at = now() WHERE key = $1 RETURNING key', [req.params.key, status, req.user!.email]);
  if (!r.rowCount) return res.status(404).json({ error: 'NOT_FOUND', message: 'Only applications onboarded in the UI can be paused' });
  config.repositories[req.params.key].status = status;
  await audit(req.user!.email, `application.${status === 'paused' ? 'paused' : 'resumed'}`, req.params.key);
  res.json({ key: req.params.key, status });
}));
