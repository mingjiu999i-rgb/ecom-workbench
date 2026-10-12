import type { CollectionRecord, ProfitRecord } from '../types/models'
import { isSupplementOrder, type ProductCostMatch } from './orderCostMatching'

export type Order = { id: string; shop: string; payTime: string; payDate: string; receipt: number; status: string; productId: string; product: string; specification: string; skuCode: string; quantity: number }
export type Refund = { id: string; orderId: string; shop: string; status: string; stage: string; refundAmount: number; appliedAt: string; approvedAt: string; refundDate: string }
export type FundCategory = 'positive' | 'refund' | 'other' | 'transfer' | 'promotion' | 'unknown'
export type Fund = { key: string; orderId: string; shop: string; occurredAt: string; income: number; expense: number; accountType: string; businessCode: string; businessName: string; businessDescription: string; category: FundCategory }
export type Promotion = { key: string; shop: string; date: string; amount: number }
export type Summary = { shop: string; date: string; orderCount: number; originalSales: number; effectiveSales: number; shippedRefund: number; orderShippedRefund: number; couponRefund: number; basicServiceFee: number; afterSaleCompensation: number; smallPayment: number; appealReimbursement: number; productCost: number | null; promotionFee: number; estimatedProfit: number | null; currentNet: number; unsettledAmount: number; profit: number | null; eligibleOrders: number; settledOrders: number; completionRate: number; mature: boolean; missingCostOrders: number; unknownFunds: number }
export type ProductMetric = { date: string; productId: string; product: string; rate: number; amount: number; cost: number; grossProfit: number; promotion: number; operationFee: number; estimatedProfit: number; quantity: number; margin: number }

const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100

function actualShippedRefunds(shipped: Set<string>, funds: Fund[]) {
  const principal = new Map<string, number>()
  const coupon = new Map<string, number>()
  funds.filter(fund => shipped.has(fund.orderId) && fund.category === 'refund').forEach(fund => {
    const amounts = fund.businessCode === '0020005' ? coupon : principal
    amounts.set(fund.orderId, (amounts.get(fund.orderId) || 0) - fund.income - fund.expense)
  })
  return { principal, coupon }
}

export function calculateSummaries(orders: Order[], refunds: Refund[], funds: Fund[], promotions: Promotion[], resolveCost: (order: Order) => ProductCostMatch | undefined, savedRecords: CollectionRecord[] = []): Summary[] {
  const days = [...new Set(orders.filter(order => order.payDate).map(order => `${order.shop}|${order.payDate}`))].sort().reverse()
  return days.map(key => {
    const split = key.indexOf('|'); const shop = key.slice(0, split); const date = key.slice(split + 1)
    const dayOrders = orders.filter(o => o.shop === shop && o.payDate === date); const ids = new Set(dayOrders.map(o => o.id))
    const dayRefunds = refunds.filter(r => r.shop === shop && ids.has(r.orderId) && r.status === '退款成功')
    const unshipped = new Set(dayRefunds.filter(r => r.stage === '未发货').map(r => r.orderId)); const shipped = new Set(dayRefunds.filter(r => r.stage === '已发货' && !unshipped.has(r.orderId)).map(r => r.orderId))
    const validOrders = dayOrders.filter(o => !unshipped.has(o.id) && !o.status.includes('取消')); const eligible = new Set(validOrders.map(o => o.id))
    const dayFunds = funds.filter(f => f.shop === shop && ids.has(f.orderId)); const original = validOrders.reduce((n, o) => n + o.receipt, 0)
    const { principal: shippedRefundByOrder, coupon: shippedCouponRefundByOrder } = actualShippedRefunds(shipped, dayFunds)
    const orderShippedRefund = [...shippedRefundByOrder.values()].reduce((n, value) => n + value, 0)
    const couponRefund = [...shippedCouponRefundByOrder.values()].reduce((n, value) => n + value, 0); const effective = original - orderShippedRefund - couponRefund
    const positive = new Set(dayFunds.filter(f => f.category === 'positive' && f.income > 0).map(f => f.orderId))
    const unsettledAmount = dayOrders.filter(o => eligible.has(o.id) && !positive.has(o.id)).reduce((n, o) => n + Math.max(0, o.receipt - (shippedRefundByOrder.get(o.id) || 0) - (shippedCouponRefundByOrder.get(o.id) || 0)), 0)
    const currentNet = dayFunds.filter(f => ['positive', 'refund', 'other'].includes(f.category)).reduce((n, f) => n + f.income + f.expense, 0)
    const basicServiceFee = dayFunds.filter(f => f.businessCode === '0030002' && f.expense < 0).reduce((n, f) => n + Math.abs(f.expense), 0)
    const afterSaleCompensation = dayFunds.filter(f => f.businessCode === '0040002' && f.expense < 0).reduce((n, f) => n + Math.abs(f.expense), 0)
    const smallPayment = dayFunds.filter(f => f.businessCode === '0040001' && f.expense < 0).reduce((n, f) => n + Math.abs(f.expense), 0)
    const appealReimbursement = dayFunds.filter(f => f.businessCode === '0130005' && f.income > 0).reduce((n, f) => n + f.income, 0)
    let productCost = 0; let missing = 0
    validOrders.filter(order => !isSupplementOrder(order)).forEach(order => { const match = resolveCost(order); if (!match) missing += 1; else productCost += match.cost * order.quantity })
    const dayPromotions = promotions.filter(p => p.shop === shop && p.date === date)
    const promotionFee = dayPromotions.length ? dayPromotions.reduce((n, p) => n + p.amount, 0) : savedRecords.find(record => record.date === date)?.promotionFee ?? 0
    const settled = [...eligible].filter(id => positive.has(id)).length
    return { shop, date, orderCount: dayOrders.length, originalSales: round(original), effectiveSales: round(effective), shippedRefund: round(orderShippedRefund), orderShippedRefund: round(orderShippedRefund), couponRefund: round(couponRefund), basicServiceFee: round(basicServiceFee), afterSaleCompensation: round(afterSaleCompensation), smallPayment: round(smallPayment), appealReimbursement: round(appealReimbursement), productCost: missing ? null : round(productCost), promotionFee: round(promotionFee), estimatedProfit: missing ? null : round(effective - productCost - promotionFee), currentNet: round(currentNet), unsettledAmount: round(unsettledAmount), profit: missing ? null : round(currentNet - productCost - promotionFee), eligibleOrders: eligible.size, settledOrders: settled, completionRate: eligible.size ? settled / eligible.size : 1, mature: settled === eligible.size, missingCostOrders: missing, unknownFunds: dayFunds.filter(f => f.category === 'unknown').length }
  })
}

export function calculateProductMetrics(orders: Order[], refunds: Refund[], funds: Fund[], promotions: Promotion[], resolveCost: (order: Order) => ProductCostMatch | undefined, linkedProductId: (order: Order) => string, products: Array<{ id: string; name: string; operationRate: number }>, savedRecords: CollectionRecord[] = [], savedProfits: ProfitRecord[] = []): ProductMetric[] {
  const rows = new Map<string, ProductMetric>()
  const days = [...new Set(orders.filter(order => order.payDate).map(order => order.payDate))]
  days.forEach(date => {
    const dayOrders = orders.filter(order => order.payDate === date)
    const ids = new Set(dayOrders.map(order => order.id))
    const dayRefunds = refunds.filter(refund => ids.has(refund.orderId) && refund.status === '退款成功')
    const unshipped = new Set(dayRefunds.filter(refund => refund.stage === '未发货').map(refund => refund.orderId))
    const shipped = new Set(dayRefunds.filter(refund => refund.stage === '已发货' && !unshipped.has(refund.orderId)).map(refund => refund.orderId))
    const validOrders = dayOrders.filter(order => !unshipped.has(order.id) && !order.status.includes('取消'))
    const dayFunds = funds.filter(fund => ids.has(fund.orderId))
    const { principal: shippedRefund, coupon: couponRefund } = actualShippedRefunds(shipped, dayFunds)
    const eligibleIds = new Set(validOrders.map(order => order.id))
    // Keep a zero-sales product row for cancelled/unshipped-refunded orders so
    // the day's fixed promotion spend still appears in product profit.
    dayOrders.forEach(order => {
      const supplement = isSupplementOrder(order)
      const match = supplement ? undefined : resolveCost(order)
      const productId = match?.productId || linkedProductId(order)
      const product = products.find(item => item.id === productId)
      if (!product) return
      const key = `${date}|${productId}`
      const current = rows.get(key) || { date, productId, product: product.name, rate: Number(product.operationRate || 0), amount: 0, cost: 0, grossProfit: 0, promotion: 0, operationFee: 0, estimatedProfit: 0, quantity: 0, margin: 0 }
      if (eligibleIds.has(order.id)) {
        current.amount += order.receipt - (shippedRefund.get(order.id) || 0) - (couponRefund.get(order.id) || 0)
        if (!supplement && match) { current.cost += match.cost * order.quantity; current.quantity += order.quantity }
      }
      rows.set(key, current)
    })
    const dayRows = [...rows.values()].filter(row => row.date === date)
    const dayPromotions = promotions.filter(item => item.date === date && item.shop === dayOrders[0]?.shop)
    const dailyPromotion = dayPromotions.length ? dayPromotions.reduce((total, item) => total + item.amount, 0) : savedRecords.find(record => record.date === date)?.promotionFee ?? 0
    const previousRows = savedProfits.filter(row => row.date === date)
    const preserveAllocation = previousRows.length === dayRows.length && dayRows.every(row => previousRows.some(previous => previous.productId === row.productId)) && Math.abs(previousRows.reduce((total, row) => total + row.promotion, 0) - dailyPromotion) < 0.005
    const dailyAmount = dayRows.reduce((total, row) => total + row.amount, 0)
    let assigned = 0
    dayRows.forEach((row, index) => {
      row.promotion = preserveAllocation ? previousRows.find(previous => previous.productId === row.productId)!.promotion : index === dayRows.length - 1 ? round(dailyPromotion - assigned) : round(dailyPromotion * (dailyAmount ? row.amount / dailyAmount : 1 / dayRows.length))
      assigned = round(assigned + row.promotion)
    })
  })
  return [...rows.values()].map(row => {
    const amount = round(row.amount), cost = round(row.cost), promotion = round(row.promotion)
    const grossProfit = round(amount - cost), operationFee = round(amount * row.rate), estimatedProfit = round(grossProfit - promotion - operationFee)
    return { ...row, amount, cost, grossProfit, promotion, operationFee, estimatedProfit, quantity: round(row.quantity), margin: amount ? estimatedProfit / amount : 0 }
  }).sort((a, b) => b.date.localeCompare(a.date) || a.product.localeCompare(b.product, 'zh-CN'))
}
