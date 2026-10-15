const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
const { sameStoredDocument: same, recoveryDifferences: differences, inspectWorkbenchRecovery: inspect } = require('../src/utils/workbenchRecovery.ts')
const { createWorkbenchSync } = require('../src/utils/workbenchSync.ts')
const until = async predicate => { for (let n = 0; n < 200; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) } assert.fail('State did not settle') }
const pending = data => ({ id: 'draft1', userId: 'owner', updatedAt: '2026-10-15T01:00:00Z', data })

test('recursive object key order does not trigger recovery and no payload is rewritten', () => {
  const local = { skus: [{ id: 'a', cost: 4, extra: { b: 2, a: 1 } }], clients: [], collectionRecords: [] }
  const cloud = { collectionRecords: [], clients: [], skus: [{ extra: { a: 1, b: 2 }, cost: 4, id: 'a' }] }
  const before = JSON.stringify(local)
  assert.notEqual(before, JSON.stringify(cloud))
  assert.equal(same(local, cloud), true)
  assert.equal(inspect(pending(local), cloud).action, 'cleanup')
  assert.equal(JSON.stringify(local), before)
})
test('actual financial values, null versus zero, absent versus zero and array order still require a choice', () => {
  for (const [a, b] of [[{ cost: 4 }, { cost: 5 }], [{ cost: null }, { cost: 0 }], [{}, { cost: 0 }], [[1, 2], [2, 1]], [{ refund: 180 }, { refund: 0 }]]) {
    assert.equal(same(a, b), false)
    assert.equal(inspect(pending(a), b).action, 'recover')
  }
})
test('JSON serialization omissions are not mistaken for content changes', () => {
  assert.equal(same({ a: undefined, b: 1 }, { b: 1 }), true)
  assert.equal(same([undefined], [null]), true)
  assert.equal(same([NaN, Infinity], [null, null]), true)
  assert.equal(same(Array(1), [9]), false)
  assert.equal(same({ x: null }, {}), false)
})
test('no draft and confirmed resolutions never prompt restoration of stale data', () => {
  assert.equal(inspect(null, { value: 2 }).action, 'none')
  for (const resolution of ['cloud-saved', 'kept-cloud']) assert.equal(inspect({ ...pending({ value: 1 }), resolution }, { value: 9 }).action, 'cleanup')
  assert.equal(inspect({ ...pending({ value: 1 }), resolution: 'unrecognized' }, { value: 9 }).action, 'recover')
})
test('differences report actual changed sections and record counts without inventing money or dates', () => {
  const result = differences({ clients: [], collectionRecords: [{ shippedRefund: null }], orderAccountingLedgers: [] }, { clients: [], collectionRecords: [{ shippedRefund: 0 }], orderAccountingLedgers: [{ orders: [] }] })
  assert.deepEqual(result.map(row => [row.label, row.localCount, row.cloudCount]), [['经营结算汇总', 1, 1], ['订单结算账本', 0, 1]])
})

function serviceFixture(raw) {
  const writes = []
  const initial = { clients: [], stores: [], products: [], productCosts: [], productLinks: [], skus: [], collectionRecords: [] }
  const client = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: raw == null ? null : { data: raw }, error: null }) }) }), upsert: value => { writes.push(value); return Promise.resolve({ error: null }) } }) }
  const source = fs.readFileSync(require.resolve('../src/services/supabase.ts'), 'utf8').replace(/import\.meta\.env/g, '({})')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const result = { exports: {} }
  const dependency = name => name === '@supabase/supabase-js' ? { createClient: () => client } : name === '../data/template' ? { initialData: initial } : name === '../utils/collectionRefunds' ? require('../src/utils/collectionRefunds.ts') : require(name)
  new Function('require', 'module', 'exports', output)(dependency, result, result.exports)
  return { service: result.exports, writes }
}
test('cloud raw snapshot is compared before existing load normalization, without changing normalization or financial data', async () => {
  const raw = { clients: [], stores: [{ id: 's' }], products: [{ id: 'p', name: '示例产品' }], productCosts: [], productLinks: [], skus: [], collectionRecords: [] }
  const before = JSON.stringify(raw), { service, writes } = serviceFixture(raw)
  const snapshot = await service.loadWorkbenchSnapshot('owner')
  assert.equal(snapshot.storedData, raw)
  assert.equal(same(snapshot.data, raw), false)
  assert.equal(inspect(pending(JSON.parse(before)), snapshot.storedData).action, 'cleanup')
  assert.equal(snapshot.data.stores[0].storeStatus, '启用')
  assert.equal((await service.loadWorkbench('owner')).stores[0].storeStatus, '启用')
  assert.equal(JSON.stringify(raw), before)
  assert.equal(writes.length, 0)
})
test('existing refund normalization remains unchanged, raw genuine refund differences cannot be hidden by it', async () => {
  const raw = { clients: [], stores: [], products: [], productCosts: [], productLinks: [], skus: [], collectionRecords: [{ id: 'r', refundBasis: 'refund_completed_at', shippedRefund: 11, orderShippedRefund: 30, orderCount: 1 }] }
  const { service } = serviceFixture(raw)
  const snapshot = await service.loadWorkbenchSnapshot('owner')
  assert.equal(snapshot.data.collectionRecords[0].shippedRefund, 30)
  assert.equal(snapshot.storedData.collectionRecords[0].shippedRefund, 11)
  const changed = structuredClone(raw); changed.collectionRecords[0].shippedRefund = 15
  assert.equal(inspect(pending(changed), snapshot.storedData).action, 'recover')
})
test('new account initialization keeps the pre-existing initial save behavior', async () => {
  const { service, writes } = serviceFixture(null)
  const snapshot = await service.loadWorkbenchSnapshot('owner')
  assert.equal(snapshot.data, snapshot.storedData)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].data, snapshot.storedData)
})

test('confirmed cloud save stamps the exact draft before cleanup and preserves payload references', async () => {
  const events = [], value = { orderAccountingLedgers: [{ orders: [{ unitCost: 4 }] }], collectionRecords: [{ shippedRefund: 180 }] }
  let local
  const manager = createWorkbenchSync({ userId: 'owner', debounceMs: 0, save: async received => { assert.equal(received, value); events.push('cloud') }, storage: {
    write: async draft => { local = draft }, acknowledge: async (user, id, resolution) => { assert.equal(local.id, id); local = { ...local, resolution }; events.push('receipt') }, remove: async () => { events.push('remove'); local = null },
  }, notify: () => {} })
  manager.enqueue(value)
  await until(() => manager.getState().status === 'saved')
  assert.deepEqual(events, ['cloud', 'receipt', 'remove'])
  assert.equal(local, null)
  manager.dispose()
})
test('cleanup failure stays visible, retains confirmed receipt and retries cleanup without another cloud write', async () => {
  let local, fail = true, saves = 0
  const manager = createWorkbenchSync({ userId: 'owner', debounceMs: 0, save: async () => { saves++ }, storage: {
    write: async draft => { local = draft }, acknowledge: async (_, id, resolution) => { if (local?.id === id) local = { ...local, resolution } }, remove: async () => { if (fail) throw new Error('blocked'); local = null },
  }, notify: () => {} })
  manager.enqueue({ value: 1 })
  await until(() => manager.getState().status === 'saved')
  assert.equal(manager.hasPending(), false)
  assert.match(manager.getState().cleanupError, /清理未完成/)
  assert.equal(local.resolution, 'cloud-saved')
  assert.equal(inspect(local, { value: 2 }).action, 'cleanup')
  fail = false; manager.retry()
  await until(() => manager.getState().cleanupError === '')
  assert.equal(saves, 1)
  assert.equal(local, null)
  manager.dispose()
})
test('unacknowledged failed cloud save never marks or clears the recoverable local draft', async () => {
  let local, receipts = 0, removals = 0
  const manager = createWorkbenchSync({ userId: 'owner', debounceMs: 0, retryDelays: [], save: async () => { throw { code: '42501', message: 'permission denied' } }, storage: {
    write: async draft => { local = draft }, acknowledge: async () => { receipts++ }, remove: async () => { removals++ },
  }, notify: () => {} })
  manager.enqueue({ value: 1 })
  await until(() => manager.getState().status === 'error')
  assert.equal(local.resolution, undefined)
  assert.equal(receipts, 0)
  assert.equal(removals, 0)
  assert.equal(inspect(local, { value: 2 }).action, 'recover')
  manager.dispose()
})
test('explicit keep-cloud choice records its own resolution without uploading local data', async () => {
  let local = pending({ value: 1 }), saves = 0
  const manager = createWorkbenchSync({ userId: 'owner', save: async () => { saves++ }, storage: {
    write: async () => {}, acknowledge: async (_, id, resolution) => { if (local.id === id) local = { ...local, resolution } }, remove: async () => { throw new Error('blocked') },
  }, notify: () => {} })
  assert.equal(await manager.clearResolvedDraft(local.id, 'kept-cloud'), true)
  assert.equal(local.resolution, 'kept-cloud')
  assert.equal(saves, 0)
  assert.equal(inspect(local, { value: 999 }).action, 'cleanup')
  manager.dispose()
})
test('failure of both receipt recording and removal is not treated as a recorded choice', async () => {
  const manager = createWorkbenchSync({ userId: 'owner', save: async () => {}, storage: { write: async () => {}, acknowledge: async () => { throw Error('blocked') }, remove: async () => { throw Error('blocked') } }, notify: () => {} })
  assert.equal(await manager.clearResolvedDraft('draft1', 'kept-cloud'), false)
  assert.match(manager.getState().cleanupError, /仍保留/)
  manager.dispose()
})
test('stale receipt/removal IDs cannot mark or delete a newer pending backup', async () => {
  let local = pending({ value: 2 }); local.id = 'newer'
  const manager = createWorkbenchSync({ userId: 'owner', save: async () => {}, storage: {
    write: async () => {}, acknowledge: async (_, id, resolution) => { if (local?.id === id) local = { ...local, resolution } }, remove: async (_, id) => { if (local?.id === id) local = null },
  }, notify: () => {} })
  await manager.clearResolvedDraft('older')
  assert.equal(local.id, 'newer')
  assert.equal(local.resolution, undefined)
  manager.dispose()
})
