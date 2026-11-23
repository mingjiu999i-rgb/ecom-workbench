import type { RowTransport } from '../services/rowWorkbenchStore'
import type { ProfitBaseline } from './profitBaselines'

type Reader = Pick<RowTransport, 'head' | 'collectionPage'>
const collection = 'a:profitBaselines'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
const nonempty = (value: unknown) => typeof value === 'string' && value.length > 0

// Overview query only. It does not load ledgers, adopt a save baseline, or write
// the returned extension into WorkbenchData or the synchronization controller.
export async function readPerformanceBaselines(transport: Reader, signal?: AbortSignal): Promise<ProfitBaseline[]> {
  signal?.throwIfAborted()
  const before = await transport.head(signal)
  if (before.mode !== 'rows' || !/^\d+$/.test(before.revision) || !transport.collectionPage) throw new Error('初始记录读取方式不可用')
  const positions = new Set<number>(), identities = new Set<string>(), cursors = new Set<string>()
  const result: Array<{ position: number; body: ProfitBaseline }> = []
  let after: string[] | null = null
  for (;;) {
    signal?.throwIfAborted()
    const page = await transport.collectionPage(collection, after, signal)
    if (!page.length) break
    for (const row of page) {
      const body = row.body
      if (row.collection !== collection || row.scope !== '' || !Number.isInteger(row.position) || row.position < 0 || positions.has(row.position)
        || !object(body) || !nonempty(body.id) || !nonempty(body.storeId) || row.store_id !== body.storeId
        || typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)
        || typeof body.recordedAt !== 'string' || !Number.isFinite(Date.parse(body.recordedAt))
        || !finite(body.orderCount) || !finite(body.collectionProfit) || !Array.isArray(body.products)
        || !body.products.length || body.products.some(product => !object(product) || !nonempty(product.productId) || !finite(product.estimatedProfit))) throw new Error('初始记录不完整，请重新读取')
      const identity = JSON.stringify([body.storeId, body.date])
      if (identities.has(identity)) throw new Error('初始记录重复，请核对后重试')
      identities.add(identity); positions.add(row.position)
      result.push({ position: row.position, body: body as ProfitBaseline })
    }
    const last = page[page.length - 1]
    after = [last.collection, last.scope, last.record_key]
    const cursor = JSON.stringify(after)
    if (cursors.has(cursor)) throw new Error('初始记录分页未推进')
    cursors.add(cursor)
  }
  const afterHead = await transport.head(signal)
  signal?.throwIfAborted()
  if (afterHead.mode !== before.mode || afterHead.revision !== before.revision) throw new Error('读取期间云端数据有更新，请重新读取')
  result.sort((a, b) => a.position - b.position)
  if (result.some((row, index) => row.position !== index)) throw new Error('初始记录分页不完整，请重新读取')
  return result.map(row => row.body)
}
