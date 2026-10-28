import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { JsonlEventStore } from 'cortico/core/event-store.ts';
import { estimateTokens } from 'cortico/core/util.ts';
import { RESERVED_FRAME_NAMES } from 'cortico/core/loop.ts';
import type { EventEnvelope, FrameEventRef } from 'cortico/core/types.ts';
import { functionCall, functionResult, message, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { collectDialogueEvents, selectDialogue, type DialogueOptions } from '../../packages/cortico-bot-xiaoshen-alont1/persona/dialogue-recovery.ts';
import { renderHandoffNote } from '../../packages/cortico-bot-xiaoshen-alont1/persona/handoffNote.ts';

const now = new Date('2026-01-05T01:00:00+08:00');
const options: DialogueOptions = { windowMinutes: 120, maxMessages: 30, reserveTokens: 2048, prioritizeSenderKeys: ['private:101'] };
const at = (minutesBefore: number) => new Date(now.getTime() - minutesBefore * 60_000).toISOString();

test('final handoff output obeys tiny and normal total budgets without slicing reserved originals', t => {
  const store = fixture(t);
  const user = inbound(store, 101, 'fixture complete question with unique ending END-USER', 10);
  const assistant = outbound(store, 101, 'fixture complete accepted answer with unique ending END-ASSISTANT', 9);
  for (let i = 0; i < 20; i++) store.append({
    type: 'fixture.scene', source: 'fixture', origin: 'external', ts: at(60 - i * 2),
    text: '场景更新'.repeat(100) + i,
  });
  const records = frame(store.range({}));
  for (const budgetTokens of [0, 128, 256, 2048, 4096]) {
    for (const dialogueEnabled of [false, true]) {
      const note = renderHandoffNote(records, {
        now, budgetTokens, speechTools: new Set(['qqbot_send']), foldTokens: 128,
        splitAtMs: now.getTime() - 30 * 60_000,
        ...(dialogueEnabled ? { dialogue: collectDialogueEvents([user, assistant]), dialogueOptions: options } : {}),
      });
      assert.ok(estimateTokens(note.text) <= budgetTokens, 'rendered total must fit budget ' + budgetTokens);
      assert.equal(note.text, note.parts.map(part => part.text).join('\n'));
      assert.equal(note.entries, note.parts.reduce((sum, part) => sum + part.entries, 0));
      const dialogue = note.parts.find(part => part.kind === 'dialogue');
      if (dialogue) {
        for (const original of [user.text, String(assistant.meta!.text)]) {
          if (dialogue.text.includes(original.slice(0, 25))) assert.ok(dialogue.text.includes(original));
        }
      }
      if (budgetTokens === 0) {
        assert.equal(note.text, ''); assert.deepEqual(note.parts, []); assert.equal(note.entries, 0);
      }
    }
    const empty = renderHandoffNote([], { now, budgetTokens, speechTools: new Set() });
    assert.ok(estimateTokens(empty.text) <= budgetTokens);
  }
});

function fixture(t: test.TestContext) {
  const base = resolve('scratch'); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'chat-handoff-'));
  t.after(() => {
    assert.ok(!relative(base, dir).startsWith('..') && dir !== base);
    rmSync(dir, { recursive: true, force: true });
  });
  return new JsonlEventStore({ dataDir: dir, run: 'fixture', timezone: 'UTC' });
}
function inbound(store: JsonlEventStore, id: number, text: string, minutes: number, extra: Partial<EventEnvelope> = {}) {
  return store.append({
    type: 'qq.message', source: 'qqbot', origin: 'external', senderKey: 'private:' + id, ts: at(minutes), text,
    meta: { conv: { kind: 'private', id }, user: id, platformMessageId: 'fixture-' + (store.latestCursor() + 1) },
    ...extra,
  });
}
function outbound(store: JsonlEventStore, id: number, text: string, minutes: number, extra: Partial<EventEnvelope> = {}) {
  return store.append({
    type: 'qq.sent', source: 'qqbot', origin: 'external', senderKey: 'private:' + id, ts: at(minutes), text: 'service accepted: ' + text, tags: ['speak'],
    meta: { conv: { kind: 'private', id }, direction: 'outbound', delivery: 'accepted', messageId: 'ack-' + (store.latestCursor() + 1), text },
    ...extra,
  });
}
function frame(events: readonly EventEnvelope[]): ContextRecord[] {
  let text = '';
  const refs: FrameEventRef[] = [];
  for (const event of events) {
    if (text) text += '\n\n';
    refs.push({ cursor: event.cursor, ts: event.ts, type: event.type, source: event.source, tags: event.tags, start: text.length, chars: event.text.length });
    text += event.text;
  }
  const tool = [...RESERVED_FRAME_NAMES][0];
  const receipt = functionResult('fixture-frame', text, { ts: now.toISOString(), frame: { events: refs } });
  return [functionCall('fixture-frame', tool, '{}', { ts: now.toISOString() }), receipt];
}

test('handoff keeps all ten selected private originals before one thousand later public events', t => {
  const store = fixture(t);
  const originals: EventEnvelope[] = [];
  for (let i = 0; i < 10; i++) originals.push(inbound(store, 101, 'fixture private original ' + i, 100 - i));
  const sent = outbound(store, 101, 'fixture accepted reply', 88);
  for (let i = 0; i < 1000; i++) store.append({
    type: 'dungeon.scene', source: 'dungeon', origin: 'external', senderKey: 'public-square',
    ts: at(50 - i / 100), text: 'fixture public update ' + i + ' / ' + 'noise '.repeat(100),
  });
  const events = store.range({});
  const withoutDialogueReserve = renderHandoffNote(frame(events), {
    now, speechTools: new Set(['qqbot_send']), budgetTokens: 4096, foldTokens: 128,
  });
  assert.equal(originals.filter(event => withoutDialogueReserve.text.includes(event.text)).length, 0);
  const note = renderHandoffNote(frame(events), {
    now, speechTools: new Set(['qqbot_send']), budgetTokens: 4096, foldTokens: 128,
    dialogue: collectDialogueEvents(events), dialogueOptions: options,
  });
  assert.equal(note.dialogueEntries, 11);
  assert.equal(note.parts[0].kind, 'dialogue');
  for (const event of [...originals, sent]) {
    const original = event.type === 'qq.sent' ? String(event.meta!.text) : event.text;
    assert.ok(note.parts[0].text.includes(original));
    assert.equal(note.text.split(original).length - 1, 1, 'source must not repeat in ordinary frame');
    assert.ok(note.parts[0].text.includes('cursor ' + event.cursor));
    assert.ok(note.parts[0].text.includes(event.ts));
  }
  assert.ok(note.dropped > 0);
  assert.ok(estimateTokens(note.text) <= 4096);
  assert.ok(note.text.indexOf('最近双向对话') < note.text.indexOf('fixture public update'));
});

test('recovery excludes other contacts, groups, forged metadata, future events and unknown origins', t => {
  const store = fixture(t);
  const own = inbound(store, 101, 'selected fixture', 5);
  inbound(store, 202, 'another private fixture', 1);
  inbound(store, 101, 'group fixture', 1, { meta: { conv: { kind: 'group', id: 101 }, user: 101 } });
  inbound(store, 101, 'mismatched sender fixture', 1, { senderKey: 'private:202' });
  inbound(store, 101, 'mismatched user fixture', 1, { meta: { conv: { kind: 'private', id: 101 }, user: 202 } });
  inbound(store, 101, 'unknown world fixture', 1, { source: 'unrelated' });
  inbound(store, 101, 'internal fixture', 1, { origin: 'internal' });
  inbound(store, 101, 'future fixture', -1);
  inbound(store, 101, 'old fixture', 121);
  const selected = selectDialogue(collectDialogueEvents(store.range({})), { ...options, now, budgetTokens: 4096 });
  assert.deepEqual(selected.entries.map(entry => entry.cursor), [own.cursor]);
  assert.equal(selected.conversation, 'private:101');
  const automatic = selectDialogue(collectDialogueEvents(store.range({})), { ...options, prioritizeSenderKeys: [], now, budgetTokens: 4096 });
  assert.equal(automatic.conversation, 'private:202');
  assert.deepEqual(automatic.entries.map(entry => entry.text), ['another private fixture']);
});

test('configurable count and window bounds keep original dates across midnight', t => {
  const store = fixture(t);
  for (let i = 0; i < 6; i++) inbound(store, 101, 'fixture dated line ' + i, 70 - i);
  const entries = collectDialogueEvents(store.range({}));
  const selected = selectDialogue(entries, { ...options, maxMessages: 3, now, budgetTokens: 4096 });
  assert.equal(selected.entries.length, 3);
  assert.equal(selected.omittedByCount, 3);
  assert.ok(selected.text.includes(entries[3].ts));
  assert.ok(selected.entries.every(entry => entry.ts.startsWith('2026-01-04')));
  assert.equal(selectDialogue(entries, { ...options, windowMinutes: 30, now, budgetTokens: 4096 }).entries.length, 0);
  assert.equal(selectDialogue(entries, { ...options, prioritizeSenderKeys: ['101'], now, budgetTokens: 4096 }).entries.length, 6);
});

test('raw records deduplicate by source and platform id without treating repeats as new evidence', t => {
  const store = fixture(t);
  const event = inbound(store, 101, 'fixture once', 1);
  const entries = collectDialogueEvents([event, event, { ...event, cursor: event.cursor + 1 }]);
  const selected = selectDialogue(entries, { ...options, now, budgetTokens: 4096 });
  assert.equal(selected.entries.length, 1);
  assert.equal(selected.text.split('fixture once').length - 1, 1);
});

test('only accepted outbound segments enter dialogue, while failed calls and assistant prose do not', t => {
  const store = fixture(t);
  const accepted = outbound(store, 101, 'accepted segment fixture', 1);
  outbound(store, 101, 'failed segment fixture', 1, { meta: { conv: { kind: 'private', id: 101 }, direction: 'outbound', delivery: 'failed', text: 'failed segment fixture' } });
  const snapshot = [
    message('assistant', 'unsent assistant prose fixture', { ts: at(1) }),
    functionCall('failed-call', 'qqbot_send', '{"to":"private:101","text":"unsent proposed fixture"}', { ts: at(1) }),
    functionResult('failed-call', '{"failed":true,"text":"service unavailable"}', { ts: at(1) }),
    ...frame(store.range({})),
  ];
  const note = renderHandoffNote(snapshot, { now, speechTools: new Set(['qqbot_send']), budgetTokens: 4096, dialogue: collectDialogueEvents(store.range({})), dialogueOptions: options });
  assert.equal(note.dialogueEntries, 1);
  assert.equal(note.parts[0].kind, 'dialogue');
  assert.ok(note.parts[0].text.includes(String(accepted.meta!.text)));
  assert.ok(note.parts[0].text.includes('不证明对方收到或已读'));
  assert.ok(!note.parts[0].text.includes('failed segment fixture'));
  assert.ok(!note.parts[0].text.includes('unsent proposed fixture'));
  assert.ok(!note.text.includes('unsent assistant prose fixture'));
  assert.ok(note.text.includes('service unavailable'));
});

test('an oversized original is omitted whole, with counts available to the caller', t => {
  const store = fixture(t);
  inbound(store, 101, 'fixture ' + 'x'.repeat(20_000), 1);
  const selected = selectDialogue(collectDialogueEvents(store.range({})), { ...options, reserveTokens: 256, now, budgetTokens: 4096 });
  assert.equal(selected.entries.length, 0);
  assert.equal(selected.omittedByBudget, 1);
  assert.equal(selected.text, '');
  assert.ok(selected.tokens <= 256);
});

test('normalized private body excludes channel annotations while legacy bodies stay explicitly labelled', t => {
  const store = fixture(t);
  const modern = inbound(store, 101, 'channel annotation and reply cue', 1, {
    meta: { conv: { kind: 'private', id: 101 }, user: 101, messageText: 'normalized fixture body', messageTextBasis: 'normalized-message' },
  });
  const legacy = inbound(store, 101, 'legacy formatted fixture', 2);
  const entries = collectDialogueEvents([modern, legacy]);
  assert.equal(entries[0].text, 'normalized fixture body');
  assert.equal(entries[0].textBasis, 'normalized-message');
  assert.equal(entries[1].textBasis, 'world-delivered');
  const selected = selectDialogue(entries, { ...options, now, budgetTokens: 4096 });
  assert.ok(!selected.text.includes('channel annotation'));
  assert.ok(selected.text.includes('旧 World 投递文字'));
  assert.ok(selected.text.includes('规范化消息正文'));
});

test('aggregated private messages retain separate timestamps, platform ids and source indexes', t => {
  const store = fixture(t);
  const event = inbound(store, 101, 'formatted aggregate fixture', 70, {
    meta: {
      conv: { kind: 'private', id: 101 }, user: 101, messageTextBasis: 'aggregated-normalized-messages',
      messages: [
        { messageId: 'fixture-a', ts: '2026-01-04T23:59:00+08:00', text: 'before midnight fixture' },
        { messageId: 'fixture-b', ts: '2026-01-05T00:01:00+08:00', text: 'after midnight fixture' },
        { messageId: null, ts: '2026-01-05T00:02:00+08:00', text: 'idless fixture one' },
        { messageId: null, ts: '2026-01-05T00:03:00+08:00', text: 'idless fixture two' },
      ],
    },
  });
  const entries = collectDialogueEvents([event]);
  const selected = selectDialogue(entries, { ...options, now, budgetTokens: 4096 });
  assert.equal(selected.entries.length, 4);
  assert.deepEqual(selected.entries.map(entry => entry.sourceIndex), [0, 1, 2, 3]);
  assert.ok(selected.text.includes('2026-01-04T23:59:00+08:00'));
  assert.ok(selected.text.includes('2026-01-05T00:01:00+08:00'));
  assert.ok(!selected.text.includes('formatted aggregate fixture'));
});
