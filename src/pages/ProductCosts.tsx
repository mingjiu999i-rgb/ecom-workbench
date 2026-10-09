import { Calculator, Download, FileSpreadsheet, Pencil, Plus, Search, Trash2, Upload } from 'lucide-react'
import { useMemo, useState, type ChangeEvent } from 'react'
import { Field, Input, Select } from '../components/Fields'
import { Modal } from '../components/Overlay'
import { createId, useWorkbench } from '../store/workbench'
import type { ProductCost } from '../types/models'
import { calculatedBreakEvenRoi, money } from '../utils/calculations'
import { parseCostImportFile, type CostImportRow } from '../utils/costImport'

const emptyCost = (productId = ''): ProductCost => ({ id: '', productId, skuCode: '', specification: '', totalCost: 0 })
const normalizeKey = (value: string) => value.trim().toLocaleLowerCase('zh-CN')

type PreviewRow = CostImportRow & {
  action: '新增' | '更新'
  detail: string
  error: string
}

export function ProductCosts() {
  const { data, update } = useWorkbench()
  const [clientId, setClientId] = useState('')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<ProductCost | null>(null)
  const [batchOpen, setBatchOpen] = useState(false)
  const [importRows, setImportRows] = useState<CostImportRow[]>([])
  const [importFileName, setImportFileName] = useState('')
  const [importError, setImportError] = useState('')
  const [importing, setImporting] = useState(false)
  const rows = useMemo(() => data.productCosts.filter(item => {
    const product = data.products.find(row => row.id === item.productId)
    const client = data.clients.find(row => row.id === product?.clientId)
    const matchesQuery = `${product?.name || ''} ${client?.name || ''} ${item.skuCode} ${item.specification}`.toLowerCase().includes(query.trim().toLowerCase())
    return (!clientId || product?.clientId === clientId) && matchesQuery
  }), [data.productCosts, data.products, data.clients, clientId, query])
  const previewRows = useMemo<PreviewRow[]>(() => {
    const keys = importRows.map(row => `${normalizeKey(row.clientName)}|${normalizeKey(row.productName)}|${normalizeKey(row.skuCode)}`)
    const duplicates = new Set(keys.filter((key, index) => keys.indexOf(key) !== index))
    return importRows.map((row, index) => {
      const errors: string[] = []
      if (!row.clientName) errors.push('甲方为空')
      if (!row.productName) errors.push('商品名称为空')
      if (!row.skuCode) errors.push('编码为空')
      if (!row.specification) errors.push('售卖规格为空')
      if (!Number.isFinite(row.totalCost) || row.totalCost < 0) errors.push('总成本必须是大于或等于 0 的数字')
      if (duplicates.has(keys[index])) errors.push('文件内的甲方、商品和编码重复')

      const client = data.clients.find(item => normalizeKey(item.name) === normalizeKey(row.clientName))
      const product = client && data.products.find(item => item.clientId === client.id && normalizeKey(item.name) === normalizeKey(row.productName))
      const existing = product && data.productCosts.find(item => item.productId === product.id && normalizeKey(item.skuCode) === normalizeKey(row.skuCode))
      const detail = !client ? '将新建甲方和商品' : !product ? '将在该甲方下新建商品' : existing ? '匹配编码，将更新规格和成本' : '将新增成本记录'
      return { ...row, action: existing ? '更新' : '新增', detail, error: errors.join('；') }
    })
  }, [data.clients, data.products, data.productCosts, importRows])
  const invalidImportCount = previewRows.filter(row => row.error).length
  const createCount = previewRows.filter(row => !row.error && row.action === '新增').length
  const updateCount = previewRows.filter(row => !row.error && row.action === '更新').length

  const save = (item: ProductCost) => {
    update(current => ({
      ...current,
      productCosts: item.id
        ? current.productCosts.map(row => row.id === item.id ? item : row)
        : [...current.productCosts, { ...item, id: createId('cost') }],
      skus: item.id ? current.skus.map(sku => sku.productCostId === item.id ? {
        ...sku,
        skuId: item.skuCode,
        specification: item.specification,
        productCost: item.totalCost,
        shippingCost: 0,
        packagingCost: 0,
        otherCost: 0,
        breakEvenRoi: calculatedBreakEvenRoi(sku.salePrice, item.totalCost),
      } : sku) : current.skus,
    }))
    setEditing(null)
  }

  const remove = (item: ProductCost) => {
    if (data.skus.some(sku => sku.productCostId === item.id)) {
      window.alert('该成本 SKU 已被商品 SKU 使用，请先删除或更换关联后再删除。')
      return
    }
    if (!window.confirm(`确定删除 SKU“${item.skuCode}”的成本资料吗？`)) return
    update(current => ({ ...current, productCosts: current.productCosts.filter(row => row.id !== item.id) }))
  }

  const closeBatch = () => {
    setBatchOpen(false)
    setImportRows([])
    setImportFileName('')
    setImportError('')
    setImporting(false)
  }

  const chooseImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setImporting(true)
    setImportError('')
    setImportRows([])
    setImportFileName(file.name)
    try {
      const parsed = await parseCostImportFile(file)
      setImportRows(parsed)
    } catch (error) {
      setImportError(error instanceof Error ? error.message : '文件解析失败。')
    } finally {
      setImporting(false)
    }
  }

  const downloadTemplate = () => {
    const csv = '\uFEFF甲方,商品名称,编码,售卖规格,总成本\n示例甲方,蛋黄果,JDG1X,1斤小果（60–100g）,8.05\n'
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = '产品成本导入模板.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  const saveBatch = () => {
    if (!previewRows.length || invalidImportCount) return
    setImporting(true)
    update(current => {
      const clients = [...current.clients]
      const products = [...current.products]
      const productCosts = [...current.productCosts]
      const changedCosts = new Map<string, ProductCost>()

      previewRows.forEach(row => {
        let client = clients.find(item => normalizeKey(item.name) === normalizeKey(row.clientName))
        if (!client) {
          client = { id: createId('client'), name: row.clientName.trim(), remark: '' }
          clients.push(client)
        }
        let product = products.find(item => item.clientId === client.id && normalizeKey(item.name) === normalizeKey(row.productName))
        if (!product) {
          product = { id: createId('product'), clientId: client.id, name: row.productName.trim(), operationRate: 0.02, remark: '' }
          products.push(product)
        }
        const costIndex = productCosts.findIndex(item => item.productId === product.id && normalizeKey(item.skuCode) === normalizeKey(row.skuCode))
        const cost: ProductCost = {
          id: costIndex >= 0 ? productCosts[costIndex].id : createId('cost'),
          productId: product.id,
          skuCode: row.skuCode.trim(),
          specification: row.specification.trim(),
          totalCost: row.totalCost,
        }
        if (costIndex >= 0) productCosts[costIndex] = cost
        else productCosts.push(cost)
        changedCosts.set(cost.id, cost)
      })

      const skus = current.skus.map(sku => {
        const cost = changedCosts.get(sku.productCostId)
        return cost ? {
          ...sku,
          skuId: cost.skuCode,
          specification: cost.specification,
          productCost: cost.totalCost,
          shippingCost: 0,
          packagingCost: 0,
          otherCost: 0,
          breakEvenRoi: calculatedBreakEvenRoi(sku.salePrice, cost.totalCost),
        } : sku
      })
      return { ...current, clients, products, productCosts, skus }
    })
    closeBatch()
  }

  return <div className="page">
    <div className="page-heading"><div><span className="eyebrow">成本资料库</span><h1>产品成本</h1><p>成本归属产品，并自动继承产品所属甲方。</p></div><div className="heading-actions"><button className="button secondary" onClick={() => setBatchOpen(true)}><Upload size={17} />批量上传成本</button><button className="button primary" onClick={() => setEditing(emptyCost(data.products[0]?.id))}><Plus size={17} />新增成本</button></div></div>
    <section className="filter-bar cost-filter">
      <div className="filter-title"><Calculator size={17} /><span>SKU 成本</span></div>
      <Select aria-label="甲方筛选" value={clientId} onChange={event => setClientId(event.target.value)}><option value="">全部甲方</option>{data.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</Select>
      <div className="search"><Search size={16} /><Input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索商品、甲方、SKU 或规格" /></div>
      {(clientId || query) && <button className="text-button" onClick={() => { setClientId(''); setQuery('') }}>清空</button>}
    </section>
    <section className="panel table-panel">
      <div className="table-caption"><div><strong>成本列表</strong><span>共 {rows.length} 条</span></div></div>
      <div className="table-scroll"><table><thead><tr><th>商品名称</th><th>所属甲方</th><th>SKU 编码</th><th>售卖规格</th><th>总成本</th><th>操作</th></tr></thead><tbody>
        {rows.map(item => { const product = data.products.find(row => row.id === item.productId); return <tr key={item.id}><td><strong className="cell-main">{product?.name || '未关联'}</strong></td><td>{data.clients.find(row => row.id === product?.clientId)?.name || '未关联'}</td><td><strong className="cell-main">{item.skuCode}</strong></td><td>{item.specification}</td><td className="emphasis">{money(item.totalCost)}</td><td><div className="actions"><button className="icon-button" onClick={() => setEditing(item)} aria-label={`编辑 ${item.skuCode}`}><Pencil size={15} /></button><button className="icon-button danger" onClick={() => remove(item)} aria-label={`删除 ${item.skuCode}`}><Trash2 size={15} /></button></div></td></tr> })}
      </tbody></table></div>
      {!rows.length && <div className="empty"><strong>暂无产品成本</strong><span>点击右上角新增 SKU 成本资料</span></div>}
    </section>
    {editing && <CostModal initial={editing} onClose={() => setEditing(null)} onSave={save} />}
    {batchOpen && <Modal title="批量上传产品成本" wide onClose={closeBatch}>
      <div className="batch-import modal-body cost-import">
        <div className="cost-import-intro"><div><strong>上传 Excel 或 CSV 文件</strong><span>首行必须包含：甲方、商品名称、编码、售卖规格、总成本</span></div><button className="text-button import-template" onClick={downloadTemplate}><Download size={14} />下载模板</button></div>
        <label className="cost-import-picker">
          <FileSpreadsheet size={28} />
          <strong>{importing ? '正在解析…' : importFileName || '点击选择文件'}</strong>
          <span>支持 .xlsx、.csv、.tsv，最大 5MB，单次最多 1000 条</span>
          <input type="file" accept=".xlsx,.csv,.tsv,.txt" onChange={chooseImportFile} disabled={importing} />
        </label>
        {importError && <div className="form-error import-message">{importError}</div>}
        {previewRows.length > 0 && <>
          <div className="import-summary"><span>已读取 <strong>{previewRows.length}</strong> 条</span><span className="import-new">新增 {createCount}</span><span className="import-update">更新 {updateCount}</span>{invalidImportCount > 0 && <span className="import-invalid">错误 {invalidImportCount}</span>}</div>
          <div className="table-scroll batch-preview cost-import-preview"><table><thead><tr><th>行</th><th>甲方</th><th>商品名称</th><th>编码</th><th>售卖规格</th><th>总成本</th><th>处理方式</th></tr></thead><tbody>{previewRows.map((row, index) => <tr key={`${row.sourceRow}-${index}`} className={row.error ? 'import-row-error' : ''}><td>{row.sourceRow}</td><td>{row.clientName || '—'}</td><td>{row.productName || '—'}</td><td><strong className="cell-main">{row.skuCode || '—'}</strong></td><td>{row.specification || '—'}</td><td>{Number.isFinite(row.totalCost) ? money(row.totalCost) : '—'}</td><td>{row.error ? <span className="import-error-text">{row.error}</span> : <><span className={`tag import-${row.action === '更新' ? 'update' : 'new'}`}>{row.action}</span><div className="cell-sub">{row.detail}</div></>}</td></tr>)}</tbody></table></div>
          {invalidImportCount > 0 && <div className="form-error import-message">请修正文件中的 {invalidImportCount} 条错误后重新上传。</div>}
        </>}
      </div>
      <div className="modal-actions"><button className="button ghost" onClick={closeBatch}>取消</button><button className="button primary" disabled={!previewRows.length || invalidImportCount > 0 || importing} onClick={saveBatch}>导入 {previewRows.length || ''} 条成本</button></div>
    </Modal>}
  </div>
}

function CostModal({ initial, onClose, onSave }: { initial: ProductCost; onClose: () => void; onSave: (item: ProductCost) => void }) {
  const { data } = useWorkbench()
  const [item, setItem] = useState(initial)
  const initialProduct = data.products.find(product => product.id === initial.productId)
  const [selectedClientId, setSelectedClientId] = useState(initialProduct?.clientId || data.clients[0]?.id || '')
  const productsForClient = data.products.filter(product => product.clientId === selectedClientId)
  const valid = item.productId && item.skuCode.trim() && item.specification.trim() && Number.isFinite(item.totalCost) && item.totalCost >= 0
  return <Modal title={`${item.id ? '编辑' : '新增'}产品成本`} onClose={onClose}>
    <div className="form-grid modal-body">
      <Field label="所属甲方" full><Select value={selectedClientId} onChange={event => { const nextClientId = event.target.value; const firstProduct = data.products.find(product => product.clientId === nextClientId); setSelectedClientId(nextClientId); setItem(current => ({ ...current, productId: firstProduct?.id || '' })) }}><option value="">请选择甲方</option>{data.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</Select></Field>
      <Field label="商品名称" full><Select value={item.productId} onChange={event => setItem(current => ({ ...current, productId: event.target.value }))}><option value="">{selectedClientId && !productsForClient.length ? '请先在基础资料中为该甲方新增产品' : '请选择商品'}</option>{productsForClient.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</Select></Field>
      <Field label="SKU 编码" full><Input autoFocus value={item.skuCode} onChange={event => setItem(current => ({ ...current, skuCode: event.target.value }))} placeholder="例如：SKU-A01" /></Field>
      <Field label="售卖规格" full><Input value={item.specification} onChange={event => setItem(current => ({ ...current, specification: event.target.value }))} placeholder="例如：2 件装 / 红色 XL" /></Field>
      <Field label="总成本" full><Input type="number" min="0" step="0.01" value={item.totalCost} onChange={event => setItem(current => ({ ...current, totalCost: event.target.value === '' ? 0 : Number(event.target.value) }))} /></Field>
    </div>
    <div className="modal-actions"><button className="button ghost" onClick={onClose}>取消</button><button className="button primary" disabled={!valid} onClick={() => onSave({ ...item, skuCode: item.skuCode.trim(), specification: item.specification.trim() })}>保存</button></div>
  </Modal>
}
