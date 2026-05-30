import { describe, it, expect } from 'vitest'
import {
  normalizeHyperliquid,
  normalizeBinance,
  normalizeBybit,
  normalizeOkx,
} from './normalize'

// Sample payloads are shaped per api-notes §1–5. APR annualization:
//   HL hourly × 24 × 365 × 100; 8h venues × 3 × 365 × 100; OKX 4h × 6 × 365 × 100.

describe('normalizeHyperliquid', () => {
  it('annualizes the hourly funding rate and converts OI to USD', () => {
    const ctx = {
      funding: '0.0000125', // hourly fractional
      markPx: '100000',
      oraclePx: '99990',
      openInterest: '1234.5', // coin units → × markPx for USD
    }
    const out = normalizeHyperliquid({
      ctx,
      venueSymbol: 'BTC',
      baseSymbol: 'BTC',
      ts: new Date('2026-05-30T00:00:00Z'),
    })
    expect(out.venueId).toBe('hyperliquid')
    expect(out.venueSymbol).toBe('BTC')
    expect(out.baseSymbol).toBe('BTC')
    expect(out.fundingRateNative).toBeCloseTo(0.0000125, 12)
    // 0.0000125 * 24 * 365 * 100 = 10.95
    expect(out.fundingRate1hApr).toBeCloseTo(10.95, 6)
    expect(out.markPrice).toBe(100000)
    expect(out.indexPrice).toBe(99990)
    // OI USD = 1234.5 * 100000
    expect(out.openInterestUsd).toBeCloseTo(1234.5 * 100000, 2)
    expect(out.nextFundingTs).toBeNull()
  })

  it('treats "funding": "0" as valid (zero), not null', () => {
    const out = normalizeHyperliquid({
      ctx: { funding: '0', markPx: '100000', oraclePx: '100000', openInterest: '0' },
      venueSymbol: 'BTC',
      baseSymbol: 'BTC',
      ts: new Date('2026-05-30T00:00:00Z'),
    })
    expect(out.fundingRateNative).toBe(0)
    expect(out.fundingRate1hApr).toBe(0)
  })

  it('handles negative funding', () => {
    const out = normalizeHyperliquid({
      ctx: { funding: '-0.0000125', markPx: '2000', oraclePx: '2000', openInterest: '10' },
      venueSymbol: 'ETH',
      baseSymbol: 'ETH',
      ts: new Date('2026-05-30T00:00:00Z'),
    })
    expect(out.fundingRate1hApr).toBeCloseTo(-10.95, 6)
  })

  it('throws on a malformed payload', () => {
    expect(() =>
      normalizeHyperliquid({
        // missing markPx
        ctx: { funding: '0.0001', oraclePx: '1', openInterest: '1' } as unknown as {
          funding: string
          markPx: string
          oraclePx: string
          openInterest: string
        },
        venueSymbol: 'BTC',
        baseSymbol: 'BTC',
        ts: new Date(),
      }),
    ).toThrow()
  })
})

describe('normalizeBinance', () => {
  it('coerces string rate, annualizes per-8h, parses ms-epoch nextFundingTime', () => {
    const item = {
      symbol: 'BTCUSDT',
      markPrice: '100000.5',
      indexPrice: '99998.1',
      lastFundingRate: '0.0001', // string per-8h
      nextFundingTime: 1748563200000, // ms epoch
    }
    const out = normalizeBinance({
      item,
      baseSymbol: 'BTC',
      openInterestUsd: 5_000_000,
      ts: new Date('2026-05-30T00:00:00Z'),
    })
    expect(out.venueId).toBe('binance_futures')
    expect(out.venueSymbol).toBe('BTCUSDT')
    expect(out.fundingRateNative).toBeCloseTo(0.0001, 12)
    // 0.0001 * 3 * 365 * 100 = 10.95
    expect(out.fundingRate1hApr).toBeCloseTo(10.95, 6)
    expect(out.markPrice).toBeCloseTo(100000.5, 6)
    expect(out.indexPrice).toBeCloseTo(99998.1, 6)
    expect(out.openInterestUsd).toBe(5_000_000)
    expect(out.nextFundingTs).toEqual(new Date(1748563200000))
  })

  it('handles negative funding', () => {
    const out = normalizeBinance({
      item: {
        symbol: 'ETHUSDT',
        markPrice: '2000',
        indexPrice: '2000',
        lastFundingRate: '-0.0001',
        nextFundingTime: 1748563200000,
      },
      baseSymbol: 'ETH',
      openInterestUsd: null,
      ts: new Date('2026-05-30T00:00:00Z'),
    })
    expect(out.fundingRate1hApr).toBeCloseTo(-10.95, 6)
    expect(out.openInterestUsd).toBeNull()
  })

  it('throws on a non-numeric rate string', () => {
    expect(() =>
      normalizeBinance({
        item: {
          symbol: 'BTCUSDT',
          markPrice: '100000',
          indexPrice: '100000',
          lastFundingRate: 'not-a-number',
          nextFundingTime: 1748563200000,
        },
        baseSymbol: 'BTC',
        openInterestUsd: null,
        ts: new Date(),
      }),
    ).toThrow()
  })
})

describe('normalizeBybit', () => {
  it('coerces string rate + string ms-epoch nextFundingTime; OI value is USD', () => {
    const item = {
      symbol: 'BTCUSDT',
      markPrice: '100000',
      indexPrice: '99999',
      fundingRate: '0.0001', // string per-8h
      nextFundingTime: '1748563200000', // STRING ms epoch
      openInterest: '50.5',
      openInterestValue: '5050000', // already USD
    }
    const out = normalizeBybit({
      item,
      baseSymbol: 'BTC',
      ts: new Date('2026-05-30T00:00:00Z'),
    })
    expect(out.venueId).toBe('bybit')
    expect(out.fundingRateNative).toBeCloseTo(0.0001, 12)
    expect(out.fundingRate1hApr).toBeCloseTo(10.95, 6)
    expect(out.openInterestUsd).toBeCloseTo(5050000, 2)
    expect(out.nextFundingTs).toEqual(new Date(1748563200000))
  })

  it('handles zero and negative funding', () => {
    const zero = normalizeBybit({
      item: {
        symbol: 'BTCUSDT',
        markPrice: '100000',
        indexPrice: '100000',
        fundingRate: '0',
        nextFundingTime: '1748563200000',
        openInterest: '0',
        openInterestValue: '0',
      },
      baseSymbol: 'BTC',
      ts: new Date(),
    })
    expect(zero.fundingRate1hApr).toBe(0)

    const neg = normalizeBybit({
      item: {
        symbol: 'SOLUSDT',
        markPrice: '150',
        indexPrice: '150',
        fundingRate: '-0.0001',
        nextFundingTime: '1748563200000',
        openInterest: '1',
        openInterestValue: '150',
      },
      baseSymbol: 'SOL',
      ts: new Date(),
    })
    expect(neg.fundingRate1hApr).toBeCloseTo(-10.95, 6)
  })
})

describe('normalizeOkx', () => {
  it('8h pair → × 3 × 365 × 100', () => {
    // fundingTime → nextFundingTime delta = 8h
    const fundingTime = Date.parse('2026-05-30T00:00:00Z')
    const nextFundingTime = Date.parse('2026-05-30T08:00:00Z')
    const out = normalizeOkx({
      funding: {
        instId: 'BTC-USDT-SWAP',
        fundingRate: '0.0001',
        fundingTime: String(fundingTime),
        nextFundingTime: String(nextFundingTime),
      },
      ticker: { instId: 'BTC-USDT-SWAP', markPx: '100000', idxPx: '99999' },
      baseSymbol: 'BTC',
      openInterestUsd: 7_000_000,
      ts: new Date('2026-05-30T00:00:00Z'),
    })
    expect(out.venueId).toBe('okx')
    expect(out.fundingRate1hApr).toBeCloseTo(10.95, 6)
    expect(out.nextFundingTs).toEqual(new Date(nextFundingTime))
  })

  it('4h pair → × 6 × 365 × 100 (detected from fundingTime delta — the classic bug)', () => {
    const fundingTime = Date.parse('2026-05-30T00:00:00Z')
    const nextFundingTime = Date.parse('2026-05-30T04:00:00Z') // 4h delta
    const out = normalizeOkx({
      funding: {
        instId: 'SOL-USDT-SWAP',
        fundingRate: '0.0001',
        fundingTime: String(fundingTime),
        nextFundingTime: String(nextFundingTime),
      },
      ticker: { instId: 'SOL-USDT-SWAP', markPx: '150', idxPx: '150' },
      baseSymbol: 'SOL',
      openInterestUsd: null,
      ts: new Date('2026-05-30T00:00:00Z'),
    })
    // 0.0001 * 6 * 365 * 100 = 21.9 (NOT 10.95 — that would be the 8h bug)
    expect(out.fundingRate1hApr).toBeCloseTo(21.9, 6)
    expect(out.openInterestUsd).toBeNull()
  })

  it('handles negative funding on a 4h pair', () => {
    const fundingTime = Date.parse('2026-05-30T00:00:00Z')
    const nextFundingTime = Date.parse('2026-05-30T04:00:00Z')
    const out = normalizeOkx({
      funding: {
        instId: 'ETH-USDT-SWAP',
        fundingRate: '-0.0001',
        fundingTime: String(fundingTime),
        nextFundingTime: String(nextFundingTime),
      },
      ticker: { instId: 'ETH-USDT-SWAP', markPx: '2000', idxPx: '2000' },
      baseSymbol: 'ETH',
      openInterestUsd: null,
      ts: new Date(),
    })
    expect(out.fundingRate1hApr).toBeCloseTo(-21.9, 6)
  })

  it('throws on a malformed funding payload', () => {
    expect(() =>
      normalizeOkx({
        funding: {
          instId: 'BTC-USDT-SWAP',
          fundingRate: 'x',
          fundingTime: '0',
          nextFundingTime: '0',
        },
        ticker: { instId: 'BTC-USDT-SWAP', markPx: '100000', idxPx: '99999' },
        baseSymbol: 'BTC',
        openInterestUsd: null,
        ts: new Date(),
      }),
    ).toThrow()
  })
})
