const { test } = require('node:test'), assert = require('node:assert/strict')
const h = require('./rowHarness.cjs')
test('row codec preserves raw structure, optional values, unknown fields, nulls, order and cross-store IDs', () => {
  const doc = h.fixture(), other = h.json(doc.orderAccountingLedgers[0]); other.storeId = 'other'
  doc.orderAccountingLedgers.push(other); doc.unknownArray = [null, 0, { nested: ['原始'] }]
  doc.orderAccountingLedgers[0].orders.push({ id: 'unknown-cost', unitCost: null, date: 'unknown' })
  const original = h.json(doc), rows = h.encodeWorkbenchRows(doc)
  assert.deepEqual(h.json(h.decodeWorkbenchRows(rows)), original)
  assert.deepEqual(doc, original)
  assert.equal(rows.find(r => r.collection === 'ledger.refunds').business_date, null)
})
test('one SKU edit updates one row; repeat import is a no-op; delete/reorder remain exact', () => {
  const before = h.fixture(), after = h.json(before); after.skus[0].salePrice = 105
  const rows = h.encodeWorkbenchRows(before), next = h.encodeWorkbenchRows(after), changes = h.diffWorkbenchRows(rows, next)
  assert.equal(changes.length, 1); assert.equal(changes[0].collection, 'a:skus')
  assert.equal(h.diffWorkbenchRows(next, h.encodeWorkbenchRows(h.json(after))).length, 0)
  after.orderAccountingLedgers[0].funds.reverse(); after.linkSalesOrders = []; delete after.extension
  assert.deepEqual(h.json(h.decodeWorkbenchRows(h.encodeWorkbenchRows(after))), after)
  assert.throws(() => h.decodeWorkbenchRows(next.filter(row => row.collection !== '$array')), /Incomplete/)
})
test('duplicate business identities stop migration instead of discarding records, oversized records remain local', () => {
  const doc = h.fixture(); doc.orderAccountingLedgers[0].orders.push({ ...doc.orderAccountingLedgers[0].orders[0] })
  assert.throws(() => h.encodeWorkbenchRows(doc), /Duplicate/)
  const changed = h.fixture(); changed.extension.raw = 'x'.repeat(300000)
  assert.throws(() => h.chunkRowChanges(h.diffWorkbenchRows([], h.encodeWorkbenchRows(changed))), /exceeds/)
})

test('progressive startup excludes history, preserves saved overview semantics and cannot be used as a write baseline', async () => {
  const doc = h.fixture()
  doc.profitRecords = [{ id: 'profit', storeId: 's', amount: 12.345 }]
  doc.collectionRecords = [{ id: 'collection', storeId: 's', currentNet: null }]
  const rows = h.encodeWorkbenchRows(doc)
  const allowed = new Set(['$array', '$value', 'a:clients', 'a:stores', 'a:products', 'a:productLinks', 'a:productCosts', 'a:skus', 'a:operations', 'a:skuHistory', 'a:todos', 'a:profitRecords', 'a:collectionRecords', 'a:skuPlanningDrafts', 'a:linkSalesPromotions'])
  const headers = new Set(['clients', 'stores', 'products', 'productLinks', 'productCosts', 'skus', 'operations', 'skuHistory', 'todos', 'profitRecords', 'collectionRecords', 'skuPlanningDrafts', 'linkSalesPromotions'])
  const startupRows = rows.filter(row => allowed.has(row.collection) && (row.collection !== '$array' || headers.has(row.record_key)))
  let startupCalls = 0
  const transport = {
    head: async () => ({ mode: 'rows', revision: '1' }),
    page: async () => { throw new Error('full serial page should not run') },
    startupPage: async after => {
      startupCalls++
      const offset = after ? startupRows.findIndex(row => h.storedRowIdentity(row) === h.storedRowIdentity({ collection: after[0], scope: after[1], record_key: after[2] })) + 1 : 0
      return startupRows.slice(offset, offset + 500)
    },
    begin: async () => null, stage: async () => {}, commit: async () => '2',
  }
  const store = h.createRowWorkbenchStore(transport)
  const startup = await store.load({ profile: 'startup' })
  assert.deepEqual(startup.profitRecords, doc.profitRecords)
  assert.deepEqual(startup.collectionRecords, doc.collectionRecords)
  assert.equal(Object.hasOwn(startup, 'orderAccountingLedgers'), false)
  assert.equal(Object.hasOwn(startup, 'linkSalesOrders'), false)
  assert.equal(startupCalls, 2)
  await assert.rejects(() => store.save(startup), /complete row baseline/)
})

test('real isolated PostgreSQL: schema, role grants, row writes, atomic imports and migration gate', async t => {
  const db = await h.database(); t.after(() => db.close())
  const doc = h.fixture(); await h.seed(db, doc); await h.seed(db, { ...doc, todos: [{ id: 'other', title: 'private' }] }, h.OTHER)
  const a = h.transport(db), b = h.transport(db, h.OTHER)
  const first = h.createRowWorkbenchStore(a)
  assert.deepEqual(h.json(await first.load()), doc)
  await t.test('startup SQL returns only the safe overview projection and cannot save it', async () => {
    const lightweight = h.createRowWorkbenchStore(a)
    const view = await lightweight.load({ profile: 'startup' })
    assert.equal(Object.hasOwn(view, 'orderAccountingLedgers'), false)
    assert.equal(Object.hasOwn(view, 'linkSalesOrders'), false)
    assert.deepEqual(view.clients, doc.clients)
    assert.deepEqual(view.collectionRecords, doc.collectionRecords)
    await assert.rejects(() => lightweight.save(view), /complete row baseline/)
  })
  await t.test('authenticated can read only own account; anon and direct mutation are denied', async () => {
    const result = await a.query('select distinct user_id from public.workbench_rows')
    assert.deepEqual(result.rows, [{ user_id: h.OWNER }])
    assert.equal((await b.query('select * from public.workbench_rows where user_id=$1', [h.OWNER])).rows.length, 0)
    await assert.rejects(() => a.query('select * from public.workbench_rows', [], 'anon'), e => e.code === '42501')
    await assert.rejects(() => a.query("update public.workbench_rows set body='{}'::jsonb"), e => e.code === '42501')
    await assert.rejects(() => h.transport(db, null).begin({ id: crypto.randomUUID(), revision: '0', fingerprint: 'a'.repeat(64), count: 1 }), e => e.code === '42501')
  })
  await db.exec(`create table public.qa_writes(collection text);
    create function public.qa_write() returns trigger language plpgsql as $$ begin insert into public.qa_writes values(new.collection); return new; end $$;
    create trigger qa_write after insert or update on public.workbench_rows for each row execute function public.qa_write();`)
  await t.test('single SKU updates exactly one business row and never rewrites legacy JSONB', async () => {
    const before = await db.query('select xmin::text,data from public.workbench_documents where user_id=$1', [h.OWNER])
    const next = h.json(doc); next.skus[0].salePrice = 105
    await first.save(next); await first.save(next)
    assert.deepEqual((await db.query('select * from public.qa_writes')).rows, [{ collection: 'a:skus' }])
    assert.deepEqual((await db.query('select xmin::text,data from public.workbench_documents where user_id=$1', [h.OWNER])).rows, before.rows)
  })
  await t.test('two devices editing same or different rows conflict without overwriting the winner', async () => {
    for (const section of ['skus', 'todos']) {
      const x = h.createRowWorkbenchStore(a), y = h.createRowWorkbenchStore(a), left = await x.load(), right = await y.load()
      left.skus[0].salePrice++; if (section === 'skus') right.skus[0].salePrice += 2; else right.todos.push({ id: crypto.randomUUID(), title: 'retain local' })
      await x.save(left); await assert.rejects(() => y.save(right), e => e.code === '40001')
      assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()), h.json(left))
      assert.ok(section !== 'todos' || right.todos.length > 0)
    }
  })
  await t.test('lost commit response then newer local edit reuses receipt and never reapplies old changes', async () => {
    let lost = true, commits = 0
    const client = h.createRowWorkbenchStore({ ...a, commit: async id => { commits++; const revision = await a.commit(id); if (lost) { lost = false; throw new TypeError('Failed to fetch') } return revision } })
    const data = await client.load(); data.skus[0].salePrice = 111
    await assert.rejects(() => client.save(data), /fetch/)
    const later = h.json(data); later.todos.push({ id: 'later', title: 'different record' })
    await client.save(later)
    assert.equal(commits, 2) // first commit and new operation; old receipt needs no commit
    assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()), later)
  })
  await t.test('offline/timeout during staging preserves the complete import and leaves no partial business data', async () => {
    let fail = true
    const store = h.createRowWorkbenchStore({ ...a, stage: async (...args) => { await a.stage(...args); if (fail) { fail = false; throw Object.assign(new Error('statement timeout'), { code: '57014' }) } } })
    const original = await store.load(), next = h.json(original)
    next.todos = Array.from({ length: 450 }, (_, i) => ({ id: `batch-${i}`, title: 'new' }))
    next.orderAccountingLedgers[0].orders[0].unitCost = 23.41
    await assert.rejects(() => store.save(next), e => e.code === '57014')
    assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()), h.json(original))
    await store.save(next)
    assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()), next)
  })
  await t.test('incomplete batches, changed retries and cross-account requests cannot commit', async () => {
    const id = crypto.randomUUID(), head = await a.head(), changes = h.diffWorkbenchRows([], h.encodeWorkbenchRows({ todos: [{ id: 'x' }] }))
    const descriptor = { id, revision: head.revision, fingerprint: 'f'.repeat(64), count: changes.length }
    await a.begin(descriptor); await a.stage(id, 0, changes.slice(0, 1))
    await assert.rejects(() => a.commit(id), /Incomplete/)
    await assert.rejects(() => b.commit(id), /Unknown/)
    await assert.rejects(() => a.begin({ ...descriptor, fingerprint: 'a'.repeat(64) }), /reused/)
    const changed = h.json(changes.slice(0, 1)); changed[0].row.body = { changed: true }
    await assert.rejects(() => a.stage(id, 0, changed), /changed payload/)
  })
  await t.test('server enforces chunk and whole-transaction byte limits without partial staging',async()=>{
    const id=crypto.randomUUID(),head=await a.head(),changes=h.diffWorkbenchRows([],h.encodeWorkbenchRows({todos:[{id:'limits'}]}))
    await a.begin({id,revision:head.revision,fingerprint:'c'.repeat(64),count:changes.length})
    await assert.rejects(()=>a.stage(id,0,Array(201).fill(changes[0])),/limits/)
    await db.query('update public.workbench_row_batches set staged_bytes=8388600 where user_id=$1 and request_id=$2',[h.OWNER,id])
    await assert.rejects(()=>a.stage(id,0,changes),e=>e.code==='54000')
    assert.equal((await db.query('select count(*)::int as n from public.workbench_row_staging where user_id=$1 and request_id=$2',[h.OWNER,id])).rows[0].n,0)
  })
  await t.test('paged read detects concurrent revision change and refuses a mixed snapshot', async () => {
    let heads = 0
    const bad = h.createRowWorkbenchStore({ ...a, head: async () => { const head = await a.head(); return { ...head, revision: heads++ ? String(BigInt(head.revision) + 1n) : head.revision } } })
    await assert.rejects(() => bad.load(), e => e.code === '40001')
  })
  await t.test('explicit rows-v1 service routing uses authenticated row RPCs and existing load normalization, with no legacy fallback', async () => {
    const fs=require('node:fs'),ts=require('typescript'),calls=[]
    const client={from:()=>{throw Error('legacy access forbidden')},rpc:(name,args)=>{
      calls.push(name)
      const run=async()=>{
        if(name==='read_workbench_rows_head')return {...await a.head(),user_id:h.OWNER}
        if(name==='read_workbench_rows_page')return a.page(args.p_after)
        if(name==='read_workbench_row_collections')return a.collections()
        if(name==='read_workbench_rows_collection_page')return a.collectionPage(args.p_collection,args.p_after)
        if(name==='read_workbench_rows_startup_page')return a.startupPage(args.p_after)
        if(name==='begin_workbench_rows')return {revision:await a.begin({id:args.p_request_id,revision:args.p_expected_revision,fingerprint:args.p_fingerprint,count:args.p_operation_count})}
        if(name==='stage_workbench_rows')return a.stage(args.p_request_id,args.p_offset,args.p_changes)
        if(name==='commit_workbench_rows')return {revision:await a.commit(args.p_request_id)}
        throw Error('Unexpected RPC')
      }
      const reply=run().then(data=>({data,error:null}),error=>({error}));reply.abortSignal=()=>reply;return reply
    }}
    const source=fs.readFileSync(require.resolve('../src/services/supabase.ts'),'utf8').replace(/import\.meta\.env/g,"({VITE_WORKBENCH_STORAGE:'rows-v1'})")
    const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,result={exports:{}}
    new Function('require','module','exports',compiled)(name=>name==='@supabase/supabase-js'?{createClient:()=>client}:name==='../data/template'?{initialData:h.fixture()}:name==='./rowWorkbenchStore'?require('../src/services/rowWorkbenchStore.ts'):name.startsWith('../utils/')?require('../src/utils/'+name.slice(9)+'.ts'):require(name),result,result.exports)
    const snapshot=await result.exports.loadWorkbenchSnapshot(h.OWNER)
    assert.equal(snapshot.data.stores[0].storeStatus,'启用')
    const next=h.json(snapshot.storedData);next.todos.push({id:'routed',title:'routed'})
    await result.exports.saveWorkbench(h.OWNER,next)
    assert.ok(calls.includes('commit_workbench_rows'))
    assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()),next)
  })
  await t.test('old/offline client direct writes and legacy delta are blocked after cutover', async () => {
    await assert.rejects(() => a.query("update public.workbench_documents set data='{}'::jsonb where user_id=$1", [h.OWNER]), e => e.code === '40001')
    const stamp = (await db.query('select updated_at from public.workbench_documents where user_id=$1', [h.OWNER])).rows[0].updated_at
    await assert.rejects(() => a.query('select public.save_workbench_delta($1::jsonb,$2,$3)', [JSON.stringify({ t: 'r', v: {} }), stamp, crypto.randomUUID()]), e => e.code === '40001')
    await db.query("update public.workbench_heads set mode='frozen' where user_id=$1", [h.OWNER])
    await assert.rejects(() => a.begin({ id: crypto.randomUUID(), revision: '0', fingerprint: 'a'.repeat(64), count: 1 }), e => e.code === '40001')
  })
})
