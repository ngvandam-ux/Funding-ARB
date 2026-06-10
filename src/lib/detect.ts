// Pure opportunity detection (SPEC §5 + Session 2 design). No I/O, no Supabase,
// no fetch, no clock — `now` is passed in so the function is deterministic and
// unit-testable (CLAUDE.md hard rule #6). The detect-opportunities Edge Function
// is a thin wrapper that reads the `latest_funding` view, calls this, and upserts.
//
// Two strategies, two thresholds (the DETECT layer; the higher paper-OPEN layer
// lives in Session 3's engine):
//   - single_venue_funding_harvest: abs(funding) net ≥ 10%. Positive funding →
//     short the perp; negative funding → long it (harvest either direction).
//   - cross_venue_basis_arb: net ≥ 15%; EVERY clearing venue pair is emitted.
// A leg is usable only if its snapshot is fresh (≤ 5 min). Cross-venue needs both.

import type { VenueId, Tier, OpportunityKind } from '../types/domain'
import { computeNetApr, computeBasisArbNetApr, computeLegDrag, computeSpotLegDrag } from './math'

export type Side = 'long' | 'short'

// One row of the `latest_funding` view (latest snapshot per active instrument).
export interface LatestSnapshot {
  instrumentId: number
  venueId: VenueId
  baseSymbol: string
  venueSymbol: string
  tier: Tier
  fundingRate1hApr: number // signed, normalized APR % — the only comparable field
  ts: Date
}

export interface DetectThresholds {
  singleVenueMinApr: number
  crossVenueMinApr: number
}

export interface DetectParams {
  now: Date
  maxStalenessMs: number
  thresholds: DetectThresholds
  minPositionUsd?: number
  cyclesPerYear?: number
}

export interface DetectedLeg {
  instrumentId: number
  venueId: VenueId
  side: Side
  fundingApr: number // signed leg APR % (for the leg_*_funding_apr columns)
}

export interface DetectedOpportunity {
  kind: OpportunityKind
  baseSymbol: string
  legA: DetectedLeg
  legB: DetectedLeg | null
  grossApr: number
  feeDragApr: number
  slipDragApr: number
  netApr: number
  minPositionUsd: number
  dedupKey: string
}

// SPEC §5 detect-layer thresholds; staleness from the design doc.
export const DEFAULT_THRESHOLDS: DetectThresholds = {
  singleVenueMinApr: 10,
  crossVenueMinApr: 15,
}
export const DEFAULT_MAX_STALENESS_MS = 5 * 60 * 1000
// SPEC §5.1: positions are held flat ~indefinitely → open+close once per year.
export const DEFAULT_CYCLES_PER_YEAR = 1
// Schema default for opportunities.min_position_usd. v1 does not size dynamically.
export const DEFAULT_MIN_POSITION_USD = 1000

function isFresh(snap: LatestSnapshot, now: Date, maxStalenessMs: number): boolean {
  return now.getTime() - snap.ts.getTime() <= maxStalenessMs
}

export function detectOpportunities(
  snapshots: LatestSnapshot[],
  params: DetectParams,
): DetectedOpportunity[] {
  const {
    now,
    maxStalenessMs,
    thresholds,
    minPositionUsd = DEFAULT_MIN_POSITION_USD,
    cyclesPerYear = DEFAULT_CYCLES_PER_YEAR,
  } = params

  const fresh = snapshots.filter((s) => isFresh(s, now, maxStalenessMs))
  const out: DetectedOpportunity[] = []

  // --- Strategy A: single-venue funding harvest -----------------------------
  for (const s of fresh) {
    const grossApr = Math.abs(s.fundingRate1hApr) // magnitude harvested either way
    const perpDrag = computeLegDrag(minPositionUsd, s.venueId, s.tier, cyclesPerYear)
    // Drag fields persist BOTH legs (perp + synthetic spot hedge) so that
    // netApr === grossApr − feeDragApr − slipDragApr stays true for consumers.
    const spotDrag = computeSpotLegDrag(minPositionUsd, s.tier, cyclesPerYear)
    const netApr = computeNetApr({
      grossApr,
      positionNotionalUsd: minPositionUsd,
      venueId: s.venueId,
      tier: s.tier,
      cyclesPerYear,
    })
    if (netApr < thresholds.singleVenueMinApr) continue
    // Positive funding: longs pay shorts → short the perp to receive.
    // Negative funding: shorts pay longs → long the perp to receive.
    const side: Side = s.fundingRate1hApr >= 0 ? 'short' : 'long'
    out.push({
      kind: 'single_venue_funding_harvest',
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
      netApr,
      minPositionUsd,
      dedupKey: `single:${s.baseSymbol}:${s.venueId}`,
    })
  }

  // --- Strategy B: cross-venue basis arb ------------------------------------
  const byBase = new Map<string, LatestSnapshot[]>()
  for (const s of fresh) {
    const list = byBase.get(s.baseSymbol)
    if (list) list.push(s)
    else byBase.set(s.baseSymbol, [s])
  }

  for (const [baseSymbol, legs] of byBase) {
    if (legs.length < 2) continue
    for (let i = 0; i < legs.length; i++) {
      for (let j = i + 1; j < legs.length; j++) {
        const a = legs[i]
        const b = legs[j]
        const res = computeBasisArbNetApr({
          legA: { venueId: a.venueId, aprPct: a.fundingRate1hApr, tier: a.tier },
          legB: { venueId: b.venueId, aprPct: b.fundingRate1hApr, tier: b.tier },
          positionNotionalUsd: minPositionUsd,
          cyclesPerYear,
        })
        if (res.netApr < thresholds.crossVenueMinApr) continue

        const dragA = computeLegDrag(minPositionUsd, a.venueId, a.tier, cyclesPerYear)
        const dragB = computeLegDrag(minPositionUsd, b.venueId, b.tier, cyclesPerYear)
        const longSnap = a.venueId === res.longVenue ? a : b
        const shortSnap = a.venueId === res.longVenue ? b : a

        // dedup key uses alphabetically-sorted venues so it is independent of
        // input order and of which leg ends up long vs short.
        const sortedVenues = [a.venueId, b.venueId].sort()

        out.push({
          kind: 'cross_venue_basis_arb',
          baseSymbol,
          legA: {
            instrumentId: longSnap.instrumentId,
            venueId: longSnap.venueId,
            side: 'long',
            fundingApr: longSnap.fundingRate1hApr,
          },
          legB: {
            instrumentId: shortSnap.instrumentId,
            venueId: shortSnap.venueId,
            side: 'short',
            fundingApr: shortSnap.fundingRate1hApr,
          },
          grossApr: res.grossApr,
          feeDragApr: dragA.feeDragPct + dragB.feeDragPct,
          slipDragApr: dragA.slipDragPct + dragB.slipDragPct,
          netApr: res.netApr,
          minPositionUsd,
          dedupKey: `cross:${baseSymbol}:${sortedVenues[0]}:${sortedVenues[1]}`,
        })
      }
    }
  }

  // Deterministic output order — stable across input orderings.
  out.sort((x, y) => (x.dedupKey < y.dedupKey ? -1 : x.dedupKey > y.dedupKey ? 1 : 0))
  return out
}
