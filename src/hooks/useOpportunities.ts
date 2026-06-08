// src/hooks/useOpportunities.ts — open opportunities, sorted by net_apr desc.
import { useMemo } from 'react'
import { useRealtimeRows } from './useRealtimeRows'
import type { Opportunity, OpportunityKind, OpportunityStatus } from '../types/domain'

export function useOpportunities() {
  const opts = useMemo(
    () => ({
      table: 'opportunities',
      select: 'id, detected_at, kind, base_symbol, gross_apr, net_apr, min_position_usd, status',
      channel: 'dash_opps',
      initialFilter: 'status=eq.open',
      map: (r: Record<string, unknown>): Opportunity => ({
        id: Number(r.id),
        detectedAt: String(r.detected_at),
        kind: r.kind as OpportunityKind,
        baseSymbol: String(r.base_symbol),
        grossApr: Number(r.gross_apr),
        netApr: Number(r.net_apr),
        minPositionUsd: Number(r.min_position_usd),
        status: r.status as OpportunityStatus,
      }),
      key: (d: Opportunity) => d.id,
      keep: (d: Opportunity) => d.status === 'open',
      sort: (a: Opportunity, b: Opportunity) => b.netApr - a.netApr,
    }),
    [],
  )
  return useRealtimeRows<Opportunity>(opts)
}
