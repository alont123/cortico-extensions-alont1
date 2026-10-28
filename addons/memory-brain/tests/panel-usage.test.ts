import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import type { WorldHost } from 'cortico/core/types.ts'
import definition from '../src/index.ts'

test('installed brain panel has a read-only Chinese tutorial and keeps database tools and four status lamps', async t => {
  const root = mkdtempSync(join(tmpdir(), 'brain-panel-'))
  mkdirSync(join(root, 'workspace')); writeFileSync(join(root, 'workspace/MEMORY.md'), '茉莉花茶是合成测试内容。')
  const cfg = definition.defaults(); cfg.syncOnStart = false; cfg.workspaceSubdir = 'workspace'
  const world = definition.create({ cfg, botDir: root, dataDir: join(root, 'data'), timezone: 'Asia/Shanghai', secret: () => '' } as never)
  t.after(async () => { await world.stop(); rmSync(root, { recursive: true, force: true }) })
  const before = world.webUi!('zh')
  const props = Object.assign({}, ...before.config!.map(group => group.schema.properties))
  assert.equal(props['worlds.brain.enabled'], undefined)
  assert.ok(props['worlds.brain.review.enabled'])
  assert.ok(props['worlds.brain.llm.enabled'])
  const usage = before.config!.filter(group => group.schema.title.includes('中文使用教程'))
  assert.equal(usage.length, 1); assert.equal(Object.keys(usage[0].schema.properties).length, 0)
  assert.match(usage[0].schema.description!, /brain_sync.*brain_stats.*brain_search.*brain_get/)
  assert.ok(before.lamps!.every(lamp => lamp.state === 'offline'))
  const log = { info() {}, warn() {}, error() {}, child() { return this } }
  await world.start({ log, pushEvent: async () => {} } as unknown as WorldHost)
  const sync = world.tools().find(tool => tool.name === 'brain_sync')!
  assert.match(String(await sync.handler({}, {} as never)), /新增 1/)
  const ui = world.webUi!('zh')
  assert.deepEqual(ui.lamps!.map(lamp => lamp.label), ['核心索引', '档案库', '复习', '同步'])
  assert.equal(ui.lamps![0].state, 'online'); assert.equal(ui.lamps![1].state, 'offline')
  assert.equal(ui.badges!.find(badge => badge.label === '工具调用')!.value, 1)
  assert.equal(world.tools().length, 10)
})
