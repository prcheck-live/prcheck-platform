/**
 * Imported evidence: results from other tools the enterprise requires before release
 * (security scans, dependency audits, performance budgets).
 *
 * The profile lists them (imported_evidence: id, format, gate). The team's CI writes each result for the
 * commit to the application's results source; PRCheck.live waits for them, checks they are about this
 * commit where the format says so, seals each file, and judges it against its gate:
 *   within the gate        -> SUPPORTED
 *   outside the gate       -> FAILED        (blocks: NOT READY)
 *   missing, unreadable,
 *   or about another build -> NOT_ASSESSED  (pending: INDETERMINATE, never READY)
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { path, RepoConfig } from './config';
import { put } from './evidence-store';

export interface ImportSpec { id: string; title: string; format: 'sarif' | 'npm-audit' | 'k6-summary'; owner?: string; gate: Record<string, number> }
export interface ImportResult {
  id: string; title: string; format: string; owner: string | null; state: 'SUPPORTED' | 'FAILED' | 'NOT_ASSESSED';
  summary: string; gate: Record<string, number>; measured: Record<string, number> | null;
  findings: Array<{ level: string; text: string; where?: string; suppressed?: string }>;
  source: string | null; digest: string | null; reason: string | null;
}

export function requiredImports(repo: RepoConfig, profile: string): ImportSpec[] {
  const f = join(path(repo.policies.path), 'profiles', `${profile}.yaml`);
  if (!existsSync(f)) return [];
  return (parse(readFileSync(f, 'utf8'))?.imported_evidence ?? []) as ImportSpec[];
}

const fileFor = (repo: RepoConfig, sha: string, id: string) => join(path(repo.imports!.path), sha.slice(0, 7), `${id}.json`);

/** Waits (up to the configured time) until every required result for the commit has arrived. */
export async function waitForImports(repo: RepoConfig, sha: string, specs: ImportSpec[]) {
  const deadline = Date.now() + (repo.imports?.wait_seconds ?? 60) * 1000;
  while (Date.now() < deadline && specs.some((s) => !existsSync(fileFor(repo, sha, s.id)))) await new Promise((r) => setTimeout(r, 2000));
}

function judge(spec: ImportSpec, doc: any, sha: string): Omit<ImportResult, 'id' | 'title' | 'format' | 'owner' | 'source' | 'digest' | 'gate'> {
  const short = sha.slice(0, 7);
  const over = (measured: Record<string, number>, keys: string[]) => keys.filter((k) => spec.gate[k] !== undefined && measured[k] > spec.gate[k]);
  if (spec.format === 'sarif') {
    const runs = doc?.runs ?? [];
    if (!runs.length) return { state: 'NOT_ASSESSED', summary: 'Not a SARIF report', measured: null, findings: [], reason: 'No runs in the SARIF file' };
    const rev = runs.flatMap((r: any) => r.versionControlProvenance ?? []).map((v: any) => String(v.revisionId ?? '')).find(Boolean);
    if (rev && !rev.startsWith(short) && !sha.startsWith(rev)) return { state: 'NOT_ASSESSED', summary: `Scanned ${rev.slice(0, 7)}, not ${short}`, measured: null, findings: [], reason: `The report is about commit ${rev.slice(0, 7)}` };
    const results = runs.flatMap((r: any) => (r.results ?? []).map((x: any) => ({ ...x, tool: r.tool?.driver?.name })));
    const counted = results.filter((x: any) => !(x.suppressions ?? []).length);
    const measured = { error: 0, warning: 0, note: 0 } as Record<string, number>;
    for (const x of counted) measured[x.level ?? 'warning'] = (measured[x.level ?? 'warning'] ?? 0) + 1;
    const findings = results.slice(0, 8).map((x: any) => ({ level: x.level ?? 'warning', text: `${x.ruleId}: ${x.message?.text ?? ''}`,
      where: x.locations?.[0]?.physicalLocation ? `${x.locations[0].physicalLocation.artifactLocation?.uri}:${x.locations[0].physicalLocation.region?.startLine ?? ''}` : undefined,
      suppressed: (x.suppressions ?? [])[0]?.justification }));
    const bad = over(measured, ['error', 'warning', 'note']);
    const sup = results.length - counted.length;
    const summary = `${runs[0].tool?.driver?.name ?? 'scanner'}: ${measured.error} error, ${measured.warning} warning${sup ? `, ${sup} suppressed` : ''}`;
    return bad.length ? { state: 'FAILED', summary, measured, findings, reason: bad.map((k) => `${measured[k]} ${k}-level result${measured[k] > 1 ? 's' : ''} (gate ${spec.gate[k]})`).join('; ') }
      : { state: 'SUPPORTED', summary, measured, findings, reason: null };
  }
  if (spec.format === 'npm-audit') {
    const v = doc?.metadata?.vulnerabilities;
    if (!v) return { state: 'NOT_ASSESSED', summary: 'Not an npm audit report', measured: null, findings: [], reason: 'metadata.vulnerabilities is missing' };
    const measured: Record<string, number> = { critical: v.critical ?? 0, high: v.high ?? 0, moderate: v.moderate ?? 0, low: v.low ?? 0 };
    const findings = Object.values(doc.vulnerabilities ?? {}).filter((x: any) => ['critical', 'high'].includes(x.severity)).slice(0, 8).map((x: any) => ({
      level: x.severity, text: `${x.name}${x.isDirect ? ' (direct)' : ''}: ${(x.via ?? []).filter((y: any) => typeof y === 'object').map((y: any) => y.url?.split('/').pop()).filter(Boolean).join(', ') || 'via ' + (x.via ?? []).join(', ')}`,
      where: x.fixAvailable && typeof x.fixAvailable === 'object' ? `fix: ${x.fixAvailable.name} ${x.fixAvailable.version}` : undefined }));
    const bad = over(measured, ['critical', 'high', 'moderate', 'low']);
    const summary = `${measured.critical} critical, ${measured.high} high, ${measured.moderate} moderate, ${measured.low} low`;
    return bad.length ? { state: 'FAILED', summary, measured, findings, reason: bad.map((k) => `${measured[k]} ${k} (gate ${spec.gate[k]})`).join('; ') }
      : { state: 'SUPPORTED', summary, measured, findings, reason: null };
  }
  if (spec.format === 'k6-summary') {
    const m = doc?.metrics;
    if (!m?.http_req_duration) return { state: 'NOT_ASSESSED', summary: 'Not a k6 summary', measured: null, findings: [], reason: 'metrics.http_req_duration is missing' };
    const built = doc.meta?.gitSha ? String(doc.meta.gitSha) : null;
    if (built && !built.startsWith(short) && !sha.startsWith(built)) return { state: 'NOT_ASSESSED', summary: `Measured ${built}, not ${short}`, measured: null, findings: [], reason: `The run measured build ${built}` };
    const measured: Record<string, number> = { p95_ms: Math.round(m.http_req_duration['p(95)'] * 10) / 10, error_rate: Math.round((m.http_req_failed?.value ?? m.http_req_failed?.rate ?? 0) * 10000) / 10000, requests: m.http_reqs?.count ?? 0 };
    const bad = over(measured, ['p95_ms', 'error_rate']);
    const summary = `p95 ${measured.p95_ms} ms over ${measured.requests} requests, ${(measured.error_rate * 100).toFixed(2)}% failed`;
    return bad.length ? { state: 'FAILED', summary, measured, findings: [], reason: bad.map((k) => k === 'p95_ms' ? `p95 ${measured.p95_ms} ms > ${spec.gate.p95_ms} ms` : `error rate ${(measured.error_rate * 100).toFixed(2)}% > ${(spec.gate.error_rate * 100).toFixed(2)}%`).join('; ') }
      : { state: 'SUPPORTED', summary, measured, findings: [], reason: null };
  }
  return { state: 'NOT_ASSESSED', summary: `Unknown format ${spec.format}`, measured: null, findings: [], reason: `PRCheck.live cannot read ${spec.format}` };
}

/** Reads, seals and judges every required result for the commit. */
export async function collectImports(repo: RepoConfig, sha: string, specs: ImportSpec[]): Promise<ImportResult[]> {
  const out: ImportResult[] = [];
  for (const spec of specs) {
    const base = { id: spec.id, title: spec.title, format: spec.format, owner: spec.owner ?? null, gate: spec.gate };
    const f = repo.imports ? fileFor(repo, sha, spec.id) : null;
    if (!f || !existsSync(f)) { out.push({ ...base, state: 'NOT_ASSESSED', summary: 'Not received', measured: null, findings: [], source: f, digest: null, reason: `No ${spec.title.toLowerCase()} result for ${sha.slice(0, 7)} yet` }); continue; }
    const raw = readFileSync(f, 'utf8');
    const digest = await put('imported', raw);
    let doc: unknown;
    try { doc = JSON.parse(raw); } catch { out.push({ ...base, state: 'NOT_ASSESSED', summary: 'Unreadable', measured: null, findings: [], source: f, digest, reason: 'The file is not valid JSON' }); continue; }
    out.push({ ...base, ...judge(spec, doc, sha), source: f, digest });
  }
  return out;
}
