import { sameStoredDocument } from '../utils/workbenchRecovery'

// Storage codec only: preserve JSON values, optional fields and array order.
// No costs, dates, identifiers or financial amounts are repaired or recalculated.
export type StoredRow = {
  collection: string; scope: string; record_key: string; position: number
  body: unknown; store_id: string | null; client_id: string | null; business_date: string | null
}
export type RowChange = { collection: string; scope: string; record_key: string } & (
  { row: StoredRow | null; position?: never } | { position: number; row?: never }
)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !value) throw new Error('Missing stored identity; migration stopped')
  return value
}
const key = (...values: unknown[]) => JSON.stringify(values)
export const storedRowIdentity = (row: Pick<StoredRow, 'collection' | 'scope' | 'record_key'>) => key(row.collection, row.scope, row.record_key)
const ledgerSections = ['orders', 'refunds', 'funds', 'promotions'] as const
const idArrays = new Set(['clients', 'stores', 'products', 'productLinks', 'productCosts', 'skus', 'operations', 'skuHistory', 'todos', 'profitRecords', 'collectionRecords', 'skuPlanningDrafts'])

export function encodeWorkbenchRows(document: object): StoredRow[] {
  const data = document as Record<string, unknown>, result: StoredRow[] = [], identities = new Set<string>()
  const stores = new Map((Array.isArray(data.stores) ? data.stores : []).filter(object).map(store => [store.id, store]))
  function add(collection: string, scope: string, record_key: string, position: number, body: unknown, storeId?: unknown) {
    const store_id = typeof storeId === 'string' ? storeId : object(body) && typeof body.storeId === 'string' ? body.storeId : null
    const client = object(body) ? body.clientId : null
    const client_id = typeof client === 'string' ? client : store_id && typeof stores.get(store_id)?.clientId === 'string' ? stores.get(store_id)!.clientId as string : null
    const date = object(body) ? body.date : null
    const business_date = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null
    const row = { collection, scope, record_key, position, body, store_id, client_id, business_date }
    const identity = storedRowIdentity(row)
    if (identities.has(identity)) throw new Error(`Duplicate stored identity in ${collection}; migration stopped`)
    identities.add(identity); result.push(row)
  }
  for (const [section, value] of Object.entries(data)) {
    if (value === undefined) continue
    if (!Array.isArray(value)) { add('$value', '', section, 0, value); continue }
    add('$array', '', section, 0, {})
    value.forEach((body, position) => {
      if (section === 'orderAccountingLedgers') {
        if (!object(body)) throw new Error('Invalid stored ledger')
        const scope = key(id(body.storeId)), metadata = { ...body }
        for (const child of ledgerSections) {
          if (!Object.hasOwn(body, child)) continue
          if (!Array.isArray(body[child])) throw new Error('Invalid stored ledger collection')
          metadata[child] = []
          body[child].forEach((entry: unknown, ordinal: number) => {
            if (!object(entry)) throw new Error('Invalid stored ledger entry')
            const field = child === 'funds' ? 'key' : child === 'promotions' ? 'date' : 'id'
            add(`ledger.${child}`, scope, key(id(entry[field])), ordinal, entry, body.storeId)
          })
        }
        add('a:orderAccountingLedgers', '', scope, position, metadata, body.storeId)
      } else {
        let recordKey: string
        if (idArrays.has(section)) { if (!object(body)) throw new Error('Invalid stored record'); recordKey = key(id(body.id)) }
        else if (section === 'linkSalesOrders') { if (!object(body)) throw new Error('Invalid link order'); recordKey = key(id(body.storeId), id(body.orderId)) }
        else if (section === 'linkSalesPromotions') { if (!object(body)) throw new Error('Invalid link promotion'); recordKey = key(id(body.storeId), id(body.goodsId), id(body.date)) }
        // Unknown extension arrays are losslessly stored by position, with no invented business identity.
        else recordKey = key(position)
        add(`a:${section}`, '', recordKey, position, body, section === 'stores' && object(body) ? body.id : undefined)
      }
    })
  }
  return result
}

export function decodeWorkbenchRows(rows: StoredRow[]): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null), identities = new Set<string>(), groups = new Map<string, StoredRow[]>()
  for (const row of rows) {
    const identity = storedRowIdentity(row)
    if (identities.has(identity)) throw new Error('Duplicate row in storage response')
    identities.add(identity)
    const group = key(row.collection, row.scope), list = groups.get(group) || []
    list.push(row); groups.set(group, list)
  }
  const ordered = (collection: string, scope = '') => {
    const items = [...(groups.get(key(collection, scope)) || [])].sort((a, b) => a.position - b.position)
    if (items.some((item, index) => item.position !== index)) throw new Error('Incomplete row page or invalid array positions')
    return items
  }
  for (const row of rows.filter(item => item.collection === '$value')) result[row.record_key] = row.body
  for (const header of rows.filter(item => item.collection === '$array')) {
    result[header.record_key] = ordered(`a:${header.record_key}`).map(row => {
      if (header.record_key !== 'orderAccountingLedgers') return row.body
      if (!object(row.body)) throw new Error('Invalid stored ledger metadata')
      const ledger = { ...row.body }
      for (const section of ledgerSections) if (Object.hasOwn(ledger, section)) ledger[section] = ordered(`ledger.${section}`, row.record_key).map(child => child.body)
      return ledger
    })
  }
  // Reject orphaned/unrecognized records instead of silently dropping them.
  if (!sameStoredDocument(encodeWorkbenchRows(result).sort(compare), [...rows].sort(compare))) throw new Error('Incomplete or incompatible stored document')
  return result
}
const compare = (a: StoredRow, b: StoredRow) => storedRowIdentity(a).localeCompare(storedRowIdentity(b))
export function diffWorkbenchRows(before: StoredRow[], after: StoredRow[]): RowChange[] {
  const previous = new Map(before.map(row => [storedRowIdentity(row), row])), changes: RowChange[] = []
  for (const row of after) {
    const identity = storedRowIdentity(row), old = previous.get(identity)
    if (!old || !sameStoredDocument(old, row)) {
      const identityFields = { collection: row.collection, scope: row.scope, record_key: row.record_key }
      // The verified full baseline and account revision CAS protect this move.
      // Preserve all body/metadata fields; only omit them when position alone changed.
      changes.push(old && sameStoredDocument({ ...old, position: row.position }, row)
        ? { ...identityFields, position: row.position }
        : { ...identityFields, row })
    }
    previous.delete(identity)
  }
  for (const row of previous.values()) changes.push({ collection: row.collection, scope: row.scope, record_key: row.record_key, row: null })
  return changes
}

// PostgreSQL JSONB text adds a space after structural commas/colons and expands
// exponential numbers. Account for that before using the existing 512 KiB RPC
// ceiling; wire JSON bytes alone are not the server's size measurement.
function jsonbTextBytes(json: string, wireBytes: number) {
  let size = wireBytes, quoted = false, escaped = false
  for (let i = 0; i < json.length; i++) {
    const char = json[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === ',' || char === ':') size++
    else if (char === '-' || char >= '0' && char <= '9') {
      const start = i
      while (i + 1 < json.length && /[0-9eE+.\-]/.test(json[i + 1])) i++
      const number = json.slice(start, i + 1), parts = number.toLowerCase().split('e')
      if (parts.length === 2) {
        const sign = parts[0].startsWith('-') ? 1 : 0, mantissa = parts[0].slice(sign)
        const digits = mantissa.replace('.', '').length
        const point = (mantissa.includes('.') ? mantissa.indexOf('.') : mantissa.length) + Number(parts[1])
        const expanded = sign + (point <= 0 ? 2 - point + digits : point >= digits ? point : digits + 1)
        size += Math.max(0, expanded - number.length)
      }
    }
  }
  return size
}

export function chunkRowChanges(changes: RowChange[], maxRows = 200, maxBytes = 256 * 1024) {
  const chunks: RowChange[][] = [], encoder = new TextEncoder(), serverBytes = 512 * 1024
  const singletonServerBytes = 2 * 1024 * 1024
  // Preserve explicit smaller caller limits. Ordinary chunks keep the 256 KiB
  // target; a larger record travels alone within the bounded singleton RPC limit.
  const singletonWireBytes = maxBytes === 256 * 1024 ? singletonServerBytes : Math.min(maxBytes, serverBytes)
  const singletonStageBytes = maxBytes === 256 * 1024 ? singletonServerBytes : serverBytes
  let chunk: RowChange[] = [], wireSize = 2, stageSize = 2
  const flush = () => { if (chunk.length) chunks.push(chunk); chunk = []; wireSize = 2; stageSize = 2 }
  for (const change of changes) {
    const json = JSON.stringify(change), wire = encoder.encode(json).byteLength, stage = jsonbTextBytes(json, wire)
    if (wire + 2 > singletonWireBytes || stage + 2 > singletonStageBytes) {
      throw new Error(`A stored record exceeds the batch limit (${change.collection}, ${stage + 2} JSONB bytes); local backup retained`)
    }
    if (wire + 2 > maxBytes || stage + 2 > serverBytes) { flush(); chunks.push([change]); continue }
    if (chunk.length && (chunk.length >= maxRows || wireSize + 1 + wire > maxBytes || stageSize + 2 + stage > serverBytes)) flush()
    wireSize += wire + (chunk.length ? 1 : 0)
    stageSize += stage + (chunk.length ? 2 : 0)
    chunk.push(change)
  }
  flush()
  return chunks
}
