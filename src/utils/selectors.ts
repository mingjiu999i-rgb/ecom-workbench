import type { WorkbenchData } from '../types/models'

export const isActiveStore = (data: WorkbenchData, storeId: string) => {
  const store = data.stores.find(item => item.id === storeId)
  return Boolean(store && store.storeStatus !== '暂停')
}

export const isActiveProductLink = (data: WorkbenchData, linkId: string) => {
  const link = data.productLinks.find(item => item.id === linkId)
  return Boolean(link && link.status !== '已挂' && isActiveStore(data, link.storeId))
}

export function getSkuContext(data: WorkbenchData, skuId: string) {
  const sku = data.skus.find(item => item.id === skuId)
  const link = data.productLinks.find(item => item.id === sku?.productLinkId)
  return {
    sku,
    link,
    client: data.clients.find(item => item.id === link?.clientId),
    store: data.stores.find(item => item.id === link?.storeId),
    product: data.products.find(item => item.id === link?.productId),
  }
}

export const displayDate = (value: string) => new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(value))
