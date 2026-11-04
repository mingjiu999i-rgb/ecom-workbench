const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  module._compile(output.outputText, filename)
}
const { matchBatchSkuCost } = require('../src/utils/batchSkuMatching.ts')
const choice = (id, specification) => ({ id, specification })
const costs = [
  choice('1-small', '1斤小果（60-100g）'), choice('1-medium', '1斤中果（100-150g）'),
  choice('1-large', '1斤大果（150-200g）'), choice('2-small', '2斤小果（60-100g）'),
  choice('3-small', '3斤小果（60-100g）'), choice('2-medium', '2斤中果（100-150g）'),
  choice('3-medium', '3斤中果（100-150g）'), choice('2-large', '2斤大果（150-200g）'),
  choice('3-large', '3斤大果（150-200g）'), choice('5-medium', '5斤中果（100-150g）'),
  choice('5-large', '5斤大果（150-200g）'), choice('5-small', '5斤小果（60-100g）'),
  choice('2-extra', '2斤特大果（200g）'), choice('3-extra', '3斤特大果（200g）'),
  choice('5-extra', '5斤特大果（200g）'),
]

test('the six screenshot rows match four unique costs and leave two genuinely different specs unresolved', () => {
  const rows = [
    ['最多人买【净重2斤-大果】150-200g/个', '2-large'],
    ['最多人买【净重3斤-大果】150-200g/个', '3-large'],
    ['回购最多【净重2斤-特大果】200g+/个', '2-extra'],
    ['回购最多【净重3斤-特大果】200g+/个', '3-extra'],
    ['试吃体验【净重0.5斤-单重60g起】小果', ''],
    ['首单推荐【净重2斤-中大果】90-150g/个', ''],
  ]
  for (const [name, expected] of rows) assert.equal(matchBatchSkuCost(name, costs), expected, name)
})

test('spaces, full-width numbers, brackets, range separators and dimension order are equivalent', () => {
  for (const name of [
    '最多人买【净重２斤－大果】１５０～２００Ｇ／个',
    '净重 2 斤 · 大果（150 至 200 克/颗）',
    '大果【150—200g/个】净重2斤',
    '150~200g/个 大果 2斤',
  ]) assert.equal(matchBatchSkuCost(name, costs), '2-large', name)
})

test('equivalent jin and kilogram total weights match, without merging different weights', () => {
  assert.equal(matchBatchSkuCost('净重1kg 大果 单果150-200g', costs), '2-large')
  assert.equal(matchBatchSkuCost('净重1公斤 大果 单果150-200g', costs), '2-large')
  assert.equal(matchBatchSkuCost('净重1千克 大果 单果150-200g', costs), '2-large')
  assert.equal(matchBatchSkuCost('净重0.5斤 大果150-200g/个', costs), '')
  assert.equal(matchBatchSkuCost('净重12斤 大果150-200g/个', costs), '')
})

test('fruit grade and exact single-fruit range must both agree', () => {
  for (const name of [
    '2斤中大果100-150g', '2斤大果90-150g', '2斤大果100-200g',
    '2斤大果150-220g', '2斤大果150g+', '2斤超大果200g+',
  ]) assert.equal(matchBatchSkuCost(name, costs), '', name)
})

test('a missing dimension never selects a more specific fruit cost by substring', () => {
  assert.equal(matchBatchSkuCost('2斤大果', costs), '')
  assert.equal(matchBatchSkuCost('大果150-200g/个', costs), '')
  assert.equal(matchBatchSkuCost('2斤150-200g/个', costs), '')
})

test('a half-jin minimum-weight specification only matches an equivalent cost if it exists', () => {
  const half = choice('half', '0.5斤小果（60g以上）')
  assert.equal(matchBatchSkuCost('试吃体验【净重0.5斤-单重60g起】小果', [...costs, half]), 'half')
  assert.equal(matchBatchSkuCost('试吃体验【净重0.5斤-单重60g起】小果', [...costs, choice('range', '0.5斤小果（60-100g）')]), '')
})

test('duplicate equivalent candidates remain manual, independent of list order or cost code', () => {
  const ambiguous = [...costs, choice('duplicate', '1kg 大果150~200g')]
  assert.equal(matchBatchSkuCost('最多人买【净重2斤-大果】150-200g/个', ambiguous), '')
  assert.equal(matchBatchSkuCost('最多人买【净重2斤-大果】150-200g/个', ambiguous.reverse()), '')
})

test('flavor and other substantive qualifiers are preserved', () => {
  const flavored = [choice('red', '2斤红心大果150-200g'), choice('yellow', '2斤黄心大果150-200g')]
  assert.equal(matchBatchSkuCost('最多人买【净重2斤-红心大果】150-200g/个', flavored), 'red')
  assert.equal(matchBatchSkuCost('净重2斤-黄心大果150-200g/个', [flavored[0]]), '')
  assert.equal(matchBatchSkuCost('净重2斤-大果150-200g/个', flavored), '')
})

test('the existing snack batch-import example and flavor selection still work', () => {
  const snacks = [choice('plain', '2袋原味【2*125g/包】'), choice('spicy', '2袋麻辣【2*125g/包】')]
  assert.equal(matchBatchSkuCost('2袋原味【2*125g/包】含花青素', snacks), 'plain')
  assert.equal(matchBatchSkuCost('2袋麻辣【2*125g/包】含花青素', snacks), 'spicy')
  assert.equal(matchBatchSkuCost('2袋麻辣【2*125g/包】含花青素', [snacks[0]]), '')
})

test('substring fallback never matches a fragment of a different numeric quantity', () => {
  assert.equal(matchBatchSkuCost('1125g原味', [choice('small', '125g原味')]), '')
  assert.equal(matchBatchSkuCost('12袋原味', [choice('two', '2袋原味')]), '')
  assert.equal(matchBatchSkuCost('0.5斤原味', [choice('five', '5斤原味')]), '')
})

test('input specifications and candidate records remain unchanged', () => {
  const snapshot = JSON.stringify(costs)
  matchBatchSkuCost('最多人买【净重2斤-大果】150-200g/个', costs)
  assert.equal(JSON.stringify(costs), snapshot)
  assert.equal(matchBatchSkuCost('', costs), '')
  assert.equal(matchBatchSkuCost('2斤大果150-200g', []), '')
})

const countedCosts = [
  choice('count-1-small', '1斤小果（小果 约6-9个/斤）'),
  choice('count-2-small', '2斤小果（小果 约6-9个/斤）'),
  choice('count-1-medium', '1斤中果（小果 约4-6个/斤）'),
  choice('count-2-medium', '2斤中果（小果 约4-6个/斤）'),
  choice('count-3-medium', '3斤中果（小果 约4-6个/斤）'),
  choice('count-2-large', '2斤大果（小果 约2-4个/斤）'),
  choice('count-3-large', '3斤大果（小果 约2-4个/斤）'),
]

test('the seven count-per-jin screenshot names match their unique real specification patterns', () => {
  const rows = [
    ['净重1斤小果【粉糯香甜真好吃】约6-9个/斤', 'count-1-small'],
    ['净重2斤小果【粉糯香甜真好吃】约6-9个/斤', 'count-2-small'],
    ['净重1斤中果【粉糯香甜真好吃】约4-6个/斤', 'count-1-medium'],
    ['净重2斤中果【粉糯香甜真好吃】约4-6个/斤', 'count-2-medium'],
    ['净重3斤中果【粉糯香甜真好吃】约4-6个/斤', 'count-3-medium'],
    ['净重2斤中大果【粉糯香甜真好吃】约2-4个/斤', 'count-2-large'],
    ['净重3斤中大果【粉糯香甜真好吃】约2-4个/斤', 'count-3-large'],
  ]
  const before = structuredClone(countedCosts)
  for (const [name, id] of rows) assert.equal(matchBatchSkuCost(name, countedCosts), id, name)
  assert.deepEqual(countedCosts, before)
})

test('count-per-jin keys normalize full-width text, count order, approximate labels and equivalent total units', () => {
  for (const name of ['净重２斤中果【粉糯香甜真好吃】约４～６颗／斤', '中果 每斤约4至6个 净重1公斤', '约4-6个/斤 净重1kg 中果', '净重2斤 中果(每斤4-6个)']) {
    assert.equal(matchBatchSkuCost(name, countedCosts), 'count-2-medium', name)
  }
})

test('count keys preserve weight, grade, exact interval and denominator conflicts without estimating gram weights', () => {
  for (const name of ['2斤中果约6-9个/斤', '2斤小果约4-6个/斤', '2斤中大果约4-6个/斤', '2斤中大果约2-5个/斤', '2斤特大果约2-4个/斤', '12斤中果约4-6个/斤', '0.5斤小果约6-9个/斤', '2斤中果约4-6个/公斤', '2斤中果约6-4个/斤', '2斤小果约0-9个/斤', '2斤中果', '中果约4-6个/斤', '2斤中果小果约4-6个/斤']) {
    assert.equal(matchBatchSkuCost(name, countedCosts), '', name)
  }
  assert.equal(matchBatchSkuCost('1斤小果约6-9个/斤', [choice('gram', '1斤小果60-100g')]), '')
  assert.equal(matchBatchSkuCost('2斤中大果100-150g', [choice('gram', '2斤大果100-150g')]), '')
})

test('equivalent count candidates remain ambiguous instead of picking by grade alias or order', () => {
  const duplicate = [...countedCosts, choice('alias', '2斤中大果（每斤2-4个）')]
  assert.equal(matchBatchSkuCost('净重2斤中大果约2-4个/斤', duplicate), '')
  assert.equal(matchBatchSkuCost('净重2斤中大果约2-4个/斤', duplicate.reverse()), '')
})

test('count keys preserve flavor and unknown descriptors while ignoring only recognized promotional wording', () => {
  const flavored = [choice('red', '2斤红心中果（每斤4-6个）'), choice('yellow', '2斤黄心中果（每斤4-6个）')]
  assert.equal(matchBatchSkuCost('净重2斤红心中果【粉糯香甜真好吃】约4-6个/斤', flavored), 'red')
  assert.equal(matchBatchSkuCost('净重2斤中果约4-6个/斤', flavored), '')
  assert.equal(matchBatchSkuCost('净重2斤红心中果约4-6个/斤', [flavored[1]]), '')
  assert.equal(matchBatchSkuCost('净重2斤中果【红心】约4-6个/斤', countedCosts), '')
})
