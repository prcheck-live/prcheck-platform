import type { CriterionResult } from './agent-core';
import type { EvidenceClass } from './sources/policies';
import type { ImportResult } from './imports';
import type { PolicySnapshot } from './sources/policies';
import type { EvidenceRecord } from './verify';

export type State = 'SUPPORTED' | 'VIOLATED' | 'INSUFFICIENT' | 'CONFLICTED' | 'NOT_ASSESSED';
export type Disposition = 'READY' | 'READY_WITH_EXCEPTIONS' | 'NOT_READY' | 'INDETERMINATE' | 'AWAITING_ASSESSMENT';

export interface ObligationResult {
  obligationId: string; policyId: string; policyVersion: string; authority: string; owner: string; severity: string;
  statement: string; check: string; state: State; reason: string | null; exceptedBy: string | null;
}

/** Maps verifier evidence onto the frozen obligations. No evidence for a check means INSUFFICIENT. */
export function assess(snapshot: PolicySnapshot, evidence: EvidenceRecord | null,
  pending: Record<string, { status: string }> = {}): ObligationResult[] {
  const out: ObligationResult[] = [];
  for (const p of snapshot.policies) {
    for (const o of p.obligations) {
      const check = `${o.verifier}/${o.check}`;
      const c = evidence?.checks[check];
      const exception = snapshot.exceptions.find((x) => x.policy === p.id && x.obligations.includes(o.id));
      out.push({
        obligationId: o.id, policyId: p.id, policyVersion: p.version, authority: p.authority, owner: p.owner, severity: p.severity,
        statement: o.statement, check,
        // A new obligation whose verifier the agent core is still producing, or a Lead has not approved, is not assessed yet.
        state: pending[check] ? 'NOT_ASSESSED' : c ? c.state : evidence ? 'INSUFFICIENT' : 'NOT_ASSESSED',
        reason: pending[check] ? `Verifier ${check} is ${pending[check].status}, not yet approved by an Assurance Lead`
          : c?.reason ?? (c ? null : evidence ? 'No verifier evidence for this check' : 'Verifiers did not run'),
        exceptedBy: exception?.id ?? null,
      });
    }
  }
  return out;
}

/**
 * The payments-critical profile (vendorpay-policies/profiles/payments-critical.yaml),
 * first match wins. Exceptions can only cover INSUFFICIENT, never VIOLATED.
 */
export function dispose(results: ObligationResult[]): { disposition: Disposition; because: string } {
  const ids = (f: (r: ObligationResult) => boolean) => results.filter(f).map((r) => r.obligationId);
  // Nothing pending: any obligation not assessed keeps the change from READY, whatever its severity.
  const notAssessed = ids((r) => r.state === 'NOT_ASSESSED');
  if (notAssessed.length) return { disposition: 'INDETERMINATE', because: `not assessed: ${notAssessed.join(', ')}` };
  const violated = ids((r) => r.state === 'VIOLATED' || r.state === 'CONFLICTED');
  if (violated.length) return { disposition: 'NOT_READY', because: `violated: ${violated.join(', ')}` };
  const open = ids((r) => r.state === 'INSUFFICIENT' && !r.exceptedBy);
  if (open.length) return { disposition: 'NOT_READY', because: `insufficient evidence: ${open.join(', ')}` };
  const excepted = ids((r) => r.state === 'INSUFFICIENT');
  if (excepted.length) return { disposition: 'READY_WITH_EXCEPTIONS', because: `under exception: ${excepted.join(', ')}` };
  return { disposition: 'READY', because: `all ${results.length} obligations supported` };
}

export const label = (d: Disposition) => d.replace(/_/g, ' ');

/* ---------- The production verdict across lanes ---------- */

export interface LaneSummary {
  required: EvidenceClass[];
  policy: { disposition: Disposition; because: string; obligations: number; supported: number };
  functional: { required: boolean; ran: boolean; story: string | null; criteria: number; supported: number; failed: number; pending: number; because: string } | null;
  regression: { required: boolean; ran: boolean; confidence: string | null; stories: Array<{ story: string; because: string; criteria: number; supported: number; failed: number; pending: number }>;
    criteria: number; supported: number; failed: number; pending: number; because: string } | null;
  imported: { required: boolean; ran: boolean; total: number; supported: number; failed: number; pending: number; because: string;
    items: Array<{ id: string; title: string; state: string; summary: string }> } | null;
  pending: string[];
}

/**
 * One answer for production. Positive evidence of a broken rule or promise blocks first;
 * then anything a required lane could not prove makes the change INDETERMINATE; only when
 * every required class is complete does the policy disposition (READY or READY WITH EXCEPTIONS) stand.
 */
export function disposeAll(
  policy: { disposition: Disposition; because: string }, obligations: ObligationResult[],
  required: EvidenceClass[], functional: { story: string | null; configured: boolean; criteria: CriterionResult[] | null },
  regression: { configured: boolean; confidence: string | null; stories: Array<{ story: string; because: string; criteria: CriterionResult[] }> | null } = { configured: false, confidence: null, stories: null },
  imported: { configured: boolean; results: ImportResult[] | null } = { configured: false, results: null },
): { disposition: Disposition; because: string; lanes: LaneSummary } {
  const fnRequired = required.includes('functional');
  const crit = functional.criteria ?? [];
  const failed = crit.filter((c) => c.state === 'FAILED').map((c) => c.criterionId);
  const open = crit.filter((c) => c.state === 'NOT_ASSESSED' || c.state === 'INCONCLUSIVE').map((c) => c.criterionId);
  const pending: string[] = [];
  let fnBecause = 'not required by the profile';
  if (fnRequired) {
    if (!functional.configured) pending.push('functional lane is required but not configured for this application');
    else if (!functional.story) pending.push('no Jira story linked, so there are no acceptance criteria to verify');
    else if (functional.criteria === null) pending.push('acceptance criteria were not verified');
    else if (!crit.length) pending.push(`${functional.story} has no acceptance criteria`);
    else if (open.length) pending.push(`not yet verified: ${open.join(', ')}`);
  }
  if (functional.criteria) fnBecause = failed.length ? `failed: ${failed.join(', ')}` : open.length ? `not yet verified: ${open.join(', ')}` : `all ${crit.length} acceptance criteria supported`;
  else if (fnRequired) fnBecause = pending[0] ?? 'not run';

  // Regression: earlier stories selected by change impact
  const rgRequired = required.includes('regression');
  const rgCrit = (regression.stories ?? []).flatMap((s) => s.criteria);
  const rgFailed = rgCrit.filter((c) => c.state === 'FAILED').map((c) => c.criterionId);
  const rgOpen = rgCrit.filter((c) => c.state === 'NOT_ASSESSED' || c.state === 'INCONCLUSIVE').map((c) => c.criterionId);
  if (rgRequired) {
    if (!regression.configured) pending.push('regression lane is required but no suites repository is configured');
    else if (regression.stories === null) pending.push('earlier stories were not re-verified');
    else if (rgOpen.length) pending.push(`regression not yet verified: ${rgOpen.join(', ')}`);
  }
  const rgBecause = regression.stories === null ? (rgRequired ? 'not run' : 'not required by the profile')
    : !regression.stories.length ? 'no earlier story shares a component with this change'
    : rgFailed.length ? `earlier stories broken: ${rgFailed.join(', ')}` : rgOpen.length ? `not yet verified: ${rgOpen.join(', ')}`
    : `${regression.stories.length} earlier stor${regression.stories.length === 1 ? 'y' : 'ies'} still keep all ${rgCrit.length} promises`;

  // Imported evidence: results from other tools the profile requires
  const imRequired = required.includes('imported');
  const im = imported.results ?? [];
  const imFailed = im.filter((x) => x.state === 'FAILED'), imOpen = im.filter((x) => x.state === 'NOT_ASSESSED');
  if (imRequired) {
    if (!imported.configured) pending.push('imported evidence is required but no results source is configured');
    else if (imported.results === null) pending.push('results from other tools were not collected');
    else if (imOpen.length) pending.push(`waiting for ${imOpen.map((x) => x.title.toLowerCase()).join(', ')}`);
  }
  const imBecause = imported.results === null ? (imRequired ? 'not collected' : 'not required by the profile')
    : !im.length ? 'the profile lists no results from other tools'
    : imFailed.length ? `outside the gate: ${imFailed.map((x) => `${x.title} (${x.reason})`).join('; ')}`
    : imOpen.length ? `waiting for ${imOpen.map((x) => x.title.toLowerCase()).join(', ')}` : `all ${im.length} required results within their gates`;

  const lanes: LaneSummary = {
    required,
    policy: { ...policy, obligations: obligations.length, supported: obligations.filter((o) => o.state === 'SUPPORTED').length },
    functional: fnRequired || functional.criteria ? {
      required: fnRequired, ran: functional.criteria !== null, story: functional.story, criteria: crit.length,
      supported: crit.filter((c) => c.state === 'SUPPORTED').length, failed: failed.length, pending: open.length, because: fnBecause,
    } : null,
    regression: rgRequired || regression.stories ? {
      required: rgRequired, ran: regression.stories !== null, confidence: regression.confidence,
      stories: (regression.stories ?? []).map((s) => ({ story: s.story, because: s.because, criteria: s.criteria.length,
        supported: s.criteria.filter((c) => c.state === 'SUPPORTED').length, failed: s.criteria.filter((c) => c.state === 'FAILED').length,
        pending: s.criteria.filter((c) => c.state === 'NOT_ASSESSED' || c.state === 'INCONCLUSIVE').length })),
      criteria: rgCrit.length, supported: rgCrit.filter((c) => c.state === 'SUPPORTED').length, failed: rgFailed.length, pending: rgOpen.length, because: rgBecause,
    } : null,
    imported: imRequired || imported.results ? { required: imRequired, ran: imported.results !== null, total: im.length,
      supported: im.filter((x) => x.state === 'SUPPORTED').length, failed: imFailed.length, pending: imOpen.length, because: imBecause,
      items: im.map((x) => ({ id: x.id, title: x.title, state: x.state, summary: x.summary })) } : null,
    pending,
  };

  const blocks: string[] = [];
  if (policy.disposition === 'NOT_READY') blocks.push(policy.because);
  if (failed.length) blocks.push(`acceptance criteria failed: ${failed.join(', ')}`);
  if (rgFailed.length) blocks.push(`earlier stories broken: ${rgFailed.join(', ')}`);
  if (imFailed.length) blocks.push(`outside the gate: ${imFailed.map((x) => `${x.title.toLowerCase()} (${x.reason})`).join('; ')}`);
  if (blocks.length) return { disposition: 'NOT_READY', because: blocks.join('; '), lanes };
  if (policy.disposition === 'INDETERMINATE') return { disposition: 'INDETERMINATE', because: policy.because, lanes };
  if (pending.length) return { disposition: 'INDETERMINATE', because: `pending: ${pending.join('; ')}`, lanes };
  const done = [`${obligations.length} obligations`, ...(lanes.functional?.ran ? [`${crit.length} acceptance criteria`] : []),
    ...(lanes.regression?.ran && rgCrit.length ? [`${rgCrit.length} earlier-story criteria`] : []),
    ...(lanes.imported?.ran && im.length ? [`${im.length} required tool results`] : [])].join(', ').replace(/, ([^,]*)$/, ' and $1');
  const because = policy.disposition === 'READY' ? `all ${done} supported; nothing pending` : `${policy.because}; everything else supported; nothing pending`;
  return { disposition: policy.disposition, because, lanes };
}
