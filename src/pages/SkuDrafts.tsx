import { Check, Copy, Plus, Save, Search, Trash2, WandSparkles } from 'lucide-react'
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { Input, Select } from '../components/Fields'
import { createId, useWorkbench } from '../store/workbench'
import { calculateSkuDraft, getSkuPlanningDrafts, matchDraftCost, removeSkuPlanningDraft, roiSetting } from '../utils/skuDrafts'
import { blankDraftGridRow, chooseDraftGridCost, draftGridError, draftGridNumber, isBlankDraftGridRow, pasteDraftGrid, saveDraftGrid, toDraftGridRow, type DraftGridColumn, type DraftGridRow } from '../utils/skuDraftGrid'
import './sku-drafts.css'

const money = (value: number | null) => value == null ? '—' : `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
const percent = (value: number | null) => value == null ? '待填 A ROI' : `${(value * 100).toFixed(2)}%`
const roi = (value: number | null) => value == null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
type Result = ReturnType<typeof calculateSkuDraft>
const target = (result: Result, row: DraftGridRow) => result.targetState === 'ready' ? roi(result.suggestedRoi)
  : result.targetState === 'no-ad-spend' ? '仅零推广费可达' : result.targetState === 'unreachable' ? '该售价无法达成'
  : !row.roiA.trim() ? '待填 A ROI' : !row.priceB.trim() ? '待填 B 售价' : '待完善输入'

export function SkuDrafts() {
  const { data, update, syncStatus } = useWorkbench()
  const saved = getSkuPlanningDrafts(data)
  const [edits, setEdits] = useState<Record<string, DraftGridRow>>(() => saved.length ? {} : Object.fromEntries(Array.from({ length: 5 }, () => { const row = blankDraftGridRow(createId('sku-plan')); return [row.id, row] })))
  const [productId, setProductId] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState('')
  const table = useRef<HTMLTableElement>(null)
  const savedIds = new Set(saved.map(row => row.id))
  const rows = [...saved.map(row => edits[row.id] || toDraftGridRow(row)), ...Object.values(edits).filter(row => !savedIds.has(row.id))]
  const visible = rows.filter(row => {
    const product = data.products.find(item => item.id === row.productId)
    const client = data.clients.find(item => item.id === product?.clientId)
    return `${row.name} ${product?.name || ''} ${client?.name || ''}`.toLowerCase().includes(query.trim().toLowerCase())
  })
  const pending = Object.values(edits).filter(row => !isBlankDraftGridRow(row))
  const invalid = pending.filter(row => draftGridError(data, row))
  const dirty = pending.length > 0
  useEffect(() => {
    if (!dirty) return
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    const navigate = (event: MouseEvent) => {
      const anchor = (event.target as Element)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!anchor || anchor.target === '_blank' || anchor.origin !== window.location.origin || anchor.pathname === window.location.pathname) return
      if (!window.confirm('表格有尚未保存的修改，确定离开吗？')) { event.preventDefault(); event.stopPropagation() }
    }
    window.addEventListener('beforeunload', unload); document.addEventListener('click', navigate, true)
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', navigate, true) }
  }, [dirty])
  const patch = (row: DraftGridRow) => { setEdits(current => ({ ...current, [row.id]: row })); setMessage('') }
  const addRows = (count: number) => {
    const additions = Array.from({ length: count }, () => blankDraftGridRow(createId('sku-plan'), productId))
    setEdits(current => ({ ...current, ...Object.fromEntries(additions.map(row => [row.id, row])) })); setQuery(''); setMessage(`已新增 ${count} 行，可直接填写或粘贴。`)
  }
  const save = () => {
    if (!pending.length) return
    const latest = pending
    try {
      update(current => saveDraftGrid(current, latest, new Date().toISOString()))
      setEdits(current => Object.fromEntries(Object.entries(current).filter(([id]) => !latest.some(row => row.id === id))))
      setMessage(`已提交 ${latest.length} 行，云端状态请查看左侧同步提示。`)
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败，修改仍保留在表格中。') }
  }
  const paste = (event: ClipboardEvent, row: DraftGridRow, column: DraftGridColumn) => {
    const text = event.clipboardData.getData('text/plain')
    if (!/[\t\r\n]/.test(text)) return
    event.preventDefault()
    try {
      const result = pasteDraftGrid(data, visible, row.id, column, text, productId || row.productId, () => createId('sku-plan'))
      setEdits(current => ({ ...current, ...Object.fromEntries(result.touched.map(item => [item.id, item])) }))
      setMessage(`已粘贴 ${result.touched.length} 行，请核对成本后点击“保存全部”。`)
    } catch (error) { setMessage(error instanceof Error ? error.message : '无法粘贴，请检查内容。') }
  }
  const nextCell = (event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>, rowId: string, column: string) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const cells = [...(table.current?.querySelectorAll<HTMLElement>(`[data-column="${column}"]`) || [])]
    const index = cells.findIndex(cell => cell.dataset.row === rowId)
    cells[index + (event.shiftKey ? -1 : 1)]?.focus()
  }
  const deleteRows = (ids: Set<string>) => {
    if (!ids.size) return
    const stored = saved.filter(row => ids.has(row.id))
    if (stored.length && !window.confirm(`确定删除 ${stored.length} 份已保存草稿吗？不会删除正式商品或成本。`)) return
    if (stored.length) update(current => stored.reduce((next, row) => removeSkuPlanningDraft(next, row.id), current))
    setEdits(current => Object.fromEntries(Object.entries(current).filter(([id]) => !ids.has(id))))
    setSelected(new Set()); setMessage('已移除所选草稿行。')
  }
  const matchCosts = () => {
    const candidates = visible.filter(row => (!selected.size || selected.has(row.id)) && !row.costId && row.name.trim())
    let matched = 0
    const updates = candidates.map(row => { const id = matchDraftCost(data, row.productId, row.name); if (id) matched++; return chooseDraftGridCost(data, row, id) })
    setEdits(current => ({ ...current, ...Object.fromEntries(updates.map(row => [row.id, row])) }))
    setMessage(`匹配成功 ${matched} 行，${candidates.length - matched} 行需选择产品或手选成本；已有成本未覆盖。`)
  }
  const productLabel = (id: string) => { const product = data.products.find(row => row.id === id); return `${data.clients.find(row => row.id === product?.clientId)?.name || '未关联甲方'} · ${product?.name || '产品已移除'}` }
  return <div className="page sku-drafts-page">
    <div className="page-heading"><div><span className="eyebrow">批量定价与投产规划</span><h1>SKU 草稿</h1><p>像表格一样直接填、批量看，毛利和 ROI 随填随算，无需打开弹窗。</p></div><div className="heading-actions"><button className="button secondary" onClick={() => addRows(1)}><Plus size={16} />新增行</button><button className="button primary" disabled={!dirty} onClick={save}><Save size={16} />保存全部{pending.length ? `（${pending.length}）` : ''}</button></div></div>
    <section className="draft-grid-toolbar panel">
      <div className="draft-grid-tools"><label>新增行所属产品<Select aria-label="新增行所属产品" value={productId} onChange={event => { const id = event.target.value; setProductId(id); setEdits(current => Object.fromEntries(Object.entries(current).map(([key, row]) => [key, isBlankDraftGridRow(row) ? { ...row, productId: id } : row]))) }}><option value="">请选择甲方 / 产品</option>{data.products.map(row => <option key={row.id} value={row.id}>{productLabel(row.id)}</option>)}</Select></label><button className="button secondary" onClick={() => addRows(10)}><Plus size={15} />新增 10 行</button><button className="button secondary" onClick={matchCosts}><WandSparkles size={15} />匹配缺失成本</button><button className="button secondary" disabled={!selected.size || !productId} onClick={() => { setEdits(current => ({ ...current, ...Object.fromEntries(visible.filter(row => selected.has(row.id)).map(row => [row.id, row.productId === productId ? row : { ...row, productId, costId: '', cost: null }])) })); setMessage('已更新选中行的产品；变更产品的行请重新匹配成本。') }}>产品应用到选中行</button><button className="button secondary" disabled={!selected.size} onClick={() => deleteRows(selected)}><Trash2 size={15} />删除选中{selected.size ? `（${selected.size}）` : ''}</button><div className="search"><Search size={15} /><Input aria-label="搜索 SKU 草稿" placeholder="搜索 SKU / 产品 / 甲方" value={query} onChange={event => setQuery(event.target.value)} /></div></div>
      <p><Copy size={14} />先选产品，再从 SKU 列粘贴 Excel 多行。列顺序：<b>SKU / 规格 → 成本编码 → A 售价 → A 当前 ROI → B 售价</b>；成本编码可留空自动匹配，也可只粘贴 SKU 单列。单次最多 500 行。</p>
      <p>标 * 为必填；A 当前 ROI、B 售价选填。蓝底列可编辑，灰底列自动计算。Tab 切换输入框，Enter / Shift+Enter 在同列向下 / 向上。</p>
    </section>
    <div className="draft-grid-status" role="status"><span>{saved.length} 行已保存 · {pending.length} 行待保存{invalid.length ? ` · ${invalid.length} 行需补齐` : ''}</span><span>{message || (dirty ? '修改尚未提交，请点“保存全部”。' : syncStatus === 'saving' ? '正在同步云端…' : syncStatus === 'error' ? '云端同步失败，请查看左侧提示。' : '直接点击单元格开始编辑。')}</span>{dirty && <button className="text-button" onClick={() => { if (window.confirm('确定放弃本页全部未保存修改吗？已保存草稿不会删除。')) { setEdits({}); setSelected(new Set()); setMessage('已放弃未保存修改。') } }}>放弃修改</button>}</div>
    <section className="panel table-panel draft-grid-panel"><div className="table-scroll draft-grid-scroll"><table className="draft-grid" ref={table}><thead><tr><th className="draft-select"><input type="checkbox" aria-label="选择全部可见行" checked={visible.length > 0 && visible.every(row => selected.has(row.id))} onChange={event => setSelected(event.target.checked ? new Set(visible.map(row => row.id)) : new Set())} /></th><th className="draft-sku editable">SKU / 规格 *</th><th className="editable">所属产品 *</th><th className="editable">关联成本 SKU *</th><th>成本</th><th className="editable">A 售价 *</th><th>推广前毛利<small>毛利率</small></th><th>A 保本 ROI</th><th className="editable">A 当前 ROI<small>选填</small></th><th>A 推广后利润率</th><th className="editable">B 售价<small>选填</small></th><th>B 目标 ROI<small>至少</small></th><th>行状态 / 操作</th></tr></thead><tbody>{visible.map((row, index) => {
      const result = calculateSkuDraft({ cost: row.cost, priceA: draftGridNumber(row.priceA), roiA: draftGridNumber(row.roiA), priceB: draftGridNumber(row.priceB) })
      const costs = data.productCosts.filter(item => item.productId === row.productId)
      const selectedCost = costs.find(item => item.id === row.costId)
      const error = isBlankDraftGridRow(row) ? '' : draftGridError(data, row)
      const cellProps = (column: string) => ({ 'data-row': row.id, 'data-column': column, onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => nextCell(event, row.id, column) })
      const numeric = (column: 'priceA' | 'roiA' | 'priceB', label: string) => <Input {...cellProps(column)} aria-label={`第${index + 1}行 ${label}`} inputMode="decimal" value={row[column]} placeholder={column === 'priceA' ? '必填' : '选填'} onChange={event => patch({ ...row, [column]: event.target.value })} onPaste={event => paste(event, row, column)} />
      return <tr key={row.id} className={`${edits[row.id] ? 'draft-row-dirty' : ''} ${error ? 'draft-row-invalid' : ''}`}><td className="draft-select"><input type="checkbox" aria-label={`选择第${index + 1}行`} checked={selected.has(row.id)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(row.id); else next.delete(row.id); return next })} /><span>{index + 1}</span></td><td className="draft-sku editable"><Input {...cellProps('name')} aria-label={`第${index + 1}行 SKU`} value={row.name} placeholder="输入 SKU / 规格，可粘贴多行" onChange={event => patch({ ...row, name: event.target.value })} onBlur={() => { if (!row.costId && row.name.trim()) { const id = matchDraftCost(data, row.productId, row.name); if (id) patch(chooseDraftGridCost(data, row, id)) } }} onPaste={event => paste(event, row, 'name')} /></td><td className="editable"><Select {...cellProps('productId')} aria-label={`第${index + 1}行 所属产品`} value={row.productId} onChange={event => patch({ ...row, productId: event.target.value, costId: '', cost: null })}><option value="">请选择产品</option>{data.products.map(item => <option key={item.id} value={item.id}>{productLabel(item.id)}</option>)}</Select></td><td className="editable"><Select {...cellProps('costId')} aria-label={`第${index + 1}行 关联成本`} value={selectedCost ? row.costId : ''} onChange={event => patch(chooseDraftGridCost(data, row, event.target.value))} onPaste={event => paste(event, row, 'costId')}><option value="">请选择成本</option>{costs.map(item => <option key={item.id} value={item.id}>{item.skuCode} · {item.specification} · {money(item.totalCost)}</option>)}</Select></td><td>{money(row.cost)}{selectedCost && selectedCost.totalCost !== row.cost && <button className="text-button draft-cost-update" onClick={() => patch(chooseDraftGridCost(data, row, row.costId))}>更新为 {money(selectedCost.totalCost)}</button>}</td><td className="editable">{numeric('priceA', 'A 售价')}</td><td className={result.grossProfit != null && result.grossProfit < 0 ? 'negative' : ''}>{money(result.grossProfit)}<small>{result.grossMargin == null ? '—' : percent(result.grossMargin)}</small></td><td>{result.breakEvenRoi != null ? roi(roiSetting(result.breakEvenRoi)) : !result.baseValid ? '—' : result.grossProfit === 0 ? '仅零推广费保本' : '售价低于成本'}</td><td className="editable">{numeric('roiA', 'A 当前 ROI')}</td><td className={result.marginA != null && result.marginA < 0 ? 'negative' : ''}>{percent(result.marginA)}{result.marginA != null && result.marginA < 0 && <small>基准亏损，B 仅对齐亏损率</small>}</td><td className="editable">{numeric('priceB', 'B 售价')}</td><td className="draft-target">{target(result, row)}</td><td><span className={error ? 'draft-cell-error' : 'draft-cell-state'}>{error || (isBlankDraftGridRow(row) ? '空白行' : edits[row.id] ? '待保存' : '已保存')}</span><button className="icon-button danger" aria-label={`删除第${index + 1}行`} onClick={() => deleteRows(new Set([row.id]))}><Trash2 size={14} /></button></td></tr>
    })}</tbody></table></div>{!visible.length && <div className="empty"><strong>{query ? '没有匹配的草稿行' : '点击“新增行”开始批量填写'}</strong><span>只需基础定价即可保存，A ROI 与 B 售价可以以后再填。</span></div>}</section>
    <div className="draft-grid-bottom"><button className="text-button" onClick={() => addRows(10)}><Plus size={15} />继续新增 10 行</button><span><Check size={14} />自动计算结果不回写正式商品和结算</span></div>
    <p className="draft-scope-note">毛利＝售价－成本（未扣推广费）；保本 ROI＝售价 ÷ 毛利。A 推广后利润率＝1－成本 ÷ A 售价－1 ÷ A ROI；B 目标按同利润率换算。保本和目标 ROI 均向上取两位小数。未计入成本的费用、退款不推算，投放不保证不抢流量。<Link to="/product-costs">打开成本库</Link></p>
  </div>
}
