import { Save, Table2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { useWorkbench } from '../store/workbench'
import { getLinkPromotions, linkKey, linkNumber, putLinkPromotions, summarizeLinkSales, type LinkSalesMetric } from '../utils/linkSales'
import './link-profit.css'

const money = (value: number | null) => value == null ? '待核对' : `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const percent = (value: number | null) => value == null ? '—' : `${(value * 100).toFixed(2)}%`

export function LinkProfit() {
  const { data, update } = useWorkbench()
  const [clientId, setClientId] = useState('')
  const [storeId, setStoreId] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [query, setQuery] = useState('')
  const [daily, setDaily] = useState(false)
  const [edits, setEdits] = useState<Record<string, { storeId: string; goodsId: string; date: string; value: string }>>({})
  const [message, setMessage] = useState('')
  const table = useRef<HTMLTableElement>(null)
  const dirty = Object.keys(edits).length > 0
  useEffect(() => {
    if (!dirty) return
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    const navigate = (event: MouseEvent) => {
      const anchor = (event.target as Element)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (anchor && anchor.origin === location.origin && anchor.pathname !== location.pathname && anchor.target !== '_blank' && !window.confirm('推广费尚未保存，确定离开吗？')) { event.preventDefault(); event.stopPropagation() }
    }
    window.addEventListener('beforeunload', unload); document.addEventListener('click', navigate, true)
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', navigate, true) }
  }, [dirty])
  const invalid = Object.values(edits).filter(row => row.value.trim() && (linkNumber(row.value) == null || !/^\d+(?:\.\d{1,2})?$/.test(row.value.trim())))
  // Preview unsaved edits in this page only; they never change settlement data.
  const preview = useMemo(() => invalid.length ? data : putLinkPromotions(data, Object.values(edits).map(row => ({ ...row, amount: row.value.trim() ? linkNumber(row.value) : null }))), [data, edits, invalid.length])
  const report = useMemo(() => summarizeLinkSales(preview, { clientId, storeId, start, end, query }), [preview, clientId, storeId, start, end, query])
  const rows = daily ? report.daily : report.summary
  const datesInvalid = Boolean(start && end && start > end)
  const stores = data.stores.filter(store => !clientId || store.clientId === clientId)
  const storeName = (id: string) => data.stores.find(store => store.id === id)?.name || '已移除店铺'
  const clientName = (id: string) => data.clients.find(client => client.id === data.stores.find(store => store.id === id)?.clientId)?.name || '未关联甲方'
  const promotionValue = (row: LinkSalesMetric) => edits[row.key]?.value ?? String(getLinkPromotions(data).find(item => linkKey(item.storeId, item.goodsId, item.date) === row.key)?.amount ?? '')
  const change = (row: LinkSalesMetric, value: string) => {
    const original = String(getLinkPromotions(data).find(item => linkKey(item.storeId, item.goodsId, item.date) === row.key)?.amount ?? '')
    setEdits(current => { const next = { ...current }; if (value === original) delete next[row.key]; else next[row.key] = { storeId: row.storeId, goodsId: row.goodsId, date: row.date, value }; return next })
    setMessage('')
  }
  const save = () => {
    if (invalid.length) { setMessage('推广费必须是非负数字，最多两位小数；不投放请明确填 0。'); return }
    try {
      const pending = Object.values(edits).map(row => ({ storeId: row.storeId, goodsId: row.goodsId, date: row.date, amount: row.value.trim() ? linkNumber(row.value) : null }))
      update(current => putLinkPromotions(current, pending)); setEdits({}); setMessage(`已提交 ${pending.length} 条推广费，请查看左侧云端同步状态。`)
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败，输入仍保留。') }
  }
  const nextCell = (event: KeyboardEvent<HTMLInputElement>, key: string) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const cells = [...(table.current?.querySelectorAll<HTMLInputElement>('input[data-promotion]') || [])]
    const index = cells.findIndex(cell => cell.dataset.promotion === key)
    cells[index + (event.shiftKey ? -1 : 1)]?.focus()
  }
  return <div className="page link-profit-page">
    <div className="page-heading"><div><span className="eyebrow">LINK PERFORMANCE</span><h1>商品 ID 盈亏</h1><p>每天正常导入订单后自动更新。按链接看销售，按天填写推广费。</p></div><div className="heading-actions"><Link className="button secondary" to="/profit-preview">去导入报表</Link><button className="button primary" disabled={!dirty} onClick={save}><Save size={16} />保存推广费{dirty ? `（${Object.keys(edits).length}）` : ''}</button></div></div>
    <section className="panel link-profit-explanation"><strong>利润＝销售额－对应成本－手填推广费</strong><span>不统计、不扣退款；也不扣平台费用或代运营费，不等同于经营结算净利润。销售额取订单报表「商家实收金额(元)」，成本只读原订单成本快照。</span><span>仅统计已导入且可识别的已付款订单；取消、待付款订单不计入。已付款的退款订单不因退款扣减。未填推广费或缺成本时不计算利润；明确无投放请填 0。</span></section>
    <section className="panel link-profit-filters"><label className="field"><span>甲方</span><select value={clientId} onChange={event => { setClientId(event.target.value); setStoreId('') }}><option value="">全部甲方</option>{data.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label><label className="field"><span>店铺</span><select value={storeId} onChange={event => setStoreId(event.target.value)}><option value="">全部店铺</option>{stores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label><label className="field"><span>开始日期</span><input type="date" value={start} onChange={event => setStart(event.target.value)} /></label><label className="field"><span>结束日期</span><input type="date" value={end} onChange={event => setEnd(event.target.value)} /></label><label className="field"><span>商品 ID / 商品名</span><input value={query} placeholder="搜索链接" onChange={event => setQuery(event.target.value)} /></label></section>
    {datesInvalid && <div className="link-profit-notice" role="alert">开始日期不能晚于结束日期。</div>}
    {(report.unindexed > 0 || report.pending.length > 0) && <div className="link-profit-notice"><strong>有数据尚不能归入链接分析</strong>{report.unindexed > 0 && <span>当前店铺及日期范围内有 {report.unindexed} 条历史订单没有商品 ID 索引。补导对应原订单报表后才能归入；不会从内部产品 ID 猜测链接。</span>}{report.pending.length > 0 && <span>{report.pending.length} 条记录缺日期、商品 ID、有效订单状态，或同一订单出现冲突 ID，暂不计入下表。缺日期的记录也会在筛选期间提示，不会推算日期。</span>}<span>下表仅代表可识别的已导入数据，不代表完整店铺销售。</span></div>}
    {message && <div className="link-profit-notice" role="status">{message}</div>}
    <section className="panel table-panel"><div className="link-profit-tablebar"><div className="link-profit-tabs"><button className={!daily ? 'active' : ''} onClick={() => setDaily(false)}>按商品 ID 汇总</button><button className={daily ? 'active' : ''} onClick={() => setDaily(true)}>按天填写推广费</button></div><span>{daily ? '蓝底可编辑；Enter 换到下一行，填写后保存。' : '期间推广费合计；任一天未填，期间利润即显示待完善。'}{dirty && ' 当前含未保存预览。'}</span></div>
      {!datesInvalid && rows.length > 0 ? <div className="table-scroll"><table ref={table} className={`link-profit-table${daily ? ' is-daily' : ''}`}><thead><tr><th>店铺</th><th>商品 ID / 商品</th>{daily && <th>订单日期</th>}<th>销量</th><th>销售额</th><th>成本</th><th>推广费{daily ? ' · 手填' : ''}</th><th>利润 · 不扣退款</th><th>利润率</th></tr></thead><tbody>{rows.map(row => <tr key={row.key}><td><strong>{storeName(row.storeId)}</strong><small>{clientName(row.storeId)}</small></td><td><strong className="link-profit-id">{row.goodsId}</strong><small className="link-profit-name" title={row.name}>{row.name || '未填写商品名'}</small></td>{daily && <td>{row.date}</td>}<td>{row.quantity ?? '待核对'}<small>{row.orders} 笔订单{!daily && ` · ${row.days} 天`}</small></td><td>{money(row.sales)}</td><td>{money(row.cost)}{row.missingCost > 0 && <small className="link-profit-warning">{row.missingCost} 笔缺成本快照</small>}</td><td>{daily ? <input className="link-promotion-input" aria-label={`${storeName(row.storeId)} ${row.goodsId} ${row.date} 推广费`} data-promotion={row.key} inputMode="decimal" placeholder="待填写" value={promotionValue(row)} onChange={event => change(row, event.target.value)} onKeyDown={event => nextCell(event, row.key)} /> : row.promotion == null ? <button className="link-profit-fill" onClick={() => setDaily(true)}>待填 {row.missingPromotion} 天</button> : money(row.promotion)}</td><td className={row.profit == null ? '' : row.profit < 0 ? 'negative' : 'positive'}>{row.profit == null ? '待完善' : money(row.profit)}</td><td>{percent(row.margin)}</td></tr>)}</tbody></table></div> : <div className="link-profit-empty"><Table2 size={30} /><strong>{datesInvalid ? '请调整日期范围' : '暂无可显示的商品 ID 销售记录'}</strong><span>到经营结算选择店铺，正常导入带商品 ID 的订单报表，即可自动建立独立分析；老数据需要补导原订单报表。</span></div>}
    </section>
  </div>
}
