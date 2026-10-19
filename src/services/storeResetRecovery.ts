import { validateStoreBusinessBackup, type StoreBusinessBackup } from '../utils/storeBusinessReset'

export type StoreResetRecovery = { id: string; backup: StoreBusinessBackup }
const DATABASE = 'ecom-workbench-store-reset-recovery'
const STORE = 'latest-by-store'
const keyFor = (account: string, storeId: string) => JSON.stringify([account, storeId])

// Independent local undo storage, never the live document or sync draft.
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let rejected = false
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'key' }) }
    request.onerror = () => { rejected = true; reject(request.error || new Error('无法打开本机撤销存储')) }
    request.onblocked = () => { rejected = true; reject(new Error('本机撤销存储被占用，请关闭其他工作台页面后重试')) }
    request.onsuccess = () => { if (rejected) request.result.close(); else resolve(request.result) }
  })
}
function validate(record: StoreResetRecovery, account: string, storeId: string) {
  if (!record || typeof record.id !== 'string' || !record.id) throw new Error('本机暂存记录无效，不能撤销')
  validateStoreBusinessBackup(record.backup)
  if (record.backup.account !== account || record.backup.store.id !== storeId) throw new Error('暂存记录不属于当前账号或店铺，不能撤销')
}
export async function writeStoreResetRecovery(record: StoreResetRecovery): Promise<void> {
  validate(record, record.backup.account, record.backup.store.id)
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite', { durability: 'strict' })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error || new Error('自动暂存失败，未清空数据'))
      transaction.onabort = () => reject(transaction.error || new Error('自动暂存中断，未清空数据'))
      transaction.objectStore(STORE).put({ key: keyFor(record.backup.account, record.backup.store.id), ...record })
    })
  } finally { database.close() }
}
export async function readStoreResetRecovery(account: string, storeId: string): Promise<StoreResetRecovery | null> {
  if (!account || !storeId) return null
  const database = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readonly')
      const request = transaction.objectStore(STORE).get(keyFor(account, storeId))
      let result: StoreResetRecovery | null = null
      request.onsuccess = () => { result = request.result || null }
      transaction.oncomplete = () => {
        try { if (result) validate(result, account, storeId); resolve(result) }
        catch (cause) { reject(cause) }
      }
      transaction.onerror = () => reject(transaction.error || new Error('无法读取本机暂存记录'))
      transaction.onabort = () => reject(transaction.error || new Error('本机暂存读取中断'))
    })
  } finally { database.close() }
}
