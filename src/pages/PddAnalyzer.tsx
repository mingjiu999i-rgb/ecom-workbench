import JSZip from 'jszip'
import { ChevronDown, ChevronRight, Download, FileSpreadsheet, RotateCcw, ShieldCheck, Upload } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from '@e965/xlsx'
import { useWorkbench } from '../store/workbench'
import type { CollectionRecord, ProfitRecord } from '../types/models'
import { isSupplementOrder, normalizeSpecification, resolveProductCost, type ProductCostMatch } from '../utils/orderCostMatching'
import { exportSettlementWorkbook, settlementExportIssues } from '../utils/settlementWorkbook'

type Row = Record<string, string | number>
type Order = { id: string; shop: string; payTime: string; payDate: string; receipt: number; status: string; productId: string; product: string; specification: string; skuCode: string; quantity: number }
type Refund = { id: string; orderId: string; shop: string; status: string; stage: string; refundAmount: number; appliedAt: string; approvedAt: string; refundDate: string }
type FundCategory = 'positive' | 'refund' | 'other' | 'transfer' | 'promotion' | 'unknown'
type Fund = { key: string; orderId: string; shop: string; occurredAt: string; income: number; expense: number; accountType: string; businessCode: string; businessName: string; businessDescription: string; category: FundCategory }
type Promotion = { key: string; shop: string; date: string; amount: number }
type Summary = { shop: string; date: string; orderCount: number; originalSales: number; effectiveSales: number; shippedRefund: number; orderShippedRefund: number; couponRefund: number; basicServiceFee: number; afterSaleCompensation: number; smallPayment: number; appealReimbursement: number; productCost: number | null; promotionFee: number; estimatedProfit: number | null; currentNet: number; unsettledAmount: number; profit: number | null; eligibleOrders: number; settledOrders: number; completionRate: number; mature: boolean; missingCostOrders: number; unknownFunds: number }
type DeductionBreakdown = { key: string; businessCode: string; businessName: string; accountType: string; deductionCount: number; deduction: number; reimbursementCount: number; reimbursement: number; netDeduction: number }
type SkuRow = { key: string; code: string; productId: string; product: string; specification: string; quantity: number; orders: Order[]; supplement: boolean; match?: ProductCostMatch }
type ProductMetric = { date: string; productId: string; product: string; rate: number; amount: number; cost: number; grossProfit: number; promotion: number; operationFee: number; estimatedProfit: number; quantity: number; margin: number }

const collectionFields: (keyof Summary & keyof CollectionRecord)[] = ['date', 'orderCount', 'originalSales', 'effectiveSales', 'shippedRefund', 'orderShippedRefund', 'couponRefund', 'basicServiceFee', 'afterSaleCompensation', 'smallPayment', 'appealReimbursement', 'productCost', 'promotionFee', 'estimatedProfit', 'currentNet', 'unsettledAmount', 'profit', 'eligibleOrders', 'settledOrders', 'completionRate', 'mature', 'missingCostOrders', 'unknownFunds']

const money = (value: number | null) => value == null ? '待补成本' : `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const text = (value: unknown) => value == null ? '' : String(value).replace(/\t/g, '').trim()
const amount = (value: unknown) => Math.round((Number(text(value).replace(/[,¥￥]/g, '')) || 0) * 100) / 100
const dateText = (value: unknown) => {
  if (value instanceof Date) return value.toLocaleDateString('sv-SE')
  const raw = text(value).replace(/\//g, '-').replace(/年|月/g, '-').replace(/日/g, '')
  const match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : raw.slice(0, 10)
}
const cellValue = (value: unknown) => value instanceof Date
  ? `${value.toLocaleDateString('sv-SE')} ${value.toTimeString().slice(0, 8)}`
  : typeof value === 'number' ? value : text(value)
const rowObject = (headers: unknown[], cells: unknown[]) => Object.fromEntries(headers.map((h, index) => [text(h), cellValue(cells[index])])) as Row
const signature = (parts: unknown[]) => JSON.stringify(parts.map(text))
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100
const manualCostKey = (order: Pick<Order, 'shop' | 'skuCode' | 'specification'>) => `${order.shop.trim()}|${order.skuCode}|${normalizeSpecification(order.specification)}`

function classifyFund(accountType: string, business: string): FundCategory {
  const combined = `${accountType}|${business}`
  const code = business.split('|', 1)[0].trim()
  if (['0010002', '0010005'].includes(code)) return 'positive'
  if (['0020002', '0020005'].includes(code)) return 'refund'
  if (['提现', '充值', '资金划转', '转账'].some(word => combined.includes(word))) return 'transfer'
  if (['推广消耗', '广告消耗', '推广实际扣费', '广告实际扣费', '推广费扣款', '广告费扣款'].some(word => combined.includes(word))) return 'promotion'
  if (['技术服务费', '售后费用', '消费者体验提升计划', '多多进宝', '小额打款', '申诉补回', '费用返还', '其他收入'].some(word => combined.includes(word)) || /^(003|004|006|013)/.test(code)) return 'other'
  return 'unknown'
}

function parseBusiness(business: string, accountType: string) {
  const split = business.indexOf('|')
  const businessCode = (split >= 0 ? business.slice(0, split) : '').trim()
  const fullName = (split >= 0 ? business.slice(split + 1) : business).trim()
  const businessName = (fullName.includes('-') ? fullName.slice(fullName.indexOf('-') + 1) : fullName) || accountType || '未识别业务'
  return { businessCode, businessName }
}

function summarizeDeductions(funds: Fund[]): DeductionBreakdown[] {
  const grouped = new Map<string, DeductionBreakdown>()
  funds.filter(fund => fund.category === 'other' && (fund.income !== 0 || fund.expense !== 0)).forEach(fund => {
    const key = `${fund.businessCode}|${fund.businessName}|${fund.accountType}`
    const current = grouped.get(key) || { key, businessCode: fund.businessCode, businessName: fund.businessName, accountType: fund.accountType, deductionCount: 0, deduction: 0, reimbursementCount: 0, reimbursement: 0, netDeduction: 0 }
    if (fund.expense < 0) { current.deductionCount += 1; current.deduction += Math.abs(fund.expense) }
    if (fund.income > 0) { current.reimbursementCount += 1; current.reimbursement += fund.income }
    current.deduction = round(current.deduction); current.reimbursement = round(current.reimbursement); current.netDeduction = round(current.deduction - current.reimbursement)
    grouped.set(key, current)
  })
  return [...grouped.values()].sort((a, b) => b.deduction - a.deduction || b.reimbursement - a.reimbursement || a.businessCode.localeCompare(b.businessCode))
}

function parseTable(data: ArrayBuffer, name: string): unknown[][] {
  if (name.toLowerCase().endsWith('.csv')) {
    const bytes = new Uint8Array(data)
    let decoded = ''
    for (const encoding of ['utf-8', 'gb18030']) {
      try { decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes); break } catch { /* try next */ }
    }
    if (!decoded) throw new Error(`${name}：CSV 编码无法识别`)
    const workbook = XLSX.read(decoded.replace(/^\uFEFF/, ''), { type: 'string', cellDates: true, raw: true })
    return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true, defval: '' }) as unknown[][]
  }
  const workbook = XLSX.read(data, { type: 'array', cellDates: true })
  const sheetName = workbook.SheetNames.includes('售后信息') ? '售后信息' : workbook.SheetNames[0]
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: '' }) as unknown[][]
}

const promotionColumns = (headers: Set<string>) => {
  const date = ['统计日期', '日期', '消耗日期', '推广日期', '数据日期'].find(x => headers.has(x))
  const spend = ['消耗金额(元)', '消耗金额（元）', '推广消耗(元)', '推广消耗（元）', '总营销花费(元)', '总营销花费（元）', '成交营销花费(元)', '成交营销花费（元）', '推广总花费(元)', '推广总花费（元）', '花费(元)', '花费（元）', '实际消耗(元)', '实际消耗（元）', '总花费(元)', '总花费（元）', '消耗', '花费'].find(x => headers.has(x))
  return { date, spend }
}

export function PddAnalyzer() {
  const { data, update, syncStatus } = useWorkbench()
  const inputRef = useRef<HTMLInputElement>(null)
  const [storeId, setStoreId] = useState('')
  const [exportClientId, setExportClientId] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [orders, setOrders] = useState<Map<string, Order>>(new Map())
  const [refunds, setRefunds] = useState<Map<string, Refund>>(new Map())
  const [funds, setFunds] = useState<Map<string, Fund>>(new Map())
  const [promotions, setPromotions] = useState<Map<string, Promotion>>(new Map())
  const [manualCostIds, setManualCostIds] = useState<Map<string, string>>(new Map())
  const [messages, setMessages] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set())
  const store = data.stores.find(item => item.id === storeId)
  const shop = store?.name || ''
  const activeStores = data.stores.filter(item => item.storeStatus !== '暂停')

  const importTable = (name: string, table: unknown[][], targetShop: string) => {
    const headerIndex = table.slice(0, 30).findIndex(row => {
      const set = new Set(row.map(text))
      const promo = promotionColumns(set)
      return (set.has('订单号') && (set.has('支付时间') || set.has('订单成交时间')))
        || (set.has('售后编号') && set.has('订单编号'))
        || (set.has('商户订单号') && set.has('发生时间'))
        || Boolean(promo.date && promo.spend)
    })
    if (headerIndex < 0) throw new Error(`${name}：找不到支持的报表表头`)
    const headers = table[headerIndex].map(text)
    const headerSet = new Set(headers)
    const rows = table.slice(headerIndex + 1).filter(row => row.some(cell => text(cell))).map(row => rowObject(headers, row))
    if (headerSet.has('订单号') && (headerSet.has('支付时间') || headerSet.has('订单成交时间'))) {
      setOrders(current => { const next = new Map(current); rows.forEach(row => { const id = text(row['订单号']); const payTime = text(row['支付时间'] || row['订单成交时间']); if (id) next.set(id, { id, shop: targetShop, payTime, payDate: dateText(payTime), receipt: amount(row['商家实收金额(元)']), status: text(row['订单状态']), productId: text(row['商品id'] || row['商品ID']), product: text(row['商品']), specification: text(row['商品规格']), skuCode: text(row['商家编码-规格维度']), quantity: Number(row['商品数量(件)'] || 0) }) }); return next })
      return `订单 ${rows.length} 行`
    }
    if (headerSet.has('售后编号') && headerSet.has('订单编号')) {
      setRefunds(current => { const next = new Map(current); rows.forEach(row => { const id = text(row['售后编号']); const appliedAt = text(row['申请时间']); const approvedAt = text(row['同意退款时间'] || row['退款成功时间'] || row['售后完成时间']); if (id) next.set(id, { id, orderId: text(row['订单编号']), shop: targetShop, status: text(row['售后状态']), stage: text(row['订单状态']), refundAmount: amount(row['退款金额'] || row['退款金额(元)'] || row['退款金额（元）']), appliedAt, approvedAt, refundDate: dateText(approvedAt || appliedAt) }) }); return next })
      return `退款 ${rows.length} 行`
    }
    if (headerSet.has('商户订单号') && headerSet.has('发生时间')) {
      setFunds(current => { const next = new Map(current); const ordinals = new Map<string, number>(); rows.forEach(row => { const orderId = text(row['商户订单号']); if (!/^\d{6}-\d+$/.test(orderId)) return; const accountType = text(row['账务类型']); const businessDescription = text(row['业务描述']); const business = parseBusiness(businessDescription, accountType); const sig = signature(['商户订单号', '发生时间', '收入金额（+元）', '支出金额（-元）', '账务类型', '备注', '业务描述'].map(field => row[field])); const ordinal = (ordinals.get(sig) || 0) + 1; ordinals.set(sig, ordinal); const key = `${sig}:${ordinal}`; next.set(key, { key, orderId, shop: targetShop, occurredAt: text(row['发生时间']), income: amount(row['收入金额（+元）']), expense: amount(row['支出金额（-元）']), accountType, businessCode: business.businessCode, businessName: business.businessName, businessDescription, category: classifyFund(accountType, businessDescription) }) }); return next })
      return `资金 ${rows.length} 行`
    }
    const promotion = promotionColumns(headerSet)
    if (promotion.date && promotion.spend) {
      setPromotions(current => { const next = new Map(current); const ordinals = new Map<string, number>(); rows.forEach(row => { const date = dateText(row[promotion.date!]); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return; const value = Math.abs(amount(row[promotion.spend!])); const sig = signature([date, value, ...headers.filter(h => h !== promotion.date && h !== promotion.spend).map(h => row[h])]); const ordinal = (ordinals.get(sig) || 0) + 1; ordinals.set(sig, ordinal); const key = `${targetShop}|${sig}:${ordinal}`; next.set(key, { key, shop: targetShop, date, amount: value }) }); return next })
      return `推广 ${rows.length} 行`
    }
    throw new Error(`${name}：无法判断报表类型`)
  }

  const importFiles = async (files: FileList) => {
    const targetShop = shop.trim()
    if (!storeId || !targetShop) { setError('请先选择店铺'); return }
    setBusy(true); setError('')
    setOrders(new Map()); setRefunds(new Map()); setFunds(new Map()); setPromotions(new Map()); setMessages([])
    const imported: string[] = []
    try {
      const consume = async (name: string, data: ArrayBuffer) => imported.push(`${name}：${importTable(name, parseTable(data, name), targetShop)}`)
      for (const file of Array.from(files)) {
        if (file.name.toLowerCase().endsWith('.zip')) {
          const zip = await JSZip.loadAsync(await file.arrayBuffer())
          for (const entry of Object.values(zip.files)) if (!entry.dir && /\.(csv|xls|xlsx)$/i.test(entry.name)) await consume(entry.name.split('/').pop() || entry.name, await entry.async('arraybuffer'))
        } else await consume(file.name, await file.arrayBuffer())
      }
      setMessages(current => [...imported, ...current].slice(0, 12))
    } catch (cause) { setError(cause instanceof Error ? cause.message : '导入失败') } finally { setBusy(false); if (inputRef.current) inputRef.current.value = '' }
  }

  const clientProducts = useMemo(() => data.products.filter(product => product.clientId === store?.clientId), [data.products, store?.clientId])
  const clientProductIds = useMemo(() => new Set(clientProducts.map(product => product.id)), [clientProducts])
  const availableCosts = useMemo(() => data.productCosts.filter(cost => clientProductIds.has(cost.productId)), [clientProductIds, data.productCosts])
  const linkedProductId = (order: Order) => data.productLinks.find(link => link.storeId === storeId && link.linkId === order.productId)?.productId || (clientProducts.length === 1 ? clientProducts[0].id : '')
  const resolveCost = (order: Order) => resolveProductCost(order, availableCosts, data.products, linkedProductId(order), manualCostIds.get(manualCostKey(order)) || '')
  const validCostOrders = useMemo(() => {
    const unshipped = new Set([...refunds.values()].filter(refund => refund.status === '退款成功' && refund.stage === '未发货').map(refund => refund.orderId))
    return [...orders.values()].filter(order => order.payDate && !order.status.includes('取消') && !unshipped.has(order.id))
  }, [orders, refunds])
  const skuRows = useMemo(() => {
    const grouped = new Map<string, SkuRow>()
    validCostOrders.forEach(order => {
      const key = `${order.skuCode}|${normalizeSpecification(order.specification)}`
      const row = grouped.get(key) || { key, code: order.skuCode, productId: order.productId, product: order.product, specification: order.specification, quantity: 0, orders: [], supplement: isSupplementOrder(order) }
      if (!row.supplement) row.quantity += order.quantity
      row.orders.push(order); grouped.set(key, row)
    })
    return [...grouped.values()].map(row => ({ ...row, match: row.supplement ? undefined : resolveCost(row.orders[0]) })).sort((a, b) => (a.code || a.specification).localeCompare(b.code || b.specification, 'zh-CN'))
  }, [availableCosts, clientProducts, data.productLinks, manualCostIds, storeId, validCostOrders])
  const resolveOrderCost = (order: Order) => resolveCost(order)
  const summaries = useMemo(() => calculateSummaries([...orders.values()], [...refunds.values()], [...funds.values()], [...promotions.values()], resolveOrderCost), [orders, refunds, funds, promotions, availableCosts, clientProducts, data.productLinks, manualCostIds, storeId])
  const productMetrics = useMemo(() => calculateProductMetrics([...orders.values()], [...refunds.values()], [...funds.values()], [...promotions.values()], resolveOrderCost, order => linkedProductId(order), data.products), [orders, refunds, funds, promotions, availableCosts, clientProducts, data.productLinks, data.products, manualCostIds, storeId])
  const total = useMemo(() => combine(summaries), [summaries])
  const savedRecords = useMemo(() => data.collectionRecords.filter(record => record.storeId === storeId).sort((a, b) => b.date.localeCompare(a.date)), [data.collectionRecords, storeId])
  const filteredRecords = useMemo(() => savedRecords.filter(record => (!startDate || record.date >= startDate) && (!endDate || record.date <= endDate)), [savedRecords, startDate, endDate])
  const savedSummaries = useMemo(() => filteredRecords.map(record => ({ shop, date: record.date, orderCount: record.orderCount, originalSales: record.originalSales, effectiveSales: record.effectiveSales, shippedRefund: record.shippedRefund, orderShippedRefund: record.orderShippedRefund ?? record.shippedRefund, couponRefund: record.couponRefund, basicServiceFee: record.basicServiceFee, afterSaleCompensation: record.afterSaleCompensation, smallPayment: record.smallPayment, appealReimbursement: record.appealReimbursement, productCost: record.productCost, promotionFee: record.promotionFee, estimatedProfit: record.estimatedProfit, currentNet: record.currentNet, unsettledAmount: record.unsettledAmount, profit: record.profit, eligibleOrders: record.eligibleOrders, settledOrders: record.settledOrders, completionRate: record.completionRate, mature: record.mature, missingCostOrders: record.missingCostOrders, unknownFunds: record.unknownFunds })), [filteredRecords, shop])
  const savedTotal = useMemo(() => combine(savedSummaries), [savedSummaries])
  const savedMonthGroups = useMemo(() => {
    const groups = new Map<string, Summary[]>()
    savedSummaries.forEach(row => {
      const month = row.date.slice(0, 7)
      const rows = groups.get(month) || []
      rows.push(row)
      groups.set(month, rows)
    })
    return [...groups.entries()].map(([month, rows]) => ({ month, rows, total: combine(rows) }))
  }, [savedSummaries])
  const savedMonthSignature = savedMonthGroups.map(group => group.month).join('|')
  const deductionBreakdown = useMemo(() => summarizeDeductions([...funds.values()]), [funds])
  const deductionTotals = useMemo(() => deductionBreakdown.reduce((sum, row) => ({ deduction: round(sum.deduction + row.deduction), reimbursement: round(sum.reimbursement + row.reimbursement), netDeduction: round(sum.netDeduction + row.netDeduction) }), { deduction: 0, reimbursement: 0, netDeduction: 0 }), [deductionBreakdown])
  const exportOptions = useMemo(() => ({ clientId: exportClientId, startDate, endDate }), [endDate, exportClientId, startDate])
  const exportStoreIds = useMemo(() => new Set(data.stores.filter(item => item.clientId === exportClientId).map(item => item.id)), [data.stores, exportClientId])
  const exportRecordCount = useMemo(() => data.collectionRecords.filter(record => exportStoreIds.has(record.storeId) && (!startDate || record.date >= startDate) && (!endDate || record.date <= endDate)).length, [data.collectionRecords, endDate, exportStoreIds, startDate])
  const exportIssues = useMemo(() => exportClientId ? settlementExportIssues(data, exportOptions) : [], [data, exportClientId, exportOptions])

  useEffect(() => {
    if (!storeId || busy || !orders.size || !funds.size || !summaries.length) return
    const changed = summaries.some(row => {
      const existing = data.collectionRecords.find(record => record.storeId === storeId && record.date === row.date)
      return !existing || existing.refundBasis !== 'refund_completed_at' || collectionFields.some(field => existing[field] !== row[field])
    })
    if (!changed) return
    const timer = window.setTimeout(() => update(current => {
      const incoming = new Map(summaries.map(row => {
        const record: CollectionRecord = { id: `collection-${storeId}-${row.date}`, storeId, date: row.date, orderCount: row.orderCount, originalSales: row.originalSales, effectiveSales: row.effectiveSales, shippedRefund: row.shippedRefund, orderShippedRefund: row.orderShippedRefund, refundBasis: 'refund_completed_at', couponRefund: row.couponRefund, basicServiceFee: row.basicServiceFee, afterSaleCompensation: row.afterSaleCompensation, smallPayment: row.smallPayment, appealReimbursement: row.appealReimbursement, productCost: row.productCost, promotionFee: row.promotionFee, estimatedProfit: row.estimatedProfit, currentNet: row.currentNet, unsettledAmount: row.unsettledAmount, profit: row.profit, eligibleOrders: row.eligibleOrders, settledOrders: row.settledOrders, completionRate: row.completionRate, mature: row.mature, missingCostOrders: row.missingCostOrders, unknownFunds: row.unknownFunds, updatedAt: new Date().toISOString() }
        return [`${storeId}|${row.date}`, record]
      }))
      return { ...current, collectionRecords: [...current.collectionRecords.filter(record => !incoming.has(`${record.storeId}|${record.date}`)), ...incoming.values()] }
    }), 600)
    return () => window.clearTimeout(timer)
  }, [busy, data.collectionRecords, funds.size, orders.size, storeId, summaries, update])

  useEffect(() => {
    if (!storeId || busy || !orders.size || !productMetrics.length || summaries.some(row => row.missingCostOrders)) return
    const orderDates = [...orders.values()].map(order => order.payDate).filter(Boolean).sort()
    const firstDate = orderDates[0], lastDate = orderDates[orderDates.length - 1]
    if (!firstDate || !lastDate) return
    const fields: (keyof ProfitRecord)[] = ['amount', 'cost', 'grossProfit', 'promotion', 'operationRate', 'operationFee', 'estimatedProfit', 'quantity', 'margin']
    const incomingKeys = new Set(productMetrics.map(row => `${storeId}|${row.date}|${row.productId}`))
    const changed = data.profitRecords.some(record => record.storeId === storeId && record.date >= firstDate && record.date <= lastDate && !incomingKeys.has(`${record.storeId}|${record.date}|${record.productId}`)) || productMetrics.some(row => {
      const existing = data.profitRecords.find(record => record.storeId === storeId && record.date === row.date && record.productId === row.productId)
      return !existing || fields.some(field => existing[field] !== (field === 'operationRate' ? row.rate : row[field as keyof ProductMetric]))
    })
    if (!changed) return
    const timer = window.setTimeout(() => update(current => {
      const incoming = productMetrics.map(row => ({ id: `profit-${storeId}-${row.date}-${row.productId}`, storeId, productId: row.productId, date: row.date, amount: row.amount, cost: row.cost, grossProfit: row.grossProfit, promotion: row.promotion, operationRate: row.rate, operationFee: row.operationFee, estimatedProfit: row.estimatedProfit, quantity: row.quantity, margin: row.margin, updatedAt: new Date().toISOString() } satisfies ProfitRecord))
      return { ...current, profitRecords: [...current.profitRecords.filter(record => record.storeId !== storeId || record.date < firstDate || record.date > lastDate), ...incoming] }
    }), 650)
    return () => window.clearTimeout(timer)
  }, [busy, data.profitRecords, orders, productMetrics, storeId, summaries, update])

  useEffect(() => {
    setExpandedMonths(savedMonthGroups[0] ? new Set([savedMonthGroups[0].month]) : new Set())
  }, [storeId, savedMonthSignature])

  const clear = () => { setOrders(new Map()); setRefunds(new Map()); setFunds(new Map()); setPromotions(new Map()); setManualCostIds(new Map()); setMessages([]); setError('') }
  const exportResult = () => {
    if (!exportClientId) { setError('请先选择要导出的甲方'); return }
    if (exportIssues.length) { setError(exportIssues.join('；')); return }
    try { exportSettlementWorkbook(data, exportOptions) } catch (cause) { setError(cause instanceof Error ? cause.message : '经营结算表导出失败') }
  }

  return <div className="page page-wide pdd-page">
    <div className="page-heading"><div><span className="eyebrow">一次导入 · 统一结算</span><h1>拼多多订单经营分析</h1><p>一次导入同时更新订单回款和产品利润；原始明细只在当前浏览器计算。</p></div><div className="heading-actions"><button className="button secondary" onClick={clear}><RotateCcw size={16} />清空本次数据</button><button className="button primary" disabled={!exportClientId || !exportRecordCount} onClick={exportResult}><Download size={16} />导出甲方结算</button></div></div>
    <section className="privacy-strip"><ShieldCheck size={18} /><div><strong>仅保存计算结果</strong><span>上传文件、订单明细、退款明细和资金流水不会保存或上传到云端。</span></div></section>
    <section className="panel pdd-import"><div><label className="field"><span>选择店铺</span><select value={storeId} onChange={event => { const nextStoreId = event.target.value; setStoreId(nextStoreId); setExportClientId(data.stores.find(item => item.id === nextStoreId)?.clientId || ''); clear() }}><option value="">请选择店铺</option>{activeStores.map(item => <option key={item.id} value={item.id}>{data.clients.find(client => client.id === item.clientId)?.name} · {item.name}</option>)}</select></label><p>一次选择同一店铺的订单、退款、资金和推广费文件；每次导入会同时更新回款明细与产品利润。</p></div><button className="button primary" disabled={busy || !storeId} onClick={() => inputRef.current?.click()}><Upload size={16} />{busy ? '正在解析…' : '选择报表并计算'}</button><input ref={inputRef} hidden type="file" multiple accept=".csv,.xls,.xlsx,.zip" onChange={event => event.target.files && void importFiles(event.target.files)} /></section>
    <section className="panel pdd-import profit-import"><div><div className="form-grid"><label className="field field-full"><span>导出甲方</span><select value={exportClientId} onChange={event => setExportClientId(event.target.value)}><option value="">请选择甲方</option>{data.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label><label className="field"><span>开始日期</span><input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></label><label className="field"><span>结束日期</span><input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} /></label></div><p>导出“甲方汇总 + 每个店铺独立回款明细”；日期留空表示全部。{exportIssues.length ? ` 当前需处理：${exportIssues.join('；')}` : exportRecordCount ? ` 已找到 ${exportRecordCount} 条回款记录。` : ''}</p></div><button className="button primary" disabled={!exportClientId || !exportRecordCount} onClick={exportResult}><Download size={16} />导出甲方结算</button></section>
    {error && <div className="pdd-message error">{error}</div>}
    {messages.length > 0 && <div className="pdd-message ok"><FileSpreadsheet size={16} /><span>{messages.join('；')}</span></div>}
    {deductionBreakdown.length > 0 && <section className="panel table-panel pdd-deduction-panel"><div className="table-caption"><div><strong>扣款明细（按业务分类）</strong><span>按资金原表全量业务代码分别汇总；扣款与补回独立展示，不相互抵消。</span></div><div className="cost-count">扣款 <b>{money(deductionTotals.deduction)}</b> · 补回 <b>{money(deductionTotals.reimbursement)}</b> · 净扣款 <b>{money(deductionTotals.netDeduction)}</b></div></div><div className="table-scroll"><table><thead><tr>{['业务代码','扣款分类','账务类型','扣款笔数','扣款金额','补回笔数','补回金额','净扣款'].map(header => <th key={header}>{header}</th>)}</tr></thead><tbody><tr className="profit-total-row"><td colSpan={3}><strong>全部分类合计</strong></td><td>{deductionBreakdown.reduce((sum, row) => sum + row.deductionCount, 0)}</td><td>{money(deductionTotals.deduction)}</td><td>{deductionBreakdown.reduce((sum, row) => sum + row.reimbursementCount, 0)}</td><td>{money(deductionTotals.reimbursement)}</td><td className={deductionTotals.netDeduction < 0 ? 'positive' : 'negative'}>{money(deductionTotals.netDeduction)}</td></tr>{deductionBreakdown.map(row => <tr key={row.key}><td><strong className="cell-main">{row.businessCode || '未识别'}</strong></td><td>{row.businessName}</td><td>{row.accountType || '—'}</td><td>{row.deductionCount}</td><td>{money(row.deduction)}</td><td>{row.reimbursementCount}</td><td>{money(row.reimbursement)}</td><td className={row.netDeduction < 0 ? 'positive' : 'negative'}>{money(row.netDeduction)}</td></tr>)}</tbody></table></div></section>}
    {skuRows.length > 0 && <section className="panel table-panel pdd-cost-panel"><div className="table-caption"><div><strong>SKU 成本匹配</strong><span>先按 SKU 编码精确匹配；空编码或未匹配时，自动按同一甲方产品的售卖规格兜底。补收差价计入销售额，不计销量和成本。</span></div><div className="cost-count"><b>{skuRows.filter(row => row.match).length}</b> 个已匹配 · <b>{skuRows.filter(row => row.supplement).length}</b> 个补差价 · <b>{skuRows.filter(row => !row.supplement && !row.match).length}</b> 个待处理</div></div><div className="table-scroll"><table><thead><tr><th>SKU 编码</th><th>报表商品/规格</th><th>售出数量</th><th>成本来源</th><th>单件总成本</th></tr></thead><tbody>{skuRows.map(row => { const match = row.match; const example = row.orders[0]; const key = manualCostKey(example); return <tr key={row.key}><td><strong className="cell-main">{row.code || '空编码'}</strong></td><td><div className="cell-main">{match?.product || row.product || row.productId || '未填写商品ID'}</div><div className="cell-sub">{match?.specification || row.specification || '未填写规格'}</div></td><td>{row.supplement ? '不计销量' : row.quantity}</td><td>{row.supplement ? <span className="link-status status-备用">补收差价</span> : match ? <span className="link-status status-日销">{match.source}匹配</span> : <span className="link-status status-已挂">待匹配</span>}</td><td>{row.supplement ? '不计成本' : match ? <strong className="positive">{money(match.cost)}</strong> : <select value={manualCostIds.get(key) || ''} onChange={event => setManualCostIds(current => { const next = new Map(current); if (event.target.value) next.set(key, event.target.value); else next.delete(key); return next })}><option value="">选择网站成本 SKU</option>{availableCosts.map(cost => <option key={cost.id} value={cost.id}>{data.products.find(product => product.id === cost.productId)?.name} · {cost.skuCode || '空编码'} · {cost.specification} · {money(cost.totalCost)}</option>)}</select>}</td></tr> })}</tbody></table></div></section>}
    {skuRows.some(row => !row.supplement && !row.match) && <div className="pdd-message error">仍有 {skuRows.filter(row => !row.supplement && !row.match).length} 个 SKU/规格未匹配成本。产品利润不会保存，甲方结算表也会停止导出，避免利润被低估。</div>}
    {total ? <><section className="pdd-metrics">{[['有效订单销售额', money(total.effectiveSales)], ['订单净回款', money(total.currentNet)], ['未回款金额', money(total.unsettledAmount)], ['推广费', money(total.promotionFee)], ['当前盈亏', money(total.profit)]].map(([label, value]) => <article className="metric" key={label}><div><span>{label}</span><strong>{value}</strong></div></article>)}</section>
      <section className="panel table-panel"><div className="table-caption"><div><strong>每日经营主表</strong><span>“已发货退款”按退款完成日期统计并包含历史订单；有效订单销售额仍按本期订单口径。基础技术服务费只统计扣除部分。</span></div></div><div className="table-scroll"><table><thead><tr>{['成交日期','订单数','订单成交额','已发货退款','优惠券退款','有效订单销售额','基础技术服务费','售后补偿消费者','小额打款','申诉补回','商品成本','推广费','预估盈亏','订单净回款','未回款金额','当前盈亏','入账状态'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{[total, ...summaries].map((s, index) => <tr key={`${s.date}-${index}`}><td className="cell-main">{index === 0 ? `累计：${s.date}` : s.date}</td><td>{s.orderCount}</td><td>{money(s.originalSales)}</td><td>{money(s.shippedRefund)}</td><td>{money(s.couponRefund)}</td><td>{money(s.effectiveSales)}</td><td>{money(s.basicServiceFee)}</td><td>{money(s.afterSaleCompensation)}</td><td>{money(s.smallPayment)}</td><td>{money(s.appealReimbursement)}</td><td>{money(s.productCost)}</td><td>{money(s.promotionFee)}</td><td>{money(s.estimatedProfit)}</td><td>{money(s.currentNet)}</td><td>{money(s.unsettledAmount)}</td><td className={s.profit != null && s.profit < 0 ? 'negative' : 'positive'}>{money(s.profit)}</td><td><span className={`status ${s.mature ? 'normal' : 'risk'}`}><i />{s.mature ? '已完成' : '未完成'}</span></td></tr>)}</tbody></table></div></section>
    </> : <section className="panel pdd-empty"><FileSpreadsheet size={28} /><strong>尚未导入报表</strong><span>选择店铺后，一次选择该店铺的全部报表。</span></section>}
    {savedTotal && <section className="panel table-panel saved-profit-panel">
      <div className="table-caption"><div><strong>云端每日订单回款</strong><span>仅保存每日计算汇总；当前日期筛选会同步应用到导出结果。</span></div><div className="cost-count">云端状态：<b>{syncStatus === 'saving' ? '保存中…' : syncStatus === 'error' ? '保存失败' : '已保存'}</b> · <b>{filteredRecords.length}</b> 条记录</div></div>
      <div className="table-scroll"><table>
        <thead><tr>{['成交日期','订单数','订单成交额','已发货退款','优惠券退款','有效订单销售额','基础技术服务费','售后补偿消费者','小额打款','申诉补回','商品成本','推广费','预估盈亏','订单净回款','未回款金额','当前盈亏','入账状态'].map(header => <th key={header}>{header}</th>)}</tr></thead>
        <tbody><tr className="profit-total-row"><td><strong>筛选汇总：{savedTotal.date}</strong></td><td>{savedTotal.orderCount}</td><td>{money(savedTotal.originalSales)}</td><td>{money(savedTotal.shippedRefund)}</td><td>{money(savedTotal.couponRefund)}</td><td>{money(savedTotal.effectiveSales)}</td><td>{money(savedTotal.basicServiceFee)}</td><td>{money(savedTotal.afterSaleCompensation)}</td><td>{money(savedTotal.smallPayment)}</td><td>{money(savedTotal.appealReimbursement)}</td><td>{money(savedTotal.productCost)}</td><td>{money(savedTotal.promotionFee)}</td><td>{money(savedTotal.estimatedProfit)}</td><td>{money(savedTotal.currentNet)}</td><td>{money(savedTotal.unsettledAmount)}</td><td className={savedTotal.profit != null && savedTotal.profit < 0 ? 'negative' : 'positive'}>{money(savedTotal.profit)}</td><td><span className={`status ${savedTotal.mature ? 'normal' : 'risk'}`}><i />{savedTotal.mature ? '已完成' : '未完成'}</span></td></tr></tbody>
        {savedMonthGroups.map(group => {
          const expanded = expandedMonths.has(group.month)
          return <tbody key={group.month} className="month-group">
            <tr className="month-group-row"><td colSpan={17}><button type="button" className="month-toggle" aria-expanded={expanded} onClick={() => setExpandedMonths(current => {
              const next = new Set(current)
              if (next.has(group.month)) next.delete(group.month)
              else next.add(group.month)
              return next
            })}>
              {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <strong>{group.month.replace('-', '年')}月</strong>
              <span>{group.rows.length} 天</span>
              {group.total && <span className="month-total">订单净回款 {money(group.total.currentNet)}</span>}
            </button></td></tr>
            {expanded && group.rows.map(row => <tr key={row.date}><td className="cell-main">{row.date}</td><td>{row.orderCount}</td><td>{money(row.originalSales)}</td><td>{money(row.shippedRefund)}</td><td>{money(row.couponRefund)}</td><td>{money(row.effectiveSales)}</td><td>{money(row.basicServiceFee)}</td><td>{money(row.afterSaleCompensation)}</td><td>{money(row.smallPayment)}</td><td>{money(row.appealReimbursement)}</td><td>{money(row.productCost)}</td><td>{money(row.promotionFee)}</td><td>{money(row.estimatedProfit)}</td><td>{money(row.currentNet)}</td><td>{money(row.unsettledAmount)}</td><td className={row.profit != null && row.profit < 0 ? 'negative' : 'positive'}>{money(row.profit)}</td><td><span className={`status ${row.mature ? 'normal' : 'risk'}`}><i />{row.mature ? '已完成' : '未完成'}</span></td></tr>)}
          </tbody>
        })}
      </table></div>
    </section>}
  </div>
}

function calculateSummaries(orders: Order[], refunds: Refund[], funds: Fund[], promotions: Promotion[], resolveCost: (order: Order) => ProductCostMatch | undefined): Summary[] {
  const orderDates = orders.filter(order => order.payDate).map(order => order.payDate).sort()
  const reportStart = orderDates[0] || ''
  const reportEnd = orderDates[orderDates.length - 1] || ''
  const refundDates = refunds.filter(refund => refund.status === '退款成功' && refund.stage === '已发货' && refund.refundDate >= reportStart && refund.refundDate <= reportEnd).map(refund => refund.refundDate)
  const days = [...new Set([...orders.filter(order => order.payDate).map(order => `${order.shop}|${order.payDate}`), ...refundDates.map(date => `${orders[0]?.shop || ''}|${date}`)])].sort().reverse()
  return days.map(key => {
    const split = key.indexOf('|'); const shop = key.slice(0, split); const date = key.slice(split + 1)
    const dayOrders = orders.filter(o => o.shop === shop && o.payDate === date); const ids = new Set(dayOrders.map(o => o.id))
    const dayRefunds = refunds.filter(r => ids.has(r.orderId) && r.status === '退款成功')
    const unshipped = new Set(dayRefunds.filter(r => r.stage === '未发货').map(r => r.orderId)); const shipped = new Set(dayRefunds.filter(r => r.stage === '已发货' && !unshipped.has(r.orderId)).map(r => r.orderId))
    const validOrders = dayOrders.filter(o => !unshipped.has(o.id) && !o.status.includes('取消')); const eligible = new Set(validOrders.map(o => o.id))
    const dayFunds = funds.filter(f => ids.has(f.orderId)); const original = validOrders.reduce((n, o) => n + o.receipt, 0)
    const shippedRefundByOrder = new Map<string, number>()
    dayRefunds.filter(r => r.stage === '已发货' && shipped.has(r.orderId)).forEach(r => shippedRefundByOrder.set(r.orderId, (shippedRefundByOrder.get(r.orderId) || 0) + r.refundAmount))
    const shippedCouponRefundByOrder = new Map<string, number>()
    dayFunds.filter(f => shipped.has(f.orderId) && f.category === 'refund' && f.businessCode === '0020005' && f.expense < 0).forEach(f => shippedCouponRefundByOrder.set(f.orderId, (shippedCouponRefundByOrder.get(f.orderId) || 0) + Math.abs(f.expense)))
    const orderShippedRefund = [...shippedRefundByOrder.values()].reduce((n, value) => n + value, 0)
    const activityShippedRefund = refunds.filter(refund => refund.shop === shop && refund.status === '退款成功' && refund.stage === '已发货' && refund.refundDate === date).reduce((total, refund) => total + refund.refundAmount, 0)
    const couponRefund = [...shippedCouponRefundByOrder.values()].reduce((n, value) => n + value, 0); const effective = original - orderShippedRefund - couponRefund
    const positive = new Set(dayFunds.filter(f => f.category === 'positive' && f.income > 0).map(f => f.orderId))
    const unsettledAmount = dayOrders.filter(o => eligible.has(o.id) && !positive.has(o.id)).reduce((n, o) => n + Math.max(0, o.receipt - (shippedRefundByOrder.get(o.id) || 0) - (shippedCouponRefundByOrder.get(o.id) || 0)), 0)
    const currentNet = dayFunds.filter(f => ['positive', 'refund', 'other'].includes(f.category)).reduce((n, f) => n + f.income + f.expense, 0)
    const basicServiceFee = dayFunds.filter(f => f.businessCode === '0030002' && f.expense < 0).reduce((n, f) => n + Math.abs(f.expense), 0)
    const afterSaleCompensation = dayFunds.filter(f => f.businessCode === '0040002' && f.expense < 0).reduce((n, f) => n + Math.abs(f.expense), 0)
    const smallPayment = dayFunds.filter(f => f.businessCode === '0040001' && f.expense < 0).reduce((n, f) => n + Math.abs(f.expense), 0)
    const appealReimbursement = dayFunds.filter(f => f.businessCode === '0130005' && f.income > 0).reduce((n, f) => n + f.income, 0)
    let productCost = 0; let missing = 0
    validOrders.filter(order => !isSupplementOrder(order)).forEach(order => { const match = resolveCost(order); if (!match) missing += 1; else productCost += match.cost * order.quantity })
    const promotionFee = promotions.filter(p => p.shop === shop && p.date === date).reduce((n, p) => n + p.amount, 0); const settled = [...eligible].filter(id => positive.has(id)).length
    return { shop, date, orderCount: dayOrders.length, originalSales: round(original), effectiveSales: round(effective), shippedRefund: round(activityShippedRefund), orderShippedRefund: round(orderShippedRefund), couponRefund: round(couponRefund), basicServiceFee: round(basicServiceFee), afterSaleCompensation: round(afterSaleCompensation), smallPayment: round(smallPayment), appealReimbursement: round(appealReimbursement), productCost: missing ? null : round(productCost), promotionFee: round(promotionFee), estimatedProfit: missing ? null : round(effective - productCost - promotionFee), currentNet: round(currentNet), unsettledAmount: round(unsettledAmount), profit: missing ? null : round(currentNet - productCost - promotionFee), eligibleOrders: eligible.size, settledOrders: settled, completionRate: eligible.size ? settled / eligible.size : 1, mature: settled === eligible.size, missingCostOrders: missing, unknownFunds: dayFunds.filter(f => f.category === 'unknown').length }
  })
}

function calculateProductMetrics(orders: Order[], refunds: Refund[], funds: Fund[], promotions: Promotion[], resolveCost: (order: Order) => ProductCostMatch | undefined, linkedProductId: (order: Order) => string, products: Array<{ id: string; name: string; operationRate: number }>): ProductMetric[] {
  const rows = new Map<string, ProductMetric>()
  const days = [...new Set(orders.filter(order => order.payDate).map(order => order.payDate))]
  days.forEach(date => {
    const dayOrders = orders.filter(order => order.payDate === date)
    const ids = new Set(dayOrders.map(order => order.id))
    const dayRefunds = refunds.filter(refund => ids.has(refund.orderId) && refund.status === '退款成功')
    const unshipped = new Set(dayRefunds.filter(refund => refund.stage === '未发货').map(refund => refund.orderId))
    const shipped = new Set(dayRefunds.filter(refund => refund.stage === '已发货' && !unshipped.has(refund.orderId)).map(refund => refund.orderId))
    const validOrders = dayOrders.filter(order => !unshipped.has(order.id) && !order.status.includes('取消'))
    const dayFunds = funds.filter(fund => ids.has(fund.orderId))
    const shippedRefund = new Map<string, number>()
    dayRefunds.filter(refund => refund.stage === '已发货' && shipped.has(refund.orderId)).forEach(refund => shippedRefund.set(refund.orderId, (shippedRefund.get(refund.orderId) || 0) + refund.refundAmount))
    const couponRefund = new Map<string, number>()
    dayFunds.filter(fund => shipped.has(fund.orderId) && fund.category === 'refund' && fund.businessCode === '0020005' && fund.expense < 0).forEach(fund => couponRefund.set(fund.orderId, (couponRefund.get(fund.orderId) || 0) + Math.abs(fund.expense)))
    validOrders.forEach(order => {
      const supplement = isSupplementOrder(order)
      const match = supplement ? undefined : resolveCost(order)
      const productId = match?.productId || linkedProductId(order)
      const product = products.find(item => item.id === productId)
      if (!product) return
      const key = `${date}|${productId}`
      const current = rows.get(key) || { date, productId, product: product.name, rate: Number(product.operationRate || 0), amount: 0, cost: 0, grossProfit: 0, promotion: 0, operationFee: 0, estimatedProfit: 0, quantity: 0, margin: 0 }
      current.amount += order.receipt - (shippedRefund.get(order.id) || 0) - (couponRefund.get(order.id) || 0)
      if (!supplement && match) { current.cost += match.cost * order.quantity; current.quantity += order.quantity }
      rows.set(key, current)
    })
    const dayRows = [...rows.values()].filter(row => row.date === date)
    const dailyPromotion = promotions.filter(item => item.date === date && item.shop === dayOrders[0]?.shop).reduce((total, item) => total + item.amount, 0)
    const dailyAmount = dayRows.reduce((total, row) => total + row.amount, 0)
    let assigned = 0
    dayRows.forEach((row, index) => {
      row.promotion = index === dayRows.length - 1 ? round(dailyPromotion - assigned) : round(dailyPromotion * (dailyAmount ? row.amount / dailyAmount : 1 / dayRows.length))
      assigned = round(assigned + row.promotion)
    })
  })
  return [...rows.values()].map(row => {
    const amount = round(row.amount), cost = round(row.cost), promotion = round(row.promotion)
    const grossProfit = round(amount - cost), operationFee = round(amount * row.rate), estimatedProfit = round(grossProfit - promotion - operationFee)
    return { ...row, amount, cost, grossProfit, promotion, operationFee, estimatedProfit, quantity: round(row.quantity), margin: amount ? estimatedProfit / amount : 0 }
  }).sort((a, b) => b.date.localeCompare(a.date) || a.product.localeCompare(b.product, 'zh-CN'))
}

function combine(days: Summary[]): Summary | null {
  if (!days.length) return null
  const sum = (field: keyof Summary) => round(days.reduce((n, d) => n + Number(d[field] || 0), 0)); const missing = days.reduce((n, d) => n + d.missingCostOrders, 0); const orderCount = sum('orderCount'); const eligibleOrders = sum('eligibleOrders'); const settledOrders = sum('settledOrders')
  const productCost = missing ? null : sum('productCost'); const promotionFee = sum('promotionFee'); const effective = sum('effectiveSales'); const currentNet = sum('currentNet')
  const dates = days.map(d => d.date).sort()
  return { shop: days[0].shop, date: `${dates[0]} 至 ${dates[dates.length - 1]}`, orderCount, originalSales: sum('originalSales'), effectiveSales: effective, shippedRefund: sum('shippedRefund'), orderShippedRefund: sum('orderShippedRefund'), couponRefund: sum('couponRefund'), basicServiceFee: sum('basicServiceFee'), afterSaleCompensation: sum('afterSaleCompensation'), smallPayment: sum('smallPayment'), appealReimbursement: sum('appealReimbursement'), productCost, promotionFee, estimatedProfit: productCost == null ? null : round(effective - productCost - promotionFee), currentNet, unsettledAmount: sum('unsettledAmount'), profit: productCost == null ? null : round(currentNet - productCost - promotionFee), eligibleOrders, settledOrders, completionRate: eligibleOrders ? settledOrders / eligibleOrders : 1, mature: days.every(d => d.mature), missingCostOrders: missing, unknownFunds: sum('unknownFunds') }
}
