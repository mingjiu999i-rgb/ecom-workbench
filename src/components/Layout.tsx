import { Box, ClipboardList, Database, LayoutDashboard, Menu, X } from 'lucide-react'
import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'

const items = [
  { to: '/', label: '总览', icon: LayoutDashboard },
  { to: '/products', label: '商品管理', icon: Box },
  { to: '/operations', label: '调整记录', icon: ClipboardList },
  { to: '/master-data', label: '基础资料', icon: Database },
]

export function Layout() {
  const [open, setOpen] = useState(false)
  return <div className="app-shell">
    <button className="mobile-menu" onClick={() => setOpen(true)} aria-label="打开导航"><Menu size={20} /></button>
    {open && <button className="nav-backdrop" onClick={() => setOpen(false)} aria-label="关闭导航" />}
    <aside className={`sidebar ${open ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark">运</div><div><strong>运营工作台</strong><span>ECOM OPS · V0.1</span></div></div>
      <button className="sidebar-close" onClick={() => setOpen(false)} aria-label="关闭导航"><X size={18} /></button>
      <nav>{items.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'} onClick={() => setOpen(false)}><Icon size={18} /><span>{label}</span></NavLink>)}</nav>
      <div className="sidebar-foot"><span className="status-dot" />数据已保存在此浏览器</div>
    </aside>
    <main className="main"><Outlet /></main>
  </div>
}
