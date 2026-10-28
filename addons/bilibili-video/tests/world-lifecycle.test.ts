import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BilibiliVideoWorld } from '../src/world.ts';
import { BILIBILI_VIDEO_DEFAULTS } from '../src/config.ts';
import { VideoBrowser } from '../src/browser.ts';
import { QrLogin } from '../src/login.ts';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const video = { bvid: 'BV1234567890', aid: 1, cid: 10, title: 'fixture', owner: 'fixture', duration: 60, p: 1, parts: [], desc: '', views: 1, chapters: [] };
function runTool(world: BilibiliVideoWorld, name: string, args = {}) {
  return (world.tools().find(tool => tool.name === name)!.handler as any)(args);
}
const worlds: BilibiliVideoWorld[] = [], dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bili-world-lifecycle-')); dirs.push(dir);
  const events: unknown[] = [], pending: any[] = [];
  const log = { info() {}, warn() {}, error() {}, child() { return this; } };
  const host = { log, pushEvent: (event: unknown) => { events.push(event); return 'cursor'; }, pushDeferred: (event: unknown) => { pending.push(event); } } as any;
  const world = new BilibiliVideoWorld({ cfg: structuredClone(BILIBILI_VIDEO_DEFAULTS), timezone: 'Asia/Shanghai', dataDir: dir }); worlds.push(world);
  return { world, state: world as any, host, events, pending };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(QrLogin.prototype, 'whoami').mockResolvedValue({ isLogin: false });
  vi.spyOn(VideoBrowser.prototype, 'stop').mockResolvedValue();
});
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.stop();
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('World observation and context boundaries', () => {
  it('keeps external titles and account names out of the system prefix while preserving them in the operator UI', async () => {
    const f = fixture(); await f.world.start(f.host);
    f.state.identity = { isLogin: true, uname: 'UNTRUSTED_ACCOUNT' };
    f.state.mode = 'watching'; f.state.video = { title: 'UNTRUSTED_TITLE', duration: 10, chapters: [] };
    expect(JSON.stringify(f.world.envPromptVars())).not.toMatch(/UNTRUSTED_/);
    expect(JSON.stringify(f.world.webUi().lamps)).toContain('UNTRUSTED_ACCOUNT');
    expect(f.world.webUi().storage?.[0].key).toBe('bilibili-video.cookies');
    f.state.pushState('UNTRUSTED_TITLE');
    expect(f.events).toEqual([expect.objectContaining({ origin: 'external', source: 'bilibili-video', text: 'UNTRUSTED_TITLE' })]);
  });
  it('does not restart its poll timer when a stopped startup identity check finishes', async () => {
    const gate = deferred<{ isLogin: boolean }>();
    vi.mocked(QrLogin.prototype.whoami).mockReturnValueOnce(gate.promise);
    const f = fixture(), starting = f.world.start(f.host);
    await f.world.stop(); gate.resolve({ isLogin: true }); await starting;
    expect(f.state.host).toBeNull(); expect(f.state.pollTimer).toBeNull();
    expect(f.state.identity.isLogin).toBe(false);
  });
  it('drops a queued scene from an earlier mount without clearing the new mount queue', async () => {
    const f = fixture(); await f.world.start(f.host);
    f.state.mode = 'watching'; f.state.cfg.observe.minIntervalSec = 0;
    f.state.armObservation(); await vi.advanceTimersByTimeAsync(0);
    expect(f.pending).toHaveLength(1);
    const stale = f.pending[0];
    await f.world.stop(); await f.world.start(f.host);
    f.state.mode = 'watching'; f.state.observeQueued = true;
    expect(await stale.render()).toBeNull();
    expect(f.state.observeQueued).toBe(true);
  });
  it('does not insert a late capture into a restarted World and avoids overlapping captures', async () => {
    const gate = deferred<any>();
    const sampling = vi.spyOn(VideoBrowser.prototype, 'sample').mockReturnValue(gate.promise);
    const f = fixture(); await f.world.start(f.host); f.state.mode = 'watching';
    const pending = f.state.capture(); await f.state.capture();
    expect(sampling).toHaveBeenCalledTimes(1);
    await f.world.stop(); await f.world.start(f.host); f.state.mode = 'watching';
    gate.resolve({ t: 1, gray: [0], jpeg: 'AA==', w: 1, h: 1 }); await pending;
    expect(f.state.samples).toEqual([]);
  });
  it('drops a playback response and navigation report from the previous mount', async () => {
    const playback = deferred<any>(), navigation = deferred<boolean>();
    vi.spyOn(VideoBrowser.prototype, 'playback').mockReturnValue(playback.promise);
    vi.spyOn(VideoBrowser.prototype, 'waitForVideo').mockReturnValue(navigation.promise);
    const info = vi.spyOn(VideoBrowser.prototype, 'videoInfo').mockResolvedValue(null);
    const f = fixture(); await f.world.start(f.host); f.state.mode = 'watching';
    const poll = f.state.poll(), report = f.state.reportOperatorNavigation('https://www.bilibili.com/video/BV1234567890');
    await f.world.stop(); await f.world.start(f.host); f.state.mode = 'watching';
    playback.resolve({ ended: true, duration: 10 }); navigation.resolve(true); await Promise.all([poll, report]);
    expect(f.state.mode).toBe('watching'); expect(f.state.lastPlayback).toBeNull();
    expect(f.events).toEqual([]); expect(info).not.toHaveBeenCalled();
  });
  it('does not carry old subtitles over a page change', async () => {
    const gate = deferred<any[]>();
    vi.spyOn(VideoBrowser.prototype, 'fetchSubtitle').mockReturnValue(gate.promise);
    const f = fixture(); await f.world.start(f.host);
    f.state.cfg.subtitle.enabled = true;
    f.state.subtitleTracks = [{ url: 'https://example.invalid/old', lan: 'zh', label: '旧字幕' }];
    const pending = f.state.ensureSubtitles(); f.state.resetVideo();
    gate.resolve([{ from: 0, to: 1, content: '旧页面' }]); await pending;
    expect(f.state.subtitles).toEqual([]); expect(f.state.subtitleLabel).toBe('');
  });
  it('preserves content across tracking-query changes but clears it for another part of the same BV', async () => {
    const f = fixture(); await f.world.start(f.host);
    const url = 'https://www.bilibili.com/video/BV1234567890';
    f.state.onNavigated(url, true); f.state.video = video;
    f.state.subtitleTracks = [{ url: 'https://example.invalid/part1', lan: 'zh', label: '第一P' }];
    f.state.onNavigated(url + '?spm_id_from=fixture&p=1', true);
    expect(f.state.video).toEqual(video); expect(f.state.subtitleTracks).toHaveLength(1);
    const content = f.state.contentGeneration;
    f.state.onNavigated(url + '?p=2', true);
    expect(f.state.video).toBeNull(); expect(f.state.subtitleTracks).toEqual([]);
    expect(f.state.contentGeneration).toBeGreaterThan(content);
  });
  it('cancels a delayed play after stop/start before reading playback or restarting capture', async () => {
    const gate = deferred<void>();
    vi.spyOn(VideoBrowser.prototype, 'url').mockReturnValue('https://www.bilibili.com/video/BV1234567890');
    vi.spyOn(VideoBrowser.prototype, 'setWebFullscreen').mockResolvedValue();
    const playing = vi.spyOn(VideoBrowser.prototype, 'play').mockReturnValue(gate.promise);
    const playback = vi.spyOn(VideoBrowser.prototype, 'playback').mockResolvedValue(null);
    const f = fixture(); await f.world.start(f.host); f.state.video = video; f.state.mode = 'browsing';
    const pending = runTool(f.world, 'bilibili_video_play'); await vi.advanceTimersByTimeAsync(0);
    expect(playing).toHaveBeenCalledTimes(1);
    await f.world.stop(); await f.world.start(f.host); gate.resolve();
    expect(await pending).toEqual(expect.objectContaining({ failed: true, text: expect.stringContaining('操作已中止') }));
    expect(f.state.mode).toBe('idle'); expect(f.state.captureTimer).toBeNull();
    expect(playback).not.toHaveBeenCalled();
  });
  it('does not act on the new browser after an old fullscreen request finishes', async () => {
    const gate = deferred<void>();
    vi.spyOn(VideoBrowser.prototype, 'url').mockReturnValue('https://www.bilibili.com/video/BV1234567890');
    vi.spyOn(VideoBrowser.prototype, 'setWebFullscreen').mockReturnValue(gate.promise);
    const playing = vi.spyOn(VideoBrowser.prototype, 'play').mockResolvedValue();
    const f = fixture(); await f.world.start(f.host); f.state.video = video; f.state.mode = 'browsing';
    const pending = runTool(f.world, 'bilibili_video_play');
    await f.world.stop(); await f.world.start(f.host); gate.resolve();
    expect((await pending).failed).toBe(true); expect(playing).not.toHaveBeenCalled();
  });
  it('does not load metadata or report success after an old open finishes', async () => {
    const gate = deferred<void>();
    vi.spyOn(VideoBrowser.prototype, 'goto').mockReturnValue(gate.promise);
    const waiting = vi.spyOn(VideoBrowser.prototype, 'waitForVideo').mockResolvedValue(true);
    const f = fixture(); await f.world.start(f.host);
    const pending = runTool(f.world, 'bilibili_video_open', { target: video.bvid });
    await f.world.stop(); await f.world.start(f.host); gate.resolve();
    expect((await pending).failed).toBe(true); expect(waiting).not.toHaveBeenCalled();
    expect(f.state.mode).toBe('idle'); expect(f.state.video).toBeNull();
  });
  it('does not restore old video metadata after a remount', async () => {
    const gate = deferred<any>();
    vi.spyOn(VideoBrowser.prototype, 'goto').mockResolvedValue();
    vi.spyOn(VideoBrowser.prototype, 'url').mockReturnValue('https://www.bilibili.com/video/BV1234567890');
    vi.spyOn(VideoBrowser.prototype, 'waitForVideo').mockResolvedValue(true);
    const info = vi.spyOn(VideoBrowser.prototype, 'videoInfo').mockReturnValue(gate.promise);
    const f = fixture(); await f.world.start(f.host);
    const pending = runTool(f.world, 'bilibili_video_open', { target: video.bvid }); await vi.advanceTimersByTimeAsync(0);
    expect(info).toHaveBeenCalledTimes(1);
    await f.world.stop(); await f.world.start(f.host); gate.resolve(video);
    expect((await pending).failed).toBe(true); expect(f.state.video).toBeNull();
  });
  it('does not replace the new mount list with an old recommendation result', async () => {
    const gate = deferred<any[]>();
    vi.spyOn(VideoBrowser.prototype, 'url').mockReturnValue('https://www.bilibili.com/video/BV1234567890');
    const listing = vi.spyOn(VideoBrowser.prototype, 'listVideos').mockReturnValue(gate.promise);
    const f = fixture(); await f.world.start(f.host); f.state.mode = 'browsing';
    const pending = runTool(f.world, 'bilibili_video_related');
    await f.world.stop(); await f.world.start(f.host); f.state.lastList = [{ n: 1, bvid: 'new' }]; gate.resolve([]);
    expect((await pending).failed).toBe(true); expect(listing).toHaveBeenCalledTimes(1);
    expect(f.state.lastList).toEqual([{ n: 1, bvid: 'new' }]);
  });
  it('does not finish the remaining leave-watching actions after stop/start', async () => {
    const gate = deferred<void>();
    const pause = vi.spyOn(VideoBrowser.prototype, 'pause').mockReturnValue(gate.promise);
    const fullscreen = vi.spyOn(VideoBrowser.prototype, 'setWebFullscreen').mockResolvedValue();
    const goto = vi.spyOn(VideoBrowser.prototype, 'goto').mockResolvedValue();
    const f = fixture(); await f.world.start(f.host); f.state.mode = 'watching';
    const pending = runTool(f.world, 'bilibili_video_search', { keyword: 'fixture' });
    expect(pause).toHaveBeenCalledTimes(1);
    await f.world.stop(); await f.world.start(f.host); gate.resolve();
    expect((await pending).failed).toBe(true); expect(fullscreen).not.toHaveBeenCalled(); expect(goto).not.toHaveBeenCalled();
  });
  it('cancels old panel opens without setting a new error or publishing an event', async () => {
    const gate = deferred<void>();
    vi.spyOn(VideoBrowser.prototype, 'goto').mockReturnValue(gate.promise);
    const f = fixture(); await f.world.start(f.host);
    const pending = f.state.invoke('player', 'browser-open');
    const result = expect(pending).rejects.toThrow('操作已中止');
    await f.world.stop(); await f.world.start(f.host); gate.resolve(); await result;
    expect(f.state.mode).toBe('idle'); expect(f.state.startError).toBeNull(); expect(f.events).toEqual([]);
  });
  it('checks the caller continuation when stop occurs just after a guarded promise resolves', async () => {
    const opened = deferred<void>(), closed = deferred<void>();
    vi.spyOn(VideoBrowser.prototype, 'goto').mockReturnValue(opened.promise);
    vi.mocked(VideoBrowser.prototype.stop).mockReturnValueOnce(closed.promise);
    const f = fixture(); await f.world.start(f.host);
    const pending = f.state.invoke('player', 'browser-open');
    const result = expect(pending).rejects.toThrow('操作已中止');
    let stopping!: Promise<void>;
    opened.resolve();
    // This is after Operation.wait's own continuation but before openBrowser's
    // caller continuation. Stop cleanup deliberately remains in flight.
    Promise.resolve().then(() => { stopping = f.world.stop(); });
    await result;
    expect(f.state.mode).toBe('idle'); expect(f.state.startError).toBeNull(); expect(f.events).toEqual([]);
    closed.resolve(); await stopping;
  });
  it('cancels old panel closes without resetting the new mount state', async () => {
    const gate = deferred<void>();
    vi.mocked(VideoBrowser.prototype.stop).mockReturnValueOnce(gate.promise);
    const f = fixture(); await f.world.start(f.host); f.state.mode = 'browsing';
    const pending = f.state.invoke('player', 'browser-close');
    const result = expect(pending).rejects.toThrow('操作已中止');
    await f.world.stop(); await f.world.start(f.host); f.state.mode = 'watching'; f.state.video = video;
    gate.resolve(); await result;
    expect(f.state.mode).toBe('watching'); expect(f.state.video).toEqual(video); expect(f.events).toEqual([]);
  });
  it('permits panel status reads while stopped but refuses new mutating actions', async () => {
    const goto = vi.spyOn(VideoBrowser.prototype, 'goto').mockResolvedValue();
    const login = vi.spyOn(QrLogin.prototype, 'start');
    const f = fixture();
    expect(await f.state.invoke('player', 'state')).toEqual(expect.objectContaining({ mode: 'idle' }));
    expect(await f.state.invoke('auth', 'state')).toEqual(expect.objectContaining({ isLogin: false }));
    await expect(f.state.invoke('player', 'browser-open')).rejects.toThrow('操作已中止');
    await expect(f.state.invoke('auth', 'start')).rejects.toThrow('操作已中止');
    expect((await runTool(f.world, 'bilibili_video_open', { target: video.bvid })).failed).toBe(true);
    expect(goto).not.toHaveBeenCalled(); expect(login).not.toHaveBeenCalled();
  });
});
