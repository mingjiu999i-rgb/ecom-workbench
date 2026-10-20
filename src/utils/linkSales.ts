import type { WorkbenchData } from '../types/models'
import { isSupplementOrder } from './orderCostMatching'

// Independent listing analysis only. Never write settlement ledgers or records.
export type LinkSalesOrder = {
  storeId: string; orderId: string; goodsId: string; name: string; date: string | null
  status: string; receipt: number | null; quantity: number | null; supplement: boolean; conflict?: boolean
  skuCode?: string; specification?: string
}
export type LinkPromotion = { storeId: string; goodsId: string; date: string; amount: number }
type LinkData = WorkbenchData & { linkSalesOrders?: LinkSalesOrder[]; linkSalesPromotions?: LinkPromotion[] }
export const linkKey = (storeId: string, goodsId: string, date = '') => JSON.stringify([storeId, goodsId, date])
const orderKey = (row: LinkSalesOrder) => JSON.stringify([row.storeId, row.orderId])
const text = (value: unknown) => value == null ? '' : String(value).replace(/\t/g, '').trim()
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
export function linkNumber(value: unknown): number | null {
  const raw = text(value).replace(/[,¥￥]/g, '')
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return null
  const number = Number(raw)
  return nonnegative(number) ? number : null
}
export function linkDate(value: unknown): string | null {
  const match = text(value).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s|T|$)/)
  if (!match) return null
  const date = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null
}
export function parseLinkSalesRows(storeId: string, rows: Record<string, unknown>[]): LinkSalesOrder[] {
  return rows.filter(row => text(row['订单号'])).map(row => ({
    storeId, orderId: text(row['订单号']), goodsId: text(row['商品id'] || row['商品ID']), name: text(row['商品']),
    date: linkDate(row['支付时间'] || row['订单成交时间']), status: text(row['订单状态']),
    receipt: linkNumber(row['商家实收金额(元)']), quantity: linkNumber(row['商品数量(件)']),
    ...(Object.hasOwn(row, '商家编码-规格维度') ? { skuCode: text(row['商家编码-规格维度']) } : {}),
    ...(Object.hasOwn(row, '商品规格') ? { specification: text(row['商品规格']) } : {}),
    supplement: isSupplementOrder({ product: text(row['商品']), specification: text(row['商品规格']), skuCode: text(row['商家编码-规格维度']) }),
  }))
}
export const getLinkSalesOrders = (data: WorkbenchData) => (data as LinkData).linkSalesOrders || []
export const getLinkPromotions = (data: WorkbenchData) => (data as LinkData).linkSalesPromotions || []
export function mergeLinkSalesOrders(data: WorkbenchData, incoming: LinkSalesOrder[]): WorkbenchData {
  const rows = new Map(getLinkSalesOrders(data).map(row => [orderKey(row), row]))
  let changed = false
  for (const row of incoming) {
    if (!row.storeId || !row.orderId) continue
    const key = orderKey(row), previous = rows.get(key)
    const conflict = previous?.conflict || Boolean(previous?.goodsId && row.goodsId && previous.goodsId !== row.goodsId)
    const next = { ...row, goodsId: previous?.goodsId || row.goodsId, ...(conflict ? { conflict: true } : {}),
      ...(row.skuCode === undefined && previous?.skuCode !== undefined ? { skuCode: previous.skuCode } : {}),
      ...(row.specification === undefined && previous?.specification !== undefined ? { specification: previous.specification } : {}),
    }
    if (JSON.stringify(previous) !== JSON.stringify(next)) { rows.set(key, next); changed = true }
  }
  return changed ? { ...data, linkSalesOrders: [...rows.values()] } as LinkData : data
}
export function putLinkPromotions(data: WorkbenchData, incoming: Array<Omit<LinkPromotion, 'amount'> & { amount: number | null }>): WorkbenchData {
  const rows = new Map(getLinkPromotions(data).map(row => [linkKey(row.storeId, row.goodsId, row.date), row]))
  for (const row of incoming) {
    if (!data.stores.some(store => store.id === row.storeId) || !row.goodsId || linkDate(row.date) !== row.date || (row.amount !== null && (!nonnegative(row.amount) || round(row.amount) !== row.amount))) throw new Error('推广费须为非负金额，最多两位小数；店铺、商品 ID 和日期不能为空。')
    const key = linkKey(row.storeId, row.goodsId, row.date)
    if (row.amount === null) rows.delete(key)
    else rows.set(key, { ...row, amount: row.amount })
  }
  return { ...data, linkSalesPromotions: [...rows.values()] } as LinkData
}

export type LinkSalesMetric = {
  key: string; storeId: string; goodsId: string; name: string; date: string; days: number; orders: number
  quantity: number | null; sales: number | null; cost: number | null; promotion: number | null
  missingCost: number; missingPromotion: number; profit: number | null; margin: number | null
}
type Filter = { storeId?: string; start?: string; end?: string; query?: string; clientId?: string }
const excluded = (row: LinkSalesOrder) => /取消|待付款|未付款|待支付/.test(row.status)
const paid = (row: LinkSalesOrder) => !excluded(row) && /已发货|未发货|已收货|已完成|已签收|已成交|待发货|待收货|待评价|交易成功|退款成功/.test(row.status)
const sum = (a: number | null, b: number | null): number | null => a == null || b == null ? null : round(a + b)
function result(row: LinkSalesMetric): LinkSalesMetric {
  const profit = row.sales != null && row.cost != null && row.promotion != null ? round(row.sales - row.cost - row.promotion) : null
  return { ...row, profit, margin: profit != null && row.sales != null && row.sales > 0 ? profit / row.sales : null }
}
export function summarizeLinkSales(data: WorkbenchData, filter: Filter = {}) {
  const stores = new Set(data.stores.filter(row => (!filter.storeId || row.id === filter.storeId) && (!filter.clientId || row.clientId === filter.clientId)).map(row => row.id))
  const inDate = (date: string) => (!filter.start || date >= filter.start) && (!filter.end || date <= filter.end)
  const search = (row: { goodsId: string; name: string }) => `${row.goodsId} ${row.name}`.toLowerCase().includes((filter.query || '').trim().toLowerCase())
  const costs = new Map((data.orderAccountingLedgers || []).flatMap(ledger => ledger.orders.map(order => [JSON.stringify([ledger.storeId, order.id]), order] as const)))
  // Read-only eligibility: a later after-sale-only import must also update this
  // analysis. Refund amounts never participate in listing profit calculations.
  const unshippedRefunds = new Set((data.orderAccountingLedgers || []).flatMap(ledger => ledger.refunds
    .filter(refund => refund.success && refund.stage === '未发货')
    .map(refund => JSON.stringify([ledger.storeId, refund.orderId]))))
  const promos = new Map(getLinkPromotions(data).map(row => [linkKey(row.storeId, row.goodsId, row.date), row.amount]))
  const dailyMap = new Map<string, LinkSalesMetric>()
  const pending: LinkSalesOrder[] = []
  for (const row of getLinkSalesOrders(data)) {
    if (!stores.has(row.storeId) || !search(row) || excluded(row)) continue
    if (row.date && !inDate(row.date)) continue
    const unshippedRefund = unshippedRefunds.has(orderKey(row)) || row.status.includes('未发货') && row.status.includes('退款成功')
    if (!row.date || !row.goodsId || row.conflict || !paid(row) && !unshippedRefund) { if (!unshippedRefund) pending.push(row); continue }
    const key = linkKey(row.storeId, row.goodsId, row.date)
    const promotion = promos.get(key) ?? null
    const metric = dailyMap.get(key) || { key, storeId: row.storeId, goodsId: row.goodsId, name: row.name, date: row.date, days: 1, orders: 0, quantity: 0, sales: 0, cost: 0, promotion, missingCost: 0, missingPromotion: promotion == null ? 1 : 0, profit: null, margin: null }
    // Keep the known listing/date for daily ad entry, even when all its paid
    // orders were refunded before shipment. Their contribution is exactly zero;
    // advertising spend is retained and can still produce a loss.
    if (unshippedRefund) { dailyMap.set(key, metric); continue }
    const snapshot = costs.get(orderKey(row))
    const unitCost = snapshot && snapshot.supplement === row.supplement && nonnegative(snapshot.unitCost) ? snapshot.unitCost : null
    const cost = row.supplement ? 0 : unitCost != null && row.quantity != null && Number.isInteger(row.quantity) ? round(unitCost * row.quantity) : null
    const quantity = row.supplement ? 0 : row.quantity != null && Number.isInteger(row.quantity) ? row.quantity : null
    metric.orders++; metric.quantity = sum(metric.quantity, quantity); metric.sales = sum(metric.sales, row.receipt)
    metric.cost = sum(metric.cost, cost); if (cost == null) metric.missingCost++
    dailyMap.set(key, metric)
  }
  // Previously entered spend must not disappear if a later report cancels all
  // orders for that day. With no eligible source orders, sales remain unknown.
  for (const promotion of getLinkPromotions(data)) {
    if (!stores.has(promotion.storeId) || !inDate(promotion.date)) continue
    const source = getLinkSalesOrders(data).find(row => row.storeId === promotion.storeId && row.goodsId === promotion.goodsId)
    const name = source?.name || ''
    if (!search({ goodsId: promotion.goodsId, name })) continue
    const key = linkKey(promotion.storeId, promotion.goodsId, promotion.date)
    if (!dailyMap.has(key)) dailyMap.set(key, { key, ...promotion, name, days: 1, orders: 0, quantity: null, sales: null, cost: null, promotion: promotion.amount, missingCost: 0, missingPromotion: 0, profit: null, margin: null })
  }
  const daily = [...dailyMap.values()].map(result).sort((a, b) => b.date.localeCompare(a.date) || a.storeId.localeCompare(b.storeId) || a.goodsId.localeCompare(b.goodsId))
  const summaryMap = new Map<string, LinkSalesMetric>()
  for (const day of daily) {
    const key = linkKey(day.storeId, day.goodsId), previous = summaryMap.get(key)
    summaryMap.set(key, previous ? result({ ...previous, days: previous.days + 1, orders: previous.orders + day.orders,
      quantity: sum(previous.quantity, day.quantity), sales: sum(previous.sales, day.sales), cost: sum(previous.cost, day.cost), promotion: sum(previous.promotion, day.promotion),
      missingCost: previous.missingCost + day.missingCost, missingPromotion: previous.missingPromotion + day.missingPromotion,
    }) : { ...day, key, date: '' })
  }
  const indexed = new Set(getLinkSalesOrders(data).map(orderKey))
  const unindexed = (data.orderAccountingLedgers || []).filter(ledger => stores.has(ledger.storeId)).reduce((count, ledger) => count + ledger.orders.filter(order => !order.cancelled && !unshippedRefunds.has(JSON.stringify([ledger.storeId, order.id])) && inDate(order.date) && !indexed.has(JSON.stringify([ledger.storeId, order.id]))).length, 0)
  return { daily, summary: [...summaryMap.values()].sort((a, b) => a.storeId.localeCompare(b.storeId) || a.goodsId.localeCompare(b.goodsId)), pending, unindexed }
}
