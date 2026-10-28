import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { WorldHost } from 'cortico/core/types.ts'
import { BRAIN_DEFAULTS, normalizeConfig, type BrainConfig } from '../src/config.ts'
import { BrainDb } from '../src/db.ts'
import { Enhancer } from '../src/entities.ts'
import { Ingester } from '../src/ingest.ts'
import { coreConfig, databaseStats } from '../src/layers.ts'
import { BRAIN_CONFIG_GROUP, panel } from '../src/panel.ts'
import { search } from '../src/search.ts'
import { BrainWorld } from '../src/world.ts'
import { flag } from '../src/review.ts'
import { fixture } from './helpers.ts'

async function setup(t: TestContext, enabled = true, count = 200, extra: Partial<BrainConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'brain-archive-'))
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const write = (source: string, content: string) => { mkdirSync(dirname(join(workspace, source)), { recursive: true }); writeFileSync(join(workspace, source), content) }
  write('MEMORY.md', '# 结论\n青禾基地在周末开放。')
  for (let index = 0; index < count; index++) write(`handoffs/${index}.md`, `# 旧记录 ${index}\n项目：旧日档案 青禾基地闲聊，玩笑不能当成结论。`)
  const cfg = { workspaceSubdir: 'workspace', syncOnStart: false, archive: { ...BRAIN_DEFAULTS.archive, enabled }, ...extra }
  const world = new BrainWorld({ cfg, botDir: root, dataDir: join(root, 'data') })
  t.after(async () => { await world.stop(); rmSync(root, { recursive: true, force: true }) })
  const call = async (name: string, args = {}) => { const outcome = await world.tools().find(tool => tool.name === name)!.handler(args, {} as never); return typeof outcome === 'string' ? outcome : outcome.text }
  await world.start({ pushEvent: async () => {} } as unknown as WorldHost)
  return { root, workspace, write, world, call }
}

test('default core search puts MEMORY first and excludes all 200 handoffs', async t => {
  const f = await setup(t); await f.call('brain_sync')
  const reply = await f.call('brain_search', { query: '青禾基地', limit: 5 })
  assert.match(reply, /^\[\d+\] \[memory\].*MEMORY\.md:1-2/)
  assert.match(reply, /青禾基地在周末开放/); assert.doesNotMatch(reply, /handoffs|旧记录/)
  const stats = JSON.parse(await f.call('brain_stats'))
  assert.equal(stats.core.documents, 1); assert.equal(stats.archive.documents, 200)
  assert.equal(stats.core.coverage.filter((row: any) => /handoff/.test(row.kind)).length, 0)
})

test('all keeps the independent core limit and collapses at most five weighted archive hits', async t => {
  const f = await setup(t); f.write('notes/open.md', '青禾基地入口约定。'); await f.call('brain_sync')
  const reply = await f.call('brain_search', { query: '青禾基地', scope: 'all', limit: 1 })
  const [core, archive] = reply.split('\n---\n')
  assert.match(core, /^核心结果：/); assert.equal((core.match(/^\[\d+\]/gm) ?? []).length, 1)
  assert.match(archive, /共 5 条.*已降权（权重 0.25）/)
  assert.doesNotMatch(reply, /闲聊|archive:/)
})

test('archive search is capped, namespace is explicit, and get keeps core numeric IDs compatible', async t => {
  const f = await setup(t); await f.call('brain_sync')
  const reply = await f.call('brain_search', { query: '青禾基地', scope: 'archive', limit: 50 })
  assert.equal((reply.match(/^\[archive:\d+\]/gm) ?? []).length, 5)
  assert.doesNotMatch(reply, /MEMORY.md|周末开放/); assert.match(reply, /\[handoffs\].*handoffs\//)
  const id = Number(reply.match(/^\[archive:(\d+)\]/)![1])
  assert.match(await f.call('brain_get', { chunk_id: id, scope: 'archive' }), /旧记录/)
  const core = await f.call('brain_search', { query: '青禾基地' })
  const coreId = Number(core.match(/^\[(\d+)\]/)![1])
  assert.match(await f.call('brain_get', { chunk_id: coreId }), /周末开放/)
  assert.match(await f.call('brain_flag', { chunk_id: coreId }), /复习 #1/)
})

test('disabled archive is never created or opened and default sync ignores explicit legacy handoff include', async t => {
  const f = await setup(t, false, 200, { include: [...BRAIN_DEFAULTS.include, 'handoffs/**/*.md'] })
  // A disabled archive must not inspect an existing invalid DB either.
  const archiveFile = join(f.root, 'data/brain/archive.db')
  assert.equal(existsSync(archiveFile), false)
  writeFileSync(archiveFile, 'untouched disabled archive')
  await f.call('brain_sync')
  assert.equal(JSON.parse(await f.call('brain_stats')).core.documents, 1)
  assert.equal(JSON.parse(await f.call('brain_stats')).archive.enabled, false)
  assert.equal(readFileSync(archiveFile, 'utf8'), 'untouched disabled archive')
  assert.equal(await f.call('brain_search', { query: '青禾基地', scope: 'archive' }), '档案库未启用，先设置 worlds.brain.archive.enabled=true')
  assert.match(await f.call('brain_search', { query: '青禾基地', scope: 'all' }), /核心结果：[\s\S]*档案库未启用/)
  assert.equal(existsSync(archiveFile + '-wal'), false)
})

test('fresh default start and sync do not create archive.db', async t => {
  const f = await setup(t, false, 200)
  assert.equal(existsSync(join(f.root, 'data/brain/archive.db')), false)
  await f.call('brain_sync')
  assert.equal(existsSync(join(f.root, 'data/brain/archive.db')), false)
  assert.equal(JSON.parse(await f.call('brain_stats')).core.documents, 1)
})

test('kind filtering applies before candidate limits for FTS, LIKE and entity searches', async t => {
  const f = fixture(t)
  for (let i = 0; i < 120; i++) f.write(`notes/${i}.md`, '昵称：青禾 青禾基地新笔记。')
  f.write('MEMORY.md', '昵称：青禾 青禾基地结论。'); f.write('memories/old.md', '昵称：青禾 青禾基地旧记忆。')
  await f.ingest.sync()
  for (const mode of ['keyword', 'entity', 'hybrid']) for (const kind of ['memory', 'memories'] as const) {
    const rows = search(f.db, { query: mode === 'keyword' ? '青禾基地' : '青禾', mode, kind })
    assert.equal(rows.length, 1); assert.equal(rows[0].kind, kind)
  }
})

test('changing includes removes old handoff chunks, FTS, entities, relations and cache, shrinks DB, preserves sources and reviews', async t => {
  const f = fixture(t, { include: [...BRAIN_DEFAULTS.include, 'handoffs/**/*.md'] })
  f.write('MEMORY.md', '核心结论原样保留。')
  const original = '# 旧记录\r\n' + Array.from({ length: 180 }, (_, i) => `\n## 历史${i}\n昵称：档案专属 项目：旧日档案${i} ${'合成档案内容。'.repeat(90)}`).join('\r\n')
  f.write('handoffs/old.md', original); await f.ingest.sync()
  const coreId = f.db.get("SELECT c.id FROM chunks c JOIN documents d ON c.doc_id=d.id WHERE d.source='MEMORY.md'")!.id
  const oldId = f.db.get("SELECT c.id FROM chunks c JOIN documents d ON c.doc_id=d.id WHERE d.source='handoffs/old.md'")!.id
  const review = flag(f.db, { chunk_id: oldId })
  f.db.sql.exec("UPDATE documents SET kind='handoff' WHERE source LIKE 'handoffs/%'; INSERT INTO llm_cache VALUES('old','derived fixture')")
  f.db.sql.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const beforeBytes = databaseStats(f.db).dbBytes
  const cfg = coreConfig(normalizeConfig())
  const migrated = new Ingester(f.db, f.workspace, cfg, new Enhancer(f.db, cfg, () => ''))
  try {
    // A scoped sync must still apply global configuration migration.
    assert.equal((await migrated.sync({ paths: ['MEMORY.md'] })).deleted, 1)
    assert.equal(f.db.meta('schema_version'), '1')
    assert.equal(f.db.get('SELECT COUNT(*) n FROM documents')!.n, 1)
    assert.equal(f.db.get('SELECT COUNT(*) n FROM chunks')!.n, 1)
    assert.equal(f.db.get('SELECT id FROM chunks')!.id, coreId)
    for (const table of ['entities', 'entity_mentions', 'relations', 'llm_cache']) assert.equal(f.db.get(`SELECT COUNT(*) n FROM ${table}`)!.n, 0)
    assert.equal(search(f.db, { query: '合成档案内容' }).length, 0)
    assert.equal(f.db.get('SELECT COUNT(*) n FROM chunks_fts')!.n, 1)
    assert.equal(f.db.get('SELECT chunk_id FROM reviews WHERE id=?', review.id)!.chunk_id, null)
    assert.match(f.db.get('SELECT text FROM reviews WHERE id=?', review.id)!.text, /旧记录/)
    assert.ok(databaseStats(f.db).dbBytes < beforeBytes / 2)
    assert.equal(readFileSync(join(f.workspace, 'handoffs/old.md'), 'utf8'), original)
    assert.equal((await migrated.sync()).deleted, 0)
  } finally { migrated.stop(); await migrated.idle() }
})

test('entity audit digest stay core-only and panel separates core/archive without exposing secrets', async t => {
  const f = await setup(t, true, 2); await f.call('brain_sync')
  assert.match(await f.call('brain_entity', { name: '旧日档案' }), /没有这个实体/)
  assert.doesNotMatch(await f.call('brain_audit'), /handoffs/)
  assert.doesNotMatch(await f.call('brain_digest'), /旧日档案|handoffs/)
  const ui = f.world.webUi()
  assert.deepEqual(ui.lamps!.map(lamp => lamp.label), ['核心索引', '档案库', '复习', '同步'])
  assert.match(ui.lamps![1].hint!, /2 文档/)
  const properties = BRAIN_CONFIG_GROUP.schema.properties
  for (const key of ['enabled', 'includeJson', 'dbFile', 'maxResults', 'weight']) assert.ok(properties['worlds.brain.archive.' + key])
  assert.equal(properties['worlds.brain.llm.apiKey'], undefined)
  assert.ok(!JSON.stringify(panel({ online: true, docs: 1, chunks: 1, entities: 0, due: 0, lastSync: 0, error: '' })).includes('Bearer '))
})

test('archive config rejects colliding DB files, invalid weights and unsafe paths', () => {
  const cfg = (archive: Partial<BrainConfig['archive']>) => normalizeConfig({ archive: { ...BRAIN_DEFAULTS.archive, ...archive } })
  for (const dbFile of ['brain.db', 'BRAIN.DB', 'brain.db-wal', '../outside.db']) assert.throws(() => cfg({ dbFile }))
  for (const weight of [0, 1, NaN, Infinity, -1]) assert.throws(() => cfg({ weight }))
  assert.deepEqual(cfg({ includeJson: '["handoffs/**/*.txt"]' }).archive.include, ['handoffs/**/*.txt'])
})

test('configured archive limits and all-scope weight apply independently from core', async t => {
  const f = await setup(t, true, 8, { maxResults: 1, archive: { ...BRAIN_DEFAULTS.archive, enabled: true, maxResults: 2, weight: 0.1 } })
  await f.call('brain_sync')
  assert.match(await f.call('brain_search', { query: '青禾基地', scope: 'all', limit: 1 }), /共 2 条.*权重 0.1/)
  assert.equal((await f.call('brain_search', { query: '青禾基地', scope: 'archive', limit: 50 })).match(/^\[archive:/gm)!.length, 2)
  assert.equal((await f.call('brain_search', { query: '青禾基地', scope: 'archive' })).match(/^\[archive:/gm)!.length, 2)
  assert.match(await f.call('brain_search', { query: '青禾基地', kind: 'handoffs' }), /没找到/)
  assert.match(await f.call('brain_search', { query: '青禾基地', scope: 'archive', kind: 'memory' }), /没找到/)
  for (const args of [{ scope: 'bad' }, { kind: 'bad' }]) assert.match(await f.call('brain_search', { query: '青禾基地', ...args }), /^参数 /)
})

test('archive ranking uses the configured multiplicative weight', async t => {
  const f = fixture(t); f.write('MEMORY.md', '青禾基地在周末开放'); await f.ingest.sync()
  const now = Date.now()
  const base = search(f.db, { query: '青禾基地', now })[0].score
  assert.equal(search(f.db, { query: '青禾基地', now, weight: 0.25 })[0].score, base * 0.25)
})

test('old installed DB hides handoffs even before first sync, then migrates through brain_sync', async t => {
  const root = mkdtempSync(join(tmpdir(), 'brain-upgrade-'))
  const workspace = join(root, 'workspace'); mkdirSync(join(workspace, 'handoffs'), { recursive: true })
  writeFileSync(join(workspace, 'MEMORY.md'), '昵称：共用名字 核心结论。')
  const bytes = Buffer.from('昵称：共用名字 项目：档案独占 旧聊天专用关键词。\r\n')
  writeFileSync(join(workspace, 'handoffs/old.md'), bytes)
  const oldCfg = normalizeConfig({ include: [...BRAIN_DEFAULTS.include, 'handoffs/**/*.md'] })
  const db = new BrainDb(join(root, 'data/brain/brain.db'))
  const ingest = new Ingester(db, workspace, oldCfg, new Enhancer(db, oldCfg, () => ''))
  try {
    await ingest.sync()
    db.sql.exec("UPDATE documents SET kind='handoff' WHERE source LIKE 'handoffs/%'")
  } finally { ingest.stop(); await ingest.idle(); db.close() }
  const world = new BrainWorld({ cfg: { workspaceSubdir: 'workspace', syncOnStart: false }, botDir: root, dataDir: join(root, 'data') })
  t.after(async () => { await world.stop(); rmSync(root, { recursive: true, force: true }) })
  await world.start({ pushEvent: async () => {} } as unknown as WorldHost)
  const call = async (name: string, args = {}) => { const outcome = await world.tools().find(tool => tool.name === name)!.handler(args, {} as never); return typeof outcome === 'string' ? outcome : outcome.text }
  assert.equal(JSON.parse(await call('brain_stats')).core.documents, 2)
  assert.match(await call('brain_search', { query: '旧聊天专用关键词' }), /没找到/)
  assert.match(await call('brain_sync', { paths: ['MEMORY.md'] }), /删除 1/)
  assert.equal(JSON.parse(await call('brain_stats')).core.documents, 1)
  assert.match(await call('brain_entity', { name: '档案独占' }), /没有这个实体/)
  const shared = JSON.parse(await call('brain_entity', { name: '共用名字' }))
  assert.equal(shared.mention_count, 1); assert.equal(shared.sources[0].source, 'MEMORY.md')
  assert.deepEqual(readFileSync(join(workspace, 'handoffs/old.md')), bytes)
})
