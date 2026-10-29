import { useMemo, useState } from 'react'
import type { buildPerformance } from '../utils/performanceSummary'
import { performanceTrendColumn } from '../utils/performanceTrendColumn'
import './performance-trend.css'

type Props = Pick<ReturnType<typeof buildPerformance>, 'trend' | 'monthly'> & { comparison: string; comparisonPeriod: string; onSelect: (start: string, end: string) => void }
const money = (value: number | null) => value == null ? '暂无数据' : `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function PerformanceTrend({ trend, monthly, comparison, comparisonPeriod, onSelect }: Props) {
  const [activeDate, setActiveDate] = useState('')
  const columns = useMemo(() => trend.map(row => ({ ...row, ...performanceTrendColumn(row.profit, row.amount) })), [trend])
  const active = columns.find(row => row.date === activeDate) || [...columns].reverse().find(row => row.profit != null || row.refund != null)
  const highest = Math.max(1, ...columns.map(row => row.high))
  const lowest = Math.min(0, ...columns.map(row => row.low))
  const plotHeight = 176
  const y = (value: number) => (highest - value) / (highest - lowest) * plotHeight
  const rangeStyle = (range: { low: number; high: number }) => ({ top: y(range.high), height: y(range.low) - y(range.high) })
  const description = (row: typeof columns[number]) => `${row.date}\n预估盈亏 ${money(row.profit)}\n退款 ${money(row.refund)}\n盈亏－退款 ${money(row.balance)}${row.profitNote ? '\n待补数据' : ''}`

  return <div className="refund-trend performance-trend">
    <div className="refund-trend-heading"><strong>{monthly ? '每月盈亏与退款' : '每日盈亏与退款'}</strong><span title={comparisonPeriod}>{comparison}</span></div>
    <div className="performance-trend-legend" aria-label="图例">
      <span><i className="legend-profit" />预估盈亏</span><span><i className="legend-refund" />退款</span><span><i className="legend-result" />盈亏－退款</span>
    </div>
    <div className="performance-trend-detail" aria-live="polite">{active ? <><strong>{active.date}</strong><span className="trend-profit-text">预估盈亏 <b>{money(active.profit)}</b></span><span className="trend-refund-text">退款 <b>{money(active.refund)}</b></span><span className="trend-result-text">盈亏－退款 <b>{money(active.balance)}</b></span></> : '暂无数据'}</div>
    <div className="performance-trend-chart">
      <div className="performance-trend-axis" aria-hidden="true"><span>{money(highest)}</span><span style={{ top: y(0) }}>0</span>{lowest < 0 && <span className="axis-bottom">{money(lowest)}</span>}</div>
      <div className="performance-trend-bars" role="group" aria-label="每日盈亏与退款单柱图">
        {columns.map(row => <button key={row.date} title={description(row)} aria-label={description(row)} onMouseEnter={() => setActiveDate(row.date)} onFocus={() => setActiveDate(row.date)} onClick={() => onSelect(row.start, row.end)}>
          <span className="performance-trend-track" style={{ height: plotHeight }} aria-hidden="true">
            <span className="performance-trend-zero" style={{ top: y(0) }} />
            <span className="performance-trend-column">
              {row.resultRange && row.balance !== 0 && <i className="trend-result-segment" style={rangeStyle(row.resultRange)} />}
              {row.refundRange && row.refund !== 0 && <i className={`trend-refund-segment${row.overlap ? ' is-overlap' : ''}`} style={rangeStyle(row.refundRange)} />}
              {row.balance != null && <i className="trend-result-marker" style={{ top: y(row.balance) }} />}
              {row.profit != null && <i className="trend-profit-marker" style={{ top: y(row.profit) }} />}
              {row.profit == null && row.refund == null && <i className="trend-unknown-marker" style={{ top: y(0) }} />}
            </span>
          </span><span className="performance-trend-date">{monthly ? row.date : row.date.slice(5)}</span>
        </button>)}
      </div>
    </div>
  </div>
}
