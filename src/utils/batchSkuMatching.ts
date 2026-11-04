import type { ProductCost } from '../types/models'

type CostChoice = Pick<ProductCost, 'id' | 'specification'>

// This matcher is only for editable SKU setup/planning previews.
// Settlement/order matching and historical cost snapshots use their own rules.
function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase()
    .replace(/(\d)\s*[-—–−~～至到]\s*(?=\d)/g, '$1~')
    .replace(/最多人买|回购最多|试吃体验|首单推荐|粉糯香甜真好吃|净含量|净重|单果重|单果|单重/g, '')
    .replace(/\/\s*(?:个|颗)/g, '')
    .replace(/[\s【】\[\]（）()*/×·,，、_—–−-]/g, '')
    .replace(/约(?=\d)/g, '')
}

const fruitGrade = /特大果|超大果|中大果|大果|中果|小果/g

function countFruitKey(raw: string): string | null {
  const value = normalize(raw)
  const totals = [...value.matchAll(/(\d+(?:\.\d+)?)(公斤|千克|kg|斤)/g)]
  const suffixCounts = [...value.matchAll(/(\d+(?:\.\d+)?)(?:~(\d+(?:\.\d+)?))?(?:个|颗)(?:每)?(公斤|千克|kg|斤)/g)]
    .map(match => ({ text: match[0], lower: Number(match[1]), upper: Number(match[2] || match[1]), unit: match[3] }))
  const prefixCounts = [...value.matchAll(/每(公斤|千克|kg|斤)(\d+(?:\.\d+)?)(?:~(\d+(?:\.\d+)?))?(?:个|颗)/g)]
    .map(match => ({ text: match[0], lower: Number(match[2]), upper: Number(match[3] || match[2]), unit: match[1] }))
  const counts = [...suffixCounts, ...prefixCounts]
  if (totals.length !== 1 || counts.length !== 1) return null
  const total = totals[0], count = counts[0]
  if (Number(total[1]) <= 0 || count.lower <= 0 || count.upper < count.lower || !Number.isInteger(count.lower) || !Number.isInteger(count.upper)) return null
  // Prefer the headline grade: "中果（小果 约4-6个/斤）" has a
  // copied descriptor inside brackets, but its headline grade is still 中果.
  const headline = normalize(raw.normalize('NFKC').replace(/\([^)]*\)|\[[^\]]*\]|【[^】]*】/g, ''))
  const headlineGrades = [...headline.matchAll(fruitGrade)]
  const grades = headlineGrades.length ? headlineGrades : [...value.matchAll(fruitGrade)]
  // 大果/中大果 are treated alike only when total weight AND the explicit
  // count interval agree. The gram-weight matcher keeps its stricter grades.
  const gradeKeys = new Set(grades.map(match => match[0] === '中大果' ? '大果' : match[0]))
  if (gradeKeys.size !== 1) return null
  const totalGrams = Number(total[1]) * (total[2] === '斤' ? 500 : 1000)
  const countBasisGrams = count.unit === '斤' ? 500 : 1000
  const residual = value.replace(total[0], '').replace(count.text, '').replace(fruitGrade, '')
  return JSON.stringify([totalGrams, [...gradeKeys][0], count.lower, count.upper, countBasisGrams, residual])
}

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
  const countedFruit = countFruitKey(name)
  const matches = costs.filter(cost => {
    const candidate = normalize(cost.specification)
    if (!candidate) return false
    const countedCandidate = countFruitKey(cost.specification)
    if (countedFruit || countedCandidate) return countedFruit != null && countedFruit === countedCandidate
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
