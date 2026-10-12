import type { CollectionRecord } from '../types/models'

// The previous version stored both refund-date and order-date totals. Only the
// latter can safely be used to repair a saved daily row without its source files.
export function normalizeCollectionRefunds(records: CollectionRecord[]): CollectionRecord[] {
  return records.flatMap(record => {
    if (record.refundBasis !== 'refund_completed_at' || !Number.isFinite(record.orderShippedRefund)) return [record]
    const repaired = { ...record, shippedRefund: record.orderShippedRefund!, refundBasis: 'order_paid_at' as const }
    // Old refund activity could create an otherwise empty day with no orders.
    const values = [record.orderCount, record.originalSales, record.effectiveSales, repaired.shippedRefund,
      record.couponRefund, record.productCost, record.promotionFee, record.currentNet,
      record.basicServiceFee, record.afterSaleCompensation, record.smallPayment, record.appealReimbursement]
    return values.every(value => value === 0) ? [] : [repaired]
  })
}
