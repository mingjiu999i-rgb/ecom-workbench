const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
const baseline=require('../docs/sync-protected-business-blobs.json')
test('protected settlement imports, ledger, calculations and exports retain exact latest-remote Git blobs',()=>{
 for(const [file,expected] of Object.entries(baseline.files)){
  const bytes=fs.readFileSync(path.resolve(__dirname,'..',file))
  const actual=crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex')
  assert.equal(actual,expected,`Protected business source changed: ${file}`)
 }
})
