import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'
import { HUMANLIKE } from '../../packages/cortico-world-humanlike-alont1/src/definition.ts'
import { hoistEnabled } from '../../packages/cortico-world-humanlike-alont1/src/config.ts'
import { migrateLegacyData } from '../../packages/cortico-world-humanlike-alont1/src/migrate.ts'

function fixture(t, beforeRemove = async () => {}) {
  const scratch = fileURLToPath(new URL('../../scratch/', import.meta.url))
  mkdirSync(scratch, { recursive: true })
  const dir = mkdtempSync(join(scratch, 'cortico-humanlike-'))
  t.after(async () => {
    await beforeRemove()
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function host(events = []) {
  const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this } }
  return { log, async pushEvent(event) { events.push(event) }, isPaused: () => false }
}

function create(t, overrides = {}) {
  let modules = []
  const botDir = fixture(t, async () => {
    for (const { world } of modules) await world.stop()
  })
  const dataDir = join(botDir, 'custom-data')
  const cfg = HUMANLIKE.defaults()
  cfg.enabled = true
  const world = HUMANLIKE.create({ cfg, dataDir, botDir, timezone: 'UTC', consolePort: 23456, ...overrides })
  modules = world.modules
  return { world, cfg, botDir, dataDir }
}

async function tool(world, name, args = {}) {
  const entry = world.tools().find((candidate) => candidate.name === name)
  assert.ok(entry, `missing tool ${name}`)
  return entry.handler(args)
}

test('humanlike delegates its only enable switch to the host extension card', async (t) => {
  const { world, cfg } = create(t)
  const moduleNames = world.modules.map(({ world }) => world.id)
  assert.deepEqual(moduleNames, ['affinity', 'learn', 'life', 'clock', 'together', 'mind', 'real'])
  for (const name of moduleNames) assert.equal(Object.hasOwn(cfg[name], 'enabled'), false, `${name} has an inert child switch`)
  const paths = world.webUi('zh').config.flatMap(({ schema }) => Object.keys(schema.properties))
  assert.deepEqual(paths.filter((path) => path.endsWith('.enabled')), [])
})

test('explicit legacy switch migration respects an existing root choice', () => {
  const disabled = { enabled: false, mind: { enabled: true, maxPending: 17 } }
  hoistEnabled(disabled)
  assert.deepEqual(disabled, { enabled: false, mind: { maxPending: 17 } })
  const legacy = { mind: { enabled: true, maxPending: 17 } }
  hoistEnabled(legacy)
  assert.deepEqual(legacy, { enabled: true, mind: { maxPending: 17 } })
})

test('humanlike startup and reload preserve the host config and ignore legacy child enable flags', async (t) => {
  const { world, cfg } = create(t)
  // Legacy flags must not override the host's authoritative root switch or be
  // deleted behind its back while it is saving/reloading configuration.
  cfg.enabled = false
  cfg.mind.enabled = true
  cfg.real.enabled = false
  cfg.clock.announce = 'all'
  cfg.mind.maxPending = 17
  const before = structuredClone(cfg)
  for (const value of Object.values(cfg)) if (value && typeof value === 'object') Object.freeze(value)
  Object.freeze(cfg)
  for (let cycle = 0; cycle < 2; cycle++) {
    await world.start(host())
    await world.stop()
    assert.deepEqual(cfg, before)
  }
})

test('humanlike saved settings survive reconstruction and restart', async (t) => {
  const { world, cfg, dataDir, botDir } = create(t)
  cfg.clock.announce = 'all'
  cfg.mind.maxPending = 17
  const saved = JSON.stringify(cfg)
  await world.start(host())
  await world.stop()
  assert.equal(JSON.stringify(cfg), saved)
  const restored = JSON.parse(saved)
  const reloaded = HUMANLIKE.create({ cfg: restored, dataDir, botDir, timezone: 'UTC', consolePort: 23456 })
  try {
    await reloaded.start(host())
    assert.equal(restored.enabled, true)
    assert.equal(restored.clock.announce, 'all')
    assert.equal(restored.mind.maxPending, 17)
    assert.equal(reloaded.modules.length, 7)
  } finally {
    await reloaded.stop()
  }
  assert.deepEqual(restored, JSON.parse(saved))
})

test('humanlike root switch permits clock events and live announce changes', async (t) => {
  const { world, cfg } = create(t)
  cfg.clock.announce = 'all'
  const events = []
  await world.start(host(events))
  const clock = world.modules.find(({ world }) => world.id === 'clock').world
  clock.period = () => '清晨'
  clock.lastPeriod = '深夜'
  clock.lastAnnounceAt = 0
  await clock.tick()
  assert.equal(events.filter((event) => event.type === 'clock.period').length, 1)
  await clock.tick()
  assert.equal(events.filter((event) => event.type === 'clock.period').length, 1)
  cfg.clock.announce = 'off'
  clock.lastPeriod = '深夜'
  clock.lastAnnounceAt = 0
  await clock.tick()
  assert.equal(events.filter((event) => event.type === 'clock.period').length, 1)
})

test('humanlike real tools read live host usage and deployment config outside module state', async (t) => {
  const { world, cfg, botDir, dataDir } = create(t)
  mkdirSync(dataDir, { recursive: true })
  cfg.real.pricingJson = JSON.stringify({ fixture: { hit: [1, 1], miss: [1, 1], out: [2, 2] } })
  const row = (completionTokens) => JSON.stringify({ ts: new Date().toISOString(), model: 'fixture', completionTokens }) + '\n'
  writeFileSync(join(dataDir, 'usage.jsonl'), row(1_000_000))
  writeFileSync(join(botDir, 'config.json'), JSON.stringify({
    context: { maxTokens: 42000 },
    rounds: { soft: 4, hard: 9 },
    worlds: { qqbot: { ownerQQ: 12345, proactive: { minGapSec: 61 } }, humanlike: { enabled: true, mind: { maxPending: 17 } } },
  }))
  assert.match(await tool(world, 'humanlike_real_cost'), /¥2\.00/)
  appendFileSync(join(dataDir, 'usage.jsonl'), row(2_000_000))
  assert.match(await tool(world, 'humanlike_real_cost'), /¥6\.00/)
  const config = await tool(world, 'humanlike_real_config')
  assert.match(config, /上下文窗口上限：42000/)
  assert.match(config, /主动消息全局最小间隔（秒）：61/)
  assert.match(config, /惦记最多挂几件：17/)
  assert.match(config, /对方的 QQ：12345/)
  assert.match(config, /装着并开着的模块：affinity、learn、life、clock、together、mind、real/)
  assert.equal(existsSync(join(dataDir, 'humanlike', 'usage.jsonl')), false)
})

test('humanlike prefix uses host port by default and preserves an explicit console address', async (t) => {
  const { world, cfg } = create(t)
  const requests = []
  const fetchBefore = globalThis.fetch
  t.after(() => { globalThis.fetch = fetchBefore })
  globalThis.fetch = async (url) => {
    requests.push(String(url))
    return new Response(JSON.stringify({ segments: [{ title: 'Fixture', text: 'prefix content' }] }))
  }
  assert.match(await tool(world, 'humanlike_real_prefix'), /prefix content/)
  assert.equal(requests[0], 'http://127.0.0.1:23456/api/prompts/prefix')
  cfg.real.consoleUrl = 'http://127.0.0.1:34567/'
  await tool(world, 'humanlike_real_prefix')
  assert.equal(requests[1], 'http://127.0.0.1:34567/api/prompts/prefix')
})

test('humanlike migration preserves new state and leaves shared usage in the host directory', (t) => {
  const dataDir = fixture(t)
  mkdirSync(join(dataDir, 'humanlike'))
  writeFileSync(join(dataDir, 'affinity.json'), '{"people":{"legacy":{}}}')
  writeFileSync(join(dataDir, 'humanlike', 'affinity.json'), '{"people":{"current":{}}}')
  writeFileSync(join(dataDir, 'mind.json'), '{"items":[{"text":"legacy reminder"}]}')
  writeFileSync(join(dataDir, 'usage.jsonl'), 'live ledger\n')
  const result = migrateLegacyData(dataDir)
  assert.deepEqual(result.migrated.map(({ file }) => file), ['mind.json'])
  assert.match(readFileSync(join(dataDir, 'humanlike', 'affinity.json'), 'utf8'), /current/)
  assert.match(readFileSync(join(dataDir, 'humanlike', 'mind.json'), 'utf8'), /legacy reminder/)
  assert.equal(existsSync(join(dataDir, 'humanlike', 'usage.jsonl')), false)
  assert.equal(readFileSync(join(dataDir, 'usage.jsonl'), 'utf8'), 'live ledger\n')
  assert.deepEqual(migrateLegacyData(dataDir).migrated, [])
})

test('humanlike unwinds partially started modules in reverse order and preserves the start error', async (t) => {
  const { world } = create(t)
  // Stop the fixture's real modules before substituting a lifecycle failure.
  await world.stop()
  const order = []
  const failure = new Error('fixture startup failure')
  world.modules = [
    { label: 'one', world: { async start() { order.push('start one') }, async stop() { order.push('stop one') } } },
    { label: 'two', world: { async start() { order.push('start two'); throw failure }, async stop() { order.push('stop two'); throw new Error('fixture stop failure') } } },
    { label: 'three', world: { async start() { order.push('start three') }, async stop() { order.push('stop three') } } },
  ]
  await assert.rejects(world.start(host()), (error) => error === failure)
  assert.deepEqual(order, ['start one', 'start two', 'stop two', 'stop one'])
  assert.equal(world.host, null)
})
