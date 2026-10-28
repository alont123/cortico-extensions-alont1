import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { WorldHost } from 'cortico/core/types.ts'
import type { EventRangeQuery, EventEnvelope } from 'cortico/core/types.ts'
import { JsonlEventStore } from 'cortico/core/event-store.ts'
import { nullLogger } from 'cortico/core/util.ts'
import { LifeWorld } from '../../packages/cortico-world-humanlike-alont1/src/modules/life/world.ts'
import { LIFE_DEFAULTS } from '../../packages/cortico-world-humanlike-alont1/src/modules/life/config.ts'
import { AFFINITY_DEFAULTS } from '../../packages/cortico-world-humanlike-alont1/src/modules/affinity/config.ts'

function setup(t: test.TestContext, overrides = {}) {
  mkdirSync('scratch', { recursive: true })
  const dir = mkdtempSync(join('scratch', 'humanlike-life-'))
  const cfg = { ...LIFE_DEFAULTS, reachOut: true, reachChance: 0, eventChance: 0, favoredId: 12345, reachFavoredChance: 0.4, ...overrides }
  const events: Array<{ event: Record<string, unknown>; options: unknown }> = []
  const store = new JsonlEventStore({ dataDir: dir, run: 'fixture-life', timezone: 'UTC' })
  let range: (query: EventRangeQuery) => EventEnvelope[] | Promise<EventEnvelope[]> = query => store.range(query)
  const host = { log: nullLogger(), store: { range: (query: EventRangeQuery) => range(query) }, async pushEvent(event: Record<string, unknown>, options: unknown) { events.push({ event, options }) } } as unknown as WorldHost
  const worlds: LifeWorld[] = []
  t.after(async () => { for (const world of worlds) await world.stop(); rmSync(dir, { recursive: true, force: true }) })
  const create = () => {
    const world = new LifeWorld({ cfg, dataDir: dir, timezone: 'UTC', affinityCfg: { ...AFFINITY_DEFAULTS, favoredId: cfg.favoredId, favoredSay: '测试中的优待态度' } })
    worlds.push(world)
    const state = world as unknown as { state: { activity: string; energy: number }; now: () => Date }
    state.now = () => new Date('2026-10-24T12:00:00')
    state.state.activity = '阅读'; state.state.energy = 0.9
    return world
  }
  return { cfg, dir, events, host, create, store, setRange(value: typeof range) { range = value } }
}

test('humanlike automatic reach rolls once per favored interval and persists failed attempts across restart', async t => {
  const f = setup(t)
  let at = Date.parse('2026-10-24T12:00:00Z')
  t.mock.method(Date, 'now', () => at)
  let world = f.create()
  await world.start(f.host)
  let draws = 0
  t.mock.method(Math, 'random', () => { draws++; return 0.9 })
  await world.maybeReachOut()
  assert.equal(f.events.length, 0)
  assert.equal(draws, 1)
  const data = JSON.parse(readFileSync(join(f.dir, 'life.json'), 'utf8'))
  assert.equal(data.lastFavoredReachAttemptAt, at)
  at += 60_000
  await world.maybeReachOut()
  assert.equal(draws, 1)
  await world.stop()
  world = f.create()
  await world.start(f.host)
  const afterStart = draws
  await world.maybeReachOut()
  assert.equal(draws, afterStart)
  at += f.cfg.reachFavoredGapMinutes * 60_000
  await world.maybeReachOut()
  assert.equal(draws, afterStart + 1)
})

test('humanlike automatic ordinary reach rolls once per ordinary interval', async t => {
  const f = setup(t, { favoredId: 0, reachChance: 0.25 })
  let at = Date.parse('2026-10-24T12:00:00Z')
  t.mock.method(Date, 'now', () => at)
  writeFileSync(join(f.dir, 'affinity.json'), JSON.stringify({ people: { '67890': { score: 70, lastAt: new Date(at - 24 * 3600_000).toISOString() } } }))
  const world = f.create()
  await world.start(f.host)
  let draws = 0
  t.mock.method(Math, 'random', () => { draws++; return 0.9 })
  await world.maybeReachOut()
  assert.equal(draws, 1)
  at += 60_000
  await world.maybeReachOut()
  assert.equal(draws, 1)
  assert.equal(f.events.length, 0)
  at += f.cfg.reachMinGapMinutes * 60_000
  await world.maybeReachOut()
  assert.equal(draws, 2)
})

test('humanlike zero probability emits nothing even with a zero random draw and manual reach remains available', async t => {
  const f = setup(t, { reachFavoredChance: 0 })
  const world = f.create()
  await world.start(f.host)
  t.mock.method(Math, 'random', () => 0)
  await world.maybeReachOut()
  assert.equal(f.events.length, 0)
  const tool = world.tools().find(tool => tool.name === 'humanlike_life_reach')!
  assert.match(String(await tool.handler({}, {} as never)), /private:12345/)
})

test('humanlike reach has no account-zero fallback when no candidate exists', async t => {
  const f = setup(t, { favoredId: 0, reachChance: 1 })
  const world = f.create()
  await world.start(f.host)
  await world.maybeReachOut()
  assert.equal(f.events.length, 0)
  const tool = world.tools().find(tool => tool.name === 'humanlike_life_reach')!
  const text = String(await tool.handler({}, {} as never))
  assert.match(text, /没有符合/)
  assert.doesNotMatch(text, /private:0/)
})

test('humanlike reach event includes score, tier, attitude and explicitly flushes', async t => {
  const f = setup(t, { reachFavoredChance: 1 })
  const world = f.create()
  await world.start(f.host)
  t.mock.method(Math, 'random', () => 0)
  await world.maybeReachOut()
  assert.equal(f.events.length, 1)
  assert.equal(f.events[0].event.origin, 'internal')
  assert.equal(f.events[0].event.senderKey, '12345')
  assert.match(String(f.events[0].event.text), /100 分，好朋友；态度：测试中的优待态度/)
  assert.deepEqual(f.events[0].options, { trigger: 'flush' })
  await world.maybeReachOut()
  assert.equal(f.events.length, 1)
})

test('humanlike live QQ messages suppress a stale favored target without rereading affinity', async t => {
  const f = setup(t, { reachFavoredChance: 1 })
  const world = f.create()
  await world.start(f.host)
  f.store.append({ type: 'qq.message', origin: 'external', source: 'qq', senderKey: '12345', text: 'fixture recent chat', ts: new Date().toISOString(), meta: { user_id: 12345 } })
  await world.maybeReachOut()
  assert.equal(f.events.length, 0)
})

test('humanlike derived QQ material cannot suppress a real reach check', async t => {
  const f = setup(t, { reachFavoredChance: 1 })
  const world = f.create()
  await world.start(f.host)
  f.store.append({ type: 'qq.message', origin: 'external', source: 'qq', senderKey: '12345', text: 'fixture derived chat', ts: new Date().toISOString(), meta: { user_id: 12345, materialKind: 'event' } })
  await world.maybeReachOut()
  assert.equal(f.events.length, 1)
})

test('humanlike global successful-reach gap prevents an ordinary target followed immediately by favored', async t => {
  const f = setup(t, { reachFavored: false, reachChance: 1, reachFavoredChance: 1 })
  let at = Date.parse('2026-10-24T12:00:00Z')
  t.mock.method(Date, 'now', () => at)
  writeFileSync(join(f.dir, 'affinity.json'), JSON.stringify({ people: { '67890': { score: 70, lastAt: new Date(at - 24 * 3600_000).toISOString() } } }))
  const world = f.create()
  await world.start(f.host)
  await world.maybeReachOut()
  assert.equal(f.events[0].event.senderKey, '67890')
  f.cfg.reachFavored = true
  at += 60_000
  await world.maybeReachOut()
  assert.equal(f.events.length, 1)
})

test('humanlike stop waits for an asynchronous live-message read and prevents a stale host reach', async t => {
  const f = setup(t, { reachFavoredChance: 1 })
  const world = f.create()
  await world.start(f.host)
  let resolve!: (events: EventEnvelope[]) => void
  f.setRange(() => new Promise(done => { resolve = done }))
  const running = world.maybeReachOut()
  assert.ok(resolve)
  const stopping = world.stop()
  resolve([])
  await Promise.all([running, stopping])
  assert.equal(f.events.length, 0)
})
