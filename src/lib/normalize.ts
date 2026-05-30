// Venue payload → common NormalizedFunding shape (api-notes §5). Pure functions.
// No I/O. Each venue payload is parsed with a zod schema; the schema defines the
// type (CLAUDE.md hard rule #5: no `any`). Dates via date-fns (hard rule: no raw
// Date arithmetic).

import { z } from 'zod'
import { differenceInHours } from 'date-fns'
import type { VenueId } from '../types/domain'

// api-notes §5 — the ONLY cross-venue-comparable shape.
export interface NormalizedFunding {
  venueId: VenueId
  venueSymbol: string
  baseSymbol: string
  fundingRateNative: number // raw per-venue-interval rate
  fundingRate1hApr: number // % annualized — the only field used for comparison
  nextFundingTs: Date | null
  markPrice: number
  indexPrice: number | null
  openInterestUsd: number | null
  ts: Date
}

// A zod helper that accepts a numeric string (venues send rates/prices as strings)
// and coerces to a finite number, rejecting NaN like "not-a-number".
const numericString = z
  .union([z.string(), z.number()])
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n), { message: 'expected a finite number' })

const HOURS_PER_YEAR = 24 * 365

// ---------------------------------------------------------------------------
// Hyperliquid — api-notes §1. `funding` is the HOURLY fractional rate.
// ---------------------------------------------------------------------------

const HyperliquidCtxSchema = z.object({
  funding: numericString, // "0" is valid (zero), not null — api-notes §1 gotcha
  markPx: numericString,
  oraclePx: numericString,
  openInterest: numericString, // coin units → × markPx for USD
})
type HyperliquidCtx = z.input<typeof HyperliquidCtxSchema>

export interface NormalizeHyperliquidArgs {
  ctx: HyperliquidCtx
  venueSymbol: string
  baseSymbol: string
  ts: Date
}

export function normalizeHyperliquid(
  args: NormalizeHyperliquidArgs,
): NormalizedFunding {
  const { venueSymbol, baseSymbol, ts } = args
  const ctx = HyperliquidCtxSchema.parse(args.ctx)
  const fundingRateNative = ctx.funding
  // Hyperliquid funds hourly: × 24 × 365 × 100.
  const fundingRate1hApr = fundingRateNative * HOURS_PER_YEAR * 100
  return {
    venueId: 'hyperliquid',
    venueSymbol,
    baseSymbol,
    fundingRateNative,
    fundingRate1hApr,
    nextFundingTs: null, // not in metaAndAssetCtxs payload
    markPrice: ctx.markPx,
    indexPrice: ctx.oraclePx,
    openInterestUsd: ctx.openInterest * ctx.markPx, // OI is in coin units
    ts,
  }
}

// ---------------------------------------------------------------------------
// Binance USDⓈ-M Futures — api-notes §2. `lastFundingRate` is per-8h (string).
// ---------------------------------------------------------------------------

const BinanceItemSchema = z.object({
  symbol: z.string(),
  markPrice: numericString,
  indexPrice: numericString,
  lastFundingRate: numericString, // string per-8h fractional
  nextFundingTime: numericString, // ms epoch
})
type BinanceItem = z.input<typeof BinanceItemSchema>

export interface NormalizeBinanceArgs {
  item: BinanceItem
  baseSymbol: string
  openInterestUsd: number | null // queried separately per-symbol
  ts: Date
}

const EIGHT_H_PER_YEAR = 3 * 365

export function normalizeBinance(
  args: NormalizeBinanceArgs,
): NormalizedFunding {
  const { baseSymbol, openInterestUsd, ts } = args
  const item = BinanceItemSchema.parse(args.item)
  const fundingRateNative = item.lastFundingRate
  // Binance funds every 8h: × 3 × 365 × 100.
  const fundingRate1hApr = fundingRateNative * EIGHT_H_PER_YEAR * 100
  return {
    venueId: 'binance_futures',
    venueSymbol: item.symbol,
    baseSymbol,
    fundingRateNative,
    fundingRate1hApr,
    nextFundingTs: new Date(item.nextFundingTime),
    markPrice: item.markPrice,
    indexPrice: item.indexPrice,
    openInterestUsd,
    ts,
  }
}

// ---------------------------------------------------------------------------
// Bybit — api-notes §3. `fundingRate` per-8h (string). `nextFundingTime` is a
// STRING ms epoch. `openInterestValue` is already USD.
// ---------------------------------------------------------------------------

const BybitItemSchema = z.object({
  symbol: z.string(),
  markPrice: numericString,
  indexPrice: numericString,
  fundingRate: numericString, // string per-8h fractional
  nextFundingTime: numericString, // STRING ms epoch
  openInterest: numericString, // coin units (unused for USD)
  openInterestValue: numericString, // already USD
})
type BybitItem = z.input<typeof BybitItemSchema>

export interface NormalizeBybitArgs {
  item: BybitItem
  baseSymbol: string
  ts: Date
}

export function normalizeBybit(args: NormalizeBybitArgs): NormalizedFunding {
  const { baseSymbol, ts } = args
  const item = BybitItemSchema.parse(args.item)
  const fundingRateNative = item.fundingRate
  // Bybit funds every 8h: × 3 × 365 × 100.
  const fundingRate1hApr = fundingRateNative * EIGHT_H_PER_YEAR * 100
  return {
    venueId: 'bybit',
    venueSymbol: item.symbol,
    baseSymbol,
    fundingRateNative,
    fundingRate1hApr,
    nextFundingTs: new Date(item.nextFundingTime),
    markPrice: item.markPrice,
    indexPrice: item.indexPrice,
    openInterestUsd: item.openInterestValue, // already USD
    ts,
  }
}

// ---------------------------------------------------------------------------
// OKX — api-notes §4. `fundingRate` per-8h for most pairs, but SOME pairs fund
// every 4h. Detect the interval from the fundingTime → nextFundingTime delta;
// 4h pairs annualize × 6, not × 3. (The single most common cross-venue bug.)
// ---------------------------------------------------------------------------

const OkxFundingSchema = z.object({
  instId: z.string(),
  fundingRate: numericString,
  fundingTime: numericString, // ms epoch
  nextFundingTime: numericString, // ms epoch
})
type OkxFunding = z.input<typeof OkxFundingSchema>

const OkxTickerSchema = z.object({
  instId: z.string(),
  markPx: numericString,
  idxPx: numericString,
})
type OkxTicker = z.input<typeof OkxTickerSchema>

export interface NormalizeOkxArgs {
  funding: OkxFunding
  ticker: OkxTicker
  baseSymbol: string
  openInterestUsd: number | null
  ts: Date
}

export function normalizeOkx(args: NormalizeOkxArgs): NormalizedFunding {
  const { baseSymbol, openInterestUsd, ts } = args
  const funding = OkxFundingSchema.parse(args.funding)
  const ticker = OkxTickerSchema.parse(args.ticker)

  // Detect the funding interval from the delta between consecutive funding
  // timestamps. Use date-fns (no raw Date arithmetic). Most pairs are 8h; some
  // are 4h — those must annualize × 6 not × 3 (api-notes §4 gotcha).
  const intervalHours = differenceInHours(
    new Date(funding.nextFundingTime),
    new Date(funding.fundingTime),
  )
  if (intervalHours <= 0) {
    throw new Error(
      `OKX funding interval must be positive, got ${intervalHours}h ` +
        `(fundingTime=${funding.fundingTime}, nextFundingTime=${funding.nextFundingTime})`,
    )
  }
  const intervalsPerYear = HOURS_PER_YEAR / intervalHours
  const fundingRateNative = funding.fundingRate
  const fundingRate1hApr = fundingRateNative * intervalsPerYear * 100

  return {
    venueId: 'okx',
    venueSymbol: funding.instId,
    baseSymbol,
    fundingRateNative,
    fundingRate1hApr,
    nextFundingTs: new Date(funding.nextFundingTime),
    markPrice: ticker.markPx,
    indexPrice: ticker.idxPx,
    openInterestUsd,
    ts,
  }
}
