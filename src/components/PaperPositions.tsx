// src/components/PaperPositions.tsx — open/at_risk positions w/ live P&L (read-only).
// Manual Close CTA removed: the engine closes on liquidation (snapshot-pnl), and the
// invokable fns are now verify_jwt=true (no anon access). The dashboard observes only.
import { useMemo } from 'react'
import type { PaperPosition, PnlSnapshot } from '../types/domain'
import { Panel } from './ui/Panel'
import { EmptyState } from './ui/EmptyState'
import { Pill } from './ui/Pill'
import { fmtSignedUsd, fmtBps } from '../lib/format'

function latestByPosition(snaps: PnlSnapshot[]): Map<number, PnlSnapshot> {
  const m = new Map<number, PnlSnapshot>()
  for (const s of snaps) {
    if (s.positionId === null) continue
    const cur = m.get(s.positionId)
    if (!cur || s.ts > cur.ts) m.set(s.positionId, s)
  }
  return m
}

export function PaperPositions({ positions, pnl }: { positions: PaperPosition[]; pnl: PnlSnapshot[] }) {
  const latest = useMemo(() => latestByPosition(pnl), [pnl])

  if (!positions.length)
    return (
      <Panel title="Paper Positions">
        <EmptyState message="No paper positions yet — engine deploys soon." />
      </Panel>
    )

  return (
    <Panel title="Paper Positions">
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-bg/80 text-fg/50">
            <tr>
              <th className="py-1">#</th>
              <th>Status</th>
              <th className="text-right">Unreal.</th>
              <th className="text-right">Funding</th>
              <th className="text-right">Liq dist</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const s = latest.get(p.id)
              const unreal = s?.unrealizedPnlUsd ?? 0
              return (
                <tr key={p.id} className="border-t border-white/5">
                  <td className="py-1">{p.id}</td>
                  <td>
                    <Pill tone={p.status === 'at_risk' ? 'warn' : 'good'}>{p.status}</Pill>
                  </td>
                  <td className={`text-right ${unreal >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                    {fmtSignedUsd(unreal)}
                  </td>
                  <td className="text-right text-fg/80">{fmtSignedUsd(p.cumulativeFundingUsd)}</td>
                  <td className="text-right text-fg/60">{fmtBps(s?.liquidationDistanceBps ?? null)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
