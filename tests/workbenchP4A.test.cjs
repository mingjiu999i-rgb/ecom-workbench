const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
const between = (text, from, to) => {
  const start = text.indexOf(from), end = text.indexOf(to, start + from.length)
  assert(start >= 0 && end > start, `Could not locate ${from}`)
  return text.slice(start, end)
}
const compile = (code, jsx = false) => ts.transpileModule(code, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  jsx: jsx ? ts.JsxEmit.ReactJSX : undefined,
} }).outputText
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const textOf = node => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'object' ? textOf(node.props?.children) : String(node)
const nodes = node => node == null || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]

test('seven light routes open without full read; heavy and unknown routes require it', () => {
  const file = source('src/components/Layout.tsx')
  const code = between(file, 'export const lightRoutes', '\nconst items')
  const context = { exports: {} }
  vm.runInNewContext(compile(code + '\nexports.routeNeedsFullData = routeNeedsFullData'), context)
  for (const route of ['/', '/products', '/sku-drafts', '/product-costs', '/operations', '/refund-review', '/master-data']) assert.equal(context.exports.routeNeedsFullData(route), false, route)
  for (const route of ['/profit-preview', '/link-profit', '/store-business-reset', '/unknown']) assert.equal(context.exports.routeNeedsFullData(route), true, route)
})

test('incomplete overview never calculates pending ledger funds as zero', () => {
  const file = source('src/components/OverviewRefundActivity.tsx')
  const code = between(file, 'export function OverviewRefundMetric', '\nfunction StoreGroup')
  let pendingCalls = 0
  const context = { exports: {}, require, useWorkbench: () => ({ data: {}, complete: false }), useState: () => [true, () => {}], useEffect: () => {}, useMemo: fn => fn(),
    overviewDay: () => '2026-11-26', summarizeOverviewRefundTotals: () => ({ hasData: false, recordedDays: 0, clients: [] }),
    summarizePendingRefundFunds: () => { pendingCalls++; return { amount: 0, stores: [] } }, overviewRefundDetailClients: () => [],
    money: amount => amount == null ? '待核对' : `¥${amount.toFixed(2)}`, changeMoney: () => '待核对', time: () => '',
    RotateCcw: 'icon', Modal: 'modal', StoreGroup: 'group', window: { addEventListener() {}, removeEventListener() {} },
  }
  vm.runInNewContext(compile(code + '\nexports.render = OverviewRefundMetric', true), context)
  const output = textOf(context.exports.render({ storeIds: [], onViewOrder() {} }))
  assert.equal(pendingCalls, 0)
  assert.match(output, /退款资金待核对：未加载/)
  assert.match(output, /当前退款资金待核对：未加载 \/ 待核对/)
  assert.doesNotMatch(output, /¥0\.00/)
})

test('partial startup data cannot be exported as a full backup from the sync notice', () => {
  const file = source('src/components/SyncNotice.tsx')
  const code = between(file, 'export function SyncNotice', '\n}') + '\n}'
  let exported = 0
  const context = { exports: {}, require, useWorkbench: () => ({ data: {}, complete: false, syncStatus: 'error', syncSession: 'idle', syncError: '保存失败', syncErrorDetail: '', backupError: '', cleanupError: '', retrySync() {}, openSyncReview() {}, reviewBusy: false, reviewIssue: '' }),
    downloadWorkbenchBackup: () => { exported++ }, CloudAlert: 'icon', Download: 'icon', RefreshCw: 'icon' }
  vm.runInNewContext(compile(code + '\nexports.render = SyncNotice', true), context)
  const button = nodes(context.exports.render()).find(node => node.type === 'button' && textOf(node).includes('需加载完整数据后导出备份'))
  assert(button)
  assert.equal(button.props.disabled, true)
  button.props.onClick()
  assert.equal(exported, 0)
})

test('write waits for verified hydration, blocks duplicates, and keeps input on failed read', async () => {
  const file = source('src/store/workbench.tsx')
  const code = between(file, '  const updateAsync = useCallback(', '\n  const update = useCallback(')
  let resolveRead, applies = 0, error = '', busy = false
  const context = { exports: {}, useCallback: fn => fn, completeRef: { current: false }, writeBusyRef: { current: false },
    ensureFullData: () => new Promise(resolve => { resolveRead = resolve }), applyUpdate: () => { applies++; return true },
    setWriteHydrationError: value => { error = value }, setHydratingForWrite: value => { busy = value }, setWriteHydrationPages() {},
  }
  vm.runInNewContext(compile(code + '\nexports.updateAsync = updateAsync'), context)
  const first = context.exports.updateAsync(() => ({}))
  assert.equal(busy, true)
  assert.equal(await context.exports.updateAsync(() => ({})), false)
  assert.equal(applies, 0)
  resolveRead(false)
  assert.equal(await first, false)
  assert.equal(applies, 0)
  assert.match(error, /表单内容已保留/)
  assert.equal(busy, false)
  const retry = context.exports.updateAsync(() => ({}))
  resolveRead(true)
  assert.equal(await retry, true)
  assert.equal(applies, 1)
  assert.equal(error, '')
})

test('todo input stays filled until hydration and update succeed', async () => {
  const file = source('src/pages/Dashboard.tsx')
  const code = between(file, '  const addTodo = async () => {', '\n\n  return <div')
  let resolveWrite, title = '未保存待办'
  const context = { exports: {}, todoTitle: title, todoDate: '2026-11-26', todoClientId: '', todoStoreId: '', hydratingForWrite: false,
    updateAsync: () => new Promise(resolve => { resolveWrite = resolve }), setTodoTitle: value => { title = typeof value === 'function' ? value(title) : value }, createId: () => 'todo-1' }
  vm.runInNewContext(compile(code + '\nexports.addTodo = addTodo'), context)
  const attempt = context.exports.addTodo()
  assert.equal(title, '未保存待办')
  resolveWrite(false); await attempt
  assert.equal(title, '未保存待办')
  const retry = context.exports.addTodo()
  resolveWrite(true); await retry
  assert.equal(title, '')
})

test('client and store deletion confirms and cascades only inside the complete-snapshot recipe', async () => {
  const file = source('src/pages/MasterData.tsx')
  const code = between(file, '  const remove = async (id: string, label: string) => {', '\n\n  const title =')
  for (const tab of ['clients', 'stores']) {
    let resolveRead, confirms = 0, recipe
    const context = { exports: {}, tab, hydratingForWrite: false,
      updateAsync: fn => { recipe = fn; return new Promise(resolve => { resolveRead = resolve }) },
      window: { confirm: () => { confirms++; return true } },
    }
    vm.runInNewContext(compile(code + '\nexports.remove = remove'), context)
    const pending = context.exports.remove('target', '目标')
    assert.equal(confirms, 0)
    assert.equal(typeof recipe, 'function')
    const full = { clients: [{ id: 'target' }], stores: [{ id: 'target', clientId: 'target' }], products: [], productCosts: [], productLinks: [], skus: [], operations: [], skuHistory: [], profitRecords: [], collectionRecords: [], orderAccountingLedgers: [{ storeId: 'target' }] }
    const changed = recipe(full)
    assert.equal(confirms, 1)
    assert.equal(changed.orderAccountingLedgers.length, 0)
    resolveRead(true); await pending; await flush()
  }
})
