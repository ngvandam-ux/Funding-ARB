// src/hooks/useExecutionLog.ts — merged event stream: paper_fills + pnl risk flips.
// Returns newest-first ExecEvent[] for the virtualized log.
import { useMemo } from 'react'
import { useRealtimeRows } from './useRealtimeRows'
import type { PaperFill, PnlSnapshot } from '../types/domain'

export interface ExecEvent {
  id: string
  ts: string
  kind: 'fill' | 'funding' | 'risk'
  text: string
}

function fillsHook() {
  return {
    table: 'paper_fills',
    select: 'id, position_id, ts, leg, side, action, instrument_id, price, size_usd, fee_usd, slippage_bps',
    channel: 'dash_fills',
    map: (r: Record<string, unknown>): PaperFill => ({
      id: Number(r.id),
      positionId: Number(r.position_id),
      ts: String(r.ts),
      leg: r.leg as 'a' | 'b',
      side: r.side as 'long' | 'short',
      action: r.action as 'open' | 'close',
      instrumentId: Number(r.instrument_id),
      price: Number(r.price),
      sizeUsd: Number(r.size_usd),
      feeUsd: Number(r.fee_usd),
      slippageBps: Number(r.slippage_bps),
    }),
    key: (d: PaperFill) => d.id,
  }
}

export function useExecutionLog(pnl: PnlSnapshot[]): { data: ExecEvent[]; isLoading: boolean; error: string | null } {
  const fillOpts = useMemo(fillsHook, [])
  const fills = useRealtimeRows<PaperFill>(fillOpts)

  const data = useMemo<ExecEvent[]>(() => {
    const fillEvents: ExecEvent[] = fills.data.map((f) => ({
      id: `fill-${f.id}`,
      ts: f.ts,
      kind: 'fill',
      text: `${f.action.toUpperCase()} leg ${f.leg.toUpperCase()} ${f.side} #${f.positionId} @ ${f.price} (fee $${f.feeUsd.toFixed(2)}, ${f.slippageBps}bps)`,
    }))
    // Risk events: a snapshot whose liq distance is tight (≤ at_risk band).
    const riskEvents: ExecEvent[] = pnl
      .filter((s) => s.liquidationDistanceBps !== null && (s.liquidationDistanceBps as number) <= 656) // ~0.2*d0 in bps
      .map((s) => ({
        id: `risk-${s.id}`,
        ts: s.ts,
        kind: 'risk' as const,
        text: `RISK #${s.positionId} liq distance ${Math.round(s.liquidationDistanceBps as number)}bps · funding $${s.cumulativeFundingUsd.toFixed(2)}`,
      }))
    return [...fillEvents, ...riskEvents].sort((a, b) => b.ts.localeCompare(a.ts))
  }, [fills.data, pnl])

  return { data, isLoading: fills.isLoading, error: fills.error }
}
