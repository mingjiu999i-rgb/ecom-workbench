import * as XLSX from 'xlsx-js-style'
import type { CollectionRecord, ProfitRecord, Store, WorkbenchData } from '../types/models'
import { initialCollectionProfit, initialProductProfit, initialStoreProductProfit } from './profitBaselines'

const note = '新记录的初始预估盈亏不扣已发货退款，记录后固定；最新盈亏随导入报表的退款回填更新。其他成本费用沿用原口径；历史初始值保留，未记录的不补算。'
const format = '#,##0.00;[Red]-#,##0.00'
function cell(sheet: XLSX.WorkSheet, row: number, column: number, value: string | number, template: XLSX.CellObject) {
  sheet[XLSX.utils.encode_cell({ r: row, c: column })] = { t: typeof value === 'number' ? 'n' : 's', v: value, s: { ...template.s, numFmt: typeof value === 'number' ? format : undefined } }
}
function extend(sheet: XLSX.WorkSheet, column: number, headerRow: number) {
  const range = XLSX.utils.decode_range(sheet['!ref']!)
  range.e.c = Math.max(range.e.c, column)
  sheet['!ref'] = XLSX.utils.encode_range(range)
  sheet['!cols'] = [...(sheet['!cols'] || []), { wch: 20 }]
  for (const merge of sheet['!merges'] || []) if (merge.s.c === 0 && merge.s.r < headerRow) merge.e.c = column
}
const shown = (value: number | null) => value == null ? '未记录' : value
const savedTotal = (rows: ProfitRecord[], field: 'cost' | 'promotion' | 'operationFee' | 'quantity'): number | null =>
  rows.length && rows.every(row => Number.isFinite(row[field]))
    ? Math.round((rows.reduce((total, row) => total + row[field], 0) + Number.EPSILON) * 100) / 100 : null

// A single-product client's saved store-day records can present a complete
// comparison even when the historical per-order product index is incomplete.
// This only prepares export cells; it never changes any saved accounting data.
function singleProductDisplay(selected: ProfitRecord[], collections: CollectionRecord[]) {
  if (!selected.length || selected.length !== collections.length) return null
  const byStoreDay = new Map(collections.map(row => [`${row.storeId}|${row.date}`, row]))
  if (byStoreDay.size !== collections.length) return null
  const byDate = new Map<string, { effective: number; productEffective: number; cost: number; productCost: number; promotion: number; productPromotion: number }>()
  let quantity = 0
  let quantityProxy = false
  for (const item of selected) {
    const collection = byStoreDay.get(`${item.storeId}|${item.date}`)
    if (!collection || ![item.amount, item.cost, item.promotion, item.operationFee,
      collection.originalSales, collection.effectiveSales, collection.productCost, collection.promotionFee,
      collection.shippedRefund, collection.couponRefund, collection.basicServiceFee,
      collection.afterSaleCompensation, collection.smallPayment].every(Number.isFinite)) return null
    const current = byDate.get(item.date) || { effective: 0, productEffective: 0, cost: 0, productCost: 0, promotion: 0, productPromotion: 0 }
    current.effective += collection.effectiveSales
    current.productEffective += item.amount
    current.cost += Number(collection.productCost)
    current.productCost += item.cost
    current.promotion += collection.promotionFee
    current.productPromotion += item.promotion
    byDate.set(item.date, current)
    if (Number.isFinite(item.quantity)) quantity += item.quantity
    else if (Number.isFinite(collection.orderCount)) { quantity += collection.orderCount; quantityProxy = true }
    else return null
  }
  if (byDate.size === 0 || [...byDate.values()].some(day =>
    Math.abs(day.cost - day.productCost) > 0.02 || Math.abs(day.promotion - day.productPromotion) > 0.02
    || Math.abs(day.effective - day.productEffective) > Math.min(50, Math.abs(day.effective) * 0.005))) return null
  const amount = (rows: CollectionRecord[], field: keyof CollectionRecord) => Math.round((rows.reduce((total, row) => total + Number(row[field]), 0) + Number.EPSILON) * 100) / 100
  const orderSales = amount(collections, 'originalSales')
  const cost = savedTotal(selected, 'cost')!
  const promotion = savedTotal(selected, 'promotion')!
  const operationFee = savedTotal(selected, 'operationFee')!
  const deduction = Math.round((collections.reduce((total, row) => total + row.shippedRefund + row.couponRefund + row.basicServiceFee + row.afterSaleCompensation + row.smallPayment, 0) + Number.EPSILON) * 100) / 100
  const grossProfit = Math.round((orderSales - cost + Number.EPSILON) * 100) / 100
  const initialProfit = Math.round((grossProfit - promotion - operationFee + Number.EPSILON) * 100) / 100
  const latestProfit = Math.round((initialProfit - deduction + Number.EPSILON) * 100) / 100
  return { grossProfit, initialProfit, initialMargin: orderSales ? initialProfit / orderSales : null,
    deduction, latestProfit, latestMargin: orderSales ? latestProfit / orderSales : null,
    quantity: Math.round((quantity + Number.EPSILON) * 100) / 100, quantityProxy }
}

// Presentation extension only. Existing workbook amounts and calculations are untouched.
export function appendProfitBaselineDisplay(workbook: XLSX.WorkBook, data: WorkbenchData, stores: Store[], collections: CollectionRecord[], profits: ProfitRecord[]) {
  const preview = workbook.Sheets['产品预览']
  const dates = [...new Set(profits.map(row => row.date))].sort()
  const columns = [...new Set(dates.map(date => date.slice(0, 7)))].flatMap(month => [
    ...dates.filter(date => date.startsWith(month)).map(date => ({ key: date, month: false })), { key: month, month: true },
  ])
  const productIds = [...new Set(profits.map(row => row.productId))].sort((a, b) =>
    (data.products.find(row => row.id === a)?.name || '已删除产品').localeCompare(data.products.find(row => row.id === b)?.name || '已删除产品', 'zh-CN'))
  const effectiveRows = Object.keys(preview).filter(address => /^B\d+$/.test(address) && preview[address]?.v === '有效销售额（历史）')
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
  if (effectiveRows.length !== productIds.length) throw new Error('产品预览有效销售额行与产品数据不一致')
  const singleProduct = productIds.length === 1
  effectiveRows.forEach((address, productIndex) => {
    const row = Number(address.slice(1)) - 1
    preview[address].v = '有效销售额'
    if (singleProduct) preview[XLSX.utils.encode_cell({ r: row - 9, c: 1 })].v = '店铺成交额（对照）'
    columns.forEach((column, columnIndex) => {
      const target = XLSX.utils.encode_cell({ r: row, c: columnIndex + 2 })
      const selected = profits.filter(item => item.productId === productIds[productIndex] && (column.month ? item.date.startsWith(column.key) : item.date === column.key))
      // The original preview marks every date/month with unindexed product
      // rows in this cell. Saved metrics remain visible, while calculations
      // based on only the indexed subset must not look like full-day results.
      const hasUnindexedRows = preview[target]?.v !== '' && preview[target]?.v != null
      if (hasUnindexedRows) {
        for (const offset of [-7, -3, -2, -1, 1, 2]) {
          const metricAddress = XLSX.utils.encode_cell({ r: row + offset, c: columnIndex + 2 })
          const template = preview[metricAddress]
          preview[metricAddress] = { t: 's', v: '', s: template.s }
        }
        for (const [offset, field] of [[-8, 'cost'], [-6, 'promotion'], [-5, 'operationFee'], [-4, 'quantity']] as const) {
          const metricAddress = XLSX.utils.encode_cell({ r: row + offset, c: columnIndex + 2 })
          const value = savedTotal(selected, field)
          const template = preview[metricAddress]
          preview[metricAddress] = { t: value == null ? 's' : 'n', v: value ?? '', s: template.s }
        }
        if (singleProduct) {
          const source = collections.filter(item => column.month ? item.date.startsWith(column.key) : item.date === column.key)
          const display = singleProductDisplay(selected, source)
          if (display) {
            for (const [offset, field] of [[-7, 'grossProfit'], [-3, 'initialProfit'], [-2, 'initialMargin'], [-1, 'deduction'], [1, 'latestProfit'], [2, 'latestMargin']] as const) {
              const metricAddress = XLSX.utils.encode_cell({ r: row + offset, c: columnIndex + 2 })
              const template = preview[metricAddress]
              const value = display[field]
              preview[metricAddress] = { t: value == null ? 's' : 'n', v: value ?? '', s: {
                ...template.s, fill: { patternType: 'solid', fgColor: { rgb: 'FFF6E5' } },
              } }
            }
            if (display.quantityProxy) {
              const metricAddress = XLSX.utils.encode_cell({ r: row - 4, c: columnIndex + 2 })
              const template = preview[metricAddress]
              preview[metricAddress] = { t: 'n', v: display.quantity, s: {
                ...template.s, numFmt: '#,##0.##"*"', fill: { patternType: 'solid', fgColor: { rgb: 'FFF6E5' } },
              } }
            }
          }
        }
        if (!singleProduct) {
          const metricAddress = XLSX.utils.encode_cell({ r: row - 9, c: columnIndex + 2 })
          const template = preview[metricAddress]
          preview[metricAddress] = { t: 's', v: '', s: template.s }
        }
      }
      if (singleProduct) {
        const metricAddress = XLSX.utils.encode_cell({ r: row - 9, c: columnIndex + 2 })
        const source = collections.filter(item => column.month ? item.date.startsWith(column.key) : item.date === column.key)
        const value = source.length && source.every(item => Number.isFinite(item.originalSales))
          ? Math.round((source.reduce((total, item) => total + item.originalSales, 0) + Number.EPSILON) * 100) / 100 : null
        const template = preview[metricAddress]
        preview[metricAddress] = { t: value == null ? 's' : 'n', v: value ?? '', s: template.s }
      }
      const value = selected.length && selected.every(item => Number.isFinite(item.amount))
        ? Math.round((selected.reduce((total, item) => total + item.amount, 0) + Number.EPSILON) * 100) / 100 : ''
      cell(preview, row, columnIndex + 2, value, preview[target])
    })
  })
  preview.A2.v = String(preview.A2.v).replace('无完整订单索引的历史数据只显示有效销售额（历史），与新口径月汇总分开。',
    '有效销售额、成本、推广费、运营费和销量展示已保存的产品数据。只有一个产品时，店铺订单成交额为各店已保存成交额的对照合计；保存的店铺与产品成本、推广费和有效销售额通过核对后，利润与退款指标按店铺回款明细及已保存产品指标展示，浅黄色格表示该展示口径，带*的销量以订单数暂代。多产品或来源不完整时，依赖逐单归属的指标留空，不以零代替。产品有效销售额与店铺回款如有差额，需核对原订单。')
  const summary = workbook.Sheets['总览']
  summary.F5.v = '最新盈亏'
  cell(summary, 4, 12, '初始预估盈亏', summary.F5)
  stores.forEach((store, index) => cell(summary, index + 5, 12,
    shown(initialStoreProductProfit(data, collections.filter(row => row.storeId === store.id))), summary[`F${index + 6}`]))
  cell(summary, stores.length + 5, 12, shown(initialStoreProductProfit(data, collections)), summary[`F${stores.length + 6}`])
  summary.A3.v = `${summary.A3.v}｜${note}`
  if (summary['!rows']?.[2]) summary['!rows'][2] = { hpt: 55 }
  summary.A3.s = { ...summary.A3.s, alignment: { vertical: 'center', wrapText: true } }
  extend(summary, 12, 4)

  stores.forEach((store, index) => {
    const sheet = workbook.Sheets[workbook.SheetNames[index + 2]]
    const rows = collections.filter(row => row.storeId === store.id).sort((a, b) => b.date.localeCompare(a.date))
    sheet.N6.v = '最新盈亏'
    cell(sheet, 5, 18, '初始预估盈亏', sheet.N6)
    cell(sheet, 6, 18, shown(initialCollectionProfit(data, rows)), sheet.N7)
    rows.forEach((row, offset) => cell(sheet, offset + 7, 18, shown(initialCollectionProfit(data, [row])), sheet[`N${offset + 8}`]))
    sheet.A3.v = `${sheet.A3.v}｜${note}`
    if (sheet['!rows']?.[2]) sheet['!rows'][2] = { hpt: 55 }
    extend(sheet, 18, 5)
  })

  if (!data.profitBaselines?.length) return
  const baselineRows: Array<Array<string | number>> = [
    ['初始预估盈亏快照'],
    [note],
    [],
    ['产品', ...columns.map(column => column.month ? `${column.key} 汇总` : column.key)],
    ...productIds.map(productId => [
      data.products.find(row => row.id === productId)?.name || '已删除产品',
      ...columns.map(column => {
      const rows = profits.filter(row => row.productId === productId && (column.month ? row.date.startsWith(column.key) : row.date === column.key))
        return rows.length ? shown(initialProductProfit(data, rows)) : ''
      }),
    ]),
  ]
  const baselineSheet = XLSX.utils.aoa_to_sheet(baselineRows)
  baselineSheet['!cols'] = [{ wch: 30 }, ...columns.map(() => ({ wch: 18 }))]
  XLSX.utils.book_append_sheet(workbook, baselineSheet, '初始利润基线')
}
