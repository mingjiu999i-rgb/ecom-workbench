const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
const { parseLinkSalesRows, mergeLinkSalesOrders } = require('../src/utils/linkSales.ts')
const { summarizeSpecSales } = require('../src/utils/specSales.ts')
const { createSettlementWorkbook } = require('../src/utils/settlementWorkbook.ts')
const { appendSpecSales } = require('../src/utils/specSalesWorkbook.ts')
const XLSX = require('xlsx-js-style')
const base = () => ({ clients: [{ id: 'c', name: '甲方' }], stores: [{ id: 'a', name: 'A店', clientId: 'c' }, { id: 'b', name: 'B店', clientId: 'c' }, { id: 'x', name: '其他店', clientId: 'other' }, { id: 'paused', name: '暂停店', clientId: 'c', storeStatus: '暂停' }], products: [], collectionRecords: [], profitRecords: [], orderAccountingLedgers: [] })
const row = (extra = {}) => ({ '订单号': '261019-1234567890123', '商品id': 'goods', '商品': '水果', '订单成交时间': '2026-10-19 12:00:00', '订单状态': '已发货', '商品数量(件)': '2', '商家实收金额(元)': '10', '商家编码-规格维度': '000123', '商品规格': '大果 5斤', ...extra })
const imported = (rows = [row()], store = 'a', data = base()) => mergeLinkSalesOrders(data, parseLinkSalesRows(store, rows))
const report = data => summarizeSpecSales(data, { clientId: 'c' })
const ledger = (extra = {}) => ({ storeId: 'a', orders: [], refunds: [], funds: [], promotions: [], ...extra })

test('captures original specification code and selling specification without cost matching', () => {
  const data = imported()
  assert.equal(data.linkSalesOrders[0].skuCode, '000123')
  assert.equal(data.linkSalesOrders[0].specification, '大果 5斤')
  assert.equal(report(data).rows[0].quantity, 2)
})
test('sums units rather than order counts and reimport is idempotent', () => {
  const rows = [row(), row({ '订单号': 'second', '商品数量(件)': '3' })]
  const data = imported(rows)
  assert.equal(report(data).rows[0].quantity, 5)
  const again = imported(rows, 'a', data)
  assert.equal(again, data)
  assert.deepEqual(report(again), report(data))
  assert.equal(report(imported([row({ '订单号': 'third' })], 'a', again)).rows[0].quantity, 7)
})
test('same full order ID and SKU in different stores remain separate; no listing ID required', () => {
  const data = imported([row({ '商品id': '' })], 'b', imported())
  assert.deepEqual(report(data).rows.map(r => [r.storeId, r.quantity]), [['a', 2], ['b', 2]])
})
test('different codes never collapse and a shared code with differing labels is explicitly split', () => {
  const data = imported([row(), row({ '订单号': 'other', '商品规格': '小果 5斤' }), row({ '订单号': 'third', '商家编码-规格维度': '000124' })])
  const result = report(data)
  assert.equal(result.rows.length, 3)
  assert.equal(result.rows.filter(r => r.conflictingSpecification).length, 2)
  assert(result.warnings.some(text => text.includes('同一编码')))
})
test('excludes cancellation, unpaid, unshipped successful refunds and supplement only', () => {
  const statuses = ['已取消', '待付款', '未付款', '待支付', '未发货，退款成功', '已发货，退款成功', '未发货，退款中']
  const data = imported([...statuses.map((status, i) => row({ '订单号': String(i), '订单状态': status })), row({ '订单号': 'supplement', '商品': '补收差价' })])
  assert.equal(report(data).rows[0].quantity, 4)
  assert.equal(report(data).complete, true)
})
test('after-sale-only refresh removes unshipped refunded units without using refund amount', () => {
  const data = imported([row(), row({ '订单号': 'second', '商品数量(件)': '3' })])
  data.orderAccountingLedgers = [ledger({ refunds: [{ orderId: row()['订单号'], success: true, stage: '未发货', amount: 0.01 }, { orderId: 'second', success: true, stage: '已发货', amount: 99999 }] })]
  const before = JSON.stringify(data)
  assert.equal(report(data).rows[0].quantity, 3)
  assert.equal(JSON.stringify(data), before)
  data.orderAccountingLedgers[0].refunds[0].success = false
  assert.equal(report(data).rows[0].quantity, 5)
})
test('unshipped-refund matching is store scoped and uses full order ID', () => {
  const data = imported([row()], 'b', imported())
  data.orderAccountingLedgers = [ledger({ refunds: [{ orderId: row()['订单号'], success: true, stage: '未发货' }] })]
  assert.deepEqual(report(data).rows.map(r => r.storeId), ['b'])
})
test('filters by export client and inclusive payment dates, excludes paused stores', () => {
  let data = imported([row(), row({ '订单号': 'old', '订单成交时间': '2026-10-18' }), row({ '订单号': 'next', '订单成交时间': '2026-10-20' })])
  for (const store of ['x', 'paused']) data = imported([row()], store, data)
  assert.equal(summarizeSpecSales(data, { clientId: 'c', startDate: '2026-10-19', endDate: '2026-10-19' }).rows[0].quantity, 2)
  assert.equal(report(data).rows.length, 1)
  assert.equal(report(data).rows[0].quantity, 6)
})
test('missing/fractional quantities propagate unknown instead of reporting a partial total; zero stays zero', () => {
  for (const quantity of ['', '1.5', '-1', 'not a number', '9007199254740992']) {
    const result = report(imported([row(), row({ '订单号': 'unknown', '商品数量(件)': quantity })]))
    assert.equal(result.rows[0].quantity, null)
    assert.equal(result.complete, false)
  }
  assert.equal(report(imported([row({ '商品数量(件)': '0' })])).rows[0].quantity, 0)
})
test('missing payment date does not get inferred and invalidates the affected total', () => {
  const data = imported([row(), row({ '订单号': 'missing', '订单成交时间': '' })])
  const result = summarizeSpecSales(data, { clientId: 'c', startDate: '2026-10-19', endDate: '2026-10-19' })
  assert.equal(result.rows[0].quantity, null)
  assert(result.warnings.some(text => text.includes('支付日期')))
})
test('legacy and missing metadata are explicit; do not guess from current product cost library', () => {
  const raw = row(); delete raw['商家编码-规格维度']; delete raw['商品规格']
  const data = imported([raw]); data.productCosts = [{ skuCode: 'guessed', specification: 'guessed' }]
  assert.equal(data.linkSalesOrders[0].skuCode, undefined)
  assert.equal(report(data).rows.length, 0)
  assert.equal(report(data).complete, false)
  assert(report(data).warnings.some(text => text.includes('补导原订单报表')))
})
test('headers absent preserve known metadata while explicitly blank columns stay blank', () => {
  const raw = row(); delete raw['商家编码-规格维度']; delete raw['商品规格']
  const data = imported([raw], 'a', imported())
  assert.equal(report(data).rows[0].skuCode, '000123')
  assert.equal(report(imported([row({ '商家编码-规格维度': '' })], 'a', data)).complete, false)
})
test('historical unindexed orders and aggregate-only dates warn without fabricating quantities', () => {
  const data = base()
  data.orderAccountingLedgers = [ledger({ orders: [{ id: 'old', date: '2026-10-19', quantity: 888, cancelled: false }] })]
  data.collectionRecords = [{ storeId: 'a', date: '2026-10-18', orderCount: 100 }]
  const result = report(data)
  assert.equal(result.rows.length, 0)
  assert.equal(result.complete, false)
  assert.equal(result.warnings.length, 2)
  assert.equal(summarizeSpecSales(data, { clientId: 'c', startDate: '2026-10-20' }).warnings.length, 0)
})
test('new analysis never writes financial data; original overview cells and all layout settings stay intact', () => {
  const data = imported(); const before = JSON.stringify(data)
  const sheet = XLSX.utils.aoa_to_sheet([['existing financial cell', 12.34]])
  sheet['!merges'] = []; sheet['!rows'] = [{ hpt: 25 }]; sheet['!cols'] = [{ wch: 22 }]; sheet['!freeze'] = { ySplit: 5 }
  const original = JSON.parse(JSON.stringify(sheet))
  appendSpecSales(sheet, data, { clientId: 'c' })
  for (const key of ['A1', 'B1', '!cols', '!freeze']) assert.deepEqual(sheet[key], original[key])
  assert.deepEqual(sheet['!rows'][0], original['!rows'][0])
  assert.equal(JSON.stringify(data), before)
  assert(Object.values(sheet).some(cell => cell?.v === '000123' && cell.t === 's'))
  assert(Object.values(sheet).some(cell => cell?.v === 2 && cell.t === 'n'))
})
test('export first sheet contains the spec table, with no extra sheets or financial changes', () => {
  const data = imported(); const before = JSON.stringify(data)
  const workbook = createSettlementWorkbook(data, { clientId: 'c' })
  assert.deepEqual(workbook.SheetNames, ['总览', '产品预览', 'A店回款', 'B店回款'])
  const values = Object.values(workbook.Sheets['总览']).map(cell => cell?.v)
  for (const label of ['各店铺规格销量', '规格维度编码', '售卖规格', '总数量（件）', '000123', '大果 5斤']) assert(values.includes(label), label)
  assert.equal(JSON.stringify(data), before)
  const reopened = XLSX.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' })
  assert(Object.values(reopened.Sheets['总览']).some(cell => cell?.v === '000123' && cell.t === 's'))
})
