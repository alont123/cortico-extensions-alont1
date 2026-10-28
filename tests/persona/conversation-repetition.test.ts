import assert from 'node:assert/strict';
import test from 'node:test';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { repeatedQuestionEvidence } from '../../packages/cortico-bot-xiaoshen-alont1/persona/conversation-repetition.ts';

const now = new Date('2026-02-14T09:00:00Z');
function answer(text: string, overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    cursor: 42, source: 'qqbot', type: 'qq.message', origin: 'external',
    ts: '2026-02-14T08:00:00Z', senderKey: 'private:101', text: 'formatted channel text',
    meta: { conv: { kind: 'private', id: 101 }, user: 101, messageText: text, messageTextBasis: 'normalized-message' },
    ...overrides,
  };
}
function check(text: string, events: EventEnvelope[], windowMinutes = 240, conversation = 'private:101') {
  return repeatedQuestionEvidence({ text, events, now, windowMinutes, conversation });
}

test('short repeated meal, activity and sleep questions return the exact observed answer evidence', () => {
  for (const [question, body, topic] of [
    ['你吃过饭了吗？', '我已经吃完晚饭了。', 'meal'],
    ['你在做什么呢？', '我正在整理房间。', 'activity'],
    ['睡了吗？', '我刚睡醒了。', 'sleep'],
  ]) {
    const event = answer(body);
    assert.deepEqual(check(question, [event]), { topic, sourceCursor: event.cursor, sourceTs: event.ts, quote: body });
  }
});

test('negations, questions, quotations, vague answers and temporal speculation are not hard suppressions', () => {
  const cases: Array<[string, string]> = [
    ['吃饭了吗？', '我还没吃饭。'], ['吃饭了吗？', '我没有吃过饭。'],
    ['吃饭了吗？', '我吃过了吗？'], ['吃饭了吗？', '他说“我已经吃过饭了”。'],
    ['吃饭了吗？', '昨天吃过饭了。'], ['吃饭了吗？', '我准备吃饭了。'],
    ['吃饭了吗？', '我可能吃过饭了。'], ['在干嘛？', '我在忙。'],
    ['在干嘛？', '我明天在开会。'], ['睡了吗？', '我准备睡了。'],
    ['睡了吗？', '如果我已经睡了。'], ['睡了吗？', '“我睡了”'],
  ];
  for (const [question, body] of cases) assert.equal(check(question, [answer(body)]), null, body);
});

test('contact, group, timestamp and normalized-body boundaries are required', () => {
  const valid = answer('我已经吃过午饭了。');
  assert.equal(check('吃饭了吗？', [valid], 30), null);
  assert.equal(check('吃饭了吗？', [valid], 240, 'private:202'), null);
  assert.equal(check('吃饭了吗？', [valid], 240, 'group:101'), null);
  assert.equal(check('吃饭了吗？', [answer('我已经吃过午饭了。', { ts: '2026-02-14T10:00:00Z' })]), null);
  assert.equal(check('吃饭了吗？', [answer('我已经吃过午饭了。', { meta: { conv: { kind: 'group', id: 101 }, messageText: '我已经吃过午饭了。', messageTextBasis: 'normalized-message' } })]), null);
  assert.equal(check('吃饭了吗？', [answer('ignored', { text: '我已经吃过午饭了。', meta: { conv: { kind: 'private', id: 101 }, user: 101 } })]), null);
  assert.equal(check('吃饭了吗？', [answer('我已经吃过午饭了。', { origin: 'internal' })]), null);
});

test('only the complete narrow question is considered; normal follow-ups and compound messages remain available', () => {
  const events = [answer('我已经吃过午饭了。')];
  for (const text of ['吃饭了吗？喜欢什么口味？', '刚才你说吃了，现在还饿吗？', '你问我“吃饭了吗？”', '今天晚饭吃什么？', '我吃饭了吗？']) {
    assert.equal(check(text, events), null, text);
  }
  assert.equal(check('吃饭了吗？', events, 0), null);
  assert.equal(check('吃饭了吗？', events, Number.NaN), null);
});

test('most recent matching evidence is returned without rewriting its day or quote', () => {
  const older = answer('我吃过饭了。', { cursor: 40, ts: '2026-02-13T23:30:00Z' });
  const current = answer('我刚吃完早饭了。', { cursor: 43, ts: '2026-02-14T08:30:00Z' });
  assert.equal(check('吃饭了吗？', [older, current], 720)?.sourceCursor, 43);
  assert.equal(check('吃饭了吗？', [older], 720)?.sourceTs, older.ts);
});

test('newer negative evidence prevents an older positive answer from forcing suppression', () => {
  const earlier = answer('我已经吃完午饭了。', { cursor: 40, ts: '2026-02-14T07:00:00Z' });
  const later = answer('晚饭还没吃。', { cursor: 43, ts: '2026-02-14T08:30:00Z' });
  assert.equal(check('吃饭了吗？', [earlier, later]), null);
});

test('aggregated normalized answers use their own timestamp and submessage source index', () => {
  const event = answer('unused', {
    ts: '2026-02-13T23:59:00Z',
    meta: { conv: { kind: 'private', id: 101 }, user: 101, messageTextBasis: 'aggregated-normalized-messages', messages: [
      { messageId: 'old', ts: '2026-02-13T23:59:00Z', text: '我已经吃完晚饭了。' },
      { messageId: 'current', ts: '2026-02-14T08:30:00Z', text: '我刚吃完早饭了。' },
    ] },
  });
  assert.deepEqual(check('吃饭了吗？', [event]), {
    topic: 'meal', sourceCursor: 42, sourceTs: '2026-02-14T08:30:00Z', sourceIndex: 1, quote: '我刚吃完早饭了。',
  });
});
