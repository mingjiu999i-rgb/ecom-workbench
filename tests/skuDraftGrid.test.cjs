const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
const { blankDraftGridRow: blank, toDraftGridRow: edit, draftGridNumber: number, isBlankDraftGridRow: empty, chooseDraftGridCost: choose, draftGridError: error, parseDraftGridPaste: parse, pasteDraftGrid: paste, saveDraftGrid: save } = require('../src/utils/skuDraftGrid.ts')
const { getSkuPlanningDrafts: drafts, calculateSkuDraft: calculate } = require('../src/utils/skuDrafts.ts')
const data = () => ({ clients: [{ id: 'c' }], stores: [], products: [{ id: 'p' }, { id: 'q' }],
  productCosts: [{ id: 's1', productId: 'p', skuCode: '001', specification: '2件装', totalCost: 4 }, { id: 's2', productId: 'p', skuCode: '002', specification: '3件装', totalCost: 6 }, { id: 'q1', productId: 'q', skuCode: '001', specification: '2件装', totalCost: 9 }],
  skus: [], productLinks: [], operations: [], skuHistory: [], todos: [], profitRecords: [{ amount: 25 }], collectionRecords: [{ shippedRefund: 8 }], orderAccountingLedgers: [{ orders: [] }], overviewRefundActivity: { version: 1 } })
const row = () => ({ ...blank('one', 'p'), name: '2件装', costId: 's1', cost: 4, priceA: '10' })
let id = 0
const nextId = () => `new-${++id}`
const now = '2026-10-15T06:00:00Z'

test('blank grid does not invent zero amounts or require optional inputs', () => {
  assert.equal(empty(blank('x', 'p')), true)
  assert.equal(blank('x').cost, null)
  assert.equal(number('  '), null)
  assert.equal(number('0'), 0)
  assert.equal(error(data(), row()), '')
})
test('currency and thousand formatting parse, malformed text and formulas do not', () => {
  assert.equal(number('￥1,234.50'), 1234.5)
  assert.equal(number('¥10.00'), 10)
  assert.equal(number('0.5'), 0.5)
  for (const value of ['1,2', '10abc', '=2+3', 'Infinity', '0x10']) assert.ok(Number.isNaN(number(value)))
})
test('Excel paste preserves blank optional cells, leading-zero codes and Windows newlines', () => {
  assert.deepEqual(parse('2件装\t001\t10\t\t\r\n3件装\t002\t12\t3\t9\r\n'), [['2件装', '001', '10', '', ''], ['3件装', '002', '12', '3', '9']])
})
test('quoted cell tabs, newlines and doubled quotes survive TSV parsing', () => {
  assert.deepEqual(parse('"红\t色\n大"\t001\t10\t\t\n"带""引号"\t002\t12'), [['红\t色\n大', '001', '10', '', ''], ['带"引号', '002', '12']])
  assert.throws(() => parse('"未闭合\t001'), /引号未闭合/)
})
test('recognized five-column header is skipped', () => {
  assert.deepEqual(parse('SKU / 规格\t成本编码\tA 售价\tA 当前 ROI\tB 售价\n2件装\t001\t10\t\t'), [['2件装', '001', '10', '', '']])
})
test('explicit blank cells and rows remain available to clear old optional values', () => {
  assert.deepEqual(parse('\t'), [['', '']])
  assert.deepEqual(parse('3\t8\n\t\n'), [['3', '8'], ['', '']])
  const result = paste(data(), [{ ...row(), roiA: '3', priceB: '8' }], 'one', 'roiA', '\t', 'p', nextId)
  assert.equal(result.rows[0].roiA, '')
  assert.equal(result.rows[0].priceB, '')
})
test('500 rows are allowed and excess rows or columns reject atomically', () => {
  assert.equal(parse(Array(500).fill('2件装').join('\n')).length, 500)
  assert.throws(() => parse(Array(501).fill('2件装').join('\n')), /500/)
  const original = [row()]
  assert.throws(() => paste(data(), original, 'one', 'name', 'a\tb\tc\td\te\tf', 'p', nextId), /列数/)
  assert.equal(original[0].priceA, '10')
})
test('multiple rows paste and match costs only inside their product', () => {
  const first = blank('one', 'p')
  const result = paste(data(), [first], 'one', 'name', '2件装\t001\t10\t3\t8\n3件装\t002\t12\t\t', 'p', nextId)
  assert.equal(result.touched.length, 2)
  assert.deepEqual(result.rows.map(r => [r.name, r.cost, r.priceA, r.roiA, r.priceB]), [['2件装', 4, '10', '3', '8'], ['3件装', 6, '12', '', '']])
  assert.equal(first.name, '')
  assert.equal(calculate({ cost: result.rows[0].cost, priceA: number(result.rows[0].priceA), roiA: number(result.rows[0].roiA), priceB: number(result.rows[0].priceB) }).suggestedRoi, 4.29)
})
test('single-column SKU paste auto matches specifications', () => {
  const result = paste(data(), [blank('one', 'p')], 'one', 'name', '2件装\n3件装', 'p', nextId)
  assert.deepEqual(result.rows.map(r => r.costId), ['s1', 's2'])
})
test('pasted replacement SKU cannot inherit a previously selected cost', () => {
  const result = paste(data(), [row()], 'one', 'name', '未匹配SKU\n', 'p', nextId)
  assert.equal(result.rows[0].costId, '')
  assert.equal(result.rows[0].cost, null)
  assert.equal(error(data(), result.rows[0]), '请选择有效成本')
})
test('explicit wrong cost code never falls back to another guessed cost', () => {
  const result = paste(data(), [row()], 'one', 'name', '2件装\t不存在\t10\t\t', 'p', nextId)
  assert.equal(result.rows[0].cost, null)
})
test('numeric rectangular paste starts at A price and preserves SKU and cost', () => {
  const result = paste(data(), [row(), { ...row(), id: 'two' }], 'one', 'priceA', '11\t4\t9\n12\t\t', 'p', nextId)
  assert.deepEqual(result.rows.map(r => [r.name, r.costId, r.priceA, r.roiA, r.priceB]), [['2件装', 's1', '11', '4', '9'], ['2件装', 's1', '12', '', '']])
})
test('manual cost selection cannot cross products and confirmed zero cost remains valid', () => {
  const d = data()
  assert.equal(choose(d, row(), 'q1').cost, null)
  d.productCosts[0].totalCost = 0
  const chosen = choose(d, row(), 's1')
  assert.equal(chosen.cost, 0)
  assert.equal(error(d, chosen), '')
})
test('unknown product and invalid required/optional cells produce actionable errors', () => {
  assert.match(error(data(), { ...row(), productId: '' }), /所属产品/)
  for (const priceA of ['', '0', '-1', 'bad', '1e999']) assert.match(error(data(), { ...row(), priceA }), /A 售价/)
  for (const roiA of ['0', '-1', 'bad']) assert.match(error(data(), { ...row(), roiA }), /A ROI/)
  for (const priceB of ['0', '-1', 'bad']) assert.match(error(data(), { ...row(), priceB }), /B 售价/)
})
test('save all persists valid edited rows once and skips new blank placeholders', () => {
  const d = data()
  const saved = save(d, [row(), { ...row(), id: 'two', name: '测试B', roiA: '3', priceB: '8' }, blank('empty', 'p')], now)
  assert.equal(drafts(saved).length, 2)
  assert.equal(drafts(saved)[0].roiA, null)
  assert.equal(drafts(saved)[0].priceB, null)
  assert.equal(drafts(saved)[1].priceB, 8)
})
test('one invalid row prevents the entire batch with no partial mutation', () => {
  const d = data(), snapshot = JSON.stringify(d)
  assert.throws(() => save(d, [row(), { ...row(), id: 'bad', priceA: '' }], now), /未保存任何行/)
  assert.equal(JSON.stringify(d), snapshot)
  assert.equal(drafts(d).length, 0)
})
test('edits update existing IDs instead of duplicating and preserve untouched hidden drafts', () => {
  const first = save(data(), [row(), { ...row(), id: 'hidden' }], now)
  const updated = { ...edit(drafts(first)[0]), priceA: '11' }
  const second = save(first, [updated], '2026-10-15T07:00:00Z')
  assert.equal(drafts(second).length, 2)
  assert.equal(drafts(second)[0].priceA, 11)
  assert.equal(drafts(second)[1], drafts(first)[1])
})
test('concurrent modification or deletion rejects stale grid writes atomically', () => {
  const first = save(data(), [row()], now)
  const stale = edit(drafts(first)[0])
  const second = save(first, [{ ...stale, priceA: '12' }], '2026-10-15T07:00:00Z')
  assert.throws(() => save(second, [{ ...stale, priceA: '13' }], now), /已被其他操作修改/)
  assert.throws(() => save({ ...first, skuPlanningDrafts: [] }, [stale], now), /已被其他操作修改/)
})
test('cleared existing rows are not silently discarded as new blank placeholders', () => {
  const existing = { ...blank('one'), baseUpdatedAt: now }
  assert.equal(empty(existing), false)
  assert.throws(() => save(data(), [existing], now), /请填 SKU/)
})
test('saved planning costs remain unchanged when the library changes until explicit selection', () => {
  const first = save(data(), [row()], now)
  first.productCosts[0] = { ...first.productCosts[0], totalCost: 9 }
  const updated = { ...edit(drafts(first)[0]), priceA: '11' }
  assert.equal(updated.cost, 4)
  assert.equal(choose(first, updated, 's1').cost, 9)
})
test('all bulk operations preserve settlement and other data by reference', () => {
  const d = data(), before = JSON.stringify(d)
  const result = paste(d, [blank('one', 'p')], 'one', 'name', '2件装\t001\t10\t3\t8\n3件装\t002\t12\t\t', 'p', nextId)
  const saved = save(d, result.rows, now)
  assert.equal(JSON.stringify(d), before)
  for (const key of Object.keys(d)) assert.equal(saved[key], d[key], key)
})
