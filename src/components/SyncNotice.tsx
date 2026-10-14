import { CloudAlert, Download, RefreshCw } from 'lucide-react'
import { downloadWorkbenchBackup, useWorkbench } from '../store/workbench'
import './sync-notice.css'

export function SyncNotice() {
  const { data, syncStatus, syncError, syncErrorDetail, backupError, retrySync } = useWorkbench()
  if (!syncError && syncStatus !== 'error') return null
  return <section className="sync-notice" role={syncStatus === 'error' ? 'alert' : 'status'} aria-label="云同步提示">
    <CloudAlert size={19} />
    <div className="sync-notice-body"><strong>{syncStatus === 'saving' ? '正在重新同步…' : '修改尚未同步到云端'}</strong>
      <p>{syncError || '保存请求未成功，请重试。'}{backupError ? ` ${backupError}` : ' 未同步修改已备份在本机，恢复连接后可继续同步。'}</p>
      {syncErrorDetail && <details><summary>查看错误详情</summary><pre>{syncErrorDetail}</pre></details>}
    </div>
    <div className="sync-notice-actions"><button className="button secondary" disabled={syncStatus === 'saving'} onClick={retrySync}><RefreshCw size={14} />重试同步</button><button className="button secondary" onClick={() => downloadWorkbenchBackup(data)}><Download size={14} />导出未同步备份</button></div>
  </section>
}
