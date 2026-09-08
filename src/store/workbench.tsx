import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Cloud, LoaderCircle, LockKeyhole, Mail } from 'lucide-react'
import type { Session } from '@supabase/supabase-js'
import { isSupabaseConfigured, loadWorkbench, saveWorkbench, supabase } from '../services/supabase'
import type { WorkbenchData } from '../types/models'

type SyncStatus = 'saved' | 'saving' | 'error'
interface WorkbenchContextValue {
  data: WorkbenchData
  update: (recipe: (current: WorkbenchData) => WorkbenchData) => void
  userEmail: string
  signOut: () => Promise<void>
  syncStatus: SyncStatus
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null)
export const createId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [data, setData] = useState<WorkbenchData | null>(null)
  const [loadError, setLoadError] = useState('')
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('saved')
  const saveQueue = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    void supabase.auth.getSession().then(({ data: result }) => setSession(result.session))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => setSession(next))
    return () => listener.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) { setData(null); return }
    let active = true
    setLoadError('')
    void loadWorkbench(session.user.id)
      .then(result => { if (active) setData(result) })
      .catch(error => { if (active) setLoadError(error instanceof Error ? error.message : '云端数据加载失败') })
    return () => { active = false }
  }, [session])

  const update = useCallback((recipe: (current: WorkbenchData) => WorkbenchData) => {
    if (!session) return
    setData(current => {
      if (!current) return current
      const next = recipe(current)
      setSyncStatus('saving')
      saveQueue.current = saveQueue.current
        .then(() => saveWorkbench(session.user.id, next))
        .then(() => setSyncStatus('saved'))
        .catch(error => { console.error(error); setSyncStatus('error') })
      return next
    })
  }, [session])

  useEffect(() => {
    if (!data) return
    const context = document.modelContext
    if (!context?.registerTool) return
    const lifecycle = new AbortController()
    const report = (error: unknown) => console.warn('WebMCP tool registration failed', error)
    void Promise.resolve(context.registerTool({
      name: 'read_workbench_summary',
      title: '查看运营概况',
      description: '读取当前云端工作台的甲方、店铺、商品链接、SKU 和风险 SKU 数量。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => ({ clients: data.clients.length, stores: data.stores.length, productLinks: data.productLinks.length, skus: data.skus.length, riskSkus: data.skus.filter(s => s.currentRoi < s.breakEvenRoi).length }),
    }, { signal: lifecycle.signal })).catch(report)
    return () => lifecycle.abort()
  }, [data])

  if (!isSupabaseConfigured) return <SetupRequired />
  if (session === undefined) return <FullScreenLoading label="正在连接云端…" />
  if (!session) return <AuthScreen />
  if (loadError) return <StateScreen title="无法读取云端数据" message={loadError} action="重新加载" onAction={() => window.location.reload()} />
  if (!data) return <FullScreenLoading label="正在同步工作台数据…" />

  const value: WorkbenchContextValue = {
    data,
    update,
    userEmail: session.user.email || '已登录',
    signOut: async () => { await supabase.auth.signOut() },
    syncStatus,
  }
  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>
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
