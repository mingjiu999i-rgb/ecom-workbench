import type { WorkbenchData } from '../types/models'

// Independent overview observations. Never used to calculate or update settlement records.
export type RefundBalance = { storeId: string; orderDate: string; amount: number | null }
export type RefundChange = {
  id: string; date: string; observedAt: string; storeId: string; orderDate: string
  before: number; after: number; amount: number
}
export type OverviewRefundActivity = {
  version: 1; initializedAt: string; balances: RefundBalance[]; changes: RefundChange[]
  dayOpening?: { date: string; observedAt: string; partial: boolean; balances: RefundBalance[] }
}
type OverviewData = WorkbenchData & { overviewRefundActivity?: OverviewRefundActivity }
const cents = (amount: number) => Math.round((amount + Number.EPSILON) * 100)
const key = (row: RefundBalance) => JSON.stringify([row.storeId, row.orderDate])
const finite = (amount: unknown): amount is number => typeof amount === 'number' && Number.isFinite(amount)
const validDay = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date

export function overviewDay(timestamp: string) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp))
}

export function getOverviewRefundActivity(data: WorkbenchData) {
  const state = (data as OverviewData).overviewRefundActivity
  return state?.version === 1 && Array.isArray(state.balances) && Array.isArray(state.changes) ? state : undefined
}

function refundBalances(data: WorkbenchData): RefundBalance[] {
  const balances = new Map<string, RefundBalance>()
  for (const record of data.collectionRecords) {
    if (!validDay(record.date)) continue
    const refund = record.refundBasis === 'order_paid_at' ? record.shippedRefund : record.orderShippedRefund
    const row: RefundBalance = { storeId: record.storeId, orderDate: record.date, amount: finite(refund) ? cents(refund) / 100 : null }
    const existing = balances.get(key(row))
    if (existing) existing.amount = existing.amount == null || row.amount == null ? null : (cents(existing.amount) + cents(row.amount)) / 100
    else balances.set(key(row), row)
  }
  return [...balances.values()].sort((a, b) => key(a).localeCompare(key(b)))
}

export function observeOverviewRefunds(data: WorkbenchData, observedAt: string): WorkbenchData {
  const previous = getOverviewRefundActivity(data)
  const balances = refundBalances(data)
  const date = overviewDay(observedAt)
  if (previous?.dayOpening?.date === date && JSON.stringify(previous.balances) === JSON.stringify(balances)) return data
  let dayOpening = previous?.dayOpening
  if (dayOpening?.date !== date) {
    const opening = new Map((previous?.balances || balances).map(row => [key(row), { ...row }]))
    // Upgrade old overview observations without counting today's already
    // recorded changes twice. These are display snapshots, not ledger values.
    if (previous && !previous.dayOpening) {
      for (const change of previous.changes.filter(row => row.date === date).slice().reverse()) {
        const rowKey = key(change)
        const existing = opening.get(rowKey)
        if (existing?.amount === null) continue
        opening.set(rowKey, { storeId: change.storeId, orderDate: change.orderDate, amount: existing
          ? (cents(existing.amount!) - cents(change.amount)) / 100
          : change.before })
      }
    }
    const partial = !previous || overviewDay(previous.initializedAt) === date
    dayOpening = { date, observedAt: partial && previous ? previous.initializedAt : observedAt, partial, balances: [...opening.values()] }
  }
  const changes = [...(previous?.changes || [])]
  if (previous) {
    const before = new Map(previous.balances.map(row => [key(row), row]))
    const after = new Map(balances.map(row => [key(row), row]))
    for (const rowKey of new Set([...before.keys(), ...after.keys()])) {
      const old = before.get(rowKey), next = after.get(rowKey)
      // Unknown legacy balances establish their first reliable baseline without inventing an increase.
      if (old?.amount === null || next?.amount === null) continue
      const beforeCents = cents(old?.amount || 0), afterCents = cents(next?.amount || 0)
      if (beforeCents === afterCents) continue
      const row = next || old!
      changes.push({
        id: `${observedAt}:${changes.length}`, date: overviewDay(observedAt), observedAt,
        storeId: row.storeId, orderDate: row.orderDate,
        before: beforeCents / 100, after: afterCents / 100, amount: (afterCents - beforeCents) / 100,
      })
    }
  }
  const overviewRefundActivity: OverviewRefundActivity = {
    version: 1, initializedAt: previous?.initializedAt || observedAt, balances, changes, dayOpening,
  }
  return { ...data, overviewRefundActivity } as OverviewData
}

// Compare the system's entire saved refund balance before/after today's
// imports. Order-date filters intentionally do not participate in this query.
export function summarizeOverviewRefundTotals(data: WorkbenchData, date: string, storeIds: Set<string>) {
  const state = getOverviewRefundActivity(data)
  const opening = state?.dayOpening?.date === date ? state.dayOpening : undefined
  const current = refundBalances(data).filter(row => storeIds.has(row.storeId))
  const before = (opening?.balances || []).filter(row => storeIds.has(row.storeId))
  // Display-only aggregation of saved turnover; never persisted in refund snapshots.
  const salesRecords = data.collectionRecords.filter(row => storeIds.has(row.storeId) && validDay(row.date))
  const totalSales = (ids: Set<string>) => {
    const records = salesRecords.filter(row => ids.has(row.storeId))
    return !records.length || records.some(row => !finite(row.originalSales)) ? null
      : records.reduce((sum, row) => sum + cents(row.originalSales), 0) / 100
  }
  const total = (rows: RefundBalance[]) => rows.some(row => row.amount == null) ? null : rows.reduce((sum, row) => sum + cents(row.amount!), 0) / 100
  const difference = (after: number | null, prior: number | null) => after == null || prior == null ? null : (cents(after) - cents(prior)) / 100
  const stores = [...storeIds].map(storeId => {
    const store = data.stores.find(row => row.id === storeId)
    const records = current.filter(row => row.storeId === storeId)
    const previous = before.filter(row => row.storeId === storeId)
    const after = total(records), prior = opening ? total(previous) : null
    return { storeId, name: store?.name || '历史店铺', clientId: store?.clientId || '',
      before: prior, after, amount: difference(after, prior), originalSales: totalSales(new Set([storeId])),
      recordedDays: new Set(records.map(row => row.orderDate)).size,
      hasData: records.length > 0 || previous.length > 0,
      unknownBalances: records.filter(row => row.amount == null).length + previous.filter(row => row.amount == null).length }
  }).filter(row => row.hasData)
    .sort((a, b) => (b.amount ?? -Infinity) - (a.amount ?? -Infinity) || a.name.localeCompare(b.name, 'zh-CN'))
  const clients = [...new Set(stores.map(row => row.clientId))].map(clientId => {
    const children = stores.filter(row => row.clientId === clientId)
    const ids = new Set(children.map(row => row.storeId))
    const records = current.filter(row => ids.has(row.storeId))
    const previous = before.filter(row => ids.has(row.storeId))
    const after = total(records), prior = opening ? total(previous) : null
    return { clientId, name: data.clients.find(row => row.id === clientId)?.name || '未关联甲方',
      before: prior, after, amount: difference(after, prior), stores: children, originalSales: totalSales(ids),
      recordedDays: new Set(records.map(row => row.orderDate)).size }
  })
  const hasData = current.length > 0 || before.length > 0
  const after = hasData ? total(current) : null
  const prior = hasData && opening ? total(before) : null
  return { date, before: prior, after, amount: difference(after, prior), stores, clients, hasData, originalSales: totalSales(storeIds),
    recordedDays: new Set(current.map(row => row.orderDate)).size,
    partialDay: opening?.partial ?? true, baselineAt: opening?.observedAt || null,
    unknownBalances: stores.reduce((sum, row) => sum + row.unknownBalances, 0) }
}

// Hide only confirmed zero changes; unknown amounts still need reconciliation.
export function overviewRefundDetailClients(summary: ReturnType<typeof summarizeOverviewRefundTotals>) {
  return summary.clients.map(client => ({ ...client, stores: client.stores.filter(store => store.amount !== 0) }))
    .filter(client => client.stores.length > 0)
}

export function summarizeOverviewRefunds(data: WorkbenchData, start: string, end: string, storeIds: Set<string>) {
  const state = getOverviewRefundActivity(data)
  const trackingStart = state ? overviewDay(state.initializedAt) : null
  const covered = trackingStart != null && end >= trackingStart
  const changes = (state?.changes || []).filter(row => storeIds.has(row.storeId) && row.date >= start && row.date <= end)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.storeId.localeCompare(b.storeId) || a.orderDate.localeCompare(b.orderDate))
  const total = (predicate: (row: RefundChange) => boolean) => changes.filter(predicate).reduce((amount, row) => amount + cents(row.amount), 0) / 100
  return {
    initializedAt: state?.initializedAt || null, trackingStart, changes,
    amount: covered ? total(() => true) : null,
    added: covered ? total(row => row.amount > 0) : null,
    reduced: covered ? total(row => row.amount < 0) : null,
    partial: covered && start < trackingStart!,
    unknownBalances: (state?.balances || []).filter(row => storeIds.has(row.storeId) && row.amount == null).length,
  }
}
