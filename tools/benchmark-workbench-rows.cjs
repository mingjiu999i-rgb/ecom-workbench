// Local PostgreSQL/WASM benchmark. No production connections or physical I/O claims.
const fs = require('node:fs'), assert = require('node:assert/strict')
const h = require('../tests/rowHarness.cjs')
const { buildWorkbenchDelta } = require('../src/utils/workbenchDelta.ts')
const median = list => [...list].sort((a,b) => a-b)[Math.floor(list.length/2)]
async function run() {
  const doc = h.fixture()
  doc.orderAccountingLedgers = Array.from({ length: 3 }, (_, s) => ({ ...h.json(doc.orderAccountingLedgers[0]), storeId: `s-${s}`,
    orders: Array.from({ length: 13000 }, (_, i) => ({ id: `order-${i}`, date: '2026-10-01', receipt: 100, cancelled: false, quantity: 2, productId: 'p', unitCost: 23.41, supplement: false, extension: 'x'.repeat(512) })) }))
  const db = await h.database()
  try {
    await h.seed(db, doc)
    await db.query('insert into public.workbench_documents(user_id,data) values($1,$2::jsonb)', [h.OTHER, JSON.stringify(doc)])
    await db.exec(`create table public.qa_row_writes(collection text);
      create function public.qa_count_row() returns trigger language plpgsql as $$begin insert into public.qa_row_writes values(new.collection); return new; end$$;
      create trigger qa_count_row after update or insert on public.workbench_rows for each row execute function public.qa_count_row();`)
    const legacy = h.transport(db, h.OTHER), row = h.transport(db)
    let rowRpcMs=0, rowUploadBytes=0, rowCalls=0
    const timed = {...row}
    for(const method of ['begin','stage','commit']) timed[method]=async(...args)=>{
      rowUploadBytes+=Buffer.byteLength(JSON.stringify(args));rowCalls++
      const started=performance.now();try{return await row[method](...args)}finally{rowRpcMs+=performance.now()-started}
    }
    const store = h.createRowWorkbenchStore(timed)
    await store.load()
    let current = doc, revision = (await db.query('select updated_at from public.workbench_documents where user_id=$1', [h.OTHER])).rows[0].updated_at
    const rounds = [], before = (await db.query('select xmin::text as xmin from public.workbench_documents where user_id=$1', [h.OWNER])).rows[0].xmin
    for (let n = 0; n < 5; n++) {
      const next = { ...current, skus: current.skus.map(sku => ({ ...sku, salePrice: 101 + n })) }
      const changes = h.diffWorkbenchRows(h.encodeWorkbenchRows(current), h.encodeWorkbenchRows(next))
      let started = performance.now()
      const delta = buildWorkbenchDelta(current, next)
      const buildMs=performance.now()-started;started=performance.now()
      const response = await legacy.query('select public.save_workbench_delta($1::jsonb,$2,$3) as receipt', [JSON.stringify(delta), revision, crypto.randomUUID()])
      const old_ms = performance.now()-started; revision = response.rows[0].receipt.updated_at
      rowRpcMs=0;rowUploadBytes=0;rowCalls=0
      started = performance.now(); await store.save(next); const rows_end_to_end_ms = performance.now()-started
      rounds.push({ old_rpc_ms: old_ms, old_end_to_end_ms:old_ms+buildMs, rows_end_to_end_ms, rows_rpc_ms:rowRpcMs, old_rpc_calls:1,new_rpc_calls:rowCalls,
        old_rpc_argument_bytes:Buffer.byteLength(JSON.stringify([delta,revision,crypto.randomUUID()])),new_rpc_argument_bytes:rowUploadBytes,
        old_delta_bytes: Buffer.byteLength(JSON.stringify(delta)), new_change_bytes: Buffer.byteLength(JSON.stringify(changes)), changed_business_rows: changes.length })
      current = next
    }
    assert.equal((await db.query('select xmin::text as xmin from public.workbench_documents where user_id=$1', [h.OWNER])).rows[0].xmin, before)
    assert.equal((await db.query('select count(*)::int as n from public.qa_row_writes')).rows[0].n, 5)
    assert.deepEqual(h.json(await h.createRowWorkbenchStore(row).load()), h.json(current))
    const output = { engine: 'PGlite 0.3.14 (isolated PostgreSQL/WASM)', node: process.version, measured_at: new Date().toISOString(), document_bytes: Buffer.byteLength(JSON.stringify(doc)), historical_orders: 39000, rounds,
      median_old_rpc_ms: median(rounds.map(r => r.old_rpc_ms)), median_new_end_to_end_ms: median(rounds.map(r => r.rows_end_to_end_ms)),
      median_old_end_to_end_ms: median(rounds.map(r=>r.old_end_to_end_ms)),median_new_rpc_ms:median(rounds.map(r=>r.rows_rpc_ms)),
      row_business_updates: 5, legacy_document_updates_from_row_path: 0, successful_saves_each_path: 5,
      physical_wal_io_cpu_cloud: 'unavailable; not inferred from request sizes or WASM process RSS' }
    const outputPath = process.argv[2] || 'docs/sync-performance-local.json'
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2)); console.log(JSON.stringify(output, null, 2))
  } finally { await db.close() }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
