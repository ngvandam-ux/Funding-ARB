// Deno mirror of src/lib/normalize.ts (all four venues).
//
// src/lib/normalize.ts remains the node/Vitest-tested SOURCE OF TRUTH. This file
// is the Deno-importable copy used by the Edge Function runtime (which can't read
// the Vite/node module graph). The normalize logic here MUST stay byte-for-byte
// identical in behavior to the tested original:
//   - HL `funding` is the HOURLY fractional rate → × 24 × 365 × 100 = APR %.
//   - Binance/Bybit fund every 8h → × 3 × 365 × 100.
//   - OKX funds 8h for most pairs but 4h for some → detect via fundingTime delta
//     (× 6 not × 3); this is the #1 cross-venue bug (api-notes §4).
//   - `"0"` is a valid zero rate (api-notes §1 gotcha), not null.
//   - HL openInterest is in COIN units → × markPx for USD; Bybit openInterestValue
//     is already USD; Binance/OKX OI is queried separately and passed in.
//   - the HL universe is POSITIONAL (caller maps name → index, then passes ctx).
//
// zod + date-fns are loaded via npm: specifiers supported by the Supabase Edge runtime.
import { z } from 'npm:zod@3'
import { differenceInHours } from 'npm:date-fns@3'
import type { VenueId } from './domain.ts'

export type { VenueId }

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

// Accepts a numeric string (venues send rates/prices as strings) or a number and
// coerces to a finite number, rejecting NaN like "not-a-number".
const numericString = z
  .union([z.string(), z.number()])
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n), { message: 'expected a finite number' })

const HOURS_PER_YEAR = 24 * 365

// ---------------------------------------------------------------------------
// Hyperliquid — api-notes §1. `funding` is the HOURLY fractional rate.
// ---------------------------------------------------------------------------

// The metaAndAssetCtxs payload carries more fields per ctx (midPx, premium,
// impliedFunding, fundingX, …). We pick only what we normalize; zod passthrough
// is not needed because the full raw ctx is stored separately in `raw`.
export const HyperliquidCtxSchema = z.object({
  funding: numericString, // "0" is valid (zero), not null — api-notes §1 gotcha
  markPx: numericString,
  oraclePx: numericString,
  openInterest: numericString, // coin units → × markPx for USD
})
export type HyperliquidCtx = z.input<typeof HyperliquidCtxSchema>

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
// Full metaAndAssetCtxs envelope. The response is a 2-tuple:
//   [ { universe: [{ name }, …] }, [ ctx, … ] ]
// universe[i].name ↔ assetCtxs[i] POSITIONALLY (api-notes §1 gotcha — do NOT
// assume alphabetical). We zod-parse the envelope so a venue shape change fails
// loud instead of inserting partial garbage.
// ---------------------------------------------------------------------------

const UniverseEntrySchema = z.object({ name: z.string() })

export const MetaAndAssetCtxsSchema = z.tuple([
  z.object({ universe: z.array(UniverseEntrySchema) }),
  z.array(HyperliquidCtxSchema.passthrough()),
])
export type MetaAndAssetCtxs = z.infer<typeof MetaAndAssetCtxsSchema>

const EIGHT_H_PER_YEAR = 3 * 365

// ---------------------------------------------------------------------------
// Binance USDⓈ-M Futures — api-notes §2. `lastFundingRate` is per-8h (string).
// ---------------------------------------------------------------------------

export const BinanceItemSchema = z.object({
  symbol: z.string(),
  markPrice: numericString,
  indexPrice: numericString,
  lastFundingRate: numericString, // string per-8h fractional
  nextFundingTime: numericString, // ms epoch
})
export type BinanceItem = z.input<typeof BinanceItemSchema>

export interface NormalizeBinanceArgs {
  item: BinanceItem
  baseSymbol: string
  openInterestUsd: number | null // queried separately per-symbol
  ts: Date
}

export function normalizeBinance(args: NormalizeBinanceArgs): NormalizedFunding {
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

export const BybitItemSchema = z.object({
  symbol: z.string(),
  markPrice: numericString,
  indexPrice: numericString,
  fundingRate: numericString, // string per-8h fractional
  nextFundingTime: numericString, // STRING ms epoch
  openInterest: numericString, // coin units (unused for USD)
  openInterestValue: numericString, // already USD
})
export type BybitItem = z.input<typeof BybitItemSchema>

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

export const OkxFundingSchema = z.object({
  instId: z.string(),
  fundingRate: numericString,
  fundingTime: numericString, // ms epoch
  nextFundingTime: numericString, // ms epoch
})
export type OkxFunding = z.input<typeof OkxFundingSchema>

export const OkxTickerSchema = z.object({
  instId: z.string(),
  markPx: numericString,
  idxPx: numericString,
})
export type OkxTicker = z.input<typeof OkxTickerSchema>

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
