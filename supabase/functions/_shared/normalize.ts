// Deno mirror of src/lib/normalize.ts (Hyperliquid only, for now).
//
// src/lib/normalize.ts remains the node/Vitest-tested SOURCE OF TRUTH. This file
// is the Deno-importable copy used by the Edge Function runtime (which can't read
// the Vite/node module graph). The Hyperliquid normalize logic here MUST stay
// byte-for-byte identical in behavior to the tested original:
//   - HL `funding` is the HOURLY fractional rate → × 24 × 365 × 100 = APR %.
//   - `"0"` is a valid zero rate (api-notes §1 gotcha), not null.
//   - openInterest is in COIN units → × markPx for USD.
//   - the universe is POSITIONAL (caller maps name → index, then passes the ctx).
//
// zod is loaded via the npm: specifier supported by the Supabase Edge runtime.
import { z } from 'npm:zod@3'

export type VenueId = 'hyperliquid' | 'binance_futures' | 'bybit' | 'okx'

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
