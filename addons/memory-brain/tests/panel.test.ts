import assert from 'node:assert/strict'
import test from 'node:test'
import { BRAIN_CONFIG_GROUP, panel } from '../src/panel.ts'
import { normalizeConfig, BRAIN_DEFAULTS } from '../src/config.ts'
import { isConfigGroup } from 'cortico/core/config-schema.ts'

test('panel declares real cached status and an owned configuration group', () => {
  const ui = panel({ online: false, docs: 0, chunks: 0, entities: 0, due: 0, lastSync: 0, error: '' })
  assert.ok(isConfigGroup(BRAIN_CONFIG_GROUP)); assert.equal(BRAIN_CONFIG_GROUP.owner, 'world:brain'); assert.equal(BRAIN_CONFIG_GROUP.id, 'world:brain')
  assert.ok(ui.lamps!.every(lamp => lamp.state === 'offline'))
})
test('editable JSON adapters preserve all array configuration fields', () => {
  const cfg = normalizeConfig({ includeJson: '["notes/**/*.txt"]', excludeJson: '["notes/private/**"]', review: { ...BRAIN_DEFAULTS.review, intervalsJson: '[2,4,8]' } })
  assert.deepEqual(cfg.include, ['notes/**/*.txt']); assert.deepEqual(cfg.review.intervals, [2, 4, 8]); assert.equal(cfg.exclude[0], 'notes/private/**')
  assert.throws(() => normalizeConfig({ includeJson: '{"bad":1}' }))
})
test('panel exposes a secret name and never a plaintext key', () => {
  const properties = BRAIN_CONFIG_GROUP.schema.properties
  assert.ok(properties['worlds.brain.llm.apiKeySecret'])
  assert.equal(properties['worlds.brain.llm.apiKey'], undefined)
  assert.ok(Object.entries(properties).filter(([, property]) => property.type !== 'object').every(([, property]) => property['x-hot'] === false))
})
test('defaults are independent and unsafe endpoint credentials are rejected', () => {
  const first = normalizeConfig(); first.include.push('extra.md'); assert.equal(normalizeConfig().include.includes('extra.md'), false)
  assert.throws(() => normalizeConfig({ llm: { ...BRAIN_DEFAULTS.llm, enabled: true, baseUrl: 'https://secret@example.org' } }))
  assert.throws(() => normalizeConfig({ llm: { ...BRAIN_DEFAULTS.llm, enabled: 'false' as never } }))
})
