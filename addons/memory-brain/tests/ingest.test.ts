import assert from 'node:assert/strict'
import { readFileSync, rmSync, symlinkSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fixture } from './helpers.ts'
import { splitChunks, globRegex } from '../src/ingest.ts'
import { BrainDb } from '../src/db.ts'
import { normalizeConfig } from '../src/config.ts'

test('indexes three explicitly included files with original relative source and line ranges', async t => {
  const f = fixture(t, { include: ['MEMORY.md', 'notes/**/*.md', 'handoffs/**/*.md'] }); f.write('MEMORY.md', '# 偏好\n昵称：海棠 喜欢酸奶。'); f.write('notes/day.md', '# 见面\n今天在远航基地见面。'); f.write('handoffs/change.md', '# 交接\n项目：纸舟 已完成。')
  const result = await f.ingest.sync()
  assert.equal(result.added, 3); assert.equal(result.errors, 0)
  assert.equal(f.db.get('SELECT COUNT(*) n FROM documents')!.n, 3)
  const chunk = f.db.get("SELECT c.* FROM chunks c JOIN documents d ON d.id=c.doc_id WHERE d.source='notes/day.md'")!
  assert.equal(chunk.start_line, 1); assert.equal(chunk.end_line, 2); assert.match(chunk.text, /远航基地/)
})
test('repeat sync is idempotent and full sync does not duplicate unchanged content', async t => {
  const f = fixture(t); f.write('MEMORY.md', '# 相同\n原文保持。')
  await f.ingest.sync(); const ids = f.db.all('SELECT id FROM chunks')
  assert.equal((await f.ingest.sync()).skipped, 1); assert.equal((await f.ingest.sync({ full: true })).skipped, 1)
  assert.deepEqual(f.db.all('SELECT id FROM chunks'), ids)
})
test('changed document replaces FTS and entity links without stale hits', async t => {
  const f = fixture(t); f.write('MEMORY.md', '昵称：海棠 喜欢酸奶'); await f.ingest.sync()
  f.write('MEMORY.md', '昵称：山岚 偏好清茶，不再是原记录。'); assert.equal((await f.ingest.sync({ full: true })).updated, 1)
  assert.equal(f.db.get("SELECT COUNT(*) n FROM chunks_fts WHERE chunks_fts MATCH '酸奶'")!.n, 0)
  assert.equal(f.db.get("SELECT COUNT(*) n FROM entities WHERE name='海棠'")!.n, 0)
})
test('deletion cascades through chunks FTS mentions and relation rows', async t => {
  const f = fixture(t); f.write('MEMORY.md', '昵称：海棠 项目：纸舟 2026-01-01'); await f.ingest.sync(); rmSync(join(f.workspace, 'MEMORY.md')); const result = await f.ingest.sync()
  assert.equal(result.deleted, 1)
  for (const table of ['documents', 'chunks', 'chunks_fts', 'entities', 'entity_mentions', 'relations']) assert.equal(f.db.get(`SELECT COUNT(*) n FROM ${table}`)!.n, 0)
})
test('file cap advances through pending documents without starvation', async t => {
  const f = fixture(t, { maxFilesPerSync: 1 }); for (const file of ['a', 'b', 'c']) f.write('notes/' + file + '.md', file + '。')
  assert.equal((await f.ingest.sync()).deferred, 2); await f.ingest.sync(); await f.ingest.sync()
  assert.equal(f.db.get('SELECT COUNT(*) n FROM documents')!.n, 3)
})
test('scoped sync leaves unrelated indexed sources intact and serializes competing requests', async t => {
  const f = fixture(t); f.write('notes/a.md', '甲。'); f.write('notes/b.md', '乙。')
  await Promise.all([f.ingest.sync({ paths: ['notes/a.md'] }), f.ingest.sync({ paths: ['notes/b.md'] })])
  assert.equal(f.db.get('SELECT COUNT(*) n FROM documents')!.n, 2)
})
test('source files remain byte-identical after indexing and stop', async t => {
  const f = fixture(t); const text = '# 原文\r\n内容带格式。\r\n'; f.write('MEMORY.md', text); await f.ingest.sync(); assert.equal(readFileSync(join(f.workspace, 'MEMORY.md'), 'utf8'), text)
})
test('links escaping the workspace are skipped and unsafe arguments are rejected', async t => {
  const f = fixture(t); const outside = join(f.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'hidden.md'), '不能索引')
  symlinkSync(outside, join(f.workspace, 'notes'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await f.ingest.sync()).seen, 0)
  await assert.rejects(f.ingest.sync({ paths: ['../outside'] }))
  assert.throws(() => normalizeConfig({ workspaceSubdir: '../outside' }))
  assert.throws(() => normalizeConfig({ dbFile: '../bad.db' }))
  assert.throws(() => normalizeConfig({ workspaceSubdir: '.. /outside' }))
})
test('conversation indexing is opt-in and include patterns are authoritative', async t => {
  const f = fixture(t, { include: ['notes/**/*'] }); f.write('notes/log.jsonl', '{"text":"private fixture"}'); f.write('notes/a.txt', '可索引'); f.write('notes/a.md', '可索引')
  assert.equal((await f.ingest.sync()).added, 2)
})
test('Markdown chunks do not overlap and preserve long-line Unicode', () => {
  const input = '# 标题\n' + '字😀'.repeat(500) + '\n\n## 下一节\n不同段落'
  const chunks = splitChunks(input, 100, 20)
  assert.ok(chunks.every(chunk => chunk.text.length <= 100 && !/[\uD800-\uDBFF]$/.test(chunk.text)))
  assert.equal(chunks.map(chunk => chunk.text).join('').replaceAll('\n', ''), input.replaceAll('\n', ''))
  assert.ok(globRegex('notes/**/*.md').test('notes/a.md')); assert.ok(globRegex('notes/**/*.md').test('notes/sub/a.md'))
})
test('failed transaction leaves no half-written document', t => {
  const f = fixture(t)
  assert.throws(() => f.db.transaction(() => { f.db.sql.prepare('INSERT INTO meta VALUES(?,?)').run('fixture', 'written'); throw new Error('fixture failure') }))
  assert.equal(f.db.meta('fixture'), undefined)
})
test('corrupt database is backed up byte-for-byte and rebuilt', t => {
  const f = fixture(t); const file = join(f.root, 'broken.db'); const bytes = Buffer.from('invalid sqlite fixture'); writeFileSync(file, bytes)
  const restored = new BrainDb(file)
  try { assert.equal(restored.recovered, true); assert.equal(restored.meta('schema_version'), '1'); const backup = readdirSync(f.root).find(name => name.startsWith('broken.db.corrupt-'))!; assert.deepEqual(readFileSync(join(f.root, backup)), bytes) } finally { restored.close() }
})
test('newer schema is preserved instead of being renamed as corruption', t => {
  const f = fixture(t); const file = join(f.root, 'future.db'); const db = new BrainDb(file); db.setMeta('schema_version', '99'); db.close()
  assert.throws(() => new BrainDb(file), /数据库版本/)
  assert.equal(readdirSync(f.root).some(name => name.startsWith('future.db.corrupt-')), false)
})
test('file-level index failure rolls back to the previous searchable snapshot', async t => {
  const f = fixture(t); f.write('MEMORY.md', '旧的清茶约定'); await f.ingest.sync()
  f.db.sql.exec("CREATE TRIGGER reject_fixture BEFORE INSERT ON chunks BEGIN SELECT RAISE(ABORT,'fixture write failure'); END")
  f.write('MEMORY.md', '新的酸奶约定，触发事务失败'); const result = await f.ingest.sync({ full: true })
  assert.equal(result.errors, 1); assert.equal(f.db.get('SELECT COUNT(*) n FROM documents')!.n, 1)
  assert.match(f.db.get('SELECT text FROM chunks')!.text, /旧的清茶/)
  assert.equal(f.db.get("SELECT COUNT(*) n FROM chunks_fts WHERE chunks_fts MATCH '旧的清茶'")!.n, 1)
})
test('conversation opt-in permits only explicitly included JSONL sources', async t => {
  const f = fixture(t, { includeConversations: true, include: ['notes/*.jsonl'] }); f.write('notes/conversation.jsonl', '{"text":"纯合成测试记录"}'); f.write('notes/other.md', '未包含')
  assert.equal((await f.ingest.sync()).added, 1); assert.equal(f.db.get('SELECT source FROM documents')!.source, 'notes/conversation.jsonl')
})
test('database directory links cannot redirect writes outside its data directory', t => {
  const f = fixture(t); const outsideDir = join(f.root, 'outside'); mkdirSync(outsideDir)
  const outside = join(outsideDir, 'brain.db'); writeFileSync(outside, 'untouched')
  const link = join(f.root, 'linked'); symlinkSync(outsideDir, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => new BrainDb(join(link, 'brain.db')), /链接/)
  assert.equal(readFileSync(outside, 'utf8'), 'untouched')
})

test('limited first sync indexes MEMORY and RECENT before handoffs', async t => {
  const f = fixture(t, { maxFilesPerSync: 1 })
  f.write('handoffs/a.md', '# 交接\n旧交接')
  f.write('notes/b.md', '# 笔记\n普通笔记')
  f.write('RECENT.md', '# 最近\n最近的事')
  f.write('MEMORY.md', '# 记忆\n一直成立的事')
  const first = await f.ingest.sync()
  assert.equal(first.added, 1)
  assert.equal(f.db.all('SELECT source FROM documents')[0].source, 'MEMORY.md')
  const second = await f.ingest.sync()
  assert.equal(second.added, 1)
  assert.equal(f.db.all('SELECT source FROM documents ORDER BY id')[1].source, 'RECENT.md')
})
