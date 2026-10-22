import type { WorkbenchData } from '../types/models'
import type { PendingDraft } from './workbenchSync'

export const storedSectionLabels: Record<string, string> = {
  clients: '甲方', stores: '店铺', products: '产品', productLinks: '商品链接', productCosts: '成本资料', skus: 'SKU',
  operations: '调整记录', skuHistory: 'SKU 历史', todos: '待办', profitRecords: '产品利润', collectionRecords: '经营结算汇总',
  linkSalesOrders: '商品 ID 独立索引', linkSalesPromotions: '商品 ID 推广费', skuPlanningDrafts: 'SKU 草稿',
  overviewRefundActivity: '总览退款观察记录', orders: '订单明细', refunds: '售后退款', funds: '资金流水', promotions: '账本推广费',
}
export const isStoredRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

// Validate structure only. Never normalize, backfill, deduplicate or calculate money.
export function readonlyDraftIssue(draft: PendingDraft<WorkbenchData>, userId: string): string {
  if (draft.userId !== userId) return '备份所属账号与当前账号不一致，不能查看。'
  if (!draft.id || !Number.isFinite(Date.parse(draft.updatedAt))) return '备份标识或时间无效，请保留原文件后核对。'
  if (!isStoredRecord(draft.data)) return '备份结构不兼容，请先导出原始备份。'
  const data = draft.data as unknown as Record<string, unknown>
  for (const key of ['clients', 'stores', 'products', 'productLinks', 'skus', 'collectionRecords', 'profitRecords']) {
    if (!Array.isArray(data[key])) return `备份缺少 ${storedSectionLabels[key]}，请先导出原始备份。`
  }
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) && !value.every(isStoredRecord)) return `${storedSectionLabels[key] || key} 的结构不兼容，请保留原始备份。`
  }
  if (data.orderAccountingLedgers !== undefined) {
    if (!Array.isArray(data.orderAccountingLedgers)) return '订单结算账本结构不兼容。'
    for (const ledger of data.orderAccountingLedgers) {
      if (typeof ledger.storeId !== 'string') return '账本缺少店铺标识，不能推算归属。'
      for (const key of ['orders', 'refunds', 'funds', 'promotions']) {
        if (ledger[key] !== undefined && (!Array.isArray(ledger[key]) || !ledger[key].every(isStoredRecord))) return '账本明细结构不兼容。'
      }
    }
  }
  return ''
}

export type StoredViewRow = { value: Record<string, unknown>; storeId?: string }
export function readonlyRows(data: WorkbenchData, section: string): StoredViewRow[] {
  if (['orders', 'refunds', 'funds', 'promotions'].includes(section)) {
    return (data.orderAccountingLedgers || []).flatMap(ledger => {
      const records = (ledger as unknown as Record<string, unknown>)[section]
      return Array.isArray(records) ? records.filter(isStoredRecord).map(value => ({ value, storeId: ledger.storeId })) : []
    })
  }
  const value = (data as unknown as Record<string, unknown>)[section]
  return Array.isArray(value) ? value.filter(isStoredRecord).map(value => ({ value, storeId: typeof value.storeId === 'string' ? value.storeId : undefined }))
    : isStoredRecord(value) ? [{ value }] : []
}

export function storedValue(value: unknown): string {
  if (value === undefined) return '未记录'
  if (value === null) return '未记录（null）'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value)) return `${value.length} 项（查看详情）`
  if (typeof value === 'object') return '查看详情'
  return String(value)
}
