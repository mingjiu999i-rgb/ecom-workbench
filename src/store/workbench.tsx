import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Cloud, LoaderCircle, LockKeyhole, Mail } from 'lucide-react'
import type { Session } from '@supabase/supabase-js'
import { isSupabaseConfigured, loadWorkbench, saveWorkbench, supabase } from '../services/supabase'
import type { WorkbenchData } from '../types/models'
import { isActiveProductLink } from '../utils/selectors'
import { readWorkbenchDraft, removeWorkbenchDraft, writeWorkbenchDraft } from '../services/workbenchDrafts'
import { createWorkbenchSync, describeSyncError, type PendingDraft, type SyncState } from '../utils/workbenchSync'

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
  const dataRef = useRef<WorkbenchData | null>(null)
  const syncRef = useRef<ReturnType<typeof createWorkbenchSync<WorkbenchData>> | null>(null)
  const userId = session?.user.id

  useEffect(() => {
    void supabase.auth.getSession().then(({ data: result }) => setSession(result.session))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => setSession(next))
    return () => listener.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!userId) { dataRef.current = null; setData(null); setRecovery(null); return }
    let active = true
    dataRef.current = null
    setData(null)
    setRecovery(null)
    setLoadError('')
    setSyncState({ status: 'saved', error: null, backupError: '' })
    const manager = createWorkbenchSync<WorkbenchData>({
      userId, save: (value, signal) => saveWorkbench(userId, value, signal),
      storage: { write: writeWorkbenchDraft, remove: removeWorkbenchDraft },
      notify: state => { if (active) setSyncState(state) },
    })
    syncRef.current = manager
    const load = async () => {
      const [cloud, draft] = await Promise.allSettled([loadWorkbench(userId), readWorkbenchDraft(userId)])
      if (!active) return
      const local = draft.status === 'fulfilled' ? draft.value : null
      if (cloud.status === 'fulfilled') {
        dataRef.current = cloud.value
        setData(cloud.value)
        if (local && JSON.stringify(local.data) !== JSON.stringify(cloud.value)) setRecovery(local)
        else if (local) void removeWorkbenchDraft(userId, local.id).catch(() => {})
      } else {
        if (local) setRecovery(local)
        setLoadError(describeSyncError(cloud.reason).message)
      }
    }
    void load()
    const online = () => manager.retry()
    const beforeUnload = (event: BeforeUnloadEvent) => { if (manager.hasPending()) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('online', online)
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      active = false
      manager.dispose()
      if (syncRef.current === manager) syncRef.current = null
      window.removeEventListener('online', online)
      window.removeEventListener('beforeunload', beforeUnload)
    }
  }, [userId])

  const update = useCallback((recipe: (current: WorkbenchData) => WorkbenchData) => {
    const current = dataRef.current
    if (!current || !syncRef.current) return
    const next = recipe(current)
    if (next === current) return
    dataRef.current = next
    setData(next)
    syncRef.current.enqueue(next)
  }, [])

  useEffect(() => {
    if (!data) return
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
  }, [data])

  if (!isSupabaseConfigured) return <SetupRequired />
  if (session === undefined) return <FullScreenLoading label="正在连接云端…" />
  if (!session) return <AuthScreen />
  if (recovery) return <div className="state-page"><Cloud size={30} /><strong>发现本机尚未同步的修改</strong><span>{new Date(recovery.updatedAt).toLocaleString('zh-CN')} 保存的本机备份与云端版本不同。请选择要保留的版本，恢复前不会覆盖云端。</span><div className="draft-recovery-actions"><button className="button primary" onClick={() => { const value = recovery.data; dataRef.current = value; setData(value); setLoadError(''); setRecovery(null); syncRef.current?.enqueue(value) }}>恢复本机修改并同步</button><button className="button secondary" onClick={() => downloadWorkbenchBackup(recovery.data)}>导出本机备份</button>{data && <button className="button secondary" onClick={() => { void removeWorkbenchDraft(recovery.userId, recovery.id).catch(() => {}); setRecovery(null) }}>保留云端版本</button>}</div></div>
  if (loadError) return <StateScreen title="无法读取云端数据" message={loadError} action="重新加载" onAction={() => window.location.reload()} />
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
