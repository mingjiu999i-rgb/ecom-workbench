import { Calculator, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Field, Input, Select } from '../components/Fields'
import { Modal } from '../components/Overlay'
import { createId, useWorkbench } from '../store/workbench'
import type { ProductCost } from '../types/models'
import { calculatedBreakEvenRoi, money } from '../utils/calculations'

const emptyCost = (productId = ''): ProductCost => ({ id: '', productId, skuCode: '', specification: '', totalCost: 0 })

export function ProductCosts() {
  const { data, update } = useWorkbench()
  const [clientId, setClientId] = useState('')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<ProductCost | null>(null)
  const rows = useMemo(() => data.productCosts.filter(item => {
    const product = data.products.find(row => row.id === item.productId)
    const client = data.clients.find(row => row.id === product?.clientId)
    const matchesQuery = `${product?.name || ''} ${client?.name || ''} ${item.skuCode} ${item.specification}`.toLowerCase().includes(query.trim().toLowerCase())
    return (!clientId || product?.clientId === clientId) && matchesQuery
  }), [data.productCosts, data.products, data.clients, clientId, query])

  const save = (item: ProductCost) => {
    update(current => ({
      ...current,
      productCosts: item.id
        ? current.productCosts.map(row => row.id === item.id ? item : row)
        : [...current.productCosts, { ...item, id: createId('cost') }],
      skus: item.id ? current.skus.map(sku => sku.productCostId === item.id ? {
        ...sku,
        skuId: item.skuCode,
        specification: item.specification,
        productCost: item.totalCost,
        shippingCost: 0,
        packagingCost: 0,
        otherCost: 0,
        breakEvenRoi: calculatedBreakEvenRoi(sku.salePrice, item.totalCost),
      } : sku) : current.skus,
    }))
    setEditing(null)
  }

  const remove = (item: ProductCost) => {
    if (data.skus.some(sku => sku.productCostId === item.id)) {
      window.alert('该成本 SKU 已被商品 SKU 使用，请先删除或更换关联后再删除。')
      return
    }
    if (!window.confirm(`确定删除 SKU“${item.skuCode}”的成本资料吗？`)) return
    update(current => ({ ...current, productCosts: current.productCosts.filter(row => row.id !== item.id) }))
  }

  return <div className="page">
    <div className="page-heading"><div><span className="eyebrow">成本资料库</span><h1>产品成本</h1><p>成本归属产品，并自动继承产品所属甲方。</p></div><button className="button primary" onClick={() => setEditing(emptyCost(data.products[0]?.id))}><Plus size={17} />新增成本</button></div>
    <section className="filter-bar cost-filter">
      <div className="filter-title"><Calculator size={17} /><span>SKU 成本</span></div>
      <Select aria-label="甲方筛选" value={clientId} onChange={event => setClientId(event.target.value)}><option value="">全部甲方</option>{data.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</Select>
      <div className="search"><Search size={16} /><Input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索商品、甲方、SKU 或规格" /></div>
      {(clientId || query) && <button className="text-button" onClick={() => { setClientId(''); setQuery('') }}>清空</button>}
    </section>
    <section className="panel table-panel">
      <div className="table-caption"><div><strong>成本列表</strong><span>共 {rows.length} 条</span></div></div>
      <div className="table-scroll"><table><thead><tr><th>商品名称</th><th>所属甲方</th><th>SKU 编码</th><th>售卖规格</th><th>总成本</th><th>操作</th></tr></thead><tbody>
        {rows.map(item => { const product = data.products.find(row => row.id === item.productId); return <tr key={item.id}><td><strong className="cell-main">{product?.name || '未关联'}</strong></td><td>{data.clients.find(row => row.id === product?.clientId)?.name || '未关联'}</td><td><strong className="cell-main">{item.skuCode}</strong></td><td>{item.specification}</td><td className="emphasis">{money(item.totalCost)}</td><td><div className="actions"><button className="icon-button" onClick={() => setEditing(item)} aria-label={`编辑 ${item.skuCode}`}><Pencil size={15} /></button><button className="icon-button danger" onClick={() => remove(item)} aria-label={`删除 ${item.skuCode}`}><Trash2 size={15} /></button></div></td></tr> })}
      </tbody></table></div>
      {!rows.length && <div className="empty"><strong>暂无产品成本</strong><span>点击右上角新增 SKU 成本资料</span></div>}
    </section>
    {editing && <CostModal initial={editing} onClose={() => setEditing(null)} onSave={save} />}
  </div>
}

function CostModal({ initial, onClose, onSave }: { initial: ProductCost; onClose: () => void; onSave: (item: ProductCost) => void }) {
  const { data } = useWorkbench()
  const [item, setItem] = useState(initial)
  const initialProduct = data.products.find(product => product.id === initial.productId)
  const [selectedClientId, setSelectedClientId] = useState(initialProduct?.clientId || data.clients[0]?.id || '')
  const productsForClient = data.products.filter(product => product.clientId === selectedClientId)
  const valid = item.productId && item.skuCode.trim() && item.specification.trim() && Number.isFinite(item.totalCost) && item.totalCost >= 0
  return <Modal title={`${item.id ? '编辑' : '新增'}产品成本`} onClose={onClose}>
    <div className="form-grid modal-body">
      <Field label="所属甲方" full><Select value={selectedClientId} onChange={event => { const nextClientId = event.target.value; const firstProduct = data.products.find(product => product.clientId === nextClientId); setSelectedClientId(nextClientId); setItem(current => ({ ...current, productId: firstProduct?.id || '' })) }}><option value="">请选择甲方</option>{data.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</Select></Field>
      <Field label="商品名称" full><Select value={item.productId} onChange={event => setItem(current => ({ ...current, productId: event.target.value }))}><option value="">{selectedClientId && !productsForClient.length ? '请先在基础资料中为该甲方新增产品' : '请选择商品'}</option>{productsForClient.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</Select></Field>
      <Field label="SKU 编码" full><Input autoFocus value={item.skuCode} onChange={event => setItem(current => ({ ...current, skuCode: event.target.value }))} placeholder="例如：SKU-A01" /></Field>
      <Field label="售卖规格" full><Input value={item.specification} onChange={event => setItem(current => ({ ...current, specification: event.target.value }))} placeholder="例如：2 件装 / 红色 XL" /></Field>
      <Field label="总成本" full><Input type="number" min="0" step="0.01" value={item.totalCost} onChange={event => setItem(current => ({ ...current, totalCost: event.target.value === '' ? 0 : Number(event.target.value) }))} /></Field>
    </div>
    <div className="modal-actions"><button className="button ghost" onClick={onClose}>取消</button><button className="button primary" disabled={!valid} onClick={() => onSave({ ...item, skuCode: item.skuCode.trim(), specification: item.specification.trim() })}>保存</button></div>
  </Modal>
}
