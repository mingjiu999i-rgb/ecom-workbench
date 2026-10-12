import type { CollectionRecord, WorkbenchData } from '../types/models'

export const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100
const value = (number: number | null | undefined) => Number.isFinite(number) ? Number(number) : 0
const sum = <T,>(rows: T[], get: (row: T) => number | null | undefined) => roundMoney(rows.reduce((total, row) => total + value(get(row)), 0))
export const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
export const shiftDate = (date: string, days: number) => { const next = new Date(`${date}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + days); return next.toISOString().slice(0, 10) }

export type PerformanceIssue = { storeId: string; date: string; kind: 'cost' | 'profit' | 'collection'; message: string }
export type PerformanceSummary = ReturnType<typeof summarizePerformance>

export function groupRefundsByOrderDate(refunds: { orderId: string; refundAmount: number }[], orderDates: Map<string, string>) {
  const grouped = new Map<string, number>()
  refunds.forEach(refund => { const date = orderDates.get(refund.orderId); if (date && validDate(date)) grouped.set(date, (grouped.get(date) || 0) + value(refund.refundAmount)) })
  return Object.fromEntries([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, amount]) => [date, roundMoney(amount)]))
}

export function refundSources(rows: CollectionRecord[], start: string, end: string) {
  let current = 0, historical = 0, unknown = 0
  rows.forEach(row => {
    if (row.refundBasis === 'order_paid_at') { current += value(row.shippedRefund); return }
    if (!row.shippedRefundByOrderDate || row.refundBasis !== 'refund_completed_at') { unknown += value(row.shippedRefund); return }
    let classified = 0
    Object.entries(row.shippedRefundByOrderDate).forEach(([date, amount]) => {
      if (!validDate(date) || date > end) return
      classified += value(amount)
      if (date >= start) current += value(amount)
      else historical += value(amount)
    })
    unknown += Math.max(0, value(row.shippedRefund) - classified)
  })
  return { current: roundMoney(current), historical: roundMoney(historical), unknown: roundMoney(unknown) }
}

export function summarizePerformance(data: WorkbenchData, start: string, end: string, storeIds: Set<string>) {
  const inRange = (row: { date: string; storeId: string }) => storeIds.has(row.storeId) && row.date >= start && row.date <= end
  const products = data.profitRecords.filter(inRange), collections = data.collectionRecords.filter(inRange)
  const issues: PerformanceIssue[] = []
  const productsByDay = new Map<string, typeof products>()
  products.forEach(row => { const key = `${row.storeId}|${row.date}`; productsByDay.set(key, [...(productsByDay.get(key) || []), row]) })
  const collectionKeys = new Set(collections.map(row => `${row.storeId}|${row.date}`))
  collections.forEach(row => {
    const dailyProducts = productsByDay.get(`${row.storeId}|${row.date}`) || []
    if (row.missingCostOrders > 0 || row.productCost == null) issues.push({ storeId: row.storeId, date: row.date, kind: 'cost', message: row.missingCostOrders > 0 ? `${row.missingCostOrders} 个订单待补成本` : '成本数据待补全' })
    const needsProfit = row.effectiveSales !== 0 || value(row.productCost) !== 0 || row.promotionFee !== 0
    const mismatch = dailyProducts.length > 0 && (Math.abs(sum(dailyProducts, item => item.amount) - row.effectiveSales) > 0.02 || (row.productCost != null && Math.abs(sum(dailyProducts, item => item.cost) - row.productCost) > 0.02) || Math.abs(sum(dailyProducts, item => item.promotion) - row.promotionFee) > 0.02)
    if ((needsProfit && !dailyProducts.length) || mismatch) issues.push({ storeId: row.storeId, date: row.date, kind: 'profit', message: mismatch ? '产品利润与回款汇总待核对' : '产品利润尚未同步' })
  })
  productsByDay.forEach((rows, key) => { if (!collectionKeys.has(key)) issues.push({ storeId: rows[0].storeId, date: rows[0].date, kind: 'collection', message: '缺少每日回款记录' }) })
  const hasData = products.length > 0 || collections.length > 0
  const sales = hasData ? sum(products, row => row.amount) : null
  const cost = hasData ? sum(products, row => row.cost) : null
  const promotion = hasData ? sum(products, row => row.promotion) : null
  const operationFee = hasData ? sum(products, row => row.operationFee) : null
  const profit = hasData ? sum(products, row => row.estimatedProfit) : null
  const originalSales = sum(collections, row => row.originalSales)
  const orderRefund = sum(collections, row => row.orderShippedRefund ?? (row.refundBasis !== 'refund_completed_at' ? row.shippedRefund : 0))
  const rateAvailable = collections.length > 0 && collections.every(row => row.orderShippedRefund != null || row.refundBasis !== 'refund_completed_at') && originalSales > 0
  return {
    hasData, sales, cost, promotion, operationFee, profit, issues,
    partial: issues.length > 0, affectedDays: new Set(issues.map(row => `${row.storeId}|${row.date}`)).size,
    recordCount: new Set([...products, ...collections].map(row => `${row.storeId}|${row.date}`)).size,
    shippedRefund: collections.length ? sum(collections, row => row.shippedRefund) : null,
    originalSales, orderRefund, refundRate: rateAvailable ? orderRefund / originalSales : null,
    refundSources: refundSources(collections, start, end),
    legacyRefund: collections.some(row => row.refundBasis !== 'order_paid_at'),
    currentNet: collections.length ? sum(collections, row => row.currentNet) : null,
    unsettledAmount: collections.length ? sum(collections, row => row.unsettledAmount) : null,
    difference: hasData ? roundMoney(value(profit) - (value(sales) - value(cost) - value(promotion) - value(operationFee))) : 0,
  }
}

export function buildPerformance(data: WorkbenchData, start: string, end: string, storeId: string, yesterday: string) {
  const selected = data.stores.filter(store => !storeId || store.id === storeId)
  const ids = new Set(selected.map(store => store.id))
  const stores = selected.map(store => {
    const allCollections = data.collectionRecords.filter(row => row.storeId === store.id)
    const allProducts = data.profitRecords.filter(row => row.storeId === store.id)
    return { ...store, ...summarizePerformance(data, start, end, new Set([store.id])),
      collectionThrough: allCollections.map(row => row.date).sort().at(-1),
      profitThrough: allProducts.map(row => row.date).sort().at(-1),
      updatedAt: [...allCollections, ...allProducts].map(row => row.updatedAt).filter(Boolean).sort().at(-1),
      missingYesterday: store.storeStatus !== '暂停' && !allCollections.some(row => row.date === yesterday),
    }
  })
  const clients = data.clients.filter(client => !storeId || selected.some(store => store.clientId === client.id)).map(client => ({ ...client, ...summarizePerformance(data, start, end, new Set(selected.filter(store => store.clientId === client.id).map(store => store.id))) }))
  const collections = data.collectionRecords.filter(row => ids.has(row.storeId) && row.date >= start && row.date <= end)
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1
  const monthly = days > 62
  const keys = monthly ? [...new Set(collections.map(row => row.date.slice(0, 7)))].sort() : Array.from({ length: Math.max(0, days) }, (_, i) => shiftDate(start, i))
  const trend = keys.map(date => {
    const rows = collections.filter(row => monthly ? row.date.startsWith(date) : row.date === date)
    const bucketStart = monthly ? `${date}-01` : date
    const bucketEnd = monthly ? shiftDate(`${Number(date.slice(0, 4)) + (date.slice(5) === '12' ? 1 : 0)}-${date.slice(5) === '12' ? '01' : String(Number(date.slice(5)) + 1).padStart(2, '0')}-01`, -1) : date
    return { date, start: bucketStart < start ? start : bucketStart, end: bucketEnd > end ? end : bucketEnd, amount: rows.length ? sum(rows, row => row.shippedRefund) : null }
  })
  // Very long custom ranges can precede year 0000; don't manufacture an invalid comparison.
  const previousEnd = shiftDate(start, -1), previousStart = shiftDate(start, -days)
  const previous = validDate(previousStart) && validDate(previousEnd) ? summarizePerformance(data, previousStart, previousEnd, ids) : null
  return { stores, clients, total: summarizePerformance(data, start, end, ids), trend, monthly, previous, previousStart, previousEnd }
}
