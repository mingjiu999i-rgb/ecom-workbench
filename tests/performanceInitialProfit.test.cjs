const assert = require('node:assert/strict'), { test } = require('node:test'), fs = require('node:fs'), ts = require('typescript')
const compile = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename)
require.extensions['.ts'] = compile; require.extensions['.tsx'] = compile; require.extensions['.css'] = () => {}
const { buildPerformance } = require('../src/utils/performanceSummary.ts')
const { PerformanceTrend } = require('../src/components/PerformanceTrend.tsx')
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server')
const collection = (date, extra = {}) => ({ storeId: 'a', date, originalSales: 3000, effectiveSales: 2500, productCost: 700, promotionFee: 200, shippedRefund: 500, refundBasis: 'order_paid_at', missingCostOrders: 0, ...extra })
const product = (date, extra = {}) => ({ storeId: 'a', productId: 'p', date, amount: 2500, cost: 700, promotion: 200, operationFee: 100, estimatedProfit: 1500, ...extra })
const baseline = (date, amount = 2000, extra = {}) => ({ id: `${date}-initial`, storeId: 'a', date, recordedAt: '2026-11-05T04:00:00Z', orderCount: 10, collectionProfit: amount + 100, products: [{ productId: 'p', estimatedProfit: amount }], ...extra })
const fixture = () => ({ stores: [{ id: 'a', clientId: 'c' }, { id: 'b', clientId: 'c' }], clients: [{ id: 'c' }], collectionRecords: [collection('2026-10-20')], profitRecords: [product('2026-10-20')], profitBaselines: [baseline('2026-10-20')] })
const report = (data, start = '2026-10-20', end = start, store = 'a') => buildPerformance(data, start, end, store, '2026-11-04')

test('green chart column reads the frozen initial value; latest tooltip and overview keep the current saved profit', () => {
  const data = fixture(), original = structuredClone(data), first = report(data)
  assert.equal(first.trend[0].profit, 2000)
  assert.equal(first.trend[0].latestProfit, 1500)
  assert.equal(first.trend[0].amount, 500)
  assert.equal(first.total.profit, 1500)
  data.collectionRecords[0].effectiveSales = 2000; data.collectionRecords[0].shippedRefund = 1000
  data.profitRecords[0].amount = 2000; data.profitRecords[0].estimatedProfit = 1000
  const second = report(data)
  assert.equal(second.trend[0].profit, 2000)
  assert.equal(second.trend[0].latestProfit, 1000)
  assert.equal(second.total.profit, 1000)
  assert.deepEqual(data.profitBaselines, original.profitBaselines)
  assert.equal(first.trend[0].profitPartial, false)
})

test('missing historical snapshots never use latest profit or zero, while known zero and losses remain numeric', () => {
  const data = fixture(); delete data.profitBaselines
  const result = report(data)
  assert.equal(result.trend[0].profit, null)
  assert.match(result.trend[0].profitNote, /未记录/)
  assert.equal(result.trend[0].latestProfit, 1500)
  for (const amount of [0, -20.25]) {
    data.profitBaselines = [baseline('2026-10-20', amount)]
    assert.equal(report(data).trend[0].profit, amount)
  }
})

test('monthly and cross-store totals require every store-date baseline; scope deduplicates products without adding absent dates', () => {
  const data = fixture()
  data.collectionRecords.push(collection('2026-10-21'), collection('2026-10-20', { storeId: 'b' }))
  data.profitRecords.push(product('2026-10-21'), product('2026-10-20', { storeId: 'b' }))
  data.profitBaselines.push(baseline('2026-10-21', 300), baseline('2026-10-20', 700, { storeId: 'b' }))
  assert.equal(report(data, '2026-10-01', '2026-12-31').trend[0].profit, 2300)
  assert.equal(report(data, '2026-10-01', '2026-12-31', '').trend[0].profit, 3000)
  assert.deepEqual(report(data, '2026-10-01', '2026-12-31').trend.map(row => row.date), ['2026-10'])
  data.profitBaselines.pop()
  assert.equal(report(data, '2026-10-20', '2026-10-20', '').trend[0].profit, null)
  assert.equal(report(data, '2026-10-01', '2026-12-31', '').trend[0].profit, null)
  assert.equal(report(data, '2026-10-21').trend[0].profit, 300)
  data.profitRecords.push(product('2026-10-21', { productId: 'second' }))
  assert.equal(report(data, '2026-10-21').trend[0].profit, 300)
})

test('saved initial amounts survive current incomplete data and include operation fees only once', () => {
  const data = fixture(), before = JSON.stringify(data)
  assert.equal(report(data).trend[0].profit, 2000)
  assert.equal(JSON.stringify(data), before)
  data.profitRecords = []
  const row = report(data).trend[0]
  assert.equal(row.profit, 2000)
  assert.equal(row.latestProfit, null)
  assert.equal(row.profitNote, null)
  assert(row.latestProfitNote)
})

test('snapshot-only historical month is read without generating missing months or changing any records', () => {
  const data = fixture(); data.collectionRecords = []; data.profitRecords = []
  const before = JSON.stringify(data), result = report(data, '2026-09-01', '2026-12-31')
  assert.deepEqual(result.trend.map(row => [row.date, row.profit, row.latestProfit, row.amount]), [['2026-10', 2000, null, null]])
  assert.equal(JSON.stringify(data), before)
})

test('chart legend and accessible hover description distinguish initial, latest and refunds without subtracting refunds again', () => {
  const result = report(fixture())
  const html = renderToStaticMarkup(React.createElement(PerformanceTrend, { ...result, comparison: '上期暂无数据', comparisonPeriod: '', onSelect() {} }))
  assert.match(html, /每日初始预估盈亏与退款/)
  assert.match(html, /初始预估盈亏 ¥2,000.00，退款 ¥500.00，最新盈亏 ¥1,500.00/)
  assert(!html.includes('盈亏－退款'))
  const data = fixture(); data.profitBaselines = []
  const unknown = renderToStaticMarkup(React.createElement(PerformanceTrend, { ...report(data), comparison: '', comparisonPeriod: '', onSelect() {} }))
  assert.match(unknown, /初始预估盈亏 未记录/)
  assert.match(unknown, /不以最新值或零代替/)
  const loading = renderToStaticMarkup(React.createElement(PerformanceTrend, { ...report(data), initialStatus: 'loading', comparison: '', comparisonPeriod: '', onSelect() {} }))
  assert.match(loading, /初始预估盈亏 读取中/)
  assert(!loading.includes('初始预估盈亏 未记录'))
  const failed = renderToStaticMarkup(React.createElement(PerformanceTrend, { ...report(data), initialStatus: 'error', comparison: '', comparisonPeriod: '', onSelect() {} }))
  assert.match(failed, /初始预估盈亏 读取失败/)
  assert.match(failed, /重新读取初始记录/)
})
