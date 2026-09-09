import type { WorkbenchData } from '../types/models'

// 新账号首次登录时写入 Supabase。你可以直接修改这里的初始资料。
export const initialClients = [
  { id: 'client-a', name: '示例甲方A', remark: '' },
  { id: 'client-b', name: '示例甲方B', remark: '' },
  { id: 'client-c', name: '示例甲方C', remark: '' },
]

export const initialStores = [
  { id: 'store-pdd', clientId: 'client-a', name: '示例拼多多店', platform: '拼多多' as const },
  { id: 'store-tb', clientId: 'client-b', name: '示例淘宝店', platform: '淘宝' as const },
]

export const initialProducts = [
  { id: 'product-a', clientId: 'client-a', name: '示例产品A', remark: '' },
  { id: 'product-b', clientId: 'client-b', name: '示例产品B', remark: '' },
]

export const initialData: WorkbenchData = {
  clients: initialClients,
  stores: initialStores,
  products: initialProducts,
  productLinks: [
    { id: 'link-a', clientId: 'client-a', storeId: 'store-pdd', productId: 'product-a', linkId: 'PDD-10001', status: '日销', url: '', remark: '' },
    { id: 'link-b', clientId: 'client-b', storeId: 'store-tb', productId: 'product-b', linkId: 'TB-20001', status: '日销', url: '', remark: '' },
  ],
  skus: [
    { id: 'sku-a', productLinkId: 'link-a', productCostId: 'cost-a', name: '标准装', skuId: 'SKU-A01', specification: '1 件', salePrice: 49.9, finalPrice: 39.9, productCost: 23, shippingCost: 0, packagingCost: 0, otherCost: 0, currentRoi: 5.2, breakEvenRoi: 4.6, activity: '平台活动', activityPrice: 39.9, remark: '' },
    { id: 'sku-b', productLinkId: 'link-b', productCostId: 'cost-b', name: '组合装', skuId: 'SKU-B01', specification: '2 件', salePrice: 89, finalPrice: 69, productCost: 45.5, shippingCost: 0, packagingCost: 0, otherCost: 0, currentRoi: 3.8, breakEvenRoi: 4.3, activity: '无活动', activityPrice: 0, remark: '关注投产' },
  ],
  productCosts: [
    { id: 'cost-a', productId: 'product-a', skuCode: 'SKU-A01', specification: '1 件', totalCost: 23 },
    { id: 'cost-b', productId: 'product-b', skuCode: 'SKU-B01', specification: '2 件', totalCost: 45.5 },
  ],
  operations: [],
  skuHistory: [],
  todos: [],
}
