import type { WorkbenchData } from '../types/models'
import { matchBatchSkuCost } from './batchSkuMatching'

// Planning only. These records never participate in settlement or SKU updates.
export type SkuPlanningDraft = {
  id: string; name: string; productId: string; costId: string; cost: number
  priceA: number; roiA: number | null; priceB: number | null; updatedAt: string
}
type PlanningData = WorkbenchData & { skuPlanningDrafts?: SkuPlanningDraft[] }

export function getSkuPlanningDrafts(data: WorkbenchData): SkuPlanningDraft[] {
  return Array.isArray((data as PlanningData).skuPlanningDrafts) ? (data as PlanningData).skuPlanningDrafts! : []
}
export function putSkuPlanningDraft(data: WorkbenchData, draft: SkuPlanningDraft): WorkbenchData {
  const drafts = getSkuPlanningDrafts(data)
  return { ...data, skuPlanningDrafts: drafts.some(row => row.id === draft.id)
    ? drafts.map(row => row.id === draft.id ? { ...draft } : row) : [...drafts, { ...draft }] } as PlanningData
}
export function removeSkuPlanningDraft(data: WorkbenchData, id: string): WorkbenchData {
  return { ...data, skuPlanningDrafts: getSkuPlanningDrafts(data).filter(row => row.id !== id) } as PlanningData
}
export function matchDraftCost(data: WorkbenchData, productId: string, name: string) {
  const costs = data.productCosts.filter(row => row.productId === productId)
  const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase()
  const code = normalize(name)
  const exactCodes = code ? costs.filter(row => normalize(row.skuCode) === code) : []
  if (exactCodes.length) return exactCodes.length === 1 ? exactCodes[0].id : ''
  return matchBatchSkuCost(name, costs)
}

const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const positive = (value: unknown): value is number => nonnegative(value) && value > 0
export const roiSetting = (value: number) => Math.ceil(value * 100 - Number.EPSILON * 16 * Math.max(1, Math.abs(value * 100))) / 100
export function calculateSkuDraft(input: { cost: number | null; priceA: number | null; roiA?: number | null; priceB?: number | null }) {
  const { cost, priceA, roiA, priceB } = input
  const baseValid = nonnegative(cost) && positive(priceA)
  const grossProfit = baseValid ? priceA - cost : null
  const grossMargin = baseValid ? (priceA - cost) / priceA : null
  const breakEvenRoi = baseValid && priceA > cost ? priceA / (priceA - cost) : null
  const adCostA = baseValid && positive(roiA) ? priceA / roiA : null
  const profitA = adCostA != null && baseValid ? priceA - cost - adCostA : null
  const marginA = profitA != null && positive(priceA) ? profitA / priceA : null
  let targetState: 'waiting' | 'ready' | 'no-ad-spend' | 'unreachable' = 'waiting'
  let targetRoi: number | null = null
  let suggestedRoi: number | null = null
  let profitB: number | null = null
  let marginB: number | null = null
  if (baseValid && positive(roiA) && positive(priceB) && marginA != null) {
    // B's allowed advertising spend at A's profit margin. Work at full
    // precision; only the suggested setting is rounded UP to two decimals.
    const budget = priceB / roiA + cost * (priceB / priceA - 1)
    const tolerance = Number.EPSILON * 16 * Math.max(1, priceB / roiA, cost, priceB)
    if (budget < -tolerance) targetState = 'unreachable'
    else if (budget <= tolerance) targetState = 'no-ad-spend'
    else {
      targetRoi = priceB / budget
      suggestedRoi = roiSetting(targetRoi)
      profitB = priceB - cost - priceB / suggestedRoi
      marginB = profitB / priceB
      targetState = 'ready'
    }
  }
  return { baseValid, grossProfit, grossMargin, breakEvenRoi, adCostA, profitA, marginA,
    targetState, targetRoi, suggestedRoi, profitB, marginB }
}
