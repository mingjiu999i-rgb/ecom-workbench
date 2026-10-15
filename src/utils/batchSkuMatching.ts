import type { ProductCost } from '../types/models'

type CostChoice = Pick<ProductCost, 'id' | 'specification'>

// This matcher is only for the editable master-data batch import preview.
// Settlement/order matching and historical cost snapshots use their own rules.
function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase()
    .replace(/(\d)\s*[-—–−~～至到]\s*(?=\d)/g, '$1~')
    .replace(/最多人买|回购最多|试吃体验|首单推荐|净含量|净重|单果重|单果|单重/g, '')
    .replace(/\/\s*(?:个|颗)/g, '')
    .replace(/[\s【】\[\]（）()*/×·,，、_—–−-]/g, '')
}

const fruitGrade = /特大果|超大果|中大果|大果|中果|小果/g

function fruitKey(value: string): string | null {
  const grades = [...value.matchAll(fruitGrade)]
  const totals = [...value.matchAll(/(\d+(?:\.\d+)?)(公斤|千克|kg|斤)/g)]
  if (grades.length !== 1 || totals.length !== 1) return null
  const grade = grades[0][0]
  const total = totals[0]
  const remainder = value.replace(total[0], '').replace(grade, '')
  const weights = [...remainder.matchAll(/(\d+(?:\.\d+)?)(?:~(\d+(?:\.\d+)?))?(?:g|克)(\+|起|以上)?/g)]
  if (weights.length !== 1) return null
  const weight = weights[0]
  const lower = Number(weight[1])
  const upper = weight[2] ? Number(weight[2]) : null
  if (upper != null && (upper < lower || weight[3])) return null
  const totalGrams = Number(total[1]) * (total[2] === '斤' ? 500 : 1000)
  // In this fruit grade, "特大果(200g)" and "特大果 200g+" are
  // the same lower-bound label. Keep "+" significant for other grades.
  const bound = grade === '特大果' && upper == null && lower === 200 ? 'minimum' : weight[3] ? 'minimum' : 'exact'
  const residual = remainder.replace(weight[0], '')
  return JSON.stringify([totalGrams, grade, lower, upper, bound, residual])
}

function containsSpecification(name: string, spec: string): boolean {
  if (spec.length < 3) return false
  let index = name.indexOf(spec)
  while (index >= 0) {
    // Never match 125g inside 1125g, or 2袋 inside 12袋.
    const joinsNumber = index > 0 && /[\d.]/.test(name[index - 1]) && /^\d/.test(spec)
    const joinsSuffix = /\d$/.test(spec) && /[\d.]/.test(name[index + spec.length] || '')
    if (!joinsNumber && !joinsSuffix) return true
    index = name.indexOf(spec, index + 1)
  }
  return false
}

export function matchBatchSkuCost(name: string, costs: readonly CostChoice[]): string {
  const key = normalize(name)
  if (!key) return ''
  const fruit = fruitKey(key)
  const matches = costs.filter(cost => {
    const candidate = normalize(cost.specification)
    if (!candidate) return false
    const candidateFruit = fruitKey(candidate)
    if (fruit && candidateFruit) return fruit === candidateFruit
    if (key === candidate) return true
    // A missing or conflicting fruit dimension must not fall back to a
    // substring (e.g. 大果 within 特大果, or 1斤 within 0.5斤).
    if (/(?:特大果|超大果|中大果|大果|中果|小果)/.test(key + candidate)) return false
    return containsSpecification(key, candidate) || containsSpecification(candidate, key)
  })
  return matches.length === 1 ? matches[0].id : ''
}
