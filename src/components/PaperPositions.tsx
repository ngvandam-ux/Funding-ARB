// src/components/PaperPositions.tsx — open/at_risk positions w/ live P&L + close CTA.
import { useMemo, useState } from 'react'
import type { PaperPosition, PnlSnapshot } from '../types/domain'
import { Panel } from './ui/Panel'
import { EmptyState } from './ui/EmptyState'
import { Pill } from './ui/Pill'
import { fmtSignedUsd, fmtBps } from '../lib/format'
import { closePaperPosition } from '../lib/api'

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
  const [busy, setBusy] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function close(id: number) {
    setBusy(id); setErr(null)
    try { await closePaperPosition(id) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }

  if (!positions.length) return <Panel title="Paper Positions"><EmptyState message="No paper positions yet — engine deploys soon." /></Panel>

  return (
    <Panel title="Paper Positions" right={err ? <span className="text-xs text-rose-300">{err}</span> : undefined}>
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-bg/80 text-fg/50">
            <tr><th className="py-1">#</th><th>Status</th><th className="text-right">Unreal.</th><th className="text-right">Funding</th><th className="text-right">Liq dist</th><th /></tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const s = latest.get(p.id)
              const unreal = s?.unrealizedPnlUsd ?? 0
              return (
                <tr key={p.id} className="border-t border-white/5">
                  <td className="py-1">{p.id}</td>
                  <td><Pill tone={p.status === 'at_risk' ? 'warn' : 'good'}>{p.status}</Pill></td>
                  <td className={`text-right ${unreal >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{fmtSignedUsd(unreal)}</td>
                  <td className="text-right text-fg/80">{fmtSignedUsd(p.cumulativeFundingUsd)}</td>
                  <td className="text-right text-fg/60">{fmtBps(s?.liquidationDistanceBps ?? null)}</td>
                  <td className="text-right">
                    <button disabled={busy === p.id} onClick={() => close(p.id)} className="rounded bg-rose-500/20 px-2 py-0.5 text-rose-300 hover:bg-rose-500/30 disabled:opacity-40">
                      {busy === p.id ? '…' : 'Close'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
