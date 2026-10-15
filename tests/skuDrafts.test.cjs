const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  module._compile(output.outputText, filename)
}
const { calculateSkuDraft: calc, getSkuPlanningDrafts: drafts, putSkuPlanningDraft: put, removeSkuPlanningDraft: remove, matchDraftCost: match, roiSetting } = require('../src/utils/skuDrafts.ts')
const near = (value, expected) => assert.ok(Math.abs(value - expected) < 1e-10, `${value} != ${expected}`)
const basic = { cost: 4, priceA: 10, roiA: null, priceB: null }

test('base-only draft calculates gross profit, gross margin and break-even without requiring A ROI or B price', () => {
  const result = calc(basic)
  assert.equal(result.baseValid, true)
  assert.equal(result.grossProfit, 6)
  near(result.grossMargin, 0.6)
  near(result.breakEvenRoi, 5 / 3)
  assert.equal(result.marginA, null)
  assert.equal(result.targetRoi, null)
  assert.equal(result.targetState, 'waiting')
})
test('A ROI enables after-ad profit margin without B price', () => {
  const result = calc({ ...basic, roiA: 3 })
  near(result.adCostA, 10 / 3)
  near(result.profitA, 8 / 3)
  near(result.marginA, 4 / 15)
  assert.equal(result.targetState, 'waiting')
})
test('10 yuan at ROI 3 maps 8 yuan to exact 30/7 and minimum setting 4.29', () => {
  const result = calc({ ...basic, roiA: 3, priceB: 8 })
  near(result.targetRoi, 30 / 7)
  assert.equal(result.suggestedRoi, 4.29)
  assert.ok(result.marginB >= result.marginA)
  near(1 - 4 / 8 - 1 / result.targetRoi, result.marginA)
})
test('lower price requires higher ROI, higher price allows lower ROI', () => {
  const lower = calc({ ...basic, roiA: 3, priceB: 8 })
  const same = calc({ ...basic, roiA: 3, priceB: 10 })
  const higher = calc({ ...basic, roiA: 3, priceB: 12 })
  assert.ok(lower.targetRoi > same.targetRoi)
  assert.ok(higher.targetRoi < same.targetRoi)
  assert.equal(same.suggestedRoi, 3)
})
test('equal profit margins do not imply equal per-order profits', () => {
  const result = calc({ ...basic, roiA: 3, priceB: 8 })
  assert.ok(result.profitB < result.profitA)
  assert.ok(result.marginB >= result.marginA)
})
test('B price alone never fabricates A ROI or target profit margin', () => {
  const result = calc({ ...basic, priceB: 8 })
  assert.equal(result.marginA, null)
  assert.equal(result.targetState, 'waiting')
})
test('missing base values are unknown rather than zero', () => {
  for (const input of [{ cost: null, priceA: 10 }, { cost: 4, priceA: null }]) {
    const result = calc({ ...input, roiA: 3, priceB: 8 })
    assert.equal(result.baseValid, false)
    assert.equal(result.grossProfit, null)
    assert.equal(result.targetState, 'waiting')
  }
})
test('invalid nonfinite or negative base inputs cannot produce calculations', () => {
  for (const input of [{ cost: -1, priceA: 10 }, { cost: NaN, priceA: 10 }, { cost: 4, priceA: Infinity }, { cost: 4, priceA: 0 }]) assert.equal(calc(input).baseValid, false)
})
test('invalid optional ROI or price never becomes a zero or infinite target', () => {
  for (const roiA of [0, -1, NaN, Infinity]) assert.equal(calc({ ...basic, roiA, priceB: 8 }).targetState, 'waiting')
  for (const priceB of [0, -1, NaN, Infinity]) assert.equal(calc({ ...basic, roiA: 3, priceB }).targetState, 'waiting')
})
test('confirmed zero cost is valid and preserves ROI across different prices', () => {
  const result = calc({ cost: 0, priceA: 10, roiA: 3, priceB: 8 })
  assert.equal(result.baseValid, true)
  assert.equal(result.breakEvenRoi, 1)
  near(result.targetRoi, 3)
  assert.equal(result.suggestedRoi, 3)
})
test('cost at or above price never advertises a finite break-even ROI', () => {
  assert.equal(calc({ cost: 10, priceA: 10 }).breakEvenRoi, null)
  assert.equal(calc({ cost: 11, priceA: 10 }).breakEvenRoi, null)
  assert.equal(calc({ cost: 11, priceA: 10 }).grossProfit, -1)
})
test('zero allowed ad spend is distinct from an impossible price', () => {
  const zero = calc({ cost: 4, priceA: 10, roiA: 5, priceB: 20 / 3 })
  assert.equal(zero.targetState, 'no-ad-spend')
  assert.equal(zero.targetRoi, null)
  const impossible = calc({ cost: 4, priceA: 10, roiA: 5, priceB: 6 })
  assert.equal(impossible.targetState, 'unreachable')
  assert.equal(impossible.targetRoi, null)
})
test('loss-making A is not silently clamped into a profitable benchmark', () => {
  const result = calc({ cost: 8, priceA: 10, roiA: 2, priceB: 9 })
  near(result.marginA, -0.3)
  assert.equal(result.targetState, 'ready')
  near(1 - 8 / 9 - 1 / result.targetRoi, result.marginA)
})
test('ROI setting rounds upward without adding a cent to exact decimal settings', () => {
  assert.equal(roiSetting(4.285714), 4.29)
  assert.equal(roiSetting(4.29), 4.29)
  assert.equal(roiSetting(1.234), 1.24)
  for (let value = 1; value < 1000; value++) assert.equal(roiSetting(value / 100), value / 100)
})
const state = () => ({
  clients: [{ id: 'c' }], stores: [], products: [{ id: 'p' }, { id: 'q' }], productLinks: [], skus: [],
  productCosts: [{ id: 'one', productId: 'p', skuCode: 'S1', specification: '2件装', totalCost: 4 }, { id: 'other', productId: 'q', skuCode: 'S2', specification: '2件装', totalCost: 7 }],
  operations: [], skuHistory: [], todos: [], profitRecords: [{ amount: 12 }], collectionRecords: [{ shippedRefund: 3 }], orderAccountingLedgers: [{ orders: [] }], overviewRefundActivity: { version: 1 },
})
const draft = { id: 'plan1', name: '2件装', productId: 'p', costId: 'one', cost: 4, priceA: 10, roiA: null, priceB: null, updatedAt: '2026-10-15T01:00:00Z' }
test('matching is confined to the selected product and rejects ambiguous specifications', () => {
  const data = state()
  assert.equal(match(data, 'p', '2件装'), 'one')
  assert.equal(match(data, '', '2件装'), '')
  data.productCosts.push({ ...data.productCosts[0], id: 'duplicate' })
  assert.equal(match(data, 'p', '2件装'), '')
})
test('exact SKU codes match within the product but duplicate codes never choose arbitrarily', () => {
  const data = state()
  assert.equal(match(data, 'p', ' s1 '), 'one')
  assert.equal(match(data, 'q', 's1'), '')
  data.productCosts.push({ ...data.productCosts[0], id: 'duplicate', specification: '另一规格' })
  assert.equal(match(data, 'p', 'S1'), '')
})
test('old accounts without drafts remain readable and optional fields stay null through JSON round-trip', () => {
  const data = state()
  assert.deepEqual(drafts(data), [])
  const reloaded = JSON.parse(JSON.stringify(put(data, draft)))
  assert.deepEqual(drafts(reloaded), [draft])
  assert.equal(drafts(reloaded)[0].roiA, null)
  assert.equal(drafts(reloaded)[0].priceB, null)
})
test('draft add, edit and removal preserve every unrelated financial object by reference', () => {
  const data = state(), original = JSON.stringify(data)
  const added = put(data, draft)
  const edited = put(added, { ...draft, roiA: 3, priceB: 8 })
  const removed = remove(edited, draft.id)
  assert.equal(drafts(edited).length, 1)
  assert.equal(drafts(edited)[0].roiA, 3)
  assert.deepEqual(drafts(removed), [])
  assert.equal(JSON.stringify(data), original)
  for (const next of [added, edited, removed]) for (const key of Object.keys(data)) assert.equal(next[key], data[key], key)
})
test('saved planning cost is explicit and never follows a library update without user action', () => {
  const data = put(state(), draft)
  data.productCosts[0] = { ...data.productCosts[0], totalCost: 8 }
  assert.equal(drafts(data)[0].cost, 4)
  assert.equal(calc(drafts(data)[0]).grossProfit, 6)
})
