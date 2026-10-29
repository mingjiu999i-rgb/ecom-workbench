const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
const { buildPerformance } = require('../src/utils/performanceSummary.ts')
const product = (date, extra = {}) => ({ storeId: 'a', productId: 'p', date, amount: 100, cost: 40, promotion: 10, operationFee: 5, estimatedProfit: 45, ...extra })
const collection = (date, extra = {}) => ({ storeId: 'a', date, effectiveSales: 100, originalSales: 100, productCost: 40, promotionFee: 10, shippedRefund: 5, orderShippedRefund: 5, refundBasis: 'order_paid_at', missingCostOrders: 0, ...extra })
const fixture = (profitRecords, collectionRecords = []) => ({ stores: [{ id: 'a', clientId: 'c' }, { id: 'b', clientId: 'c' }], clients: [{ id: 'c' }], profitRecords, collectionRecords })
const report = (data, start = '2026-10-01', end = '2026-10-03', store = 'a') => buildPerformance(data, start, end, store, '2026-10-03')

test('trend reads saved net estimated profits once, retains losses and known zero, without mutating data', () => {
  const data = fixture([product('2026-10-01'), product('2026-10-02', { estimatedProfit: -12 }), product('2026-10-03', { estimatedProfit: 0 })], ['01', '02', '03'].map(day => collection(`2026-10-${day}`)))
  const before = JSON.stringify(data)
  const result = report(data)
  assert.deepEqual(result.trend.map(row => row.profit), [45, -12, 0])
  assert.equal(result.trend.reduce((sum, row) => sum + row.profit, 0), result.total.profit)
  assert.deepEqual(result.trend.map(row => row.amount), [5, 5, 5])
  assert.equal(JSON.stringify(data), before)
})

test('no profit records and missing monetary fields remain unknown, including mixed known/unknown products', () => {
  assert.equal(report(fixture([], [collection('2026-10-01')])).trend[0].profit, null)
  assert.equal(report(fixture([])).trend[0].profit, null)
  for (const field of ['operationFee', 'estimatedProfit', 'amount', 'cost', 'promotion']) {
    for (const missing of [null, undefined, NaN, Infinity]) {
      const result = report(fixture([product('2026-10-01'), product('2026-10-01', { [field]: missing })]))
      assert.equal(result.trend[0].profit, null, field)
      assert.match(result.trend[0].profitNote, /缺少/)
    }
  }
})

test('incomplete cost, promotion or unsynced products cannot produce a misleading complete daily profit', () => {
  for (const extra of [{ productCost: null }, { missingCostOrders: 1 }, { promotionFeeKnown: false }, { effectiveSales: 200 }]) {
    const row = report(fixture([product('2026-10-01')], [collection('2026-10-01', extra)])).trend[0]
    assert.equal(row.profit, null)
    assert(row.profitNote)
  }
  const mixed = fixture([product('2026-10-01')], [collection('2026-10-01'), collection('2026-10-01', { storeId: 'b' })])
  assert.equal(report(mixed, undefined, undefined, '').trend[0].profit, null)
  const savedOnly = report(fixture([product('2026-10-01')])).trend[0]
  assert.equal(savedOnly.profit, 45)
  assert.equal(savedOnly.profitPartial, true)
})

test('store/date filters and monthly buckets include saved-profit-only months without inventing absent months', () => {
  const data = fixture([product('2026-09-30'), product('2026-10-01'), product('2026-10-01', { storeId: 'b', estimatedProfit: 100 }), product('2026-12-15', { estimatedProfit: -3 }), product('2027-01-01')])
  const result = report(data, '2026-10-01', '2026-12-31')
  assert.equal(result.monthly, true)
  assert.deepEqual(result.trend.map(row => [row.date, row.profit, row.amount]), [['2026-10', 45, null], ['2026-12', -3, null]])
  assert.equal(report(data).trend[0].profit, 45)
  assert.equal(report(data, undefined, undefined, '').trend[0].profit, 145)
  const clipped = report(data, '2026-09-30', '2026-12-15')
  assert.equal(clipped.trend[0].start, '2026-09-30')
  assert.equal(clipped.trend.at(-1).end, '2026-12-15')
})
