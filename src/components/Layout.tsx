import { BarChart3, Box, Boxes, Calculator, Check, ChevronRight, ClipboardList, Cloud, CloudAlert, Database, LayoutDashboard, LogOut, Menu, X } from 'lucide-react'
import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useWorkbench } from '../store/workbench'

const items = [
  { to: '/', label: '总览', icon: LayoutDashboard },
  { to: '/products', label: '商品管理', icon: Box },
  { to: '/product-costs', label: '产品成本', icon: Calculator },
  { to: '/operations', label: '调整记录', icon: ClipboardList },
  { to: '/master-data', label: '基础资料', icon: Database },
  { to: '/profit-preview', label: '经营结算', icon: BarChart3 },
]

export function Layout() {
  const [open, setOpen] = useState(false)
  const { userEmail, signOut, syncStatus } = useWorkbench()
  const { pathname } = useLocation()
  const currentPage = items.find(item => item.to === pathname)?.label || '总览'
  return <div className="app-shell">
    <button className="mobile-menu" onClick={() => setOpen(true)} aria-label="打开导航"><Menu size={20} /></button>
    {open && <button className="nav-backdrop" onClick={() => setOpen(false)} aria-label="关闭导航" />}
    <aside className={`sidebar ${open ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><Boxes size={22} strokeWidth={1.8} /></div><div><strong>运营工作台</strong><span>ECOM · WORKSPACE</span></div></div>
      <button className="sidebar-close" onClick={() => setOpen(false)} aria-label="关闭导航"><X size={18} /></button>
      <nav aria-label="主导航"><span className="nav-section-label">工作空间</span>{items.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'} onClick={() => setOpen(false)}><Icon size={18} strokeWidth={1.8} /><span>{label}</span></NavLink>)}</nav>
      <div className="account-card"><div className={`sync-line sync-${syncStatus}`}>{syncStatus === 'saved' ? <Check size={13} /> : syncStatus === 'saving' ? <Cloud size={13} /> : <CloudAlert size={13} />}<span>{syncStatus === 'saved' ? '云端已同步' : syncStatus === 'saving' ? '正在保存…' : '同步失败'}</span></div><div className="account-email" title={userEmail}>{userEmail}</div><button onClick={() => void signOut()}><LogOut size={14} />退出登录</button></div>
    </aside>
    <main className="main"><header className="workspace-bar"><div className="workspace-breadcrumb"><span>工作空间</span><ChevronRight size={14} /><strong>{currentPage}</strong></div><div className="workspace-cloud"><Cloud size={15} /><span>云端工作台</span></div></header><Outlet /></main>
  </div>
}
