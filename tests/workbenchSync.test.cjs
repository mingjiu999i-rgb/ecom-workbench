const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  module._compile(output.outputText, filename)
}
const { createWorkbenchSync, describeSyncError } = require('../src/utils/workbenchSync.ts')
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const until = async predicate => { for (let n = 0; n < 200; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) } assert.fail('Sync state did not settle') }
const flushPromises = async () => { for (let n = 0; n < 30; n++) await Promise.resolve() }
function setup(save, overrides = {}) {
  const states = [], writes = [], removed = []
  const manager = createWorkbenchSync({
    userId: 'owner', save, debounceMs: 0, retryDelays: [0, 0], timeoutMs: 1000,
    storage: { write: async value => { writes.push(value) }, remove: async (user, id) => { removed.push([user, id]) } },
    notify: state => states.push(state), ...overrides,
  })
  return { manager, states, writes, removed }
}

test('transport failure retries and only marks saved after successful acknowledgement', async () => {
  let calls = 0
  const { manager, writes } = setup(async () => { if (++calls < 3) throw new TypeError('Failed to fetch') })
  manager.enqueue({ value: 1 })
  assert.equal(manager.getState().status, 'saving')
  await until(() => manager.getState().status === 'saved')
  assert.equal(calls, 3)
  assert.equal(writes.length, 1)
  assert.equal(manager.hasPending(), false)
  manager.dispose()
})

test('permanent errors retain the latest draft and support manual retry without an extra edit', async () => {
  let reject = true, calls = 0
  const { manager, writes } = setup(async value => { calls++; assert.equal(value.value, 7); if (reject) throw { code: '42501', message: 'row-level security policy' } })
  manager.enqueue({ value: 7 })
  await until(() => manager.getState().status === 'error')
  assert.equal(calls, 1)
  assert.equal(manager.hasPending(), true)
  assert.equal(writes[0].data.value, 7)
  reject = false
  manager.retry()
  await until(() => manager.getState().status === 'saved')
  assert.equal(calls, 2)
  manager.dispose()
})

test('rapid edits are coalesced, old in-flight success cannot acknowledge newer unsaved data', async () => {
  const first = deferred(), second = deferred(), payloads = []
  const { manager } = setup(async value => { payloads.push(value); await (payloads.length === 1 ? first.promise : second.promise) })
  manager.enqueue({ value: 1 })
  await until(() => payloads.length === 1)
  manager.enqueue({ value: 2 })
  manager.enqueue({ value: 3 })
  first.resolve()
  await until(() => payloads.length === 2)
  assert.deepEqual(payloads, [{ value: 1 }, { value: 3 }])
  assert.equal(manager.getState().status, 'saving')
  assert.equal(manager.hasPending(), true)
  second.resolve()
  await until(() => manager.getState().status === 'saved')
  manager.dispose()
})

test('an older failed request does not block a newer pending edit', async () => {
  const first = deferred(), payloads = []
  const { manager } = setup(async value => { payloads.push(value); if (payloads.length === 1) await first.promise })
  manager.enqueue({ value: 1 })
  await until(() => payloads.length === 1)
  manager.enqueue({ value: 2 })
  first.reject({ code: '42501', message: 'permission denied' })
  await until(() => manager.getState().status === 'saved')
  assert.deepEqual(payloads, [{ value: 1 }, { value: 2 }])
  manager.dispose()
})

test('failed local backup does not block cloud save, and is reported if cloud save also fails', async () => {
  let fail = true
  const { manager } = setup(async () => { if (fail) throw { code: '42501', message: 'permission denied' } }, { storage: { write: async () => { throw new Error('IndexedDB unavailable') }, remove: async () => {} } })
  manager.enqueue({ value: 1 })
  await until(() => manager.getState().status === 'error')
  assert.ok(manager.getState().backupError.includes('备份不可用'))
  fail = false
  manager.retry()
  await until(() => manager.getState().status === 'saved')
  manager.dispose()
})

test('disposing aborts an active request without clearing its recoverable draft', async () => {
  let signal
  const { manager, removed, writes } = setup(async (_, supplied) => { signal = supplied; await new Promise((resolve, reject) => supplied.addEventListener('abort', () => reject(new Error('aborted')))) })
  manager.enqueue({ value: 9 })
  await until(() => signal != null)
  manager.dispose()
  assert.equal(signal.aborted, true)
  assert.equal(writes.length, 1)
  assert.equal(removed.length, 0)
})

test('plain Supabase error objects produce visible actionable messages and codes', () => {
  assert.equal(describeSyncError({ code: '42501', message: 'permission denied' }).retryable, false)
  assert.match(describeSyncError({ code: '42501', message: 'permission denied' }).detail, /42501/)
  assert.match(describeSyncError({ code: 'PGRST301', message: 'JWT expired' }).message, /登录状态/)
  assert.equal(describeSyncError({ code: '57014', message: 'statement timeout' }).retryable, true)
  assert.match(describeSyncError({ status: 413, message: 'Request too large' }).message, /接收限制/)
})

test('the sync layer passes complete financial data through by reference with no calculation or rewriting', async () => {
  const value = { clients: [{ id: 'a' }], orderAccountingLedgers: [{ orders: [{ unitCost: 23 }], refunds: [{ amount: 30 }] }], collectionRecords: [{ date: '2026-09-30', shippedRefund: 130 }], overviewRefundActivity: { version: 1, changes: [] } }
  const original = JSON.stringify(value)
  const { manager } = setup(async received => { assert.equal(received, value); assert.equal(JSON.stringify(received), original) })
  manager.enqueue(value)
  await until(() => manager.getState().status === 'saved')
  assert.equal(JSON.stringify(value), original)
  manager.dispose()
})

test('a slow local backup cannot expire the cloud request before it starts', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const backup = deferred(), saved = deferred()
  let signal
  const { manager } = setup(async (_, supplied) => { signal = supplied; await saved.promise }, {
    timeoutMs: 20,
    storage: { write: () => backup.promise, remove: async () => {} },
  })
  context.after(() => manager.dispose())
  manager.enqueue({ value: 1 })
  context.mock.timers.tick(0)
  await flushPromises()
  context.mock.timers.tick(25)
  assert.equal(signal, undefined)
  backup.resolve()
  await flushPromises()
  assert.equal(signal.aborted, false)
  saved.resolve()
  await flushPromises()
  assert.equal(manager.getState().status, 'saved')
})

test('disposing during local backup never starts a cloud write afterward', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const backup = deferred()
  let calls = 0
  const { manager, removed } = setup(async () => { calls++ }, {
    storage: { write: () => backup.promise, remove: async () => {} },
  })
  manager.enqueue({ value: 1 })
  context.mock.timers.tick(0)
  await flushPromises()
  manager.dispose()
  backup.resolve()
  await flushPromises()
  assert.equal(calls, 0)
  assert.equal(removed.length, 0)
  assert.equal(manager.hasPending(), true)
})

test('a healthy save taking over 30 seconds completes without aborting or resending', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const saved = deferred()
  let calls = 0, signal
  const { manager } = setup(async (_, supplied) => { calls++; signal = supplied; await saved.promise }, { timeoutMs: undefined })
  context.after(() => manager.dispose())
  manager.enqueue({ value: 1 })
  context.mock.timers.tick(0)
  await flushPromises()
  context.mock.timers.tick(35000)
  assert.equal(signal.aborted, false)
  assert.equal(manager.hasPending(), true)
  assert.equal(manager.getState().status, 'saving')
  saved.resolve()
  await flushPromises()
  assert.equal(manager.getState().status, 'saved')
  assert.equal(calls, 1)
})

test('a real request timeout has a useful reason and retains the draft for manual retry', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let signal, fail = true
  const { manager, removed } = setup(async (_, supplied) => {
    signal = supplied
    // PostgREST wraps fetch aborts in a plain object instead of preserving the
    // DOMException. Diagnostics must still retain our own timeout reason.
    if (fail) await new Promise((_, reject) => supplied.addEventListener('abort', () => reject({ message: 'AbortError: signal is aborted without reason' }), { once: true }))
  }, { timeoutMs: 20, retryDelays: [] })
  context.after(() => manager.dispose())
  manager.enqueue({ value: 1 })
  context.mock.timers.tick(0)
  await flushPromises()
  context.mock.timers.tick(20)
  await flushPromises()
  assert.equal(signal.reason.name, 'TimeoutError')
  assert.match(manager.getState().error.detail, /20 ms/)
  assert.equal(manager.getState().status, 'error')
  assert.equal(manager.hasPending(), true)
  assert.equal(removed.length, 0)
  fail = false
  manager.retry()
  context.mock.timers.tick(0)
  await flushPromises()
  assert.equal(manager.getState().status, 'saved')
})

test('an external abort is retryable but is not reported as a known timeout', () => {
  const failure = describeSyncError({ message: 'AbortError: signal is aborted without reason' })
  assert.equal(failure.retryable, true)
  assert.match(failure.message, /中断/)
  assert.doesNotMatch(failure.message, /超时/)
})

test('PostgREST connection errors are transient while missing functions and version conflicts remain distinct', () => {
  for (const code of ['PGRST000', 'PGRST001', 'PGRST002', 'PGRST003']) {
    const failure = describeSyncError({ code, message: 'Could not query the database for the schema cache. Retrying.' })
    assert.equal(failure.retryable, true)
    assert.equal(failure.reconnecting, true)
    assert.match(failure.detail, new RegExp(code))
    assert.match(failure.message, /数据库连接/)
  }
  for (const code of ['PGRST202', '40001', '42501', 'PGRST301']) {
    const failure = describeSyncError({ code, message: 'Cloud request rejected' })
    assert.equal(failure.retryable, false)
    assert.notEqual(failure.reconnecting, true)
  }
  for (const error of [new TypeError('Failed to fetch'), { status: 503, message: 'Service unavailable' }, { message: 'upstream connect error, delayed connect error: 111' }]) {
    const failure = describeSyncError(error)
    assert.equal(failure.retryable, true)
    assert.equal(failure.reconnecting, true)
  }
  assert.notEqual(describeSyncError({ code: '57014', message: 'statement timeout' }).reconnecting, true)
})

test('schema-cache recovery after ten seconds automatically saves the same draft only after acknowledgement', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const value = { todos: [{ id: 'todo', title: 'unsaved edit' }], orderAccountingLedgers: [{ orders: [{ unitCost: 23 }], refunds: [{ amount: 30 }] }] }
  const before = JSON.stringify(value)
  const { manager, writes, removed } = setup(async received => {
    calls++
    assert.equal(received, value)
    assert.equal(JSON.stringify(received), before)
    if (calls === 3) throw new TypeError('Failed to fetch')
    if (calls < 4) throw { code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.' }
  }, { retryDelays: undefined })
  context.after(() => manager.dispose())
  manager.enqueue(value)
  context.mock.timers.tick(0); await flushPromises()
  for (const delay of [1000, 3000]) { context.mock.timers.tick(delay); await flushPromises() }
  assert.equal(calls, 3)
  assert.equal(manager.getState().status, 'saving')
  assert.equal(manager.hasPending(), true)
  assert.equal(removed.length, 0)
  context.mock.timers.tick(9999); await flushPromises()
  assert.equal(calls, 3)
  context.mock.timers.tick(1); await flushPromises()
  assert.equal(calls, 4)
  assert.equal(manager.getState().status, 'saved')
  assert.equal(manager.hasPending(), false)
  assert.equal(writes.length, 1)
  assert.equal(removed.length, 1)
})

test('persistent schema connection failure stops after bounded backoff and retains the local backup', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const { manager, removed } = setup(async () => { calls++; throw { code: 'PGRST002', message: 'schema cache unavailable' } }, { retryDelays: undefined })
  context.after(() => manager.dispose())
  manager.enqueue({ value: 1 })
  context.mock.timers.tick(0); await flushPromises()
  for (const delay of [1000, 3000, 10000, 30000, 60000]) { context.mock.timers.tick(delay); await flushPromises() }
  assert.equal(calls, 6)
  assert.equal(manager.getState().status, 'error')
  assert.equal(manager.hasPending(), true)
  assert.equal(removed.length, 0)
  context.mock.timers.tick(120000); await flushPromises()
  assert.equal(calls, 6)
})
