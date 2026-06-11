// Tests for the momentum-harvest stats lib (design doc 2026-06-11).
// Pure math + detection: rolling baseline mean/σ, z-scores, 2-settlement
// persistence, hysteresis hold, n-guard, σ-floor, baseline exclusion.

import { describe, it, expect } from 'vitest'
import {
  computeFundingStats,
  detectMomentum,
  MIN_SIGMA_APR,
  MIN_BASELINE_INTERVALS,
  MOMENTUM_ENTRY_Z,
  MOMENTUM_HOLD_Z,
  MOMENTUM_CYCLES_PER_YEAR,
  type IntervalRate,
  type MomentumParams,
} from './stats'
import { computeNetApr } from './math'
import type { LatestSnapshot, Side } from './detect'

const NOW = new Date('2026-06-11T12:00:00Z')
const HOUR = 60 * 60 * 1000

/** Hourly interval rates ending just before NOW; values[0] is the OLDEST. */
function hourlyRates(instrumentId: number, values: number[]): IntervalRate[] {
  return values.map((v, i) => ({
    instrumentId,
    intervalTs: new Date(NOW.getTime() - (values.length - i) * HOUR),
    fundingRate1hApr: v,
  }))
}

function snap(instrumentId: number, apr: number, over: Partial<LatestSnapshot> = {}): LatestSnapshot {
  return {
    instrumentId,
    venueId: 'hyperliquid',
    baseSymbol: 'BTC',
    venueSymbol: 'BTC',
    tier: 'major',
    fundingRate1hApr: apr,
    ts: NOW,
    ...over,
  }
}

function params(over: Partial<MomentumParams> = {}): MomentumParams {
  return {
    now: NOW,
    maxStalenessMs: 5 * 60 * 1000,
    openMomentum: new Map<string, Side>(),
    ...over,
  }
}

// Baseline of 30 settled hourly rates alternating 8/12 → mean 10, sample σ ≈ 2.0339.
// The 2 newest (persistence-test) intervals are appended on top of this.
const FLAT_30 = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 8 : 12))

describe('computeFundingStats', () => {
  it('computes baseline mean and sample stddev excluding the 2 newest intervals', () => {
    // Baseline [10,10,12,12] (mean 11, σ = sqrt(4/3) ≈ 1.1547); newest two are
    // wild spikes that must NOT contaminate the baseline.
    const rates = hourlyRates(1, [10, 10, 12, 12, 90, 95])
    const [s] = computeFundingStats(rates, NOW)
    expect(s.meanApr).toBeCloseTo(11, 10)
    expect(s.stddevApr).toBeCloseTo(Math.sqrt(4 / 3), 10)
    expect(s.nIntervals).toBe(4)
    expect(s.currentApr).toBe(95)
    expect(s.intervalTs.getTime()).toBe(NOW.getTime() - 1 * HOUR)
  })

  it('z-score uses σ_eff = max(σ, MIN_SIGMA_APR) so flat baselines cannot explode', () => {
    // Baseline all 10 → σ = 0 → σ_eff = MIN_SIGMA_APR.
    const rates = hourlyRates(1, [10, 10, 10, 10, 10, 11])
    const [s] = computeFundingStats(rates, NOW)
    expect(s.stddevApr).toBe(0)
    expect(s.zScore).toBeCloseTo((11 - 10) / MIN_SIGMA_APR, 10)
  })

  it('skips instruments with fewer than 2 baseline intervals', () => {
    const rates = hourlyRates(1, [10, 12, 14]) // 1 baseline after excluding 2 newest
    expect(computeFundingStats(rates, NOW)).toEqual([])
  })

  it('ignores baseline intervals older than the 7-day window', () => {
    const recent = hourlyRates(1, [10, 10, 10, 10, 20, 20])
    const stale: IntervalRate[] = [
      { instrumentId: 1, intervalTs: new Date(NOW.getTime() - 8 * 24 * HOUR), fundingRate1hApr: 500 },
    ]
    const [s] = computeFundingStats([...stale, ...recent], NOW)
    expect(s.meanApr).toBeCloseTo(10, 10)
    expect(s.nIntervals).toBe(4)
  })

  it('groups by instrument and sorts output by instrumentId', () => {
    const rates = [...hourlyRates(2, [10, 10, 10, 10, 10, 10]), ...hourlyRates(1, [5, 5, 5, 5, 5, 5])]
    const out = computeFundingStats(rates, NOW)
    expect(out.map((s) => s.instrumentId)).toEqual([1, 2])
  })

  it('does not trust caller ordering of interval rows', () => {
    const ordered = hourlyRates(1, [10, 10, 12, 12, 90, 95])
    const shuffled = [ordered[4], ordered[0], ordered[5], ordered[2], ordered[1], ordered[3]]
    expect(computeFundingStats(shuffled, NOW)).toEqual(computeFundingStats(ordered, NOW))
  })
})

describe('detectMomentum — entry', () => {
  it('emits a short-side momentum opp when the 2 newest settled rates are both > mean + 2σ and net clears the floor', () => {
    const rates = hourlyRates(1, [...FLAT_30, 40, 45]) // z ≈ 14.7 and 17.2
    const out = detectMomentum([snap(1, 45)], rates, params())
    expect(out).toHaveLength(1)
    const o = out[0]
    expect(o.kind).toBe('momentum_harvest')
    expect(o.legA.side).toBe('short')
    expect(o.legA.instrumentId).toBe(1)
    expect(o.legB).toBeNull()
    expect(o.dedupKey).toBe('momentum:BTC:hyperliquid')
    expect(o.grossApr).toBe(45)
    // Honest costs: momentum holds are short-lived, so drag is annualized with
    // MOMENTUM_CYCLES_PER_YEAR, not Strategy A's hold-forever 1.
    expect(o.netApr).toBeCloseTo(
      computeNetApr({
        grossApr: 45,
        positionNotionalUsd: o.minPositionUsd,
        venueId: 'hyperliquid',
        tier: 'major',
        cyclesPerYear: MOMENTUM_CYCLES_PER_YEAR,
      }),
      10,
    )
    expect(o.netApr).toBeCloseTo(o.grossApr - o.feeDragApr - o.slipDragApr, 10)
  })

  it('emits a long-side opp on the negative tail', () => {
    const neg30 = FLAT_30.map((v) => -v)
    const rates = hourlyRates(1, [...neg30, -40, -45])
    const out = detectMomentum([snap(1, -45)], rates, params())
    expect(out).toHaveLength(1)
    expect(out[0].legA.side).toBe('long')
    expect(out[0].grossApr).toBe(45) // magnitude harvested
    expect(out[0].legA.fundingApr).toBe(-45)
  })

  it('requires BOTH of the 2 newest settled intervals beyond the band (persistence)', () => {
    const rates = hourlyRates(1, [...FLAT_30, 10, 45]) // only the newest spikes
    expect(detectMomentum([snap(1, 45)], rates, params())).toEqual([])
  })

  it('requires both persistence intervals on the SAME tail', () => {
    const rates = hourlyRates(1, [...FLAT_30, -45, 45])
    expect(detectMomentum([snap(1, 45)], rates, params())).toEqual([])
  })

  it('does not enter below the baseline-sample guard (MIN_BASELINE_INTERVALS)', () => {
    const flat13 = Array.from({ length: MIN_BASELINE_INTERVALS - 1 }, () => 10)
    const rates = hourlyRates(1, [...flat13, 40, 45])
    expect(detectMomentum([snap(1, 45)], rates, params())).toEqual([])
  })

  it('does not enter when live net APR is below the Strategy A floor', () => {
    // Spike is huge in z terms (flat baseline at 1 → σ_eff floor) but tiny in
    // absolute terms — uneconomic, must not become an opportunity.
    const flat30 = Array.from({ length: 30 }, () => 1)
    const rates = hourlyRates(1, [...flat30, 4, 5])
    expect(detectMomentum([snap(1, 5)], rates, params())).toEqual([])
  })

  it('σ floor suppresses noise spikes on flat baselines', () => {
    // Baseline flat 20, newest two at 20.8: raw σ=0 would make z infinite, but
    // σ_eff=0.5 gives z=1.6 < 2 → no entry, even though net APR clears the floor.
    const flat30 = Array.from({ length: 30 }, () => 20)
    const rates = hourlyRates(1, [...flat30, 20.8, 20.8])
    expect(detectMomentum([snap(1, 20.8)], rates, params())).toEqual([])
  })

  it('ignores instruments with a stale live snapshot', () => {
    const rates = hourlyRates(1, [...FLAT_30, 40, 45])
    const staleSnap = snap(1, 45, { ts: new Date(NOW.getTime() - 6 * 60 * 1000) })
    expect(detectMomentum([staleSnap], rates, params())).toEqual([])
  })

  it('uses the entry z threshold exclusively (z must exceed, not equal)', () => {
    // Baseline [8,12,...] σ≈2.0339; choose persistence values right at the band edge.
    const sigma = Math.sqrt((4 * 30) / 29)
    const edge = 10 + MOMENTUM_ENTRY_Z * sigma // exactly 2σ above the mean
    const rates = hourlyRates(1, [...FLAT_30, edge, edge])
    expect(detectMomentum([snap(1, edge)], rates, params())).toEqual([])
  })
})

describe('detectMomentum — hysteresis hold', () => {
  const openShort = () => new Map<string, Side>([['momentum:BTC:hyperliquid', 'short']])

  it('holds an open opp while the latest settled |z| ≥ holdZ on the same tail, even below entry band and floor', () => {
    // Latest settled z ≈ (13 − 10) / 2.0339 ≈ 1.475 → between holdZ=1 and entryZ=2.
    const rates = hourlyRates(1, [...FLAT_30, 40, 13])
    const out = detectMomentum([snap(1, 13)], rates, params({ openMomentum: openShort() }))
    expect(out).toHaveLength(1)
    expect(out[0].legA.side).toBe('short')
  })

  it('does NOT freshly enter in the hold band without an open opp (hysteresis is one-way)', () => {
    const rates = hourlyRates(1, [...FLAT_30, 40, 13])
    expect(detectMomentum([snap(1, 13)], rates, params())).toEqual([])
  })

  it('releases the hold when |z| drops below holdZ → opp disappears → reconcile expires it', () => {
    // Latest settled 11 → z ≈ 0.49 < 1.
    const rates = hourlyRates(1, [...FLAT_30, 40, 11])
    expect(detectMomentum([snap(1, 11)], rates, params({ openMomentum: openShort() }))).toEqual([])
  })

  it('releases the hold when z flips to the opposite tail of the open side', () => {
    // z ≈ −2.46, but the open opp is a SHORT (positive-tail) harvest.
    const rates = hourlyRates(1, [...FLAT_30, 40, 5])
    expect(detectMomentum([snap(1, 5)], rates, params({ openMomentum: openShort() }))).toEqual([])
  })

  it('hold z threshold is inclusive', () => {
    // Baseline [12,8,12,8,10]: mean 10 and sample σ = 2, both exact in floating
    // point, so z lands exactly on MOMENTUM_HOLD_Z with no epsilon drift.
    const atHold = 10 + MOMENTUM_HOLD_Z * 2
    const rates = hourlyRates(1, [12, 8, 12, 8, 10, 40, atHold])
    const out = detectMomentum([snap(1, atHold)], rates, params({ openMomentum: openShort() }))
    expect(out).toHaveLength(1)
  })
})

describe('detectMomentum — output discipline', () => {
  it('returns deterministic order by dedupKey across input orderings', () => {
    const ratesA = hourlyRates(1, [...FLAT_30, 40, 45])
    const ratesB = hourlyRates(2, [...FLAT_30, 40, 45])
    const snapA = snap(1, 45)
    const snapB = snap(2, 45, { baseSymbol: 'ETH', venueSymbol: 'ETH' })
    const out1 = detectMomentum([snapA, snapB], [...ratesA, ...ratesB], params())
    const out2 = detectMomentum([snapB, snapA], [...ratesB, ...ratesA], params())
    expect(out1.map((o) => o.dedupKey)).toEqual(out2.map((o) => o.dedupKey))
    expect(out1.map((o) => o.dedupKey)).toEqual(['momentum:BTC:hyperliquid', 'momentum:ETH:hyperliquid'])
  })

  it('emits nothing for instruments that have interval history but no live snapshot', () => {
    const rates = hourlyRates(1, [...FLAT_30, 40, 45])
    expect(detectMomentum([], rates, params())).toEqual([])
  })
})
