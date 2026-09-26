import * as XLSX from 'xlsx-js-style'

export type ProfitExportMetric = {
  date: string
  productId: string
  product: string
  amount: number
  cost: number
  grossProfit: number
  promotion: number
  operationFee: number
  estimatedProfit: number
  quantity: number
  margin: number
}

type MetricKey = 'amount' | 'cost' | 'grossProfit' | 'promotion' | 'operationFee' | 'estimatedProfit' | 'quantity' | 'margin'

const metricRows: Array<{ label: string; key: MetricKey; format: string }> = [
  { label: '实收金额', key: 'amount', format: '#,##0.00;[Red]-#,##0.00' },
  { label: '货品成本', key: 'cost', format: '#,##0.00;[Red]-#,##0.00' },
  { label: '商品毛利润', key: 'grossProfit', format: '#,##0.00;[Red]-#,##0.00' },
  { label: '推广花费', key: 'promotion', format: '#,##0.00;[Red]-#,##0.00' },
  { label: '运营费用预估', key: 'operationFee', format: '#,##0.00;[Red]-#,##0.00' },
  { label: '当天毛利预估', key: 'estimatedProfit', format: '#,##0.00;[Red]-#,##0.00' },
  { label: '当天销量', key: 'quantity', format: '#,##0.##;[Red]-#,##0.##' },
  { label: '毛利率', key: 'margin', format: '0.00%;[Red]-0.00%' },
]

const thinBorder = {
  top: { style: 'thin', color: { rgb: '808080' } },
  bottom: { style: 'thin', color: { rgb: '808080' } },
  left: { style: 'thin', color: { rgb: '808080' } },
  right: { style: 'thin', color: { rgb: '808080' } },
}

const monthKey = (date: string) => date.slice(0, 7)
const dayLabel = (date: string) => {
  const [, month, day] = date.split('-').map(Number)
  return `${month}月${day}日`
}

function monthlyValue(rows: ProfitExportMetric[], key: MetricKey) {
  if (key === 'margin') {
    const amount = rows.reduce((sum, row) => sum + row.amount, 0)
    const profit = rows.reduce((sum, row) => sum + row.estimatedProfit, 0)
    return amount ? profit / amount : 0
  }
  return rows.reduce((sum, row) => sum + row[key], 0)
}

export function aggregateProfitMetrics(metrics: ProfitExportMetric[]) {
  const grouped = new Map<string, ProfitExportMetric>()
  metrics.forEach(row => {
    const key = `${row.date}|${row.productId}`
    const current = grouped.get(key)
    if (!current) {
      grouped.set(key, { ...row })
      return
    }
    current.amount += row.amount
    current.cost += row.cost
    current.grossProfit += row.grossProfit
    current.promotion += row.promotion
    current.operationFee += row.operationFee
    current.estimatedProfit += row.estimatedProfit
    current.quantity += row.quantity
    current.margin = current.amount ? current.estimatedProfit / current.amount : 0
  })
  return [...grouped.values()]
}

export function createProfitPreviewSheet(metrics: ProfitExportMetric[]) {
  const combinedMetrics = aggregateProfitMetrics(metrics)
  const dates = [...new Set(combinedMetrics.map(row => row.date))].sort()
  const months = [...new Set(dates.map(monthKey))]
  const years = new Set(months.map(month => month.slice(0, 4)))
  const products = [...new Map(combinedMetrics.map(row => [row.productId, row.product])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'))
  const columnCount = 2 + dates.length + months.length
  const rows: Array<Array<string | number>> = []
  const merges: XLSX.Range[] = []
  const blockStarts: number[] = []

  products.forEach(([productId, product], productIndex) => {
    const start = rows.length
    blockStarts.push(start)
    const productRows = combinedMetrics.filter(row => row.productId === productId)
    const byDate = new Map(productRows.map(row => [row.date, row]))
    rows.push([
      product,
      '日期',
      ...dates.map(dayLabel),
      ...months.map(month => {
        const [year, number] = month.split('-').map(Number)
        return years.size > 1 ? `${year}年${number}月份数据` : `${number}月份数据`
      }),
    ])
    metricRows.forEach(metric => {
      rows.push([
        '',
        metric.label,
        ...dates.map(date => byDate.get(date)?.[metric.key] ?? ''),
        ...months.map(month => monthlyValue(productRows.filter(row => monthKey(row.date) === month), metric.key)),
      ])
    })
    merges.push({ s: { r: start, c: 0 }, e: { r: start + metricRows.length, c: 0 } })
    if (productIndex < products.length - 1) rows.push(new Array(columnCount).fill(''), new Array(columnCount).fill(''))
  })

  const sheet = XLSX.utils.aoa_to_sheet(rows)
  sheet['!merges'] = merges
  sheet['!cols'] = [
    { wch: 11 },
    { wch: 16 },
    ...dates.map(() => ({ wch: 12 })),
    ...months.map(() => ({ wch: years.size > 1 ? 18 : 14 })),
  ]
  sheet['!rows'] = rows.map((_, index) => ({ hpt: blockStarts.includes(index) ? 24 : 22 }))

  blockStarts.forEach(start => {
    const end = start + metricRows.length
    for (let row = start; row <= end; row += 1) {
      for (let column = 0; column < columnCount; column += 1) {
        const address = XLSX.utils.encode_cell({ r: row, c: column })
        const cell = sheet[address] || (sheet[address] = { t: 's', v: '' })
        const isSummary = column >= 2 + dates.length
        const isLabel = column <= 1
        cell.s = {
          font: {
            name: '宋体',
            sz: column === 0 ? 18 : 11,
            bold: column <= 1 || isSummary,
          },
          fill: isLabel
            ? { patternType: 'solid', fgColor: { rgb: 'FFF200' } }
            : isSummary
              ? { patternType: 'solid', fgColor: { rgb: 'A8E3DF' } }
              : { patternType: 'solid', fgColor: { rgb: 'FFFFFF' } },
          alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
          border: thinBorder,
          numFmt: row > start ? metricRows[row - start - 1].format : undefined,
        }
      }
    }
  })

  sheet['!sheetViews'] = [{ showGridLines: false }]
  return sheet
}
