const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
const { parseLinkSalesRows, mergeLinkSalesOrders, summarizeLinkSales, putLinkPromotions, getLinkSalesOrders, linkKey, linkDate, linkNumber } = require('../src/utils/linkSales.ts')
const row = (extra = {}) => ({ '订单号': 'order-1', '商品id': '869083513281', '商品': '水果', '订单成交时间': '2026-10-14 12:34:56', '订单状态': '已发货，待收货', '商家实收金额(元)': '10', '商品数量(件)': '1', ...extra })
const base = () => ({ clients: [], stores: [{ id: 'a', clientId: 'client' }, { id: 'b', clientId: 'client' }], products: [], productLinks: [], skus: [], productCosts: [], operations: [], skuHistory: [], todos: [], profitRecords: [{ amount: 88 }], collectionRecords: [{ profit: 42 }], orderAccountingLedgers: [{ storeId: 'a', orders: [{ id: 'order-1', date: '2026-10-14', unitCost: 4, quantity: 1, supplement: false }], refunds: [{ amount: 200 }], funds: [], promotions: [{ date: '2026-10-14', amount: 999 }] }] })
const imported = (data = base(), rows = [row()], store = 'a') => mergeLinkSalesOrders(data, parseLinkSalesRows(store, rows))
const ad = (data, amount, date = '2026-10-14', storeId = 'a', goodsId = '869083513281') => putLinkPromotions(data, [{ storeId, goodsId, date, amount }])

test('reads report listing ID, never order digits or internal product ID', () => {
  const data = imported()
  assert.equal(getLinkSalesOrders(data)[0].goodsId, '869083513281')
  assert.equal(summarizeLinkSales(data).summary[0].goodsId, '869083513281')
})
test('reimport is idempotent and overlapping reports retain history', () => {
  const first = imported(), again = imported(first)
  assert.equal(first, again)
  const next = imported(again, [row({ '订单号': 'order-2' })])
  assert.equal(getLinkSalesOrders(next).length, 2)
  assert.equal(summarizeLinkSales(next).summary[0].sales, 20)
})
test('store + order and store + listing keep stores independent', () => {
  const data = imported(imported(), [row()], 'b')
  assert.equal(summarizeLinkSales(data).summary.length, 2)
  assert.equal(summarizeLinkSales(ad(data, 0)).summary.find(r => r.storeId === 'b').promotion, null)
  assert.notEqual(linkKey('a|b', 'c'), linkKey('a', 'b|c'))
})
test('null ads versus explicit zero and deletion remain different', () => {
  const data = imported()
  assert.equal(summarizeLinkSales(data).summary[0].profit, null)
  assert.equal(summarizeLinkSales(ad(data, 0)).summary[0].profit, 6)
  assert.equal(summarizeLinkSales(ad(ad(data, 0), null)).summary[0].profit, null)
})
test('uses original cost snapshot rather than edited cost library; never deducts refund amounts', () => {
  const data = imported(); data.productCosts = [{ totalCost: 99 }]
  const metric = summarizeLinkSales(ad(data, 2)).summary[0]
  assert.equal(metric.sales, 10); assert.equal(metric.cost, 4); assert.equal(metric.profit, 4); assert.equal(metric.margin, .4)
  data.orderAccountingLedgers[0].refunds = [{ orderId: 'order-1', amount: 999999, success: true, stage: '已发货' }]
  assert.deepEqual(summarizeLinkSales(ad(data, 2)).summary[0], metric)
})
test('unshipped successful refund contributes no sales, units, order count or cost', () => {
  const data = imported(base(), [row({ '订单状态': '未发货，退款成功' })])
  const metric = summarizeLinkSales(ad(data, 0)).summary[0]
  assert.equal(metric.orders, 0); assert.equal(metric.quantity, 0); assert.equal(metric.sales, 0); assert.equal(metric.cost, 0); assert.equal(metric.profit, 0)
})
test('missing cost or amount never becomes zero or a partial total', () => {
  const data = imported(base(), [row(), row({ '订单号': 'order-2', '商家实收金额(元)': '' })])
  const metric = summarizeLinkSales(ad(data, 0)).summary[0]
  assert.equal(metric.sales, null); assert.equal(metric.cost, null); assert.equal(metric.profit, null); assert.equal(metric.missingCost, 1)
})
test('zero cost snapshot remains known', () => {
  const data = base(); data.orderAccountingLedgers[0].orders[0].unitCost = 0
  assert.equal(summarizeLinkSales(ad(imported(data), 0)).summary[0].profit, 10)
})
test('pending or cancelled orders excluded; missing dates and IDs reported without guessing', () => {
  const data = imported(base(), [row({ '订单号': 'pending', '订单状态': '待付款' }), row({ '订单号': 'cancelled', '订单状态': '已取消' }), row({ '订单号': 'date', '订单成交时间': '' }), row({ '订单号': 'id', '商品id': '' })])
  const metric = summarizeLinkSales(data, { start: '2026-10-14', end: '2026-10-14' })
  assert.equal(metric.daily.length, 0); assert.equal(metric.pending.length, 2)
  assert.equal(metric.unindexed, 1)
})
test('conflicting report listing IDs are quarantined instead of moving historical orders', () => {
  const data = imported(imported(), [row({ '商品id': 'another' })])
  assert.equal(summarizeLinkSales(data).summary.length, 0)
  assert.equal(summarizeLinkSales(data).pending[0].conflict, true)
})
test('period totals reconcile by listing and date, missing day ad blocks period profit', () => {
  let data = imported(); data = imported(data, [row({ '订单号': 'order-2', '订单成交时间': '2026-10-15' })])
  data.orderAccountingLedgers[0].orders.push({ id: 'order-2', date: '2026-10-15', unitCost: 3, supplement: false })
  let report = summarizeLinkSales(ad(data, 2))
  assert.equal(report.summary[0].sales, 20); assert.equal(report.summary[0].promotion, null); assert.equal(report.summary[0].missingPromotion, 1)
  report = summarizeLinkSales(ad(ad(data, 2), 1, '2026-10-15'))
  assert.equal(report.summary[0].profit, 10); assert.equal(report.summary[0].cost, 7); assert.equal(report.summary[0].promotion, 3)
  assert.equal(report.daily.reduce((sum, row) => sum + row.profit, 0), report.summary[0].profit)
  assert.equal(summarizeLinkSales(data, { start: '2026-10-15', end: '2026-10-15' }).summary[0].sales, 10)
})
test('analysis updates never modify protected finance data or unknown extensions', () => {
  const data = base(); data.skuPlanningDrafts = [{ cost: 5 }]
  const snapshot = JSON.stringify(data)
  const next = ad(imported(data), 3)
  assert.equal(JSON.stringify(data), snapshot)
  for (const key of Object.keys(data)) assert.equal(next[key], data[key], key)
})
test('invalid dates, fractional quantities, invalid money stay unknown', () => {
  assert.equal(linkDate('2026-02-30'), null); assert.equal(linkDate('2026-10-14'), '2026-10-14')
  assert.equal(linkNumber(''), null); assert.equal(linkNumber('NaN'), null); assert.equal(linkNumber('0'), 0)
  const metric = summarizeLinkSales(imported(base(), [row({ '商品数量(件)': '1.5' })])).summary[0]
  assert.equal(metric.quantity, null); assert.equal(metric.cost, null)
})
test('promotion batch validation is atomic and rejects negative or overprecise inputs', () => {
  const data = imported(), before = JSON.stringify(data)
  assert.throws(() => ad(data, -1)); assert.throws(() => ad(data, .001)); assert.throws(() => ad(data, Infinity))
  assert.throws(() => putLinkPromotions(data, [{ storeId: 'a', goodsId: 'x', date: '2026-10-14', amount: 1 }, { storeId: 'a', goodsId: 'x', date: '2026-02-30', amount: 2 }]))
  assert.equal(JSON.stringify(data), before)
})
test('supplement revenue does not create units or cost', () => {
  const report = summarizeLinkSales(ad(imported(base(), [row({ '商品': '补收差价' })]), 0))
  assert.equal(report.summary[0].quantity, 0); assert.equal(report.summary[0].cost, 0); assert.equal(report.summary[0].profit, 10)
})
test('saved advertising is retained even when all source orders later become cancelled', () => {
  const data = imported(ad(imported(), 2), [row({ '订单状态': '已取消' })])
  const metric = summarizeLinkSales(data).summary[0]
  assert.equal(metric.promotion, 2); assert.equal(metric.sales, null); assert.equal(metric.profit, null)
})
test('after-sale-only refresh excludes unshipped refunds from existing listing history without reimporting orders', () => {
  const data = imported()
  data.orderAccountingLedgers[0].refunds = [{ id: 'refund', orderId: 'order-1', success: true, stage: '未发货', amount: 1 }]
  const before = JSON.stringify(data)
  const metric = summarizeLinkSales(ad(data, 2)).summary[0]
  assert.equal(metric.quantity, 0); assert.equal(metric.sales, 0); assert.equal(metric.cost, 0); assert.equal(metric.profit, -2)
  assert.equal(JSON.stringify(data), before)
  data.orderAccountingLedgers[0].refunds[0].amount = 99999
  assert.deepEqual(summarizeLinkSales(ad(data, 2)).summary[0], metric)
})
test('mixed unshipped/shipped refunds exclude only unshipped rows and preserve original shipped costs', () => {
  const data = imported(base(), [row({ '订单状态': '未发货，退款成功' }), row({ '订单号': 'order-2', '订单状态': '已发货，退款成功', '商家实收金额(元)': '20', '商品数量(件)': '2' })])
  data.orderAccountingLedgers[0].orders.push({ id: 'order-2', date: '2026-10-14', unitCost: 4, supplement: false })
  data.orderAccountingLedgers[0].refunds = [{ orderId: 'order-2', success: true, stage: '已发货', amount: 20 }]
  const metric = summarizeLinkSales(ad(data, 3)).summary[0]
  assert.equal(metric.orders, 1); assert.equal(metric.quantity, 2); assert.equal(metric.sales, 20); assert.equal(metric.cost, 8); assert.equal(metric.profit, 9)
})
test('pending/failed unshipped refunds never remove valid sales', () => {
  const data = imported(base(), [row({ '订单状态': '未发货，退款中' })])
  data.orderAccountingLedgers[0].refunds = [{ orderId: 'order-1', success: false, stage: '未发货', amount: 10 }]
  assert.equal(summarizeLinkSales(ad(data, 0)).summary[0].sales, 10)
  assert.equal(summarizeLinkSales(ad(data, 0)).summary[0].cost, 4)
})
test('unshipped refund exclusion is scoped by store plus full order ID', () => {
  const data = imported(imported(), [row()], 'b')
  data.orderAccountingLedgers[0].refunds = [{ orderId: 'order-1', success: true, stage: '未发货', amount: 10 }]
  const report = summarizeLinkSales(data)
  assert.equal(report.summary.find(row => row.storeId === 'a').sales, 0)
  assert.equal(report.summary.find(row => row.storeId === 'b').sales, 10)
  assert.equal(report.summary.find(row => row.storeId === 'b').cost, null)
})
test('all-unshipped-refund date remains available for ad entry, blank ads remain unknown', () => {
  const data = imported(base(), [row({ '订单状态': '未发货，退款成功', '商家实收金额(元)': '', '商品数量(件)': '' })])
  data.orderAccountingLedgers[0].orders[0].unitCost = null
  const report = summarizeLinkSales(data)
  assert.equal(report.daily[0].date, '2026-10-14'); assert.equal(report.daily[0].orders, 0)
  assert.equal(report.daily[0].missingCost, 0); assert.equal(report.daily[0].sales, 0); assert.equal(report.daily[0].cost, 0)
  assert.equal(report.daily[0].promotion, null); assert.equal(report.daily[0].profit, null)
})
test('period sums preserve ad spend on excluded-only days and reconcile with daily rows', () => {
  const data = imported(base(), [row({ '订单状态': '未发货，退款成功' }), row({ '订单号': 'order-2', '订单成交时间': '2026-10-15' })])
  data.orderAccountingLedgers[0].orders.push({ id: 'order-2', date: '2026-10-15', unitCost: 4, supplement: false })
  const report = summarizeLinkSales(ad(ad(data, 2), 3, '2026-10-15'))
  assert.equal(report.summary[0].quantity, 1); assert.equal(report.summary[0].orders, 1)
  assert.equal(report.summary[0].sales, 10); assert.equal(report.summary[0].cost, 4); assert.equal(report.summary[0].promotion, 5); assert.equal(report.summary[0].profit, 1)
  assert.equal(report.daily.reduce((n, row) => n + row.profit, 0), report.summary[0].profit)
})
test('excluded refunds do not invent listing/date mappings or require irrelevant historical mappings', () => {
  const data = imported(base(), [row({ '订单状态': '未发货，退款成功', '订单成交时间': '', '商品id': '' })])
  data.orderAccountingLedgers[0].refunds = [{ orderId: 'order-1', success: true, stage: '未发货', amount: 10 }]
  const report = summarizeLinkSales(data)
  assert.equal(report.daily.length, 0); assert.equal(report.unindexed, 0)
  delete data.linkSalesOrders
  assert.equal(summarizeLinkSales(data).unindexed, 0)
})
