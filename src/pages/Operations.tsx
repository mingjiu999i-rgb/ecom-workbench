import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Modal } from '../components/Overlay'
import { OperationForm } from '../components/OperationForm'
import { useWorkbench } from '../store/workbench'
import { displayDate, getSkuContext } from '../utils/selectors'

export function Operations() {
  const { data } = useWorkbench()
  const [open, setOpen] = useState(false)
  const operations = data.operations.filter(operation => operation.type !== '到手价').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return <div className="page page-wide">
    <div className="page-heading"><div><span className="eyebrow">变更追踪</span><h1>调整记录</h1><p>保留每次 SKU 经营参数的调整原因和前后值。</p></div><button className="button primary" onClick={() => setOpen(true)}><Plus size={17} />新增调整</button></div>
    <section className="panel table-panel"><div className="table-caption"><div><strong>全部记录</strong><span>共 {operations.length} 条</span></div></div>
      <div className="table-scroll"><table><thead><tr><th>日期时间</th><th>甲方 / 店铺</th><th>产品 / 链接</th><th>SKU</th><th>调整类型</th><th>调整内容</th><th>原因</th><th>备注</th></tr></thead><tbody>
        {operations.map(op => { const ctx = getSkuContext(data, op.skuId); return <tr key={op.id}><td><time>{displayDate(op.createdAt)}</time></td><td><div className="cell-main">{ctx.client?.name ?? '—'}</div><div className="cell-sub">{ctx.store?.name ?? '—'}</div></td><td><div className="cell-main">{ctx.product?.name ?? '—'}</div><div className="cell-sub">{ctx.link?.linkId ?? '—'}</div></td><td><div className="cell-main">{ctx.sku?.name ?? '已删除'}</div><div className="cell-sub">{ctx.sku?.skuId ?? '—'}</div></td><td><span className="tag tag-blue">{op.type}</span></td><td><span className="change-before">{op.before || '—'}</span><span className="change-arrow">→</span><strong className="change-after">{op.after}</strong></td><td>{op.reason}</td><td className="remark-cell">{op.remark || '—'}</td></tr> })}
      </tbody></table></div>
      {!operations.length && <div className="empty"><div className="empty-symbol">↗</div><strong>还没有调整记录</strong><span>点击右上角新增第一条调整</span><button className="button secondary" onClick={() => setOpen(true)}>新增调整</button></div>}
    </section>
    {open && <Modal title="新增调整" onClose={() => setOpen(false)} wide><OperationForm onDone={() => setOpen(false)} /></Modal>}
  </div>
}
