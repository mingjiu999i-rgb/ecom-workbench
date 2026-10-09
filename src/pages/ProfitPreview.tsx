import JSZip from 'jszip'
import { BarChart3, Download, FileSpreadsheet, RotateCcw, ScanText, ShieldCheck, Upload } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import Tesseract from 'tesseract.js'
import * as XLSX from '@e965/xlsx'
import * as XLSXStyle from 'xlsx-js-style'
import { useWorkbench } from '../store/workbench'
import type { ProductCost, ProfitRecord } from '../types/models'
import { createProfitPreviewSheet } from '../utils/profitWorkbook'

type Row = Record<string, string | number>
type ProfitOrder = { key: string; orderId: string; date: string; skuCode: string; specification: string; productItemId: string; quantity: number; receipt: number; status: string }
type CostMatch = { cost?: ProductCost; productId: string; source: '编码' | '规格' | '手动' | '不计成本' }
type SkuGroup = { key: string; skuCode: string; specification: string; quantity: number; receipt: number; orders: ProfitOrder[]; match?: CostMatch }
type ProfitMetric = { date: string; productId: string; product: string; rate: number; amount: number; cost: number; grossProfit: number; promotion: number; operationFee: number; estimatedProfit: number; quantity: number; margin: number }
type ImportRange = { startDate: string; endDate: string }
type PromotionOcrRow = { date: string; amount: number; matched: boolean }

const invalidStatus = ['退款', '取消', '待付款', '未付款']
const noCostChoice = '__no_cost__'
const noCostProductId = '__no_cost_income__'
const noCostProductName = '小额收款（不计成本）'
const cleanText = (value: unknown) => value == null ? '' : String(value).replace(/\t/g, '').trim()
const cleanNumber = (value: unknown) => Math.round((Number(cleanText(value).replace(/[,¥￥]/g, '')) || 0) * 100) / 100
const normalize = (value: string) => value.toLowerCase().replace(/[\s【】\[\]（）()*/×·,，-]/g, '')
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100
const money = (value: number) => `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const dateText = (value: unknown) => {
  if (value instanceof Date) return value.toLocaleDateString('sv-SE')
  const raw = cleanText(value).replace(/\//g, '-').replace(/年|月/g, '-').replace(/日/g, '')
  const match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : ''
}
const cellValue = (value: unknown) => value instanceof Date ? `${value.toLocaleDateString('sv-SE')} ${value.toTimeString().slice(0, 8)}` : typeof value === 'number' ? value : cleanText(value)
const rowObject = (headers: unknown[], cells: unknown[]) => Object.fromEntries(headers.map((header, index) => [cleanText(header), cellValue(cells[index])])) as Row
const isValidOrder = (order: ProfitOrder) => Boolean(order.date && !invalidStatus.some(word => order.status.includes(word)))

function parseOcrMoney(value: string) {
  const normalized = value.replace(/,/g, '').replace(/[^\d.]/g, '')
  if (!normalized || (normalized.match(/\./g) || []).length > 1) return null
  if (/^\d{4,}$/.test(normalized)) return round(Number(normalized) / 100)
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? round(parsed) : null
}

function parsePromotionOcrText(value: string) {
  const rows = new Map<string, number>()
  value.split(/\r?\n/).forEach(line => {
    const dateMatch = line.match(/(?:20)?(\d{2})[/.\-](\d{1,2})[/.\-](\d{1,2})/)
    if (!dateMatch || dateMatch.index == null) return
    const year = Number(dateMatch[1]) + 2000
    const month = Number(dateMatch[2])
    const day = Number(dateMatch[3])
    const validDate = new Date(Date.UTC(year, month - 1, day))
    if (validDate.getUTCFullYear() !== year || validDate.getUTCMonth() !== month - 1 || validDate.getUTCDate() !== day) return
    const amountToken = line.slice(dateMatch.index + dateMatch[0].length).match(/\d+(?:[.,]\d+)?/)?.[0]
    const promotion = amountToken ? parseOcrMoney(amountToken) : null
    if (promotion == null) return
    rows.set(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, promotion)
  })
  return rows
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
  return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true, defval: '' }) as unknown[][]
}

export function ProfitPreview() {
  const { data, update, syncStatus } = useWorkbench()
  const inputRef = useRef<HTMLInputElement>(null)
  const promotionImageRef = useRef<HTMLInputElement>(null)
  const [storeId, setStoreId] = useState('')
  const [exportClientId, setExportClientId] = useState('')
  const [orders, setOrders] = useState<Map<string, ProfitOrder>>(new Map())
  const [manualMatches, setManualMatches] = useState<Map<string, string>>(new Map())
  const [promotions, setPromotions] = useState<Map<string, number>>(new Map())
  const [messages, setMessages] = useState<string[]>([])
  const [importRanges, setImportRanges] = useState<ImportRange[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrStatus, setOcrStatus] = useState('')
  const [ocrRows, setOcrRows] = useState<PromotionOcrRow[]>([])

  const store = data.stores.find(item => item.id === storeId)
  const clientProducts = data.products.filter(product => product.clientId === store?.clientId)
  const productIds = new Set(clientProducts.map(product => product.id))
  const availableCosts = data.productCosts.filter(cost => productIds.has(cost.productId))
  const activeStores = data.stores.filter(item => item.storeStatus !== '暂停')
  const savedRecords = useMemo(() => data.profitRecords.filter(record => record.storeId === storeId).sort((a, b) => b.date.localeCompare(a.date) || a.productId.localeCompare(b.productId)), [data.profitRecords, storeId])
  const savedPromotions = useMemo(() => new Map(savedRecords.map(record => [`${record.date}|${record.productId}`, record.promotion])), [savedRecords])
  const productName = (productId: string) => productId === noCostProductId ? noCostProductName : data.products.find(product => product.id === productId)?.name || '已删除产品'

  const clearResults = () => { setOrders(new Map()); setManualMatches(new Map()); setPromotions(new Map()); setMessages([]); setImportRanges([]); setOcrRows([]); setOcrStatus(''); setError('') }

  const resolveCost = (order: ProfitOrder): CostMatch | undefined => {
    const manualId = manualMatches.get(`${order.skuCode}|${order.specification}`)
    const linkedProductId = data.productLinks.find(link => link.storeId === storeId && link.linkId === order.productItemId)?.productId
    if (manualId === noCostChoice) return { productId: linkedProductId || noCostProductId, source: '不计成本' }
    if (manualId) { const cost = availableCosts.find(item => item.id === manualId); if (cost) return { cost, productId: cost.productId, source: '手动' } }
    const scoped = linkedProductId ? availableCosts.filter(cost => cost.productId === linkedProductId) : availableCosts
    const codeMatches = scoped.filter(cost => order.skuCode && cost.skuCode.trim() === order.skuCode)
    if (codeMatches.length === 1) return { cost: codeMatches[0], productId: codeMatches[0].productId, source: '编码' }
    const orderSpec = normalize(order.specification)
    const specMatches = scoped.filter(cost => { const spec = normalize(cost.specification); return spec.length >= 2 && orderSpec && (orderSpec.includes(spec) || spec.includes(orderSpec)) })
    if (specMatches.length === 1) return { cost: specMatches[0], productId: specMatches[0].productId, source: '规格' }
    return undefined
  }

  const skuGroups = useMemo(() => {
    const groups = new Map<string, SkuGroup>()
    orders.forEach(order => {
      if (!isValidOrder(order)) return
      const key = `${order.skuCode}|${order.specification}`
      const row = groups.get(key) || { key, skuCode: order.skuCode, specification: order.specification, quantity: 0, receipt: 0, orders: [] }
      row.quantity += order.quantity; row.receipt += order.receipt; row.orders.push(order); groups.set(key, row)
    })
    return [...groups.values()].map(group => ({ ...group, match: resolveCost(group.orders[0]) })).sort((a, b) => (a.skuCode || a.specification).localeCompare(b.skuCode || b.specification, 'zh-CN'))
  }, [orders, manualMatches, storeId, data.productLinks, data.productCosts])

  const metrics = useMemo(() => {
    const rows = new Map<string, ProfitMetric>()
    orders.forEach(order => {
      if (!isValidOrder(order)) return
      const match = resolveCost(order)
      if (!match) return
      const product = data.products.find(item => item.id === match.productId)
      if (!product && match.productId !== noCostProductId) return
      const key = `${order.date}|${match.productId}`
      const row = rows.get(key) || { date: order.date, productId: match.productId, product: product?.name || noCostProductName, rate: product?.operationRate || 0, amount: 0, cost: 0, grossProfit: 0, promotion: 0, operationFee: 0, estimatedProfit: 0, quantity: 0, margin: 0 }
      row.amount += order.receipt; row.cost += order.quantity * (match.cost?.totalCost || 0); row.quantity += order.quantity; rows.set(key, row)
    })
    return [...rows.values()].map(row => {
      const recordKey = `${row.date}|${row.productId}`
      const promotion = promotions.has(recordKey) ? promotions.get(recordKey) || 0 : savedPromotions.get(recordKey) || 0
      const amount = round(row.amount), cost = round(row.cost), grossProfit = round(amount - cost), operationFee = round(amount * row.rate), estimatedProfit = round(grossProfit - promotion - operationFee)
      return { ...row, amount, cost, grossProfit, promotion, operationFee, estimatedProfit, quantity: round(row.quantity), margin: amount ? estimatedProfit / amount : 0 }
    }).sort((a, b) => b.date.localeCompare(a.date) || a.product.localeCompare(b.product, 'zh-CN'))
  }, [orders, manualMatches, promotions, savedPromotions, data.products, data.productCosts, storeId])

  const unmatched = skuGroups.filter(group => !group.match)
  const total = useMemo(() => metrics.length ? metrics.reduce((sum, row) => ({ amount: sum.amount + row.amount, cost: sum.cost + row.cost, grossProfit: sum.grossProfit + row.grossProfit, promotion: sum.promotion + row.promotion, operationFee: sum.operationFee + row.operationFee, estimatedProfit: sum.estimatedProfit + row.estimatedProfit, quantity: sum.quantity + row.quantity }), { amount: 0, cost: 0, grossProfit: 0, promotion: 0, operationFee: 0, estimatedProfit: 0, quantity: 0 }) : null, [metrics])
  const savedTotal = useMemo(() => savedRecords.length ? savedRecords.reduce((sum, row) => ({ amount: sum.amount + row.amount, cost: sum.cost + row.cost, grossProfit: sum.grossProfit + row.grossProfit, promotion: sum.promotion + row.promotion, operationFee: sum.operationFee + row.operationFee, estimatedProfit: sum.estimatedProfit + row.estimatedProfit, quantity: sum.quantity + row.quantity }), { amount: 0, cost: 0, grossProfit: 0, promotion: 0, operationFee: 0, estimatedProfit: 0, quantity: 0 }) : null, [savedRecords])
  const exportMetrics = useMemo(() => {
    const rows = new Map(savedRecords.map(record => [`${record.date}|${record.productId}`, {
      date: record.date,
      productId: record.productId,
      product: productName(record.productId),
      amount: record.amount,
      cost: record.cost,
      grossProfit: record.grossProfit,
      promotion: record.promotion,
      operationFee: record.operationFee,
      estimatedProfit: record.estimatedProfit,
      quantity: record.quantity,
      margin: record.margin,
    }]))
    if (!unmatched.length) metrics.forEach(row => rows.set(`${row.date}|${row.productId}`, row))
    return [...rows.values()]
  }, [data.products, metrics, savedRecords, unmatched.length])
  const clientExportMetrics = useMemo(() => {
    if (!exportClientId) return []
    const clientStoreIds = new Set(data.stores.filter(item => item.clientId === exportClientId).map(item => item.id))
    return data.profitRecords.filter(record => clientStoreIds.has(record.storeId)).map(record => ({
      date: record.date,
      productId: record.productId,
      product: productName(record.productId),
      amount: record.amount,
      cost: record.cost,
      grossProfit: record.grossProfit,
      promotion: record.promotion,
      operationFee: record.operationFee,
      estimatedProfit: record.estimatedProfit,
      quantity: record.quantity,
      margin: record.margin,
    }))
  }, [data.products, data.profitRecords, data.stores, exportClientId])

  useEffect(() => {
    if (!storeId || !orders.size || !importRanges.length || unmatched.length) return
    const fields: (keyof ProfitRecord)[] = ['amount', 'cost', 'grossProfit', 'promotion', 'operationRate', 'operationFee', 'estimatedProfit', 'quantity', 'margin']
    const incomingKeys = new Set(metrics.map(row => `${storeId}|${row.date}|${row.productId}`))
    const coveredByImport = (date: string) => importRanges.some(range => date >= range.startDate && date <= range.endDate)
    const staleRecord = data.profitRecords.some(record => record.storeId === storeId && coveredByImport(record.date) && !incomingKeys.has(`${record.storeId}|${record.date}|${record.productId}`))
    const changed = staleRecord || metrics.some(row => {
      const existing = data.profitRecords.find(record => record.storeId === storeId && record.date === row.date && record.productId === row.productId)
      return !existing || fields.some(field => existing[field] !== (field === 'operationRate' ? row.rate : row[field as keyof ProfitMetric]))
    })
    if (!changed) return
    const timer = window.setTimeout(() => update(current => {
      const incoming = new Map(metrics.map(row => {
        const id = `profit-${storeId}-${row.date}-${row.productId}`
        const record: ProfitRecord = { id, storeId, productId: row.productId, date: row.date, amount: row.amount, cost: row.cost, grossProfit: row.grossProfit, promotion: row.promotion, operationRate: row.rate, operationFee: row.operationFee, estimatedProfit: row.estimatedProfit, quantity: row.quantity, margin: row.margin, updatedAt: new Date().toISOString() }
        return [`${storeId}|${row.date}|${row.productId}`, record]
      }))
      return { ...current, profitRecords: [...current.profitRecords.filter(record => record.storeId !== storeId || !coveredByImport(record.date)), ...incoming.values()] }
    }), 600)
    return () => window.clearTimeout(timer)
  }, [data.profitRecords, importRanges, metrics, orders.size, storeId, unmatched.length, update])

  const importTable = (name: string, table: unknown[][], next: Map<string, ProfitOrder>) => {
    const headerIndex = table.slice(0, 30).findIndex(row => { const headers = new Set(row.map(cleanText)); return headers.has('订单状态') && headers.has('商品数量(件)') && headers.has('商家实收金额(元)') && (headers.has('支付时间') || headers.has('订单成交时间')) })
    if (headerIndex < 0) throw new Error(`${name}：找不到订单报表表头`)
    const headers = table[headerIndex].map(cleanText)
    const rows = table.slice(headerIndex + 1).filter(row => row.some(cell => cleanText(cell))).map(row => rowObject(headers, row))
    rows.forEach((row, index) => {
      const orderId = cleanText(row['订单号'])
      const payTime = row['支付时间'] || row['订单成交时间']
      const skuCode = cleanText(row['商家编码-规格维度'])
      const specification = cleanText(row['商品规格'])
      const key = orderId || JSON.stringify([name, index, payTime, skuCode, specification, row['商家实收金额(元)']])
      next.set(key, { key, orderId, date: dateText(payTime), skuCode, specification, productItemId: cleanText(row['商品id'] || row['商品ID']), quantity: cleanNumber(row['商品数量(件)']), receipt: cleanNumber(row['商家实收金额(元)']), status: cleanText(row['订单状态']) })
    })
    const dates = rows.map(row => dateText(row['支付时间'] || row['订单成交时间'])).filter(Boolean).sort()
    return { count: rows.length, startDate: dates[0] || '', endDate: dates[dates.length - 1] || '' }
  }

  const importFiles = async (files: FileList) => {
    if (!storeId) { setError('请先选择店铺'); return }
    setBusy(true); setError('')
    try {
      const next = new Map<string, ProfitOrder>(); const imported: string[] = []; const ranges: ImportRange[] = []
      const consume = async (name: string, buffer: ArrayBuffer) => { const result = importTable(name, parseTable(buffer, name), next); imported.push(`${name}：${result.count} 行`); if (result.startDate && result.endDate) ranges.push({ startDate: result.startDate, endDate: result.endDate }) }
      for (const file of Array.from(files)) {
        if (file.name.toLowerCase().endsWith('.zip')) {
          const zip = await JSZip.loadAsync(await file.arrayBuffer())
          for (const entry of Object.values(zip.files)) if (!entry.dir && /\.(csv|xls|xlsx)$/i.test(entry.name)) await consume(entry.name.split('/').pop() || entry.name, await entry.async('arraybuffer'))
        } else await consume(file.name, await file.arrayBuffer())
      }
      setOrders(next); setImportRanges(ranges); setMessages(current => [...imported, ...current].slice(0, 10))
    } catch (cause) { setError(cause instanceof Error ? cause.message : '订单报表解析失败') } finally { setBusy(false); if (inputRef.current) inputRef.current.value = '' }
  }

  const importPromotionImages = async (files: FileList) => {
    if (!storeId || !metrics.length) { setError('请先选择店铺并导入订单报表'); return }
    if (unmatched.length) { setError('请先完成全部 SKU 成本匹配，再识别推广费截图'); return }
    setOcrBusy(true); setError(''); setOcrStatus('正在加载本地识别模型…')
    let worker: Awaited<ReturnType<typeof Tesseract.createWorker>> | undefined
    try {
      worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
        logger: message => {
          if (message.status === 'recognizing text') setOcrStatus(`正在识别截图：${Math.round(message.progress * 100)}%`)
        },
      })
      await worker.setParameters({
        tessedit_char_whitelist: '0123456789/.- ',
        preserve_interword_spaces: '1',
        tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
      })
      const recognized = new Map<string, number>()
      for (const [index, file] of Array.from(files).entries()) {
        setOcrStatus(`正在识别第 ${index + 1}/${files.length} 张截图…`)
        const result = await worker.recognize(file)
        parsePromotionOcrText(result.data.text).forEach((value, date) => recognized.set(date, value))
      }
      if (!recognized.size) throw new Error('没有识别到“日期 + 成交花费”，请上传包含表格日期列和成交花费列的清晰截图')
      const rowsByDate = new Map<string, ProfitMetric[]>()
      metrics.forEach(row => rowsByDate.set(row.date, [...(rowsByDate.get(row.date) || []), row]))
      const matchedDates = [...recognized.keys()].filter(date => rowsByDate.has(date))
      if (!matchedDates.length) throw new Error('截图中的日期与当前订单报表日期不一致，请检查是否选择了正确店铺和报表')
      setPromotions(current => {
        const next = new Map(current)
        matchedDates.forEach(date => {
          const dayRows = rowsByDate.get(date) || []
          const dailyPromotion = recognized.get(date) || 0
          const dailyAmount = dayRows.reduce((sum, row) => sum + row.amount, 0)
          let assigned = 0
          dayRows.forEach((row, index) => {
            const allocation = index === dayRows.length - 1
              ? round(dailyPromotion - assigned)
              : round(dailyPromotion * (dailyAmount > 0 ? row.amount / dailyAmount : 1 / dayRows.length))
            assigned = round(assigned + allocation)
            next.set(`${date}|${row.productId}`, Math.max(0, allocation))
          })
        })
        return next
      })
      setOcrRows([...recognized.entries()].map(([date, amount]) => ({ date, amount, matched: rowsByDate.has(date) })).sort((a, b) => b.date.localeCompare(a.date)))
      const ignored = recognized.size - matchedDates.length
      setMessages(current => [`推广费截图：识别 ${recognized.size} 天，已填写 ${matchedDates.length} 天${ignored ? `，${ignored} 天无对应订单未填写` : ''}`, ...current].slice(0, 10))
      setOcrStatus('识别完成，可在下方推广费输入框继续手动修改')
    } catch (cause) {
      setOcrRows([]); setOcrStatus(''); setError(cause instanceof Error ? cause.message : '推广费截图识别失败')
    } finally {
      if (worker) await worker.terminate()
      setOcrBusy(false)
      if (promotionImageRef.current) promotionImageRef.current.value = ''
    }
  }

  const writeProfitWorkbook = (rows: typeof exportMetrics, filename: string, includeSkuMatches = false) => {
    const workbook = XLSXStyle.utils.book_new()
    XLSXStyle.utils.book_append_sheet(workbook, createProfitPreviewSheet(rows), '毛利预览表')
    if (includeSkuMatches && skuGroups.length) XLSXStyle.utils.book_append_sheet(workbook, XLSXStyle.utils.json_to_sheet(skuGroups.map(group => ({ SKU编码: group.skuCode, 商品规格: group.specification, 销量: group.quantity, 实收金额: round(group.receipt), 匹配方式: group.match?.source || '未匹配', 成本SKU: group.match?.source === '不计成本' ? '小额收款（不计成本）' : group.match?.cost?.skuCode || '', 单件成本: group.match ? group.match.cost?.totalCost ?? 0 : '' }))), 'SKU匹配')
    XLSXStyle.writeFile(workbook, filename)
  }

  const exportResult = () => {
    if (!exportMetrics.length) return
    writeProfitWorkbook(exportMetrics, `${store?.name || '店铺'}_毛利预览_${new Date().toLocaleDateString('sv-SE').replaceAll('-', '')}.xlsx`, true)
  }

  const exportClientResult = () => {
    if (!clientExportMetrics.length) return
    const clientName = data.clients.find(client => client.id === exportClientId)?.name || '甲方'
    writeProfitWorkbook(clientExportMetrics, `${clientName}_全部店铺毛利汇总_${new Date().toLocaleDateString('sv-SE').replaceAll('-', '')}.xlsx`)
  }

  return <div className="page page-wide pdd-page">
    <div className="page-heading"><div><span className="eyebrow">统一毛利计算</span><h1>毛利预览</h1><p>适用于余顺交、赵梦圆及后续店铺；统一使用工作台中的产品成本和运营费率。</p></div><div className="heading-actions"><button className="button secondary" onClick={clearResults}><RotateCcw size={16} />清空本次数据</button><button className="button primary" disabled={!exportMetrics.length} onClick={exportResult}><Download size={16} />导出毛利预览</button></div></div>
    <section className="privacy-strip"><ShieldCheck size={18} /><div><strong>报表仅在浏览器中计算</strong><span>订单明细不会上传或保存；产品成本和运营费率来自工作台基础资料。</span></div></section>
    <section className="panel pdd-import profit-import"><div><label className="field"><span>按甲方汇总导出</span><select value={exportClientId} onChange={event => setExportClientId(event.target.value)}><option value="">请选择甲方</option>{data.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label><p>汇总该甲方名下所有店铺中相同日期、相同产品的已保存毛利数据。</p></div><button className="button primary" disabled={!clientExportMetrics.length} onClick={exportClientResult}><Download size={16} />导出甲方汇总</button></section>
    <section className="panel pdd-import profit-import"><div><label className="field"><span>选择店铺</span><select value={storeId} onChange={event => { setStoreId(event.target.value); clearResults() }}><option value="">请选择店铺</option>{activeStores.map(item => <option key={item.id} value={item.id}>{data.clients.find(client => client.id === item.clientId)?.name} · {item.name}</option>)}</select></label><p>上传该店铺的订单 CSV、XLS、XLSX 或 ZIP；每次导入会替换上一次报表，并自动过滤退款、取消、待付款和未付款订单。</p></div><button className="button primary" disabled={busy || !storeId} onClick={() => inputRef.current?.click()}><Upload size={16} />{busy ? '正在解析…' : '选择订单报表'}</button><input ref={inputRef} hidden type="file" multiple accept=".csv,.xls,.xlsx,.zip" onChange={event => event.target.files && void importFiles(event.target.files)} /></section>
    <section className="panel pdd-import profit-import promotion-ocr-panel"><div><div className="field"><span>截图识别推广费</span><strong>识别日期和“成交花费(元)”</strong></div><p>截图仅在浏览器本地识别；同一天多个产品按实收比例分配。识别后仍可在毛利预览表中手动修改推广费。</p>{ocrStatus && <div className="ocr-status"><ScanText size={15} /><span>{ocrStatus}</span></div>}{ocrRows.length > 0 && <div className="ocr-result-list">{ocrRows.map(row => <span key={row.date} className={row.matched ? '' : 'unmatched'}>{row.date} · {money(row.amount)}{row.matched ? '' : '（无订单）'}</span>)}</div>}</div><button className="button secondary" disabled={ocrBusy || !storeId || !metrics.length || unmatched.length > 0} onClick={() => promotionImageRef.current?.click()}><ScanText size={16} />{ocrBusy ? '正在识别…' : '选择推广费截图'}</button><input ref={promotionImageRef} hidden type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={event => event.target.files && void importPromotionImages(event.target.files)} /></section>
    {error && <div className="pdd-message error">{error}</div>}
    {messages.length > 0 && <div className="pdd-message ok"><FileSpreadsheet size={16} /><span>{messages.join('；')}</span></div>}
    {skuGroups.length > 0 && <section className="panel table-panel pdd-cost-panel"><div className="table-caption"><div><strong>SKU 成本匹配</strong><span>先按商家编码匹配；未匹配项可选择成本 SKU，或标记为小额收款不计商品成本。</span></div><div className="cost-count"><b>{skuGroups.length - unmatched.length}</b> 个已处理 · <b>{unmatched.length}</b> 个待处理</div></div><div className="table-scroll"><table><thead><tr><th>报表 SKU</th><th>商品规格</th><th>销量</th><th>匹配方式</th><th>成本 SKU / 产品</th><th>单件成本</th></tr></thead><tbody>{skuGroups.map(group => { const match = group.match; const manualChoice = manualMatches.get(group.key) || ''; const editable = !match || Boolean(manualChoice); return <tr key={group.key}><td><strong className="cell-main">{group.skuCode || '空编码'}</strong></td><td>{group.specification || '—'}</td><td>{group.quantity}</td><td>{match ? <span className={`link-status ${match.source === '不计成本' ? 'status-备用' : 'status-日销'}`}>{match.source === '不计成本' ? '不计成本' : `${match.source}匹配`}</span> : <span className="link-status status-已挂">待匹配</span>}</td><td>{editable ? <select value={manualChoice} onChange={event => setManualMatches(current => { const next = new Map(current); if (event.target.value) next.set(group.key, event.target.value); else next.delete(group.key); return next })}><option value="">请选择成本 SKU</option><option value={noCostChoice}>无需匹配（小额收款，不计成本）</option>{availableCosts.map(cost => <option key={cost.id} value={cost.id}>{data.products.find(product => product.id === cost.productId)?.name} · {cost.skuCode} · {cost.specification}</option>)}</select> : <><div className="cell-main">{match.cost?.skuCode}</div><div className="cell-sub">{productName(match.productId)} · {match.cost?.specification}</div></>}</td><td>{match ? money(match.cost?.totalCost || 0) : '—'}</td></tr> })}</tbody></table></div></section>}
    {unmatched.length > 0 && <div className="pdd-message error">还有 {unmatched.length} 个 SKU 未匹配成本，毛利结果暂不完整；完成匹配后即可导出。</div>}
    {total && <><section className="pdd-metrics">{[['商家实收', money(total.amount)], ['商品成本', money(total.cost)], ['推广费', money(total.promotion)], ['运营费', money(total.operationFee)], ['毛利预估', money(total.estimatedProfit)]].map(([label, value]) => <article className="metric" key={label}><div><span>{label}</span><strong>{value}</strong></div></article>)}</section><section className="panel table-panel"><div className="table-caption"><div><strong>本次毛利预览</strong><span>毛利预估＝实收金额－成本－推广费－运营费；推广费支持截图识别，也可继续手动填写修改。</span></div><div className="cost-count">云端状态：<b>{syncStatus === 'saving' ? '保存中…' : syncStatus === 'error' ? '保存失败' : '已保存'}</b></div></div><div className="table-scroll"><table><thead><tr>{['日期','产品','实收金额','成本','毛利','推广费（识别/手填）','运营费率','运营费','毛利预估','销量','毛利率'].map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{metrics.map(row => { const key = `${row.date}|${row.productId}`; return <tr key={key}><td>{row.date}</td><td><strong className="cell-main">{row.product}</strong></td><td>{money(row.amount)}</td><td>{money(row.cost)}</td><td>{money(row.grossProfit)}</td><td><input className="cost-input promo-input" aria-label={`${row.date} ${row.product} 推广费`} type="number" min="0" step="0.01" value={promotions.has(key) ? promotions.get(key) : savedPromotions.get(key) ?? 0} onChange={event => setPromotions(current => { const next = new Map(current); next.set(key, Number(event.target.value || 0)); return next })} /></td><td>{(row.rate * 100).toFixed(2).replace(/\.00$/, '')}%</td><td>{money(row.operationFee)}</td><td className={row.estimatedProfit < 0 ? 'negative' : 'positive'}>{money(row.estimatedProfit)}</td><td>{row.quantity}</td><td>{(row.margin * 100).toFixed(2)}%</td></tr> })}</tbody></table></div></section></>}
    {savedTotal && <section className="panel table-panel saved-profit-panel"><div className="table-caption"><div><strong>已保存每日毛利</strong><span>仅保存每日汇总，不保存订单明细；相同店铺、日期和产品再次导入时自动覆盖。</span></div><div className="cost-count"><b>{savedRecords.length}</b> 条每日记录</div></div><div className="table-scroll"><table><thead><tr>{['日期','产品','实收金额','成本','推广费','运营费','毛利预估','销量','毛利率'].map(header => <th key={header}>{header}</th>)}</tr></thead><tbody><tr className="profit-total-row"><td><strong>累计汇总</strong></td><td>{savedRecords.length ? `${savedRecords[savedRecords.length - 1].date} 至 ${savedRecords[0].date}` : '—'}</td><td>{money(savedTotal.amount)}</td><td>{money(savedTotal.cost)}</td><td>{money(savedTotal.promotion)}</td><td>{money(savedTotal.operationFee)}</td><td className={savedTotal.estimatedProfit < 0 ? 'negative' : 'positive'}>{money(savedTotal.estimatedProfit)}</td><td>{savedTotal.quantity}</td><td>{savedTotal.amount ? `${(savedTotal.estimatedProfit / savedTotal.amount * 100).toFixed(2)}%` : '0.00%'}</td></tr>{savedRecords.map(record => <tr key={record.id}><td>{record.date}</td><td><strong className="cell-main">{productName(record.productId)}</strong></td><td>{money(record.amount)}</td><td>{money(record.cost)}</td><td>{money(record.promotion)}</td><td>{money(record.operationFee)}</td><td className={record.estimatedProfit < 0 ? 'negative' : 'positive'}>{money(record.estimatedProfit)}</td><td>{record.quantity}</td><td>{(record.margin * 100).toFixed(2)}%</td></tr>)}</tbody></table></div></section>}
    {!orders.size && <section className="panel pdd-empty"><BarChart3 size={28} /><strong>尚未导入订单</strong><span>选择店铺并上传订单报表后生成毛利预览。</span></section>}
  </div>
}
