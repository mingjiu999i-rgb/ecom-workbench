// Generates a reviewable SQL artifact ONLY. Never executes SQL or connects.
const fs = require('node:fs'), crypto = require('node:crypto')
require('./prepare-workbench-row-migration.cjs') // Install the TypeScript loader.
const { decodeWorkbenchRows } = require('../src/services/workbenchRows.ts')
const [bundlePath, userId, updatedAt, output] = process.argv.slice(2)
if (!bundlePath || !/^[0-9a-f-]{36}$/i.test(userId || '') || !/^\d{4}-\d\d-\d\dT/.test(updatedAt || '') || !output) throw new Error('Usage: node tools/write-workbench-row-import.cjs bundle.json ACCOUNT_UUID EXPECTED_UPDATED_AT NEW.sql')
const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'))
if (bundle.format !== 'workbench-rows-v1') throw new Error('Unsupported migration bundle')
const { prepare } = require('./prepare-workbench-row-migration.cjs')
const raw = decodeWorkbenchRows(bundle.rows), verified = prepare(raw)
if (verified.document_sha256 !== bundle.document_sha256 || verified.row_keys_sha256 !== bundle.row_keys_sha256 || verified.exact_values_sha256 !== bundle.exact_values_sha256) throw new Error('Migration bundle checksum mismatch')
const quote = value => "'" + String(value).replace(/'/g, "''") + "'"
let tag
do { tag='$migration_'+crypto.randomBytes(16).toString('hex')+'$' } while(JSON.stringify(raw).includes(tag))
const parts = [`-- PRIVATE business-data artifact; inspect locally. Do not commit or upload.\n-- PRODUCTION EXECUTION REQUIRES SEPARATE HUMAN APPROVAL.\nbegin;\nset local lock_timeout='2s';\nset local statement_timeout='30s';\nset local standard_conforming_strings=on;\nlock table public.workbench_documents in share row exclusive mode;\n`]
parts.push(`do ${tag} begin
  if not exists(select 1 from public.workbench_documents where user_id=${quote(userId)}::uuid and updated_at=${quote(updatedAt)}::timestamptz and data=${quote(JSON.stringify(raw))}::jsonb) then
    raise exception 'Source snapshot changed or missing; import aborted';
  end if;
  if exists(select 1 from public.workbench_heads where user_id=${quote(userId)}::uuid and (mode<>'shadow' or revision<>0))
    or exists(select 1 from public.workbench_rows where user_id=${quote(userId)}::uuid) then
    raise exception 'Target is not empty shadow storage; import aborted';
  end if;
end ${tag};
insert into public.workbench_heads(user_id,mode) values(${quote(userId)}::uuid,'shadow') on conflict(user_id) do nothing;
`)
for (let offset = 0; offset < bundle.rows.length; offset += 200) parts.push(`insert into public.workbench_rows(user_id,collection,scope,record_key,position,body,store_id,client_id,business_date)
 select ${quote(userId)}::uuid,collection,scope,record_key,position,body,store_id,client_id,business_date
 from jsonb_to_recordset(${quote(JSON.stringify(bundle.rows.slice(offset, offset + 200)))}::jsonb)
 as x(collection text,scope text,record_key text,position integer,body jsonb,store_id text,client_id text,business_date text);
`)
parts.push(`-- Leaves legacy writes active; this is NOT a production cutover.\ncommit;\n`)
fs.writeFileSync(output, parts.join('\n'), { flag: 'wx' })
console.log('Wrote private import SQL; no database connection was made.')
