const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const h = require('./rowHarness.cjs')
const patch = fs.readFileSync(path.join(h.root, 'supabase/proposals/20261023092148_compact_workbench_positions.sql'), 'utf8')
const original = fs.readFileSync(path.join(h.root, 'supabase/proposals/202610220001_workbench_rows.sql'), 'utf8')
const legacyFunctions = ['stage_workbench_rows', 'commit_workbench_rows'].map(name => original.match(new RegExp(`create function public\\.${name}\\([\\s\\S]*?end \\$\\$;`))[0].replace('create function', 'create or replace function')).join('\n')
const identity = row => ({ collection: row.collection, scope: row.scope, record_key: row.record_key })
const begin = async (a, changes, revision = '0') => {
  const id = crypto.randomUUID(); await a.begin({ id, revision, fingerprint: 'a'.repeat(64), count: changes.length }); return id
}
test('compact moves are emitted only when every field except position is identical', () => {
  const before = h.encodeWorkbenchRows(h.fixture()), row = before.find(r => r.collection === 'a:skus')
  const next = before.map(r => r === row ? { ...r, position: 1 } : r)
  assert.deepEqual(h.diffWorkbenchRows(before, next), [{ ...identity(row), position: 1 }])
  for (const changes of [{ body: { ...row.body, productCost: 88 } }, { store_id: 'other' }, { client_id: 'other' }, { business_date: '2026-10-23' }]) {
    const changed = { ...row, ...changes, position: 1 }
    assert.deepEqual(h.diffWorkbenchRows(before, before.map(r => r === row ? changed : r)), [{ ...identity(row), row: changed }])
  }
})
test('PostgreSQL compact operations retain atomicity, receipts, CAS, account isolation and old payload support', async t => {
  const db = await h.database(); t.after(() => db.close())
  const doc = h.fixture(); doc.todos = [{ id: 'one', title: '一', money: null }, { id: 'two', title: '二', money: 1.2345 }]
  await h.seed(db, doc); await h.seed(db, doc, h.OTHER)
  const a = h.transport(db), rows = h.encodeWorkbenchRows(doc), one = rows.find(r => r.collection === 'a:todos' && r.position === 0), two = rows.find(r => r.collection === 'a:todos' && r.position === 1)
  const move = { ...identity(two), position: 0 }
  await t.test('old server rejects compact stages before committing any business data', async () => {
    await db.exec(legacyFunctions)
    const id = await begin(a, [move]); await assert.rejects(() => a.stage(id, 0, [move]), e => e.code === '22023')
    await assert.rejects(() => a.commit(id), /Incomplete/)
    assert.equal((await a.head()).revision, '0'); await db.exec(patch)
  })
  await t.test('malformed, ambiguous or oversized moves cannot stage', async () => {
    const id = await begin(a, [move])
    for (const value of [{ ...move, position: -1 }, { ...move, position: 0.5 }, { ...move, position: '1' }, { ...move, position: null }, { ...move, position: 1000000000 }, { ...move, row: null }, { ...move, body: {} }, identity(two)]) {
      await assert.rejects(() => a.stage(id, 0, [value]), e => e.code === '22023')
    }
    assert.equal((await db.query('select count(*)::int as n from public.workbench_row_staging where request_id=$1', [id])).rows[0].n, 0)
  })
  await t.test('missing targets abort deletes and all other changes', async () => {
    const changes = [{ ...identity(one), row: null }, { ...move, record_key: '["missing"]' }], id = await begin(a, changes)
    await a.stage(id, 0, changes); await assert.rejects(() => a.commit(id), e => e.code === '40001')
    assert.equal((await db.query('select count(*)::int as n from public.workbench_rows where user_id=$1 and collection=$2', [h.OWNER, 'a:todos'])).rows[0].n, 2)
    assert.equal((await a.head()).revision, '0')
  })
  await t.test('cross-account and unauthenticated stages are refused', async () => {
    const id = await begin(a, [move])
    await assert.rejects(() => h.transport(db, h.OTHER).stage(id, 0, [move]), /Unknown batch/)
    await assert.rejects(() => h.transport(db, null).stage(id, 0, [move]), e => e.code === '42501')
    await assert.rejects(() => a.query('select public.commit_workbench_rows($1)', [id], 'anon'), e => e.code === '42501')
  })
  await db.exec(`create table public.qa_body_touches(n int); create function public.qa_body_touch() returns trigger language plpgsql as $$begin insert into public.qa_body_touches values(1);return new;end$$;
    create trigger qa_body_touch after update of body on public.workbench_rows for each row execute function public.qa_body_touch();`)
  const next = h.json(doc); next.todos.shift(); next.skus[0].name = 'unchanged rules'
  const changes = h.diffWorkbenchRows(rows, h.encodeWorkbenchRows(next)), id = await begin(a, changes)
  await t.test('mixed delete, compact move and full change commit atomically and retry exactly once', async () => {
    await a.stage(id, 0, changes); const bytes = (await db.query('select staged_bytes from public.workbench_row_batches where request_id=$1', [id])).rows[0].staged_bytes
    await a.stage(id, 0, changes)
    assert.equal((await db.query('select staged_bytes from public.workbench_row_batches where request_id=$1', [id])).rows[0].staged_bytes, bytes)
    await assert.rejects(() => a.stage(id, 0, [{ ...changes[0], position: 99 }]), e => e.code === '22023')
    assert.equal(await a.commit(id), '1'); assert.equal(await a.commit(id), '1')
    assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()), next)
    assert.equal((await db.query('select count(*)::int as n from public.qa_body_touches')).rows[0].n, 1)
    assert.deepEqual(h.json(await h.createRowWorkbenchStore(h.transport(db, h.OTHER)).load()), doc)
  })
  await t.test('stale compact batches fail CAS; old receipts cannot revert later data', async () => {
    const stale = await begin(a, [{ ...move, position: 1 }], '1'); await a.stage(stale, 0, [{ ...move, position: 1 }])
    const store = h.createRowWorkbenchStore(a), current = await store.load(); current.todos[0].title = 'newer'; await store.save(current)
    await assert.rejects(() => a.commit(stale), e => e.code === '40001')
    assert.equal(await a.commit(id), '1'); assert.equal((await a.head()).revision, '2')
    assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()), current)
  })
})
