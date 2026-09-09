import { Filter, Plus, Search, SlidersHorizontal } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Drawer, Modal } from '../components/Overlay'
import { Field, Input, Select, Textarea } from '../components/Fields'
import { OperationForm } from '../components/OperationForm'
import { createId, useWorkbench } from '../store/workbench'
import type { ActivityType, Platform, Sku } from '../types/models'
import { grossMargin, grossProfit, money, percent, totalCost } from '../utils/calculations'
import { getSkuContext } from '../utils/selectors'

const emptySku = (productLinkId = ''): Sku => ({ id: '', productLinkId, name: '', skuId: '', specification: '', salePrice: 0, finalPrice: 0, productCost: 0, shippingCost: 0, packagingCost: 0, otherCost: 0, currentRoi: 0, breakEvenRoi: 0, activity: '无活动', remark: '' })
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
      <div className="table-scroll"><table><thead><tr><th>产品 / 链接</th><th>甲方 / 店铺</th><th>SKU</th><th>售价</th><th>到手价</th><th>总成本</th><th>毛利</th><th>毛利率</th><th>投产</th><th>活动</th><th>备注</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>{rows.map(sku => { const ctx = getSkuContext(data, sku.id); const risk = sku.currentRoi < sku.breakEvenRoi; return <tr key={sku.id}>
          <td><div className="cell-main">{ctx.product?.name}</div><div className="cell-sub">{ctx.link?.linkId}</div></td>
          <td><div className="cell-main">{ctx.client?.name}</div><div className="cell-sub">{ctx.store?.name} · {ctx.store?.platform}</div></td>
          <td><button className="sku-link" onClick={() => setEditing(sku)}>{sku.name}</button><div className="cell-sub">{sku.skuId} · {sku.specification}</div></td>
          <td>{money(sku.salePrice)}</td><td className="emphasis">{money(sku.finalPrice)}</td><td>{money(totalCost(sku))}</td><td className={grossProfit(sku) < 0 ? 'negative' : 'positive'}>{money(grossProfit(sku))}</td><td>{percent(grossMargin(sku))}</td>
          <td><div className="cell-main">{sku.currentRoi.toFixed(1)}</div><div className="cell-sub">持平 {sku.breakEvenRoi.toFixed(1)}</div></td><td><span className="tag">{sku.activity}</span></td><td className="remark-cell">{sku.remark || '—'}</td><td><span className={`status ${risk ? 'risk' : 'normal'}`}><i />{risk ? '风险' : '正常'}</span></td><td><button className="row-action" onClick={() => setEditing(sku)}>查看</button></td>
        </tr> })}</tbody></table></div>
      {!rows.length && <div className="empty"><strong>没有符合条件的 SKU</strong><span>调整筛选条件或新增一条 SKU</span></div>}
    </section>
    {editing && <SkuDrawer sku={editing} onClose={() => setEditing(null)} onAdjust={id => { setEditing(null); setOperationSkuId(id) }} onSave={saved => { update(current => ({ ...current, skus: saved.id ? current.skus.map(x => x.id === saved.id ? saved : x) : [...current.skus, { ...saved, id: createId('sku') }] })); setEditing(null) }} />}
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
      <section className="form-section"><h3>价格与成本</h3><div className="form-grid">
        {([['salePrice','售价'],['finalPrice','到手价'],['productCost','商品成本'],['shippingCost','快递'],['packagingCost','包装'],['otherCost','其他成本']] as const).map(([key,label]) => <Field key={key} label={label}><Input type="number" min="0" step="0.01" value={sku[key]} onChange={e => number(key, e.target.value)} /></Field>)}
      </div><div className="profit-strip"><div><span>总成本</span><strong>{money(totalCost(sku))}</strong></div><div><span>毛利</span><strong>{money(grossProfit(sku))}</strong></div><div><span>毛利率</span><strong>{percent(grossMargin(sku))}</strong></div></div></section>
      <section className="form-section"><h3>投产与活动</h3><div className="form-grid"><Field label="当前投产"><Input type="number" min="0" step="0.1" value={sku.currentRoi} onChange={e => number('currentRoi', e.target.value)} /></Field><Field label="持平投产"><Input type="number" min="0" step="0.1" value={sku.breakEvenRoi} onChange={e => number('breakEvenRoi', e.target.value)} /></Field><Field label="当前活动" full><Select value={sku.activity} onChange={e => set('activity', e.target.value as ActivityType)}>{activities.map(x => <option key={x}>{x}</option>)}</Select></Field><Field label="备注" full><Textarea value={sku.remark} onChange={e => set('remark', e.target.value)} /></Field></div></section>
    </div><div className="drawer-actions">{!isNew && <button className="button secondary" onClick={() => onAdjust(sku.id)}>新增调整</button>}<button className="button primary" disabled={!valid} onClick={() => onSave(sku)}>保存</button></div>
  </Drawer>
}
