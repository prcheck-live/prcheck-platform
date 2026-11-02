import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { path, RepoConfig } from '../config';

export interface TeamResults {
  source: string;
  total: number; passed: number; failed: number; skipped: number;
  byIssue: Record<string, { total: number; passed: number }>;
}

/**
 * The team's own test results for this commit, as they would be imported into Xray.
 * QIVVRA records them as context. They never decide the disposition: they show
 * what the team checked, which is exactly what the policy gap analysis needs.
 */
export async function teamResults(repo: RepoConfig, sha: string, jiraProject: string): Promise<TeamResults | null> {
  if (repo.sources.xray.adapter === 'cloud') return cloudResults(repo, sha, jiraProject);
  const f = join(path(repo.sources.xray.path!), sha, 'junit.xml');
  if (!existsSync(f)) return null;
  const xml = readFileSync(f, 'utf8');
  const res: TeamResults = { source: `JUnit ${f}`, total: 0, passed: 0, failed: 0, skipped: 0, byIssue: {} };
  const keyRe = new RegExp(`\\b(${jiraProject}-\\d+)\\b`);
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = /name="([^"]*)"/.exec(m[1])?.[1] ?? '';
    const body = m[3] ?? '';
    const failed = /<(failure|error)\b/.test(body);
    const skipped = /<skipped\b/.test(body);
    res.total++;
    if (failed) res.failed++; else if (skipped) res.skipped++; else res.passed++;
    const key = keyRe.exec(name)?.[1];
    if (key) {
      res.byIssue[key] ??= { total: 0, passed: 0 };
      res.byIssue[key].total++;
      if (!failed && !skipped) res.byIssue[key].passed++;
    }
  }
  return res;
}

/** Polls for the team's results for a commit, up to sources.xray.wait_seconds (default 0). */
export async function waitForTeamResults(repo: RepoConfig, sha: string): Promise<TeamResults | null> {
  const deadline = Date.now() + (repo.sources.xray.wait_seconds ?? 0) * 1000;
  for (;;) {
    const r = await teamResults(repo, sha, repo.jira_project);
    if (r || Date.now() >= deadline) return r;
    await new Promise((res) => setTimeout(res, 3000));
  }
}

/* ---------- Xray Cloud ---------- */
export const XRAY_CLOUD = 'https://xray.cloud.getxray.app';
/**
 * Convention: the team's CI imports its results for a commit as a Test Execution
 * labelled commit-<7-char sha> (Xray's JUnit import accepts the labels). QIVVRA
 * finds that execution with JQL and reads its test runs.
 */
export const commitLabel = (sha: string) => `commit-${sha.slice(0, 7)}`;

export async function xrayToken(baseUrl: string, clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v2/authenticate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(res.status === 401 ? 'Xray rejected the client ID or secret' : `Xray authenticate: HTTP ${res.status}`);
  return String(await res.json());
}

export async function xrayGraphql<T = any>(baseUrl: string, token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v2/graphql`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.errors) throw new Error(`Xray GraphQL: ${res.status} ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);
  return j.data as T;
}

async function cloudResults(repo: RepoConfig, sha: string, jiraProject: string): Promise<TeamResults | null> {
  const x = repo.sources.xray, base = x.base_url || XRAY_CLOUD;
  const secret = repo.secrets?.XRAY_CLIENT_SECRET;
  if (!x.client_id || !secret) throw new Error('Xray Cloud needs a client ID and client secret');
  const token = await xrayToken(base, x.client_id, secret);
  const data = await xrayGraphql(base, token, `query($jql: String, $limit: Int!) {
    getTestExecutions(jql: $jql, limit: $limit) { total results {
      jira(fields: ["key"])
      testRuns(limit: 100) { results { status { name } test { jira(fields: ["key", "summary"]) } } } } } }`,
  { jql: `project = "${jiraProject}" AND labels = "${commitLabel(sha)}" ORDER BY created DESC`, limit: 1 });
  const exec = data?.getTestExecutions?.results?.[0];
  if (!exec) return null;
  const res: TeamResults = { source: `Xray Cloud ${exec.jira?.key ?? ''} (${commitLabel(sha)})`, total: 0, passed: 0, failed: 0, skipped: 0, byIssue: {} };
  const keyRe = new RegExp(`\\b(${jiraProject}-\\d+)\\b`);
  for (const run of exec.testRuns?.results ?? []) {
    const st = String(run.status?.name ?? '').toUpperCase();
    const passed = st === 'PASSED', failed = st === 'FAILED' || st === 'ABORTED';
    res.total++;
    if (passed) res.passed++; else if (failed) res.failed++; else res.skipped++;
    const key = keyRe.exec(String(run.test?.jira?.summary ?? ''))?.[1];
    if (key) { res.byIssue[key] ??= { total: 0, passed: 0 }; res.byIssue[key].total++; if (passed) res.byIssue[key].passed++; }
  }
  return res;
}
