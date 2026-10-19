const assert = require('node:assert/strict'), { test } = require('node:test'), fs = require('node:fs'), ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
const { createStoreBusinessBackup } = require('../src/utils/storeBusinessReset.ts')
const { writeStoreResetRecovery, readStoreResetRecovery } = require('../src/services/storeResetRecovery.ts')
const record = (account = 'a@example.invalid', storeId = 'a', id = 'reset-1') => ({ id, backup: createStoreBusinessBackup({ stores: [{ id: storeId, name: '店铺', clientId: 'c' }], collectionRecords: [], profitRecords: [] }, storeId, account, '2026-10-19T01:00:00Z') })
function database() {
  const records = new Map(), pending = []
  const state = { hold: false, abort: false, unavailable: false, closes: 0 }
  global.indexedDB = { open() {
    if (state.unavailable) throw new Error('本机存储不可用')
    const request = { result: { objectStoreNames: { contains: () => true }, close() { state.closes++ }, transaction(_store, mode, options) {
      if (mode === 'readwrite') assert.equal(options.durability, 'strict')
      const transaction = { objectStore() { return {
        put(value) { const commit = () => { if (state.abort) transaction.onabort?.(); else { records.set(value.key, structuredClone(value)); transaction.oncomplete?.() } }; if (state.hold) pending.push(commit); else queueMicrotask(commit) },
        get(key) { const result = {}; queueMicrotask(() => { result.result = structuredClone(records.get(key)); result.onsuccess?.(); if (state.abort) transaction.onabort?.(); else transaction.oncomplete?.() }); return result },
      } } }; return transaction
    } } }
    queueMicrotask(() => request.onsuccess?.()); return request
  } }
  return { records, state, commit: () => pending.splice(0).forEach(run => run()) }
}
test('local recovery resolves only after transaction commit, survives new reads and replaces latest per store', async () => {
  const db = database(); db.state.hold = true; let done = false
  const saving = writeStoreResetRecovery(record()).then(() => done = true)
  await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false); assert.equal(db.records.size, 0)
  db.commit(); await saving; assert.equal(done, true)
  assert.equal((await readStoreResetRecovery('a@example.invalid','a')).id, 'reset-1')
  db.state.hold = false; await writeStoreResetRecovery(record('a@example.invalid','a','reset-2'))
  assert.equal(db.records.size, 1); assert.equal((await readStoreResetRecovery('a@example.invalid','a')).id, 'reset-2')
  assert.ok(db.state.closes >= 4)
})
test('recovery database isolates accounts and stores and rejects mismatched stored snapshots', async () => {
  const db = database(); await writeStoreResetRecovery(record()); await writeStoreResetRecovery(record('b@example.invalid','a','other'))
  assert.equal((await readStoreResetRecovery('a@example.invalid','a')).id, 'reset-1')
  assert.equal((await readStoreResetRecovery('b@example.invalid','a')).id, 'other')
  assert.equal(await readStoreResetRecovery('a@example.invalid','b'), null)
  db.records.set(JSON.stringify(['a@example.invalid','a']), record('b@example.invalid'))
  await assert.rejects(readStoreResetRecovery('a@example.invalid','a'), /当前账号或店铺/)
})
test('unavailable storage or aborted transaction rejects instead of reporting a saved snapshot', async () => {
  const db = database(); db.state.abort = true
  await assert.rejects(writeStoreResetRecovery(record()), /中断/); assert.equal(db.records.size, 0)
  await assert.rejects(readStoreResetRecovery('a@example.invalid','a'), /中断/)
  db.state.unavailable = true; await assert.rejects(writeStoreResetRecovery(record()), /不可用/)
})
