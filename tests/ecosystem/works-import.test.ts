import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { LogBlobStore } from 'cortico/core/blobs.ts';
import { JsonlEventStore } from 'cortico/core/event-store.ts';
import { nullLogger } from 'cortico/core/util.ts';
import type { WorldHost } from 'cortico/core/types.ts';
import { WorksWorld } from '../../packages/cortico-world-works-alont1/src/world.ts';
import { WORKS_MAX_IMPORT_BYTES } from '../../packages/cortico-world-works-alont1/src/import-image.ts';
import { AlbumWorld } from '../../packages/cortico-world-album-alont1/src/world.ts';
import { ALBUM_DEFAULTS } from '../../packages/cortico-world-album-alont1/src/config.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

function fixture(t: test.TestContext) {
  const scratch = resolve('scratch'); mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'ecosystem-works-'));
  t.after(() => { assert.ok(dir.startsWith(scratch + '\\') || dir.startsWith(scratch + '/')); rmSync(dir, { recursive: true, force: true }); });
  const dataDir = join(dir, 'works-data');
  const blobs = new LogBlobStore(join(dir, 'events-data'));
  const store = new JsonlEventStore({ dataDir: join(dir, 'events-data'), run: 'fixture', timezone: 'UTC' });
  const host = { blob: (handle: string) => blobs.read(handle), store, log: nullLogger(),
    pushEvent() { throw new Error('Import must not emit or forward events'); },
    pushDeferred() { throw new Error('Import must not emit deferred events'); },
  } as unknown as WorldHost;
  const world = new WorksWorld({ dataDir, botDir: dir });
  const call = (target: WorksWorld, name: string, args: Record<string, unknown> = {}) => target.tools().find(tool => tool.name === name)!.handler(args, {} as never);
  const items = () => existsSync(join(dataDir, 'works.json')) ? JSON.parse(readFileSync(join(dataDir, 'works.json'), 'utf8')) : [];
  return { dir, dataDir, blobs, store, host, world, call, items,
    copy: (item: { file: string }) => join(dataDir, 'works', item.file),
  };
}

test('works alone keeps title, local-file and page tools usable without any companion extension', async t => {
  const f = fixture(t);
  const path = join(f.dir, 'standalone.png'); writeFileSync(path, png);
  assert.match(String(await f.call(f.world, 'works_add', { title: 'standalone', path })), /#1/);
  assert.deepEqual(readFileSync(f.copy(f.items()[0])), png);
  assert.match(String(await f.call(f.world, 'works_page')), /1 件/);
  assert.ok(existsSync(join(f.dataDir, 'works', 'index.html')));
});

test('real AlbumWorld hands a real event attachment to works through the host, preserving external origin', async t => {
  const f = fixture(t); const handle = f.blobs.put(png, 'image/png');
  const saved = f.store.append({ type: 'qq.message', source: 'qq', origin: 'external', senderKey: 'fixture-user', ts: '2026-01-01T00:00:00Z', text: 'fixture',
    blobs: [{ handle, mime: 'image/png', fallbackText: 'external fixture image' }] });
  const album = new AlbumWorld({ cfg: ALBUM_DEFAULTS, dataDir: join(f.dir, 'album-data'), botName: 'fixture', timezone: 'UTC' });
  await album.start(f.host); t.after(() => album.stop());
  const entries = JSON.parse(readFileSync(join(f.dir, 'album-data', 'album.json'), 'utf8')).entries;
  const viewed = await album.tools().find(tool => tool.name === 'album_view')!.handler({ ids: [entries[0].id] }, {} as never) as { blobs: Array<{ handle: string }> };
  await f.world.start(f.host);
  assert.match(String(await f.call(f.world, 'works_import_image', { handle: viewed.blobs[0].handle, title: '<script>not code</script>', note: 'from fixture' })), /已收录附件 #1/);
  const item = f.items()[0];
  assert.equal(item.sourceHandle, handle);
  assert.equal(item.sourceSha256, createHash('sha256').update(png).digest('hex'));
  assert.deepEqual(readFileSync(f.copy(item)), png);
  assert.equal(f.store.latestCursor(), saved.cursor, 'no automatic forwarding or event loop');
  assert.equal(f.store.get(saved.cursor)?.origin, 'external');
  await f.call(f.world, 'works_page');
  const html = readFileSync(join(f.dataDir, 'works', 'index.html'), 'utf8');
  assert.ok(html.includes('&lt;script&gt;not code&lt;/script&gt;'));
  assert.ok(html.includes('来源附件：' + handle));
});

test('duplicate and concurrent retries preserve one item and its original title across reload', async t => {
  const f = fixture(t); const handle = f.blobs.put(png, 'image/png'); await f.world.start(f.host);
  const input = { handle, title: 'original' };
  await Promise.all([f.call(f.world, 'works_import_image', input), f.call(f.world, 'works_import_image', { ...input, title: 'retry' })]);
  await f.world.stop();
  const reloaded = new WorksWorld({ dataDir: f.dataDir, botDir: f.dir }); await reloaded.start(f.host);
  assert.match(String(await f.call(reloaded, 'works_import_image', { ...input, title: 'changed' })), /未重复保存或修改/);
  assert.equal(f.items().length, 1); assert.equal(f.items()[0].title, 'original');
  assert.equal(readdirSync(join(f.dataDir, 'works', 'files')).length, 1);
});

test('missing source or cleared source fails without creating a work', async t => {
  const f = fixture(t); await f.world.start(f.host);
  assert.match(String(await f.call(f.world, 'works_import_image', { handle: 'log:missing.png', title: 'missing' })), /附件不存在/);
  const handle = f.blobs.put(png, 'image/png'); f.blobs.clear();
  assert.match(String(await f.call(f.world, 'works_import_image', { handle, title: 'cleared' })), /附件不存在/);
  assert.deepEqual(f.items(), []);
});

test('old host without blob support and stopped host fail clearly while standalone tools remain usable', async t => {
  const f = fixture(t); await f.world.start({} as WorldHost);
  assert.match(String(await f.call(f.world, 'works_import_image', { handle: 'log:missing.png', title: 'old host' })), /未提供附件解析能力/);
  assert.match(String(await f.call(f.world, 'works_add', { title: 'still usable' })), /#1/);
  await f.world.start(f.host); await f.world.stop();
  assert.match(String(await f.call(f.world, 'works_import_image', { handle: 'log:missing.png', title: 'stopped' })), /尚未启动/);
});

test('unsupported handle schemes fail instead of interpreting a path or a future reference protocol', async t => {
  const f = fixture(t); await f.world.start({ ...f.host, blob() { throw new Error('invalid handles must not reach host'); } });
  for (const handle of ['file:///tmp/picture.png', 'asset:v2:picture', 'https://example.invalid/a.png', 'log:', 'mem:line\nbreak']) {
    assert.match(String(await f.call(f.world, 'works_import_image', { handle, title: 'invalid' })), /完整 log: 或 mem:/);
  }
  assert.deepEqual(f.items(), []);
});

test('declared MIME must match raster signatures and SVG or HTML cannot be imported as images', async t => {
  const f = fixture(t); await f.world.start(f.host);
  for (const [bytes, mime] of [[Buffer.from('<script>alert(1)</script>'), 'image/png'], [Buffer.from('<svg onload="bad()"></svg>'), 'image/svg+xml'], [png, 'image/jpeg']] as const) {
    const handle = f.blobs.put(bytes, mime);
    assert.match(String(await f.call(f.world, 'works_import_image', { handle, title: 'reject' })), /文件头一致/);
  }
  assert.deepEqual(f.items(), []);
});

test('empty and oversized images are rejected before copying', async t => {
  const f = fixture(t); const oversized = Buffer.alloc(WORKS_MAX_IMPORT_BYTES + 1); png.copy(oversized);
  for (const bytes of [Buffer.alloc(0), oversized]) {
    await f.world.start({ ...f.host, blob: () => ({ bytes, mime: 'image/png' }) });
    assert.match(String(await f.call(f.world, 'works_import_image', { handle: 'log:large.png', title: 'reject' })), /20 MiB/);
  }
  assert.deepEqual(f.items(), []);
});

test('works copy survives source retention cleanup and duplicate retry does not reread the source', async t => {
  const f = fixture(t); const handle = f.blobs.put(png, 'image/png'); await f.world.start(f.host);
  await f.call(f.world, 'works_import_image', { handle, title: 'kept' }); f.blobs.clear();
  assert.deepEqual(readFileSync(f.copy(f.items()[0])), png);
  assert.match(String(await f.call(f.world, 'works_import_image', { handle, title: 'retry' })), /已收录 #1/);
  await f.call(f.world, 'works_page');
  assert.ok(readFileSync(join(f.dataDir, 'works', 'index.html'), 'utf8').includes(f.items()[0].file));
});

test('index failure removes the new copy and preserves existing entries', async t => {
  const f = fixture(t); const handle = f.blobs.put(png, 'image/png'); await f.world.start(f.host);
  await f.call(f.world, 'works_add', { title: 'existing' });
  const index = join(f.dataDir, 'works.json'); rmSync(index); mkdirSync(index);
  assert.match(String(await f.call(f.world, 'works_import_image', { handle, title: 'rejected' })), /收录失败/);
  assert.equal(readdirSync(join(f.dataDir, 'works', 'files')).length, 0);
  assert.match(String(await f.call(f.world, 'works_list')), /existing/);
  assert.doesNotMatch(String(await f.call(f.world, 'works_list')), /rejected/);
});

test('mem handles are resolved exclusively by the host and a missing local copy is not silently replaced', async t => {
  const f = fixture(t);
  const handle = 'mem:fixture-opaque-key';
  await f.world.start({ ...f.host, blob: value => value === handle ? { bytes: png, mime: 'image/png' } : null });
  assert.match(String(await f.call(f.world, 'works_import_image', { handle, title: 'host image' })), /已收录附件/);
  const item = f.items()[0]; rmSync(f.copy(item));
  assert.match(String(await f.call(f.world, 'works_import_image', { handle, title: 'replace' })), /副本缺失/);
  assert.equal(f.items().length, 1); assert.equal(f.items()[0].title, 'host image');
});
