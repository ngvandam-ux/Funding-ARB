// src/hooks/usePnlSnapshots.ts — all pnl snapshots (time-series for the curve + header).
import { useMemo } from 'react'
import { useRealtimeRows } from './useRealtimeRows'
import type { PnlSnapshot } from '../types/domain'

function numOrNull(v: unknown): number | null { return v === null || v === undefined ? null : Number(v) }

export function usePnlSnapshots() {
  const opts = useMemo(
    () => ({
      table: 'pnl_snapshots',
      select: 'id, ts, position_id, unrealized_pnl_usd, realized_pnl_usd, cumulative_funding_usd, cumulative_fees_usd, leg_a_mark, leg_b_mark, liquidation_distance_bps',
      channel: 'dash_pnl',
      map: (r: Record<string, unknown>): PnlSnapshot => ({
        id: Number(r.id),
        ts: String(r.ts),
        positionId: numOrNull(r.position_id),
        unrealizedPnlUsd: Number(r.unrealized_pnl_usd),
        realizedPnlUsd: Number(r.realized_pnl_usd),
        cumulativeFundingUsd: Number(r.cumulative_funding_usd),
        cumulativeFeesUsd: Number(r.cumulative_fees_usd),
        legAMark: numOrNull(r.leg_a_mark),
        legBMark: numOrNull(r.leg_b_mark),
        liquidationDistanceBps: numOrNull(r.liquidation_distance_bps),
      }),
      key: (d: PnlSnapshot) => d.id,
      sort: (a: PnlSnapshot, b: PnlSnapshot) => a.ts.localeCompare(b.ts),
    }),
    [],
  )
  return useRealtimeRows<PnlSnapshot>(opts)
}
