// src/components/AprLeaderboard.tsx — sortable table: symbol | venue | apr | next funding.
import { useMemo, useState } from 'react'
import type { LatestFunding } from '../types/domain'
import { Panel } from './ui/Panel'
import { EmptyState } from './ui/EmptyState'
import { fmtApr, fmtRelTime } from '../lib/format'

type SortKey = 'apr' | 'symbol'

export function AprLeaderboard({ rows }: { rows: LatestFunding[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('apr')
  const sorted = useMemo(() => {
    const copy = [...rows]
    copy.sort((a, b) =>
      sortKey === 'apr'
        ? Math.abs(b.fundingRate1hApr) - Math.abs(a.fundingRate1hApr)
        : a.baseSymbol.localeCompare(b.baseSymbol),
    )
    return copy
  }, [rows, sortKey])

  if (!rows.length) return <Panel title="APR Leaderboard"><EmptyState message="Waiting for funding snapshots…" /></Panel>

  return (
    <Panel
      title="APR Leaderboard"
      right={
        <button className="text-xs text-cyan hover:underline" onClick={() => setSortKey(sortKey === 'apr' ? 'symbol' : 'apr')}>
          sort: {sortKey}
        </button>
      }
    >
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-bg/80 text-fg/50">
            <tr><th className="py-1">Symbol</th><th>Venue</th><th className="text-right">1h APR</th><th className="text-right">Next</th></tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.instrumentId} className="border-t border-white/5">
                <td className="py-1 font-medium">{r.baseSymbol}</td>
                <td className="text-fg/70">{r.venueId.replace('_futures', '')}</td>
                <td className={`text-right ${r.fundingRate1hApr >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{fmtApr(r.fundingRate1hApr)}</td>
                <td className="text-right text-fg/50">{fmtRelTime(r.nextFundingTs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
