import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Cloud, LoaderCircle, LockKeyhole, Mail } from 'lucide-react'
import type { Session } from '@supabase/supabase-js'
import { isSupabaseConfigured, loadWorkbenchSnapshot, saveWorkbench, supabase } from '../services/supabase'
import type { WorkbenchData } from '../types/models'
import { isActiveProductLink } from '../utils/selectors'
import { acknowledgeWorkbenchDraft, readWorkbenchDraft, removeWorkbenchDraft, writeWorkbenchDraft } from '../services/workbenchDrafts'
import { createWorkbenchSync, describeSyncError, type PendingDraft, type SyncState } from '../utils/workbenchSync'
import { inspectWorkbenchRecovery, isResolvedDraft, sameStoredDocument, type recoveryDifferences } from '../utils/workbenchRecovery'
import { readonlyDraftIssue } from '../utils/readonlyWorkbench'
import { ReadonlyWorkbench } from '../components/ReadonlyWorkbench'

type SyncStatus = 'saved' | 'saving' | 'error'
interface WorkbenchContextValue {
  data: WorkbenchData
  update: (recipe: (current: WorkbenchData) => WorkbenchData) => void
  userEmail: string
  signOut: () => Promise<void>
  syncStatus: SyncStatus
  syncError: string
  syncErrorDetail: string
  backupError: string
  cleanupError: string
  retrySync: () => void
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null)
export const createId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [data, setData] = useState<WorkbenchData | null>(null)
  const [loadError, setLoadError] = useState('')
  const [syncState, setSyncState] = useState<SyncState>({ status: 'saved', error: null, backupError: '' })
  const [recovery, setRecovery] = useState<PendingDraft<WorkbenchData> | null>(null)
  const [differences, setDifferences] = useState<ReturnType<typeof recoveryDifferences>>([])
  const [recoveryIssue, setRecoveryIssue] = useState('')
  const [resolving, setResolving] = useState(false)
  const [readonlyDraft, setReadonlyDraft] = useState<PendingDraft<WorkbenchData> | null>(null)
  const [loadedOwner, setLoadedOwner] = useState('')
  const [cloudLoading, setCloudLoading] = useState(false)
  const [loadDetail, setLoadDetail] = useState('')
  const readonlyRef = useRef(false)
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
    readonlyRef.current = false
    setReadonlyDraft(null)
    if (!userId) { dataRef.current = null; setData(null); setRecovery(null); setLoadedOwner(''); return }
    let active = true
    dataRef.current = null
    setData(null)
    setRecovery(null)
    setLoadedOwner(userId)
    setCloudLoading(true)
    setLoadDetail('')
    setDifferences([]); setRecoveryIssue(''); setResolving(false)
    setLoadError('')
    setSyncState({ status: 'saved', error: null, backupError: '' })
    const manager = createWorkbenchSync<WorkbenchData>({
      userId, save: (value, signal) => saveWorkbench(userId, value, signal),
      storage: { write: writeWorkbenchDraft, remove: removeWorkbenchDraft, acknowledge: acknowledgeWorkbenchDraft },
      notify: state => { if (active && !readonlyRef.current) setSyncState(state) },
    })
    syncRef.current = manager
    const controller = new AbortController()
    loadController.current = controller
    let timeout = setTimeout(() => controller.abort(new DOMException('云端读取超过 30000 ms', 'TimeoutError')), 30000)
    const draftTask = readWorkbenchDraft(userId)
    // Offer the local reader without waiting for a hung cloud request.
    void draftTask.then(local => {
      if (active && !readonlyRef.current && local && !isResolvedDraft(local)) setRecovery(local)
    }).catch(() => { if (active) setRecoveryIssue('本机备份读取失败，未清理备份。') })
    const load = async () => {
      const [cloud, draft] = await Promise.allSettled([loadWorkbenchSnapshot(userId, { signal: controller.signal, initialize: false }), draftTask])
      clearTimeout(timeout)
      if (!active || readonlyRef.current) return
      setCloudLoading(false)
      const local = draft.status === 'fulfilled' ? draft.value : null
      if (cloud.status === 'fulfilled') {
        dataRef.current = cloud.value.data
        setData(cloud.value.data)
        const inspection = inspectWorkbenchRecovery(local, cloud.value.storedData)
        if (inspection.action === 'recover' && local) { setDifferences(inspection.differences); setRecovery(local) }
        else { setRecovery(null); if (inspection.action === 'cleanup' && local) void manager.clearResolvedDraft(local.id, local.resolution || 'cloud-saved') }
      } else {
        if (local && !isResolvedDraft(local)) setRecovery(local)
        let failure = cloud.reason
        // Preserve the existing new-account behavior only when local storage
        // was read successfully and no local snapshot can be displaced.
        if (draft.status === 'fulfilled' && !local && cloud.reason?.code === 'WORKBENCH_NOT_FOUND') {
          timeout = setTimeout(() => controller.abort(new DOMException('云端初始化超过 30000 ms', 'TimeoutError')), 30000)
          try {
            const initial = await loadWorkbenchSnapshot(userId, { signal: controller.signal })
            if (active && !readonlyRef.current) { dataRef.current = initial.data; setData(initial.data) }
            return
          } catch (error) { failure = error }
          finally { clearTimeout(timeout) }
        }
        if (!active || readonlyRef.current) return
        const reason = controller.signal.aborted ? controller.signal.reason : failure
        const diagnostic = describeSyncError(reason)
        const details = failure as { status?: number; stage?: string; elapsedMs?: number } | null
        setLoadError('无法读取云端数据。已有本机备份会保留，可选择只读查看。')
        setLoadDetail([diagnostic.detail, details?.status ? `HTTP ${details.status}` : '', details?.stage ? `阶段 ${details.stage}` : '', typeof details?.elapsedMs === 'number' ? `${details.elapsedMs} ms` : ''].filter(Boolean).join(' · '))
      }
    }
    void load()
    const online = () => { if (!readonlyRef.current) manager.retry() }
    const beforeUnload = (event: BeforeUnloadEvent) => { if (manager.hasPending()) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('online', online)
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      active = false
      clearTimeout(timeout)
      controller.abort()
      if (loadController.current === controller) loadController.current = null
      manager.dispose()
      if (syncRef.current === manager) syncRef.current = null
      window.removeEventListener('online', online)
      window.removeEventListener('beforeunload', beforeUnload)
    }
  }, [userId])

  const update = useCallback((recipe: (current: WorkbenchData) => WorkbenchData) => {
    const current = dataRef.current
    if (readonlyRef.current || ownerRef.current !== userId || !current || !syncRef.current) return
    const next = recipe(current)
    if (next === current || sameStoredDocument(current, next)) return
    dataRef.current = next
    setData(next)
    syncRef.current.enqueue(next)
  }, [userId])

  useEffect(() => {
    if (!data || readonlyDraft || loadedOwner !== userId) return
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
  }, [data, readonlyDraft, loadedOwner, userId])

  if (!isSupabaseConfigured) return <SetupRequired />
  if (session === undefined) return <FullScreenLoading label="正在连接云端…" />
  if (!session) return <AuthScreen />
  if (loadedOwner !== userId) return <FullScreenLoading label="正在读取当前账号…" />
  if (readonlyDraft?.userId === userId) return <ReadonlyWorkbench draft={readonlyDraft} email={session.user.email || '已登录'} onExport={() => downloadWorkbenchBackup(readonlyDraft.data)} onExit={() => window.location.reload()} />
  if (recovery) return <div className="state-page"><Cloud size={30} /><strong>{data ? '本机备份与云端有内容差异' : cloudLoading ? '正在核对本机备份' : '暂时无法核对本机备份'}</strong><span>{new Date(recovery.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 的本机备份已保留。{data ? '仅检测到下列内容差异；尚未合并、删除或覆盖任何版本。' : cloudLoading ? '云端仍在读取，可以先只读查看本机数据。' : '云端读取失败，无法比较差异。可以只读查看本机数据，备份不会被修改。'}</span>
    {differences.length > 0 && <ul className="recovery-differences" aria-label="本机与云端差异">{differences.map(item => <li key={item.key}><strong>{item.label}</strong><span>{item.localCount != null || item.cloudCount != null ? `本机 ${item.localCount ?? '未记录'} 条 / 云端 ${item.cloudCount ?? '未记录'} 条，内容不同` : '保存内容或字段不同'}</span></li>)}</ul>}
    {recoveryIssue && <p className="recovery-error" role="alert">{recoveryIssue}</p>}
    {loadDetail && <details><summary>查看读取错误详情</summary><pre>{loadDetail}</pre></details>}
    <div className="draft-recovery-actions"><button className="button primary" onClick={() => {
      const issue = readonlyDraftIssue(recovery, userId)
      if (issue) { setRecoveryIssue(issue); return }
      // Set the write barrier synchronously before aborting any pending read.
      readonlyRef.current = true
      loadController.current?.abort()
      syncRef.current?.dispose()
      syncRef.current = null
      dataRef.current = null
      setReadonlyDraft(recovery)
    }}>只读查看本机数据</button><button className="button secondary" onClick={() => downloadWorkbenchBackup(recovery.data)}>导出本机备份</button><button className="button secondary" disabled={resolving || cloudLoading || !data} onClick={() => { if (!window.confirm('恢复会用这份本机备份替换云端工作台内容。请确认已核对差异，建议先导出备份。确定恢复吗？')) return; const value = recovery.data; dataRef.current = value; setData(value); setLoadError(''); setRecovery(null); syncRef.current?.enqueue(value) }}>恢复本机修改并同步</button>{data && <button className="button secondary" disabled={resolving} onClick={async () => { setResolving(true); setRecoveryIssue(''); const resolved = await syncRef.current?.clearResolvedDraft(recovery.id, 'kept-cloud'); if (resolved) setRecovery(null); else setRecoveryIssue('无法记录选择或清理本机备份，备份仍保留。请导出后重试，不会悄悄丢弃修改。'); setResolving(false) }}>{resolving ? '正在记录选择…' : '保留云端并清理本机备份'}</button>}</div></div>
  if (loadError) return <><StateScreen title="无法读取云端数据" message={loadError} action="重新加载" onAction={() => window.location.reload()} />{loadDetail && <details><summary>查看读取错误详情</summary><pre>{loadDetail}</pre></details>}</>
  if (!data) return <FullScreenLoading label="正在同步工作台数据…" />

  const value: WorkbenchContextValue = {
    data,
    update,
    userEmail: session.user.email || '已登录',
    signOut: async () => { await supabase.auth.signOut() },
    syncStatus: syncState.status,
    syncError: syncState.error?.message || '',
    syncErrorDetail: syncState.error?.detail || '',
    backupError: syncState.backupError,
    cleanupError: syncState.cleanupError || '',
    retrySync: () => syncRef.current?.retry(),
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
