import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import test from 'node:test'
import type { World, WorldHost } from 'cortico/core/types.ts'
import { coerceGroupValues, getByPath, isConfigGroup } from 'cortico/core/config-schema.ts'
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts'
import { attachPanel, completeConfig, withWorldPanel, type PanelGuide } from '../../templates/panel-runtime.ts'
import { XIAOSHEN_USAGE_GROUP } from '../../packages/cortico-bot-xiaoshen-alont1/persona/config.ts'
import { QQ_DEFAULTS, normalizeConfig, toIds } from '../../packages/cortico-world-qq-better-alont1/src/config.ts'
import { definition as CUA } from '../../packages/cortico-world-cua-alont1/src/definition.ts'
import { CUA_DEFAULTS, normalizeCuaConfig } from '../../packages/cortico-world-cua-alont1/src/config.ts'
import { MEMORY_DOCTOR } from '../../packages/cortico-world-memory-doctor-alont1/src/definition.ts'
import { MIND } from '../../packages/cortico-world-mind-alont1/src/definition.ts'
import { writeFileSync } from 'node:fs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const guide: PanelGuide = { title: '测试', purpose: '本地验证。', setup: '启用。', firstUse: '先查看。', troubleshoot: '查看日志。' }
const host = {} as WorldHost
function fake(overrides: Partial<World> = {}): World {
  return { id: 'demo', envPromptVars: () => ({}), tools: () => [], async start() {}, async stop() {}, webUi: () => ({ lamps: [{ label: '组件', state: 'online' }] }), ...overrides }
}

test('panel lamps follow actual lifecycle, preserve component states, and never claim external connectivity', async () => {
  const world = attachPanel(fake(), { enabled: false }, guide)
  assert.equal(world.webUi!().lamps![0].state, 'offline')
  await world.start(host); assert.equal(world.webUi!().lamps![0].state, 'online')
  await world.stop(); assert.equal(world.webUi!().lamps![0].state, 'offline')
  assert.match(world.webUi!().config![0].schema.description!, /外部服务.*实际工具回执/)
})

test('concurrent duplicate starts and stop/restart requests remain ordered without duplicate timers', async () => {
  const events: string[] = []
  const world = attachPanel(fake({ async start() { events.push('start') }, async stop() { events.push('stop') } }), {}, guide)
  await Promise.all([world.start(host), world.start(host)])
  assert.deepEqual(events, ['start'])
  await Promise.all([world.stop(), world.start(host)])
  assert.deepEqual(events, ['start', 'stop', 'start'])
})

test('lifecycle errors stay visible and retain original World rollback and error identity', async () => {
  const failure = new Error('fixture private details'), events: string[] = []
  const world = attachPanel(fake({ async start() { events.push('own rollback'); throw failure }, async stop() { events.push('stop') } }), {}, guide)
  await assert.rejects(world.start(host), error => error === failure)
  assert.deepEqual(events, ['own rollback'])
  assert.equal(world.webUi!().lamps![0].state, 'error')
  assert.ok(!JSON.stringify(world.webUi!()).includes(failure.message))
  await world.stop(); assert.equal(world.webUi!().lamps![0].state, 'offline')
})

test('tools retain result, tags, context and error identity while panel counts calls without recording input', async () => {
  const failure = new Error('fixture'), context = {} as never
  const world = attachPanel(fake({ tools: () => [{ name: 'demo_read', tags: ['read'], description: 'read', parameters: { type: 'object', properties: {} }, handler: async (args, ctx) => { assert.equal(ctx, context); if (args.fail) throw failure; return { text: 'done', isError: args.error === true } } }] }), {}, guide)
  const tool = world.tools()[0]
  assert.deepEqual(tool.tags, ['read'])
  assert.deepEqual(await tool.handler({ secret: 'fixture-sensitive-input' }, context), { text: 'done', isError: false })
  await tool.handler({ error: true }, context)
  await assert.rejects(Promise.resolve(tool.handler({ fail: true }, context)), error => error === failure)
  const ui = world.webUi!()
  assert.equal(ui.badges!.find(b => b.label === '工具调用')!.value, 3)
  assert.equal(ui.badges!.find(b => b.label === '异常回执')!.value, 2)
  assert.ok(!JSON.stringify(ui).includes('fixture-sensitive-input'))
})

test('panel guide augments config without losing existing custom actions, streams or prompt docs', async () => {
  const invoke = async (_panel: string, _method: string, _args: unknown[]) => 'ok', stream = () => {}, doc = { key: 'demo.prompt', title: '提示词', description: '原模板', path: 'fixture.md' }
  const world = attachPanel(fake({ webUi: () => ({ panels: [{ id: 'custom', title: '自定义' }], invoke, stream, promptDocs: [doc] }) }), {}, guide)
  const ui = world.webUi!()
  assert.equal(ui.invoke, invoke); assert.equal(ui.stream, stream); assert.equal(ui.promptDocs![0], doc)
  assert.equal(await ui.invoke!('custom', 'read', []), 'ok')
})

test('a failed status read leaves a visible error plus readable tutorial and repair configuration', () => {
  const world = attachPanel(fake({ webUi() { throw new Error('private path') } }), { enabled: false, limit: 2 }, guide)
  const ui = world.webUi!()
  assert.equal(ui.lamps![0].state, 'error')
  assert.ok(ui.config!.some(g => g.schema.title.includes('中文使用教程')))
  assert.ok(ui.config!.some(g => g.schema.properties['worlds.demo.limit']))
  assert.ok(!JSON.stringify(ui).includes('private path'))
})

test('config completion avoids plaintext credentials, unsupported array editors and duplicate paths', () => {
  const config = completeConfig('demo', { enabled: false, token: 'private', apiKeySecret: 'API_KEY', nested: { count: 5 }, files: ['a', 'b'] }, {}, guide)
  const properties = Object.assign({}, ...config.map(g => g.schema.properties))
  assert.equal(properties['worlds.demo.token'], undefined)
  assert.equal(properties['worlds.demo.apiKeySecret'].type, 'string')
  assert.equal(properties['worlds.demo.nested.count'].type, 'number')
  assert.equal(properties['worlds.demo.files'], undefined)
  assert.match(config[0].schema.description!, /files/)
})

test('captured constructor configuration is marked as requiring remount', () => {
  const prop = { type: 'string' as const, title: '目录', 'x-hot': true }
  const config = completeConfig('demo', { dir: '' }, { config: [{ id: 'world:demo', owner: 'world:demo', schema: { type: 'object', title: 'demo', properties: { 'worlds.demo.dir': prop } } }] }, { ...guide, remount: ['dir'] })
  assert.equal(config[1].schema.properties['worlds.demo.dir']['x-hot'], false)
  assert.equal(prop['x-hot'], true)
})

test('QQ list form round trips preserve account semantics including all-private wildcard', () => {
  for (const key of ['groups', 'privates', 'adminGroups'] as const) {
    const cfg = normalizeConfig({ ...structuredClone(QQ_DEFAULTS), enabled: false })
    cfg[key] = [123456, 234567]
    const group = { id: 'world:qqbot', owner: 'world:qqbot' as const, schema: { type: 'object' as const, title: '名单', properties: { ['worlds.qqbot.' + key]: { type: 'string' as const, title: key } } } }
    const result = coerceGroupValues(group, { ['worlds.qqbot.' + key]: String(cfg[key]) })
    assert.ok('values' in result)
    assert.deepEqual(toIds(result.values['worlds.qqbot.' + key]), toIds(cfg[key]))
  }
  const cfg = normalizeConfig({ ...structuredClone(QQ_DEFAULTS), enabled: false, privates: '*' })
  assert.equal(cfg.privates, '*')
})

test('bot tutorial is visible and read-only instead of becoming a new configuration field', () => {
  assert.ok(isConfigGroup(XIAOSHEN_USAGE_GROUP)); assert.equal(XIAOSHEN_USAGE_GROUP.owner, 'persona')
  assert.equal(Object.keys(XIAOSHEN_USAGE_GROUP.schema.properties).length, 0)
  assert.match(XIAOSHEN_USAGE_GROUP.schema.description!, /开始：.*记忆：.*交接：.*排查：/)
})

test('CUA hot input permission uses the host config and normalizing free play does not mutate defaults', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cua-panel-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const before = structuredClone(CUA_DEFAULTS)
  normalizeCuaConfig({ freePlay: { minutesPerSession: 99 } })
  assert.deepEqual(CUA_DEFAULTS, before)
  const ctx = fakeWorldContext(CUA, { scratchDir: dir })
  const world = CUA.create(ctx)
  assert.match(String((await world.envPromptVars())?.['cua.control']), /只能看/)
  let inputs = 0
  const controlled = world as unknown as Record<string, unknown>
  controlled.doInput = async () => { inputs++ }
  controlled.shot = async () => ({ width: 1, height: 1, scale: 1, jpeg: Buffer.from([0]) })
  const move = world.tools().find(tool => tool.name === 'cua_move')!
  assert.match(String(await move.handler({ x: 1, y: 1 }, {} as never)), /没开/)
  ctx.cfg.allowInput = true
  assert.match(String((await world.envPromptVars())?.['cua.control']), /可以点击/)
  assert.match(String(await move.handler({ x: 1, y: 1 }, {} as never)), /已移到/)
  assert.equal(inputs, 1)
  ctx.cfg.allowInput = false
  assert.match(String(await move.handler({ x: 1, y: 1 }, {} as never)), /没开/)
  assert.equal(inputs, 1)
  const props = Object.assign({}, ...world.webUi!().config!.map(group => group.schema.properties))
  assert.equal(props['worlds.cua.allowInput']['x-hot'], true)
  assert.equal(props['worlds.cua.enabled'], undefined)
})

test('memory doctor hot thresholds change the next report while directory changes require remount', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-doc-panel-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = fakeWorldContext(MEMORY_DOCTOR, { scratchDir: dir })
  mkdirSync(join(ctx.botDir, 'workspace'), { recursive: true }); writeFileSync(join(ctx.botDir, 'workspace/MEMORY.md'), '完全合成的记忆体检内容。'.repeat(100))
  ctx.cfg.sourceDir = 'workspace'
  ctx.cfg.residentFilesJson = '["MEMORY.md"]'
  const world = MEMORY_DOCTOR.create(ctx)
  ctx.cfg.residentWarnTokens = 100000
  assert.doesNotMatch(String((await world.envPromptVars())?.['memoryDoc.residentTokens']), /超过配置提醒线/)
  ctx.cfg.residentWarnTokens = 1
  assert.match(String((await world.envPromptVars())?.['memoryDoc.residentTokens']), /超过配置提醒线/)
  const props = Object.assign({}, ...world.webUi!().config!.map(group => group.schema.properties))
  assert.equal(props['worlds.memory-doc.residentWarnTokens']['x-hot'], true)
  assert.equal(props['worlds.memory-doc.memoryDir']['x-hot'], false)
})

test('an empty mind queue remains online while the extension is running', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mind-empty-panel-'))
  const ctx = fakeWorldContext(MIND, { scratchDir: dir })
  const world = MIND.create(ctx)
  t.after(async () => { await world.stop(); rmSync(dir, { recursive: true, force: true }) })
  const log = { info() {}, warn() {}, error() {}, child() { return this } }
  await world.start({ log, pushEvent: async () => {}, isPaused: () => false } as unknown as WorldHost)
  assert.equal(world.webUi!().lamps![0].state, 'online')
  assert.match(world.webUi!().lamps![0].hint!, /没有惦记/)
  await world.stop(); assert.equal(world.webUi!().lamps![0].state, 'offline')
})

for (const name of readdirSync(join(root, 'packages')).filter(name => name.startsWith('cortico-world-'))) {
  test(`${name}: tutorial, config contracts, idle lifecycle and independent defaults`, async t => {
    const dir = join(root, 'packages', name), manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const def = (await import(pathToFileURL(join(dir, manifest.main)).href)).default
    const scratch = mkdtempSync(join(tmpdir(), 'cortico-panel-')); t.after(() => rmSync(scratch, { recursive: true, force: true }))
    const ctx = fakeWorldContext(def, { scratchDir: scratch, packageDir: dir })
    const world = def.create(ctx), ui = world.webUi('zh')
    const usage = ui.config.filter((g: any) => g.schema.title.includes('中文使用教程'))
    assert.equal(usage.length, 1); assert.equal(Object.keys(usage[0].schema.properties).length, 0)
    assert.match(usage[0].schema.description, /用途：.*启用：.*第一次使用：.*排查：/)
    assert.ok(ui.lamps.every((lamp: any) => lamp.state === 'offline'))
    const names = new Set(world.tools().map((tool: any) => tool.name))
    const guideFile = JSON.parse(readFileSync(join(root, 'docs/panel-guides.json'), 'utf8'))[name.slice('cortico-world-'.length, -'-alont1'.length)]
    for (const match of guideFile.firstUse.matchAll(/\b[a-z]+(?:_[a-z0-9]+)+\b/g)) assert.ok(names.has(match[0]), '教程引用不存在的工具：' + match[0])
    const keys = ui.config.flatMap((g: any) => Object.keys(g.schema.properties))
    assert.equal(new Set(keys).size, keys.length)
    assert.ok(!keys.some((key: string) => /\.(token|password|apiKey|xhsCookie)$/.test(key)))
    const a = def.defaults(), b = def.defaults()
    const refs = (left: any, right: any) => { for (const key of Object.keys(left)) if (left[key] && typeof left[key] === 'object') { assert.notEqual(left[key], right[key]); refs(left[key], right[key]) } }
    refs(a, b)
    const source = readFileSync(join(dir, 'src/panel-runtime.ts'), 'utf8')
    assert.equal(source, readFileSync(join(root, 'templates/panel-runtime.ts'), 'utf8'))
    assert.ok(ui.config.every(isConfigGroup))
  })
}


test('config completion omits activation and obsolete fields from declared schemas and defaults', () => {
  const defaults = { enabled: false, obsolete: true, notifications: { enabled: true } }
  const ui = { config: [{ id: 'world:demo', owner: 'world:demo' as const, schema: {
    type: 'object' as const, title: 'Demo', properties: {
      'worlds.demo.enabled': { type: 'boolean' as const, title: '启用' },
      'worlds.demo.obsolete': { type: 'boolean' as const, title: '旧配置' },
      'worlds.demo.notifications.enabled': { type: 'boolean' as const, title: '通知', 'x-hot': true },
    },
  } }] }
  const snapshot = structuredClone(ui)
  const groups = completeConfig('demo', defaults, ui, { ...guide, omit: ['obsolete'] })
  const properties = Object.assign({}, ...groups.map(group => group.schema.properties))
  assert.deepEqual(Object.keys(properties), ['worlds.demo.notifications.enabled'])
  assert.equal(properties['worlds.demo.notifications.enabled']['x-hot'], true)
  assert.deepEqual(ui, snapshot)
  assert.equal(defaults.enabled, false)
  assert.match(groups[0].schema.description!, /激活控件/)
})

test('humanlike and all seven overlapping standalone extensions visibly warn against enabling together', () => {
  const names = ['affinity', 'learn', 'life', 'clock', 'together', 'mind', 'real']
  const guides = JSON.parse(readFileSync(join(root, 'docs/panel-guides.json'), 'utf8'))
  for (const name of ['humanlike', ...names]) {
    assert.match(guides[name].setup, /不要同时启用/)
    assert.match(readFileSync(join(root, 'packages', 'cortico-world-' + name + '-alont1', 'README.md'), 'utf8'), /不要同时启用/)
  }
  for (const name of names) assert.ok(guides.humanlike.setup.includes(name))
})
