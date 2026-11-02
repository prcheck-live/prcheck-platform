/**
 * Onboarding an application: what an Admin gives QIVVRA, how each part is tested
 * before it is saved, and how saved applications join the ones in qivvra.config.yaml.
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
  identities: Array<{ name: string; value?: string }>;
}
export const STEPS = ['application', 'github', 'jira', 'xray', 'policies', 'verifiers', 'environment', 'identities'] as const;
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
  for (const i of d.identities ?? []) if (i.name && i.value) s[i.name] = i.value;
  return s;
}
function withoutSecrets(d: Draft): Draft {
  return {
    ...d,
    github: { ...d.github, token: undefined }, xray: { ...d.xray, client_secret: undefined },
    jira: { ...d.jira, token: undefined }, policies: { ...d.policies, token: undefined }, verifiers: { ...d.verifiers, token: undefined },
    identities: (d.identities ?? []).map((i) => ({ name: i.name })),
  };
}

const isUrl = (s: string) => /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(s);
const checkoutDir = (key: string, which: 'policies' | 'verifiers') => join(config.root, 'data', 'checkouts', key, which);
const localPath = (p: string) => (isAbsolute(p) ? p : cfgPath(p));
const sourceDir = (d: Draft, which: 'policies' | 'verifiers') => (isUrl(d[which].source) ? checkoutDir(d.key, which) : localPath(d[which].source));

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
  };
}

/** Applications saved in the UI join the ones in the config file when the engine starts. */
export async function loadApplications() {
  const rows = (await pool.query('SELECT * FROM applications ORDER BY created_at')).rows;
  for (const r of rows) {
    if (config.repositories[r.key]?.origin === 'file') { console.warn(`application ${r.key}: defined in qivvra.config.yaml, the onboarded copy is ignored`); continue; }
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
async function ensureCheckout(d: Draft, which: 'policies' | 'verifiers', token: string | undefined, checks: Check[]): Promise<string | null> {
  const src = (d[which]?.source ?? '').trim();
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
      checks.push(warn('Updates', 'A local checkout is used as it is. Give a Git URL so QIVVRA pulls the latest approved main before every assessment.'));
    }
  } catch (e) { checks.push(fail('Repository', tail(e))); return null; }
  if (existsSync(join(dir, 'package.json')) && !existsSync(join(dir, 'node_modules'))) {
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
function obligationsIn(policyDir: string) {
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
      else if (config.repositories[d.key] && (config.repositories[d.key].origin === 'file' || d.key !== editing)) checks.push(fail('Application key', `${d.key} is already onboarded${config.repositories[d.key].origin === 'file' ? ' in qivvra.config.yaml' : ''}`));
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
        if (!own && !process.env.QIVVRA_GITHUB_TOKEN) { checks.push(fail('Organisation connection', 'QIVVRA has no organisation connection yet (QIVVRA_GITHUB_TOKEN). Choose "Access token for this repository", or install the QIVVRA GitHub App first.')); break; }
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
      found.requiredCheck = 'qivvra/assurance';
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
        checks.push(warn('Team CI convention', `Import each commit's results as a Test Execution labelled ${commitLabel('<sha>')} (for example ${commitLabel('3f6e20d')}), so QIVVRA finds the right run`));
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
      checks.push(existsSync(join(dir, 'reporters', 'evidence-reporter.ts')) ? pass('Evidence reporter', 'Results are sealed as QIVVRA evidence') : fail('Evidence reporter', 'reporters/evidence-reporter.ts is missing; start from the QIVVRA verifier template'));
      let titles: string[] = [];
      try {
        const { stdout } = await run('npx', ['playwright', 'test', '--list', '--reporter=list'], { cwd: dir, timeout: 120_000, env: { ...process.env, BASE_URL: 'http://127.0.0.1:9' } });
        titles = [...new Set([...stdout.matchAll(/\b(V\d+\/[a-z0-9-]+)/gi)].map((m) => m[1]))];
        checks.push(titles.length ? pass('Checks found', `${titles.length} checks in ${new Set(titles.map((t) => t.split('/')[0])).size} verifiers`) : fail('Checks found', 'No checks named like V1/some-check'));
      } catch (e) { checks.push(fail('Playwright', tail(e))); break; }
      if (!titles.some((t) => /^V1\//.test(t))) checks.push(fail('Environment check (V1)', 'Without V1, QIVVRA cannot prove which commit it tested'));
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
        else checks.push(fail('/version', `Must return JSON with gitSha (got HTTP ${res.status}${v ? ' ' + JSON.stringify(v).slice(0, 120) : ''}). QIVVRA only verifies a build it can prove is the pull request's commit.`));
      } catch (err) { checks.push(fail('Reachable', `${url} · ${tail(err)}`)); }
      const w = Number(e.wait_for_commit_seconds);
      checks.push(Number.isInteger(w) && w >= 0 && w <= 7200 ? pass('Wait for deploy', `${w} s`) : fail('Wait for deploy', '0 to 7200 seconds'));
      if (e.log_path) checks.push(existsSync(localPath(e.log_path)) ? pass('Application log', localPath(e.log_path)) : warn('Application log', `${localPath(e.log_path)} not found yet; the log check is NOT ASSESSED until it exists`));
      else checks.push(warn('Application log', 'None given; log-masking checks will be NOT ASSESSED'));
      break;
    }
    case 'identities': {
      const vdir = d.verifiers?.source ? sourceDir(d, 'verifiers') : null;
      if (!vdir || !existsSync(vdir)) { checks.push(fail('Verifiers repository', 'Test the verifiers repository step first: it declares which logins are needed')); break; }
      const needed = identitiesIn(vdir).list;
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
  if (!r) return res.status(404).json({ error: 'NOT_FOUND', message: config.repositories[req.params.key] ? 'Defined in qivvra.config.yaml; edit that file' : 'Unknown application' });
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
  const vdir = sourceDir(d, 'verifiers');
  d.identities = identitiesIn(vdir).list.map((n) => ({ name: n.name, value: (d.identities ?? []).find((i) => i.name === n.name)?.value }));
  const secrets = { ...(editing ? await existingSecrets(editing) : {}), ...secretsOf(d) };
  // Keep only the secrets the saved settings use.
  const keep = new Set(['POLICIES_GIT_TOKEN', 'VERIFIERS_GIT_TOKEN', ...d.identities.map((i) => i.name)]);
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
    github: { webhookUrl: `${config.server.public_url}/webhooks/github`, events: ['pull_request'], contentType: 'application/json', requiredCheck: 'qivvra/assurance', repository: d.github.repository, base: d.github.base_branch },
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
