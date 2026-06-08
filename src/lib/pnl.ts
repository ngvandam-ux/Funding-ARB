// Pure paper-trade P&L math (SPEC §6 + Session 3 design). No I/O, no clock —
// marks / dt / now are all injected so this is deterministic and unit-tested.
// Reuses the fee + slippage tables from math.ts.

import type { VenueId, Tier } from '../types/domain'
import { VENUE_TAKER_BPS, SLIPPAGE_BPS_BY_TIER } from './math'

export const PAPER_LEVERAGE = 3
export const MAINTENANCE_MARGIN_FRACTION = 0.005
export const PAPER_POSITION_USD = 1000
export const AT_RISK_BUFFER_FRACTION = 0.2
export const LIQUIDATION_BUFFER_FRACTION = 0.05

// Adverse-move fraction a leg can absorb before liquidation (isolated margin).
export const INITIAL_BUFFER_FRACTION =
  1 / PAPER_LEVERAGE - MAINTENANCE_MARGIN_FRACTION

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000
const BPS = 10_000

export type Side = 'long' | 'short'

function assertPositiveFinite(v: number, label: string): void {
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`${label} must be a positive finite number, got ${v}`)
  }
}

function legFeeUsd(sizeUsd: number, venueId: VenueId): number {
  const bps = VENUE_TAKER_BPS[venueId]
  if (bps === undefined) throw new Error(`unknown venueId: ${String(venueId)}`)
  return sizeUsd * (bps / BPS)
}

function legSlippage(sizeUsd: number, tier: Tier): { bps: number; usd: number } {
  const bps = SLIPPAGE_BPS_BY_TIER[tier]
  if (bps === undefined) throw new Error(`unknown tier: ${String(tier)}`)
  return { bps, usd: sizeUsd * (bps / BPS) }
}

function liqPriceFor(side: Side, entryPrice: number): number {
  return side === 'short'
    ? entryPrice * (1 + INITIAL_BUFFER_FRACTION)
    : entryPrice * (1 - INITIAL_BUFFER_FRACTION)
}

export interface OpenLegInput {
  venueId: VenueId
  tier: Tier
  side: Side
  mark: number
}
export interface OpenFill {
  side: Side
  entryPrice: number
  liqPrice: number
  feeUsd: number
  slippageBps: number
  slippageUsd: number
}
export interface OpenResult {
  legA: OpenFill
  legB: OpenFill | null
  feesUsd: number
  slippageUsd: number
}

export function computeOpenFills(args: {
  legA: OpenLegInput
  legB: OpenLegInput | null
  sizeUsd: number
}): OpenResult {
  const { legA, legB, sizeUsd } = args
  assertPositiveFinite(sizeUsd, 'sizeUsd')
  const build = (leg: OpenLegInput): OpenFill => {
    assertPositiveFinite(leg.mark, 'mark')
    const feeUsd = legFeeUsd(sizeUsd, leg.venueId)
    const slip = legSlippage(sizeUsd, leg.tier)
    return {
      side: leg.side,
      entryPrice: leg.mark,
      liqPrice: liqPriceFor(leg.side, leg.mark),
      feeUsd,
      slippageBps: slip.bps,
      slippageUsd: slip.usd,
    }
  }
  const a = build(legA)
  const b = legB ? build(legB) : null
  return {
    legA: a,
    legB: b,
    feesUsd: a.feeUsd + (b ? b.feeUsd : 0),
    slippageUsd: a.slippageUsd + (b ? b.slippageUsd : 0),
  }
}

function legPricePnl(side: Side, entryPrice: number, mark: number, sizeUsd: number): number {
  const move = (mark - entryPrice) / entryPrice
  return side === 'long' ? move * sizeUsd : -move * sizeUsd
}

export interface PositionLeg {
  side: Side
  entryPrice: number
}

export function computeUnrealizedPnl(args: {
  legA: PositionLeg
  legB: PositionLeg | null
  markA: number
  markB: number | null
  sizeUsd: number
}): number {
  const { legA, legB, markA, markB, sizeUsd } = args
  // Single-venue funding harvest is delta-neutral via the implicit spot leg.
  if (!legB) return 0
  if (markB === null) throw new Error('cross-venue position requires markB')
  return (
    legPricePnl(legA.side, legA.entryPrice, markA, sizeUsd) +
    legPricePnl(legB.side, legB.entryPrice, markB, sizeUsd)
  )
}

export function accrueFunding(args: {
  legA: { side: Side; fundingRate1hApr: number }
  legB: { side: Side; fundingRate1hApr: number } | null
  sizeUsd: number
  dtMs: number
}): number {
  const { legA, legB, sizeUsd, dtMs } = args
  if (!Number.isFinite(dtMs) || dtMs < 0) {
    throw new Error(`dtMs must be a finite number >= 0, got ${dtMs}`)
  }
  const dtYears = dtMs / MS_PER_YEAR
  // Positive funding pays shorts: a short RECEIVES +r, a long pays (−r).
  const legFunding = (leg: { side: Side; fundingRate1hApr: number }): number => {
    const receivedApr = leg.side === 'short' ? leg.fundingRate1hApr : -leg.fundingRate1hApr
    return sizeUsd * (receivedApr / 100) * dtYears
  }
  return legFunding(legA) + (legB ? legFunding(legB) : 0)
}

function adverseFraction(side: Side, entryPrice: number, mark: number): number {
  const a = side === 'short' ? (mark - entryPrice) / entryPrice : (entryPrice - mark) / entryPrice
  return Math.max(0, a)
}

export interface RiskLeg {
  side: Side
  entryPrice: number
}
export interface RiskAssessment {
  liquidationDistanceBps: number
  status: 'open' | 'at_risk' | 'liquidated_paper'
}

export function assessRisk(args: {
  legA: RiskLeg
  legB: RiskLeg | null
  markA: number
  markB: number | null
}): RiskAssessment {
  const { legA, legB, markA, markB } = args
  const d0 = INITIAL_BUFFER_FRACTION
  const remaining = (leg: RiskLeg, mark: number): number =>
    d0 - adverseFraction(leg.side, leg.entryPrice, mark)
  const rems = [remaining(legA, markA)]
  if (legB) {
    if (markB === null) throw new Error('cross-venue position requires markB')
    rems.push(remaining(legB, markB))
  }
  const minRem = Math.min(...rems)
  const ratio = minRem / d0
  const status =
    ratio < LIQUIDATION_BUFFER_FRACTION
      ? 'liquidated_paper'
      : ratio < AT_RISK_BUFFER_FRACTION
        ? 'at_risk'
        : 'open'
  return { liquidationDistanceBps: minRem * BPS, status }
}
