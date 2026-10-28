/**
 * BilibiliVideoWorld: a bilibili browser window as the stream picture. Two states the tools move
 * between: browsing (open pages, search, read lists and comments, scroll; nothing plays) and
 * watching (one video plays in web fullscreen and an observation event arrives every
 * `observe.minIntervalSec` or longer). An observation is a grid of frames picked from the samples
 * taken since the previous one (`capture.ts`), with the picture events, subtitle lines and the
 * video's own danmaku of that span in the text.
 *
 * The operator shares the window: a navigation or pause the World did not ask for is reported as
 * a `bilibili-video.state` event and leaves playback where the operator put it.
 */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import QRCode from 'qrcode';
import type { Logger, ToolDef, ToolOutcome, World, WorldWebUiDecl, WorldHost } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { nowIso } from 'cortico/core/util.ts';
import { BILIBILI_VIDEO_CONFIG_GROUP, BILIBILI_VIDEO_ID, type BilibiliVideoConfigSection } from './config.ts';
import { BILIBILI_VIDEO_TOOL_DECLS } from './tools.ts';
import { BrowserRefusal, VideoBrowser, type ListEntry, type Playback, type SubtitleTrack, type VideoInfo } from './browser.ts';
import { CookieJar, QrLogin, type Identity } from './login.ts';
import { DanmakuPool, spread, subtitlesBetween, type SubtitleLine } from './danmaku.ts';
import { describeEvents, dhash, gridFor, meanAbsDiff, selectFrames, type FrameMeta } from './capture.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const HOME_URL = 'https://www.bilibili.com/';
const POLL_MS = 1000;
/** Samples kept beyond the last observation, so a long model round still has material. */
const SAMPLE_CAP = 900;
const LIST_MAX = 20;

type Mode = 'idle' | 'browsing' | 'watching' | 'paused';
type Args = Record<string, unknown>;

/** One tool or panel action belongs to one mounted World. Check before each new
 * external action and after every await, before assigning its result. */
interface Operation {
  check(): void;
  wait<T>(action: () => Promise<T>): Promise<T>;
  /** Synchronous check in the caller's continuation, before it stores a result. */
  checked<T>(value: T): T;
}

interface StoredSample extends FrameMeta {
  jpeg: string;
  /** Cell size the JPEG was drawn at (portrait videos turn the cell). */
  w: number;
  h: number;
}

export interface BilibiliVideoWorldOptions {
  cfg: BilibiliVideoConfigSection;
  timezone: string;
  dataDir: string;
}

export class BilibiliVideoWorld implements World {
  readonly id = BILIBILI_VIDEO_ID;
  private readonly cfg: BilibiliVideoConfigSection;
  private host: WorldHost | null = null;
  private log: Logger | null = null;
  private readonly jar: CookieJar;
  private readonly qr: QrLogin;
  private readonly browser: VideoBrowser;
  private identity: Identity = { isLogin: false };

  private mode: Mode = 'idle';
  private currentBvid: string | null = null;
  private currentPart = 1;
  private video: VideoInfo | null = null;
  private readonly danmaku = new DanmakuPool();
  private subtitleTracks: SubtitleTrack[] = [];
  private subtitles: SubtitleLine[] = [];
  private subtitleLabel = '';
  private lastList: ListEntry[] = [];
  private startError: string | null = null;

  private samples: StoredSample[] = [];
  private prevGray: number[] | null = null;
  private prevMafd = 0;
  /** Operator pause/resume is reported once it has held for this many polls. */
  private pauseSeen = 0;
  private resumeSeen = 0;
  private lastObservedT = 0;
  private lastObservedAt = 0;
  private captureTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private observeTimer: ReturnType<typeof setTimeout> | null = null;
  private observeQueued = false;
  private lastPlayback: Playback | null = null;
  /** Playback changes the World itself asked for, so the poll does not report them as the operator's. */
  private ownChangeUntil = 0;
  private stalledSince = 0;
  private stallReported = false;
  private lastMontage: { jpeg: Buffer; at: string; cells: number } | null = null;
  private sceneCount = 0;
  private generation = 0;
  private contentGeneration = 0;
  private observationGeneration = 0;
  private navigationTimer: ReturnType<typeof setTimeout> | null = null;
  private polling: number | null = null;
  private capturing: number | null = null;

  constructor(private readonly opts: BilibiliVideoWorldOptions) {
    this.cfg = opts.cfg;
    this.jar = new CookieJar(join(opts.dataDir, 'bilibili-video', 'cookies.json'));
    this.qr = new QrLogin({ jar: this.jar, onChange: (s) => { if (s.status === 'authorized') void this.refreshIdentity(); } });
    this.browser = new VideoBrowser({
      cfg: opts.cfg,
      dataDir: opts.dataDir,
      jar: this.jar,
      log: () => this.log,
      onNavigated: (url, byWorld) => this.onNavigated(url, byWorld),
      onLost: () => this.onBrowserLost(),
      onDanmaku: (list) => { this.danmaku.add(list); },
      onSubtitleTracks: (cid, tracks) => { if (!this.video || this.video.cid === cid) this.subtitleTracks = tracks; },
    });
  }

  /* ---------- lifecycle ---------- */

  async start(host: WorldHost): Promise<void> {
    const generation = ++this.generation;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.host = host;
    this.log = host.log;
    this.startError = null;
    await this.refreshIdentity();
    if (generation !== this.generation || this.host !== host) return;
    // the browser window is opened on purpose: from the WebUI, by the bot's tool, or by the first page tool
    this.pollTimer = setInterval(() => { void this.poll().catch(() => this.log?.warn('bilibili-video playback polling failed')); }, POLL_MS);
    this.pollTimer.unref?.();
  }

  /** Opens the browser window on the bilibili home page; `by` names who asked, for the event the other side gets. */
  private async openBrowser(by: 'operator' | 'bot', operation: Operation): Promise<string> {
    operation.check();
    if (this.browser.connected && this.mode !== 'idle') return `浏览器已经开着,${this.stateLine()}`;
    this.startError = null;
    try {
      operation.checked(await operation.wait(() => this.browser.goto(HOME_URL)));
    } catch (err) {
      operation.check();
      this.startError = (err as Error).message;
      this.log?.warn('bilibili-video browser failed to open', { err: this.startError });
      throw err;
    }
    this.mode = 'browsing';
    if (by === 'operator') this.pushState('[视频] 操作员打开了 B 站浏览器窗口,停在首页。');
    return '浏览器窗口已打开,停在 B 站首页';
  }

  private async closeBrowser(by: 'operator' | 'bot', operation: Operation): Promise<string> {
    operation.check();
    if (!this.browser.connected && this.mode === 'idle') return '浏览器本来就没开';
    this.stopObserving();
    operation.checked(await operation.wait(() => this.browser.stop()));
    this.resetVideo();
    this.currentBvid = null;
    this.lastPlayback = null;
    this.mode = 'idle';
    if (by === 'operator') this.pushState('[视频] 操作员关掉了 B 站浏览器窗口。');
    return '浏览器窗口已关闭';
  }

  /** The window went away without a stop (closed by hand, crashed). */
  private onBrowserLost(): void {
    if (this.mode === 'idle') return;
    this.stopObserving();
    this.resetVideo();
    this.currentBvid = null;
    this.lastPlayback = null;
    this.mode = 'idle';
    this.pushState('[视频] B 站浏览器窗口被关掉了。要用再 bilibili_video_browser 打开。');
  }

  async stop(): Promise<void> {
    const generation = ++this.generation;
    this.host = null;
    this.stopObserving();
    if (this.navigationTimer) clearTimeout(this.navigationTimer);
    this.navigationTimer = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.qr.stop();
    await this.browser.stop();
    if (generation !== this.generation) return;
    this.resetVideo();
    this.lastPlayback = null;
    this.currentBvid = null;
    this.mode = 'idle';
  }

  private async refreshIdentity(): Promise<void> {
    const generation = this.generation;
    const identity = await this.qr.whoami();
    if (generation === this.generation) this.identity = identity;
  }

  /* ---------- state changes ---------- */

  private onNavigated(url: string, byWorld: boolean): void {
    if (!this.host) return;
    if (this.navigationTimer) clearTimeout(this.navigationTimer);
    this.navigationTimer = null;
    // Tracking-query rewrites keep the same content; another part has its own
    // cid, subtitles and danmaku even when its BV id is unchanged.
    const bvid = url.match(/\/video\/(BV[0-9A-Za-z]{10})/)?.[1] ?? null;
    let part = 1;
    try { const p = Number(new URL(url).searchParams.get('p')); if (Number.isInteger(p) && p > 0) part = p; } catch { /* a non-video URL resets content below */ }
    const sameVideo = bvid !== null && bvid === this.currentBvid && part === this.currentPart;
    this.currentBvid = bvid;
    this.currentPart = part;
    if (!sameVideo) this.resetVideo();
    if (byWorld) return;
    if (this.mode === 'watching' || this.mode === 'paused') this.stopObserving();
    this.mode = 'browsing';
    const generation = this.generation, content = this.contentGeneration;
    this.navigationTimer = setTimeout(() => {
      this.navigationTimer = null;
      if (generation !== this.generation || content !== this.contentGeneration) return;
      void this.reportOperatorNavigation(url).catch(() => this.log?.warn('bilibili-video navigation observation failed'));
    }, 2500);
    this.navigationTimer.unref?.();
  }

  private async reportOperatorNavigation(url: string): Promise<void> {
    if (!this.host) return;
    const host = this.host, generation = this.generation, content = this.contentGeneration;
    let text: string;
    if (/\/video\/BV/.test(url)) {
      await this.browser.waitForVideo(8000);
      if (host !== this.host || generation !== this.generation || content !== this.contentGeneration) return;
      const info = await this.browser.videoInfo().catch(() => null);
      if (host !== this.host || generation !== this.generation || content !== this.contentGeneration) return;
      this.video = info;
      text = info
        ? `[视频] 操作员在窗口里换到了《${info.title}》(${info.owner},${fmt(info.duration)}${info.parts.length > 1 ? `,第 ${info.p}/${info.parts.length} P` : ''}),没有播放。想看就 bilibili_video_play。`
        : `[视频] 操作员在窗口里打开了 ${url},没有播放。`;
    } else {
      text = `[视频] 操作员把窗口切到了 ${url}。`;
    }
    void host.pushEvent({ type: 'bilibili-video.state', source: this.id, origin: 'external', ts: nowIso(this.opts.timezone), text, senderKey: this.id }, { trigger: 'flush' });
  }

  private resetVideo(): void {
    this.contentGeneration++;
    this.video = null;
    this.danmaku.clear();
    this.subtitleTracks = [];
    this.subtitles = [];
    this.subtitleLabel = '';
    this.samples = [];
    this.prevGray = null;
  }

  private async poll(): Promise<void> {
    if (this.mode === 'idle' || !this.host) return;
    const generation = this.generation, content = this.contentGeneration;
    if (this.polling === generation) return;
    this.polling = generation;
    try {
    const pb = await this.browser.playback();
    if (generation !== this.generation || content !== this.contentGeneration || !this.host) return;
    const prev = this.lastPlayback;
    this.lastPlayback = pb;
    if (!pb) return;
    const own = Date.now() < this.ownChangeUntil;
    if (this.mode === 'watching') {
      if (pb.ended) {
        this.stopObserving();
        this.mode = 'browsing';
        this.pushState(`[视频] 《${this.video?.title ?? ''}》播放完了(${fmt(pb.duration)})。`);
        return;
      }
      // the player pauses itself for a moment when switching quality; only a pause that holds is the operator's
      this.pauseSeen = pb.paused && !own ? this.pauseSeen + 1 : 0;
      if (this.pauseSeen >= 3) {
        this.pauseSeen = 0;
        this.stopObserving();
        this.mode = 'paused';
        this.pushState(`[视频] 操作员在窗口里暂停了,停在 ${fmt(pb.t)}。`);
        return;
      }
      const stalled = !pb.paused && (pb.readyState < 3 || (prev && !prev.paused && pb.t === prev.t));
      if (stalled) {
        this.stalledSince ||= Date.now();
        if (!this.stallReported && Date.now() - this.stalledSince > this.cfg.playback.stallSec * 1000) {
          this.stallReported = true;
          const ahead = pb.bufferedEnd > pb.t ? `缓冲到 ${fmt(pb.bufferedEnd)}` : '没有缓冲';
          this.pushState(`[视频] 播放器在 ${fmt(pb.t)} 卡住加载超过 ${this.cfg.playback.stallSec} 秒,${ahead},当前画质 ${pb.quality || '未知'}。一直卡可以 bilibili_video_quality 降一档。`);
        }
      } else {
        if (this.stallReported) this.pushState(`[视频] 播放器恢复了,现在 ${fmt(pb.t)}。`);
        this.stalledSince = 0;
        this.stallReported = false;
      }
    } else if (this.mode === 'paused') {
      this.resumeSeen = !pb.paused && !own ? this.resumeSeen + 1 : 0;
      if (this.resumeSeen >= 2) {
        this.resumeSeen = 0;
        this.mode = 'watching';
        this.lastObservedT = pb.t;
        this.startObserving();
        this.pushState(`[视频] 操作员在窗口里继续播放了,从 ${fmt(pb.t)} 起。`);
      }
    }
    } finally { if (this.polling === generation) this.polling = null; }
  }

  private pushState(text: string): void {
    if (!this.host) return;
    void this.host.pushEvent({ type: 'bilibili-video.state', source: this.id, origin: 'external', ts: nowIso(this.opts.timezone), text, senderKey: this.id }, { trigger: 'flush' });
  }

  /* ---------- observation ---------- */

  private startObserving(): void {
    this.stopObserving();
    this.samples = [];
    this.prevGray = null;
    this.lastObservedAt = Date.now();
    this.stalledSince = 0;
    this.stallReported = false;
    const period = Math.max(100, Math.round(1000 / this.cfg.observe.captureFps));
    this.captureTimer = setInterval(() => { void this.capture().catch(() => this.log?.warn('bilibili-video capture failed')); }, period);
    this.captureTimer.unref?.();
    this.armObservation();
    void this.ensureSubtitles().catch(() => this.log?.warn('bilibili-video subtitle observation failed'));
  }

  private stopObserving(): void {
    this.observationGeneration++;
    if (this.captureTimer) clearInterval(this.captureTimer);
    this.captureTimer = null;
    if (this.observeTimer) clearTimeout(this.observeTimer);
    this.observeTimer = null;
    this.observeQueued = false;
  }

  private async capture(): Promise<void> {
    if (this.mode !== 'watching' || !this.host) return;
    const generation = this.generation, content = this.contentGeneration, observation = this.observationGeneration;
    if (this.capturing === observation) return;
    this.capturing = observation;
    try {
    const o = this.cfg.observe;
    const s = await this.browser.sample(o.cellWidth, o.cellHeight, o.jpegQuality);
    if (!s || generation !== this.generation || content !== this.contentGeneration || observation !== this.observationGeneration || !this.host || this.mode !== 'watching') return;
    const last = this.samples.at(-1);
    if (last && s.t <= last.t) return;
    const luma = s.gray.reduce((a, b) => a + b, 0) / s.gray.length;
    const mafd = this.prevGray ? meanAbsDiff(this.prevGray, s.gray) : 0;
    // a cut is a jump in frame difference, not a large difference: steady motion keeps mafd
    // level, so min(mafd, |mafd − previous mafd|) stays low for it (ffmpeg's scene score)
    const diff = Math.min(mafd, Math.abs(mafd - this.prevMafd));
    this.prevMafd = mafd;
    this.prevGray = s.gray;
    this.samples.push({ t: s.t, jpeg: s.jpeg, w: s.w, h: s.h, hash: dhash(s.gray, 64, 36), luma, diff });
    if (this.samples.length > SAMPLE_CAP) this.samples.splice(0, this.samples.length - SAMPLE_CAP);
    } finally { if (this.capturing === observation) this.capturing = null; }
  }

  private armObservation(): void {
    if (this.observeTimer || this.observeQueued || this.mode !== 'watching' || !this.host) return;
    const generation = this.generation, content = this.contentGeneration, observation = this.observationGeneration;
    const wait = Math.max(0, this.cfg.observe.minIntervalSec * 1000 - (Date.now() - this.lastObservedAt));
    this.observeTimer = setTimeout(() => {
      this.observeTimer = null;
      if (this.mode !== 'watching' || !this.host || generation !== this.generation || content !== this.contentGeneration || observation !== this.observationGeneration) return;
      this.observeQueued = true;
      this.host.pushDeferred({ type: 'bilibili-video.scene', origin: 'external', senderKey: this.id, render: () => this.renderScene(generation, content, observation) }, { trigger: 'debounce' });
    }, wait);
    this.observeTimer.unref?.();
  }

  /** Builds the observation at delivery time, then arms the next one. */
  private async renderScene(generation = this.generation, content = this.contentGeneration, observation = this.observationGeneration): Promise<{ text: string; blobs: Array<{ bytes: Uint8Array; mime: string; name: string; fallbackText: string }> } | null> {
    const current = () => generation === this.generation && content === this.contentGeneration && observation === this.observationGeneration && !!this.host && this.mode === 'watching';
    if (!current()) return null;
    this.observeQueued = false;
    try {
      if (this.mode !== 'watching') return null;
      const o = this.cfg.observe;
      const t0 = this.lastObservedT;
      const pool = this.samples.filter((s) => s.t > t0);
      if (!pool.length) return null;
      const t1 = pool[pool.length - 1].t;
      const gap = Math.max(0.5, t1 - t0);
      const idx = selectFrames(pool, gap, o);
      const chosen = idx.map((i) => pool[i]);
      const grid = gridFor(chosen.length);
      // cells share the newest frame's orientation; an odd one out is scaled into it
      const newest = chosen[chosen.length - 1];
      const jpeg = await this.browser.montage(chosen.map((c) => c.jpeg), grid.cols, grid.rows, newest.w, newest.h, o.jpegQuality);
      if (!jpeg || !current()) return null;
      const bytes = Buffer.from(jpeg, 'base64');
      this.lastObservedT = t1;
      this.lastObservedAt = Date.now();
      this.samples = this.samples.filter((s) => s.t > t1 - 1);
      this.sceneCount++;
      this.lastMontage = { jpeg: bytes, at: new Date().toISOString(), cells: chosen.length };

      const v = this.video;
      const lines: string[] = [];
      lines.push(`[视频]${v ? ` 《${v.title}》` : ''} 现在 ${fmt(t1)}${v ? ` / ${fmt(v.duration)}` : ''},播放中。`);
      const times = chosen.map((c, i) => `${fmt(c.t)}${i === chosen.length - 1 ? '(最新)' : ''}`).join('、');
      lines.push(chosen.length === 1 ? `画面 1 格:${times}` : `画面 ${chosen.length} 格(${grid.cols}×${grid.rows},左→右、上→下):${times}`);
      const events = describeEvents(pool, o, fmt);
      if (events.length) lines.push(`检测:${events.join(';')}`);
      if (v) {
        const entered = v.chapters.filter((c) => c.from > t0 && c.from <= t1);
        if (entered.length) lines.push(`进入章节:${entered.map((c) => `${fmt(c.from)}「${c.title}」`).join('、')}`);
      }
      if (!this.subtitles.length) await this.ensureSubtitles();
      if (!current()) return null;
      if (this.cfg.subtitle.enabled && this.subtitles.length) {
        const sub = subtitlesBetween(this.subtitles, t0, t1);
        if (sub.length) lines.push(`字幕(${this.subtitleLabel}):${sub.map((l) => `${fmt(l.from)} ${l.content}`).join(' | ')}`);
      }
      if (this.cfg.danmaku.enabled && this.danmaku.size) {
        const dm = this.danmaku.between(t0, t1);
        if (dm.length) {
          const quoted = spread(dm, this.cfg.danmaku.maxPerScene);
          lines.push(`视频弹幕 ${fmt(t0)}–${fmt(t1)} 共 ${dm.length} 条${quoted.length < dm.length ? `,引 ${quoted.length} 条` : ''}:${quoted.map((d) => `${fmt(d.t)} ${d.content}`).join(';')}`);
        }
      }
      return { text: lines.join('\n'), blobs: [{ bytes, mime: 'image/jpeg', name: `scene-${this.sceneCount}.jpg`, fallbackText: `画面拼图 ${chosen.length} 格` }] };
    } catch (err) {
      this.log?.warn('bilibili-video scene render failed', { err: (err as Error).message });
      return null;
    } finally {
      if (current()) this.armObservation();
    }
  }

  private async ensureSubtitles(): Promise<void> {
    if (!this.cfg.subtitle.enabled || this.subtitles.length || !this.subtitleTracks.length) return;
    const track = this.subtitleTracks.find((t) => /^ai-zh/.test(t.lan)) ?? this.subtitleTracks.find((t) => /^zh/.test(t.lan)) ?? this.subtitleTracks[0];
    const generation = this.generation, content = this.contentGeneration;
    const lines = await this.browser.fetchSubtitle(track.url);
    if (lines.length && generation === this.generation && content === this.contentGeneration && this.subtitleTracks.includes(track)) {
      this.subtitles = lines;
      this.subtitleLabel = track.label;
    }
  }

  /* ---------- tools ---------- */

  private beginOperation(): Operation {
    const host = this.host, generation = this.generation;
    const check = () => {
      if (!host || this.host !== host || this.generation !== generation) {
        throw new BrowserRefusal('操作已中止（扩展未运行、已停止或已重启）；已发生的浏览器动作不会回滚，请按当前状态重试');
      }
    };
    check();
    return { check, checked<T>(value: T): T { check(); return value; }, async wait<T>(action: () => Promise<T>): Promise<T> {
      check();
      try { return await action(); } finally { check(); }
    } };
  }

  tools(): ToolDef[] {
    const handlers: Record<string, (args: Args, operation: Operation) => Promise<ToolOutcome>> = {
      bilibili_video_browser: async (a, op) => ({ text: a.action === 'close' ? await this.closeBrowser('bot', op) : await this.openBrowser('bot', op) }),
      bilibili_video_open: (a, op) => this.open(a, op),
      bilibili_video_play: (a, op) => this.play(a, op),
      bilibili_video_pause: (_, op) => this.pauseTool(op),
      bilibili_video_seek: (a, op) => this.seek(a, op),
      bilibili_video_look: (a, op) => this.look(a, op),
      bilibili_video_quality: (a, op) => this.quality(a, op),
      bilibili_video_exit: (_, op) => this.exit(op),
      bilibili_video_search: (a, op) => this.search(a, op),
      bilibili_video_related: (_, op) => this.related(op),
      bilibili_video_comments: (a, op) => this.comments(a, op),
      bilibili_video_scroll: (a, op) => this.scroll(a, op),
      bilibili_video_snapshot: (_, op) => this.snapshot(op),
    };
    return BILIBILI_VIDEO_TOOL_DECLS.map((decl) => ({
      ...decl,
      handler: async (args: Args) => {
        try {
          const operation = this.beginOperation();
          // open and search bring the window up themselves; the rest work on a page that is already there
          if (this.mode === 'idle' && !['bilibili_video_browser', 'bilibili_video_open', 'bilibili_video_search'].includes(decl.name)) {
            return { text: `[${decl.name} 没执行] 浏览器窗口没开;bilibili_video_browser open,或直接 bilibili_video_open / bilibili_video_search。`, failed: true };
          }
          const out = operation.checked(await operation.wait(() => handlers[decl.name](args, operation)));
          if (this.mode === 'idle' && this.browser.connected) this.mode = 'browsing';
          return out;
        } catch (err) {
          if (err instanceof BrowserRefusal) return { text: `[${decl.name} 没执行] ${err.message}。`, failed: true };
          return { text: `[${decl.name} 失败] ${(err as Error).message}`, failed: true };
        }
      },
    }));
  }

  private async loadVideoPage(operation: Operation): Promise<VideoInfo | null> {
    operation.checked(await operation.wait(() => this.browser.waitForVideo()));
    for (let i = 0; i < 5; i++) {
      const info = operation.checked(await operation.wait(() => this.browser.videoInfo()));
      if (info) { this.video = info; break; }
      operation.checked(await operation.wait(() => sleep(400)));
    }
    // the subtitle list rides on the player-info response; give it a moment to arrive
    for (let i = 0; i < 10 && !(this.video && this.browser.playerInfoCid === this.video.cid); i++) operation.checked(await operation.wait(() => sleep(400)));
    return this.video;
  }

  private describeVideo(v: VideoInfo): string {
    const parts = v.parts.length > 1 ? `,共 ${v.parts.length} P,现在第 ${v.p} P「${v.parts.find((x) => x.p === v.p)?.title ?? ''}」` : '';
    const subs = this.subtitleTracks.length ? `字幕:${this.subtitleTracks.map((t) => t.label).join('、')}` : '没有字幕';
    const desc = v.desc.replace(/\s+/g, ' ').trim();
    const chapters = v.chapters.length ? `\n章节:${v.chapters.map((c) => `${fmt(c.from)}「${c.title}」`).join('、')}` : '';
    return `《${v.title}》 UP 主 ${v.owner},${fmt(v.duration)},${v.views} 次播放${parts}。${subs};视频弹幕已载入 ${this.danmaku.size} 条(播放中会继续载入)。${desc ? `\n简介:${desc.slice(0, 200)}${desc.length > 200 ? '…' : ''}` : ''}${chapters}`;
  }

  private async open(args: Args, operation: Operation): Promise<ToolOutcome> {
    const target = typeof args.target === 'string' ? args.target.trim() : '';
    const p = typeof args.p === 'number' && args.p >= 1 ? Math.round(args.p) : 0;
    if (this.mode === 'watching' || this.mode === 'paused') operation.checked(await operation.wait(() => this.leaveWatching(operation)));
    if (!target) {
      operation.checked(await operation.wait(() => this.browser.goto(HOME_URL)));
      this.mode = 'browsing';
      operation.checked(await operation.wait(() => sleep(1500)));
      this.lastList = operation.checked(await operation.wait(() => this.browser.listVideos({ max: LIST_MAX })));
      return { text: `已回到 B 站首页。首页上的视频:\n${listText(this.lastList)}` };
    }
    let url: string;
    let revealed = '';
    if (/^\d{1,2}$/.test(target)) {
      const entry = this.lastList.find((e) => e.n === Number(target));
      if (!entry) throw new BrowserRefusal(`上一次列表里没有第 ${target} 条${this.lastList.length ? `(有 1–${this.lastList.length})` : '(还没有列表,先搜索或看推荐)'}`);
      if (operation.checked(await operation.wait(() => this.browser.revealVideo(entry.bvid)))) revealed = '(先把那张卡片滚到了画面里)';
      url = entry.url;
    } else if (/^BV[0-9A-Za-z]{10}$/.test(target)) {
      url = `https://www.bilibili.com/video/${target}`;
    } else {
      let u: URL;
      try { u = new URL(target.startsWith('http') ? target : `https://${target}`); } catch { throw new BrowserRefusal(`「${target}」不是 BV 号、网址或列表序号`); }
      if (!/(^|\.)bilibili\.com$/.test(u.hostname) && !/(^|\.)b23\.tv$/.test(u.hostname)) throw new BrowserRefusal('这个窗口只开 bilibili.com 的页面');
      url = u.toString();
    }
    if (p > 1 && /\/video\//.test(url)) url += (url.includes('?') ? '&' : '?') + `p=${p}`;
    operation.checked(await operation.wait(() => this.browser.goto(url)));
    this.mode = 'browsing';
    if (!/\/video\//.test(this.browser.url())) {
      operation.checked(await operation.wait(() => sleep(1500)));
      this.lastList = operation.checked(await operation.wait(() => this.browser.listVideos({ max: LIST_MAX })));
      return { text: `已打开 ${this.browser.url()}${revealed}。${this.lastList.length ? `页面上的视频:\n${listText(this.lastList)}` : ''}` };
    }
    const info = operation.checked(await operation.wait(() => this.loadVideoPage(operation)));
    if (!info) return { text: `已打开 ${this.browser.url()}${revealed},但页面上读不到视频信息(可能不是视频页,或还在加载)。`, failed: true };
    return { text: `已打开视频页${revealed},没有播放。${this.describeVideo(info)}\n要看就 bilibili_video_play。` };
  }

  private async play(args: Args, operation: Operation): Promise<ToolOutcome> {
    if (!/\/video\//.test(this.browser.url())) throw new BrowserRefusal('当前窗口不是视频页;先 bilibili_video_open 打开一个视频');
    if (!this.video) operation.checked(await operation.wait(() => this.loadVideoPage(operation)));
    const from = typeof args.fromSec === 'number' && args.fromSec >= 0 ? args.fromSec : undefined;
    this.ownChangeUntil = Date.now() + 3000;
    operation.checked(await operation.wait(() => this.browser.setWebFullscreen(true)));
    operation.checked(await operation.wait(() => this.browser.play(from)));
    operation.checked(await operation.wait(() => sleep(600)));
    const pb = operation.checked(await operation.wait(() => this.browser.playback()));
    this.mode = 'watching';
    this.lastObservedT = pb?.t ?? from ?? 0;
    this.lastPlayback = pb;
    this.startObserving();
    const o = this.cfg.observe;
    return { text: `开始看${this.video ? `《${this.video.title}》` : ''},从 ${fmt(pb?.t ?? from ?? 0)} 起,画面 ${pb?.width ?? '?'}×${pb?.height ?? '?'}。之后每隔约 ${o.minIntervalSec} 秒自动收到一条观察帧。` };
  }

  private async pauseTool(operation: Operation): Promise<ToolOutcome> {
    if (this.mode !== 'watching') return { text: this.mode === 'paused' ? '已经是暂停状态。' : '现在没有在看视频。' };
    this.ownChangeUntil = Date.now() + 3000;
    operation.checked(await operation.wait(() => this.browser.pause()));
    this.stopObserving();
    this.mode = 'paused';
    const pb = operation.checked(await operation.wait(() => this.browser.playback()));
    return { text: `已暂停,停在 ${fmt(pb?.t ?? 0)}。bilibili_video_play 继续。` };
  }

  private async seek(args: Args, operation: Operation): Promise<ToolOutcome> {
    if (this.mode !== 'watching' && this.mode !== 'paused') throw new BrowserRefusal('现在没有在看视频;先 bilibili_video_play');
    const pb = operation.checked(await operation.wait(() => this.browser.playback()));
    if (!pb) throw new BrowserRefusal('页面上没有播放器');
    let to: number;
    if (typeof args.toSec === 'number') to = args.toSec;
    else if (typeof args.bySec === 'number') to = pb.t + args.bySec;
    else throw new BrowserRefusal('给 toSec 或 bySec');
    to = Math.max(0, Math.min(pb.duration || to, to));
    this.ownChangeUntil = Date.now() + 3000;
    operation.checked(await operation.wait(() => this.browser.seek(to)));
    if (this.mode === 'paused') { operation.checked(await operation.wait(() => this.browser.play())); this.mode = 'watching'; }
    this.lastObservedT = to;
    this.samples = [];
    this.prevGray = null;
    this.startObserving();
    return { text: `已跳到 ${fmt(to)}${pb.duration ? ` / ${fmt(pb.duration)}` : ''},继续播放。` };
  }

  private async look(args: Args, operation: Operation): Promise<ToolOutcome> {
    const o = this.cfg.observe;
    const nums = [args.x, args.y, args.width, args.height];
    const region = nums.every((n) => typeof n === 'number') ? { x: clamp01(args.x as number), y: clamp01(args.y as number), width: clamp01(args.width as number), height: clamp01(args.height as number) } : undefined;
    const f = operation.checked(await operation.wait(() => this.browser.frame(o.cellWidth * 2, o.cellHeight * 2, Math.max(o.jpegQuality, 0.85), region)));
    if (!f) throw new BrowserRefusal('页面上没有正在播放或已加载的视频画面');
    const where = region ? `区域 (${region.x.toFixed(2)}, ${region.y.toFixed(2)}) ${region.width.toFixed(2)}×${region.height.toFixed(2)}` : '整帧';
    return { text: `${fmt(f.t)} 的画面,${where},${f.width}×${f.height}。`, blobs: [{ bytes: Buffer.from(f.jpeg, 'base64'), mime: 'image/jpeg', name: 'look.jpg', fallbackText: `视频画面 ${f.width}×${f.height}` }] };
  }

  private async quality(args: Args, operation: Operation): Promise<ToolOutcome> {
    if (!/\/video\//.test(this.browser.url())) throw new BrowserRefusal('当前窗口不是视频页');
    const want = typeof args.level === 'string' ? args.level.trim() : '';
    const describe = (list: Array<{ label: string; active: boolean }>) => list.map((q) => `${q.label}${q.active ? '(当前)' : ''}`).join(' | ');
    let list = operation.checked(await operation.wait(() => this.browser.qualityOptions()));
    if (!list.length) throw new BrowserRefusal('播放器的画质菜单还没出现(视频还没开始加载)');
    if (!want) return { text: `画质档位:${describe(list)}。` };
    this.ownChangeUntil = Date.now() + 5000;
    if (!(operation.checked(await operation.wait(() => this.browser.setQuality(want))))) return { text: `菜单里没有包含「${want}」的档位。现有:${describe(list)}。`, failed: true };
    operation.checked(await operation.wait(() => sleep(1500)));
    list = operation.checked(await operation.wait(() => this.browser.qualityOptions()));
    const pb = operation.checked(await operation.wait(() => this.browser.playback()));
    return { text: `已点「${want}」。现在:${describe(list)};播放器显示 ${pb?.quality || '未知'},画面 ${pb?.width ?? '?'}×${pb?.height ?? '?'}(切换要几秒生效,标「大会员」「登录即享」的档位点了也不会生效)。` };
  }

  private async leaveWatching(operation: Operation): Promise<void> {
    this.ownChangeUntil = Date.now() + 3000;
    this.stopObserving();
    operation.checked(await operation.wait(() => this.browser.pause().catch(() => {})));
    operation.checked(await operation.wait(() => this.browser.setWebFullscreen(false).catch(() => {})));
    this.mode = 'browsing';
  }

  private async exit(operation: Operation): Promise<ToolOutcome> {
    if (this.mode !== 'watching' && this.mode !== 'paused') return { text: '现在就在逛页面的状态。' };
    const pb = operation.checked(await operation.wait(() => this.browser.playback()));
    operation.checked(await operation.wait(() => this.leaveWatching(operation)));
    return { text: `已退出观看,停在 ${fmt(pb?.t ?? 0)},页面留在这个视频。` };
  }

  private async search(args: Args, operation: Operation): Promise<ToolOutcome> {
    const keyword = typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!keyword) throw new BrowserRefusal('keyword 是空的');
    const page = typeof args.page === 'number' && args.page >= 1 ? Math.round(args.page) : 1;
    if (this.mode === 'watching' || this.mode === 'paused') operation.checked(await operation.wait(() => this.leaveWatching(operation)));
    operation.checked(await operation.wait(() => this.browser.goto(`https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}${page > 1 ? `&page=${page}` : ''}`)));
    this.mode = 'browsing';
    operation.checked(await operation.wait(() => sleep(2000)));
    this.lastList = operation.checked(await operation.wait(() => this.browser.listVideos({ max: LIST_MAX })));
    if (!this.lastList.length) return { text: `搜索「${keyword}」的结果页打开了,但页面上没读到视频卡片;用 bilibili_video_snapshot 看一眼。`, failed: true };
    return { text: `搜索「${keyword}」第 ${page} 页,${this.lastList.length} 条:\n${listText(this.lastList)}\nbilibili_video_open 给序号打开。` };
  }

  private async related(operation: Operation): Promise<ToolOutcome> {
    if (!/\/video\//.test(this.browser.url())) throw new BrowserRefusal('当前窗口不是视频页');
    const exclude = this.video?.bvid;
    let list = operation.checked(await operation.wait(() => this.browser.listVideos({ within: '#reco_list, .recommend-list-v1, .rec-list, .video-page-card-small', exclude, max: 15 })));
    if (!list.length) list = operation.checked(await operation.wait(() => this.browser.listVideos({ exclude, max: 15 })));
    this.lastList = list;
    if (!list.length) return { text: '页面上没读到相关推荐。', failed: true };
    return { text: `相关推荐 ${list.length} 条:\n${listText(list)}\nbilibili_video_open 给序号打开。` };
  }

  private async comments(args: Args, operation: Operation): Promise<ToolOutcome> {
    if (!/\/video\//.test(this.browser.url())) throw new BrowserRefusal('当前窗口不是视频页');
    if (this.mode === 'watching' || this.mode === 'paused') operation.checked(await operation.wait(() => this.leaveWatching(operation)));
    const count = typeof args.count === 'number' ? Math.max(1, Math.min(50, Math.round(args.count))) : 15;
    const list = operation.checked(await operation.wait(() => this.browser.readComments(count)));
    if (!list.length) return { text: '已滚到评论区,但还没读到评论(可能还在加载,或这个视频关了评论);用 bilibili_video_snapshot 看一眼。', failed: true };
    return { text: `评论区前 ${list.length} 条:\n${list.map((c, i) => `${i + 1}. ${c.user}${c.likes ? `(赞 ${c.likes})` : ''}:${c.text}`).join('\n')}` };
  }

  private async scroll(args: Args, operation: Operation): Promise<ToolOutcome> {
    const n = typeof args.screens === 'number' && Number.isFinite(args.screens) ? Math.max(-10, Math.min(10, args.screens)) : 1;
    const r = operation.checked(await operation.wait(() => this.browser.scrollScreens(n)));
    return { text: `滚了 ${n} 屏,页面位置 ${r.y}/${r.height}。` };
  }

  private async snapshot(operation: Operation): Promise<ToolOutcome> {
    const s = operation.checked(await operation.wait(() => this.browser.screenshot(0.8)));
    return { text: `窗口截图:「${s.title}」 ${s.url}`, blobs: [{ bytes: s.jpeg, mime: 'image/jpeg', name: 'window.jpg', fallbackText: '窗口截图' }] };
  }

  /* ---------- prompt & WebUI ---------- */

  private stateLine(): string {
    const v = this.video;
    const pb = this.lastPlayback;
    switch (this.mode) {
      case 'idle': return this.startError ? `浏览器没开起来(${this.startError})` : '浏览器窗口没开(WebUI 面板或 bilibili_video_browser 可以打开)';
      case 'browsing': return v ? `停在视频页《${v.title}》,没有播放` : `逛页面,${this.browser.url() || '空白'}`;
      case 'watching': return `正在看《${v?.title ?? ''}》,${fmt(pb?.t ?? 0)} / ${fmt(v?.duration ?? pb?.duration ?? 0)}`;
      case 'paused': return `《${v?.title ?? ''}》暂停在 ${fmt(pb?.t ?? 0)}`;
    }
  }

  envPromptVars(): Record<string, string> {
    const state = { idle: '浏览器窗口未打开', browsing: '浏览器已打开，未进入观看模式', watching: '正在观看视频', paused: '视频已暂停' }[this.mode];
    return {
      'bilibiliVideo.identity': this.identity.isLogin ? '已登录' : '未登录(看不到需要登录的清晰度和字幕)',
      'bilibiliVideo.state': `${state}；标题、账号名与页面内容以外部事件或工具回执为准。`,
      'bilibiliVideo.intervalSec': String(this.cfg.observe.minIntervalSec),
      'bilibiliVideo.stallSec': String(this.cfg.playback.stallSec),
    };
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const en = language === 'en';
    const auth = this.qr.current;
    const modeText: Record<Mode, string> = { idle: en ? 'idle' : '未启动', browsing: en ? 'browsing' : '逛页面', watching: en ? 'watching' : '观看中', paused: en ? 'paused' : '已暂停' };
    return {
      label: en ? 'Bilibili video' : 'B 站视频',
      lamps: [
        { label: en ? 'Sign-in' : '登录', state: this.identity.isLogin ? 'online' : auth.status === 'pending' || auth.status === 'scanned' ? 'loading' : 'offline', hint: this.identity.isLogin ? this.identity.uname : auth.detail ?? (en ? 'not signed in' : '未登录') },
        { label: en ? 'Browser' : '浏览器', state: this.browser.connected ? 'online' : this.startError ? 'error' : 'offline', hint: this.startError ?? (this.browser.connected ? this.browser.url() : en ? 'closed; open it from the playback panel' : '没开;在「播放状态」面板里打开') },
        { label: en ? 'Playback' : '播放', state: this.mode === 'watching' ? 'online' : 'offline', hint: this.stateLine() },
      ],
      badges: [
        { label: en ? 'State' : '状态', value: modeText[this.mode], tone: this.mode === 'watching' ? 'on' : 'plain' },
        { label: en ? 'Scenes' : '观察帧', value: this.sceneCount, tone: 'plain' },
      ],
      panels: [
        { id: 'auth', title: en ? 'Bilibili sign-in' : 'B 站授权', description: en ? 'Scan the QR code with the bilibili app.' : '用手机 B 站扫码登录;登录态存在数据目录里,每次开浏览器自动带上。', getMethods: ['qr'] },
        { id: 'player', title: en ? 'Playback' : '播放状态', description: en ? 'What the bot is watching and the latest observation grid.' : '现在在看什么,最近一张观察帧。', getMethods: ['montage'] },
      ],
      invoke: (panel, method) => this.invoke(panel, method),
      config: [BILIBILI_VIDEO_CONFIG_GROUP],
      promptDocs: [{
        key: `worlds.${BILIBILI_VIDEO_ID}.envPrompt`,
        title: 'B 站视频环境',
        description: '两种状态、观察帧的读法、看视频时的说话约定。',
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'bilibiliVideo.identity', description: '登录身份' },
          { name: 'bilibiliVideo.state', description: '现在在逛页面还是在看哪个视频' },
          { name: 'bilibiliVideo.intervalSec', description: '观察帧最短间隔(秒)' },
          { name: 'bilibiliVideo.stallSec', description: '卡住判定时长(秒)' },
        ],
      }],
      storage: [{
        key: 'bilibili-video.cookies',
        label: en ? 'Sign-in cookies' : '登录 cookie',
        kind: 'disk',
        location: this.jar.path,
        danger: true,
        note: en ? 'Signs the browser out.' : '清除后浏览器退回未登录。',
        stat: () => (this.jar.load().length ? `${this.jar.load().length} 个` : '空'),
        clear: () => { this.qr.logout(); this.identity = { isLogin: false }; return '已清除'; },
      }],
    };
  }

  private async invoke(panel: string, method: string): Promise<unknown> {
    if (panel === 'auth') {
      if (method === 'state') {
        const s = this.qr.current;
        return { status: s.status, detail: s.detail ?? null, startedAt: s.startedAt ?? null, uname: this.identity.uname ?? null, isLogin: this.identity.isLogin, expiresAt: this.jar.expiresAt()?.toISOString() ?? null };
      }
      if (method === 'start') { const op = this.beginOperation(); op.checked(await op.wait(() => this.qr.start())); return { ok: true }; }
      if (method === 'logout') { this.beginOperation(); this.qr.logout(); this.identity = { isLogin: false }; return { ok: true }; }
      if (method === 'refresh') { const op = this.beginOperation(); op.checked(await op.wait(() => this.refreshIdentity())); return { isLogin: this.identity.isLogin, uname: this.identity.uname ?? null }; }
      if (method === 'qr') {
        const text = this.qr.current.qrText;
        if (!text) throw new Error('没有待扫的二维码');
        const png = await QRCode.toBuffer(text, { type: 'png', width: 320, margin: 1 });
        return { $binary: { mime: 'image/png', base64: png.toString('base64') } };
      }
    }
    if (panel === 'player') {
      if (method === 'state') {
        return { mode: this.mode, state: this.stateLine(), url: this.browser.url(), video: this.video ? { title: this.video.title, owner: this.video.owner, duration: this.video.duration, bvid: this.video.bvid } : null, playback: this.lastPlayback, samples: this.samples.length, danmaku: this.danmaku.size, subtitle: this.subtitleLabel || null, scenes: this.sceneCount, lastMontageAt: this.lastMontage?.at ?? null, lastMontageCells: this.lastMontage?.cells ?? 0 };
      }
      if (method === 'montage') {
        if (!this.lastMontage) throw new Error('还没有观察帧');
        return { $binary: { mime: 'image/jpeg', base64: this.lastMontage.jpeg.toString('base64') } };
      }
      if (method === 'browser-open') return { message: await this.openBrowser('operator', this.beginOperation()) };
      if (method === 'browser-close') return { message: await this.closeBrowser('operator', this.beginOperation()) };
    }
    throw new Error(`未知方法 ${panel}/${method}`);
  }
}

function listText(list: readonly ListEntry[]): string {
  return list.map((e) => `${e.n}. ${e.text} [${e.bvid}]`).join('\n');
}

/** mm:ss, or h:mm:ss past an hour. */
export function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

