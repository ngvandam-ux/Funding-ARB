// Pure alert message builders (no I/O). Used by the alert-watch edge fn.
// Self-contained formatting (no dependency on format.ts) so the Deno mirror is trivial.

// Alert only on opportunities well above the auto-open bars (single 15 / cross 20),
// so pings mean "unusually fat", not routine.
export const ALERT_OPP_APR = 30

function signedPct(n: number): string {
  const sign = n < 0 ? '−' : '+'
  return `${sign}${Math.abs(n).toFixed(2)}%`
}

function signedUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—'
  const sign = n < 0 ? '−' : '+'
  return `${sign}$${Math.abs(n).toFixed(2)}`
}

export interface OppAlertInput {
  baseSymbol: string
  kind: 'single_venue_funding_harvest' | 'cross_venue_basis_arb'
  netApr: number
}

export function formatOppAlert(o: OppAlertInput): string {
  const kind = o.kind === 'cross_venue_basis_arb' ? 'cross-venue' : 'single-venue'
  return `🟢 New opp: ${o.baseSymbol} ${kind} ${signedPct(o.netApr)} net APR`
}

export interface LiqAlertInput {
  id: number
  realizedPnlUsd: number | null
}

export function formatLiquidationAlert(p: LiqAlertInput): string {
  return `🔴 Position #${p.id} liquidated · realized ${signedUsd(p.realizedPnlUsd)}`
}
