import { ArrowRight, Box, Building2, Link2, Store, TriangleAlert } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useWorkbench } from '../store/workbench'
import { displayDate, getSkuContext } from '../utils/selectors'

export function Dashboard() {
  const { data } = useWorkbench()
  const navigate = useNavigate()
  const risks = data.skus.filter(s => s.currentRoi < s.breakEvenRoi).length
  const metrics = [
    ['甲方', data.clients.length, Building2, 'blue'], ['店铺', data.stores.length, Store, 'violet'],
    ['商品链接', data.productLinks.length, Link2, 'cyan'], ['SKU', data.skus.length, Box, 'indigo'],
    ['投产风险', risks, TriangleAlert, risks ? 'red' : 'green'],
  ] as const
  const recent = [...data.operations].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5)

  return <div className="page">
    <div className="page-heading"><div><span className="eyebrow">今日经营视图</span><h1>总览</h1><p>快速查看业务规模与需要关注的 SKU。</p></div><div className="today">{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date())}</div></div>
    <section className="metrics">{metrics.map(([label, value, Icon, tone]) => <article key={label} className="metric"><div className={`metric-icon ${tone}`}><Icon size={18} /></div><div><span>{label}</span><strong>{value}</strong></div></article>)}</section>
    <div className="dashboard-grid">
      <section className="panel"><div className="panel-heading"><div><h2>甲方概览</h2><p>点击甲方查看对应商品</p></div></div>
        <div className="client-list">{data.clients.map(client => {
          const stores = data.stores.filter(s => s.clientId === client.id)
          const links = data.productLinks.filter(l => l.clientId === client.id)
          const linkIds = new Set(links.map(l => l.id))
          return <button key={client.id} onClick={() => navigate(`/products?client=${client.id}`)} className="client-row"><div className="client-avatar">{client.name.slice(-1)}</div><div className="client-name"><strong>{client.name}</strong><span>{stores.length} 家店铺</span></div><div className="client-stat"><b>{links.length}</b><span>商品</span></div><div className="client-stat"><b>{data.skus.filter(s => linkIds.has(s.productLinkId)).length}</b><span>SKU</span></div><ArrowRight size={17} /></button>
        })}</div>
      </section>
      <section className="panel"><div className="panel-heading"><div><h2>最近调整</h2><p>最新的经营操作</p></div><button className="text-button" onClick={() => navigate('/operations')}>查看全部</button></div>
        {recent.length ? <div className="recent-list">{recent.map(op => { const ctx = getSkuContext(data, op.skuId); return <div className="recent-row" key={op.id}><div className={`adjust-icon ${op.type === '投产' ? 'accent' : ''}`}>{op.type.slice(0, 1)}</div><div><strong>{ctx.sku?.name ?? '已删除 SKU'} · {op.type}</strong><span>{op.before} → {op.after} · {op.reason}</span></div><time>{displayDate(op.createdAt)}</time></div> })}</div> : <div className="empty"><ClipboardEmpty /><strong>还没有调整记录</strong><span>在 SKU 详情中新增第一条调整</span></div>}
      </section>
    </div>
  </div>
}

function ClipboardEmpty() { return <div className="empty-symbol">↗</div> }
