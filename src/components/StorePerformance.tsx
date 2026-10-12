import { ArrowRight, BadgePercent, CircleDollarSign, RotateCcw, TrendingUp } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWorkbench } from '../store/workbench'

const money = (value: number | null) => value == null ? '—' : `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const sum = <T,>(rows: T[], value: (row: T) => number) => Math.round(rows.reduce((total, row) => total + value(row), 0) * 100) / 100

export function StorePerformance() {
  const { data } = useWorkbench()
  const navigate = useNavigate()
  const today = new Date().toLocaleDateString('sv-SE')
  const yesterdayDate = new Date(`${today}T12:00:00`)
  yesterdayDate.setDate(yesterdayDate.getDate() - 1)
  const yesterday = yesterdayDate.toLocaleDateString('sv-SE')
  const [period, setPeriod] = useState<'yesterday' | 'month' | 'custom'>('month')
  const [customStart, setCustomStart] = useState(`${today.slice(0, 7)}-01`)
  const [customEnd, setCustomEnd] = useState(today)
  const [storeId, setStoreId] = useState('')
  const startDate = period === 'month' ? `${today.slice(0, 7)}-01` : period === 'yesterday' ? yesterday : customStart
  const endDate = period === 'month' ? today : period === 'yesterday' ? yesterday : customEnd
  const validRange = Boolean(startDate && endDate && startDate <= endDate)
  const selectedStore = data.stores.find(store => store.id === storeId)
  const rangeLabel = startDate === endDate ? startDate : `${startDate} 至 ${endDate}`

  const performance = useMemo(() => {
    const inRange = (row: { date: string; storeId: string }) => validRange && row.date >= startDate && row.date <= endDate && (!storeId || row.storeId === storeId)
    const profits = data.profitRecords.filter(inRange)
    const collections = data.collectionRecords.filter(inRange)
    const summarize = (ids: Set<string>) => {
      const productRows = profits.filter(row => ids.has(row.storeId))
      const collectionRows = collections.filter(row => ids.has(row.storeId))
      const hasData = productRows.length > 0 || collectionRows.length > 0
      return {
        sales: hasData ? sum(productRows, row => row.amount) : null,
        operationFee: hasData ? sum(productRows, row => row.operationFee) : null,
        profit: hasData ? sum(productRows, row => row.estimatedProfit) : null,
        shippedRefund: collectionRows.length ? sum(collectionRows, row => row.shippedRefund) : null,
        missingProfit: collectionRows.some(row => row.missingCostOrders > 0 || ((row.effectiveSales !== 0 || row.promotionFee !== 0 || Boolean(row.productCost)) && !productRows.some(product => product.storeId === row.storeId && product.date === row.date))),
      }
    }
    const stores = data.stores.filter(store => !storeId || store.id === storeId).map(store => ({ ...store, ...summarize(new Set([store.id])) }))
    const clients = data.clients.filter(client => !storeId || client.id === selectedStore?.clientId).map(client => ({ ...client, ...summarize(new Set(stores.filter(store => store.clientId === client.id).map(store => store.id))) }))
    return {
      stores, clients, total: summarize(new Set(stores.map(store => store.id))),
      recordCount: new Set([...profits, ...collections].map(row => `${row.storeId}|${row.date}`)).size,
      legacyRefund: collections.some(row => row.refundBasis !== 'refund_completed_at'),
    }
  }, [data, startDate, endDate, storeId, selectedStore?.clientId, validRange])

  const detail = (targetStoreId: string) => navigate(`/profit-preview?${new URLSearchParams({ store: targetStoreId, start: startDate, end: endDate, detail: 'saved' })}`)
  const metrics = [
    ['销售额', performance.total.sales, CircleDollarSign, 'blue'],
    ['我的提点', performance.total.missingProfit ? null : performance.total.operationFee, BadgePercent, 'violet'],
    ['甲方盈利', performance.total.missingProfit ? null : performance.total.profit, TrendingUp, 'green'],
    ['已发货退款', performance.total.shippedRefund, RotateCcw, 'red'],
  ] as const

  return <section className="panel performance-panel" aria-label="店铺业绩总览">
    <div className="panel-heading performance-heading">
      <div><h2>{selectedStore ? `${selectedStore.name}业绩` : '全部店铺业绩'}</h2><p>汇总经营结算中已经保存的数据</p></div>
      <div className="performance-controls">
        <select aria-label="筛选店铺" value={storeId} onChange={event => setStoreId(event.target.value)}><option value="">全部店铺</option>{data.stores.map(store => <option key={store.id} value={store.id}>{data.clients.find(client => client.id === store.clientId)?.name} · {store.name}{store.storeStatus === '暂停' ? '（暂停）' : ''}</option>)}</select>
        <div className="performance-period" role="group" aria-label="业绩日期范围">{([['yesterday', '昨天'], ['month', '本月'], ['custom', '自定义']] as const).map(([value, label]) => <button key={value} aria-pressed={period === value} className={period === value ? 'active' : ''} onClick={() => setPeriod(value)}>{label}</button>)}</div>
      </div>
    </div>
    {period === 'custom' && <div className="performance-dates"><label>开始日期<input type="date" aria-label="业绩开始日期" value={customStart} max={customEnd || undefined} onChange={event => setCustomStart(event.target.value)} /></label><span>至</span><label>结束日期<input type="date" aria-label="业绩结束日期" value={customEnd} min={customStart || undefined} onChange={event => setCustomEnd(event.target.value)} /></label></div>}
    {!validRange ? <div className="performance-note negative" role="alert">请选择完整日期范围，且开始日期不能晚于结束日期。</div> : <>
      <div className="performance-metrics">{metrics.map(([label, value, Icon, tone]) => <article className="metric" key={label}><div className={`metric-icon ${tone}`}><Icon size={19} /></div><div><span>{label}</span><strong>{money(value)}</strong></div></article>)}</div>
      <p className="performance-note">已发货退款按退款完成日期统计，包含历史订单退款。{performance.legacyRefund && '部分数据仍为旧版退款口径，请在经营结算重新导入报表。'}{performance.total.missingProfit && '部分记录待补成本或产品利润尚未同步，提点和盈利暂不展示；销售额为已保存的产品数据。'}</p>
      {!performance.recordCount ? <div className="performance-empty">{rangeLabel} 暂无已保存的经营数据，请到经营结算导入报表。<button className="text-button" onClick={() => selectedStore ? detail(selectedStore.id) : navigate('/profit-preview')}>前往经营结算 <ArrowRight size={14} /></button></div> : <>
        <div className="table-caption"><div><strong>各甲方汇总</strong><span>{rangeLabel}</span></div><span>{performance.recordCount} 条店铺日经营记录</span></div>
        <div className="table-scroll"><table><thead><tr><th>甲方</th><th>销售额</th><th>我的提点</th><th>甲方盈利</th><th>已发货退款</th></tr></thead><tbody>{performance.clients.map(client => <tr key={client.id}><td className="cell-main">{client.name}</td><td>{money(client.sales)}</td><td className="performance-fee">{money(client.missingProfit ? null : client.operationFee)}</td><td className={client.profit != null && client.profit < 0 ? 'negative' : 'positive'}>{money(client.missingProfit ? null : client.profit)}</td><td className="negative">{money(client.shippedRefund)}</td></tr>)}</tbody></table></div>
        <div className="table-caption"><div><strong>店铺明细</strong><span>点击详情查看该店铺在所选日期内的经营结算</span></div></div>
        <div className="table-scroll"><table><thead><tr><th>店铺</th><th>销售额</th><th>我的提点</th><th>甲方盈利</th><th>已发货退款</th><th>操作</th></tr></thead><tbody>{performance.stores.map(store => <tr key={store.id}><td><strong className="cell-main">{store.name}</strong><div className="cell-sub">{data.clients.find(client => client.id === store.clientId)?.name}{store.storeStatus === '暂停' ? ' · 暂停' : ''}</div></td><td>{money(store.sales)}</td><td className="performance-fee">{money(store.missingProfit ? null : store.operationFee)}</td><td className={store.profit != null && store.profit < 0 ? 'negative' : 'positive'}>{money(store.missingProfit ? null : store.profit)}</td><td className="negative">{money(store.shippedRefund)}</td><td><button className="text-button" aria-label={`查看${store.name}经营结算详情`} onClick={() => detail(store.id)}>详情 <ArrowRight size={14} /></button></td></tr>)}</tbody></table></div>
      </>}
    </>}
  </section>
}
