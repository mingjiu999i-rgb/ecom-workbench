import { RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useWorkbench } from '../store/workbench'
import { getOverviewRefundActivity, observeOverviewRefunds, summarizeOverviewRefunds } from '../utils/overviewRefundActivity'
import { Modal } from './Overlay'
import './overview-refund.css'

const money = (amount: number | null) => amount == null ? '未记录' : `¥${amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const time = (timestamp: string) => new Date(timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })

// Mounted beside the overview's host layout so imports are observed while the settlement page is open.
// This observer writes only overviewRefundActivity; every settlement field is preserved by reference.
export function OverviewRefundTracker() {
  const { data, update } = useWorkbench()
  useEffect(() => {
    const now = new Date().toISOString()
    if (observeOverviewRefunds(data, now) !== data) update(current => observeOverviewRefunds(current, now))
  }, [data, update])
  return null
}

export function OverviewRefundMetric({ start, end, storeIds, onViewOrder }: {
  start: string; end: string; storeIds: string[]
  onViewOrder: (storeId: string, orderDate: string) => void
}) {
  const { data } = useWorkbench()
  const [open, setOpen] = useState(false)
  const [orderDate, setOrderDate] = useState('')
  const summary = useMemo(() => summarizeOverviewRefunds(data, start, end, new Set(storeIds)), [data, start, end, storeIds])
  const rows = summary.changes.filter(row => !orderDate || row.orderDate === orderDate)
  const state = getOverviewRefundActivity(data)
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open])
  return <>
    <article className="metric overview-refund-metric">
      <div className="metric-icon red"><RotateCcw size={19} /></div>
      <div><span>新增已发货退款</span><button className="metric-amount" aria-label="查看新增退款明细" onClick={() => { setOrderDate(''); setOpen(true) }}>
        <strong>{money(summary.amount)}</strong><small>{summary.partial ? '部分时段 · ' : ''}按导入日期 · 查看明细</small>
      </button></div>
    </article>
    {open && <Modal wide title="新增退款 · 按导入日期" onClose={() => setOpen(false)}>
      <div className="modal-body overview-refund-detail">
        <p>{start === end ? start : `${start} 至 ${end}`} · 仅统计所选店铺</p>
        <dl className="profit-breakdown"><div><dt>本期退款净增</dt><dd>{money(summary.amount)}</dd></div><div><dt>新增退款</dt><dd>{money(summary.added)}</dd></div><div><dt>退款调减</dt><dd>{money(summary.reduced)}</dd></div></dl>
        <p>按导入后发现变化的日期记录。例如 10 月 13 日导入后，9 月 30 日订单的累计退款从 100 元变为 130 元，10 月 13 日新增记 30 元。重复导入金额不变时不计数；调减按负数记录。</p>
        <p>此卡片按导入日期统计；下方退款率、趋势和店铺表格按原订单日期统计，两种金额不能直接对比。</p>
        <div className="overview-refund-notice">
          {summary.initializedAt ? <>开始记录于 {time(summary.initializedAt)}。首次读取只建立基准，更新前的历史新增无法倒推。{summary.partial && '所选时段包含开始记录前的日期，金额只包含已记录部分。'}</> : '正在建立总览基准，尚无新增记录。'}
          {summary.amount == null && '所选日期尚未开始记录，暂无可核对的新增金额。'}
          {summary.unknownBalances > 0 && `另有 ${summary.unknownBalances} 条历史记录缺少可核对的累计退款金额，首次补齐时只建立基准。`}
        </div>
        <label className="overview-refund-filter"><span>追溯原订单日期</span><input type="date" aria-label="筛选新增退款的原订单日期" value={orderDate} onChange={event => setOrderDate(event.target.value)} /><button className="text-button" onClick={() => setOrderDate('')}>全部日期</button></label>
        <div className="table-scroll overview-refund-table"><table><thead><tr><th>发现时间</th><th>店铺</th><th>原订单日期</th><th>导入前累计</th><th>导入后累计</th><th>本次变化</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td>{time(row.observedAt)}</td><td>{data.stores.find(store => store.id === row.storeId)?.name || '历史店铺'}</td><td><button className="text-button" aria-label={`查看${row.storeId} ${row.orderDate}原订单结算`} onClick={() => { setOpen(false); onViewOrder(row.storeId, row.orderDate) }}>{row.orderDate}</button></td><td>{money(row.before)}</td><td>{money(row.after)}</td><td className={row.amount < 0 ? 'positive' : 'negative'}>{row.amount > 0 ? '+' : ''}{money(row.amount)}</td></tr>)}</tbody></table></div>
        {!rows.length && <div className="overview-refund-empty">{!state || summary.amount == null ? '这个时段尚未记录新增退款。' : orderDate ? '该原订单日期没有本期新增记录。' : '所选时段内尚未记录到退款金额变化。'}</div>}
      </div>
      <div className="modal-actions"><button className="button secondary" onClick={() => setOpen(false)}>关闭</button></div>
    </Modal>}
  </>
}
