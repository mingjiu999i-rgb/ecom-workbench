import { FilePenLine, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Field, Input, Select } from '../components/Fields'
import { Modal } from '../components/Overlay'
import { createId, useWorkbench } from '../store/workbench'
import { calculateSkuDraft, getSkuPlanningDrafts, matchDraftCost, putSkuPlanningDraft, removeSkuPlanningDraft, roiSetting, type SkuPlanningDraft } from '../utils/skuDrafts'
import './sku-drafts.css'

const amount = (value: number | null) => value == null ? '待填写' : `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const percent = (value: number | null) => value == null ? '待填写 A 当前 ROI' : `${(value * 100).toFixed(2)}%`
const roi = (value: number | null) => value == null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
const number = (value: string) => value.trim() === '' ? null : Number(value)
const positive = (value: number | null) => value != null && Number.isFinite(value) && value > 0
type Result = ReturnType<typeof calculateSkuDraft>
const target = (result: Result, priceB: number | null, roiA: number | null) => result.targetState === 'ready' ? roi(result.suggestedRoi)
  : result.targetState === 'no-ad-spend' ? '仅零推广费可达成'
  : result.targetState === 'unreachable' ? '该售价无法达成'
  : !positive(roiA) ? '待填写 A 当前 ROI' : !positive(priceB) ? '待填写 B 售价' : '待完善基础定价'
const breakEven = (result: Result) => result.breakEvenRoi != null ? roi(roiSetting(result.breakEvenRoi))
  : !result.baseValid ? '待填写' : result.grossProfit === 0 ? '仅零推广费保本' : '售价低于成本'

export function SkuDrafts() {
  const { data, update } = useWorkbench()
  const [editing, setEditing] = useState<SkuPlanningDraft | 'new' | null>(null)
  const [query, setQuery] = useState('')
  const drafts = getSkuPlanningDrafts(data)
  const rows = drafts.filter(row => {
    const product = data.products.find(item => item.id === row.productId)
    const client = data.clients.find(item => item.id === product?.clientId)
    return `${row.name} ${product?.name || ''} ${client?.name || ''}`.toLowerCase().includes(query.trim().toLowerCase())
  }).slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return <div className="page sku-drafts-page">
    <div className="page-heading"><div><span className="eyebrow">定价与投产规划</span><h1>SKU 草稿</h1><p>先拟售价，再验证 A 店投产；跑通后，换算其他售价所需的目标 ROI。</p></div><button className="button primary" onClick={() => setEditing('new')}><Plus size={17} />新建 SKU 草稿</button></div>
    <div className="draft-stages"><div><b>01</b><strong>基础定价<span>必填 · SKU、产品、成本、A 拟售价</span></strong></div><div><b>02</b><strong>A 店验证<span>选填 · 跑量后填写 A 当前 ROI</span></strong></div><div><b>03</b><strong>跨店换算<span>选填 · B 售价 → 同利润率目标 ROI</span></strong></div></div>
    <div className="draft-scope-note">草稿独立保存到当前账号，沿用工作台云端同步。不会创建正式商品、修改成本库、调整投放或改变经营结算。</div>
    <section className="filter-bar"><div className="filter-title"><FilePenLine size={17} /><span>{drafts.length} 份草稿</span></div><div className="search"><Search size={16} /><Input aria-label="搜索 SKU 草稿" placeholder="搜索 SKU、产品或甲方" value={query} onChange={event => setQuery(event.target.value)} /></div></section>
    <section className="panel table-panel"><div className="table-caption"><div><strong>SKU 定价草稿</strong><span>毛利未扣推广费；推广后利润率需有 A 当前 ROI 才能计算。</span></div></div><div className="table-scroll"><table className="draft-table"><thead><tr>{['SKU / 产品', '成本', 'A 拟售价', '推广前毛利 / 毛利率', 'A 保本 ROI', 'A 当前 ROI（选填）', 'A 推广后利润率', 'B 售价（选填）', 'B 目标 ROI（至少）', '操作'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{rows.map(row => {
      const result = calculateSkuDraft(row)
      const product = data.products.find(item => item.id === row.productId)
      const cost = data.productCosts.find(item => item.id === row.costId)
      const client = data.clients.find(item => item.id === product?.clientId)
      return <tr key={row.id}><td><strong className="cell-main">{row.name}</strong><span className="cell-sub">{client?.name || '甲方已移除'} · {product?.name || '产品已移除'}</span>{(!cost || cost.totalCost !== row.cost) && <span className="draft-cost-warning">{cost ? '成本库已变更，草稿保留原成本' : '成本记录已移除，草稿保留原成本'}</span>}</td><td>{amount(row.cost)}</td><td>{amount(row.priceA)}</td><td><strong className={result.grossProfit != null && result.grossProfit < 0 ? 'negative' : ''}>{amount(result.grossProfit)}</strong><span className="cell-sub">{result.grossMargin == null ? '待填写' : percent(result.grossMargin)}</span></td><td>{breakEven(result)}</td><td>{row.roiA == null ? '未填写' : roi(row.roiA)}</td><td className={result.marginA != null && result.marginA < 0 ? 'negative' : ''}>{percent(result.marginA)}</td><td>{row.priceB == null ? '未填写' : amount(row.priceB)}</td><td className="draft-target">{target(result, row.priceB, row.roiA)}</td><td><div className="actions"><button className="icon-button" aria-label={`编辑草稿 ${row.name}`} onClick={() => setEditing(row)}><Pencil size={15} /></button><button className="icon-button danger" aria-label={`删除草稿 ${row.name}`} onClick={() => { if (window.confirm(`确定删除草稿“${row.name}”吗？不会删除正式商品或成本。`)) update(current => removeSkuPlanningDraft(current, row.id)) }}><Trash2 size={15} /></button></div></td></tr>
    })}</tbody></table></div>{!rows.length && <div className="empty"><FilePenLine size={28} /><strong>{query ? '没有匹配的草稿' : '先把 SKU 和拟售价记下来'}</strong><span>{query ? '请调整搜索条件。' : '只填基础定价即可保存，A 当前 ROI 和 B 售价可以以后补。'}</span></div>}</section>
    <div className="draft-scope-note">同成本下，B 售价越低，所需目标 ROI 越高；售价越高，目标 ROI 可降低。目标用于对齐扣推广费后的利润率，不保证店铺之间不抢流量。请把运费、包装等纳入成本；未计入的费用和退款损失不会被推算。</div>
    {editing && <DraftEditor initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSave={draft => { update(current => putSkuPlanningDraft(current, draft)); setEditing(null) }} />}
  </div>
}

function DraftEditor({ initial, onClose, onSave }: { initial: SkuPlanningDraft | null; onClose: () => void; onSave: (draft: SkuPlanningDraft) => void }) {
  const { data } = useWorkbench()
  const [clientId, setClientId] = useState(data.products.find(row => row.id === initial?.productId)?.clientId || '')
  const [productId, setProductId] = useState(initial?.productId || '')
  const [name, setName] = useState(initial?.name || '')
  const [costId, setCostId] = useState(initial?.costId || '')
  const [cost, setCost] = useState<number | null>(initial?.cost ?? null)
  const [priceA, setPriceA] = useState(initial ? String(initial.priceA) : '')
  const [roiA, setRoiA] = useState(initial?.roiA == null ? '' : String(initial.roiA))
  const [priceB, setPriceB] = useState(initial?.priceB == null ? '' : String(initial.priceB))
  const [message, setMessage] = useState('')
  const costs = data.productCosts.filter(row => row.productId === productId)
  const selectedCost = costs.find(row => row.id === costId)
  const input = { cost, priceA: number(priceA), roiA: number(roiA), priceB: number(priceB) }
  const result = calculateSkuDraft(input)
  const valid = !!name.trim() && !!productId && !!selectedCost && result.baseValid && (roiA === '' || positive(input.roiA)) && (priceB === '' || positive(input.priceB))
  const chooseCost = (id: string) => { const item = costs.find(row => row.id === id); setCostId(id); setCost(item && Number.isFinite(item.totalCost) && item.totalCost >= 0 ? item.totalCost : null); setMessage('') }
  const resetCost = () => { setCostId(''); setCost(null); setMessage('') }
  return <Modal wide title={initial ? '编辑 SKU 草稿' : '新建 SKU 草稿'} onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); if (valid) onSave({ id: initial?.id || createId('sku-plan'), name: name.trim(), productId, costId, cost: cost!, priceA: input.priceA!, roiA: input.roiA, priceB: input.priceB, updatedAt: new Date().toISOString() }) }}>
      <div className="modal-body draft-editor">
        <h3>01 基础定价 <small>必填</small></h3><div className="form-grid">
          <Field label="所属甲方 *"><Select required aria-label="所属甲方" value={clientId} onChange={event => { setClientId(event.target.value); setProductId(''); resetCost() }}><option value="">请选择甲方</option>{data.clients.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</Select></Field>
          <Field label="所属产品 *"><Select required aria-label="所属产品" value={productId} onChange={event => { setProductId(event.target.value); resetCost() }}><option value="">请选择产品</option>{data.products.filter(row => row.clientId === clientId).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</Select></Field>
          <Field label="预设 SKU 名称 / 规格 *" full><Input required autoFocus aria-label="预设 SKU 名称" value={name} onChange={event => setName(event.target.value)} placeholder="例如：1斤小果（60–100g）" /></Field>
          <Field label="关联成本 *" full><div className="draft-cost-picker"><Select required aria-label="关联成本" value={selectedCost ? costId : ''} onChange={event => chooseCost(event.target.value)}><option value="">{productId && !costs.length ? '该产品暂无成本，请先到产品成本新增' : '请选择成本 SKU'}</option>{costs.map(row => <option key={row.id} value={row.id}>{row.skuCode} · {row.specification} · {amount(row.totalCost)}</option>)}</Select><button className="button secondary" type="button" disabled={!productId || !name.trim() || !costs.length} onClick={() => { const matched = matchDraftCost(data, productId, name); if (matched) { chooseCost(matched); setMessage('已在当前产品内匹配到唯一成本，请核对规格。') } else setMessage('未找到唯一匹配，请从成本列表手动选择。不会猜测或覆盖当前选择。') }}>匹配成本</button></div></Field>
          {message && <p className="draft-help field-full" role="status">{message}</p>}
          <Field label="测算总成本（只读）"><Input aria-label="测算总成本" readOnly value={cost == null ? '' : amount(cost)} placeholder="选择成本后显示" /></Field>
          <Field label="A 拟售价（元）*"><Input required aria-label="A 拟售价" type="number" min="0.01" step="0.01" value={priceA} onChange={event => setPriceA(event.target.value)} placeholder="必填，例如 10" /></Field>
        </div>
        {selectedCost && selectedCost.totalCost !== cost && <div className="draft-alert">成本库已更新。草稿仍按原成本 {amount(cost)} 测算。<button type="button" className="text-button" onClick={() => chooseCost(costId)}>使用最新成本 {amount(selectedCost.totalCost)}</button></div>}
        <p className="draft-help">成本由成本库选取，包含哪些费用以成本资料为准。<Link to="/product-costs" target="_blank" rel="noreferrer">打开产品成本库</Link>；此处不会修改成本库。</p>
        <div className="draft-base-results"><div><span>推广前毛利</span><strong>{amount(result.grossProfit)}</strong></div><div><span>推广前毛利率</span><strong>{result.grossMargin == null ? '待填写' : percent(result.grossMargin)}</strong></div><div><span>A 保本 ROI</span><strong>{breakEven(result)}</strong></div></div>
        <h3>02 A 店验证 <small>选填 · 未跑通可留空</small></h3><div className="form-grid"><Field label="A 当前 ROI（销售额 ÷ 推广费）"><Input aria-label="A 当前 ROI" type="number" min="0.01" step="0.01" value={roiA} onChange={event => setRoiA(event.target.value)} placeholder="选填，例如 3" /></Field><div className="draft-result"><span>A 扣推广费后利润率</span><strong className={result.marginA != null && result.marginA < 0 ? 'negative' : ''}>{percent(result.marginA)}</strong></div></div>
        {result.marginA != null && result.marginA < 0 && <div className="draft-alert">A 当前方案亏损。后续 B 目标只会对齐这个亏损率，不代表保本或盈利。</div>}
        <h3>03 跨店换算 <small>选填 · A 跑通后再填</small></h3><div className="form-grid"><Field label="B 拟售价（元）"><Input aria-label="B 拟售价" type="number" min="0.01" step="0.01" value={priceB} onChange={event => setPriceB(event.target.value)} placeholder="选填，例如 8" /></Field><div className="draft-result"><span>B 目标 ROI（至少）</span><strong>{target(result, input.priceB, input.roiA)}</strong></div></div>
        {result.targetState === 'ready' && <div className="draft-comparison"><span>A 每单推广费 {amount(result.adCostA)} · 每单利润 {amount(result.profitA)}</span><span>B 按建议 ROI 测算：每单利润 {amount(result.profitB)} · 利润率 {percent(result.marginB)}</span></div>}
        <p className="draft-help">推广前毛利＝售价－成本；保本 ROI＝售价 ÷ 推广前毛利；推广后利润率＝1－成本 ÷ 售价－1 ÷ ROI。B 目标按同利润率反算；保本和目标 ROI 均向上取两位小数，避免设置低于理论值。仅作测算，不包含未计入成本的费用或退款，也不保证不抢流量。</p>
        {((roiA !== '' && !positive(input.roiA)) || (priceB !== '' && !positive(input.priceB))) && <div className="form-error">选填项可以留空；填写时，ROI 和售价必须大于 0。</div>}
      </div><div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={!valid}>保存草稿</button></div>
    </form>
  </Modal>
}
