// src/components/Header.tsx — portfolio P&L + open count + last update (SPEC §7).
import type { PaperPosition, PnlSnapshot } from '../types/domain'
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

export function Header({ positions, pnl }: { positions: PaperPosition[]; pnl: PnlSnapshot[] }) {
  const latest = latestByPosition(pnl)
  let total = 0
  for (const p of positions) {
    if (p.status === 'closed' || p.status === 'liquidated_paper') {
      total += p.realizedPnlUsd ?? 0
    } else {
      const s = latest.get(p.id)
      total += (s?.unrealizedPnlUsd ?? 0) + p.cumulativeFundingUsd - p.cumulativeFeesUsd
    }
  }
  const openCount = positions.filter((p) => p.status === 'open' || p.status === 'at_risk').length
  const lastTs = pnl.length ? pnl[pnl.length - 1].ts : null

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
        <span className="text-fg/60">Updated {fmtRelTime(lastTs)}</span>
      </div>
    </header>
  )
}
