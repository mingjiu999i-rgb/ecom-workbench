import JSZip from 'jszip'
import { ChevronDown, ChevronRight, Download, FileSpreadsheet, RotateCcw, ShieldCheck, Upload } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import * as XLSX from '@e965/xlsx'
import { Modal } from '../components/Overlay'
import { useWorkbench } from '../store/workbench'
import type { CollectionRecord, ProfitRecord } from '../types/models'
import { isSupplementOrder, normalizeSpecification, resolveProductCost, type ProductCostMatch } from '../utils/orderCostMatching'
import type { Order, Refund, Fund, FundCategory, Promotion, Summary, ProductMetric } from '../utils/pddCalculations'
import { preparePddAccounting, reportFingerprint } from '../utils/pddLedger'
import { exportSettlementWorkbook, settlementExportValidation } from '../utils/settlementWorkbook'
import { mergeLinkSalesOrders, parseLinkSalesRows, type LinkSalesOrder } from '../utils/linkSales'

type Row = Record<string, string | number>
type DeductionBreakdown = { key: string; businessCode: string; businessName: string; accountType: string; deductionCount: number; deduction: number; reimbursementCount: number; reimbursement: number; netDeduction: number }
type SkuRow = { key: string; code: string; productId: string; product: string; specification: string; quantity: number; orders: Order[]; supplement: boolean; match?: ProductCostMatch }

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
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const overviewReturn = searchParams.get('returnTo') || '/'
  const returnTo = overviewReturn === '/' || overviewReturn.startsWith('/?') ? overviewReturn : '/'
  const requestedFocus = searchParams.get('focus') || ''
  const requestedStoreId = searchParams.get('store') || ''
  const requestedStore = data.stores.find(item => item.id === requestedStoreId)
  const requestedStart = searchParams.get('start') || ''
  const requestedEnd = searchParams.get('end') || ''
  const showSavedDetail = searchParams.get('detail') === 'saved'
  const savedDetailRef = useRef<HTMLElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [storeId, setStoreId] = useState(requestedStore?.id || '')
  const [exportClientId, setExportClientId] = useState(requestedStore?.clientId || '')
  const [startDate, setStartDate] = useState(requestedStart)
  const [endDate, setEndDate] = useState(requestedEnd)
  const [orders, setOrders] = useState<Map<string, Order>>(new Map())
  const [linkSalesBatch, setLinkSalesBatch] = useState<LinkSalesOrder[]>([])
  const [linkSalesWarning, setLinkSalesWarning] = useState('')
  const [refunds, setRefunds] = useState<Map<string, Refund>>(new Map())
  const [funds, setFunds] = useState<Map<string, Fund>>(new Map())
  const [promotions, setPromotions] = useState<Map<string, Promotion>>(new Map())
  const [manualCostIds, setManualCostIds] = useState<Map<string, string>>(new Map())
  const [messages, setMessages] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [importReady, setImportReady] = useState(false)
  const [reportTypes, setReportTypes] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [exportWarnings, setExportWarnings] = useState<string[]>([])
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set())
  const store = data.stores.find(item => item.id === storeId)
  const shop = store?.name || ''
  const activeStores = data.stores.filter(item => item.storeStatus !== '暂停' || item.id === storeId)

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
      // Sidecar only: keep real listing IDs separately. Settlement parsing below is unchanged.
      try {
        const listingRows = parseLinkSalesRows(storeId, rows)
        setLinkSalesBatch(current => [...current, ...listingRows])
        if (listingRows.length !== rows.length) setLinkSalesWarning('部分行缺少订单号，未进入商品 ID 分析；经营结算仍按原流程处理。')
      } catch { setLinkSalesWarning('商品 ID 独立分析读取失败，经营结算仍按原流程处理；请重新导入订单报表。') }
      setReportTypes(current => new Set([...current, 'orders']))
      setOrders(current => { const next = new Map(current); rows.forEach(row => { const id = text(row['订单号']); const payTime = text(row['支付时间'] || row['订单成交时间']); if (id) next.set(id, { id, shop: targetShop, payTime, payDate: dateText(payTime), receipt: amount(row['商家实收金额(元)']), status: text(row['订单状态']), productId: text(row['商品id'] || row['商品ID']), product: text(row['商品']), specification: text(row['商品规格']), skuCode: text(row['商家编码-规格维度']), quantity: Number(row['商品数量(件)'] || 0) }) }); return next })
      return `订单 ${rows.length} 行`
    }
    if (headerSet.has('售后编号') && headerSet.has('订单编号')) {
      setReportTypes(current => new Set([...current, 'refunds']))
      setRefunds(current => { const next = new Map(current); rows.forEach(row => { const id = text(row['售后编号']); const appliedAt = text(row['申请时间']); const approvedAt = text(row['同意退款时间'] || row['退款成功时间'] || row['售后完成时间']); if (id) next.set(id, { id, orderId: text(row['订单编号']), shop: targetShop, status: text(row['售后状态']), stage: text(row['订单状态']), refundAmount: amount(row['退款金额'] || row['退款金额(元)'] || row['退款金额（元）']), appliedAt, approvedAt, refundDate: dateText(approvedAt || appliedAt) }) }); return next })
      return `退款 ${rows.length} 行`
    }
    if (headerSet.has('商户订单号') && headerSet.has('发生时间')) {
      setReportTypes(current => new Set([...current, 'funds']))
      setFunds(current => { const next = new Map(current); const ordinals = new Map<string, number>(); rows.forEach(row => { const orderId = text(row['商户订单号']); if (!/^\d{6}-\d+$/.test(orderId)) return; const accountType = text(row['账务类型']); const businessDescription = text(row['业务描述']); const business = parseBusiness(businessDescription, accountType); const sig = signature(['商户订单号', '发生时间', '收入金额（+元）', '支出金额（-元）', '账务类型', '备注', '业务描述'].map(field => row[field])); const ordinal = (ordinals.get(sig) || 0) + 1; ordinals.set(sig, ordinal); const key = `${reportFingerprint(sig)}:${ordinal}`; next.set(key, { key, orderId, shop: targetShop, occurredAt: text(row['发生时间']), income: amount(row['收入金额（+元）']), expense: amount(row['支出金额（-元）']), accountType, businessCode: business.businessCode, businessName: business.businessName, businessDescription, category: classifyFund(accountType, businessDescription) }) }); return next })
      return `资金 ${rows.length} 行`
    }
    const promotion = promotionColumns(headerSet)
    if (promotion.date && promotion.spend) {
      setReportTypes(current => new Set([...current, 'promotions']))
      setPromotions(current => { const next = new Map(current); const ordinals = new Map<string, number>(); rows.forEach(row => { const date = dateText(row[promotion.date!]); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return; const value = Math.abs(amount(row[promotion.spend!])); const sig = signature([date, value, ...headers.filter(h => h !== promotion.date && h !== promotion.spend).map(h => row[h])]); const ordinal = (ordinals.get(sig) || 0) + 1; ordinals.set(sig, ordinal); const key = `${targetShop}|${sig}:${ordinal}`; next.set(key, { key, shop: targetShop, date, amount: value }) }); return next })
      return `推广 ${rows.length} 行`
    }
    throw new Error(`${name}：无法判断报表类型`)
  }

  const importFiles = async (files: FileList) => {
    const targetShop = shop.trim()
    if (!storeId || !targetShop) { setError('请先选择店铺'); return }
    setBusy(true); setError(''); setImportReady(false); setReportTypes(new Set())
    setLinkSalesBatch([]); setLinkSalesWarning('')
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
      setMessages(current => [...imported, ...current].slice(0, 12)); setImportReady(true)
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
  const savedRecords = useMemo(() => data.collectionRecords.filter(record => record.storeId === storeId).sort((a, b) => b.date.localeCompare(a.date)), [data.collectionRecords, storeId])
  const savedProfits = useMemo(() => data.profitRecords.filter(record => record.storeId === storeId), [data.profitRecords, storeId])
  const previousLedger = data.orderAccountingLedgers?.find(ledger => ledger.storeId === storeId)
  const accounting = useMemo(() => preparePddAccounting({
    storeId, shop, previous: previousLedger, orders: [...orders.values()], refunds: [...refunds.values()],
    funds: [...funds.values()], promotions: [...promotions.values()], reportTypes, savedRecords, savedProfits,
    resolveCost, linkedProductId, products: data.products,
  }), [storeId, shop, previousLedger, orders, refunds, funds, promotions, reportTypes, savedRecords, savedProfits, availableCosts, clientProducts, data.productLinks, data.products, manualCostIds])
  const { summaries, productMetrics } = accounting
  useEffect(() => {
    if (busy || !importReady || !linkSalesBatch.length) return
    // A separate update preserves every settlement field and never feeds back into accounting.
    update(current => mergeLinkSalesOrders(current, linkSalesBatch))
  }, [busy, importReady, linkSalesBatch, update])
  const total = useMemo(() => combine(summaries), [summaries])
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
  const exportValidation = useMemo(() => exportClientId ? settlementExportValidation(data, exportOptions) : { blocking: [], warnings: [] }, [data, exportClientId, exportOptions])

  useEffect(() => {
    if (!storeId || busy || !importReady) return
    const profitDates = new Set(summaries.filter(row => !row.missingCostOrders).map(row => row.date))
    const incomingMetrics = productMetrics.filter(row => profitDates.has(row.date))
    const fields: (keyof ProfitRecord)[] = ['amount', 'cost', 'grossProfit', 'promotion', 'operationRate', 'operationFee', 'estimatedProfit', 'quantity', 'margin']
    const incomingKeys = new Set(incomingMetrics.map(row => `${row.date}|${row.productId}`))
    const ledgerChanged = JSON.stringify(previousLedger) !== JSON.stringify(accounting.ledger)
    const collectionsChanged = summaries.some(row => {
      const existing = savedRecords.find(record => record.date === row.date)
      return !existing || existing.refundBasis !== 'order_paid_at' || collectionFields.some(field => existing[field] !== row[field])
    })
    const profitsChanged = savedProfits.some(record => profitDates.has(record.date) && !incomingKeys.has(`${record.date}|${record.productId}`)) || incomingMetrics.some(row => {
      const existing = savedProfits.find(record => record.date === row.date && record.productId === row.productId)
      return !existing || fields.some(field => existing[field] !== (field === 'operationRate' ? row.rate : row[field as keyof ProductMetric]))
    })
    if (!ledgerChanged && !collectionsChanged && !profitsChanged) return
    const timer = window.setTimeout(() => update(current => {
      const updatedAt = new Date().toISOString()
      const incoming = new Map(summaries.map(({ shop: _shop, ...row }) => [row.date, {
        ...row, id: `collection-${storeId}-${row.date}`, storeId, refundBasis: 'order_paid_at' as const, updatedAt,
      } satisfies CollectionRecord]))
      const incomingProfits = incomingMetrics.map(row => ({
        id: `profit-${storeId}-${row.date}-${row.productId}`, storeId, productId: row.productId, date: row.date,
        amount: row.amount, cost: row.cost, grossProfit: row.grossProfit, promotion: row.promotion, operationRate: row.rate,
        operationFee: row.operationFee, estimatedProfit: row.estimatedProfit, quantity: row.quantity, margin: row.margin, updatedAt,
      } satisfies ProfitRecord))
      return {
        ...current,
        orderAccountingLedgers: [...(current.orderAccountingLedgers || []).filter(ledger => ledger.storeId !== storeId), accounting.ledger],
        collectionRecords: [...current.collectionRecords.filter(record => record.storeId !== storeId || !incoming.has(record.date)), ...incoming.values()],
        profitRecords: [...current.profitRecords.filter(record => record.storeId !== storeId || !profitDates.has(record.date)), ...incomingProfits],
      }
    }), 600)
    return () => window.clearTimeout(timer)
  }, [storeId, busy, importReady, accounting, previousLedger, savedRecords, savedProfits, summaries, productMetrics, update])

  useEffect(() => {
    setExpandedMonths(savedMonthGroups[0] ? new Set([savedMonthGroups[0].month]) : new Set())
  }, [storeId, savedMonthSignature])

  const clear = () => { setImportReady(false); setReportTypes(new Set()); setOrders(new Map()); setRefunds(new Map()); setFunds(new Map()); setPromotions(new Map()); setManualCostIds(new Map()); setMessages([]); setError(''); setLinkSalesBatch([]); setLinkSalesWarning('') }
  useEffect(() => {
    setStoreId(requestedStore?.id || '')
    setExportClientId(requestedStore?.clientId || '')
    setStartDate(requestedStart)
    setEndDate(requestedEnd)
    clear()
  }, [requestedStore?.id, requestedStore?.clientId, requestedStart, requestedEnd])

  useEffect(() => {
    if (!showSavedDetail || !storeId || requestedFocus) return
    const frame = window.requestAnimationFrame(() => savedDetailRef.current?.scrollIntoView({ block: 'start' }))
    return () => window.cancelAnimationFrame(frame)
  }, [showSavedDetail, storeId, startDate, endDate, requestedFocus])
  const exportResult = () => {
    if (!exportClientId) { setError('请先选择要导出的甲方'); return }
    if (exportValidation.blocking.length) { setError(exportValidation.blocking.join('；')); return }
    if (exportValidation.warnings.length) { setExportWarnings(exportValidation.warnings); return }
    try { exportSettlementWorkbook(data, exportOptions, true) } catch (cause) { setError(cause instanceof Error ? cause.message : '经营结算表导出失败') }
  }

  const confirmWarningExport = () => {
    setExportWarnings([])
    try { exportSettlementWorkbook(data, exportOptions, true) } catch (cause) { setError(cause instanceof Error ? cause.message : '经营结算表导出失败') }
  }

  return <div className="page page-wide pdd-page">
    {showSavedDetail && <div className="settlement-detail-context"><Link className="text-button" to={returnTo}>← 返回总览</Link><span>{store ? `${store.name} · ${startDate || '全部日期'}${endDate && startDate !== endDate ? ` 至 ${endDate}` : ''}` : '请选择店铺查看经营结算详情'}</span></div>}
    {requestedFocus && <div className="settlement-process-guide"><div><strong>{requestedFocus === 'costs' ? '补全成本与利润' : '重新导入并核对数据'}</strong><p>{requestedFocus === 'costs' ? '先补充产品成本，再重新导入该店铺的订单、退款、资金和推广报表，更新这一天的利润。' : '重新导入该店铺覆盖所选日期的完整报表，核对产品利润和每日回款汇总。'}</p></div><div className="heading-actions">{requestedFocus === 'costs' && <Link className="button secondary" to={`/product-costs?${new URLSearchParams({ client: store?.clientId || '', returnTo: `${location.pathname}${location.search}` })}`}>补充产品成本</Link>}<button className="button primary" disabled={!storeId || busy} onClick={() => inputRef.current?.click()}>导入报表</button></div></div>}
    <div className="page-heading"><div><span className="eyebrow">订单回款 + 产品利润</span><h1>甲方经营结算</h1><p>一次导入同时更新各店铺回款与跨店产品利润，所有甲方统一导出总览、产品预览和每店独立回款明细。</p></div><div className="heading-actions"><button className="button secondary" onClick={clear}><RotateCcw size={16} />清空本次数据</button><button className="button primary" disabled={!exportClientId || !exportRecordCount} onClick={exportResult}><Download size={16} />导出甲方结算</button></div></div>
    <section className="privacy-strip"><ShieldCheck size={18} /><div><strong>保存汇总与回填索引</strong><span>保存订单号、成交日期、成本金额及售后／流水计算索引，用于历史回填和重复导入去重；不保存原始文件和收件人信息。</span></div></section>
    <div className="store-reset-entry"><span>报表导错店铺？可清空该店全部日期的经营数据后重传，清空前系统自动暂存、支持撤销；结算计算规则不变。</span><Link to={`/store-business-reset${storeId ? `?store=${encodeURIComponent(storeId)}` : ''}`}>单店数据重置</Link></div>
    <section className="panel pdd-import"><div><label className="field"><span>选择店铺</span><select value={storeId} onChange={event => { const nextStoreId = event.target.value; setStoreId(nextStoreId); setExportClientId(data.stores.find(item => item.id === nextStoreId)?.clientId || ''); clear() }}><option value="">请选择店铺</option>{activeStores.map(item => <option key={item.id} value={item.id}>{data.clients.find(client => client.id === item.clientId)?.name} · {item.name}</option>)}</select></label><p>一次选择同一店铺的订单、退款、资金和推广费文件；首次导入订单后，后续可只补导售后或资金报表，自动回填原订单日期；历史推广费保留，重叠报表自动去重。</p></div><button className="button primary" disabled={busy || !storeId} onClick={() => inputRef.current?.click()}><Upload size={16} />{busy ? '正在解析…' : '选择报表并计算'}</button><input ref={inputRef} hidden type="file" multiple accept=".csv,.xls,.xlsx,.zip" onChange={event => event.target.files && void importFiles(event.target.files)} /></section>
    {linkSalesWarning && <div className="pdd-message warning" role="alert">{linkSalesWarning}</div>}
    {importReady && linkSalesBatch.length > 0 && <div className="pdd-message"><span>已额外记录本次订单的商品 ID；不扣退款的链接利润请到 <Link to="/link-profit">商品 ID 盈亏</Link> 填写每日推广费。</span></div>}
    <section className="panel pdd-import profit-import"><div><div className="form-grid"><label className="field field-full"><span>导出甲方</span><select value={exportClientId} onChange={event => setExportClientId(event.target.value)}><option value="">请选择甲方</option>{data.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label><label className="field"><span>开始日期</span><input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></label><label className="field"><span>结束日期</span><input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} /></label></div><p>所有甲方统一导出“总览 + 产品预览 + 每个店铺独立回款明细”，可在各工作表分别隐藏行列；日期留空表示全部。{exportValidation.blocking.length ? ` 当前无法导出：${exportValidation.blocking.join('；')}` : exportValidation.warnings.length ? ' 当前有数据提醒，点击导出后可选择重新导入或忽略提醒继续。' : exportRecordCount ? ` 已找到 ${exportRecordCount} 条回款记录。` : ''}</p></div><button className="button primary" disabled={!exportClientId || !exportRecordCount} onClick={exportResult}><Download size={16} />导出甲方结算</button></section>
    {exportValidation.warnings.length > 0 && <div className="pdd-message warning"><strong>数据提醒</strong><span>{exportValidation.warnings.join('；')}。仍可点击“导出甲方结算”选择忽略并继续。</span></div>}
    {importReady && (accounting.unmatchedRefunds > 0 || accounting.unmatchedFunds > 0) && <div className="pdd-message warning"><strong>有记录待回填</strong><span>{accounting.unmatchedRefunds} 条成功售后、{accounting.unmatchedFunds} 条资金流水尚未找到原订单；已保存计算索引，补导对应历史订单后会自动回填，不会计入发生当天。</span></div>}
    {importReady && accounting.blockedDates.length > 0 && <div className="pdd-message warning"><strong>历史索引待初始化</strong><span>{accounting.blockedDates.join('、')} 的旧数据只有每日汇总。请一次性补导这些日期的完整订单、售后和资金报表；建立索引后无需重复导入固定报表，现有汇总暂时保留。</span></div>}
    {importReady && accounting.pendingRefundFunds > 0 && <div className="pdd-message warning"><strong>退款资金待补齐</strong><span>{accounting.pendingRefundFunds} 个已发货退款订单尚无对应退款资金流水。退款金额以实际资金为准，补导流水后自动回填。</span></div>}
    {error && <div className="pdd-message error">{error}</div>}
    {messages.length > 0 && <div className="pdd-message ok"><FileSpreadsheet size={16} /><span>{messages.join('；')}</span></div>}
    {deductionBreakdown.length > 0 && <section className="panel table-panel pdd-deduction-panel"><div className="table-caption"><div><strong>扣款明细（按业务分类）</strong><span>按资金原表全量业务代码分别汇总；扣款与补回独立展示，不相互抵消。</span></div><div className="cost-count">扣款 <b>{money(deductionTotals.deduction)}</b> · 补回 <b>{money(deductionTotals.reimbursement)}</b> · 净扣款 <b>{money(deductionTotals.netDeduction)}</b></div></div><div className="table-scroll"><table><thead><tr>{['业务代码','扣款分类','账务类型','扣款笔数','扣款金额','补回笔数','补回金额','净扣款'].map(header => <th key={header}>{header}</th>)}</tr></thead><tbody><tr className="profit-total-row"><td colSpan={3}><strong>全部分类合计</strong></td><td>{deductionBreakdown.reduce((sum, row) => sum + row.deductionCount, 0)}</td><td>{money(deductionTotals.deduction)}</td><td>{deductionBreakdown.reduce((sum, row) => sum + row.reimbursementCount, 0)}</td><td>{money(deductionTotals.reimbursement)}</td><td className={deductionTotals.netDeduction < 0 ? 'positive' : 'negative'}>{money(deductionTotals.netDeduction)}</td></tr>{deductionBreakdown.map(row => <tr key={row.key}><td><strong className="cell-main">{row.businessCode || '未识别'}</strong></td><td>{row.businessName}</td><td>{row.accountType || '—'}</td><td>{row.deductionCount}</td><td>{money(row.deduction)}</td><td>{row.reimbursementCount}</td><td>{money(row.reimbursement)}</td><td className={row.netDeduction < 0 ? 'positive' : 'negative'}>{money(row.netDeduction)}</td></tr>)}</tbody></table></div></section>}
    {skuRows.length > 0 && <section className="panel table-panel pdd-cost-panel"><div className="table-caption"><div><strong>SKU 成本匹配</strong><span>此处显示当前匹配成本，新订单首次导入后锁定；历史订单沿用原成本。空编码按同一甲方产品的规格匹配，补收差价不计销量和成本。</span></div><div className="cost-count"><b>{skuRows.filter(row => row.match).length}</b> 个已匹配 · <b>{skuRows.filter(row => row.supplement).length}</b> 个补差价 · <b>{skuRows.filter(row => !row.supplement && !row.match).length}</b> 个待处理</div></div><div className="table-scroll"><table><thead><tr><th>SKU 编码</th><th>报表商品/规格</th><th>售出数量</th><th>成本来源</th><th>单件总成本</th></tr></thead><tbody>{skuRows.map(row => { const match = row.match; const example = row.orders[0]; const key = manualCostKey(example); return <tr key={row.key}><td><strong className="cell-main">{row.code || '空编码'}</strong></td><td><div className="cell-main">{match?.product || row.product || row.productId || '未填写商品ID'}</div><div className="cell-sub">{match?.specification || row.specification || '未填写规格'}</div></td><td>{row.supplement ? '不计销量' : row.quantity}</td><td>{row.supplement ? <span className="link-status status-备用">补收差价</span> : match ? <span className="link-status status-日销">{match.source}匹配</span> : <span className="link-status status-已挂">待匹配</span>}</td><td>{row.supplement ? '不计成本' : match ? <strong className="positive">{money(match.cost)}</strong> : <select value={manualCostIds.get(key) || ''} onChange={event => setManualCostIds(current => { const next = new Map(current); if (event.target.value) next.set(key, event.target.value); else next.delete(key); return next })}><option value="">选择网站成本 SKU</option>{availableCosts.map(cost => <option key={cost.id} value={cost.id}>{data.products.find(product => product.id === cost.productId)?.name} · {cost.skuCode || '空编码'} · {cost.specification} · {money(cost.totalCost)}</option>)}</select>}</td></tr> })}</tbody></table></div></section>}
    {skuRows.some(row => !row.supplement && !row.match) && <div className="pdd-message error">仍有 {skuRows.filter(row => !row.supplement && !row.match).length} 个 SKU/规格未匹配成本。产品利润不会保存，甲方结算表也会停止导出，避免利润被低估。</div>}
    {total ? <><section className="pdd-metrics">{[['有效订单销售额', money(total.effectiveSales)], ['订单净回款', money(total.currentNet)], ['未回款金额', money(total.unsettledAmount)], ['推广费', money(total.promotionFee)], ['当前盈亏', money(total.profit)]].map(([label, value]) => <article className="metric" key={label}><div><span>{label}</span><strong>{value}</strong></div></article>)}</section>
      <section className="panel table-panel"><div className="table-caption"><div><strong>每日经营主表</strong><span>退款按原订单成交日期回填；后续退款会更新原日期的有效销售额和利润，推广费仍归属消耗当天。退款金额以资金流水为准，SKU 成本按首次导入锁定。基础技术服务费只统计扣除部分。</span></div></div><div className="table-scroll"><table><thead><tr>{['成交日期','订单数','订单成交额','已发货退款','优惠券退款','有效订单销售额','基础技术服务费','售后补偿消费者','小额打款','申诉补回','商品成本','推广费','预估盈亏','订单净回款','未回款金额','当前盈亏','入账状态'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{[total, ...summaries].map((s, index) => <tr key={`${s.date}-${index}`}><td className="cell-main">{index === 0 ? `累计：${s.date}` : s.date}</td><td>{s.orderCount}</td><td>{money(s.originalSales)}</td><td>{money(s.shippedRefund)}</td><td>{money(s.couponRefund)}</td><td>{money(s.effectiveSales)}</td><td>{money(s.basicServiceFee)}</td><td>{money(s.afterSaleCompensation)}</td><td>{money(s.smallPayment)}</td><td>{money(s.appealReimbursement)}</td><td>{money(s.productCost)}</td><td>{money(s.promotionFee)}</td><td>{money(s.estimatedProfit)}</td><td>{money(s.currentNet)}</td><td>{money(s.unsettledAmount)}</td><td className={s.profit != null && s.profit < 0 ? 'negative' : 'positive'}>{money(s.profit)}</td><td><span className={`status ${s.mature ? 'normal' : 'risk'}`}><i />{s.mature ? '已完成' : '未完成'}</span></td></tr>)}</tbody></table></div></section>
    </> : <section className="panel pdd-empty"><FileSpreadsheet size={28} /><strong>{importReady ? '本次暂无可回填的订单' : '尚未导入报表'}</strong><span>选择店铺后导入报表；后续可以只补导售后或资金报表。</span></section>}
    {savedTotal && <section ref={savedDetailRef} className="panel table-panel saved-profit-panel">
      <div className="table-caption"><div><strong>云端每日订单回款</strong><span>后续售后和订单资金变动自动回填成交日期；当前日期筛选会同步应用到导出结果。</span></div><div className="cost-count">云端状态：<b>{syncStatus === 'saving' ? '保存中…' : syncStatus === 'error' ? '保存失败' : '已保存'}</b> · <b>{filteredRecords.length}</b> 条记录</div></div>
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
    {exportWarnings.length > 0 && <Modal title="发现历史数据提醒" onClose={() => setExportWarnings([])}><div className="modal-body settlement-warning"><p>以下数据可能影响退款口径或产品利润，但不会强制阻止导出：</p><ul>{exportWarnings.map(issue => <li key={issue}>{issue}</li>)}</ul><p>选择继续后，将按当前已有数据生成经营结算表。</p></div><div className="modal-actions"><button className="button ghost" onClick={() => setExportWarnings([])}>返回重新导入</button><button className="button primary" onClick={confirmWarningExport}>忽略提醒，继续导出</button></div></Modal>}
  </div>
}


function combine(days: Summary[]): Summary | null {
  if (!days.length) return null
  const sum = (field: keyof Summary) => round(days.reduce((n, d) => n + Number(d[field] || 0), 0)); const missing = days.reduce((n, d) => n + d.missingCostOrders, 0); const orderCount = sum('orderCount'); const eligibleOrders = sum('eligibleOrders'); const settledOrders = sum('settledOrders')
  const productCost = missing ? null : sum('productCost'); const promotionFee = sum('promotionFee'); const effective = sum('effectiveSales'); const currentNet = sum('currentNet')
  const dates = days.map(d => d.date).sort()
  return { shop: days[0].shop, date: `${dates[0]} 至 ${dates[dates.length - 1]}`, orderCount, originalSales: sum('originalSales'), effectiveSales: effective, shippedRefund: sum('shippedRefund'), orderShippedRefund: sum('orderShippedRefund'), couponRefund: sum('couponRefund'), basicServiceFee: sum('basicServiceFee'), afterSaleCompensation: sum('afterSaleCompensation'), smallPayment: sum('smallPayment'), appealReimbursement: sum('appealReimbursement'), productCost, promotionFee, estimatedProfit: productCost == null ? null : round(effective - productCost - promotionFee), currentNet, unsettledAmount: sum('unsettledAmount'), profit: productCost == null ? null : round(currentNet - productCost - promotionFee), eligibleOrders, settledOrders, completionRate: eligibleOrders ? settledOrders / eligibleOrders : 1, mature: days.every(d => d.mature), missingCostOrders: missing, unknownFunds: sum('unknownFunds') }
}
