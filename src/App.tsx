import { Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Dashboard } from './pages/Dashboard'
import { Products } from './pages/Products'
import { Operations } from './pages/Operations'
import { MasterData } from './pages/MasterData'
import { ProductCosts } from './pages/ProductCosts'
import { PddAnalyzer } from './pages/PddAnalyzer'
import { ProfitPreview } from './pages/ProfitPreview'
import { WorkbenchProvider } from './store/workbench'

export default function App() {
  return <WorkbenchProvider><Routes><Route element={<Layout />}>
    <Route index element={<Dashboard />} />
    <Route path="products" element={<Products />} />
    <Route path="product-costs" element={<ProductCosts />} />
    <Route path="operations" element={<Operations />} />
    <Route path="master-data" element={<MasterData />} />
    <Route path="pdd-analyzer" element={<PddAnalyzer />} />
    <Route path="profit-preview" element={<ProfitPreview />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Route></Routes></WorkbenchProvider>
}
