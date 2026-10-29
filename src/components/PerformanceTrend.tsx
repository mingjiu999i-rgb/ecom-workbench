import { useState } from 'react'
import type { buildPerformance } from '../utils/performanceSummary'
import './performance-trend.css'

type Props = Pick<ReturnType<typeof buildPerformance>, 'trend' | 'monthly'> & { comparison: string; comparisonPeriod: string; onSelect: (start: string, end: string) => void }
const money = (value: number | null) => value == null ? '暂无数据' : `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function PerformanceTrend({ trend, monthly, comparison, comparisonPeriod, onSelect }: Props) {
  const [activeDate, setActiveDate] = useState('')
  const active = trend.find(row => row.date === activeDate) || [...trend].reverse().find(row => row.profit != null || row.amount != null)
  const positiveMax = Math.max(1, ...trend.flatMap(row => [row.amount ?? 0, row.profit ?? 0]))
  const negativeMax = Math.max(0, ...trend.map(row => -(row.profit ?? 0)))
  const plotHeight = 144
  const positiveHeight = plotHeight * positiveMax / (positiveMax + negativeMax)
  const height = (value: number | null) => value == null ? 3 : value === 0 ? 2 : Math.max(3, Math.abs(value) / (positiveMax + negativeMax) * plotHeight)
  const description = (row: Props['trend'][number]) => `${row.date}，退款 ${money(row.amount)}，预估盈亏（已扣运营费用）${money(row.profit)}${row.profitNote ? `；${row.profitNote}` : row.profitPartial ? '；仅汇总已保存产品利润，缺少每日回款记录待核对' : ''}`

  return <div className="refund-trend performance-trend">
    <div className="refund-trend-heading"><strong>退款与预估盈亏趋势</strong><span title={comparisonPeriod}>{comparison}</span></div>
    <div className="performance-trend-legend" aria-label="图例">
      <span><i className="trend-refund" />已发货退款</span><span><i className="trend-profit" />预估盈利（已扣运营费用）</span><span><i className="trend-loss" />预估亏损</span><span><i className="trend-unknown" />暂无数据</span>
    </div>
    <p>{monthly ? '按月汇总已保存数据，暂无记录的月份不展示。' : '按原订单成交日期汇总已保存数据。'}盈亏沿用甲方预估盈利，已扣运营费用；缺少利润或费用时不按零展示。悬停或聚焦查看金额，点击日期查看对应时段。</p>
    <div className="performance-trend-detail" aria-live="polite">{active ? <><strong>{active.date}</strong><span>退款 {money(active.amount)}</span><span className={active.profit != null && active.profit < 0 ? 'trend-loss-text' : 'trend-profit-text'}>预估盈亏 {money(active.profit)}</span>{active.profitNote ? <span>{active.profitNote}</span> : active.profitPartial && <span>已保存产品利润汇总 · 回款记录待核对</span>}</> : '暂无可展示数据'}</div>
    <div className="performance-trend-chart">
      <div className="performance-trend-axis" aria-hidden="true"><span>{money(positiveMax)}</span><span style={{ top: positiveHeight }}>0</span>{negativeMax > 0 && <span className="axis-bottom">{money(-negativeMax)}</span>}</div>
      <div className="performance-trend-bars" role="group" aria-label="每日退款与预估盈亏趋势">
        {trend.map(row => <button key={row.date} title={description(row)} aria-label={description(row)} onMouseEnter={() => setActiveDate(row.date)} onFocus={() => setActiveDate(row.date)} onClick={() => onSelect(row.start, row.end)}>
          <span className="performance-trend-track" style={{ height: plotHeight }} aria-hidden="true">
            <span className="performance-trend-zero" style={{ top: positiveHeight }} />
            <i className={`performance-trend-bar trend-refund${row.amount == null ? ' trend-unknown' : ''}`} style={{ height: height(row.amount), top: positiveHeight - height(row.amount) }} />
            <i className={`performance-trend-bar ${row.profit == null ? 'trend-unknown' : row.profit < 0 ? 'trend-loss' : 'trend-profit'}`} style={{ height: height(row.profit), top: row.profit != null && row.profit < 0 ? positiveHeight : positiveHeight - height(row.profit) }} />
          </span><span className="performance-trend-date">{monthly ? row.date : row.date.slice(5)}</span>
        </button>)}
      </div>
    </div>
  </div>
}
