// Offline only. Never opens a connection or reads credentials.
const fs = require('node:fs'), crypto = require('node:crypto'), ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
const { encodeWorkbenchRows, decodeWorkbenchRows, storedRowIdentity } = require('../src/services/workbenchRows.ts')
const { sameStoredDocument } = require('../src/utils/workbenchRecovery.ts')
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
function prepare(document) {
  const rows = encodeWorkbenchRows(document), restored = decodeWorkbenchRows(rows)
  if (!sameStoredDocument(document, restored)) throw new Error('Round-trip differs; migration stopped')
  const counts = {}, financialFields = []
  for (const row of rows) {
    counts[row.collection] = (counts[row.collection] || 0) + 1
    // Fingerprint every raw field, including null, rather than inventing totals
    // or applying another rounding rule to historical financial values.
    financialFields.push([storedRowIdentity(row), row.body])
  }
  return { format: 'workbench-rows-v1', document_sha256: digest(document), row_keys_sha256: digest(rows.map(storedRowIdentity).sort()),
    exact_values_sha256: digest(financialFields.sort((a,b) => a[0].localeCompare(b[0]))), counts, rows }
}
if (require.main === module) {
  const [input, output, verifyInput] = process.argv.slice(2)
  if (!input || !output) throw new Error('Usage: node tools/prepare-workbench-row-migration.cjs raw-document.json NEW-bundle.json [exported-rows.json]')
  const doc = JSON.parse(fs.readFileSync(input, 'utf8')), bundle = prepare(doc)
  if (verifyInput) {
    const exported = JSON.parse(fs.readFileSync(verifyInput, 'utf8'))
    if (!sameStoredDocument(doc, decodeWorkbenchRows(exported.rows || exported))) throw new Error('Exported database rows differ; cutover prohibited')
  }
  fs.writeFileSync(output, JSON.stringify(bundle, null, 2), { flag: 'wx' })
  console.log(JSON.stringify({ exact: true, document_sha256: bundle.document_sha256, counts: bundle.counts }))
}
module.exports = { prepare }
