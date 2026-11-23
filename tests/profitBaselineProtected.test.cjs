const assert = require('node:assert/strict'), { test } = require('node:test'), fs = require('node:fs'), crypto = require('node:crypto')
const pinned = require('../docs/profit-baseline-protected-segments.json')
const read = file => fs.readFileSync(require('node:path').resolve(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n')
const hash = source => crypto.createHash('sha256').update(source).digest('hex')

test('baseline feature leaves the entire original parsing, import and accounting pipeline plus combine function unchanged', () => {
  let page = read('src/pages/PddAnalyzer.tsx')
  page = page.replace("import { SettlementExportWarnings } from '../components/SettlementExportWarnings'\n", '').replace("import { useProfitBaselines } from '../components/useProfitBaselines'\n", '')
    .replace("import { initialCollectionProfit } from '../utils/profitBaselines'\n", '')
    .replace("const baselineMoney = (value: number | null) => value == null ? '未记录' : money(value)\n", '')
    .replace("  useProfitBaselines(!busy && importReady, storeId, orders, reportTypes, accounting)\n  const initialProfit = (rows: Array<{ date: string }>) => initialCollectionProfit(data, rows.map(row => ({ storeId, date: row.date })))\n\n", '')
  assert.equal(hash(page.split('  return <div className="page page-wide pdd-page">')[0]), pinned.page_before_render)
  assert.equal(hash(page.slice(page.indexOf('function combine('))), pinned.page_combine)
})

test('approved product preview export source stays pinned while profit baseline presentation remains separate', () => {
  const workbook = read('src/utils/settlementWorkbook.ts')
    .replace("import { appendProfitBaselineDisplay } from './profitBaselineWorkbook'\n", '')
    .replace('  appendProfitBaselineDisplay(workbook, data, stores, collections, profits)\n', '')
  assert.equal(hash(workbook), pinned.original_workbook)
})
