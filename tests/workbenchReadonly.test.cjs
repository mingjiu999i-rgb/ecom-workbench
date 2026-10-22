const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript')
const { createRequire } = require('node:module')
const React = require('react'), { create, act } = require('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
require.extensions['.css'] = () => {}
const { createWorkbenchSync } = require('../src/utils/workbenchSync.ts')
const { readonlyDraftIssue, readonlyRows, storedValue } = require('../src/utils/readonlyWorkbench.ts')
const fixtureData = () => ({ clients: [{ id: 'c', name: '甲方' }], stores: [{ id: 's', name: '测试店', clientId: 'c' }], products: [], productLinks: [], skus: [{ id: 'sku', name: 'SKU', productCost: null }], productCosts: [], todos: [], operations: [], skuHistory: [], collectionRecords: [{ id: 'r', storeId: 's', date: '2026-10-21', profit: null, currentNet: 0 }], profitRecords: [{ id: 'p', amount: 1.23456 }], orderAccountingLedgers: [{ storeId: 's', orders: [{ id: 'order', unitCost: null, receipt: 0 }], refunds: [{ id: 'refund', orderId: 'order', amount: 12.34 }], funds: [{ key: 'flow', income: 0, expense: 3 }], promotions: [{ date: '2026-10-21', amount: 4 }] }] })
const draftFor = data => ({ id: 'durable-draft', userId: 'owner', updatedAt: '2026-10-22T04:10:53Z', data })
const textOf = node => typeof node === 'string' ? node : (node?.children || []).map(textOf).join('')
const allText = renderer => textOf(renderer.toJSON())
const click = async (renderer, name) => {
  const button = renderer.root.findAllByType('button').find(node => textOf(node) === name)
  assert.ok(button, `Missing button ${name}`)
  assert.notEqual(button.props.disabled, true)
  await act(async () => { button.props.onClick() })
}

function setup({ draft = draftFor(fixtureData()), cloud = async () => { throw { status: 500, code: 'PGRST002', message: 'connection unavailable', stage: 'query', elapsedMs: 61 } } } = {}) {
  const events = [], target = new EventTarget()
  global.window = target
  window.location = { reload: () => events.push('reload') }
  window.confirm = () => { throw new Error('Must not prompt for a read-only view') }
  global.document = {}
  let authListener, mountedBusiness = 0, latestContext
  const localRequire = createRequire(path.resolve('src/store/workbench.tsx'))
  const dependency = name => {
    if (name === '../services/supabase') return {
      isSupabaseConfigured: true,
      supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: 'owner', email: 'test@example.invalid' } } } }), onAuthStateChange: listener => { authListener = listener; return { data: { subscription: { unsubscribe() {} } } } }, signOut: async () => {} } },
      loadWorkbenchSnapshot: async (userId, options) => { events.push(['load', userId, options]); return cloud(userId, options) },
      saveWorkbench: async () => { events.push('save') },
    }
    if (name === '../services/workbenchDrafts') return {
      readWorkbenchDraft: async () => draft,
      writeWorkbenchDraft: async () => events.push('write'),
      acknowledgeWorkbenchDraft: async () => events.push('acknowledge'), removeWorkbenchDraft: async () => events.push('remove'),
    }
    if (name === '../utils/workbenchSync') return {
      ...localRequire(name), createWorkbenchSync: options => {
        const manager = createWorkbenchSync(options), enqueue = manager.enqueue
        manager.enqueue = value => { events.push('enqueue'); enqueue(value) }
        return manager
      },
    }
    return localRequire(name)
  }
  const filename = path.resolve('src/store/workbench.tsx')
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(dependency, module, module.exports)
  function Business() {
    latestContext = module.exports.useWorkbench()
    React.useEffect(() => { mountedBusiness++; latestContext.update(current => { events.push('business-recipe'); return { ...current } }) }, [])
    return React.createElement('p', null, 'normal business')
  }
  const App = () => React.createElement(module.exports.WorkbenchProvider, null, React.createElement(Business))
  let renderer
  return {
    events, draft, App, get renderer() { return renderer }, get businessMounts() { return mountedBusiness },
    get context() { return latestContext },
    async mount() { await act(async () => { renderer = create(React.createElement(App)) }) },
    async unmount() { await act(async () => renderer.unmount()) },
    async switchAccount(id) { await act(async () => { authListener('SIGNED_IN', { user: { id, email: 'other@example.invalid' } }) }) },
  }
}
const noWrites = instance => assert.deepEqual(instance.events.filter(event => typeof event === 'string' && ['save', 'write', 'acknowledge', 'remove', 'enqueue', 'business-recipe'].includes(event)), [])

test('successful cloud read with real differences allows viewing local data without choosing either destructive resolution', async () => {
  const cloudData = fixtureData(); cloudData.collectionRecords = []
  const instance = setup({ cloud: async () => ({ data: cloudData, storedData: cloudData }) }), before = JSON.stringify(instance.draft)
  await instance.mount()
  assert.match(allText(instance.renderer), /本机备份与云端有内容差异/)
  await click(instance.renderer, '只读查看本机数据')
  assert.match(allText(instance.renderer), /离线只读/)
  assert.match(allText(instance.renderer), /尚未与云端核对/)
  assert.equal(instance.businessMounts, 0)
  assert.equal(JSON.stringify(instance.draft), before)
  noWrites(instance)
  await instance.unmount()
})

test('query failure exposes evidence and local reader still makes no writes after navigation, filtering and online events', async () => {
  const instance = setup(), before = JSON.stringify(instance.draft)
  await instance.mount()
  assert.match(allText(instance.renderer), /HTTP 500/)
  assert.match(allText(instance.renderer), /PGRST002/)
  await click(instance.renderer, '只读查看本机数据')
  await click(instance.renderer, '订单明细')
  assert.match(allText(instance.renderer), /order/)
  await click(instance.renderer, '资金流水')
  assert.match(allText(instance.renderer), /flow/)
  const filter = instance.renderer.root.findAllByType('select').find(node => node.props['aria-label'] === '只读筛选店铺')
  await act(async () => { filter.props.onChange({ target: { value: 's' } }); window.dispatchEvent(new Event('online')) })
  await click(instance.renderer, '详情')
  assert.match(allText(instance.renderer), /"expense": 3/)
  assert.equal(JSON.stringify(instance.draft), before)
  noWrites(instance)
  await instance.unmount()
})

test('local reader is available before a hung cloud request finishes; late matching cloud result cannot clean or replace the backup', async () => {
  let finish, signal
  const instance = setup({ cloud: (_, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve }) } }), before = JSON.stringify(instance.draft)
  await instance.mount()
  assert.match(allText(instance.renderer), /正在核对本机备份/)
  await click(instance.renderer, '只读查看本机数据')
  assert.equal(signal.aborted, true)
  await act(async () => finish({ data: instance.draft.data, storedData: instance.draft.data }))
  assert.match(allText(instance.renderer), /离线只读/)
  assert.equal(instance.businessMounts, 0)
  assert.equal(JSON.stringify(instance.draft), before)
  noWrites(instance)
  await instance.unmount()
})

test('refresh repeats the same preserved pending draft, not a resolved or rewritten version', async () => {
  const instance = setup(), before = JSON.stringify(instance.draft)
  await instance.mount(); await click(instance.renderer, '只读查看本机数据'); await instance.unmount()
  await instance.mount()
  assert.match(allText(instance.renderer), /本机备份已保留/)
  await click(instance.renderer, '只读查看本机数据')
  assert.equal(JSON.stringify(instance.draft), before)
  noWrites(instance)
  await instance.unmount()
})

test('mismatched account draft cannot be opened and switching accounts removes the old reader', async () => {
  const instance = setup()
  await instance.mount(); await click(instance.renderer, '只读查看本机数据')
  await instance.switchAccount('other')
  assert.doesNotMatch(allText(instance.renderer), /运营工作台 · 本机数据只读查看/)
  await click(instance.renderer, '只读查看本机数据')
  assert.match(allText(instance.renderer), /备份所属账号与当前账号不一致/)
  assert.equal(instance.businessMounts, 0)
  noWrites(instance)
  await instance.unmount()
})

test('a pending backup plus zero cloud rows never initializes an empty document', async () => {
  const instance = setup({ cloud: async () => { throw { code: 'WORKBENCH_NOT_FOUND', status: 200 } } })
  await instance.mount()
  assert.equal(instance.events.filter(event => Array.isArray(event) && event[0] === 'load').length, 1)
  await click(instance.renderer, '只读查看本机数据')
  noWrites(instance)
  await instance.unmount()
})

test('invalid snapshot never opens a partial reader or normalizes financial values to zero', async () => {
  const draft = draftFor(fixtureData()); draft.data.orderAccountingLedgers[0].refunds = null
  const instance = setup({ draft })
  await instance.mount(); await click(instance.renderer, '只读查看本机数据')
  assert.match(allText(instance.renderer), /账本明细结构不兼容/)
  assert.doesNotMatch(allText(instance.renderer), /运营工作台 · 本机数据只读查看/)
  noWrites(instance)
  await instance.unmount()
})

test('startup read timeout retains a useful read error and the original local snapshot', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const instance = setup({ cloud: (_, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })) }), before = JSON.stringify(instance.draft)
  await instance.mount()
  await act(async () => { context.mock.timers.tick(30000) })
  assert.match(allText(instance.renderer), /30000 ms/)
  await click(instance.renderer, '只读查看本机数据')
  assert.equal(JSON.stringify(instance.draft), before)
  noWrites(instance)
  await instance.unmount()
})

test('healthy cloud with no draft still enters the original business application', async () => {
  const data = fixtureData(), instance = setup({ draft: null, cloud: async () => ({ data, storedData: data }) })
  await instance.mount()
  assert.match(allText(instance.renderer), /normal business/)
  assert.equal(instance.businessMounts, 1)
  assert.equal(instance.context.data, data)
  assert.equal(instance.events.includes('save'), false)
  await instance.unmount()
})

test('401 and 403 stay visible without being relabeled as database timeouts', async () => {
  for (const status of [401, 403]) {
    const instance = setup({ cloud: async () => { throw { status, message: 'permission rejected', stage: 'query' } } })
    await instance.mount()
    assert.match(allText(instance.renderer), new RegExp(`HTTP ${status}`))
    assert.doesNotMatch(allText(instance.renderer), /数据库超时/)
    noWrites(instance)
    await instance.unmount()
  }
})

function realService(result) {
  const writes = []
  const request = { eq: () => request, abortSignal: () => request, maybeSingle: async () => result }
  const client = { from: () => ({ select: () => request, upsert: value => { writes.push(value); return Promise.resolve({ error: null }) } }), rpc: () => { writes.push('rpc'); return Promise.resolve({ error: null }) } }
  const filename = path.resolve('src/services/supabase.ts'), localRequire = createRequire(filename)
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8').replace(/import\.meta\.env/g, '({})'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(name => name === '@supabase/supabase-js' ? { createClient: () => client } : localRequire(name), module, module.exports)
  return { service: module.exports, writes }
}

test('real pure loader never initializes or invokes an RPC when the query returns zero rows', async () => {
  const { service, writes } = realService({ data: null, error: null, status: 200 })
  await assert.rejects(service.loadWorkbenchSnapshot('owner', { initialize: false }), error => error.code === 'WORKBENCH_NOT_FOUND' && error.status === 200)
  assert.deepEqual(writes, [])
})

test('real loader distinguishes query rejection from HTTP 200 followed by frontend normalization failure', async () => {
  const query = realService({ data: null, error: { code: '57014', message: 'statement timeout' }, status: 500 })
  await assert.rejects(query.service.loadWorkbenchSnapshot('owner', { initialize: false }), error => error.code === '57014' && error.status === 500 && error.stage === 'query' && typeof error.elapsedMs === 'number')
  const malformed = { ...fixtureData(), products: [null] }, before = JSON.stringify(malformed)
  const format = realService({ data: { data: malformed }, error: null, status: 200 })
  await assert.rejects(format.service.loadWorkbenchSnapshot('owner', { initialize: false }), error => error.code === 'WORKBENCH_FORMAT' && error.status === 200 && error.stage === 'normalize')
  assert.deepEqual(query.writes, []); assert.deepEqual(format.writes, [])
  assert.equal(JSON.stringify(malformed), before)
})

test('aborted pure loader cannot return a late cloud result or create initial data', async () => {
  const controller = new AbortController(); controller.abort(new DOMException('cancelled', 'AbortError'))
  const { service, writes } = realService({ data: null, error: null, status: 200 })
  await assert.rejects(service.loadWorkbenchSnapshot('owner', { initialize: false, signal: controller.signal }), { name: 'AbortError' })
  assert.deepEqual(writes, [])
})

test('read-only codec preserves null versus zero, precision, array order and unrecorded dates', () => {
  const data = fixtureData(), before = JSON.stringify(data)
  assert.equal(readonlyDraftIssue(draftFor(data), 'owner'), '')
  assert.equal(readonlyRows(data, 'orders')[0].value, data.orderAccountingLedgers[0].orders[0])
  assert.equal(readonlyRows(data, 'refunds')[0].value.date, undefined)
  assert.equal(storedValue(null), '未记录（null）')
  assert.equal(storedValue(undefined), '未记录')
  assert.equal(storedValue(0), '0')
  assert.equal(storedValue(1.23456), '1.23456')
  assert.equal(JSON.stringify(data), before)
})
