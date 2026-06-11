// src/components/OpportunityTable.tsx — open opportunities, sortable (read-only).
// Manual paper-trade CTA removed: auto-open drives the run, and the invokable fns
// are now verify_jwt=true (no anon access). The dashboard observes; it never mutates.
import type { Opportunity } from '../types/domain'
import { Panel } from './ui/Panel'
import { EmptyState } from './ui/EmptyState'
import { Pill } from './ui/Pill'
import { fmtApr } from '../lib/format'

export function OpportunityTable({ rows }: { rows: Opportunity[] }) {
  if (!rows.length)
    return (
      <Panel title="Opportunities">
        <EmptyState message="No open opportunities clearing the detect bar." />
      </Panel>
    )

  return (
    <Panel title="Opportunities">
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-bg/80 text-fg/50">
            <tr>
              <th className="py-1">Symbol</th>
              <th>Kind</th>
              <th className="text-right">Net APR</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} className="border-t border-white/5">
                <td className="py-1 font-medium">{o.baseSymbol}</td>
                <td>
                  <Pill
                    tone={
                      o.kind === 'cross_venue_basis_arb'
                        ? 'warn'
                        : o.kind === 'momentum_harvest'
                          ? 'good'
                          : 'neutral'
                    }
                  >
                    {o.kind === 'cross_venue_basis_arb'
                      ? 'cross'
                      : o.kind === 'momentum_harvest'
                        ? 'momentum'
                        : 'single'}
                  </Pill>
                </td>
                <td className="text-right text-emerald-300">{fmtApr(o.netApr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
