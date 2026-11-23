import type { CollectionRecord, ProfitRecord, WorkbenchData } from '../types/models'
import type { preparePddAccounting } from './pddLedger'

export type ProfitBaseline = {
  id: string
  storeId: string
  date: string
  recordedAt: string
  orderCount: number
  collectionProfit: number
  products: Array<{ productId: string; estimatedProfit: number }>
}

type CaptureInput = {
  storeId: string
  orderDates: Set<string>
  reportTypes: Set<string>
  accounting: ReturnType<typeof preparePddAccounting>
  recordedAt: string
}
const key = (row: { storeId: string; date: string }) => JSON.stringify([row.storeId, row.date])
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100

// Record an independent display snapshot only. Never feed it back into orders,
// refunds, costs, promotion allocation, collections or profit rows.
export function captureProfitBaselines(data: WorkbenchData, input: CaptureInput): ProfitBaseline[] {
  // A real successful import may contain only a new day's orders, or only a
  // later adjustment. Reuse its existing ledger/cost/promotion context instead
  // of requiring four files in the same batch or a refund-free starting point.
  if (!['orders', 'refunds', 'funds', 'promotions'].some(type => input.reportTypes.has(type))) return []
  const existing = new Set((data.profitBaselines || []).map(key))
  const promotionDates = new Set(input.accounting.ledger.promotions.map(row => row.date))
  const { orders, refunds, funds } = input.accounting.ledger
  const unshipped = new Set(refunds.filter(row => row.success && row.stage === '未发货').map(row => row.orderId))
  const shipped = new Set(refunds.filter(row => row.success && row.stage === '已发货' && !unshipped.has(row.orderId)).map(row => row.orderId))
  const orderIndex = new Map(orders.map(row => [row.id, row]))
  const productRefunds = new Map<string, number>()
  funds.filter(row => row.category === 'refund' && row.businessCode !== '0020005' && shipped.has(row.orderId)).forEach(fund => {
    const order = orderIndex.get(fund.orderId)
    if (!order || order.cancelled) return
    const productKey = JSON.stringify([order.date, order.productId])
    productRefunds.set(productKey, (productRefunds.get(productKey) || 0) - fund.income - fund.expense)
  })
  return input.accounting.summaries.flatMap(summary => {
    const identity = { storeId: input.storeId, date: summary.date }
    const saved = data.collectionRecords.find(row => row.storeId === input.storeId && row.date === summary.date)
    const promotionKnown = promotionDates.has(summary.date) || (saved && Number.isFinite(saved.promotionFee)
      && (!('promotionFeeKnown' in saved) || saved.promotionFeeKnown !== false)
      && (saved.promotionFee > 0 || ('promotionFeeKnown' in saved && saved.promotionFeeKnown === true)))
    if (existing.has(key(identity)) || !input.accounting.readyDates.has(summary.date) || !promotionKnown
      || summary.missingCostOrders || summary.estimatedProfit == null || !Number.isFinite(summary.estimatedProfit) || !Number.isFinite(summary.shippedRefund)) return []
    if (!saved || saved.refundBasis !== 'order_paid_at' || !Object.entries(summary).every(([field, value]) => field === 'shop' || saved[field as keyof CollectionRecord] === value)) return []
    const metrics = input.accounting.productMetrics.filter(row => row.date === summary.date)
    if (!metrics.length || metrics.some(metric => {
      const row = data.profitRecords.find(item => item.storeId === input.storeId && item.date === metric.date && item.productId === metric.productId)
      return !row || ![metric.estimatedProfit, metric.amount, metric.cost, metric.promotion, metric.rate].every(Number.isFinite) || ['amount', 'cost', 'grossProfit', 'promotion', 'operationFee', 'estimatedProfit', 'quantity', 'margin'].some(field => row[field as keyof ProfitRecord] !== metric[field as keyof typeof metric]) || row.operationRate !== metric.rate
    })) return []
    // Exclude shipped principal refunds from NEW initial snapshots, even when
    // the first import already contains them. Coupon/unshipped refunds retain
    // their existing treatment. Keep saved costs and promotion allocation;
    // product operation fees still use the existing rate on the initial amount.
    const products = metrics.map(row => {
      const refund = productRefunds.get(JSON.stringify([row.date, row.productId])) ?? 0
      const amount = round(row.amount + refund)
      return { productId: row.productId, estimatedProfit: round(round(amount - row.cost) - row.promotion - round(amount * row.rate)) }
    })
    if (products.some(row => !Number.isFinite(row.estimatedProfit))) return []
    return [{ ...identity, id: `profit-baseline-${key(identity)}`, recordedAt: input.recordedAt,
      orderCount: summary.orderCount, collectionProfit: round(summary.estimatedProfit + summary.shippedRefund), products,
    }]
  })
}

export function appendProfitBaselines(data: WorkbenchData, candidates: ProfitBaseline[]): WorkbenchData {
  const existing = new Set((data.profitBaselines || []).map(key))
  const added = candidates.filter(row => {
    if (existing.has(key(row))) return false
    existing.add(key(row)); return true
  })
  return added.length ? { ...data, profitBaselines: [...(data.profitBaselines || []), ...added] } : data
}

// Missing initial values stay unknown, including in mixed historical totals.
export function initialCollectionProfit(data: WorkbenchData, rows: Array<Pick<CollectionRecord, 'storeId' | 'date'>>): number | null {
  if (!rows.length) return null
  const index = new Map((data.profitBaselines || []).map(row => [key(row), row.collectionProfit]))
  const values = rows.map(row => index.get(key(row)))
  return values.every(value => typeof value === 'number' && Number.isFinite(value)) ? round((values as number[]).reduce((a, b) => a + b, 0)) : null
}

export function initialProductProfit(data: WorkbenchData, rows: Array<Pick<ProfitRecord, 'storeId' | 'date' | 'productId'>>): number | null {
  if (!rows.length) return null
  const index = new Map((data.profitBaselines || []).flatMap(row => row.products.map(product => [JSON.stringify([row.storeId, row.date, product.productId]), product.estimatedProfit] as const)))
  const values = rows.map(row => index.get(JSON.stringify([row.storeId, row.date, row.productId])))
  return values.every(value => typeof value === 'number' && Number.isFinite(value)) ? round((values as number[]).reduce((a, b) => a + b, 0)) : null
}

export function initialStoreProductProfit(data: WorkbenchData, rows: Array<Pick<CollectionRecord, 'storeId' | 'date'>>): number | null {
  if (!rows.length) return null
  const index = new Map((data.profitBaselines || []).map(row => [key(row), row]))
  const snapshots = rows.map(row => index.get(key(row)))
  if (snapshots.some(row => !row || !row.products.length || row.products.some(product => !Number.isFinite(product.estimatedProfit)))) return null
  return round(snapshots.reduce((total, row) => total + row!.products.reduce((subtotal, product) => subtotal + product.estimatedProfit, 0), 0))
}
