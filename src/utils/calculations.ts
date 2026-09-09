import type { Sku } from '../types/models'

const safe = (value: number) => Number.isFinite(value) ? value : 0
export const totalCost = (sku: Sku) => safe(sku.productCost) + safe(sku.shippingCost) + safe(sku.packagingCost) + safe(sku.otherCost)
export const grossProfit = (sku: Sku) => safe(sku.finalPrice) - totalCost(sku)
export const grossMargin = (sku: Sku) => sku.finalPrice > 0 ? (grossProfit(sku) / sku.finalPrice) * 100 : 0
export const calculatedBreakEvenRoi = (salePrice: number, cost: number) => {
  const profit = safe(salePrice) - safe(cost)
  return profit > 0 ? safe(salePrice) / profit : 0
}
export const money = (value: number) => `¥${safe(value).toFixed(2)}`
export const percent = (value: number) => `${safe(value).toFixed(1)}%`
