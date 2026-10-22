const assert = require('node:assert/strict')
const { test, mock } = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
const { parseLinkSalesRows, mergeLinkSalesOrders } = require('../src/utils/linkSales.ts')
const { summarizeSpecSales } = require('../src/utils/specSales.ts')
const { createSettlementWorkbook } = require('../src/utils/settlementWorkbook.ts')
const { appendSpecSales, specSalesYesterdayFilter } = require('../src/utils/specSalesWorkbook.ts')
const XLSX = require('xlsx-js-style')
// Existing export fixtures are paid on October 19; exports run the next day.
mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-20T04:00:00Z') })
const base = () => ({ clients: [{ id: 'c', name: '甲方' }], stores: [{ id: 'a', name: 'A店', clientId: 'c' }, { id: 'b', name: 'B店', clientId: 'c' }, { id: 'x', name: '其他店', clientId: 'other' }, { id: 'paused', name: '暂停店', clientId: 'c', storeStatus: '暂停' }], products: [{ id: 'p', clientId: 'c', name: '水果' }], productCosts: [{ id: 'cost', productId: 'p', skuCode: '000123', specification: '大果5斤', totalCost: 4 }], skus: [], collectionRecords: [], profitRecords: [], orderAccountingLedgers: [] })
const row = (extra = {}) => ({ '订单号': '261019-1234567890123', '商品id': 'goods', '商品': '水果', '订单成交时间': '2026-10-19 12:00:00', '订单状态': '已发货', '商品数量(件)': '2', '商家实收金额(元)': '10', '商家编码-规格维度': '000123', '商品规格': '大果 5斤', ...extra })
const imported = (rows = [row()], store = 'a', data = base()) => mergeLinkSalesOrders(data, parseLinkSalesRows(store, rows))
const report = data => summarizeSpecSales(data, { clientId: 'c' })
const ledger = (extra = {}) => ({ storeId: 'a', orders: [], refunds: [], funds: [], promotions: [], ...extra })

test('yesterday uses the Shanghai calendar and ignores the settlement date range without changing it', () => {
  const filter = Object.freeze({ clientId: 'c', startDate: '2026-09-15', endDate: '2026-10-21' })
  const cases = [
    ['2026-10-21T15:59:59Z', '2026-10-20'],
    ['2026-10-21T16:00:00Z', '2026-10-21'],
    ['2026-10-22T04:00:00Z', '2026-10-21'],
    ['2026-01-01T00:00:00Z', '2025-12-31'],
    ['2024-03-01T00:00:00Z', '2024-02-29'],
  ]
  for (const [now, yesterday] of cases) {
    assert.deepEqual(specSalesYesterdayFilter(filter, new Date(now)), { clientId: 'c', startDate: yesterday, endDate: yesterday })
  }
  assert.deepEqual(filter, { clientId: 'c', startDate: '2026-09-15', endDate: '2026-10-21' })
})

test('only the appended spec section uses yesterday; old and current orders never inflate its quantities', () => {
  const data = imported([
    row({ '订单号': 'old', '订单成交时间': '2026-09-15', '商品数量(件)': '100' }),
    row({ '订单号': 'yesterday-start', '订单成交时间': '2026-10-19 00:00:00', '商品数量(件)': '2' }),
    row({ '订单号': 'yesterday-end', '订单成交时间': '2026-10-19 23:59:59', '商品数量(件)': '3' }),
    row({ '订单号': 'today', '订单成交时间': '2026-10-20 00:00:00', '商品数量(件)': '200' }),
  ])
  const before = JSON.stringify(data)
  // Even a financial report covering only an older day keeps yesterday's table.
  for (const range of [{ startDate: '2026-09-15', endDate: '2026-10-20' }, { startDate: '2026-09-15', endDate: '2026-09-15' }, {}]) {
    const workbook = createSettlementWorkbook(data, { clientId: 'c', ...range })
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets['总览'], { header: 1, raw: true })
    const section = grid.slice(grid.findIndex(r => r[0] === '规格销量汇总'))
    assert.equal(section[1][0], '昨日 2026-10-19，相同规格编码跨店合计。')
    assert.deepEqual(section.filter(r => r[0] === '000123').map(r => r[8]), [5])
  }
  assert.equal(JSON.stringify(data), before)
})

test('yesterday with no orders is explicit and does not fall back to historical sales', () => {
  const data = imported([row({ '订单成交时间': '2026-10-18', '商品数量(件)': '999' })])
  const sheet = XLSX.utils.aoa_to_sheet([['existing financial cell']])
  appendSpecSales(sheet, data, { clientId: 'c', startDate: '2026-09-15', endDate: '2026-10-20' })
  const values = Object.values(sheet).map(cell => cell?.v)
  assert(values.includes('昨日 2026-10-19，相同规格编码跨店合计。'))
  assert(values.includes('所选范围暂无可统计的规格销量。'))
  assert(!values.includes(999))
  assert(!values.includes('000123'))
})

test('missing dates and quantities in the yesterday section stay unknown instead of zero', () => {
  for (const unknown of [row({ '订单号': 'unknown', '订单成交时间': '' }), row({ '订单号': 'unknown', '商品数量(件)': '' })]) {
    const sheet = XLSX.utils.aoa_to_sheet([['existing financial cell']])
    appendSpecSales(sheet, imported([row(), unknown]), { clientId: 'c', startDate: '2026-09-15', endDate: '2026-10-20' })
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true })
    assert.equal(grid.find(r => r[0] === '000123')[8], '待补数据')
    assert(grid.some(r => typeof r[0] === 'string' && r[0].includes('当前销量不完整')))
  }
})

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
test('same full order ID in different stores counts both; the same code exports as one row', () => {
  const data = imported([row({ '商品id': '' })], 'b', imported())
  assert.deepEqual(report(data).rows.map(r => [r.skuCode, r.quantity]), [['000123', 4]])
})
test('different codes never collapse; different raw SKU names sharing one code are combined', () => {
  const data = imported([row(), row({ '订单号': 'other', '商品规格': '小果 5斤' }), row({ '订单号': 'third', '商家编码-规格维度': '000124' })])
  const result = report(data)
  assert.equal(result.rows.length, 2)
  assert.equal(result.rows.find(r => r.skuCode === '000123').quantity, 4)
  assert.equal(result.rows.find(r => r.skuCode === '000123').specification, '大果5斤')
  assert.equal(result.warnings.length, 0)
})

test('screenshot duplicate specs merge for export: JDG2Z 22+1=23 and JDG3D 45+1=46', () => {
  const data = imported([
    row({ '订单号': '1', '商家编码-规格维度': 'JDG2Z', '商品规格': '2斤中果（100-150g）', '商品数量(件)': '22' }),
    row({ '订单号': '2', '商家编码-规格维度': 'JDG2Z', '商品规格': '2斤中果 (100-150g)', '商品数量(件)': '1' }),
    row({ '订单号': '3', '商家编码-规格维度': 'JDG3D', '商品规格': '3斤大果（150-200g）', '商品数量(件)': '45' }),
    row({ '订单号': '4', '商家编码-规格维度': 'JDG3D', '商品规格': '３斤大果【１５０-２００Ｇ】', '商品数量(件)': '1' }),
  ])
  const before = JSON.stringify(data)
  const result = report(data)
  assert.deepEqual(result.rows.map(r => [r.skuCode, r.quantity]), [['JDG2Z', 23], ['JDG3D', 46]])
  assert.equal(result.warnings.length, 0)
  const workbook = createSettlementWorkbook(data, { clientId: 'c' })
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets['总览'], { header: 1, raw: true })
  const rows = grid.filter(r => ['JDG2Z', 'JDG3D'].includes(r[0]))
  assert.deepEqual(rows.map(r => [r[0], r[8]]), [['JDG2Z', 23], ['JDG3D', 46]])
  assert.equal(JSON.stringify(data), before)
})

test('exact code is the grouping key regardless of stores or raw name; leading zeros remain significant', () => {
  let data = imported([
    row(), row({ '订单号': 'different-code', '商家编码-规格维度': '123' }),
    row({ '订单号': 'different-weight', '商品规格': '大果 6斤' }),
    row({ '订单号': 'range', '商品规格': '大果 (100-150g)' }),
    row({ '订单号': 'other-range', '商品规格': '大果 (150-200g)' }),
    row({ '订单号': 'operator', '商品规格': '大果 1+1斤' }),
    row({ '订单号': 'no-operator', '商品规格': '大果 11斤' }),
  ])
  data = imported([row()], 'b', data)
  assert.equal(report(data).rows.length, 2)
  assert.deepEqual(report(data).rows.map(r => [r.skuCode, r.quantity]), [['000123', 14], ['123', 2]])
})

test('merged export keeps unknown quantities unknown and uses selected date range only', () => {
  const data = imported([
    row(), row({ '订单号': 'missing', '商品规格': '大果　５斤', '商品数量(件)': '' }),
    row({ '订单号': 'later', '商品规格': '大果5斤', '订单成交时间': '2026-10-20', '商品数量(件)': '99' }),
  ])
  const result = summarizeSpecSales(data, { clientId: 'c', startDate: '2026-10-19', endDate: '2026-10-19' })
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].quantity, null)
  assert.equal(result.complete, false)
})

test('page no longer renders the added spec block and preserves the original SKU cost matching section', () => {
  const analyzer = fs.readFileSync(require('node:path').join(__dirname, '../src/pages/PddAnalyzer.tsx'), 'utf8')
  assert(!analyzer.includes('SpecificationSales'))
  assert(analyzer.includes('SKU 成本匹配'))
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
  assert.deepEqual(report(data).rows.map(r => [r.skuCode, r.quantity]), [['000123', 2]])
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
  for (const label of ['规格销量汇总', '规格编码', '售卖规格', '总数量（件）', '000123', '大果5斤']) assert(values.includes(label), label)
  assert(!values.includes('大果 5斤'))
  assert.equal(JSON.stringify(data), before)
  const reopened = XLSX.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' })
  assert(Object.values(reopened.Sheets['总览']).some(cell => cell?.v === '000123' && cell.t === 's'))
})

test('code-only source counts without the original SKU name and displays the system short specification', () => {
  const raw = row(); delete raw['商品规格']
  const data = imported([raw])
  assert.deepEqual(report(data).rows.map(r => [r.skuCode, r.specification, r.quantity]), [['000123', '大果5斤', 2]])
  assert.equal(report(data).complete, true)
})

test('short specification lookup stays within exported client and never substitutes original selling SKU name', () => {
  const data = imported([row({ '商品规格': '原订单名称绝不能导出' })])
  data.products.push({ id: 'foreign-product', clientId: 'other' })
  data.productCosts.push({ id: 'foreign', productId: 'foreign-product', skuCode: '000123', specification: '其他甲方简称', totalCost: 1 })
  data.skus.push({ name: '商家原售卖SKU名称', skuId: '000123', specification: '商家原规格' })
  assert.equal(report(data).rows[0].specification, '大果5斤')
  data.productCosts = data.productCosts.filter(cost => cost.id !== 'cost')
  assert.equal(report(data).rows[0].specification, '未设置简称')
  assert.equal(report(data).rows[0].quantity, 2)
})

test('ambiguous or blank system short names stay explicit while one code still has one quantity', () => {
  const data = imported([row(), row({ '订单号': 'other', '商品规格': '另一个长名' })])
  data.productCosts.push({ id: 'other-name', productId: 'p', skuCode: '000123', specification: '不同简称', totalCost: 999 })
  assert.deepEqual(report(data).rows.map(r => [r.specification, r.quantity]), [['简称待核对', 4]])
  data.productCosts = [{ id: 'blank', productId: 'p', skuCode: '000123', specification: '', totalCost: 0 }]
  assert.equal(report(data).rows[0].specification, '未设置简称')
  assert.equal(report(data).complete, true)
})

test('duplicate library entries with the same short name never multiply quantities; library costs have no effect', () => {
  const data = imported()
  const before = report(data)
  data.productCosts.push({ ...data.productCosts[0], id: 'duplicate', totalCost: 99999 })
  assert.deepEqual(report(data), before)
  data.productCosts[0].specification = data.productCosts[1].specification = '更新后的系统简称'
  assert.equal(report(data).rows[0].specification, '更新后的系统简称')
  assert.equal(report(data).rows[0].quantity, 2)
})

test('one unknown quantity in any store keeps the cross-store code total unknown, never a partial sum', () => {
  const data = imported([row({ '商品数量(件)': '' })], 'b', imported())
  assert.equal(report(data).rows.length, 1)
  assert.equal(report(data).rows[0].quantity, null)
  assert.equal(report(data).complete, false)
})

test('export omits store columns, raw names and detailed diagnostics; many issues produce only one compact note', () => {
  const data = imported([row({ '商品规格': '原始长规格名称' }), ...Array.from({ length: 40 }, (_, index) => row({ '订单号': `missing-${index}`, '商家编码-规格维度': '' }))])
  data.orderAccountingLedgers = [ledger({ orders: [{ id: 'unindexed', date: '2026-10-19', cancelled: false, quantity: 7 }] })]
  const sheet = createSettlementWorkbook(data, { clientId: 'c' }).Sheets['总览']
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true })
  const start = grid.findIndex(r => r[0] === '规格销量汇总')
  const section = grid.slice(start)
  const values = section.flat()
  assert.deepEqual(section[3].filter(Boolean), ['规格编码', '售卖规格', '总数量（件）'])
  for (const forbidden of ['店铺', 'A店', 'B店', '原始长规格名称']) assert(!values.includes(forbidden))
  assert(!values.some(value => typeof value === 'string' && /缺少规格维度编码，需补导|历史订单缺少规格明细|A店：/.test(value)))
  assert.equal(section.filter(r => r.some(value => typeof value === 'string' && value.includes('当前销量不完整'))).length, 1)
  assert.equal(section.length, 5)
  const reopened = XLSX.read(XLSX.write({ SheetNames: ['总览'], Sheets: { 总览: sheet } }, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', cellNF: true })
  const codeCell = Object.values(reopened.Sheets['总览']).find(cell => cell?.v === '000123')
  assert.equal(codeCell.t, 's'); assert.equal(codeCell.w, '000123'); assert.equal(codeCell.z, '@')
})
