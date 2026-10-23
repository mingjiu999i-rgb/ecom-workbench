const fs = require('node:fs'), ts = require('typescript'), path = require('node:path')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
const { PGlite } = require('@electric-sql/pglite')
const codec = require('../src/services/workbenchRows.ts')
const { createRowWorkbenchStore } = require('../src/services/rowWorkbenchStore.ts')
const OWNER = '00000000-0000-0000-0000-000000000001', OTHER = '00000000-0000-0000-0000-000000000002'
const root = path.resolve(__dirname, '..')
const fixture = () => ({
  clients: [{ id: 'c', name: '甲方', remark: '' }], stores: [{ id: 's', clientId: 'c', name: '店铺', platform: '拼多多', storeStatus: '启用' }],
  products: [{ id: 'p', clientId: 'c', name: '产品', operationRate: 0.02, remark: '' }],
  productLinks: [{ id: 'l', clientId: 'c', storeId: 's', productId: 'p', linkId: 'goods', status: '日销', url: '', remark: '' }],
  productCosts: [{ id: 'cost', productId: 'p', skuCode: 'sku', specification: '1件', totalCost: 99 }],
  skus: [{ id: 'sku', productLinkId: 'l', productCostId: 'cost', salePrice: 100, productCost: 99 }],
  operations: [], skuHistory: [], todos: [], profitRecords: [], collectionRecords: [],
  orderAccountingLedgers: [{ storeId: 's', initializedDates: ['2026-10-01'],
    orders: [{ id: 'same-order', date: '2026-10-01', receipt: 100, cancelled: false, quantity: 2, productId: 'p', unitCost: 23.41, supplement: false }],
    refunds: [{ id: 'refund', orderId: 'same-order', success: true, stage: '已发货', amount: 30 }],
    funds: [{ key: 'fingerprint:1', orderId: 'same-order', income: 100, expense: 0, businessCode: '0010002', category: 'positive' }, { key: 'fingerprint:2', orderId: 'same-order', income: 0, expense: -30, businessCode: '0020002', category: 'refund' }],
    promotions: [{ date: '2026-10-01', amount: 5.25 }],
  }],
  linkSalesOrders: [{ storeId: 's', orderId: 'same-order', goodsId: 'goods', name: '产品', date: null, receipt: null, quantity: 2, status: '', supplement: false, skuCode: 'sku', specification: '1件' }],
  linkSalesPromotions: [], extension: { known: null, zero: 0, raw: '保留未知字段' },
})
async function database() {
  const db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth, public to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;
    insert into auth.users values('${OWNER}'),('${OTHER}');`)
  for (const name of ['202609080001_create_workbench_documents.sql', '202610210001_add_atomic_workbench_delta.sql']) await db.exec(fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8'))
  await db.exec('grant select,insert,update,delete on public.workbench_documents to authenticated;')
  await db.exec(fs.readFileSync(path.join(root, 'supabase/proposals/202610220001_workbench_rows.sql'), 'utf8'))
  await db.exec(fs.readFileSync(path.join(root, 'supabase/proposals/20261023092148_compact_workbench_positions.sql'), 'utf8'))
  return db
}
async function seed(db, doc, uid = OWNER, mode = 'rows') {
  await db.query('insert into public.workbench_documents(user_id,data) values($1,$2::jsonb)', [uid, JSON.stringify(doc)])
  await db.query('insert into public.workbench_heads(user_id,mode) values($1,$2)', [uid, mode])
  const rows = codec.encodeWorkbenchRows(doc)
  for (let n = 0; n < rows.length; n += 200) await db.query(`insert into public.workbench_rows(user_id,collection,scope,record_key,position,body,store_id,client_id,business_date)
    select $1,collection,scope,record_key,position,body,store_id,client_id,business_date from jsonb_to_recordset($2::jsonb)
    as x(collection text,scope text,record_key text,position integer,body jsonb,store_id text,client_id text,business_date text)`, [uid, JSON.stringify(rows.slice(n, n + 200))])
}
function transport(db, uid = OWNER) {
  const query = (sql, args = [], role = 'authenticated') => db.transaction(async tx => {
    await tx.exec(`set local role ${role}`)
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [uid || ''])
    return tx.query(sql, args)
  })
  const rpc = async (sql, args) => (await query(sql, args)).rows[0].value
  return {
    query,
    head: () => rpc('select public.read_workbench_rows_head() as value'),
    page: async after => (await query('select * from public.read_workbench_rows_page($1,500)', [after])).rows.map(({ user_id, ...row }) => row),
    startupPage: async after => (await query('select * from public.read_workbench_rows_startup_page($1,500,262144)', [after])).rows.map(({ user_id, ...row }) => row),
    collections: async () => (await query('select public.read_workbench_row_collections() as value')).rows.map(row => row.value),
    collectionPage: async (collection, after) => (await query('select * from public.read_workbench_rows_collection_page($1,$2,500,262144)', [collection, after])).rows.map(({ user_id, ...row }) => row),
    begin: async r => (await rpc('select public.begin_workbench_rows($1,$2,$3,$4) as value', [r.id, r.revision, r.fingerprint, r.count])).revision,
    stage: async (id, offset, changes) => { await query('select public.stage_workbench_rows($1,$2,$3::jsonb)', [id, offset, JSON.stringify(changes)]) },
    commit: async id => (await rpc('select public.commit_workbench_rows($1) as value', [id])).revision,
  }
}
const json = value => JSON.parse(JSON.stringify(value))
module.exports = { ...codec, createRowWorkbenchStore, database, seed, transport, fixture, OWNER, OTHER, json, root }
