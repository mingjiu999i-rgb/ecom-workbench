import { ArrowRight, BadgePercent, CircleDollarSign, RotateCcw, TrendingUp } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useWorkbench } from '../store/workbench'
import { buildPerformance, shiftDate, summarizePerformance, validDate, type PerformanceSummary } from '../utils/performanceSummary'
import { Modal } from './Overlay'

const money = (value: number | null) => value == null ? '—' : `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const percent = (value: number | null) => value == null ? '—' : `${(value * 100).toFixed(2)}%`
const scrollKey = 'workbench-overview-scroll'
type Dialog = { kind: 'profit' | 'issues' | 'refund'; label: string; storeIds: string[] }

export function StorePerformance() {
  const { data } = useWorkbench()
  const navigate = useNavigate(), location = useLocation()
  const [params, setParams] = useSearchParams()
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const today = new Date().toLocaleDateString('sv-SE'), yesterday = shiftDate(today, -1)
  const period = ['yesterday', 'custom'].includes(params.get('period') || '') ? params.get('period')! : 'month'
  const storeId = data.stores.some(store => store.id === params.get('store')) ? params.get('store')! : ''
  const customStart = params.has('start') ? params.get('start')! : `${today.slice(0, 7)}-01`
  const customEnd = params.has('end') ? params.get('end')! : today
  const startDate = period === 'month' ? `${today.slice(0, 7)}-01` : period === 'yesterday' ? yesterday : customStart
  const endDate = period === 'custom' ? customEnd : period === 'yesterday' ? yesterday : today
  const validRange = validDate(startDate) && validDate(endDate) && startDate <= endDate
  const selectedStore = data.stores.find(store => store.id === storeId)
  const rangeLabel = startDate === endDate ? startDate : `${startDate} 至 ${endDate}`
  const performance = useMemo(() => buildPerformance(data, validRange ? startDate : today, validRange ? endDate : today, storeId, yesterday), [data, startDate, endDate, storeId, yesterday, today, validRange])
  const allIds = performance.stores.map(store => store.id)
  const dialogSummary = dialog ? summarizePerformance(data, startDate, endDate, new Set(dialog.storeIds)) : null
  const changeFilter = (changes: Record<string, string>) => setParams(current => { const next = new URLSearchParams(current); Object.entries(changes).forEach(([key, val]) => val ? next.set(key, val) : next.delete(key)); return next }, { replace: true })
  const changeDate = (key: string, val: string) => setParams(current => { const next = new URLSearchParams(current); next.set(key, val); return next }, { replace: true })
  useEffect(() => {
    let frame = 0
    try {
      const saved = JSON.parse(sessionStorage.getItem(scrollKey) || 'null') as { path: string; top: number } | null
      if (saved?.path === `${location.pathname}${location.search}` && Number.isFinite(saved.top)) {
        frame = window.requestAnimationFrame(() => {
          window.scrollTo({ top: saved.top, behavior: 'instant' })
          try { sessionStorage.removeItem(scrollKey) } catch { /* Optional browser storage. */ }
        })
      }
    } catch { /* Filters still restore through the URL when browser storage is unavailable. */ }
    return () => window.cancelAnimationFrame(frame)
  }, [location.pathname, location.search])
  useEffect(() => {
    if (!dialog) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setDialog(null) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [dialog])
  const detail = (targetStoreId: string, start = startDate, end = endDate, focus = '') => {
    const returnTo = `${location.pathname}${location.search}`
    try { sessionStorage.setItem(scrollKey, JSON.stringify({ path: returnTo, top: window.scrollY })) } catch { /* Optional scroll restoration. */ }
    setDialog(null)
    navigate(`/profit-preview?${new URLSearchParams({ store: targetStoreId, start, end, detail: 'saved', returnTo, ...(focus ? { focus } : {}) })}`)
  }
  const show = (kind: Dialog['kind'], label: string, ids = allIds) => setDialog({ kind, label, storeIds: ids })
  const status = (summary: PerformanceSummary, label: string, ids: string[]) => summary.hasData
    ? <button className={`performance-status ${summary.partial ? 'partial' : 'complete'}`} onClick={() => show('issues', label, ids)}>{summary.partial ? `部分汇总 · ${summary.affectedDays} 个店铺日待处理` : '已保存数据完整'}</button>
    : <span className="cell-sub">暂无数据</span>
  const profitButton = (summary: PerformanceSummary, label: string, ids: string[]) => <button className={`amount-button ${summary.profit != null && summary.profit < 0 ? 'negative' : 'positive'}`} aria-label={`查看${label}盈利构成`} disabled={!summary.hasData} onClick={() => show('profit', label, ids)}>{money(summary.profit)}</button>
  const metrics = [['销售额', performance.total.sales, CircleDollarSign, 'blue'], ['运营费用', performance.total.operationFee, BadgePercent, 'violet'], ['甲方盈利', performance.total.profit, TrendingUp, 'green'], ['已发货退款', performance.total.shippedRefund, RotateCcw, 'red']] as const
  const refundMax = Math.max(1, ...performance.trend.map(row => row.amount || 0))
  const previousRefund = performance.previous?.shippedRefund
  const comparison = previousRefund == null ? '上期暂无数据' : previousRefund === 0 ? '上期退款为零' : `较前一等长周期${(performance.total.shippedRefund || 0) >= previousRefund ? '增加' : '减少'} ${percent(Math.abs((performance.total.shippedRefund || 0) - previousRefund) / previousRefund)}`
  const overdueStores = performance.stores.filter(store => store.missingYesterday)
  return <section className="panel performance-panel" aria-label="店铺业绩总览">
    <div className="panel-heading performance-heading"><div><h2>{selectedStore ? `${selectedStore.name}业绩` : '全部店铺业绩'}</h2><p>汇总经营结算中已经保存的数据</p></div><div className="performance-controls">
      <select aria-label="筛选店铺" value={storeId} onChange={event => changeFilter({ store: event.target.value })}><option value="">全部店铺</option>{data.stores.map(store => <option key={store.id} value={store.id}>{data.clients.find(client => client.id === store.clientId)?.name} · {store.name}{store.storeStatus === '暂停' ? '（暂停）' : ''}</option>)}</select>
      <div className="performance-period" role="group" aria-label="业绩日期范围">{([['yesterday', '昨天'], ['month', '本月'], ['custom', '自定义']] as const).map(([val, label]) => <button key={val} aria-pressed={period === val} className={period === val ? 'active' : ''} onClick={() => changeFilter({ period: val })}>{label}</button>)}</div>
    </div></div>
    {period === 'custom' && <div className="performance-dates"><label>开始日期<input type="date" aria-label="业绩开始日期" value={customStart} max={customEnd || undefined} onChange={event => changeDate('start', event.target.value)} /></label><span>至</span><label>结束日期<input type="date" aria-label="业绩结束日期" value={customEnd} min={customStart || undefined} onChange={event => changeDate('end', event.target.value)} /></label></div>}
    {!validRange ? <div className="performance-note negative" role="alert">请选择完整日期范围，且开始日期不能晚于结束日期。</div> : <>
      <div className="performance-metrics">{metrics.map(([label, amount, Icon, tone]) => <article className="metric" key={label}><div className={`metric-icon ${tone}`}><Icon size={19} /></div><div><span>{label}</span>{label === '甲方盈利' ? <button className="metric-amount" aria-label="查看全部店铺盈利构成" disabled={!performance.total.hasData} onClick={() => show('profit', selectedStore?.name || '全部店铺')}><strong>{money(amount)}</strong><small>查看构成</small></button> : label === '已发货退款' ? <button className="metric-amount" aria-label="查看退款口径与来源" disabled={amount == null} onClick={() => show('refund', selectedStore?.name || '全部店铺')}><strong>{money(amount)}</strong><small>查看来源</small></button> : <strong>{money(amount)}</strong>}</div></article>)}</div>
      <div className="performance-summary-status">{status(performance.total, selectedStore?.name || '全部店铺', allIds)}{overdueStores.length > 0 && <span>{overdueStores.length} 家启用店铺昨天暂无回款记录，可在店铺明细核对。</span>}</div>
      <p className="performance-note">已发货退款按退款完成日期统计，包含历史订单退款。{performance.total.legacyRefund && '部分数据仍为旧版退款口径，请在经营结算重新导入报表。'}{performance.total.partial && '销售额、运营费用和盈利按已保存的产品数据汇总；金额可能不完整，可点击“部分汇总”查看待处理日期。'}</p>
      {!performance.total.recordCount ? <div className="performance-empty">{rangeLabel} 暂无已保存的经营数据，请到经营结算导入报表。<button className="text-button" onClick={() => detail(selectedStore?.id || allIds[0] || '')}>前往经营结算 <ArrowRight size={14} /></button></div> : <>
        <div className="refund-overview"><div><strong>同期订单已发货退款率 <b>{percent(performance.total.refundRate)}</b></strong><span>同期订单已发货退款 ÷ 同期订单成交额</span></div><button className="text-button" onClick={() => show('refund', selectedStore?.name || '全部店铺')}>本期退款来源 <ArrowRight size={14} /></button></div>
        <div className="refund-trend"><div className="refund-trend-heading"><strong>退款金额趋势</strong><span title={`${performance.previousStart} 至 ${performance.previousEnd}`}>{comparison}</span></div><p>{performance.monthly ? '按月汇总，暂无记录的月份不展示。' : '按退款完成日期汇总，灰色表示当天尚无保存记录。'}点击日期可查看对应时段总览。</p><div className="refund-bars" role="group" aria-label="退款金额趋势">{performance.trend.map(row => <button key={row.date} title={`${row.date}：${money(row.amount)}${row.amount == null ? '（暂无保存记录）' : ''}`} aria-label={`${row.date}退款${row.amount == null ? '暂无记录' : money(row.amount)}`} onClick={() => changeFilter({ period: 'custom', start: row.start, end: row.end })}><span className="refund-bar-track"><i className={row.amount == null ? 'no-data' : ''} style={{ height: `${row.amount == null ? 4 : Math.max(3, (row.amount / refundMax) * 100)}%` }} /></span><span>{performance.monthly ? row.date : row.date.slice(5)}</span></button>)}</div></div>
        <div className="table-caption"><div><strong>各甲方汇总</strong><span>{rangeLabel}</span></div><span>{performance.total.recordCount} 条店铺日经营记录</span></div>
        <div className="table-scroll"><table><thead><tr><th>甲方</th><th>销售额</th><th>运营费用</th><th>甲方盈利</th><th>已发货退款</th><th>同期订单退款率</th><th>数据完整性</th></tr></thead><tbody>{performance.clients.map(client => { const ids = performance.stores.filter(store => store.clientId === client.id).map(store => store.id); return <tr key={client.id}><td className="cell-main">{client.name}</td><td>{money(client.sales)}</td><td className="performance-fee">{money(client.operationFee)}</td><td>{profitButton(client, client.name, ids)}</td><td className="negative">{money(client.shippedRefund)}</td><td>{percent(client.refundRate)}</td><td>{status(client, client.name, ids)}</td></tr> })}</tbody></table></div>
      </>}
      <div className="table-caption"><div><strong>店铺明细</strong><span>查看更新时间、处理缺失数据或进入经营结算</span></div></div>
      <div className="table-scroll performance-store-table"><table><thead><tr><th>店铺</th><th>销售额</th><th>运营费用</th><th>甲方盈利</th><th>已发货退款</th><th>同期订单退款率</th><th>数据完整性</th><th>数据更新时间</th><th>操作</th></tr></thead><tbody>{performance.stores.map(store => <tr key={store.id}><td><strong className="cell-main">{store.name}</strong><div className="cell-sub">{data.clients.find(client => client.id === store.clientId)?.name}{store.storeStatus === '暂停' ? ' · 暂停' : ''}</div></td><td>{money(store.sales)}</td><td className="performance-fee">{money(store.operationFee)}</td><td>{profitButton(store, store.name, [store.id])}</td><td className="negative">{money(store.shippedRefund)}</td><td>{percent(store.refundRate)}</td><td>{status(store, store.name, [store.id])}</td><td className="performance-freshness"><span>回款记录截至 {store.collectionThrough || '暂无记录'}</span><span>产品利润截至 {store.profitThrough || '暂无记录'}</span>{store.updatedAt && <span>更新于 {new Date(store.updatedAt).toLocaleString('zh-CN', { hour12: false })}</span>}{store.missingYesterday && <button className="text-button freshness-warning" onClick={() => detail(store.id, yesterday, yesterday)}>昨天暂无回款记录 · 去核对</button>}</td><td><button className="text-button" aria-label={`查看${store.name}经营结算详情`} onClick={() => detail(store.id)}>详情 <ArrowRight size={14} /></button></td></tr>)}</tbody></table></div>
    </>}
    {dialog && dialogSummary && <Modal wide title={`${dialog.label} · ${dialog.kind === 'profit' ? '盈利构成' : dialog.kind === 'issues' ? '数据完整性' : '退款口径与来源'}`} onClose={() => setDialog(null)}>
      <div className="modal-body performance-dialog"><p>{rangeLabel}</p>
        {dialog.kind === 'profit' && <><p>甲方盈利为已保存产品数据的预估利润。销售额已扣除对应订单退款，退款金额不会在这里重复扣除。</p><dl className="profit-breakdown">{[['有效销售额', dialogSummary.sales], ['减：商品成本', dialogSummary.cost], ['减：推广费', dialogSummary.promotion], ['减：运营费用', dialogSummary.operationFee], ...(dialogSummary.difference ? [['历史记录及汇总差额', dialogSummary.difference]] : []), ['甲方预估盈利', dialogSummary.profit]].map(([label, amount]) => <div key={String(label)}><dt>{label}</dt><dd>{money(amount as number | null)}</dd></div>)}</dl><p>计算：有效销售额 − 商品成本 − 推广费 − 运营费用。经营结算的“当前盈亏”依据已回款金额计算，账期及费用口径不同。</p><div className="profit-payment"><span>订单净回款 <b>{money(dialogSummary.currentNet)}</b></span><span>未回款金额 <b>{money(dialogSummary.unsettledAmount)}</b></span></div>{dialogSummary.partial && <button className="performance-status partial" onClick={() => setDialog({ ...dialog, kind: 'issues' })}>部分汇总 · 查看 {dialogSummary.affectedDays} 个店铺日待处理数据</button>}</>}
        {dialog.kind === 'refund' && <><dl className="profit-breakdown"><div><dt>本期完成已发货退款</dt><dd>{money(dialogSummary.shippedRefund)}</dd></div><div><dt>其中：本期订单退款</dt><dd>{money(dialogSummary.refundSources.current)}</dd></div><div><dt>其中：历史订单退款</dt><dd>{money(dialogSummary.refundSources.historical)}</dd></div><div><dt>其中：来源待核对</dt><dd>{money(dialogSummary.refundSources.unknown)}</dd></div><div><dt>同期订单已发货退款率</dt><dd>{percent(dialogSummary.refundRate)}</dd></div></dl><p>来源拆分按订单成交日期归属；旧报表或未匹配到订单的退款列为“来源待核对”，重新导入订单与退款报表后可补充。</p><p>退款率使用所选期间成交订单的已发货退款 {money(dialogSummary.orderRefund)} ÷ 同期订单成交额 {money(dialogSummary.originalSales)}，与“本期完成退款”分属不同统计口径。成交额为零或缺少同口径数据时不计算退款率。</p>{dialogSummary.legacyRefund && <p className="freshness-warning">部分记录使用旧版退款口径，趋势和来源需要重新导入后核对。</p>}</>}
        {dialog.kind === 'issues' && <>{!dialogSummary.partial ? <p>所选时段已有产品利润与每日回款记录一致。未保存的日期可在店铺明细查看更新情况。</p> : <><p>以下日期需要补成本、重新导入或核对利润。已有金额继续展示，待处理数据不会被当作完整经营结果。</p><div className="performance-issue-list">{dialogSummary.issues.sort((a, b) => b.date.localeCompare(a.date) || a.storeId.localeCompare(b.storeId)).map(issue => <div key={`${issue.storeId}|${issue.date}|${issue.kind}`}><div><strong>{data.stores.find(store => store.id === issue.storeId)?.name || '店铺'} · {issue.date}</strong><span>{issue.message}</span></div><button className="text-button" aria-label={`处理${issue.storeId} ${issue.date} ${issue.kind}`} onClick={() => detail(issue.storeId, issue.date, issue.date, issue.kind === 'cost' ? 'costs' : 'import')}>去处理 <ArrowRight size={14} /></button></div>)}</div></>}</>}
      </div><div className="modal-actions"><button className="button secondary" onClick={() => setDialog(null)}>关闭</button>{dialog.storeIds.length === 1 && <button className="button primary" onClick={() => detail(dialog.storeIds[0])}>查看经营结算</button>}</div>
    </Modal>}
  </section>
}
