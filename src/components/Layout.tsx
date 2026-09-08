import { Box, Check, ClipboardList, Cloud, CloudAlert, Database, LayoutDashboard, LogOut, Menu, X } from 'lucide-react'
import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useWorkbench } from '../store/workbench'

const items = [
  { to: '/', label: '总览', icon: LayoutDashboard },
  { to: '/products', label: '商品管理', icon: Box },
  { to: '/operations', label: '调整记录', icon: ClipboardList },
  { to: '/master-data', label: '基础资料', icon: Database },
]

export function Layout() {
  const [open, setOpen] = useState(false)
  const { userEmail, signOut, syncStatus } = useWorkbench()
  return <div className="app-shell">
    <button className="mobile-menu" onClick={() => setOpen(true)} aria-label="打开导航"><Menu size={20} /></button>
    {open && <button className="nav-backdrop" onClick={() => setOpen(false)} aria-label="关闭导航" />}
    <aside className={`sidebar ${open ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark">运</div><div><strong>运营工作台</strong><span>ECOM OPS · V0.1</span></div></div>
      <button className="sidebar-close" onClick={() => setOpen(false)} aria-label="关闭导航"><X size={18} /></button>
      <nav>{items.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'} onClick={() => setOpen(false)}><Icon size={18} /><span>{label}</span></NavLink>)}</nav>
      <div className="account-card"><div className="sync-line">{syncStatus === 'saved' ? <Check size={13} /> : syncStatus === 'saving' ? <Cloud size={13} /> : <CloudAlert size={13} />}<span>{syncStatus === 'saved' ? '云端已同步' : syncStatus === 'saving' ? '正在保存…' : '同步失败'}</span></div><div className="account-email" title={userEmail}>{userEmail}</div><button onClick={() => void signOut()}><LogOut size={14} />退出登录</button></div>
    </aside>
    <main className="main"><Outlet /></main>
  </div>
}
