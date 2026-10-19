const assert = require('node:assert/strict'), { test } = require('node:test'), fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
const { preparePddAccounting } = require('../src/utils/pddLedger.ts')
const { observeOverviewRefunds, summarizeOverviewRefundTotals } = require('../src/utils/overviewRefundActivity.ts')
const { createStoreBusinessBackup, resetStoreBusiness, restoreStoreBusiness, storeBusinessSummary, validateStoreBusinessBackup, backupMatchesStore } = require('../src/utils/storeBusinessReset.ts')
const now = '2026-10-19T02:00:00Z', account = 'test@example.invalid'
const fixture = () => {
  let data = { clients: [{ id: 'client', name: '甲方' }], stores: [{ id: 'a', name: '甲店', clientId: 'client' }, { id: 'b', name: '乙店', clientId: 'client' }], products: [{ id: 'product', name: '产品', operationRate: .02 }], productLinks: [{ storeId: 'a', linkId: 'listing' }], skus: [{ id: 'sku' }], productCosts: [{ id: 'cost', totalCost: 30 }], operations: [{ storeId: 'a' }], skuHistory: [], todos: [{ storeId: 'a' }], skuPlanningDrafts: [{ cost: 50 }], customExtension: { untouched: true }, profitRecords: [], collectionRecords: [], orderAccountingLedgers: [], linkSalesOrders: [], linkSalesPromotions: [] }
  for (const store of data.stores) {
    const order = { id: 'same-order', shop: store.name, payTime: '2026-10-01', payDate: '2026-10-01', receipt: 100, status: '已发货', productId: 'listing', product: '产品', specification: '一箱', skuCode: 'sku', quantity: 2 }
    const refund = { id: 'refund', orderId: order.id, shop: store.name, status: '退款成功', stage: '已发货', refundAmount: 20 }
    const fund = { key: 'fund', orderId: order.id, shop: store.name, income: 100, expense: 0, businessCode: '0010002', category: 'positive' }
    const input = { storeId: store.id, shop: store.name, orders: [order], refunds: [refund], funds: [fund, { ...fund, key: 'refund-fund', income: 0, expense: -20, businessCode: '0020002', category: 'refund' }], promotions: [{ key: 'promo', shop: store.name, date: order.payDate, amount: 10 }], reportTypes: new Set(['orders', 'refunds', 'funds', 'promotions']), savedRecords: [], savedProfits: [], resolveCost: () => ({ cost: 30, productId: 'product' }), linkedProductId: () => 'product', products: data.products }
    const result = preparePddAccounting(input)
    data.orderAccountingLedgers.push(result.ledger)
    data.collectionRecords.push(...result.summaries.map(({ shop, ...row }) => ({ ...row, id: `collection-${store.id}`, storeId: store.id, refundBasis: 'order_paid_at', updatedAt: now })))
    data.profitRecords.push(...result.productMetrics.map(({ rate, ...row }) => ({ ...row, id: `profit-${store.id}`, storeId: store.id, operationRate: rate, updatedAt: now })))
    data.linkSalesOrders.push({ storeId: store.id, orderId: order.id, goodsId: 'listing', name: '产品', date: order.payDate, status: '已发货', receipt: 100, quantity: 2, supplement: false })
    data.linkSalesPromotions.push({ storeId: store.id, goodsId: 'listing', date: order.payDate, amount: 12 })
  }
  return observeOverviewRefunds(data, now)
}
const backup = data => createStoreBusinessBackup(data, 'a', account, now)
const reset = data => resetStoreBusiness(data, backup(data), account, '甲店')

test('single store reset clears every business scope but not store/catalog/SKU/cost/planning or another store', () => {
  const data = fixture(), original = JSON.stringify(data), next = reset(data)
  for (const field of ['collectionRecords','profitRecords','orderAccountingLedgers','linkSalesOrders','linkSalesPromotions']) {
    assert.equal(next[field].some(row => row.storeId === 'a'), false, field)
    assert.equal(next[field][0], data[field].find(row => row.storeId === 'b'), field)
  }
  for (const field of ['clients','stores','products','productLinks','skus','productCosts','operations','skuHistory','todos','skuPlanningDrafts','customExtension']) assert.equal(next[field], data[field], field)
  assert.equal(JSON.stringify(data), original)
  assert.equal(storeBusinessSummary(next, 'a').hasData, false)
  assert.equal(storeBusinessSummary(next, 'b').hasData, true)
})
test('selected store overview balances, opening and changes removed without generating a negative refund adjustment', () => {
  const data = fixture(), next = reset(data), observed = observeOverviewRefunds(next, now)
  assert.equal(observed, next)
  assert.equal(summarizeOverviewRefundTotals(next, '2026-10-19', new Set(['b'])).after, 20)
  for (const key of ['balances','changes']) assert.equal(next.overviewRefundActivity[key].some(row => row.storeId === 'a'), false)
  assert.equal(next.overviewRefundActivity.dayOpening.balances.some(row => row.storeId === 'a'), false)
})
test('backup is a detached snapshot with no other store records and round-trips through JSON', () => {
  const data = fixture(), saved = backup(data)
  validateStoreBusinessBackup(JSON.parse(JSON.stringify(saved)))
  data.orderAccountingLedgers[0].orders[0].unitCost = 999
  assert.equal(saved.scope.orderAccountingLedgers[0].orders[0].unitCost, 30)
  for (const key of ['collectionRecords','profitRecords','orderAccountingLedgers','linkSalesOrders','linkSalesPromotions']) assert.ok(saved.scope[key].every(row => row.storeId === 'a'))
  assert.ok(saved.scope.overview.balances.every(row => row.storeId === 'a'))
})
test('store and complete name plus original account are required; no all-store wildcard', () => {
  const data = fixture(), saved = backup(data)
  assert.throws(() => createStoreBusinessBackup(data, '', account, now))
  assert.throws(() => createStoreBusinessBackup(data, 'missing', account, now))
  assert.throws(() => resetStoreBusiness(data, saved, account, '甲'))
  assert.throws(() => resetStoreBusiness(data, saved, 'wrong', '甲店'))
  const otherClient = structuredClone(data); otherClient.stores[0].clientId = 'changed'
  assert.throws(() => resetStoreBusiness(otherClient, saved, account, '甲店'))
})
test('new data after backup blocks clear but other-store edits do not block or get lost', () => {
  const data = fixture(), saved = backup(data)
  const changed = structuredClone(data); changed.orderAccountingLedgers[0].orders[0].receipt = 55
  assert.equal(backupMatchesStore(changed, saved), false)
  assert.throws(() => resetStoreBusiness(changed, saved, account, '甲店'), /暂存期间/)
  const other = structuredClone(data); other.orderAccountingLedgers[1].orders[0].receipt = 77
  assert.equal(resetStoreBusiness(other, saved, account, '甲店').orderAccountingLedgers[0].orders[0].receipt, 77)
})
test('same-day restore restores exact financial values and locked snapshots, preserves other-store changes', () => {
  const data = fixture(), saved = backup(data), empty = resetStoreBusiness(data, saved, account, '甲店')
  empty.orderAccountingLedgers[0].orders[0].unitCost = 123
  const next = restoreStoreBusiness(empty, saved, account, '甲店', now)
  for (const key of ['collectionRecords','profitRecords','orderAccountingLedgers','linkSalesOrders','linkSalesPromotions']) assert.deepEqual(next[key].filter(row => row.storeId === 'a'), data[key].filter(row => row.storeId === 'a'))
  assert.equal(next.orderAccountingLedgers.find(row => row.storeId === 'b').orders[0].unitCost, 123)
  assert.equal(observeOverviewRefunds(next, now).overviewRefundActivity.changes.length, data.overviewRefundActivity.changes.length)
})
test('restore refuses to overwrite any freshly reimported business records', () => {
  const data = fixture(), saved = backup(data)
  assert.throws(() => restoreStoreBusiness(data, saved, account, '甲店', now), /已有经营数据/)
  const next = reset(data); next.linkSalesPromotions.push({ storeId: 'a', goodsId: 'x', date: '2026-10-19', amount: 0 })
  assert.throws(() => restoreStoreBusiness(next, saved, account, '甲店', now), /已有经营数据/)
})
test('later-day restoration establishes display baseline without inventing newly added refunds', () => {
  const data = fixture(), saved = backup(data), later = '2026-10-20T03:00:00Z'
  const next = restoreStoreBusiness(observeOverviewRefunds(reset(data), later), saved, account, '甲店', later)
  assert.equal(summarizeOverviewRefundTotals(next, '2026-10-20', new Set(['a'])).amount, 0)
  assert.equal(observeOverviewRefunds(next, later).overviewRefundActivity.changes.length, next.overviewRefundActivity.changes.length)
})
test('legacy accounts without sidecar or overview metadata remain resettable and restorable', () => {
  const data = fixture(); delete data.linkSalesOrders; delete data.linkSalesPromotions; delete data.overviewRefundActivity
  const saved = backup(data), next = restoreStoreBusiness(reset(data), saved, account, '甲店', now)
  assert.equal(next.linkSalesOrders, undefined)
  assert.equal(summarizeOverviewRefundTotals(next, '2026-10-19', new Set(['a'])).amount, 0)
  assert.deepEqual(next.collectionRecords.find(row => row.storeId === 'a'), data.collectionRecords.find(row => row.storeId === 'a'))
})
test('restoration rejects malformed, wrong-version or cross-store backup records', () => {
  const saved = backup(fixture())
  const corrupt = change => { const value = structuredClone(saved); change(value); assert.throws(() => validateStoreBusinessBackup(value)) }
  corrupt(value => value.version = 99)
  corrupt(value => value.scope.collectionRecords[0].storeId = 'b')
  corrupt(value => value.scope.orderAccountingLedgers[0].orders[0].unitCost = '30')
  corrupt(value => value.scope.orderAccountingLedgers[0].funds[0].category = 'bad')
  corrupt(value => value.scope.linkSalesPromotions[0].amount = Infinity)
  corrupt(value => value.scope.overview.balances[0].storeId = 'b')
  corrupt(value => value.scope.profitRecords = 'not-array')
  assert.throws(() => validateStoreBusinessBackup({}))
})
test('cleared ledger really allows original orders to be reimported without stale dedup, costs or refunds', () => {
  const data = reset(fixture())
  assert.equal(data.orderAccountingLedgers.some(ledger => ledger.storeId === 'a'), false)
  const result = preparePddAccounting({ storeId: 'a', shop: '甲店', orders: [{ id: 'same-order', shop: '甲店', payDate: '2026-10-01', receipt: 50, status: '已发货', product: '产品', quantity: 1 }], refunds: [], funds: [], promotions: [], reportTypes: new Set(['orders']), savedRecords: [], savedProfits: [], resolveCost: () => ({ cost: 15, productId: 'product' }), linkedProductId: () => 'product', products: data.products })
  assert.equal(result.ledger.orders[0].unitCost, 15)
  assert.equal(result.ledger.refunds.length, 0)
  assert.equal(result.summaries[0].originalSales, 50)
})
