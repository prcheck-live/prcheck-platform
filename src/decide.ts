import type { PolicySnapshot } from './sources/policies';
import type { EvidenceRecord } from './verify';

export type State = 'SUPPORTED' | 'VIOLATED' | 'INSUFFICIENT' | 'CONFLICTED' | 'NOT_ASSESSED';
export type Disposition = 'READY' | 'READY_WITH_EXCEPTIONS' | 'NOT_READY' | 'INDETERMINATE' | 'AWAITING_ASSESSMENT';

export interface ObligationResult {
  obligationId: string; policyId: string; policyVersion: string; authority: string; owner: string; severity: string;
  statement: string; check: string; state: State; reason: string | null; exceptedBy: string | null;
}

/** Maps verifier evidence onto the frozen obligations. No evidence for a check means INSUFFICIENT. */
export function assess(snapshot: PolicySnapshot, evidence: EvidenceRecord | null): ObligationResult[] {
  const out: ObligationResult[] = [];
  for (const p of snapshot.policies) {
    for (const o of p.obligations) {
      const check = `${o.verifier}/${o.check}`;
      const c = evidence?.checks[check];
      const exception = snapshot.exceptions.find((x) => x.policy === p.id && x.obligations.includes(o.id));
      out.push({
        obligationId: o.id, policyId: p.id, policyVersion: p.version, authority: p.authority, owner: p.owner, severity: p.severity,
        statement: o.statement, check,
        state: c ? c.state : evidence ? 'INSUFFICIENT' : 'NOT_ASSESSED',
        reason: c?.reason ?? (c ? null : evidence ? 'No verifier evidence for this check' : 'Verifiers did not run'),
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
  const notAssessed = ids((r) => r.state === 'NOT_ASSESSED' && r.severity === 'critical');
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
