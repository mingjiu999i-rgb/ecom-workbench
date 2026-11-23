import { RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useWorkbench } from '../store/workbench'
import { observeOverviewRefunds, overviewDay, overviewRefundDetailClients, summarizeOverviewRefundTotals, summarizePendingRefundFunds } from '../utils/overviewRefundActivity'
import { Modal } from './Overlay'
import './overview-refund.css'

const money = (amount: number | null) => amount == null ? '待核对' : `¥${amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const changeMoney = (amount: number | null) => amount == null ? '待核对' : `${amount > 0 ? '+' : ''}${money(amount)}`
const time = (timestamp: string) => new Date(timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })

// Only overview snapshots change here; all settlement data is preserved.
export function OverviewRefundTracker() {
  const { data, update } = useWorkbench()
  useEffect(() => {
    const observe = () => {
      const now = new Date().toISOString()
      if (observeOverviewRefunds(data, now) !== data) update(current => observeOverviewRefunds(current, now))
    }
    observe()
    // Roll the daily comparison forward even when a tab stays open overnight.
    const timer = window.setInterval(observe, 60000)
    return () => window.clearInterval(timer)
  }, [data, update])
  return null
}

export function OverviewRefundMetric({ storeIds, onViewOrder }: {
  start: string; end: string; storeIds: string[]
  onViewOrder: (storeId: string, orderDate: string) => void
}) {
  const { data } = useWorkbench()
  const [open, setOpen] = useState(false)
  const today = overviewDay(new Date().toISOString())
  const summary = useMemo(() => summarizeOverviewRefundTotals(data, today, new Set(storeIds)), [data, today, storeIds])
  const pending = useMemo(() => summarizePendingRefundFunds(data, new Set(storeIds)), [data, storeIds])
  const detailClients = useMemo(() => overviewRefundDetailClients(summary), [summary])
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open])
  return <>
    <article className="metric overview-refund-metric">
      <div className="metric-icon red"><RotateCcw size={19} /></div>
      <div><span>今日新增已确认已发货退款</span>
        <button className="metric-amount" aria-label="查看今日新增退款店铺明细" onClick={() => setOpen(true)}>
          <strong>{summary.hasData ? money(summary.added) : '暂无记录'}</strong>
          <small>系统累计 {summary.hasData ? money(summary.after) : '暂无记录'}</small>
          <small>{pending.amount > 0 ? `退款资金待核对 ${money(pending.amount)} · 查看店铺明细` : '查看店铺明细'}</small>
        </button>
      </div>
    </article>
    {open && <Modal wide title="今日新增已确认已发货退款 · 店铺明细" onClose={() => setOpen(false)}>
      <div className="modal-body overview-refund-detail">
        <p>{today} · 仅统计所选店铺 · 已保存 {summary.recordedDays} 个成交日的数据</p>
        <div className="overview-refund-equation" aria-label="累计退款前后对比">
          <div><span>导入前累计（今日基准）</span><strong>{money(summary.before)}</strong></div>
          <span aria-hidden="true">→</span>
          <div><span>导入后累计（当前）</span><strong>{money(summary.after)}</strong></div>
          <span aria-hidden="true">=</span>
          <div><span>今日净变化</span><strong>{changeMoney(summary.amount)}</strong></div>
        </div>
        <p>卡片显示今天各原成交日已确认已发货退款的正向变化合计；调减另列。退款先匹配原订单、退款成功的已发货售后记录及资金记录，再按原成交日回填。今天多次导入合并统计，重复导入不重复增加，不受上方订单日期筛选影响。</p>
        {summary.partialDay && <div className="overview-refund-notice">{summary.baselineAt ? `从 ${time(summary.baselineAt)} 建立的基准开始比较；建立基准以前的新增金额未记录，不能倒推。` : '尚未建立导入前基准，暂时无法计算增加金额。'}</div>}
        {summary.unknownBalances > 0 && <div className="overview-refund-notice">部分历史退款金额缺失，导入前后差额暂时待核对，不以零代替。补齐后的累计金额可以展示，但无法推算缺失的历史基准。</div>}
        <div className="table-scroll overview-refund-table">
          <table><thead><tr><th>甲方 / 店铺</th><th title="汇总全部已保存成交日的原成交额，未扣除已发货退款及优惠券退款">累计成交金额</th><th>已保存成交日</th><th>导入前累计</th><th>当前累计</th><th>今日确认新增</th><th>今日调减</th></tr></thead>
            <tbody>{detailClients.map(client => <StoreGroup key={client.clientId} client={client} onView={storeId => { setOpen(false); onViewOrder(storeId, '') }} />)}</tbody>
            {summary.hasData && <tfoot><tr><td>全部所选店铺合计</td><td>{money(summary.originalSales)}</td><td>{summary.recordedDays} 天</td><td>{money(summary.before)}</td><td>{money(summary.after)}</td><td>{money(summary.added)}</td><td>{money(summary.reduced)}</td></tr></tfoot>}
          </table>
        </div>
        {!summary.hasData && <div className="overview-refund-empty">所选店铺暂无已保存的退款汇总。</div>}
        {summary.hasData && detailClients.length === 0 && <div className="overview-refund-empty">今日暂无新增或调减退款。</div>}
        <p>仅显示退款有变化或待核对的店铺。新增和调减按店铺分别合计；金额来自经营结算已保存的结果，尚未成功回填的退款不会被推算进来。</p>
        <h3>当前退款资金待核对：{money(pending.amount)}</h3>
        <p>这是账本中累计尚未完成原订单、售后或历史日期匹配的退款本金，不代表今日新增，也不计入上方已确认金额。已知未发货退款或退款未成功的资金不列入待核对。</p>
        {pending.stores.length > 0 && <div className="table-scroll overview-refund-table"><table><thead><tr><th>店铺</th><th>缺原订单</th><th>缺售后记录</th><th>原日期资料待补齐</th><th>待核对合计</th></tr></thead><tbody>
          {pending.stores.map(store => <tr key={store.storeId}><td>{store.name}</td><td>{money(store.missingOrder)}</td><td>{money(store.missingAfterSale)}</td><td>{money(store.awaitingSource)}</td><td>{money(store.amount)}</td></tr>)}
        </tbody></table></div>}
      </div>
      <div className="modal-actions"><button className="button secondary" onClick={() => setOpen(false)}>关闭</button></div>
    </Modal>}
  </>
}

function StoreGroup({ client, onView }: {
  client: ReturnType<typeof summarizeOverviewRefundTotals>['clients'][number]
  onView: (storeId: string) => void
}) {
  return <>
    <tr className="overview-refund-client"><td>{client.name}</td><td>{money(client.originalSales)}</td><td>{client.recordedDays} 天</td><td>{money(client.before)}</td><td>{money(client.after)}</td><td>{money(client.added)}</td><td>{money(client.reduced)}</td></tr>
    {client.stores.map(store => <tr key={store.storeId}><td><button className="text-button" aria-label={`查看${store.name}经营结算`} onClick={() => onView(store.storeId)}>{store.name}</button></td><td>{money(store.originalSales)}</td><td>{store.recordedDays} 天</td><td>{money(store.before)}</td><td>{money(store.after)}</td><td className={store.added != null && store.added > 0 ? 'negative' : ''}>{money(store.added)}</td><td>{money(store.reduced)}</td></tr>)}
  </>
}
