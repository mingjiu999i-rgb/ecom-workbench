export type SyncFailure = { message: string; detail: string; retryable: boolean }
export type SyncState = { status: 'saved' | 'saving' | 'error'; error: SyncFailure | null; backupError: string }
export type PendingDraft<T> = { id: string; userId: string; updatedAt: string; data: T }
export type DraftStorage<T> = {
  write: (draft: PendingDraft<T>) => Promise<void>
  remove: (userId: string, id: string) => Promise<void>
}

export function describeSyncError(error: unknown): SyncFailure {
  const item = error && typeof error === 'object' ? error as { message?: string; code?: string; status?: number } : {}
  const message = typeof item.message === 'string' ? item.message : String(error || '未知保存错误')
  const code = String(item.code || item.status || '')
  const detail = [code, message.replace(/[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/g, '[登录凭据已隐藏]')].filter(Boolean).join(' · ').slice(0, 500)
  if (['401', 'PGRST301', 'PGRST302'].includes(code) || /jwt.*(expired|invalid)|refresh.?token/i.test(message)) return { message: '登录状态失效，云端未接受保存。请先导出未同步备份，再重新登录。', detail, retryable: false }
  if (['403', '42501'].includes(code) || /row.level security|permission denied/i.test(message)) return { message: '云端拒绝写入，账号权限校验未通过。', detail, retryable: false }
  if (['413', '54000'].includes(code) || /payload too large|request.*too large/i.test(message)) return { message: '本次数据超过云端接收限制。修改仍保留在当前页面。', detail, retryable: false }
  if (code === '57014' || /timeout|timed out|abort/i.test(message)) return { message: '云端保存超时，待同步修改已保留。', detail, retryable: true }
  if (/fetch|network|offline|connection|load failed/i.test(message) || /^50[0234]$/.test(code)) return { message: '连接云端失败，待同步修改已保留。请检查网络后重试。', detail, retryable: true }
  return { message: '云端保存失败，待同步修改已保留。', detail, retryable: false }
}

export function createWorkbenchSync<T>(options: {
  userId: string; save: (data: T, signal: AbortSignal) => Promise<void>
  storage: DraftStorage<T>; notify: (state: SyncState) => void
  debounceMs?: number; retryDelays?: number[]; timeoutMs?: number
}) {
  type Pending = PendingDraft<T> & { backup: Promise<void>; attempts: number }
  let pending: Pending | null = null, running = false, disposed = false, timer: ReturnType<typeof setTimeout> | undefined
  let active: AbortController | null = null, backupQueue = Promise.resolve(), backupError = ''
  let state: SyncState = { status: 'saved', error: null, backupError: '' }
  const delays = options.retryDelays || [1000, 3000]
  const notify = (status: SyncState['status'], error: SyncFailure | null = null) => {
    state = { status, error, backupError }
    if (!disposed) options.notify(state)
  }
  const schedule = (delay: number) => {
    if (disposed) return
    clearTimeout(timer)
    timer = setTimeout(() => { void run() }, delay)
  }
  async function run() {
    if (disposed || running || !pending) return
    running = true
    const current = pending
    const controller = new AbortController()
    active = controller
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000)
    let retryDelay: number | null = null
    try {
      await current.backup
      await options.save(current.data, controller.signal)
      if (disposed) return
      if (pending?.id === current.id) pending = null
      try { await options.storage.remove(options.userId, current.id) } catch { /* A stale recovery draft is safe; it is compared with cloud data on reopen. */ }
      notify(pending ? 'saving' : 'saved')
    } catch (error) {
      if (disposed) return
      if (pending?.id !== current.id) notify('saving')
      else {
        const failure = describeSyncError(error)
        if (failure.retryable && current.attempts < delays.length) {
          retryDelay = delays[current.attempts++]
          notify('saving', failure)
        } else notify('error', failure)
      }
    } finally {
      clearTimeout(timeout)
      active = null
      running = false
      if (!disposed && pending && state.status !== 'error') schedule(retryDelay ?? 0)
    }
  }
  return {
    enqueue(data: T) {
      if (disposed) return
      const draft: PendingDraft<T> = { id: crypto.randomUUID(), userId: options.userId, updatedAt: new Date().toISOString(), data }
      const backup = backupQueue.then(() => options.storage.write(draft)).then(() => { backupError = '' }).catch(() => { backupError = '本机自动备份不可用，请使用“导出未同步备份”保留修改。' })
      backupQueue = backup
      pending = { ...draft, backup, attempts: 0 }
      notify('saving')
      schedule(options.debounceMs ?? 300)
    },
    retry() { if (pending && !disposed) { pending.attempts = 0; notify('saving'); schedule(0) } },
    hasPending() { return pending != null },
    getState() { return state },
    dispose() { disposed = true; clearTimeout(timer); active?.abort() },
  }
}
