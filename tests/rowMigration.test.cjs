const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process')
const h=require('./rowHarness.cjs'),{prepare}=require('../tools/prepare-workbench-row-migration.cjs')
const {preparePddAccounting}=require('../src/utils/pddLedger.ts')
const {summarizeLinkSales}=require('../src/utils/linkSales.ts')
const {summarizeSpecSales}=require('../src/utils/specSales.ts')
const {grossProfit,calculatedBreakEvenRoi}=require('../src/utils/calculations.ts')
const {normalizeCollectionRefunds}=require('../src/utils/collectionRefunds.ts')

test('lossless migration preserves existing settlement, refund, profit, collection, product ID and yesterday spec results',()=>{
 const doc=h.fixture(),ledger=doc.orderAccountingLedgers[0]
 ledger.orders.push({...ledger.orders[0],id:'cancelled',cancelled:true,receipt:33},{...ledger.orders[0],id:'unshipped',unitCost:null},{...ledger.orders[0],id:'unknown-cost',unitCost:null})
 ledger.refunds.push({id:'unshipped-refund',orderId:'unshipped',success:true,stage:'未发货',amount:100})
 doc.linkSalesOrders[0].date='2026-10-21';doc.linkSalesOrders[0].receipt=100
 doc.linkSalesPromotions=[{storeId:'s',goodsId:'goods',date:'2026-10-21',amount:5.25}]
 const other=h.json(ledger);other.storeId='other';doc.stores.push({...doc.stores[0],id:'other'});doc.orderAccountingLedgers.push(other)
 doc.linkSalesOrders.push({...doc.linkSalesOrders[0],storeId:'other'})
 const metrics=data=>({
  accounting:data.orderAccountingLedgers.map(previous=>preparePddAccounting({storeId:previous.storeId,shop:'店铺',previous,orders:[],refunds:[],funds:[],promotions:previous.promotions.map(row=>({...row,key:row.date,shop:'店铺'})),reportTypes:new Set(),savedRecords:data.collectionRecords,savedProfits:data.profitRecords,products:data.products,resolveCost:()=>({cost:999,productId:'p'}),linkedProductId:()=> 'p'})),
  links:summarizeLinkSales(data,{}),spec:summarizeSpecSales(data,{startDate:'2026-10-21',endDate:'2026-10-21'}),
  normalized:normalizeCollectionRefunds(data.collectionRecords),
  gross:data.skus.map(s=>grossProfit(s)),roi:data.skus.map(s=>calculatedBreakEvenRoi(s.salePrice,s.productCost)),
 })
 const restored=h.decodeWorkbenchRows(prepare(doc).rows)
 assert.deepEqual(h.json(metrics(restored)),h.json(metrics(doc)))
 assert.equal(metrics(restored).accounting[0].summaries.length,1)
 assert.equal(metrics(restored).accounting[0].summaries[0].productCost,null)
 assert.equal(restored.orderAccountingLedgers[0].orders[0].unitCost,23.41)
 assert.equal(restored.orderAccountingLedgers[0].orders.at(-1).unitCost,null)
})

test('offline migration generator is executable in isolated PostgreSQL, preserves old document and refuses stale/repeated imports',async t=>{
 const db=await h.database();t.after(()=>db.close())
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-rows-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}))
 const doc=h.fixture();doc.extension.raw="apostrophe ' and $migration$ and \\ and 中文"
 const bundle=prepare(doc),input=path.join(folder,'bundle.json'),output=path.join(folder,'import.sql')
 fs.writeFileSync(input,JSON.stringify(bundle))
 await db.query('insert into public.workbench_documents(user_id,data) values($1,$2::jsonb)',[h.OWNER,JSON.stringify(doc)])
 const original=(await db.query('select data,updated_at,xmin::text as xmin from public.workbench_documents where user_id=$1',[h.OWNER])).rows[0]
 execFileSync(process.execPath,['tools/write-workbench-row-import.cjs',input,h.OWNER,new Date(original.updated_at).toISOString(),output],{cwd:h.root})
 const sql=fs.readFileSync(output,'utf8');await db.exec(sql)
 assert.equal((await db.query('select mode from public.workbench_heads')).rows[0].mode,'shadow')
 const rows=(await db.query('select * from public.workbench_rows')).rows.map(({user_id,...row})=>row)
 assert.deepEqual(h.json(h.decodeWorkbenchRows(rows)),doc)
 assert.deepEqual((await db.query('select data,updated_at,xmin::text as xmin from public.workbench_documents where user_id=$1',[h.OWNER])).rows[0],original)
 await assert.rejects(()=>db.exec(sql),/not empty/);await db.exec('rollback')
 const stale=path.join(folder,'stale.sql')
 execFileSync(process.execPath,['tools/write-workbench-row-import.cjs',input,h.OTHER,'2000-01-01T00:00:00Z',stale],{cwd:h.root})
 await assert.rejects(()=>db.exec(fs.readFileSync(stale,'utf8')),/Source snapshot changed/);await db.exec('rollback')
})
