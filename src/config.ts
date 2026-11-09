import { readFileSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { parse } from 'yaml';

export interface RepoConfig {
  key: string;
  app?: string;
  /** Where this application was defined: prcheck.config.yaml, or onboarded by an Admin in the UI. */
  origin?: 'file' | 'ui';
  status?: 'active' | 'paused';
  /** Decrypted credentials, in memory only (see secrets.ts). */
  secrets?: Record<string, string>;
  /** Names of secrets passed to the verifiers as environment variables (their test logins). */
  verifier_env?: string[];
  github: string;
  base_branch: string;
  jira_project: string;
  sources: {
    github: { adapter: 'local-git' | 'api'; path?: string };
    jira: { adapter: 'file' | 'cloud'; path?: string; base_url?: string; email?: string };
    xray: { adapter: 'junit' | 'cloud'; path?: string; base_url?: string; client_id?: string; wait_seconds?: number };
  };
  policies: { path: string; pull?: boolean; repository?: string };
  environment: { name: string; base_url: string; log_path?: string; wait_for_commit_seconds: number };
  verifiers: { adapter: 'local-playwright' | 'github-dispatch'; path?: string; repository?: string; pull?: boolean };
  /** Functional lane: approved checks per acceptance criterion, produced by the agent core. Defaults to the verifiers repository. */
  functional?: { adapter: 'frozen-suites' | 'agent-core'; path?: string; repository?: string; pull?: boolean; budget_seconds?: number; core_version?: string };
  /** The myDiya agent core (prcheck.agent-core/v1): impact analysis and generation of verifiers and suites. Token: secret AGENT_CORE_TOKEN. */
  agent_core?: { url: string; version?: string };
  /** The team's own automation repository: read-only context for the agents, never evidence. */
  team_automation?: { path: string; repository?: string; pull?: boolean };
  /** Where the team's CI writes results from other tools: <path>/<commit>/<id>.json, one per profile import. */
  imports?: { adapter: 'files'; path: string; wait_seconds?: number };
  /** Channels the functional and regression lanes test on QE. */
  channels?: { ui?: { url?: string; browsers?: string[] }; api?: { base_url?: string; spec?: string }; mcp?: { url: string } };
}
export interface Config {
  root: string;
  server: { port: number; public_url: string };
  database_url: string;
  evidence_store: string;
  outbox: string;
  repositories: Record<string, RepoConfig>;
}

const file = process.env.PRCHECK_CONFIG ?? join(__dirname, '..', 'prcheck.config.yaml');
const root = dirname(resolve(file));
const raw = parse(readFileSync(file, 'utf8'));

/** Resolves a config path against the config file's folder. */
export const path = (p: string) => (isAbsolute(p) ? p : join(root, p));

export const config: Config = {
  root,
  server: { ...raw.server, public_url: process.env.PRCHECK_PUBLIC_URL || raw.server.public_url },
  database_url: process.env.DATABASE_URL ?? raw.database_url,
  evidence_store: path(raw.evidence_store),
  outbox: path(raw.outbox),
  repositories: Object.fromEntries(Object.entries((raw.repositories ?? {}) as Record<string, Omit<RepoConfig, 'key'>>).map(([k, v]) => [k, { ...v, key: k, origin: 'file' as const }])),
};

/** Adds or replaces an application onboarded in the UI. Applications from the config file cannot be replaced. */
export function registerRepo(r: RepoConfig) {
  const existing = config.repositories[r.key];
  if (existing && existing.origin === 'file') throw new Error(`${r.key} is defined in prcheck.config.yaml`);
  config.repositories[r.key] = r;
}

/** Git credentials for a private policy or verifier repository, passed per command, never written to .git/config. */
export function gitAuth(r: RepoConfig, which: 'POLICIES' | 'VERIFIERS' | 'SUITES' | 'TEAM'): string[] {
  const t = r.secrets?.[`${which}_GIT_TOKEN`];
  return t ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${t}`).toString('base64')}`] : [];
}

export function repoByGithubName(fullName: string): RepoConfig | undefined {
  return Object.values(config.repositories).find((r) => r.github.toLowerCase() === fullName.toLowerCase());
}
