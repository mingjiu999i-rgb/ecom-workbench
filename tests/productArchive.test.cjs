const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
const { setProductArchived, isProductArchived, productOptions, isOperationalProductLink } = require('../src/utils/productArchive.ts')
const { isActiveProductLink } = require('../src/utils/selectors.ts')
const { preparePddAccounting } = require('../src/utils/pddLedger.ts')
const { createSettlementWorkbook } = require('../src/utils/settlementWorkbook.ts')
const { summarizePerformance } = require('../src/utils/performanceSummary.ts')
const { encodeWorkbenchRows, decodeWorkbenchRows, diffWorkbenchRows } = require('../src/services/workbenchRows.ts')

function fixture() {
  const products = [{ id: 'p', clientId: 'c', name: '停做产品', operationRate: 0.02, remark: '保留备注', extension: { original: true } }, { id: 'other', clientId: 'c', name: '其他产品', operationRate: 0.03, remark: '' }]
  const input = { storeId: 's', shop: '店铺', orders: [{ id: 'order', payDate: '2026-10-01', payTime: '2026-10-01', receipt: 100, status: '已发货', productId: 'goods', product: '停做产品', specification: '一件', skuCode: 'SKU', quantity: 1 }], refunds: [], funds: [{ key: 'credit', orderId: 'order', income: 100, expense: 0, businessCode: '0010002', category: 'positive' }], promotions: [{ key: 'promo', date: '2026-10-01', amount: 20 }], products, resolveCost: () => ({ cost: 30, productId: 'p' }), linkedProductId: () => 'p', reportTypes: new Set(['orders', 'funds', 'promotions']), savedRecords: [], savedProfits: [] }
  const result = preparePddAccounting(input)
  const data = { clients: [{ id: 'c', name: '甲方', remark: '' }], stores: [{ id: 's', clientId: 'c', name: '店铺', platform: '拼多多', storeStatus: '启用' }], products,
    productCosts: [{ id: 'cost', productId: 'p', skuCode: 'SKU', specification: '一件', totalCost: 30 }],
    productLinks: [{ id: 'link', clientId: 'c', storeId: 's', productId: 'p', linkId: 'goods', status: '日销', url: '', remark: '' }],
    skus: [{ id: 'sku', productLinkId: 'link', productCostId: 'cost', name: '原SKU', salePrice: 100, productCost: 30 }], operations: [{ id: 'op', productId: 'p', skuId: 'sku', after: '30' }], skuHistory: [{ id: 'history', skuId: 'sku', name: '旧名称', salePrice: 80 }], todos: [],
    collectionRecords: result.summaries.map(({ shop, ...row }) => ({ ...row, id: row.date, storeId: 's', refundBasis: 'order_paid_at', updatedAt: '' })),
    profitRecords: result.productMetrics.map(({ rate, ...row }) => ({ ...row, id: row.date + row.productId, storeId: 's', operationRate: rate, updatedAt: '' })), orderAccountingLedgers: [result.ledger],
    skuPlanningDrafts: [{ id: 'draft', productId: 'p', name: '历史草稿' }], unknownExtension: { amount: null, retained: [0, '原值'] } }
  return { data, input }
}

test('archive/restore only changes the product flag, preserving every financial object, relation, ID and unknown field', () => {
  const { data } = fixture(), snapshot = structuredClone(data)
  const archived = setProductArchived(data, 'p', true)
  assert.equal(archived.products[0].archived, true)
  assert.equal(archived.products[1], data.products[1])
  for (const key of Object.keys(data).filter(key => key !== 'products')) assert.equal(archived[key], data[key], key)
  assert.deepEqual(data, snapshot)
  const restored = setProductArchived(archived, 'p', false)
  assert.deepEqual(restored, data)
  assert.equal(Object.hasOwn(restored.products[0], 'archived'), false)
  assert.equal(setProductArchived(data, 'missing', true), data)
  assert.equal(setProductArchived(data, 'p', false), data)
  assert.equal(setProductArchived(archived, 'p', true), archived)
})

test('old products stay available, archived products disappear only from operational choices, retained edit choices remain', () => {
  const { data } = fixture(), archived = setProductArchived(data, 'p', true)
  assert.equal(isProductArchived(data.products[0]), false)
  assert.deepEqual(productOptions(data).map(row => row.id), ['p', 'other'])
  assert.deepEqual(productOptions(archived).map(row => row.id), ['other'])
  assert.deepEqual(productOptions(archived, 'p').map(row => row.id), ['p', 'other'])
  assert.equal(isOperationalProductLink(data, 'link'), true)
  assert.equal(isOperationalProductLink(archived, 'link'), false)
  assert.equal(isActiveProductLink(archived, 'link'), true, 'shared store/sync selector must retain its original meaning')
  assert.equal(isOperationalProductLink(setProductArchived(archived, 'p', false), 'link'), true)
})

test('existing row codec persists the flag losslessly and sync only changes one product body, without deletion or ledger writes', () => {
  const { data } = fixture(), archived = setProductArchived(data, 'p', true)
  const before = encodeWorkbenchRows(data), after = encodeWorkbenchRows(archived)
  const changes = diffWorkbenchRows(before, after)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].collection, 'a:products')
  assert.equal(changes[0].row.body.archived, true)
  assert.deepEqual(JSON.parse(JSON.stringify(decodeWorkbenchRows(after))), archived)
  const restored = setProductArchived(decodeWorkbenchRows(after), 'p', false)
  assert.deepEqual(restored, data)
  assert.equal(diffWorkbenchRows(after, encodeWorkbenchRows(restored)).length, 1)
})

test('historical overview and every settlement worksheet are identical after archiving and restoring', () => {
  const { data } = fixture()
  const summary = summarizePerformance(data, '2026-10-01', '2026-10-31', new Set(['s']))
  for (const updated of [setProductArchived(data, 'p', true), setProductArchived(setProductArchived(data, 'p', true), 'p', false)]) {
    assert.deepEqual(summarizePerformance(updated, '2026-10-01', '2026-10-31', new Set(['s'])), summary)
    for (const options of [{ clientId: 'c' }, { clientId: 'c', startDate: '2026-10-01', endDate: '2026-10-01' }]) {
      const before = createSettlementWorkbook(data, options), after = createSettlementWorkbook(updated, options)
      assert.deepEqual(after.SheetNames, before.SheetNames)
      assert.deepEqual(after.Sheets, before.Sheets)
    }
  }
})

test('late refunds on an archived product use the same original order date, frozen cost, promotion and operation fee', () => {
  const { data, input } = fixture(), archived = setProductArchived(data, 'p', true)
  const refresh = products => preparePddAccounting({ ...input, products, orders: [], funds: [{ key: 'refund-fund', orderId: 'order', income: 0, expense: -30, businessCode: '0020002', category: 'refund' }], promotions: [], reportTypes: new Set(['refunds', 'funds']),
    previous: structuredClone(data.orderAccountingLedgers[0]), savedRecords: data.collectionRecords, savedProfits: data.profitRecords,
    resolveCost: () => ({ cost: 999, productId: 'p' }), refunds: [{ id: 'refund', orderId: 'order', status: '退款成功', stage: '已发货', refundAmount: 30, refundDate: '2026-11-04' }] })
  const before = refresh(data.products), after = refresh(archived.products)
  assert.deepEqual(after, before)
  assert.equal(after.ledger.orders[0].unitCost, 30)
  assert.equal(after.summaries[0].date, '2026-10-01')
  assert.equal(after.summaries[0].productCost, 30)
  assert.equal(after.productMetrics[0].amount, 70)
  assert.equal(after.productMetrics[0].promotion, 20)
  assert.equal(after.productMetrics[0].operationFee, 1.4)
})
