const assert = require('node:assert/strict'), { test } = require('node:test'), fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
const { readPerformanceBaselines } = require('../src/utils/performanceBaselineRead.ts')
const baseline = (index = 0) => ({ id: `snapshot-${index}`, storeId: 's', date: `2026-11-${String(index + 1).padStart(2, '0')}`, recordedAt: '2026-11-05T04:00:00Z', orderCount: 1, collectionProfit: 50, products: [{ productId: 'p', estimatedProfit: 48 }] })
const row = (index = 0) => ({ collection: 'a:profitBaselines', scope: '', record_key: JSON.stringify([index]), position: index, store_id: 's', body: baseline(index) })
const reader = pages => ({ head: async () => ({ mode: 'rows', revision: '12' }), collectionPage: async (name, after) => { assert.equal(name, 'a:profitBaselines'); return pages[after ? Number(JSON.parse(after[2])[0]) + 1 : 0] || [] } })

test('overview reads only the baseline collection with consistent revision, pagination, stored order, known zero and losses', async () => {
  const first = row(), second = row(1); second.body.products[0].estimatedProfit = 0
  first.body.collectionProfit = -1
  const requests = [], transport = reader({ 0: [first], 1: [second] })
  const read = transport.collectionPage
  transport.collectionPage = (name, after, signal) => { requests.push([name, after]); return read(name, after, signal) }
  assert.deepEqual(await readPerformanceBaselines(transport), [first.body, second.body])
  assert.deepEqual(requests.map(item => item[1]), [null, ['a:profitBaselines', '', '[0]'], ['a:profitBaselines', '', '[1]']])
  assert.deepEqual(await readPerformanceBaselines(reader({})), [])
})

test('a failed or inconsistent read is an error and cannot masquerade as no saved initial records', async () => {
  await assert.rejects(() => readPerformanceBaselines({ ...reader({}), collectionPage: async () => { throw new Error('offline') } }), /offline/)
  let heads = 0
  await assert.rejects(() => readPerformanceBaselines({ ...reader({ 0: [row()] }), head: async () => ({ mode: 'rows', revision: String(++heads) }) }), /有更新/)
  await assert.rejects(() => readPerformanceBaselines({ ...reader({}), head: async () => ({ mode: 'legacy', revision: '1' }) }), /不可用/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(() => readPerformanceBaselines(reader({}), controller.signal))
})

test('malformed, cross-scope, duplicate and incomplete pages are rejected rather than summed', async () => {
  const cases = [
    { ...row(), collection: 'ledger.funds' }, { ...row(), scope: 'other' }, { ...row(), store_id: 'wrong' },
    { ...row(), body: { ...baseline(), collectionProfit: null } }, { ...row(), body: { ...baseline(), products: [] } },
  ]
  for (const invalid of cases) await assert.rejects(() => readPerformanceBaselines(reader({ 0: [invalid] })), /不完整/)
  await assert.rejects(() => readPerformanceBaselines(reader({ 0: [row(), row()] })))
  const duplicate = row(1); duplicate.body.date = row().body.date
  await assert.rejects(() => readPerformanceBaselines(reader({ 0: [row(), duplicate] })), /重复/)
  await assert.rejects(() => readPerformanceBaselines(reader({ 0: [row(1)] })), /分页不完整/)
})

test('existing account-scoped database reader loads the new extension after startup without reading or writing ledgers', async () => {
  const h = require('./rowHarness.cjs'), db = await h.database()
  try {
    const data = { ...h.fixture(), profitBaselines: [baseline()] }
    await h.seed(db, data)
    await h.seed(db, { ...h.fixture(), profitBaselines: [{ ...baseline(), collectionProfit: 999 }] }, h.OTHER)
    const base = h.transport(db), calls = [], before = await base.head()
    const rows = await readPerformanceBaselines({ head: base.head, collectionPage: async (name, after, signal) => { calls.push(name); return base.collectionPage(name, after, signal) } })
    assert.deepEqual(rows, data.profitBaselines)
    assert.deepEqual(new Set(calls), new Set(['a:profitBaselines']))
    assert.deepEqual(await base.head(), before)
    assert.equal((await db.query('select count(*)::int as n from public.workbench_row_batches')).rows[0].n, 0)
    assert.deepEqual((await db.query('select data from public.workbench_documents where user_id=$1', [h.OWNER])).rows[0].data, data)
  } finally { await db.close() }
})
