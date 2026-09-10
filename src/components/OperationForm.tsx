import { useMemo, useState } from 'react'
import { Field, Input, Select, Textarea } from './Fields'
import { createId, useWorkbench } from '../store/workbench'
import type { AdjustmentReason, AdjustmentType, Operation, Sku } from '../types/models'
import { appendSkuHistory } from '../utils/skuHistory'
import { calculatedBreakEvenRoi, totalCost } from '../utils/calculations'

const types: AdjustmentType[] = ['售价', '到手价', '成本', '投产', '活动', '活动价', 'SKU', '其他']
const reasons: AdjustmentReason[] = ['平台比价', '竞品变化', '报活动', '活动结束', '成本变化', '推广调整', '测试', '手动修改', '其他']
const activities = ['无活动', '平台活动', '店铺活动', '百亿补贴', '其他'] as const

const currentValue = (sku: Sku | undefined, type: AdjustmentType) => {
  if (!sku) return ''
  const map: Record<AdjustmentType, string> = { 售价: String(sku.salePrice), 到手价: String(sku.finalPrice), 成本: String(sku.productCost), 投产: String(sku.currentRoi), 活动: sku.activity, 活动价: String(sku.activityPrice || 0), SKU: sku.name, 其他: '' }
  return map[type]
}

export function OperationForm({ initialSkuId = '', onDone }: { initialSkuId?: string; onDone: () => void }) {
  const { data, update } = useWorkbench()
  const first = data.skus.find(s => s.id === initialSkuId)
  const firstLink = data.productLinks.find(l => l.id === first?.productLinkId)
  const [productIdInput, setProductIdInput] = useState(firstLink?.linkId ?? '')
  const [clientId, setClientId] = useState(firstLink?.clientId ?? '')
  const [storeId, setStoreId] = useState(firstLink?.storeId ?? '')
  const [productId, setProductId] = useState(firstLink?.productId ?? '')
  const [linkId, setLinkId] = useState(firstLink?.id ?? '')
  const [skuId, setSkuId] = useState(initialSkuId)
  const [type, setType] = useState<AdjustmentType>('投产')
  const selectedSku = data.skus.find(s => s.id === skuId)
  const [before, setBefore] = useState(currentValue(first, '投产'))
  const [after, setAfter] = useState('')
  const [reason, setReason] = useState<AdjustmentReason>('平台比价')
  const [remark, setRemark] = useState('')
  const [createdAt, setCreatedAt] = useState(new Date().toISOString().slice(0, 16))
  const skus = data.skus.filter(s => !linkId || s.productLinkId === linkId)
  const selectedClient = data.clients.find(x => x.id === clientId)
  const selectedStore = data.stores.find(x => x.id === storeId)
  const selectedProduct = data.products.find(x => x.id === productId)
  const matchingLinks = useMemo(() => {
    const query = productIdInput.trim().toLowerCase()
    if (!query || data.productLinks.some(link => link.linkId.toLowerCase() === query)) return []
    return data.productLinks.filter(link => link.linkId.toLowerCase().includes(query)).slice(0, 8)
  }, [data.productLinks, productIdInput])
  const valid = clientId && storeId && productId && linkId && skuId && after.trim()

  const setTypeAndBefore = (next: AdjustmentType) => { setType(next); setBefore(currentValue(selectedSku, next)); setAfter('') }
  const chooseSku = (id: string) => { setSkuId(id); setBefore(currentValue(data.skus.find(s => s.id === id), type)) }
  const chooseLink = (id: string, displayedId?: string) => {
    const link = data.productLinks.find(item => item.id === id)
    const product = data.products.find(item => item.id === link?.productId)
    if (!link || !product) return
    const linkedSkus = data.skus.filter(item => item.productLinkId === link.id)
    setProductIdInput(displayedId ?? link.linkId)
    setClientId(product.clientId)
    setStoreId(link.storeId)
    setProductId(product.id)
    setLinkId(link.id)
    const nextSku = linkedSkus.length === 1 ? linkedSkus[0] : undefined
    setSkuId(nextSku?.id || '')
    setBefore(currentValue(nextSku, type))
  }
  const enterProductId = (value: string) => {
    setProductIdInput(value)
    const exact = data.productLinks.find(link => link.linkId.toLowerCase() === value.trim().toLowerCase())
    if (exact) chooseLink(exact.id, value)
    else { setClientId(''); setStoreId(''); setProductId(''); setLinkId(''); setSkuId(''); setBefore('') }
  }

  const save = () => {
    if (!valid) return
    const operation: Operation = { id: createId('op'), createdAt: new Date(createdAt).toISOString(), clientId, storeId, productId, productLinkId: linkId, skuId, type, before, after, reason, remark }
    update(current => {
      const beforeSku = current.skus.find(sku => sku.id === skuId)
      const afterSku = beforeSku ? syncSku(beforeSku, type, after) : undefined
      return { ...current,
        operations: [operation, ...current.operations],
        skus: current.skus.map(sku => sku.id !== skuId ? sku : afterSku || sku),
        skuHistory: afterSku ? appendSkuHistory(current.skuHistory, beforeSku, afterSku) : current.skuHistory,
      }
    })
    onDone()
  }

  return <><div className="form-grid operation-form">
    <Field label="商品 ID（输入后直接筛选）" full><div className="operation-id-search"><Input autoFocus value={productIdInput} onChange={e => enterProductId(e.target.value)} placeholder="输入完整或部分商品 ID" />{matchingLinks.length > 0 && <div className="operation-id-results">{matchingLinks.map(link => { const product = data.products.find(item => item.id === link.productId); const client = data.clients.find(item => item.id === product?.clientId); return <button type="button" key={link.id} onClick={() => chooseLink(link.id)}><strong>{link.linkId}</strong><span>{client?.name || '—'} · {product?.name || '—'}</span></button> })}</div>}</div></Field>
    <Field label="甲方（自动关联）"><Input value={selectedClient?.name || ''} readOnly placeholder="请先输入商品 ID" /></Field>
    <Field label="店铺（自动关联）"><Input value={selectedStore?.name || ''} readOnly placeholder="自动带出" /></Field>
    <Field label="产品（自动关联）"><Input value={selectedProduct?.name || ''} readOnly placeholder="自动带出" /></Field>
    <Field label="商品链接（自动关联）"><Input value={firstLink && firstLink.id === linkId ? firstLink.linkId : data.productLinks.find(x => x.id === linkId)?.linkId || ''} readOnly placeholder="自动带出" /></Field>
    <Field label="SKU"><Select value={skuId} onChange={e => chooseSku(e.target.value)}><option value="">请选择</option>{skus.map(x => <option key={x.id} value={x.id}>{x.name} · {x.skuId}</option>)}</Select></Field>
    <Field label="调整类型"><Select value={type} onChange={e => setTypeAndBefore(e.target.value as AdjustmentType)}>{types.map(x => <option key={x}>{x}</option>)}</Select></Field>
    <Field label="调整前"><Input value={before} onChange={e => setBefore(e.target.value)} placeholder="原值" /></Field>
    <Field label="调整后">{type === '活动' ? <Select value={after} onChange={e => setAfter(e.target.value)}><option value="">请选择</option>{activities.map(x => <option key={x}>{x}</option>)}</Select> : <Input value={after} onChange={e => setAfter(e.target.value)} placeholder="新值" />}</Field>
    <Field label="调整原因"><Select value={reason} onChange={e => setReason(e.target.value as AdjustmentReason)}>{reasons.map(x => <option key={x}>{x}</option>)}</Select></Field>
    <Field label="时间"><Input type="datetime-local" value={createdAt} onChange={e => setCreatedAt(e.target.value)} /></Field>
    <Field label="备注" full><Textarea value={remark} onChange={e => setRemark(e.target.value)} placeholder="可选" /></Field>
  </div><div className="modal-actions"><button className="button ghost" onClick={onDone}>取消</button><button className="button primary" disabled={!valid} onClick={save}>保存调整</button></div></>
}

function syncSku(sku: Sku, type: AdjustmentType, value: string): Sku {
  const numeric = Number(value)
  if (type === '售价' && Number.isFinite(numeric)) return { ...sku, salePrice: numeric, breakEvenRoi: calculatedBreakEvenRoi(numeric, totalCost(sku)) }
  if (type === '到手价') return { ...sku, finalPrice: Number.isFinite(numeric) ? numeric : sku.finalPrice }
  if (type === '成本') return { ...sku, productCost: Number.isFinite(numeric) ? numeric : sku.productCost }
  if (type === '投产') return { ...sku, currentRoi: Number.isFinite(numeric) ? numeric : sku.currentRoi }
  if (type === '活动') return { ...sku, activity: value as Sku['activity'] }
  if (type === '活动价') return { ...sku, activityPrice: Number.isFinite(numeric) ? numeric : sku.activityPrice }
  if (type === 'SKU') return { ...sku, name: value }
  return sku
}
