import { describe, it, expect } from 'vitest'
import { coinalyzeSymbol, fundingAprFromNative, nextFunding8hUtc } from './coinalyze'

describe('coinalyzeSymbol', () => {
  it('maps Binance futures to the _PERP.A format', () => {
    expect(coinalyzeSymbol('binance_futures', 'BTCUSDT')).toBe('BTCUSDT_PERP.A')
    expect(coinalyzeSymbol('binance_futures', 'ETHUSDT')).toBe('ETHUSDT_PERP.A')
  })
  it('maps Bybit to the .6 format (no _PERP suffix)', () => {
    expect(coinalyzeSymbol('bybit', 'BTCUSDT')).toBe('BTCUSDT.6')
    expect(coinalyzeSymbol('bybit', 'SOLUSDT')).toBe('SOLUSDT.6')
  })
  it('throws on a venue this adapter does not cover', () => {
    expect(() => coinalyzeSymbol('hyperliquid', 'BTC')).toThrow()
    expect(() => coinalyzeSymbol('okx', 'BTC-USDT-SWAP')).toThrow()
  })
})

describe('fundingAprFromNative', () => {
  it('annualizes an 8h native rate to the project APR convention (×3×365×100)', () => {
    // matches normalizeBinance/normalizeBybit so cross-venue compare is apples-to-apples
    expect(fundingAprFromNative(0.0001)).toBeCloseTo(0.0001 * 3 * 365 * 100, 9) // 10.95
    expect(fundingAprFromNative(-0.009635)).toBeCloseTo(-0.009635 * 3 * 365 * 100, 6)
    expect(fundingAprFromNative(0)).toBe(0)
  })
})

describe('nextFunding8hUtc', () => {
  it('returns the next 00/08/16 UTC boundary as ISO', () => {
    // 2026-06-09T03:10Z → next boundary 08:00Z
    expect(nextFunding8hUtc(Date.parse('2026-06-09T03:10:00Z'))).toBe('2026-06-09T08:00:00.000Z')
    // 2026-06-09T09:00Z → next boundary 16:00Z
    expect(nextFunding8hUtc(Date.parse('2026-06-09T09:00:00Z'))).toBe('2026-06-09T16:00:00.000Z')
    // 2026-06-09T20:00Z → rolls to next day 00:00Z
    expect(nextFunding8hUtc(Date.parse('2026-06-09T20:00:00Z'))).toBe('2026-06-10T00:00:00.000Z')
    // exactly on a boundary → the following one
    expect(nextFunding8hUtc(Date.parse('2026-06-09T08:00:00Z'))).toBe('2026-06-09T16:00:00.000Z')
  })
})
