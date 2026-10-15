import type { PendingDraft } from './workbenchSync'

// Compare JSON document contents, never key insertion order. Array order and
// actual values (including null versus zero) remain significant. No data is
// normalized, repaired, reordered or written by this comparison.
export function sameStoredDocument(left: unknown, right: unknown): boolean {
  if (typeof left === 'number' && !Number.isFinite(left)) left = null
  if (typeof right === 'number' && !Number.isFinite(right)) right = null
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index++) if (!sameStoredDocument(left[index] === undefined ? null : left[index], right[index] === undefined ? null : right[index])) return false
    return true
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const a = left as Record<string, unknown>, b = right as Record<string, unknown>
    const keysA = Object.keys(a).filter(key => a[key] !== undefined)
    const keysB = Object.keys(b).filter(key => b[key] !== undefined)
    return keysA.length === keysB.length && keysA.every(key => Object.prototype.hasOwnProperty.call(b, key) && sameStoredDocument(a[key], b[key]))
  }
  return false
}

const labels: Record<string, string> = {
  clients: '甲方资料', stores: '店铺资料', products: '产品资料', productLinks: '商品链接',
  productCosts: '成本资料', skus: '商品 SKU', operations: '调整记录', skuHistory: 'SKU 历史',
  todos: '待办事项', profitRecords: '产品利润记录', collectionRecords: '经营结算汇总',
  orderAccountingLedgers: '订单结算账本', overviewRefundActivity: '总览退款观察记录', skuPlanningDrafts: 'SKU 草稿',
}
export function recoveryDifferences(local: unknown, cloud: unknown) {
  const a = local && typeof local === 'object' ? local as Record<string, unknown> : {}
  const b = cloud && typeof cloud === 'object' ? cloud as Record<string, unknown> : {}
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(key => !sameStoredDocument(a[key], b[key]))
    .map(key => ({ key, label: labels[key] || key, localCount: Array.isArray(a[key]) ? a[key].length : null,
      cloudCount: Array.isArray(b[key]) ? b[key].length : null }))
}
export const isResolvedDraft = (draft: PendingDraft<unknown>) => draft.resolution === 'cloud-saved' || draft.resolution === 'kept-cloud'
export function inspectWorkbenchRecovery(local: PendingDraft<unknown> | null, storedCloudData: unknown) {
  if (!local) return { action: 'none' as const, differences: [] }
  if (isResolvedDraft(local)) return { action: 'cleanup' as const, differences: [] }
  if (sameStoredDocument(local.data, storedCloudData)) return { action: 'cleanup' as const, differences: [] }
  return { action: 'recover' as const, differences: recoveryDifferences(local.data, storedCloudData) }
}
