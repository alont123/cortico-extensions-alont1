import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { WorldHost } from 'cortico/core/types.ts'
import { BrainWorld } from '../src/world.ts'
import { BRAIN_DEFAULTS } from '../src/config.ts'

async function create(t: import('node:test').TestContext, empty = false, cfg: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'brain-world-')); mkdirSync(join(root, 'workspace')); if (!empty) writeFileSync(join(root, 'workspace/MEMORY.md'), '# 偏好\n昵称：海棠 喜欢青禾酸奶。')
  const events: any[] = []
  const host = { pushEvent: async (event: unknown) => { events.push(event) } } as unknown as WorldHost
  const world = new BrainWorld({ cfg: { workspaceSubdir: 'workspace', syncOnStart: false, ...cfg }, botDir: root, dataDir: join(root, 'data'), timezone: 'Asia/Shanghai' })
  t.after(async () => { await world.stop(); rmSync(root, { recursive: true, force: true }) })
  const call = async (name: string, args = {}) => { const outcome = await world.tools().find(tool => tool.name === name)!.handler(args, {} as never); return typeof outcome === 'string' ? outcome : outcome.text }
  return { root, events, host, world, call }
}
test('start opens database but never scans workspace synchronously', async t => {
  const f = await create(t); await f.world.start(f.host)
  const stats = JSON.parse(String(await f.call('brain_stats'))); assert.equal(stats.documents, 0); assert.equal(f.world.tools().length, 10)
})
test('all ten tools work end to end on synthetic data and preserve source files', async t => {
  const f = await create(t); const original = readFileSync(join(f.root, 'workspace/MEMORY.md'), 'utf8'); await f.world.start(f.host)
  assert.match(String(await f.call('brain_sync')), /新增 1/)
  assert.match(String(await f.call('brain_search', { query: '青禾酸奶' })), /MEMORY.md:1-2/)
  const stats = JSON.parse(String(await f.call('brain_stats'))); assert.equal(stats.documents, 1); assert.ok(stats.entities)
  const result = String(await f.call('brain_search', { query: '青禾酸奶' })); const chunk = Number(result.match(/^\[(\d+)\]/)![1])
  assert.match(String(await f.call('brain_get', { chunk_id: chunk })), /青禾酸奶/)
  assert.match(String(await f.call('brain_entity', { name: '海棠' })), /mention_count/)
  assert.match(String(await f.call('brain_flag', { chunk_id: chunk })), /复习 #1/)
  assert.equal(String(await f.call('brain_review')), '到期清单空。')
  assert.match(String(await f.call('brain_grade', { id: 1, grade: 3 })), /下次/)
  assert.match(String(await f.call('brain_audit')), /duplicates/)
  assert.match(String(await f.call('brain_digest')), /新增\/变更文档 1/)
  assert.equal(readFileSync(join(f.root, 'workspace/MEMORY.md'), 'utf8'), original)
})
test('review events are claimed once per local day including concurrent checks and restart', async t => {
  const f = await create(t); await f.world.start(f.host); await f.call('brain_flag', { text: '脱敏复习条目' })
  const tomorrow = Date.now() + 2 * 86400000
  await Promise.all([f.world.checkReviews(tomorrow), f.world.checkReviews(tomorrow)])
  assert.equal(f.events.length, 1); assert.equal(f.events[0].type, 'brain.review_due'); assert.equal(f.events[0].origin, 'external')
  await f.world.stop(); await f.world.start(f.host); await f.world.checkReviews(tomorrow); assert.equal(f.events.length, 1)
  await f.world.checkReviews(tomorrow + 86400000); assert.equal(f.events.length, 2)
})
test('sync failure notifications are rate limited and do not leak absolute filesystem paths', async t => {
  const f = await create(t); await f.world.start(f.host); rmSync(join(f.root, 'workspace'), { recursive: true })
  const one = await f.call('brain_sync'); const two = await f.call('brain_sync')
  assert.equal(f.events.length, 1); assert.equal(f.events[0].type, 'brain.sync_failed'); assert.equal(f.events[0].origin, 'internal')
  assert.ok(!String(one).includes(f.root) && !String(two).includes(f.root)); assert.ok(!JSON.stringify(f.events).includes(f.root))
})
test('invalid tool arguments return bounded actionable text without uncaught failures', async t => {
  const f = await create(t); await f.world.start(f.host)
  for (const [name, args] of [['brain_search', { query: '' }], ['brain_search', { query: 'x', limit: 0 }], ['brain_sync', { paths: ['../escape'] }], ['brain_grade', { id: 1, grade: 5 }], ['brain_review', { limit: 'bad' }]] as const) {
    const reply = String(await f.call(name, args)); assert.ok(reply.length < 150); assert.ok(!reply.includes(f.root))
  }
})
test('brain_sync reports deferred files and asks for another pass', async t => {
  const f = await create(t, true, { maxFilesPerSync: 1 })
  writeFileSync(join(f.root, 'workspace/MEMORY.md'), '# M\nmemory')
  writeFileSync(join(f.root, 'workspace/RECENT.md'), '# R\nrecent')
  await f.world.start(f.host)
  const first = String(await f.call('brain_sync'))
  assert.match(first, /延后 1/)
  assert.match(first, /还有 1 个文件未处理/)
  const second = String(await f.call('brain_sync'))
  assert.match(second, /延后 0/)
  assert.doesNotMatch(second, /还有 \d+ 个文件未处理/)
})
test('stop closes the database and prestart tools cannot query data', async t => {
  const f = await create(t); assert.match(String(await f.call('brain_stats')), /尚未启动/); await f.world.start(f.host); await f.world.stop(); assert.match(String(await f.call('brain_sync')), /尚未启动/)
})
test('stopping an active scan cancels it without a false failure notification', async t => {
  const f = await create(t); await f.world.start(f.host)
  const rejected = assert.rejects(f.world.synchronize(), /取消/)
  await f.world.stop(); await rejected
  assert.equal(f.events.length, 0)
})

test('question recall is labelled in tools and stays in the selected core or archive database', async t => {
  const f = await create(t, true, { archive: { ...BRAIN_DEFAULTS.archive, enabled: true } })
  writeFileSync(join(f.root, 'workspace/MEMORY.md'), '饮茶偏好：茉莉花茶。')
  mkdirSync(join(f.root, 'workspace/handoffs'))
  writeFileSync(join(f.root, 'workspace/handoffs/old.md'), '旧聊天：花茶相关的一次玩笑。')
  await f.world.start(f.host); await f.call('brain_sync')
  const core = String(await f.call('brain_search', { query: '我喜欢喝什么茶？' }))
  assert.match(core, /MEMORY.md:1-1/); assert.match(core, /关键词补充（仅命中：茶；需核对原文）/)
  assert.doesNotMatch(core, /handoffs|archive:/)
  const archive = String(await f.call('brain_search', { query: '我喜欢喝什么茶？', scope: 'archive' }))
  assert.match(archive, /handoffs\/old.md:1-1/); assert.match(archive, /关键词补充/)
  assert.doesNotMatch(archive, /MEMORY.md/)
  assert.match(String(await f.call('brain_search', { query: '我喜欢喝什么茶？', kind: 'notes' })), /没找到/)
})
