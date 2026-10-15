const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  module._compile(output.outputText, filename)
}
const { observeOverviewRefunds: observe, summarizeOverviewRefunds: summary, getOverviewRefundActivity: state } = require('../src/utils/overviewRefundActivity.ts')
const stamp = '2026-10-13T01:00:00Z'
const next = '2026-10-13T02:00:00Z'
const row = (amount, date = '2026-09-30', storeId = 's1') => ({ id: storeId + date, storeId, date, shippedRefund: amount, orderShippedRefund: amount, refundBasis: 'order_paid_at' })
const data = (...records) => ({ stores: [{ id: 's1' }, { id: 's2' }], collectionRecords: records, profitRecords: [{ amount: 500, estimatedProfit: 50 }], orderAccountingLedgers: [{ storeId: 's1', orders: [], funds: [], refunds: [] }] })
const total = (value, start = '2026-10-13', end = start, ids = ['s1']) => summary(value, start, end, new Set(ids))
const setAmount = (value, amount) => ({ ...value, collectionRecords: [row(amount)] })

test('first observation establishes a baseline and never labels historical totals as new refunds', () => {
  const original = data(row(100))
  const observed = observe(original, stamp)
  assert.equal(state(observed).changes.length, 0)
  assert.equal(total(observed).amount, 0)
  assert.equal(total(observed, '2026-10-12').amount, null)
  assert.equal(total(original).amount, null)
  assert.equal(Object.hasOwn(original, 'overviewRefundActivity'), false)
})

test('old order increase is recorded on the import observation day, with before/after amounts and order date', () => {
  const baseline = observe(data(row(100)), stamp)
  const changed = observe(setAmount(baseline, 130), next)
  const result = total(changed)
  assert.equal(result.amount, 30)
  assert.deepEqual(result.changes.map(r => [r.date, r.orderDate, r.before, r.after, r.amount]), [['2026-10-13', '2026-09-30', 100, 130, 30]])
  assert.equal(total(changed, '2026-09-30').amount, null)
})

test('repeated imports, unchanged records, and persisted reloads never double count', () => {
  let value = observe(data(row(100)), stamp)
  value = observe(setAmount(value, 130), next)
  assert.equal(observe(value, '2026-10-13T03:00:00Z'), value)
  const reloaded = JSON.parse(JSON.stringify(value))
  const rolled = observe(reloaded, '2026-10-14T01:00:00Z')
  assert.deepEqual(state(rolled).changes, state(reloaded).changes)
  assert.equal(total(reloaded).amount, 30)
  assert.equal(state(reloaded).changes.length, 1)
})

test('multiple imports and multiple original dates accumulate by store and selected observation period', () => {
  let value = observe(data(row(100), row(50, '2026-09-20', 's2')), stamp)
  value = observe({ ...value, collectionRecords: [row(130), row(60, '2026-09-20', 's2'), row(5, '2026-10-12')] }, next)
  assert.equal(total(value).amount, 35)
  assert.equal(total(value, '2026-10-13', '2026-10-13', ['s2']).amount, 10)
  assert.equal(total(value, '2026-10-13', '2026-10-13', ['s1', 's2']).amount, 45)
  value = observe({ ...value, collectionRecords: [row(140), row(60, '2026-09-20', 's2'), row(5, '2026-10-12')] }, '2026-10-14T01:00:00Z')
  assert.equal(total(value).amount, 35)
  assert.equal(total(value, '2026-10-14').amount, 10)
  assert.equal(total(value, '2026-10-13', '2026-10-14', ['s1', 's2']).amount, 55)
})

test('refund reductions are explicit signed adjustments, not an additional refund', () => {
  const baseline = observe(data(row(100)), stamp)
  const changed = observe(setAmount(baseline, 90), next)
  assert.equal(total(changed).amount, -10)
  assert.equal(total(changed).added, 0)
  assert.equal(total(changed).reduced, -10)
  const restored = observe(setAmount(changed, 100), '2026-10-13T03:00:00Z')
  assert.equal(total(restored).amount, 0)
})

test('legacy missing balances are unknown and first correction establishes a reliable baseline', () => {
  const baseline = observe(data({ ...row(100), refundBasis: 'refund_completed_at', orderShippedRefund: undefined }), stamp)
  assert.equal(total(baseline).unknownBalances, 1)
  const corrected = observe(setAmount(baseline, 150), next)
  assert.equal(total(corrected).amount, 0)
  assert.equal(total(corrected).unknownBalances, 0)
  const increased = observe(setAmount(corrected, 160), '2026-10-13T03:00:00Z')
  assert.equal(total(increased).amount, 10)
})

test('dates use Asia/Shanghai at midnight and older periods stay explicitly unavailable', () => {
  const baseline = observe(data(row(100)), '2026-10-12T15:59:00Z')
  const changed = observe(setAmount(baseline, 130), '2026-10-12T16:01:00Z')
  assert.equal(total(changed).amount, 30)
  assert.equal(total(changed, '2026-10-12').amount, 0)
  assert.equal(total(changed, '2026-10-01', '2026-10-13').partial, true)
})

test('observer preserves all settlement fields and never mutates input ledger, collections, profits, or exports', () => {
  const baseline = observe(data(row(100)), stamp)
  const imported = setAmount(baseline, 130)
  const originalJSON = JSON.stringify(imported)
  const result = observe(imported, next)
  assert.equal(JSON.stringify(imported), originalJSON)
  for (const field of Object.keys(imported).filter(field => field !== 'overviewRefundActivity')) assert.equal(result[field], imported[field])
  assert.deepEqual(Object.keys(result).filter(key => result[key] !== imported[key]), ['overviewRefundActivity'])
})

test('currency rounding avoids fractional-cent increases', () => {
  const baseline = observe(data(row(0.1)), stamp)
  const changed = observe(setAmount(baseline, 0.1 + 0.2), next)
  assert.equal(total(changed).amount, 0.2)
})
