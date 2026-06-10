import { describe, it, expect } from 'vitest'
import {
  computeOpenFills,
  INITIAL_BUFFER_FRACTION,
  PAPER_LEVERAGE,
  MAINTENANCE_MARGIN_FRACTION,
} from './pnl'

describe('constants', () => {
  it('derives the initial liquidation buffer from leverage and maintenance', () => {
    // d0 = 1/3 − 0.005 ≈ 0.32833…
    expect(PAPER_LEVERAGE).toBe(3)
    expect(MAINTENANCE_MARGIN_FRACTION).toBe(0.005)
    expect(INITIAL_BUFFER_FRACTION).toBeCloseTo(1 / 3 - 0.005, 9)
  })
})

describe('computeOpenFills', () => {
  it('builds a cross-venue pair: entry=mark, taker fee + slippage per leg, liq prices', () => {
    const r = computeOpenFills({
      legA: { venueId: 'hyperliquid', tier: 'major', side: 'long', mark: 100 },
      legB: { venueId: 'binance_futures', tier: 'major', side: 'short', mark: 100 },
      sizeUsd: 1000,
    })
    // fees: HL 4.5bps*1000=0.45 ; Binance 4.0bps*1000=0.40 ; total 0.85
    expect(r.legA.feeUsd).toBeCloseTo(0.45, 9)
    expect(r.legB!.feeUsd).toBeCloseTo(0.4, 9)
    expect(r.feesUsd).toBeCloseTo(0.85, 9)
    // slippage major 5bps*1000=0.50 each ; total 1.00
    expect(r.legA.slippageBps).toBe(5)
    expect(r.legA.slippageUsd).toBeCloseTo(0.5, 9)
    expect(r.slippageUsd).toBeCloseTo(1.0, 9)
    // entry = mark
    expect(r.legA.entryPrice).toBe(100)
    // liq: long liquidates DOWN, short liquidates UP, by d0
    expect(r.legA.liqPrice).toBeCloseTo(100 * (1 - INITIAL_BUFFER_FRACTION), 6)
    expect(r.legB!.liqPrice).toBeCloseTo(100 * (1 + INITIAL_BUFFER_FRACTION), 6)
  })

  it('single-venue: legB is null and a synthetic spot leg adds its own fee + slippage', () => {
    const r = computeOpenFills({
      legA: { venueId: 'hyperliquid', tier: 'mid', side: 'short', mark: 50 },
      legB: null,
      sizeUsd: 1000,
    })
    expect(r.legB).toBeNull()
    // perp leg: HL 4.5bps fee = 0.45 ; mid 15bps slip = 1.50
    // spot leg: SPOT_TAKER_BPS 10bps fee = 1.00 ; same-tier slip = 1.50
    expect(r.spotLeg).not.toBeNull()
    expect(r.spotLeg!.feeUsd).toBeCloseTo(1.0, 9)
    expect(r.spotLeg!.slippageUsd).toBeCloseTo(1.5, 9)
    expect(r.feesUsd).toBeCloseTo(1.45, 9)
    expect(r.slippageUsd).toBeCloseTo(3.0, 9)
    expect(r.openCostsUsd).toBeCloseTo(4.45, 9)
  })

  it('cross-venue: no spot leg, openCostsUsd = fees + slippage', () => {
    const r = computeOpenFills({
      legA: { venueId: 'hyperliquid', tier: 'major', side: 'long', mark: 100 },
      legB: { venueId: 'binance_futures', tier: 'major', side: 'short', mark: 100 },
      sizeUsd: 1000,
    })
    expect(r.spotLeg).toBeNull()
    expect(r.openCostsUsd).toBeCloseTo(1.85, 9) // 0.85 fees + 1.00 slip
  })

  it('throws on a non-positive size or mark', () => {
    expect(() =>
      computeOpenFills({ legA: { venueId: 'okx', tier: 'major', side: 'long', mark: 100 }, legB: null, sizeUsd: 0 }),
    ).toThrow()
    expect(() =>
      computeOpenFills({ legA: { venueId: 'okx', tier: 'major', side: 'long', mark: 0 }, legB: null, sizeUsd: 1000 }),
    ).toThrow()
  })
})

import { computeUnrealizedPnl } from './pnl'

describe('computeUnrealizedPnl', () => {
  it('single-venue (legB null) is perfectly hedged by spot → 0', () => {
    const pnl = computeUnrealizedPnl({
      legA: { side: 'short', entryPrice: 100 },
      legB: null,
      markA: 130,
      markB: null,
      sizeUsd: 1000,
    })
    expect(pnl).toBe(0)
  })

  it('cross-venue long+short on a +10% move nets ≈ 0 (delta-neutral)', () => {
    // long gains +10% * 1000 = +100 ; short loses -10% * 1000 = -100
    const pnl = computeUnrealizedPnl({
      legA: { side: 'long', entryPrice: 100 },
      legB: { side: 'short', entryPrice: 100 },
      markA: 110,
      markB: 110,
      sizeUsd: 1000,
    })
    expect(pnl).toBeCloseTo(0, 9)
  })

  it('cross-venue captures basis drift when the two marks diverge', () => {
    // long leg +10% = +100 ; short leg only +5% adverse = -50 ; net +50
    const pnl = computeUnrealizedPnl({
      legA: { side: 'long', entryPrice: 100 },
      legB: { side: 'short', entryPrice: 100 },
      markA: 110,
      markB: 105,
      sizeUsd: 1000,
    })
    expect(pnl).toBeCloseTo(50, 9)
  })

  it('throws when a cross-venue position is missing markB', () => {
    expect(() =>
      computeUnrealizedPnl({
        legA: { side: 'long', entryPrice: 100 },
        legB: { side: 'short', entryPrice: 100 },
        markA: 110,
        markB: null,
        sizeUsd: 1000,
      }),
    ).toThrow()
  })
})

import { settleFundingDiscrete, VENUE_FUNDING_INTERVAL_HOURS } from './pnl'

describe('VENUE_FUNDING_INTERVAL_HOURS', () => {
  it('matches the venue funding cadences (api-notes §1-4)', () => {
    expect(VENUE_FUNDING_INTERVAL_HOURS).toEqual({
      hyperliquid: 1,
      binance_futures: 8,
      bybit: 8,
      okx: 8,
    })
  })
})

describe('settleFundingDiscrete', () => {
  const H = 3_600_000
  // Anchor every leg at t=0 epoch-aligned unless a test says otherwise.
  const leg = (side: 'long' | 'short', native: number, intervalHours: number, anchorMs: number | null = null) => ({
    side,
    fundingRateNative: native,
    intervalHours,
    anchorMs,
  })

  it('pays size × native rate when exactly one 8h boundary is crossed (short receives)', () => {
    // boundaries at 0, 8h, 16h… window (7h, 9h] crosses the 8h boundary once.
    const f = settleFundingDiscrete({
      legA: leg('short', 0.0001, 8),
      legB: null,
      sizeUsd: 1000,
      lastMs: 7 * H,
      nowMs: 9 * H,
    })
    expect(f).toBeCloseTo(0.1, 9) // 1000 × 0.0001
  })

  it('pays nothing when no boundary is crossed', () => {
    const f = settleFundingDiscrete({
      legA: leg('short', 0.0001, 8),
      legB: null,
      sizeUsd: 1000,
      lastMs: 9 * H,
      nowMs: 10 * H,
    })
    expect(f).toBe(0)
  })

  it('long pays on positive funding (negative settlement)', () => {
    const f = settleFundingDiscrete({
      legA: leg('long', 0.0001, 8),
      legB: null,
      sizeUsd: 1000,
      lastMs: 7 * H,
      nowMs: 9 * H,
    })
    expect(f).toBeCloseTo(-0.1, 9)
  })

  it('counts every boundary crossed when ticks were skipped', () => {
    // window (7h, 25h] crosses 8h, 16h, 24h → 3 settlements
    const f = settleFundingDiscrete({
      legA: leg('short', 0.0001, 8),
      legB: null,
      sizeUsd: 1000,
      lastMs: 7 * H,
      nowMs: 25 * H,
    })
    expect(f).toBeCloseTo(0.3, 9)
  })

  it('hourly venue settles every hour', () => {
    const f = settleFundingDiscrete({
      legA: leg('short', 0.00001, 1),
      legB: null,
      sizeUsd: 1000,
      lastMs: 0,
      nowMs: 3 * H,
    })
    expect(f).toBeCloseTo(0.03, 9) // 3 settlements × 0.01
  })

  it('a boundary exactly at lastMs is NOT recounted; exactly at nowMs IS counted', () => {
    const atLast = settleFundingDiscrete({
      legA: leg('short', 0.0001, 8),
      legB: null,
      sizeUsd: 1000,
      lastMs: 8 * H,
      nowMs: 9 * H,
    })
    expect(atLast).toBe(0)
    const atNow = settleFundingDiscrete({
      legA: leg('short', 0.0001, 8),
      legB: null,
      sizeUsd: 1000,
      lastMs: 15 * H,
      nowMs: 16 * H,
    })
    expect(atNow).toBeCloseTo(0.1, 9)
  })

  it('respects a venue anchor that is not epoch-aligned', () => {
    // anchor (a known settlement) at 3h; settlements at …, 3h, 11h, 19h …
    // window (10h, 12h] crosses 11h once; epoch-aligned would cross nothing… wait, 8h epoch
    // boundary at 8h or 16h is NOT in (10h,12h], so anchor handling is what's being tested.
    const f = settleFundingDiscrete({
      legA: leg('short', 0.0001, 8, 3 * H),
      legB: null,
      sizeUsd: 1000,
      lastMs: 10 * H,
      nowMs: 12 * H,
    })
    expect(f).toBeCloseTo(0.1, 9)
  })

  it('cross-venue legs settle independently on their own intervals', () => {
    // window (0h, 8h]: hourly leg settles 8×, 8h leg settles once.
    // legA long on −0.00002/h → receives 1000×0.00002×8 = +0.16
    // legB short on +0.0004/8h → receives 1000×0.0004 = +0.40
    const f = settleFundingDiscrete({
      legA: leg('long', -0.00002, 1),
      legB: leg('short', 0.0004, 8),
      sizeUsd: 1000,
      lastMs: 0,
      nowMs: 8 * H,
    })
    expect(f).toBeCloseTo(0.56, 9)
  })

  it('throws when nowMs is before lastMs', () => {
    expect(() =>
      settleFundingDiscrete({ legA: leg('short', 0.0001, 8), legB: null, sizeUsd: 1000, lastMs: 2 * H, nowMs: H }),
    ).toThrow()
  })
})

import { nextNegativeFundingStreak, shouldAutoClose, EXIT_NEGATIVE_TICKS } from './pnl'

describe('exit rule (negative net funding receipt)', () => {
  it('positive receipt resets the streak', () => {
    expect(nextNegativeFundingStreak(5.2, 4)).toBe(0)
  })

  it('negative receipt increments the streak', () => {
    expect(nextNegativeFundingStreak(-0.1, 0)).toBe(1)
    expect(nextNegativeFundingStreak(-3, 4)).toBe(5)
  })

  it('zero receipt counts as negative (not earning → leave)', () => {
    expect(nextNegativeFundingStreak(0, 1)).toBe(2)
  })

  it('closes only when the streak reaches EXIT_NEGATIVE_TICKS consecutive ticks', () => {
    expect(EXIT_NEGATIVE_TICKS).toBe(6)
    expect(shouldAutoClose(5)).toBe(false)
    expect(shouldAutoClose(6)).toBe(true)
    expect(shouldAutoClose(7)).toBe(true)
  })
})

import { assessRisk, INITIAL_BUFFER_FRACTION as D0 } from './pnl'

describe('assessRisk', () => {
  it('fresh position (mark == entry) is open with full buffer', () => {
    const r = assessRisk({ legA: { side: 'short', entryPrice: 100 }, legB: null, markA: 100, markB: null })
    expect(r.status).toBe('open')
    expect(r.liquidationDistanceBps).toBeCloseTo(D0 * 10_000, 4)
  })

  it('short leg: price rising consumes buffer; >80% consumed → at_risk', () => {
    // d0 ≈ 0.3283. at_risk when remaining/d0 < 0.20 → consumed > 0.8*d0 ≈ 0.2627.
    // move +0.27 (27%) adverse → remaining ≈ 0.0583, ratio ≈ 0.178 < 0.20
    const r = assessRisk({ legA: { side: 'short', entryPrice: 100 }, legB: null, markA: 127, markB: null })
    expect(r.status).toBe('at_risk')
  })

  it('>95% consumed → liquidated_paper', () => {
    // move +0.32 adverse → remaining ≈ 0.0083, ratio ≈ 0.025 < 0.05
    const r = assessRisk({ legA: { side: 'short', entryPrice: 100 }, legB: null, markA: 132, markB: null })
    expect(r.status).toBe('liquidated_paper')
  })

  it('long leg: price falling is the adverse direction', () => {
    const r = assessRisk({ legA: { side: 'long', entryPrice: 100 }, legB: null, markA: 68, markB: null })
    expect(r.status).toBe('liquidated_paper')
  })

  it('cross-venue: the binding (losing) leg drives the state', () => {
    // legA long unharmed (price up), legB short deep in adverse → liquidated
    const r = assessRisk({
      legA: { side: 'long', entryPrice: 100 },
      legB: { side: 'short', entryPrice: 100 },
      markA: 132,
      markB: 132,
    })
    expect(r.status).toBe('liquidated_paper')
  })
})

import { computeClose } from './pnl'

describe('computeClose', () => {
  it('realized = price P&L + funding − stored open costs − close costs', () => {
    // cross-venue, marks unchanged (pricePnl 0), $1000/leg, HL+Binance major.
    // close fee: HL 0.45 + Binance 0.40 = 0.85 ; close slip: 0.50 each = 1.00
    // open costs recorded at open = 1.85 ; cumulative funding = +12.00
    // realized = 0 + 12 − 1.85 − (0.85 + 1.00) = 8.30
    const r = computeClose({
      legA: { venueId: 'hyperliquid', tier: 'major', side: 'long', entryPrice: 100 },
      legB: { venueId: 'binance_futures', tier: 'major', side: 'short', entryPrice: 100 },
      markA: 100,
      markB: 100,
      sizeUsd: 1000,
      cumulativeFundingUsd: 12,
      openCostsUsd: 1.85,
    })
    expect(r.pricePnl).toBeCloseTo(0, 9)
    expect(r.closeFeesUsd).toBeCloseTo(0.85, 9)
    expect(r.closeCostsUsd).toBeCloseTo(1.85, 9)
    expect(r.totalCostsUsd).toBeCloseTo(3.7, 9)
    expect(r.realizedPnlUsd).toBeCloseTo(8.3, 9)
    expect(r.legA.exitPrice).toBe(100)
  })

  it('single-venue: spot leg costs charged at close too', () => {
    // HL short, mid tier. close: perp fee 0.45 + perp slip 1.50 + spot fee 1.00 + spot slip 1.50 = 4.45
    // open costs (recorded) = 4.45 ; funding +5
    // realized = 0 + 5 − 4.45 − 4.45 = −3.90
    const r = computeClose({
      legA: { venueId: 'hyperliquid', tier: 'mid', side: 'short', entryPrice: 50 },
      legB: null,
      markA: 50,
      markB: null,
      sizeUsd: 1000,
      cumulativeFundingUsd: 5,
      openCostsUsd: 4.45,
    })
    expect(r.legB).toBeNull()
    expect(r.spotLeg).not.toBeNull()
    expect(r.closeCostsUsd).toBeCloseTo(4.45, 9)
    expect(r.realizedPnlUsd).toBeCloseTo(-3.9, 9)
  })

  it('uses the actually-stored open costs, not an assumed mirror of close costs', () => {
    // openCostsUsd deliberately ≠ close costs (e.g. fee table changed mid-run).
    const r = computeClose({
      legA: { venueId: 'hyperliquid', tier: 'major', side: 'long', entryPrice: 100 },
      legB: { venueId: 'binance_futures', tier: 'major', side: 'short', entryPrice: 100 },
      markA: 100,
      markB: 100,
      sizeUsd: 1000,
      cumulativeFundingUsd: 0,
      openCostsUsd: 9.99,
    })
    expect(r.realizedPnlUsd).toBeCloseTo(0 - 9.99 - 1.85, 9)
  })
})
