// Pure Coinalyze adapter helpers (no I/O). The ingest-coinalyze edge fn uses these
// to map our Binance/Bybit instruments to Coinalyze symbols and to normalize funding
// to the project's APR convention — identical to normalizeBinance/normalizeBybit so
// cross-venue comparison stays apples-to-apples (CLAUDE.md hard rule #4).
import type { VenueId } from '../types/domain'

// Coinalyze exchange codes (confirmed via /exchanges): A=Binance, 6=Bybit.
// Binance perps are "<SYM>_PERP.A"; Bybit perps are "<SYM>.6" (no _PERP suffix).
const EIGHT_H_PER_YEAR = 3 * 365

export function coinalyzeSymbol(venueId: VenueId, venueSymbol: string): string {
  switch (venueId) {
    case 'binance_futures':
      return `${venueSymbol}_PERP.A`
    case 'bybit':
      return `${venueSymbol}.6`
    default:
      throw new Error(`coinalyze adapter does not cover venue: ${venueId}`)
  }
}

/** Binance + Bybit fund every 8h; annualize to % the same way normalize.ts does. */
export function fundingAprFromNative(nativeRate: number): number {
  return nativeRate * EIGHT_H_PER_YEAR * 100
}

const EIGHT_H_MS = 8 * 60 * 60 * 1000

/** Next 00:00 / 08:00 / 16:00 UTC boundary strictly after `nowMs`, as ISO. */
export function nextFunding8hUtc(nowMs: number): string {
  const next = Math.floor(nowMs / EIGHT_H_MS) * EIGHT_H_MS + EIGHT_H_MS
  return new Date(next).toISOString()
}
