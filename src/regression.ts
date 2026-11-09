/**
 * Regression lane: did the change break a promise an earlier story already kept?
 *
 * Selection (the agent core's change-impact step, myDelta; deterministic in this build): a story's
 * approved suite names the components it lives in. A change selects every earlier story that shares
 * a component with the files it touches. A changed source file that maps to no component means the
 * impact is unknown, so every earlier story is selected (full regression), never fewer.
 * The selected suites run against the same QE build, and each acceptance criterion is judged exactly
 * like the functional lane: only approved, current checks count.
 */
import { createHash } from 'crypto';
import { readdirSync } from 'fs';
import { join } from 'path';
import { config, RepoConfig } from './config';
import { CriterionResult, FunctionalMission, judgeStory, readManifest, runSpecs, suitesDir } from './agent-core';
import { fetchIssue } from './sources/jira';
import type { PolicySnapshot } from './sources/policies';

const SOURCE = /^(src|db|lib|app|public|server|client)\//;

export interface Selection {
  confidence: 'mapped' | 'unknown-impact';
  /** Who selected: PRCheck.live's component overlap, plus the agent core's impact analysis (myDelta) when connected. */
  source?: string; core?: { version: string; agents: string[] } | null;
  changedComponents: string[];
  unmappedSource: string[];
  selected: Array<{ story: string; because: string }>;
  notSelected: Array<{ story: string; components: string[] }>;
}
export interface RegressionStory { story: string; summary: string | null; because: string; suite: string; criteria: CriterionResult[] }
export interface RegressionRecord {
  kind: 'prcheck.regression/v1'; assessmentId: string; sha: string; selection: Selection;
  suitesCommit: string | null; environmentConfirmed: boolean | null; stories: RegressionStory[];
  checks: import('./agent-core').FunctionalRecord['checks'];
}

export function selectRegression(repo: RepoConfig, snapshot: Pick<PolicySnapshot, 'components' | 'unmappedFiles'>, ownStory: string | null): Selection {
  const { dir } = suitesDir(repo);
  const changed = Object.keys(snapshot.components ?? {});
  const unmappedSource = (snapshot.unmappedFiles ?? []).filter((f) => SOURCE.test(f));
  let stories: string[] = [];
  try { stories = readdirSync(join(dir, 'functional', 'suites')).filter((n) => /\.ya?ml$/.test(n)).map((n) => n.replace(/\.ya?ml$/, '')); } catch { /* no suites */ }
  const selected: Selection['selected'] = [], notSelected: Selection['notSelected'] = [];
  for (const story of stories.sort()) {
    if (story === ownStory) continue;
    const comps = readManifest(dir, story).manifest?.components ?? [];
    const shared = comps.filter((c) => changed.includes(c));
    if (unmappedSource.length) selected.push({ story, because: `impact unknown: ${unmappedSource.slice(0, 3).join(', ')}${unmappedSource.length > 3 ? '…' : ''} map${unmappedSource.length === 1 ? 's' : ''} to no component, so every earlier story is re-verified` });
    else if (!comps.length) selected.push({ story, because: 'its suite names no components, so it is always re-verified' });
    else if (shared.length) selected.push({ story, because: `the change touches ${shared.join(', ')}` });
    else notSelected.push({ story, components: comps });
  }
  return { confidence: unmappedSource.length ? 'unknown-impact' : 'mapped', changedComponents: changed, unmappedSource, selected, notSelected };
}

/**
 * Asks the agent core's myDelta which earlier stories the change can affect, and merges its answer into
 * the component-overlap selection. myDelta may add stories (with its reason); it can never remove one.
 */
export async function withImpact(repo: RepoConfig, selection: Selection, changedFiles: string[], sha: string): Promise<{ selection: Selection; note: string | null }> {
  const am = await import('./agent-missions');
  if (!am.coreConnected(repo)) return { selection: { ...selection, source: 'component overlap' }, note: null };
  const { dir } = suitesDir(repo);
  const stories = [...selection.selected.map((s) => s.story), ...selection.notSelected.map((s) => s.story)].map((key) => ({ key, components: readManifest(dir, key).manifest?.components ?? [] }));
  let components: Record<string, string[]> = {};
  try {
    const { parse } = await import('yaml'); const { readFileSync } = await import('fs');
    const cat = parse(readFileSync(join((await import('./config')).path(repo.policies.path), 'catalog', 'components.yaml'), 'utf8')).repositories?.[repo.key]?.components ?? {};
    components = Object.fromEntries(Object.entries(cat).map(([k, v]: [string, any]) => [k, v.paths ?? []]));
  } catch { /* no catalog */ }
  try {
    const out = await am.runImpact(repo, { application: repo.key, sha, changedFiles, components, stories });
    const picked = (out!.result.selected ?? []) as Array<{ story: string; because: string }>;
    const merged = selection.selected.map((s) => picked.some((p) => p.story === s.story) ? { ...s, because: `${s.because} (confirmed by myDelta)` } : s);
    const added = picked.filter((p) => !selection.selected.some((s) => s.story === p.story) && stories.some((s) => s.key === p.story));
    return { selection: { ...selection, selected: [...merged, ...added.map((p) => ({ story: p.story, because: p.because }))], notSelected: selection.notSelected.filter((n) => !added.some((a) => a.story === n.story)),
      source: 'component overlap + myDelta', core: { version: out!.core?.version ?? '?', agents: out!.agents } },
      note: `myDelta (agent core ${out!.core?.version ?? '?'}) ${added.length ? `added ${added.map((a) => a.story).join(', ')}` : `confirmed the selection`}` };
  } catch (e) {
    return { selection: { ...selection, source: 'component overlap' }, note: `Agent core impact analysis unavailable (${(e as Error).message.slice(0, 160)}); component overlap used` };
  }
}

export async function runRegressionMission(repo: RepoConfig, args: { assessmentId: string; sha: string; selection: Selection; channels: FunctionalMission['channels'] }) {
  const { dir, commit } = suitesDir(repo);
  const picked = await Promise.all(args.selection.selected.map(async (s) => ({ ...s, ...readManifest(dir, s.story), issue: await fetchIssue(repo, s.story).catch(() => null) })));
  const specs = [...new Set(picked.filter((p) => p.manifest).map((p) => p.manifest!.spec))];
  let checks: RegressionRecord['checks'] = {}, environmentConfirmed: boolean | null = null;
  if (specs.length) ({ checks, environmentConfirmed } = await runSpecs(repo, dir, specs, join(config.root, 'data', 'runs', args.assessmentId, 'regression'),
    { qeUrl: repo.environment.base_url, sha: args.sha, channels: args.channels }, repo.functional?.budget_seconds ?? 600));
  const stories: RegressionStory[] = picked.map((p) => ({
    story: p.story, summary: p.issue?.summary ?? null, because: p.because,
    suite: p.raw ? 'sha256:' + createHash('sha256').update(p.raw).digest('hex') : 'none',
    criteria: p.issue
      ? judgeStory(p.story, p.issue.acceptanceCriteria, p.manifest, checks)
      : [{ criterionId: `${p.story}-AC?`, story: p.story, position: 0, text: `${p.story} could not be read from Jira`, textDigest: '', suiteStatus: 'none', checks: [], state: 'NOT_ASSESSED', reason: 'Story not found in Jira' }],
  }));
  const record: RegressionRecord = { kind: 'prcheck.regression/v1', assessmentId: args.assessmentId, sha: args.sha, selection: args.selection, suitesCommit: commit, environmentConfirmed, stories, checks };
  return { record, raw: JSON.stringify(record, null, 2) };
}
