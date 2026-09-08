import type { WorkbenchData } from '../types/models'

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
