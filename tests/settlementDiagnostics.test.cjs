const assert = require('node:assert/strict'), { test } = require('node:test'), fs = require('node:fs'), ts = require('typescript')
const compile = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename)
require.extensions['.ts'] = compile; require.extensions['.tsx'] = compile; require.extensions['.css'] = () => {}
const { settlementDiagnostics } = require('../src/utils/settlementDiagnostics.ts')
const { settlementExportValidation, createSettlementWorkbook } = require('../src/utils/settlementWorkbook.ts')
const { SettlementExportWarnings } = require('../src/components/SettlementExportWarnings.tsx')
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server'), { MemoryRouter } = require('react-router-dom')
const options = { clientId: 'c' }, date = '2026-11-05'
function fixture() {
  return { clients: [{ id: 'c', name: '甲方' }], stores: [{ id: 'a', clientId: 'c', name: 'A店', storeStatus: '启用' }], products: [{ id: 'p', name: '产品' }], productCosts: [], productLinks: [],
    collectionRecords: [{ id: 'day', storeId: 'a', date, effectiveSales: 100, originalSales: 100, orderCount: 2, productCost: 30, promotionFee: 10, missingCostOrders: 0, shippedRefund: 0, couponRefund: 0, refundBasis: 'order_paid_at', eligibleOrders: 2, settledOrders: 2, currentNet: 100, unsettledAmount: 0, profit: 60, estimatedProfit: 60, mature: true, basicServiceFee: 0, afterSaleCompensation: 0, smallPayment: 0, appealReimbursement: 0, unknownFunds: 0, updatedAt: '2026-11-06T03:00:00Z' }],
    profitRecords: [{ id: 'profit', storeId: 'a', date, productId: 'p', amount: 99, cost: 30, promotion: 10, operationFee: 2, estimatedProfit: 57, grossProfit: 69, quantity: 1, margin: 57 / 99, updatedAt: '2026-11-06T03:00:00Z' }],
    orderAccountingLedgers: [{ storeId: 'a', initializedDates: [date], orders: [{ id: 'normal', date, receipt: 99, cancelled: false, quantity: 1, productId: 'p', unitCost: 30, supplement: false }, { id: 'supplement', date, receipt: 1, cancelled: false, quantity: 1, productId: '', unitCost: 0, supplement: true }], refunds: [], funds: [], promotions: [{ date, amount: 10 }] }],
    linkSalesOrders: [{ storeId: 'a', orderId: 'supplement', goodsId: 'goods-123', name: '补收差价', date, supplement: true, receipt: 1 }],
  }
}
const render = data => renderToStaticMarkup(React.createElement(MemoryRouter, {}, React.createElement(SettlementExportWarnings, { data, options, warnings: settlementExportValidation(data, options).warnings, syncStatus: 'saved', onInspect() {} })))

test('a one-yuan supplement explains the exact saved sales gap without changing any ledger, records or export amounts', () => {
  const data = fixture(), before = structuredClone(data), book = createSettlementWorkbook(data, options)
  const rows = settlementDiagnostics(data, options)
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.date, date); assert.equal(row.storeName, 'A店'); assert.equal(row.productRows, 1)
  assert.deepEqual(row.metrics.map(metric => [metric.key, metric.daily, metric.products, metric.difference, metric.flagged]), [['sales', 100, 99, -1, true], ['cost', 30, 30, 0, false], ['promotion', 10, 10, 0, false]])
  assert.equal(row.supplementMatchesSalesGap, true)
  assert.equal(row.unassignedOriginalAmount, 1)
  assert.equal(row.unassignedOrders[0].id, 'supplement')
  assert.equal(row.unassignedOrders[0].goodsId, 'goods-123')
  assert.deepEqual(data, before)
  assert.deepEqual(createSettlementWorkbook(data, options), book)
  assert.match(settlementExportValidation(data, options).warnings[0], /1 天的产品利润数据尚未同步/)
})

test('no product records stay unknown, including a promotion-only day; they do not become zero or an invented difference', () => {
  const data = fixture(); data.profitRecords = []
  Object.assign(data.collectionRecords[0], { effectiveSales: 0, productCost: 0, promotionFee: .09 })
  const day = settlementDiagnostics(data, options)[0]
  assert.equal(day.missingProducts, true)
  assert(day.metrics.every(metric => metric.products === null && metric.difference === null))
  const html = render(data)
  assert.match(html, /产品利润明细为 0 条/)
  assert.match(html, /推广费 ¥0.09/)
  assert.match(html, /缺少明细不等于金额为零/)
})

test('diagnostics obey original client, paused-store and inclusive-date scope and group products before comparing', () => {
  const data = fixture()
  data.profitRecords = [{ ...data.profitRecords[0], amount: 50, cost: 15, promotion: 5 }, { ...data.profitRecords[0], id: 'two', productId: 'q', amount: 50, cost: 15, promotion: 5 }]
  assert.deepEqual(settlementDiagnostics(data, options), [])
  assert.deepEqual(settlementExportValidation(data, options).warnings, [])
  data.collectionRecords.push({ ...data.collectionRecords[0], id: 'outside', date: '2026-11-04' })
  data.stores.push({ id: 'paused', clientId: 'c', name: '暂停店', storeStatus: '暂停' }, { id: 'other', clientId: 'other-client', name: '另一甲方店' })
  data.collectionRecords.push({ ...data.collectionRecords[0], id: 'paused', storeId: 'paused' }, { ...data.collectionRecords[0], id: 'other', storeId: 'other' })
  assert.deepEqual(settlementDiagnostics(data, { ...options, startDate: date, endDate: date }), [])
  assert.deepEqual(settlementDiagnostics(data, options).map(row => row.date), ['2026-11-04'])
})

test('old refund normalization is read-only and remains consistent with original validation', () => {
  const data = fixture(); data.profitRecords[0].amount = 100
  data.collectionRecords[0].refundBasis = 'refund_completed_at'
  const before = structuredClone(data)
  assert.equal(settlementDiagnostics(data, options)[0].legacyRefund, true)
  data.collectionRecords[0].orderShippedRefund = 0
  assert.deepEqual(settlementDiagnostics(data, options), [])
  assert.deepEqual(settlementExportValidation(data, options).warnings, [])
  assert.equal(before.collectionRecords[0].refundBasis, 'refund_completed_at')
  assert.equal(data.collectionRecords[0].refundBasis, 'refund_completed_at')
})

test('cancelled, unshipped-refunded or already assigned orders do not masquerade as missing product ownership', () => {
  const data = fixture(), order = data.orderAccountingLedgers[0].orders[1]
  order.cancelled = true
  assert.deepEqual(settlementDiagnostics(data, options)[0].unassignedOrders, [])
  order.cancelled = false; data.orderAccountingLedgers[0].refunds = [{ id: 'refund', orderId: order.id, success: true, stage: '未发货', amount: 1 }]
  assert.deepEqual(settlementDiagnostics(data, options)[0].unassignedOrders, [])
  data.orderAccountingLedgers[0].refunds = []; order.productId = 'p'
  assert.deepEqual(settlementDiagnostics(data, options)[0].unassignedOrders, [])
  order.productId = 'deleted-product'
  assert.equal(settlementDiagnostics(data, options)[0].unassignedOrders[0].missingProduct, true)
})

test('warning evidence preserves existing tolerance and never fabricates unknown saved monetary fields', () => {
  for (const amount of [100, 100.01, 100.02, 100.03, 99.98]) {
    const data = fixture(); data.profitRecords[0].amount = amount
    assert.equal(settlementDiagnostics(data, options).some(day => day.mismatch), settlementExportValidation(data, options).warnings.some(message => message.includes('产品利润')))
  }
  const data = fixture(); delete data.profitRecords[0].amount
  const metric = settlementDiagnostics(data, options)[0].metrics[0]
  assert.equal(metric.products, null); assert.equal(metric.difference, null)
  data.linkSalesOrders[0].conflict = true
  assert.equal(settlementDiagnostics(data, options)[0].unassignedOrders[0].goodsId, null)
})

test('dialog names the real date, saved values, difference and order/listing clue without claiming a network failure', () => {
  const data = fixture(), before = structuredClone(data), html = render(data)
  for (const text of ['不是网络同步失败', '2026-11-05', '¥100.00', '¥99.00', '¥-1.00', '补差价', 'supplement', 'goods-123', '基础资料', '商品链接']) assert(html.includes(text), text)
  assert(!html.includes('1 天的产品利润数据尚未同步'))
  assert(html.includes('/profit-preview?store=a&amp;start=2026-11-05&amp;end=2026-11-05&amp;detail=saved'))
  assert.deepEqual(data, before)
  data.profitRecords[0].amount = 100
  const resolved = renderToStaticMarkup(React.createElement(MemoryRouter, {}, React.createElement(SettlementExportWarnings, { data, options, warnings: ['A店：1 天的产品利润数据尚未同步'], onInspect() {} })))
  assert.match(resolved, /当前已保存数据没有上述差异/)
})
