// src/components/PnlCurve.tsx — cumulative portfolio P&L over time, 4 series (SPEC §7).
// recharts is the ONLY charting lib (CLAUDE.md). Aggregates pnl_snapshots across
// positions per timestamp into portfolio totals.
import { useMemo } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Legend } from 'recharts'
import type { PnlSnapshot } from '../types/domain'
import { Panel } from './ui/Panel'
import { EmptyState } from './ui/EmptyState'

interface Point { ts: number; realized: number; unrealized: number; funding: number; fees: number }

// Sum the latest-known value per position at each snapshot timestamp (step-forward).
function buildSeries(snaps: PnlSnapshot[]): Point[] {
  const byTs = new Map<string, PnlSnapshot[]>()
  for (const s of snaps) {
    const arr = byTs.get(s.ts) ?? []
    arr.push(s)
    byTs.set(s.ts, arr)
  }
  const latestPerPos = new Map<number, PnlSnapshot>()
  const points: Point[] = []
  for (const ts of [...byTs.keys()].sort()) {
    for (const s of byTs.get(ts)!) if (s.positionId !== null) latestPerPos.set(s.positionId, s)
    let realized = 0, unrealized = 0, funding = 0, fees = 0
    for (const s of latestPerPos.values()) {
      realized += s.realizedPnlUsd; unrealized += s.unrealizedPnlUsd
      funding += s.cumulativeFundingUsd; fees += s.cumulativeFeesUsd
    }
    points.push({ ts: new Date(ts).getTime(), realized, unrealized, funding, fees: -fees })
  }
  return points
}

export function PnlCurve({ pnl }: { pnl: PnlSnapshot[] }) {
  const data = useMemo(() => buildSeries(pnl), [pnl])
  if (!data.length) return <Panel title="P&L Curve"><EmptyState message="No P&L snapshots yet — engine deploys soon." /></Panel>

  return (
    <Panel title="P&L Curve">
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} scale="time"
              tickFormatter={(t) => new Date(t as number).toLocaleDateString()} stroke="#6b7280" fontSize={11} />
            <YAxis stroke="#6b7280" fontSize={11} tickFormatter={(v) => `$${v as number}`} />
            <Tooltip contentStyle={{ background: '#0a0a0f', border: '1px solid rgba(255,255,255,0.1)' }}
              labelFormatter={(t) => new Date(t as number).toLocaleString()} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="unrealized" name="Unrealized" stroke="#22d3ee" dot={false} />
            <Line type="monotone" dataKey="realized" name="Realized" stroke="#e879f9" dot={false} />
            <Line type="monotone" dataKey="funding" name="Funding" stroke="#34d399" dot={false} />
            <Line type="monotone" dataKey="fees" name="Fees" stroke="#fb7185" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  )
}
