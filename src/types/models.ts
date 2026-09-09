export type Platform = '拼多多' | '淘宝' | '其他'
export type LinkStatus = '日销' | '活动' | '备用' | '已挂'
export type ActivityType = '无活动' | '平台活动' | '店铺活动' | '百亿补贴' | '其他'
export type AdjustmentType = '售价' | '到手价' | '成本' | '投产' | '活动' | 'SKU' | '其他'
export type AdjustmentReason = '平台比价' | '竞品变化' | '报活动' | '活动结束' | '成本变化' | '推广调整' | '测试' | '其他'

export interface Client { id: string; name: string; remark: string }
export interface Store { id: string; clientId: string; name: string; platform: Platform }
export interface Product { id: string; clientId: string; name: string; remark: string }
export interface ProductCost {
  id: string; productId: string; skuCode: string; specification: string; totalCost: number
}
export interface ProductLink {
  id: string; clientId: string; storeId: string; productId: string
  linkId: string; status: LinkStatus; url: string; remark: string
}
export interface Sku {
  id: string; productLinkId: string; productCostId: string; name: string; skuId: string; specification: string
  salePrice: number; finalPrice: number; productCost: number; shippingCost: number
  packagingCost: number; otherCost: number; currentRoi: number; breakEvenRoi: number
  activity: ActivityType; activityPrice: number; remark: string
}
export interface Operation {
  id: string; createdAt: string; clientId: string; storeId: string; productId: string
  productLinkId: string; skuId: string; type: AdjustmentType; before: string
  after: string; reason: AdjustmentReason; remark: string
}
export interface SkuHistory {
  id: string; skuId: string; name: string; salePrice: number; recordedAt: string
}
export interface TodoItem {
  id: string; date: string; title: string; clientId: string; storeId: string
  completed: boolean; createdAt: string
}
export interface WorkbenchData {
  clients: Client[]; stores: Store[]; products: Product[]; productLinks: ProductLink[]
  skus: Sku[]; productCosts: ProductCost[]; operations: Operation[]; skuHistory: SkuHistory[]; todos: TodoItem[]
}
