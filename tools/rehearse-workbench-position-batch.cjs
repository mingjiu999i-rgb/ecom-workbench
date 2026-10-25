// Offline only: no network, credentials, production mutation or implicit merging.
// node tools/rehearse-workbench-position-batch.cjs BEFORE.json AFTER.json OUTPUT.json [CLOUD_FINGERPRINTS.json]
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { performance } = require('node:perf_hooks')
const h = require('../tests/rowHarness.cjs')
const { sameStoredDocument } = require('../src/utils/workbenchRecovery.ts')
async function main() {
  const [beforePath, afterPath, output, fingerprints] = process.argv.slice(2)
  if (!beforePath || !afterPath || !output) throw new Error('Provide before, after and private output paths')
  const before = JSON.parse(fs.readFileSync(beforePath)), after = JSON.parse(fs.readFileSync(afterPath))
  const beforeRows = h.encodeWorkbenchRows(before), afterRows = h.encodeWorkbenchRows(after), previous = new Map(beforeRows.map(r => [h.storedRowIdentity(r), r]))
  const old = []
  for (const row of afterRows) {
    const key = h.storedRowIdentity(row), earlier = previous.get(key)
    if (!earlier || !sameStoredDocument(earlier, row)) old.push({ collection: row.collection, scope: row.scope, record_key: row.record_key, row })
    previous.delete(key)
  }
  for (const row of previous.values()) old.push({ collection: row.collection, scope: row.scope, record_key: row.record_key, row: null })
  const compact = h.diffWorkbenchRows(beforeRows, afterRows), db = await h.database()
  try {
    console.log('Seeding isolated PostgreSQL from verified baseline')
    await h.seed(db, before)
    const liveFingerprint = await db.query(`select collection, count(*)::integer as count,
      md5(string_agg(md5((to_jsonb(r)-'user_id')::text),'' order by scope collate "C",record_key collate "C")) as fingerprint
      from public.workbench_rows r where user_id=$1 group by collection order by collection`, [h.OWNER])
    if (fingerprints) assert.deepEqual(liveFingerprint.rows, JSON.parse(fs.readFileSync(fingerprints)), 'Baseline differs from read-only cloud fingerprints')
    const sql = fs.readFileSync(path.join(h.root, 'supabase/proposals/202610220001_workbench_rows.sql'), 'utf8')
    await db.exec(['stage_workbench_rows', 'commit_workbench_rows'].map(name => sql.match(new RegExp(`create function public\\.${name}\\([\\s\\S]*?end \\$\\$;`))[0].replace('create function', 'create or replace function')).join('\n'))
    const a = h.transport(db), oldId = crypto.randomUUID()
    const oldChunks = h.chunkRowChanges(old), compactChunks = h.chunkRowChanges(compact)
    async function serverBytes(changes) {
      let bytes = 0
      for (let n = 0; n < changes.length; n += 200) bytes += Number((await db.query('select sum(octet_length(value::text)) as bytes from jsonb_array_elements($1::jsonb)', [JSON.stringify(changes.slice(n, n + 200))])).rows[0].bytes)
      return bytes
    }
    const oldBytes = await serverBytes(old), compactBytes = await serverBytes(compact)
    await a.begin({ id: oldId, revision: '0', fingerprint: 'a'.repeat(64), count: old.length })
    let offset = 0, oldError = null
    for (const chunk of oldChunks) {
      try { await a.stage(oldId, offset, chunk); offset += chunk.length } catch (e) { oldError = e.code; break }
    }
    assert.equal(oldError, '54000'); assert.equal((await a.head()).revision, '0')
    const oldPrefixCount = offset
    const stagedPrefix = (await db.query('select staged_bytes,result_revision from public.workbench_row_batches where request_id=$1', [oldId])).rows[0]
    assert.equal(stagedPrefix.result_revision, null)
    const beforeCheck = (await db.query('select collection,count(*)::int as count,md5(string_agg(md5((to_jsonb(r)-\'user_id\')::text),\'\' order by scope collate "C",record_key collate "C")) as fingerprint from public.workbench_rows r where user_id=$1 group by collection order by collection', [h.OWNER])).rows
    assert.deepEqual(beforeCheck, liveFingerprint.rows)
    console.log('Old protocol reproduced 54000; complete live baseline unchanged. Rehearsing compact batch.')
    await db.exec(fs.readFileSync(path.join(h.root, 'supabase/proposals/20261023092148_compact_workbench_positions.sql'), 'utf8'))
    await db.exec(`create table public.qa_body_touches(collection text); create function public.qa_body_touch() returns trigger language plpgsql as $$begin insert into public.qa_body_touches values(new.collection);return new;end$$;
      create trigger qa_body_touch after update of body on public.workbench_rows for each row execute function public.qa_body_touch();
      create function public.qa_legacy_touch() returns trigger language plpgsql as $$begin raise exception 'Legacy document must not be updated';end$$;
      create trigger qa_legacy_touch before update on public.workbench_documents for each row execute function public.qa_legacy_touch();`)
    const id = crypto.randomUUID(), start = performance.now()
    await a.begin({ id, revision: '0', fingerprint: 'b'.repeat(64), count: compact.length })
    offset = 0
    for (const chunk of compactChunks) { await a.stage(id, offset, chunk); offset += chunk.length }
    // Replaying every chunk must not increase byte accounting.
    const bytes = Number((await db.query('select staged_bytes from public.workbench_row_batches where request_id=$1', [id])).rows[0].staged_bytes)
    assert.equal(bytes, compactBytes)
    await a.stage(id, 0, compactChunks[0])
    assert.equal(Number((await db.query('select staged_bytes from public.workbench_row_batches where request_id=$1', [id])).rows[0].staged_bytes), bytes)
    const commitStart = performance.now()
    assert.equal(await a.commit(id), '1'); const commitMs = performance.now() - commitStart
    assert.equal(await a.commit(id), '1'); assert.equal((await a.head()).revision, '1')
    const elapsedMs = performance.now() - start
    const restoredRows = (await db.query('select collection,scope,record_key,position,body,store_id,client_id,business_date from public.workbench_rows where user_id=$1', [h.OWNER])).rows
    assert(sameStoredDocument(h.decodeWorkbenchRows(restoredRows), after), 'Committed document differs from pending snapshot')
    assert.equal((await db.query('select count(*)::int as n from public.qa_body_touches')).rows[0].n, compact.filter(c => c.row).length)
    assert.equal((await db.query('select count(*)::int as n from public.workbench_row_staging where request_id=$1', [oldId])).rows[0].n, oldPrefixCount)
    const report = {
      environment: 'isolated PGlite PostgreSQL; not production performance', cloudBaselineFingerprintsMatch: fingerprints ? true : null,
      beforeRows: beforeRows.length, afterRows: afterRows.length, operations: compact.length,
      moves: compact.filter(c => !Object.hasOwn(c, 'row')).length, fullBodies: compact.filter(c => c.row).length, deletes: compact.filter(c => c.row === null).length,
      old: { stagedBytesTotal: oldBytes, jsonUploadBytes: oldChunks.reduce((n,c)=>n+Buffer.byteLength(JSON.stringify(c)),0), stageRequestsPlanned: oldChunks.length, error: oldError, prefixBytes: Number(stagedPrefix.staged_bytes) },
      compact: { stagedBytesTotal: compactBytes, jsonUploadBytes: compactChunks.reduce((n,c)=>n+Buffer.byteLength(JSON.stringify(c)),0), stageRequests: compactChunks.length, elapsedMs, commitMs },
      exactPendingDocumentMatch: true, legacyDocumentUpdates: 0, bodyUpdates: compact.filter(c => c.row).length,
      stageRetryDidNotIncreaseBytes: true, commitRetryRevisionUnchanged: true, oldFailedBatchPreserved: true,
    }
    fs.writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2))
  } finally { await db.close() }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
