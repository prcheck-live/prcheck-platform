import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { gitAuth, path, RepoConfig } from '../config';

export interface PolicySnapshot {
  repository: string; profile: string; policyRepoCommit: string | null; snapshotDigest: string;
  components: Record<string, string[]>; unmappedFiles: string[];
  policies: Array<{
    id: string; title?: string; version: string; authority: string; owner: string; severity: string; file: string; digest: string;
    obligations: Array<{ id: string; statement: string; verifier: string; check: string }>;
  }>;
  exceptions: Array<{ id: string; policy: string; obligations: string[]; expires: string }>;
}

/**
 * Asks the policy repository which rules apply to these files. The policy repo's
 * own selector is the single source of truth, so PRCheck.live and a human running it
 * by hand always get the same answer.
 */
export function selectPolicies(repo: RepoConfig, files: string[], jiraKey: string | null): PolicySnapshot {
  const dir = path(repo.policies.path);
  // Use the latest approved rules: main of the policy repo, as merged with CODEOWNERS approval.
  if (repo.policies.pull) execFileSync('git', [...gitAuth(repo, 'POLICIES'), '-C', dir, 'pull', '--ff-only', '-q'], { stdio: 'ignore' });
  const args = ['tsx', 'scripts/select.ts', '--repo', repo.key, '--paths', files.join(','), '--json'];
  if (jiraKey) args.push('--jira', jiraKey);
  return JSON.parse(execFileSync('npx', args, { cwd: dir, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }));
}

export type EvidenceClass = 'policy' | 'functional' | 'regression' | 'imported';

/**
 * The evidence classes the application's profile requires before READY ("nothing pending").
 * A profile without required_evidence asks for the policy lane only, as before.
 */
export function requiredEvidence(repo: RepoConfig, profile: string): EvidenceClass[] {
  const f = join(path(repo.policies.path), 'profiles', `${profile}.yaml`);
  if (!existsSync(f)) return ['policy'];
  const req = parse(readFileSync(f, 'utf8'))?.required_evidence;
  if (!req) return ['policy'];
  const list = Array.isArray(req) ? req : Object.entries(req).filter(([, v]) => v === 'required' || v === true).map(([k]) => k);
  return (['policy', 'functional', 'regression', 'imported'] as EvidenceClass[]).filter((c) => c === 'policy' || list.includes(c));
}
