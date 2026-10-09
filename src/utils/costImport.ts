export interface CostImportRow {
  sourceRow: number
  clientName: string
  productName: string
  skuCode: string
  specification: string
  totalCost: number
}

type CellValue = string | number | boolean | Date | null | undefined

const MAX_IMPORT_ROWS = 1000
const MAX_FILE_SIZE = 5 * 1024 * 1024

const headerAliases = {
  clientName: ['甲方', '所属甲方', '客户'],
  productName: ['商品名称', '产品名称', '商品', '产品'],
  skuCode: ['编码', 'sku编码', 'sku编号', 'sku'],
  specification: ['售卖规格', '规格'],
  totalCost: ['总成本', '成本'],
} as const

const normalizeHeader = (value: CellValue) => String(value ?? '')
  .trim()
  .toLowerCase()
  .replace(/[\s_\-\/\\()（）]/g, '')

const cellText = (value: CellValue) => {
  if (value instanceof Date) return value.toLocaleDateString('zh-CN')
  return String(value ?? '').trim()
}

const parseNumber = (value: CellValue) => {
  if (typeof value === 'number') return value
  const normalized = String(value ?? '').trim().replace(/[￥¥,，\s]/g, '')
  return normalized === '' ? Number.NaN : Number(normalized)
}

const findHeaderIndex = (headers: CellValue[], aliases: readonly string[]) => {
  const normalizedAliases = aliases.map(normalizeHeader)
  return headers.findIndex(header => normalizedAliases.includes(normalizeHeader(header)))
}

export function rowsToCostImport(matrix: CellValue[][]): CostImportRow[] {
  const nonEmptyRows = matrix.filter(row => row.some(cell => cellText(cell)))
  if (!nonEmptyRows.length) throw new Error('文件中没有可导入的数据。')

  const headers = nonEmptyRows[0]
  const columns = {
    clientName: findHeaderIndex(headers, headerAliases.clientName),
    productName: findHeaderIndex(headers, headerAliases.productName),
    skuCode: findHeaderIndex(headers, headerAliases.skuCode),
    specification: findHeaderIndex(headers, headerAliases.specification),
    totalCost: findHeaderIndex(headers, headerAliases.totalCost),
  }
  const missing = Object.entries(columns).filter(([, index]) => index < 0).map(([key]) => ({
    clientName: '甲方', productName: '商品名称', skuCode: '编码', specification: '售卖规格', totalCost: '总成本',
  }[key]))
  if (missing.length) throw new Error(`缺少必填列：${missing.join('、')}`)

  const dataRows = nonEmptyRows.slice(1)
  if (!dataRows.length) throw new Error('文件只有表头，没有成本数据。')
  if (dataRows.length > MAX_IMPORT_ROWS) throw new Error(`一次最多导入 ${MAX_IMPORT_ROWS} 条成本。`)

  return dataRows.map((row, index) => ({
    sourceRow: index + 2,
    clientName: cellText(row[columns.clientName]),
    productName: cellText(row[columns.productName]),
    skuCode: cellText(row[columns.skuCode]),
    specification: cellText(row[columns.specification]),
    totalCost: parseNumber(row[columns.totalCost]),
  }))
}

function parseDelimited(text: string): string[][] {
  const input = text.replace(/^\uFEFF/, '')
  const firstLine = input.split(/\r?\n/, 1)[0] || ''
  const delimiter = firstLine.includes('\t') ? '\t' : firstLine.includes(';') && !firstLine.includes(',') ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let value = ''
  let quoted = false

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]
    if (character === '"') {
      if (quoted && input[index + 1] === '"') { value += '"'; index += 1 } else quoted = !quoted
    } else if (character === delimiter && !quoted) {
      row.push(value); value = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && input[index + 1] === '\n') index += 1
      row.push(value); rows.push(row); row = []; value = ''
    } else value += character
  }
  row.push(value)
  rows.push(row)
  return rows
}

export async function parseCostImportFile(file: File): Promise<CostImportRow[]> {
  if (file.size > MAX_FILE_SIZE) throw new Error('文件不能超过 5MB。')
  const extension = file.name.split('.').pop()?.toLowerCase()
  if (extension === 'xlsx') {
    const { readSheet } = await import('read-excel-file/browser')
    const rows = await readSheet(file)
    return rowsToCostImport(rows as unknown as CellValue[][])
  }
  if (extension === 'csv' || extension === 'tsv' || extension === 'txt') {
    return rowsToCostImport(parseDelimited(await file.text()))
  }
  throw new Error('仅支持 .xlsx、.csv 和 .tsv 文件。')
}
