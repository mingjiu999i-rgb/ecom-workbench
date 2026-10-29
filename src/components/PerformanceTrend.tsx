import { useMemo, useRef, useState, type MouseEvent } from 'react'
import type { buildPerformance } from '../utils/performanceSummary'
import { performanceTrendColumn } from '../utils/performanceTrendColumn'
import './performance-trend.css'

type Props = Pick<ReturnType<typeof buildPerformance>, 'trend' | 'monthly'> & { comparison: string; comparisonPeriod: string; onSelect: (start: string, end: string) => void }
type Series = 'both' | 'refund' | 'profit'
const money = (value: number | null) => value == null ? '暂无数据' : `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function PerformanceTrend({ trend, monthly, comparison, comparisonPeriod, onSelect }: Props) {
  const [series, setSeries] = useState<Series>('both')
  const [activeDate, setActiveDate] = useState<string | null>(null)
  const [point, setPoint] = useState({ left: 8, top: 8 })
  const chart = useRef<HTMLDivElement>(null)
  const columns = useMemo(() => trend.map(row => ({ ...row, ...performanceTrendColumn(row.profit, row.amount) })), [trend])
  const active = columns.find(row => row.date === activeDate)
  const showRefund = series !== 'profit', showProfit = series !== 'refund'
  const values = columns.flatMap(row => [...(showRefund ? [row.refund ?? 0] : []), ...(showProfit ? [row.profit ?? 0] : [])])
  const highest = Math.max(1, ...values), lowest = Math.min(0, ...values), plotHeight = 200
  const y = (value: number) => (highest - value) / (highest - lowest) * plotHeight
  const description = (row: typeof columns[number]) => `${row.date}，预估盈亏 ${money(row.profit)}，退款 ${money(row.refund)}，盈亏－退款 ${money(row.balance)}`
  const isolate = (name: Series) => { setSeries(current => current === name ? 'both' : name); setActiveDate(null) }
  const locate = (date: string, clientX: number, clientY: number) => {
    const rect = chart.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(248, rect.width - 16)
    setPoint({ left: Math.max(8, Math.min(clientX - rect.left + 14, rect.width - width - 8)), top: Math.max(8, Math.min(clientY - rect.top - 140, plotHeight - 130)) })
    setActiveDate(date)
  }
  const hover = (event: MouseEvent<HTMLButtonElement>, date: string) => locate(date, event.clientX, event.clientY)
  const mark = (amount: number | null, name: 'refund' | 'profit') => amount == null
    ? <span className={`performance-trend-unknown series-${name}`} style={{ top: y(0) }}>—</span>
    : <i className={`performance-trend-bar series-${name}`} style={{ top: amount < 0 ? y(0) : y(amount), height: Math.max(2, Math.abs(y(amount) - y(0))) }} />

  return <div className="refund-trend performance-trend">
    <div className="refund-trend-heading"><strong>{monthly ? '每月盈亏与退款' : '每日盈亏与退款'}</strong><span title={comparisonPeriod}>退款：{comparison}</span></div>
    <div className="performance-trend-legend" role="group" aria-label="图例筛选">
      <button type="button" aria-pressed={showRefund} title={series === 'refund' ? '再次点击恢复两项' : '点击单独查看退款'} onClick={() => isolate('refund')}><i className="legend-refund" />退款</button>
      <button type="button" aria-pressed={showProfit} title={series === 'profit' ? '再次点击恢复两项' : '点击单独查看预估盈亏'} onClick={() => isolate('profit')}><i className="legend-profit" />预估盈亏</button>
    </div>
    <div className="performance-trend-chart" ref={chart} onMouseLeave={() => { if (!chart.current?.contains(document.activeElement)) setActiveDate(null) }}>
      <div className="performance-trend-axis" aria-hidden="true">{y(0) >= 22 && <span>{money(highest)}</span>}<span style={{ top: y(0) }}>0</span>{lowest < 0 && plotHeight - y(0) >= 22 && <span className="axis-bottom">{money(lowest)}</span>}</div>
      <div className={`performance-trend-bars mode-${series}`} role="group" aria-label="每日盈亏与退款趋势">
        {columns.map(row => <button key={row.date} type="button" aria-label={description(row)} aria-describedby={row.date === activeDate ? 'performance-trend-tooltip' : undefined} onMouseEnter={event => hover(event, row.date)} onMouseMove={event => hover(event, row.date)} onFocus={event => { const rect = event.currentTarget.getBoundingClientRect(); locate(row.date, rect.left + rect.width / 2, rect.top + 80) }} onBlur={() => setActiveDate(null)} onClick={() => onSelect(row.start, row.end)}>
          <span className="performance-trend-track" style={{ height: plotHeight }} aria-hidden="true">
            <span className="performance-trend-zero" style={{ top: y(0) }} />
            {showRefund && mark(row.refund, 'refund')}{showProfit && mark(row.profit, 'profit')}
          </span><span className="performance-trend-date">{monthly ? row.date : row.date.slice(5)}</span>
        </button>)}
      </div>
      {active && <div className="performance-trend-tooltip" id="performance-trend-tooltip" role="tooltip" style={{ top: point.top, left: `min(${point.left}px, max(8px, calc(100% - 256px)))` }}>
        <strong>{active.date}</strong>
        <div><span><i className="legend-profit" />预估盈亏</span><b>{money(active.profit)}</b></div>
        <div><span><i className="legend-refund" />退款</span><b>{money(active.refund)}</b></div>
        <div className="performance-trend-difference"><span>盈亏－退款</span><b>{money(active.balance)}</b></div>
      </div>}
    </div>
  </div>
}
