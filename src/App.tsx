// src/App.tsx — 12-col dashboard grid (SPEC §7). Each panel owns its own data hook.
import { useFundingSnapshots } from './hooks/useFundingSnapshots'
import { useOpportunities } from './hooks/useOpportunities'
import { usePaperPositions } from './hooks/usePaperPositions'
import { usePnlSnapshots } from './hooks/usePnlSnapshots'
import { useExecutionLog } from './hooks/useExecutionLog'
import { Header } from './components/Header'
import { FundingHeatmap } from './components/FundingHeatmap'
import { AprLeaderboard } from './components/AprLeaderboard'
import { OpportunityTable } from './components/OpportunityTable'
import { PaperPositions } from './components/PaperPositions'
import { PnlCurve } from './components/PnlCurve'
import { ExecutionLog } from './components/ExecutionLog'

export default function App() {
  const funding = useFundingSnapshots()
  const opps = useOpportunities()
  const positions = usePaperPositions()
  const pnl = usePnlSnapshots()
  const exec = useExecutionLog(pnl.data)

  return (
    <div className="min-h-screen bg-bg p-4 text-fg">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <Header positions={positions.data} pnl={pnl.data} funding={funding.data} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <FundingHeatmap rows={funding.data} />
          <AprLeaderboard rows={funding.data} />
          <OpportunityTable rows={opps.data} />
          <PaperPositions positions={positions.data} pnl={pnl.data} />
        </div>
        <PnlCurve pnl={pnl.data} />
        <ExecutionLog events={exec.data} />
      </div>
    </div>
  )
}
