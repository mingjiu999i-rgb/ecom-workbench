import type { WorkbenchData } from '../types/models'
import { getLinkSalesOrders, linkDate } from './linkSales'

export type SpecSalesFilter = { clientId?: string; startDate?: string; endDate?: string }
export type SpecSalesRow = {
  key: string; skuCode: string; specification: string; quantity: number | null
}
export const specSalesBasis = '按订单支付日期统计件数；取消、未成交、未付款、未发货退款成功及补差价不计入，已发货退款保留销量。'

type SpecSalesIssue = {
  storeId: string; reason: string; skuCode?: string; date?: string; orderId?: string; blocksQuantity?: boolean
}

// Read-only analysis of the existing independent order index. Never infer SKU
// codes or quantities from today's cost library or change settlement records.
// The library supplies display names only, never costs or eligibility.
export function summarizeSpecSales(data: WorkbenchData, filter: SpecSalesFilter = {}) {
  const stores = data.stores.filter(store => (!filter.clientId || store.clientId === filter.clientId) && store.storeStatus !== '暂停')
  const storeIds = new Set(stores.map(store => store.id))
  const clientIds = new Set(stores.map(store => store.clientId))
  const productIds = new Set(data.products.filter(product => clientIds.has(product.clientId)).map(product => product.id))
  const namesByCode = new Map<string, Set<string>>()
  for (const cost of data.productCosts || []) {
    if (!productIds.has(cost.productId) || !cost.skuCode.trim()) continue
    const names = namesByCode.get(cost.skuCode.trim()) || new Set<string>()
    // A matched-but-blank name stays unknown rather than using an order's name.
    names.add(cost.specification.trim()); namesByCode.set(cost.skuCode.trim(), names)
  }
  const shortName = (code: string) => {
    const names = namesByCode.get(code)
    if (!names || !names.size || names.size === 1 && names.has('')) return '未设置简称'
    return names.size === 1 ? [...names][0] : '简称待核对'
  }
  const inRange = (date: string) => (!filter.startDate || date >= filter.startDate) && (!filter.endDate || date <= filter.endDate)
  const orderKey = (storeId: string, orderId: string) => JSON.stringify([storeId, orderId])
  const unshipped = new Set((data.orderAccountingLedgers || []).flatMap(ledger => ledger.refunds
    .filter(refund => refund.success && refund.stage === '未发货')
    .map(refund => orderKey(ledger.storeId, refund.orderId))))
  const indexed = new Set<string>()
  const groups = new Map<string, SpecSalesRow>()
  const issues = new Map<string, Map<string, number>>()
  const diagnostics: SpecSalesIssue[] = []
  const issue = (storeId: string, reason: string, context: Omit<SpecSalesIssue, 'storeId' | 'reason'>) => {
    const reasons = issues.get(storeId) || new Map<string, number>()
    reasons.set(reason, (reasons.get(reason) || 0) + 1)
    issues.set(storeId, reasons)
    diagnostics.push({ storeId, reason, ...context })
  }
  // The order index is normally unique; keep repeated persisted entries from
  // being counted twice without changing its storage/deduplication rules.
  const orders = new Map(getLinkSalesOrders(data).map(order => [orderKey(order.storeId, order.orderId), order]))
  for (const [id, order] of orders) {
    indexed.add(id)
    if (!storeIds.has(order.storeId) || order.supplement || /取消|未成交|待付款|未付款|待支付/.test(order.status)) continue
    if (unshipped.has(id) || order.status.includes('未发货') && order.status.includes('退款成功')) continue
    const dateKnown = !!order.date && linkDate(order.date) === order.date
    if (dateKnown && !inRange(order.date!)) continue
    const context = { skuCode: order.skuCode?.trim(), date: dateKnown ? order.date! : undefined, orderId: order.orderId }
    if (!/已发货|未发货|已收货|已完成|已签收|已成交|待发货|待收货|待评价|交易成功|退款成功/.test(order.status) || order.conflict) {
      issue(order.storeId, '订单状态或商品关联待核对', context); continue
    }
    if (!context.skuCode) {
      issue(order.storeId, '缺少规格维度编码，需补导原订单报表', context); continue
    }
    const skuCode = context.skuCode
    // Reporting groups by exact code across the selected client's stores.
    // Order deduplication and refund lookup above remain store-scoped.
    const key = JSON.stringify([skuCode])
    const group = groups.get(key) || { key, skuCode, specification: shortName(skuCode), quantity: 0 }
    const quantityKnown = typeof order.quantity === 'number' && Number.isSafeInteger(order.quantity) && order.quantity >= 0
    const blocked = { ...context, blocksQuantity: true }
    if (!dateKnown) issue(order.storeId, '缺少有效支付日期，无法确定统计范围', blocked)
    if (!quantityKnown) issue(order.storeId, '缺少有效整数件数', blocked)
    group.quantity = !dateKnown || !quantityKnown || group.quantity === null ? null : group.quantity + order.quantity!
    if (group.quantity !== null && !Number.isSafeInteger(group.quantity)) { group.quantity = null; issue(order.storeId, '件数超出可精确统计范围，请核对原报表件数', blocked) }
    groups.set(key, group)
  }
  const ledgerDates = new Set<string>()
  for (const ledger of data.orderAccountingLedgers || []) {
    if (!storeIds.has(ledger.storeId)) continue
    for (const order of ledger.orders) {
      ledgerDates.add(JSON.stringify([ledger.storeId, order.date]))
      if (order.cancelled || order.supplement || !inRange(order.date) || unshipped.has(orderKey(ledger.storeId, order.id))) continue
      if (!indexed.has(orderKey(ledger.storeId, order.id))) issue(ledger.storeId, '历史订单缺少规格明细，需补导原订单报表', { date: order.date, orderId: order.id })
    }
  }
  const uncoveredDates = new Set<string>()
  for (const record of data.collectionRecords) {
    const key = JSON.stringify([record.storeId, record.date])
    if (storeIds.has(record.storeId) && inRange(record.date) && record.orderCount > 0 && !ledgerDates.has(key)) uncoveredDates.add(key)
  }
  for (const key of uncoveredDates) {
    const [storeId, date] = JSON.parse(key) as [string, string]
    issue(storeId, '历史汇总日期缺少逐单记录，需补导原订单报表（天）', { date })
  }
  const rows = [...groups.values()].sort((a, b) => a.skuCode.localeCompare(b.skuCode, 'zh-CN'))
  const warnings = stores.flatMap(store => {
    const messages = [...(issues.get(store.id) || [])].map(([reason, count]) => `${reason}：${count}`)
    return messages.map(message => `${store.name}：${message}`)
  })
  return { rows, warnings, diagnostics, complete: issues.size === 0 }
}
