const assert = require('node:assert/strict'), { test } = require('node:test'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript'), { createRequire } = require('node:module')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
const logic = require('../src/utils/storeBusinessReset.ts')
const source = path.resolve(__dirname, '../src/pages/StoreBusinessReset.tsx'), realRequire = createRequire(source)
const tick = () => new Promise(resolve => setImmediate(resolve))
function harness(storage = new Map()) {
  const state = [], refs = [], effects = []; let cursor = 0, refCursor = 0, effectCursor = 0, writes = 0, localWrites = 0, dirty = false
  let data = { clients: [{ id: 'c', name: '甲方' }], stores: [{ id: 'a', name: '甲店', clientId: 'c' }, { id: 'b', name: '乙店', clientId: 'c' }], products: [], productLinks: [], productCosts: [], skus: [], operations: [], skuHistory: [], todos: [], profitRecords: [], collectionRecords: [], orderAccountingLedgers: ['a','b'].map(storeId => ({ storeId, initializedDates: ['2026-10-01'], orders: [{ id: 'same-id', date: '2026-10-01', receipt: 100, quantity: 1, productId: 'p', unitCost: 20, supplement: false, cancelled: false }], refunds: [], funds: [], promotions: [] })) }
  let status = 'saved', account = 'qa@example.invalid', saveError = false, gate = null
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial; return [state[i], value => { const next = typeof value === 'function' ? value(state[i]) : value; if (next !== state[i]) dirty = true; state[i] = next }] },
    useMemo: compute => compute(), useRef(initial) { const i = refCursor++; return refs[i] ||= { current: initial } },
    useEffect(run, deps) { const i = effectCursor++, old = effects[i]; if (!old || deps.some((dep, j) => !Object.is(dep, old.deps[j]))) effects[i] = { deps, run, previous: old?.cleanup, pending: true } },
  }
  const exported = { exports: {} }
  const run = vm.runInThisContext(`(function(require,module,exports,window){${ts.transpileModule(fs.readFileSync(source,'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText}\n})`, { filename: source })
  run(name => name === 'react' ? hooks : name === 'react-router-dom' ? { Link: 'a', useSearchParams: () => [new URLSearchParams('store=a')] } : name === '../store/workbench' ? { useWorkbench: () => ({ data, userEmail: account, syncStatus: status, update(recipe) { data = recipe(data); writes++; dirty = true } }) } : name === '../utils/storeBusinessReset' ? logic : name === '../services/storeResetRecovery' ? {
    readStoreResetRecovery: async (user, store) => structuredClone(storage.get(JSON.stringify([user,store])) || null),
    writeStoreResetRecovery: async record => { localWrites++; if (gate) await gate; if (saveError) throw new Error('自动暂存失败，未清空数据。'); storage.set(JSON.stringify([record.backup.account,record.backup.store.id]), structuredClone(record)) },
  } : name.endsWith('.css') ? {} : realRequire(name), exported, exported.exports, { addEventListener() {}, removeEventListener() {} })
  const render = () => {
    let tree, passes = 0
    do { dirty = false; cursor = 0; refCursor = 0; effectCursor = 0; tree = exported.exports.StoreBusinessReset(); for (const effect of effects) if (effect.pending) { effect.pending = false; effect.previous?.(); effect.cleanup = effect.run() } } while (dirty && ++passes < 10)
    return tree
  }
  const nodes = root => { if (!root || typeof root !== 'object') return []; if (Array.isArray(root)) return root.flatMap(nodes); return [root, ...nodes(root.props?.children)] }
  const text = root => root == null || typeof root === 'boolean' ? '' : Array.isArray(root) ? root.map(text).join('') : typeof root === 'object' ? text(root.props?.children) : String(root)
  const find = (type, match = () => true) => nodes(render()).find(node => node.type === type && match(node))
  const button = label => find('button', node => text(node).includes(label))
  const confirm = (value = '甲店') => find('input', node => node.props.placeholder === '请输入店铺全名').props.onChange({ target: { value } })
  render()
  return { render, button, text, storage, confirm, get data() { return data }, get writes() { return writes }, get localWrites() { return localWrites }, setStatus(value) { status = value; render() }, setAccount(value) { account = value; render() }, failSave() { saveError = true }, holdSave() { let release; gate = new Promise(resolve => release = resolve); return release }, changeData(recipe) { data = recipe(data); render() }, async flush() { await tick(); render() }, reset() { find('form').props.onSubmit({ preventDefault() {} }) }, undo() { button('撤销本次清空')?.props.onClick() }, unmount() { effects.forEach(effect => effect.cleanup?.()) } }
}
test('no manual download or checkbox: exact store name triggers automatic snapshot before reset', async () => {
  const ui = harness(); await ui.flush()
  assert.equal(ui.button('下载'), undefined)
  assert.equal(ui.button('全部经营数据').props.disabled, true)
  ui.confirm('甲'); ui.reset(); await ui.flush(); assert.equal(ui.writes, 0)
  ui.confirm(); const other = ui.data.orderAccountingLedgers[1]
  assert.equal(ui.button('全部经营数据').props.disabled, false)
  ui.reset(); assert.equal(ui.writes, 0)
  await ui.flush()
  assert.equal(ui.localWrites, 1); assert.equal(ui.writes, 1); assert.equal(ui.data.orderAccountingLedgers[0], other)
  assert.equal(ui.data.orderAccountingLedgers.length, 1)
  assert.equal(ui.button('撤销本次清空').props.disabled, false)
})
test('failed or uncommitted temporary storage never clears business data; duplicate submit is ignored', async () => {
  const ui = harness(); await ui.flush(); ui.confirm(); ui.failSave(); ui.reset(); await ui.flush()
  assert.equal(ui.writes, 0); assert.equal(ui.data.orderAccountingLedgers.length, 2)
  assert.match(ui.text(ui.render()), /自动暂存失败/)
  const second = harness(); await second.flush(); second.confirm(); const release = second.holdSave()
  second.reset(); second.reset(); await second.flush(); assert.equal(second.writes, 0); assert.equal(second.localWrites, 1)
  release(); await second.flush(); assert.equal(second.writes, 1)
})
test('page refresh reloads same-account store snapshot and undo preserves original cost without overwriting new imports', async () => {
  const ui = harness(); await ui.flush(); ui.confirm(); ui.reset(); await ui.flush()
  const refreshed = harness(ui.storage); refreshed.changeData(() => structuredClone(ui.data)); await refreshed.flush()
  assert.equal(refreshed.button('撤销本次清空').props.disabled, false)
  refreshed.undo(); assert.equal(refreshed.data.orderAccountingLedgers.find(row => row.storeId === 'a').orders[0].unitCost, 20)
  assert.equal(refreshed.button('撤销本次清空').props.disabled, true)
  const newOrders = harness(ui.storage); await newOrders.flush(); assert.equal(newOrders.button('撤销本次清空').props.disabled, true)
  newOrders.undo(); assert.equal(newOrders.writes, 0)
})
test('synchronizing/errors and source edits during automatic persistence block clearing', async () => {
  for (const status of ['saving','error']) { const ui = harness(); await ui.flush(); ui.confirm(); ui.setStatus(status); assert.equal(ui.button('全部经营数据').props.disabled, true); ui.reset(); await ui.flush(); assert.equal(ui.writes, 0) }
  const ui = harness(); await ui.flush(); ui.confirm(); const release = ui.holdSave(); ui.reset(); ui.changeData(data => { const next = structuredClone(data); next.orderAccountingLedgers[0].orders[0].receipt = 77; return next }); release(); await ui.flush()
  assert.equal(ui.writes, 0); assert.equal(ui.data.orderAccountingLedgers[0].orders[0].receipt, 77); assert.match(ui.text(ui.render()), /暂存期间/)
})
test('navigation/unmount or account change while persisting cannot clear stale account data', async () => {
  for (const action of ['unmount','account']) { const ui = harness(); await ui.flush(); ui.confirm(); const release = ui.holdSave(); ui.reset(); if (action === 'unmount') ui.unmount(); else ui.setAccount('other@example.invalid'); release(); await tick(); assert.equal(ui.writes, 0) }
})
