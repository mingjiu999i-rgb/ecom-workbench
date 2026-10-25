const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  module._compile(output.outputText, filename)
}
const { observeOverviewRefunds: observe, summarizeOverviewRefundTotals: totals, overviewRefundDetailClients: detailClients } = require('../src/utils/overviewRefundActivity.ts')
const prior = '2026-10-14T01:00:00Z', morning = '2026-10-15T01:00:00Z', later = '2026-10-15T02:00:00Z'
const day = '2026-10-15', all = new Set(['a', 'b', 'c'])
const row = (storeId, amount, date = '2026-09-30') => ({ id: `${storeId}|${date}`, storeId, date, shippedRefund: amount, refundBasis: 'order_paid_at' })
const data = records => ({
  clients: [{ id: 'one', name: '甲方一' }, { id: 'two', name: '甲方二' }],
  stores: [{ id: 'a', name: 'A店', clientId: 'one' }, { id: 'b', name: 'B店', clientId: 'one' }, { id: 'c', name: 'C店', clientId: 'two' }],
  collectionRecords: records, profitRecords: [{ amount: 20, cost: 5 }], orderAccountingLedgers: [{ storeId: 'a', orders: [], refunds: [], funds: [] }],
})
const baseline = () => observe(data([row('a', 200), row('b', 300), row('c', 500)]), prior)
const update = (value, records, time = morning) => observe({ ...value, collectionRecords: records }, time)

test('detail hides unchanged stores and empty client groups without changing cumulative totals', () => {
  const value = update(baseline(), [row('a', 300), row('b', 300), row('c', 500)])
  const summary = totals(value, day, all)
  const snapshot = JSON.stringify(summary)
  const visible = detailClients(summary)
  assert.deepEqual(visible.map(client => [client.name, client.stores.map(store => store.storeId)]), [['甲方一', ['a']]])
  assert.equal(visible[0].before, 500)
  assert.equal(visible[0].after, 600)
  assert.equal(summary.before, 1000)
  assert.equal(summary.after, 1100)
  assert.equal(summary.amount, 100)
  assert.equal(JSON.stringify(summary), snapshot)
})

test('detail shows empty state when all stores are unchanged', () => {
  const value = observe(baseline(), morning)
  assert.deepEqual(detailClients(totals(value, day, all)), [])
})

test('detail retains negative adjustments even when the client net change is zero', () => {
  const value = update(baseline(), [row('a', 240), row('b', 260), row('c', 500)])
  const summary = totals(value, day, all)
  const visible = detailClients(summary)
  assert.equal(summary.amount, 0)
  assert.equal(visible.length, 1)
  assert.deepEqual(visible[0].stores.map(store => store.amount), [40, -40])
})

test('detail retains unknown balances instead of treating them as unchanged', () => {
  const unknown = { ...row('a', 0), refundBasis: 'refund_completed_at', orderShippedRefund: undefined }
  const value = update(observe(data([unknown, row('c', 500)]), prior), [unknown, row('c', 500)])
  const visible = detailClients(totals(value, day, all))
  assert.deepEqual(visible.map(client => client.stores.map(store => [store.storeId, store.amount])), [[['a', null]]])
})

test('1000 to 1180 displays 180 and the three stores reconcile to 100 + 60 + 20', () => {
  const value = update(baseline(), [row('a', 300), row('b', 360), row('c', 520)])
  const summary = totals(value, day, all)
  assert.equal(summary.before, 1000)
  assert.equal(summary.after, 1180)
  assert.equal(summary.amount, 180)
  assert.deepEqual(summary.stores.map(store => [store.name, store.amount]), [['A店', 100], ['B店', 60], ['C店', 20]])
  assert.deepEqual(summary.clients.map(client => [client.name, client.amount]), [['甲方一', 160], ['甲方二', 20]])
  assert.equal(summary.stores.reduce((sum, store) => sum + store.amount, 0), summary.amount)
  assert.equal(summary.partialDay, false)
})

test('current and opening totals include every saved order date across months', () => {
  const first = observe(data([row('a', 100, '2026-09-01'), row('a', 200, '2026-10-14')]), prior)
  const value = update(first, [row('a', 130, '2026-09-01'), row('a', 200, '2026-10-14'), row('a', 50, '2026-10-15')])
  const summary = totals(value, day, new Set(['a']))
  assert.equal(summary.before, 300)
  assert.equal(summary.after, 380)
  assert.equal(summary.amount, 80)
  assert.equal(summary.recordedDays, 3)
})

test('multiple imports accumulate, while identical imports and reloads never duplicate the increase', () => {
  let value = update(baseline(), [row('a', 300), row('b', 300), row('c', 500)])
  value = update(value, [row('a', 300), row('b', 360), row('c', 520)], later)
  assert.equal(totals(value, day, all).amount, 180)
  assert.equal(observe(value, '2026-10-15T03:00:00Z'), value)
  const reloaded = JSON.parse(JSON.stringify(value))
  assert.equal(totals(reloaded, day, all).amount, 180)
  assert.equal(totals(reloaded, day, all).before, 1000)
})

test('store and client selection isolates the same before-after calculation', () => {
  const value = update(baseline(), [row('a', 300), row('b', 360), row('c', 520)])
  assert.equal(totals(value, day, new Set(['b'])).amount, 60)
  assert.equal(totals(value, day, new Set(['a', 'b'])).amount, 160)
  assert.deepEqual(totals(value, day, new Set(['b'])).stores.map(store => store.storeId), ['b'])
})

test('a new Shanghai day starts at the last saved cumulative total and then measures new imports', () => {
  const value = update(baseline(), [row('a', 300), row('b', 360), row('c', 520)])
  const rolled = observe(value, '2026-10-15T16:01:00Z')
  assert.equal(totals(rolled, '2026-10-16', all).before, 1180)
  assert.equal(totals(rolled, '2026-10-16', all).amount, 0)
  const changed = update(rolled, [row('a', 325), row('b', 360), row('c', 520)], '2026-10-15T17:00:00Z')
  assert.equal(totals(changed, '2026-10-16', all).amount, 25)
})

test('unknown historical opening amounts stay unknown when corrected, never masquerading as zero', () => {
  const unknown = { ...row('a', 0), refundBasis: 'refund_completed_at', orderShippedRefund: undefined }
  const first = observe(data([unknown]), prior)
  const changed = update(first, [row('a', 150)])
  const summary = totals(changed, day, new Set(['a']))
  assert.equal(summary.before, null)
  assert.equal(summary.after, 150)
  assert.equal(summary.amount, null)
  assert.ok(summary.unknownBalances > 0)
  assert.equal(summary.stores[0].amount, null)
})

test('first load establishes a partial-day baseline without relabeling historical refunds as new', () => {
  const value = observe(data([row('a', 1000)]), morning)
  const summary = totals(value, day, new Set(['a']))
  assert.equal(summary.before, 1000)
  assert.equal(summary.after, 1000)
  assert.equal(summary.amount, 0)
  assert.equal(summary.partialDay, true)
  assert.equal(totals(data([row('a', 1000)]), day, new Set(['a'])).amount, null)
})

test('migration preserves earlier changes already recorded today and measures later imports correctly', () => {
  const existing = update(baseline(), [row('a', 300), row('b', 300), row('c', 500)])
  delete existing.overviewRefundActivity.dayOpening
  const upgraded = update(existing, [row('a', 300), row('b', 360), row('c', 520)], later)
  assert.equal(totals(upgraded, day, all).before, 1000)
  assert.equal(totals(upgraded, day, all).after, 1180)
  assert.equal(totals(upgraded, day, all).amount, 180)
})

test('adjustments remain signed and all store changes still sum to the net increase', () => {
  const value = update(baseline(), [row('a', 300), row('b', 260), row('c', 520)])
  const summary = totals(value, day, all)
  assert.equal(summary.amount, 80)
  assert.equal(summary.stores.find(store => store.storeId === 'b').amount, -40)
  assert.equal(summary.after - summary.before, summary.amount)
})

test('saved-day counts use actual distinct dates, not an invented continuous date range', () => {
  const value = observe(data([row('a', 50, '2026-09-01'), row('a', 50, '2026-10-10'), row('b', 100, '2026-10-10')]), morning)
  const summary = totals(value, day, all)
  assert.equal(summary.recordedDays, 2)
  assert.equal(summary.clients[0].recordedDays, 2)
  assert.equal(summary.stores.find(store => store.storeId === 'a').recordedDays, 2)
})

test('no saved records are shown as unavailable, while a captured empty baseline can measure a new store', () => {
  const first = observe(data([]), prior)
  assert.equal(totals(first, '2026-10-14', all).after, null)
  const changed = update(first, [row('a', 30)])
  assert.equal(totals(changed, day, all).before, 0)
  assert.equal(totals(changed, day, all).amount, 30)
})

test('only overview metadata changes: financial objects and values are preserved by reference', () => {
  const original = baseline()
  const incoming = { ...original, collectionRecords: [row('a', 300), row('b', 360), row('c', 520)] }
  const snapshot = JSON.stringify(incoming)
  const observed = observe(incoming, morning)
  totals(observed, day, all)
  assert.equal(JSON.stringify(incoming), snapshot)
  for (const field of Object.keys(incoming).filter(field => field !== 'overviewRefundActivity')) assert.equal(observed[field], incoming[field])
  assert.deepEqual(Object.keys(observed).filter(field => observed[field] !== incoming[field]), ['overviewRefundActivity'])
})

test('saved turnover includes all dates and unchanged stores in client and selected totals without modifying storage', () => {
  const records = [
    { ...row('a', 200), originalSales: 1000.10, effectiveSales: 800.10 },
    { ...row('a', 50, '2026-10-14'), originalSales: 200.20, effectiveSales: 150.20 },
    { ...row('b', 300), originalSales: 3000, effectiveSales: 2700 },
    { ...row('c', 500), originalSales: 5000, effectiveSales: 4500 },
  ]
  const value = update(observe(data(records), prior), records.map((record, i) => i === 0 ? { ...record, shippedRefund: 250 } : record))
  const snapshot = JSON.stringify(value)
  const summary = totals(value, day, all)
  assert.equal(summary.stores.find(store => store.storeId === 'a').originalSales, 1200.30)
  assert.equal(summary.clients.find(client => client.clientId === 'one').originalSales, 4200.30)
  assert.equal(summary.originalSales, 9200.30)
  const visible = detailClients(summary)
  assert.deepEqual(visible[0].stores.map(store => store.storeId), ['a'])
  assert.equal(visible[0].originalSales, 4200.30)
  assert.equal(totals(value, day, new Set(['a'])).originalSales, 1200.30)
  assert.equal(totals(value, day, new Set(['b'])).originalSales, 3000)
  assert.equal(summary.amount, 50)
  assert.equal(JSON.stringify(value), snapshot)
})

test('missing or invalid saved turnover stays unknown while confirmed zero and unrelated stores remain usable', () => {
  for (const originalSales of [undefined, null, NaN, Infinity]) {
    const value = data([{ ...row('a', 20), originalSales }, { ...row('b', 30), originalSales: 0 }, { ...row('c', 40), originalSales: 100 }])
    const summary = totals(value, day, all)
    assert.equal(summary.originalSales, null)
    assert.equal(summary.clients.find(client => client.clientId === 'one').originalSales, null)
    assert.equal(summary.stores.find(store => store.storeId === 'a').originalSales, null)
    assert.equal(totals(value, day, new Set(['b'])).originalSales, 0)
    assert.equal(totals(value, day, new Set(['c'])).originalSales, 100)
  }
  assert.equal(totals(data([]), day, all).originalSales, null)
})

test('turnover uses the same valid saved dates as refund totals and retains cent precision', () => {
  const value = data([
    { ...row('a', 0), originalSales: 0.1 },
    { ...row('a', 0, '2026-10-01'), originalSales: 0.2 },
    { ...row('a', 0, 'invalid'), originalSales: 9000 },
    { ...row('a', 0, '2026-02-30'), originalSales: 9000 },
  ])
  const summary = totals(value, day, new Set(['a']))
  assert.equal(summary.originalSales, 0.3)
  assert.equal(summary.recordedDays, 2)
})
