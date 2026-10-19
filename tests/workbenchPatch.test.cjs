const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  module._compile(output.outputText, filename)
}
const { buildWorkbenchPatch } = require('../src/utils/workbenchPatch.ts')
const apply = (previous, patch) => { const result = { ...previous }; patch.removed.forEach(key => delete result[key]); return { ...result, ...patch.updates } }

test('editing one todo never includes unchanged historical ledgers or settlement sections', () => {
  const previous = { todos: [{ title: 'before' }], orderAccountingLedgers: [{ orders: Array.from({length:10000},(_,i)=>({id:String(i),unitCost:23})) }], collectionRecords: [{ date: '2026-09-30', shippedRefund: 130 }], profitRecords: [{ amount: 200, estimatedProfit: 47 }] }
  const next = { ...previous, todos: [{ title: 'after' }] }
  const patch = buildWorkbenchPatch(previous, next)
  assert.deepEqual(Object.keys(patch.updates), ['todos'])
  assert.ok(JSON.stringify(patch).length < 200)
  assert.deepEqual(apply(previous, patch), next)
  assert.equal(patch.updates.todos, next.todos)
})

test('unchanged arrays reconstructed after reload are not uploaded again', () => {
  const value = { skus: [{ id:'a',salePrice:49.9 }], orderAccountingLedgers: [{ orders:[{unitCost:23}] }] }
  assert.equal(buildWorkbenchPatch(value, JSON.parse(JSON.stringify(value))).changed, false)
})

test('actual ledger and refund changes are forwarded exactly, never recalculated or discarded', () => {
  const previous = { orderAccountingLedgers: [{ refunds:[{amount:100}] }], collectionRecords:[{date:'2026-09-30',shippedRefund:100}], todos:[] }
  const next = { ...previous, orderAccountingLedgers: [{ refunds:[{amount:130}] }], collectionRecords:[{date:'2026-09-30',shippedRefund:130}] }
  const json = JSON.stringify(next)
  const patch = buildWorkbenchPatch(previous,next)
  assert.deepEqual(Object.keys(patch.updates).sort(), ['collectionRecords','orderAccountingLedgers'])
  assert.deepEqual(apply(previous,patch),next)
  assert.equal(JSON.stringify(next),json)
})

test('new keys, explicit nulls, empty arrays and removed optional fields preserve full-save semantics', () => {
  const previous = { todos:[1], option:7, optional:'remove', existing:null }
  const next = { todos:[], option:null, added:0, existing:null }
  const patch = buildWorkbenchPatch(previous,next)
  assert.deepEqual(apply(previous,patch),next)
  assert.deepEqual(patch.removed,['optional'])
})

test('an ordinary settings edit preserves unrelated server-side additions', () => {
  const previous = { todos:[], skus:[1] }
  const next = { ...previous,todos:[1] }
  const remote = { ...previous, profitRecords:[{estimatedProfit:47}] }
  assert.deepEqual(apply(remote,buildWorkbenchPatch(previous,next)), { ...remote,todos:[1] })
})

test('database JSON key ordering never resends otherwise identical large sections', () => {
  assert.equal(buildWorkbenchPatch({a:[{x:1,y:2}]},{a:[{y:2,x:1}]}).changed,false)
})

function serviceFixture(raw) {
  const writes=[], calls=[], rpcReplies=[]
  const client = {
    from: () => ({
      select: () => ({eq:()=>({maybeSingle:async()=>({data:raw==null?null:{data:raw},error:null})})}),
      upsert: value => { writes.push(value); return Promise.resolve({error:null}) },
    }),
    rpc: (name,args) => { calls.push({name,args}); const reply=rpcReplies.shift()||{error:null}; const result=Promise.resolve(reply); result.abortSignal=()=>result; return result },
  }
  const source=fs.readFileSync(require.resolve('../src/services/supabase.ts'),'utf8').replace(/import\.meta\.env/g,'({})')
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const result={exports:{}}
  const dependency=name=>name==='@supabase/supabase-js'?{createClient:()=>client}:name==='../data/template'?{initialData:{todos:[]}}:name.startsWith('../utils/')?require('../src/utils/'+name.slice('../utils/'.length)+'.ts'):require(name)
  new Function('require','module','exports',compiled)(dependency,result,result.exports)
  return {service:result.exports,writes,calls,rpcReplies}
}

test('save service sends only changed sections and advances its baseline after acknowledgement',async()=>{
  const raw={clients:[],stores:[],products:[],productCosts:[],productLinks:[],skus:[],collectionRecords:[],todos:[],orderAccountingLedgers:[{orders:[{unitCost:23}]}]}
  const {service,writes,calls}=serviceFixture(raw)
  const loaded=await service.loadWorkbenchSnapshot('owner')
  const next={...loaded.storedData,todos:[{title:'test'}]}
  await service.saveWorkbench('owner',next)
  assert.equal(writes.length,0)
  assert.deepEqual(calls[0],{name:'save_workbench_patch',args:{p_updates:{todos:next.todos},p_remove:[]}})
  await service.saveWorkbench('owner',next)
  assert.equal(calls.length,1)
})

test('database errors keep the unsaved baseline for retry and never trigger a second full upload',async()=>{
  const raw={clients:[],stores:[],products:[],productCosts:[],productLinks:[],skus:[],collectionRecords:[],todos:[]}
  const {service,writes,calls,rpcReplies}=serviceFixture(raw)
  await service.loadWorkbenchSnapshot('owner')
  rpcReplies.push({error:{code:'57014',message:'statement timeout'}})
  const next={...raw,todos:[1]}
  await assert.rejects(()=>service.saveWorkbench('owner',next),error=>error.code==='57014')
  await service.saveWorkbench('owner',next)
  assert.equal(writes.length,0)
  assert.deepEqual(calls[0].args,calls[1].args)
})

test('only a missing RPC falls back to the existing full-save transport during rollout',async()=>{
  const raw={clients:[],stores:[],products:[],productCosts:[],productLinks:[],skus:[],collectionRecords:[],todos:[]}
  const {service,writes,rpcReplies}=serviceFixture(raw)
  await service.loadWorkbenchSnapshot('owner')
  rpcReplies.push({error:{code:'PGRST202',message:'function missing'}})
  const next={...raw,todos:[1]}
  await service.saveWorkbench('owner',next)
  assert.equal(writes.length,1)
  assert.equal(writes[0].data,next)
})
