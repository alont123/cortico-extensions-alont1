import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture } from './helpers.ts'
import { extractEntities, entityProfile, Enhancer } from '../src/entities.ts'
import { normalizeConfig, BRAIN_DEFAULTS } from '../src/config.ts'
import { Ingester } from '../src/ingest.ts'
import { audit } from '../src/audit.ts'

test('offline extraction recognizes typed names identifiers dates links files and amounts', () => {
  const entities = extractEntities('海棠(12345) @12345 群号：7654321 项目：纸舟 2026-01-01 晚上 10月23日 https://example.org/info 记录.md 股票代码：600000 花了12.5元 「清茶约定」')
  for (const type of ['person', 'group', 'project', 'date', 'url', 'file', 'stock', 'money', 'time', 'topic']) assert.ok(entities.some(entity => entity.type === type), type)
  assert.ok(entities.find(entity => entity.name === '12345')!.aliases.includes('海棠'))
})
test('profile counts and co-occurrences retain verifiable relative sources', async t => {
  const f = fixture(t); f.write('MEMORY.md', '海棠(12345) 项目：纸舟'); f.write('notes/day.md', 'QQ号：12345 项目：纸舟'); await f.ingest.sync()
  const row = entityProfile(f.db, '海棠')!; assert.equal(row.mention_count, 2); assert.equal(row.sources.length, 2); assert.ok(row.related.some((item: any) => item.name === '纸舟'))
})
test('LLM disabled does not call an endpoint even when a secret exists', async t => {
  const f = fixture(t); let calls = 0
  const enhancer = new Enhancer(f.db, f.cfg, () => 'fixture-key', (async () => { calls++; throw new Error('must not call') }) as typeof fetch)
  const results = await enhancer.enrich(['昵称：海棠'])
  assert.equal(calls, 0); assert.ok(results[0].entities.length)
})
test('enabled LLM uses a fake endpoint caches results and rejects invented entities', async t => {
  const f = fixture(t); let calls = 0
  const cfg = normalizeConfig({ llm: { ...BRAIN_DEFAULTS.llm, enabled: true, baseUrl: 'http://127.0.0.1:1' } })
  const fake = async (_url: any, init: any) => { calls++; assert.match(init.body, /海棠/); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [{ index: 0, entities: [{ type: 'person', name: '海棠' }, { type: 'person', name: '编造人物' }], summary: '候选摘要', conflicts: [] }] }) } }] })) }
  const enhancer = new Enhancer(f.db, cfg, () => 'fixture-key', fake as typeof fetch)
  assert.equal((await enhancer.enrich(['海棠喝清茶。']))[0].entities.some(item => item.name === '编造人物'), false)
  await enhancer.enrich(['海棠喝清茶。']); assert.equal(calls, 1)
})
test('LLM failure degrades to regex and hourly limit survives new enhancer instances', async t => {
  const f = fixture(t); let calls = 0
  const cfg = normalizeConfig({ llm: { ...BRAIN_DEFAULTS.llm, enabled: true, maxCallsPerHour: 1 } })
  const fake = async () => { calls++; throw new Error('fake endpoint failed') }
  const first = new Enhancer(f.db, cfg, () => 'fixture-key', fake as typeof fetch)
  assert.ok((await first.enrich(['昵称：海棠']))[0].entities.length)
  await new Enhancer(f.db, cfg, () => 'fixture-key', fake as typeof fetch).enrich(['昵称：山岚'])
  assert.equal(calls, 1)
})
test('optional summaries and conflict candidates are source-linked and labelled unverified', async t => {
  const f = fixture(t); f.write('MEMORY.md', '海棠喝清茶。')
  const cfg = normalizeConfig({ llm: { ...BRAIN_DEFAULTS.llm, enabled: true } })
  const fake = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [{ index: 0, entities: [], summary: '清茶偏好候选', conflicts: ['待核对偏好变化'] }] }) } }] }))
  const ingest = new Ingester(f.db, f.workspace, cfg, new Enhancer(f.db, cfg, () => 'fixture-key', fake as typeof fetch))
  await ingest.sync(); assert.equal(f.db.get('SELECT COUNT(*) n FROM annotations')!.n, 1)
  const report = audit(f.db, f.workspace, 1000, 180); assert.equal(report.conflicts.length, 1); assert.match(report.conflicts[0].note, /未核实/)
  assert.equal(report.conflicts[0].source, 'MEMORY.md')
})
