const {test}=require('node:test'),assert=require('node:assert/strict')
const h=require('./rowHarness.cjs')
function transportFor(doc,{orphan='',revisionChange=false}={}){
 const rows=h.encodeWorkbenchRows(doc),heads=[];let active=0,max=0,reads=0
 if(orphan)rows.push({collection:'ledger.funds',scope:orphan,record_key:'["extra"]',position:0,body:{key:'extra'},store_id:null,client_id:null,business_date:null})
 const compare=(a,b)=>a.scope<b.scope?-1:a.scope>b.scope?1:a.record_key<b.record_key?-1:a.record_key>b.record_key?1:0
 const groups=new Map();for(const row of rows){const list=groups.get(row.collection)||[];list.push(row);groups.set(row.collection,list)}for(const list of groups.values())list.sort(compare)
 const transport={head:async()=>{heads.push(1);return{mode:'rows',revision:revisionChange&&heads.length>1?'1':'0'}},collections:async()=>[...groups.keys()].sort(),
  collectionPage:async(collection,after)=>{active++;max=Math.max(max,active);reads++;await new Promise(resolve=>setImmediate(resolve));try{return(groups.get(collection)||[]).filter(row=>!after||compare(row,{scope:after[1],record_key:after[2]})>0).slice(0,2)}finally{active--}},
  page:async()=>{throw Error('Unexpected serial fallback')},begin:async()=>{throw Error('Read must not write')},stage:async()=>{},commit:async()=>''}
 return{transport,get max(){return max},get reads(){return reads}}
}
const fixture=()=>{const doc=h.fixture();for(const store of ['a','m','z']){const ledger=h.json(doc.orderAccountingLedgers[0]);ledger.storeId=store;ledger.funds=Array.from({length:11},(_,i)=>({key:'fund-'+i,income:i===0?null:i+0.01,expense:0}));doc.orderAccountingLedgers.push(ledger);doc.stores.push({...doc.stores[0],id:store})}return doc}
test('scope workers reconstruct the exact snapshot across page boundaries and empty ledgers, capped at four concurrent requests',async()=>{
 const doc=fixture();doc.orderAccountingLedgers[1].refunds=[];const io=transportFor(doc),loaded=await h.createRowWorkbenchStore(io.transport).load()
 assert.deepEqual(h.json(loaded),doc);assert.equal(io.max,4);assert(io.reads>20)
})
test('scoped paging never silently drops orphan scopes before, between or after known ledgers',async()=>{
 for(const orphan of ['','["b"]','["zzzz"]']){const io=transportFor(fixture(),{orphan:orphan||'!'})
 await assert.rejects(()=>h.createRowWorkbenchStore(io.transport).load(),/Orphan|Incomplete/)}
})
test('scope scheduling still rejects a version change and never saves a mixed snapshot',async()=>{
 const io=transportFor(fixture(),{revisionChange:true});await assert.rejects(()=>h.createRowWorkbenchStore(io.transport).load(),e=>e.code==='40001')
})
