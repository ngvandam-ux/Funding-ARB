import { describe, it, expect } from 'vitest'
import {
  detectOpportunities,
  DEFAULT_THRESHOLDS,
  DEFAULT_MAX_STALENESS_MS,
  type LatestSnapshot,
  type DetectParams,
} from './detect'
import type { VenueId, Tier } from '../types/domain'

// Detection rules: SPEC §5 + the Session 2 design doc.
//  - Single-venue harvest: net APR ≥ 10% (DEFAULT_THRESHOLDS.singleVenueMinApr).
//    Uses abs(funding); side is short on positive funding, long on negative.
//  - Cross-venue basis arb: net APR ≥ 15%, every clearing venue pair emitted.
//  - Staleness: any leg whose snapshot is older than 5 min is dropped; a
//    cross-venue opp requires BOTH legs fresh.

const NOW = new Date('2026-05-31T20:00:00.000Z')

function snap(
  over: Partial<LatestSnapshot> & {
    instrumentId: number
    venueId: VenueId
    baseSymbol: string
    fundingRate1hApr: number
  },
): LatestSnapshot {
  return {
    venueSymbol: `${over.baseSymbol}-${over.venueId}`,
    tier: 'major' as Tier,
    ts: NOW,
    ...over,
  }
}

function params(over: Partial<DetectParams> = {}): DetectParams {
  return {
    now: NOW,
    maxStalenessMs: DEFAULT_MAX_STALENESS_MS,
    thresholds: DEFAULT_THRESHOLDS,
    ...over,
  }
}

describe('detectOpportunities — single-venue funding harvest', () => {
  it('emits a single_venue opp when net APR clears the 10% bar (positive funding → short)', () => {
    const out = detectOpportunities(
      [snap({ instrumentId: 1, venueId: 'hyperliquid', baseSymbol: 'HYPE', fundingRate1hApr: 32 })],
      params(),
    )
    expect(out).toHaveLength(1)
    const o = out[0]
    expect(o.kind).toBe('single_venue_funding_harvest')
    expect(o.baseSymbol).toBe('HYPE')
    expect(o.legA.side).toBe('short') // positive funding → short the perp
    expect(o.legA.venueId).toBe('hyperliquid')
    expect(o.legB).toBeNull()
    expect(o.dedupKey).toBe('single:HYPE:hyperliquid')
    // gross = abs(32) = 32 ; net = 32 − feeDrag − slipDrag (≈0.19) ≈ 31.81
    expect(o.grossApr).toBeCloseTo(32, 6)
    expect(o.netApr).toBeCloseTo(o.grossApr - o.feeDragApr - o.slipDragApr, 6)
    expect(o.netApr).toBeGreaterThan(31)
    expect(o.minPositionUsd).toBe(1000)
  })

  it('harvests negative funding via the long side (abs of funding)', () => {
    const out = detectOpportunities(
      [snap({ instrumentId: 9, venueId: 'hyperliquid', baseSymbol: 'HYPE', fundingRate1hApr: -43 })],
      params(),
    )
    expect(out).toHaveLength(1)
    expect(out[0].legA.side).toBe('long') // negative funding → long the perp
    expect(out[0].grossApr).toBeCloseTo(43, 6) // magnitude
    expect(out[0].netApr).toBeGreaterThan(40)
  })

  it('does NOT emit when net APR is below the 10% bar', () => {
    const out = detectOpportunities(
      [snap({ instrumentId: 1, venueId: 'binance_futures', baseSymbol: 'BTC', fundingRate1hApr: 8 })],
      params(),
    )
    expect(out).toHaveLength(0)
  })

  it('drops a stale snapshot (> 5 min old) and emits nothing', () => {
    const stale = snap({
      instrumentId: 1,
      venueId: 'hyperliquid',
      baseSymbol: 'HYPE',
      fundingRate1hApr: 32,
      ts: new Date(NOW.getTime() - 6 * 60 * 1000), // 6 min old
    })
    expect(detectOpportunities([stale], params())).toHaveLength(0)
  })
})

describe('detectOpportunities — cross-venue basis arb', () => {
  it('emits a cross_venue opp for opposite-sign funding clearing the 15% bar', () => {
    const out = detectOpportunities(
      [
        snap({ instrumentId: 1, venueId: 'hyperliquid', baseSymbol: 'BTC', fundingRate1hApr: 40 }),
        snap({ instrumentId: 2, venueId: 'binance_futures', baseSymbol: 'BTC', fundingRate1hApr: -20 }),
      ],
      params(),
    )
    const cross = out.filter((o) => o.kind === 'cross_venue_basis_arb')
    expect(cross).toHaveLength(1)
    const o = cross[0]
    expect(o.baseSymbol).toBe('BTC')
    // long the negative-funding venue (binance), short the positive (hyperliquid)
    const longLeg = [o.legA, o.legB].find((l) => l?.side === 'long')
    const shortLeg = [o.legA, o.legB].find((l) => l?.side === 'short')
    expect(longLeg?.venueId).toBe('binance_futures')
    expect(shortLeg?.venueId).toBe('hyperliquid')
    expect(o.grossApr).toBeCloseTo(60, 6)
    expect(o.netApr).toBeCloseTo(o.grossApr - o.feeDragApr - o.slipDragApr, 6)
    // dedup key uses alphabetically-sorted venues for stability
    expect(o.dedupKey).toBe('cross:BTC:binance_futures:hyperliquid')
  })

  it('requires BOTH legs fresh — one stale leg means no cross-venue opp', () => {
    const out = detectOpportunities(
      [
        snap({ instrumentId: 1, venueId: 'hyperliquid', baseSymbol: 'BTC', fundingRate1hApr: 40 }),
        snap({
          instrumentId: 2,
          venueId: 'binance_futures',
          baseSymbol: 'BTC',
          fundingRate1hApr: -20,
          ts: new Date(NOW.getTime() - 10 * 60 * 1000),
        }),
      ],
      params(),
    )
    expect(out.filter((o) => o.kind === 'cross_venue_basis_arb')).toHaveLength(0)
  })

  it('does NOT emit a cross opp when the spread is below 15%', () => {
    const out = detectOpportunities(
      [
        snap({ instrumentId: 1, venueId: 'hyperliquid', baseSymbol: 'ETH', fundingRate1hApr: 12 }),
        snap({ instrumentId: 2, venueId: 'binance_futures', baseSymbol: 'ETH', fundingRate1hApr: 10 }),
      ],
      params(),
    )
    expect(out.filter((o) => o.kind === 'cross_venue_basis_arb')).toHaveLength(0)
  })

  it('emits EVERY clearing venue pair for a base symbol (not just the best)', () => {
    // BTC across 3 venues, all opposite-ish so multiple pairs clear 15%.
    const out = detectOpportunities(
      [
        snap({ instrumentId: 1, venueId: 'hyperliquid', baseSymbol: 'BTC', fundingRate1hApr: 40 }),
        snap({ instrumentId: 2, venueId: 'binance_futures', baseSymbol: 'BTC', fundingRate1hApr: -20 }),
        snap({ instrumentId: 3, venueId: 'bybit', baseSymbol: 'BTC', fundingRate1hApr: -25 }),
      ],
      params(),
    )
    const cross = out.filter((o) => o.kind === 'cross_venue_basis_arb')
    // pairs: hl/binance (60), hl/bybit (65), binance/bybit (|−20−−25|=5 → below 15)
    const keys = cross.map((o) => o.dedupKey).sort()
    expect(keys).toEqual([
      'cross:BTC:binance_futures:hyperliquid',
      'cross:BTC:bybit:hyperliquid',
    ])
  })

  it('does not pair across different base symbols', () => {
    const out = detectOpportunities(
      [
        snap({ instrumentId: 1, venueId: 'hyperliquid', baseSymbol: 'BTC', fundingRate1hApr: 40 }),
        snap({ instrumentId: 2, venueId: 'binance_futures', baseSymbol: 'ETH', fundingRate1hApr: -40 }),
      ],
      params(),
    )
    expect(out.filter((o) => o.kind === 'cross_venue_basis_arb')).toHaveLength(0)
  })
})

describe('detectOpportunities — defaults & determinism', () => {
  it('exposes the documented default thresholds and staleness window', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ singleVenueMinApr: 10, crossVenueMinApr: 15 })
    expect(DEFAULT_MAX_STALENESS_MS).toBe(5 * 60 * 1000)
  })

  it('returns a stable order across runs (sorted by dedupKey)', () => {
    const input = [
      snap({ instrumentId: 1, venueId: 'hyperliquid', baseSymbol: 'BTC', fundingRate1hApr: 40 }),
      snap({ instrumentId: 2, venueId: 'binance_futures', baseSymbol: 'BTC', fundingRate1hApr: -20 }),
      snap({ instrumentId: 3, venueId: 'okx', baseSymbol: 'SOL', fundingRate1hApr: 30 }),
    ]
    const a = detectOpportunities(input, params()).map((o) => o.dedupKey)
    const b = detectOpportunities([...input].reverse(), params()).map((o) => o.dedupKey)
    expect(a).toEqual(b)
    expect(a).toEqual([...a].sort())
  })
})
