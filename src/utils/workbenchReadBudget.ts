// Read deadlines only. Progress never changes a draft, write baseline or cloud data.
export function createWorkbenchReadBudget(controller: AbortController) {
  let idle: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const maximum = setTimeout(() => controller.abort(new DOMException('完整云端读取超过 300000 ms，备份已保留', 'TimeoutError')), 300000)
  const progress = () => {
    if (disposed || controller.signal.aborted) return
    clearTimeout(idle)
    idle = setTimeout(() => controller.abort(new DOMException('完整云端读取连续 60000 ms 无进展，备份已保留', 'TimeoutError')), 60000)
  }
  const dispose = () => { disposed = true; clearTimeout(idle); clearTimeout(maximum) }
  controller.signal.addEventListener('abort', dispose, { once: true })
  progress()
  return { progress, dispose() { dispose(); controller.signal.removeEventListener('abort', dispose) } }
}
