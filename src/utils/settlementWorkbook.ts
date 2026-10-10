import * as XLSX from 'xlsx-js-style'
import type { CollectionRecord, ProfitRecord, Store, WorkbenchData } from '../types/models'

type CellValue = string | number | Date | null
type CollectionTotal = Omit<CollectionRecord, 'id' | 'storeId' | 'date' | 'updatedAt'> & { date: string }

export type SettlementExportOptions = {
  clientId: string
  startDate?: string
  endDate?: string
}

const colors = {
  navy: '243B64', charcoal: '26323C', blue: '4F74D9', yellow: 'FFF200', teal: 'A8E3DF',
  paleBlue: 'E8EEF3', paleOrange: 'FFF6E5', paleTeal: 'EAF8F5', text: '263247', muted: '718096',
  line: 'DCE2EA', white: 'FFFFFF', green: '198A61', orange: 'B76B16', red: 'D7263D', gray: 'F5F7FA',
}
const moneyFormat = '#,##0.00;[Red]-#,##0.00'
const percentFormat = '0.00%'
const round = (value: number) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100
const sum = <T,>(rows: T[], getter: (row: T) => number) => round(rows.reduce((total, row) => total + Number(getter(row) || 0), 0))
const inRange = (date: string, startDate?: string, endDate?: string) => (!startDate || date >= startDate) && (!endDate || date <= endDate)
const monthKey = (date: string) => date.slice(0, 7)
const dateLabel = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`
const monthLabel = (month: string) => `${Number(month.slice(5))}月份数据`

const border = {
  top: { style: 'thin', color: { rgb: colors.line } },
  bottom: { style: 'thin', color: { rgb: colors.line } },
  left: { style: 'thin', color: { rgb: colors.line } },
  right: { style: 'thin', color: { rgb: colors.line } },
} as const

function safeFilename(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || '经营结算'
}

export function safeSheetName(value: string, used = new Set<string>()) {
  const base = (value.replace(/[\\/*?:[\]]/g, '').trim() || '店铺回款').slice(0, 31)
  let name = base
  let index = 2
  while (used.has(name)) {
    const suffix = `(${index})`
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`
    index += 1
  }
  used.add(name)
  return name
}

function combineCollections(rows: CollectionRecord[]): CollectionTotal | null {
  if (!rows.length) return null
  const missing = rows.reduce((total, row) => total + Number(row.missingCostOrders || 0), 0)
  const productCost = missing || rows.some(row => row.productCost == null) ? null : sum(rows, row => Number(row.productCost))
  const eligibleOrders = sum(rows, row => row.eligibleOrders)
  const settledOrders = sum(rows, row => row.settledOrders)
  const dates = rows.map(row => row.date).sort()
  const effectiveSales = sum(rows, row => row.effectiveSales)
  const promotionFee = sum(rows, row => row.promotionFee)
  const currentNet = sum(rows, row => row.currentNet)
  return {
    date: `${dates[0]} 至 ${dates[dates.length - 1]}`,
    orderCount: sum(rows, row => row.orderCount),
    originalSales: sum(rows, row => row.originalSales),
    effectiveSales,
    shippedRefund: sum(rows, row => row.shippedRefund),
    orderShippedRefund: sum(rows, row => row.orderShippedRefund ?? row.shippedRefund),
    couponRefund: sum(rows, row => row.couponRefund),
    basicServiceFee: sum(rows, row => row.basicServiceFee),
    afterSaleCompensation: sum(rows, row => row.afterSaleCompensation),
    smallPayment: sum(rows, row => row.smallPayment),
    appealReimbursement: sum(rows, row => row.appealReimbursement),
    productCost,
    promotionFee,
    estimatedProfit: productCost == null ? null : round(effectiveSales - productCost - promotionFee),
    currentNet,
    unsettledAmount: sum(rows, row => row.unsettledAmount),
    profit: productCost == null ? null : round(currentNet - productCost - promotionFee),
    eligibleOrders,
    settledOrders,
    completionRate: eligibleOrders ? settledOrders / eligibleOrders : 1,
    mature: rows.every(row => row.mature),
    missingCostOrders: missing,
    unknownFunds: sum(rows, row => row.unknownFunds),
  }
}

function aggregateProfitRows(rows: ProfitRecord[]) {
  const grouped = new Map<string, ProfitRecord>()
  rows.forEach(row => {
    const key = `${row.date}|${row.productId}`
    const current = grouped.get(key)
    if (!current) { grouped.set(key, { ...row }); return }
    current.amount = round(current.amount + row.amount)
    current.cost = round(current.cost + row.cost)
    current.grossProfit = round(current.grossProfit + row.grossProfit)
    current.promotion = round(current.promotion + row.promotion)
    current.operationFee = round(current.operationFee + row.operationFee)
    current.estimatedProfit = round(current.estimatedProfit + row.estimatedProfit)
    current.quantity = round(current.quantity + row.quantity)
    current.margin = current.amount ? current.estimatedProfit / current.amount : 0
  })
  return [...grouped.values()]
}

export function settlementExportIssues(data: WorkbenchData, options: SettlementExportOptions) {
  const storeIds = new Set(data.stores.filter(store => store.clientId === options.clientId).map(store => store.id))
  const collection = data.collectionRecords.filter(row => storeIds.has(row.storeId) && inRange(row.date, options.startDate, options.endDate))
  const profits = data.profitRecords.filter(row => storeIds.has(row.storeId) && inRange(row.date, options.startDate, options.endDate))
  const issues: string[] = []
  if (!collection.length) issues.push('所选甲方和日期范围内没有订单回款数据')
  const missingCost = collection.reduce((total, row) => total + Number(row.missingCostOrders || 0), 0)
  if (missingCost) issues.push(`还有 ${missingCost} 个订单未匹配成本`)
  const legacyRefundRows = collection.filter(row => row.refundBasis !== 'refund_completed_at').length
  if (legacyRefundRows) issues.push(`有 ${legacyRefundRows} 天仍是旧版售后口径，请重新导入对应店铺报表`)
  const profitByStoreDate = new Map<string, ProfitRecord[]>()
  profits.forEach(row => profitByStoreDate.set(`${row.storeId}|${row.date}`, [...(profitByStoreDate.get(`${row.storeId}|${row.date}`) || []), row]))
  const unsynced = collection.filter(row => {
    if (!row.effectiveSales && !row.productCost && !row.promotionFee) return false
    const productRows = profitByStoreDate.get(`${row.storeId}|${row.date}`) || []
    if (!productRows.length) return true
    return Math.abs(sum(productRows, item => item.amount) - row.effectiveSales) > 0.02
      || Math.abs(sum(productRows, item => item.cost) - Number(row.productCost || 0)) > 0.02
      || Math.abs(sum(productRows, item => item.promotion) - row.promotionFee) > 0.02
  })
  if (unsynced.length) issues.push(`有 ${unsynced.length} 天的产品利润数据尚未同步，请重新导入对应店铺报表`)
  return issues
}

function setCell(sheet: XLSX.WorkSheet, row: number, column: number, value: CellValue, style?: XLSX.CellStyle) {
  const address = XLSX.utils.encode_cell({ r: row, c: column })
  const cell: XLSX.CellObject = value instanceof Date
    ? { t: 'd', v: value }
    : typeof value === 'number' ? { t: 'n', v: value } : { t: 's', v: value == null ? '' : String(value) }
  if (style) cell.s = style
  sheet[address] = cell
}

function titleStyle(size = 16): XLSX.CellStyle {
  return { font: { name: 'Microsoft YaHei', sz: size, bold: true, color: { rgb: colors.text } }, alignment: { vertical: 'center' } }
}

const noteStyle: XLSX.CellStyle = { font: { name: 'Microsoft YaHei', sz: 9, italic: true, color: { rgb: colors.muted } }, alignment: { vertical: 'center', wrapText: true } }
const headerStyle: XLSX.CellStyle = {
  font: { name: 'Microsoft YaHei', sz: 10, bold: true, color: { rgb: colors.white } },
  fill: { patternType: 'solid', fgColor: { rgb: colors.navy } },
  alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, border,
}
const detailHeaderStyle: XLSX.CellStyle = { ...headerStyle, fill: { patternType: 'solid', fgColor: { rgb: colors.charcoal } } }
const bodyStyle: XLSX.CellStyle = { font: { name: 'Microsoft YaHei', sz: 10, color: { rgb: colors.text } }, alignment: { vertical: 'center' }, border }
const moneyStyle: XLSX.CellStyle = { ...bodyStyle, numFmt: moneyFormat, alignment: { horizontal: 'right', vertical: 'center' } }
const percentStyle: XLSX.CellStyle = { ...bodyStyle, numFmt: percentFormat, alignment: { horizontal: 'right', vertical: 'center' } }

function applyWhiteCanvas(sheet: XLSX.WorkSheet, lastRow: number, lastColumn: number) {
  for (let row = 0; row <= lastRow; row += 1) {
    for (let column = 0; column <= lastColumn; column += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: column })
      const cell = sheet[address] || (sheet[address] = { t: 's', v: '' })
      cell.s = { ...(cell.s || {}), fill: cell.s?.fill || { patternType: 'solid', fgColor: { rgb: colors.white } } }
    }
  }
}

function buildSummarySheet(data: WorkbenchData, clientId: string, stores: Store[], collections: CollectionRecord[], profits: ProfitRecord[], startDate: string, endDate: string) {
  const sheet = XLSX.utils.aoa_to_sheet([])
  const client = data.clients.find(item => item.id === clientId)
  setCell(sheet, 1, 0, `${client?.name || '甲方'}经营结算表`, titleStyle())
  setCell(sheet, 2, 0, `${startDate} 至 ${endDate}｜上方按店铺独立对账，下方按标准产品跨店铺合并｜数据截至本次导出时点`, noteStyle)
  const storeHeaders = ['店铺', '有效销售额', '货品成本', '推广费', '运营费', '预估利润', '本期发生\n已发货退款', '已发货退款率', '订单净回款', '未回款金额', '订单回款完成率', '状态']
  storeHeaders.forEach((label, column) => setCell(sheet, 4, column, label, headerStyle))
  const storeRows = stores.map(store => {
    const collectionRows = collections.filter(row => row.storeId === store.id)
    const total = combineCollections(collectionRows)
    const storeProfits = profits.filter(row => row.storeId === store.id)
    const operationFee = sum(storeProfits, row => row.operationFee)
    const estimatedProfit = sum(storeProfits, row => row.estimatedProfit)
    const status = !total ? '暂无数据' : total.mature ? '已完成' : total.settledOrders ? '回款中' : '待回款'
    return { store, total, operationFee, estimatedProfit, status }
  })
  let row = 5
  storeRows.forEach(item => {
    const total = item.total
    const values: CellValue[] = [item.store.name, total?.effectiveSales ?? '', total?.productCost ?? '', total?.promotionFee ?? '', item.operationFee || '', total ? item.estimatedProfit : '', total?.shippedRefund ?? '', total?.originalSales ? Number(total.orderShippedRefund || 0) / total.originalSales : 0, total?.currentNet ?? '', total?.unsettledAmount ?? '', total?.completionRate ?? 0, item.status]
    values.forEach((value, column) => setCell(sheet, row, column, value, column === 7 || column === 10 ? percentStyle : column >= 1 && column <= 9 ? moneyStyle : bodyStyle))
    row += 1
  })
  const clientTotal = combineCollections(collections)
  const totalOperationFee = sum(profits, item => item.operationFee)
  const totalEstimatedProfit = sum(profits, item => item.estimatedProfit)
  const clientStatus = !clientTotal ? '暂无数据' : clientTotal.mature ? '已完成' : clientTotal.settledOrders ? '回款中' : '待回款'
  const totalValues: CellValue[] = ['甲方合计', clientTotal?.effectiveSales ?? '', clientTotal?.productCost ?? '', clientTotal?.promotionFee ?? '', totalOperationFee || '', clientTotal ? totalEstimatedProfit : '', clientTotal?.shippedRefund ?? '', clientTotal?.originalSales ? Number(clientTotal.orderShippedRefund || 0) / clientTotal.originalSales : 0, clientTotal?.currentNet ?? '', clientTotal?.unsettledAmount ?? '', clientTotal?.completionRate ?? 0, clientStatus]
  totalValues.forEach((value, column) => setCell(sheet, row, column, value, { ...(column === 7 || column === 10 ? percentStyle : column >= 1 && column <= 9 ? moneyStyle : bodyStyle), font: { name: 'Microsoft YaHei', sz: 10, bold: true, color: { rgb: colors.text } }, fill: { patternType: 'solid', fgColor: { rgb: 'EDF2FF' } } }))
  row += 2
  setCell(sheet, row, 0, '说明', { ...bodyStyle, font: { name: 'Microsoft YaHei', sz: 9, bold: true, color: { rgb: colors.text } } })
  setCell(sheet, row, 1, '“本期发生已发货退款”按退款完成时间统计，包含历史订单退款；有效销售额和退款率仍按本期订单口径计算。', noteStyle)
  row += 2
  setCell(sheet, row, 0, '产品利润汇总', titleStyle(12))
  row += 1
  setCell(sheet, row, 0, '相同标准产品在不同店铺合并展示；有效销售额已反映本期订单退款。补收差价计入金额，不计销量和成本。', noteStyle)
  row += 2

  const aggregated = aggregateProfitRows(profits)
  const dates = [...new Set(aggregated.map(item => item.date))].sort()
  const months = [...new Set(dates.map(monthKey))]
  const columns: Array<{ type: 'date' | 'month'; key: string }> = []
  months.forEach(month => {
    dates.filter(date => date.startsWith(month)).forEach(date => columns.push({ type: 'date', key: date }))
    columns.push({ type: 'month', key: month })
  })
  const productIds = [...new Set(aggregated.map(item => item.productId))].sort((a, b) => {
    const nameA = data.products.find(item => item.id === a)?.name || '已删除产品'
    const nameB = data.products.find(item => item.id === b)?.name || '已删除产品'
    return nameA.localeCompare(nameB, 'zh-CN')
  })
  const metrics = [
    { label: '有效销售额', key: 'amount' as const, format: moneyFormat },
    { label: '货品成本', key: 'cost' as const, format: moneyFormat },
    { label: '商品毛利润', key: 'grossProfit' as const, format: moneyFormat },
    { label: '推广花费', key: 'promotion' as const, format: moneyFormat },
    { label: '运营费用预估', key: 'operationFee' as const, format: moneyFormat },
    { label: '预估利润', key: 'estimatedProfit' as const, format: moneyFormat },
    { label: '当天销量', key: 'quantity' as const, format: '#,##0.##' },
    { label: '毛利率', key: 'margin' as const, format: percentFormat },
  ]
  productIds.forEach((productId, productIndex) => {
    const start = row
    const productRows = aggregated.filter(item => item.productId === productId)
    setCell(sheet, start, 0, data.products.find(item => item.id === productId)?.name || '已删除产品', { ...headerStyle, font: { name: 'Microsoft YaHei', sz: 12, bold: true, color: { rgb: '000000' } }, fill: { patternType: 'solid', fgColor: { rgb: colors.yellow } } })
    setCell(sheet, start, 1, '日期', { ...headerStyle, font: { name: 'Microsoft YaHei', sz: 10, bold: true, color: { rgb: '000000' } }, fill: { patternType: 'solid', fgColor: { rgb: colors.yellow } } })
    columns.forEach((column, index) => setCell(sheet, start, index + 2, column.type === 'date' ? dateLabel(column.key) : monthLabel(column.key), { ...headerStyle, fill: { patternType: 'solid', fgColor: { rgb: column.type === 'month' ? colors.teal : colors.navy } }, font: { name: 'Microsoft YaHei', sz: 10, bold: true, color: { rgb: column.type === 'month' ? colors.text : colors.white } } }))
    metrics.forEach((metric, metricIndex) => {
      const metricRow = start + metricIndex + 1
      setCell(sheet, metricRow, 1, metric.label, { ...bodyStyle, font: { name: 'Microsoft YaHei', sz: 10, bold: true, color: { rgb: '000000' } }, fill: { patternType: 'solid', fgColor: { rgb: colors.yellow } } })
      columns.forEach((column, index) => {
        const selected = productRows.filter(item => column.type === 'date' ? item.date === column.key : monthKey(item.date) === column.key)
        let value: number | string = ''
        if (selected.length) {
          if (metric.key === 'margin') {
            const amount = sum(selected, item => item.amount)
            value = amount ? sum(selected, item => item.estimatedProfit) / amount : 0
          } else value = sum(selected, item => Number(item[metric.key]))
        }
        setCell(sheet, metricRow, index + 2, value, { ...bodyStyle, numFmt: metric.format, fill: column.type === 'month' ? { patternType: 'solid', fgColor: { rgb: colors.teal } } : undefined, font: { name: 'Microsoft YaHei', sz: 10, bold: column.type === 'month', color: { rgb: colors.text } }, alignment: { horizontal: 'center', vertical: 'center' } })
      })
    })
    sheet['!merges'] = [...(sheet['!merges'] || []), { s: { r: start, c: 0 }, e: { r: start + metrics.length, c: 0 } }]
    for (let metricRow = start + 1; metricRow <= start + metrics.length; metricRow += 1) setCell(sheet, metricRow, 0, '', { ...bodyStyle, fill: { patternType: 'solid', fgColor: { rgb: colors.yellow } } })
    row = start + metrics.length + (productIndex < productIds.length - 1 ? 3 : 1)
  })
  if (!productIds.length) setCell(sheet, row, 0, '暂无已同步的产品利润数据', { ...bodyStyle, fill: { patternType: 'solid', fgColor: { rgb: colors.gray } } })

  const lastColumn = Math.max(columns.length + 1, 11)
  const lastRow = Math.max(row, 10)
  applyWhiteCanvas(sheet, lastRow, lastColumn)
  sheet['!merges'] = [
    { s: { r: 1, c: 0 }, e: { r: 1, c: 11 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: 11 } },
    { s: { r: storeRows.length + 7, c: 1 }, e: { r: storeRows.length + 7, c: 11 } },
    { s: { r: storeRows.length + 9, c: 0 }, e: { r: storeRows.length + 9, c: lastColumn } },
    { s: { r: storeRows.length + 10, c: 0 }, e: { r: storeRows.length + 10, c: lastColumn } },
    ...(sheet['!merges'] || []),
  ]
  sheet['!cols'] = [{ wch: 19 }, { wch: 18 }, ...columns.map(column => ({ wch: column.type === 'month' ? 15 : 11 }))]
  sheet['!rows'] = Array.from({ length: Math.max(row + 1, 12) }, (_, index) => ({ hpt: index === 4 ? 34 : index === 1 ? 25 : 23 }))
  sheet['!freeze'] = { xSplit: 2, ySplit: 5, topLeftCell: 'C6', activePane: 'bottomRight', state: 'frozen' }
  sheet['!sheetViews'] = [{ showGridLines: false }]
  sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 1, c: 0 }, e: { r: lastRow, c: lastColumn } })
  return sheet
}

function buildDetailSheet(store: Store, rows: CollectionRecord[], startDate: string, endDate: string) {
  const sheet = XLSX.utils.aoa_to_sheet([])
  setCell(sheet, 1, 0, `${store.name}订单回款明细`, titleStyle())
  setCell(sheet, 2, 0, `本页只统计“${store.name}”。已发货退款按本期退款完成时间统计，包含历史订单退款；有效订单销售额仍按本期订单口径。`, noteStyle)
  const headers = ['店铺名称', '成交日期', '订单数', '订单成交额', '已发货退款', '优惠券退款', '有效订单销售额', '基础技术服务费', '售后补偿消费者', '小额打款', '申诉补回', '商品成本', '推广费', '预估盈亏', '订单净回款', '未回款金额', '当前盈亏']
  headers.forEach((label, column) => setCell(sheet, 5, column, label, detailHeaderStyle))
  const total = combineCollections(rows)
  const totalValues: CellValue[] = total
    ? [store.name, `${startDate} 至 ${endDate}`, total.orderCount, total.originalSales, total.shippedRefund, total.couponRefund, total.effectiveSales, total.basicServiceFee, total.afterSaleCompensation, total.smallPayment, total.appealReimbursement, total.productCost ?? '', total.promotionFee, total.estimatedProfit ?? '', total.currentNet, total.unsettledAmount, total.profit ?? '']
    : [store.name, '暂无该店铺数据', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']
  totalValues.forEach((value, column) => setCell(sheet, 6, column, value, { ...(column >= 3 ? moneyStyle : bodyStyle), font: { name: 'Microsoft YaHei', sz: 10, bold: true, color: { rgb: colors.text } }, fill: { patternType: 'solid', fgColor: { rgb: colors.paleBlue } } }))
  ;[...rows].sort((a, b) => b.date.localeCompare(a.date)).forEach((item, index) => {
    const values: CellValue[] = ['', item.date, item.orderCount, item.originalSales, item.shippedRefund, item.couponRefund, item.effectiveSales, item.basicServiceFee, item.afterSaleCompensation, item.smallPayment, item.appealReimbursement, item.productCost ?? '', item.promotionFee, item.estimatedProfit ?? '', item.currentNet, item.unsettledAmount, item.profit ?? '']
    values.forEach((value, column) => {
      const style = column >= 3 ? moneyStyle : bodyStyle
      setCell(sheet, index + 7, column, value, style)
    })
  })
  const lastRow = Math.max(rows.length + 6, 7)
  applyWhiteCanvas(sheet, lastRow, 16)
  sheet['!merges'] = [
    { s: { r: 1, c: 0 }, e: { r: 1, c: 16 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: 16 } },
  ]
  sheet['!cols'] = [22, 22, 11, 15, 15, 15, 17, 17, 17, 14, 14, 15, 15, 15, 15, 15, 15].map(wch => ({ wch }))
  sheet['!rows'] = Array.from({ length: Math.max(rows.length + 8, 9) }, (_, index) => ({ hpt: index === 5 ? 34 : index === 1 ? 25 : 23 }))
  sheet['!freeze'] = { xSplit: 2, ySplit: 6, topLeftCell: 'C7', activePane: 'bottomRight', state: 'frozen' }
  sheet['!sheetViews'] = [{ showGridLines: false }]
  sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 1, c: 0 }, e: { r: lastRow, c: 16 } })
  return sheet
}

export function createSettlementWorkbook(data: WorkbenchData, options: SettlementExportOptions) {
  const client = data.clients.find(item => item.id === options.clientId)
  if (!client) throw new Error('找不到所选甲方')
  const stores = data.stores.filter(store => store.clientId === options.clientId && store.storeStatus !== '暂停')
  const storeIds = new Set(stores.map(store => store.id))
  const collections = data.collectionRecords.filter(row => storeIds.has(row.storeId) && inRange(row.date, options.startDate, options.endDate))
  const profits = data.profitRecords.filter(row => storeIds.has(row.storeId) && inRange(row.date, options.startDate, options.endDate))
  const dates = collections.map(row => row.date).sort()
  const startDate = options.startDate || dates[0] || '最早'
  const endDate = options.endDate || dates[dates.length - 1] || '最新'
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, buildSummarySheet(data, options.clientId, stores, collections, profits, startDate, endDate), '甲方汇总')
  const used = new Set(['甲方汇总'])
  stores.forEach(store => XLSX.utils.book_append_sheet(workbook, buildDetailSheet(store, collections.filter(row => row.storeId === store.id), startDate, endDate), safeSheetName(`${store.name}回款`, used)))
  workbook.Workbook = workbook.Workbook || {}
  ;(workbook.Workbook as unknown as { CalcPr: { calcMode: string; fullCalcOnLoad: boolean; forceFullCalc: boolean } }).CalcPr = { calcMode: 'auto', fullCalcOnLoad: true, forceFullCalc: true }
  return workbook
}

export function exportSettlementWorkbook(data: WorkbenchData, options: SettlementExportOptions) {
  const issues = settlementExportIssues(data, options)
  if (issues.length) throw new Error(issues.join('；'))
  const clientName = data.clients.find(item => item.id === options.clientId)?.name || '甲方'
  const range = options.startDate || options.endDate ? `${options.startDate || '最早'}_${options.endDate || '最新'}` : '全部日期'
  XLSX.writeFile(createSettlementWorkbook(data, options), `${safeFilename(clientName)}_经营结算_${safeFilename(range)}.xlsx`)
}
