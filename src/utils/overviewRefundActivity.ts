import type { WorkbenchData } from '../types/models'

// Independent overview observations. Never used to calculate or update settlement records.
export type RefundBalance = { storeId: string; orderDate: string; amount: number | null }
export type RefundChange = {
  id: string; date: string; observedAt: string; storeId: string; orderDate: string
  before: number; after: number; amount: number
}
export type OverviewRefundActivity = {
  version: 1; initializedAt: string; balances: RefundBalance[]; changes: RefundChange[]
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
  if (previous && JSON.stringify(previous.balances) === JSON.stringify(balances)) return data
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
    version: 1, initializedAt: previous?.initializedAt || observedAt, balances, changes,
  }
  return { ...data, overviewRefundActivity } as OverviewData
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
