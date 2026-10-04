import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { ConservativeProvider } from './context/ConservativeMode'
import { AgentSayDoView } from './views/AgentSayDoView'
import { AtlasView } from './views/AtlasView'
import { BacktestsView } from './views/BacktestsView'
import { BenchmarksView } from './views/BenchmarksView'
import { BrainView } from './views/BrainView'
import { LandingView } from './views/LandingView'
import { LiveView } from './views/LiveView'
import { LoopView } from './views/LoopView'
import { OrgChartView } from './views/OrgChartView'
import { SandboxView } from './views/SandboxView'
import { StrainView } from './views/StrainView'
import { SwarmMapView } from './views/SwarmMapView'

// HashRouter: works on any static host (GitHub Pages, `vite preview`, the demo laptop)
// without server-side rewrites.
export default function App() {
  return (
    <ConservativeProvider>
      <HashRouter>
        <Routes>
          <Route index element={<LandingView />} />
          <Route element={<Layout />}>
            <Route path="sandbox" element={<SandboxView />} />
            <Route path="live" element={<LiveView />} />
            <Route path="backtests" element={<BacktestsView />} />
            <Route path="atlas" element={<AtlasView />} />
            <Route path="loop" element={<LoopView />} />
            <Route path="swarm" element={<SwarmMapView />} />
            <Route path="strain" element={<StrainView />} />
            <Route path="agents" element={<AgentSayDoView />} />
            <Route path="agent" element={<Navigate to="/agents" replace />} />
            <Route path="brain" element={<BrainView />} />
            <Route path="org" element={<OrgChartView />} />
            <Route path="evidence" element={<BenchmarksView />} />
            <Route path="*" element={<Navigate to="/sandbox" replace />} />
          </Route>
        </Routes>
      </HashRouter>
    </ConservativeProvider>
  )
}
