import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { config, gitAuth, path, RepoConfig } from './config';

export interface EvidenceRecord {
  kind: string; environmentConfirmed: boolean;
  target: { versionAtStart: { gitSha?: string } | null };
  verifiers: { commit: string | null };
  checks: Record<string, { state: 'SUPPORTED' | 'VIOLATED' | 'NOT_ASSESSED'; reason: string | null; observation: unknown }>;
}

/** Runs QIVVRA's verifiers against the environment and returns their evidence record. */
export async function runVerifiers(repo: RepoConfig, assessmentId: string, sha: string): Promise<{ record: EvidenceRecord; raw: string }> {
  if (repo.verifiers.adapter === 'github-dispatch') {
    // Production path: POST /repos/<verifiers repo>/dispatches {event_type: "qivvra-verify", client_payload}
    // then collect the "qivvra-evidence-<assessment>" artifact. Not wired in this MVP build.
    throw new Error('github-dispatch verifier adapter is not wired in this build; use local-playwright');
  }
  if (repo.verifiers.pull) execFileSync('git', [...gitAuth(repo, 'VERIFIERS'), '-C', path(repo.verifiers.path!), 'pull', '--ff-only', '-q'], { stdio: 'ignore' });
  const outDir = join(config.root, 'data', 'runs', assessmentId);
  mkdirSync(outDir, { recursive: true });
  const env = {
    ...process.env,
    // QIVVRA's test logins for this application, entered by the Admin at onboarding
    ...Object.fromEntries((repo.verifier_env ?? []).filter((k) => repo.secrets?.[k] !== undefined).map((k) => [k, repo.secrets![k]])),
    BASE_URL: repo.environment.base_url,
    EXPECTED_SHA: sha,
    EVIDENCE_DIR: outDir,
    ...(repo.environment.log_path ? { LOG_PATH: path(repo.environment.log_path) } : {}),
  };
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npx', ['playwright', 'test', '--reporter=./reporters/evidence-reporter.ts'], { cwd: path(repo.verifiers.path!), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.resume();
    // Failing checks make Playwright exit non-zero; that is evidence, not an error.
    child.on('close', () => (existsSync(join(outDir, 'evidence.json')) ? resolve() : reject(new Error(`Verifiers produced no evidence: ${err.slice(-500)}`))));
  });
  const raw = readFileSync(join(outDir, 'evidence.json'), 'utf8');
  return { record: JSON.parse(raw), raw };
}
