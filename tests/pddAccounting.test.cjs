const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')

// Compile the production TypeScript in this isolated Node test process.
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  module._compile(output.outputText, filename)
}
const { preparePddAccounting, reportFingerprint } = require('../src/utils/pddLedger.ts')
const { normalizeCollectionRefunds } = require('../src/utils/collectionRefunds.ts')
const { createSettlementWorkbook } = require('../src/utils/settlementWorkbook.ts')

const products = [{ id: 'product', name: '产品', operationRate: 0.02 }]
const order = (id = '251001-1', date = '2026-10-01') => ({ id, shop: '店铺', payTime: date, payDate: date, receipt: 100, status: '已发货', productId: 'link', product: '产品', specification: '一件', skuCode: 'sku', quantity: 1 })
const refund = (id = 'refund-1', orderId = '251001-1', amount = 30, status = '退款成功') => ({ id, orderId, shop: '店铺', status, stage: '已发货', refundAmount: amount, appliedAt: '2026-10-10', approvedAt: '2026-10-10', refundDate: '2026-10-10' })
const fund = (key, expense = 0, income = 0, businessCode = '0030002', category = 'other', orderId = '251001-1') => ({ key, orderId, shop: '店铺', occurredAt: '2026-10-10', income, expense, accountType: '', businessCode, businessName: '', businessDescription: '', category })
const promotion = { key: 'promo', shop: '店铺', date: '2026-10-01', amount: 20 }
const resolveCost = () => ({ cost: 30, productId: 'product', product: '产品', specification: '', skuCode: 'sku', source: 'SKU 编码' })
const input = (overrides = {}) => ({ storeId: 'store', shop: '店铺', orders: [], refunds: [], funds: [], promotions: [], reportTypes: new Set(), savedRecords: [], savedProfits: [], products, resolveCost, linkedProductId: () => 'product', ...overrides })
const records = result => result.summaries.map(({ shop, ...row }) => ({ ...row, id: row.date, storeId: 'store', refundBasis: 'order_paid_at', updatedAt: '' }))
const profitRecords = result => result.productMetrics.map(({ rate, ...row }) => ({ ...row, id: `${row.date}-${row.productId}`, storeId: 'store', operationRate: rate, updatedAt: '' }))
const initial = () => preparePddAccounting(input({ orders: [order()], promotions: [promotion], funds: [fund('credit', 0, 100, '0010002', 'positive')] }))
const next = (previous, overrides = {}) => preparePddAccounting(input({ previous: JSON.parse(JSON.stringify(previous.ledger)), savedRecords: records(previous), savedProfits: profitRecords(previous), ...overrides }))

test('refund-only refresh after reload backfills October 1 without resending fixed reports', () => {
  const first = initial()
  const funded = next(first, { funds: [fund('refund', -30, 0, '0020002', 'refund')] })
  const result = next(funded, { refunds: [refund()] })
  assert.equal(result.summaries.length, 1)
  const row = result.summaries[0]
  assert.equal(row.date, '2026-10-01')
  assert.equal(row.orderCount, 1)
  assert.equal(row.originalSales, 100)
  assert.equal(row.shippedRefund, 30)
  assert.equal(row.effectiveSales, 70)
  assert.equal(row.promotionFee, 20)
  assert.equal(row.productCost, 30)
  assert.equal(row.currentNet, 70)
  assert.equal(result.productMetrics[0].promotion, 20)
  assert.equal(result.productMetrics[0].amount, 70)
})

test('new-day orders and late fees, coupon refunds, reimbursements use original order ID', () => {
  const first = initial()
  const result = next(first, { orders: [order('251010-2', '2026-10-10')], refunds: [refund()], funds: [
    fund('fee', -5), fund('refund', -30, 0, '0020002', 'refund'),
    fund('coupon', -2, 0, '0020005', 'refund'), fund('appeal', 0, 4, '0130005'),
  ] })
  const row = result.summaries.find(row => row.date === '2026-10-01')
  assert.equal(row.shippedRefund, 30)
  assert.equal(row.couponRefund, 2)
  assert.equal(row.basicServiceFee, 5)
  assert.equal(row.appealReimbursement, 4)
  assert.equal(row.currentNet, 67)
  assert.equal(row.profit, 17)
  assert.equal(row.effectiveSales, 68)
  assert.equal(row.promotionFee, 20)
  const today = result.summaries.find(row => row.date === '2026-10-10')
  assert.equal(today.shippedRefund, 0)
  assert.equal(today.basicServiceFee, 0)
  assert.equal(today.currentNet, 0)
})

test('overlapping refund and fund uploads are idempotent, while distinct partial refunds add up', () => {
  const events = { refunds: [refund(), refund('refund-2', '251001-1', 10)], funds: [fund('fee-1', -5), fund('fee-2', -5), fund('refund-1', -30, 0, '0020002', 'refund'), fund('refund-2', -10, 0, '0020002', 'refund')] }
  const first = next(initial(), events)
  const repeated = next(first, events)
  assert.deepEqual(repeated.ledger, first.ledger)
  assert.deepEqual(repeated.summaries, first.summaries)
  assert.equal(repeated.summaries[0].shippedRefund, 40)
  assert.equal(repeated.summaries[0].basicServiceFee, 10)
})

test('funds-only import preserves previous refund, promotion and frozen cost', () => {
  const refunded = next(initial(), { refunds: [refund()], funds: [fund('refund', -30, 0, '0020002', 'refund')] })
  const result = next(refunded, { funds: [fund('fee', -5)], resolveCost: () => ({ ...resolveCost(), cost: 80 }) })
  assert.equal(result.summaries[0].shippedRefund, 30)
  assert.equal(result.summaries[0].currentNet, 65)
  assert.equal(result.summaries[0].promotionFee, 20)
  assert.equal(result.summaries[0].productCost, 30)
})

test('pending after-sale status becomes success using the same after-sale ID', () => {
  const pending = next(initial(), { refunds: [refund('refund-1', '251001-1', 30, '处理中')] })
  assert.equal(pending.summaries[0].shippedRefund, 0)
  const completed = next(pending, { refunds: [refund()], funds: [fund('refund', -30, 0, '0020002', 'refund')] })
  assert.equal(completed.ledger.refunds.length, 1)
  assert.equal(completed.summaries[0].shippedRefund, 30)
})

test('unmatched adjustments and promotion-first imports wait for the matching order', () => {
  const waiting = preparePddAccounting(input({ refunds: [refund()], funds: [fund('fee', -5), fund('refund', -30, 0, '0020002', 'refund')], promotions: [promotion] }))
  assert.equal(waiting.summaries.length, 0)
  assert.equal(waiting.unmatchedRefunds, 1)
  assert.equal(waiting.unmatchedFunds, 2)
  const result = next(waiting, { orders: [order()] })
  assert.equal(result.unmatchedRefunds, 0)
  assert.equal(result.summaries[0].date, '2026-10-01')
  assert.equal(result.summaries[0].shippedRefund, 30)
  assert.equal(result.summaries[0].basicServiceFee, 5)
  assert.equal(result.summaries[0].promotionFee, 20)
})

test('legacy summaries stay intact until a complete one-time initialization', () => {
  const savedRecords = records(initial())
  savedRecords[0].orderCount = 2
  const partial = preparePddAccounting(input({ savedRecords, orders: [order()], refunds: [refund()], funds: [fund('fee', -5), fund('credit', 0, 100, '0010002', 'positive')], reportTypes: new Set(['orders', 'refunds', 'funds']) }))
  assert.deepEqual(partial.blockedDates, ['2026-10-01'])
  assert.equal(partial.summaries.length, 0)
  const complete = preparePddAccounting(input({ previous: partial.ledger, savedRecords, orders: [order('251001-2')], reportTypes: new Set(['orders', 'refunds', 'funds']) }))
  assert.equal(complete.blockedDates.length, 0)
  assert.equal(complete.summaries[0].orderCount, 2)
})

test('cross-month refund stays with September order', () => {
  const first = preparePddAccounting(input({ orders: [order('250930-1', '2026-09-30')] }))
  const result = next(first, { refunds: [refund('refund-sep', '250930-1', 20)], funds: [fund('refund-sep', -20, 0, '0020002', 'refund', '250930-1')] })
  assert.equal(result.summaries[0].date, '2026-09-30')
  assert.equal(result.summaries[0].shippedRefund, 20)
  assert.equal(result.productMetrics[0].date, '2026-09-30')
})

test('historical refund-date display is repaired from saved order-date amount', () => {
  const row = { ...records(initial())[0], refundBasis: 'refund_completed_at', shippedRefund: 0, orderShippedRefund: 30, effectiveSales: 70 }
  const [repaired] = normalizeCollectionRefunds([row])
  assert.equal(repaired.shippedRefund, 30)
  assert.equal(repaired.refundBasis, 'order_paid_at')
  assert.equal(repaired.promotionFee, 20)
  const unrepairable = { ...row, orderShippedRefund: undefined }
  assert.equal(normalizeCollectionRefunds([unrepairable])[0].refundBasis, 'refund_completed_at')
})

test('settlement workbook uses the same order-date refund in filtered summary and daily sheet', () => {
  const result = next(initial(), { refunds: [refund()], funds: [fund('refund', -30, 0, '0020002', 'refund')] })
  const data = { clients: [{ id: 'client', name: '甲方' }], stores: [{ id: 'store', clientId: 'client', name: '店铺', storeStatus: '启用' }], products, collectionRecords: records(result), profitRecords: profitRecords(result) }
  const workbook = createSettlementWorkbook(data, { clientId: 'client', startDate: '2026-10-01', endDate: '2026-10-01' })
  assert.equal(workbook.Sheets['店铺回款'].E8.v, 30)
  assert.equal(workbook.Sheets['店铺回款'].M8.v, 20)
  assert.equal(workbook.Sheets['总览'].G7.v, 30)
})

test('all clients export separate overview, product preview and store details with cross-store monthly totals', () => {
  const first = initial()
  const baseProfit = profitRecords(first)[0]
  const data = {
    clients: [{ id: 'client', name: '甲方一' }, { id: 'other', name: '甲方二' }],
    stores: [
      { id: 'store', clientId: 'client', name: '店铺', storeStatus: '启用' },
      { id: 'second', clientId: 'client', name: '第二店铺', storeStatus: '启用' },
      { id: 'other', clientId: 'other', name: '另一甲方店', storeStatus: '启用' },
    ], products,
    collectionRecords: [...records(first), { ...records(first)[0], id: 'second', storeId: 'second' }, { ...records(first)[0], id: 'other', storeId: 'other' }],
    profitRecords: [baseProfit, { ...baseProfit, id: 'second', storeId: 'second' }, { ...baseProfit, id: 'other', storeId: 'other' }],
  }
  const workbook = createSettlementWorkbook(data, { clientId: 'client' })
  assert.deepEqual(workbook.SheetNames, ['总览', '产品预览', '店铺回款', '第二店铺回款'])
  const preview = workbook.Sheets['产品预览']
  assert.equal(preview.A1.v, '产品利润汇总')
  assert.equal(preview.C4.v, '10月1日')
  assert.equal(preview.D4.v, '10月份数据')
  assert.equal(preview.C5.v, 200)
  assert.equal(preview.D5.v, 200)
  assert.equal(preview.D10.v, baseProfit.estimatedProfit * 2)
  assert.equal(preview.D12.v, baseProfit.estimatedProfit / baseProfit.amount)
  assert.equal(workbook.Sheets['总览']['!ref'], 'A1:L10')
  assert(!Object.values(workbook.Sheets['总览']).some(cell => cell?.v === '产品利润汇总'))
  const other = createSettlementWorkbook(data, { clientId: 'other' })
  assert.deepEqual(other.SheetNames, ['总览', '产品预览', '另一甲方店回款'])
  assert.equal(other.Sheets['产品预览'].C5.v, 100)
  const empty = createSettlementWorkbook({ ...data, profitRecords: [] }, { clientId: 'client' })
  assert.equal(empty.Sheets['产品预览'].A4.v, '暂无已同步的产品利润数据')
})

test('fingerprints are stable and do not retain raw remarks', () => {
  assert.equal(reportFingerprint('订单|备注'), reportFingerprint('订单|备注'))
  assert.notEqual(reportFingerprint('订单|备注'), reportFingerprint('订单|另一备注'))
  assert.match(reportFingerprint('订单|备注'), /^[0-9a-f]+$/)
})


test('SKU edits affect newly imported orders but neither reimports nor refunds reprice old orders', () => {
  const first = initial()
  const result = next(first, {
    orders: [order(), order('251013-2', '2026-10-13')],
    resolveCost: () => ({ ...resolveCost(), cost: 80 }),
  })
  assert.equal(result.ledger.orders.find(row => row.id === '251001-1').unitCost, 30)
  assert.equal(result.ledger.orders.find(row => row.id === '251013-2').unitCost, 80)
  assert.equal(result.summaries.find(row => row.date === '2026-10-01').productCost, 30)
  assert.equal(result.summaries.find(row => row.date === '2026-10-13').productCost, 80)
  const adjusted = next(result, { refunds: [refund()], funds: [fund('refund', -30, 0, '0020002', 'refund')] })
  assert.equal(adjusted.summaries[0].productCost, 30)
})

test('free SKU snapshot remains zero after a price change', () => {
  const first = preparePddAccounting(input({ orders: [order()], resolveCost: () => ({ ...resolveCost(), cost: 0 }) }))
  const result = next(first, { orders: [order()] })
  assert.equal(result.summaries[0].productCost, 0)
})

test('refund amount is taken from actual principal and coupon funds, without double counting after-sale amount', () => {
  const result = next(initial(), {
    refunds: [refund('refund-1', '251001-1', 99)],
    funds: [fund('refund', -30, 0, '0020002', 'refund'), fund('coupon', -2, 0, '0020005', 'refund')],
  })
  assert.equal(result.summaries[0].shippedRefund, 30)
  assert.equal(result.summaries[0].couponRefund, 2)
  assert.equal(result.summaries[0].effectiveSales, 68)
  assert.equal(result.productMetrics[0].amount, 68)
  const unfunded = next(initial(), { refunds: [refund()] })
  assert.equal(unfunded.pendingRefundFunds, 1)
  assert.equal(unfunded.summaries[0].shippedRefund, 0)
})

test('a refund does not redistribute previously assigned promotion between products', () => {
  const twoProducts = [...products, { id: 'second', name: '产品二', operationRate: 0.02 }]
  const first = preparePddAccounting(input({
    products: twoProducts, orders: [order(), order('251001-2')], promotions: [promotion],
    resolveCost: order => ({ ...resolveCost(), productId: order.id === '251001-2' ? 'second' : 'product' }),
  }))
  const result = next(first, { products: twoProducts, refunds: [refund()], funds: [fund('refund', -30, 0, '0020002', 'refund')] })
  assert.deepEqual(result.productMetrics.map(row => row.promotion), [10, 10])
  assert.equal(result.summaries[0].promotionFee, 20)
})

test('legacy initialization cannot erase settled receipts when the wrong fund date range is uploaded', () => {
  const partial = preparePddAccounting(input({ savedRecords: records(initial()), orders: [order()], refunds: [refund()], funds: [fund('fee', -5)], reportTypes: new Set(['orders', 'refunds', 'funds']) }))
  assert.deepEqual(partial.blockedDates, ['2026-10-01'])
  assert.equal(partial.summaries.length, 0)
})

test('unshipped full refunds remove sales and cost while retaining the original promotion in product profit', () => {
  const result = next(initial(), { refunds: [{ ...refund(), stage: '未发货' }] })
  assert.equal(result.summaries[0].effectiveSales, 0)
  assert.equal(result.summaries[0].productCost, 0)
  assert.equal(result.summaries[0].promotionFee, 20)
  assert.equal(result.productMetrics[0].amount, 0)
  assert.equal(result.productMetrics[0].cost, 0)
  assert.equal(result.productMetrics[0].quantity, 0)
  assert.equal(result.productMetrics[0].promotion, 20)
  assert.equal(result.productMetrics[0].estimatedProfit, -20)
})
