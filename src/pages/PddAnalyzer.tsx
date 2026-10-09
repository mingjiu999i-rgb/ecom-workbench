import JSZip from 'jszip'
import { ChevronDown, ChevronRight, Download, FileSpreadsheet, RotateCcw, ShieldCheck, Upload } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from '@e965/xlsx'
import { useWorkbench } from '../store/workbench'
import type { CollectionRecord } from '../types/models'

type Row = Record<string, string | number>
type Order = { id: string; shop: string; payTime: string; payDate: string; receipt: number; status: string; productId: string; specification: string; skuCode: string; quantity: number }
type Refund = { id: string; orderId: string; shop: string; status: string; stage: string; refundAmount: number }
type FundCategory = 'positive' | 'refund' | 'other' | 'transfer' | 'promotion' | 'unknown'
type Fund = { key: string; orderId: string; shop: string; occurredAt: string; income: number; expense: number; accountType: string; businessCode: string; businessName: string; businessDescription: string; category: FundCategory }
type Promotion = { key: string; shop: string; date: string; amount: number }
type Summary = { shop: string; date: string; orderCount: number; originalSales: number; effectiveSales: number; shippedRefund: number; couponRefund: number; basicServiceFee: number; afterSaleCompensation: number; smallPayment: number; appealReimbursement: number; productCost: number | null; promotionFee: number; estimatedProfit: number | null; currentNet: number; unsettledAmount: number; profit: number | null; eligibleOrders: number; settledOrders: number; completionRate: number; mature: boolean; missingCostOrders: number; unknownFunds: number }
type DeductionBreakdown = { key: string; businessCode: string; businessName: string; accountType: string; deductionCount: number; deduction: number; reimbursementCount: number; reimbursement: number; netDeduction: number }

const collectionFields: (keyof Summary & keyof CollectionRecord)[] = ['date', 'orderCount', 'originalSales', 'effectiveSales', 'shippedRefund', 'couponRefund', 'basicServiceFee', 'afterSaleCompensation', 'smallPayment', 'appealReimbursement', 'productCost', 'promotionFee', 'estimatedProfit', 'currentNet', 'unsettledAmount', 'profit', 'eligibleOrders', 'settledOrders', 'completionRate', 'mature', 'missingCostOrders', 'unknownFunds']

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
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [orders, setOrders] = useState<Map<string, Order>>(new Map())
  const [refunds, setRefunds] = useState<Map<string, Refund>>(new Map())
  const [funds, setFunds] = useState<Map<string, Fund>>(new Map())
  const [promotions, setPromotions] = useState<Map<string, Promotion>>(new Map())
  const [manualCosts, setManualCosts] = useState<Map<string, number>>(new Map())
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
      setOrders(current => { const next = new Map(current); rows.forEach(row => { const id = text(row['订单号']); const payTime = text(row['支付时间'] || row['订单成交时间']); if (id) next.set(id, { id, shop: targetShop, payTime, payDate: dateText(payTime), receipt: amount(row['商家实收金额(元)']), status: text(row['订单状态']), productId: text(row['商品id']), specification: text(row['商品规格']), skuCode: text(row['商家编码-规格维度']), quantity: Number(row['商品数量(件)'] || 0) }) }); return next })
      return `订单 ${rows.length} 行`
    }
    if (headerSet.has('售后编号') && headerSet.has('订单编号')) {
      setRefunds(current => { const next = new Map(current); rows.forEach(row => { const id = text(row['售后编号']); if (id) next.set(id, { id, orderId: text(row['订单编号']), shop: targetShop, status: text(row['售后状态']), stage: text(row['订单状态']), refundAmount: amount(row['退款金额'] || row['退款金额(元)'] || row['退款金额（元）']) }) }); return next })
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

  const libraryCosts = useMemo(() => {
    const storeClientId = store?.clientId
    const preferred = storeClientId ? data.productCosts.filter(item => data.products.find(product => product.id === item.productId)?.clientId === storeClientId) : data.productCosts
    const fallback = storeClientId ? data.productCosts : []
    const matches = new Map<string, { cost: number; product: string; specification: string }>()
    for (const item of [...fallback, ...preferred]) {
      const code = item.skuCode.trim()
      if (!code) continue
      matches.set(code, { cost: Number(item.totalCost), product: data.products.find(product => product.id === item.productId)?.name || '未关联商品', specification: item.specification })
    }
    return matches
  }, [data.productCosts, data.products, store?.clientId])
  const resolvedCosts = useMemo(() => {
    const result = new Map(manualCosts)
    libraryCosts.forEach((match, code) => result.set(`${shop.trim()}|${code}`, match.cost))
    return result
  }, [manualCosts, libraryCosts, shop])
  const skuRows = useMemo(() => {
    const grouped = new Map<string, { code: string; productId: string; specification: string; quantity: number }>()
    orders.forEach(order => { if (!order.skuCode) return; const row = grouped.get(order.skuCode) || { code: order.skuCode, productId: order.productId, specification: order.specification, quantity: 0 }; row.quantity += order.quantity; grouped.set(order.skuCode, row) })
    return [...grouped.values()].sort((a, b) => a.code.localeCompare(b.code, 'zh-CN'))
  }, [orders])
  const summaries = useMemo(() => calculateSummaries([...orders.values()], [...refunds.values()], [...funds.values()], [...promotions.values()], resolvedCosts), [orders, refunds, funds, promotions, resolvedCosts])
  const total = useMemo(() => combine(summaries), [summaries])
  const savedRecords = useMemo(() => data.collectionRecords.filter(record => record.storeId === storeId).sort((a, b) => b.date.localeCompare(a.date)), [data.collectionRecords, storeId])
  const filteredRecords = useMemo(() => savedRecords.filter(record => (!startDate || record.date >= startDate) && (!endDate || record.date <= endDate)), [savedRecords, startDate, endDate])
  const savedSummaries = useMemo(() => filteredRecords.map(record => ({ shop, date: record.date, orderCount: record.orderCount, originalSales: record.originalSales, effectiveSales: record.effectiveSales, shippedRefund: record.shippedRefund, couponRefund: record.couponRefund, basicServiceFee: record.basicServiceFee, afterSaleCompensation: record.afterSaleCompensation, smallPayment: record.smallPayment, appealReimbursement: record.appealReimbursement, productCost: record.productCost, promotionFee: record.promotionFee, estimatedProfit: record.estimatedProfit, currentNet: record.currentNet, unsettledAmount: record.unsettledAmount, profit: record.profit, eligibleOrders: record.eligibleOrders, settledOrders: record.settledOrders, completionRate: record.completionRate, mature: record.mature, missingCostOrders: record.missingCostOrders, unknownFunds: record.unknownFunds })), [filteredRecords, shop])
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

  useEffect(() => {
    if (!storeId || busy || !orders.size || !funds.size || !summaries.length) return
    const changed = summaries.some(row => {
      const existing = data.collectionRecords.find(record => record.storeId === storeId && record.date === row.date)
      return !existing || collectionFields.some(field => existing[field] !== row[field])
    })
    if (!changed) return
    const timer = window.setTimeout(() => update(current => {
      const incoming = new Map(summaries.map(row => {
        const record: CollectionRecord = { id: `collection-${storeId}-${row.date}`, storeId, date: row.date, orderCount: row.orderCount, originalSales: row.originalSales, effectiveSales: row.effectiveSales, shippedRefund: row.shippedRefund, couponRefund: row.couponRefund, basicServiceFee: row.basicServiceFee, afterSaleCompensation: row.afterSaleCompensation, smallPayment: row.smallPayment, appealReimbursement: row.appealReimbursement, productCost: row.productCost, promotionFee: row.promotionFee, estimatedProfit: row.estimatedProfit, currentNet: row.currentNet, unsettledAmount: row.unsettledAmount, profit: row.profit, eligibleOrders: row.eligibleOrders, settledOrders: row.settledOrders, completionRate: row.completionRate, mature: row.mature, missingCostOrders: row.missingCostOrders, unknownFunds: row.unknownFunds, updatedAt: new Date().toISOString() }
        return [`${storeId}|${row.date}`, record]
      }))
      return { ...current, collectionRecords: [...current.collectionRecords.filter(record => !incoming.has(`${record.storeId}|${record.date}`)), ...incoming.values()] }
    }), 600)
    return () => window.clearTimeout(timer)
  }, [busy, data.collectionRecords, funds.size, orders.size, storeId, summaries, update])

  useEffect(() => {
    setExpandedMonths(savedMonthGroups[0] ? new Set([savedMonthGroups[0].month]) : new Set())
  }, [storeId, savedMonthSignature])

  const clear = () => { setOrders(new Map()); setRefunds(new Map()); setFunds(new Map()); setPromotions(new Map()); setManualCosts(new Map()); setMessages([]); setError('') }
  const exportResult = () => {
    if (!savedTotal) return
    const summaryRows = [savedTotal, ...savedSummaries].map(s => ({ 店铺名称: s.shop, 成交日期: s.date, 订单数: s.orderCount, 订单成交额: s.originalSales, 已发货退款: s.shippedRefund, 优惠券退款: s.couponRefund, 有效订单销售额: s.effectiveSales, 基础技术服务费: s.basicServiceFee, 售后补偿消费者: s.afterSaleCompensation, 小额打款: s.smallPayment, 申诉补回: s.appealReimbursement, 商品成本: s.productCost, 推广费: s.promotionFee, 预估盈亏: s.estimatedProfit, 订单净回款: s.currentNet, 未回款金额: s.unsettledAmount, 当前盈亏: s.profit, 入账完成率: s.completionRate, 入账状态: s.mature ? '入账已完成' : '入账未完成' }))
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows), '订单回款汇总')
    const range = startDate || endDate ? `${startDate || '最早'}_${endDate || '最新'}` : '全部日期'
    XLSX.writeFile(workbook, `${shop || '店铺'}_订单回款_${range}.xlsx`)
  }

  return <div className="page page-wide pdd-page">
    <div className="page-heading"><div><span className="eyebrow">浏览器计算 · 云端汇总</span><h1>拼多多订单经营分析</h1><p>原始报表仅在当前浏览器计算，云端只保存每日计算结果。</p></div><div className="heading-actions"><button className="button secondary" onClick={clear}><RotateCcw size={16} />清空本次数据</button><button className="button primary" disabled={!savedTotal} onClick={exportResult}><Download size={16} />导出筛选结果</button></div></div>
    <section className="privacy-strip"><ShieldCheck size={18} /><div><strong>仅保存计算结果</strong><span>上传文件、订单明细、退款明细和资金流水不会保存或上传到云端。</span></div></section>
    <section className="panel pdd-import"><div><label className="field"><span>选择店铺</span><select value={storeId} onChange={event => { setStoreId(event.target.value); clear() }}><option value="">请选择店铺</option>{activeStores.map(item => <option key={item.id} value={item.id}>{data.clients.find(client => client.id === item.clientId)?.name} · {item.name}</option>)}</select></label><p>一次选择同一店铺的订单、退款、资金和推广费文件；每次导入会替换本次浏览器中的原始数据。</p></div><button className="button primary" disabled={busy || !storeId} onClick={() => inputRef.current?.click()}><Upload size={16} />{busy ? '正在解析…' : '选择报表并计算'}</button><input ref={inputRef} hidden type="file" multiple accept=".csv,.xls,.xlsx,.zip" onChange={event => event.target.files && void importFiles(event.target.files)} /></section>
    <section className="panel pdd-import profit-import"><div><div className="form-grid"><label className="field"><span>开始日期</span><input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></label><label className="field"><span>结束日期</span><input type="date" value={endDate} onChange={event => setEndDate(event.target.value)} /></label></div><p>日期筛选同时作用于下方云端汇总和 Excel 导出；留空表示全部日期。</p></div><button className="button primary" disabled={!savedTotal} onClick={exportResult}><Download size={16} />导出筛选结果</button></section>
    {error && <div className="pdd-message error">{error}</div>}
    {messages.length > 0 && <div className="pdd-message ok"><FileSpreadsheet size={16} /><span>{messages.join('；')}</span></div>}
    {deductionBreakdown.length > 0 && <section className="panel table-panel pdd-deduction-panel"><div className="table-caption"><div><strong>扣款明细（按业务分类）</strong><span>按资金原表全量业务代码分别汇总；扣款与补回独立展示，不相互抵消。</span></div><div className="cost-count">扣款 <b>{money(deductionTotals.deduction)}</b> · 补回 <b>{money(deductionTotals.reimbursement)}</b> · 净扣款 <b>{money(deductionTotals.netDeduction)}</b></div></div><div className="table-scroll"><table><thead><tr>{['业务代码','扣款分类','账务类型','扣款笔数','扣款金额','补回笔数','补回金额','净扣款'].map(header => <th key={header}>{header}</th>)}</tr></thead><tbody><tr className="profit-total-row"><td colSpan={3}><strong>全部分类合计</strong></td><td>{deductionBreakdown.reduce((sum, row) => sum + row.deductionCount, 0)}</td><td>{money(deductionTotals.deduction)}</td><td>{deductionBreakdown.reduce((sum, row) => sum + row.reimbursementCount, 0)}</td><td>{money(deductionTotals.reimbursement)}</td><td className={deductionTotals.netDeduction < 0 ? 'positive' : 'negative'}>{money(deductionTotals.netDeduction)}</td></tr>{deductionBreakdown.map(row => <tr key={row.key}><td><strong className="cell-main">{row.businessCode || '未识别'}</strong></td><td>{row.businessName}</td><td>{row.accountType || '—'}</td><td>{row.deductionCount}</td><td>{money(row.deduction)}</td><td>{row.reimbursementCount}</td><td>{money(row.reimbursement)}</td><td className={row.netDeduction < 0 ? 'positive' : 'negative'}>{money(row.netDeduction)}</td></tr>)}</tbody></table></div></section>}
    {skuRows.length > 0 && <section className="panel table-panel pdd-cost-panel"><div className="table-caption"><div><strong>SKU 成本匹配</strong><span>优先自动匹配产品成本库；未匹配项可手动填写本次成本。匹配字段：商家编码-规格维度＝SKU 编码。</span></div><div className="cost-count"><b>{skuRows.filter(row => libraryCosts.has(row.code)).length}</b> 个自动匹配 · <b>{skuRows.filter(row => !libraryCosts.has(row.code) && manualCosts.has(`${shop.trim()}|${row.code}`)).length}</b> 个手动填写 · <b>{skuRows.filter(row => !libraryCosts.has(row.code) && !manualCosts.has(`${shop.trim()}|${row.code}`)).length}</b> 个待填写</div></div><div className="table-scroll"><table><thead><tr><th>SKU 编码</th><th>报表商品/规格</th><th>售出数量</th><th>成本来源</th><th>单件总成本</th></tr></thead><tbody>{skuRows.map(row => { const automatic = libraryCosts.get(row.code); const manualKey = `${shop.trim()}|${row.code}`; return <tr key={row.code}><td><strong className="cell-main">{row.code}</strong></td><td><div className="cell-main">{automatic?.product || row.productId || '未填写商品ID'}</div><div className="cell-sub">{automatic?.specification || row.specification || '未填写规格'}</div></td><td>{row.quantity}</td><td>{automatic ? <span className="link-status status-日销">成本库自动匹配</span> : <span className="link-status status-备用">手动填写</span>}</td><td>{automatic ? <strong className="positive">{money(automatic.cost)}</strong> : <input className="cost-input" type="number" min="0" step="0.01" placeholder="填写单件总成本" value={manualCosts.get(manualKey) ?? ''} onChange={event => setManualCosts(current => { const next = new Map(current); if (event.target.value === '') next.delete(manualKey); else next.set(manualKey, Number(event.target.value)); return next })} />}</td></tr> })}</tbody></table></div></section>}
    {total ? <><section className="pdd-metrics">{[['有效订单销售额', money(total.effectiveSales)], ['订单净回款', money(total.currentNet)], ['未回款金额', money(total.unsettledAmount)], ['推广费', money(total.promotionFee)], ['当前盈亏', money(total.profit)]].map(([label, value]) => <article className="metric" key={label}><div><span>{label}</span><strong>{value}</strong></div></article>)}</section>
      <section className="panel table-panel"><div className="table-caption"><div><strong>每日经营主表</strong><span>订单成交额已排除未发货退款和已取消订单；基础技术服务费只统计扣除部分。</span></div></div><div className="table-scroll"><table><thead><tr>{['成交日期','订单数','订单成交额','已发货退款','优惠券退款','有效订单销售额','基础技术服务费','售后补偿消费者','小额打款','申诉补回','商品成本','推广费','预估盈亏','订单净回款','未回款金额','当前盈亏','入账状态'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{[total, ...summaries].map((s, index) => <tr key={`${s.date}-${index}`}><td className="cell-main">{index === 0 ? `累计：${s.date}` : s.date}</td><td>{s.orderCount}</td><td>{money(s.originalSales)}</td><td>{money(s.shippedRefund)}</td><td>{money(s.couponRefund)}</td><td>{money(s.effectiveSales)}</td><td>{money(s.basicServiceFee)}</td><td>{money(s.afterSaleCompensation)}</td><td>{money(s.smallPayment)}</td><td>{money(s.appealReimbursement)}</td><td>{money(s.productCost)}</td><td>{money(s.promotionFee)}</td><td>{money(s.estimatedProfit)}</td><td>{money(s.currentNet)}</td><td>{money(s.unsettledAmount)}</td><td className={s.profit != null && s.profit < 0 ? 'negative' : 'positive'}>{money(s.profit)}</td><td><span className={`status ${s.mature ? 'normal' : 'risk'}`}><i />{s.mature ? '已完成' : '未完成'}</span></td></tr>)}</tbody></table></div></section>
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

function calculateSummaries(orders: Order[], refunds: Refund[], funds: Fund[], promotions: Promotion[], costs: Map<string, number>): Summary[] {
  const days = [...new Set(orders.filter(o => o.payDate).map(o => `${o.shop}|${o.payDate}`))].sort().reverse()
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
    const shippedRefund = [...shippedRefundByOrder.values()].reduce((n, value) => n + value, 0)
    const couponRefund = [...shippedCouponRefundByOrder.values()].reduce((n, value) => n + value, 0); const effective = original - shippedRefund - couponRefund
    const positive = new Set(dayFunds.filter(f => f.category === 'positive' && f.income > 0).map(f => f.orderId))
    const unsettledAmount = dayOrders.filter(o => eligible.has(o.id) && !positive.has(o.id)).reduce((n, o) => n + Math.max(0, o.receipt - (shippedRefundByOrder.get(o.id) || 0) - (shippedCouponRefundByOrder.get(o.id) || 0)), 0)
    const currentNet = dayFunds.filter(f => ['positive', 'refund', 'other'].includes(f.category)).reduce((n, f) => n + f.income + f.expense, 0)
    const basicServiceFee = dayFunds.filter(f => f.businessCode === '0030002' && f.expense < 0).reduce((n, f) => n + Math.abs(f.expense), 0)
    const afterSaleCompensation = dayFunds.filter(f => f.businessCode === '0040002' && f.expense < 0).reduce((n, f) => n + Math.abs(f.expense), 0)
    const smallPayment = dayFunds.filter(f => f.businessCode === '0040001' && f.expense < 0).reduce((n, f) => n + Math.abs(f.expense), 0)
    const appealReimbursement = dayFunds.filter(f => f.businessCode === '0130005' && f.income > 0).reduce((n, f) => n + f.income, 0)
    let productCost = 0; let missing = 0
    validOrders.filter(o => o.skuCode).forEach(o => { const cost = costs.get(`${shop}|${o.skuCode}`); if (cost == null) missing += 1; else productCost += cost * o.quantity })
    const promotionFee = promotions.filter(p => p.shop === shop && p.date === date).reduce((n, p) => n + p.amount, 0); const settled = [...eligible].filter(id => positive.has(id)).length
    return { shop, date, orderCount: dayOrders.length, originalSales: round(original), effectiveSales: round(effective), shippedRefund: round(shippedRefund), couponRefund: round(couponRefund), basicServiceFee: round(basicServiceFee), afterSaleCompensation: round(afterSaleCompensation), smallPayment: round(smallPayment), appealReimbursement: round(appealReimbursement), productCost: missing ? null : round(productCost), promotionFee: round(promotionFee), estimatedProfit: missing ? null : round(effective - productCost - promotionFee), currentNet: round(currentNet), unsettledAmount: round(unsettledAmount), profit: missing ? null : round(currentNet - productCost - promotionFee), eligibleOrders: eligible.size, settledOrders: settled, completionRate: eligible.size ? settled / eligible.size : 1, mature: settled === eligible.size, missingCostOrders: missing, unknownFunds: dayFunds.filter(f => f.category === 'unknown').length }
  })
}

function combine(days: Summary[]): Summary | null {
  if (!days.length) return null
  const sum = (field: keyof Summary) => round(days.reduce((n, d) => n + Number(d[field] || 0), 0)); const missing = days.reduce((n, d) => n + d.missingCostOrders, 0); const orderCount = sum('orderCount'); const eligibleOrders = sum('eligibleOrders'); const settledOrders = sum('settledOrders')
  const productCost = missing ? null : sum('productCost'); const promotionFee = sum('promotionFee'); const effective = sum('effectiveSales'); const currentNet = sum('currentNet')
  const dates = days.map(d => d.date).sort()
  return { shop: days[0].shop, date: `${dates[0]} 至 ${dates[dates.length - 1]}`, orderCount, originalSales: sum('originalSales'), effectiveSales: effective, shippedRefund: sum('shippedRefund'), couponRefund: sum('couponRefund'), basicServiceFee: sum('basicServiceFee'), afterSaleCompensation: sum('afterSaleCompensation'), smallPayment: sum('smallPayment'), appealReimbursement: sum('appealReimbursement'), productCost, promotionFee, estimatedProfit: productCost == null ? null : round(effective - productCost - promotionFee), currentNet, unsettledAmount: sum('unsettledAmount'), profit: productCost == null ? null : round(currentNet - productCost - promotionFee), eligibleOrders, settledOrders, completionRate: eligibleOrders ? settledOrders / eligibleOrders : 1, mature: days.every(d => d.mature), missingCostOrders: missing, unknownFunds: sum('unknownFunds') }
}
