import type { Sku, SkuHistory } from '../types/models'

export function appendSkuHistory(history: SkuHistory[], before: Sku | undefined, after: Sku): SkuHistory[] {
  if (!before || (before.name === after.name && before.salePrice === after.salePrice)) return history
  const last = [...history].reverse().find(item => item.skuId === before.id)
  if (last?.name === before.name && last.salePrice === before.salePrice) return history
  return [...history, {
    id: `history-${crypto.randomUUID()}`,
    skuId: before.id,
    name: before.name,
    salePrice: before.salePrice,
    recordedAt: new Date().toISOString(),
  }]
}
