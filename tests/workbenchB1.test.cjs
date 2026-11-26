const {test}=require('node:test'),assert=require('node:assert/strict')
const h=require('./rowHarness.cjs')
const {createWorkbenchSync}=require('../src/utils/workbenchSync.ts')
const fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm'),path=require('node:path')

const flush=async()=>{for(let n=0;n<30;n++)await Promise.resolve()}
const until=async predicate=>{for(let n=0;n<200;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5))}assert.fail('state did not settle')}
const failure=(code,status)=>Object.assign(new Error(code),{code,status})
function rig(overrides={},createStore=h.createRowWorkbenchStore){
 const source=h.fixture(),rows=h.encodeWorkbenchRows(source).sort((a,b)=>
  a.collection.localeCompare(b.collection)||a.scope.localeCompare(b.scope)||a.record_key.localeCompare(b.record_key))
 const calls={begin:[],stage:[],commit:[],writes:[],removed:[]}
 let revision='0'
 const transport={
  head:async()=>({mode:'rows',revision}),
  page:async after=>rows.filter(row=>!after||[row.collection,row.scope,row.record_key].join('\0')>after.join('\0')),
  begin:async request=>{calls.begin.push(request);return null},
  stage:async(id,offset,changes)=>{calls.stage.push({id,offset,count:changes.length})},
  commit:async id=>{calls.commit.push(id);revision=String(Number(revision)+1);return revision},
  ...overrides,
 }
 const store=createStore(transport)
 const sync=createWorkbenchSync({userId:'owner',save:(data,signal,onProgress)=>store.save(data,signal,onProgress),
  debounceMs:0,retryDelays:[0,0],storage:{write:async draft=>{calls.writes.push(draft)},remove:async(user,id)=>{calls.removed.push([user,id])}},notify:()=>{}})
 return{source,store,sync,calls,transport,setRevision:value=>{revision=value}}
}
const edit=(source,n)=>({...source,todos:[{id:'todo',title:`edit-${n}`}]})

function inspectableStore(transport){
 const source=fs.readFileSync(path.join(__dirname,'../src/services/rowWorkbenchStore.ts'),'utf8')
 const marker=/  return \{\r?\n    async load\(/
 assert.match(source,marker)
 const instrumented=source.replace(marker,"  return {\n    __debugState: () => structuredClone({ baseline, revision, pending }),\n    async load(")
 const compiled=ts.transpileModule(instrumented,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 const module={exports:{}}
 new Function('require','module','exports',compiled)(name=>name==='./workbenchRows'?require('../src/services/workbenchRows.ts'):require(name),module,module.exports)
 return module.exports.createRowWorkbenchStore(transport)
}

test('begin conflict freezes the original request through ten later edits and manual/online retries',async()=>{
 const r=rig({begin:async request=>{r.calls.begin.push(request);throw failure('PT409',409)}})
 await r.store.load();r.sync.enqueue(edit(r.source,0));await until(()=>r.sync.getState().session==='conflict')
 const pending=r.store.getPendingRequest(),before=r.calls.begin.length
 for(let n=1;n<=10;n++)r.sync.enqueue(edit(r.source,n))
 await until(()=>r.calls.writes.length===11)
 r.sync.retry();r.sync.retry(false);await new Promise(resolve=>setTimeout(resolve,20))
 assert.equal(r.sync.getState().session,'conflict');assert.equal(r.calls.begin.length,before)
 assert.equal(r.calls.stage.length+r.calls.commit.length,0)
 assert.deepEqual(r.store.getPendingRequest(),pending)
 assert.equal(r.calls.writes.at(-1).data.todos[0].title,'edit-10')
 r.sync.dispose()
})

test('commit conflict freezes pending, performs no cleanup and read-only review leaves writer intact',async()=>{
 const r=rig({commit:async id=>{r.calls.commit.push(id);throw failure('40001',409)}},inspectableStore)
 await r.store.load();r.sync.enqueue(edit(r.source,1));await until(()=>r.sync.getState().session==='conflict')
 const before=r.store.__debugState(),counts=[r.calls.begin.length,r.calls.stage.length,r.calls.commit.length]
 const snapshot=await r.store.readOnly()
 assert.deepEqual(snapshot.data,r.source);assert.deepEqual(r.store.__debugState(),before)
 await assert.rejects(()=>r.store.load(),/Unconfirmed changes/)
 r.sync.enqueue(edit(r.source,2));await until(()=>r.calls.writes.length===2)
 assert.deepEqual([r.calls.begin.length,r.calls.stage.length,r.calls.commit.length],counts)
 assert.equal(r.calls.removed.length,0)
 r.sync.dispose()
})

test('504 begin retries the same immutable request, then becomes unconfirmed until manual retry',async()=>{
 let failing=true
 const r=rig({begin:async request=>{r.calls.begin.push(request);if(failing)throw failure('504',504);return null}})
 await r.store.load();r.sync.enqueue(edit(r.source,1));await until(()=>r.sync.getState().session==='unconfirmed')
 assert.equal(r.calls.begin.length,3);assert.equal(new Set(r.calls.begin.map(x=>x.id)).size,1)
 assert.equal(new Set(r.calls.begin.map(x=>x.fingerprint)).size,1)
 r.sync.retry(false);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(r.calls.begin.length,3)
 failing=false;r.sync.retry();await until(()=>r.sync.getState().status==='saved')
 assert.equal(r.calls.begin.length,4);assert.equal(r.calls.begin[3].id,r.calls.begin[0].id)
 r.sync.dispose()
})

test('stage timeout replays only the unconfirmed block; capacity resets block progress without retry',async()=>{
 for(const code of ['504','54000']){
  let failed=false
  const r=rig({stage:async(id,offset,changes)=>{
   r.calls.stage.push({id,offset,count:changes.length})
   if(offset===200&&!failed){failed=true;throw failure(code,code==='504'?504:413)}
  }})
  await r.store.load()
  r.sync.enqueue({...r.source,todos:Array.from({length:450},(_,n)=>({id:`todo-${n}`,title:'new'}))})
  await until(()=>r.sync.getState().status==='saved'||r.sync.getState().session==='capacity')
  if(code==='504'){
   assert.equal(r.sync.getState().status,'saved')
   assert.deepEqual(r.calls.stage.map(x=>x.offset),[0,200,200,400])
   assert.equal(new Set(r.calls.begin.map(x=>x.id)).size,1)
  }else{
   assert.equal(r.sync.getState().session,'capacity')
   assert.equal(r.store.getPendingRequest().offset,0)
   assert.equal(r.store.getPendingRequest().nextChunk,0)
   const count=r.calls.stage.length;r.sync.retry();await new Promise(resolve=>setTimeout(resolve,20))
   assert.equal(r.calls.stage.length,count)
  }
  r.sync.dispose()
 }
})

test('review detects changed cloud revision and adopts a verified snapshot only after recheck',async()=>{
 const r=rig({begin:async request=>{r.calls.begin.push(request);if(r.calls.begin.length===1)throw failure('PT409',409);return null}})
 await r.store.load();r.sync.enqueue(edit(r.source,1));await until(()=>r.sync.getState().session==='conflict')
 const original=r.store.getPendingRequest();r.setRevision('1')
 const review=await r.store.readOnly();r.setRevision('2')
 await assert.rejects(()=>r.store.adoptReview(review,true),e=>e.code==='40001')
 assert.deepEqual(r.store.getPendingRequest(),original);assert.equal(r.store.getAbandonedRequests().length,0)
 r.setRevision('1');await r.store.adoptReview(review,true)
 assert.equal(r.store.getPendingRequest(),null)
 assert.equal(r.store.getAbandonedRequests()[0].id,original.id)
 assert.equal(r.sync.resumeFromReview(),true)
 await until(()=>r.sync.getState().status==='saved')
 assert.equal(r.calls.begin.at(-1).revision,'1')
 assert.notEqual(r.calls.begin.at(-1).id,original.id)
 r.sync.dispose()
})

test('keeping reviewed cloud abandons the request and clears the draft without a write RPC',async()=>{
 const r=rig({begin:async request=>{r.calls.begin.push(request);throw failure('PT409',409)}})
 await r.store.load();r.sync.enqueue(edit(r.source,1));await until(()=>r.sync.getState().session==='conflict')
 const review=await r.store.readOnly(),counts=[r.calls.begin.length,r.calls.stage.length,r.calls.commit.length]
 await r.store.adoptReview(review,true)
 assert.equal(await r.sync.keepCloud(),true)
 assert.equal(r.sync.getState().status,'saved');assert.equal(r.calls.removed.length,1)
 assert.deepEqual([r.calls.begin.length,r.calls.stage.length,r.calls.commit.length],counts)
 assert.equal(r.store.getAbandonedRequests().length,1)
 r.sync.dispose()
})

test('write progress reports acknowledged begin and stages only',async()=>{
 const progress=[]
 const r=rig({stage:async(id,offset,changes)=>{
  r.calls.stage.push({id,offset,count:changes.length})
  if(offset===200)throw failure('54000',413)
 }})
 await r.store.load()
 await assert.rejects(()=>r.store.save({...r.source,todos:Array.from({length:450},(_,n)=>({id:`todo-${n}`,title:'new'}))},undefined,
  event=>progress.push(event)),e=>e.code==='54000')
 assert.deepEqual(progress.map(item=>[item.phase,item.confirmedChunks,item.totalChunks]),[['begin',0,3],['stage',1,3]])
 assert.equal(r.store.getPendingRequest().nextChunk,0)
 r.sync.dispose()
})

test('HTTP-only 409 on commit freezes the request, while a changing read-only version leaves it untouched',async()=>{
 let reads=0
 const r=rig({commit:async()=>{throw failure('23505',409)},head:async()=>({mode:'rows',revision:reads++>2?'1':'0'})})
 await r.store.load();r.sync.enqueue(edit(r.source,1));await until(()=>r.sync.getState().session==='conflict')
 const pending=structuredClone(r.store.getPendingRequest())
 await assert.rejects(()=>r.store.readOnly(),e=>e.code==='40001')
 assert.deepEqual(r.store.getPendingRequest(),pending)
 r.sync.dispose()
})

test('IndexedDB failure remains visible while conflict holds memory edits and clears on a later successful backup',async()=>{
 let fail=true,writes=0
 const r=rig({begin:async request=>{r.calls.begin.push(request);throw failure('PT409',409)}})
 await r.store.load()
 const manager=createWorkbenchSync({userId:'owner',save:(data,signal,progress)=>r.store.save(data,signal,progress),debounceMs:0,retryDelays:[],
  storage:{write:async()=>{writes++;if(fail)throw Error('IndexedDB unavailable')},remove:async()=>{}},notify:()=>{}})
 manager.enqueue(edit(r.source,1));await until(()=>manager.getState().session==='conflict')
 assert.match(manager.getState().backupError,/立即导出/);assert.equal(manager.hasPending(),true)
 fail=false;manager.enqueue(edit(r.source,2));await until(()=>writes===2)
 assert.equal(manager.getState().backupError,'');assert.equal(manager.getState().session,'conflict')
 assert.equal(r.calls.begin.length,1)
 manager.dispose();r.sync.dispose()
})

test('write budget extends with acknowledgements past 120 seconds, stalls at 90 seconds and stops at 10 minutes',async t=>{
 for(const mode of ['progress','idle','maximum'])await t.test(mode,async context=>{
  context.mock.timers.enable({apis:['setTimeout','Date'],now:0})
  let signal,progress,resolve
  const pending=new Promise(done=>{resolve=done})
  const manager=createWorkbenchSync({userId:'owner',debounceMs:0,retryDelays:[],
   save:async(_,provided,onProgress)=>{signal=provided;progress=onProgress;await Promise.race([pending,new Promise((_,reject)=>provided.addEventListener('abort',()=>reject(provided.reason),{once:true}))])},
   storage:{write:async()=>{},remove:async()=>{}},notify:()=>{}})
  context.after(()=>manager.dispose());manager.enqueue({value:1})
  context.mock.timers.tick(0);await flush()
  assert(signal)
  if(mode==='progress'){
   for(let n=0;n<3;n++){context.mock.timers.tick(80000);progress();await flush()}
   assert.equal(signal.aborted,false);resolve();await flush();assert.equal(manager.getState().status,'saved')
  }else if(mode==='idle'){
   context.mock.timers.tick(90000);await flush();assert.equal(signal.aborted,true)
   assert.equal(manager.getState().session,'unconfirmed');assert.match(manager.getState().error.detail,/90000/)
  }else{
   for(let n=0;n<7;n++){context.mock.timers.tick(80000);progress();await flush()}
   context.mock.timers.tick(40000);await flush();assert.equal(signal.aborted,true)
   assert.equal(manager.getState().session,'unconfirmed');assert.match(manager.getState().error.detail,/600000/)
  }
 })
})

test('batch receipt uses only an authenticated RLS SELECT for the exact user and request',async()=>{
 const selections=[],rows=[{request_id:'request-1',expected_revision:7,fingerprint:'abc',operation_count:3,result_revision:8},
  {request_id:'request-1',expected_revision:7,fingerprint:'abc',operation_count:3,result_revision:null},null]
 const client={rpc:()=>{throw Error('begin/RPC probe forbidden')},from:table=>{
  assert.equal(table,'workbench_row_batches')
  const query={select:columns=>{selections.push(['select',columns]);return query},eq:(key,value)=>{selections.push(['eq',key,value]);return query},
   maybeSingle:async()=>({data:rows.shift(),error:null})}
  return query
 }}
 const source=fs.readFileSync(path.join(__dirname,'../src/services/supabase.ts'),'utf8').replace(/import\.meta\.env/g,"({VITE_WORKBENCH_STORAGE:'rows-v1'})")
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 const result={exports:{}}
 new Function('require','module','exports',compiled)(name=>name==='@supabase/supabase-js'?{createClient:()=>client}:
  name==='../data/template'?{initialData:h.fixture()}:name.startsWith('../utils/')?require('../src/utils/'+name.slice(9)+'.ts'):require(name),result,result.exports)
 const read=result.exports.readWorkbenchBatchReceipt
 assert.deepEqual(await read('owner','request-1'),{state:'committed',requestId:'request-1',expectedRevision:'7',fingerprint:'abc',operationCount:3,resultRevision:'8'})
 assert.equal((await read('owner','request-1')).state,'uncommitted')
 assert.equal((await read('owner','request-1')).state,'missing')
 for(let n=0;n<3;n++)assert.deepEqual(selections.slice(n*3,n*3+3),[
  ['select','request_id,expected_revision,fingerprint,operation_count,result_revision'],['eq','user_id','owner'],['eq','request_id','request-1']])
})

test('unconfirmed review blocks complete reading if the read-only receipt query fails',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../src/store/workbench.tsx'),'utf8')
 const start=source.indexOf('  const openSyncReview = useCallback('),end=source.indexOf('\n  const keepReviewedCloud',start)
 assert(start>=0&&end>start)
 const compiled=ts.transpileModule(source.slice(start,end)+'\nexports.openSyncReview=openSyncReview',
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 const events=[],result={exports:{}},request={id:'request-1',revision:'7',fingerprint:'abc',count:3}
 let fail=true,mismatch=false,issue='',review=null,readCalls=0
 const context={exports:result.exports,AbortController,userId:'owner',ownerRef:{current:'owner'},reviewController:{current:null},
  syncRef:{current:{getState:()=>({session:'unconfirmed'})}},useCallback:fn=>fn,
  setReviewBusy:value=>events.push(['busy',value]),setReviewIssue:value=>{issue=value},setSyncReview:value=>{review=value},
  getWorkbenchPendingRequest:async()=>{events.push('pending');return request},
  readWorkbenchBatchReceipt:async()=>{events.push('receipt');if(fail)throw Error('RLS denied');return{state:'uncommitted',requestId:request.id,expectedRevision:'7',fingerprint:mismatch?'wrong':'abc',operationCount:3}},
  readWorkbenchForReview:async()=>{events.push('read');readCalls++;return{revision:'7',data:{},storedData:{}}},
  createWorkbenchReadBudget:()=>({progress(){},dispose(){}}),describeSyncError:error=>({detail:error.message})}
 vm.runInNewContext(compiled,context)
 result.exports.openSyncReview();await flush()
 assert.match(issue,/RLS denied/);assert.equal(readCalls,0);assert.equal(review,null)
 assert.deepEqual(events.filter(x=>typeof x==='string'),['pending','receipt'])
 fail=false;mismatch=true;result.exports.openSyncReview();await flush()
 assert.match(issue,/回执与原请求不一致/);assert.equal(readCalls,0)
 mismatch=false;result.exports.openSyncReview();await flush()
 assert.equal(readCalls,1);assert.equal(review.cloud.revision,'7')
 assert.deepEqual(events.filter(x=>typeof x==='string').slice(4),['pending','receipt','read'])
})
