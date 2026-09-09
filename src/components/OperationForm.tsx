import { useMemo, useState } from 'react'
import { Field, Input, Select, Textarea } from './Fields'
import { createId, useWorkbench } from '../store/workbench'
import type { AdjustmentReason, AdjustmentType, Operation, Sku } from '../types/models'
import { appendSkuHistory } from '../utils/skuHistory'
import { calculatedBreakEvenRoi, totalCost } from '../utils/calculations'

const types: AdjustmentType[] = ['售价', '到手价', '成本', '投产', '活动', 'SKU', '其他']
const reasons: AdjustmentReason[] = ['平台比价', '竞品变化', '报活动', '活动结束', '成本变化', '推广调整', '测试', '其他']
const activities = ['无活动', '平台活动', '店铺活动', '百亿补贴', '其他'] as const

const currentValue = (sku: Sku | undefined, type: AdjustmentType) => {
  if (!sku) return ''
  const map: Record<AdjustmentType, string> = { 售价: String(sku.salePrice), 到手价: String(sku.finalPrice), 成本: String(sku.productCost), 投产: String(sku.currentRoi), 活动: sku.activity, SKU: sku.name, 其他: '' }
  return map[type]
}

export function OperationForm({ initialSkuId = '', onDone }: { initialSkuId?: string; onDone: () => void }) {
  const { data, update } = useWorkbench()
  const first = data.skus.find(s => s.id === initialSkuId)
  const firstLink = data.productLinks.find(l => l.id === first?.productLinkId)
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
  const stores = data.stores.filter(s => !clientId || s.clientId === clientId)
  const products = data.products.filter(product => !clientId || product.clientId === clientId)
  const links = data.productLinks.filter(l => (!clientId || l.clientId === clientId) && (!storeId || l.storeId === storeId) && (!productId || l.productId === productId))
  const skus = data.skus.filter(s => !linkId || s.productLinkId === linkId)
  const valid = clientId && storeId && productId && linkId && skuId && after.trim()

  const setTypeAndBefore = (next: AdjustmentType) => { setType(next); setBefore(currentValue(selectedSku, next)); setAfter('') }
  const chooseSku = (id: string) => { setSkuId(id); setBefore(currentValue(data.skus.find(s => s.id === id), type)) }

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
    <Field label="甲方"><Select value={clientId} onChange={e => { setClientId(e.target.value); setStoreId(''); setProductId(''); setLinkId(''); setSkuId('') }}><option value="">请选择</option>{data.clients.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
    <Field label="店铺"><Select value={storeId} onChange={e => { setStoreId(e.target.value); setLinkId(''); setSkuId('') }}><option value="">请选择</option>{stores.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
    <Field label="产品"><Select value={productId} onChange={e => { setProductId(e.target.value); setLinkId(''); setSkuId('') }}><option value="">请选择</option>{products.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
    <Field label="商品链接"><Select value={linkId} onChange={e => { setLinkId(e.target.value); setSkuId('') }}><option value="">请选择</option>{links.map(x => <option key={x.id} value={x.id}>{x.linkId}</option>)}</Select></Field>
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
  if (type === 'SKU') return { ...sku, name: value }
  return sku
}
