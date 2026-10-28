import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { ConversationSources, CONVERSATION_SOURCE_FILE } from '../../packages/cortico-bot-xiaoshen-alont1/persona/conversation-sources.ts';
import { conversationPolicy, withConfiguredOwner } from '../../packages/cortico-bot-xiaoshen-alont1/persona/conversation-policy.ts';
import { collectDialogueEvents, selectDialogue } from '../../packages/cortico-bot-xiaoshen-alont1/persona/dialogue-recovery.ts';
import { repeatedQuestionEvidence } from '../../packages/cortico-bot-xiaoshen-alont1/persona/conversation-repetition.ts';

const now = Date.parse('2026-01-05T01:00:00+08:00');
const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const policy = conversationPolicy({ sourceMaxEvents: 30, prioritizeSenderKeys: 'private:101', sourceRetentionHours: 2 });
function fixture(t: test.TestContext) {
  const base = resolve('scratch'); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'conversation-sources-'));
  t.after(() => {
    assert.ok(dir !== base && !relative(base, dir).startsWith('..'));
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
function event(cursor: number, id = 101, text = 'fixture original', minutes = 5): EventEnvelope {
  return {
    cursor, source: 'qqbot', type: 'qq.message', origin: 'external', ts: at(minutes),
    senderKey: 'private:' + id, text: 'fixture World prefix\n' + text, run: 'fixture',
    meta: { conv: { kind: 'private', id }, user: id, direction: 'inbound', messageText: text,
      messageTextBasis: 'normalized-message', messageTs: at(minutes), platformMessageId: 'fixture-' + cursor },
  };
}
function aggregate(cursor: number, values: Array<{ text: string; ts: string }>): EventEnvelope {
  const original = event(cursor);
  return { ...original, ts: values[0].ts, text: values.map(v => v.text).join('\n'), meta: {
    ...original.meta, platformMessageId: null, messageTextBasis: 'aggregated-normalized-messages',
    messageText: values.map(v => v.text).join('\n'),
    messages: values.map((v, index) => ({ ...v, messageId: 'aggregate-' + cursor + '-' + index })),
  } };
}
function cache(dir: string, cfg = policy, clock: () => number = () => now) {
  return new ConversationSources(dir, () => cfg, clock);
}

test('normalized originals and accepted outbound survive a restart, returned copies cannot mutate storage', t => {
  const dir = fixture(t), source = cache(dir), inbound = event(1);
  const outbound: EventEnvelope = { ...event(2), type: 'qq.sent', tags: ['speak'], meta: {
    conv: { kind: 'private', id: 101 }, direction: 'outbound', delivery: 'accepted', text: 'fixture accepted',
    messageId: 'receipt', segmentIndex: 0, segmentCount: 1,
  } };
  source.observe([inbound, outbound]);
  inbound.meta!.messageText = 'caller mutation';
  const restarted = cache(dir);
  assert.equal(restarted.status(), null);
  assert.equal(restarted.get(1)!.meta!.messageText, 'fixture original');
  assert.equal(restarted.get(1)!.meta!.messageTs, at(5));
  assert.equal(restarted.get(2)!.meta!.delivery, 'accepted');
  restarted.get(1)!.meta!.messageText = 'mutation';
  restarted.snapshot()[0].text = 'mutation';
  assert.equal(restarted.get(1)!.meta!.messageText, 'fixture original');
  assert.notEqual(restarted.get(1)!.text, 'mutation');
});

test('aggregate cache keeps each original date and source index across midnight and restart', t => {
  const dir = fixture(t);
  cache(dir).observe([aggregate(1, [{ text: 'fixture before midnight', ts: at(90) }, { text: 'fixture after midnight', ts: at(30) }])]);
  const restored = cache(dir).snapshot();
  const entries = collectDialogueEvents(restored);
  assert.deepEqual(entries.map(e => [e.ts, e.sourceIndex, e.text]), [
    [at(90), 0, 'fixture before midnight'], [at(30), 1, 'fixture after midnight'],
  ]);
  assert.equal(restored[0].meta!.messageTextBasis, 'aggregated-normalized-messages');
});

test('owner sources survive a flood of newer other contacts within the count cap', t => {
  const dir = fixture(t), source = cache(dir);
  source.observe(Array.from({ length: 10 }, (_, i) => event(i + 1, 101, 'owner fixture ' + i, 90 - i)));
  source.observe(Array.from({ length: 100 }, (_, i) => event(i + 11, 202, 'other fixture ' + i, 30 - i / 10)));
  assert.equal(source.snapshot().length, 30);
  assert.equal(source.snapshot().filter(e => e.senderKey === 'private:101').length, 10);
  assert.equal(cache(dir).snapshot().filter(e => e.senderKey === 'private:101').length, 10);
});

test('reused host cursors replace old source identities and duplicate deliveries do not rewrite the cache', t => {
  const dir = fixture(t), source = cache(dir), file = join(dir, CONVERSATION_SOURCE_FILE);
  const old = event(1, 101, 'old quoted fixture', 60);
  source.observe([old]);
  const before = statSync(file).mtimeMs;
  source.observe([old]);
  assert.equal(statSync(file).mtimeMs, before);
  const replacement = event(1, 202, 'new contact fixture', 5);
  source.observe([replacement]);
  assert.equal(source.get(1)!.senderKey, 'private:202');
  assert.equal(source.get(1)!.ts, at(5));
  assert.equal(source.get(1)!.meta!.messageText, 'new contact fixture');
  assert.ok(!JSON.stringify(cache(dir).snapshot()).includes('old quoted fixture'));
  source.observe([{ ...replacement, type: 'fixture.scene', source: 'fixture' }]);
  assert.equal(source.get(1), undefined);
  assert.equal(cache(dir).get(1), undefined);
});

test('byte cap also removes low priority events before owner events', t => {
  const dir = fixture(t), cfg = conversationPolicy({ ...policy, sourceMaxEvents: 300, sourceMaxChars: 32000 });
  const source = cache(dir, cfg);
  source.observe([event(1, 101, 'owner survives byte cap', 90),
    ...Array.from({ length: 60 }, (_, i) => event(i + 2, 202, '文'.repeat(32000), 30 - i / 10))]);
  assert.ok(statSync(join(dir, CONVERSATION_SOURCE_FILE)).size <= 4 * 1024 * 1024);
  assert.ok(source.get(1));
  assert.ok(source.snapshot().length < 61);
  assert.ok(cache(dir, cfg).get(1));
});

test('retention removes expired and future source messages without changing aggregate indexes', t => {
  const dir = fixture(t), source = cache(dir);
  source.observe([event(1, 101, 'expired fixture', 121), event(2, 101, 'future fixture', -1),
    aggregate(3, [{ text: 'expired aggregate', ts: at(121) }, { text: 'retained aggregate', ts: at(30) }, { text: 'future aggregate', ts: at(-1) }])]);
  const rows = source.snapshot();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, '');
  assert.equal(rows[0].meta!.messageText, '');
  assert.deepEqual(collectDialogueEvents(rows).map(e => [e.sourceIndex, e.text]), [[1, 'retained aggregate']]);
  assert.equal(cache(dir, policy, () => now + 121 * 60_000).snapshot().length, 0);
});

test('damaged JSON is preserved and explicit clear enables clean persistence again', t => {
  const dir = fixture(t), file = join(dir, CONVERSATION_SOURCE_FILE);
  mkdirSync(join(dir, '.persona'));
  writeFileSync(file, '{"version":1,"events":[');
  const before = readFileSync(file), source = cache(dir);
  assert.match(source.status()!, /保留原文件/);
  source.observe([event(1)]);
  assert.deepEqual(readFileSync(file), before);
  assert.equal(source.snapshot().length, 1);
  source.clear();
  assert.equal(source.status(), null);
  assert.equal(source.snapshot().length, 0);
  assert.equal(existsSync(file), false);
  assert.equal(cache(dir).snapshot().length, 0);
  source.observe([event(2)]);
  assert.deepEqual(cache(dir).snapshot().map(e => e.cursor), [2]);
});

test('hard linked source cache is neither overwritten nor deleted', t => {
  const dir = fixture(t), file = join(dir, CONVERSATION_SOURCE_FILE), outside = join(dir, 'untouched.json');
  mkdirSync(join(dir, '.persona'));
  const original = JSON.stringify({ version: 1, events: [] });
  writeFileSync(outside, original); linkSync(outside, file);
  const source = cache(dir);
  source.observe([event(1)]);
  assert.match(source.status()!, /保留原文件/);
  assert.throws(() => source.clear(), /Linked source cache/);
  assert.equal(readFileSync(outside, 'utf8'), original);
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('junction storage directories cannot redirect persistence or clear', t => {
  const dir = fixture(t), target = join(dir, 'redirected'), link = join(dir, '.persona');
  mkdirSync(target); symlinkSync(target, link, 'junction');
  t.after(() => { if (existsSync(link)) unlinkSync(link); });
  const source = cache(dir);
  source.observe([event(1)]);
  assert.ok(source.status());
  assert.throws(() => source.clear(), /Linked source cache/);
  assert.equal(existsSync(join(target, 'recent-sources.json')), false);
});

test('failed replacement removes temporary files and preserves last complete cache', { skip: process.platform !== 'win32' }, t => {
  const dir = fixture(t), source = cache(dir), file = join(dir, CONVERSATION_SOURCE_FILE);
  source.observe([event(1)]);
  const before = readFileSync(file);
  chmodSync(file, 0o444);
  try {
    source.observe([event(2)]);
    assert.match(source.status()!, /未能保存/);
    assert.deepEqual(readFileSync(file), before);
    assert.deepEqual(readdirSync(join(dir, '.persona')), ['recent-sources.json']);
    assert.equal(source.snapshot().length, 2);
  } finally { chmodSync(file, 0o666); }
});

test('malformed events, group messages and incorrect origins never enter this cache', t => {
  const source = cache(fixture(t));
  const invalid = [
    { ...event(1), origin: 'internal' },
    { ...event(2), meta: { conv: { kind: 'group', id: 101 } } },
    { ...event(3), senderKey: 'private:202' },
    { ...event(4), run: 2 },
    { ...event(5), tags: [null] },
    aggregate(6, Array.from({ length: 501 }, () => ({ text: 'too many', ts: at(5) }))),
  ] as unknown as EventEnvelope[];
  assert.doesNotThrow(() => source.observe(invalid));
  assert.equal(source.snapshot().length, 0);
  const valid = event(7); valid.meta!.messages = [null];
  source.observe([valid]);
  assert.equal(source.snapshot().length, 1);
  assert.equal(source.get(7)!.meta!.messages, undefined);
});

test('bounded prefixes are labeled, preserve Unicode, and cannot become complete repetition answers', t => {
  const dir = fixture(t), cfg = conversationPolicy({ ...policy, sourceMaxChars: 256 }), source = cache(dir, cfg);
  const first = event(1, 101, 'a'.repeat(255) + '😀' + 'do not join tail');
  const second = event(2, 101, '我吃了' + ' '.repeat(260) + '其实没有');
  source.observe([first, second, aggregate(3, [
    { text: 'older complete', ts: at(8) }, { text: 'x'.repeat(300), ts: at(7) },
  ])]);
  assert.equal(source.get(1)!.meta!.messageText, 'a'.repeat(255));
  assert.equal(source.get(1)!.meta!.messageTextTruncated, true);
  const aggregateRows = collectDialogueEvents([source.get(3)!]);
  assert.equal(aggregateRows.length, 1);
  assert.equal(aggregateRows[0].sourceIndex, 1);
  assert.equal(aggregateRows[0].text.length, 256);
  assert.equal(aggregateRows[0].truncated, true);
  const note = selectDialogue(collectDialogueEvents(source.snapshot()), {
    windowMinutes: 120, maxMessages: 30, reserveTokens: 2048, budgetTokens: 2048,
    prioritizeSenderKeys: ['private:101'], now: new Date(now),
  });
  assert.match(note.text, /缓存仅保留连续前缀，非完整原文/);
  assert.equal(repeatedQuestionEvidence({
    text: '吃了没', conversation: 'private:101', events: source.snapshot(), now: new Date(now), windowMinutes: 120,
  }), null);
});

test('policy values remain bounded and owner selection requires explicit valid configuration', () => {
  const cfg = conversationPolicy({ sourceMaxEvents: NaN, sourceMaxChars: Infinity,
    dialogueWindowMinutes: -1, dialogueMaxMessages: 999, dialogueReserveTokens: 256.9 });
  assert.equal(cfg.sourceMaxEvents, 500); assert.equal(cfg.sourceMaxChars, 8192);
  assert.equal(cfg.dialogueWindowMinutes, 1); assert.equal(cfg.dialogueMaxMessages, 100);
  assert.equal(cfg.dialogueReserveTokens, 256);
  assert.equal(withConfiguredOwner(cfg, { qqbot: { ownerQQ: 101 } }).prioritizeSenderKeys, 'private:101');
  assert.equal(withConfiguredOwner(cfg, { qqbot: { ownerQQ: '101' } }).prioritizeSenderKeys, '');
  assert.equal(withConfiguredOwner(policy, { qqbot: { ownerQQ: 202 } }).prioritizeSenderKeys, 'private:101');
});
