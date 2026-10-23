const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript')
require('./rowHarness.cjs')
const {inspectWorkbenchRecovery,isResolvedDraft}=require('../src/utils/workbenchRecovery.ts')
const {describeSyncError}=require('../src/utils/workbenchSync.ts')
// Execute the actual account-loading effect with a virtual clock and transport.
// This covers the pending-draft branch, rather than testing a copied timeout rule.
const source=fs.readFileSync(path.join(__dirname,'../src/store/workbench.tsx'),'utf8')
const start=source.indexOf('  useEffect(() => {\n    ownerRef.current = userId')
const end=source.indexOf('\n  }, [userId])',start)
assert(start>=0&&end>start)
const body=source.slice(start+'  useEffect(() => {'.length,end)
const compiled=ts.transpileModule('function runAccountLoad(){'+body+'\n}',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
async function harness({draft=true,delay=45000,error=null,different=false}={}){
 let now=0,id=0,cleanup=0,request
 const timers=new Map(),state={},raw={clients:[],stores:[],products:[],productCosts:[],productLinks:[],skus:[],orders:[{id:'retained',unitCost:null,amount:12.34}]}
 const local=draft?{id:'draft',userId:'owner',updatedAt:'2026-10-23T02:14:21Z',data:structuredClone(raw)}:null
 const before=JSON.stringify(local),context={AbortController,DOMException,console,userId:'owner',inspectWorkbenchRecovery,isResolvedDraft,describeSyncError}
 const setTimer=(fn,ms)=>{timers.set(++id,{at:now+ms,fn});return id}
 Object.assign(context,{setTimeout:setTimer,clearTimeout:n=>timers.delete(n),window:{addEventListener(){},removeEventListener(){}},
  readWorkbenchDraft:async()=>local,writeWorkbenchDraft:async()=>{},removeWorkbenchDraft:async()=>{},acknowledgeWorkbenchDraft:async()=>{},saveWorkbench:async()=>{throw Error('Must not save during read')},
  createWorkbenchSync:()=>({retry(){},hasPending:()=>false,dispose(){},clearResolvedDraft:async()=>{cleanup++;return true}}),
  loadWorkbenchSnapshot:(_owner,options)=>{request=options;return new Promise((resolve,reject)=>{
   options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true})
   setTimer(()=>error?reject(error):resolve({data:structuredClone(raw),storedData:different?{...raw,changed:true}:raw,complete:true}),delay)
  })},
 })
 for(const name of ['ownerRef','completeRef','hydrateRef','hydrateController','dataRef','syncRef','loadController'])context[name]={current:null}
 for(const name of ['Complete','FullLoadError','Data','Recovery','LoadedOwner','CloudLoading','LoadDetail','Differences','RecoveryIssue','Resolving','LoadError','SyncState'])context['set'+name]=value=>{state[name]=value}
 vm.createContext(context);vm.runInContext(compiled,context);const dispose=context.runAccountLoad()
 const flush=async()=>{for(let n=0;n<12;n++)await Promise.resolve()}
 await flush()
 const advance=async ms=>{const target=now+ms;for(;;){let selected;for(const [n,t]of timers)if(t.at<=target&&(!selected||t.at<selected[1].at))selected=[n,t];if(!selected)break;now=selected[1].at;timers.delete(selected[0]);selected[1].fn();await flush()}now=target;await flush()}
 return{advance,state,local,before,get request(){return request},get cleanup(){return cleanup},dispose}
}
test('a pending draft survives 30 seconds and is compared only after a healthy complete read',async()=>{
 const h=await harness();assert.equal(h.request.profile,'full')
 await h.advance(31000);assert.equal(h.request.signal.aborted,false);assert.equal(h.cleanup,0);assert.equal(JSON.stringify(h.local),h.before)
 await h.advance(14000);assert.equal(h.request.signal.aborted,false);assert.equal(h.state.Complete,true);assert.equal(h.state.Recovery,null);assert.equal(h.cleanup,1);h.dispose()
})
test('complete-read deadline is finite and retains the unverified draft on timeout',async()=>{
 const h=await harness({delay:180000});await h.advance(120001)
 assert.equal(h.request.signal.aborted,true);assert.match(h.state.LoadDetail,/120000/);assert.equal(h.cleanup,0);assert.equal(JSON.stringify(h.local),h.before);assert.equal(h.state.Recovery,h.local);h.dispose()
})
test('no pending draft keeps the lightweight 30-second startup deadline',async()=>{
 const h=await harness({draft:false});assert.equal(h.request.profile,'startup');await h.advance(30001)
 assert.equal(h.request.signal.aborted,true);assert.match(h.state.LoadDetail,/30000/);assert.equal(h.cleanup,0);h.dispose()
})
test('real differences and version conflicts still retain the draft without any save or cleanup',async()=>{
 for(const options of [{different:true},{error:{code:'40001',message:'Cloud data changed'}}]){
  const h=await harness(options);await h.advance(45000);assert.equal(h.cleanup,0);assert.equal(h.state.Recovery,h.local);assert.equal(JSON.stringify(h.local),h.before);h.dispose()
 }
})
