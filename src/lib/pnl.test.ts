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

  it('single-venue: legB is null and totals come from one leg', () => {
    const r = computeOpenFills({
      legA: { venueId: 'hyperliquid', tier: 'mid', side: 'short', mark: 50 },
      legB: null,
      sizeUsd: 1000,
    })
    expect(r.legB).toBeNull()
    expect(r.feesUsd).toBeCloseTo(0.45, 9)
    expect(r.slippageUsd).toBeCloseTo(1.5, 9) // mid 15bps
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

import { accrueFunding } from './pnl'

describe('accrueFunding', () => {
  const YEAR_MS = 365 * 24 * 60 * 60 * 1000

  it('short leg receives positive funding (longs pay shorts)', () => {
    // +36.5% APR, short, $1000, over exactly 1 day → 36.5/100/365 * 1000 = $1.00
    const f = accrueFunding({
      legA: { side: 'short', fundingRate1hApr: 36.5 },
      legB: null,
      sizeUsd: 1000,
      dtMs: YEAR_MS / 365,
    })
    expect(f).toBeCloseTo(1.0, 9)
  })

  it('long leg on positive funding pays (negative accrual)', () => {
    const f = accrueFunding({
      legA: { side: 'long', fundingRate1hApr: 36.5 },
      legB: null,
      sizeUsd: 1000,
      dtMs: YEAR_MS / 365,
    })
    expect(f).toBeCloseTo(-1.0, 9)
  })

  it('cross-venue: both legs receive funding (long neg-funding, short pos-funding)', () => {
    // legA long on −20% APR → receives +20% ; legB short on +40% APR → receives +40%
    // over 1 year, $1000 → +200 + 400 = +600
    const f = accrueFunding({
      legA: { side: 'long', fundingRate1hApr: -20 },
      legB: { side: 'short', fundingRate1hApr: 40 },
      sizeUsd: 1000,
      dtMs: YEAR_MS,
    })
    expect(f).toBeCloseTo(600, 6)
  })

  it('scales linearly with dt', () => {
    const oneHour = accrueFunding({ legA: { side: 'short', fundingRate1hApr: 10 }, legB: null, sizeUsd: 1000, dtMs: 3_600_000 })
    const twoHour = accrueFunding({ legA: { side: 'short', fundingRate1hApr: 10 }, legB: null, sizeUsd: 1000, dtMs: 7_200_000 })
    expect(twoHour).toBeCloseTo(oneHour * 2, 9)
  })

  it('throws on negative dt', () => {
    expect(() => accrueFunding({ legA: { side: 'short', fundingRate1hApr: 10 }, legB: null, sizeUsd: 1000, dtMs: -1 })).toThrow()
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
