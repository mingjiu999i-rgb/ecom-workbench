const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
const { performanceTrendColumn: column } = require('../src/utils/performanceTrendColumn.ts')

test('one column uses the saved profit endpoint, refund interval and display-only difference without adding the three values', () => {
  const row = column(2196.8, 875.44)
  assert.equal(row.profit, 2196.8)
  assert.equal(row.refund, 875.44)
  assert.equal(row.balance, 1321.36)
  assert.deepEqual(row.resultRange, { low: 0, high: 1321.36 })
  assert.deepEqual(row.refundRange, { low: 1321.36, high: 2196.8 })
  assert.equal(row.high, 2196.8)
  assert.equal(row.overlap, false)
})

test('refund exceeding profit and already negative profits extend below zero without losing either interval', () => {
  for (const [profit, refund, balance] of [[100, 150, -50], [-100, 30, -130], [0, 50, -50]]) {
    const row = column(profit, refund)
    assert.equal(row.balance, balance)
    assert.equal(row.refundRange.high - row.refundRange.low, refund)
    assert.equal(row.resultRange.low, balance)
    assert.equal(row.low, balance)
    assert.equal(row.overlap, true)
  }
})

test('known zero and cent precision remain exact; unknown inputs never become a zero difference', () => {
  assert.equal(column(100, 0).balance, 100)
  assert.equal(column(100, 100).balance, 0)
  assert.equal(column(0, 0).balance, 0)
  assert.equal(column(0.3, 0.1).balance, 0.2)
  for (const missing of [null, undefined, NaN, Infinity]) {
    assert.equal(column(missing, 10).balance, null)
    assert.equal(column(10, missing).balance, null)
  }
  assert.deepEqual(column(null, 10).refundRange, { low: 0, high: 10 })
  assert.equal(column(null, null).resultRange, null)
})
