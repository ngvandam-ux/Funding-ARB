// src/components/Header.tsx — portfolio P&L + open count + last update (SPEC §7).
import { useEffect, useState } from 'react'
import { differenceInMinutes } from 'date-fns'
import type { LatestFunding, PaperPosition, PnlSnapshot } from '../types/domain'
import { fmtSignedUsd, fmtRelTime } from '../lib/format'

// Latest snapshot per position.
function latestByPosition(snaps: PnlSnapshot[]): Map<number, PnlSnapshot> {
  const m = new Map<number, PnlSnapshot>()
  for (const s of snaps) {
    if (s.positionId === null) continue
    const cur = m.get(s.positionId)
    if (!cur || s.ts > cur.ts) m.set(s.positionId, s)
  }
  return m
}

export function Header({
  positions,
  pnl,
  funding,
}: {
  positions: PaperPosition[]
  pnl: PnlSnapshot[]
  funding: LatestFunding[]
}) {
  // Re-render every 30s so "Updated X ago" keeps ticking even when realtime dies
  // (otherwise the label is computed only at render and silently freezes).
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  const latest = latestByPosition(pnl)
  let total = 0
  for (const p of positions) {
    if (p.status === 'closed' || p.status === 'liquidated_paper') {
      total += p.realizedPnlUsd ?? 0
    } else {
      const s = latest.get(p.id)
      // cumulative_fees_usd is ALL costs (fees + slippage + synthetic spot leg).
      total += (s?.unrealizedPnlUsd ?? 0) + p.cumulativeFundingUsd - p.cumulativeFeesUsd
    }
  }
  const openCount = positions.filter((p) => p.status === 'open' || p.status === 'at_risk').length

  // Freshness = newest ts across pnl AND funding snapshots.
  let lastTs: string | null = null
  for (const s of pnl) if (lastTs === null || s.ts > lastTs) lastTs = s.ts
  for (const f of funding) if (lastTs === null || f.ts > lastTs) lastTs = f.ts
  const staleMin = lastTs ? differenceInMinutes(now, new Date(lastTs)) : null
  const staleClass =
    staleMin !== null && staleMin > 15
      ? 'text-rose-300'
      : staleMin !== null && staleMin > 5
        ? 'text-amber-300'
        : 'text-fg/60'

  return (
    <header className="flex flex-wrap items-baseline justify-between gap-4 rounded-lg border border-white/10 bg-white/[0.02] px-5 py-4">
      <h1 className="text-xl font-semibold">
        Funding-Arb <span className="text-magenta">·</span> <span className="text-cyan">paper only</span>
      </h1>
      <div className="flex items-baseline gap-6 text-sm">
        <span>
          Portfolio P&L{' '}
          <strong className={total >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{fmtSignedUsd(total)}</strong>
        </span>
        <span>Open <strong>{openCount}</strong></span>
        <span className={staleClass}>Updated {fmtRelTime(lastTs, now)}</span>
      </div>
    </header>
  )
}
