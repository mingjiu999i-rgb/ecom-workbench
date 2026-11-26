export type SyncFailure = { message: string; detail: string; retryable: boolean; reconnecting?: boolean }
export type SyncSession = 'idle' | 'saving' | 'retrying' | 'conflict' | 'capacity' | 'unconfirmed'
export type SyncState = { status: 'saved' | 'saving' | 'error'; session: SyncSession; error: SyncFailure | null; backupError: string; cleanupError?: string }
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
  if (['40001', 'PT409'].includes(code) || item.status === 409) return { message: '云端已有更新，当前修改和本机备份已保留。请导出备份后核对两个版本。', detail, retryable: false }
  if (code === '55P03') return { message: '云端暂时忙碌，待同步修改已保留。', detail, retryable: true }
  if (['PGRST000', 'PGRST001', 'PGRST002', 'PGRST003'].includes(code)) return { message: '云端数据库连接暂时不可用，待同步修改已保留。', detail, retryable: true, reconnecting: true }
  if (code === '504') return { message: '云端服务暂时不可用，待同步修改已保留。', detail, retryable: true, reconnecting: true }
  if (code === '57014' || item.name === 'TimeoutError' || /timeout|timed out/i.test(message)) return { message: '云端保存超时，待同步修改已保留。', detail, retryable: true }
  if (item.name === 'AbortError' || /abort/i.test(message)) return { message: '云端保存请求中断，待同步修改已保留，可重试同步。', detail, retryable: true }
  if (/^5\d\d$/.test(code) || /upstream connect|remote connection failure/i.test(message)) return { message: '云端服务暂时不可用，待同步修改已保留。', detail, retryable: true, reconnecting: ['502', '503', '504'].includes(code) || /upstream connect|remote connection failure/i.test(message) }
  if (/fetch|network|offline|connection|load failed/i.test(message)) return { message: '连接云端失败，待同步修改已保留。', detail, retryable: true, reconnecting: true }
  return { message: '云端保存失败，待同步修改已保留。', detail, retryable: false }
}

export function createWorkbenchWriteBudget(controller: AbortController, idleMs = 90000, maximumMs = 600000, totalLimitMs = maximumMs) {
  let idle: ReturnType<typeof setTimeout> | undefined, disposed = false, maximumExceeded = false
  const maximum = setTimeout(() => {
    maximumExceeded = true
    controller.abort(new DOMException(`云端保存超过 ${totalLimitMs} ms 总上限，结果待核对`, 'TimeoutError'))
  }, Math.max(0, maximumMs))
  const progress = () => {
    if (disposed || controller.signal.aborted) return
    clearTimeout(idle)
    idle = setTimeout(() => controller.abort(new DOMException(`云端保存连续 ${idleMs} ms 无进展，结果待核对`, 'TimeoutError')), idleMs)
  }
  const dispose = () => { disposed = true; clearTimeout(idle); clearTimeout(maximum) }
  controller.signal.addEventListener('abort', dispose, { once: true })
  progress()
  return { progress, get maximumExceeded() { return maximumExceeded }, dispose() { dispose(); controller.signal.removeEventListener('abort', dispose) } }
}

export function createWorkbenchSync<T>(options: {
  userId: string; save: (data: T, signal: AbortSignal, onProgress: () => void) => Promise<void>
  storage: DraftStorage<T>; notify: (state: SyncState) => void
  debounceMs?: number; retryDelays?: number[]; timeoutMs?: number; maximumMs?: number; random?: () => number
}) {
  type Pending = PendingDraft<T> & { backup: Promise<void> }
  let pending: Pending | null = null, running = false, disposed = false, timer: ReturnType<typeof setTimeout> | undefined
  let active: AbortController | null = null, backupQueue = Promise.resolve(), backupError = ''
  let session: SyncSession = 'idle', state: SyncState = { status: 'saved', session, error: null, backupError: '' }
  const cleanupPending = new Map<string, DraftResolution>()
  let cleanupQueue = Promise.resolve(), cleanupError = ''
  let failureAttempts = 0, retryAt = 0, exhausted = false, writeStartedAt: number | null = null
  const notify = (status: SyncState['status'], error: SyncFailure | null = null, nextSession: SyncSession = session) => {
    session = nextSession
    state = { status, session, error, backupError, cleanupError }
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
    if (disposed || running || !pending || ['conflict', 'capacity', 'unconfirmed'].includes(session)) return
    running = true
    const current = pending
    const controller = new AbortController()
    active = controller
    let budget: ReturnType<typeof createWorkbenchWriteBudget> | undefined
    let maximumReached = false
    let retryDelay: number | null = null
    try {
      await current.backup
      if (disposed || pending?.id !== current.id) return
      // IndexedDB work does not consume the upload budget. Acknowledged begin
      // and stage calls reset the idle clock; retries share one total deadline.
      if (writeStartedAt === null) writeStartedAt = Date.now()
      const remaining = (options.maximumMs ?? 600000) - (Date.now() - writeStartedAt)
      if (remaining <= 0) {
        maximumReached = true
        throw new DOMException(`云端保存超过 ${options.maximumMs ?? 600000} ms 总上限，结果待核对`, 'TimeoutError')
      }
      budget = createWorkbenchWriteBudget(controller, options.timeoutMs ?? 90000, remaining, options.maximumMs ?? 600000)
      await options.save(current.data, controller.signal, budget.progress)
      controller.signal.throwIfAborted()
      failureAttempts = 0; retryAt = 0; exhausted = false; writeStartedAt = null
      budget.dispose()
      if (disposed) return
      if (pending?.id === current.id) pending = null
      await clearResolvedDraft(current.id)
      notify(pending ? 'saving' : 'saved', null, pending ? 'saving' : 'idle')
    } catch (error) {
      if (disposed) return
      const failure = describeSyncError(controller.signal.aborted ? controller.signal.reason : error)
      const item = error as { code?: string; status?: number; writePhase?: string } | null
      const conflict = (item?.writePhase === 'begin' || item?.writePhase === 'commit')
        && (item.code === 'PT409' || item.code === '40001' || item.status === 409)
      const capacity = item?.writePhase === 'stage' && item.code === '54000'
      if (conflict) { exhausted = true; notify('error', failure, 'conflict') }
      else if (capacity) { exhausted = true; notify('error', failure, 'capacity') }
      else if (pending?.id !== current.id && !failure.retryable) notify('saving', null, 'saving')
      else {
        // PostgREST may wrap the fetch rejection; retain our actual timeout
        // reason so diagnostics do not degrade to an unexplained AbortError.
        // A database restart can take longer than the ordinary short retry
        // window. Keep the draft pending through schema-cache reconstruction.
        const delays = options.retryDelays ?? (failure.reconnecting ? [1000, 2000, 4000, 8000, 16000] : [1000, 2000])
        if (failure.retryable && !maximumReached && !budget?.maximumExceeded && failureAttempts < delays.length) {
          const base = delays[failureAttempts++]
          // Equal jitter avoids synchronized retries while keeping a finite cap.
          retryDelay = options.retryDelays ? base : Math.floor(base * (0.5 + 0.5 * (options.random ?? Math.random)()))
          retryAt = Date.now() + retryDelay
          notify('saving', failure, 'retrying')
        } else { exhausted = failure.retryable; notify('error', failure, failure.retryable ? 'unconfirmed' : 'idle') }
      }
    } finally {
      budget?.dispose()
      active = null
      running = false
      if (!disposed && pending && state.status !== 'error' && !['conflict', 'capacity', 'unconfirmed'].includes(session)) schedule(retryDelay ?? 0)
    }
  }
  return {
    enqueue(data: T) {
      if (disposed) return
      const draft: PendingDraft<T> = { id: crypto.randomUUID(), userId: options.userId, updatedAt: new Date().toISOString(), data }
      const backup = backupQueue.then(() => options.storage.write(draft)).then(() => { backupError = ''; notify(state.status, state.error) }).catch(() => {
        backupError = '本机备份失败，最近修改只在本页面内存中。请立即导出未同步备份。'
        notify(state.status, state.error)
      })
      backupQueue = backup
      pending = { ...draft, backup }
      // New edits remain durable but cannot reset a failed account's retry budget.
      if (exhausted || ['conflict', 'capacity', 'unconfirmed'].includes(session)) { notify('error', state.error); return }
      notify('saving', null, 'saving')
      schedule(options.debounceMs ?? 300)
    },
    retry(manual = true) {
      if (disposed) return
      if (session === 'conflict' || session === 'capacity') return
      if (session === 'unconfirmed' && !manual) return
      if (pending) { failureAttempts = 0; retryAt = 0; exhausted = false; writeStartedAt = null; notify('saving', null, 'saving'); schedule(0) }
      else for (const [id, resolution] of cleanupPending) void clearResolvedDraft(id, resolution)
    },
    async keepCloud() {
      if (!pending || !['conflict', 'capacity', 'unconfirmed'].includes(session)) return false
      const id = pending.id
      clearTimeout(timer); pending = null; failureAttempts = 0; retryAt = 0; exhausted = false; writeStartedAt = null
      notify('saved', null, 'idle')
      await backupQueue
      return clearResolvedDraft(id, 'kept-cloud')
    },
    resumeFromReview() {
      if (!pending || !['conflict', 'capacity', 'unconfirmed'].includes(session)) return false
      failureAttempts = 0; retryAt = 0; exhausted = false; writeStartedAt = null
      notify('saving', null, 'saving'); schedule(0)
      return true
    },
    clearResolvedDraft,
    hasPending() { return pending != null },
    getState() { return state },
    dispose() { disposed = true; clearTimeout(timer); active?.abort() },
  }
}
