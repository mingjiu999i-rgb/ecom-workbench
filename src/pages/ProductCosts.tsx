import { Calculator, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Field, Input } from '../components/Fields'
import { Modal } from '../components/Overlay'
import { createId, useWorkbench } from '../store/workbench'
import type { ProductCost } from '../types/models'
import { money } from '../utils/calculations'

const emptyCost = (): ProductCost => ({ id: '', skuCode: '', specification: '', totalCost: 0 })

export function ProductCosts() {
  const { data, update } = useWorkbench()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<ProductCost | null>(null)
  const rows = useMemo(() => data.productCosts.filter(item =>
    `${item.skuCode} ${item.specification}`.toLowerCase().includes(query.trim().toLowerCase()),
  ), [data.productCosts, query])

  const save = (item: ProductCost) => {
    update(current => ({
      ...current,
      productCosts: item.id
        ? current.productCosts.map(row => row.id === item.id ? item : row)
        : [...current.productCosts, { ...item, id: createId('cost') }],
    }))
    setEditing(null)
  }

  const remove = (item: ProductCost) => {
    if (!window.confirm(`确定删除 SKU“${item.skuCode}”的成本资料吗？`)) return
    update(current => ({ ...current, productCosts: current.productCosts.filter(row => row.id !== item.id) }))
  }

  return <div className="page">
    <div className="page-heading"><div><span className="eyebrow">成本资料库</span><h1>产品成本</h1><p>维护商品 SKU 编码、售卖规格与总成本。</p></div><button className="button primary" onClick={() => setEditing(emptyCost())}><Plus size={17} />新增成本</button></div>
    <section className="filter-bar cost-filter">
      <div className="filter-title"><Calculator size={17} /><span>SKU 成本</span></div>
      <div className="search"><Search size={16} /><Input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索 SKU 编码或售卖规格" /></div>
      {query && <button className="text-button" onClick={() => setQuery('')}>清空</button>}
    </section>
    <section className="panel table-panel">
      <div className="table-caption"><div><strong>成本列表</strong><span>共 {rows.length} 条</span></div></div>
      <div className="table-scroll"><table><thead><tr><th>SKU 编码</th><th>售卖规格</th><th>总成本</th><th>操作</th></tr></thead><tbody>
        {rows.map(item => <tr key={item.id}><td><strong className="cell-main">{item.skuCode}</strong></td><td>{item.specification}</td><td className="emphasis">{money(item.totalCost)}</td><td><div className="actions"><button className="icon-button" onClick={() => setEditing(item)} aria-label={`编辑 ${item.skuCode}`}><Pencil size={15} /></button><button className="icon-button danger" onClick={() => remove(item)} aria-label={`删除 ${item.skuCode}`}><Trash2 size={15} /></button></div></td></tr>)}
      </tbody></table></div>
      {!rows.length && <div className="empty"><strong>暂无产品成本</strong><span>点击右上角新增 SKU 成本资料</span></div>}
    </section>
    {editing && <CostModal initial={editing} onClose={() => setEditing(null)} onSave={save} />}
  </div>
}

function CostModal({ initial, onClose, onSave }: { initial: ProductCost; onClose: () => void; onSave: (item: ProductCost) => void }) {
  const [item, setItem] = useState(initial)
  const valid = item.skuCode.trim() && item.specification.trim() && Number.isFinite(item.totalCost) && item.totalCost >= 0
  return <Modal title={`${item.id ? '编辑' : '新增'}产品成本`} onClose={onClose}>
    <div className="form-grid modal-body">
      <Field label="SKU 编码" full><Input autoFocus value={item.skuCode} onChange={event => setItem(current => ({ ...current, skuCode: event.target.value }))} placeholder="例如：SKU-A01" /></Field>
      <Field label="售卖规格" full><Input value={item.specification} onChange={event => setItem(current => ({ ...current, specification: event.target.value }))} placeholder="例如：2 件装 / 红色 XL" /></Field>
      <Field label="总成本" full><Input type="number" min="0" step="0.01" value={item.totalCost} onChange={event => setItem(current => ({ ...current, totalCost: event.target.value === '' ? 0 : Number(event.target.value) }))} /></Field>
    </div>
    <div className="modal-actions"><button className="button ghost" onClick={onClose}>取消</button><button className="button primary" disabled={!valid} onClick={() => onSave({ ...item, skuCode: item.skuCode.trim(), specification: item.specification.trim() })}>保存</button></div>
  </Modal>
}
