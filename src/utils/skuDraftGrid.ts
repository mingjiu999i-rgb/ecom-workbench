import type { WorkbenchData } from '../types/models'
import { getSkuPlanningDrafts, matchDraftCost, putSkuPlanningDraft, type SkuPlanningDraft } from './skuDrafts'

export type DraftGridRow = {
  id: string; name: string; productId: string; costId: string; cost: number | null
  priceA: string; roiA: string; priceB: string; baseUpdatedAt: string | null
}
export const draftGridColumns = ['name', 'costId', 'priceA', 'roiA', 'priceB'] as const
export type DraftGridColumn = typeof draftGridColumns[number]
export const blankDraftGridRow = (id: string, productId = ''): DraftGridRow => ({ id, productId, name: '', costId: '', cost: null, priceA: '', roiA: '', priceB: '', baseUpdatedAt: null })
export const toDraftGridRow = (row: SkuPlanningDraft): DraftGridRow => ({ ...row, priceA: String(row.priceA), roiA: row.roiA == null ? '' : String(row.roiA), priceB: row.priceB == null ? '' : String(row.priceB), baseUpdatedAt: row.updatedAt })
export const draftGridNumber = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return null
  const numeric = trimmed.replace(/^[¥￥]\s*/, '')
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d*)?$/.test(numeric)) return Number(numeric.replace(/,/g, ''))
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(numeric) ? Number(numeric) : NaN
}
export const isBlankDraftGridRow = (row: DraftGridRow) => row.baseUpdatedAt == null && !row.name.trim() && !row.costId && !row.priceA.trim() && !row.roiA.trim() && !row.priceB.trim()
export function chooseDraftGridCost(data: WorkbenchData, row: DraftGridRow, id: string): DraftGridRow {
  const cost = data.productCosts.find(item => item.id === id && item.productId === row.productId)
  return { ...row, costId: cost?.id || '', cost: cost && Number.isFinite(cost.totalCost) && cost.totalCost >= 0 ? cost.totalCost : null }
}
export function draftGridError(data: WorkbenchData, row: DraftGridRow) {
  if (!row.name.trim()) return '请填 SKU / 规格'
  if (!data.products.some(item => item.id === row.productId)) return '请选择所属产品'
  if (!data.productCosts.some(item => item.id === row.costId && item.productId === row.productId) || row.cost == null || !Number.isFinite(row.cost) || row.cost < 0) return '请选择有效成本'
  if (!(draftGridNumber(row.priceA)! > 0) || !Number.isFinite(draftGridNumber(row.priceA))) return 'A 售价须大于 0'
  if (row.roiA.trim() && (!(draftGridNumber(row.roiA)! > 0) || !Number.isFinite(draftGridNumber(row.roiA)))) return 'A ROI 须大于 0 或留空'
  if (row.priceB.trim() && (!(draftGridNumber(row.priceB)! > 0) || !Number.isFinite(draftGridNumber(row.priceB)))) return 'B 售价须大于 0 或留空'
  return ''
}

// Excel tab-delimited text, including quoted tabs/newlines and doubled quotes.
export function parseDraftGridPaste(text: string): string[][] {
  if (text.length > 500000) throw new Error('粘贴内容过大，请分批粘贴（最多 500 行）。')
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  const input = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (char === '"') {
      if (quoted && input[i + 1] === '"') { cell += '"'; i++ }
      else if (quoted || cell === '') quoted = !quoted
      else cell += char
    } else if (!quoted && (char === '\t' || char === '\n')) {
      row.push(cell); cell = ''
      if (char === '\n') { rows.push(row); row = [] }
    } else cell += char
  }
  if (quoted) throw new Error('粘贴内容的引号未闭合，请重新复制。')
  row.push(cell); rows.push(row)
  // Only remove the synthetic row after a final newline. Deliberately copied
  // blank cells/rows must still clear old optional inputs instead of disappearing.
  if (input.endsWith('\n')) rows.pop()
  if (!input) return []
  if (rows[0]?.[0].trim().match(/^(SKU(?:名称|\/规格)?|SKU 名称|SKU \/ 规格)$/i) && rows[0]?.[2]?.includes('售价')) rows.shift()
  if (rows.length > 500) throw new Error('单次最多粘贴 500 行，请分批操作。')
  return rows
}

export function pasteDraftGrid(data: WorkbenchData, rows: DraftGridRow[], startId: string, column: DraftGridColumn, text: string, defaultProductId: string, newId: () => string) {
  const matrix = parseDraftGridPaste(text)
  const offset = draftGridColumns.indexOf(column)
  if (matrix.some(row => row.length > draftGridColumns.length - offset)) throw new Error('列数超出范围。顺序：SKU / 规格、成本编码、A 售价、A 当前 ROI、B 售价。')
  const start = rows.findIndex(row => row.id === startId)
  if (start < 0) throw new Error('目标行不存在，请重试。')
  const next = [...rows]
  const touched: DraftGridRow[] = []
  matrix.forEach((values, index) => {
    const target = start + index
    const original = next[target] || blankDraftGridRow(newId(), defaultProductId)
    let updated = { ...original }
    let explicitCost: string | undefined
    values.forEach((value, col) => {
      const key = draftGridColumns[offset + col]
      if (key === 'costId') explicitCost = value.trim()
      else updated = { ...updated, [key]: value.trim() }
    })
    // Never carry another pasted SKU's old cost over silently.
    if (offset === 0 || explicitCost !== undefined) {
      const id = matchDraftCost(data, updated.productId, explicitCost || updated.name)
      updated = chooseDraftGridCost(data, updated, id)
    }
    next[target] = updated; touched.push(updated)
  })
  return { rows: next, touched }
}

export function saveDraftGrid(data: WorkbenchData, rows: DraftGridRow[], updatedAt: string) {
  const incoming = rows.filter(row => !isBlankDraftGridRow(row))
  const saved = getSkuPlanningDrafts(data)
  for (const row of incoming) {
    const error = draftGridError(data, row)
    if (error) throw new Error(`${row.name || '未命名行'}：${error}，本次未保存任何行。`)
    const current = saved.find(item => item.id === row.id)
    if ((current?.updatedAt ?? null) !== row.baseUpdatedAt) throw new Error(`${row.name} 已被其他操作修改，请先放弃本页修改并重新核对；本次未保存任何行。`)
  }
  return incoming.reduce((next, row) => putSkuPlanningDraft(next, {
    id: row.id, name: row.name.trim(), productId: row.productId, costId: row.costId, cost: row.cost!,
    priceA: draftGridNumber(row.priceA)!, roiA: draftGridNumber(row.roiA), priceB: draftGridNumber(row.priceB), updatedAt,
  }), data)
}
