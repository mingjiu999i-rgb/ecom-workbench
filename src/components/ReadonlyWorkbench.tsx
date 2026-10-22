import { useDeferredValue, useMemo, useState } from 'react'
import type { WorkbenchData } from '../types/models'
import type { PendingDraft } from '../utils/workbenchSync'
import { readonlyRows, storedSectionLabels, storedValue } from '../utils/readonlyWorkbench'
import './readonly-workbench.css'

const preferredColumns: Record<string, string[]> = {
  collectionRecords: ['date', 'orderCount', 'effectiveSales', 'shippedRefund', 'productCost', 'promotionFee', 'profit', 'currentNet'],
  profitRecords: ['date', 'productId', 'quantity', 'amount', 'cost', 'promotion', 'operationFee', 'estimatedProfit'],
  skus: ['name', 'skuId', 'specification', 'salePrice', 'productCost', 'shippingCost', 'packagingCost', 'otherCost'],
  orders: ['id', 'date', 'productId', 'quantity', 'receipt', 'cancelled', 'unitCost', 'supplement'],
  refunds: ['id', 'orderId', 'success', 'stage', 'amount'],
  funds: ['key', 'orderId', 'income', 'expense', 'businessCode', 'category'],
  promotions: ['date', 'amount'],
}
const fields: Record<string, string> = {
  date: '保存日期', id: '记录 ID', key: '流水键', orderId: '订单 ID', productId: '产品 ID', name: '名称', skuId: 'SKU 编码', specification: '规格',
  quantity: '数量', receipt: '订单实收', cancelled: '取消', unitCost: '历史单位成本', supplement: '补差价',
  success: '退款成功', stage: '退款阶段', amount: '保存金额', income: '收入', expense: '支出', businessCode: '业务码', category: '分类',
  orderCount: '订单数', effectiveSales: '有效销售额', shippedRefund: '已发货退款', productCost: '产品成本', promotionFee: '推广费', profit: '利润', currentNet: '当前净额',
  cost: '成本', promotion: '推广费', operationFee: '运营费', estimatedProfit: '预估利润', salePrice: '售价', shippingCost: '运费', packagingCost: '包装费', otherCost: '其他成本',
}

// Deliberately mounts no business editors, automatic observers or sync notice.
// All numbers below are stored values; this reader performs no settlement calculations.
export function ReadonlyWorkbench({ draft, email, onExport, onExit }: {
  draft: PendingDraft<WorkbenchData>; email: string; onExport: () => void; onExit: () => void
}) {
  const data = draft.data
  const [section, setSection] = useState('collectionRecords')
  const [storeId, setStoreId] = useState(''), [query, setQuery] = useState('')
  const [start, setStart] = useState(''), [end, setEnd] = useState(''), [page, setPage] = useState(0)
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null)
  const search = useDeferredValue(query.trim().toLowerCase())
  const sections = useMemo(() => [...new Set(['collectionRecords', 'profitRecords', 'skus', 'orders', 'refunds', 'funds', 'promotions',
    ...Object.keys(data).filter(key => key !== 'orderAccountingLedgers')])], [data])
  const rows = useMemo(() => readonlyRows(data, section), [data, section])
  const filtered = useMemo(() => rows.filter(row => {
    if (storeId && row.storeId !== storeId) return false
    const date = typeof row.value.date === 'string' ? row.value.date : ''
    if ((start || end) && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (start && date < start) || (end && date > end))) return false
    return !search || JSON.stringify(row.value).toLowerCase().includes(search)
  }), [rows, storeId, start, end, search])
  const columns = preferredColumns[section] || Object.keys(rows[0]?.value || {}).slice(0, 8)
  const lastPage = Math.max(0, Math.ceil(filtered.length / 50) - 1), activePage = Math.min(page, lastPage)
  const visible = filtered.slice(activePage * 50, (activePage + 1) * 50)
  const detailJson = detail ? JSON.stringify(detail, null, 2) : ''
  const changeSection = (next: string) => { setSection(next); setPage(0); setDetail(null) }
  return <div className="readonly-workbench">
    <header><div><strong>运营工作台 · 本机数据只读查看</strong><p>{email}</p></div><div className="readonly-actions"><button className="button secondary" onClick={onExport}>导出本机备份</button><button className="button secondary" onClick={onExit}>返回版本核对</button></div></header>
    <section className="readonly-banner" role="status"><strong>离线只读 · 本机备份已保留</strong><p>备份时间：{new Date(draft.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）。此视图尚未与云端核对，不代表最新云端数据。</p><p>这里只查看原始保存记录，不录入、不重算、不同步、不清理备份。缺少日期或金额会显示未记录。</p></section>
    <nav aria-label="查看保存数据">{sections.map(key => <button key={key} className="button secondary" aria-pressed={section === key} onClick={() => changeSection(key)}>{storedSectionLabels[key] || key}</button>)}</nav>
    <section className="panel">
      <div className="readonly-filters"><label>店铺<select aria-label="只读筛选店铺" value={storeId} onChange={e => { setStoreId(e.target.value); setPage(0) }}><option value="">全部记录</option>{data.stores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
        <label>搜索原记录<input aria-label="只读搜索" value={query} onChange={e => { setQuery(e.target.value); setPage(0) }} /></label>
        <label>保存日期起<input aria-label="只读开始日期" type="date" value={start} onChange={e => { setStart(e.target.value); setPage(0) }} /></label>
        <label>保存日期止<input aria-label="只读结束日期" type="date" value={end} onChange={e => { setEnd(e.target.value); setPage(0) }} /></label>
        <button className="button secondary" onClick={() => { setStoreId(''); setQuery(''); setStart(''); setEnd(''); setPage(0) }}>清除筛选</button></div>
      <p>{storedSectionLabels[section] || section}：当前 {filtered.length} 条 / 原记录 {rows.length} 条。每页最多 50 条。</p>
      <p>店铺、日期筛选仅匹配记录已保存的字段；未记录的归属或日期不推算。金额按保存值显示，全部字段可点“详情”查看。</p>
      <div className="table-scroll"><table><thead><tr><th>店铺</th>{columns.map(key => <th key={key}>{fields[key] || key}</th>)}<th>原记录</th></tr></thead><tbody>{visible.map((row, index) => <tr key={activePage * 50 + index}><td>{row.storeId ? data.stores.find(store => store.id === row.storeId)?.name || row.storeId : '未记录'}</td>{columns.map(key => <td key={key}>{storedValue(row.value[key])}</td>)}<td><button className="text-button" onClick={() => setDetail(row.value)}>详情</button></td></tr>)}</tbody></table></div>
      {!filtered.length && <p>没有符合条件的已保存记录；这不表示业务金额为零。</p>}
      <div className="readonly-actions"><button className="button secondary" disabled={activePage === 0} onClick={() => setPage(activePage - 1)}>上一页</button><span>第 {activePage + 1} / {lastPage + 1} 页</span><button className="button secondary" disabled={activePage === lastPage} onClick={() => setPage(activePage + 1)}>下一页</button></div>
    </section>
    {detail && <section className="panel readonly-detail" aria-label="只读原记录详情"><button className="button secondary" onClick={() => setDetail(null)}>关闭详情</button><pre>{detailJson.slice(0, 200000)}</pre>{detailJson.length > 200000 && <p>详情显示前 200000 字符，请导出原始备份查看全部内容；数据未被截断保存。</p>}</section>}
  </div>
}
