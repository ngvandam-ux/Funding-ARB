// src/hooks/useFundingSnapshots.ts — latest_funding view; realtime on funding_snapshots.
import { useMemo } from 'react'
import { useRealtimeRows } from './useRealtimeRows'
import type { LatestFunding, VenueId, Tier } from '../types/domain'

function num(v: unknown): number { return Number(v) }
function numOrNull(v: unknown): number | null { return v === null || v === undefined ? null : Number(v) }

export function useFundingSnapshots() {
  const opts = useMemo(
    () => ({
      table: 'latest_funding',
      realtimeTable: 'funding_snapshots',
      select: 'instrument_id, venue_id, venue_symbol, base_symbol, tier, funding_rate_1h_apr, mark_price, open_interest_usd, next_funding_ts, ts',
      channel: 'dash_funding',
      map: (r: Record<string, unknown>): LatestFunding => ({
        instrumentId: num(r.instrument_id),
        venueId: r.venue_id as VenueId,
        venueSymbol: String(r.venue_symbol),
        baseSymbol: String(r.base_symbol),
        tier: r.tier as Tier,
        fundingRate1hApr: num(r.funding_rate_1h_apr),
        markPrice: numOrNull(r.mark_price),
        openInterestUsd: numOrNull(r.open_interest_usd),
        nextFundingTs: (r.next_funding_ts as string | null) ?? null,
        ts: String(r.ts),
      }),
      key: (d: LatestFunding) => d.instrumentId,
    }),
    [],
  )
  return useRealtimeRows<LatestFunding>(opts)
}
