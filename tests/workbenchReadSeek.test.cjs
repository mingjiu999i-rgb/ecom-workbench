const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const h = require('./rowHarness.cjs')
const read = file => fs.readFileSync(path.join(h.root, 'supabase/proposals', file), 'utf8')
const upgrade = read('20261117020519_seek_workbench_read_pages.sql'), rollback = read('rollback_workbench_read_pages.sql')
const fixture = () => {
  const doc = h.fixture(), base = h.json(doc.orderAccountingLedgers[0])
  doc.extension.raw = 'x'.repeat(400000)
  for (const storeId of ['aaa', 'zzz']) {
    doc.stores.push({ ...doc.stores[0], id: storeId })
    doc.orderAccountingLedgers.push({ ...h.json(base), storeId, funds: Array.from({ length: 901 }, (_, i) => ({ key: 'fund-' + String(i).padStart(5, '0'), income: i % 3 ? i + 0.01 : null, expense: i % 2 ? 0 : -1.2345, memo: '中文"\\:' + 'x'.repeat(i % 60) })) })
  }
  doc.unknownArray = [{ preserve: null }, { preserve: true }]
  return doc
}
const page = async (a, collection, after, limit, bytes) => (await a.query('select * from public.read_workbench_rows_collection_page($1,$2,$3,$4)', [collection, after, limit, bytes])).rows

test('old and seek-based RPCs return identical collections and pages, including byte boundaries, scopes and malformed cursors', async t => {
  const db = await h.database(); t.after(() => db.close()); const doc = fixture(); await h.seed(db, doc)
  const a = h.transport(db), rows = h.encodeWorkbenchRows(doc), fund = rows.filter(r => r.collection === 'ledger.funds').sort((a,b) => a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : a.record_key < b.record_key ? -1 : 1)
  const cursor = row => [row.collection, row.scope, row.record_key]
  const cases = [
    ['ledger.funds', null, 500, 262144], ['ledger.funds', cursor(fund[450]), 7, 32768],
    ['ledger.funds', cursor(fund[899]), 500, 32768], ['ledger.funds', cursor(fund.at(-1)), 500, 262144],
    ['$value', null, 500, 32768], ['$value', null, 0, 0], ['$value', null, null, null],
    ['ledger.funds', [], 500, 262144], ['ledger.funds', ['bad'], 500, 262144],
    ['ledger.funds', ['bad', fund[0].scope, null], 900, 9999999],
    ['a:unknownArray', null, 500, 262144], ['missing', null, 500, 262144], [null, null, 500, 262144],
  ]
  const newCollections = await a.collections(), newPages = []
  for (const args of cases) newPages.push(await page(a, ...args))
  assert(newPages[4].length >= 1); assert(newPages[4][0].body)
  await db.exec(rollback)
  assert.deepEqual(await a.collections(), newCollections)
  for (let i=0; i<cases.length; i++) assert.deepEqual(await page(a, ...cases[i]), newPages[i], JSON.stringify(cases[i]))
  await db.exec(upgrade)
  assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()), doc)
  assert.deepEqual(h.json((await db.query('select data from public.workbench_documents')).rows[0].data), doc)
  assert.equal((await a.head()).revision, '0')
})

test('collection seeking handles unknown collection names, multiple accounts, empty accounts and RLS without definer privileges', async t => {
  const db = await h.database(); t.after(() => db.close()); await h.seed(db, h.fixture()); await h.seed(db, h.fixture(), h.OTHER)
  await db.query("insert into public.workbench_rows(user_id,collection,scope,record_key,position,body) values($1,'extension.future','','new',0,'{}')", [h.OWNER])
  const a=h.transport(db), b=h.transport(db,h.OTHER)
  assert((await a.collections()).includes('extension.future')); assert(!(await b.collections()).includes('extension.future'))
  assert.equal((await page(b,'extension.future',null,500,262144)).length,0)
  assert.deepEqual(await h.transport(db,null).collections(), [])
  assert.deepEqual(await page(h.transport(db,null),'a:skus',null,500,262144), [])
  await assert.rejects(()=>a.query('select public.read_workbench_row_collections()',[],'anon'), e=>e.code==='42501')
  await assert.rejects(()=>a.query("select * from public.read_workbench_rows_collection_page('a:skus')",[],'anon'), e=>e.code==='42501')
  const permissions=(await db.query("select proname,prosecdef from pg_proc where oid in ('public.read_workbench_row_collections()'::regprocedure,'public.read_workbench_rows_collection_page(text,text[],integer,integer)'::regprocedure)")).rows
  assert(permissions.every(p=>p.prosecdef===false))
})

test('read-only rollback preserves the exact complete snapshot and never touches heads, batches or legacy document', async t => {
  const db=await h.database();t.after(()=>db.close());const doc=fixture();await h.seed(db,doc)
  const a=h.transport(db), before=h.json(await h.createRowWorkbenchStore(a).load())
  await db.exec(rollback)
  assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()),before)
  await db.exec(upgrade)
  assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()),doc)
  assert.equal((await a.head()).revision,'0')
  assert.equal((await db.query('select count(*)::integer as n from public.workbench_row_batches')).rows[0].n,0)
})
