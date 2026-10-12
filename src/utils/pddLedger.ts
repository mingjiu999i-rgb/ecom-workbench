import type { CollectionRecord, OrderAccountingLedger, ProfitRecord } from '../types/models'
import { isSupplementOrder, type ProductCostMatch } from './orderCostMatching'
import { calculateProductMetrics, calculateSummaries, type Fund, type Order, type Promotion, type Refund } from './pddCalculations'

// Store a fingerprint for deduplication, never the signature's original remarks
// or business descriptions. The ordinal retains identical but distinct rows.
export function reportFingerprint(value: string): string {
  let hash = 14695981039346656037n
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 1099511628211n)
  }
  return hash.toString(16)
}

type Input = {
  storeId: string; shop: string; previous?: OrderAccountingLedger
  orders: Order[]; refunds: Refund[]; funds: Fund[]; promotions: Promotion[]
  reportTypes: Set<string>
  savedRecords: CollectionRecord[]; savedProfits: ProfitRecord[]
  resolveCost: (order: Order) => ProductCostMatch | undefined
  linkedProductId: (order: Order) => string
  products: Array<{ id: string; name: string; operationRate: number }>
}

export function preparePddAccounting(input: Input) {
  const { storeId, shop, previous, savedRecords, savedProfits } = input
  const previousOrders = new Map((previous?.orders || []).map(order => [order.id, order]))
  const orders = new Map(previousOrders)
  input.orders.filter(order => order.payDate).forEach(order => {
    const existing = orders.get(order.id)
    const match = input.resolveCost(order)
    const supplement = isSupplementOrder(order)
    orders.set(order.id, {
      id: order.id, date: order.payDate, receipt: order.receipt, cancelled: order.status.includes('取消'),
      quantity: order.quantity, productId: existing?.productId || match?.productId || input.linkedProductId(order),
      // A matched order keeps its first imported unit cost, including zero.
      // Later SKU edits apply only to orders that do not yet have a snapshot.
      unitCost: supplement ? 0 : existing?.unitCost ?? match?.cost ?? null, supplement,
    })
  })
  const refunds = new Map((previous?.refunds || []).map(refund => [refund.id, refund]))
  input.refunds.forEach(refund => refunds.set(refund.id, {
    id: refund.id, orderId: refund.orderId, success: refund.status === '退款成功', stage: refund.stage, amount: refund.refundAmount,
  }))
  const funds = new Map((previous?.funds || []).map(fund => [fund.key, fund]))
  input.funds.forEach(fund => funds.set(fund.key, {
    key: fund.key, orderId: fund.orderId, income: fund.income, expense: fund.expense, businessCode: fund.businessCode, category: fund.category,
  }))
  const promotionAmounts = new Map((previous?.promotions || []).map(promotion => [promotion.date, promotion.amount]))
  const incomingPromotionAmounts = new Map<string, number>()
  input.promotions.forEach(promotion => incomingPromotionAmounts.set(promotion.date, (incomingPromotionAmounts.get(promotion.date) || 0) + promotion.amount))
  incomingPromotionAmounts.forEach((amount, date) => promotionAmounts.set(date, amount))
  const initialized = new Set(previous?.initializedDates || [])
  const indexedCounts = new Map<string, number>()
  orders.forEach(order => indexedCounts.set(order.date, (indexedCounts.get(order.date) || 0) + 1))
  const positiveByDate = new Map<string, Set<string>>()
  funds.forEach(fund => {
    const date = orders.get(fund.orderId)?.date
    if (!date || fund.category !== 'positive' || fund.income <= 0) return
    const ids = positiveByDate.get(date) || new Set<string>()
    ids.add(fund.orderId)
    positiveByDate.set(date, ids)
  })
  indexedCounts.forEach((count, date) => {
    const saved = savedRecords.find(row => row.date === date)
    // A legacy aggregate has no order/transaction index. Initialize it once
    // from complete source reports before replacing any of its financial data.
    const baselineCovered = !saved || (count >= saved.orderCount
      && (positiveByDate.get(date)?.size || 0) >= saved.settledOrders
      && ['orders', 'refunds', 'funds'].every(type => input.reportTypes.has(type)))
    if (baselineCovered) initialized.add(date)
  })
  const ledger: OrderAccountingLedger = { storeId, initializedDates: [...initialized].sort(), orders: [...orders.values()], refunds: [...refunds.values()], funds: [...funds.values()], promotions: [...promotionAmounts].map(([date, amount]) => ({ date, amount })) }

  const touched = new Set<string>()
  const touch = (orderId: string) => { const order = orders.get(orderId); if (order) touched.add(order.date) }
  input.orders.forEach(order => { touch(order.id); const old = previousOrders.get(order.id); if (old) touched.add(old.date) })
  input.refunds.forEach(refund => touch(refund.orderId))
  input.funds.forEach(fund => touch(fund.orderId))
  input.promotions.forEach(promotion => touched.add(promotion.date))
  // Pending refunds/funds become effective when their missing order arrives.
  const blockedDates = [...touched].filter(date => indexedCounts.has(date) && !initialized.has(date))
  const readyDates = new Set([...touched].filter(date => initialized.has(date)))
  const runtimeOrders: Order[] = ledger.orders.filter(order => readyDates.has(order.date)).map(order => ({
    id: order.id, shop, payTime: order.date, payDate: order.date, receipt: order.receipt,
    status: order.cancelled ? '已取消' : '', productId: order.productId,
    product: order.supplement ? '补收差价' : '', specification: '', skuCode: '', quantity: order.quantity,
  }))
  const runtimeRefunds: Refund[] = ledger.refunds.map(refund => ({
    id: refund.id, orderId: refund.orderId, shop, status: refund.success ? '退款成功' : '', stage: refund.stage,
    refundAmount: refund.amount, appliedAt: '', approvedAt: '', refundDate: '',
  }))
  const runtimeFunds: Fund[] = ledger.funds.map(fund => ({ ...fund, shop, occurredAt: '', accountType: '', businessName: '', businessDescription: '' }))
  const resolveCost = (order: Order): ProductCostMatch | undefined => {
    const saved = orders.get(order.id)
    if (!saved || saved.unitCost == null) return undefined
    return { cost: saved.unitCost, productId: saved.productId, product: input.products.find(product => product.id === saved.productId)?.name || '', specification: '', skuCode: '', source: 'SKU 编码' }
  }
  const runtimePromotions: Promotion[] = ledger.promotions.map(promotion => ({ ...promotion, key: promotion.date, shop }))
  const summaries = calculateSummaries(runtimeOrders, runtimeRefunds, runtimeFunds, runtimePromotions, resolveCost, savedRecords)
  const productMetrics = calculateProductMetrics(runtimeOrders, runtimeRefunds, runtimeFunds, runtimePromotions, resolveCost, order => orders.get(order.id)?.productId || '', input.products, savedRecords, savedProfits)
  const unmatchedRefunds = ledger.refunds.filter(refund => refund.success && !orders.has(refund.orderId)).length
  const unmatchedFunds = ledger.funds.filter(fund => !orders.has(fund.orderId) && !['transfer', 'promotion'].includes(fund.category)).length
  const refundFundOrders = new Set(ledger.funds.filter(fund => fund.category === 'refund').map(fund => fund.orderId))
  const pendingRefundFunds = new Set(ledger.refunds.filter(refund => refund.success && refund.stage === '已发货' && orders.has(refund.orderId) && !refundFundOrders.has(refund.orderId)).map(refund => refund.orderId)).size
  return { ledger, summaries, productMetrics, readyDates, blockedDates, unmatchedRefunds, unmatchedFunds, pendingRefundFunds }
}
