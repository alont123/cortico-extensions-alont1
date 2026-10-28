import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { JsonlEventStore } from 'cortico/core/event-store.ts'
import { nullLogger } from 'cortico/core/util.ts'
import { QQWorld } from '../packages/cortico-world-qq-better-alont1/src/world.ts'
import { OneBotDriver } from '../packages/cortico-world-qq-better-alont1/src/driver.ts'
import { QQ_DEFAULTS, normalizeConfig } from '../packages/cortico-world-qq-better-alont1/src/config.ts'
import { splitReplyIntoMessages } from '../packages/cortico-world-qq-better-alont1/src/normalize.ts'
import type { OneBotSegment } from '../packages/cortico-world-qq-better-alont1/src/types.ts'

const segment = (text: string): OneBotSegment => ({ type: 'text', data: { text } })
const plain = (groups: OneBotSegment[][]) => groups.flat().filter(s => s.type === 'text').map(s => s.data.text).join('')
const outcomeText = (result: any) => typeof result === 'string' ? result : result.text

function fixture(t: { after(fn: () => Promise<void>): void }, patch: Partial<typeof QQ_DEFAULTS> = {}) {
  const parent = resolve(tmpdir()), dir = mkdtempSync(join(parent, 'cortico-chat-qq-'))
  assert.equal(resolve(dir, '..'), parent)
  const cfg = Object.assign(structuredClone(QQ_DEFAULTS), patch, { sendIntervalMs: 0, privates: [40001, 40002], groups: [50001] })
  cfg.antiLoop.enabled = false; cfg.groupSpeak.enabled = false
  const world = new QQWorld(cfg, dir, join(dir, 'qqbot')) as any
  world.log = nullLogger()
  for (const id of cfg.privates) world.ensureConv('private', id)
  world.ensureConv('group', 50001)
  const store = new JsonlEventStore({ dataDir: join(dir, 'events'), run: 'test', timezone: 'UTC' })
  const emitted: any[] = [], sent: any[] = []
  world.host = { store, pushEvent: async (event: any) => { emitted.push(structuredClone(event)); return store.append({ ...event, blobs: undefined }) } }
  world.driver = { callApi: async (_action: string, params: any) => { sent.push(structuredClone(params)); return { message_id: 8000 + sent.length } }, stop: async () => {} }
  const send = (text: string, to = 'private:40001', context = {}) => world.tools().find((tool: any) => tool.name === 'qqbot_send').handler({ text, to }, context)
  t.after(async () => { await world.stop(); rmSync(dir, { recursive: true, force: true }) })
  return { cfg, world, store, emitted, sent, send }
}

test('QQ defaults merge three short sentences in private and group conversations', async t => {
  const { send, sent, emitted } = fixture(t)
  const text = '第一项确认好了。第二项稍后处理。最后一项明天看。'
  assert.match(outcomeText(await send(text)), /发送 1\/1/)
  assert.match(outcomeText(await send(text, 'group:50001')), /发送 1\/1/)
  assert.equal(sent.length, 2)
  assert.equal(plain(sent.map(message => message.message)), text + text)
  assert.equal(emitted.length, 2)
})

test('QQ private sentence splitting is opt-in and the existing false switch still wins', async t => {
  const { cfg, send, sent } = fixture(t, { splitMinChars: 0, splitReplyMaxMessages: 10, coalesceShortSentences: false })
  const text = '甲。乙。丙。'
  await send(text); assert.equal(sent.length, 1)
  cfg.splitPrivateReplies = true
  await send(text); assert.equal(sent.length, 4)
  cfg.splitReplyBySentence = false
  cfg.splitParagraphs = true
  await send('甲。\n\n乙。\n\n丙。'); assert.equal(sent.length, 5)
})

test('QQ short sentences coalesce and the message cap merges without dropping text', () => {
  const input = '第一小句。第二小句。第三小句。第四小句。'
  const opts = { splitBySentence: true, sentencesPerMessage: 1, maxBytes: 1500, minChars: 10 }
  const separate = splitReplyIntoMessages([segment(input)], opts)
  const coalesced = splitReplyIntoMessages([segment(input)], { ...opts, coalesceShortSentences: true })
  const capped = splitReplyIntoMessages([segment(input)], { ...opts, maxMessages: 2 })
  assert.equal(separate.length, 4)
  assert.ok(coalesced.length < separate.length)
  assert.ok(capped.length <= 2)
  assert.equal(plain(coalesced), input)
  assert.equal(plain(capped), input)
})

test('QQ rejects a message exceeding byte and count budgets before any send attempt', async t => {
  const { send, sent, emitted } = fixture(t, { maxMessageBytes: 8, splitReplyMaxMessages: 2 })
  const result = await send('完整内容必须保留😀'.repeat(8))
  assert.equal(result.failed, true)
  assert.match(result.text, /超过单次上限 2.*未发送/)
  assert.equal(sent.length, 0); assert.equal(emitted.length, 0)
})

test('QQ byte splitting preserves Unicode when voluntary private splitting is disabled', async t => {
  const { send, sent } = fixture(t, { maxMessageBytes: 12, splitReplyMaxMessages: 20 })
  const input = '甲😀乙丙'.repeat(4)
  await send(input)
  assert.equal(plain(sent.map(message => message.message)), input)
  assert.ok(sent.length > 1)
  assert.ok(sent.every(message => Buffer.byteLength(plain([message.message])) <= 12))
})

test('QQ sends structured text under the cumulative byte cap and rejects impossible count limits', async t => {
  const { cfg, send, sent } = fixture(t, { maxMessageBytes: 10, splitReplyMaxMessages: 3 })
  const original = 'aaaaaaa @40002 bbbbbbbb'
  await send(original)
  assert.ok(sent.length > 1)
  assert.ok(sent.every(message => Buffer.byteLength(plain([message.message])) <= 10))
  assert.equal(sent.flatMap(message => message.message).filter((s: OneBotSegment) => s.type === 'at').length, 1)
  assert.equal(plain(sent.map(message => message.message)), 'aaaaaaa  bbbbbbbb')
  const count = sent.length
  cfg.splitReplyMaxMessages = 1
  const rejected = await send(original)
  assert.equal(rejected.failed, true)
  assert.match(rejected.text, /超过单次上限/)
  assert.equal(sent.length, count)
  cfg.maxMessageBytes = 3
  assert.equal((await send('😀')).failed, true)
  assert.equal(sent.length, count)
})

test('QQ stops after a partial failure and records only accepted segments', async t => {
  const { world, send, emitted, store } = fixture(t, { maxMessageBytes: 6, splitMinChars: 0, splitPrivateReplies: true, splitReplyMaxMessages: 3, coalesceShortSentences: false })
  let attempts = 0
  world.driver.callApi = async () => { if (++attempts === 1) return { message_id: 8801 }; throw new Error('fixture response lost') }
  const result = await send('甲。乙。丙。')
  assert.equal(result.failed, true)
  assert.match(result.text, /服务已受理 1，结果未确认 1，未尝试 1/)
  assert.match(result.text, /8801/)
  assert.equal(attempts, 2)
  assert.equal(emitted.length, 1)
  assert.deepEqual(emitted[0].tags, ['speak']); assert.equal(emitted[0].origin, 'external')
  assert.equal(emitted[0].type, 'qq.sent')
  assert.equal(emitted[0].meta.text, '甲。')
  assert.equal(emitted[0].meta.delivery, 'accepted')
  assert.deepEqual(emitted[0].meta.conv, { kind: 'private', id: 40001, address: 'private:40001' })
  assert.equal(store.range({ source: 'qqbot' })[0].meta?.messageId, '8801')
  await world.tools().find((tool: any) => tool.name === 'qqbot_confirm_send').handler({}, {})
  assert.equal(attempts, 2)
})

test('QQ a first failed attempt stops the remainder and is never reported as accepted', async t => {
  const { world, send, emitted } = fixture(t, { maxMessageBytes: 6, splitMinChars: 0, splitPrivateReplies: true, splitReplyMaxMessages: 3, coalesceShortSentences: false })
  let attempts = 0
  world.driver.callApi = async () => { attempts++; throw new Error('fixture connection lost') }
  const result = await send('甲。乙。丙。')
  assert.equal(result.failed, true)
  assert.match(result.text, /服务已受理 0，结果未确认 1，未尝试 2/)
  assert.equal(attempts, 1); assert.equal(emitted.length, 0)
})

test('QQ stop while an acknowledgement is pending prevents later segments', async t => {
  const { world, send, emitted } = fixture(t, { maxMessageBytes: 6, splitMinChars: 0, splitPrivateReplies: true, splitReplyMaxMessages: 3, coalesceShortSentences: false })
  let release!: (value: unknown) => void, attempts = 0
  world.driver.callApi = async () => { attempts++; return new Promise(resolve => { release = resolve }) }
  const resultPromise = send('甲。乙。丙。')
  await world.stop()
  release({ message_id: 9901 })
  const result = await resultPromise
  assert.equal(result.failed, true)
  assert.match(result.text, /服务已受理 1，结果未确认 0，未尝试 2/)
  assert.equal(attempts, 1); assert.equal(emitted.length, 1)
})

test('QQ blocks new sends as soon as stop starts and can send after a mocked restart', async t => {
  const { world, send, sent } = fixture(t)
  let finishStop!: () => void
  world.driver.stop = () => new Promise<void>(resolve => { finishStop = resolve })
  const stopping = world.stop()
  assert.equal(typeof finishStop, 'function')
  const blocked = await send('停止中绝不启动的新模拟发送。')
  assert.equal(blocked.failed, true)
  assert.equal(sent.length, 0)
  finishStop(); await stopping
  // Exercise the real World.start lifecycle while every network driver method is a stub.
  t.mock.method(OneBotDriver.prototype, 'start', async () => {})
  t.mock.method(OneBotDriver.prototype, 'stop', async () => {})
  t.mock.method(OneBotDriver.prototype, 'callApi', async (_action: string, params: any) => {
    sent.push(structuredClone(params)); return { message_id: 9911 }
  })
  await world.start({ ...world.host, log: nullLogger() })
  const restarted = await send('重启后的模拟发送。')
  assert.match(outcomeText(restarted), /发送 1\/1/)
  assert.equal(sent.length, 1)
})

test('QQ cancellation before dispatch never sends or creates a sent event', async t => {
  const { send, sent, emitted } = fixture(t)
  const signal = AbortSignal.abort()
  const result = await send('取消测试。', 'private:40001', { signal })
  assert.equal(result.failed, true)
  assert.equal(sent.length, 0); assert.equal(emitted.length, 0)
})

test('QQ acknowledgement without message id is accepted but not described as read', async t => {
  const { world, send, emitted } = fixture(t)
  world.driver.callApi = async () => undefined
  const result = await send('编号缺失的模拟回执。')
  assert.match(outcomeText(result), /服务受理，非已读确认/)
  assert.equal(emitted[0].meta.messageId, null)
  assert.equal(emitted[0].meta.delivery, 'accepted')
})

test('QQ event-store failure after acceptance cannot cause a duplicate send', async t => {
  const { world, send, sent } = fixture(t)
  world.host.pushEvent = async () => { throw new Error('fixture disk full') }
  const result = await send('已经受理的模拟消息。')
  assert.match(outcomeText(result), /回执事件未能记录/)
  assert.equal(sent.length, 1)
})

test('QQ new split settings normalize invalid inputs and preserve an explicit false switch', () => {
  const cfg = Object.assign(structuredClone(QQ_DEFAULTS), { enabled: true, splitMinChars: NaN, splitReplyMaxMessages: Infinity, splitPrivateReplies: true, splitReplyBySentence: false })
  normalizeConfig(cfg)
  assert.equal(cfg.splitMinChars, QQ_DEFAULTS.splitMinChars)
  assert.equal(cfg.splitReplyMaxMessages, QQ_DEFAULTS.splitReplyMaxMessages)
  assert.equal(cfg.splitReplyBySentence, false)
})

test('QQ normalized message metadata excludes prefix, contact note and reply cue', async t => {
  const { cfg, world, emitted } = fixture(t, { privateAggregationWindow: 0 })
  cfg.replyCue = 'FIXTURE_REPLY_INSTRUCTION'
  world.people.set('40001', 'FIXTURE_CONTACT_NOTE', 'fixture')
  const body = '模拟联系人只说这句话。'
  await world.handleMessage({ post_type: 'message', self_id: 90001, user_id: 40001, message_id: 7001, time: Date.parse('2026-01-02T10:00:00Z') / 1000, message: [segment(body)] }, world.ensureConv('private', 40001), { userId: 40001, name: 'fixture' })
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].meta.messageText, body)
  assert.equal(emitted[0].meta.messageTextBasis, 'normalized-message')
  assert.match(emitted[0].text, /FIXTURE_REPLY_INSTRUCTION/)
  assert.match(emitted[0].text, /FIXTURE_CONTACT_NOTE/)
  assert.doesNotMatch(emitted[0].meta.messageText, /FIXTURE_/)
})

test('QQ message provenance does not attribute a quoted reply to the new sender', async t => {
  const { world, emitted } = fixture(t, { privateAggregationWindow: 0 })
  world.driver.callApi = async () => ({ sender: { nickname: 'fixture-other' }, message: [segment('这句话属于被引用的人。')] })
  await world.handleMessage({ post_type: 'message', self_id: 90001, user_id: 40001, message_id: 7002, time: Date.parse('2026-01-02T10:01:00Z') / 1000, message: [{ type: 'reply', data: { id: '6999' } }, segment('这句话才是当前发言。')] }, world.ensureConv('private', 40001), { userId: 40001, name: 'fixture' })
  assert.match(emitted[0].text, /这句话属于被引用的人/)
  assert.equal(emitted[0].meta.messageText, '这句话才是当前发言。')
})

test('QQ aggregation keeps every platform message source separate for each contact', async t => {
  const { world, emitted } = fixture(t, { privateAggregationWindow: 60000 })
  const sender = { userId: 40001, name: 'fixture' }, first = world.ensureConv('private', 40001), other = world.ensureConv('private', 40002)
  world.aggregatePrivate(first, sender, '第一条模拟原文', [], { platformMessageId: 'a1', messageTs: '2026-01-02T10:00:00Z' })
  world.aggregatePrivate(first, sender, '第二条模拟原文', [], { platformMessageId: 'a2', messageTs: '2026-01-02T10:00:01Z' })
  world.aggregatePrivate(other, { userId: 40002, name: 'other' }, '另一个联系人的模拟原文', [], { platformMessageId: 'b1', messageTs: '2026-01-02T11:00:00Z' })
  world.flushAggregated(first); world.flushAggregated(other)
  assert.equal(emitted.length, 2)
  assert.equal(emitted[0].ts, '2026-01-02T10:00:00Z')
  assert.equal(emitted[0].meta.platformMessageId, null)
  assert.equal(emitted[0].meta.messageTextBasis, 'aggregated-normalized-messages')
  assert.deepEqual(emitted[0].meta.messages, [
    { messageId: 'a1', ts: '2026-01-02T10:00:00Z', text: '第一条模拟原文' },
    { messageId: 'a2', ts: '2026-01-02T10:00:01Z', text: '第二条模拟原文' },
  ])
  assert.doesNotMatch(emitted[0].meta.messageText, /另一个/)
  assert.equal(emitted[1].meta.conv.id, 40002)
})

test('QQ expired aggregation flushes old sources and attachments before adding new ones', async t => {
  const { world, emitted } = fixture(t, { privateAggregationWindow: 60000 })
  const conv = world.ensureConv('private', 40001), sender = { userId: 40001, name: 'fixture' }
  world.aggregatePrivate(conv, sender, '上一批', [{ bytes: new Uint8Array([1]), mime: 'image/png', fallbackText: '[old fixture]' }], { platformMessageId: 'old', messageTs: '2026-01-02T10:00:00Z' })
  conv.pendingAggregatedText.firstAt = Date.now() - 61000
  world.aggregatePrivate(conv, sender, '下一批', [{ bytes: new Uint8Array([2]), mime: 'image/png', fallbackText: '[new fixture]' }], { platformMessageId: 'new', messageTs: '2026-01-02T11:00:00Z' })
  world.flushAggregated(conv)
  assert.equal(emitted[0].meta.messages[0].messageId, 'old')
  assert.equal(emitted[1].meta.messages[0].messageId, 'new')
  assert.equal(emitted[0].blobs[0].bytes[0], 1)
  assert.equal(emitted[1].blobs[0].bytes[0], 2)
})
