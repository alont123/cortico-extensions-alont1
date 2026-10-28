import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { JsonlEventStore } from 'cortico/core/event-store.ts'
import { nullLogger } from 'cortico/core/util.ts'
import type { EventEnvelope, WorldHost } from 'cortico/core/types.ts'
import { AffinityWorld, type AffinityRecord } from '../../packages/cortico-world-humanlike-alont1/src/modules/affinity/world.ts'
import { AFFINITY_DEFAULTS } from '../../packages/cortico-world-humanlike-alont1/src/modules/affinity/config.ts'

async function fixture(t: test.TestContext, timezone = 'UTC') {
  const scratch = fileURLToPath(new URL('../../scratch/', import.meta.url))
  mkdirSync(scratch, { recursive: true })
  const dir = mkdtempSync(join(scratch, 'affinity-feedback-'))
  const cfg = structuredClone(AFFINITY_DEFAULTS)
  cfg.dailyGainCap = 1
  const store = new JsonlEventStore({ dataDir: dir, run: 'fixture', timezone })
  const started: unknown[] = []
  const host = { store, log: nullLogger(), async pushEvent(event: unknown) { started.push(event) } } as unknown as WorldHost
  const make = () => new AffinityWorld({ cfg, dataDir: dir, timezone })
  let world = make()
  await world.start(host)
  t.after(async () => { await world.stop(); rmSync(dir, { recursive: true, force: true }) })
  return {
    cfg, dir, store, started,
    async restart() { await world.stop(); world = make(); await world.start(host) },
    async get(qq = 12345) { return world.tools().find(x => x.name === 'humanlike_affinity_get')!.handler({ qq }, { role: 'fixture', log: nullLogger() }) },
    async adjust(delta: number) { return world.tools().find(x => x.name === 'humanlike_affinity_adjust')!.handler({ qq: 12345, delta, reason: '实际发生的事' }, { role: 'fixture', log: nullLogger() }) },
    record() { return (world as unknown as { data: { people: Record<string, AffinityRecord> } }).data.people['12345']! },
    tool(name: string) { return world.tools().find(x => x.name === name)! },
    append(overrides: Partial<EventEnvelope> = {}) {
      return store.append({ run: 'fixture', type: 'qq.message', source: 'qq', senderKey: '12345', origin: 'external', ts: new Date(Date.now() - 1000).toISOString(), text: '正常聊天', meta: { user_id: 12345 }, ...overrides })
    },
  }
}

test('affinity counts original QQ messages, not queries, clock or replay materials; gain is capped and persistent', async t => {
  const f = await fixture(t)
  assert.deepEqual(f.started, [])
  f.append(); f.append()
  f.append({ source: 'clock', type: 'clock.period', origin: 'internal' })
  f.append({ source: 'mind', type: 'mind.material', meta: { materialKind: 'event' } })
  f.append({ type: 'qq.message', meta: { user_id: 54321 } })
  f.append({ senderKey: '54321' })
  assert.match(String(await f.get()), /聊过 2 句/)
  assert.equal(f.record().score, 0.8)
  const lastAt = f.record().lastAt
  assert.match(String(await f.get()), /刚查过/)
  assert.equal(f.record().msgs, 2)
  assert.equal(f.record().lastAt, lastAt)
  f.append(); f.append()
  await Promise.all([f.get(), f.get()])
  assert.equal(f.record().msgs, 4)
  assert.equal(f.record().score, 1)
  await f.restart()
  await f.get()
  assert.equal(f.record().msgs, 4)
  assert.equal(f.record().score, 1)
})

test('affinity migrates old query totals without treating them as chat, and adjust shares the daily cap', async t => {
  const f = await fixture(t)
  const file = join(f.dir, 'affinity.json')
  writeFileSync(file, JSON.stringify({ version: 1, people: { 12345: { score: 10, best: 10, msgs: 89, firstAt: '2020-01-01T00:00:00Z', lastAt: '2020-01-01T00:00:00Z', note: '' } } }))
  await f.restart()
  f.append({ ts: new Date(Date.now() - 2 * 86400000).toISOString() })
  f.append()
  await f.get()
  assert.equal(f.record().legacyQueryCount, 89)
  assert.equal(f.record().msgs, 1)
  assert.equal(f.record().score, 10.4)
  await f.adjust(0.9)
  assert.equal(f.record().score, 11)
  await f.restart()
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).people['12345'].legacyQueryCount, 89)
})

test('affinity supports async store proxies and does not invent contact timestamps on reads', async t => {
  const f = await fixture(t)
  const original = f.store.range.bind(f.store)
  // Cross-process hosts return a Promise even when the in-process reader is synchronous.
  Object.assign(f.store, { range: async (query: Parameters<JsonlEventStore['range']>[0]) => original(query) })
  await f.get()
  assert.equal(f.record().msgs, 0)
  assert.equal(f.record().firstAt, '')
  assert.equal(f.record().lastAt, '')
  f.append()
  await f.get()
  assert.equal(f.record().msgs, 1)
  assert.ok(Date.parse(f.record().lastAt) <= Date.now())
})

test('an empty first-day scan advances the cursor and never imports older chat on the next query or restart', async t => {
  const f = await fixture(t)
  const old = f.append({ ts: new Date(Date.now() - 2 * 86400000).toISOString() })
  await f.get()
  assert.equal(f.record().msgs, 0)
  assert.equal(f.record().messageCursor, old.cursor)
  await f.get()
  await f.restart()
  await f.get()
  assert.equal(f.record().msgs, 0)
  f.append()
  await f.get()
  assert.equal(f.record().msgs, 1)
  assert.equal(f.record().score, f.cfg.gainPerMessage)
})

test('an asynchronous snapshot excludes messages arriving during the scan and counts them once on the next query', async t => {
  const f = await fixture(t)
  const first = f.append()
  const range = f.store.range.bind(f.store)
  const latest = f.store.latestCursor.bind(f.store)
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  Object.assign(f.store, {
    latestCursor: async () => latest(),
    range: async (query: Parameters<typeof range>[0]) => {
      enter()
      await released
      return range(query)
    },
  })
  const scanning = f.get()
  await entered
  const second = f.append()
  release()
  await scanning
  assert.equal(f.record().messageCursor, first.cursor)
  assert.equal(f.record().msgs, 1)
  await Promise.all([f.get(), f.get()])
  assert.equal(f.record().messageCursor, second.cursor)
  assert.equal(f.record().msgs, 2)
  assert.equal(f.record().score, f.cfg.gainPerMessage * 2)
})

test('a failed store scan does not consume the cursor or prevent the next scan', async t => {
  const f = await fixture(t)
  f.append()
  const range = f.store.range.bind(f.store)
  Object.assign(f.store, { range: async () => { throw new Error('fixture reader unavailable') } })
  await assert.rejects(f.get(), /reader unavailable/)
  assert.equal(f.record().messageCursor, undefined)
  assert.equal(f.record().msgs, 0)
  Object.assign(f.store, { range })
  await f.get()
  assert.equal(f.record().msgs, 1)
  assert.equal(f.record().score, f.cfg.gainPerMessage)
})

for (const boundary of [
  { timezone: 'Asia/Shanghai', now: '2026-10-24T00:10:00.345Z', old: '2026-10-23T15:59:59.999Z', midnight: '2026-10-23T16:00:00.000Z' },
  { timezone: 'America/New_York', now: '2026-03-08T16:10:00.345Z', old: '2026-03-08T04:30:00.000Z', midnight: '2026-03-08T05:00:00.000Z' },
]) {
  test(`the first scan starts at exact local midnight, including DST transitions: ${boundary.timezone}`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(boundary.now) })
    const f = await fixture(t, boundary.timezone)
    f.append({ ts: boundary.old })
    f.append({ ts: boundary.midnight })
    await f.get()
    assert.equal(f.record().msgs, 1)
    assert.equal(f.record().score, f.cfg.gainPerMessage)
    assert.equal(f.record().firstAt, boundary.midnight)
    assert.equal(f.record().lastAt, boundary.midnight)
  })
}

test('ordinary messages and explicit adjustments share the cap across concurrent tools and reset on the next local day', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-24T12:00:00Z') })
  const f = await fixture(t)
  f.append(); f.append()
  await Promise.all([f.get(), f.adjust(0.9), f.get()])
  assert.equal(f.record().msgs, 2)
  assert.equal(f.record().score, f.cfg.dailyGainCap)
  assert.equal(f.record().gainedToday, f.cfg.dailyGainCap)
  const emotions = structuredClone(f.record().emotions)
  assert.match(String(await f.adjust(0.9)), /分数未变/)
  assert.deepEqual(f.record().emotions, emotions)
  t.mock.timers.setTime(Date.parse('2026-10-25T00:05:00Z'))
  f.append(); f.append()
  await f.get()
  assert.equal(f.record().msgs, 4)
  assert.equal(f.record().score, f.cfg.dailyGainCap + f.cfg.gainPerMessage * 2)
  assert.equal(f.record().gainedToday, f.cfg.gainPerMessage * 2)
  await f.restart()
  await f.get()
  assert.equal(f.record().msgs, 4)
})

test('adjust accounts for pending ordinary messages and consumes only the score actually gained near the maximum', async t => {
  const f = await fixture(t)
  f.cfg.startScore = f.cfg.maxScore - 0.1
  f.cfg.dailyGainCap = 2
  f.append()
  await f.adjust(0.9)
  assert.equal(f.record().msgs, 1)
  assert.equal(f.record().score, f.cfg.maxScore)
  assert.equal(f.record().gainedToday, 0.1)
  assert.equal(f.record().emotions, undefined)
  assert.deepEqual(f.tool('humanlike_affinity_get').tags, ['write', 'snapshot'])
})
