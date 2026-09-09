import type { AdjustmentType, Operation, Sku, WorkbenchData } from '../types/models'

const trackedFields: Array<{ key: keyof Sku; type: AdjustmentType }> = [
  { key: 'name', type: 'SKU' },
  { key: 'salePrice', type: '售价' },
  { key: 'finalPrice', type: '到手价' },
  { key: 'productCost', type: '成本' },
  { key: 'activity', type: '活动' },
  { key: 'activityPrice', type: '活动价' },
]

export function createSkuChangeOperations(data: WorkbenchData, before: Sku | undefined, after: Sku, source: string): Operation[] {
  if (!before) return []
  const link = data.productLinks.find(item => item.id === after.productLinkId)
  if (!link) return []
  const createdAt = new Date().toISOString()
  return trackedFields.flatMap(({ key, type }) => before[key] === after[key] ? [] : [{
    id: crypto.randomUUID(), createdAt,
    clientId: link.clientId, storeId: link.storeId, productId: link.productId,
    productLinkId: link.id, skuId: after.id, type,
    before: String(before[key] ?? ''), after: String(after[key] ?? ''),
    reason: '手动修改' as const, remark: source,
  }])
}
