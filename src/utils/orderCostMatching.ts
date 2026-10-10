import type { Product, ProductCost } from '../types/models'

export type CostOrder = {
  product: string
  specification: string
  skuCode: string
}

export type ProductCostMatch = {
  cost: number
  productId: string
  product: string
  specification: string
  skuCode: string
  source: 'SKU 编码' | '售卖规格' | '手动填写'
}

export const normalizeSpecification = (value: string) => value.toLowerCase().replace(/[\s【】\[\]（）()*/×·,，+＋_—–-]/g, '')
export const isSupplementOrder = (order: CostOrder) => `${order.product}|${order.specification}|${order.skuCode}`.includes('补收差价')

export function resolveProductCost(order: CostOrder, costs: ProductCost[], products: Product[], linkedProductId = '', manualCostId = ''): ProductCostMatch | undefined {
  if (isSupplementOrder(order)) return undefined
  const scoped = linkedProductId ? costs.filter(cost => cost.productId === linkedProductId) : costs
  const exact = scoped.filter(cost => order.skuCode && cost.skuCode.trim() === order.skuCode.trim())
  let matched = exact.length === 1 ? exact[0] : undefined
  let source: ProductCostMatch['source'] = 'SKU 编码'
  if (!matched) {
    const specification = normalizeSpecification(order.specification)
    const specificationMatches = scoped.filter(cost => {
      const candidate = normalizeSpecification(cost.specification)
      return candidate.length >= 2 && specification.length >= 2 && (specification.includes(candidate) || candidate.includes(specification))
    })
    if (specificationMatches.length === 1) { matched = specificationMatches[0]; source = '售卖规格' }
  }
  if (!matched && manualCostId) {
    matched = costs.find(cost => cost.id === manualCostId)
    source = '手动填写'
  }
  if (!matched) return undefined
  return {
    cost: Number(matched.totalCost),
    productId: matched.productId,
    product: products.find(product => product.id === matched?.productId)?.name || '未关联商品',
    specification: matched.specification,
    skuCode: matched.skuCode,
    source,
  }
}
