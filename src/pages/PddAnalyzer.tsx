import JSZip from 'jszip'
import { Download, FileSpreadsheet, RotateCcw, ShieldCheck, Upload } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import * as XLSX from '@e965/xlsx'

type Row = Record<string, string | number>
type Order = { id: string; shop: string; payTime: string; payDate: string; receipt: number; status: string; skuCode: string; quantity: number }
type Refund = { id: string; orderId: string; shop: string; status: string; stage: string }
type FundCategory = 'positive' | 'refund' | 'other' | 'transfer' | 'promotion' | 'unknown'
type Fund = { key: string; orderId: string; shop: string; income: number; expense: number; category: FundCategory }
type Promotion = { key: string; shop: string; date: string; amount: number }
type Summary = { shop: string; date: string; orderCount: number; originalSales: number; effectiveSales: number; shippedRefund: number; otherDeductions: number; productCost: number | null; promotionFee: number; estimatedProfit: number | null; currentNet: number; collectionGap: number; profit: number | null; eligibleOrders: number; settledOrders: number; completionRate: number; mature: boolean; missingCostOrders: number; unknownFunds: number }

const money = (value: number | null) => value == null ? '待补成本' : `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const text = (value: unknown) => value == null ? '' : String(value).replace(/\t/g, '').trim()
const amount = (value: unknown) => Math.round((Number(text(value).replace(/[,¥￥]/g, '')) || 0) * 100) / 100
const normalizeHeader = (value: unknown) => text(value).replace(/[\s_\-（）()]/g, '').toLowerCase()
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
  const inputRef = useRef<HTMLInputElement>(null)
  const [shop, setShop] = useState('')
  const [orders, setOrders] = useState<Map<string, Order>>(new Map())
  const [refunds, setRefunds] = useState<Map<string, Refund>>(new Map())
  const [funds, setFunds] = useState<Map<string, Fund>>(new Map())
  const [promotions, setPromotions] = useState<Map<string, Promotion>>(new Map())
  const [costs, setCosts] = useState<Map<string, number>>(new Map())
  const [messages, setMessages] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const importTable = (name: string, table: unknown[][], targetShop: string) => {
    const headerIndex = table.slice(0, 30).findIndex(row => {
      const set = new Set(row.map(text))
      const normalized = new Set(row.map(normalizeHeader))
      const promo = promotionColumns(set)
      return (set.has('订单号') && (set.has('支付时间') || set.has('订单成交时间')))
        || (set.has('售后编号') && set.has('订单编号'))
        || (set.has('商户订单号') && set.has('发生时间'))
        || Boolean(promo.date && promo.spend)
        || ([...normalized].some(x => ['sku编码', 'skucode', '商家编码规格维度'].includes(x)) && [...normalized].some(x => ['总成本', '总成本元', '单件总成本', '单件总成本元'].includes(x)))
    })
    if (headerIndex < 0) throw new Error(`${name}：找不到支持的报表表头`)
    const headers = table[headerIndex].map(text)
    const headerSet = new Set(headers)
    const rows = table.slice(headerIndex + 1).filter(row => row.some(cell => text(cell))).map(row => rowObject(headers, row))
    const normalized = headers.map(normalizeHeader)
    const skuColumn = normalized.findIndex(x => ['sku编码', 'skucode', '商家编码规格维度'].includes(x))
    const costColumn = normalized.findIndex(x => ['总成本', '总成本元', '单件总成本', '单件总成本元'].includes(x))
    if (skuColumn >= 0 && costColumn >= 0) {
      setCosts(current => { const next = new Map(current); for (const row of table.slice(headerIndex + 1)) { const sku = text(row[skuColumn]); if (sku && !['合计', '总计'].includes(sku)) next.set(`${targetShop}|${sku}`, amount(row[costColumn])) } return next })
      return `成本 ${rows.length} 行`
    }
    if (headerSet.has('订单号') && (headerSet.has('支付时间') || headerSet.has('订单成交时间'))) {
      setOrders(current => { const next = new Map(current); rows.forEach(row => { const id = text(row['订单号']); const payTime = text(row['支付时间'] || row['订单成交时间']); if (id) next.set(id, { id, shop: targetShop, payTime, payDate: dateText(payTime), receipt: amount(row['商家实收金额(元)']), status: text(row['订单状态']), skuCode: text(row['商家编码-规格维度']), quantity: Number(row['商品数量(件)'] || 0) }) }); return next })
      return `订单 ${rows.length} 行`
    }
    if (headerSet.has('售后编号') && headerSet.has('订单编号')) {
      setRefunds(current => { const next = new Map(current); rows.forEach(row => { const id = text(row['售后编号']); if (id) next.set(id, { id, orderId: text(row['订单编号']), shop: targetShop, status: text(row['售后状态']), stage: text(row['订单状态']) }) }); return next })
      return `退款 ${rows.length} 行`
    }
    if (headerSet.has('商户订单号') && headerSet.has('发生时间')) {
      setFunds(current => { const next = new Map(current); const ordinals = new Map<string, number>(); rows.forEach(row => { const orderId = text(row['商户订单号']); if (!/^\d{6}-\d+$/.test(orderId)) return; const sig = signature(['商户订单号', '发生时间', '收入金额（+元）', '支出金额（-元）', '账务类型', '备注', '业务描述'].map(field => row[field])); const ordinal = (ordinals.get(sig) || 0) + 1; ordinals.set(sig, ordinal); const key = `${sig}:${ordinal}`; next.set(key, { key, orderId, shop: targetShop, income: amount(row['收入金额（+元）']), expense: amount(row['支出金额（-元）']), category: classifyFund(text(row['账务类型']), text(row['业务描述'])) }) }); return next })
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
    if (!targetShop) { setError('请先填写本批报表的店铺名称'); return }
    setBusy(true); setError('')
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

  const summaries = useMemo(() => calculateSummaries([...orders.values()], [...refunds.values()], [...funds.values()], [...promotions.values()], costs), [orders, refunds, funds, promotions, costs])
  const total = useMemo(() => combine(summaries), [summaries])
  const clear = () => { setOrders(new Map()); setRefunds(new Map()); setFunds(new Map()); setPromotions(new Map()); setCosts(new Map()); setMessages([]); setError('') }
  const exportResult = () => {
    if (!total) return
    const summaryRows = [total, ...summaries].map(s => ({ 店铺名称: s.shop, 成交日期: s.date, 订单数: s.orderCount, 订单成交额: s.originalSales, 有效订单销售额: s.effectiveSales, 已发货退款: s.shippedRefund, 其他扣款: s.otherDeductions, 商品成本: s.productCost, 推广费: s.promotionFee, 预估盈亏: s.estimatedProfit, 订单净回款: s.currentNet, 回款差额: s.collectionGap, 当前盈亏: s.profit, 入账完成率: s.completionRate, 入账状态: s.mature ? '入账已完成' : '入账未完成' }))
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows), '经营汇总')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([...orders.values()]), '订单明细')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([...refunds.values()]), '退款明细')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([...funds.values()]), '资金明细')
    XLSX.writeFile(workbook, `${shop || '店铺'}_订单经营分析_${new Date().toLocaleDateString('sv-SE').replaceAll('-', '')}.xlsx`)
  }

  return <div className="page page-wide pdd-page">
    <div className="page-heading"><div><span className="eyebrow">浏览器临时计算</span><h1>拼多多订单经营分析</h1><p>导入报表后在当前页面计算；不上传、不保存，刷新页面即清空。</p></div><div className="heading-actions"><button className="button secondary" onClick={clear}><RotateCcw size={16} />清空本次数据</button><button className="button primary" disabled={!total} onClick={exportResult}><Download size={16} />导出 Excel</button></div></div>
    <section className="privacy-strip"><ShieldCheck size={18} /><div><strong>仅保留计算逻辑</strong><span>报表内容只存在当前浏览器内存中，不会进入工作台云端数据库。</span></div></section>
    <section className="panel pdd-import"><div><label className="field"><span>本批表头店铺名称</span><input value={shop} onChange={event => setShop(event.target.value)} placeholder="例如：果老二生鲜" /></label><p>一次选择同一店铺的订单、退款、资金、推广费和 SKU 成本文件；支持 CSV、XLS、XLSX、ZIP。</p></div><button className="button primary" disabled={busy} onClick={() => inputRef.current?.click()}><Upload size={16} />{busy ? '正在解析…' : '选择报表并计算'}</button><input ref={inputRef} hidden type="file" multiple accept=".csv,.xls,.xlsx,.zip" onChange={event => event.target.files && void importFiles(event.target.files)} /></section>
    {error && <div className="pdd-message error">{error}</div>}
    {messages.length > 0 && <div className="pdd-message ok"><FileSpreadsheet size={16} /><span>{messages.join('；')}</span></div>}
    {total ? <><section className="pdd-metrics">{[['有效订单销售额', money(total.effectiveSales)], ['订单净回款', money(total.currentNet)], ['回款差额', money(total.collectionGap)], ['推广费', money(total.promotionFee)], ['当前盈亏', money(total.profit)]].map(([label, value]) => <article className="metric" key={label}><div><span>{label}</span><strong>{value}</strong></div></article>)}</section>
      <section className="panel table-panel"><div className="table-caption"><div><strong>每日经营主表</strong><span>回款差额＝有效订单销售额－订单净回款；推广费单独计入盈亏。</span></div></div><div className="table-scroll"><table><thead><tr>{['成交日期','订单数','订单成交额','有效订单销售额','已发货退款','其他扣款','商品成本','推广费','预估盈亏','订单净回款','回款差额','当前盈亏','入账状态'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{[total, ...summaries].map((s, index) => <tr key={`${s.date}-${index}`}><td className="cell-main">{index === 0 ? `累计：${s.date}` : s.date}</td><td>{s.orderCount}</td><td>{money(s.originalSales)}</td><td>{money(s.effectiveSales)}</td><td>{money(s.shippedRefund)}</td><td>{money(s.otherDeductions)}</td><td>{money(s.productCost)}</td><td>{money(s.promotionFee)}</td><td>{money(s.estimatedProfit)}</td><td>{money(s.currentNet)}</td><td>{money(s.collectionGap)}</td><td className={s.profit != null && s.profit < 0 ? 'negative' : 'positive'}>{money(s.profit)}</td><td><span className={`status ${s.mature ? 'normal' : 'risk'}`}><i />{s.mature ? '已完成' : '未完成'}</span></td></tr>)}</tbody></table></div></section>
    </> : <section className="panel pdd-empty"><FileSpreadsheet size={28} /><strong>尚未导入报表</strong><span>填写店铺名称后，一次选择该店铺的全部报表。</span></section>}
  </div>
}

function calculateSummaries(orders: Order[], refunds: Refund[], funds: Fund[], promotions: Promotion[], costs: Map<string, number>): Summary[] {
  const days = [...new Set(orders.filter(o => o.payDate).map(o => `${o.shop}|${o.payDate}`))].sort().reverse()
  return days.map(key => {
    const split = key.indexOf('|'); const shop = key.slice(0, split); const date = key.slice(split + 1)
    const dayOrders = orders.filter(o => o.shop === shop && o.payDate === date); const ids = new Set(dayOrders.map(o => o.id))
    const dayRefunds = refunds.filter(r => ids.has(r.orderId) && r.status === '退款成功')
    const unshipped = new Set(dayRefunds.filter(r => r.stage === '未发货').map(r => r.orderId)); const shipped = new Set(dayRefunds.filter(r => r.stage === '已发货').map(r => r.orderId))
    const dayFunds = funds.filter(f => ids.has(f.orderId)); const original = dayOrders.reduce((n, o) => n + o.receipt, 0); const unshippedOriginal = dayOrders.filter(o => unshipped.has(o.id)).reduce((n, o) => n + o.receipt, 0); const effective = original - unshippedOriginal
    const eligible = new Set(dayOrders.filter(o => !unshipped.has(o.id) && !o.status.includes('取消')).map(o => o.id)); const positive = new Set(dayFunds.filter(f => f.category === 'positive' && f.income > 0).map(f => f.orderId))
    const currentNet = dayFunds.filter(f => ['positive', 'refund', 'other'].includes(f.category)).reduce((n, f) => n + f.income + f.expense, 0)
    const shippedRefund = -dayFunds.filter(f => f.category === 'refund' && shipped.has(f.orderId)).reduce((n, f) => n + f.income + f.expense, 0)
    const otherDeductions = -dayFunds.filter(f => f.category === 'other').reduce((n, f) => n + f.income + f.expense, 0)
    let productCost = 0; let missing = 0
    dayOrders.filter(o => !unshipped.has(o.id) && o.skuCode).forEach(o => { const cost = costs.get(`${shop}|${o.skuCode}`); if (cost == null) missing += 1; else productCost += cost * o.quantity })
    const promotionFee = promotions.filter(p => p.shop === shop && p.date === date).reduce((n, p) => n + p.amount, 0); const settled = [...eligible].filter(id => positive.has(id)).length
    return { shop, date, orderCount: dayOrders.length, originalSales: round(original), effectiveSales: round(effective), shippedRefund: round(shippedRefund), otherDeductions: round(otherDeductions), productCost: missing ? null : round(productCost), promotionFee: round(promotionFee), estimatedProfit: missing ? null : round(effective - productCost - promotionFee), currentNet: round(currentNet), collectionGap: round(effective - currentNet), profit: missing ? null : round(currentNet - productCost - promotionFee), eligibleOrders: eligible.size, settledOrders: settled, completionRate: eligible.size ? settled / eligible.size : 1, mature: settled === eligible.size, missingCostOrders: missing, unknownFunds: dayFunds.filter(f => f.category === 'unknown').length }
  })
}

function combine(days: Summary[]): Summary | null {
  if (!days.length) return null
  const sum = (field: keyof Summary) => round(days.reduce((n, d) => n + Number(d[field] || 0), 0)); const missing = days.reduce((n, d) => n + d.missingCostOrders, 0); const orderCount = sum('orderCount'); const eligibleOrders = sum('eligibleOrders'); const settledOrders = sum('settledOrders')
  const productCost = missing ? null : sum('productCost'); const promotionFee = sum('promotionFee'); const effective = sum('effectiveSales'); const currentNet = sum('currentNet')
  const dates = days.map(d => d.date).sort()
  return { shop: days[0].shop, date: `${dates[0]} 至 ${dates[dates.length - 1]}`, orderCount, originalSales: sum('originalSales'), effectiveSales: effective, shippedRefund: sum('shippedRefund'), otherDeductions: sum('otherDeductions'), productCost, promotionFee, estimatedProfit: productCost == null ? null : round(effective - productCost - promotionFee), currentNet, collectionGap: round(effective - currentNet), profit: productCost == null ? null : round(currentNet - productCost - promotionFee), eligibleOrders, settledOrders, completionRate: eligibleOrders ? settledOrders / eligibleOrders : 1, mature: days.every(d => d.mature), missingCostOrders: missing, unknownFunds: sum('unknownFunds') }
}
