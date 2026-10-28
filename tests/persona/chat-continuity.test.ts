/** Synthetic integration tests of Persona public hooks and real file/tools, without a model or QQ network. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { CoreApi, EventEnvelope, ToolDef, World } from 'cortico/core/types.ts';
import { JsonlEventStore } from 'cortico/core/event-store.ts';
import { functionResult, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { Cormini } from '../../packages/cortico-bot-xiaoshen-alont1/persona/persona.ts';
import { CONVERSATION_DEFAULTS } from '../../packages/cortico-bot-xiaoshen-alont1/persona/conversation-policy.ts';

function fixture(t: test.TestContext) {
  const base = resolve('scratch'); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'continuity-'));
  t.after(() => { assert.ok(relative(base, dir) && !relative(base, dir).startsWith('..')); rmSync(dir, { recursive: true, force: true }); });
  const policy = { ...CONVERSATION_DEFAULTS, prioritizeSenderKeys: 'private:101' };
  const sent: string[] = [];
  const speak: ToolDef = { name: 'fixture_speak', tags: ['speak'], description: 'test', parameters: { type: 'object' },
    handler: async args => { sent.push(String(args.text)); return 'accepted'; } };
  const world = { id: 'qqbot', tools: () => [speak] } as World;
  const memoryDir = join(dir, 'memory');
  const make = () => new Cormini({ memoryDir, worlds: [world], handoff: () => policy });
  const persona = make();
  const external: Array<{text: string; kind: string}> = [], internal: string[] = [];
  let snapshot: ContextRecord[] = [];
  const log = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, emit() {}, child() { return log; } };
  const api = { log, injectInternal: (text: string) => internal.push(text),
    injectExternal: (text: string, kind: string) => external.push({ text, kind }),
    toolsTagged: (tag: string) => new Set(tag === 'speak' ? ['fixture_speak'] : []),
    sessionInfo: () => ({ id: 'main', running: 0, snapshot, estTokens: 0, hardTokens: null }),
    blob: () => ({ bytes: new Uint8Array([1]), mime: 'text/plain' }),
  } as unknown as CoreApi;
  persona.attach(api);
  const store = new JsonlEventStore({ dataDir: join(dir, 'events'), run: 'fixture', timezone: 'UTC' });
  const inbound = (text: string, id = 101, minutes = 1) => store.append({
    type: 'qq.message', source: 'qqbot', origin: 'external', senderKey: 'private:' + id,
    ts: new Date(Date.now() - minutes * 60_000).toISOString(), text: 'channel fixture: ' + text,
    meta: { conv: { kind: 'private', id }, user: id, messageText: text, messageTextBasis: 'normalized-message' },
  });
  const call = async (name: string, args: Record<string, unknown>, who = persona) => {
    const tool = who.declareSessions()[0].tools().find(tool => tool.name === name);
    assert.ok(tool, name); return tool.handler(args, { role: 'main', log });
  };
  return { dir, memoryDir, persona, make, api, external, internal, inbound, call, sent, policy,
    setSnapshot: (next: ContextRecord[]) => { snapshot = next; } };
}

test('observed sources survive a restart; clear does not replay and an existing frame does not duplicate', t => {
  const f = fixture(t), event = f.inbound('合成测试：已完成书架整理');
  f.persona.onDelivery({ events: [event, f.inbound('other contact fixture', 202)] });
  const restarted = f.make(); restarted.attach(f.api);
  restarted.onOpening({ reason: 'restarted' });
  assert.equal(f.external.length, 1);
  assert.ok(f.external[0].text.includes('已完成书架整理'));
  assert.ok(!f.external[0].text.includes('other contact'));
  assert.ok(f.external[0].text.includes(event.ts));
  assert.ok(f.internal.every(text => !text.includes('已完成书架整理')));
  f.external.length = 0;
  restarted.onOpening({ reason: 'cleared' });
  assert.equal(f.external.length, 0);
  f.setSnapshot([functionResult('visible', event.text, { frame: { events: [{
    cursor: event.cursor, ts: event.ts, source: event.source, type: event.type, start: 0, chars: event.text.length,
  }] } })]);
  restarted.onOpening({ reason: 'restarted' });
  assert.equal(f.external.length, 0);
});

test('Persona handoff emits original private context as external and uses actual speak names', async t => {
  const f = fixture(t);
  const events = Array.from({ length: 10 }, (_, i) => f.inbound('合成对话编号-' + i));
  f.persona.onDelivery({ events });
  const result = await f.persona.onHandoff([], { hardTokens: 8192 });
  assert.deepEqual(result.tail, []);
  assert.ok(f.external[0].text.includes('最近双向对话'));
  for (const event of events) assert.ok(f.external[0].text.includes(String(event.meta!.messageText)));
  assert.ok(f.internal.every(text => !text.includes('合成对话编号')));
  const nudge = f.persona.onTurnWouldEnd() ?? '';
  assert.ok(nudge.includes('fixture_speak'));
  assert.ok(!nudge.includes('qq_send'));
});

test('RECENT requires an observed exact quote, keeps original date and blocks every file write route', async t => {
  const f = fixture(t);
  writeFileSync(join(f.memoryDir, 'RECENT.md'), '合成旧记录，来源未知');
  const event = f.inbound('合成来源：已经把蓝色文件夹归档', 101, 60 * 24 * 3);
  f.persona.onDelivery({ events: [event] });
  const quote = await f.call('recent_append', { kind: 'quote', quote: '已经把蓝色文件夹归档', source: { cursor: event.cursor, senderKey: 'private:101' } });
  assert.equal(typeof quote, 'string'); assert.ok(String(quote).includes(event.ts));
  const forged = await f.call('recent_append', { kind: 'quote', quote: '不存在的原话', source: { cursor: event.cursor, senderKey: 'private:101' } });
  assert.equal(typeof forged === 'object' && forged.failed, true);
  for (const name of ['write_file', 'append_file', 'edit_file', 'delete_file', 'save_blob']) {
    const result = await f.call(name, { path: 'RECENT.md', content: 'bad', old_string: '合成', new_string: 'bad', handle: 'log:fixture.txt' });
    assert.match(String(result), /failed|只读|recent_append|RECENT/);
  }
  assert.equal(readFileSync(join(f.memoryDir, 'RECENT.md'), 'utf8'), '合成旧记录，来源未知');
  const read = String(await f.call('read_file', { path: 'RECENT.md' }));
  assert.ok(read.includes('legacy-unsourced')); assert.ok(read.includes('source-matches'));
  const segments = await f.persona.systemSegments({ now: new Date(), timezone: 'UTC', worlds: [] });
  const prefix = segments.map(part => part.text).join('\n');
  assert.ok(!prefix.includes('合成旧记录')); assert.ok(!prefix.includes('蓝色文件夹'));
  assert.ok(prefix.includes('recent_read'));
});

test('finite repeated-question fallback prevents the actual handler and is live-configurable', async t => {
  const f = fixture(t);
  f.persona.onDelivery({ events: [f.inbound('我吃过饭了')] });
  const denied = await f.call('fixture_speak', { to: 'private:101', text: '吃饭了吗？' });
  assert.equal(typeof denied === 'object' && denied.failed, true); assert.deepEqual(f.sent, []);
  await f.call('fixture_speak', { to: 'private:202', text: '吃饭了吗？' });
  assert.equal(f.sent.length, 1);
  f.policy.repeatQuestionFallbackEnabled = false;
  await f.call('fixture_speak', { to: 'private:101', text: '吃饭了吗？' });
  assert.equal(f.sent.length, 2);
});

test('explicit proactive candidates recover one target only, including internal life candidates', t => {
  const f = fixture(t);
  f.persona.onDelivery({ events: [f.inbound('合成甲原文'), f.inbound('合成乙原文', 202)] });
  const candidate = { cursor: 99, ts: new Date().toISOString(), origin: 'internal', source: 'life',
    type: 'life.reach', text: 'candidate', meta: { targetQQ: 202 } } as EventEnvelope;
  f.persona.onDelivery({ events: [candidate] });
  assert.equal(f.external.length, 1);
  assert.ok(f.external[0].text.includes('合成乙原文')); assert.ok(!f.external[0].text.includes('合成甲原文'));
  f.persona.onDelivery({ events: [candidate] }); assert.equal(f.external.length, 1);
});

test('declared evidence storage clear removes cached records without deleting the legacy file', async t => {
  const f = fixture(t);
  writeFileSync(join(f.memoryDir, 'RECENT.md'), 'legacy fixture');
  const event = f.inbound('合成可清除原文');
  f.persona.onDelivery({ events: [event] });
  await f.call('recent_append', { kind: 'quote', quote: '合成可清除原文', source: { cursor: event.cursor, senderKey: 'private:101' } });
  const storage = f.persona.webUi().memory!.storage!.find(item => item.key === 'conversation-records')!;
  assert.ok(storage); await storage.clear();
  assert.equal(JSON.parse(String(await f.call('recent_read', {}))).total, 0);
  assert.equal(readFileSync(join(f.memoryDir, 'RECENT.md'), 'utf8'), 'legacy fixture');
  const restarted = f.make(); restarted.attach(f.api); restarted.onOpening({ reason: 'restarted' });
  assert.equal(f.external.length, 0);
  const missing = await f.call('recent_append', { kind: 'quote', quote: '合成可清除原文', source: { cursor: event.cursor, senderKey: 'private:101' } });
  assert.equal(typeof missing === 'object' && missing.failed, true);
});

test('variants cannot accidentally skip the base ledger policy through ordinary file hooks', async t => {
  const f = fixture(t);
  class PermissiveVariant extends Cormini {
    protected writeGuard(): string | null { return null; }
    protected readOverride(): string | null { return 'ordinary variant text'; }
  }
  writeFileSync(join(f.memoryDir, 'RECENT.md'), 'legacy variant fixture');
  const variant = new PermissiveVariant({ memoryDir: f.memoryDir }); variant.attach(f.api);
  for (const name of ['write_file', 'append_file', 'delete_file', 'save_blob']) {
    const result = await f.call(name, { path: 'RECENT.md', content: 'must fail', handle: 'log:fixture.txt' }, variant);
    assert.match(String(result), /failed/);
  }
  assert.ok(String(await f.call('read_file', { path: 'RECENT.md' }, variant)).includes('legacy-unsourced'));
  assert.equal(await f.call('read_file', { path: 'ordinary.md' }, variant), 'ordinary variant text');
  assert.equal(readFileSync(join(f.memoryDir, 'RECENT.md'), 'utf8'), 'legacy variant fixture');
});
