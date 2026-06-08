// src/components/OpportunityTable.tsx — open opportunities, sortable, with paper-trade CTA.
import { useState } from 'react'
import type { Opportunity } from '../types/domain'
import { Panel } from './ui/Panel'
import { EmptyState } from './ui/EmptyState'
import { Pill } from './ui/Pill'
import { fmtApr } from '../lib/format'
import { openPaperPosition } from '../lib/api'

export function OpportunityTable({ rows }: { rows: Opportunity[] }) {
  const [busy, setBusy] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function trade(id: number) {
    setBusy(id); setErr(null)
    try { await openPaperPosition(id) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }

  if (!rows.length) return <Panel title="Opportunities"><EmptyState message="No open opportunities clearing the detect bar." /></Panel>

  return (
    <Panel title="Opportunities" right={err ? <span className="text-xs text-rose-300">{err}</span> : undefined}>
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-bg/80 text-fg/50">
            <tr><th className="py-1">Symbol</th><th>Kind</th><th className="text-right">Net APR</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} className="border-t border-white/5">
                <td className="py-1 font-medium">{o.baseSymbol}</td>
                <td><Pill tone={o.kind === 'cross_venue_basis_arb' ? 'warn' : 'neutral'}>{o.kind === 'cross_venue_basis_arb' ? 'cross' : 'single'}</Pill></td>
                <td className="text-right text-emerald-300">{fmtApr(o.netApr)}</td>
                <td className="text-right">
                  <button
                    disabled={busy === o.id}
                    onClick={() => trade(o.id)}
                    className="rounded bg-magenta/20 px-2 py-0.5 text-magenta hover:bg-magenta/30 disabled:opacity-40"
                  >
                    {busy === o.id ? '…' : 'Paper-trade'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
