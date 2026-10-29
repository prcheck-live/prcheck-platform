import { readFileSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { parse } from 'yaml';

export interface RepoConfig {
  key: string;
  github: string;
  base_branch: string;
  jira_project: string;
  sources: {
    github: { adapter: 'local-git' | 'api'; path?: string };
    jira: { adapter: 'file' | 'cloud'; path?: string };
    xray: { adapter: 'junit'; path: string };
  };
  policies: { path: string };
  environment: { name: string; base_url: string; log_path?: string; wait_for_commit_seconds: number };
  verifiers: { adapter: 'local-playwright' | 'github-dispatch'; path?: string; repository?: string };
}
export interface Config {
  root: string;
  server: { port: number; public_url: string };
  database_url: string;
  evidence_store: string;
  outbox: string;
  repositories: Record<string, RepoConfig>;
}

const file = process.env.QIVVRA_CONFIG ?? join(__dirname, '..', 'qivvra.config.yaml');
const root = dirname(resolve(file));
const raw = parse(readFileSync(file, 'utf8'));

/** Resolves a config path against the config file's folder. */
export const path = (p: string) => (isAbsolute(p) ? p : join(root, p));

export const config: Config = {
  root,
  server: raw.server,
  database_url: process.env.DATABASE_URL ?? raw.database_url,
  evidence_store: path(raw.evidence_store),
  outbox: path(raw.outbox),
  repositories: Object.fromEntries(Object.entries(raw.repositories as Record<string, Omit<RepoConfig, 'key'>>).map(([k, v]) => [k, { ...v, key: k }])),
};

export function repoByGithubName(fullName: string): RepoConfig | undefined {
  return Object.values(config.repositories).find((r) => r.github.toLowerCase() === fullName.toLowerCase());
}
