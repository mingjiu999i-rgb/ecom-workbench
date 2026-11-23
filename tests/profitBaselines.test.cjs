const assert = require('node:assert/strict'), { test } = require('node:test'), fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
const { preparePddAccounting } = require('../src/utils/pddLedger.ts')
const { captureProfitBaselines, appendProfitBaselines, initialCollectionProfit, initialProductProfit, initialStoreProductProfit } = require('../src/utils/profitBaselines.ts')
const { createSettlementWorkbook } = require('../src/utils/settlementWorkbook.ts')
const { createStoreBusinessBackup, resetStoreBusiness, restoreStoreBusiness, validateStoreBusinessBackup } = require('../src/utils/storeBusinessReset.ts')
const XLSX = require('xlsx-js-style')
const now = '2026-11-05T03:00:00Z', day = '2026-10-20'
function fixture(extra = {}) {
  const products = [{ id: 'p', name: '产品', operationRate: .02 }]
  const input = { storeId: 's', shop: '店铺', orders: [{ id: 'order', shop: '店铺', payDate: day, payTime: day, receipt: 100, quantity: 1, status: '已发货', productId: 'listing', product: '产品', specification: '一件', skuCode: 'sku' }], refunds: [], funds: [{ key: 'paid', orderId: 'order', shop: '店铺', income: 100, expense: 0, businessCode: '0010002', category: 'positive' }], promotions: [{ key: 'promotion', shop: '店铺', date: day, amount: 20 }], reportTypes: new Set(['orders', 'refunds', 'funds', 'promotions']), savedRecords: [], savedProfits: [], resolveCost: () => ({ cost: 30, productId: 'p' }), linkedProductId: () => 'p', products, ...extra }
  const accounting = preparePddAccounting(input)
  const data = { clients: [{ id: 'c', name: '甲方' }], stores: [{ id: 's', name: '店铺', clientId: 'c', storeStatus: '启用' }], products, productCosts: [], collectionRecords: accounting.summaries.map(({ shop, ...row }) => ({ ...row, id: `collection-${row.date}`, storeId: 's', refundBasis: 'order_paid_at', updatedAt: now })), profitRecords: accounting.productMetrics.map(({ rate, ...row }) => ({ ...row, id: `profit-${row.date}-${row.productId}`, storeId: 's', operationRate: rate, updatedAt: now })), orderAccountingLedgers: [accounting.ledger] }
  return { input, accounting, data, capture: { storeId: 's', orderDates: new Set(input.orders.map(row => row.payDate)), reportTypes: input.reportTypes, accounting, recordedAt: now } }
}
const captured = f => appendProfitBaselines(f.data, captureProfitBaselines(f.data, f.capture))

test('a new initial snapshot excludes shipped refunds already present at first import without requiring four report types', () => {
  const base = fixture(), date = '2026-11-05'
  const f = fixture({
    orders: [{ ...base.input.orders[0], payDate: date, payTime: date }],
    promotions: [{ ...base.input.promotions[0], date }],
    refunds: [{ id: 'small-refund', orderId: 'order', shop: '店铺', status: '退款成功', stage: '已发货', refundAmount: .01 }],
    funds: [...base.input.funds, { key: 'small-refund-fund', orderId: 'order', shop: '店铺', income: 0, expense: -.01, businessCode: '0020002', category: 'refund' }],
    reportTypes: new Set(['orders', 'refunds']),
  })
  f.capture.recordedAt = '2026-11-06T03:00:00Z'
  const before = structuredClone(f.data), data = captured(f)
  assert.equal(data.profitBaselines.length, 1)
  assert.equal(data.profitBaselines[0].date, date)
  assert.equal(data.profitBaselines[0].recordedAt, f.capture.recordedAt)
  assert.equal(data.profitBaselines[0].collectionProfit, 50)
  assert.equal(data.profitBaselines[0].products[0].estimatedProfit, 48)
  assert.equal(data.collectionRecords[0].estimatedProfit, 49.99)
  assert.equal(data.profitRecords[0].estimatedProfit, 47.99)
  assert.deepEqual(f.data, before)
})

test('initial excludes only shipped principal; latest and exported amounts follow later refund backfills exactly once', () => {
  const base = fixture()
  const first = fixture({
    refunds: [{ id: 'refund', orderId: 'order', shop: '店铺', status: '退款成功', stage: '已发货', refundAmount: 999 }],
    funds: [...base.input.funds,
      { key: 'principal', orderId: 'order', shop: '店铺', income: 0, expense: -30, businessCode: '0020002', category: 'refund' },
      { key: 'coupon', orderId: 'order', shop: '店铺', income: 0, expense: -5, businessCode: '0020005', category: 'refund' },
    ],
  })
  const before = structuredClone(first.data), saved = captured(first)
  assert.equal(initialCollectionProfit(saved, saved.collectionRecords), 45)
  assert.equal(initialProductProfit(saved, saved.profitRecords), 43.1)
  assert.equal(saved.collectionRecords[0].estimatedProfit, 15)
  assert.equal(saved.profitRecords[0].estimatedProfit, 13.7)
  assert.deepEqual(first.data, before)
  const later = fixture({ previous: first.accounting.ledger, savedRecords: saved.collectionRecords, savedProfits: saved.profitRecords,
    orders: [], refunds: [], promotions: [], reportTypes: new Set(['funds']),
    funds: [{ key: 'later-principal', orderId: 'order', shop: '店铺', income: 0, expense: -10, businessCode: '0020002', category: 'refund' }],
  })
  const updated = { ...later.data, profitBaselines: saved.profitBaselines }
  assert.equal(initialCollectionProfit(updated, updated.collectionRecords), 45)
  assert.equal(initialProductProfit(updated, updated.profitRecords), 43.1)
  assert.equal(updated.collectionRecords[0].estimatedProfit, 5)
  assert.equal(updated.profitRecords[0].estimatedProfit, 3.9)
  assert.deepEqual(captureProfitBaselines(updated, later.capture), [])
  const book = createSettlementWorkbook(updated, { clientId: 'c' })
  assert.equal(book.Sheets['总览'].M6.v, 43.1)
  assert.equal(book.Sheets['总览'].F6.v, 3.9)
  assert.equal(book.Sheets['店铺回款'].S8.v, 45)
  assert.equal(book.Sheets['店铺回款'].N8.v, 5)
  assert.equal(book.Sheets['初始利润基线'].B5.v, 43.1)
  assert.equal(book.Sheets['产品预览'].B15.v, '最新盈亏')
  assert.equal(book.Sheets['产品预览'].C15.v, book.Sheets['产品预览'].C11.v - book.Sheets['产品预览'].C13.v)
  const reopened = XLSX.read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' })
  assert.equal(reopened.Sheets['店铺回款'].S8.v, 45)
  assert.equal(reopened.Sheets['店铺回款'].N8.v, 5)
})

test('old saved initial values remain byte-for-byte unchanged after a later import and in export', () => {
  const f = fixture(), data = captured(f)
  data.profitBaselines[0].collectionProfit = 49.99
  data.profitBaselines[0].products[0].estimatedProfit = 47.99
  const before = JSON.stringify(data.profitBaselines)
  assert.deepEqual(captureProfitBaselines(data, f.capture), [])
  assert.equal(appendProfitBaselines(data, [{ ...data.profitBaselines[0], collectionProfit: 50 }]), data)
  assert.equal(JSON.stringify(data.profitBaselines), before)
  const book = createSettlementWorkbook(data, { clientId: 'c' })
  assert.equal(book.Sheets['总览'].M6.v, 47.99)
  assert.equal(book.Sheets['店铺回款'].S8.v, 49.99)
})

test('initial product values retain saved promotion allocation, costs, ownership and operation rates', () => {
  const base = fixture()
  const f = fixture({
    products: [...base.input.products, { id: 'q', name: '第二产品', operationRate: .1 }],
    orders: [...base.input.orders, { ...base.input.orders[0], id: 'second' }],
    resolveCost: order => ({ cost: 30, productId: order.id === 'second' ? 'q' : 'p' }),
    refunds: [{ id: 'refund', orderId: 'order', shop: '店铺', status: '退款成功', stage: '已发货', refundAmount: 30 }],
    funds: [...base.input.funds, { key: 'refund', orderId: 'order', shop: '店铺', income: 0, expense: -30, businessCode: '0020002', category: 'refund' }],
  })
  const before = structuredClone(f.data), data = captured(f)
  for (const row of f.data.profitRecords) {
    const initialAmount = row.amount + (row.productId === 'p' ? 30 : 0)
    assert.equal(initialProductProfit(data, [row]), Math.round((initialAmount - row.cost - row.promotion - Math.round(initialAmount * row.operationRate * 100) / 100) * 100) / 100)
  }
  assert.deepEqual(f.data, before)
  assert.equal(initialCollectionProfit(data, data.collectionRecords), 120)
})

test('cancelled and unshipped refunded orders keep their existing exclusion; pending or failed refunds are not restored', () => {
  const base = fixture()
  for (const stage of ['未发货', '已发货']) {
    const f = fixture({ orders: [{ ...base.input.orders[0], status: stage === '已发货' ? '已取消' : '已发货' }],
      refunds: [{ id: 'refund', orderId: 'order', shop: '店铺', status: '退款成功', stage, refundAmount: 30 }],
      funds: [...base.input.funds, { key: 'refund', orderId: 'order', shop: '店铺', income: 0, expense: -30, businessCode: '0020002', category: 'refund' }],
    })
    const data = captured(f)
    assert.equal(initialProductProfit(data, data.profitRecords), -20)
    assert.equal(initialCollectionProfit(data, data.collectionRecords), -20)
  }
  const failed = fixture({ refunds: [{ id: 'refund', orderId: 'order', shop: '店铺', status: '退款关闭', stage: '已发货', refundAmount: 30 }] })
  assert.equal(initialCollectionProfit(captured(failed), failed.data.collectionRecords), 50)
})

test('report types may arrive separately and reuse the saved order, cost and promotion context', () => {
  const first = fixture({ promotions: [], reportTypes: new Set(['orders']) })
  assert.deepEqual(captureProfitBaselines(first.data, first.capture), []) // Unknown promotion is still unknown.
  const next = fixture({ previous: first.accounting.ledger, savedRecords: first.data.collectionRecords,
    savedProfits: first.data.profitRecords, orders: [], funds: [], reportTypes: new Set(['promotions']) })
  assert.equal(next.capture.orderDates.size, 0)
  const result = captured(next)
  assert.equal(result.profitBaselines[0].collectionProfit, 50)
  assert.equal(result.profitBaselines[0].products[0].estimatedProfit, 48)
  assert.equal(result.collectionRecords, next.data.collectionRecords)
  assert.equal(result.orderAccountingLedgers, next.data.orderAccountingLedgers)
})

test('pending refund funds do not prevent freezing the current estimate or updating latest profit afterwards', () => {
  const base = fixture()
  const f = fixture({ refunds: [{ id: 'pending-refund', orderId: 'order', shop: '店铺', status: '退款成功', stage: '已发货', refundAmount: 1 }], reportTypes: new Set(['orders', 'refunds']) })
  assert.equal(f.accounting.pendingRefundFunds, 1)
  const data = captured(f)
  assert.equal(data.profitBaselines[0].collectionProfit, 50)
  const later = fixture({ previous: f.accounting.ledger, savedRecords: data.collectionRecords, savedProfits: data.profitRecords,
    orders: [], promotions: [], reportTypes: new Set(['funds']),
    funds: [{ ...base.input.funds[0], key: 'later-refund-fund', income: 0, expense: -1, businessCode: '0020002', category: 'refund' }] })
  const updated = { ...later.data, profitBaselines: data.profitBaselines }
  assert.equal(updated.collectionRecords[0].estimatedProfit, 49)
  assert.equal(initialCollectionProfit(updated, updated.collectionRecords), 50)
  assert.deepEqual(captureProfitBaselines(updated, later.capture), [])
})

test('an existing saved promotion amount is reusable without a new promotion file; unknown zero is never invented', () => {
  const base = fixture()
  const f = fixture({ previous: { ...base.accounting.ledger, promotions: [] }, savedRecords: base.data.collectionRecords,
    savedProfits: base.data.profitRecords, promotions: [], reportTypes: new Set(['orders']) })
  assert.equal(f.accounting.ledger.promotions.length, 0)
  assert.equal(f.data.collectionRecords[0].promotionFee, 20)
  assert.equal(captured(f).profitBaselines[0].collectionProfit, 50)
  const unknown = fixture({ promotions: [], reportTypes: new Set(['orders']) })
  assert.deepEqual(captureProfitBaselines(unknown.data, unknown.capture), [])
  f.data.collectionRecords[0].promotionFeeKnown = false
  assert.deepEqual(captureProfitBaselines(f.data, f.capture), [])
  const zero = fixture({ promotions: [{ ...base.input.promotions[0], amount: 0 }], reportTypes: new Set(['orders']) })
  assert.equal(captured(zero).profitBaselines[0].collectionProfit, 70)
})

test('one date with missing cost or blocked legacy accounting cannot block another valid date', () => {
  const base = fixture(), extra = { ...base.input.orders[0], id: 'second', payDate: '2026-10-21', payTime: '2026-10-21' }
  const f = fixture({ orders: [...base.input.orders, extra], promotions: [...base.input.promotions, { ...base.input.promotions[0], date: extra.payDate }],
    resolveCost: order => order.id === 'order' ? undefined : base.input.resolveCost(order), reportTypes: new Set(['orders']) })
  const rows = captureProfitBaselines(f.data, f.capture)
  assert.deepEqual(rows.map(row => row.date), ['2026-10-21'])
  assert.equal(rows[0].collectionProfit, 50)
  assert.deepEqual(captureProfitBaselines(f.data, { ...f.capture, accounting: { ...f.accounting, readyDates: new Set() } }), [])
})

test('first saved complete import freezes initial values while refund-only updates keep original calculations', () => {
  const first = fixture(), data = captured(first), before = structuredClone(data)
  assert.equal(initialCollectionProfit(data, data.collectionRecords), 50)
  assert.equal(initialProductProfit(data, data.profitRecords), 48)
  const later = fixture({ previous: data.orderAccountingLedgers[0], orders: [], promotions: [], savedRecords: data.collectionRecords, savedProfits: data.profitRecords, reportTypes: new Set(['refunds', 'funds']), refunds: [{ id: 'refund', orderId: 'order', shop: '店铺', status: '退款成功', stage: '已发货', refundAmount: 30 }], funds: [{ key: 'refund-fund', orderId: 'order', shop: '店铺', income: 0, expense: -30, businessCode: '0020002', category: 'refund' }] })
  const refreshed = { ...later.data, profitBaselines: data.profitBaselines }
  assert.equal(refreshed.collectionRecords[0].estimatedProfit, 20)
  assert.equal(refreshed.profitRecords[0].estimatedProfit, 18.6)
  assert.equal(initialCollectionProfit(refreshed, refreshed.collectionRecords), 50)
  assert.equal(initialProductProfit(refreshed, refreshed.profitRecords), 48)
  assert.deepEqual(captureProfitBaselines(refreshed, later.capture), [])
  assert.deepEqual(data, before)
  assert.equal(appendProfitBaselines(refreshed, [{ ...data.profitBaselines[0], collectionProfit: -999 }]), refreshed)
})

test('historical reads, unsaved calculations, unknown promotion and missing costs never invent an initial value', () => {
  const f = fixture(), original = structuredClone(f.data)
  assert.equal(initialCollectionProfit(f.data, f.data.collectionRecords), null)
  assert.deepEqual(captureProfitBaselines(f.data, { ...f.capture, reportTypes: new Set() }), [])
  assert.deepEqual(captureProfitBaselines({ ...f.data, profitRecords: [] }, f.capture), [])
  assert.deepEqual(captureProfitBaselines({ ...f.data, collectionRecords: [] }, f.capture), [])
  assert.deepEqual(captureProfitBaselines(f.data, { ...f.capture, accounting: { ...f.accounting, readyDates: new Set() } }), [])
  const unknown = fixture({ promotions: [] }), missing = fixture({ resolveCost: () => undefined })
  assert.deepEqual(captureProfitBaselines(unknown.data, unknown.capture), [])
  assert.deepEqual(captureProfitBaselines(missing.data, missing.capture), [])
  assert.equal(captureProfitBaselines(f.data, { ...f.capture, accounting: { ...f.accounting, pendingRefundFunds: 1 } }).length, 1)
  assert.deepEqual(f.data, original)
})

test('zero and losses are valid initial values; mixed histories, dates, stores and product gaps stay unknown', () => {
  const f = fixture(), data = captured(f), row = data.collectionRecords[0], product = data.profitRecords[0]
  const gap = { ...row, storeId: 'other' }
  assert.equal(initialCollectionProfit(data, [row, gap]), null)
  assert.equal(initialStoreProductProfit(data, [row, gap]), null)
  assert.equal(initialProductProfit(data, [product, { ...product, productId: 'missing' }]), null)
  for (const value of [0, -5.25]) {
    const changed = { ...data, profitBaselines: [{ ...data.profitBaselines[0], collectionProfit: value, products: [{ productId: 'p', estimatedProfit: value }] }] }
    assert.equal(initialCollectionProfit(changed, [row]), value)
    assert.equal(initialProductProfit(changed, [product]), value)
  }
})

test('export adds fixed initial values to summary, products and details; latest values retain the original amounts', () => {
  const f = fixture(), data = captured(f), before = JSON.stringify(data)
  const book = createSettlementWorkbook(data, { clientId: 'c' })
  assert.equal(book.Sheets['总览'].F5.v, '最新盈亏')
  assert.equal(book.Sheets['总览'].F6.v, 48)
  assert.equal(book.Sheets['总览'].M5.v, '初始预估盈亏')
  assert.equal(book.Sheets['总览'].M6.v, 48)
  assert.equal(book.Sheets['店铺回款'].N6.v, '最新盈亏')
  assert.equal(book.Sheets['店铺回款'].N8.v, 50)
  assert.equal(book.Sheets['店铺回款'].S8.v, 50)
  assert.equal(book.Sheets['产品预览'].B15.v, '最新盈亏')
  assert.equal(book.Sheets['产品预览'].C15.v, 48)
  assert.equal(book.Sheets['初始利润基线'].A5.v, '产品')
  assert.equal(book.Sheets['初始利润基线'].B5.v, 48)
  assert.equal(book.Sheets['初始利润基线'].C5.v, 48)
  const reopened = XLSX.read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' })
  assert.equal(reopened.Sheets['店铺回款'].S8.t, 'n')
  assert.equal(reopened.Sheets['店铺回款'].S8.v, 50)
  const history = createSettlementWorkbook(f.data, { clientId: 'c' })
  assert.equal(history.Sheets['总览'].M6.v, '未记录')
  assert.equal(history.Sheets['店铺回款'].S8.v, '未记录')
  assert.equal(history.Sheets['初始利润基线'], undefined)
  assert.equal(JSON.stringify(data), before)
})

test('export respects client/date scope and aggregates initial values across stores and products', () => {
  const f = fixture(), data = captured(f), other = structuredClone(data)
  other.collectionRecords[0].id = 'other-day'; other.collectionRecords[0].storeId = 'other'
  other.profitRecords[0].id = 'other-profit'; other.profitRecords[0].storeId = 'other'
  other.profitBaselines[0].id = 'other-baseline'; other.profitBaselines[0].storeId = 'other'
  const multi = { ...data, stores: [...data.stores, { id: 'other', name: '二店', clientId: 'c' }], collectionRecords: [...data.collectionRecords, ...other.collectionRecords], profitRecords: [...data.profitRecords, ...other.profitRecords], profitBaselines: [...data.profitBaselines, ...other.profitBaselines] }
  const book = createSettlementWorkbook(multi, { clientId: 'c' })
  assert.equal(book.Sheets['总览'].M8.v, 96)
  assert.equal(book.Sheets['初始利润基线'].B5.v, 96)
  assert.equal(book.Sheets['二店回款'].S8.v, 50)
  const excluded = createSettlementWorkbook(multi, { clientId: 'c', startDate: '2026-11-01' })
  assert.equal(excluded.Sheets['总览'].M6.v, '未记录')
  assert.equal(excluded.Sheets['店铺回款'].S7.v, '未记录')
})

test('single-store reset and undo include snapshots and reject mixed-store or invalid backup amounts', () => {
  const f = fixture(), data = captured(f), account = 'test@example.invalid'
  const backup = createStoreBusinessBackup(data, 's', account, now)
  assert.deepEqual(backup.scope.profitBaselines, data.profitBaselines)
  const cleared = resetStoreBusiness(data, backup, account, '店铺')
  assert.deepEqual(cleared.profitBaselines, [])
  const restored = restoreStoreBusiness(cleared, backup, account, '店铺', now)
  assert.deepEqual(restored.profitBaselines, data.profitBaselines)
  const corrupt = structuredClone(backup); corrupt.scope.profitBaselines[0].storeId = 'other'
  assert.throws(() => validateStoreBusinessBackup(corrupt))
  const invalid = structuredClone(backup); invalid.scope.profitBaselines[0].collectionProfit = null
  assert.throws(() => validateStoreBusinessBackup(invalid))
})

test('existing row storage writes and reloads baseline extension without changing ledger or legacy data', async () => {
  const h = require('./rowHarness.cjs'), db = await h.database()
  try {
    const f = fixture(), data = captured(f)
    await h.seed(db, f.data)
    const client = h.createRowWorkbenchStore(h.transport(db)), loaded = await client.load()
    await client.save({ ...loaded, profitBaselines: data.profitBaselines })
    const reloaded = await h.createRowWorkbenchStore(h.transport(db)).load()
    assert.deepEqual(h.json(reloaded.profitBaselines), data.profitBaselines)
    assert.deepEqual(h.json(reloaded.orderAccountingLedgers), f.data.orderAccountingLedgers)
    assert.deepEqual((await db.query('select data from public.workbench_documents where user_id=$1', [h.OWNER])).rows[0].data, f.data)
    assert.equal(initialCollectionProfit(reloaded, reloaded.collectionRecords), 50)
  } finally { await db.close() }
})
