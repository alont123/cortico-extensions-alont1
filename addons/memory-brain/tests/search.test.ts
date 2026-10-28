import assert from 'node:assert/strict'
import { utimesSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fixture } from './helpers.ts'
import { search, getChunks } from '../src/search.ts'

for (const unicode of [false, true]) test(`Chinese substring search works with ${unicode ? 'unicode61 fallback' : 'trigram'}`, async t => {
  const f = fixture(t, {}, unicode); f.write('MEMORY.md', '# 约定\n周末在青禾交流基地见面，昵称：海棠 喜欢酸奶。'); await f.ingest.sync()
  for (const query of ['青禾交流基地', '酸奶', '约定']) { const hits = search(f.db, { query }); assert.equal(hits.length, 1); assert.equal(hits[0].source, 'MEMORY.md'); assert.ok(hits[0].start_line >= 1) }
})
test('search treats quotes SQL and LIKE wildcard characters as text', async t => {
  const f = fixture(t); f.write('MEMORY.md', '百分比 100% 是原文，路径 a_b。'); await f.ingest.sync()
  assert.equal(search(f.db, { query: '%_no_match' }).length, 0)
  assert.equal(search(f.db, { query: "' OR 1=1 --" }).length, 0)
  assert.equal(search(f.db, { query: '100%' }).length, 1)
})
test('source scope recentness and no-result behavior are explicit', async t => {
  const f = fixture(t); f.write('MEMORY.md', '酸奶偏好。'); f.write('notes/new.md', '酸奶偏好。'); const old = new Date('2000-01-01'); utimesSync(join(f.workspace, 'MEMORY.md'), old, old); await f.ingest.sync()
  assert.deepEqual(search(f.db, { query: '酸奶', since_days: 1 }).map(row => row.source), ['notes/new.md'])
  assert.equal(search(f.db, { query: '酸奶', source: 'MEMORY' }).length, 1)
  assert.equal(search(f.db, { query: '不存在的紫色月亮' }).length, 0)
})
test('entity aliases retrieve the associated original chunk', async t => {
  const f = fixture(t); f.write('MEMORY.md', '海棠(12345) 喜欢清茶。'); await f.ingest.sync()
  assert.equal(search(f.db, { query: '海棠', mode: 'entity' }).length, 1)
})
test('search deduplicates a source and get returns adjacent original chunks', async t => {
  const f = fixture(t); f.write('MEMORY.md', '# 一\n酸奶\n\n# 二\n酸奶\n\n# 三\n清茶'); await f.ingest.sync()
  const hits = search(f.db, { query: '酸奶', limit: 50 }); assert.equal(hits.length, 1)
  const middle = f.db.get('SELECT id FROM chunks WHERE seq=1')!
  assert.equal(getChunks(f.db, middle.id, 1).length, 3)
  assert.equal(getChunks(f.db, 999999).length, 0)
})
