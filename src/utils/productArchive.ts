import type { Product, WorkbenchData } from '../types/models'
import { isActiveProductLink } from './selectors'

export const isProductArchived = (product: Product | undefined) => product?.archived === true
export const isArchivedProductId = (data: WorkbenchData, productId: string) => isProductArchived(data.products.find(product => product.id === productId))
export const productOptions = (data: WorkbenchData, retainedId = '') => data.products.filter(product => !isProductArchived(product) || product.id === retainedId)

// UI visibility only. Settlement still receives every saved product and cost.
export const isOperationalProductLink = (data: WorkbenchData, linkId: string) => {
  const link = data.productLinks.find(item => item.id === linkId)
  return isActiveProductLink(data, linkId) && !isArchivedProductId(data, link?.productId || '')
}

// Do not cascade, remove relations, or rewrite any financial collection.
export function setProductArchived(data: WorkbenchData, productId: string, archived: boolean): WorkbenchData {
  const product = data.products.find(item => item.id === productId)
  if (!product || isProductArchived(product) === archived) return data
  const updated = { ...product }
  if (archived) updated.archived = true
  else delete updated.archived
  return { ...data, products: data.products.map(item => item.id === productId ? updated : item) }
}
