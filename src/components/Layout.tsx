import { BarChart3, Box, Boxes, Calculator, Check, ChevronRight, ClipboardList, Cloud, CloudAlert, Database, FilePenLine, LayoutDashboard, LoaderCircle, LogOut, Menu, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useWorkbench } from '../store/workbench'
import { OverviewRefundTracker } from './OverviewRefundActivity'
import { SyncNotice } from './SyncNotice'

const items = [
  { to: '/', label: '总览', icon: LayoutDashboard },
  { to: '/products', label: '商品管理', icon: Box },
  { to: '/sku-drafts', label: 'SKU 草稿', icon: FilePenLine },
  { to: '/product-costs', label: '产品成本', icon: Calculator },
  { to: '/operations', label: '调整记录', icon: ClipboardList },
  { to: '/master-data', label: '基础资料', icon: Database },
  { to: '/profit-preview', label: '经营结算', icon: BarChart3 },
  { to: '/link-profit', label: '商品 ID 盈亏', icon: Calculator },
]

export function Layout() {
  const [open, setOpen] = useState(false)
  const { userEmail, signOut, syncStatus, complete, fullLoadError, ensureFullData } = useWorkbench()
  const { pathname } = useLocation()
  const needsFullData = pathname !== '/'
  useEffect(() => { if (needsFullData && !complete) void ensureFullData() }, [needsFullData, complete, ensureFullData])
  const currentPage = items.find(item => item.to === pathname)?.label || (pathname === '/store-business-reset' ? '单店经营数据重置' : '总览')
  return <div className="app-shell">
    {complete && <OverviewRefundTracker />}
    <button className="mobile-menu" onClick={() => setOpen(true)} aria-label="打开导航"><Menu size={20} /></button>
    {open && <button className="nav-backdrop" onClick={() => setOpen(false)} aria-label="关闭导航" />}
    <aside className={`sidebar ${open ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><Boxes size={22} strokeWidth={1.8} /></div><div><strong>运营工作台</strong><span>ECOM · WORKSPACE</span></div></div>
      <button className="sidebar-close" onClick={() => setOpen(false)} aria-label="关闭导航"><X size={18} /></button>
      <nav aria-label="主导航"><span className="nav-section-label">工作空间</span>{items.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'} onClick={() => setOpen(false)}><Icon size={18} strokeWidth={1.8} /><span>{label}</span></NavLink>)}</nav>
      <div className="account-card"><div className={`sync-line sync-${syncStatus}`}>{syncStatus === 'saved' ? <Check size={13} /> : syncStatus === 'saving' ? <Cloud size={13} /> : <CloudAlert size={13} />}<span>{!complete ? '总览已加载' : syncStatus === 'saved' ? '云端已同步' : syncStatus === 'saving' ? '正在保存…' : '同步失败'}</span></div><div className="account-email" title={userEmail}>{userEmail}</div><button onClick={() => void signOut()}><LogOut size={14} />退出登录</button></div>
    </aside>
    <main className="main"><header className="workspace-bar"><div className="workspace-breadcrumb"><span>工作空间</span><ChevronRight size={14} /><strong>{currentPage}</strong></div><div className="workspace-cloud"><Cloud size={15} /><span>云端工作台</span></div></header><SyncNotice />{needsFullData && !complete ? <div className="state-page"><LoaderCircle className="spin" size={25} /><strong>正在读取完整经营数据</strong><span>{fullLoadError || '订单、退款和资金明细仅在需要时加载；完成前不会保存任何修改。'}</span>{fullLoadError && <button className="button secondary" onClick={() => void ensureFullData()}>重新读取</button>}</div> : <Outlet />}</main>
  </div>
}
