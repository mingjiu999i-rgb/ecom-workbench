import { AlertTriangle, ArrowRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useWorkbench } from '../store/workbench'
import { findRefundAnomalies, summarizeRefundPeriod } from '../utils/refundReview'
import { buildRefundReviewNarrative } from '../utils/refundReviewNarrative'
import { shiftDate, validDate } from '../utils/performanceSummary'
import './refund-review.css'

const money = (value: number | null) => value == null ? '未记录' : `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const percent = (value: number | null) => value == null ? '无法计算' : `${(value * 100).toFixed(2)}%`
const change = (value: number | null) => value == null ? '无法比较' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)} 个百分点`

export function RefundReview() {
  const { data } = useWorkbench()
  const today = new Date().toLocaleDateString('sv-SE')
  const latestSaved = data.collectionRecords.map(row => row.date).filter(date => validDate(date) && date <= today).sort().at(-1) || shiftDate(today, -1)
  const [start, setStart] = useState(() => shiftDate(latestSaved, -89))
  const [end, setEnd] = useState(latestSaved)
  const [storeId, setStoreId] = useState('')
  const valid = validDate(start) && validDate(end) && start <= end && end <= today
  const selectedStores = data.stores.filter(store => !storeId || store.id === storeId)
  const scope = useMemo(() => selectedStores.map(store => {
    const rows = data.collectionRecords.filter(row => row.storeId === store.id)
    return { store, rows, period: summarizeRefundPeriod(rows, start, end), findings: valid ? findRefundAnomalies(rows, start, end) : [] }
  }), [data.collectionRecords, data.stores, storeId, start, end, valid])
  const findings = scope.flatMap(item => item.findings.map(finding => ({ ...finding, store: item.store })))
    .sort((a, b) => (b.severity === 'high' ? 1 : 0) - (a.severity === 'high' ? 1 : 0) || b.rateChange - a.rateChange)
  const shown = findings.slice(0, 12)
  const missing = scope.filter(item => !item.period.observedDays || item.period.missingRefundBasis || !item.period.completeCoverage)
  const narrative = valid ? buildRefundReviewNarrative(scope.map(item => ({ name: item.store.name, period: item.period, findings: item.findings }))) : []

  return <div className="page refund-review-page">
    <div className="page-heading"><div><span className="eyebrow">经营数据视图</span><h1>退款影响复盘</h1><p>按原订单成交日期比较退款率、订单入账率和净回款比例，定位退款异常升高的时段。</p></div></div>
    <section className="panel refund-review-filter"><label className="field"><span>店铺</span><select value={storeId} onChange={event => setStoreId(event.target.value)}><option value="">全部店铺（逐店判断）</option>{data.stores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label><label className="field"><span>开始日期</span><input type="date" value={start} max={end} onChange={event => setStart(event.target.value)} /></label><label className="field"><span>结束日期</span><input type="date" value={end} max={today} onChange={event => setEnd(event.target.value)} /></label></section>
    {!valid ? <section className="panel refund-review-empty">请选择不晚于今天的有效日期区间。</section> : <>
      <section className="panel refund-review-method"><strong>判断口径</strong><p>每个完整自然周与之前连续 28 天的同店数据比较。退款率＝归属该成交日的已发货退款 ÷ 订单成交额；同时满足上升至少 2 个百分点、相对上升至少 50%，才标为退款异常。订单入账率＝已入账订单数 ÷ 应入账订单数；净回款比例＝订单净回款 ÷ 有效订单销售额，包含资金扣费影响。两项回款指标任一下降至少 5 个百分点，标为重点关注。缺日期或旧退款口径的区间不作异常判断。</p></section>
      <section className="panel"><div className="panel-heading"><div><h2>异常时段</h2><p>{shown.length ? `找到 ${findings.length} 个可核对的店铺周；按影响程度展示` : '当前可比数据中未检出达到阈值的完整周'}</p></div></div>
        {shown.length ? <div className="refund-review-findings">{shown.map(item => <article className="refund-review-finding" key={`${item.store.id}|${item.current.start}`}><div className="refund-review-finding-title"><div><span className={item.severity === 'high' ? 'refund-review-high' : 'refund-review-elevated'}>{item.severity === 'high' ? '重点关注' : '退款升高'}</span><h3>{item.store.name} · {item.current.start} 至 {item.current.end}</h3></div><Link className="text-button" to={`/profit-preview?${new URLSearchParams({ store: item.store.id, start: item.current.start, end: item.current.end })}`}>核对结算 <ArrowRight size={14} /></Link></div><div className="refund-review-numbers"><div><span>已发货退款</span><strong>{money(item.current.shippedRefund)}</strong><small>前 28 天周均 {item.baseline.shippedRefund == null ? '未记录' : money(item.baseline.shippedRefund / 4)}</small></div><div><span>退款率</span><strong>{percent(item.current.refundRate)}</strong><small>基准 {percent(item.baseline.refundRate)} · 上升 {change(item.rateChange)}</small></div><div><span>订单入账率</span><strong>{percent(item.current.paymentCompletion)}</strong><small>较基准 {change(item.paymentChange)}</small></div><div><span>净回款比例</span><strong>{percent(item.current.netReceiptRatio)}</strong><small>较基准 {change(item.netReceiptChange)}</small></div></div><p>本周成交额 {money(item.current.originalSales)}，未回款 {money(item.current.unsettledAmount)}，最新盈亏 {money(item.current.latestProfit)}，当前盈亏 {money(item.current.currentProfit)}。退款上升与回款变化在同一订单成交区间出现，具体原因仍需核对订单及资金明细。</p></article>)}</div> : <div className="refund-review-empty">没有足够完整且同口径的数据时，这里不会把未知日期当成零。</div>}
      </section>
      {missing.length > 0 && <section className="panel refund-review-caveats"><div className="panel-heading"><div><h2><AlertTriangle size={18} /> 数据待核对</h2><p>以下店铺的所选区间存在缺失日期或旧退款口径，可能遗漏异常时段。</p></div></div><ul>{missing.map(item => <li key={item.store.id}>{item.store.name}：{item.period.observedDays ? `保存 ${item.period.observedDays}/${item.period.expectedDays} 天` : '所选区间无已保存结算记录'}{item.period.missingRefundBasis ? '；部分退款缺少同成交日口径' : ''}</li>)}</ul></section>}
      <section className="panel refund-review-narrative"><div><h2>退款文字复盘</h2><p>根据当前筛选范围内已保存的结算汇总自动更新，无需生成或付费。文字用于定位异常，金额和比例以经营结算为准。</p></div><div className="refund-review-output">{narrative.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div></section>
    </>}
  </div>
}
