// Pure gate for the auto-open engine: does this opportunity warrant a paper position?
// Two bounds — the PAPER-OPEN bar (lower) and a SANITY ceiling (upper). The ceiling is
// a circuit breaker: real funding-arb net APR sustains well under 100%, so anything above
// MAX_SANE_APR is almost certainly bad/misnormalized data — never open on it.
// (A 2026-06-09 ingest bug produced 1000%+ opps that auto-opened 21 junk positions.)
import type { OpportunityKind } from '../types/domain'

export const SINGLE_OPEN_APR = 15
export const CROSS_OPEN_APR = 20
export const MAX_SANE_APR = 200

export function paperOpenBar(kind: OpportunityKind): number {
  // momentum_harvest deliberately shares the single-venue bar: same single-leg
  // delta-neutral economics, only the entry signal differs (promoted to
  // auto-open 2026-06-11; its net APR already carries the harsher 52-cycle drag).
  return kind === 'cross_venue_basis_arb' ? CROSS_OPEN_APR : SINGLE_OPEN_APR
}

export function shouldAutoOpen(kind: OpportunityKind, netApr: number): boolean {
  if (!Number.isFinite(netApr)) return false
  return netApr >= paperOpenBar(kind) && netApr <= MAX_SANE_APR
}
