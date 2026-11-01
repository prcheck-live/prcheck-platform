import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { path, RepoConfig } from '../config';

export interface JiraIssue {
  key: string; summary: string; status: string; type: string; labels: string[];
  acceptanceCriteria: string[]; source: string;
}

export async function fetchIssue(repo: RepoConfig, key: string): Promise<JiraIssue | null> {
  const src = repo.sources.jira;
  if (src.adapter === 'file') {
    const f = join(path(src.path!), `${key}.json`);
    if (!existsSync(f)) return null;
    return { ...JSON.parse(readFileSync(f, 'utf8')), source: `file ${f}` };
  }
  const base = (src.base_url ?? process.env.JIRA_BASE_URL)?.replace(/\/+$/, ''), email = src.email ?? process.env.JIRA_EMAIL;
  const token = repo.secrets?.JIRA_TOKEN ?? process.env.JIRA_TOKEN;
  if (!base || !email || !token) throw new Error('Jira site, email and API token must be set for the cloud adapter');
  const res = await fetch(`${base}/rest/api/3/issue/${key}?fields=summary,status,issuetype,labels,description`, {
    headers: { authorization: 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64'), accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Jira ${key}: ${res.status}`);
  const j = await res.json();
  const text = adfToText(j.fields.description);
  return {
    key, summary: j.fields.summary, status: j.fields.status?.name, type: j.fields.issuetype?.name, labels: j.fields.labels ?? [],
    acceptanceCriteria: text.split('\n').map((l) => l.trim()).filter((l) => /^\d+[.)]\s/.test(l)).map((l) => l.replace(/^\d+[.)]\s*/, '')),
    source: `Jira Cloud ${base}`,
  };
}

/** Flattens Atlassian Document Format to plain text, one paragraph or list item per line. */
function adfToText(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  const inner = (node.content ?? []).map(adfToText).join(node.type === 'orderedList' || node.type === 'bulletList' || node.type === 'doc' ? '\n' : '');
  if (node.type === 'orderedList') return inner.split('\n').map((l: string, i: number) => `${i + 1}. ${l}`).join('\n');
  return inner;
}
