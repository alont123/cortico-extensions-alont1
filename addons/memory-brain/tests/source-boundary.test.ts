import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import type { WorldHost } from 'cortico/core/types.ts'
import { BrainWorld } from '../src/world.ts'
import { BRAIN_DEFAULTS } from '../src/config.ts'

const host = { pushEvent: async () => {} } as unknown as WorldHost
const call = async (world: BrainWorld, name: string, args = {}) => { const outcome = await world.tools().find(tool => tool.name === name)!.handler(args, {} as never); return typeof outcome === 'string' ? outcome : outcome.text }

test('default World stays disabled and cannot infer a Persona workspace', async t => {
  const root = mkdtempSync(join(tmpdir(), 'brain-boundary-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'workspace')); writeFileSync(join(root, 'workspace/MEMORY.md'), 'PRIVATE_SOURCE')
  assert.equal(BRAIN_DEFAULTS.enabled, false)
  const world = new BrainWorld({ cfg: {}, botDir: root, dataDir: join(root, 'data') })
  await assert.rejects(world.start(host), /明确配置.*workspaceSubdir/)
  assert.equal(existsSync(join(root, 'data')), false)
  assert.equal(readFileSync(join(root, 'workspace/MEMORY.md'), 'utf8'), 'PRIVATE_SOURCE')
  const outcome = await world.tools().find(tool => tool.name === 'brain_stats')!.handler({}, {} as never)
  assert.equal(typeof outcome === 'object' && outcome.failed, true)
  await world.stop()
})

test('changing an explicit source cannot expose the previous source database', async t => {
  const root = mkdtempSync(join(tmpdir(), 'brain-source-scope-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const name of ['one', 'two']) mkdirSync(join(root, name))
  writeFileSync(join(root, 'one/MEMORY.md'), '第一资料 茉莉花茶')
  writeFileSync(join(root, 'two/MEMORY.md'), '第二资料 绿豆汤')
  const options = { botDir: root, dataDir: join(root, 'data') }
  const first = new BrainWorld({ ...options, cfg: { workspaceSubdir: 'one', syncOnStart: false } })
  await first.start(host); await call(first, 'brain_sync'); await first.stop()
  const second = new BrainWorld({ ...options, cfg: { workspaceSubdir: 'two', syncOnStart: false } })
  await assert.rejects(second.start(host), /资料目录与已有索引不一致/)
  assert.match(String(await call(second, 'brain_stats')), /尚未启动/)
  await second.stop()
  const fresh = new BrainWorld({ ...options, cfg: { workspaceSubdir: 'two', dbFile: 'two.db', syncOnStart: false } })
  try {
    await fresh.start(host); await call(fresh, 'brain_sync')
    assert.match(String(await call(fresh, 'brain_search', { query: '绿豆汤' })), /绿豆汤/)
    assert.doesNotMatch(String(await call(fresh, 'brain_search', { query: '茉莉花茶' })), /第一资料/)
  } finally { await fresh.stop() }
  const original = new BrainWorld({ ...options, cfg: { workspaceSubdir: 'one', syncOnStart: false } })
  try { await original.start(host); assert.match(String(await call(original, 'brain_search', { query: '茉莉花茶' })), /第一资料/) }
  finally { await original.stop() }
})

test('core and archive files remain under the brain namespace of the host dataDir', async t => {
  const root = mkdtempSync(join(tmpdir(), 'brain-storage-prefix-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'documents')); writeFileSync(join(root, 'documents/MEMORY.md'), 'source stays read only')
  const dataDir = join(root, 'host-data')
  const world = new BrainWorld({ botDir: root, dataDir, cfg: { workspaceSubdir: 'documents', syncOnStart: false, archive: { ...BRAIN_DEFAULTS.archive, enabled: true } } })
  try {
    await world.start(host)
    assert.equal(existsSync(join(dataDir, 'brain/brain.db')), true)
    assert.equal(existsSync(join(dataDir, 'brain/archive.db')), true)
    assert.equal(existsSync(join(dataDir, 'brain.db')), false)
    assert.equal(existsSync(join(root, 'documents/brain.db')), false)
    assert.ok((world.webUi().storage ?? []).every(part => part.key.startsWith('brain.')))
    assert.equal(readFileSync(join(root, 'documents/MEMORY.md'), 'utf8'), 'source stays read only')
  } finally { await world.stop() }
})
