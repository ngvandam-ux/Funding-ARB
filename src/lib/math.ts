// Pure arb math (SPEC §5). No I/O, no Supabase, no fetch.
// Fees: api-notes §6. Slippage: api-notes §7. Throws on bad input.

import type { VenueId, Tier } from '../types/domain'

// api-notes §6 — base (zero-volume-tier) taker fees in bps, per venue.
export const VENUE_TAKER_BPS: Record<VenueId, number> = {
  hyperliquid: 4.5,
  binance_futures: 4.0,
  bybit: 5.5,
  okx: 5.0,
} as const

// api-notes §7 — flat slippage assumptions in bps, per liquidity tier.
export const SLIPPAGE_BPS_BY_TIER: Record<Tier, number> = {
  major: 5,
  mid: 15,
  alt: 50,
} as const

// Single-venue funding harvest (SPEC §5.1) is spot + perp. The spot hedge leg is
// modeled with a flat retail spot taker fee — venue spot fee schedules cluster
// around 10 bps — plus the same tier slippage as the perp leg. Without this the
// strategy's cost base is understated by roughly half.
export const SPOT_TAKER_BPS = 10

const BPS = 10_000

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number, got ${value}`)
  }
}

/**
 * One-way slippage cost in USD for a single leg of the given notional and tier.
 * cost = notional × (tierBps / 10_000)
 */
export function applySlippage(notionalUsd: number, tier: Tier): number {
  assertPositiveFinite(notionalUsd, 'notionalUsd')
  const bps = SLIPPAGE_BPS_BY_TIER[tier]
  if (bps === undefined) {
    throw new Error(`unknown tier: ${String(tier)}`)
  }
  return notionalUsd * (bps / BPS)
}

/** One-way taker fee cost in USD for a single leg on the given venue. */
function takerFeeUsd(notionalUsd: number, venueId: VenueId): number {
  const bps = VENUE_TAKER_BPS[venueId]
  if (bps === undefined) {
    throw new Error(`unknown venueId: ${String(venueId)}`)
  }
  return notionalUsd * (bps / BPS)
}

/**
 * Round-trip (open + close) drag for one leg, expressed in APR percentage points.
 * SPEC §5: (round_trip_cost / position_notional) × cycles_per_year × 100.
 *
 * Returned as a {feeDragPct, slipDragPct} breakdown so callers (the detector) can
 * persist `est_fees_apr_drag` and `est_slippage_apr_drag` separately. Note the
 * notional cancels algebraically — the drag in APR % is notional-independent — but
 * we still require a positive notional so a bad call fails loud (hard rule #7).
 */
export function computeLegDrag(
  notionalUsd: number,
  venueId: VenueId,
  tier: Tier,
  cyclesPerYear: number,
): { feeDragPct: number; slipDragPct: number } {
  assertPositiveFinite(notionalUsd, 'notionalUsd')
  assertPositiveFinite(cyclesPerYear, 'cyclesPerYear')
  const roundTripFee = 2 * takerFeeUsd(notionalUsd, venueId)
  const roundTripSlip = 2 * applySlippage(notionalUsd, tier)
  return {
    feeDragPct: (roundTripFee / notionalUsd) * cyclesPerYear * 100,
    slipDragPct: (roundTripSlip / notionalUsd) * cyclesPerYear * 100,
  }
}

/**
 * Round-trip drag of the synthetic spot hedge leg, in APR percentage points.
 * Same shape as computeLegDrag so the detector can persist both.
 */
export function computeSpotLegDrag(
  notionalUsd: number,
  tier: Tier,
  cyclesPerYear: number,
): { feeDragPct: number; slipDragPct: number } {
  assertPositiveFinite(notionalUsd, 'notionalUsd')
  assertPositiveFinite(cyclesPerYear, 'cyclesPerYear')
  const roundTripFee = 2 * notionalUsd * (SPOT_TAKER_BPS / BPS)
  const roundTripSlip = 2 * applySlippage(notionalUsd, tier)
  return {
    feeDragPct: (roundTripFee / notionalUsd) * cyclesPerYear * 100,
    slipDragPct: (roundTripSlip / notionalUsd) * cyclesPerYear * 100,
  }
}

export interface ComputeNetAprArgs {
  grossApr: number // already-normalized APR % (fundingRate1hApr)
  positionNotionalUsd: number
  venueId: VenueId
  tier: Tier
  cyclesPerYear: number
}

/**
 * SPEC §5.1 — single-venue funding harvest (delta-neutral via spot hedge).
 * net = gross − perp leg drag − spot leg drag, drags scaled by cyclesPerYear.
 */
export function computeNetApr(args: ComputeNetAprArgs): number {
  const { grossApr, positionNotionalUsd, venueId, tier, cyclesPerYear } = args
  assertPositiveFinite(positionNotionalUsd, 'positionNotionalUsd')
  assertPositiveFinite(cyclesPerYear, 'cyclesPerYear')
  if (!Number.isFinite(grossApr)) {
    throw new Error(`grossApr must be finite, got ${grossApr}`)
  }
  const perp = computeLegDrag(positionNotionalUsd, venueId, tier, cyclesPerYear)
  const spot = computeSpotLegDrag(positionNotionalUsd, tier, cyclesPerYear)
  return (
    grossApr - perp.feeDragPct - perp.slipDragPct - spot.feeDragPct - spot.slipDragPct
  )
}

export interface BasisArbLeg {
  venueId: VenueId
  aprPct: number // already-normalized APR % (fundingRate1hApr)
  tier: Tier
}

export interface ComputeBasisArbArgs {
  legA: BasisArbLeg
  legB: BasisArbLeg
  positionNotionalUsd: number
  cyclesPerYear: number
}

export interface BasisArbResult {
  grossApr: number
  netApr: number
  longVenue: VenueId
  shortVenue: VenueId
}

/**
 * SPEC §5.2 — cross-venue basis arbitrage.
 * gross = abs(a)+abs(b) when signs are opposite; abs(a−b) when signs are same.
 * net = gross − both legs' round-trip fee drag − both legs' round-trip slippage drag.
 */
export function computeBasisArbNetApr(
  args: ComputeBasisArbArgs,
): BasisArbResult {
  const { legA, legB, positionNotionalUsd, cyclesPerYear } = args
  assertPositiveFinite(positionNotionalUsd, 'positionNotionalUsd')
  assertPositiveFinite(cyclesPerYear, 'cyclesPerYear')
  if (!Number.isFinite(legA.aprPct) || !Number.isFinite(legB.aprPct)) {
    throw new Error('both leg aprPct values must be finite')
  }

  const a = legA.aprPct
  const b = legB.aprPct
  const oppositeSigns = a * b < 0
  const grossApr = oppositeSigns
    ? Math.abs(a) + Math.abs(b)
    : Math.abs(a - b)

  const dragA = computeLegDrag(
    positionNotionalUsd,
    legA.venueId,
    legA.tier,
    cyclesPerYear,
  )
  const dragB = computeLegDrag(
    positionNotionalUsd,
    legB.venueId,
    legB.tier,
    cyclesPerYear,
  )
  const netApr =
    grossApr -
    (dragA.feeDragPct + dragB.feeDragPct) -
    (dragA.slipDragPct + dragB.slipDragPct)

  // SPEC §5.2 (corrected rule): long the negative-funding venue, short the
  // positive-funding venue — you receive funding on both legs. When both legs
  // share a sign, the same logic generalizes to: short the higher-APR venue
  // (receive the most / pay the least) and long the lower-APR venue.
  const longLeg = a <= b ? legA : legB
  const shortLeg = a <= b ? legB : legA

  return {
    grossApr,
    netApr,
    longVenue: longLeg.venueId,
    shortVenue: shortLeg.venueId,
  }
}
