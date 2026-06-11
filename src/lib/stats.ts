// Momentum-harvest stats + detection (design doc 2026-06-11). Pure: no I/O,
// no Supabase, no clock — `now` is passed in (CLAUDE.md hard rule #6).
//
// Hypothesis under test: funding rates mean-revert. When the settled rate runs
// > 2σ beyond its 7-day baseline for 2 consecutive settlements AND the live
// rate clears Strategy A's economic bar, emit a `momentum_harvest` opportunity.
// Detect-only in this phase: auto-open filters the kind out (see auto-open).
//
// Baseline deliberately EXCLUDES the 2 newest settled intervals (the ones the
// persistence test inspects). On 8h venues a 7-day window is only 21 samples;
// letting the spike into its own baseline self-dampens the trigger.
//
// Hysteresis: an opp that is already open stays detected while the latest
// settled |z| ≥ MOMENTUM_HOLD_Z on the SAME tail as its side. Entry needs
// |z| > MOMENTUM_ENTRY_Z on both persistence intervals. One spike therefore
// maps to one opportunity row — clean time-to-reversion data.

import { computeNetApr, computeLegDrag, computeSpotLegDrag } from './math'
import {
  DEFAULT_MIN_POSITION_USD,
  DEFAULT_THRESHOLDS,
  type DetectedOpportunity,
  type LatestSnapshot,
  type Side,
} from './detect'

// One row of the `funding_interval_rates` view: the last snapshot observed in
// one venue funding interval (≈ the rate that settled at that boundary).
export interface IntervalRate {
  instrumentId: number
  intervalTs: Date // interval bucket start (UTC, aligned to venue cadence)
  fundingRate1hApr: number // signed, normalized APR %
}

// One row destined for the `funding_stats` table.
export interface InstrumentStats {
  instrumentId: number
  intervalTs: Date // newest settled interval the stats describe
  nIntervals: number // baseline sample count (excludes the 2 newest)
  meanApr: number
  stddevApr: number // raw sample stddev (n−1); NOT floored
  currentApr: number // newest settled interval's rate
  zScore: number // (currentApr − mean) / max(stddev, MIN_SIGMA_APR)
}

export interface MomentumParams {
  now: Date
  maxStalenessMs: number
  // dedup_key → leg_a_side of currently-open momentum opportunities. Drives
  // the hysteresis hold; the side pins which tail the hold listens to.
  openMomentum: Map<string, Side>
  minPositionUsd?: number
  entryMinNetApr?: number
}

export const STATS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
// Number of newest settled intervals used for the persistence test (and
// excluded from the baseline).
export const PERSISTENCE_INTERVALS = 2
export const MOMENTUM_ENTRY_Z = 2
export const MOMENTUM_HOLD_Z = 1
// Baseline must have at least this many settled samples before we trust σ.
// 14 ≈ two-thirds of an 8h venue's 7-day window; HL reaches it in 14h.
export const MIN_BASELINE_INTERVALS = 14
// σ floor in APR points: a dead-flat week must not turn a 0.8-point wiggle
// into a 2σ "spike". z is always computed against max(σ, this).
export const MIN_SIGMA_APR = 0.5
// Honest cost annualization: momentum holds are short-lived by thesis (the
// rate reverts), so round-trip costs amortize over ~a week, not Strategy A's
// hold-forever cyclesPerYear=1. 52 ⇒ assumed ~7-day hold.
export const MOMENTUM_CYCLES_PER_YEAR = 52

interface InstrumentSeries {
  baseline: IntervalRate[] // window-bounded, oldest→newest, excludes newest 2
  persistence: IntervalRate[] // the newest PERSISTENCE_INTERVALS, oldest→newest
}

function seriesByInstrument(rates: IntervalRate[], now: Date): Map<number, InstrumentSeries> {
  const grouped = new Map<number, IntervalRate[]>()
  for (const r of rates) {
    const list = grouped.get(r.instrumentId)
    if (list) list.push(r)
    else grouped.set(r.instrumentId, [r])
  }
  const out = new Map<number, InstrumentSeries>()
  const cutoff = now.getTime() - STATS_WINDOW_MS
  for (const [instrumentId, list] of grouped) {
    list.sort((a, b) => a.intervalTs.getTime() - b.intervalTs.getTime())
    const persistence = list.slice(-PERSISTENCE_INTERVALS)
    const baseline = list
      .slice(0, list.length - persistence.length)
      .filter((r) => r.intervalTs.getTime() >= cutoff)
    out.set(instrumentId, { baseline, persistence })
  }
  return out
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}

/** Sample standard deviation (n−1). Caller guarantees values.length ≥ 2. */
function sampleStddev(values: number[], mu: number): number {
  const ss = values.reduce((acc, v) => acc + (v - mu) * (v - mu), 0)
  return Math.sqrt(ss / (values.length - 1))
}

function zScore(apr: number, mu: number, sigma: number): number {
  return (apr - mu) / Math.max(sigma, MIN_SIGMA_APR)
}

/**
 * Rolling 7-day baseline stats per instrument, one result per instrument
 * describing its newest settled interval. Instruments with fewer than 2
 * baseline samples (σ undefined) are skipped. Output sorted by instrumentId.
 */
export function computeFundingStats(rates: IntervalRate[], now: Date): InstrumentStats[] {
  const out: InstrumentStats[] = []
  for (const [instrumentId, series] of seriesByInstrument(rates, now)) {
    const { baseline, persistence } = series
    if (baseline.length < 2 || persistence.length < PERSISTENCE_INTERVALS) continue
    const values = baseline.map((r) => r.fundingRate1hApr)
    const mu = mean(values)
    const sigma = sampleStddev(values, mu)
    const newest = persistence[persistence.length - 1]
    out.push({
      instrumentId,
      intervalTs: newest.intervalTs,
      nIntervals: baseline.length,
      meanApr: mu,
      stddevApr: sigma,
      currentApr: newest.fundingRate1hApr,
      zScore: zScore(newest.fundingRate1hApr, mu, sigma),
    })
  }
  out.sort((a, b) => a.instrumentId - b.instrumentId)
  return out
}

/**
 * Momentum-harvest detection. Same DetectedOpportunity shape as Strategy A so
 * the Edge Function's reconcile loop needs no changes; only the kind, the
 * dedup key namespace, and the cost annualization differ.
 */
export function detectMomentum(
  snapshots: LatestSnapshot[],
  rates: IntervalRate[],
  params: MomentumParams,
): DetectedOpportunity[] {
  const {
    now,
    maxStalenessMs,
    openMomentum,
    minPositionUsd = DEFAULT_MIN_POSITION_USD,
    entryMinNetApr = DEFAULT_THRESHOLDS.singleVenueMinApr,
  } = params

  const series = seriesByInstrument(rates, now)
  const out: DetectedOpportunity[] = []

  for (const s of snapshots) {
    if (now.getTime() - s.ts.getTime() > maxStalenessMs) continue
    const inst = series.get(s.instrumentId)
    if (inst === undefined) continue
    const { baseline, persistence } = inst
    if (baseline.length < 2 || persistence.length < PERSISTENCE_INTERVALS) continue

    const values = baseline.map((r) => r.fundingRate1hApr)
    const mu = mean(values)
    const sigma = sampleStddev(values, mu)
    const zs = persistence.map((r) => zScore(r.fundingRate1hApr, mu, sigma))
    const zLatest = zs[zs.length - 1]

    const dedupKey = `momentum:${s.baseSymbol}:${s.venueId}`
    const openSide = openMomentum.get(dedupKey)

    let side: Side | null = null
    if (openSide !== undefined) {
      // Hysteresis hold: same tail as the open side, |z| ≥ holdZ (inclusive).
      const heldTail = openSide === 'short' ? zLatest : -zLatest
      if (heldTail >= MOMENTUM_HOLD_Z) side = openSide
    } else if (baseline.length >= MIN_BASELINE_INTERVALS) {
      // Fresh entry: every persistence interval strictly beyond the band, all
      // on the same tail, and the LIVE rate must clear the economic floor.
      if (zs.every((z) => z > MOMENTUM_ENTRY_Z)) side = 'short'
      else if (zs.every((z) => z < -MOMENTUM_ENTRY_Z)) side = 'long'
      if (side !== null) {
        const netApr = computeNetApr({
          grossApr: Math.abs(s.fundingRate1hApr),
          positionNotionalUsd: minPositionUsd,
          venueId: s.venueId,
          tier: s.tier,
          cyclesPerYear: MOMENTUM_CYCLES_PER_YEAR,
        })
        if (netApr < entryMinNetApr) side = null
      }
    }
    if (side === null) continue

    const grossApr = Math.abs(s.fundingRate1hApr)
    const perpDrag = computeLegDrag(minPositionUsd, s.venueId, s.tier, MOMENTUM_CYCLES_PER_YEAR)
    const spotDrag = computeSpotLegDrag(minPositionUsd, s.tier, MOMENTUM_CYCLES_PER_YEAR)
    out.push({
      kind: 'momentum_harvest',
      baseSymbol: s.baseSymbol,
      legA: {
        instrumentId: s.instrumentId,
        venueId: s.venueId,
        side,
        fundingApr: s.fundingRate1hApr,
      },
      legB: null,
      grossApr,
      feeDragApr: perpDrag.feeDragPct + spotDrag.feeDragPct,
      slipDragApr: perpDrag.slipDragPct + spotDrag.slipDragPct,
      netApr: grossApr - perpDrag.feeDragPct - perpDrag.slipDragPct - spotDrag.feeDragPct - spotDrag.slipDragPct,
      minPositionUsd,
      dedupKey,
    })
  }

  out.sort((x, y) => (x.dedupKey < y.dedupKey ? -1 : x.dedupKey > y.dedupKey ? 1 : 0))
  return out
}
