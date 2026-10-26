const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
const XLSX = require('xlsx-js-style')
const { createSettlementWorkbook } = require('../src/utils/settlementWorkbook.ts')
const { appendSpecSales } = require('../src/utils/specSalesWorkbook.ts')
const collection = (extra = {}) => ({ id: 'day', storeId: 'a', date: '2026-10-24', orderCount: 10, originalSales: 100, effectiveSales: 65, shippedRefund: 30, couponRefund: 5, basicServiceFee: 0, afterSaleCompensation: 0, smallPayment: 0, appealReimbursement: 0, productCost: 20, promotionFee: 10, estimatedProfit: 35, currentNet: 65, unsettledAmount: 0, profit: 35, eligibleOrders: 10, settledOrders: 10, completionRate: 1, mature: true, missingCostOrders: 0, unknownFunds: 0, ...extra })
const fixture = (rows = [collection()]) => ({ clients: [{ id: 'c', name: '甲方' }], stores: [{ id: 'a', clientId: 'c', name: 'A店' }, { id: 'b', clientId: 'c', name: 'B店' }], products: [], productCosts: [], collectionRecords: rows, profitRecords: [] })

test('spec section uses only A:D, merges selling specification B:C and leaves existing canvas intact', () => {
  for (const data of [fixture([]), fixture()]) {
    const sheet = XLSX.utils.aoa_to_sheet([['财务', 12.34, null, null, null, '原始财务单元格']])
    sheet['!cols'] = [{ wch: 22 }, { wch: 16 }, { wch: 16 }, { wch: 15 }, { wch: 15 }]
    const original = structuredClone(sheet)
    appendSpecSales(sheet, data, { clientId: 'c' })
    for (const [key, value] of Object.entries(original)) if (key !== '!ref') assert.deepEqual(sheet[key], value)
    for (const key of Object.keys(sheet).filter(key => /^[A-Z]+\d+$/.test(key))) {
      const cell = XLSX.utils.decode_cell(key)
      if (cell.r > 0) assert(cell.c <= 3, key)
    }
    assert(sheet['!merges'].every(merge => merge.e.c <= 3))
    const address = Object.keys(sheet).find(key => sheet[key]?.v === '规格编码')
    const r = XLSX.utils.decode_cell(address).r
    assert.equal(sheet[`B${r + 1}`].v, '售卖规格')
    assert.equal(sheet[`D${r + 1}`].v, '总数量（件）')
    assert(sheet['!merges'].some(merge => merge.s.r === r && merge.s.c === 1 && merge.e.c === 2))
    for (const column of ['A', 'B', 'C', 'D']) assert.equal(sheet[`${column}${r + 1}`].s.fill.fgColor.rgb, '243B64')
  }
})

test('daily after-sale cost uses displayed refunds and weighted totals, scoped by store and dates', () => {
  const data = fixture([collection(), collection({ id: 'day2', date: '2026-10-25', orderCount: 2, shippedRefund: 8, couponRefund: 4 }), collection({ id: 'other', storeId: 'b', orderCount: 4, shippedRefund: 2, couponRefund: 2 })])
  const snapshot = JSON.stringify(data)
  const book = createSettlementWorkbook(data, { clientId: 'c' })
  const sheet = book.Sheets['A店回款']
  assert.equal(sheet.R6.v, '均单售后')
  assert.equal(sheet.R7.v, 47 / 12)
  assert.equal(sheet.R8.v, 6)
  assert.equal(sheet.R9.v, 3.5)
  assert.equal(book.Sheets['B店回款'].R7.v, 1)
  assert.equal(XLSX.utils.decode_range(sheet['!ref']).e.c, 17)
  assert.equal(sheet.R8.s.numFmt, '#,##0.00;[Red]-#,##0.00')
  const filtered = createSettlementWorkbook(data, { clientId: 'c', startDate: '2026-10-25', endDate: '2026-10-25' })
  assert.equal(filtered.Sheets['A店回款'].R7.v, 6)
  assert.equal(filtered.Sheets['B店回款'].R7.v, '')
  const reopened = XLSX.read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', cellNF: true })
  assert.equal(reopened.Sheets['A店回款'].R9.t, 'n')
  assert.equal(reopened.Sheets['A店回款'].R9.w, '3.50')
  assert.equal(JSON.stringify(data), snapshot)
})

test('zero and missing inputs never divide by zero or fabricate a known average', () => {
  for (const values of [{ orderCount: 0 }, { orderCount: undefined }, { shippedRefund: undefined }, { couponRefund: null }]) {
    const sheet = createSettlementWorkbook(fixture([collection(values)]), { clientId: 'c' }).Sheets['A店回款']
    assert.equal(sheet.R7.v, '')
    assert.equal(sheet.R8.v, '')
  }
  const knownZero = createSettlementWorkbook(fixture([collection({ shippedRefund: 0, couponRefund: 0 })]), { clientId: 'c' }).Sheets['A店回款']
  assert.equal(knownZero.R8.v, 0)
  const incomplete = createSettlementWorkbook(fixture([collection(), collection({ date: '2026-10-25', couponRefund: undefined })]), { clientId: 'c' }).Sheets['A店回款']
  assert.equal(incomplete.R7.v, '')
  assert.equal(incomplete.R9.v, 3.5)
})

test('historical refund normalization is reflected in the new display without mutating saved records', () => {
  const data = fixture([collection({ refundBasis: 'refund_completed_at', shippedRefund: 999, orderShippedRefund: 15 })])
  const snapshot = JSON.stringify(data)
  const sheet = createSettlementWorkbook(data, { clientId: 'c' }).Sheets['A店回款']
  assert.equal(sheet.E8.v, 15)
  assert.equal(sheet.R8.v, 2)
  assert.equal(JSON.stringify(data), snapshot)
})
