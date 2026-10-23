export type SyncFailure = { message: string; detail: string; retryable: boolean; reconnecting?: boolean }
export type SyncState = { status: 'saved' | 'saving' | 'error'; error: SyncFailure | null; backupError: string; cleanupError?: string }
export type DraftResolution = 'cloud-saved' | 'kept-cloud'
export type PendingDraft<T> = { id: string; userId: string; updatedAt: string; data: T; resolution?: DraftResolution }
export type DraftStorage<T> = {
  write: (draft: PendingDraft<T>) => Promise<void>
  remove: (userId: string, id: string) => Promise<void>
  acknowledge?: (userId: string, id: string, resolution: DraftResolution) => Promise<void>
}

export function describeSyncError(error: unknown): SyncFailure {
  const item = error && typeof error === 'object' ? error as { name?: string; message?: string; code?: string; status?: number } : {}
  const message = typeof item.message === 'string' ? item.message : String(error || '未知保存错误')
  const code = String(item.code || item.status || '')
  const detail = [code, message.replace(/[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/g, '[登录凭据已隐藏]')].filter(Boolean).join(' · ').slice(0, 500)
  if (['401', 'PGRST301', 'PGRST302'].includes(code) || /jwt.*(expired|invalid)|refresh.?token/i.test(message)) return { message: '登录状态失效，云端未接受保存。请先导出未同步备份，再重新登录。', detail, retryable: false }
  if (['403', '42501'].includes(code) || /row.level security|permission denied/i.test(message)) return { message: '云端拒绝写入，账号权限校验未通过。', detail, retryable: false }
  if (['413', '54000'].includes(code) || /payload too large|request.*too large/i.test(message)) return { message: '本次数据超过云端接收限制。修改仍保留在当前页面。', detail, retryable: false }
  if (code === '40001') return { message: '云端已有更新，当前修改和本机备份已保留。请导出备份后核对两个版本。', detail, retryable: false }
  if (['PGRST000', 'PGRST001', 'PGRST002', 'PGRST003'].includes(code)) return { message: '云端数据库连接暂时不可用，待同步修改已保留。', detail, retryable: true, reconnecting: true }
  if (code === '57014' || item.name === 'TimeoutError' || /timeout|timed out/i.test(message)) return { message: '云端保存超时，待同步修改已保留。', detail, retryable: true }
  if (item.name === 'AbortError' || /abort/i.test(message)) return { message: '云端保存请求中断，待同步修改已保留，可重试同步。', detail, retryable: true }
  if (/^5\d\d$/.test(code) || /upstream connect|remote connection failure/i.test(message)) return { message: '云端服务暂时不可用，待同步修改已保留。', detail, retryable: true, reconnecting: ['502', '503', '504'].includes(code) || /upstream connect|remote connection failure/i.test(message) }
  if (/fetch|network|offline|connection|load failed/i.test(message)) return { message: '连接云端失败，待同步修改已保留。', detail, retryable: true, reconnecting: true }
  return { message: '云端保存失败，待同步修改已保留。', detail, retryable: false }
}

export function createWorkbenchSync<T>(options: {
  userId: string; save: (data: T, signal: AbortSignal) => Promise<void>
  storage: DraftStorage<T>; notify: (state: SyncState) => void
  debounceMs?: number; retryDelays?: number[]; timeoutMs?: number; random?: () => number
}) {
  type Pending = PendingDraft<T> & { backup: Promise<void> }
  let pending: Pending | null = null, running = false, disposed = false, timer: ReturnType<typeof setTimeout> | undefined
  let active: AbortController | null = null, backupQueue = Promise.resolve(), backupError = ''
  let state: SyncState = { status: 'saved', error: null, backupError: '' }
  const cleanupPending = new Map<string, DraftResolution>()
  let cleanupQueue = Promise.resolve(), cleanupError = ''
  let failureAttempts = 0, retryAt = 0, exhausted = false
  const notify = (status: SyncState['status'], error: SyncFailure | null = null) => {
    state = { status, error, backupError, cleanupError }
    if (!disposed) options.notify(state)
  }
  const schedule = (delay: number) => {
    if (disposed) return
    clearTimeout(timer)
    timer = setTimeout(() => { void run() }, Math.max(delay, retryAt - Date.now()))
  }
  function clearResolvedDraft(id: string, resolution: DraftResolution = 'cloud-saved'): Promise<boolean> {
    cleanupPending.set(id, resolution)
    const task = cleanupQueue.then(async () => {
      if (disposed) return false
      cleanupPending.set(id, resolution)
      let acknowledged = false, removed = false
      try { if (options.storage.acknowledge) { await options.storage.acknowledge(options.userId, id, resolution); acknowledged = true } } catch { /* Still try removal, but never pretend the choice was recorded. */ }
      try { await options.storage.remove(options.userId, id); cleanupPending.delete(id); removed = true } catch { /* Keep the exact ID for safe retries. */ }
      cleanupError = cleanupPending.size ? '本机备份清理未完成，备份仍保留。请重试清理；不会因此覆盖云端数据。' : ''
      notify(state.status, state.error)
      return acknowledged || removed
    })
    cleanupQueue = task.then(() => {})
    return task
  }
  async function run() {
    if (disposed || running || !pending) return
    running = true
    const current = pending
    const controller = new AbortController()
    active = controller
    let timeout: ReturnType<typeof setTimeout> | undefined
    let retryDelay: number | null = null
    try {
      await current.backup
      if (disposed || pending?.id !== current.id) return
      // IndexedDB work does not consume the upload budget. Whole-workbench
      // snapshots can take longer than 30 seconds on a slow connection.
      const timeoutMs = options.timeoutMs ?? 120000
      timeout = setTimeout(() => controller.abort(new DOMException(`云端保存请求超过 ${timeoutMs} ms`, 'TimeoutError')), timeoutMs)
      await options.save(current.data, controller.signal)
      failureAttempts = 0; retryAt = 0; exhausted = false
      clearTimeout(timeout)
      if (disposed) return
      if (pending?.id === current.id) pending = null
      await clearResolvedDraft(current.id)
      notify(pending ? 'saving' : 'saved')
    } catch (error) {
      if (disposed) return
      const failure = describeSyncError(controller.signal.aborted ? controller.signal.reason : error)
      if (pending?.id !== current.id && !failure.retryable) notify('saving')
      else {
        // PostgREST may wrap the fetch rejection; retain our actual timeout
        // reason so diagnostics do not degrade to an unexplained AbortError.
        // A database restart can take longer than the ordinary short retry
        // window. Keep the draft pending through schema-cache reconstruction.
        const delays = options.retryDelays ?? (failure.reconnecting ? [1000, 2000, 4000, 8000, 16000] : [1000, 2000])
        if (failure.retryable && failureAttempts < delays.length) {
          const base = delays[failureAttempts++]
          // Equal jitter avoids synchronized retries while keeping a finite cap.
          retryDelay = options.retryDelays ? base : Math.floor(base * (0.5 + 0.5 * (options.random ?? Math.random)()))
          retryAt = Date.now() + retryDelay
          notify('saving', failure)
        } else { exhausted = failure.retryable; notify('error', failure) }
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
      pending = { ...draft, backup }
      // New edits remain durable but cannot reset a failed account's retry budget.
      if (exhausted) { notify('error', state.error); return }
      notify('saving')
      schedule(options.debounceMs ?? 300)
    },
    retry() {
      if (disposed) return
      if (pending) { failureAttempts = 0; retryAt = 0; exhausted = false; notify('saving'); schedule(0) }
      else for (const [id, resolution] of cleanupPending) void clearResolvedDraft(id, resolution)
    },
    clearResolvedDraft,
    hasPending() { return pending != null },
    getState() { return state },
    dispose() { disposed = true; clearTimeout(timer); active?.abort() },
  }
}
