/** Synthetic CDP requests only; never starts a browser or makes an external request. */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { afterEach, expect, it, vi } from 'vitest';
import { VideoBrowser } from '../src/browser.ts';
import { CookieJar } from '../src/login.ts';
import { BILIBILI_VIDEO_DEFAULTS } from '../src/config.ts';

vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: () => { throw new Error('No real browser in content tests'); },
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const flush = () => new Promise<void>(done => setImmediate(done));
const playerUrl = (cid: number) => `https://api.bilibili.com/x/player/wbi/v2?cid=${cid}`;
const dmUrl = (cid: number) => `https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=${cid}&segment_index=1`;
const subtitle = (label: string) => ({ body: JSON.stringify({ data: { subtitle: { subtitles: [{ lan: 'zh', lan_doc: label, subtitle_url: `https://subtitle.example/${label}` }] } } }), base64Encoded: false });
function danmaku(text: string) {
  const content = Buffer.from(text);
  const elem = Buffer.concat([Buffer.from([0x3a, content.length]), content]);
  return { body: Buffer.concat([Buffer.from([0x0a, elem.length]), elem]).toString('base64'), base64Encoded: true };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bili-content-unit-'));
  const replies = new Map<string, unknown>();
  let currentUrl = 'https://www.bilibili.com/video/BV1fixture?p=1';
  const frame = { url: () => currentUrl };
  const cdp = Object.assign(new EventEmitter(), {
    send: vi.fn(async (method: string, args?: { requestId?: string }) => method === 'Network.getResponseBody' ? await replies.get(args!.requestId!) : {}),
    detach: vi.fn(async () => {}),
  });
  const page = Object.assign(new EventEmitter(), {
    url: () => currentUrl, isClosed: () => false, close: vi.fn(async () => {}),
    setUserAgent: vi.fn(async () => {}), setDefaultNavigationTimeout: vi.fn(),
    createCDPSession: vi.fn(async () => cdp), mainFrame: () => frame,
    evaluate: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  });
  const browser = Object.assign(new EventEmitter(), {
    connected: true, pages: async () => [], newPage: async () => page as unknown as Page,
    version: async () => 'Chrome/123.0', close: async () => {}, disconnect: async () => {},
  });
  const cfg = structuredClone(BILIBILI_VIDEO_DEFAULTS);
  cfg.browser.cdpUrl = 'http://127.0.0.1:48123';
  const onDanmaku = vi.fn(), onSubtitleTracks = vi.fn(), onNavigated = vi.fn();
  const video = new VideoBrowser({ cfg, dataDir: root, jar: new CookieJar(join(root, 'cookies.json')), log: () => null,
    onDanmaku, onSubtitleTracks, onNavigated, onLost: vi.fn(), launch: {
      connect: async () => browser as unknown as Browser,
      fetch: vi.fn(async () => new Response(JSON.stringify({ Browser: 'Chrome/123.0', webSocketDebuggerUrl: 'ws://127.0.0.1:48123/devtools/browser/content-fixture' }))) as typeof fetch,
      spawn: () => { throw new Error('No browser launch'); },
    },
  });
  cleanups.push(async () => { await video.stop(); rmSync(root, { recursive: true, force: true }); });
  await video.ensure();
  function begin(id: string, url: string, reply: unknown) {
    replies.set(id, reply); cdp.emit('Network.requestWillBeSent', { requestId: id, request: { url } });
  }
  function finish(id: string, url: string) {
    cdp.emit('Network.responseReceived', { requestId: id, response: { url } });
    cdp.emit('Network.loadingFinished', { requestId: id });
  }
  return { video, page, cdp, onDanmaku, onSubtitleTracks, begin, finish,
    receive(id: string, url: string, reply: unknown) { begin(id, url, reply); finish(id, url); },
    navigate(url = currentUrl) { currentUrl = url; page.emit('framenavigated', frame); },
  };
}

it('delivers current-page subtitles and decoded danmaku', async () => {
  const f = await fixture();
  f.receive('player', playerUrl(100), subtitle('current'));
  f.receive('dm', dmUrl(100), danmaku('current'));
  await flush();
  expect(f.video.playerInfoCid).toBe(100);
  expect(f.onSubtitleTracks).toHaveBeenCalledWith(100, [expect.objectContaining({ label: 'current' })]);
  expect(f.onDanmaku).toHaveBeenCalledWith([expect.objectContaining({ content: 'current' })]);
});

it('drops body reads that complete after navigation and retains the new page results', async () => {
  const f = await fixture(), oldSub = deferred<unknown>(), oldDm = deferred<unknown>();
  f.receive('old-player', playerUrl(100), oldSub.promise);
  f.receive('old-dm', dmUrl(100), oldDm.promise);
  f.navigate('https://www.bilibili.com/video/BV2fixture');
  f.receive('new-player', playerUrl(200), subtitle('new'));
  f.receive('new-dm', dmUrl(200), danmaku('new'));
  oldSub.resolve(subtitle('old')); oldDm.resolve(danmaku('old'));
  await flush();
  expect(f.video.playerInfoCid).toBe(200);
  expect(f.onSubtitleTracks).toHaveBeenCalledTimes(1);
  expect(f.onDanmaku).toHaveBeenCalledTimes(1);
  expect(f.onDanmaku.mock.calls[0][0][0].content).toBe('new');
});

it('binds the request before its response so delayed old-page headers cannot adopt the new generation', async () => {
  const f = await fixture();
  f.begin('old-player', playerUrl(100), subtitle('old'));
  f.begin('old-dm', dmUrl(100), danmaku('old'));
  f.navigate('https://www.bilibili.com/video/BV2fixture');
  f.finish('old-player', playerUrl(100)); f.finish('old-dm', dmUrl(100));
  await flush();
  expect(f.cdp.send.mock.calls.filter(([method]) => method === 'Network.getResponseBody')).toHaveLength(0);
  expect(f.onSubtitleTracks).not.toHaveBeenCalled(); expect(f.onDanmaku).not.toHaveBeenCalled();
});

it('rejects an old CID across a same-page part switch and rejects mismatched danmaku OIDs', async () => {
  const f = await fixture(), old = deferred<unknown>();
  f.receive('old-player', playerUrl(100), old.promise);
  f.receive('new-player', playerUrl(200), subtitle('part-2'));
  f.receive('wrong-dm', dmUrl(100), danmaku('wrong'));
  f.receive('right-dm', dmUrl(200), danmaku('right'));
  old.resolve(subtitle('part-1')); await flush();
  expect(f.video.playerInfoCid).toBe(200); expect(f.onSubtitleTracks).toHaveBeenCalledTimes(1);
  expect(f.onDanmaku).toHaveBeenCalledTimes(1); expect(f.onDanmaku.mock.calls[0][0][0].content).toBe('right');
});

it('same-URL reloads and stop invalidate pending reads too', async () => {
  const f = await fixture(), reload = deferred<unknown>(), stopped = deferred<unknown>();
  f.receive('reload', playerUrl(100), reload.promise); f.navigate();
  reload.resolve(subtitle('reload-old')); await flush();
  f.receive('stop', playerUrl(200), stopped.promise); await f.video.stop();
  stopped.resolve(subtitle('stop-old')); await flush();
  expect(f.video.playerInfoCid).toBe(0); expect(f.onSubtitleTracks).not.toHaveBeenCalled();
});

it('drops a fetched subtitle file when navigation changes while page.evaluate is pending', async () => {
  const f = await fixture(), file = deferred<unknown>();
  f.page.evaluate.mockImplementation(() => file.promise);
  const reading = f.video.fetchSubtitle('https://subtitle.example/file'); await flush();
  f.navigate('https://www.bilibili.com/video/BV2fixture');
  file.resolve({ body: [{ from: 0, to: 1, content: 'old subtitle' }] });
  expect(await reading).toEqual([]);
});
