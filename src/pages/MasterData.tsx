import { ChevronDown, ChevronRight, Clock3, ExternalLink, Filter, ListPlus, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { Fragment, useState } from 'react'
import { Field, Input, Select, Textarea } from '../components/Fields'
import { Modal } from '../components/Overlay'
import { createId, useWorkbench } from '../store/workbench'
import type { Client, LinkStatus, Platform, Product, ProductLink, Sku, Store } from '../types/models'
import { calculatedBreakEvenRoi, money, percent } from '../utils/calculations'
import { appendSkuHistory } from '../utils/skuHistory'
import { createSkuChangeOperations } from '../utils/skuOperations'

type Tab = 'clients' | 'stores' | 'products' | 'links' | 'skus'
type Draft = Partial<Client & Store & Product & ProductLink & Sku> & { platform?: Platform; status?: LinkStatus }
type BatchRow = { name: string; price: number; productCostId: string }
const tabs: { id: Tab; label: string }[] = [{ id: 'clients', label: '甲方' }, { id: 'stores', label: '店铺' }, { id: 'products', label: '产品' }, { id: 'links', label: '商品链接' }, { id: 'skus', label: 'SKU' }]
const linkStatuses: LinkStatus[] = ['日销', '活动', '备用', '已挂']

export function MasterData() {
  const { data, update } = useWorkbench()
  const [tab, setTab] = useState<Tab>('clients')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [skuClientId, setSkuClientId] = useState('')
  const [skuProductId, setSkuProductId] = useState('')
  const [skuLinkId, setSkuLinkId] = useState('')
  const [skuQuery, setSkuQuery] = useState('')
  const [expandedSkuLinks, setExpandedSkuLinks] = useState<Set<string>>(new Set())
  const [expandedLinkGroups, setExpandedLinkGroups] = useState<Set<string>>(new Set())
  const [historySkuId, setHistorySkuId] = useState<string | null>(null)
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchLinkId, setBatchLinkId] = useState('')
  const [batchText, setBatchText] = useState('')
  const [batchRows, setBatchRows] = useState<BatchRow[]>([])
  const isEdit = Boolean(draft?.id)
  const openNew = () => setDraft(tab === 'stores' ? { clientId: data.clients[0]?.id, platform: '拼多多' } : tab === 'products' ? { clientId: data.clients[0]?.id } : tab === 'links' ? { clientId: data.clients[0]?.id, storeId: '', productId: '', status: '日销' } : tab === 'skus' ? { productLinkId: '', productCostId: '', name: '', salePrice: 0 } : {})

  const batchCosts = data.productCosts.filter(cost => cost.productId === data.productLinks.find(link => link.id === batchLinkId)?.productId)
  const parseBatch = () => {
    const normalize = (value: string) => value.toLowerCase().replace(/[\s【】\[\]（）()*/×]/g, '')
    const rows = batchText.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
      const cells = line.split(/\t|,|，/).map(cell => cell.trim()).filter(Boolean)
      const price = Number(cells.at(-1))
      const name = cells.slice(0, -1).join(' ')
      const key = normalize(name)
      const matches = batchCosts.filter(cost => {
        const spec = normalize(cost.specification)
        return spec.length >= 3 && (key.includes(spec) || spec.includes(key))
      })
      return { name, price, productCostId: matches.length === 1 ? matches[0].id : '' }
    }).filter(row => row.name && Number.isFinite(row.price) && row.price > 0)
    setBatchRows(rows)
  }
  const saveBatch = () => {
    if (!batchLinkId || !batchRows.length || batchRows.some(row => !row.productCostId)) return
    update(current => {
      const existing = new Set(current.skus.filter(sku => sku.productLinkId === batchLinkId).map(sku => sku.name.trim().toLowerCase()))
      const additions = batchRows.filter(row => {
        const key = row.name.trim().toLowerCase()
        if (existing.has(key)) return false
        existing.add(key)
        return true
      }).map(row => {
        const cost = current.productCosts.find(item => item.id === row.productCostId)!
        return { id: createId('sku'), productLinkId: batchLinkId, productCostId: cost.id, name: row.name, skuId: cost.skuCode, specification: cost.specification, salePrice: row.price, finalPrice: row.price, productCost: cost.totalCost, shippingCost: 0, packagingCost: 0, otherCost: 0, currentRoi: 0, breakEvenRoi: calculatedBreakEvenRoi(row.price, cost.totalCost), activity: '无活动' as const, activityPrice: 0, remark: '' }
      })
      return { ...current, skus: [...current.skus, ...additions] }
    })
    setBatchOpen(false); setBatchText(''); setBatchRows([])
  }

  const save = () => {
    if (!draft) return
    update(current => {
      if (tab === 'clients') { const item: Client = { id: draft.id || createId('client'), name: draft.name?.trim() || '', remark: draft.remark || '' }; return { ...current, clients: isEdit ? current.clients.map(x => x.id === item.id ? item : x) : [...current.clients, item] } }
      if (tab === 'stores') { const item: Store = { id: draft.id || createId('store'), clientId: draft.clientId || '', name: draft.name?.trim() || '', platform: draft.platform || '其他' }; return { ...current, stores: isEdit ? current.stores.map(x => x.id === item.id ? item : x) : [...current.stores, item] } }
      if (tab === 'products') { const item: Product = { id: draft.id || createId('product'), clientId: draft.clientId || '', name: draft.name?.trim() || '', remark: draft.remark || '' }; return { ...current, products: isEdit ? current.products.map(x => x.id === item.id ? item : x) : [...current.products, item] } }
      if (tab === 'links') { const item: ProductLink = { id: draft.id || createId('link'), clientId: draft.clientId || '', storeId: draft.storeId || '', productId: draft.productId || '', linkId: draft.linkId?.trim() || '', status: draft.status || '日销', url: draft.url || '', remark: draft.remark || '' }; return { ...current, productLinks: isEdit ? current.productLinks.map(x => x.id === item.id ? item : x) : [...current.productLinks, item] } }
      const cost = current.productCosts.find(x => x.id === draft.productCostId)
      const price = Number(draft.salePrice || 0)
      const item: Sku = { id: draft.id || createId('sku'), productLinkId: draft.productLinkId || '', productCostId: cost?.id || '', name: draft.name?.trim() || '', skuId: cost?.skuCode || '', specification: cost?.specification || '', salePrice: price, finalPrice: price, productCost: cost?.totalCost || 0, shippingCost: 0, packagingCost: 0, otherCost: 0, currentRoi: draft.currentRoi || 0, breakEvenRoi: calculatedBreakEvenRoi(price, cost?.totalCost || 0), activity: draft.activity || '无活动', activityPrice: draft.activity === '无活动' ? 0 : Number(draft.activityPrice || 0), remark: draft.remark || '' }
      const before = current.skus.find(x => x.id === item.id)
      return { ...current, skus: isEdit ? current.skus.map(x => x.id === item.id ? item : x) : [...current.skus, item], skuHistory: appendSkuHistory(current.skuHistory, before, item), operations: [...createSkuChangeOperations(current, before, item, '基础资料直接修改'), ...current.operations] }
    })
    setDraft(null)
  }

  const remove = (id: string, label: string) => {
    if (!window.confirm(`确定删除“${label}”吗？相关下级资料也会一并删除。`)) return
    update(current => {
      if (tab === 'clients') { const productIds = new Set(current.products.filter(x => x.clientId === id).map(x => x.id)); const storeIds = new Set(current.stores.filter(x => x.clientId === id).map(x => x.id)); const linkIds = new Set(current.productLinks.filter(x => x.clientId === id || productIds.has(x.productId) || storeIds.has(x.storeId)).map(x => x.id)); const skuIds = new Set(current.skus.filter(x => linkIds.has(x.productLinkId)).map(x => x.id)); return { ...current, clients: current.clients.filter(x => x.id !== id), stores: current.stores.filter(x => !storeIds.has(x.id)), products: current.products.filter(x => !productIds.has(x.id)), productCosts: current.productCosts.filter(x => !productIds.has(x.productId)), productLinks: current.productLinks.filter(x => !linkIds.has(x.id)), skus: current.skus.filter(x => !skuIds.has(x.id)), operations: current.operations.filter(x => !skuIds.has(x.skuId)), skuHistory: current.skuHistory.filter(x => !skuIds.has(x.skuId)) } }
      if (tab === 'stores') { const linkIds = new Set(current.productLinks.filter(x => x.storeId === id).map(x => x.id)); const skuIds = new Set(current.skus.filter(x => linkIds.has(x.productLinkId)).map(x => x.id)); return { ...current, stores: current.stores.filter(x => x.id !== id), productLinks: current.productLinks.filter(x => !linkIds.has(x.id)), skus: current.skus.filter(x => !skuIds.has(x.id)), operations: current.operations.filter(x => !skuIds.has(x.skuId)), skuHistory: current.skuHistory.filter(x => !skuIds.has(x.skuId)) } }
      if (tab === 'products') { const linkIds = new Set(current.productLinks.filter(x => x.productId === id).map(x => x.id)); const skuIds = new Set(current.skus.filter(x => linkIds.has(x.productLinkId)).map(x => x.id)); return { ...current, products: current.products.filter(x => x.id !== id), productCosts: current.productCosts.filter(x => x.productId !== id), productLinks: current.productLinks.filter(x => !linkIds.has(x.id)), skus: current.skus.filter(x => !skuIds.has(x.id)), operations: current.operations.filter(x => !skuIds.has(x.skuId)), skuHistory: current.skuHistory.filter(x => !skuIds.has(x.skuId)) } }
      if (tab === 'links') { const skuIds = new Set(current.skus.filter(x => x.productLinkId === id).map(x => x.id)); return { ...current, productLinks: current.productLinks.filter(x => x.id !== id), skus: current.skus.filter(x => !skuIds.has(x.id)), operations: current.operations.filter(x => !skuIds.has(x.skuId)), skuHistory: current.skuHistory.filter(x => !skuIds.has(x.skuId)) } }
      return { ...current, skus: current.skus.filter(x => x.id !== id), operations: current.operations.filter(x => x.skuId !== id), skuHistory: current.skuHistory.filter(x => x.skuId !== id) }
    })
  }

  const title = tabs.find(x => x.id === tab)?.label ?? ''
  const selectedLink = data.productLinks.find(x => x.id === draft?.productLinkId)
  const selectedCost = data.productCosts.find(x => x.id === draft?.productCostId)
  const storesForClient = data.stores.filter(x => !draft?.clientId || x.clientId === draft.clientId)
  const productsForLink = data.products.filter(product => product.clientId === draft?.clientId && data.productCosts.some(cost => cost.productId === product.id))
  const costsForSku = data.productCosts.filter(cost => cost.productId === selectedLink?.productId)
  const skuPrice = Number(draft?.salePrice || 0), skuCost = selectedCost?.totalCost || 0, skuProfit = skuPrice - skuCost
  const skuMargin = skuPrice > 0 ? (skuProfit / skuPrice) * 100 : 0
  const skuFilterProducts = data.products.filter(product => !skuClientId || product.clientId === skuClientId)
  const skuFilterLinks = data.productLinks.filter(link => (!skuClientId || link.clientId === skuClientId) && (!skuProductId || link.productId === skuProductId))
  const filteredSkus = data.skus.filter(sku => {
    const link = data.productLinks.find(x => x.id === sku.productLinkId)
    const product = data.products.find(x => x.id === link?.productId)
    const cost = data.productCosts.find(x => x.id === sku.productCostId)
    const text = `${link?.linkId || ''} ${product?.name || ''} ${sku.name} ${cost?.skuCode || sku.skuId} ${cost?.specification || sku.specification}`.toLowerCase()
    return (!skuClientId || product?.clientId === skuClientId) && (!skuProductId || product?.id === skuProductId) && (!skuLinkId || link?.id === skuLinkId) && (!skuQuery.trim() || text.includes(skuQuery.trim().toLowerCase()))
  })
  const groupedSkus = Array.from(new Set(filteredSkus.map(sku => sku.productLinkId))).map(linkId => ({ linkId, rows: filteredSkus.filter(sku => sku.productLinkId === linkId) }))
  const toggleSkuGroup = (linkId: string) => setExpandedSkuLinks(current => { const next = new Set(current); if (next.has(linkId)) next.delete(linkId); else next.add(linkId); return next })
  const linkGroups = Array.from(new Set(data.productLinks.map(link => `${link.clientId}|${link.storeId}`))).map(key => { const [clientId, storeId] = key.split('|'); return { key, clientId, storeId, rows: data.productLinks.filter(link => link.clientId === clientId && link.storeId === storeId) } })
  const toggleLinkGroup = (key: string) => setExpandedLinkGroups(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })
  const valid = tab === 'clients' ? draft?.name?.trim() : tab === 'products' ? draft?.clientId && draft.name?.trim() : tab === 'stores' ? draft?.clientId && draft.name?.trim() : tab === 'links' ? draft?.clientId && draft?.storeId && draft?.productId && draft?.linkId?.trim() : draft?.productLinkId && draft?.productCostId && draft?.name?.trim() && skuPrice > 0

  return <div className="page">
    <div className="page-heading"><div><span className="eyebrow">数据字典</span><h1>基础资料</h1><p>按甲方 → 产品 → 成本 → 商品链接 → SKU 维护业务关系。</p></div><div className="heading-actions">{tab === 'skus' && <button className="button secondary" onClick={() => setBatchOpen(true)}><ListPlus size={17} />批量导入</button>}<button className="button primary" onClick={openNew}><Plus size={17} />新增{title}</button></div></div>
    <section className="panel master-panel"><div className="tabs" role="tablist">{tabs.map(x => <button role="tab" aria-selected={tab === x.id} className={tab === x.id ? 'active' : ''} key={x.id} onClick={() => setTab(x.id)}>{x.label}<span>{data[x.id === 'links' ? 'productLinks' : x.id].length}</span></button>)}</div><div className="master-content">
      {tab === 'clients' && <SimpleTable headers={['名称','备注','操作']} rows={data.clients.map(x => [<strong>{x.name}</strong>, x.remark || '—', <Actions key="a" onEdit={() => setDraft(x)} onDelete={() => remove(x.id, x.name)} />])} />}
      {tab === 'stores' && <SimpleTable headers={['店铺名称','所属甲方','平台','操作']} rows={data.stores.map(x => [<strong>{x.name}</strong>, data.clients.find(c => c.id === x.clientId)?.name || '—', <span className="tag">{x.platform}</span>, <Actions key="a" onEdit={() => setDraft(x)} onDelete={() => remove(x.id, x.name)} />])} />}
      {tab === 'products' && <SimpleTable headers={['产品名称','所属甲方','SKU 成本','关联链接','备注','操作']} rows={data.products.map(x => [<strong>{x.name}</strong>, data.clients.find(client => client.id === x.clientId)?.name || '未关联', `${data.productCosts.filter(cost => cost.productId === x.id).length} 条`, `${data.productLinks.filter(link => link.productId === x.id).length} 条`, x.remark || '—', <Actions key="a" onEdit={() => setDraft(x)} onDelete={() => remove(x.id, x.name)} />])} />}
      {tab === 'links' && <div className="table-scroll"><table><thead><tr><th>甲方 / 店铺 / 商品 ID</th><th>状态</th><th>产品</th><th>URL</th><th>备注</th><th>操作</th></tr></thead><tbody>{linkGroups.map(group => { const client = data.clients.find(x => x.id === group.clientId); const store = data.stores.find(x => x.id === group.storeId); const expanded = expandedLinkGroups.has(group.key); return <Fragment key={group.key}><tr className="sku-group-row"><td colSpan={6}><button onClick={() => toggleLinkGroup(group.key)}>{expanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}<strong>{client?.name || '未关联甲方'}</strong><span>{store?.name || '未关联店铺'}</span><em>{group.rows.length} 个 ID</em></button></td></tr>{expanded && group.rows.map(link => <tr key={link.id} className="sku-detail-row"><td><strong>{link.linkId}</strong></td><td><span className={`link-status status-${link.status}`}>{link.status}</span></td><td>{data.products.find(p => p.id === link.productId)?.name || '—'}</td><td>{link.url ? <a className="external" href={link.url} target="_blank" rel="noreferrer">打开<ExternalLink size={13} /></a> : '—'}</td><td>{link.remark || '—'}</td><td><Actions onEdit={() => setDraft(link)} onDelete={() => remove(link.id, link.linkId)} /></td></tr>)}</Fragment> })}</tbody></table>{!linkGroups.length && <div className="empty"><strong>暂无商品链接</strong><span>点击右上角新增</span></div>}</div>}
      {tab === 'skus' && <><section className="filter-bar master-sku-filter"><div className="filter-title"><Filter size={17} /><span>SKU 筛选</span></div><Select value={skuClientId} onChange={e => { setSkuClientId(e.target.value); setSkuProductId(''); setSkuLinkId('') }}><option value="">全部甲方</option>{data.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</Select><Select value={skuProductId} onChange={e => { setSkuProductId(e.target.value); setSkuLinkId('') }}><option value="">全部产品</option>{skuFilterProducts.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</Select><Select value={skuLinkId} onChange={e => setSkuLinkId(e.target.value)}><option value="">全部商品 ID</option>{skuFilterLinks.map(link => <option key={link.id} value={link.id}>{link.linkId}</option>)}</Select><div className="search"><Search size={16} /><Input value={skuQuery} onChange={e => setSkuQuery(e.target.value)} placeholder="搜索商品 ID、SKU 名称或编码" /></div>{(skuClientId || skuProductId || skuLinkId || skuQuery) && <button className="text-button" onClick={() => { setSkuClientId(''); setSkuProductId(''); setSkuLinkId(''); setSkuQuery('') }}>清空</button>}</section><div className="table-scroll"><table><thead><tr><th>商品 ID / 分组</th><th>店铺 / ID 状态</th><th>售卖 SKU 名称</th><th>SKU 编码</th><th>成本</th><th>售价</th><th>毛利</th><th>毛利率</th><th>保本 ROI</th><th>操作</th></tr></thead><tbody>{groupedSkus.map(group => { const link = data.productLinks.find(x => x.id === group.linkId); const product = data.products.find(x => x.id === link?.productId); const client = data.clients.find(x => x.id === product?.clientId); const store = data.stores.find(x => x.id === link?.storeId); const expanded = expandedSkuLinks.has(group.linkId); return <Fragment key={group.linkId}><tr className="sku-group-row"><td colSpan={10}><button onClick={() => toggleSkuGroup(group.linkId)}>{expanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}<strong>{link?.linkId || '未关联商品 ID'}</strong><span>{client?.name || '—'} · {store?.name || '—'} · {product?.name || '—'}</span>{link && <span className={`link-status status-${link.status}`}>{link.status}</span>}<em>{group.rows.length} 个 SKU</em></button></td></tr>{expanded && group.rows.map(sku => { const cost = data.productCosts.find(x => x.id === sku.productCostId); const c = cost?.totalCost ?? sku.productCost; const profit = sku.salePrice - c; const margin = sku.salePrice > 0 ? profit / sku.salePrice * 100 : 0; return <tr key={sku.id} className="sku-detail-row"><td><span className="cell-sub">{link?.linkId}</span></td><td><div className="cell-main">{store?.name || '—'}</div><div className="cell-sub">{link?.status || '日销'}</div></td><td>{sku.name}</td><td><div className="cell-main">{cost?.skuCode || sku.skuId}</div><div className="cell-sub">{cost?.specification || sku.specification}</div></td><td>{money(c)}</td><td>{money(sku.salePrice)}</td><td><span className={profit < 0 ? 'negative' : 'positive'}>{money(profit)}</span></td><td>{percent(margin)}</td><td>{calculatedBreakEvenRoi(sku.salePrice, c).toFixed(2)}</td><td><div className="actions"><button className="icon-button" onClick={() => setHistorySkuId(sku.id)} aria-label="历史记录" title="历史记录"><Clock3 size={15} /></button><Actions onEdit={() => setDraft({ ...sku, productCostId: cost?.id || '' })} onDelete={() => remove(sku.id, sku.name)} /></div></td></tr> })}</Fragment> })}</tbody></table>{!groupedSkus.length && <div className="empty"><strong>没有符合条件的 SKU</strong><span>请调整筛选条件或新增 SKU</span></div>}</div></>}
    </div></section>
    {draft && <Modal title={`${isEdit ? '编辑' : '新增'}${title}`} onClose={() => setDraft(null)}><div className="form-grid modal-body">
      {tab === 'clients' && <><Field label="名称" full><Input autoFocus value={draft.name || ''} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="备注" full><Textarea value={draft.remark || ''} onChange={e => setDraft({ ...draft, remark: e.target.value })} /></Field></>}
      {tab === 'products' && <><Field label="所属甲方" full><Select value={draft.clientId || ''} onChange={e => setDraft({ ...draft, clientId: e.target.value })}><option value="">请选择甲方</option>{data.clients.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field><Field label="产品名称" full><Input autoFocus value={draft.name || ''} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="备注" full><Textarea value={draft.remark || ''} onChange={e => setDraft({ ...draft, remark: e.target.value })} /></Field></>}
      {tab === 'stores' && <><Field label="所属甲方" full><Select value={draft.clientId || ''} onChange={e => setDraft({ ...draft, clientId: e.target.value })}>{data.clients.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field><Field label="店铺名称" full><Input autoFocus value={draft.name || ''} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="平台" full><Select value={draft.platform || '拼多多'} onChange={e => setDraft({ ...draft, platform: e.target.value as Platform })}>{['拼多多','淘宝','其他'].map(x => <option key={x}>{x}</option>)}</Select></Field></>}
      {tab === 'links' && <><Field label="所属甲方"><Select value={draft.clientId || ''} onChange={e => setDraft({ ...draft, clientId: e.target.value, storeId: '', productId: '' })}><option value="">请选择</option>{data.clients.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field><Field label="所属店铺"><Select value={draft.storeId || ''} onChange={e => setDraft({ ...draft, storeId: e.target.value })}><option value="">请选择</option>{storesForClient.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field><Field label="产品"><Select value={draft.productId || ''} onChange={e => setDraft({ ...draft, productId: e.target.value })}><option value="">{draft.clientId && !productsForLink.length ? '请先为该甲方建立产品成本' : '请选择'}</option>{productsForLink.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field><Field label="商品 ID"><Input value={draft.linkId || ''} onChange={e => setDraft({ ...draft, linkId: e.target.value })} /></Field><Field label="ID 状态"><Select value={draft.status || '日销'} onChange={e => setDraft({ ...draft, status: e.target.value as LinkStatus })}>{linkStatuses.map(status => <option key={status}>{status}</option>)}</Select></Field><Field label="商品链接 URL" full><Input type="url" value={draft.url || ''} onChange={e => setDraft({ ...draft, url: e.target.value })} placeholder="https://" /></Field><Field label="备注" full><Textarea value={draft.remark || ''} onChange={e => setDraft({ ...draft, remark: e.target.value })} /></Field></>}
      {tab === 'skus' && <><Field label="商品 ID" full><Select value={draft.productLinkId || ''} onChange={e => setDraft({ ...draft, productLinkId: e.target.value, productCostId: '' })}><option value="">请选择商品 ID</option>{data.productLinks.map(link => { const product = data.products.find(x => x.id === link.productId); const client = data.clients.find(x => x.id === product?.clientId); return <option key={link.id} value={link.id}>{link.linkId} · {client?.name} · {product?.name}</option> })}</Select></Field><Field label="售卖 SKU 名称" full><Input autoFocus value={draft.name || ''} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="SKU 编码" full><Select value={draft.productCostId || ''} onChange={e => setDraft({ ...draft, productCostId: e.target.value })}><option value="">{selectedLink && !costsForSku.length ? '该产品暂无成本 SKU' : '请从产品成本库选择'}</option>{costsForSku.map(cost => <option key={cost.id} value={cost.id}>{cost.skuCode} · {cost.specification}</option>)}</Select></Field><Field label="成本（自动同步）"><Input value={money(skuCost)} readOnly /></Field><Field label="售价"><Input type="number" min="0" step="0.01" value={draft.salePrice ?? 0} onChange={e => setDraft({ ...draft, salePrice: e.target.value === '' ? 0 : Number(e.target.value) })} /></Field><div className="profit-strip" style={{ gridColumn: '1 / -1' }}><div><span>毛利</span><strong>{money(skuProfit)}</strong></div><div><span>毛利率</span><strong>{percent(skuMargin)}</strong></div><div><span>保本 ROI</span><strong>{calculatedBreakEvenRoi(skuPrice, skuCost).toFixed(2)}</strong></div></div></>}
    </div><div className="modal-actions"><button className="button ghost" onClick={() => setDraft(null)}>取消</button><button className="button primary" disabled={!valid} onClick={save}>保存</button></div></Modal>}
    {batchOpen && <Modal title="批量导入 SKU" wide onClose={() => setBatchOpen(false)}><div className="batch-import modal-body">
      <Field label="商品 ID" full><Select value={batchLinkId} onChange={e => { setBatchLinkId(e.target.value); setBatchRows([]) }}><option value="">请选择商品 ID</option>{data.productLinks.map(link => { const product = data.products.find(x => x.id === link.productId); const client = data.clients.find(x => x.id === link.clientId); return <option key={link.id} value={link.id}>{link.linkId} · {client?.name} · {product?.name}</option> })}</Select></Field>
      <Field label="粘贴数据（每行：SKU 名称 + Tab + 售价）" full><Textarea rows={8} value={batchText} onChange={e => { setBatchText(e.target.value); setBatchRows([]) }} placeholder={'2袋原味【2*125g/包】含花青素\t19.50\n2袋麻辣【2*125g/包】含花青素\t19.50'} /></Field>
      <button className="button secondary" disabled={!batchLinkId || !batchText.trim()} onClick={parseBatch}>解析并匹配成本</button>
      {batchRows.length > 0 && <div className="table-scroll batch-preview"><table><thead><tr><th>售卖 SKU 名称</th><th>售价</th><th>成本 SKU</th></tr></thead><tbody>{batchRows.map((row, index) => <tr key={`${row.name}-${index}`}><td>{row.name}</td><td>{money(row.price)}</td><td><Select value={row.productCostId} onChange={e => setBatchRows(current => current.map((item, i) => i === index ? { ...item, productCostId: e.target.value } : item))}><option value="">请选择成本 SKU</option>{batchCosts.map(cost => <option key={cost.id} value={cost.id}>{cost.skuCode} · {cost.specification} · {money(cost.totalCost)}</option>)}</Select></td></tr>)}</tbody></table></div>}
      {batchRows.length > 0 && batchRows.some(row => !row.productCostId) && <div className="form-error">请为未自动匹配的行选择成本 SKU。</div>}
    </div><div className="modal-actions"><button className="button ghost" onClick={() => setBatchOpen(false)}>取消</button><button className="button primary" disabled={!batchRows.length || batchRows.some(row => !row.productCostId)} onClick={saveBatch}>导入 {batchRows.length || ''} 条 SKU</button></div></Modal>}
    {historySkuId && <Modal title="SKU 曾用名称与价格" wide onClose={() => setHistorySkuId(null)}><div className="table-scroll history-table"><table><thead><tr><th>使用记录时间</th><th>曾用 SKU 名称</th><th>曾用售价</th></tr></thead><tbody>{data.skuHistory.filter(item => item.skuId === historySkuId).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)).map(item => <tr key={item.id}><td>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(item.recordedAt))}</td><td>{item.name}</td><td>{money(item.salePrice)}</td></tr>)}</tbody></table>{!data.skuHistory.some(item => item.skuId === historySkuId) && <div className="empty"><strong>暂无历史记录</strong><span>修改 SKU 名称或售价后，旧值会自动保存在这里</span></div>}</div><div className="modal-actions"><button className="button primary" onClick={() => setHistorySkuId(null)}>完成</button></div></Modal>}
  </div>
}

function Actions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) { return <div className="actions"><button className="icon-button" onClick={onEdit} aria-label="编辑"><Pencil size={15} /></button><button className="icon-button danger" onClick={onDelete} aria-label="删除"><Trash2 size={15} /></button></div> }
function SimpleTable({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) { return <div className="table-scroll"><table><thead><tr>{headers.map(x => <th key={x}>{x}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table>{!rows.length && <div className="empty"><strong>暂无资料</strong><span>点击右上角新增</span></div>}</div> }
