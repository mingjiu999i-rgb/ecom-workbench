const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const cache = new Map()
function load(file) {
  if (cache.has(file)) return cache.get(file).exports
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  cache.set(file, module)
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { Date, Math, Number, Object, Set }, { filename: file })((request) => {
    if (request === './performanceSummary') return { roundMoney: n => Math.round((n + Number.EPSILON) * 100) / 100,
      shiftDate: (date, days) => { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10) },
      validDate: date => /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) }
    throw Error(request)
  }, module, module.exports)
  return module.exports
}
const { summarizeRefundPeriod, findRefundAnomalies } = load('src/utils/refundReview.ts')
const { buildRefundReviewNarrative } = load('src/utils/refundReviewNarrative.ts')
const date = (base, offset) => { const day = new Date(`${base}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + offset); return day.toISOString().slice(0, 10) }
const row = (dateValue, refund, extra = {}) => ({ storeId: 's1', date: dateValue, originalSales: 100, orderShippedRefund: refund, shippedRefund: refund,
  orderCount: 10, settledOrders: 9, eligibleOrders: 10, currentNet: 80, effectiveSales: 100 - refund, unsettledAmount: 10, ...extra })

test('detects a seven-day refund-rate rise and reports payment movement separately', () => {
  const rows = Array.from({ length: 28 }, (_, i) => row(date('2026-09-07', i), 2))
    .concat(Array.from({ length: 7 }, (_, i) => row(date('2026-10-05', i), 10, { settledOrders: 7, currentNet: 50 })))
  const findings = findRefundAnomalies(rows, '2026-10-05', '2026-10-11')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].severity, 'high')
  assert.equal(findings[0].current.refundRate, 0.1)
  assert.equal(findings[0].baseline.refundRate, 0.02)
  assert.ok(findings[0].paymentChange < -0.19)
})

test('does not call a partial week or missing baseline an anomaly', () => {
  const rows = Array.from({ length: 28 }, (_, i) => row(date('2026-09-07', i), 2))
    .concat(Array.from({ length: 6 }, (_, i) => row(date('2026-10-05', i), 10)))
  assert.equal(findRefundAnomalies(rows, '2026-10-05', '2026-10-11').length, 0)
})

test('keeps old refund basis and zero denominators unknown', () => {
  const old = summarizeRefundPeriod([row('2026-10-05', 10, { orderShippedRefund: undefined, refundBasis: 'refund_completed_at' })], '2026-10-05', '2026-10-05')
  assert.equal(old.refundRate, null)
  assert.equal(old.missingRefundBasis, true)
  const zero = summarizeRefundPeriod([row('2026-10-05', 0, { originalSales: 0, eligibleOrders: 0, effectiveSales: 0 })], '2026-10-05', '2026-10-05')
  assert.equal(zero.refundRate, null)
  assert.equal(zero.paymentCompletion, null)
  assert.equal(zero.netReceiptRatio, null)
})

test('narrative separates refund-rate rise from payment and receipt movement without inventing missing profit', () => {
  const rows = Array.from({ length: 28 }, (_, i) => row(date('2026-09-07', i), 2))
    .concat(Array.from({ length: 7 }, (_, i) => row(date('2026-10-05', i), 10, { settledOrders: 7, currentNet: 50 })))
  const text = buildRefundReviewNarrative([{ name: '测试店铺', period: summarizeRefundPeriod(rows, '2026-09-07', '2026-10-11'),
    findings: findRefundAnomalies(rows, '2026-10-05', '2026-10-11') }]).join(' ')
  assert.match(text, /测试店铺（2026-10-05 至 2026-10-11）/)
  assert.match(text, /已发货退款率 10\.00%，此前 28 天为 2\.00%，上升 8\.00 个百分点/)
  assert.match(text, /订单入账率 70\.00%，较基准下降 20\.00 个百分点/)
  assert.match(text, /净回款比例/)
  assert.match(text, /最新盈亏 未记录，当前盈亏 未记录/)
  assert.match(text, /不能仅凭这些数字判定退款造成回款或利润变化/)
})

test('narrative calls missing dates out and never treats an empty period as zero refund', () => {
  const partial = summarizeRefundPeriod([row('2026-10-05', 10)], '2026-10-05', '2026-10-11')
  const text = buildRefundReviewNarrative([{ name: '测试店铺', period: partial, findings: [] }]).join(' ')
  assert.match(text, /未检出达到阈值/)
  assert.match(text, /缺失日期或旧退款口径，可能漏检异常/)
  const empty = buildRefundReviewNarrative([{ name: '测试店铺', period: summarizeRefundPeriod([], '2026-10-05', '2026-10-11'), findings: [] }]).join(' ')
  assert.match(empty, /没有已保存的结算记录/)
  assert.doesNotMatch(empty, /退款率 0/)
})
