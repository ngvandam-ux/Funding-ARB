// src/components/ExecutionLog.tsx — virtualized newest-top event stream (SPEC §7).
import { FixedSizeList } from 'react-window'
import type { ExecEvent } from '../hooks/useExecutionLog'
import { Panel } from './ui/Panel'
import { EmptyState } from './ui/EmptyState'

const TONE: Record<ExecEvent['kind'], string> = { fill: 'text-fg/80', funding: 'text-emerald-300', risk: 'text-amber-300' }

export function ExecutionLog({ events }: { events: ExecEvent[] }) {
  if (!events.length) return <Panel title="Execution Log"><EmptyState message="No fills or risk events yet." /></Panel>

  return (
    <Panel title="Execution Log">
      <FixedSizeList height={220} itemCount={events.length} itemSize={22} width="100%">
        {({ index, style }) => {
          const e = events[index]
          return (
            <div style={style} className={`flex gap-3 font-mono text-[11px] ${TONE[e.kind]}`}>
              <span className="text-fg/40">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className="truncate">{e.text}</span>
            </div>
          )
        }}
      </FixedSizeList>
    </Panel>
  )
}
