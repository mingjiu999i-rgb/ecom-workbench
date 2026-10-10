import { ArrowRight, BadgePercent, Box, Building2, CalendarDays, Check, Circle, CircleDollarSign, Link2, Plus, Store, Trash2, TrendingUp } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createId, useWorkbench } from '../store/workbench'
import { money } from '../utils/calculations'
import { displayDate, getSkuContext, isActiveProductLink } from '../utils/selectors'

type PerformanceRange = 'yesterday' | 'month' | 'custom'

const localDate = (date: Date) => date.toLocaleDateString('sv-SE')
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100

export function Dashboard() {
  const { data, update } = useWorkbench()
  const navigate = useNavigate()
  const today = localDate(new Date())
  const yesterday = (() => { const date = new Date(); date.setDate(date.getDate() - 1); return localDate(date) })()
  const monthStart = `${today.slice(0, 7)}-01`
  const [todoDate, setTodoDate] = useState(today)
  const [todoTitle, setTodoTitle] = useState('')
  const [todoClientId, setTodoClientId] = useState('')
  const [todoStoreId, setTodoStoreId] = useState('')
  const [performanceRange, setPerformanceRange] = useState<PerformanceRange>('month')
  const [performanceStart, setPerformanceStart] = useState(monthStart)
  const [performanceEnd, setPerformanceEnd] = useState(today)
  const activeStores = data.stores.filter(store => store.storeStatus !== '暂停')
  const activeLinks = data.productLinks.filter(link => isActiveProductLink(data, link.id))
  const activeLinkIds = new Set(activeLinks.map(link => link.id))
  const metrics = [
    ['甲方', data.clients.length, Building2, 'blue'], ['店铺', activeStores.length, Store, 'violet'],
    ['商品链接', activeLinks.length, Link2, 'cyan'], ['SKU', data.skus.filter(sku => activeLinkIds.has(sku.productLinkId)).length, Box, 'indigo'],
  ] as const
  const recent = data.operations.filter(operation => operation.type !== '到手价' && isActiveProductLink(data, operation.productLinkId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5)
  const datedTodos = data.todos.filter(todo => todo.date === todoDate).sort((a, b) => Number(a.completed) - Number(b.completed) || a.createdAt.localeCompare(b.createdAt))
  const todoStores = activeStores.filter(store => !todoClientId || store.clientId === todoClientId)
  const selectedRange = performanceRange === 'yesterday'
    ? { start: yesterday, end: yesterday }
    : performanceRange === 'month'
      ? { start: monthStart, end: today }
      : { start: performanceStart, end: performanceEnd }
  const performance = useMemo(() => {
    const records = selectedRange.start && selectedRange.end && selectedRange.start <= selectedRange.end
      ? data.profitRecords.filter(record => record.date >= selectedRange.start && record.date <= selectedRange.end)
      : []
    const rows = data.clients.map(client => {
      const storeIds = new Set(data.stores.filter(store => store.clientId === client.id).map(store => store.id))
      const clientRecords = records.filter(record => storeIds.has(record.storeId))
      return {
        id: client.id,
        name: client.name,
        sales: round(clientRecords.reduce((sum, record) => sum + record.amount, 0)),
        commission: round(clientRecords.reduce((sum, record) => sum + record.operationFee, 0)),
        profit: round(clientRecords.reduce((sum, record) => sum + record.estimatedProfit, 0)),
      }
    })
    return {
      rows,
      recordCount: records.length,
      sales: round(rows.reduce((sum, row) => sum + row.sales, 0)),
      commission: round(rows.reduce((sum, row) => sum + row.commission, 0)),
      profit: round(rows.reduce((sum, row) => sum + row.profit, 0)),
    }
  }, [data.clients, data.profitRecords, data.stores, selectedRange.end, selectedRange.start])
  const addTodo = () => {
    const title = todoTitle.trim()
    if (!title) return
    update(current => ({ ...current, todos: [...current.todos, { id: createId('todo'), date: todoDate, title, clientId: todoClientId, storeId: todoStoreId, completed: false, createdAt: new Date().toISOString() }] }))
    setTodoTitle('')
  }

  return <div className="page">
    <div className="page-heading"><div><span className="eyebrow">经营数据视图</span><h1>总览</h1><p>快速查看全部店铺的销售额、提点和甲方盈利。</p></div><div className="today">{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date())}</div></div>
    <section className="metrics">{metrics.map(([label, value, Icon, tone]) => <article key={label} className="metric"><div className={`metric-icon ${tone}`}><Icon size={18} /></div><div><span>{label}</span><strong>{value}</strong></div></article>)}</section>
    <section className="panel performance-panel">
      <div className="panel-heading performance-heading"><div><h2>全部店铺业绩</h2><p>汇总经营结算中已经保存的数据</p></div><div className="performance-range"><div className="range-switch"><button className={performanceRange === 'yesterday' ? 'active' : ''} onClick={() => setPerformanceRange('yesterday')}>昨天</button><button className={performanceRange === 'month' ? 'active' : ''} onClick={() => setPerformanceRange('month')}>本月</button><button className={performanceRange === 'custom' ? 'active' : ''} onClick={() => setPerformanceRange('custom')}>自定义</button></div>{performanceRange === 'custom' && <div className="custom-range"><input aria-label="开始日期" type="date" value={performanceStart} max={performanceEnd || today} onChange={event => setPerformanceStart(event.target.value)} /><span>至</span><input aria-label="结束日期" type="date" value={performanceEnd} min={performanceStart} max={today} onChange={event => setPerformanceEnd(event.target.value)} /></div>}</div></div>
      <div className="performance-metrics">
        <article><div className="performance-icon sales"><CircleDollarSign size={19} /></div><div><span>销售额</span><strong>{money(performance.sales)}</strong></div></article>
        <article><div className="performance-icon commission"><BadgePercent size={19} /></div><div><span>我的提点</span><strong>{money(performance.commission)}</strong></div></article>
        <article><div className="performance-icon profit"><TrendingUp size={19} /></div><div><span>甲方盈利</span><strong className={performance.profit < 0 ? 'negative' : ''}>{money(performance.profit)}</strong></div></article>
      </div>
      <div className="performance-table-head"><div><strong>各甲方汇总</strong><span>{selectedRange.start === selectedRange.end ? selectedRange.start : `${selectedRange.start} 至 ${selectedRange.end}`}</span></div><span>{performance.recordCount} 条经营记录</span></div>
      <div className="table-scroll performance-table"><table><thead><tr><th>甲方</th><th>销售额</th><th>我的提点</th><th>甲方盈利</th></tr></thead><tbody>{performance.rows.map(row => <tr key={row.id}><td><strong className="cell-main">{row.name}</strong></td><td>{money(row.sales)}</td><td className="performance-commission">{money(row.commission)}</td><td className={row.profit < 0 ? 'negative' : 'positive'}>{money(row.profit)}</td></tr>)}</tbody></table></div>
      {!performance.recordCount && <div className="performance-empty">该时间段还没有保存经营数据</div>}
    </section>
    <section className="panel todo-panel"><div className="panel-heading todo-heading"><div><h2>重要待办</h2><p>记录今天或指定日期需要处理的甲方、店铺事项</p></div><label className="todo-date"><CalendarDays size={15} /><input type="date" value={todoDate} onChange={e => setTodoDate(e.target.value)} /></label></div>
      <div className="todo-quick-add"><input className="todo-title-input" value={todoTitle} onChange={e => setTodoTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addTodo() }} placeholder="输入需要处理的重要事项，按回车快速添加" /><select value={todoClientId} onChange={e => { setTodoClientId(e.target.value); setTodoStoreId('') }}><option value="">关联甲方（可选）</option>{data.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select><select value={todoStoreId} onChange={e => setTodoStoreId(e.target.value)} disabled={!todoClientId}><option value="">关联店铺（可选）</option>{todoStores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}</select><button className="button primary" disabled={!todoTitle.trim()} onClick={addTodo}><Plus size={16} />添加</button></div>
      {datedTodos.length ? <div className="todo-list">{datedTodos.map(todo => { const client = data.clients.find(item => item.id === todo.clientId); const store = data.stores.find(item => item.id === todo.storeId); return <div key={todo.id} className={`todo-row ${todo.completed ? 'completed' : ''}`}><button className="todo-check" aria-label={todo.completed ? '标记为未完成' : '标记为已完成'} onClick={() => update(current => ({ ...current, todos: current.todos.map(item => item.id === todo.id ? { ...item, completed: !item.completed } : item) }))}>{todo.completed ? <Check size={15} /> : <Circle size={16} />}</button><div className="todo-content"><strong>{todo.title}</strong>{(client || store) && <span>{client?.name}{client && store ? ' · ' : ''}{store?.name}</span>}</div><button className="icon-button danger" aria-label="删除待办" onClick={() => update(current => ({ ...current, todos: current.todos.filter(item => item.id !== todo.id) }))}><Trash2 size={14} /></button></div> })}</div> : <div className="todo-empty">{todoDate === today ? '今天还没有待办，先添加一项重要事项吧' : '该日期暂无待办'}</div>}
    </section>
    <div className="dashboard-grid">
      <section className="panel"><div className="panel-heading"><div><h2>甲方概览</h2><p>点击甲方查看对应商品</p></div></div>
        <div className="client-list">{data.clients.map(client => {
          const stores = activeStores.filter(s => s.clientId === client.id)
          const links = activeLinks.filter(l => l.clientId === client.id)
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
