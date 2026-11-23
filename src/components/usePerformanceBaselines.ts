import { useEffect, useState } from 'react'
import { supabase } from '../services/supabase'
import { useWorkbench } from '../store/workbench'
import type { ProfitBaseline } from '../utils/profitBaselines'
import { readPerformanceBaselines } from '../utils/performanceBaselineRead'

const empty: ProfitBaseline[] = []
export function usePerformanceBaselines() {
  const { data, complete, userEmail } = useWorkbench()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<{ owner: string; rows: ProfitBaseline[]; status: 'ready' | 'error'; error?: string } | null>(null)
  const available = complete || Array.isArray(data.profitBaselines)
  useEffect(() => {
    if (available) return
    let active = true
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 15000)
    setLoaded(null)
    void (async () => {
      const { data: session, error } = await supabase.auth.getSession()
      if (error || !session.session) throw new Error('请登录后重新读取初始记录')
      // Keep the existing shared row-storage module behind its dynamic entry.
      const { supabaseRowTransport } = await import('../services/rowWorkbenchStore')
      return readPerformanceBaselines(supabaseRowTransport(supabase, session.session.user.id), controller.signal)
    })().then(rows => { if (active) setLoaded({ owner: userEmail, rows, status: 'ready' }) })
      .catch(() => { if (active) setLoaded({ owner: userEmail, rows: empty, status: 'error', error: '初始记录暂未读取成功，请重试；未将读取失败当作没有记录。' }) })
      .finally(() => window.clearTimeout(timer))
    return () => { active = false; window.clearTimeout(timer); controller.abort() }
  }, [available, userEmail, attempt])
  const state = loaded?.owner === userEmail ? loaded : null
  return {
    rows: available ? data.profitBaselines || empty : state?.rows || empty,
    status: available ? 'ready' as const : state?.status || 'loading' as const,
    error: available ? undefined : state?.error,
    retry: () => setAttempt(current => current + 1),
  }
}
