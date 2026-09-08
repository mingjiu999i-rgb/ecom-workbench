import { ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Field, Input, Select, Textarea } from '../components/Fields'
import { Modal } from '../components/Overlay'
import { createId, useWorkbench } from '../store/workbench'
import type { Client, Platform, Product, ProductLink, Store } from '../types/models'

type Tab = 'clients' | 'stores' | 'products' | 'links'
type Draft = Partial<Client & Store & Product & ProductLink> & { platform?: Platform }
const tabs: { id: Tab; label: string }[] = [{ id: 'clients', label: '甲方' }, { id: 'stores', label: '店铺' }, { id: 'products', label: '产品' }, { id: 'links', label: '商品链接' }]

export function MasterData() {
  const { data, update } = useWorkbench()
  const [tab, setTab] = useState<Tab>('clients')
  const [draft, setDraft] = useState<Draft | null>(null)
  const isEdit = Boolean(draft?.id)
  const openNew = () => setDraft(tab === 'stores' ? { clientId: data.clients[0]?.id, platform: '拼多多' } : tab === 'links' ? { clientId: data.clients[0]?.id, storeId: '', productId: '' } : {})

  const save = () => {
    if (!draft) return
    update(current => {
      if (tab === 'clients') { const item: Client = { id: draft.id || createId('client'), name: draft.name?.trim() || '', remark: draft.remark || '' }; return { ...current, clients: isEdit ? current.clients.map(x => x.id === item.id ? item : x) : [...current.clients, item] } }
      if (tab === 'stores') { const item: Store = { id: draft.id || createId('store'), clientId: draft.clientId || '', name: draft.name?.trim() || '', platform: draft.platform || '其他' }; return { ...current, stores: isEdit ? current.stores.map(x => x.id === item.id ? item : x) : [...current.stores, item] } }
      if (tab === 'products') { const item: Product = { id: draft.id || createId('product'), name: draft.name?.trim() || '', remark: draft.remark || '' }; return { ...current, products: isEdit ? current.products.map(x => x.id === item.id ? item : x) : [...current.products, item] } }
      const item: ProductLink = { id: draft.id || createId('link'), clientId: draft.clientId || '', storeId: draft.storeId || '', productId: draft.productId || '', linkId: draft.linkId?.trim() || '', url: draft.url || '', remark: draft.remark || '' }
      return { ...current, productLinks: isEdit ? current.productLinks.map(x => x.id === item.id ? item : x) : [...current.productLinks, item] }
    })
    setDraft(null)
  }

  const remove = (id: string, label: string) => {
    if (!window.confirm(`确定删除“${label}”吗？相关下级资料也会一并删除。`)) return
    update(current => {
      if (tab === 'clients') { const storeIds = new Set(current.stores.filter(x => x.clientId === id).map(x => x.id)); const linkIds = new Set(current.productLinks.filter(x => x.clientId === id || storeIds.has(x.storeId)).map(x => x.id)); const skuIds = new Set(current.skus.filter(x => linkIds.has(x.productLinkId)).map(x => x.id)); return { ...current, clients: current.clients.filter(x => x.id !== id), stores: current.stores.filter(x => !storeIds.has(x.id)), productLinks: current.productLinks.filter(x => !linkIds.has(x.id)), skus: current.skus.filter(x => !skuIds.has(x.id)), operations: current.operations.filter(x => !skuIds.has(x.skuId)) } }
      if (tab === 'stores') { const linkIds = new Set(current.productLinks.filter(x => x.storeId === id).map(x => x.id)); const skuIds = new Set(current.skus.filter(x => linkIds.has(x.productLinkId)).map(x => x.id)); return { ...current, stores: current.stores.filter(x => x.id !== id), productLinks: current.productLinks.filter(x => !linkIds.has(x.id)), skus: current.skus.filter(x => !skuIds.has(x.id)), operations: current.operations.filter(x => !skuIds.has(x.skuId)) } }
      if (tab === 'products') { const linkIds = new Set(current.productLinks.filter(x => x.productId === id).map(x => x.id)); const skuIds = new Set(current.skus.filter(x => linkIds.has(x.productLinkId)).map(x => x.id)); return { ...current, products: current.products.filter(x => x.id !== id), productLinks: current.productLinks.filter(x => !linkIds.has(x.id)), skus: current.skus.filter(x => !skuIds.has(x.id)), operations: current.operations.filter(x => !skuIds.has(x.skuId)) } }
      const skuIds = new Set(current.skus.filter(x => x.productLinkId === id).map(x => x.id)); return { ...current, productLinks: current.productLinks.filter(x => x.id !== id), skus: current.skus.filter(x => !skuIds.has(x.id)), operations: current.operations.filter(x => !skuIds.has(x.skuId)) }
    })
  }

  const title = tabs.find(x => x.id === tab)?.label ?? ''
  const valid = tab === 'clients' || tab === 'products' ? draft?.name?.trim() : tab === 'stores' ? draft?.clientId && draft.name?.trim() : draft?.clientId && draft?.storeId && draft?.productId && draft?.linkId?.trim()
  const storesForClient = data.stores.filter(x => !draft?.clientId || x.clientId === draft.clientId)

  return <div className="page">
    <div className="page-heading"><div><span className="eyebrow">数据字典</span><h1>基础资料</h1><p>维护甲方、店铺、产品和商品链接的基础关系。</p></div><button className="button primary" onClick={openNew}><Plus size={17} />新增{title}</button></div>
    <section className="panel master-panel"><div className="tabs" role="tablist">{tabs.map(x => <button role="tab" aria-selected={tab === x.id} className={tab === x.id ? 'active' : ''} key={x.id} onClick={() => setTab(x.id)}>{x.label}<span>{data[x.id === 'links' ? 'productLinks' : x.id].length}</span></button>)}</div>
      <div className="master-content">
        {tab === 'clients' && <SimpleTable headers={['名称','备注','操作']} rows={data.clients.map(x => [<strong>{x.name}</strong>, x.remark || '—', <Actions key="a" onEdit={() => setDraft(x)} onDelete={() => remove(x.id, x.name)} />])} />}
        {tab === 'stores' && <SimpleTable headers={['店铺名称','所属甲方','平台','操作']} rows={data.stores.map(x => [<strong>{x.name}</strong>, data.clients.find(c => c.id === x.clientId)?.name || '—', <span className="tag">{x.platform}</span>, <Actions key="a" onEdit={() => setDraft(x)} onDelete={() => remove(x.id, x.name)} />])} />}
        {tab === 'products' && <SimpleTable headers={['产品名称','备注','关联链接','操作']} rows={data.products.map(x => [<strong>{x.name}</strong>, x.remark || '—', `${data.productLinks.filter(l => l.productId === x.id).length} 条`, <Actions key="a" onEdit={() => setDraft(x)} onDelete={() => remove(x.id, x.name)} />])} />}
        {tab === 'links' && <SimpleTable headers={['链接 ID','甲方 / 店铺','产品','URL','备注','操作']} rows={data.productLinks.map(x => [<strong>{x.linkId}</strong>, <div><div className="cell-main">{data.clients.find(c => c.id === x.clientId)?.name}</div><div className="cell-sub">{data.stores.find(s => s.id === x.storeId)?.name}</div></div>, data.products.find(p => p.id === x.productId)?.name || '—', x.url ? <a className="external" href={x.url} target="_blank" rel="noreferrer">打开<ExternalLink size={13} /></a> : '—', x.remark || '—', <Actions key="a" onEdit={() => setDraft(x)} onDelete={() => remove(x.id, x.linkId)} />])} />}
      </div>
    </section>
    {draft && <Modal title={`${isEdit ? '编辑' : '新增'}${title}`} onClose={() => setDraft(null)}><div className="form-grid modal-body">
      {(tab === 'clients' || tab === 'products') && <><Field label={tab === 'clients' ? '名称' : '产品名称'} full><Input autoFocus value={draft.name || ''} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="备注" full><Textarea value={draft.remark || ''} onChange={e => setDraft({ ...draft, remark: e.target.value })} /></Field></>}
      {tab === 'stores' && <><Field label="所属甲方" full><Select value={draft.clientId || ''} onChange={e => setDraft({ ...draft, clientId: e.target.value })}>{data.clients.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field><Field label="店铺名称" full><Input autoFocus value={draft.name || ''} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="平台" full><Select value={draft.platform || '拼多多'} onChange={e => setDraft({ ...draft, platform: e.target.value as Platform })}>{['拼多多','淘宝','其他'].map(x => <option key={x}>{x}</option>)}</Select></Field></>}
      {tab === 'links' && <><Field label="所属甲方"><Select value={draft.clientId || ''} onChange={e => setDraft({ ...draft, clientId: e.target.value, storeId: '' })}><option value="">请选择</option>{data.clients.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field><Field label="所属店铺"><Select value={draft.storeId || ''} onChange={e => setDraft({ ...draft, storeId: e.target.value })}><option value="">请选择</option>{storesForClient.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field><Field label="产品"><Select value={draft.productId || ''} onChange={e => setDraft({ ...draft, productId: e.target.value })}><option value="">请选择</option>{data.products.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field><Field label="链接 ID"><Input value={draft.linkId || ''} onChange={e => setDraft({ ...draft, linkId: e.target.value })} /></Field><Field label="商品链接 URL" full><Input type="url" value={draft.url || ''} onChange={e => setDraft({ ...draft, url: e.target.value })} placeholder="https://" /></Field><Field label="备注" full><Textarea value={draft.remark || ''} onChange={e => setDraft({ ...draft, remark: e.target.value })} /></Field></>}
    </div><div className="modal-actions"><button className="button ghost" onClick={() => setDraft(null)}>取消</button><button className="button primary" disabled={!valid} onClick={save}>保存</button></div></Modal>}
  </div>
}

function Actions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) { return <div className="actions"><button className="icon-button" onClick={onEdit} aria-label="编辑"><Pencil size={15} /></button><button className="icon-button danger" onClick={onDelete} aria-label="删除"><Trash2 size={15} /></button></div> }
function SimpleTable({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) { return <div className="table-scroll"><table><thead><tr>{headers.map(x => <th key={x}>{x}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table>{!rows.length && <div className="empty"><strong>暂无资料</strong><span>点击右上角新增</span></div>}</div> }
