import type { WorkbenchData } from '../types/models'
import type { DraftResolution, PendingDraft } from '../utils/workbenchSync'

const DATABASE = 'ecom-workbench-local-drafts'
const STORE = 'pending'
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE, { keyPath: 'userId' }) }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onblocked = () => reject(new Error('本机备份数据库暂时不可用'))
  })
}
export async function readWorkbenchDraft(userId: string): Promise<PendingDraft<WorkbenchData> | null> {
  const database = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readonly')
      const request = transaction.objectStore(STORE).get(userId)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })
  } finally { database.close() }
}
export async function writeWorkbenchDraft(draft: PendingDraft<WorkbenchData>): Promise<void> {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).put(draft)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally { database.close() }
}
export async function removeWorkbenchDraft(userId: string, id: string): Promise<void> {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      const request = store.get(userId)
      request.onsuccess = () => { if (request.result?.id === id) store.delete(userId) }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally { database.close() }
}

// Record only a confirmed server acknowledgement or the user's explicit
// choice, and never mark a newer pending draft that replaced this one.
export async function acknowledgeWorkbenchDraft(userId: string, id: string, resolution: DraftResolution): Promise<void> {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      const request = store.get(userId)
      request.onsuccess = () => { if (request.result?.id === id) store.put({ ...request.result, resolution }) }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally { database.close() }
}
