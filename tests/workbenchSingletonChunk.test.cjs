const { test } = require('node:test'), assert = require('node:assert/strict')
const h = require('./rowHarness.cjs')
const LIMIT = 512 * 1024
const SINGLETON_LIMIT = 2 * 1024 * 1024
const change = raw => ({ collection: '$value', scope: '', record_key: 'extension', row: {
  collection: '$value', scope: '', record_key: 'extension', position: 0, body: { raw },
  store_id: null, client_id: null, business_date: null,
} })

test('ordinary chunks retain 200 rows/256 KiB; larger supported records travel alone without reordering', () => {
  const rows = [change('before'), change('中'.repeat(90000)), change('after')]
  const chunks = h.chunkRowChanges(rows)
  assert.deepEqual(chunks.map(c => c.length), [1, 1, 1])
  assert.deepEqual(chunks.flat(), rows)
  const small = Array.from({ length: 405 }, (_, i) => ({ ...change('x'.repeat(2000)), record_key: String(i) }))
  for (const chunk of h.chunkRowChanges(small)) {
    assert(chunk.length <= 200)
    assert(Buffer.byteLength(JSON.stringify(chunk)) <= 256 * 1024)
  }
  assert.throws(() => h.chunkRowChanges([change('x'.repeat(1000))], 200, 500), /exceeds/)
  const observation = change('x'.repeat(533 * 1024))
  observation.record_key = observation.row.record_key = 'overviewRefundActivity'
  assert.deepEqual(h.chunkRowChanges([observation]), [[observation]])
})

test('PostgreSQL measures exact 2 MiB singleton boundary, Unicode, escapes and exponential numeric expansion', async t => {
  const db = await h.database(); t.after(() => db.close())
  await h.seed(db, h.fixture()); const a = h.transport(db)
  const stageBytes = async changes => Number((await db.query('select octet_length($1::jsonb::text) as bytes', [JSON.stringify(changes)])).rows[0].bytes)
  const base = change(''), oldPadding = LIMIT - await stageBytes([base]), oldExact = change('x'.repeat(oldPadding))
  assert.equal(await stageBytes([oldExact]), LIMIT)
  const id = crypto.randomUUID()
  await a.begin({ id, revision: '0', fingerprint: 'a'.repeat(64), count: 1 }); await a.stage(id, 0, [oldExact])
  const padding = SINGLETON_LIMIT - await stageBytes([base]), exact = change('x'.repeat(padding))
  assert.equal(await stageBytes([exact]), SINGLETON_LIMIT)
  assert.deepEqual(h.chunkRowChanges([exact]), [[exact]])
  assert.throws(() => h.chunkRowChanges([change('x'.repeat(padding + 1))]), /exceeds/)
  for (const raw of ['中:,"\\\n'.repeat(30000), 'text \\"1e+300,:' .repeat(20000)]) {
    const chunks = h.chunkRowChanges([change(raw)])
    assert(await stageBytes(chunks[0]) <= SINGLETON_LIMIT)
  }
  const numeric = change('x'.repeat(270000)); numeric.row.body.numbers = Array(1000).fill(1e300)
  assert(Buffer.byteLength(JSON.stringify([numeric])) < LIMIT)
  assert(await stageBytes([numeric]) > LIMIT)
  assert.deepEqual(h.chunkRowChanges([numeric]), [[numeric]])
  const compactNumeric = change(''); compactNumeric.row.body.numbers = Array(1800).fill(1e300)
  assert(Buffer.byteLength(JSON.stringify([compactNumeric])) < 256 * 1024)
  assert(await stageBytes([compactNumeric]) > LIMIT)
  assert.deepEqual(h.chunkRowChanges([compactNumeric]), [[compactNumeric]])
  const many = Array.from({ length: 405 }, (_, i) => ({ ...change('x'.repeat(2000)), record_key: String(i) }))
  for (const chunk of h.chunkRowChanges(many)) {
    if (chunk.length > 1) {
      assert(Buffer.byteLength(JSON.stringify(chunk)) <= 256 * 1024)
      assert(await stageBytes(chunk) <= LIMIT)
    }
  }
})

test('large observation plus ordinary edits remains atomic through an interrupted stage and receipt retry', async t => {
  const db = await h.database(); t.after(() => db.close())
  const doc = h.fixture(); await h.seed(db, doc)
  const a = h.transport(db), originalLegacy = (await db.query('select data,updated_at from public.workbench_documents')).rows
  let fail = true, stages = 0, commits = 0
  const store = h.createRowWorkbenchStore({ ...a,
    stage: async (...args) => { if (++stages === 2 && fail) { fail = false; throw new Error('network offline') }; return a.stage(...args) },
    commit: async id => { commits++; return a.commit(id) },
  })
  await store.load()
  const next = h.json(doc); next.skus[0].name = 'test'; next.extension.raw = 'x'.repeat(270000)
  await assert.rejects(() => store.save(next), /offline/)
  assert.equal((await a.head()).revision, '0')
  assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()), doc)
  await store.save(next)
  assert.equal((await a.head()).revision, '1'); assert.equal(commits, 1)
  assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()), next)
  assert.deepEqual((await db.query('select data,updated_at from public.workbench_documents')).rows, originalLegacy)
})

test('singleton support does not raise the 8 MiB atomic cap or commit a partial large import', async t => {
  const db = await h.database(); t.after(() => db.close())
  const doc = h.fixture(); await h.seed(db, doc)
  const a = h.transport(db), store = h.createRowWorkbenchStore(a); await store.load()
  const next = h.json(doc); next.todos = Array.from({ length: 17 }, (_, i) => ({ id: String(i), raw: 'x'.repeat(500000) }))
  await assert.rejects(() => store.save(next), e => e.code === '54000')
  assert.equal((await a.head()).revision, '0')
  assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()), doc)
  await assert.rejects(() => store.load(), /Unconfirmed changes/)
  const batch = (await db.query('select staged_bytes,result_revision from public.workbench_row_batches')).rows[0]
  assert(Number(batch.staged_bytes) <= 8388608); assert.equal(batch.result_revision, null)
})
