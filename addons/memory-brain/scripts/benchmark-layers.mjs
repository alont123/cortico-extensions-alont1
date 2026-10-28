import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { BrainDb } from '../src/db.ts'
import { BRAIN_DEFAULTS, normalizeConfig } from '../src/config.ts'
import { Enhancer } from '../src/entities.ts'
import { Ingester } from '../src/ingest.ts'
import { coreConfig, archiveConfig, databaseStats } from '../src/layers.ts'
import { search } from '../src/search.ts'
import { BrainWorld } from '../src/world.ts'

// Entirely synthetic: 53 core documents / 2,088 chunks, plus 200 handoffs.
// This models the reported core shape without reading any deployment content.
mkdirSync('scratch', { recursive: true }); mkdirSync('reports', { recursive: true })
const root = mkdtempSync(join(process.cwd(), 'scratch/layers-'))
const workspace = join(root, 'workspace'); mkdirSync(workspace)
const write = (path, count, archive = false) => {
  const file = join(workspace, path); mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, Array.from({ length: count }, (_, seq) => `## 段落 ${seq}\n项目：${archive ? '旧日档案' : '核心约定'} 青禾基地${archive ? '聊天记录的旧玩笑，需核对语境' : '在周末开放，需核对原文'}。${'这是完全合成的性能验证内容。'.repeat(45)}\n`).join('\n'))
}
write('MEMORY.md', 69); write('RECENT.md', 20)
for (let i = 0; i < 51; i++) write(`notes/${i}.md`, i === 50 ? 49 : 39)
for (let i = 0; i < 200; i++) write(`handoffs/${i}.md`, 20, true)
const sourceBefore = readFileSync(join(workspace, 'handoffs/0.md'))
const open = []
const build = async (file, cfg) => {
  const db = new BrainDb(join(root, file)); open.push(db)
  const ingest = new Ingester(db, workspace, cfg, new Enhancer(db, cfg, () => ''))
  const begin = performance.now(); let result; let passes = 0
  try {
    do { result = await ingest.sync(); passes++; assert.equal(result.errors, 0) } while (result.deferred)
  } finally { ingest.stop(); await ingest.idle() }
  db.sql.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  return { db, stats: databaseStats(db), indexMs: +(performance.now() - begin).toFixed(2), passes }
}
const measure = (db, layer = 'legacy') => {
  const samples = []
  for (let i = 0; i < 60; i++) {
    const begin = performance.now()
    assert.ok(search(db, { query: i % 3 === 0 ? '青禾' : i % 3 === 1 ? '青禾基地' : layer === 'archive' ? '聊天记录' : '周末开放', ...(layer === 'core' ? { excludeKinds: ['handoffs'] } : {}) }).length)
    samples.push(performance.now() - begin)
  }
  samples.sort((a, b) => a - b)
  const questionSamples = []
  for (let i = 0; i < 30; i++) {
    const begin = performance.now()
    const hits = search(db, { query: '青禾基地什么时候开放？', ...(layer === 'core' ? { excludeKinds: ['handoffs'] } : {}) })
    assert.ok(hits.length); assert.ok(hits.every(row => row.match === 'keywords'))
    questionSamples.push(performance.now() - begin)
  }
  questionSamples.sort((a, b) => a - b)
  return { searchP95Ms: +samples[Math.ceil(samples.length * 0.95) - 1].toFixed(2), searchMaxMs: +samples.at(-1).toFixed(2), samples: samples.length, questionP95Ms: +questionSamples[Math.ceil(questionSamples.length * 0.95) - 1].toFixed(2), questionMaxMs: +questionSamples.at(-1).toFixed(2), questionSamples: questionSamples.length }
}
let world
try {
  const cfg = normalizeConfig({ workspaceSubdir: 'workspace', syncOnStart: false })
  const legacy = await build('legacy.db', normalizeConfig({ include: [...BRAIN_DEFAULTS.include, 'handoffs/**/*.md'] }))
  const core = await build('core.db', coreConfig(cfg))
  const archive = await build('archive.db', archiveConfig(cfg))
  const legacySearch = measure(legacy.db), coreSearch = measure(core.db, 'core'), archiveSearch = measure(archive.db, 'archive')
  const oldBytes = legacy.stats.dbBytes
  const migrated = new Ingester(legacy.db, workspace, coreConfig(cfg), new Enhancer(legacy.db, cfg, () => ''))
  const migrationStart = performance.now()
  try { assert.equal((await migrated.sync()).deleted, 200) } finally { migrated.stop(); await migrated.idle() }
  const migratedStats = databaseStats(legacy.db)
  const migrationMs = +(performance.now() - migrationStart).toFixed(2)
  const start = performance.now()
  world = new BrainWorld({ cfg, botDir: root, dataDir: join(root, 'default-data') })
  await world.start({ pushEvent: async () => {} })
  const defaultStartMs = +(performance.now() - start).toFixed(2)
  assert.equal(existsSync(join(root, 'default-data/brain/archive.db')), false)
  assert.deepEqual(readFileSync(join(workspace, 'handoffs/0.md')), sourceBefore)
  const summarize = result => ({ ...result.stats, indexMs: result.indexMs, syncPasses: result.passes })
  const report = {
    syntheticOnly: true, fixture: { coreDocuments: 53, coreChunks: 2088, handoffDocuments: 200, handoffChunks: 4000 },
    legacyInclusive: { ...summarize(legacy), ...legacySearch },
    core: { ...summarize(core), ...coreSearch }, archive: { ...summarize(archive), ...archiveSearch },
    migration: { beforeBytes: oldBytes, afterBytes: migratedStats.dbBytes, removedDocuments: 200, elapsedMs: migrationMs, schemaVersion: legacy.db.meta('schema_version'), sourceBytesUnchanged: true },
    defaultStartMs, defaultArchiveCreated: false,
    coreSizeReductionPercent: +((1 - core.stats.dbBytes / oldBytes) * 100).toFixed(2), node: process.version,
  }
  console.log(JSON.stringify(report, null, 2))
  writeFileSync('reports/layers-performance.json', JSON.stringify(report, null, 2) + '\n')
  assert.equal(core.stats.documents, 53); assert.equal(core.stats.chunks, 2088)
  assert.equal(archive.stats.documents, 200); assert.equal(archive.stats.chunks, 4000)
  assert.ok(core.stats.dbBytes < 50 * 1024 * 1024)
  assert.ok(coreSearch.searchP95Ms < 100)
  assert.ok(coreSearch.questionP95Ms < 100)
  assert.ok(core.stats.dbBytes < oldBytes / 2)
  assert.ok(migratedStats.dbBytes < oldBytes / 2)
} finally {
  await world?.stop()
  for (const db of open) db.close()
  rmSync(root, { recursive: true, force: true })
}
