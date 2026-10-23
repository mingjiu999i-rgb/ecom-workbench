const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { reconcile } = require('../tools/reconcile-workbench-sources.cjs')

const write = (dir, name, value) => { const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify(value)); return file }
const base = amount => ({
  stores: [{ id: 's', name: '店铺' }],
  todos: [{ id: 'same', title: '保留' }, { id: 'money', amount, updatedAt: '2026-10-22T00:00:00Z' }],
  linkSalesOrders: [{ storeId: 's', orderId: 'o', salesAmount: 10 }],
  orderAccountingLedgers: [{ storeId: 's', orders: [{ id: 'o', unitCost: null, receipt: 0 }], refunds: [], funds: [{ key: 'f', income: 0, expense: 3 }], promotions: [] }],
})

test('three-source reconciliation is read-only, preserves null/zero and classifies conflicts without choosing a winner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-reconcile-'))
  const cloud = base(10), windows = base(11), mac = base(10)
  windows.todos.push({ id: 'windows-new', amount: 0 })
  mac.todos.push({ id: 'mac-new', amount: null })
  const report = reconcile({ cloud: write(dir, 'cloud.json', { data: cloud, revision: '7' }), windows: write(dir, 'windows.json', windows), mac: write(dir, 'mac.json', mac) })
  assert.equal(report.read_only, true)
  assert.equal(report.complete, true)
  assert.equal(report.consistent, false)
  assert.equal(report.summary.conflict, 1)
  assert.equal(report.summary.windows_only, 1)
  assert.equal(report.summary.mac_only, 1)
  const conflict = report.categories.conflict[0]
  assert.deepEqual(conflict.core_amounts, { cloud: { amount: 10 }, windows: { amount: 11 }, mac: { amount: 10 } })
  assert.match(conflict.interpretation, /无法自动判断/)
})

test('missing source or duplicate business key makes reconciliation incomplete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-reconcile-'))
  const windows = base(10); windows.todos.push({ ...windows.todos[0] })
  const report = reconcile({ cloud: null, windows: write(dir, 'windows.json', windows), mac: path.join(dir, 'missing.json') })
  assert.equal(report.complete, false)
  assert.equal(report.consistent, false)
  assert.ok(report.categories.unknown.some(row => row.source === 'cloud'))
  assert.ok(report.categories.unknown.some(row => row.reason === 'duplicate-business-key'))
})
