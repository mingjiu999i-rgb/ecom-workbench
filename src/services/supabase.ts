import { createClient } from '@supabase/supabase-js'
import { initialData } from '../data/template'
import type { WorkbenchData } from '../types/models'
import { normalizeCollectionRefunds } from '../utils/collectionRefunds'
import { buildWorkbenchPatch } from '../utils/workbenchPatch'
import { buildWorkbenchDelta } from '../utils/workbenchDelta'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)
export const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseAnonKey || 'placeholder-anon-key')
const cloneInitialData = (): WorkbenchData => JSON.parse(JSON.stringify(initialData)) as WorkbenchData
const storedSnapshots = new Map<string, WorkbenchData>()
const storedRevisions = new Map<string, string>()
const requestIds = new WeakMap<WorkbenchData, string>()
const accountWrites = new Map<string, Promise<void>>()
// This remains dormant until the approved database cutover and matching
// Vercel environment change. The legacy path is unchanged by default.
export const rowStorageEnabled = import.meta.env.VITE_WORKBENCH_STORAGE === 'rows-v1'
const rowStores = new Map<string, ReturnType<typeof import('./rowWorkbenchStore').createRowWorkbenchStore>>()
async function rowStore(userId: string) {
  let store = rowStores.get(userId)
  if (!store) {
    const { createRowWorkbenchStore, supabaseRowTransport } = await import('./rowWorkbenchStore')
    store = createRowWorkbenchStore(supabaseRowTransport(supabase, userId))
    rowStores.set(userId, store)
  }
  return store
}

const normalizeWorkbench = (value: WorkbenchData): WorkbenchData => {
  const hasProductCosts = Array.isArray(value.productCosts)
  const legacyCosts = hasProductCosts ? value.productCosts : []
  const products = (value.products || []).map(product => {
    const legacyCost = legacyCosts.find(cost => cost.productId === product.id) as (typeof legacyCosts[number] & { clientId?: string }) | undefined
    const link = (value.productLinks || []).find(item => item.productId === product.id)
    const defaultRate = product.name.includes('百香果') ? 0.025 : product.name.includes('薯片') || product.name.includes('土豆片') ? 0.03 : 0.02
    return { ...product, clientId: product.clientId || legacyCost?.clientId || link?.clientId || '', operationRate: Number.isFinite(product.operationRate) ? product.operationRate : defaultRate }
  })
  const productCosts = hasProductCosts
    ? legacyCosts.map(cost => ({ id: cost.id, productId: cost.productId || '', skuCode: cost.skuCode, specification: cost.specification, totalCost: cost.totalCost }))
    : (value.skus || []).map(sku => {
        const link = (value.productLinks || []).find(item => item.id === sku.productLinkId)
        return {
          id: `cost-${sku.id}`,
          productId: link?.productId || '',
          skuCode: sku.skuId,
          specification: sku.specification,
          totalCost: Number(sku.productCost || 0) + Number(sku.shippingCost || 0) + Number(sku.packagingCost || 0) + Number(sku.otherCost || 0),
        }
      })
  const skus = (value.skus || []).map(sku => {
    const link = (value.productLinks || []).find(item => item.id === sku.productLinkId)
    const linkedCost = productCosts.find(cost => cost.id === sku.productCostId)
      || productCosts.find(cost => cost.productId === link?.productId && cost.skuCode === sku.skuId)
    return {
      ...sku,
      finalPrice: Number(sku.salePrice || 0),
      activityPrice: Number(sku.activityPrice || 0),
      productCostId: linkedCost?.id || '',
      productCost: linkedCost?.totalCost ?? sku.productCost,
      shippingCost: linkedCost ? 0 : sku.shippingCost,
      packagingCost: linkedCost ? 0 : sku.packagingCost,
      otherCost: linkedCost ? 0 : sku.otherCost,
    }
  })
  const stores = (value.stores || []).map(store => ({ ...store, storeStatus: store.storeStatus || '启用' as const }))
  const productLinks = (value.productLinks || []).map(link => ({ ...link, status: link.status || '日销' as const }))
  const collectionRecords = normalizeCollectionRefunds(value.collectionRecords || [])
  return { ...value, stores, products, productCosts, productLinks, skus, skuHistory: value.skuHistory || [], todos: value.todos || [], profitRecords: value.profitRecords || [], collectionRecords }
}

export type WorkbenchLoadProfile = 'startup' | 'full'
export async function loadWorkbenchSnapshot(userId: string, options: { signal?: AbortSignal; initialize?: boolean; profile?: WorkbenchLoadProfile } = {}): Promise<{ data: WorkbenchData; storedData: WorkbenchData; complete: boolean }> {
  if (rowStorageEnabled) {
    const profile = options.profile || 'full'
    const storedData = await (await rowStore(userId)).load({ signal: options.signal, profile, concurrency: 4 }) as unknown as WorkbenchData
    return { data: normalizeWorkbench(storedData), storedData, complete: profile === 'full' }
  }
  const started = performance.now()
  const request = supabase.from('workbench_documents').select('data, updated_at').eq('user_id', userId)
  const { data, error, status } = await (options.signal ? request.abortSignal(options.signal) : request).maybeSingle()
  options.signal?.throwIfAborted()
  if (error) throw Object.assign(error, { status, stage: 'query', elapsedMs: Math.round(performance.now() - started) })
  if (data?.data) {
    const storedData = data.data as WorkbenchData
    storedSnapshots.set(userId, storedData)
    if (typeof data.updated_at === 'string') storedRevisions.set(userId, data.updated_at)
    else storedRevisions.delete(userId)
    try { return { data: normalizeWorkbench(storedData), storedData, complete: true } }
    catch { throw { code: 'WORKBENCH_FORMAT', status, stage: 'normalize', elapsedMs: Math.round(performance.now() - started), message: '云端请求成功，但保存数据结构无法按当前版本加载。原始数据未修改。' } }
  }
  if (options.initialize === false) throw { code: 'WORKBENCH_NOT_FOUND', status, stage: 'query', message: '未读到当前账号的云端文档。未创建或覆盖任何数据。' }
  const initial = cloneInitialData()
  await saveWorkbench(userId, initial, options.signal)
  return { data: initial, storedData: initial, complete: true }
}

export async function loadWorkbench(userId: string): Promise<WorkbenchData> {
  return (await loadWorkbenchSnapshot(userId)).data
}

export async function saveWorkbench(userId: string, data: WorkbenchData, signal?: AbortSignal): Promise<void> {
  const previousWrite = accountWrites.get(userId) || Promise.resolve()
  const write = previousWrite.catch(() => {}).then(() => {
    signal?.throwIfAborted()
    return persistWorkbench(userId, data, signal)
  })
  accountWrites.set(userId, write)
  try { await write } finally { if (accountWrites.get(userId) === write) accountWrites.delete(userId) }
}

async function persistWorkbench(userId: string, data: WorkbenchData, signal?: AbortSignal): Promise<void> {
  if (rowStorageEnabled) { await (await rowStore(userId)).save(data, signal); return }
  let previous = storedSnapshots.get(userId)
  if (!previous) {
    // Recovery after a failed initial read must establish a cloud baseline;
    // it must never turn an existing 26 MB document into a blind full upsert.
    const request = supabase.from('workbench_documents').select('data, updated_at').eq('user_id', userId)
    const { data: document, error } = await (signal ? request.abortSignal(signal) : request).maybeSingle()
    if (error) throw error
    if (document?.data) {
      previous = document.data as WorkbenchData
      storedSnapshots.set(userId, previous)
      if (typeof document.updated_at === 'string') storedRevisions.set(userId, document.updated_at)
    }
  }
  if (previous) {
    const revision = storedRevisions.get(userId)
    if (revision) {
      const delta = buildWorkbenchDelta(previous, data)
      if (!delta) return
      let requestId = requestIds.get(data)
      if (!requestId) { requestId = crypto.randomUUID(); requestIds.set(data, requestId) }
      const request = supabase.rpc('save_workbench_delta', { p_delta: delta, p_expected_updated_at: revision, p_request_id: requestId })
      const { data: acknowledgement, error } = await (signal ? request.abortSignal(signal) : request)
      if (!error) {
        const savedAt = acknowledgement && typeof acknowledgement === 'object' && 'updated_at' in acknowledgement ? acknowledgement.updated_at : null
        if (typeof savedAt !== 'string') throw new Error('Cloud save acknowledgement missing revision')
        storedSnapshots.set(userId, data)
        storedRevisions.set(userId, savedAt)
        return
      }
      if (error.code !== 'PGRST202') throw error
    }
    const patch = buildWorkbenchPatch(previous, data)
    if (!patch.changed) return
    const request = supabase.rpc('save_workbench_patch', { p_updates: patch.updates, p_remove: patch.removed })
    const { data: acknowledgement, error } = await (signal ? request.abortSignal(signal) : request)
    if (!error) {
      storedSnapshots.set(userId, data)
      if (acknowledgement && typeof acknowledgement.updated_at === 'string') storedRevisions.set(userId, acknowledgement.updated_at)
      else storedRevisions.delete(userId)
      return
    }
    // During staged rollout, only a missing RPC may use the legacy save path.
    // A real database error must remain visible and keep the previous baseline.
    if (error.code !== 'PGRST202') throw error
  }
  const savedAt = new Date().toISOString()
  const request = supabase.from('workbench_documents').upsert({ user_id: userId, data, updated_at: savedAt }, { onConflict: 'user_id' })
  const { error } = await (signal ? request.abortSignal(signal) : request)
  if (error) throw error
  storedSnapshots.set(userId, data)
  storedRevisions.set(userId, savedAt)
}
