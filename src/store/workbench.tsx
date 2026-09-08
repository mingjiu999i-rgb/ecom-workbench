import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { storage } from '../services/storage'
import type { WorkbenchData } from '../types/models'

interface WorkbenchContextValue {
  data: WorkbenchData
  update: (recipe: (current: WorkbenchData) => WorkbenchData) => void
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null)

export const createId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<WorkbenchData>(() => storage.load())
  useEffect(() => { storage.save(data) }, [data])
  useEffect(() => {
    const context = document.modelContext
    if (!context?.registerTool) return
    const lifecycle = new AbortController()
    const report = (error: unknown) => console.warn('WebMCP tool registration failed', error)
    void Promise.resolve(context.registerTool({
      name: 'read_workbench_summary', title: '查看运营概况',
      description: '读取当前浏览器中运营工作台的甲方、店铺、商品链接、SKU 和风险 SKU 数量。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => ({ clients: data.clients.length, stores: data.stores.length, productLinks: data.productLinks.length, skus: data.skus.length, riskSkus: data.skus.filter(s => s.currentRoi < s.breakEvenRoi).length }),
    }, { signal: lifecycle.signal })).catch(report)
    void Promise.resolve(context.registerTool({
      name: 'update_sku_current_roi', title: '调整 SKU 当前投产',
      description: '按内部 SKU 记录 ID 修改当前投产，并同步新增一条原因记为“推广调整”的调整记录。',
      inputSchema: { type: 'object', properties: { skuId: { type: 'string' }, currentRoi: { type: 'number', minimum: 0 } }, required: ['skuId', 'currentRoi'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input: unknown) => {
        if (!input || typeof input !== 'object') throw new Error('需要 skuId 和 currentRoi')
        const { skuId, currentRoi } = input as { skuId?: unknown; currentRoi?: unknown }
        if (typeof skuId !== 'string' || typeof currentRoi !== 'number' || !Number.isFinite(currentRoi) || currentRoi < 0) throw new Error('输入无效')
        const sku = data.skus.find(item => item.id === skuId)
        const link = data.productLinks.find(item => item.id === sku?.productLinkId)
        if (!sku || !link) throw new Error('未找到 SKU')
        setData(current => ({ ...current,
          skus: current.skus.map(item => item.id === skuId ? { ...item, currentRoi } : item),
          operations: [{ id: createId('op'), createdAt: new Date().toISOString(), clientId: link.clientId, storeId: link.storeId, productId: link.productId, productLinkId: link.id, skuId, type: '投产', before: String(sku.currentRoi), after: String(currentRoi), reason: '推广调整', remark: '通过页面工具调整' }, ...current.operations],
        }))
        return { skuId, before: sku.currentRoi, after: currentRoi, saved: true }
      },
    }, { signal: lifecycle.signal })).catch(report)
    return () => lifecycle.abort()
  }, [data])
  const value = useMemo(() => ({ data, update: setData }), [data])
  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>
}

export function useWorkbench() {
  const value = useContext(WorkbenchContext)
  if (!value) throw new Error('useWorkbench must be used inside WorkbenchProvider')
  return value
}
