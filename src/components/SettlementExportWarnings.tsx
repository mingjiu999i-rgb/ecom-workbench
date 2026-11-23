import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import type { WorkbenchData } from '../types/models'
import type { SettlementExportOptions } from '../utils/settlementWorkbook'
import { settlementDiagnostics, type SettlementDayDiagnostic } from '../utils/settlementDiagnostics'
import './settlement-diagnostics.css'

type Props = { data: WorkbenchData; options: SettlementExportOptions; warnings: string[]; syncStatus?: 'saved' | 'saving' | 'error'; onInspect: () => void }
const money = (value: number | null) => value == null ? '未记录' : `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const difference = (value: number | null) => value == null ? '无法比较' : `${value > 0 ? '+' : ''}${money(value)}`
const shortReason = (day: SettlementDayDiagnostic) => day.missingProducts ? '缺少产品明细'
  : day.mismatch ? day.metrics.filter(metric => metric.flagged).map(metric => `${metric.label}：产品明细${metric.difference == null ? '金额待核对' : `${metric.difference < 0 ? '少' : '多'} ${money(Math.abs(metric.difference))}`}`).join('；')
    : '退款归属口径未确认'
const dateTime = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未记录'

export function SettlementExportWarnings({ data, options, warnings, syncStatus, onInspect }: Props) {
  const days = useMemo(() => settlementDiagnostics(data, options), [data, options])
  const groups = [...new Set(days.map(day => day.storeId))].map(id => ({ id, name: days.find(day => day.storeId === id)!.storeName, days: days.filter(day => day.storeId === id) }))
  const otherWarnings = warnings.filter(warning => !warning.endsWith('天的产品利润数据尚未同步') && !warning.includes('天的退款口径未确认'))
  const client = data.clients.find(row => row.id === options.clientId)
  return <div className="modal-body settlement-diagnostics">
    <p className="diagnostics-intro">这里核对的是已保存的回款汇总与产品明细金额，不是网络同步失败。请按下面的具体日期和差额核对，再决定是否继续导出。</p>
    <p className="diagnostics-scope">核对范围：{client?.name || '所选甲方'} · {options.startDate || options.endDate ? `${options.startDate || '最早已保存日期'} 至 ${options.endDate || '最新已保存日期'}` : '全部已保存日期'} · 包含该甲方所有启用店铺。</p>
    {syncStatus && <p className="diagnostics-scope">当前保存状态：{syncStatus === 'saving' ? '保存中，请在保存完成后重新核对' : syncStatus === 'error' ? '保存失败，请先处理页面顶部的同步提示' : '云端已同步'}。下方金额取自当前页面已保存的计算结果。</p>}
    {groups.length === 0 && otherWarnings.length === 0 && <p role="status" className="diagnostics-resolved">重新核对后，当前已保存数据没有上述差异。数据可能已完成更新，请返回后再次点击导出。</p>}
    {groups.map((group, groupIndex) => <section className="diagnostics-store" key={group.id}>
      <h3>{group.name} · {new Set(group.days.map(day => day.date)).size} 个日期需核对</h3>
      {group.days.map((day, dayIndex) => <details key={day.id} open={groupIndex === 0 && dayIndex === 0} className="diagnostics-day">
        <summary><strong>{day.date}</strong><span>{shortReason(day)}{day.unassignedOrders.some(order => order.supplement) ? ' · 补差价产品归属待核对' : ''}</span></summary>
        <div className="diagnostics-day-body">
          {day.mismatch && <>
            <p>{day.missingProducts ? `该日回款汇总已经保存，产品利润明细为 ${day.productRows} 条；缺少明细不等于金额为零。` : `该日有 ${day.productRows} 条产品利润明细，下面只比较现有金额。`}</p>
            <div className="table-scroll"><table><thead><tr><th>核对项目</th><th>回款汇总</th><th>产品明细合计</th><th>差额</th></tr></thead><tbody>{day.metrics.map(metric => <tr key={metric.key} className={metric.flagged ? 'diagnostics-different' : ''}><td>{metric.label}</td><td>{money(metric.daily)}</td><td>{money(metric.products)}</td><td>{difference(metric.difference)}</td></tr>)}</tbody></table></div>
            <p className="diagnostics-caption">差额＝产品明细合计－回款汇总。此处只列出核对结果，不修改任何金额。</p>
          </>}
          {day.supplementMatchesSalesGap && <p className="diagnostics-cause">发现 {day.unassignedOrders.length} 笔补差价订单尚未归属可用产品，原订单金额合计 {money(day.unassignedOriginalAmount)}，与产品销售额少计的金额一致。请先核对这些订单的产品归属。</p>}
          {!day.supplementMatchesSalesGap && day.unassignedOrders.length > 0 && <p className="diagnostics-cause">发现 {day.unassignedOrders.length} 笔订单尚未归属可用产品，原订单金额合计 {money(day.unassignedOriginalAmount)}。这是需要核对的具体线索；现有记录不足以认定它们解释了全部差额。</p>}
          {day.unassignedOrders.length > 0 && <details className="diagnostics-orders"><summary>查看 {day.unassignedOrders.length} 笔产品归属待核对订单</summary><div className="table-scroll"><table><thead><tr><th>订单号</th><th>商品 ID</th><th>订单原金额</th><th>问题</th></tr></thead><tbody>{day.unassignedOrders.map(order => <tr key={order.id}><td>{order.id}</td><td>{order.goodsId || '未保存，请按订单号查原报表'}</td><td>{money(order.amount)}</td><td>{order.supplement ? '补差价 · ' : ''}{order.missingProduct ? '原产品已不存在' : '未归属产品'}</td></tr>)}</tbody></table></div><p>在<Link to="/master-data" onClick={onInspect}>基础资料 → 商品链接</Link>核对对应商品 ID 的所属产品，确认后再导入该日期的订单，更新产品明细。表中的订单原金额未扣后续退款，不能直接用来补写利润。</p></details>}
          {day.missingProducts && day.metrics.find(metric => metric.key === 'sales')?.daily === 0 && day.metrics.find(metric => metric.key === 'cost')?.daily === 0 && <p className="diagnostics-cause">该日销售额和成本为零，但回款汇总仍有推广费 {money(day.metrics.find(metric => metric.key === 'promotion')!.daily)}，产品明细没有对应记录，请核对推广费应归属的产品。</p>}
          {day.legacyRefund && <p className="diagnostics-cause">该日记录未确认按原订单成交日期归属退款，需要核对这一日期的原订单和退款报表；仅凭当前汇总无法确认退款归属。</p>}
          <p className="diagnostics-caption">回款汇总更新于 {dateTime(day.dailyUpdatedAt)}；产品明细更新于 {dateTime(day.productsUpdatedAt)}。</p>
          <Link className="text-button" to={`/profit-preview?${new URLSearchParams({ store: day.storeId, start: day.date, end: day.date, detail: 'saved' })}`} onClick={onInspect}>查看 {day.date} 已保存结果 →</Link>
        </div>
      </details>)}
    </section>)}
    {otherWarnings.length > 0 && <ul>{otherWarnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
    <p className="diagnostics-scope">选择继续导出后，仍沿用当前已保存结果。此提醒不会自动分配补差价，也不会改写销售额、成本或利润。</p>
  </div>
}
