import { Filter, Plus, Search, SlidersHorizontal } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Drawer, Modal } from '../components/Overlay'
import { Field, Input, Select, Textarea } from '../components/Fields'
import { OperationForm } from '../components/OperationForm'
import { createId, useWorkbench } from '../store/workbench'
import type { ActivityType, Platform, Sku } from '../types/models'
import { calculatedBreakEvenRoi, grossMargin, grossProfit, money, percent, totalCost } from '../utils/calculations'
import { getSkuContext } from '../utils/selectors'
import { appendSkuHistory } from '../utils/skuHistory'
import { createSkuChangeOperations } from '../utils/skuOperations'

const emptySku = (productLinkId = ''): Sku => ({ id: '', productLinkId, productCostId: '', name: '', skuId: '', specification: '', salePrice: 0, finalPrice: 0, productCost: 0, shippingCost: 0, packagingCost: 0, otherCost: 0, currentRoi: 0, breakEvenRoi: 0, activity: '无活动', activityPrice: 0, remark: '' })
const activities: ActivityType[] = ['无活动', '平台活动', '店铺活动', '百亿补贴', '其他']

export function Products() {
  const { data, update } = useWorkbench()
  const [params] = useSearchParams()
  const [clientId, setClientId] = useState(params.get('client') ?? '')
  const [storeId, setStoreId] = useState('')
  const [platform, setPlatform] = useState('')
  const [productId, setProductId] = useState('')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Sku | null>(null)
  const [operationSkuId, setOperationSkuId] = useState<string | null>(null)
  const rows = useMemo(() => data.skus.filter(sku => {
    const ctx = getSkuContext(data, sku.id)
    const haystack = `${ctx.product?.name} ${ctx.link?.linkId} ${sku.name} ${sku.skuId}`.toLowerCase()
    return (!clientId || ctx.client?.id === clientId) && (!storeId || ctx.store?.id === storeId) && (!platform || ctx.store?.platform === platform) && (!productId || ctx.product?.id === productId) && (!query || haystack.includes(query.toLowerCase()))
  }), [data, clientId, storeId, platform, productId, query])
  const filteredStores = data.stores.filter(s => !clientId || s.clientId === clientId)
  const filteredProducts = data.products.filter(product => !clientId || product.clientId === clientId)
  const clear = () => { setClientId(''); setStoreId(''); setPlatform(''); setProductId(''); setQuery('') }

  return <div className="page page-wide">
    <div className="page-heading"><div><span className="eyebrow">经营数据中心</span><h1>商品管理</h1><p>统一查看 SKU 的价格、成本、毛利和投产状态。</p></div><button className="button primary" onClick={() => setEditing(emptySku(data.productLinks[0]?.id))}><Plus size={17} />新增 SKU</button></div>
    <section className="filter-bar">
      <div className="filter-title"><Filter size={17} /><span>筛选</span></div>
      <Select aria-label="甲方筛选" value={clientId} onChange={e => { setClientId(e.target.value); setStoreId(''); setProductId('') }}><option value="">全部甲方</option>{data.clients.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
      <Select aria-label="店铺筛选" value={storeId} onChange={e => setStoreId(e.target.value)}><option value="">全部店铺</option>{filteredStores.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
      <Select aria-label="平台筛选" value={platform} onChange={e => setPlatform(e.target.value)}><option value="">全部平台</option>{['拼多多', '淘宝', '其他'].map(x => <option key={x}>{x}</option>)}</Select>
      <Select aria-label="产品筛选" value={productId} onChange={e => setProductId(e.target.value)}><option value="">全部产品</option>{filteredProducts.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
      <div className="search"><Search size={16} /><Input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索产品、链接或 SKU" /></div>
      {(clientId || storeId || platform || productId || query) && <button className="text-button" onClick={clear}>清空</button>}
    </section>
    <section className="panel table-panel"><div className="table-caption"><div><strong>SKU 列表</strong><span>共 {rows.length} 条</span></div><SlidersHorizontal size={17} /></div>
      <div className="table-scroll"><table><thead><tr><th>产品 / 链接</th><th>甲方 / 店铺</th><th>ID 状态</th><th>SKU</th><th>售价</th><th>到手价</th><th>总成本</th><th>毛利</th><th>毛利率</th><th>保本投产</th><th>活动状态</th><th>活动价</th><th>活动毛利率</th><th>活动保本投产</th><th>备注</th><th>操作</th></tr></thead>
        <tbody>{rows.map(sku => { const ctx = getSkuContext(data, sku.id); const activityActive = sku.activity !== '无活动' && sku.activityPrice > 0; const cost = totalCost(sku); return <tr key={sku.id}>
          <td><div className="cell-main">{ctx.product?.name}</div><div className="cell-sub">{ctx.link?.linkId}</div></td>
          <td><div className="cell-main">{ctx.client?.name}</div><div className="cell-sub">{ctx.store?.name} · {ctx.store?.platform}</div></td>
          <td><span className={`link-status status-${ctx.link?.status || '日销'}`}>{ctx.link?.status || '日销'}</span></td>
          <td><button className="sku-link" onClick={() => setEditing(sku)}>{sku.name}</button><div className="cell-sub">{sku.skuId} · {sku.specification}</div></td>
          <td>{money(sku.salePrice)}</td><td className="emphasis">{money(sku.finalPrice)}</td><td>{money(totalCost(sku))}</td><td className={grossProfit(sku) < 0 ? 'negative' : 'positive'}>{money(grossProfit(sku))}</td><td>{percent(grossMargin(sku))}</td>
          <td>{sku.breakEvenRoi.toFixed(1)}</td><td><span className="tag">{sku.activity}</span></td><td>{activityActive ? money(sku.activityPrice) : '—'}</td><td>{activityActive ? percent((sku.activityPrice - cost) / sku.activityPrice * 100) : '—'}</td><td>{activityActive ? (sku.activityPrice > cost ? (sku.activityPrice / (sku.activityPrice - cost)).toFixed(1) : '无法持平') : '—'}</td><td className="remark-cell">{sku.remark || '—'}</td><td><button className="row-action" onClick={() => setEditing(sku)}>查看</button></td>
        </tr> })}</tbody></table></div>
      {!rows.length && <div className="empty"><strong>没有符合条件的 SKU</strong><span>调整筛选条件或新增一条 SKU</span></div>}
    </section>
    {editing && <SkuDrawer sku={editing} onClose={() => setEditing(null)} onAdjust={id => { setEditing(null); setOperationSkuId(id) }} onSave={saved => { update(current => { const before = current.skus.find(x => x.id === saved.id); const normalized = { ...saved, breakEvenRoi: calculatedBreakEvenRoi(saved.salePrice, totalCost(saved)), activityPrice: saved.activity === '无活动' ? 0 : saved.activityPrice }; const item = normalized.id ? normalized : { ...normalized, id: createId('sku') }; return { ...current, skus: saved.id ? current.skus.map(x => x.id === saved.id ? item : x) : [...current.skus, item], skuHistory: appendSkuHistory(current.skuHistory, before, item), operations: [...createSkuChangeOperations(current, before, item, '商品管理直接修改'), ...current.operations] } }); setEditing(null) }} />}
    {operationSkuId && <Modal title="新增调整" onClose={() => setOperationSkuId(null)} wide><OperationForm initialSkuId={operationSkuId} onDone={() => setOperationSkuId(null)} /></Modal>}
  </div>
}

function SkuDrawer({ sku: initial, onClose, onSave, onAdjust }: { sku: Sku; onClose: () => void; onSave: (sku: Sku) => void; onAdjust: (id: string) => void }) {
  const { data } = useWorkbench()
  const [sku, setSku] = useState(initial)
  const set = <K extends keyof Sku>(key: K, value: Sku[K]) => setSku(current => ({ ...current, [key]: value }))
  const number = (key: keyof Sku, value: string) => set(key, (value === '' ? 0 : Number(value)) as never)
  const isNew = !sku.id
  const link = data.productLinks.find(x => x.id === sku.productLinkId)
  const valid = sku.productLinkId && sku.name.trim() && sku.skuId.trim()
  return <Drawer title={isNew ? '新增 SKU' : sku.name} onClose={onClose}>
    <div className="drawer-content">
      <section className="form-section"><h3>基础信息</h3><div className="form-grid">
        <Field label="商品链接" full><Select value={sku.productLinkId} onChange={e => set('productLinkId', e.target.value)}><option value="">请选择</option>{data.productLinks.map(x => <option key={x.id} value={x.id}>{data.products.find(p => p.id === x.productId)?.name} · {x.linkId}</option>)}</Select></Field>
        <Field label="SKU 名称"><Input value={sku.name} onChange={e => set('name', e.target.value)} /></Field><Field label="SKU ID"><Input value={sku.skuId} onChange={e => set('skuId', e.target.value)} /></Field>
        <Field label="规格" full><Input value={sku.specification} onChange={e => set('specification', e.target.value)} /></Field>
      </div></section>
      <section className="form-section activity-section"><h3>活动与保本投产</h3><div className="form-grid"><Field label="活动状态"><Select value={sku.activity} onChange={e => { const activity = e.target.value as ActivityType; setSku(current => ({ ...current, activity, activityPrice: activity === '无活动' ? 0 : current.activityPrice })) }}>{activities.map(x => <option key={x}>{x}</option>)}</Select></Field><Field label="普通价保本投产"><Input value={calculatedBreakEvenRoi(sku.salePrice, totalCost(sku)).toFixed(2)} readOnly /></Field>{sku.activity !== '无活动' && <><Field label="活动价" full><Input type="number" min="0" step="0.01" value={sku.activityPrice || 0} onChange={e => number('activityPrice', e.target.value)} placeholder="请输入该 SKU 的活动价" /></Field><div className="profit-strip field-full"><div><span>活动毛利</span><strong>{money(sku.activityPrice - totalCost(sku))}</strong></div><div><span>活动毛利率</span><strong>{percent(sku.activityPrice > 0 ? (sku.activityPrice - totalCost(sku)) / sku.activityPrice * 100 : 0)}</strong></div><div><span>活动保本投产</span><strong>{sku.activityPrice > totalCost(sku) ? (sku.activityPrice / (sku.activityPrice - totalCost(sku))).toFixed(2) : '无法持平'}</strong></div></div></>}<Field label="备注" full><Textarea value={sku.remark} onChange={e => set('remark', e.target.value)} /></Field></div></section>
      <section className="form-section"><h3>价格与成本</h3><div className="form-grid">
        {([['salePrice','售价'],['finalPrice','到手价'],['productCost','商品成本'],['shippingCost','快递'],['packagingCost','包装'],['otherCost','其他成本']] as const).map(([key,label]) => <Field key={key} label={label}><Input type="number" min="0" step="0.01" value={sku[key]} onChange={e => number(key, e.target.value)} /></Field>)}
      </div><div className="profit-strip"><div><span>总成本</span><strong>{money(totalCost(sku))}</strong></div><div><span>毛利</span><strong>{money(grossProfit(sku))}</strong></div><div><span>毛利率</span><strong>{percent(grossMargin(sku))}</strong></div></div></section>
      {!isNew && <section className="form-section"><h3>曾用名称与价格</h3>{data.skuHistory.filter(item => item.skuId === sku.id).length ? <div className="sku-history-list">{data.skuHistory.filter(item => item.skuId === sku.id).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)).map(item => <div key={item.id}><span>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short' }).format(new Date(item.recordedAt))}</span><strong>{item.name}</strong><b>{money(item.salePrice)}</b></div>)}</div> : <p className="form-hint">修改名称或售价后，旧值会自动记录在这里。</p>}</section>}
    </div><div className="drawer-actions">{!isNew && <button className="button secondary" onClick={() => onAdjust(sku.id)}>新增调整</button>}<button className="button primary" disabled={!valid} onClick={() => onSave(sku)}>保存</button></div>
  </Drawer>
}
