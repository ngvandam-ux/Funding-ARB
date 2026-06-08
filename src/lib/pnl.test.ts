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
