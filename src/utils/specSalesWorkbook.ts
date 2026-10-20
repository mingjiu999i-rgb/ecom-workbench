import * as XLSX from 'xlsx-js-style'
import type { WorkbenchData } from '../types/models'
import { specSalesBasis, summarizeSpecSales, type SpecSalesFilter } from './specSales'

// Append only below the original financial canvas. All existing cells, styles,
// merges, widths, panes and financial worksheets remain untouched.
export function appendSpecSales(sheet: XLSX.WorkSheet, data: WorkbenchData, filter: SpecSalesFilter) {
  const report = summarizeSpecSales(data, filter)
  const oldRange = XLSX.utils.decode_range(sheet['!ref'] || 'A1:L1')
  let row = oldRange.e.r + 2
  const border = { bottom: { style: 'thin' as const, color: { rgb: 'DCE2EA' } } }
  const base: XLSX.CellStyle = { font: { name: 'Microsoft YaHei', sz: 10, color: { rgb: '263247' } }, alignment: { vertical: 'center', wrapText: true }, fill: { patternType: 'solid', fgColor: { rgb: 'FFFFFF' } }, border }
  const put = (column: number, value: string | number, style: XLSX.CellStyle = base) => {
    sheet[XLSX.utils.encode_cell({ r: row, c: column })] = { t: typeof value === 'number' ? 'n' : 's', v: value, s: style }
  }
  const merges = sheet['!merges'] || (sheet['!merges'] = [])
  const heights = sheet['!rows'] || (sheet['!rows'] = [])
  const full = (message: string, warning = false) => {
    put(0, message, { ...base, font: { ...base.font, color: { rgb: warning ? 'B76B16' : '718096' }, sz: 9 } })
    merges.push({ s: { r: row, c: 0 }, e: { r: row, c: 11 } }); heights[row] = { hpt: 34 }; row++
  }
  put(0, '各店铺规格销量', { ...base, font: { ...base.font, bold: true, sz: 14 } })
  merges.push({ s: { r: row, c: 0 }, e: { r: row, c: 11 } }); heights[row++] = { hpt: 28 }
  full(`${filter.startDate || '全部起始日期'} 至 ${filter.endDate || '全部结束日期'}。${specSalesBasis}`)
  if (!report.complete) full('规格资料不完整：以下仅展示可识别的规格；不能作为完整销量，待补数据不按 0 处理。', true)
  report.warnings.forEach(message => full(message, true))
  const spans = [[0, 0], [1, 3], [4, 8], [9, 11]]
  const cells = (values: Array<string | number>, header = false) => {
    values.forEach((value, index) => {
      const [start, end] = spans[index]
      put(start, value, { ...base, ...(index === 1 ? { numFmt: '@' } : {}), ...(index === 3 ? { numFmt: '#,##0', alignment: { horizontal: 'right', vertical: 'center' } } : {}), ...(header ? { font: { ...base.font, bold: true, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: '243B64' } }, alignment: { horizontal: 'center', vertical: 'center' } } : {}) })
      if (start !== end) merges.push({ s: { r: row, c: start }, e: { r: row, c: end } })
    })
    heights[row] = { hpt: header ? 28 : 34 }; row++
  }
  cells(['店铺', '规格维度编码', '售卖规格', '总数量（件）'], true)
  report.rows.forEach(item => cells([data.stores.find(store => store.id === item.storeId)?.name || item.storeId, item.skuCode, item.specification, item.quantity ?? '待补数据']))
  if (!report.rows.length) full(report.complete ? '所选范围暂无可统计的规格销量。' : '暂无完整规格明细，请补导包含“商家编码-规格维度”“商品规格”“商品数量(件)”的原订单报表。', !report.complete)
  for (let addedRow = oldRange.e.r + 1; addedRow < row; addedRow++) {
    for (let column = 0; column <= 11; column++) {
      const address = XLSX.utils.encode_cell({ r: addedRow, c: column })
      if (!sheet[address]) sheet[address] = { t: 's', v: '', s: { fill: { patternType: 'solid', fgColor: { rgb: 'FFFFFF' } } } }
    }
  }
  sheet['!ref'] = XLSX.utils.encode_range({ s: oldRange.s, e: { r: row - 1, c: Math.max(11, oldRange.e.c) } })
}
