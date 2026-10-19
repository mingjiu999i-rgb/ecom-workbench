import { RotateCcw, ShieldAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useWorkbench } from '../store/workbench'
import { createStoreBusinessBackup, resetStoreBusiness, restoreStoreBusiness, storeBusinessSummary, validateStoreBusinessBackup } from '../utils/storeBusinessReset'
import { readStoreResetRecovery, writeStoreResetRecovery, type StoreResetRecovery } from '../services/storeResetRecovery'
import './store-business-reset.css'

export function StoreBusinessReset() {
  const { data, update, userEmail, syncStatus } = useWorkbench()
  const [params] = useSearchParams()
  const [storeId, setStoreId] = useState(params.get('store') || '')
  const [recovery, setRecovery] = useState<StoreResetRecovery | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const generation = useRef(0)
  const pending = useRef(false)
  const latest = useRef({ storeId, userEmail, syncStatus })
  latest.current = { storeId, userEmail, syncStatus }
  const store = data.stores.find(row => row.id === storeId)
  const inspected = useMemo(() => {
    if (!store) return { summary: null, error: '' }
    try { return { summary: storeBusinessSummary(data, store.id), error: '' } }
    catch (cause) { return { summary: null, error: cause instanceof Error ? cause.message : '数据结构无法识别，已阻止操作。' } }
  }, [data, store])
  useEffect(() => {
    const token = ++generation.current
    setRecovery(null); setLoading(true)
    void readStoreResetRecovery(userEmail, storeId).then(record => {
      if (token === generation.current) setRecovery(record)
    }).catch(() => {
      if (token === generation.current) setError('本机撤销记录读取失败；清空时会重新尝试自动暂存，暂存不成功就不会清空。')
    }).finally(() => { if (token === generation.current) setLoading(false) })
    return () => { generation.current++ }
  }, [storeId, userEmail])
  useEffect(() => {
    if (!busy) return
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', unload)
    return () => window.removeEventListener('beforeunload', unload)
  }, [busy])
  const ready = syncStatus === 'saved' && !busy && !loading
  const selectedRecovery = recovery?.backup.account === userEmail && recovery.backup.store.id === storeId ? recovery : null
  const select = (id: string) => {
    if (pending.current || id === storeId) return
    generation.current++; setStoreId(id); setRecovery(null); setConfirmation(''); setLoading(true); setMessage(''); setError('')
  }
  const reset = async (event: FormEvent) => {
    event.preventDefault()
    if (!store || !ready || pending.current || confirmation !== store.name || !inspected.summary?.hasData) return
    pending.current = true; setBusy(true); setError('')
    const token = ++generation.current
    try {
      const record = { id: crypto.randomUUID(), backup: createStoreBusinessBackup(data, store.id, userEmail, new Date().toISOString()) }
      validateStoreBusinessBackup(record.backup)
      await writeStoreResetRecovery(record)
      if (token !== generation.current || latest.current.storeId !== store.id || latest.current.userEmail !== userEmail) return
      if (latest.current.syncStatus !== 'saved') throw new Error('当前有数据正在同步，请等待同步完成后重试清空。')
      // Only a committed local snapshot permits clearing; recheck current scope.
      update(current => resetStoreBusiness(current, record.backup, userEmail, confirmation))
      setRecovery(record); setConfirmation(''); setMessage(`已提交「${store.name}」全部日期的经营数据清空。请等待“云端已同步”再重传；清错店铺可点击“撤销本次清空”。`)
    } catch (cause) {
      if (token === generation.current) setError(cause instanceof Error ? cause.message : '自动暂存失败，未清空数据。')
    } finally {
      pending.current = false
      if (token === generation.current) setBusy(false)
    }
  }
  const undo = () => {
    if (!store || !selectedRecovery || !ready || pending.current || inspected.summary?.hasData) return
    try {
      update(current => restoreStoreBusiness(current, selectedRecovery.backup, userEmail, store.name, new Date().toISOString()))
      setError(''); setMessage(`已提交「${store.name}」撤销清空，请等待云端同步。其他店铺未变，历史金额和成本快照原样恢复。`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '撤销失败。') }
  }
  const counts = inspected.summary?.counts
  return <div className="page store-reset-page"><div className="page-heading"><div><span className="eyebrow">经营数据维护 · 不改变结算算法</span><h1>单店经营数据重置</h1><p>选店铺、输入店铺名确认、清空后重传。不需要下载备份。</p></div><Link className="button secondary" to="/profit-preview" onClick={event => { if (busy) event.preventDefault() }}>返回经营结算</Link></div>
    <section className="panel store-reset-warning"><ShieldAlert size={24} /><div><strong>只清空所选店铺的全部日期，不受日期筛选影响</strong><p>清理结算汇总、产品利润、订单／售后／资金／推广账本、原订单成本快照、商品 ID 销售索引和手填推广费，以及该店退款观察记录。保留甲方、店铺、商品链接、SKU、成本库及 SKU 草稿，其他店铺不动。</p><p>重传该店完整历史报表时，将按正常导入规则重新锁定成本。请先关闭其他正在导入或编辑工作台的页面和设备，避免旧页面写回数据。</p></div></section>
    <section className="panel store-reset-selection"><label className="field"><span>选择需要重置的店铺</span><select value={storeId} disabled={busy} onChange={event => select(event.target.value)}><option value="">请选择店铺（不支持全部清空）</option>{data.stores.map(row => <option key={row.id} value={row.id}>{data.clients.find(client => client.id === row.clientId)?.name || '未关联甲方'} · {row.name}</option>)}</select></label></section>
    {(error || inspected.error) && <div className="store-reset-alert" role="alert">{error || inspected.error}</div>}
    {message && <div className="store-reset-message" role="status">{message}</div>}
    {syncStatus !== 'saved' && <div className="store-reset-alert">{syncStatus === 'saving' ? '正在同步，请等待“云端已同步”后再重传或撤销。' : '云端同步失败，请使用同步提示重试，不要在其他页面重新导入。'}</div>}
    {store && counts && <><section className="panel store-reset-scope"><h2>将处理：{store.name}</h2><p>已记录的订单／汇总日期：{inspected.summary?.start ? `${inspected.summary.start} 至 ${inspected.summary.end}` : '尚无可识别日期'}。这是实际记录范围，不表示期间每天都有数据。</p><dl>{[['每日结算汇总',counts.collections],['产品利润记录',counts.profits],['订单成本快照',counts.orders],['售后记录',counts.refunds],['资金流水',counts.funds],['店铺推广费日期',counts.promotionDays],['商品 ID 订单索引',counts.linkOrders],['商品 ID 手填推广费',counts.linkPromotions]].map(([label,count]) => <div key={String(label)}><dt>{label}</dt><dd>{count}</dd></div>)}</dl></section>
    <section className="panel store-reset-actions"><h2>确认清空「{store.name}」</h2><form onSubmit={event => void reset(event)}><label className="field"><span>输入完整店铺名「{store.name}」确认</span><input disabled={busy} autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} placeholder="请输入店铺全名" /></label><button className="button store-reset-danger-button" disabled={!ready || confirmation !== store.name || !inspected.summary?.hasData} type="submit">{busy ? '正在自动暂存…' : `清空「${store.name}」全部经营数据`}</button></form>{!inspected.summary?.hasData && <p>该店当前没有经营记录。{ready ? <Link to={`/profit-preview?store=${encodeURIComponent(store.id)}`}>前往该店重新导入报表</Link> : '同步完成后才能开始重新导入。'}</p>}</section>
    <section className="panel store-reset-actions"><h2>清错了？撤销本次清空</h2><p>系统在清空前自动暂存原记录，无需下载。只在本机此浏览器保留每个账号、每家店最近一次记录；刷新页面后仍可读取，不跨设备同步，清理浏览器数据后不可用。</p>{selectedRecovery ? <><p>上次暂存：{new Date(selectedRecovery.backup.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · {selectedRecovery.backup.store.name}</p><button className="button secondary" disabled={!ready || !!inspected.summary?.hasData} onClick={undo}><RotateCcw size={16} />撤销本次清空</button>{inspected.summary?.hasData && <p>当前店铺已有经营数据，不能覆盖撤销；不会用旧记录覆盖重传后的新数据。</p>}</> : <p>{loading ? '正在读取自动暂存…' : '当前店铺暂无自动暂存记录。'}</p>}</section></>}
  </div>
}
