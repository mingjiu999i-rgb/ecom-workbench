#!/usr/bin/env node
'use strict'

// Read-only comparison of exported workbench JSON. This tool never connects
// to Supabase, merges records, uploads data, or removes local drafts.
const fs = require('node:fs')
const path = require('node:path')

const CHILDREN = ['orders', 'refunds', 'funds', 'promotions']
const MONEY_FIELDS = new Set([
  'amount', 'sales', 'salesAmount', 'refundAmount', 'profit', 'cost', 'totalCost',
  'income', 'expense', 'receipt', 'promotionFee', 'promotionAmount', 'productCost',
  'shippingCost', 'packagingCost', 'otherCost', 'unitCost', 'settlementAmount', 'currentNet',
])
const META_FIELDS = ['version', 'revision', 'updatedAt', 'modifiedAt', 'updated_at', 'modified_at']

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function unwrap(raw) {
  if (Array.isArray(raw)) {
    if (raw.length !== 1) throw new Error('云端导出必须只包含一个账号')
    return unwrap(raw[0])
  }
  if (!raw || typeof raw !== 'object') throw new Error('来源不是 JSON 对象')
  const document = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) && !Object.hasOwn(raw, 'stores') ? raw.data : raw
  const metadata = document === raw ? {} : Object.fromEntries(META_FIELDS.filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]]))
  return { document, metadata }
}

function businessKey(section, record, scope = '') {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  let fields
  if (section === 'linkSalesOrders') fields = ['storeId', 'orderId']
  else if (section === 'linkSalesPromotions') fields = ['storeId', 'goodsId', 'date']
  else if (section === 'orderAccountingLedgers') fields = ['storeId']
  else if (section === 'funds') fields = ['key']
  else if (section === 'promotions') fields = ['date']
  else fields = ['id']
  if (fields.some(field => typeof record[field] !== 'string' || !record[field])) return null
  return canonical([scope, ...fields.map(field => record[field])])
}

function recordMeta(record) {
  return Object.fromEntries(META_FIELDS.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]))
}

function coreAmounts(record) {
  const values = {}
  const visit = (value, prefix, depth) => {
    if (!value || typeof value !== 'object' || depth > 3) return
    for (const [key, child] of Object.entries(value)) {
      const name = prefix ? `${prefix}.${key}` : key
      if (MONEY_FIELDS.has(key) && (typeof child === 'number' || child === null || typeof child === 'string')) values[name] = child
      else if (!Array.isArray(child)) visit(child, name, depth + 1)
    }
  }
  visit(record, '', 0)
  return values
}

function addRecord(index, ambiguous, section, scope, record) {
  const key = businessKey(section, record, scope)
  if (!key) { ambiguous.push({ section, reason: 'missing-business-key' }); return }
  const identity = `${section}:${key}`
  if (index.has(identity)) { index.delete(identity); ambiguous.push({ section, identity, reason: 'duplicate-business-key' }); return }
  const comparable = section === 'orderAccountingLedgers'
    ? Object.fromEntries(Object.entries(record).filter(([name]) => !CHILDREN.includes(name)))
    : record
  index.set(identity, { section, key, record: comparable, metadata: recordMeta(record), amounts: coreAmounts(record) })
}

function indexDocument(document) {
  const index = new Map(), ambiguous = [], counts = {}
  for (const [section, value] of Object.entries(document)) {
    if (!Array.isArray(value)) continue
    counts[section] = value.length
    for (const record of value) {
      addRecord(index, ambiguous, section, '', record)
      if (section !== 'orderAccountingLedgers' || !record || typeof record !== 'object') continue
      const scope = typeof record.storeId === 'string' ? record.storeId : ''
      for (const child of CHILDREN) {
        const rows = record[child]
        if (!Array.isArray(rows)) { ambiguous.push({ section: `ledger.${child}`, reason: 'missing-or-invalid-array', scope }); continue }
        counts[`ledger.${child}`] = (counts[`ledger.${child}`] || 0) + rows.length
        for (const row of rows) addRecord(index, ambiguous, child, scope, row)
      }
    }
  }
  return { index, ambiguous, counts }
}

function loadSource(name, filename) {
  if (!filename) return { name, available: false, reason: '未提供导出文件' }
  const resolved = path.resolve(filename)
  if (!fs.existsSync(resolved)) return { name, available: false, path: resolved, reason: '文件不存在' }
  try {
    const { document, metadata } = unwrap(JSON.parse(fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, '')))
    const indexed = indexDocument(document)
    return { name, available: true, path: resolved, metadata, ...indexed }
  } catch (error) {
    return { name, available: false, path: resolved, reason: error instanceof Error ? error.message : String(error) }
  }
}

function changedFields(records) {
  const fields = new Set()
  for (const entry of records) for (const key of Object.keys(entry.record || {})) fields.add(key)
  return [...fields].sort().filter(field => new Set(records.map(entry => canonical(entry.record?.[field]))).size > 1)
}

function reconcile(inputs) {
  const sources = ['cloud', 'windows', 'mac'].map(name => loadSource(name, inputs[name]))
  const available = sources.filter(source => source.available)
  const identities = new Set(available.flatMap(source => [...source.index.keys()]))
  const categories = { identical: [], cloud_only: [], windows_only: [], mac_only: [], same_subset: [], conflict: [], unknown: [] }
  for (const identity of [...identities].sort()) {
    const present = available.filter(source => source.index.has(identity))
    const values = new Set(present.map(source => canonical(source.index.get(identity).record)))
    const detail = {
      identity,
      section: present[0].index.get(identity).section,
      present_in: present.map(source => source.name),
      record_metadata: Object.fromEntries(present.map(source => [source.name, source.index.get(identity).metadata])),
      core_amounts: Object.fromEntries(present.map(source => [source.name, source.index.get(identity).amounts])),
    }
    if (present.length === 3 && values.size === 1) categories.identical.push(detail)
    else if (present.length === 1) {
      const category = `${present[0].name}_only`
      categories[category].push({ ...detail, interpretation: present[0].name === 'cloud' ? '不能据此判断本机是否删除过该记录' : '本机新增候选；未自动采用或上传' })
    } else if (values.size === 1) categories.same_subset.push({ ...detail, missing_sources: sources.filter(source => !present.includes(source)).map(source => source.name) })
    else categories.conflict.push({ ...detail, changed_fields: changedFields(present.map(source => source.index.get(identity))), interpretation: '无共同基准版本，无法自动判断哪一端较新' })
  }
  for (const source of sources) {
    if (!source.available) categories.unknown.push({ source: source.name, reason: source.reason })
    else categories.unknown.push(...source.ambiguous.map(item => ({ source: source.name, ...item })))
  }
  const summary = Object.fromEntries(Object.entries(categories).map(([name, rows]) => [name, rows.length]))
  return {
    format: 'ecom-workbench-reconciliation-v1',
    read_only: true,
    complete: sources.every(source => source.available) && categories.unknown.length === 0,
    consistent: sources.every(source => source.available) && categories.unknown.length === 0 && categories.conflict.length === 0 && categories.cloud_only.length === 0 && categories.windows_only.length === 0 && categories.mac_only.length === 0 && categories.same_subset.length === 0,
    limitations: ['来源导出时间不是逐记录修改时间', '缺少共同基准版本时冲突不能自动选定胜方', '缺失记录不能单独证明发生过删除'],
    sources: Object.fromEntries(sources.map(source => [source.name, source.available
      ? { available: true, path: source.path, metadata: source.metadata, counts: source.counts, indexed_records: source.index.size, ambiguous_records: source.ambiguous.length }
      : { available: false, path: source.path || null, reason: source.reason }])),
    summary,
    categories,
  }
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (!key?.startsWith('--') || argv[i + 1] == null) throw new Error('用法: --cloud FILE --windows FILE --mac FILE --output FILE；缺少的来源可写 -')
    args[key.slice(2)] = argv[i + 1] === '-' ? null : argv[i + 1]
  }
  if (!args.output) throw new Error('必须提供 --output，且目标文件不能已存在')
  return args
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const report = reconcile(args)
    fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    console.log(JSON.stringify({ complete: report.complete, consistent: report.consistent, sources: report.sources, summary: report.summary }, null, 2))
    if (!report.complete) process.exitCode = 2
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

module.exports = { canonical, indexDocument, reconcile, unwrap }
