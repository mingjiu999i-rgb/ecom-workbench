const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const h = require('./rowHarness.cjs')
const proposal = fs.readFileSync(path.join(h.root, 'supabase/proposals/20261116024422_deduplicate_workbench_staging_identity.sql'), 'utf8')
const legacy = fs.readFileSync(path.join(h.root, 'supabase/proposals/20261023092148_compact_workbench_positions.sql'), 'utf8')
const identity = row => ({ collection: row.collection, scope: row.scope, record_key: row.record_key })
const begin = async (a, changes) => { const id = crypto.randomUUID(); await a.begin({ id, revision: '0', count: changes.length, fingerprint: 'a'.repeat(64) }); return id }

test('staging removes only duplicate identity, preserves body and metadata, and existing commit stays lossless', async t => {
  const db = await h.database(); t.after(() => db.close())
  const doc = h.fixture(); doc.todos = [{ id: 'a' }, { id: 'b' }]; await h.seed(db, doc)
  const next = h.json(doc); next.todos.reverse(); next.todos.pop()
  next.skus[0].name = 'edited'; next.skus[0].nested = { collection: 'body field', scope: 'must survive', record_key: null, amount: 1.23456 }
  const a = h.transport(db), changes = h.diffWorkbenchRows(h.encodeWorkbenchRows(doc), h.encodeWorkbenchRows(next)), id = await begin(a, changes)
  await a.stage(id, 0, changes)
  const staged = (await db.query('select * from public.workbench_row_staging order by operation_index')).rows
  for (const [i, s] of staged.entries()) {
    assert.deepEqual(identity(s), identity(changes[i])); assert.equal(Object.hasOwn(s.operation, 'collection'), false)
    if (s.operation.row) {
      const { collection, scope, record_key, ...payload } = changes[i].row
      assert.deepEqual(s.operation.row, payload)
    } else if (changes[i].row === null) assert.deepEqual(s.operation, { row: null })
    else assert.deepEqual(s.operation, { position: changes[i].position })
  }
  const bytes = (await db.query('select staged_bytes from public.workbench_row_batches where request_id=$1', [id])).rows[0].staged_bytes
  assert.equal(Number(bytes), Number((await db.query('select sum(octet_length(operation::text)) as bytes from public.workbench_row_staging')).rows[0].bytes))
  await a.stage(id, 0, changes); assert.equal((await db.query('select staged_bytes from public.workbench_row_batches where request_id=$1', [id])).rows[0].staged_bytes, bytes)
  assert.equal(await a.commit(id), '1'); assert.equal(await a.commit(id), '1')
  assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()), next)
  assert.deepEqual(h.json((await db.query('select data from public.workbench_documents')).rows[0].data), doc)
})

test('replay still rejects identity, metadata, body and unknown-field changes and cross-account staging', async t => {
  const db = await h.database(); t.after(() => db.close()); await h.seed(db, h.fixture()); await h.seed(db, h.fixture(), h.OTHER)
  const a = h.transport(db), row = h.encodeWorkbenchRows(h.fixture()).find(r => r.collection === 'a:skus'), change = { ...identity(row), row }, id = await begin(a, [change])
  await a.stage(id, 0, [change])
  for (const field of ['collection', 'scope', 'record_key']) {
    const changed = h.json(change); changed[field] += 'different'; changed.row[field] = changed[field]
    await assert.rejects(() => a.stage(id, 0, [changed]), e => e.code === '22023')
  }
  for (const changed of [{ ...change, extra: true }, { ...change, row: { ...row, store_id: 'other' } }, { ...change, row: { ...row, body: { changed: true } } }]) {
    await assert.rejects(() => a.stage(id, 0, [changed]), e => e.code === '22023')
  }
  await assert.rejects(() => h.transport(db, h.OTHER).stage(id, 0, [change]), /Unknown batch/)
  await assert.rejects(() => h.transport(db, null).stage(id, 0, [change]), e => e.code === '42501')
  await assert.rejects(() => a.query('select public.stage_workbench_rows($1,0,$2::jsonb)', [id, JSON.stringify([change])], 'anon'), e => e.code === '42501')
})

test('old oversized pending batch resumes under same request ID, preserves atomicity, byte accounting and lost-response receipt', async t => {
  const db = await h.database(); t.after(() => db.close()); await db.exec(legacy)
  const doc = h.fixture(); await h.seed(db, doc)
  const next = h.json(doc); next.todos = Array.from({ length: 14022 }, (_, i) => ({ id: 'record-' + 'x'.repeat(140) + i, raw: 'y'.repeat(125), costSnapshot: 23.41 }))
  const a = h.transport(db); let commits = 0, lost = true
  const store = h.createRowWorkbenchStore({ ...a, commit: async id => { const result = await a.commit(id); commits++; if (lost) { lost = false; throw new Error('response lost') }; return result } })
  await store.load(); await assert.rejects(() => store.save(next), e => e.code === '54000')
  const before = (await db.query('select * from public.workbench_row_batches')).rows[0]
  assert.equal((await a.head()).revision, '0'); assert.equal(before.result_revision, null)
  assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()), doc)
  await db.exec(proposal)
  await assert.rejects(() => store.save(next), /response lost/)
  const after = (await db.query('select * from public.workbench_row_batches')).rows[0]
  assert.equal(after.request_id, before.request_id); assert.equal(after.fingerprint, before.fingerprint)
  assert.equal(Number(after.result_revision), 1); assert(Number(after.staged_bytes) < Number(before.staged_bytes)); assert(Number(after.staged_bytes) <= 8388608)
  const latest = h.json(next); latest.extension.queuedAfterFailure = 'must survive'
  await store.save(latest); assert.equal(commits, 2); assert.equal((await a.head()).revision, '2')
  assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()), latest)
  const receipts = (await db.query('select operation_count,result_revision from public.workbench_row_batches order by result_revision')).rows
  assert.deepEqual(receipts.map(r => [r.operation_count, Number(r.result_revision)]), [[14022, 1], [1, 2]])
})

test('a rejected chunk rolls back legacy normalization and counters, and CAS still prevents stale commit', async t => {
  const db = await h.database(); t.after(() => db.close()); await db.exec(legacy)
  const doc = h.fixture(); await h.seed(db, doc)
  const a = h.transport(db), next = h.json(doc); next.todos = [{ id: 'first' }, { id: 'second', raw: 'x'.repeat(3000) }]
  const changes = h.diffWorkbenchRows(h.encodeWorkbenchRows(doc), h.encodeWorkbenchRows(next)), id = await begin(a, changes)
  await a.stage(id, 0, changes.slice(0, 1))
  const old = (await db.query('select operation from public.workbench_row_staging')).rows[0].operation
  await db.query('update public.workbench_row_batches set staged_bytes=8388600 where request_id=$1', [id])
  await db.exec(proposal)
  await assert.rejects(() => a.stage(id, 0, changes), e => e.code === '54000')
  assert.deepEqual((await db.query('select operation from public.workbench_row_staging')).rows[0].operation, old)
  assert.equal(Number((await db.query('select staged_bytes from public.workbench_row_batches')).rows[0].staged_bytes), 8388600)
  await db.query('update public.workbench_row_batches set staged_bytes=octet_length($2::jsonb::text) where request_id=$1', [id, JSON.stringify(old)])
  await a.stage(id, 0, changes)
  const winner = h.createRowWorkbenchStore(a), newer = await winner.load(); newer.skus[0].name = 'winner'; await winner.save(newer)
  await assert.rejects(() => a.commit(id), e => e.code === '40001')
  assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()), newer)
})
