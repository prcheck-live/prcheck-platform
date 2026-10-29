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
  const f = join(path(repo.sources.xray.path), sha, 'junit.xml');
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
