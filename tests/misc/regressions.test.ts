import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitWorkspaceMemory } from '../../packages/cortico-bot-xiaoshen-alont1/persona/memory.ts';
import { applyFixes } from '../../packages/cortico-frugal-alont1/src/apply.mjs';
import { checkRules } from '../../packages/cortico-frugal-alont1/src/check.mjs';
import { MEME_DEFAULTS } from '../../packages/cortico-world-meme-alont1/src/config.ts';
import { MemeWorld } from '../../packages/cortico-world-meme-alont1/src/world.ts';

test('workspace rejects linked directories outside its root for reads, writes and blobs', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cortico-boundary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'workspace');
  const outside = join(dir, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, 'private.md'), 'outside');
  symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const memory = new GitWorkspaceMemory({ memoryDir: root });

  assert.throws(() => memory.readFile('linked/private.md'), /symbolic link/);
  assert.throws(() => memory.insideWorkspace('linked/private.md'), /symbolic link/);
  assert.throws(() => memory.writeFileAtomic('linked/new/note.md', 'blocked'), /symbolic link/);
  assert.throws(() => memory.appendFile('linked/private.md', 'blocked'), /symbolic link/);
  assert.throws(() => memory.ensureDirs(['../outside/new']), /路径/);
  assert.equal(memory.blobs.get('mem:linked/private.md'), null);
  assert.throws(() => memory.blobs.put('linked/new.png', new Uint8Array([1]), 'image/png'), /symbolic link/);
  assert.equal(readFileSync(join(outside, 'private.md'), 'utf8'), 'outside');
});

test('workspace traversal skips links and cycles while ordinary nested files remain usable', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cortico-walk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const memory = new GitWorkspaceMemory({ memoryDir: dir });
  memory.writeFileAtomic('notes/safe.md', 'safe');
  symlinkSync(dir, join(dir, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(memory.walkFiles(), ['notes/safe.md']);
  assert.match(memory.listing(), /notes\/safe.md/);
  assert.equal(memory.blobs.list('').length, 1);
  assert.equal(memory.grep({ match: (line) => line === 'safe' }).length, 1);
  assert.equal(memory.readFile('notes/safe.md'), 'safe');
});

test('frugal rechecks current configuration before applying an older report', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cortico-frugal-refresh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  const rule = { path: 'quota', kind: 'atMost', value: 10, suggest: 8, auto: true };
  const oldReport = checkRules({ quota: 50 }, [rule]);
  writeFileSync(file, JSON.stringify({ quota: 2 }));
  const result = applyFixes(file, oldReport, { apply: true });
  assert.equal(result.written, false);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).quota, 2);
  assert.equal(result.backup, null);

  writeFileSync(file, JSON.stringify({ quota: 30 }));
  const applied = applyFixes(file, oldReport, { apply: true });
  assert.equal(applied.changed[0].from, 30);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).quota, 8);
  assert.equal(JSON.parse(readFileSync(applied.backup!, 'utf8')).quota, 30);
});

test('frugal respects a gate disabled after its original report', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cortico-frugal-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  const rule = { path: 'effort', kind: 'oneOf', value: ['low'], suggest: 'low', auto: true,
    onlyWhen: { path: 'thinking', kind: 'isTrue' } };
  const oldReport = checkRules({ thinking: true, effort: 'high' }, [rule]);
  writeFileSync(file, JSON.stringify({ thinking: false, effort: 'high' }));
  assert.equal(applyFixes(file, oldReport, { apply: true }).written, false);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).effort, 'high');
});

test('meme followup verification accepts complete abbreviations and expansions, rejects fragments', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cortico-meme-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const world = new MemeWorld({ cfg: { ...MEME_DEFAULTS }, dataDir: dir, timezone: 'Asia/Shanghai' });
  const chain = world.tools().find((tool) => tool.name === 'meme_chain')!;
  for (const candidate of ['ZDJD', '真的假的', 'zdjd（真的假的）', 'wkzkbl', '我靠真开播了']) {
    assert.match(String(await chain.handler({ q: 'KSKBL', candidate }, {} as never)), /^接得上/);
  }
  for (const candidate of ['假的', '真', 'jd', '真的假的但是完全是假的']) {
    assert.match(String(await chain.handler({ q: 'KSKBL', candidate }, {} as never)), /^本地没有/);
  }
});
