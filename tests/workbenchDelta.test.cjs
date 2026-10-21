const assert=require('node:assert/strict'), {test}=require('node:test'), fs=require('node:fs'), ts=require('typescript')
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,filename)
const {buildWorkbenchDelta}=require('../src/utils/workbenchDelta.ts')
const {describeSyncError}=require('../src/utils/workbenchSync.ts')
const json=value=>JSON.parse(JSON.stringify(value))
function apply(value,delta){
 if(!delta)return value
 if(delta.t==='r')return json(delta.v)
 if(delta.t==='a')return Array.from({length:delta.l},(_,i)=>Object.hasOwn(delta.v,String(i))?apply(value[i],delta.v[String(i)]):value[i])
 const result={...value}; delta.d.forEach(key=>delete result[key]); for(const [key,child] of Object.entries(delta.v))Object.defineProperty(result,key,{value:apply(value[key],child),enumerable:true,writable:true,configurable:true}); return result
}
test('a change in one imported order does not resend other orders, stores, cost snapshots or refunds',()=>{
 const before={orderAccountingLedgers:Array.from({length:3},(_,s)=>({storeId:String(s),orders:Array.from({length:13000},(_,i)=>({id:`${s}-${i}`,unitCost:23,quantity:2,paidAt:'2026-10-01',remarks:'x'.repeat(512)})),refunds:[{id:'existing',amount:30}]})),collectionRecords:[{date:'2026-10-01',shippedRefund:30}],todos:[]}
 const ledger=before.orderAccountingLedgers[1]
 const next={...before,orderAccountingLedgers:before.orderAccountingLedgers.map((item,i)=>i===1?{...item,orders:[...ledger.orders,{id:'new',unitCost:31,quantity:1,paidAt:'2026-10-21'}],refunds:[...ledger.refunds,{id:'new-refund',amount:12}]}:item),collectionRecords:[{date:'2026-10-01',shippedRefund:42}]}
 const delta=buildWorkbenchDelta(before,next), bytes=Buffer.byteLength(JSON.stringify(delta)),fullBytes=Buffer.byteLength(JSON.stringify(next))
 assert(fullBytes>20_000_000); assert(bytes<1500); assert.deepEqual(apply(before,delta),next)
 assert.equal(delta.v.orderAccountingLedgers.v['1'].v.orders.l,13001)
 assert.deepEqual(Object.keys(delta.v.orderAccountingLedgers.v),['1'])
 assert.equal(before.orderAccountingLedgers[1].orders.length,13000)
 console.log(`transport verification: full=${fullBytes} bytes, delta=${bytes} bytes`)
})
test('replacement, insertion, deletion, reordering and truncation retain the exact requested JSON values',()=>{
 const cases=[
 [[1,2,3],[1,3]], [[1,2],[9,1,2]], [[1,2,3],[3,2,1]], [[{id:'a',cost:0},{id:'b',cost:null}],[{id:'b',cost:null}]],
 [{a:1,b:[1,2],drop:9},{a:null,b:[],added:false}], [[1],[1,null]], [[1,2],[]], [[],[{},0,null]],
 [{a:{b:1}}, {a:[]}], [{a:[1]}, {a:{b:0}}], [{a:1,b:undefined},{b:2,c:undefined}],
 [{a:[undefined,NaN,Infinity]},{a:[null,0,null]}],
 [JSON.parse('{"__proto__":{"x":1},"constructor":3}'),JSON.parse('{"__proto__":{"x":2},"constructor":0}')],
  [JSON.parse('{"__proto__":{"x":1},"constructor":3}'),{}],
 ]
 for(const [before,after] of cases)assert.deepEqual(apply(json(before),buildWorkbenchDelta(before,after)),json(after))
})
test('object key ordering and equivalent serialized values do not cause a save',()=>{
 assert.equal(buildWorkbenchDelta({a:[{x:1,y:2}],unused:undefined},{a:[{y:2,x:1}]}),null)
 assert.equal(buildWorkbenchDelta({a:[NaN,undefined,Infinity]},{a:[null,null,null]}),null)
})
test('concurrent cloud edits are a non-retryable conflict and retain the local draft',()=>{
 const failure=describeSyncError({code:'40001',message:'Cloud data changed since loading; local changes retained'})
 assert.equal(failure.retryable,false); assert.match(failure.message,/备份已保留/)
})
let seed=72519
const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32)
function value(depth=0){if(depth>3||random()<0.4)return [null,false,0,23,-1,'订单日期'][Math.floor(random()*6)]; if(random()<0.5)return Array.from({length:Math.floor(random()*5)},()=>value(depth+1));return Object.fromEntries(Array.from({length:Math.floor(random()*5)},(_,i)=>[`key${i}`,value(depth+1)]))}
test('random nested JSON round-trips without interpreting business fields',()=>{for(let i=0;i<350;i++){const before=value(),after=value();assert.deepEqual(apply(before,buildWorkbenchDelta(before,after)),after)}})
function fixture(){
 const raw={clients:[],stores:[],products:[],productCosts:[],productLinks:[],skus:[],collectionRecords:[],todos:[],orderAccountingLedgers:[{orders:[{id:'a',unitCost:23}]}]}, calls=[], replies=[],readReplies=[]
 const client={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>readReplies.shift()||({data:{data:raw,updated_at:'2026-10-21T00:00:00+00:00'},error:null})})}),upsert:()=>{throw Error('unexpected full upload')}}),rpc:(name,args)=>{calls.push({name,args});const promise=Promise.resolve(replies.shift()||{data:{updated_at:'2026-10-21T00:01:00+00:00'},error:null});promise.abortSignal=()=>promise;return promise}}
 const source=fs.readFileSync(require.resolve('../src/services/supabase.ts'),'utf8').replace(/import\.meta\.env/g,'({})')
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,result={exports:{}}
 new Function('require','module','exports',compiled)(name=>name==='@supabase/supabase-js'?{createClient:()=>client}:name==='../data/template'?{initialData:raw}:name.startsWith('../utils/')?require('../src/utils/'+name.slice('../utils/'.length)+'.ts'):require(name),result,result.exports)
 return{service:result.exports,raw,calls,replies,readReplies}
}
test('successful acknowledgement advances the revision and retry of a failed response reuses its request ID',async()=>{
 const {service,raw,calls,replies}=fixture();await service.loadWorkbenchSnapshot('owner')
 const next={...raw,todos:[{id:'a',title:'test'}]};replies.push({error:{message:'Failed to fetch'}})
 await assert.rejects(()=>service.saveWorkbench('owner',next));await service.saveWorkbench('owner',next)
 assert.equal(calls[0].name,'save_workbench_delta');assert.deepEqual(calls[0].args,calls[1].args)
 const later={...next,todos:[{id:'a',title:'after'}]};await service.saveWorkbench('owner',later)
 assert.equal(calls[2].args.p_expected_updated_at,'2026-10-21T00:01:00+00:00')
 assert.notEqual(calls[2].args.p_request_id,calls[1].args.p_request_id)
 assert.deepEqual(apply(next,calls[2].args.p_delta),later)
 await service.saveWorkbench('owner',later);assert.equal(calls.length,3)
})
test('conflicts and malformed acknowledgements never advance the baseline or use a full upload',async()=>{
 const {service,raw,calls,replies}=fixture();await service.loadWorkbenchSnapshot('owner');const next={...raw,todos:[1]}
 replies.push({error:{code:'40001',message:'concurrent edit'}});await assert.rejects(()=>service.saveWorkbench('owner',next),error=>error.code==='40001')
 replies.push({data:{},error:null});await assert.rejects(()=>service.saveWorkbench('owner',next),/missing revision/)
 await service.saveWorkbench('owner',next);assert.deepEqual(calls[0].args,calls[2].args)
})
test('missing new RPC alone uses the previous rollout-safe changed-section RPC',async()=>{
 const {service,raw,calls,replies}=fixture();await service.loadWorkbenchSnapshot('owner');replies.push({error:{code:'PGRST202',message:'missing'}})
 const next={...raw,todos:[1]};await service.saveWorkbench('owner',next)
 assert.equal(calls[1].name,'save_workbench_patch');assert.deepEqual(calls[1].args.p_updates,{todos:[1]})
})
test('restoring a local draft after failed initial loading reads a baseline before a delta save',async()=>{
 const {service,raw,calls}=fixture();const next={...raw,todos:[{id:'new'}]}
 await service.saveWorkbench('owner',next)
 assert.equal(calls[0].name,'save_workbench_delta');assert.deepEqual(apply(raw,calls[0].args.p_delta),next)
})
test('cloud baseline failure preserves the draft instead of making a blind full upload',async()=>{
 const {service,raw,calls,readReplies}=fixture();readReplies.push({error:{message:'Failed to fetch'}})
 await assert.rejects(()=>service.saveWorkbench('owner',{...raw,todos:[1]}));assert.equal(calls.length,0)
})
