import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { autoWebUi } from '../../templates/auto-panel.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))

test('configuration defaults require remounting and do not assert external availability', () => {
  const ui = autoWebUi('demo', 'Demo', { enabled: false, endpoint: '', limit: 6 })
  assert.equal(ui.lamps, undefined)
  const group = ui.config![0]!
  assert.equal(group.owner, 'world:demo')
  assert.deepEqual(Object.keys(group.schema.properties), ['worlds.demo.endpoint', 'worlds.demo.limit'])
  assert.ok(Object.values(group.schema.properties).every((field) => field['x-hot'] === false))
})

test('ordinary config saves cannot overwrite host activation, while nested feature switches stay editable', () => {
  const defaults = { enabled: false, notifications: { enabled: true } }
  const group = autoWebUi('demo', 'Demo', defaults, {
    enabled: { title: 'Enable', 'x-hot': true },
    'notifications.enabled': { title: '通知开关', 'x-hot': true },
  }).config![0]!
  assert.equal(Object.hasOwn(group.schema.properties, 'worlds.demo.enabled'), false)
  assert.deepEqual(group.schema.properties['worlds.demo.notifications.enabled'], {
    title: '通知开关', type: 'boolean', 'x-hot': true,
  })
  assert.ok(group.schema.description!.includes('激活/停用按钮'))
  assert.deepEqual(defaults, { enabled: false, notifications: { enabled: true } })
})

test('integer defaults keep decimal configuration and nested leaves remain editable', () => {
  const group = autoWebUi('demo', 'Demo', { cfg: 3, nested: { deeper: { than: { before: 2 } } } }).config![0]!
  assert.equal(group.schema.properties['worlds.demo.cfg']!.type, 'number')
  assert.equal(group.schema.properties['worlds.demo.nested.deeper.than.before']!.type, 'number')
})

test('only finite numeric pairs use the Core array editor', () => {
  const group = autoWebUi('demo', 'Demo', {
    pair: [0.5, 2], empty: [], strings: ['a', 'b'], many: [1, 2, 3], reversed: [2, 1], objects: [{ enabled: true }], invalid: NaN, missing: null,
  }).config![0]!
  assert.deepEqual(Object.keys(group.schema.properties), ['worlds.demo.pair'])
  assert.deepEqual(group.schema.properties['worlds.demo.pair'], {
    title: 'pair', 'x-hot': false, type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
  })
  for (const path of ['empty', 'strings', 'many', 'reversed', 'objects', 'invalid', 'missing']) assert.ok(group.schema.description!.includes(path))
})

test('owners can declare metadata for actual configuration contracts', () => {
  const group = autoWebUi('demo', 'Demo', { mode: 'a', timeoutSec: 2, dir: '' }, {
    mode: { title: 'Mode', enum: ['a', 'b'] },
    timeoutSec: { minimum: 0.5, maximum: 10, 'x-suffix': '秒', 'x-hot': true },
    dir: { 'x-path': { kind: 'directory' } },
  }).config![0]!
  assert.deepEqual(group.schema.properties['worlds.demo.mode']!.enum, ['a', 'b'])
  assert.equal(group.schema.properties['worlds.demo.timeoutSec']!['x-hot'], true)
  assert.equal(group.schema.properties['worlds.demo.timeoutSec']!.minimum, 0.5)
  assert.equal(group.schema.properties['worlds.demo.dir']!['x-path']!.kind, 'directory')
})

test('every independent package carries the canonical helper without a runtime dependency', async () => {
  const template = await readFile(join(root, 'templates', 'auto-panel.ts'), 'utf8')
  let count = 0
  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(root, 'packages', entry.name, 'src', 'panel.ts')
    let content: string
    try { content = await readFile(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    assert.equal(content, template, entry.name)
    count++
  }
  assert.ok(count > 0)
})
