import { createClient } from '@supabase/supabase-js'
import { initialData } from '../data/template'
import type { WorkbenchData } from '../types/models'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)
export const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseAnonKey || 'placeholder-anon-key')
const cloneInitialData = (): WorkbenchData => JSON.parse(JSON.stringify(initialData)) as WorkbenchData

export async function loadWorkbench(userId: string): Promise<WorkbenchData> {
  const { data, error } = await supabase.from('workbench_documents').select('data').eq('user_id', userId).maybeSingle()
  if (error) throw error
  if (data?.data) return data.data as WorkbenchData
  const initial = cloneInitialData()
  await saveWorkbench(userId, initial)
  return initial
}

export async function saveWorkbench(userId: string, data: WorkbenchData): Promise<void> {
  const { error } = await supabase.from('workbench_documents').upsert({ user_id: userId, data, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
  if (error) throw error
}
