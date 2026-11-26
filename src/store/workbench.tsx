import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Cloud, LoaderCircle, LockKeyhole, Mail } from 'lucide-react'
import type { Session } from '@supabase/supabase-js'
import { adoptWorkbenchReview, getWorkbenchPendingRequest, isSupabaseConfigured, loadWorkbenchSnapshot, readWorkbenchBatchReceipt, readWorkbenchForReview, saveWorkbench, supabase, type WorkbenchBatchReceipt, type WorkbenchReview } from '../services/supabase'
import type { WorkbenchData } from '../types/models'
import { isActiveProductLink } from '../utils/selectors'
import { acknowledgeWorkbenchDraft, readWorkbenchDraft, removeWorkbenchDraft, writeWorkbenchDraft } from '../services/workbenchDrafts'
import { createWorkbenchSync, describeSyncError, type PendingDraft, type SyncSession, type SyncState } from '../utils/workbenchSync'
import { inspectWorkbenchRecovery, isResolvedDraft, recoveryDifferences, sameStoredDocument } from '../utils/workbenchRecovery'
import { createWorkbenchReadBudget } from '../utils/workbenchReadBudget'

type SyncStatus = 'saved' | 'saving' | 'error'
interface WorkbenchContextValue {
  data: WorkbenchData
  update: (recipe: (current: WorkbenchData) => WorkbenchData) => void
  updateAsync: (recipe: (current: WorkbenchData) => WorkbenchData) => Promise<boolean>
  hydratingForWrite: boolean
  writeHydrationError: string
  writeHydrationPages: number
  userEmail: string
  signOut: () => Promise<void>
  syncStatus: SyncStatus
  syncSession: SyncSession
  syncError: string
  syncErrorDetail: string
  backupError: string
  cleanupError: string
  retrySync: () => void
  openSyncReview: () => void
  reviewBusy: boolean
  reviewIssue: string
  complete: boolean
  fullLoadError: string
  ensureFullData: () => Promise<boolean>
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null)
export const createId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [data, setData] = useState<WorkbenchData | null>(null)
  const [loadError, setLoadError] = useState('')
  const [syncState, setSyncState] = useState<SyncState>({ status: 'saved', session: 'idle', error: null, backupError: '' })
  const [recovery, setRecovery] = useState<PendingDraft<WorkbenchData> | null>(null)
  const [differences, setDifferences] = useState<ReturnType<typeof recoveryDifferences>>([])
  const [recoveryIssue, setRecoveryIssue] = useState('')
  const [syncReview, setSyncReview] = useState<{ cloud: WorkbenchReview; receipt: WorkbenchBatchReceipt | null; stale: boolean } | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewIssue, setReviewIssue] = useState('')
  const [resolving, setResolving] = useState(false)
  const [complete, setComplete] = useState(true)
  const [fullLoadError, setFullLoadError] = useState('')
  const [hydratingForWrite, setHydratingForWrite] = useState(false)
  const [writeHydrationError, setWriteHydrationError] = useState('')
  const [writeHydrationPages, setWriteHydrationPages] = useState(0)
  const [loadedOwner, setLoadedOwner] = useState('')
  const [cloudLoading, setCloudLoading] = useState(false)
  const [loadDetail, setLoadDetail] = useState('')
  const [loadPages, setLoadPages] = useState(0)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const completeRef = useRef(true)
  const hydrateRef = useRef<Promise<boolean> | null>(null)
  const writeBusyRef = useRef(false)
  const hydrateController = useRef<AbortController | null>(null)
  const reviewController = useRef<AbortController | null>(null)
  const ownerRef = useRef<string | undefined>(undefined)
  const loadController = useRef<AbortController | null>(null)
  const dataRef = useRef<WorkbenchData | null>(null)
  const syncRef = useRef<ReturnType<typeof createWorkbenchSync<WorkbenchData>> | null>(null)
  const userId = session?.user.id

  useEffect(() => {
    void supabase.auth.getSession().then(({ data: result }) => setSession(result.session))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => setSession(next))
    return () => listener.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    ownerRef.current = userId
    completeRef.current = false
    setComplete(false)
    setFullLoadError('')
    setHydratingForWrite(false); setWriteHydrationError(''); setWriteHydrationPages(0); writeBusyRef.current = false
    hydrateRef.current = null
    hydrateController.current?.abort()
    hydrateController.current = null
    if (!userId) { dataRef.current = null; setData(null); setRecovery(null); setLoadedOwner(''); return }
    let active = true
    dataRef.current = null
    setData(null)
    setRecovery(null)
    setLoadedOwner(userId)
    setCloudLoading(true)
    setLoadDetail('')
    setLoadPages(0)
    setDifferences([]); setRecoveryIssue(''); setResolving(false)
    setLoadError('')
    reviewController.current?.abort()
    reviewController.current = null
    setSyncReview(null); setReviewBusy(false); setReviewIssue('')
    setSyncState({ status: 'saved', session: 'idle', error: null, backupError: '' })
    const manager = createWorkbenchSync<WorkbenchData>({
      userId, save: (value, signal, onProgress) => saveWorkbench(userId, value, signal, onProgress),
      storage: { write: writeWorkbenchDraft, remove: removeWorkbenchDraft, acknowledge: acknowledgeWorkbenchDraft },
      notify: state => { if (active) setSyncState(state) },
    })
    syncRef.current = manager
    const controller = new AbortController()
    loadController.current = controller
    let timeout = setTimeout(() => controller.abort(new DOMException('云端读取超过 30000 ms', 'TimeoutError')), 30000)
    let fullReadBudget: ReturnType<typeof createWorkbenchReadBudget> | undefined
    const draftTask = readWorkbenchDraft(userId)
    void draftTask.then(local => {
      if (active && local && !isResolvedDraft(local)) setRecovery(local)
    }).catch(() => { if (active) setRecoveryIssue('本机备份读取失败，未清理备份。') })
    const load = async () => {
      const draft = await draftTask.then(value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason }))
      const local = draft.status === 'fulfilled' ? draft.value : null
      // A pending local draft is a complete snapshot. It must only be compared
      // with a complete cloud snapshot; the lightweight startup view is never
      // authoritative for recovery decisions.
      const profile = local && !isResolvedDraft(local) ? 'full' : 'startup'
      // Healthy large histories can need more than 120s. Continue while pages
      // arrive, with a 60s stall deadline and a finite 5-minute overall limit.
      if (profile === 'full') {
        clearTimeout(timeout)
        fullReadBudget = createWorkbenchReadBudget(controller)
      }
      const cloud = await loadWorkbenchSnapshot(userId, { signal: controller.signal, initialize: false, profile,
        onProgress: progress => { if (active && !controller.signal.aborted) { fullReadBudget?.progress(); setLoadPages(progress.pages) } },
      }).then(value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason }))
      clearTimeout(timeout)
      fullReadBudget?.dispose()
      if (!active) return
      setCloudLoading(false)
      if (cloud.status === 'fulfilled') {
        dataRef.current = cloud.value.data
        setData(cloud.value.data)
        completeRef.current = cloud.value.complete
        setComplete(cloud.value.complete)
        if (cloud.value.complete) {
          const inspection = inspectWorkbenchRecovery(local, cloud.value.storedData)
          if (inspection.action === 'recover' && local) { setDifferences(inspection.differences); setRecovery(local) }
          else { setRecovery(null); if (inspection.action === 'cleanup' && local) void manager.clearResolvedDraft(local.id, local.resolution || 'cloud-saved') }
        } else setRecovery(null)
      } else {
        if (local && !isResolvedDraft(local)) setRecovery(local)
        let failure = cloud.reason
        // Preserve the existing new-account behavior only when local storage
        // was read successfully and no local snapshot can be displaced.
        if (draft.status === 'fulfilled' && !local && cloud.reason?.code === 'WORKBENCH_NOT_FOUND') {
          timeout = setTimeout(() => controller.abort(new DOMException('云端初始化超过 30000 ms', 'TimeoutError')), 30000)
          try {
            const initial = await loadWorkbenchSnapshot(userId, { signal: controller.signal })
            if (active) { dataRef.current = initial.data; setData(initial.data); completeRef.current = true; setComplete(true) }
            return
          } catch (error) { failure = error }
          finally { clearTimeout(timeout) }
        }
        if (!active) return
        const reason = controller.signal.aborted ? controller.signal.reason : failure
        const diagnostic = describeSyncError(reason)
        const details = failure as { status?: number; stage?: string; elapsedMs?: number } | null
        setLoadError('无法读取云端数据。已有本机备份会保留，不会自动覆盖或清理。')
        setLoadDetail([diagnostic.detail, details?.status ? `HTTP ${details.status}` : '', details?.stage ? `阶段 ${details.stage}` : '', typeof details?.elapsedMs === 'number' ? `${details.elapsedMs} ms` : ''].filter(Boolean).join(' · '))
      }
    }
    void load()
    const online = () => manager.retry(false)
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const state = manager.getState()
      if (writeBusyRef.current || manager.hasPending() || state.backupError && ['conflict', 'unconfirmed'].includes(state.session)) {
        event.preventDefault(); event.returnValue = ''
      }
    }
    window.addEventListener('online', online)
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      active = false
      clearTimeout(timeout)
      fullReadBudget?.dispose()
      controller.abort()
      hydrateController.current?.abort()
      reviewController.current?.abort()
      if (loadController.current === controller) loadController.current = null
      manager.dispose()
      if (syncRef.current === manager) syncRef.current = null
      window.removeEventListener('online', online)
      window.removeEventListener('beforeunload', beforeUnload)
    }
  }, [userId, loadAttempt])

  const ensureFullData = useCallback((): Promise<boolean> => {
    if (completeRef.current) return Promise.resolve(true)
    if (!userId || ownerRef.current !== userId) return Promise.resolve(false)
    if (hydrateRef.current) return hydrateRef.current
    const controller = new AbortController()
    hydrateController.current = controller
    setFullLoadError('')
    const budget = createWorkbenchReadBudget(controller)
    const operation = loadWorkbenchSnapshot(userId, { signal: controller.signal, initialize: false, profile: 'full', onProgress: progress => { budget.progress(); setWriteHydrationPages(progress.pages) } }).then(snapshot => {
      if (ownerRef.current !== userId) return false
      dataRef.current = snapshot.data
      setData(snapshot.data)
      completeRef.current = true
      setComplete(true)
      return true
    }).catch(error => {
      if (ownerRef.current === userId) setFullLoadError(describeSyncError(controller.signal.aborted ? controller.signal.reason : error).detail)
      return false
    }).finally(() => {
      budget.dispose()
      if (hydrateController.current === controller) hydrateController.current = null
      if (hydrateRef.current === operation) hydrateRef.current = null
    })
    hydrateRef.current = operation
    return operation
  }, [userId])

  const applyUpdate = useCallback((recipe: (current: WorkbenchData) => WorkbenchData): boolean => {
    const current = dataRef.current
    if (!completeRef.current || ownerRef.current !== userId || !current || !syncRef.current) return false
    const next = recipe(current)
    if (next === current || sameStoredDocument(current, next)) return true
    dataRef.current = next
    setData(next)
    syncRef.current.enqueue(next)
    return true
  }, [userId])

  const updateAsync = useCallback(async (recipe: (current: WorkbenchData) => WorkbenchData): Promise<boolean> => {
    if (writeBusyRef.current) return false
    writeBusyRef.current = true
    setWriteHydrationError('')
    const needsHydration = !completeRef.current
    if (needsHydration) { setHydratingForWrite(true); setWriteHydrationPages(0) }
    try {
      if (needsHydration && !await ensureFullData()) {
        setWriteHydrationError('完整数据加载失败，表单内容已保留。请重试保存。')
        return false
      }
      return applyUpdate(recipe)
    } catch (error) {
      setWriteHydrationError(error instanceof Error ? error.message : '修改未完成，请重试。')
      return false
    } finally {
      writeBusyRef.current = false
      setHydratingForWrite(false)
    }
  }, [applyUpdate, ensureFullData])

  const update = useCallback((recipe: (current: WorkbenchData) => WorkbenchData) => {
    if (completeRef.current) { applyUpdate(recipe); return }
    // Preserve the user's action, but only apply it after a complete snapshot
    // has established the write baseline and local-backup semantics.
    void ensureFullData().then(ready => { if (ready) applyUpdate(recipe) })
  }, [applyUpdate, ensureFullData])

  const openSyncReview = useCallback(() => {
    if (!userId || ownerRef.current !== userId || reviewController.current) return
    const sessionState = syncRef.current?.getState().session
    if (!sessionState || !['conflict', 'capacity', 'unconfirmed'].includes(sessionState)) return
    const controller = new AbortController()
    reviewController.current = controller
    setReviewBusy(true); setReviewIssue(''); setSyncReview(null)
    void (async () => {
      let receipt: WorkbenchBatchReceipt | null = null
      if (sessionState === 'unconfirmed') {
        const request = await getWorkbenchPendingRequest(userId)
        if (!request) throw new Error('无法取得原请求 ID，结果仍未确认；请保留并导出本机备份。')
        receipt = await readWorkbenchBatchReceipt(userId, request.id, controller.signal)
        if (receipt.state !== 'missing' && (receipt.expectedRevision !== request.revision
          || receipt.fingerprint !== request.fingerprint || receipt.operationCount !== request.count)) {
          throw new Error('批次回执与原请求不一致，结果仍未确认；请保留本机备份。')
        }
      }
      const budget = createWorkbenchReadBudget(controller)
      try {
        const cloud = await readWorkbenchForReview(userId, controller.signal, budget.progress)
        if (ownerRef.current === userId && !controller.signal.aborted) setSyncReview({ cloud, receipt, stale: false })
      } finally { budget.dispose() }
    })().catch(error => {
      if (ownerRef.current === userId && !controller.signal.aborted) setReviewIssue(`只读核对未完成：${describeSyncError(error).detail}。原请求与本机修改仍保留。`)
    }).finally(() => {
      if (reviewController.current === controller) reviewController.current = null
      if (ownerRef.current === userId) setReviewBusy(false)
    })
  }, [userId])

  const keepReviewedCloud = useCallback(() => {
    if (!userId || !syncReview || syncReview.stale || resolving) return
    if (!window.confirm('保留云端会放弃本次本机修改并清理本机备份。请确认已核对差异并导出备份。确定保留云端吗？')) return
    setResolving(true); setReviewIssue('')
    void (async () => {
      await adoptWorkbenchReview(userId, syncReview.cloud, true)
      const manager = syncRef.current
      if (!manager) throw new Error('同步会话已结束')
      const cleared = await manager.keepCloud()
      dataRef.current = syncReview.cloud.data
      setData(syncReview.cloud.data); completeRef.current = true; setComplete(true)
      setSyncReview(null)
      if (!cleared) setReviewIssue('已保留云端，但本机备份清理未完成。请在同步提示中重试清理。')
    })().catch(error => {
      const item = error as { code?: string } | null
      if (item?.code === '40001') {
        setSyncReview(review => review && { ...review, stale: true })
        setReviewIssue('云端又有更新，尚未清理本机备份。请重新读取云端核对。')
      } else setReviewIssue(`保留云端未完成：${describeSyncError(error).detail}`)
    }).finally(() => setResolving(false))
  }, [userId, syncReview, resolving])

  const restoreReviewedLocal = useCallback(() => {
    if (!userId || !syncReview || syncReview.stale || resolving) return
    if (!window.confirm('将以当前本机修改建立新请求并同步云端。请确认已核对差异并导出备份。确定继续吗？')) return
    setResolving(true); setReviewIssue('')
    void (async () => {
      await adoptWorkbenchReview(userId, syncReview.cloud, true)
      if (!syncRef.current?.resumeFromReview()) throw new Error('原本机修改已不在同步会话中')
      setSyncReview(null)
    })().catch(error => {
      const item = error as { code?: string } | null
      if (item?.code === '40001') {
        setSyncReview(review => review && { ...review, stale: true })
        setReviewIssue('云端又有更新，尚未发出新写请求。请重新读取云端核对。')
      } else setReviewIssue(`恢复本机修改未开始：${describeSyncError(error).detail}`)
    }).finally(() => setResolving(false))
  }, [userId, syncReview, resolving])

  useEffect(() => {
    if (!data || loadedOwner !== userId) return
    const context = document.modelContext
    if (!context?.registerTool) return
    const lifecycle = new AbortController()
    const report = (error: unknown) => console.warn('WebMCP tool registration failed', error)
    void Promise.resolve(context.registerTool({
      name: 'read_workbench_summary',
      title: '查看运营概况',
      description: '读取当前云端工作台的甲方、店铺、商品链接和 SKU 数量。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => {
        const activeLinkIds = new Set(data.productLinks.filter(link => isActiveProductLink(data, link.id)).map(link => link.id))
        return { clients: data.clients.length, stores: data.stores.filter(store => store.storeStatus !== '暂停').length, productLinks: activeLinkIds.size, skus: data.skus.filter(sku => activeLinkIds.has(sku.productLinkId)).length }
      },
    }, { signal: lifecycle.signal })).catch(report)
    return () => lifecycle.abort()
  }, [data, loadedOwner, userId])

  if (!isSupabaseConfigured) return <SetupRequired />
  if (session === undefined) return <FullScreenLoading label="正在连接云端…" />
  if (!session) return <AuthScreen />
  if (loadedOwner !== userId) return <FullScreenLoading label="正在读取当前账号…" />
  if (recovery) return <div className="state-page"><Cloud size={30} /><strong>{data ? '本机备份与云端有内容差异' : cloudLoading ? '正在核对本机备份' : '暂时无法核对本机备份'}</strong><span>{new Date(recovery.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 的本机备份已保留。{data ? '仅检测到下列内容差异；尚未合并、删除或覆盖任何版本。' : cloudLoading ? '正在读取完整云端数据后再核对。' : '云端读取失败，无法比较差异；备份不会被修改。'}</span>
    {cloudLoading && <span role="status">{loadPages ? `已完成 ${loadPages} 页云端读取，正在继续核对…` : '正在连接云端并读取历史数据…'} 本机备份不会在读取期间被覆盖或清理。</span>}
    {differences.length > 0 && <ul className="recovery-differences" aria-label="本机与云端差异">{differences.map(item => <li key={item.key}><strong>{item.label}</strong><span>{item.localCount != null || item.cloudCount != null ? `本机 ${item.localCount ?? '未记录'} 条 / 云端 ${item.cloudCount ?? '未记录'} 条，内容不同` : '保存内容或字段不同'}</span></li>)}</ul>}
    {recoveryIssue && <p className="recovery-error" role="alert">{recoveryIssue}</p>}
    {loadDetail && <details><summary>查看读取错误详情</summary><pre>{loadDetail}</pre></details>}
    <div className="draft-recovery-actions"><button className="button secondary" onClick={() => downloadWorkbenchBackup(recovery.data)}>导出本机备份</button>{!data && !cloudLoading && <button className="button secondary" disabled={resolving} onClick={() => setLoadAttempt(attempt => attempt + 1)}>重新读取云端</button>}<button className="button secondary" disabled={resolving || cloudLoading || !data || !complete} onClick={() => { if (!window.confirm('恢复会用这份本机备份替换云端工作台内容。请确认已核对差异，建议先导出备份。确定恢复吗？')) return; const value = recovery.data; dataRef.current = value; setData(value); completeRef.current = true; setComplete(true); setLoadError(''); setRecovery(null); syncRef.current?.enqueue(value) }}>恢复本机修改并同步</button>{data && complete && <button className="button secondary" disabled={resolving} onClick={async () => { setResolving(true); setRecoveryIssue(''); const resolved = await syncRef.current?.clearResolvedDraft(recovery.id, 'kept-cloud'); if (resolved) setRecovery(null); else setRecoveryIssue('无法记录选择或清理本机备份，备份仍保留。请导出后重试，不会悄悄丢弃修改。'); setResolving(false) }}>{resolving ? '正在记录选择…' : '保留云端并清理本机备份'}</button>}</div></div>
  if (syncReview && data) {
    const changed = recoveryDifferences(data, syncReview.cloud.storedData)
    return <div className="state-page"><Cloud size={30} /><strong>核对本机修改与云端</strong>
      <span>云端版本 {syncReview.cloud.revision}。原写请求保持冻结；只读核对未更改写入基线或服务端批次。</span>
      {syncReview.receipt && <p role="status">原请求回执：{syncReview.receipt.state === 'committed' ? `已提交，版本 ${syncReview.receipt.resultRevision}` : syncReview.receipt.state === 'uncommitted' ? '存在未提交批次' : '批次不存在或已被清理'}。仍须以完整数据差异核对当前本机修改。</p>}
      {syncState.backupError && <p className="recovery-error" role="alert">{syncState.backupError}</p>}
      {changed.length ? <ul className="recovery-differences" aria-label="本机与云端差异">{changed.map(item => <li key={item.key}><strong>{item.label}</strong><span>{item.localCount != null || item.cloudCount != null ? `本机 ${item.localCount ?? '未记录'} 条 / 云端 ${item.cloudCount ?? '未记录'} 条，内容不同` : '保存内容或字段不同'}</span></li>)}</ul> : <p>本机修改与本次核对的云端快照内容一致。</p>}
      {reviewIssue && <p className="recovery-error" role="alert">{reviewIssue}</p>}
      <div className="draft-recovery-actions"><button className="button secondary" onClick={() => downloadWorkbenchBackup(dataRef.current || data)}>导出本机备份</button>
        <button className="button secondary" disabled={resolving || reviewBusy} onClick={openSyncReview}>重新读取云端核对</button>
        <button className="button secondary" disabled={resolving || syncReview.stale} onClick={keepReviewedCloud}>保留云端并清理本机备份</button>
        <button className="button secondary" disabled={resolving || syncReview.stale} onClick={restoreReviewedLocal}>用本机修改恢复</button>
        <button className="button secondary" disabled={resolving} onClick={() => setSyncReview(null)}>暂不决定</button></div></div>
  }
  if (loadError) return <><StateScreen title="无法读取云端数据" message={loadError} action="重新加载" onAction={() => window.location.reload()} />{loadDetail && <details><summary>查看读取错误详情</summary><pre>{loadDetail}</pre></details>}</>
  if (!data) return <FullScreenLoading label="正在同步工作台数据…" />

  const value: WorkbenchContextValue = {
    data,
    update,
    updateAsync,
    hydratingForWrite,
    writeHydrationError,
    writeHydrationPages,
    userEmail: session.user.email || '已登录',
    signOut: async () => { await supabase.auth.signOut() },
    syncStatus: syncState.status,
    syncSession: syncState.session,
    syncError: syncState.error?.message || '',
    syncErrorDetail: syncState.error?.detail || '',
    backupError: syncState.backupError,
    cleanupError: syncState.cleanupError || '',
    retrySync: () => syncRef.current?.retry(),
    openSyncReview,
    reviewBusy,
    reviewIssue,
    complete,
    fullLoadError,
    ensureFullData,
  }
  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>
}

export function downloadWorkbenchBackup(value: WorkbenchData) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `运营工作台未同步备份-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function AuthScreen() {
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const sendLink = async (event: FormEvent) => {
    event.preventDefault()
    setSending(true)
    setError('')
    const { error: authError } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } })
    setSending(false)
    if (authError) setError(authError.message); else setSent(true)
  }
  return <div className="auth-page"><section className="auth-card">
    <div className="auth-mark"><Cloud size={22} /></div><span className="eyebrow">ECOM OPS · CLOUD</span><h1>登录运营工作台</h1><p>使用同一邮箱登录 Windows 和 Mac，即可访问同一份经营数据。</p>
    {sent ? <div className="auth-success"><Mail size={22} /><strong>登录链接已发送</strong><span>请打开邮箱中的链接完成登录。</span><button className="text-button" onClick={() => setSent(false)}>更换邮箱</button></div> : <form onSubmit={sendLink}><label className="field"><span>邮箱地址</span><input type="email" required autoFocus value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" /></label>{error && <div className="form-error">{error}</div>}<button className="button primary auth-submit" disabled={sending}>{sending ? <LoaderCircle className="spin" size={17} /> : <LockKeyhole size={17} />}{sending ? '正在发送…' : '发送登录链接'}</button></form>}
    <div className="auth-foot"><LockKeyhole size={13} />数据仅对当前账号可见</div>
  </section></div>
}

function SetupRequired() { return <StateScreen title="等待连接 Supabase" message="请在部署环境中配置 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY。" /> }
function FullScreenLoading({ label }: { label: string }) { return <div className="state-page"><LoaderCircle className="spin" size={25} /><span>{label}</span></div> }
function StateScreen({ title, message, action, onAction }: { title: string; message: string; action?: string; onAction?: () => void }) { return <div className="state-page"><Cloud size={30} /><strong>{title}</strong><span>{message}</span>{action && <button className="button secondary" onClick={onAction}>{action}</button>}</div> }

export function useWorkbench() {
  const value = useContext(WorkbenchContext)
  if (!value) throw new Error('useWorkbench must be used inside WorkbenchProvider')
  return value
}
