// src/hooks/usePaperPositions.ts — ALL positions (open + closed/liquidated).
// Consumers filter by status: PaperPositions shows open/at_risk; Header needs
// closed rows too so realized P&L reaches the portfolio total.
import { useMemo } from 'react'
import { useRealtimeRows } from './useRealtimeRows'
import type { PaperPosition, PositionStatus } from '../types/domain'

function numOrNull(v: unknown): number | null { return v === null || v === undefined ? null : Number(v) }

export function usePaperPositions() {
  const opts = useMemo(
    () => ({
      table: 'paper_positions',
      select: 'id, opportunity_id, opened_at, closed_at, status, position_size_usd, leg_a_instrument_id, leg_a_side, leg_a_entry_price, leg_b_instrument_id, leg_b_side, leg_b_entry_price, cumulative_funding_usd, cumulative_fees_usd, realized_pnl_usd',
      channel: 'dash_positions',
      map: (r: Record<string, unknown>): PaperPosition => ({
        id: Number(r.id),
        opportunityId: numOrNull(r.opportunity_id),
        openedAt: String(r.opened_at),
        closedAt: (r.closed_at as string | null) ?? null,
        status: r.status as PositionStatus,
        positionSizeUsd: Number(r.position_size_usd),
        legAInstrumentId: Number(r.leg_a_instrument_id),
        legASide: r.leg_a_side as 'long' | 'short',
        legAEntryPrice: Number(r.leg_a_entry_price),
        legBInstrumentId: numOrNull(r.leg_b_instrument_id),
        legBSide: (r.leg_b_side as 'long' | 'short' | null) ?? null,
        legBEntryPrice: numOrNull(r.leg_b_entry_price),
        cumulativeFundingUsd: Number(r.cumulative_funding_usd),
        cumulativeFeesUsd: Number(r.cumulative_fees_usd),
        realizedPnlUsd: numOrNull(r.realized_pnl_usd),
      }),
      key: (d: PaperPosition) => d.id,
      sort: (a: PaperPosition, b: PaperPosition) => b.openedAt.localeCompare(a.openedAt),
    }),
    [],
  )
  return useRealtimeRows<PaperPosition>(opts)
}
