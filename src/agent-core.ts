/**
 * The agent core, as PRCheck.live sees it: a mission goes in, sealed evidence comes out.
 *
 * PRCheck.live never asks the agents for a verdict. A functional mission returns, per acceptance
 * criterion, what the frozen and approved checks observed on the QE build. Agents generate and
 * heal those checks elsewhere (generation, proof and approval); here only approved checks run.
 *
 * Adapters:
 *   frozen-suites  runs the approved suites from the suites repository with Playwright (this build)
 *   agent-core     sends the mission to the packaged myDiya agent core (next step; not wired yet)
 */
import { createHash } from 'crypto';
import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { config, gitAuth, path, RepoConfig } from './config';
import type { JiraIssue } from './sources/jira';

export type CriterionState = 'SUPPORTED' | 'FAILED' | 'NOT_ASSESSED' | 'INCONCLUSIVE';
export type SuiteStatus = 'approved' | 'proven' | 'generated' | 'returned' | 'stale' | 'none';

export interface FunctionalMission {
  kind: 'prcheck.mission.functional/v1';
  assessmentId: string; repository: string; sha: string; qeUrl: string;
  story: { key: string; summary: string; acceptanceCriteria: string[] };
  changedFiles: string[];
  /** What the application offers on QE: UI, API (with its specification) and MCP. */
  channels: { ui?: { url?: string; browsers?: string[] }; api?: { base_url?: string; spec?: string }; mcp?: { url: string } };
  /** Names of PRCheck.live's test logins; the values travel as environment variables, never in the mission. */
  identities: string[];
  budgetSeconds: number;
}

export interface CriterionResult {
  criterionId: string; story: string; position: number; text: string; textDigest: string;
  suiteStatus: SuiteStatus; checks: string[]; state: CriterionState; reason: string | null;
}

export interface FunctionalRecord {
  kind: 'prcheck.functional/v1';
  mission: FunctionalMission;
  core: { adapter: string; name: string; version: string; pinned: string | null; agents: string[] };
  suite: { story: string; file: string; digest: string; approvedBy: string | null; approvedAt: string | null } | null;
  environmentConfirmed: boolean | null;
  suitesCommit: string | null;
  checks: Record<string, { state: 'SUPPORTED' | 'FAILED' | 'NOT_ASSESSED'; reason: string | null; observation: unknown }>;
  criteria: CriterionResult[];
}

/** The same normalisation the suite manifest uses, so whitespace or a trailing full stop never makes a criterion stale. */
export const criterionDigest = (text: string) =>
  createHash('sha256').update(text.split(/\s+/).filter(Boolean).join(' ').replace(/\.+$/, '').toLowerCase()).digest('hex').slice(0, 12);

export interface SuiteManifest {
  story: string; spec: string; components?: string[]; approved_by?: string; approved_at?: string;
  generated_by?: { core?: string; version?: string; agents?: string[] };
  criteria: Array<{ id: string; text_digest: string; status: SuiteStatus; checks: string[] }>;
}

export function buildMission(repo: RepoConfig, assessmentId: string, sha: string, jira: JiraIssue, files: string[]): FunctionalMission {
  return {
    kind: 'prcheck.mission.functional/v1', assessmentId, repository: repo.github, sha, qeUrl: repo.environment.base_url,
    story: { key: jira.key, summary: jira.summary, acceptanceCriteria: jira.acceptanceCriteria },
    changedFiles: files, channels: repo.channels ?? { ui: { url: repo.environment.base_url, browsers: ['chromium'] } }, identities: repo.verifier_env ?? [], budgetSeconds: repo.functional?.budget_seconds ?? 600,
  };
}

/** The environment a suite run gets: test logins, the QE build it must see, and the channels to test. */
function suiteEnv(repo: RepoConfig, mission: { qeUrl: string; sha: string; channels: FunctionalMission['channels'] }, outDir: string) {
  return {
    ...process.env,
    ...Object.fromEntries((repo.verifier_env ?? []).filter((k) => repo.secrets?.[k] !== undefined).map((k) => [k, repo.secrets![k]])),
    BASE_URL: mission.qeUrl, EXPECTED_SHA: mission.sha.slice(0, 7), EVIDENCE_DIR: outDir,
    ...(repo.environment.log_path ? { LOG_PATH: path(repo.environment.log_path) } : {}),
    ...(mission.channels.ui?.url ? { UI_URL: mission.channels.ui.url, BROWSERS: (mission.channels.ui.browsers ?? ['chromium']).join(',') } : {}),
    ...(mission.channels.api?.base_url ? { API_BASE_URL: mission.channels.api.base_url } : {}),
    ...(mission.channels.mcp?.url ? { MCP_URL: mission.channels.mcp.url } : {}),
    ...(repo.secrets?.MCP_TOKEN ? { MCP_TOKEN: repo.secrets.MCP_TOKEN } : {}),
  };
}

/** Suites live in the suites repository (or the verifiers repository when none is given); pulled before a run. */
export function suitesDir(repo: RepoConfig): { dir: string; commit: string | null } {
  const fn = repo.functional!;
  // The suites that decide always run from the repository, frozen; the agent core only produces them.
  const dir = path(fn.path ?? repo.verifiers.path!);
  if (fn.pull) execFileSync('git', [...gitAuth(repo, repo.secrets?.SUITES_GIT_TOKEN ? 'SUITES' : 'VERIFIERS'), '-C', dir, 'pull', '--ff-only', '-q'], { stdio: 'ignore' });
  let commit: string | null = null;
  try { commit = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a checkout */ }
  return { dir, commit };
}
export function readManifest(dir: string, story: string): { manifest: SuiteManifest | null; raw: string | null } {
  const f = join(dir, 'functional', 'suites', `${story}.yaml`);
  const raw = existsSync(f) ? readFileSync(f, 'utf8') : null;
  return { manifest: raw ? parse(raw) : null, raw };
}

/** Runs spec files against QE in one Playwright run and returns each check's evidence. */
export async function runSpecs(repo: RepoConfig, dir: string, specs: string[], outDir: string, mission: { qeUrl: string; sha: string; channels: FunctionalMission['channels'] }, budgetSeconds: number) {
  mkdirSync(outDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npx', ['playwright', 'test', '-c', 'playwright.functional.config.ts', ...specs, '--reporter=./reporters/functional-reporter.ts'],
      { cwd: dir, env: suiteEnv(repo, mission, outDir), stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), budgetSeconds * 1000);
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.resume();
    child.on('close', () => { clearTimeout(timer); existsSync(join(outDir, 'functional.json')) ? resolve() : reject(new Error(`Suite run produced no evidence: ${err.slice(-500)}`)); });
  });
  const ev = JSON.parse(readFileSync(join(outDir, 'functional.json'), 'utf8'));
  const checks: FunctionalRecord['checks'] = Object.fromEntries(Object.entries(ev.checks as Record<string, any>).map(([k, c]) => [k, { state: c.state, reason: c.reason, observation: c.observation }]));
  return { checks, environmentConfirmed: ev.environmentConfirmed as boolean };
}

/** Judges one story's acceptance criteria from its manifest and the checks' evidence. Only approved, current checks count. */
export function judgeStory(story: string, acceptanceCriteria: string[], manifest: SuiteManifest | null, checks: FunctionalRecord['checks']): CriterionResult[] {
  return acceptanceCriteria.map((text, i) => {
    const id = `AC${i + 1}`, textDigest = criterionDigest(text);
    const base = { criterionId: `${story}-${id}`, story, position: i + 1, text, textDigest };
    const entry = manifest?.criteria.find((c) => c.id === id);
    if (!manifest) return { ...base, suiteStatus: 'none' as const, checks: [], state: 'NOT_ASSESSED' as const, reason: `No functional suite for ${story} yet: the agent core must generate it and an Assurance Lead must approve it` };
    if (!entry) return { ...base, suiteStatus: 'none' as const, checks: [], state: 'NOT_ASSESSED' as const, reason: `The ${story} suite has no check for ${id}` };
    if (entry.text_digest !== textDigest) return { ...base, suiteStatus: 'stale' as const, checks: entry.checks, state: 'NOT_ASSESSED' as const, reason: `${id} changed in Jira after its checks were approved; they must be regenerated and approved again` };
    if (entry.status !== 'approved') return { ...base, suiteStatus: entry.status, checks: entry.checks, state: 'NOT_ASSESSED' as const, reason: `Checks for ${id} are ${entry.status}, not yet approved by an Assurance Lead` };
    const results = entry.checks.map((c) => ({ c, r: checks[c] }));
    const failed = results.find((x) => x.r?.state === 'FAILED');
    const missing = results.find((x) => !x.r || x.r.state === 'NOT_ASSESSED');
    if (failed) return { ...base, suiteStatus: 'approved' as const, checks: entry.checks, state: 'FAILED' as const, reason: `${failed.c}: ${(failed.r!.reason ?? 'failed').replace(/^Error:\s*/, '')}` };
    if (missing) return { ...base, suiteStatus: 'approved' as const, checks: entry.checks, state: 'NOT_ASSESSED' as const, reason: `${missing.c}: ${missing.r?.reason ?? 'did not run'}` };
    return { ...base, suiteStatus: 'approved' as const, checks: entry.checks, state: 'SUPPORTED' as const, reason: null };
  });
}

export async function runFunctionalMission(repo: RepoConfig, mission: FunctionalMission): Promise<{ record: FunctionalRecord; raw: string }> {
  const fn = repo.functional!;
  const { dir, commit: suitesCommit } = suitesDir(repo);
  const story = mission.story.key;
  const { manifest, raw: manifestRaw } = readManifest(dir, story);
  // Run the suite's checks against QE. Unapproved checks run too, as advisory evidence, but never count.
  let checks: FunctionalRecord['checks'] = {}, environmentConfirmed: boolean | null = null;
  if (manifest) ({ checks, environmentConfirmed } = await runSpecs(repo, dir, [manifest.spec], join(config.root, 'data', 'runs', mission.assessmentId, 'functional'), mission, mission.budgetSeconds));
  const criteria = judgeStory(story, mission.story.acceptanceCriteria, manifest, checks);
  const record: FunctionalRecord = {
    kind: 'prcheck.functional/v1', mission,
    core: { adapter: fn.adapter, name: manifest?.generated_by?.core ?? 'mydiya-agent-core', version: manifest?.generated_by?.version ?? '—', pinned: fn.core_version ?? null, agents: manifest?.generated_by?.agents ?? [] },
    suite: manifest ? { story, file: `functional/suites/${story}.yaml`, digest: 'sha256:' + createHash('sha256').update(manifestRaw!).digest('hex'), approvedBy: manifest.approved_by ?? null, approvedAt: manifest.approved_at ? String(manifest.approved_at) : null } : null,
    environmentConfirmed, suitesCommit, checks, criteria,
  };
  return { record, raw: JSON.stringify(record, null, 2) };
}
