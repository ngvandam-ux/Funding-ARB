// src/components/FundingHeatmap.tsx — CSS grid rows=base symbol, cols=venue.
// Color = signed 1h-APR (heatmap.ts); cell size rank = open interest. SPEC §7.
import { useMemo } from 'react'
import type { LatestFunding, VenueId } from '../types/domain'
import { Panel } from './ui/Panel'
import { EmptyState } from './ui/EmptyState'
import { aprColor, oiSizeRank } from '../lib/heatmap'
import { fmtApr } from '../lib/format'

const VENUES: VenueId[] = ['hyperliquid', 'okx', 'binance_futures', 'bybit']
const VENUE_LABEL: Record<VenueId, string> = {
  hyperliquid: 'HL', okx: 'OKX', binance_futures: 'BIN', bybit: 'BYB',
}
const SIZE_OPACITY = [0.35, 0.6, 0.8, 1]

export function FundingHeatmap({ rows }: { rows: LatestFunding[] }) {
  const { symbols, cell } = useMemo(() => {
    const cellMap = new Map<string, LatestFunding>()
    const syms = new Set<string>()
    for (const r of rows) {
      syms.add(r.baseSymbol)
      cellMap.set(`${r.baseSymbol}|${r.venueId}`, r)
    }
    return { symbols: [...syms].sort(), cell: cellMap }
  }, [rows])

  if (!rows.length) return <Panel title="Funding Heatmap"><EmptyState message="Waiting for funding snapshots…" /></Panel>

  return (
    <Panel title="Funding Heatmap">
      <div className="grid gap-1 text-xs" style={{ gridTemplateColumns: `4rem repeat(${VENUES.length}, 1fr)` }}>
        <div />
        {VENUES.map((v) => <div key={v} className="text-center text-fg/60">{VENUE_LABEL[v]}</div>)}
        {symbols.map((sym) => (
          <FragmentRow key={sym} sym={sym} cell={cell} />
        ))}
      </div>
    </Panel>
  )
}

function FragmentRow({ sym, cell }: { sym: string; cell: Map<string, LatestFunding> }) {
  return (
    <>
      <div className="flex items-center font-medium text-fg/80">{sym}</div>
      {VENUES.map((v) => {
        const c = cell.get(`${sym}|${v}`)
        const color = aprColor(c ? c.fundingRate1hApr : null)
        const opacity = c ? SIZE_OPACITY[oiSizeRank(c.openInterestUsd)] : 0
        return (
          <div
            key={v}
            title={c ? `${sym} ${VENUE_LABEL[v]} ${fmtApr(c.fundingRate1hApr)} · next ${c.nextFundingTs ?? '—'}` : 'no data'}
            className="flex h-8 items-center justify-center rounded"
            style={{ backgroundColor: color === 'transparent' ? 'rgba(255,255,255,0.03)' : color, opacity: c ? opacity : 1 }}
          >
            {c ? <span className="text-[10px] text-black/70">{fmtApr(c.fundingRate1hApr)}</span> : ''}
          </div>
        )
      })}
    </>
  )
}
