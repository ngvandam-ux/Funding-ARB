// Deno mirror of src/lib/pnl.ts. src/lib/pnl.ts is the Vitest-tested SOURCE OF
// TRUTH (pnl.test.ts); this copy is for the Edge Function runtime. Keep behavior
// byte-for-byte identical. Pure paper-trade P&L math (SPEC §6); no I/O, no clock.

import type { VenueId, Tier } from './domain.ts'
import { VENUE_TAKER_BPS, SLIPPAGE_BPS_BY_TIER, SPOT_TAKER_BPS } from './math.ts'

export const PAPER_LEVERAGE = 3
export const MAINTENANCE_MARGIN_FRACTION = 0.005
export const PAPER_POSITION_USD = 1000
export const AT_RISK_BUFFER_FRACTION = 0.2
export const LIQUIDATION_BUFFER_FRACTION = 0.05

// Adverse-move fraction a leg can absorb before liquidation (isolated margin).
export const INITIAL_BUFFER_FRACTION =
  1 / PAPER_LEVERAGE - MAINTENANCE_MARGIN_FRACTION

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
// Single-venue harvest is spot + perp (SPEC §5.1): the spot hedge is synthetic
// (no fill row, perfect hedge assumed) but its costs are real and charged here.
export interface SpotLegCosts {
  feeUsd: number
  slippageUsd: number
}
export interface OpenResult {
  legA: OpenFill
  legB: OpenFill | null
  spotLeg: SpotLegCosts | null
  feesUsd: number
  slippageUsd: number
  openCostsUsd: number
}

function spotLegCosts(sizeUsd: number, tier: Tier): SpotLegCosts {
  return {
    feeUsd: sizeUsd * (SPOT_TAKER_BPS / BPS),
    slippageUsd: legSlippage(sizeUsd, tier).usd,
  }
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
  const spot = legB ? null : spotLegCosts(sizeUsd, legA.tier)
  const feesUsd = a.feeUsd + (b ? b.feeUsd : 0) + (spot ? spot.feeUsd : 0)
  const slippageUsd =
    a.slippageUsd + (b ? b.slippageUsd : 0) + (spot ? spot.slippageUsd : 0)
  return {
    legA: a,
    legB: b,
    spotLeg: spot,
    feesUsd,
    slippageUsd,
    openCostsUsd: feesUsd + slippageUsd,
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

// Venue funding cadences (api-notes §1-4). OKX occasionally runs 4h intervals on
// exotic symbols; the tracked BTC/ETH/SOL swaps are 8h. If OKX 4h instruments are
// ever added, derive the interval per-instrument instead of per-venue.
export const VENUE_FUNDING_INTERVAL_HOURS: Record<VenueId, number> = {
  hyperliquid: 1,
  binance_futures: 8,
  bybit: 8,
  okx: 8,
} as const

// Funding settles DISCRETELY at venue funding times (SPEC §6.2.3) — you are paid
// only when you hold across a settlement, at the rate fixed for that interval.
// The continuous pro-rata accrual this replaces systematically over-credited
// transient rate spikes (auto-open buys spikes by construction).
export interface SettleLeg {
  side: Side
  // Rate per funding interval as a decimal fraction (funding_rate_native).
  fundingRateNative: number
  intervalHours: number
  // A known settlement timestamp for this venue (e.g. next_funding_ts).
  // null → settlements assumed epoch-aligned (true for 1h and 00/08/16-UTC venues).
  anchorMs?: number | null
}

function settlementsCrossed(lastMs: number, nowMs: number, intervalMs: number, anchorMs: number): number {
  // Settlement times are anchor + k·interval; count those in (lastMs, nowMs].
  return Math.floor((nowMs - anchorMs) / intervalMs) - Math.floor((lastMs - anchorMs) / intervalMs)
}

export function settleFundingDiscrete(args: {
  legA: SettleLeg
  legB: SettleLeg | null
  sizeUsd: number
  lastMs: number
  nowMs: number
}): number {
  const { legA, legB, sizeUsd, lastMs, nowMs } = args
  assertPositiveFinite(sizeUsd, 'sizeUsd')
  if (!Number.isFinite(lastMs) || !Number.isFinite(nowMs) || nowMs < lastMs) {
    throw new Error(`invalid settlement window: lastMs=${lastMs} nowMs=${nowMs}`)
  }
  const legSettled = (leg: SettleLeg): number => {
    assertPositiveFinite(leg.intervalHours, 'intervalHours')
    if (!Number.isFinite(leg.fundingRateNative)) {
      throw new Error(`fundingRateNative must be finite, got ${leg.fundingRateNative}`)
    }
    const intervalMs = leg.intervalHours * 3_600_000
    const n = settlementsCrossed(lastMs, nowMs, intervalMs, leg.anchorMs ?? 0)
    if (n <= 0) return 0
    // Positive funding pays shorts: a short RECEIVES +r, a long pays (−r).
    const receivedPerSettlement =
      sizeUsd * (leg.side === 'short' ? leg.fundingRateNative : -leg.fundingRateNative)
    return n * receivedPerSettlement
  }
  return legSettled(legA) + (legB ? legSettled(legB) : 0)
}

// Exit rule: a funding-harvest position only earns while its net funding receipt
// is positive; once it stops earning for EXIT_NEGATIVE_TICKS consecutive 5-min
// ticks (30 min), close it. Without this the measured strategy is
// "open at spike, hold forever" — which nobody would run with real money.
export const EXIT_NEGATIVE_TICKS = 6

export function nextNegativeFundingStreak(netReceiptApr: number, prevStreak: number): number {
  if (!Number.isFinite(netReceiptApr)) {
    throw new Error(`netReceiptApr must be finite, got ${netReceiptApr}`)
  }
  return netReceiptApr > 0 ? 0 : prevStreak + 1
}

export function shouldAutoClose(streak: number): boolean {
  return streak >= EXIT_NEGATIVE_TICKS
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

export interface CloseLegInput {
  venueId: VenueId
  tier: Tier
  side: Side
  entryPrice: number
}
export interface CloseFill {
  side: Side
  exitPrice: number
  feeUsd: number
  slippageBps: number
  slippageUsd: number
}
export interface CloseResult {
  legA: CloseFill
  legB: CloseFill | null
  spotLeg: SpotLegCosts | null
  pricePnl: number
  closeFeesUsd: number
  closeSlippageUsd: number
  closeCostsUsd: number
  totalCostsUsd: number
  realizedPnlUsd: number
}

export function computeClose(args: {
  legA: CloseLegInput
  legB: CloseLegInput | null
  markA: number
  markB: number | null
  sizeUsd: number
  cumulativeFundingUsd: number
  // Open-side costs as actually recorded at open time — never re-derived here,
  // so a fee-table change mid-run can't silently rewrite history.
  openCostsUsd: number
}): CloseResult {
  const { legA, legB, markA, markB, sizeUsd, cumulativeFundingUsd, openCostsUsd } = args
  assertPositiveFinite(sizeUsd, 'sizeUsd')
  if (!Number.isFinite(openCostsUsd) || openCostsUsd < 0) {
    throw new Error(`openCostsUsd must be a finite number >= 0, got ${openCostsUsd}`)
  }
  const buildClose = (leg: CloseLegInput, mark: number): CloseFill => {
    assertPositiveFinite(mark, 'mark')
    const feeUsd = legFeeUsd(sizeUsd, leg.venueId)
    const slip = legSlippage(sizeUsd, leg.tier)
    return { side: leg.side, exitPrice: mark, feeUsd, slippageBps: slip.bps, slippageUsd: slip.usd }
  }
  const a = buildClose(legA, markA)
  const b = legB ? buildClose(legB, markB as number) : null
  const spot = legB ? null : spotLegCosts(sizeUsd, legA.tier)
  const pricePnl = computeUnrealizedPnl({
    legA: { side: legA.side, entryPrice: legA.entryPrice },
    legB: legB ? { side: legB.side, entryPrice: legB.entryPrice } : null,
    markA,
    markB,
    sizeUsd,
  })
  const closeFeesUsd = a.feeUsd + (b ? b.feeUsd : 0) + (spot ? spot.feeUsd : 0)
  const closeSlippageUsd =
    a.slippageUsd + (b ? b.slippageUsd : 0) + (spot ? spot.slippageUsd : 0)
  const closeCostsUsd = closeFeesUsd + closeSlippageUsd
  const totalCostsUsd = openCostsUsd + closeCostsUsd
  const realizedPnlUsd = pricePnl + cumulativeFundingUsd - totalCostsUsd
  return {
    legA: a,
    legB: b,
    spotLeg: spot,
    pricePnl,
    closeFeesUsd,
    closeSlippageUsd,
    closeCostsUsd,
    totalCostsUsd,
    realizedPnlUsd,
  }
}
