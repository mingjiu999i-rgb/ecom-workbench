import { createClient } from '@supabase/supabase-js'
import { initialData } from '../data/template'
import type { WorkbenchData } from '../types/models'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)
export const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseAnonKey || 'placeholder-anon-key')
const cloneInitialData = (): WorkbenchData => JSON.parse(JSON.stringify(initialData)) as WorkbenchData

const normalizeWorkbench = (value: WorkbenchData): WorkbenchData => {
  const hasProductCosts = Array.isArray(value.productCosts)
  const legacyCosts = hasProductCosts ? value.productCosts : []
  const products = (value.products || []).map(product => {
    const legacyCost = legacyCosts.find(cost => cost.productId === product.id) as (typeof legacyCosts[number] & { clientId?: string }) | undefined
    const link = (value.productLinks || []).find(item => item.productId === product.id)
    return { ...product, clientId: product.clientId || legacyCost?.clientId || link?.clientId || '' }
  })
  const productCosts = hasProductCosts
    ? legacyCosts.map(cost => ({ id: cost.id, productId: cost.productId || '', skuCode: cost.skuCode, specification: cost.specification, totalCost: cost.totalCost }))
    : (value.skus || []).map(sku => {
        const link = (value.productLinks || []).find(item => item.id === sku.productLinkId)
        return {
          id: `cost-${sku.id}`,
          productId: link?.productId || '',
          skuCode: sku.skuId,
          specification: sku.specification,
          totalCost: Number(sku.productCost || 0) + Number(sku.shippingCost || 0) + Number(sku.packagingCost || 0) + Number(sku.otherCost || 0),
        }
      })
  const skus = (value.skus || []).map(sku => {
    const link = (value.productLinks || []).find(item => item.id === sku.productLinkId)
    const linkedCost = productCosts.find(cost => cost.id === sku.productCostId)
      || productCosts.find(cost => cost.productId === link?.productId && cost.skuCode === sku.skuId)
    return {
      ...sku,
      activityPrice: Number(sku.activityPrice || 0),
      productCostId: linkedCost?.id || '',
      productCost: linkedCost?.totalCost ?? sku.productCost,
      shippingCost: linkedCost ? 0 : sku.shippingCost,
      packagingCost: linkedCost ? 0 : sku.packagingCost,
      otherCost: linkedCost ? 0 : sku.otherCost,
    }
  })
  const productLinks = (value.productLinks || []).map(link => ({ ...link, status: link.status || '日销' as const }))
  return { ...value, products, productCosts, productLinks, skus, skuHistory: value.skuHistory || [], todos: value.todos || [] }
}

export async function loadWorkbench(userId: string): Promise<WorkbenchData> {
  const { data, error } = await supabase.from('workbench_documents').select('data').eq('user_id', userId).maybeSingle()
  if (error) throw error
  if (data?.data) return normalizeWorkbench(data.data as WorkbenchData)
  const initial = cloneInitialData()
  await saveWorkbench(userId, initial)
  return initial
}

export async function saveWorkbench(userId: string, data: WorkbenchData): Promise<void> {
  const { error } = await supabase.from('workbench_documents').upsert({ user_id: userId, data, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
  if (error) throw error
}
