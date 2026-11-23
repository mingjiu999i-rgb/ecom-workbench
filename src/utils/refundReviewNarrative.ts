import type { RefundReviewFinding, RefundReviewPeriod } from './refundReview'

export type RefundReviewNarrativeStore = {
  name: string
  period: RefundReviewPeriod
  findings: RefundReviewFinding[]
}

const money = (value: number | null) => value == null ? '未记录' : `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const percent = (value: number) => `${(value * 100).toFixed(2)}%`
const movement = (value: number | null) => value == null ? '缺少可比数据' : value === 0 ? '与基准持平' : `较基准${value < 0 ? '下降' : '上升'} ${(Math.abs(value) * 100).toFixed(2)} 个百分点`
const metric = (name: string, value: number | null, change: number | null) => value == null
  ? `${name}未记录`
  : `${name}${percent(value)}，${movement(change)}`

export function buildRefundReviewNarrative(stores: RefundReviewNarrativeStore[]): string[] {
  if (!stores.some(store => store.period.observedDays)) return ['所选区间没有已保存的结算记录，无法生成退款文字复盘。']
  const findings = stores.flatMap(store => store.findings.map(finding => ({ name: store.name, finding })))
    .sort((a, b) => (b.finding.severity === 'high' ? 1 : 0) - (a.finding.severity === 'high' ? 1 : 0)
      || b.finding.rateChange - a.finding.rateChange || b.finding.current.start.localeCompare(a.finding.current.start))
  const incomplete = stores.filter(store => !store.period.completeCoverage || store.period.missingRefundBasis)
  const affected = new Set(findings.map(item => item.name)).size
  const high = findings.filter(item => item.finding.severity === 'high').length
  const summary = findings.length
    ? `可比数据中检出 ${findings.length} 个退款率异常升高的店铺周，涉及 ${affected} 家店铺${high ? `，其中 ${high} 个同时出现明显的入账率或净回款比例下降` : ''}。以下按影响程度列出最多 3 个时段。`
    : '当前可比数据中未检出达到阈值的退款率异常升高时段。'
  const details = findings.slice(0, 3).map(({ name, finding }) => {
    const { current, baseline, rateChange, paymentChange, netReceiptChange } = finding
    const refund = `已发货退款率 ${percent(current.refundRate!)}，此前 28 天为 ${percent(baseline.refundRate!)}，上升 ${(rateChange * 100).toFixed(2)} 个百分点`
    const amount = `本周已发货退款 ${money(current.shippedRefund)}，此前 28 天周均 ${money(baseline.shippedRefund == null ? null : baseline.shippedRefund / 4)}`
    return `${name}（${current.start} 至 ${current.end}）：${refund}；${amount}。${metric('订单入账率 ', current.paymentCompletion, paymentChange)}；${metric('净回款比例 ', current.netReceiptRatio, netReceiptChange)}。未回款 ${money(current.unsettledAmount)}，最新盈亏 ${money(current.latestProfit)}，当前盈亏 ${money(current.currentProfit)}。`
  })
  const limits = incomplete.length ? `所选区间还有 ${incomplete.length} 家店铺存在缺失日期或旧退款口径，可能漏检异常；详情见“数据待核对”。` : ''
  return [summary, ...details, limits, '退款、回款与盈亏属于同一订单成交区间的已保存汇总，不能仅凭这些数字判定退款造成回款或利润变化；具体原因请核对结算及资金明细。'].filter(Boolean)
}
