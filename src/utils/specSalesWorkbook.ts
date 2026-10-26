import * as XLSX from 'xlsx-js-style'
import type { WorkbenchData } from '../types/models'
import { summarizeSpecSales, type SpecSalesFilter } from './specSales'

export function specSalesYesterdayFilter(filter: SpecSalesFilter, now = new Date()): SpecSalesFilter {
  const yesterday = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now.getTime() - 24 * 60 * 60 * 1000))
  return { clientId: filter.clientId, startDate: yesterday, endDate: yesterday }
}

// Append only below the original financial canvas. All existing cells, styles,
// merges, widths, panes and financial worksheets remain untouched.
export function appendSpecSales(sheet: XLSX.WorkSheet, data: WorkbenchData, filter: SpecSalesFilter) {
  // This section always shows yesterday, independently of the financial range.
  const reportFilter = specSalesYesterdayFilter(filter)
  const report = summarizeSpecSales(data, reportFilter)
  const oldRange = XLSX.utils.decode_range(sheet['!ref'] || 'A1:L1')
  let row = oldRange.e.r + 2
  const lastColumn = 3
  const base: XLSX.CellStyle = { font: { name: 'Microsoft YaHei', sz: 10, color: { rgb: '263247' } }, alignment: { horizontal: 'left', vertical: 'center', wrapText: true }, fill: { patternType: 'solid', fgColor: { rgb: 'FFFFFF' } } }
  const put = (column: number, value: string | number, style: XLSX.CellStyle = base) => {
    sheet[XLSX.utils.encode_cell({ r: row, c: column })] = { t: typeof value === 'number' ? 'n' : 's', v: value, s: style }
  }
  const merges = sheet['!merges'] || (sheet['!merges'] = [])
  const heights = sheet['!rows'] || (sheet['!rows'] = [])
  const full = (message: string, warning = false) => {
    put(0, message, { ...base, font: { ...base.font, color: { rgb: warning ? 'B76B16' : '718096' }, sz: 9 } })
    merges.push({ s: { r: row, c: 0 }, e: { r: row, c: lastColumn } }); heights[row] = { hpt: 34 }; row++
  }
  put(0, '规格销量汇总', { ...base, font: { ...base.font, bold: true, sz: 14 } })
  merges.push({ s: { r: row, c: 0 }, e: { r: row, c: lastColumn } }); heights[row++] = { hpt: 28 }
  full(`昨日 ${reportFilter.startDate}，相同规格编码跨店合计。`)
  if (!report.complete) full('部分历史订单缺少可核对的编码、日期、件数或状态，当前销量不完整；待补数据不按 0 处理。', true)
  const spans = [[0, 0], [1, 2], [3, 3]]
  const cells = (values: Array<string | number>, header = false) => {
    values.forEach((value, index) => {
      const [start, end] = spans[index]
      const style: XLSX.CellStyle = { ...base, ...(index === 0 ? { numFmt: '@' } : {}), ...(index === 2 ? { numFmt: '#,##0' } : {}), ...(header ? { font: { ...base.font, bold: true, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: '243B64' } } } : {}) }
      for (let column = start; column <= end; column++) put(column, column === start ? value : '', style)
      if (start !== end) merges.push({ s: { r: row, c: start }, e: { r: row, c: end } })
    })
    heights[row] = { hpt: header ? 28 : 23 }; row++
  }
  cells(['规格编码', '售卖规格', '总数量（件）'], true)
  report.rows.forEach(item => cells([item.skuCode, item.specification, item.quantity ?? '待补数据']))
  if (!report.rows.length) full(report.complete ? '所选范围暂无可统计的规格销量。' : '暂无可统计的规格编码，需补导原订单报表。', !report.complete)
  for (let addedRow = oldRange.e.r + 1; addedRow < row; addedRow++) {
    for (let column = 0; column <= lastColumn; column++) {
      const address = XLSX.utils.encode_cell({ r: addedRow, c: column })
      if (!sheet[address]) sheet[address] = { t: 's', v: '', s: { fill: { patternType: 'solid', fgColor: { rgb: 'FFFFFF' } } } }
    }
  }
  sheet['!ref'] = XLSX.utils.encode_range({ s: oldRange.s, e: { r: row - 1, c: Math.max(lastColumn, oldRange.e.c) } })
}
