const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
const { preparePddAccounting } = require('../src/utils/pddLedger.ts')
const { observeOverviewRefunds } = require('../src/utils/overviewRefundActivity.ts')
const { createStoreBusinessBackup, resetStoreBusiness, restoreStoreBusiness, storeBusinessSummary, storeBusinessDates, validateStoreBusinessBackup, backupMatchesStore } = require('../src/utils/storeBusinessReset.ts')

const day = '2026-10-01', nextDay = '2026-10-02', now = '2026-10-19T02:00:00Z', account = 'qa@example.invalid'
function fixture() {
  const data = { clients: [{ id: 'client', name: '甲方' }], stores: [{ id: 'a', name: '甲店', clientId: 'client' }, { id: 'b', name: '乙店', clientId: 'client' }], products: [{ id: 'p', name: '水果', operationRate: 0 }], productLinks: [], productCosts: [], skus: [], skuPlanningDrafts: [], profitRecords: [], collectionRecords: [], orderAccountingLedgers: [], linkSalesOrders: [], linkSalesPromotions: [] }
  for (const store of data.stores) {
    const orders = [day, nextDay].map((date, index) => ({ id: `${store.id}-${index}`, shop: store.name, payTime: date, payDate: date, receipt: 100 + index, status: '已发货', productId: 'p', product: '水果', specification: '一箱', skuCode: 'sku', quantity: 1 }))
    const refunds = orders.map((order, index) => ({ id: `${store.id}-refund-${index}`, orderId: order.id, shop: store.name, status: '退款成功', stage: '已发货', refundAmount: 10 + index }))
    const funds = orders.map((order, index) => ({ key: `${store.id}-fund-${index}`, orderId: order.id, shop: store.name, income: 100 + index, expense: 0, businessCode: '0010002', category: 'positive' }))
    const promotions = orders.map((order, index) => ({ key: `${store.id}-promo-${index}`, shop: store.name, date: order.payDate, amount: 5 + index }))
    const result = preparePddAccounting({ storeId: store.id, shop: store.name, orders, refunds, funds, promotions, reportTypes: new Set(['orders', 'refunds', 'funds', 'promotions']), savedRecords: [], savedProfits: [], resolveCost: () => ({ cost: 20, productId: 'p' }), linkedProductId: () => 'p', products: data.products })
    data.orderAccountingLedgers.push(result.ledger)
    data.collectionRecords.push(...result.summaries.map(({ shop, ...row }) => ({ ...row, id: `collection-${store.id}-${row.date}`, storeId: store.id, refundBasis: 'order_paid_at', updatedAt: now })))
    data.profitRecords.push(...result.productMetrics.map(({ rate, ...row }) => ({ ...row, id: `profit-${store.id}-${row.date}`, storeId: store.id, operationRate: rate, updatedAt: now })))
    data.linkSalesOrders.push(...orders.map(order => ({ storeId: store.id, orderId: order.id, goodsId: 'p', name: '水果', date: order.payDate, status: order.status, receipt: order.receipt, quantity: 1, supplement: false })))
    data.linkSalesPromotions.push(...orders.map(order => ({ storeId: store.id, goodsId: 'p', date: order.payDate, amount: 5 })))
  }
  data.orderAccountingLedgers[0].funds.push({ key: 'unmatched', orderId: 'not-in-ledger', income: 1, expense: 0, businessCode: '0010002', category: 'positive' })
  data.profitBaselines = data.stores.flatMap(store => [day, nextDay].map(date => ({ id: `baseline-${store.id}-${date}`, storeId: store.id, date, recordedAt: now, orderCount: 1, collectionProfit: 65, products: [{ productId: 'p', estimatedProfit: 60 }] })))
  return observeOverviewRefunds(data, now)
}
const save = data => createStoreBusinessBackup(data, 'a', account, now, day)
const clear = (data, backup = save(data)) => resetStoreBusiness(data, backup, account, '甲店')

test('one-day reset removes only that day and its linked transactions; unknown-date rows remain', () => {
  const data = fixture(), backup = save(data), original = structuredClone(data)
  validateStoreBusinessBackup(backup)
  assert.deepEqual(storeBusinessDates(data, 'a'), [nextDay, day])
  assert.equal(backup.targetDate, day)
  assert.equal(backup.scope.orderAccountingLedgers[0].orders.length, 1)
  const cleared = clear(data, backup)
  assert.equal(storeBusinessSummary(cleared, 'a', day).hasData, false)
  assert.equal(storeBusinessSummary(cleared, 'a', nextDay).hasData, true)
  assert.equal(storeBusinessSummary(cleared, 'b', day).hasData, true)
  for (const key of ['collectionRecords', 'profitRecords', 'linkSalesOrders', 'linkSalesPromotions', 'profitBaselines']) {
    assert.deepEqual(cleared[key].filter(row => row.storeId === 'a'), data[key].filter(row => row.storeId === 'a' && row.date === nextDay), key)
    assert.deepEqual(cleared[key].filter(row => row.storeId === 'b'), data[key].filter(row => row.storeId === 'b'), key)
  }
  const ledger = cleared.orderAccountingLedgers.find(row => row.storeId === 'a')
  assert.deepEqual(ledger.orders.map(row => row.id), ['a-1'])
  assert.deepEqual(ledger.refunds.map(row => row.orderId), ['a-1'])
  assert.deepEqual(ledger.funds.map(row => row.orderId), ['a-1', 'not-in-ledger'])
  assert.deepEqual(ledger.promotions.map(row => row.date), [nextDay])
  assert.deepEqual(ledger.initializedDates, [nextDay])
  assert.equal(cleared.overviewRefundActivity.balances.some(row => row.storeId === 'a' && row.orderDate === day), false)
  assert.equal(observeOverviewRefunds(cleared, now), cleared)
  assert.deepEqual(data, original)
})

test('one-day undo restores original values while another day can change; reimport blocks undo', () => {
  const data = fixture(), backup = save(data)
  const changed = structuredClone(data)
  changed.orderAccountingLedgers[0].orders[1].unitCost = 44
  changed.profitBaselines.find(row => row.storeId === 'a' && row.date === nextDay).collectionProfit = 77
  assert.equal(backupMatchesStore(changed, backup), true)
  const cleared = clear(changed, backup)
  const restored = restoreStoreBusiness(cleared, backup, account, '甲店', now)
  const ledger = restored.orderAccountingLedgers.find(row => row.storeId === 'a')
  assert.equal(ledger.orders.find(row => row.date === day).unitCost, 20)
  assert.equal(ledger.orders.find(row => row.date === nextDay).unitCost, 44)
  assert.equal(restored.profitBaselines.find(row => row.storeId === 'a' && row.date === day).collectionProfit, 65)
  assert.equal(restored.profitBaselines.find(row => row.storeId === 'a' && row.date === nextDay).collectionProfit, 77)
  assert.equal(storeBusinessSummary(restored, 'a', day).hasData, true)
  assert.equal(observeOverviewRefunds(restored, now), restored)
  assert.throws(() => restoreStoreBusiness(restored, backup, account, '甲店', now), /已有经营数据/)
  const reimported = structuredClone(cleared)
  reimported.collectionRecords.push(data.collectionRecords.find(row => row.storeId === 'a' && row.date === day))
  assert.throws(() => restoreStoreBusiness(reimported, backup, account, '甲店', now), /已有经营数据/)
})

test('selected-date changes during backup block reset; malformed dates and mixed-date backups are rejected', () => {
  const data = fixture(), backup = save(data)
  const changed = structuredClone(data)
  changed.orderAccountingLedgers[0].orders[0].receipt = 999
  assert.equal(backupMatchesStore(changed, backup), false)
  assert.throws(() => clear(changed, backup), /暂存期间/)
  assert.throws(() => createStoreBusinessBackup(data, 'a', account, now, '2026-10-32'), /有效的成交日期/)
  const mixed = structuredClone(backup)
  mixed.scope.collectionRecords[0].date = nextDay
  assert.throws(() => validateStoreBusinessBackup(mixed), /备份记录/)
})
