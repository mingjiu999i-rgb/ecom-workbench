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
export type RowWriteProgress = { phase: 'begin' | 'stage'; confirmedChunks: number; totalChunks: number }
export type RowLoadOptions = { signal?: AbortSignal; profile?: RowLoadProfile; concurrency?: number; onProgress?: (progress: RowLoadProgress) => void }
export type RowReviewSnapshot = { data: Record<string, unknown>; revision: string; rows: StoredRow[] }
const conflict = () => Object.assign(new Error('Cloud data changed; local changes retained'), { code: '40001' })
const businessConflict = (error: unknown) => {
  const item = error as { code?: string; status?: number } | null
  return !!item && (item.code === 'PT409' || item.code === '40001' || item.status === 409)
}
const writeFailure = (error: unknown, phase: 'begin' | 'stage' | 'commit') => {
  const item = error as { code?: string; status?: number; message?: string } | null
  return Object.assign(new Error(item?.message || String(error)), { code: item?.code, status: item?.status, writePhase: phase, cause: error })
}
const validRevision = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
const cursorOf = (row: StoredRow) => [row.collection, row.scope, row.record_key]
const appendRows = (target: StoredRow[], source: StoredRow[]) => {
  for (const row of source) target.push(row)
}

async function readPages(read: (after: string[] | null) => Promise<StoredRow[]>, signal?: AbortSignal) {
  const rows: StoredRow[] = []
  let cursor: string[] | null = null
  for (;;) {
    signal?.throwIfAborted()
    const page = await read(cursor)
    if (!page.length) break
    appendRows(rows, page)
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
  appendRows(rows, metadata)
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
      appendRows(rows, await jobs[index]())
    }
  })
  await Promise.all(workers)
  return rows
}

// Loaded only by the explicit rows-v1 client gate. Server mode must also be
// 'rows'; no fallback to a legacy snapshot is allowed after activation.
export function createRowWorkbenchStore(transport: RowTransport) {
  let baseline: StoredRow[] | null = null, revision = '', queue = Promise.resolve()
  let pending: { rows: StoredRow[]; changes: RowChange[]; chunks: RowChange[][]; nextChunk: number; offset: number; id: string; revision: string; fingerprint: string } | null = null
  let frozen = false
  const verified = new WeakSet<RowReviewSnapshot>(), abandoned: { id: string; revision: string; fingerprint: string; count: number }[] = []
  async function readVerified(options: RowLoadOptions = {}): Promise<RowReviewSnapshot> {
    const { signal, profile = 'full', concurrency = 4, onProgress } = options
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
    const snapshot = { data: structuredClone(decodeWorkbenchRows(rows)), revision: before.revision, rows }
    verified.add(snapshot)
    return snapshot
  }
  async function finish(signal?: AbortSignal, onProgress?: (progress: RowWriteProgress) => void) {
    const request = pending!
    signal?.throwIfAborted()
    let saved: string | null
    try { saved = await transport.begin({ id: request.id, revision: request.revision, fingerprint: request.fingerprint, count: request.changes.length }, signal) }
    catch (error) { if (businessConflict(error)) frozen = true; throw writeFailure(error, 'begin') }
    if (saved !== null && !validRevision(saved)) throw new Error('Cloud save acknowledgement missing revision')
    onProgress?.({ phase: 'begin', confirmedChunks: request.nextChunk, totalChunks: request.chunks.length })
    if (saved === null) {
      while (request.nextChunk < request.chunks.length) {
        const chunk = request.chunks[request.nextChunk]
        signal?.throwIfAborted()
        try { await transport.stage(request.id, request.offset, chunk, signal) }
        catch (error) {
          // A separately approved server compaction fix may need to normalize
          // an older prefix. Size failures are not automatically retried.
          if ((error as { code?: string } | null)?.code === '54000') { request.nextChunk = 0; request.offset = 0 }
          throw writeFailure(error, 'stage')
        }
        // Advance only after acknowledgement. A lost reply replays just this
        // chunk under the same ID; the server still verifies its exact payload.
        request.offset += chunk.length; request.nextChunk++
        onProgress?.({ phase: 'stage', confirmedChunks: request.nextChunk, totalChunks: request.chunks.length })
      }
      try { saved = await transport.commit(request.id, signal) }
      catch (error) { if (businessConflict(error)) frozen = true; throw writeFailure(error, 'commit') }
    }
    if (!validRevision(saved)) throw new Error('Cloud save acknowledgement missing revision')
    baseline = request.rows; revision = saved; pending = null
  }
  return {
    async load(options: RowLoadOptions | AbortSignal = {}) {
      const normalized: RowLoadOptions = typeof AbortSignal !== 'undefined' && options instanceof AbortSignal
        ? { signal: options as AbortSignal }
        : options as RowLoadOptions
      const operation = queue.catch(() => {}).then(async () => {
        if (pending) throw new Error('Unconfirmed changes must be resolved before reloading')
        const snapshot = await readVerified(normalized)
        // A startup view is intentionally incomplete and must never become a
        // write baseline. Only a verified full snapshot can be diffed/saved.
        if ((normalized.profile || 'full') === 'full') { baseline = snapshot.rows; revision = snapshot.revision }
        return snapshot.data
      })
      queue = operation.then(() => {}, () => {})
      return operation
    },
    // This read bypasses the write queue and never adopts a write baseline.
    readOnly(options: RowLoadOptions = {}) { return readVerified({ ...options, profile: 'full' }) },
    getPendingRequest() { return pending && { id: pending.id, revision: pending.revision, fingerprint: pending.fingerprint, count: pending.changes.length, nextChunk: pending.nextChunk, offset: pending.offset } },
    getAbandonedRequests() { return abandoned.map(item => ({ ...item })) },
    async adoptReview(snapshot: RowReviewSnapshot, verifyRevision = false, signal?: AbortSignal) {
      if (!verified.has(snapshot)) throw new Error('Unverified cloud review snapshot')
      await queue.catch(() => {})
      if (verifyRevision) {
        const head = await transport.head(signal)
        if (head.mode !== 'rows' || head.revision !== snapshot.revision) throw conflict()
      }
      if (pending) abandoned.push({ id: pending.id, revision: pending.revision, fingerprint: pending.fingerprint, count: pending.changes.length })
      baseline = snapshot.rows; revision = snapshot.revision; pending = null; frozen = false
    },
    save(data: object, signal?: AbortSignal, onProgress?: (progress: RowWriteProgress) => void): Promise<void> {
      const snapshot = structuredClone(data)
      const operation = queue.catch(() => {}).then(async () => {
        signal?.throwIfAborted()
        if (frozen) throw Object.assign(new Error('Conflicted request is frozen until cloud review'), { code: 'PT409', writePhase: 'begin' })
        if (!baseline) throw new Error('Load complete row baseline before saving')
        if (pending) await finish(signal, onProgress)
        const rows = encodeWorkbenchRows(snapshot), changes = diffWorkbenchRows(baseline, rows)
        if (!changes.length) return
        const chunks = chunkRowChanges(changes)
        if (changes.length > 100000) throw new Error('Import exceeds batch limit; local backup retained')
        const bytes = new TextEncoder().encode(JSON.stringify(changes))
        const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
        pending = { rows, changes, chunks, nextChunk: 0, offset: 0, id: crypto.randomUUID(), revision, fingerprint }
        await finish(signal, onProgress)
      })
      queue = operation
      return operation
    },
  }
}

// Caller supplies the already authenticated anon-key client. No elevated key.
export function supabaseRowTransport(client: SupabaseClient, userId: string): RowTransport {
  const rpc = async (name: string, args: object, signal?: AbortSignal) => {
    const query = client.rpc(name, args), { data, error, status } = await (signal ? query.abortSignal(signal) : query)
    if (error) throw Object.assign(new Error(error.message), error, { status })
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
    async collectionPage(collection, after, signal) { return mapRows(await rpc('read_workbench_rows_collection_page', { p_collection: collection, p_after: after, p_limit: 2000, p_max_bytes: 1048576 }, signal)) },
    async begin(request, signal) { const data = await rpc('begin_workbench_rows', { p_request_id: request.id, p_expected_revision: request.revision, p_fingerprint: request.fingerprint, p_operation_count: request.count }, signal); return data?.revision },
    async stage(id, offset, changes, signal) { await rpc('stage_workbench_rows', { p_request_id: id, p_offset: offset, p_changes: changes }, signal) },
    async commit(id, signal) { return (await rpc('commit_workbench_rows', { p_request_id: id }, signal))?.revision },
  }
}
