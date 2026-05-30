import { describe, it, expect } from 'vitest'
import {
  computeNetApr,
  computeBasisArbNetApr,
  applySlippage,
  VENUE_TAKER_BPS,
  SLIPPAGE_BPS_BY_TIER,
} from './math'

// All formulas come from SPEC §5. Fees from api-notes §6, slippage from api-notes §7.
// APR values below are already-normalized percent figures (fundingRate1hApr).

describe('applySlippage', () => {
  it('returns slippage cost in USD for a major-tier leg (5 bps)', () => {
    // 5 bps of $100,000 = $50
    expect(applySlippage(100_000, 'major')).toBeCloseTo(50, 6)
  })

  it('returns slippage cost for a mid-tier leg (15 bps)', () => {
    // 15 bps of $100,000 = $150
    expect(applySlippage(100_000, 'mid')).toBeCloseTo(150, 6)
  })

  it('returns slippage cost for an alt-tier leg (50 bps)', () => {
    // 50 bps of $100,000 = $500
    expect(applySlippage(100_000, 'alt')).toBeCloseTo(500, 6)
  })

  it('uses the documented tier bps table', () => {
    expect(SLIPPAGE_BPS_BY_TIER).toEqual({ major: 5, mid: 15, alt: 50 })
  })

  it('throws on a non-positive notional', () => {
    expect(() => applySlippage(0, 'major')).toThrow()
    expect(() => applySlippage(-1, 'major')).toThrow()
  })

  it('throws on a non-finite notional', () => {
    expect(() => applySlippage(Number.NaN, 'major')).toThrow()
  })
})

describe('VENUE_TAKER_BPS', () => {
  it('matches the api-notes §6 fee schedule', () => {
    expect(VENUE_TAKER_BPS).toEqual({
      hyperliquid: 4.5,
      binance_futures: 4.0,
      bybit: 5.5,
      okx: 5.0,
    })
  })
})

describe('computeNetApr (single-venue funding harvest)', () => {
  it('subtracts fee drag and slippage drag, scaled by cyclesPerYear', () => {
    // gross 50% APR, $100k notional, hyperliquid (4.5 bps taker), major (5 bps), 1 cycle/yr.
    // round-trip fee = open+close on the single short leg = 2 * 4.5 bps = 9 bps of 100k = $90
    // slippage round-trip = 2 * 5 bps = 10 bps of 100k = $100
    // feeDrag% = 90 / 100000 * 1 * 100 = 0.09%
    // slipDrag% = 100 / 100000 * 1 * 100 = 0.10%
    // net = 50 - 0.09 - 0.10 = 49.81
    const net = computeNetApr({
      grossApr: 50,
      positionNotionalUsd: 100_000,
      venueId: 'hyperliquid',
      tier: 'major',
      cyclesPerYear: 1,
    })
    expect(net).toBeCloseTo(49.81, 6)
  })

  it('scales drag up with more cycles per year', () => {
    // Same as above but 4 cycles/yr → drag is 4x.
    // feeDrag% = 0.09 * 4 = 0.36 ; slipDrag% = 0.10 * 4 = 0.40 ; net = 50 - 0.76 = 49.24
    const net = computeNetApr({
      grossApr: 50,
      positionNotionalUsd: 100_000,
      venueId: 'hyperliquid',
      tier: 'major',
      cyclesPerYear: 4,
    })
    expect(net).toBeCloseTo(49.24, 6)
  })

  it('can go negative when drag exceeds a tiny gross APR', () => {
    const net = computeNetApr({
      grossApr: 0.05,
      positionNotionalUsd: 100_000,
      venueId: 'bybit',
      tier: 'alt',
      cyclesPerYear: 50,
    })
    expect(net).toBeLessThan(0)
  })

  it('throws on a non-positive notional', () => {
    expect(() =>
      computeNetApr({
        grossApr: 50,
        positionNotionalUsd: 0,
        venueId: 'hyperliquid',
        tier: 'major',
        cyclesPerYear: 1,
      }),
    ).toThrow()
  })

  it('throws on a non-positive cyclesPerYear', () => {
    expect(() =>
      computeNetApr({
        grossApr: 50,
        positionNotionalUsd: 100_000,
        venueId: 'hyperliquid',
        tier: 'major',
        cyclesPerYear: 0,
      }),
    ).toThrow()
  })
})

describe('computeBasisArbNetApr (cross-venue)', () => {
  it('opposite signs → gross = abs(a) + abs(b)', () => {
    // a = +40 (positive funding venue), b = -20 (negative funding venue).
    // gross = 40 + 20 = 60.
    // Both legs: hyperliquid 4.5 bps + binance 4.0 bps, $100k, major, 1 cycle/yr.
    // leg A round-trip fee = 2 * 4.5 bps = $90 ; leg B = 2 * 4.0 bps = $80 → $170
    // feeDrag% = 170/100000*100 = 0.17
    // slippage each leg round-trip = 2 * 5 bps = $100 each → $200 ; slipDrag% = 0.20
    // net = 60 - 0.17 - 0.20 = 59.63
    const res = computeBasisArbNetApr({
      legA: { venueId: 'hyperliquid', aprPct: 40, tier: 'major' },
      legB: { venueId: 'binance_futures', aprPct: -20, tier: 'major' },
      positionNotionalUsd: 100_000,
      cyclesPerYear: 1,
    })
    expect(res.grossApr).toBeCloseTo(60, 6)
    expect(res.netApr).toBeCloseTo(59.63, 6)
  })

  it('same signs (both positive) → gross = abs(a - b)', () => {
    const res = computeBasisArbNetApr({
      legA: { venueId: 'hyperliquid', aprPct: 40, tier: 'major' },
      legB: { venueId: 'binance_futures', aprPct: 25, tier: 'major' },
      positionNotionalUsd: 100_000,
      cyclesPerYear: 1,
    })
    expect(res.grossApr).toBeCloseTo(15, 6)
    expect(res.netApr).toBeCloseTo(15 - 0.17 - 0.2, 6)
  })

  it('same signs (both negative) → gross = abs(a - b)', () => {
    const res = computeBasisArbNetApr({
      legA: { venueId: 'hyperliquid', aprPct: -40, tier: 'major' },
      legB: { venueId: 'binance_futures', aprPct: -25, tier: 'major' },
      positionNotionalUsd: 100_000,
      cyclesPerYear: 1,
    })
    expect(res.grossApr).toBeCloseTo(15, 6)
  })

  // SPEC §5.2 (corrected rule): long the negative-funding venue, short the positive-funding venue.
  it('direction: longs the negative-funding venue, shorts the positive-funding venue', () => {
    const res = computeBasisArbNetApr({
      legA: { venueId: 'hyperliquid', aprPct: -20, tier: 'major' }, // negative → long
      legB: { venueId: 'binance_futures', aprPct: 40, tier: 'major' }, // positive → short
      positionNotionalUsd: 100_000,
      cyclesPerYear: 1,
    })
    expect(res.longVenue).toBe('hyperliquid')
    expect(res.shortVenue).toBe('binance_futures')
  })

  it('direction holds regardless of leg ordering', () => {
    const res = computeBasisArbNetApr({
      legA: { venueId: 'binance_futures', aprPct: 40, tier: 'major' }, // positive → short
      legB: { venueId: 'hyperliquid', aprPct: -20, tier: 'major' }, // negative → long
      positionNotionalUsd: 100_000,
      cyclesPerYear: 1,
    })
    expect(res.longVenue).toBe('hyperliquid')
    expect(res.shortVenue).toBe('binance_futures')
  })

  it('same-sign (both positive): long the lower-funding venue, short the higher', () => {
    // Both positive: you still want to be short where you receive the most,
    // long where you pay the least → long the lower APR, short the higher APR.
    const res = computeBasisArbNetApr({
      legA: { venueId: 'hyperliquid', aprPct: 25, tier: 'major' },
      legB: { venueId: 'binance_futures', aprPct: 40, tier: 'major' },
      positionNotionalUsd: 100_000,
      cyclesPerYear: 1,
    })
    expect(res.shortVenue).toBe('binance_futures') // higher positive
    expect(res.longVenue).toBe('hyperliquid') // lower positive
  })

  it('throws on a non-positive notional', () => {
    expect(() =>
      computeBasisArbNetApr({
        legA: { venueId: 'hyperliquid', aprPct: 40, tier: 'major' },
        legB: { venueId: 'binance_futures', aprPct: -20, tier: 'major' },
        positionNotionalUsd: 0,
        cyclesPerYear: 1,
      }),
    ).toThrow()
  })

  it('throws on a non-positive cyclesPerYear', () => {
    expect(() =>
      computeBasisArbNetApr({
        legA: { venueId: 'hyperliquid', aprPct: 40, tier: 'major' },
        legB: { venueId: 'binance_futures', aprPct: -20, tier: 'major' },
        positionNotionalUsd: 100_000,
        cyclesPerYear: 0,
      }),
    ).toThrow()
  })
})
