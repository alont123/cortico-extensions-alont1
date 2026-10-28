import assert from 'node:assert/strict'
import test from 'node:test'
import type { World, WorldHost } from 'cortico/core/types.ts'
import { attachPanel } from '../../templates/panel-runtime.ts'

const guide = { title: '测试', purpose: '状态', setup: '启用', firstUse: '查看', troubleshoot: '日志' }
const host = {} as WorldHost
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }

test('alternating queued lifecycle requests preserve the final stop after a restart', async () => {
  const gate = deferred(), events: string[] = []
  const world = attachPanel<World>({ id: 'fixture', envPromptVars: () => ({}), tools: () => [],
    async start() { events.push('start'); if (events.length === 1) await gate.promise },
    async stop() { events.push('stop') },
  } satisfies World, {}, guide)
  const first = world.start(host)
  await Promise.resolve()
  const stop = world.stop(), restart = world.start(host), finalStop = world.stop()
  assert.notEqual(stop, finalStop)
  gate.release()
  await Promise.all([first, stop, restart, finalStop])
  assert.deepEqual(events, ['start', 'stop', 'start', 'stop'])
  assert.equal(world.webUi!().lamps![0].state, 'offline')
})

test('adjacent starts coalesce while a later start following a stop remains distinct', async () => {
  const gate = deferred(), events: string[] = []
  const world = attachPanel<World>({ id: 'fixture', envPromptVars: () => ({}), tools: () => [],
    async start() { events.push('start'); await gate.promise }, async stop() { events.push('stop') },
  } satisfies World, {}, guide)
  const first = world.start(host), duplicate = world.start(host)
  assert.equal(first, duplicate)
  const stop = world.stop(), last = world.start(host)
  gate.release(); await Promise.all([first, stop, last])
  assert.deepEqual(events, ['start', 'stop', 'start'])
  assert.equal(world.webUi!().lamps![0].state, 'online')
})

test('panel tracks concurrent tools and the contract failed receipt without retaining arguments', async () => {
  const gate = deferred()
  const world = attachPanel<World>({ id: 'fixture', envPromptVars: () => ({}), async start() {}, async stop() {},
    tools: () => [{ name: 'fixture_read', tags: ['read'], description: '读取', parameters: { type: 'object', properties: {} },
      async handler(args) { await gate.promise; return { text: '未完成', ...(args.fail === true ? { failed: true as const } : {}) } },
    }],
  } satisfies World, {}, guide)
  const tool = world.tools()[0]
  const first = tool.handler({ fail: true, secret: 'never-show-this' }, {} as never)
  const second = tool.handler({}, {} as never)
  assert.equal(world.webUi!().badges!.find(item => item.label === '执行中')!.value, 2)
  gate.release(); await Promise.all([first, second])
  const ui = world.webUi!()
  assert.equal(ui.badges!.find(item => item.label === '执行中')!.value, 0)
  assert.equal(ui.badges!.find(item => item.label === '异常回执')!.value, 1)
  assert.match(String(ui.badges!.find(item => item.label === '最近完成耗时')!.value), /^\d+ ms$/)
  assert.ok(!JSON.stringify(ui).includes('never-show-this'))
})
