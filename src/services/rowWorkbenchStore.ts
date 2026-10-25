import type { SupabaseClient } from '@supabase/supabase-js'
import { chunkRowChanges, decodeWorkbenchRows, diffWorkbenchRows, encodeWorkbenchRows, type StoredRow, type RowChange } from './workbenchRows'

type Head = { mode: string; revision: string }
export type RowLoadProfile = 'startup' | 'full'
export type RowTransport = {
  head: (signal?: AbortSignal) => Promise<Head>
  page: (after: string[] | null, signal?: AbortSignal) => Promise<StoredRow[]>
  startupPage?: (after: string[] | null, signal?: AbortSignal) => Promise<StoredRow[]>
  collections?: (signal?: AbortSignal) => Promise<string[]>
  collectionPage?: (collection: string, after: string[] | null, signal?: AbortSignal) => Promise<StoredRow[]>
  begin: (request: { id: string; revision: string; fingerprint: string; count: number }, signal?: AbortSignal) => Promise<string | null>
  stage: (id: string, offset: number, changes: RowChange[], signal?: AbortSignal) => Promise<void>
  commit: (id: string, signal?: AbortSignal) => Promise<string>
}
export type RowLoadProgress = { pages: number }
export type RowLoadOptions = { signal?: AbortSignal; profile?: RowLoadProfile; concurrency?: number; onProgress?: (progress: RowLoadProgress) => void }
const conflict = () => Object.assign(new Error('Cloud data changed; local changes retained'), { code: '40001' })
const validRevision = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
const cursorOf = (row: StoredRow) => [row.collection, row.scope, row.record_key]

async function readPages(read: (after: string[] | null) => Promise<StoredRow[]>, signal?: AbortSignal) {
  const rows: StoredRow[] = []
  let cursor: string[] | null = null
  for (;;) {
    signal?.throwIfAborted()
    const page = await read(cursor)
    if (!page.length) break
    rows.push(...page)
    const next = cursorOf(page[page.length - 1])
    if (JSON.stringify(next) === JSON.stringify(cursor)) throw new Error('Row pagination did not advance')
    cursor = next
  }
  return rows
}

async function readFullRows(transport: RowTransport, signal?: AbortSignal, concurrency = 4) {
  if (!transport.collections || !transport.collectionPage) return readPages(after => transport.page(after, signal), signal)
  const collections = await transport.collections(signal)
  const rows: StoredRow[] = []
  // Ledger scopes are the exact metadata record keys, already returned in
  // database cursor order. Split history reads across those existing scopes so
  // one large funds collection cannot monopolize a single serial worker.
  const metadataCollection = 'a:orderAccountingLedgers'
  const metadata = collections.includes(metadataCollection)
    ? await readPages(after => transport.collectionPage!(metadataCollection, after, signal), signal)
    : []
  rows.push(...metadata)
  const scopes = metadata.map(row => row.record_key), knownScopes = new Set(scopes)
  const ledgerCollections = new Set(['ledger.orders', 'ledger.refunds', 'ledger.funds', 'ledger.promotions'])
  async function readScope(collection: string, scope: string, first: boolean) {
    // Codec identities are nonempty JSON arrays; '' cannot skip a real key.
    // The first partition starts at null to detect orphan scopes before it.
    let cursor: string[] | null = first ? null : [collection, scope, '']
    const own: StoredRow[] = []
    for (;;) {
      signal?.throwIfAborted()
      const page = await transport.collectionPage!(collection, cursor, signal)
      if (!page.length) return own
      let crossed = false
      for (const row of page) {
        if (row.collection !== collection || !knownScopes.has(row.scope)) throw new Error('Orphan or incompatible ledger scope')
        if (row.scope !== scope) { crossed = true; break }
        own.push(row)
      }
      if (crossed) return own
      const next = cursorOf(page[page.length - 1])
      if (JSON.stringify(next) === JSON.stringify(cursor)) throw new Error('Row pagination did not advance')
      cursor = next
    }
  }
  const jobs: (() => Promise<StoredRow[]>)[] = []
  // Start large independent histories early, under the same global 4-RPC cap.
  const priority = ['a:linkSalesOrders', 'ledger.funds', 'ledger.orders', 'ledger.refunds']
  const ordered = [...priority.filter(value => collections.includes(value)), ...collections.filter(value => !priority.includes(value))]
  for (const collection of ordered) {
    if (collection === metadataCollection) continue
    if (ledgerCollections.has(collection) && scopes.length) {
      scopes.forEach((scope, index) => jobs.push(() => readScope(collection, scope, index === 0)))
    } else jobs.push(() => readPages(after => transport.collectionPage!(collection, after, signal), signal))
  }
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, 4, jobs.length || 1)) }, async () => {
    for (;;) {
      const index = next++
      if (index >= jobs.length) return
      rows.push(...await jobs[index]())
    }
  })
  await Promise.all(workers)
  return rows
}

// Loaded only by the explicit rows-v1 client gate. Server mode must also be
// 'rows'; no fallback to a legacy snapshot is allowed after activation.
export function createRowWorkbenchStore(transport: RowTransport) {
  let baseline: StoredRow[] | null = null, revision = '', queue = Promise.resolve()
  let pending: { rows: StoredRow[]; changes: RowChange[]; id: string; revision: string; fingerprint: string } | null = null
  async function finish(signal?: AbortSignal) {
    const request = pending!
    signal?.throwIfAborted()
    let saved = await transport.begin({ id: request.id, revision: request.revision, fingerprint: request.fingerprint, count: request.changes.length }, signal)
    if (saved === null) {
      let offset = 0
      for (const chunk of chunkRowChanges(request.changes)) {
        signal?.throwIfAborted()
        await transport.stage(request.id, offset, chunk, signal); offset += chunk.length
      }
      saved = await transport.commit(request.id, signal)
    }
    if (!validRevision(saved)) throw new Error('Cloud save acknowledgement missing revision')
    baseline = request.rows; revision = saved; pending = null
  }
  return {
    async load(options: RowLoadOptions | AbortSignal = {}) {
      const normalized: RowLoadOptions = typeof AbortSignal !== 'undefined' && options instanceof AbortSignal
        ? { signal: options as AbortSignal }
        : options as RowLoadOptions
      const { signal, profile = 'full', concurrency = 4, onProgress } = normalized
      const operation = queue.catch(() => {}).then(async () => {
        if (pending) throw new Error('Unconfirmed changes must be resolved before reloading')
        const before = await transport.head(signal)
        if (before.mode !== 'rows' || !validRevision(before.revision)) throw conflict()
        let pages = 0
        const reportPage = async (request: Promise<StoredRow[]>) => {
          const page = await request
          signal?.throwIfAborted()
          onProgress?.({ pages: ++pages })
          return page
        }
        const reader: RowTransport = { ...transport,
          page: (after, requestSignal) => reportPage(transport.page(after, requestSignal)),
          collectionPage: transport.collectionPage
            ? (collection, after, requestSignal) => reportPage(transport.collectionPage!(collection, after, requestSignal))
            : undefined,
        }
        const rows = profile === 'startup' && transport.startupPage
          ? await readPages(after => reportPage(transport.startupPage!(after, signal)), signal)
          : await readFullRows(reader, signal, concurrency)
        signal?.throwIfAborted()
        const after = await transport.head(signal)
        signal?.throwIfAborted()
        if (after.mode !== 'rows' || before.revision !== after.revision) throw conflict()
        const data = decodeWorkbenchRows(rows)
        // A startup view is intentionally incomplete and must never become a
        // write baseline. Only a verified full snapshot can be diffed/saved.
        if (profile === 'full') { baseline = rows; revision = before.revision }
        return structuredClone(data)
      })
      queue = operation.then(() => {}, () => {})
      return operation
    },
    save(data: object, signal?: AbortSignal): Promise<void> {
      const snapshot = structuredClone(data)
      const operation = queue.catch(() => {}).then(async () => {
        signal?.throwIfAborted()
        if (!baseline) throw new Error('Load complete row baseline before saving')
        if (pending) await finish(signal)
        const rows = encodeWorkbenchRows(snapshot), changes = diffWorkbenchRows(baseline, rows)
        if (!changes.length) return
        chunkRowChanges(changes)
        if (changes.length > 100000) throw new Error('Import exceeds batch limit; local backup retained')
        const bytes = new TextEncoder().encode(JSON.stringify(changes))
        const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
        pending = { rows, changes, id: crypto.randomUUID(), revision, fingerprint }
        await finish(signal)
      })
      queue = operation
      return operation
    },
  }
}

// Caller supplies the already authenticated anon-key client. No elevated key.
export function supabaseRowTransport(client: SupabaseClient, userId: string): RowTransport {
  const rpc = async (name: string, args: object, signal?: AbortSignal) => {
    const query = client.rpc(name, args), { data, error } = await (signal ? query.abortSignal(signal) : query)
    if (error) throw error
    return data
  }
  const mapRows = (data: unknown) => {
    if (!Array.isArray(data)) throw new Error('Invalid cloud row page')
    return data.map(({ user_id: _owner, ...row }) => row as StoredRow)
  }
  return {
    async head(signal) {
      const data = await rpc('read_workbench_rows_head', {}, signal)
      if (!data || data.user_id !== userId) throw conflict()
      return { mode: data.mode, revision: data.revision }
    },
    async page(after, signal) { return mapRows(await rpc('read_workbench_rows_page', { p_after: after, p_limit: 500 }, signal)) },
    async startupPage(after, signal) { return mapRows(await rpc('read_workbench_rows_startup_page', { p_after: after, p_limit: 500, p_max_bytes: 262144 }, signal)) },
    async collections(signal) {
      const data = await rpc('read_workbench_row_collections', {}, signal)
      if (!Array.isArray(data) || data.some(value => typeof value !== 'string')) throw new Error('Invalid cloud collection list')
      return data
    },
    async collectionPage(collection, after, signal) { return mapRows(await rpc('read_workbench_rows_collection_page', { p_collection: collection, p_after: after, p_limit: 500, p_max_bytes: 262144 }, signal)) },
    async begin(request, signal) { const data = await rpc('begin_workbench_rows', { p_request_id: request.id, p_expected_revision: request.revision, p_fingerprint: request.fingerprint, p_operation_count: request.count }, signal); return data?.revision },
    async stage(id, offset, changes, signal) { await rpc('stage_workbench_rows', { p_request_id: id, p_offset: offset, p_changes: changes }, signal) },
    async commit(id, signal) { return (await rpc('commit_workbench_rows', { p_request_id: id }, signal))?.revision },
  }
}
