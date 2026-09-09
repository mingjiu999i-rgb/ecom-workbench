import { ArrowRight, Box, Building2, CalendarDays, Check, Circle, Link2, Plus, Store, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createId, useWorkbench } from '../store/workbench'
import { displayDate, getSkuContext } from '../utils/selectors'

export function Dashboard() {
  const { data, update } = useWorkbench()
  const navigate = useNavigate()
  const today = new Date().toLocaleDateString('sv-SE')
  const [todoDate, setTodoDate] = useState(today)
  const [todoTitle, setTodoTitle] = useState('')
  const [todoClientId, setTodoClientId] = useState('')
  const [todoStoreId, setTodoStoreId] = useState('')
  const metrics = [
    ['甲方', data.clients.length, Building2, 'blue'], ['店铺', data.stores.length, Store, 'violet'],
    ['商品链接', data.productLinks.length, Link2, 'cyan'], ['SKU', data.skus.length, Box, 'indigo'],
  ] as const
  const recent = [...data.operations].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5)
  const datedTodos = data.todos.filter(todo => todo.date === todoDate).sort((a, b) => Number(a.completed) - Number(b.completed) || a.createdAt.localeCompare(b.createdAt))
  const todoStores = data.stores.filter(store => !todoClientId || store.clientId === todoClientId)
  const addTodo = () => {
    const title = todoTitle.trim()
    if (!title) return
    update(current => ({ ...current, todos: [...current.todos, { id: createId('todo'), date: todoDate, title, clientId: todoClientId, storeId: todoStoreId, completed: false, createdAt: new Date().toISOString() }] }))
    setTodoTitle('')
  }

  return <div className="page">
    <div className="page-heading"><div><span className="eyebrow">今日经营视图</span><h1>总览</h1><p>快速查看业务规模与需要关注的 SKU。</p></div><div className="today">{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date())}</div></div>
    <section className="metrics">{metrics.map(([label, value, Icon, tone]) => <article key={label} className="metric"><div className={`metric-icon ${tone}`}><Icon size={18} /></div><div><span>{label}</span><strong>{value}</strong></div></article>)}</section>
    <section className="panel todo-panel"><div className="panel-heading todo-heading"><div><h2>重要待办</h2><p>记录今天或指定日期需要处理的甲方、店铺事项</p></div><label className="todo-date"><CalendarDays size={15} /><input type="date" value={todoDate} onChange={e => setTodoDate(e.target.value)} /></label></div>
      <div className="todo-quick-add"><input className="todo-title-input" value={todoTitle} onChange={e => setTodoTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addTodo() }} placeholder="输入需要处理的重要事项，按回车快速添加" /><select value={todoClientId} onChange={e => { setTodoClientId(e.target.value); setTodoStoreId('') }}><option value="">关联甲方（可选）</option>{data.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select><select value={todoStoreId} onChange={e => setTodoStoreId(e.target.value)} disabled={!todoClientId}><option value="">关联店铺（可选）</option>{todoStores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}</select><button className="button primary" disabled={!todoTitle.trim()} onClick={addTodo}><Plus size={16} />添加</button></div>
      {datedTodos.length ? <div className="todo-list">{datedTodos.map(todo => { const client = data.clients.find(item => item.id === todo.clientId); const store = data.stores.find(item => item.id === todo.storeId); return <div key={todo.id} className={`todo-row ${todo.completed ? 'completed' : ''}`}><button className="todo-check" aria-label={todo.completed ? '标记为未完成' : '标记为已完成'} onClick={() => update(current => ({ ...current, todos: current.todos.map(item => item.id === todo.id ? { ...item, completed: !item.completed } : item) }))}>{todo.completed ? <Check size={15} /> : <Circle size={16} />}</button><div className="todo-content"><strong>{todo.title}</strong>{(client || store) && <span>{client?.name}{client && store ? ' · ' : ''}{store?.name}</span>}</div><button className="icon-button danger" aria-label="删除待办" onClick={() => update(current => ({ ...current, todos: current.todos.filter(item => item.id !== todo.id) }))}><Trash2 size={14} /></button></div> })}</div> : <div className="todo-empty">{todoDate === today ? '今天还没有待办，先添加一项重要事项吧' : '该日期暂无待办'}</div>}
    </section>
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
