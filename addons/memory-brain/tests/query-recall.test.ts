import assert from 'node:assert/strict'
import { utimesSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { search } from '../src/search.ts'
import { fixture } from './helpers.ts'

for (const unicode of [false, true]) {
  test(`two-character substring 茉莉 matches 茉莉花茶 with ${unicode ? 'unicode61' : 'trigram'}`, async t => {
    const f = fixture(t, {}, unicode); f.write('MEMORY.md', '饮茶偏好：茉莉花茶。'); await f.ingest.sync()
    const hits = search(f.db, { query: '茉莉' })
    assert.equal(hits.length, 1); assert.equal(hits[0].source, 'MEMORY.md')
  })
  test(`continuous Chinese question uses visibly labelled keyword recall with ${unicode ? 'unicode61' : 'trigram'}`, async t => {
    const f = fixture(t, {}, unicode); f.write('MEMORY.md', '饮茶偏好：茉莉花茶。'); await f.ingest.sync()
    const hits = search(f.db, { query: '我以前说过我喜欢喝哪种茶？' })
    assert.equal(hits.length, 1); assert.equal(hits[0].source, 'MEMORY.md')
    assert.equal(hits[0].match, 'keywords'); assert.ok(hits[0].matchedTerms.includes('茶'))
  })
}

test('keyword supplementation preserves source, date, kind and archive exclusions before limits', async t => {
  const f = fixture(t, { include: ['MEMORY.md', 'notes/**/*.md', 'memories/**/*.md', 'handoffs/**/*.md'] })
  f.write('MEMORY.md', '饮茶偏好：茉莉花茶。')
  f.write('notes/old.md', '旧的茉莉花茶。')
  utimesSync(join(f.workspace, 'notes/old.md'), new Date('2000-01-01'), new Date('2000-01-01'))
  f.write('notes/current.md', '现在的茉莉花茶。')
  f.write('memories/other.md', '另一份茉莉花茶。')
  for (let i = 0; i < 110; i++) f.write(`handoffs/${i}.md`, '历史聊天中提及茉莉花茶。')
  await f.ingest.sync()
  const hits = search(f.db, { query: '我之前说过喜欢喝什么茶吗？', source: 'notes/', since_days: 1, kind: 'notes', excludeKinds: ['handoffs'], limit: 5 })
  assert.deepEqual(hits.map(row => row.source), ['notes/current.md'])
})

test('plain multi-term queries keep conjunction and do not silently relax to OR', async t => {
  const f = fixture(t); f.write('MEMORY.md', '喜欢茉莉花茶。'); f.write('notes/b.md', '清茶。'); await f.ingest.sync()
  assert.equal(search(f.db, { query: '茉莉 清茶' }).length, 0)
  assert.equal(search(f.db, { query: '不存在的紫色月亮' }).length, 0)
})

test('question fallback never drops literal SQL, LIKE or quote punctuation', async t => {
  const f = fixture(t); f.write('MEMORY.md', '只有百分比 1000 和代号 aXb，不含要找的原文。'); await f.ingest.sync()
  for (const query of ['100% 是什么？', 'a_b 是什么？', '"不存在"是什么？', '“不存在”是什么？', "' OR 1=1 --？"]) assert.equal(search(f.db, { query }).length, 0)
})

test('entity mode remains explicit entity lookup and does not run broad keyword fallback', async t => {
  const f = fixture(t); f.write('MEMORY.md', '饮茶偏好：茉莉花茶。'); await f.ingest.sync()
  assert.equal(search(f.db, { query: '我喜欢喝什么茶？', mode: 'entity' }).length, 0)
})

test('literal question hits always rank ahead of supplemented partial keyword hits', async t => {
  const f = fixture(t)
  f.write('MEMORY.md', '喜欢喝什么茶？原文提问，待核对。')
  f.write('notes/answer.md', '饮茶偏好：茉莉花茶。')
  await f.ingest.sync()
  const hits = search(f.db, { query: '喜欢喝什么茶？', limit: 5 })
  assert.equal(hits[0].source, 'MEMORY.md'); assert.equal(hits[1].source, 'notes/answer.md')
  assert.equal(hits[1].match, 'keywords')
})

test('filler-only questions cannot broaden into a whole-index match', async t => {
  const f = fixture(t); f.write('MEMORY.md', '饮茶偏好：茉莉花茶。'); await f.ingest.sync()
  assert.equal(search(f.db, { query: '我之前说过什么吗？' }).length, 0)
})

test('invalid OR candidates do not suppress the literal conjunctive LIKE fallback', async t => {
  const f = fixture(t)
  f.write('MEMORY.md', '茉莉花茶与清茶都是原文关键词。')
  for (let i = 0; i < 110; i++) f.write(`notes/${i}.md`, '茉莉花茶。'.repeat(10))
  await f.ingest.sync()
  const hits = search(f.db, { query: '茉莉花茶 清茶', limit: 1 })
  assert.equal(hits.length, 1); assert.equal(hits[0].source, 'MEMORY.md'); assert.equal(hits[0].match, 'literal')
})
