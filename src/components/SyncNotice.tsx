import { CloudAlert, Download, RefreshCw } from 'lucide-react'
import { downloadWorkbenchBackup, useWorkbench } from '../store/workbench'
import './sync-notice.css'

export function SyncNotice() {
  const { data, complete, syncStatus, syncSession, syncError, syncErrorDetail, backupError, cleanupError, retrySync, openSyncReview, reviewBusy, reviewIssue } = useWorkbench()
  if (!syncError && syncStatus !== 'error' && !cleanupError && !backupError && !reviewIssue) return null
  const localOnly = syncStatus === 'saved' && !syncError
  const frozen = ['conflict', 'capacity', 'unconfirmed'].includes(syncSession)
  return <section className={`sync-notice${backupError ? ' backup-failed' : ''}`} role={syncStatus === 'error' || backupError ? 'alert' : 'status'} aria-label="云同步提示">
    <CloudAlert size={19} />
    <div className="sync-notice-body"><strong>{backupError ? '本机备份失败，请立即导出' : localOnly ? '云端数据正常，本机备份需处理' : syncSession === 'conflict' ? '云端版本冲突，自动提交已停止' : syncSession === 'capacity' ? '云端容量限制，自动提交已停止' : syncSession === 'unconfirmed' ? '保存结果未确认，自动提交已停止' : syncStatus === 'saving' ? '正在重新同步…' : '修改尚未同步到云端'}</strong>
      <p>{backupError && <strong className="sync-notice-backup">{backupError} </strong>}{localOnly ? cleanupError : `${syncError || '保存请求未成功，请重试。'}${!backupError ? ' 未同步修改已备份在本机。' : ''}${cleanupError ? ` ${cleanupError}` : ''}`}</p>
      {reviewIssue && <p role="alert">{reviewIssue}</p>}
      {syncErrorDetail && <details><summary>查看错误详情</summary><pre>{syncErrorDetail}</pre></details>}
    </div>
    <div className="sync-notice-actions"><button className="button secondary" disabled={!complete} title={!complete ? '需加载完整数据后才能导出完整备份' : undefined} onClick={() => { if (complete) downloadWorkbenchBackup(data) }}><Download size={14} />{complete ? localOnly ? '导出当前数据备份' : '导出未同步备份' : '需加载完整数据后导出备份'}</button>
      {frozen && <button className="button secondary" disabled={reviewBusy} onClick={openSyncReview}>{reviewBusy ? '正在只读核对…' : '读取云端核对'}</button>}
      {(!localOnly || cleanupError) && !['conflict', 'capacity'].includes(syncSession) && <button className="button secondary" disabled={syncStatus === 'saving'} onClick={retrySync}><RefreshCw size={14} />{localOnly ? '重试清理本机备份' : syncSession === 'unconfirmed' ? '重试同一请求' : '重试同步'}</button>}</div>
  </section>
}
