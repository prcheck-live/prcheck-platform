import { execFileSync } from 'child_process';
import { path, RepoConfig } from '../config';

export interface ChangeFiles { files: string[]; source: string }

/** Lists the files a PR changes between its base and head commit. */
export async function changedFiles(repo: RepoConfig, base: string, head: string): Promise<ChangeFiles> {
  const src = repo.sources.github;
  if (src.adapter === 'local-git') {
    const dir = path(src.path!);
    const out = execFileSync('git', ['-C', dir, 'diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' });
    return { files: out.split('\n').filter(Boolean), source: `git diff ${base}...${head} (${dir})` };
  }
  const files: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await githubApi(`/repos/${repo.github}/compare/${base}...${head}?per_page=100&page=${page}`, {}, repo);
    const batch = (res.files ?? []) as Array<{ filename: string }>;
    files.push(...batch.map((f) => f.filename));
    if (batch.length < 100) break;
  }
  return { files, source: `GitHub compare ${repo.github} ${base}...${head}` };
}

/** The application's own token (entered at onboarding), else the organisation's (PRCHECK_GITHUB_TOKEN). */
export const githubToken = (repo?: Pick<RepoConfig, 'secrets'>) => repo?.secrets?.GITHUB_TOKEN || process.env.PRCHECK_GITHUB_TOKEN || '';

export async function githubApi(apiPath: string, init: { method?: string; body?: unknown } = {}, repo?: Pick<RepoConfig, 'secrets'>) {
  const token = githubToken(repo);
  if (!token) throw new Error('No GitHub token: give one for this application, or set PRCHECK_GITHUB_TOKEN for the organisation');
  const res = await fetch(`https://api.github.com${apiPath}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${apiPath}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/** The Jira key links GitHub, Jira and Xray. Taken from the PR title first, then the branch. */
export function jiraKeyFrom(project: string, ...texts: Array<string | undefined>): string | null {
  const re = new RegExp(`\\b(${project}-\\d+)\\b`);
  for (const t of texts) { const m = t?.match(re); if (m) return m[1]; }
  return null;
}

/** First line of the head commit message, shown as the revision summary. */
export async function commitSubject(repo: RepoConfig, sha: string): Promise<string | null> {
  try {
    if (repo.sources.github.adapter === 'local-git') {
      return execFileSync('git', ['-C', path(repo.sources.github.path!), 'log', '-1', '--format=%s', sha], { encoding: 'utf8' }).trim() || null;
    }
    const c = await githubApi(`/repos/${repo.github}/commits/${sha}`, {}, repo);
    return String(c.commit?.message ?? '').split('\n')[0] || null;
  } catch { return null; }
}
