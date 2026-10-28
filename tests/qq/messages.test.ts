import assert from 'node:assert/strict'
import test from 'node:test'
import { splitLongText, splitReplyIntoMessages } from '../../packages/cortico-world-qq-better-alont1/src/normalize.ts'

const text = (value: string) => ({ type: 'text' as const, data: { text: value } })
const options = { splitBySentence: false, sentencesPerMessage: 1, maxBytes: 20 }
test('QQ splits paragraphs and strips terminal periods while preserving expressive punctuation', () => {
  assert.deepEqual(splitReplyIntoMessages([text('第一段。\n\n第二段！\n\n第三段？')], { ...options, splitParagraphs: true, stripTrailingPeriod: true }), [[text('第一段')], [text('第二段！')], [text('第三段？')]])
})
test('QQ keeps mentions and other structural segments when sentence splitting is enabled', () => {
  const at = { type: 'at' as const, data: { qq: '12345' } }
  const reply = { type: 'reply' as const, data: { id: '99' } }
  const input = [reply, at, text('第一句。第二句。')]
  assert.deepEqual(splitReplyIntoMessages(input, { ...options, maxBytes: 100, splitBySentence: true }), [input])
})
test('QQ UTF-8 splitting terminates for small budgets and preserves all code points', () => {
  for (const budget of [1, 3, 4, 8, 9, 20, 128]) {
    const input = '中文😀\n' .repeat(100)
    const parts = splitLongText(input, budget)
    assert.equal(parts.join(''), input)
    assert.ok(parts.every(part => part.length > 0 && !part.includes('\ufffd')))
    assert.ok(parts.every(part => Buffer.byteLength(part) <= Math.max(budget, 4)))
  }
})
test('QQ enforces byte limits when sentence splitting is off and keeps face-only replies', () => {
  const input = '文字😀'.repeat(20)
  const groups = splitReplyIntoMessages([text(input)], options)
  assert.equal(groups.flat().map(segment => segment.type === 'text' ? segment.data.text : '').join(''), input)
  assert.ok(groups.every(group => group.every(segment => segment.type !== 'text' || Buffer.byteLength(segment.data.text) <= options.maxBytes)))
  const face = { type: 'face' as const, data: { id: '14' } }
  assert.deepEqual(splitReplyIntoMessages([face], { ...options, splitParagraphs: true }), [[face]])
})

test('QQ counts all text segments around mentions toward one byte cap without changing their order', () => {
  const at = { type: 'at' as const, data: { qq: '12345' } }
  const reply = { type: 'reply' as const, data: { id: '99' } }
  const input = [reply, text('aaaaaaaa'), at, text('bbbbbbbb'), text('😀中文')]
  const groups = splitReplyIntoMessages(input, { ...options, maxBytes: 10, maxMessages: 4 })
  const flattened = groups.flat()
  assert.ok(groups.length > 1)
  assert.ok(groups.every(group => Buffer.byteLength(group.filter(s => s.type === 'text').map(s => s.data.text).join('')) <= 10))
  assert.equal(flattened.filter(s => s.type === 'text').map(s => s.data.text).join(''), 'aaaaaaaabbbbbbbb😀中文')
  assert.deepEqual(flattened.filter(s => s.type !== 'text'), [reply, at])
  const mentionIndex = flattened.indexOf(at)
  assert.equal(flattened.slice(0, mentionIndex).filter(s => s.type === 'text').map(s => s.data.text).join(''), 'aaaaaaaa')
  assert.throws(() => splitReplyIntoMessages(input, { ...options, maxBytes: 10, maxMessages: 1 }), /超过单次上限/)
})

test('QQ refuses an indivisible Unicode character that cannot fit the configured byte cap', () => {
  assert.throws(() => splitReplyIntoMessages([text('😀')], { ...options, maxBytes: 3 }), /字节上限/)
  assert.throws(() => splitReplyIntoMessages([{ type: 'at', data: { qq: '12345' } }, text('😀')], { ...options, maxBytes: 3 }), /字节上限/)
})
