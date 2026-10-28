/** Launch state-machine tests: synthetic ChildProcesses/CDP only; no real browser is started. */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser, Page } from 'puppeteer-core';
import type { Logger } from 'cortico/core/types.ts';
import { VideoBrowser, parseWindowsIntegrityRid, createWindowsIntegrityDetector, type BrowserLaunchOverrides } from '../src/browser.ts';
import { BILIBILI_VIDEO_DEFAULTS } from '../src/config.ts';
import { CookieJar } from '../src/login.ts';

// An old or incomplete implementation must fail closed instead of ever opening a real browser.
// Every launch exercised below explicitly supplies its synthetic spawn implementation.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const guardedExecFile = ((file: string, ...args: unknown[]) => {
    if (/(?:^|[\\/])whoami\.exe$/i.test(file)) throw new Error('Unit tests forbid real integrity probes; use BrowserLaunchOverrides.integrityRid');
    return Reflect.apply(actual.execFile, undefined, [file, ...args]);
  }) as typeof actual.execFile;
  return { ...actual, execFile: vi.fn(guardedExecFile), spawn: vi.fn(() => { throw new Error('Unit tests forbid real browser spawn; use BrowserLaunchOverrides.spawn'); }) };
});

const implementation = readFileSync(new URL('../src/browser.ts', import.meta.url), 'utf8');
if (!/export\s+(?:interface|type)\s+BrowserLaunchOverrides\b/.test(implementation)
  || !/\blaunch\?\s*:\s*BrowserLaunchOverrides\b/.test(implementation)) {
  throw new Error('BrowserLaunchOverrides and VideoBrowserOptions.launch must be implemented before running these isolated tests');
}

const roots: string[] = [];
const videos: VideoBrowser[] = [];
afterEach(async () => {
  await Promise.all(videos.splice(0).map((video) => video.stop()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  expect(vi.mocked(execFile).mock.calls.some(([file]) => /(?:^|[\\/])whoami\.exe$/i.test(String(file)))).toBe(false);
  vi.mocked(execFile).mockClear();
});

function rootDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'bili-launch-unit-'));
  roots.push(root);
  return root;
}

class ProcessStub extends EventEmitter {
  pid = 47001;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stderr = new PassThrough();
  kill = vi.fn(() => { this.exitCode = 0; this.emit('exit', 0, null); return true; });
  exit(code: number): void { this.exitCode = code; this.emit('exit', code, null); }
  exitWithSignal(signal: NodeJS.Signals): void { this.signalCode = signal; this.emit('exit', null, signal); }
  asChild(): ChildProcess { return this as unknown as ChildProcess; }
}

function fakePage(url = 'about:blank') {
  const events = new EventEmitter();
  const cdp = Object.assign(new EventEmitter(), { send: vi.fn(async (_method: string, _params?: unknown): Promise<Record<string, unknown>> => ({ product: 'Edg/155.0', protocolVersion: '1.3' })), detach: vi.fn(async () => {}) });
  const page = Object.assign(events, {
    url: vi.fn(() => url), isClosed: vi.fn(() => false), close: vi.fn(async () => {}),
    goto: vi.fn(async (_url: string, _options?: unknown) => {}),
    setUserAgent: vi.fn(async () => {}), setDefaultNavigationTimeout: vi.fn(),
    createCDPSession: vi.fn(async () => cdp), mainFrame: vi.fn(() => null),
  });
  return { page, cdp, asPage: page as unknown as Page };
}

function fakeBrowser(existing: ReturnType<typeof fakePage>[] = []) {
  const page = fakePage();
  const emitter = new EventEmitter();
  const browser = Object.assign(emitter, {
    connected: true, pages: vi.fn(async () => existing.map((p) => p.asPage)),
    newPage: vi.fn(async () => page.asPage), version: vi.fn(async () => 'Chrome/123.0.0.0'),
    createBrowserCDPSession: vi.fn(async () => ({ send: vi.fn(async () => ({ product: 'Edg/155.0', protocolVersion: '1.3' })), detach: vi.fn(async () => {}) })),
    close: vi.fn(async () => { browser.connected = false; emitter.emit('disconnected'); }),
    disconnect: vi.fn(async () => { browser.connected = false; emitter.emit('disconnected'); }),
  });
  return { browser, page, asBrowser: browser as unknown as Browser };
}

const WS_PATH = '/devtools/browser/launch-test';
function endpoint(port = 48123, path = WS_PATH): string { return `ws://127.0.0.1:${port}${path}`; }
function dap(profile: string, port = 48123, path = WS_PATH): void {
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'DevToolsActivePort'), `${port}\n${path}\n`);
}
function profileArg(args: string[]): string {
  const profile = args.find((arg) => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
  if (!profile) throw new Error('missing isolated profile argument');
  return profile;
}
function healthyFetch(port = 48123, path = WS_PATH): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({ Browser: 'Edg/155.0', webSocketDebuggerUrl: endpoint(port, path) }), { status: 200 })) as unknown as typeof fetch;
}
function fixture(launch: BrowserLaunchOverrides = {}, overrides: Partial<typeof BILIBILI_VIDEO_DEFAULTS.browser> = {}) {
  const root = rootDir();
  const cfg = structuredClone(BILIBILI_VIDEO_DEFAULTS);
  Object.assign(cfg.browser, overrides);
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const proc = new ProcessStub();
  const browser = fakeBrowser();
  const profiles: string[] = [];
  const spawn = vi.fn((_file: string, args: string[]) => {
    const profile = profileArg(args);
    profiles.push(profile);
    dap(profile);
    return proc.asChild();
  });
  const kill = vi.fn(async (child: ChildProcess) => { (child as unknown as ProcessStub).kill(); });
  const connect = vi.fn(async () => browser.asBrowser);
  const opts: BrowserLaunchOverrides = {
    candidates: async () => ['edge-fixture.exe'], integrityRid: async () => 8192, spawn, connect, fetch: healthyFetch(), kill,
    timeoutMs: 600, exitGraceMs: 15, pollMs: 5, ...launch,
  };
  const onLost = vi.fn();
  const onDanmaku = vi.fn();
  const onSubtitleTracks = vi.fn();
  const video = new VideoBrowser({
    cfg, dataDir: root, jar: new CookieJar(join(root, 'unit-cookies.json')),
    log: () => log as unknown as Logger, onNavigated: vi.fn(), onLost,
    onDanmaku, onSubtitleTracks, launch: opts,
  });
  videos.push(video);
  return { root, cfg, log, proc, browser, profiles, spawn, kill, connect, video, onLost, onDanmaku, onSubtitleTracks };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function saveSyntheticCookie(root: string): void {
  new CookieJar(join(root, 'unit-cookies.json')).save([
    { name: 'unit-lifecycle-cookie', value: 'synthetic-only', domain: '.bilibili.com', path: '/', secure: true, httpOnly: true },
  ]);
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function diagnosticText(f: ReturnType<typeof fixture>, error: unknown): string {
  return `${String(error)} ${JSON.stringify(f.log.info.mock.calls)} ${JSON.stringify(f.log.warn.mock.calls)} ${JSON.stringify(f.log.error.mock.calls)}`;
}

describe('isolated browser launch state machine', () => {
  it.each([
    ['"Mandatory Label\\Low Mandatory Level","Label","S-1-16-4096","Enabled"\r\n', 4096],
    ['"本地组","组","S-1-5-32-545","已启用"\r\n"强制标签\\中强制级别","标签","S-1-16-8192","已启用"\r\n', 8192],
  ])('reads an integrity RID without depending on localized group names', (csv, rid) => {
    expect(parseWindowsIntegrityRid(csv)).toBe(rid);
  });

  it('treats missing, ambiguous and malformed integrity SIDs as unknown', () => {
    expect(parseWindowsIntegrityRid('"Users","Group","S-1-5-32-545","Enabled"')).toBeNull();
    expect(parseWindowsIntegrityRid('"Low","Label","S-1-16-4096","Enabled"\n"Medium","Label","S-1-16-8192","Enabled"')).toBeNull();
    expect(parseWindowsIntegrityRid('"Label","S-1-16-4096-other","Enabled"')).toBeNull();
    expect(parseWindowsIntegrityRid('"Label","S-1-16-99999999999999999999","Enabled"')).toBeNull();
  });

  it('retries a transient integrity query failure and caches the known result', async () => {
    const query = vi.fn<() => Promise<number | null>>().mockRejectedValueOnce(Error('busy')).mockResolvedValue(4096);
    const detect = createWindowsIntegrityDetector(query);
    expect(await detect()).toBe(4096);
    expect(await detect()).toBe(4096);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('does not cache unknown integrity permanently after both attempts fail', async () => {
    const query = vi.fn<() => Promise<number | null>>().mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(4096);
    const detect = createWindowsIntegrityDetector(query);
    expect(await detect()).toBeNull();
    expect(await detect()).toBe(4096);
    expect(await detect()).toBe(4096);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('shares one pending integrity query between concurrent callers', async () => {
    const value = deferred<number | null>();
    const query = vi.fn(() => value.promise);
    const detect = createWindowsIntegrityDetector(query);
    const first = detect(), second = detect();
    await flushPromises();
    expect(query).toHaveBeenCalledOnce();
    value.resolve(8192);
    expect(await Promise.all([first, second])).toEqual([8192, 8192]);
  });

  it('bounds two unresponsive integrity attempts to a combined 1500 ms', async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn(() => new Promise<number | null>(() => {}));
      const detect = createWindowsIntegrityDetector(query);
      const result = detect();
      await vi.advanceTimersByTimeAsync(1500);
      expect(await result).toBeNull();
      expect(query).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it.skipIf(process.platform !== 'win32')('refuses a Low host before discovering browsers or creating profiles', async () => {
    const candidates = vi.fn(async () => ['edge-fixture.exe']);
    const f = fixture({ candidates, integrityRid: async () => 4096 });
    await expect(f.video.ensure()).rejects.toThrow(/宿主处于低完整性.*普通目录.*不要改整个工作区.*helper.*cdpUrl/);
    expect(candidates).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
    expect(existsSync(join(f.root, 'bilibili-video'))).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('does not create a missing explicit profile when the host has Low integrity', async () => {
    const profile = join(rootDir(), 'not-created');
    const f = fixture({ integrityRid: async () => 4096 }, { profileDir: profile });
    await expect(f.video.ensure()).rejects.toThrow(/宿主处于低完整性/);
    expect(existsSync(profile)).toBe(false);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'win32')('preserves an unhealthy explicit profile and its DAP on Low-integrity refusal', async () => {
    const profile = join(rootDir(), 'stale-low-profile');
    dap(profile);
    const original = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8');
    const f = fixture({ integrityRid: async () => 4096, fetch: vi.fn(async () => { throw Error('ECONNREFUSED'); }) as unknown as typeof fetch }, { profileDir: profile });
    await expect(f.video.ensure()).rejects.toThrow(/宿主处于低完整性/);
    expect(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8')).toBe(original);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each([8192, null])('continues normal startup when the host integrity is %s', async (rid) => {
    const f = fixture({ integrityRid: async () => rid });
    await expect(f.video.ensure()).resolves.toBeDefined();
    expect(f.spawn).toHaveBeenCalledOnce();
  });

  it('keeps normal startup available when integrity detection fails', async () => {
    const f = fixture({ integrityRid: async () => { throw Error('synthetic unavailable query'); } });
    await expect(f.video.ensure()).resolves.toBeDefined();
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(diagnosticText(f, '')).not.toContain('synthetic unavailable query');
  });

  it.skipIf(process.platform !== 'win32')('cancels an integrity query without starting or creating a browser', async () => {
    const entered = deferred<void>();
    const query = deferred<number | null>();
    const f = fixture({ integrityRid: () => { entered.resolve(); return query.promise; } });
    const opening = f.video.ensure().catch((error: unknown) => error);
    await entered.promise;
    await f.video.stop();
    query.resolve(8192);
    expect(String(await opening)).toContain('取消');
    expect(f.spawn).not.toHaveBeenCalled();
    expect(existsSync(join(f.root, 'bilibili-video'))).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('counts integrity detection against the total startup budget', async () => {
    const query = deferred<number | null>();
    const f = fixture({ integrityRid: () => query.promise, timeoutMs: 50 });
    await expect(f.video.ensure()).rejects.toThrow(/超时|预算/);
    query.resolve(8192);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(existsSync(join(f.root, 'bilibili-video'))).toBe(false);
  });

  it('uses a browser-selected port and removes only its own temporary profile on stop', async () => {
    const f = fixture();
    const unrelated = join(f.root, 'bilibili-video', 'browser-personal-do-not-delete');
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(join(unrelated, 'keep.txt'), 'unrelated data');
    await f.video.ensure();
    expect(f.spawn).toHaveBeenCalledOnce();
    const args = f.spawn.mock.calls[0][1];
    expect(args).toContain('--remote-debugging-port=0');
    expect(args).toContain('--remote-debugging-address=127.0.0.1');
    expect(f.profiles[0]).not.toBe(join(f.root, 'bilibili-video', 'browser'));
    expect(f.connect).toHaveBeenCalledWith({ browserWSEndpoint: endpoint(), defaultViewport: null });
    expect(f.video.connected).toBe(true);
    await f.video.stop();
    expect(f.video.connected).toBe(false);
    expect(existsSync(f.profiles[0])).toBe(false);
    expect(readFileSync(join(unrelated, 'keep.txt'), 'utf8')).toBe('unrelated data');
  });

  it('deduplicates simultaneous open requests without spawning another browser', async () => {
    const f = fixture();
    const pages = await Promise.all([f.video.ensure(), f.video.ensure(), f.video.ensure()]);
    expect(pages[0]).toBe(pages[1]);
    expect(pages[1]).toBe(pages[2]);
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.connect).toHaveBeenCalledOnce();
  });

  it('preserves cookie injection and the existing CDP observation hooks after launch', async () => {
    const f = fixture();
    new CookieJar(join(f.root, 'unit-cookies.json')).save([
      { name: 'unit-cookie', value: 'synthetic-only', domain: '.bilibili.com', path: '/', secure: true, httpOnly: true },
    ]);
    await f.video.ensure();
    const cdp = f.browser.page.cdp;
    expect(cdp.send).toHaveBeenCalledWith('Network.enable');
    expect(cdp.send).toHaveBeenCalledWith('Network.setCookies', {
      cookies: [{ name: 'unit-cookie', value: 'synthetic-only', domain: '.bilibili.com', path: '/', secure: true, httpOnly: true }],
    });
    expect(cdp.listenerCount('Network.responseReceived')).toBe(1);
    expect(cdp.listenerCount('Network.loadingFinished')).toBe(1);
  });

  it('retries exit 0 with a new profile and reports handoff promptly', async () => {
    const profiles: string[] = [];
    const spawn = vi.fn((_file: string, args: string[]) => {
      profiles.push(profileArg(args));
      const proc = new ProcessStub();
      setImmediate(() => proc.exit(0));
      return proc.asChild();
    });
    const f = fixture({ spawn, timeoutMs: 1800 });
    const start = Date.now();
    const err = await f.video.ensure().catch((error: unknown) => error);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/已有|接管|交给|exit\s*0|退出.*0/i);
    expect(Date.now() - start).toBeLessThan(1200);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(new Set(profiles).size).toBe(2);
    expect(profiles.every((p) => !existsSync(p))).toBe(true);
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('accepts a successful endpoint even when the startup stub exits 0', async () => {
    const f = fixture({ spawn: (_file, args) => {
      const proc = new ProcessStub();
      dap(profileArg(args));
      setImmediate(() => proc.exit(0));
      return proc.asChild();
    } });
    await expect(f.video.ensure()).resolves.toBeDefined();
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.video.connected).toBe(true);
  });

  it('includes a nonzero exit code and a useful stderr line without leaking credentials', async () => {
    const spawn = vi.fn((_file: string, _args: string[]) => {
      const proc = new ProcessStub();
      setImmediate(() => {
        proc.stderr.write('Authorization: Bearer unit-bearer-secret\nCookie: SESSDATA=unit-cookie-secret\nRemote debugging blocked by enterprise policy\n');
        proc.exit(23);
      });
      return proc.asChild();
    });
    const f = fixture({ spawn });
    const err = await f.video.ensure().catch((error: unknown) => error);
    const diagnostic = `${String(err)} ${JSON.stringify(f.log.warn.mock.calls)} ${JSON.stringify(f.log.error.mock.calls)}`;
    expect(err).toBeInstanceOf(Error);
    expect(diagnostic).toContain('23');
    expect(diagnostic).toMatch(/policy|策略/i);
    expect(diagnostic).not.toContain('unit-bearer-secret');
    expect(diagnostic).not.toContain('unit-cookie-secret');
    expect(spawn.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('handles the asynchronous spawn error event as a readable rejection', async () => {
    const spawn = vi.fn(() => {
      const proc = new ProcessStub();
      setImmediate(() => proc.emit('error', Object.assign(new Error('spawn blocked ENOENT'), { code: 'ENOENT' })));
      return proc.asChild();
    });
    const f = fixture({ spawn });
    await expect(f.video.ensure()).rejects.toThrow(/ENOENT|启动|程序/);
    expect(f.video.connected).toBe(false);
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('does not mistake an unrelated websocket path for the profile endpoint', async () => {
    const profiles: string[] = [];
    const spawn = vi.fn((_file: string, args: string[]) => {
      const profile = profileArg(args);
      profiles.push(profile);
      dap(profile, 48123, '/devtools/browser/expected-owned-browser');
      return new ProcessStub().asChild();
    });
    const f = fixture({ spawn, fetch: healthyFetch(48123, '/devtools/browser/unrelated-browser'), timeoutMs: 180 });
    await expect(f.video.ensure()).rejects.toThrow();
    expect(f.connect).not.toHaveBeenCalled();
    expect(profiles.every((p) => !existsSync(p))).toBe(true);
  });

  it('falls back to the next candidate after a browser cannot start', async () => {
    const spawn = vi.fn((file: string, args: string[]) => {
      const proc = new ProcessStub();
      if (file === 'broken-chrome.exe') setImmediate(() => proc.exit(17));
      else dap(profileArg(args));
      return proc.asChild();
    });
    const f = fixture({ candidates: async () => ['broken-chrome.exe', 'working-edge.exe'], spawn });
    await expect(f.video.ensure()).resolves.toBeDefined();
    expect(spawn.mock.calls.some(([file]) => file === 'working-edge.exe')).toBe(true);
    expect(f.video.connected).toBe(true);
  });

  it('shares one timeout budget across candidates instead of waiting once for every retry', async () => {
    const profiles: string[] = [];
    const candidates = Array.from({ length: 12 }, (_, i) => `unresponsive-${i}.exe`);
    const spawn = vi.fn((_file: string, args: string[]) => {
      profiles.push(profileArg(args));
      return new ProcessStub().asChild();
    });
    const f = fixture({ candidates: async () => candidates, spawn, timeoutMs: 120 });
    const start = Date.now();
    await expect(f.video.ensure()).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(700);
    expect(spawn.mock.calls.length).toBeLessThan(candidates.length * 2);
    expect(profiles.every((p) => !existsSync(p))).toBe(true);
  });

  it('does not accept a generic HTTP 200 response as a DevTools browser', async () => {
    const f = fixture({
      fetch: vi.fn(async () => new Response(JSON.stringify({ message: 'ordinary web server' }), { status: 200 })) as unknown as typeof fetch,
      timeoutMs: 100,
    });
    await expect(f.video.ensure()).rejects.toThrow();
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('unreachable cdpUrl gives an actionable error without launching anything', async () => {
    const f = fixture({ fetch: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch }, { cdpUrl: 'http://127.0.0.1:49321' });
    await expect(f.video.ensure()).rejects.toThrow(/cdpUrl|调试|端口|接管/i);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('attaches cdpUrl from a Low host without closing existing pages or the external browser', async () => {
    const externalPages = [fakePage('https://example.test/personal'), fakePage('https://www.bilibili.com/')];
    const external = fakeBrowser(externalPages);
    const integrityRid = vi.fn(async () => 4096);
    const f = fixture({ integrityRid, connect: async () => external.asBrowser }, { cdpUrl: 'http://127.0.0.1:48123' });
    await f.video.ensure();
    expect(integrityRid).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(externalPages.every((p) => p.page.close.mock.calls.length === 0)).toBe(true);
    await f.video.stop();
    expect(external.browser.close).not.toHaveBeenCalled();
    expect(external.browser.disconnect).toHaveBeenCalledOnce();
    expect(f.kill).not.toHaveBeenCalled();
  });

  it('reuses a healthy explicit profile from a Low host and preserves its contents on stop', async () => {
    const profile = join(rootDir(), 'explicit-profile');
    dap(profile);
    writeFileSync(join(profile, 'user-setting.txt'), 'preserve');
    const external = fakeBrowser([fakePage('https://example.test/keep-a'), fakePage('https://example.test/keep-b')]);
    const integrityRid = vi.fn(async () => 4096);
    const f = fixture({ integrityRid, connect: async () => external.asBrowser }, { profileDir: profile });
    await f.video.ensure();
    expect(integrityRid).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(external.browser.pages).toHaveBeenCalled();
    await f.video.stop();
    expect(external.browser.close).not.toHaveBeenCalled();
    expect(external.browser.disconnect).toHaveBeenCalledOnce();
    expect(readFileSync(join(profile, 'user-setting.txt'), 'utf8')).toBe('preserve');
    expect(f.kill).not.toHaveBeenCalled();
  });

  it('a stale explicit profile is never deleted and no external browser is killed', async () => {
    const profile = join(rootDir(), 'explicit-stale');
    dap(profile, 48123, '/devtools/browser/stale');
    writeFileSync(join(profile, 'keep.txt'), 'do not remove');
    const spawned: ProcessStub[] = [];
    const f = fixture({
      fetch: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
      spawn: (_file, args) => {
        expect(profileArg(args)).toBe(profile);
        const proc = new ProcessStub(); spawned.push(proc);
        setImmediate(() => proc.exit(0));
        return proc.asChild();
      }, timeoutMs: 180,
    }, { profileDir: profile });
    await expect(f.video.ensure()).rejects.toThrow();
    expect(readFileSync(join(profile, 'keep.txt'), 'utf8')).toBe('do not remove');
    expect(f.connect).not.toHaveBeenCalled();
    for (const [proc] of f.kill.mock.calls) expect(spawned.map((p) => p.asChild())).toContain(proc);
  });

  it('cleans up a spawned browser and its profile when page attachment fails', async () => {
    const f = fixture();
    f.browser.page.page.createCDPSession.mockRejectedValueOnce(new Error('synthetic attach failure'));
    await expect(f.video.ensure()).rejects.toThrow();
    expect(f.video.connected).toBe(false);
    expect(f.browser.browser.close.mock.calls.length + f.kill.mock.calls.length).toBeGreaterThan(0);
    expect(f.profiles.every((p) => !existsSync(p))).toBe(true);
  });

  it('stop during connection cancels startup and closes a late owned browser', async () => {
    let resolveConnect!: (value: Browser) => void;
    let entered!: () => void;
    const reachedConnect = new Promise<void>((resolve) => { entered = resolve; });
    const externalPromise = new Promise<Browser>((resolve) => { resolveConnect = resolve; });
    const late = fakeBrowser();
    const f = fixture({ connect: () => { entered(); return externalPromise; } });
    const opening = f.video.ensure().catch((error: unknown) => error);
    await reachedConnect;
    const stopping = f.video.stop();
    resolveConnect(late.asBrowser);
    await stopping;
    expect(await opening).toBeInstanceOf(Error);
    expect(f.video.connected).toBe(false);
    expect(late.browser.close.mock.calls.length + late.browser.disconnect.mock.calls.length).toBeGreaterThan(0);
    expect(f.profiles.every((p) => !existsSync(p))).toBe(true);
  });

  it('can reopen after a normal close using another fresh temporary profile', async () => {
    const profiles: string[] = [];
    const launched: ReturnType<typeof fakeBrowser>[] = [];
    const f = fixture({
      spawn: (_file, args) => { const p = profileArg(args); profiles.push(p); dap(p); return new ProcessStub().asChild(); },
      connect: async () => { const b = fakeBrowser(); launched.push(b); return b.asBrowser; },
    });
    await f.video.ensure();
    await f.video.stop();
    await f.video.ensure();
    expect(new Set(profiles).size).toBe(2);
    expect(launched).toHaveLength(2);
    expect(f.video.connected).toBe(true);
    expect(existsSync(profiles[0])).toBe(false);
    await f.video.stop();
    expect(existsSync(profiles[1])).toBe(false);
    const pluginDir = join(f.root, 'bilibili-video');
    expect(existsSync(pluginDir) ? readdirSync(pluginDir) : []).not.toContain('browser');
  });

  it('detaches a late CDP session after stop without injecting cookies or replacing the reopened session', async () => {
    const old = fakeBrowser();
    const next = fakeBrowser();
    const creating = deferred<typeof old.page.cdp>();
    const entered = deferred<void>();
    old.page.page.createCDPSession.mockImplementationOnce(() => { entered.resolve(); return creating.promise; });
    let connects = 0;
    const f = fixture({ connect: async () => (++connects === 1 ? old : next).asBrowser });
    saveSyntheticCookie(f.root);
    const opening = f.video.ensure().catch((error: unknown) => error);
    await entered.promise;
    await f.video.stop();
    expect(await opening).toBeInstanceOf(Error);
    await f.video.ensure();
    creating.resolve(old.page.cdp);
    await flushPromises();
    expect(old.page.cdp.detach).toHaveBeenCalled();
    expect(old.page.cdp.send).not.toHaveBeenCalled();
    await f.video.goto('https://www.bilibili.com/');
    expect(next.page.cdp.send.mock.calls.filter(([method]) => method === 'Network.setCookies')).toHaveLength(2);
    expect(old.page.cdp.send.mock.calls.filter(([method]) => method === 'Network.setCookies')).toHaveLength(0);
    expect(f.video.connected).toBe(true);
  });

  it('ignores late Network.enable completion after stop and keeps the new CDP session authoritative', async () => {
    const old = fakeBrowser();
    const next = fakeBrowser();
    const enabling = deferred<Record<string, unknown>>();
    const entered = deferred<void>();
    old.page.cdp.send.mockImplementation((method) => {
      if (method === 'Network.enable') { entered.resolve(); return enabling.promise; }
      return Promise.resolve({});
    });
    let connects = 0;
    const f = fixture({ connect: async () => (++connects === 1 ? old : next).asBrowser });
    saveSyntheticCookie(f.root);
    const opening = f.video.ensure().catch((error: unknown) => error);
    await entered.promise;
    await f.video.stop();
    expect(await opening).toBeInstanceOf(Error);
    await f.video.ensure();
    enabling.resolve({});
    await flushPromises();
    await f.video.goto('https://www.bilibili.com/');
    expect(old.page.cdp.detach).toHaveBeenCalled();
    expect(old.page.cdp.send.mock.calls.map(([method]) => method)).toEqual(['Network.enable']);
    expect(next.page.cdp.send.mock.calls.filter(([method]) => method === 'Network.setCookies')).toHaveLength(2);
    expect(f.video.connected).toBe(true);
  });

  it('does not publish a response body that resolves after the session was stopped', async () => {
    const f = fixture();
    await f.video.ensure();
    const body = deferred<Record<string, unknown>>();
    const requested = deferred<void>();
    const cdp = f.browser.page.cdp;
    cdp.send.mockImplementation((method) => {
      if (method === 'Network.getResponseBody') { requested.resolve(); return body.promise; }
      return Promise.resolve({});
    });
    cdp.emit('Network.requestWillBeSent', { requestId: 'late-subtitle', request: { url: 'https://api.bilibili.com/x/player/wbi/v2?cid=987' } });
    cdp.emit('Network.responseReceived', { requestId: 'late-subtitle', response: { url: 'https://api.bilibili.com/x/player/wbi/v2?cid=987' } });
    cdp.emit('Network.loadingFinished', { requestId: 'late-subtitle' });
    await requested.promise;
    await f.video.stop();
    body.resolve({ body: JSON.stringify({ data: { subtitle: { subtitles: [{ lan: 'zh-CN', lan_doc: 'synthetic subtitle', subtitle_url: 'https://example.test/subtitle.json' }] } } }), base64Encoded: false });
    await flushPromises();
    expect(f.onSubtitleTracks).not.toHaveBeenCalled();
    expect(f.onDanmaku).not.toHaveBeenCalled();
    expect(f.video.playerInfoCid).toBe(0);
  });

  it('finishes cancellation when version and browser close both stop answering', async () => {
    const browser = fakeBrowser();
    const version = deferred<string>();
    const close = deferred<void>();
    const entered = deferred<void>();
    browser.browser.version.mockImplementation(() => { entered.resolve(); return version.promise; });
    browser.browser.close.mockImplementation(() => close.promise);
    const f = fixture({ connect: async () => browser.asBrowser, timeoutMs: 2500 });
    const opening = f.video.ensure().catch((error: unknown) => error);
    await entered.promise;
    const stopping = f.video.stop();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const stopped = await Promise.race([
        stopping.then(() => true),
        new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 2500); }),
      ]);
      expect(stopped).toBe(true);
      expect(await opening).toBeInstanceOf(Error);
      expect(f.video.connected).toBe(false);
      expect(f.kill).toHaveBeenCalled();
      expect(browser.browser.close).toHaveBeenCalled();
    } finally {
      if (timeout) clearTimeout(timeout);
      version.resolve('Chrome/123.0.0.0');
      close.resolve();
      await stopping;
    }
  });

  it('recognizes signal termination promptly even though exitCode remains null', async () => {
    const spawn = vi.fn(() => {
      const proc = new ProcessStub();
      setImmediate(() => proc.exitWithSignal('SIGTERM'));
      return proc.asChild();
    });
    const f = fixture({ spawn, timeoutMs: 1800 });
    const started = Date.now();
    const error = await f.video.ensure().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(diagnosticText(f, error)).toContain('SIGTERM');
    expect(Date.now() - started).toBeLessThan(1200);
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('redacts equals-form headers and the whole quoted password including spaces', async () => {
    const spawn = vi.fn(() => {
      const proc = new ProcessStub();
      setImmediate(() => {
        proc.stderr.write('Authorization=Bearer unit-auth-equals-secret\nCookie=unit-cookie-equals-secret\npassword="unit quoted password secret"\nsafe startup failure\n');
        proc.exit(23);
      });
      return proc.asChild();
    });
    const f = fixture({ spawn });
    const error = await f.video.ensure().catch((err: unknown) => err);
    const output = diagnosticText(f, error);
    expect(error).toBeInstanceOf(Error);
    expect(output).toContain('safe startup failure');
    expect(output).not.toContain('unit-auth-equals-secret');
    expect(output).not.toContain('unit-cookie-equals-secret');
    expect(output).not.toContain('quoted password secret');
  });

  it('discards the continuation of a truncated sensitive stderr line until its newline', async () => {
    const spawn = vi.fn(() => {
      const proc = new ProcessStub();
      setImmediate(() => {
        proc.stderr.write('token=' + 'S'.repeat(9000));
        proc.stderr.write('unit-sensitive-continuation-after-truncation\nsafe line after truncation\n');
        proc.exit(23);
      });
      return proc.asChild();
    });
    const f = fixture({ spawn });
    const error = await f.video.ensure().catch((err: unknown) => err);
    const output = diagnosticText(f, error);
    expect(error).toBeInstanceOf(Error);
    expect(output).toContain('safe line after truncation');
    expect(output).not.toContain('unit-sensitive-continuation-after-truncation');
    expect(output).not.toContain('S'.repeat(64));
  });

  it('distinguishes a readable DAP with an unhealthy endpoint from a missing handoff', async () => {
    const spawn = vi.fn((_file: string, args: string[]) => {
      dap(profileArg(args));
      return new ProcessStub().asChild();
    });
    const refused = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as unknown as typeof fetch;
    const f = fixture({ spawn, fetch: refused, timeoutMs: 350, pollMs: 10 });
    const error = await f.video.ensure().catch((err: unknown) => err);
    const output = diagnosticText(f, error);
    expect(error).toBeInstanceOf(Error);
    expect(output).toContain('已读取 DevToolsActivePort');
    expect(output).toContain('ECONNREFUSED');
    expect(output).not.toMatch(/疑似交给已有实例/);
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('reports malformed DevToolsActivePort instead of claiming no endpoint was written', async () => {
    const spawn = vi.fn((_file: string, args: string[]) => {
      const profile = profileArg(args);
      mkdirSync(profile, { recursive: true });
      writeFileSync(join(profile, 'DevToolsActivePort'), 'not-a-port\n/not/a/ws\n');
      return new ProcessStub().asChild();
    });
    const f = fixture({ spawn, timeoutMs: 250, pollMs: 10 });
    const error = await f.video.ensure().catch((err: unknown) => err);
    const output = diagnosticText(f, error);
    expect(error).toBeInstanceOf(Error);
    expect(output).toContain('DevToolsActivePort');
    expect(output).toMatch(/格式|读取/);
    expect(output).not.toMatch(/疑似交给已有实例/);
  });

  it('reports an HTTP rejection after a readable DAP without mislabeling it as no port', async () => {
    const spawn = vi.fn((_file: string, args: string[]) => {
      dap(profileArg(args));
      return new ProcessStub().asChild();
    });
    const badStatus = vi.fn(async () => new Response('unit upstream error', { status: 502 })) as unknown as typeof fetch;
    const f = fixture({ spawn, fetch: badStatus, timeoutMs: 350, pollMs: 10 });
    const error = await f.video.ensure().catch((err: unknown) => err);
    const output = diagnosticText(f, error);
    expect(error).toBeInstanceOf(Error);
    expect(output).toContain('已读取 DevToolsActivePort');
    expect(output).toContain('HTTP 502');
    expect(output).not.toMatch(/疑似交给已有实例/);
  });
});
