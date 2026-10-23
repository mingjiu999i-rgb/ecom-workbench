#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename)
const { encodeWorkbenchRows } = require('../src/services/workbenchRows.ts')
const { createRowWorkbenchStore } = require('../src/services/rowWorkbenchStore.ts')

const input = process.argv[2]
const output = process.argv[3]
if (!input || !output) throw new Error('用法: node tools/benchmark-progressive-load.cjs INPUT.json OUTPUT.json')
const raw = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8').replace(/^\uFEFF/, ''))
const document = raw?.data && typeof raw.data === 'object' && !Array.isArray(raw.data) && !raw.stores ? raw.data : raw
const encodedAt = performance.now()
const rows = encodeWorkbenchRows(document).sort((a, b) => [a.collection, a.scope, a.record_key].join('\0').localeCompare([b.collection, b.scope, b.record_key].join('\0')))
const encodeMs = performance.now() - encodedAt
const startupCollections = new Set(['$array', '$value', 'a:clients', 'a:stores', 'a:products', 'a:productLinks', 'a:productCosts', 'a:skus', 'a:operations', 'a:skuHistory', 'a:todos', 'a:profitRecords', 'a:collectionRecords', 'a:skuPlanningDrafts', 'a:linkSalesPromotions'])
const startupHeaders = new Set(['clients', 'stores', 'products', 'productLinks', 'productCosts', 'skus', 'operations', 'skuHistory', 'todos', 'profitRecords', 'collectionRecords', 'skuPlanningDrafts', 'linkSalesPromotions'])
const startupRows = rows.filter(row => startupCollections.has(row.collection) && (row.collection !== '$array' || startupHeaders.has(row.record_key)))
const key = row => [row.collection, row.scope, row.record_key].join('\0')
const collectionSources = new Map()
for (const row of rows) {
  let list = collectionSources.get(row.collection)
  if (!list) { list = []; collectionSources.set(row.collection, list) }
  list.push(row)
}
const payloadBytes = value => Buffer.byteLength(JSON.stringify(value))
const sqlBytes = row => Buffer.byteLength(JSON.stringify(row.body)) + Buffer.byteLength(row.collection) + Buffer.byteLength(row.scope) + Buffer.byteLength(row.record_key) + 64

function afterIndex(source, after) {
  if (!after) return 0
  const wanted = after.join('\0')
  let low = 0, high = source.length
  while (low < high) { const middle = (low + high) >> 1; if (key(source[middle]) <= wanted) low = middle + 1; else high = middle }
  return low
}
function page(source, after, byteCap = Infinity) {
  const candidates = source.slice(afterIndex(source, after), afterIndex(source, after) + 500)
  let bytes = 0
  return candidates.filter((row, index) => { bytes += sqlBytes(row); return index === 0 || bytes <= byteCap })
}
function transportFor(profile, stats) {
  const common = {
    head: async () => { stats.requests++; stats.responseBytes += 48; return { mode: 'rows', revision: '1' } },
    begin: async () => null, stage: async () => {}, commit: async () => '2',
  }
  if (profile === 'legacy-full') return {
    ...common,
    page: async after => { stats.requests++; const value = page(rows, after); stats.responseBytes += payloadBytes(value); return value },
  }
  if (profile === 'startup') return {
    ...common,
    page: async () => { throw new Error('unexpected full page') },
    startupPage: async after => { stats.requests++; const value = page(startupRows, after, 262144); stats.responseBytes += payloadBytes(value); return value },
  }
  const collections = [...collectionSources.keys()]
  return {
    ...common,
    page: async () => { throw new Error('unexpected serial page') },
    collections: async () => { stats.requests++; stats.responseBytes += payloadBytes(collections); return collections },
    collectionPage: async (collection, after) => {
      stats.requests++
      const source = collectionSources.get(collection) || []
      const value = page(source, after, 262144)
      stats.responseBytes += payloadBytes(value)
      return value
    },
  }
}
async function measure(profile, attempts = 3) {
  const timings = [], samples = []
  for (let attempt = 0; attempt < attempts; attempt++) {
    const stats = { requests: 0, responseBytes: 0 }
    const store = createRowWorkbenchStore(transportFor(profile, stats))
    const started = performance.now()
    const result = await store.load({ profile: profile === 'startup' ? 'startup' : 'full', concurrency: 4 })
    timings.push(performance.now() - started)
    samples.push({ ...stats, topLevelKeys: Object.keys(result).length })
  }
  timings.sort((a, b) => a - b)
  const sample = samples[samples.length - 1]
  const median = timings[Math.floor(timings.length / 2)]
  const rttRounds = profile === 'parallel-full' ? 3 + Math.ceil((sample.requests - 3) / 4) : sample.requests
  return { rows: profile === 'startup' ? startupRows.length : rows.length, requests: sample.requests, responseBytes: sample.responseBytes, localMedianMs: Number(median.toFixed(2)), localRunsMs: timings.map(value => Number(value.toFixed(2))), modeledAt100msRttMs: Number((median + rttRounds * 100).toFixed(2)), modeledRttRounds: rttRounds }
}

(async () => {
  const before = await measure('legacy-full')
  const startup = await measure('startup')
  const onDemandFull = await measure('parallel-full')
  const report = {
    source: { file: path.basename(input), documentBytes: fs.statSync(path.resolve(input)).size, encodedRows: rows.length, startupRows: startupRows.length, encodeMs: Number(encodeMs.toFixed(2)) },
    conditions: { runtime: process.version, machine: `${process.platform}/${process.arch}`, attempts: 3, transport: 'in-process exact JSON serialization; no production network or database latency', pageLimit: 500, byteLimit: 262144, fullReadConcurrency: 4, modeledRttMs: 100 },
    before,
    startup,
    onDemandFull,
    reductions: { requestsPercent: Number(((1 - startup.requests / before.requests) * 100).toFixed(2)), bytesPercent: Number(((1 - startup.responseBytes / before.responseBytes) * 100).toFixed(2)), localTimePercent: Number(((1 - startup.localMedianMs / before.localMedianMs) * 100).toFixed(2)) },
  }
  fs.writeFileSync(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  console.log(JSON.stringify(report, null, 2))
})().catch(error => { console.error(error); process.exitCode = 1 })
