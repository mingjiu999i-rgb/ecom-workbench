import type { WorkbenchData } from '../types/models'
import { getOverviewRefundActivity, observeOverviewRefunds, overviewDay, type OverviewRefundActivity } from './overviewRefundActivity'
import type { LinkSalesOrder, LinkPromotion } from './linkSales'
import { sameStoredDocument } from './workbenchRecovery'

type BusinessData = WorkbenchData & {
  linkSalesOrders?: LinkSalesOrder[]; linkSalesPromotions?: LinkPromotion[]; overviewRefundActivity?: OverviewRefundActivity
}
const fields = ['collectionRecords', 'profitRecords', 'orderAccountingLedgers', 'linkSalesOrders', 'linkSalesPromotions', 'profitBaselines'] as const
type BusinessField = typeof fields[number]
type Scope = Pick<BusinessData, BusinessField> & { overview?: {
  balances: OverviewRefundActivity['balances']; changes: OverviewRefundActivity['changes']
  openingDate: string | null; openingBalances: OverviewRefundActivity['balances']
} }
export type StoreBusinessBackup = {
  kind: 'ecom-store-business-backup'; version: 1; createdAt: string; account: string
  store: { id: string; name: string; clientId: string }; scope: Scope; targetDate?: string
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
function scopeFor(data: WorkbenchData, storeId: string, targetDate?: string): Scope {
  storeFor(data, storeId)
  if (targetDate !== undefined && !date(targetDate)) throw new Error('请选择有效的成交日期。')
  const extended = data as BusinessData
  const scope: Scope = { collectionRecords: [], profitRecords: [] }
  for (const key of fields) {
    const rows = extended[key]
    if (rows !== undefined && !Array.isArray(rows)) throw new Error('经营数据结构异常，已阻止清理。')
    if (rows !== undefined) (scope as Record<string, unknown>)[key] = rows.filter(row => row.storeId === storeId && (targetDate === undefined || key === 'orderAccountingLedgers' || ('date' in row && row.date === targetDate)))
  }
  if (targetDate !== undefined && (scope.orderAccountingLedgers?.length || 0) > 1) throw new Error('该店存在重复账本，无法安全地按日期清理。')
  if (targetDate !== undefined && scope.orderAccountingLedgers) scope.orderAccountingLedgers = scope.orderAccountingLedgers.map(ledger => {
    const orders = ledger.orders.filter(order => order.date === targetDate)
    const ids = new Set(orders.map(order => order.id))
    return { ...ledger, initializedDates: ledger.initializedDates.filter(day => day === targetDate), orders,
      refunds: ledger.refunds.filter(row => ids.has(row.orderId)), funds: ledger.funds.filter(row => ids.has(row.orderId)),
      promotions: ledger.promotions.filter(row => row.date === targetDate) }
  }).filter(ledger => ledger.initializedDates.length + ledger.orders.length + ledger.refunds.length + ledger.funds.length + ledger.promotions.length > 0)
  if (extended.overviewRefundActivity !== undefined) {
    const state = getOverviewRefundActivity(data)
    if (!state) throw new Error('退款观察记录版本无法识别，已阻止清理。')
    scope.overview = { balances: state.balances.filter(row => row.storeId === storeId && (targetDate === undefined || row.orderDate === targetDate)), changes: state.changes.filter(row => row.storeId === storeId && (targetDate === undefined || row.orderDate === targetDate)), openingDate: state.dayOpening?.date || null, openingBalances: (state.dayOpening?.balances || []).filter(row => row.storeId === storeId && (targetDate === undefined || row.orderDate === targetDate)) }
  }
  return scope
}
function datesInScope(scope: Scope) {
  return [...new Set([...scope.collectionRecords.map(row => row.date), ...scope.profitRecords.map(row => row.date), ...(scope.orderAccountingLedgers || []).flatMap(row => [...row.initializedDates, ...row.orders.map(order => order.date), ...row.promotions.map(promotion => promotion.date)]), ...(scope.linkSalesOrders || []).flatMap(row => row.date ? [row.date] : []), ...(scope.linkSalesPromotions || []).map(row => row.date), ...(scope.profitBaselines || []).map(row => row.date), ...(scope.overview?.balances || []).map(row => row.orderDate), ...(scope.overview?.changes || []).map(row => row.orderDate), ...(scope.overview?.openingBalances || []).map(row => row.orderDate)])].filter(date).sort()
}
export function storeBusinessSummary(data: WorkbenchData, storeId: string, targetDate?: string) {
  const scope = scopeFor(data, storeId, targetDate)
  const ledgers = scope.orderAccountingLedgers || []
  const dates = datesInScope(scope)
  const counts = {
    collections: scope.collectionRecords.length, profits: scope.profitRecords.length, ledgers: ledgers.length,
    orders: ledgers.reduce((n, row) => n + row.orders.length, 0), refunds: ledgers.reduce((n, row) => n + row.refunds.length, 0), funds: ledgers.reduce((n, row) => n + row.funds.length, 0),
    promotionDays: ledgers.reduce((n, row) => n + row.promotions.length, 0), linkOrders: scope.linkSalesOrders?.length || 0, linkPromotions: scope.linkSalesPromotions?.length || 0,
    observations: (scope.overview?.balances.length || 0) + (scope.overview?.changes.length || 0) + (scope.overview?.openingBalances.length || 0),
    profitBaselines: scope.profitBaselines?.length || 0,
  }
  return { counts, start: dates[0] || null, end: dates.at(-1) || null, hasData: Object.values(counts).some(value => value > 0) }
}
export function storeBusinessDates(data: WorkbenchData, storeId: string) {
  return datesInScope(scopeFor(data, storeId)).reverse()
}
export function createStoreBusinessBackup(data: WorkbenchData, storeId: string, account: string, createdAt: string, targetDate?: string): StoreBusinessBackup {
  const store = storeFor(data, storeId)
  if (!account || !Number.isFinite(Date.parse(createdAt))) throw new Error('账号或备份时间无效。')
  return JSON.parse(JSON.stringify({ kind: 'ecom-store-business-backup', version: 1, createdAt, account, store: { id: store.id, name: store.name, clientId: store.clientId }, ...(targetDate === undefined ? {} : { targetDate }), scope: scopeFor(data, storeId, targetDate) }))
}
export function validateStoreBusinessBackup(value: unknown): asserts value is StoreBusinessBackup {
  if (!object(value) || value.kind !== 'ecom-store-business-backup' || value.version !== 1 || !strings(value, ['createdAt', 'account']) || !Number.isFinite(Date.parse(String(value.createdAt))) || !object(value.store) || !strings(value.store, ['id', 'name', 'clientId']) || !object(value.scope)) throw new Error('不是本系统的单店经营备份，不能恢复。')
  const id = value.store.id
  if (value.targetDate !== undefined && !date(value.targetDate)) throw new Error('备份成交日期无效，不能恢复。')
  const owned = (row: Record<string, unknown>) => row.storeId === id
  const scope = value.scope
  const fail = () => { throw new Error('备份记录缺字段、金额无效或混入其他店铺，已阻止恢复。') }
  if (!array(scope.collectionRecords, row => owned(row) && strings(row, ['id', 'date', 'updatedAt']) && date(row.date) && numeric(row, ['orderCount','originalSales','effectiveSales','shippedRefund','couponRefund','basicServiceFee','afterSaleCompensation','smallPayment','appealReimbursement','promotionFee','currentNet','unsettledAmount','eligibleOrders','settledOrders','completionRate','missingCostOrders','unknownFunds']) && numeric(row, ['productCost','estimatedProfit','profit'], true) && typeof row.mature === 'boolean')) fail()
  if (!array(scope.profitRecords, row => owned(row) && strings(row, ['id','productId','date','updatedAt']) && date(row.date) && numeric(row, ['amount','cost','grossProfit','promotion','operationRate','operationFee','estimatedProfit','quantity','margin']))) fail()
  if (scope.orderAccountingLedgers !== undefined && !array(scope.orderAccountingLedgers, row => owned(row) && Array.isArray(row.initializedDates) && row.initializedDates.every(date) && array(row.orders, order => strings(order, ['id','date','productId']) && date(order.date) && numeric(order, ['receipt','quantity']) && numeric(order, ['unitCost'], true) && typeof order.cancelled === 'boolean' && typeof order.supplement === 'boolean') && array(row.refunds, refund => strings(refund, ['id','orderId','stage']) && numeric(refund, ['amount']) && typeof refund.success === 'boolean') && array(row.funds, fund => strings(fund, ['key','orderId','businessCode']) && ['positive','refund','other','transfer','promotion','unknown'].includes(String(fund.category)) && numeric(fund, ['income','expense'])) && array(row.promotions, promo => date(promo.date) && numeric(promo, ['amount'])))) fail()
  if (scope.linkSalesOrders !== undefined && !array(scope.linkSalesOrders, row => owned(row) && strings(row, ['orderId','goodsId','name','status']) && (row.date === null || date(row.date)) && numeric(row, ['receipt','quantity'], true) && typeof row.supplement === 'boolean' && (row.conflict === undefined || typeof row.conflict === 'boolean'))) fail()
  if (scope.linkSalesPromotions !== undefined && !array(scope.linkSalesPromotions, row => owned(row) && strings(row, ['goodsId']) && date(row.date) && numeric(row, ['amount']))) fail()
  if (scope.profitBaselines !== undefined && !array(scope.profitBaselines, row => owned(row) && strings(row, ['id', 'date', 'recordedAt']) && date(row.date) && Number.isFinite(Date.parse(String(row.recordedAt))) && numeric(row, ['orderCount', 'collectionProfit']) && array(row.products, product => strings(product, ['productId']) && numeric(product, ['estimatedProfit'])))) fail()
  if (scope.overview !== undefined) {
    const overview = scope.overview
    const balance = (row: Record<string, unknown>) => owned(row) && date(row.orderDate) && numeric(row, ['amount'], true)
    if (!object(overview) || !array(overview.balances, balance) || !array(overview.openingBalances, balance) || (overview.openingDate !== null && !date(overview.openingDate)) || !array(overview.changes, row => owned(row) && strings(row, ['id','observedAt']) && date(row.date) && date(row.orderDate) && numeric(row, ['before','after','amount']))) fail()
  }
  if (value.targetDate !== undefined) {
    const day = value.targetDate
    const selectedScope = scope as Scope
    const datedRowsMatch = [selectedScope.collectionRecords, selectedScope.profitRecords, selectedScope.linkSalesOrders || [], selectedScope.linkSalesPromotions || [], selectedScope.profitBaselines || []].every(rows => rows.every(row => row.date === day))
    const ledgersMatch = (selectedScope.orderAccountingLedgers || []).length <= 1 && (selectedScope.orderAccountingLedgers || []).every(ledger => {
      const ids = new Set(ledger.orders.map(order => order.id))
      return ledger.initializedDates.every(value => value === day) && ledger.orders.every(row => row.date === day) && ledger.promotions.every(row => row.date === day) && ledger.refunds.every(row => ids.has(row.orderId)) && ledger.funds.every(row => ids.has(row.orderId))
    })
    const overviewMatches = [selectedScope.overview?.balances || [], selectedScope.overview?.changes || [], selectedScope.overview?.openingBalances || []].every(rows => rows.every(row => row.orderDate === day))
    if (!datedRowsMatch || !ledgersMatch || !overviewMatches) fail()
  }
}
function confirmStore(data: WorkbenchData, backup: StoreBusinessBackup, account: string, confirmation: string) {
  validateStoreBusinessBackup(backup)
  const store = storeFor(data, backup.store.id)
  if (account !== backup.account || store.clientId !== backup.store.clientId) throw new Error('备份账号或店铺归属不匹配，已阻止操作。')
  if (confirmation !== store.name) throw new Error('请输入当前店铺完整名称确认。')
}
export function backupMatchesStore(data: WorkbenchData, backup: StoreBusinessBackup) {
  return sameStoredDocument(scopeFor(data, backup.store.id, backup.targetDate), backup.scope) && data.stores.find(row => row.id === backup.store.id)?.name === backup.store.name
}
export function resetStoreBusiness(data: WorkbenchData, backup: StoreBusinessBackup, account: string, confirmation: string): WorkbenchData {
  confirmStore(data, backup, account, confirmation)
  if (!backupMatchesStore(data, backup)) throw new Error('暂存期间该店数据发生变化，未清空数据，请重试。')
  const id = backup.store.id, next = { ...data } as BusinessData
  if (backup.targetDate !== undefined) {
    const day = backup.targetDate
    for (const key of fields) {
      if (key === 'orderAccountingLedgers' || next[key] === undefined) continue
      (next as unknown as Record<string, unknown>)[key] = next[key]!.filter(row => row.storeId !== id || row.date !== day)
    }
    if (next.orderAccountingLedgers) next.orderAccountingLedgers = next.orderAccountingLedgers.map(ledger => {
      if (ledger.storeId !== id) return ledger
      const ids = new Set(ledger.orders.filter(order => order.date === day).map(order => order.id))
      return { ...ledger, initializedDates: ledger.initializedDates.filter(value => value !== day), orders: ledger.orders.filter(order => order.date !== day), refunds: ledger.refunds.filter(row => !ids.has(row.orderId)), funds: ledger.funds.filter(row => !ids.has(row.orderId)), promotions: ledger.promotions.filter(row => row.date !== day) }
    }).filter(ledger => ledger.storeId !== id || ledger.initializedDates.length + ledger.orders.length + ledger.refunds.length + ledger.funds.length + ledger.promotions.length > 0)
    const state = getOverviewRefundActivity(data)
    if (state) next.overviewRefundActivity = { ...state, balances: state.balances.filter(row => row.storeId !== id || row.orderDate !== day), changes: state.changes.filter(row => row.storeId !== id || row.orderDate !== day), ...(state.dayOpening ? { dayOpening: { ...state.dayOpening, balances: state.dayOpening.balances.filter(row => row.storeId !== id || row.orderDate !== day) } } : {}) }
    return next
  }
  for (const key of fields) if (next[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = next[key]!.filter(row => row.storeId !== id)
  const state = getOverviewRefundActivity(data)
  if (state) next.overviewRefundActivity = { ...state, balances: state.balances.filter(row => row.storeId !== id), changes: state.changes.filter(row => row.storeId !== id), ...(state.dayOpening ? { dayOpening: { ...state.dayOpening, balances: state.dayOpening.balances.filter(row => row.storeId !== id) } } : {}) }
  return next
}
export function restoreStoreBusiness(data: WorkbenchData, backup: StoreBusinessBackup, account: string, confirmation: string, now: string): WorkbenchData {
  confirmStore(data, backup, account, confirmation)
  const id = backup.store.id
  if (storeBusinessSummary(data, id, backup.targetDate).hasData) throw new Error('该店对应日期已有经营数据，不能覆盖恢复；请先核对，避免覆盖重传后的新数据。')
  const next = { ...data } as BusinessData
  for (const key of fields) {
    if (key === 'orderAccountingLedgers' || backup.scope[key] === undefined) continue
    (next as unknown as Record<string, unknown>)[key] = [...(next[key] || []), ...backup.scope[key]!]
  }
  if (backup.scope.orderAccountingLedgers) {
    if (backup.targetDate === undefined) next.orderAccountingLedgers = [...(next.orderAccountingLedgers || []), ...backup.scope.orderAccountingLedgers]
    else {
      const savedLedger = backup.scope.orderAccountingLedgers[0]
      if (savedLedger) {
        const current = next.orderAccountingLedgers?.find(row => row.storeId === id)
        const restored = current ? { ...current, initializedDates: [...new Set([...current.initializedDates, ...savedLedger.initializedDates])].sort(), orders: [...current.orders, ...savedLedger.orders], refunds: [...current.refunds, ...savedLedger.refunds], funds: [...current.funds, ...savedLedger.funds], promotions: [...current.promotions, ...savedLedger.promotions] } : savedLedger
        next.orderAccountingLedgers = [...(next.orderAccountingLedgers || []).filter(row => row.storeId !== id), restored]
      }
    }
  }
  const saved = backup.scope.overview
  {
    const state = getOverviewRefundActivity(data), today = overviewDay(now)
    const observed = getOverviewRefundActivity(observeOverviewRefunds(next, now))!
    const balances = observed.balances.filter(row => row.storeId === id && (backup.targetDate === undefined || row.orderDate === backup.targetDate))
    // Restore display observations only. On a later day, rebaseline restored
    // balances so restoring a backup cannot masquerade as new refunds.
    const opening = state?.dayOpening?.date === today ? state.dayOpening : { date: today, observedAt: now, partial: true, balances: state?.balances || observed.balances.filter(row => row.storeId !== id) }
    next.overviewRefundActivity = { ...state, version: 1, initializedAt: state?.initializedAt || now, balances: [...(state?.balances || observed.balances.filter(row => row.storeId !== id)), ...balances].sort((a, b) => JSON.stringify([a.storeId, a.orderDate]).localeCompare(JSON.stringify([b.storeId, b.orderDate]))), changes: [...(state?.changes || []), ...(saved?.changes || [])], dayOpening: { ...opening, balances: [...opening.balances, ...(saved?.openingDate === today ? saved.openingBalances : balances)] } }
  }
  return next
}
