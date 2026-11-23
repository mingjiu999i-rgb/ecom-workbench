import type { CollectionRecord, ProfitRecord, WorkbenchData } from '../types/models'
import type { SettlementExportOptions } from './settlementWorkbook'
import { normalizeCollectionRefunds } from './collectionRefunds'
import { getLinkSalesOrders } from './linkSales'

export type SettlementMetricCheck = {
  key: 'sales' | 'cost' | 'promotion'; label: string
  daily: number | null; products: number | null; difference: number | null; flagged: boolean
}
export type SettlementDayDiagnostic = {
  id: string; storeId: string; storeName: string; date: string
  missingProducts: boolean; mismatch: boolean; legacyRefund: boolean; productRows: number
  metrics: SettlementMetricCheck[]
  unassignedOrders: Array<{ id: string; amount: number | null; supplement: boolean; goodsId: string | null; missingProduct: boolean }>
  unassignedOriginalAmount: number | null
  supplementMatchesSalesGap: boolean
  dailyUpdatedAt: string | null; productsUpdatedAt: string | null
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100
// Mirror the existing export check only to locate its evidence. Its trigger,
// tolerance and blocking/export decisions remain in settlementWorkbook.ts.
const exportSum = (rows: ProfitRecord[], get: (row: ProfitRecord) => number) => round(rows.reduce((total, row) => total + Number(get(row) || 0), 0))
const knownSum = (rows: ProfitRecord[], get: (row: ProfitRecord) => number) => rows.length && rows.every(row => finite(get(row))) ? round(rows.reduce((total, row) => total + get(row), 0)) : null
const identity = (storeId: string, date: string) => JSON.stringify([storeId, date])

// Read-only evidence from already saved results and indexes. Never repair,
// infer product ownership, recalculate settlement profit or write records here.
export function settlementDiagnostics(data: WorkbenchData, options: SettlementExportOptions): SettlementDayDiagnostic[] {
  const stores = data.stores.filter(row => row.clientId === options.clientId && row.storeStatus !== '暂停')
  const storeNames = new Map(stores.map(row => [row.id, row.name]))
  const inRange = (row: { storeId: string; date: string }) => storeNames.has(row.storeId) && (!options.startDate || row.date >= options.startDate) && (!options.endDate || row.date <= options.endDate)
  const profits = new Map<string, ProfitRecord[]>()
  data.profitRecords.filter(inRange).forEach(row => { const key = identity(row.storeId, row.date); profits.set(key, [...(profits.get(key) || []), row]) })
  const ledgers = new Map((data.orderAccountingLedgers || []).map(row => [row.storeId, row]))
  const products = new Set((data.products || []).map(row => row.id))
  const listingOrders = new Map(getLinkSalesOrders(data).map(row => [JSON.stringify([row.storeId, row.orderId]), row]))
  return normalizeCollectionRefunds(data.collectionRecords).filter(inRange).flatMap(row => {
    const productRows = profits.get(identity(row.storeId, row.date)) || []
    const needsProductCheck = Boolean(row.effectiveSales || row.productCost || row.promotionFee)
    const fields: Array<{ key: SettlementMetricCheck['key']; label: string; daily: keyof CollectionRecord; product: keyof ProfitRecord }> = [
      { key: 'sales', label: '有效销售额', daily: 'effectiveSales', product: 'amount' },
      { key: 'cost', label: '商品成本', daily: 'productCost', product: 'cost' },
      { key: 'promotion', label: '推广费', daily: 'promotionFee', product: 'promotion' },
    ]
    const metrics = fields.map(field => {
      const saved = row[field.daily], daily = finite(saved) ? saved : null
      const get = (product: ProfitRecord) => product[field.product] as number
      const total = knownSum(productRows, get)
      const comparison = field.key === 'cost' ? Number(row.productCost || 0) : saved as number
      return { key: field.key, label: field.label, daily, products: total,
        difference: daily != null && total != null ? round(total - daily) : null,
        flagged: needsProductCheck && (!productRows.length || Math.abs(exportSum(productRows, get) - comparison) > .02),
      }
    })
    const mismatch = needsProductCheck && (!productRows.length || metrics.some(metric => metric.flagged))
    const legacyRefund = row.refundBasis !== 'order_paid_at'
    if (!mismatch && !legacyRefund) return []
    const ledger = ledgers.get(row.storeId)
    const unshipped = new Set((ledger?.refunds || []).filter(refund => refund.success && refund.stage === '未发货').map(refund => refund.orderId))
    const unassignedOrders = (ledger?.orders || []).filter(order => order.date === row.date && !order.cancelled && !unshipped.has(order.id) && (!order.productId || !products.has(order.productId))).map(order => {
      const listing = listingOrders.get(JSON.stringify([row.storeId, order.id]))
      return { id: order.id, amount: finite(order.receipt) ? order.receipt : null, supplement: order.supplement,
        goodsId: listing && !listing.conflict && listing.goodsId ? listing.goodsId : null, missingProduct: Boolean(order.productId),
      }
    })
    const unassignedOriginalAmount = unassignedOrders.length && unassignedOrders.every(order => order.amount != null) ? round(unassignedOrders.reduce((total, order) => total + order.amount!, 0)) : null
    const sales = metrics.find(metric => metric.key === 'sales')!
    const supplementMatchesSalesGap = unassignedOrders.length > 0 && unassignedOrders.every(order => order.supplement) && sales.difference != null && sales.difference < 0 && unassignedOriginalAmount != null && round(-sales.difference) === unassignedOriginalAmount
    return [{ id: `${identity(row.storeId, row.date)}|${row.id}`, storeId: row.storeId, storeName: storeNames.get(row.storeId)!, date: row.date,
      missingProducts: mismatch && !productRows.length, mismatch, legacyRefund, productRows: productRows.length, metrics,
      unassignedOrders, unassignedOriginalAmount, supplementMatchesSalesGap,
      dailyUpdatedAt: row.updatedAt || null, productsUpdatedAt: productRows.map(item => item.updatedAt).filter(Boolean).sort().at(-1) || null,
    }]
  }).sort((a, b) => a.storeName.localeCompare(b.storeName, 'zh-CN') || b.date.localeCompare(a.date))
}
