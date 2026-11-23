const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const h=require('./rowHarness.cjs');
const read=name=>fs.readFileSync(path.join(h.root,'supabase/proposals',name),'utf8');
const proposal=read('compact_workbench_staging_rows.sql'),rollback=read('rollback_compact_workbench_staging_rows.sql');
const identity=r=>({collection:r.collection,scope:r.scope,record_key:r.record_key});
async function begin(a,count){const id=crypto.randomUUID();await a.begin({id,count,revision:(await a.head()).revision,fingerprint:'a'.repeat(64)});return id}
function unpack(s){
 if(!Array.isArray(s.operation.row))return s.operation;
 const [position,body,store,client,date,flags,extras]=s.operation.row,row={...extras,position,body};
 if(flags&1)row.store_id=flags&8?body.storeId:flags&16?JSON.parse(s.scope)[0]:store;
 if(flags&2)row.client_id=flags&32?body.clientId:client;
 if(flags&4)row.business_date=flags&64?body.date:date;
 return {...s.operation,row};
}
test('tuple staging preserves exact payloads, optional keys, metadata overrides, nested values and future fields',async t=>{
 const db=await h.database();t.after(()=>db.close());const doc=h.fixture();await h.seed(db,doc);await db.exec(proposal);const a=h.transport(db);
 const cases=[
  {body:{storeId:'s',clientId:'c',date:'2026-11-18',amount:0.123456,raw:['',null,{nested:'中文\\"'}]},store_id:'s',client_id:'c',business_date:'2026-11-18'},
  {body:{storeId:'s',clientId:'c',date:'2026-11-18'},store_id:'override',client_id:'override',business_date:'override',unknown:{preserve:null}},
  {body:null}, {body:0,store_id:null,client_id:null,business_date:null},
  {body:[null,0,'x'],store_id:'scope-store',client_id:0,business_date:{raw:'x'}},
  {body:{storeId:null,clientId:null,date:null},store_id:null,client_id:null},
  {body:'raw',store_id:'包含\\"中文',business_date:''},
 ];
 const changes=cases.map((payload,i)=>{const row={collection:'extension.future',scope:JSON.stringify([payload.store_id]),record_key:JSON.stringify([i]),position:i,...payload};return {...identity(row),row,unknownTop:{kept:true}}});
 const id=await begin(a,changes.length);await a.stage(id,0,changes);
 const staged=(await db.query('select * from public.workbench_row_staging order by operation_index')).rows;
 for(let i=0;i<changes.length;i++){
  const {collection,scope,record_key,...row}=changes[i].row;
  assert.deepEqual(unpack(staged[i]),{row,unknownTop:{kept:true}});
 }
 assert(staged[0].operation.row[5]&8);assert(staged[0].operation.row[5]&32);assert(staged[0].operation.row[5]&64);
 assert(staged[4].operation.row[5]&16);
 await a.stage(id,0,changes);
 for(const mutation of [c=>{c.row.store_id='other'},c=>{delete c.row.client_id},c=>{c.row.body={changed:true}},c=>{c.row.unknown=true},c=>{c.record_key='different';c.row.record_key='different'}]){
  const change=h.json(changes[0]);mutation(change);await assert.rejects(()=>a.stage(id,0,[change]),e=>e.code==='22023');
 }
 await assert.rejects(()=>a.stage(id,0,[{...identity(changes[0]),row:staged[0].operation.row}]),e=>e.code==='22023');
 await assert.rejects(()=>h.transport(db,h.OTHER).stage(id,0,[changes[0]]),/Unknown batch/);
 await assert.rejects(()=>h.transport(db,null).stage(id,0,[changes[0]]),e=>e.code==='42501');
 await assert.rejects(()=>a.query('select public.stage_workbench_rows($1,0,$2::jsonb)',[id,JSON.stringify([changes[0]])],'anon'),e=>e.code==='42501');
 const byteCounter=(await db.query('select staged_bytes from public.workbench_row_batches where request_id=$1',[id])).rows[0].staged_bytes;
 assert.equal(Number(byteCounter),Number((await db.query('select sum(octet_length(operation::text)) bytes from public.workbench_row_staging')).rows[0].bytes));
 assert.equal(await a.commit(id),'1');assert.equal(await a.commit(id),'1');
 const stored=(await db.query("select * from public.workbench_rows where collection='extension.future' order by position")).rows;
 for(let i=0;i<stored.length;i++){
  assert.deepEqual(stored[i].body,cases[i].body);
  for(const field of ['store_id','client_id','business_date']){
   const value=cases[i][field];const expected=value==null?null:typeof value==='object'?JSON.stringify(value).replace(':',': '):String(value);
   assert.equal(stored[i][field],expected);
  }
 }
 assert.deepEqual(h.json((await db.query('select data from public.workbench_documents')).rows[0].data),doc);
});

test('mixed legacy and tuple staging commits atomically; guarded rollback never strands a new-format batch',async t=>{
 const db=await h.database();t.after(()=>db.close());const doc=h.fixture();await h.seed(db,doc);const a=h.transport(db),next=h.json(doc);next.skus[0].salePrice=123.456;next.todos=[{id:'new',title:'keep'}];
 const changes=h.diffWorkbenchRows(h.encodeWorkbenchRows(doc),h.encodeWorkbenchRows(next)),id=await begin(a,changes.length);
 await a.stage(id,0,changes.slice(0,1));await db.exec(proposal);await a.stage(id,1,changes.slice(1));
 assert.equal((await a.head()).revision,'0');assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()),doc);
 await assert.rejects(()=>db.exec(rollback),/Uncommitted tuple/);await db.exec('rollback;');
 assert.equal(await a.commit(id),'1');assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()),next);
 await db.exec(rollback);const following=h.createRowWorkbenchStore(a),value=await following.load();value.skus[0].remark='rollback compatible';await following.save(value);
 assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()),value);
});

test('an old prefix normalizes under the same batch ID and exact retry payload checks',async t=>{
 const db=await h.database();t.after(()=>db.close());await h.seed(db,h.fixture());const a=h.transport(db);
 const changes=Array.from({length:401},(_,i)=>{const row={collection:'extension.future',scope:'["s"]',record_key:JSON.stringify([i]),position:i,body:{storeId:'s',date:'2026-11-18',income:1.2345},store_id:'s',client_id:null,business_date:'2026-11-18'};return {...identity(row),row}});
 const id=await begin(a,changes.length);await a.stage(id,0,changes.slice(0,200));const before=(await db.query('select staged_bytes from public.workbench_row_batches where request_id=$1',[id])).rows[0].staged_bytes;
 await db.exec(proposal);await a.stage(id,0,changes.slice(0,200));const after=(await db.query('select staged_bytes from public.workbench_row_batches where request_id=$1',[id])).rows[0].staged_bytes;assert(Number(after)<Number(before));
 await a.stage(id,200,changes.slice(200,400));await assert.rejects(()=>a.commit(id),/Incomplete/);assert.equal((await a.head()).revision,'0');
 await a.stage(id,400,changes.slice(400));assert.equal(await a.commit(id),'1');
});

test('8 MiB limit and account revision conflicts still leave zero partial business writes',async t=>{
 const db=await h.database();t.after(()=>db.close());const doc=h.fixture();await h.seed(db,doc);await db.exec(proposal);const a=h.transport(db);
 const changes=Array.from({length:90},(_,i)=>{const row={collection:'extension.future',scope:'',record_key:JSON.stringify([i]),position:i,body:'x'.repeat(100000),store_id:null,client_id:null,business_date:null};return {...identity(row),row}});
 const id=await begin(a,changes.length);let failed=false;
 for(let i=0;i<changes.length;i+=2){try{await a.stage(id,i,changes.slice(i,i+2))}catch(e){assert.equal(e.code,'54000');failed=true;break}}
 assert(failed);assert.equal((await a.head()).revision,'0');assert.equal((await db.query("select count(*) n from public.workbench_rows where collection='extension.future'")).rows[0].n,0);
 const winner=h.createRowWorkbenchStore(a),data=await winner.load();data.skus[0].remark='winner';await winner.save(data);
 await assert.rejects(()=>a.commit(id),e=>e.code==='40001');assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()),data);
});

test('a lost stage acknowledgement replays only the unconfirmed chunk and retains queued edits',async t=>{
 const db=await h.database();t.after(()=>db.close());const doc=h.fixture();await h.seed(db,doc);await db.exec(proposal);const a=h.transport(db),calls=[];let lose=true;
 const store=h.createRowWorkbenchStore({...a,stage:async(id,offset,changes)=>{calls.push({id,offset});await a.stage(id,offset,changes);if(offset===200&&lose){lose=false;throw new DOMException('timeout','TimeoutError')}}});
 await store.load();const first=h.json(doc);first.todos=Array.from({length:501},(_,i)=>({id:'id'+i,title:'entry'}));
 await assert.rejects(()=>store.save(first),/timeout/);assert.equal((await a.head()).revision,'0');const queued=h.json(first);queued.skus[0].remark='later edit';await store.save(queued);
 assert.deepEqual(calls.slice(0,4).map(c=>c.offset),[0,200,200,400]);assert.equal(new Set(calls.slice(0,4).map(c=>c.id)).size,1);
 assert.deepEqual(h.json(await h.createRowWorkbenchStore(a).load()),queued);assert.equal((await a.head()).revision,'2');
});
