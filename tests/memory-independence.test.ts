import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test, { type TestContext } from 'node:test'
import { MemsearchWorld } from '../packages/cortico-world-memsearch-alont1/src/world.ts'
import { MEMSEARCH_DEFAULTS } from '../packages/cortico-world-memsearch-alont1/src/config.ts'
import { MemoryDoctorWorld } from '../packages/cortico-world-memory-doctor-alont1/src/world.ts'
import { MEMORY_DOCTOR_DEFAULTS } from '../packages/cortico-world-memory-doctor-alont1/src/config.ts'
import { Heartbeat } from '../packages/cortico-bot-xiaoshen-alont1/persona/heartbeat.ts'
import xiaoshen from '../packages/cortico-bot-xiaoshen-alont1/index.ts'
import { applyFixes } from '../packages/cortico-frugal-alont1/src/apply.mjs'
import { checkRules } from '../packages/cortico-frugal-alont1/src/check.mjs'
import { findDeployment, findProvider } from '../packages/cortico-frugal-alont1/src/find.mjs'

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'memory-independent-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'workspace'))
  mkdirSync(join(root, 'documents'))
  writeFileSync(join(root, 'workspace/MEMORY.md'), '不得自动读取的 Persona 私有内容。')
  writeFileSync(join(root, 'documents/note.md'), '独立资料：茉莉花茶。')
  return root
}
const call = async (world: { tools(): any[] }, name: string, args = {}) => { const outcome = await world.tools().find(tool => tool.name === name)!.handler(args, {}); return typeof outcome === 'string' ? outcome : outcome.text }
const doctor = (root: string, cfg = {}) => new MemoryDoctorWorld({ cfg: { ...MEMORY_DOCTOR_DEFAULTS, ...cfg }, botDir: root, dataDir: join(root, 'own-data'), timezone: 'UTC' })

test('default file Worlds do not discover or read Persona paths', async t => {
  const root = fixture(t)
  const search = new MemsearchWorld({ cfg: { ...MEMSEARCH_DEFAULTS }, botDir: root })
  assert.match(await call(search, 'mem_search', { query: '私有内容' }), /尚未配置资料目录/)
  assert.equal(search.envPromptVars()['memsearch.files'], '0')
  assert.match(await call(doctor(root), 'memory_check'), /尚未配置资料目录/)
  assert.match(await call(doctor(root), 'memory_find', { keyword: '私有内容' }), /尚未配置资料目录/)
  for (const [world, name, args] of [[search, 'mem_search', { query: '私有内容' }], [doctor(root), 'memory_check', {}]] as const) {
    const outcome = await world.tools().find(tool => tool.name === name)!.handler(args, {} as never)
    assert.equal(typeof outcome === 'object' && outcome.failed, true)
  }
})

test('explicit source search works independently and stats removes deleted cached files', async t => {
  const root = fixture(t)
  const world = new MemsearchWorld({ cfg: { ...MEMSEARCH_DEFAULTS, sourceDir: 'documents' }, botDir: root })
  assert.match(await call(world, 'mem_search', { query: '茉莉', count: 'not-a-number' }), /count 必须/ )
  assert.match(await call(world, 'mem_search', { query: '茉莉' }), /note.md:1/)
  assert.doesNotMatch(await call(world, 'mem_search', { query: '私有内容' }), /不得自动读取/)
  rmSync(join(root, 'documents/note.md'))
  assert.match(await call(world, 'mem_stats'), /索引了 0 个文件/)
  assert.doesNotMatch(await call(world, 'mem_search', { query: '茉莉' }), /note.md/)
})

test('file Worlds skip junction escapes and cycles without reading outside sources', async t => {
  const root = fixture(t)
  symlinkSync(join(root, 'workspace'), join(root, 'documents/outside'), process.platform === 'win32' ? 'junction' : 'dir')
  symlinkSync(join(root, 'documents'), join(root, 'documents/loop'), process.platform === 'win32' ? 'junction' : 'dir')
  const world = new MemsearchWorld({ cfg: { ...MEMSEARCH_DEFAULTS, sourceDir: 'documents' }, botDir: root })
  assert.match(await call(world, 'mem_stats'), /索引了 1 个文件/)
  assert.doesNotMatch(await call(world, 'mem_search', { query: '私有内容' }), /不得自动读取/)
  assert.doesNotMatch(await call(doctor(root, { sourceDir: 'documents' }), 'memory_find', { keyword: '私有内容' }), /不得自动读取/)
})

test('doctor honors explicit legacy path and only counts nominated resident files', async t => {
  const root = fixture(t)
  const legacy = doctor(root, { memoryDir: 'documents' })
  assert.match(await call(legacy, 'memory_find', { keyword: '茉莉' }), /note.md:1/)
  assert.equal(legacy.envPromptVars()['memoryDoc.residentTokens'], '0 tok')
  const selected = doctor(root, { sourceDir: 'documents', residentFilesJson: '["note.md"]', residentWarnTokens: 1 })
  assert.match(selected.envPromptVars()['memoryDoc.residentTokens'], /超过配置提醒线/)
  assert.equal(readFileSync(join(root, 'documents/note.md'), 'utf8'), '独立资料：茉莉花茶。')
  assert.throws(() => doctor(root, { residentFilesJson: '["../outside.md"]' }), /相对路径/)
  await call(legacy, 'memory_check')
  mkdirSync(join(root, 'other-documents'))
  writeFileSync(join(root, 'other-documents/note.md'), '另一个资料源。'.repeat(400))
  const otherSource = doctor(root, { sourceDir: 'other-documents' })
  assert.doesNotMatch(await call(otherSource, 'memory_check'), /跟上次比/)
})

test('Persona heartbeat treats invalid delays as paused and avoids timer overflow', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let fired = 0
  for (const delay of [0, -1, NaN, Infinity, 1e20]) {
    const heartbeat = new Heartbeat(() => delay, () => fired++)
    heartbeat.start(); t.mock.timers.tick(1000); heartbeat.stop()
  }
  assert.equal(fired, 0)
  const live = new Heartbeat(() => 100, () => fired++)
  live.start(); t.mock.timers.tick(100); assert.equal(fired, 1)
  live.stop(); t.mock.timers.tick(1000); assert.equal(fired, 1)
})

test('bot configuration defaults do not share mutable logging or usage state across deployments', () => {
  const first = xiaoshen.defaults() as any
  const second = xiaoshen.defaults() as any
  const previous = structuredClone({ logging: second.logging, usage: second.usage })
  first.logging.changedForOneDeployment = true
  first.usage.changedForOneDeployment = true
  assert.deepEqual({ logging: second.logging, usage: second.usage }, previous)
  const third = xiaoshen.defaults() as any
  assert.deepEqual({ logging: third.logging, usage: third.usage }, previous)
})

test('frugal preserves BOM backups and uses distinct atomic-write backups in one second', t => {
  const root = fixture(t)
  const file = join(root, 'config.json')
  const original = '\uFEFF{"limit":50}'
  const rules = [{ path: 'limit', kind: 'atMost', value: 10, suggest: 8 }]
  writeFileSync(file, original)
  const first = applyFixes(file, checkRules({ limit: 50 }, rules), { apply: true, stamp: new Date(0) })
  assert.equal(readFileSync(first.backup!, 'utf8'), original)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).limit, 8)
  writeFileSync(file, '{"limit":90}')
  const second = applyFixes(file, checkRules({ limit: 90 }, rules), { apply: true, stamp: new Date(0) })
  assert.notEqual(first.backup, second.backup)
  assert.equal(readFileSync(second.backup!, 'utf8'), '{"limit":90}')
  assert.equal(readdirSync(root).filter(name => name.includes('.tmp-frugal-')).length, 0)
})

test('frugal rejects ambiguous endpoints and deployment path escapes', t => {
  const root = fixture(t)
  const deployment = join(root, 'deployments/demo')
  for (const name of ['a', 'b']) { mkdirSync(join(deployment, 'providers', name), { recursive: true }); writeFileSync(join(deployment, 'providers', name, 'config.json'), '{}') }
  assert.throws(() => findProvider(root, deployment, undefined), /多个端点/)
  assert.equal(findProvider(root, deployment, 'b')!.name, 'b')
  assert.throws(() => findDeployment(root, '../workspace'), /单个目录名/)
  assert.throws(() => findProvider(root, deployment, '../workspace'), /单个目录名/)
})
