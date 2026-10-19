import type { WorkbenchData } from '../types/models'
import { getOverviewRefundActivity, observeOverviewRefunds, overviewDay, type OverviewRefundActivity } from './overviewRefundActivity'
import type { LinkSalesOrder, LinkPromotion } from './linkSales'
import { sameStoredDocument } from './workbenchRecovery'

type BusinessData = WorkbenchData & {
  linkSalesOrders?: LinkSalesOrder[]; linkSalesPromotions?: LinkPromotion[]; overviewRefundActivity?: OverviewRefundActivity
}
const fields = ['collectionRecords', 'profitRecords', 'orderAccountingLedgers', 'linkSalesOrders', 'linkSalesPromotions'] as const
type BusinessField = typeof fields[number]
type Scope = Pick<BusinessData, BusinessField> & { overview?: {
  balances: OverviewRefundActivity['balances']; changes: OverviewRefundActivity['changes']
  openingDate: string | null; openingBalances: OverviewRefundActivity['balances']
} }
export type StoreBusinessBackup = {
  kind: 'ecom-store-business-backup'; version: 1; createdAt: string; account: string
  store: { id: string; name: string; clientId: string }; scope: Scope
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
const numeric = (value: Record<string, unknown>, keys: string[], nullable = false) => keys.every(key => finite(value[key]) || nullable && value[key] === null)
const strings = (value: Record<string, unknown>, keys: string[]) => keys.every(key => typeof value[key] === 'string')
const date = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
const array = (value: unknown, predicate: (row: Record<string, unknown>) => boolean) => Array.isArray(value) && value.every(row => object(row) && predicate(row))

function storeFor(data: WorkbenchData, storeId: string) {
  const stores = data.stores.filter(row => row.id === storeId)
  if (!storeId || stores.length !== 1) throw new Error('请选择一个有效店铺，不能清理全部店铺。')
  return stores[0]
}
function scopeFor(data: WorkbenchData, storeId: string): Scope {
  storeFor(data, storeId)
  const extended = data as BusinessData
  const scope: Scope = { collectionRecords: [], profitRecords: [] }
  for (const key of fields) {
    const rows = extended[key]
    if (rows !== undefined && !Array.isArray(rows)) throw new Error('经营数据结构异常，已阻止清理。')
    if (rows !== undefined) (scope as Record<string, unknown>)[key] = rows.filter(row => row.storeId === storeId)
  }
  if (extended.overviewRefundActivity !== undefined) {
    const state = getOverviewRefundActivity(data)
    if (!state) throw new Error('退款观察记录版本无法识别，已阻止清理。')
    scope.overview = { balances: state.balances.filter(row => row.storeId === storeId), changes: state.changes.filter(row => row.storeId === storeId), openingDate: state.dayOpening?.date || null, openingBalances: (state.dayOpening?.balances || []).filter(row => row.storeId === storeId) }
  }
  return scope
}
export function storeBusinessSummary(data: WorkbenchData, storeId: string) {
  const scope = scopeFor(data, storeId)
  const ledgers = scope.orderAccountingLedgers || []
  const dates = [...new Set([...scope.collectionRecords.map(row => row.date), ...scope.profitRecords.map(row => row.date), ...ledgers.flatMap(row => row.orders.map(order => order.date)), ...(scope.linkSalesOrders || []).flatMap(row => row.date ? [row.date] : [])])].filter(date).sort()
  const counts = {
    collections: scope.collectionRecords.length, profits: scope.profitRecords.length, ledgers: ledgers.length,
    orders: ledgers.reduce((n, row) => n + row.orders.length, 0), refunds: ledgers.reduce((n, row) => n + row.refunds.length, 0), funds: ledgers.reduce((n, row) => n + row.funds.length, 0),
    promotionDays: ledgers.reduce((n, row) => n + row.promotions.length, 0), linkOrders: scope.linkSalesOrders?.length || 0, linkPromotions: scope.linkSalesPromotions?.length || 0,
    observations: (scope.overview?.balances.length || 0) + (scope.overview?.changes.length || 0) + (scope.overview?.openingBalances.length || 0),
  }
  return { counts, start: dates[0] || null, end: dates.at(-1) || null, hasData: Object.values(counts).some(value => value > 0) }
}
export function createStoreBusinessBackup(data: WorkbenchData, storeId: string, account: string, createdAt: string): StoreBusinessBackup {
  const store = storeFor(data, storeId)
  if (!account || !Number.isFinite(Date.parse(createdAt))) throw new Error('账号或备份时间无效。')
  return JSON.parse(JSON.stringify({ kind: 'ecom-store-business-backup', version: 1, createdAt, account, store: { id: store.id, name: store.name, clientId: store.clientId }, scope: scopeFor(data, storeId) }))
}
export function validateStoreBusinessBackup(value: unknown): asserts value is StoreBusinessBackup {
  if (!object(value) || value.kind !== 'ecom-store-business-backup' || value.version !== 1 || !strings(value, ['createdAt', 'account']) || !Number.isFinite(Date.parse(String(value.createdAt))) || !object(value.store) || !strings(value.store, ['id', 'name', 'clientId']) || !object(value.scope)) throw new Error('不是本系统的单店经营备份，不能恢复。')
  const id = value.store.id
  const owned = (row: Record<string, unknown>) => row.storeId === id
  const scope = value.scope
  const fail = () => { throw new Error('备份记录缺字段、金额无效或混入其他店铺，已阻止恢复。') }
  if (!array(scope.collectionRecords, row => owned(row) && strings(row, ['id', 'date', 'updatedAt']) && date(row.date) && numeric(row, ['orderCount','originalSales','effectiveSales','shippedRefund','couponRefund','basicServiceFee','afterSaleCompensation','smallPayment','appealReimbursement','promotionFee','currentNet','unsettledAmount','eligibleOrders','settledOrders','completionRate','missingCostOrders','unknownFunds']) && numeric(row, ['productCost','estimatedProfit','profit'], true) && typeof row.mature === 'boolean')) fail()
  if (!array(scope.profitRecords, row => owned(row) && strings(row, ['id','productId','date','updatedAt']) && date(row.date) && numeric(row, ['amount','cost','grossProfit','promotion','operationRate','operationFee','estimatedProfit','quantity','margin']))) fail()
  if (scope.orderAccountingLedgers !== undefined && !array(scope.orderAccountingLedgers, row => owned(row) && Array.isArray(row.initializedDates) && row.initializedDates.every(date) && array(row.orders, order => strings(order, ['id','date','productId']) && date(order.date) && numeric(order, ['receipt','quantity']) && numeric(order, ['unitCost'], true) && typeof order.cancelled === 'boolean' && typeof order.supplement === 'boolean') && array(row.refunds, refund => strings(refund, ['id','orderId','stage']) && numeric(refund, ['amount']) && typeof refund.success === 'boolean') && array(row.funds, fund => strings(fund, ['key','orderId','businessCode']) && ['positive','refund','other','transfer','promotion','unknown'].includes(String(fund.category)) && numeric(fund, ['income','expense'])) && array(row.promotions, promo => date(promo.date) && numeric(promo, ['amount'])))) fail()
  if (scope.linkSalesOrders !== undefined && !array(scope.linkSalesOrders, row => owned(row) && strings(row, ['orderId','goodsId','name','status']) && (row.date === null || date(row.date)) && numeric(row, ['receipt','quantity'], true) && typeof row.supplement === 'boolean' && (row.conflict === undefined || typeof row.conflict === 'boolean'))) fail()
  if (scope.linkSalesPromotions !== undefined && !array(scope.linkSalesPromotions, row => owned(row) && strings(row, ['goodsId']) && date(row.date) && numeric(row, ['amount']))) fail()
  if (scope.overview !== undefined) {
    const overview = scope.overview
    const balance = (row: Record<string, unknown>) => owned(row) && date(row.orderDate) && numeric(row, ['amount'], true)
    if (!object(overview) || !array(overview.balances, balance) || !array(overview.openingBalances, balance) || (overview.openingDate !== null && !date(overview.openingDate)) || !array(overview.changes, row => owned(row) && strings(row, ['id','observedAt']) && date(row.date) && date(row.orderDate) && numeric(row, ['before','after','amount']))) fail()
  }
}
function confirmStore(data: WorkbenchData, backup: StoreBusinessBackup, account: string, confirmation: string) {
  validateStoreBusinessBackup(backup)
  const store = storeFor(data, backup.store.id)
  if (account !== backup.account || store.clientId !== backup.store.clientId) throw new Error('备份账号或店铺归属不匹配，已阻止操作。')
  if (confirmation !== store.name) throw new Error('请输入当前店铺完整名称确认。')
}
export function backupMatchesStore(data: WorkbenchData, backup: StoreBusinessBackup) {
  return sameStoredDocument(scopeFor(data, backup.store.id), backup.scope) && data.stores.find(row => row.id === backup.store.id)?.name === backup.store.name
}
export function resetStoreBusiness(data: WorkbenchData, backup: StoreBusinessBackup, account: string, confirmation: string): WorkbenchData {
  confirmStore(data, backup, account, confirmation)
  if (!backupMatchesStore(data, backup)) throw new Error('暂存期间该店数据发生变化，未清空数据，请重试。')
  const id = backup.store.id, next = { ...data } as BusinessData
  for (const key of fields) if (next[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = next[key]!.filter(row => row.storeId !== id)
  const state = getOverviewRefundActivity(data)
  if (state) next.overviewRefundActivity = { ...state, balances: state.balances.filter(row => row.storeId !== id), changes: state.changes.filter(row => row.storeId !== id), ...(state.dayOpening ? { dayOpening: { ...state.dayOpening, balances: state.dayOpening.balances.filter(row => row.storeId !== id) } } : {}) }
  return next
}
export function restoreStoreBusiness(data: WorkbenchData, backup: StoreBusinessBackup, account: string, confirmation: string, now: string): WorkbenchData {
  confirmStore(data, backup, account, confirmation)
  const id = backup.store.id
  if (storeBusinessSummary(data, id).hasData) throw new Error('该店已有经营数据，不能覆盖恢复；请先核对，避免覆盖重传后的新数据。')
  const next = { ...data } as BusinessData
  for (const key of fields) if (backup.scope[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = [...(next[key] || []), ...backup.scope[key]!]
  const saved = backup.scope.overview
  {
    const state = getOverviewRefundActivity(data), today = overviewDay(now)
    const observed = getOverviewRefundActivity(observeOverviewRefunds(next, now))!
    const balances = observed.balances.filter(row => row.storeId === id)
    // Restore display observations only. On a later day, rebaseline restored
    // balances so restoring a backup cannot masquerade as new refunds.
    const opening = state?.dayOpening?.date === today ? state.dayOpening : { date: today, observedAt: now, partial: true, balances: state?.balances || observed.balances.filter(row => row.storeId !== id) }
    next.overviewRefundActivity = { ...state, version: 1, initializedAt: state?.initializedAt || now, balances: [...(state?.balances || observed.balances.filter(row => row.storeId !== id)), ...balances], changes: [...(state?.changes || []), ...(saved?.changes || [])], dayOpening: { ...opening, balances: [...opening.balances, ...(saved?.openingDate === today ? saved.openingBalances : balances)] } }
  }
  return next
}
