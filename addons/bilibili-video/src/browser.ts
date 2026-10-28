/**
 * The browser window the audience sees: one Chrome or Edge driven over the DevTools protocol,
 * launched here with its own profile (or attached through `browser.cdpUrl`), signed in by the
 * cookies in the jar, kept on bilibili. The World reads the page the way a viewer sees it: the
 * video element for frames, the page's own danmaku and subtitle responses, the DOM for lists.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, lstat, realpath, readdir, rm, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve, dirname, basename, posix, win32 } from 'node:path';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import puppeteer, { type Browser, type CDPSession, type Page } from 'puppeteer-core';
import type { Logger } from 'cortico/core/types.ts';
import type { BilibiliVideoConfigSection } from './config.ts';
import type { CookieJar } from './login.ts';
import { decodeDanmakuSegment, parseSubtitle, type Danmaku, type SubtitleLine } from './danmaku.ts';

const NAV_TIMEOUT_MS = 30_000;
/** How long after a World goto main-frame navigations still count as the World's. */
const OWN_NAV_WINDOW_MS = 6000;
const EVAL_TIMEOUT_MS = 10_000;
/** How much of a spawned browser's stderr the log keeps. */
const STDERR_TAIL = 4096;
/** How long a spawned browser gets to open its DevTools endpoint. */
const LAUNCH_TIMEOUT_MS = 20_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** The call cannot be carried out for a reason the model should read. */
export class BrowserRefusal extends Error {}

export interface VideoInfo {
  bvid: string;
  aid: number;
  cid: number;
  title: string;
  owner: string;
  /** Seconds, the current part. */
  duration: number;
  /** 1-based current part. */
  p: number;
  parts: Array<{ p: number; title: string; duration: number }>;
  desc: string;
  views: number;
  /** Chapters the uploader marked, seconds. */
  chapters: Array<{ from: number; to: number; title: string }>;
}

export interface Playback {
  t: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  /** 0–4 as `HTMLMediaElement.readyState`. */
  readyState: number;
  /** End of the buffered range that holds the current time, seconds; 0 when none. */
  bufferedEnd: number;
  width: number;
  height: number;
  webFullscreen: boolean;
  /** The player's quality label as shown in its control bar, empty when unreadable. */
  quality: string;
}

export interface Sample {
  t: number;
  jpeg: string;
  /** 64×36 luma of the cropped picture. */
  gray: number[];
  /** Cell size the JPEG was drawn at: the long and short sides turned to the picture's orientation. */
  w: number;
  h: number;
  /** Picture region of the video frame after black bars were cut, video pixels. */
  crop: { x: number; y: number; w: number; h: number };
}

export interface ListEntry {
  n: number;
  bvid: string;
  url: string;
  text: string;
}

export interface SubtitleTrack {
  lan: string;
  label: string;
  url: string;
}

/** Programmatic test overrides; no new deployment configuration or browser download. */
export interface BrowserLaunchOverrides {
  candidates?: (explicit: string) => Promise<string[]>;
  /** Windows integrity RID of the host's inherited token; null means unknown. */
  integrityRid?: () => Promise<number | null>;
  spawn?: (file: string, args: string[]) => ChildProcess;
  connect?: (options: { browserWSEndpoint: string; defaultViewport: null }) => Promise<Browser>;
  fetch?: typeof fetch;
  kill?: (proc: ChildProcess) => Promise<void>;
  timeoutMs?: number;
  exitGraceMs?: number;
  pollMs?: number;
}

export interface VideoBrowserOptions {
  cfg: BilibiliVideoConfigSection;
  dataDir: string;
  jar: CookieJar;
  log: () => Logger | null;
  /** The main frame navigated; `byWorld` is true when a World tool asked for it. */
  onNavigated: (url: string, byWorld: boolean) => void;
  /** The browser went away without `stop()`: window closed by hand, process gone. */
  onLost: () => void;
  onDanmaku: (list: Danmaku[]) => void;
  onSubtitleTracks: (cid: number, tracks: SubtitleTrack[]) => void;
  launch?: BrowserLaunchOverrides;
}

interface ContentResponse {
  url: string;
  generation: number;
  cid: number;
  received: boolean;
}

/** Only the player's own API responses are candidates for video content. */
function contentRequest(url: string): { cid: number; player: boolean } | null {
  try {
    const u = new URL(url);
    if (u.hostname !== 'api.bilibili.com') return null;
    const player = /^\/x\/player\/(?:wbi\/)?v2$/.test(u.pathname);
    if (!player && u.pathname !== '/x/v2/dm/web/seg.so') return null;
    const cid = Number(u.searchParams.get(player ? 'cid' : 'oid'));
    return Number.isSafeInteger(cid) && cid > 0 ? { cid, player } : null;
  } catch { return null; }
}

export class VideoBrowser {
  private browser: Browser | null = null;
  private session: BrowserSession | null = null;
  private startController: AbortController | null = null;
  private stopping: Promise<void> | null = null;
  private releasing: Promise<void> | null = null;
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private starting: Promise<Page> | null = null;
  /** Main-frame navigations before this instant were asked for by a World tool. */
  private ownNavUntil = 0;
  private lastNavUrl = '';
  private lastNavAt = 0;
  /** cid of the latest player-info response the page received (subtitle list comes with it). */
  playerInfoCid = 0;
  private contentGeneration = 0;
  private contentCid = 0;
  private readonly pendingBodies = new Map<string, ContentResponse>();

  constructor(private readonly opts: VideoBrowserOptions) {}

  private get cfg() { return this.opts.cfg.browser; }

  get connected(): boolean { return this.browser?.connected === true; }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.invalidateContent();
    this.startController?.abort();
    this.stopping = this.stopNow().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  private async stopNow(): Promise<void> {
    await this.starting?.catch(() => {});
    const session = this.session;
    this.browser = null; this.page = null; this.cdp = null; this.session = null;
    this.startController = null;
    this.pendingBodies.clear();
    if (session) await this.release(session);
    await this.releasing;
  }

  /** The page, launching or attaching the browser on first use. */
  async ensure(): Promise<Page> {
    if (this.stopping) { await this.stopping; return this.ensure(); }
    if (this.releasing) { await this.releasing; return this.ensure(); }
    if (this.page && !this.page.isClosed() && this.browser?.connected) return this.page;
    if (!this.starting) {
      this.startController?.abort();
      const controller = new AbortController();
      this.startController = controller;
      this.starting = this.open(controller.signal).finally(() => {
        if (this.startController === controller && !this.browser?.connected) this.startController = null;
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async open(signal: AbortSignal): Promise<Page> {
    const until = Date.now() + Math.max(50, this.opts.launch?.timeoutMs ?? LAUNCH_TIMEOUT_MS);
    let session: BrowserSession | null = this.session;
    try {
      session ??= await this.launchBrowser(signal, until);
      const browser = session.browser;
      const pages = await interruptible(browser.pages(), signal, Math.min(5000, remaining(until)));
      // An attached browser is user-owned: create one plugin page, preserve every existing tab.
      const page = session === this.session || !session.owned
        ? await interruptible(browser.newPage(), signal, Math.min(5000, remaining(until)), p => p.close().catch(() => {}))
        : pages.find(p => !p.url().startsWith('devtools://') && !p.isClosed()) ?? await interruptible(browser.newPage(), signal, Math.min(5000, remaining(until)));
      session.page = page;
      await interruptible(page.setUserAgent(UA).catch(() => {}), signal, Math.min(5000, remaining(until)));
      const cdp = await this.attach(page, signal, until);
      checkCanceled(signal);
      if (Date.now() >= until) { await bounded(cdp.detach(), 500).catch(() => {}); throw new BrowserRefusal('浏览器启动总预算已用尽'); }
      this.browser = browser; this.page = page; this.session = session; this.cdp = cdp;
      browser.once('disconnected', () => {
        if (this.session !== session) return;
        this.startController?.abort(); this.startController = null;
        this.browser = null; this.page = null; this.cdp = null; this.session = null;
        this.invalidateContent();
        this.opts.log()?.warn('bilibili-video browser disconnected');
        this.releasing = this.release(session!).finally(() => { this.releasing = null; });
        this.opts.onLost();
      });
      return page;
    } catch (error) {
      if (session) await this.release(session);
      this.browser = null; this.page = null; this.cdp = null; this.session = null;
      if (signal.aborted) throw new BrowserRefusal('浏览器启动已取消');
      throw error instanceof BrowserRefusal ? error : new BrowserRefusal('浏览器页面初始化失败：' + safeDiagnostic(errorText(error)));
    }
  }

  private async release(session: BrowserSession): Promise<void> {
    session.disposing ??= (async () => {
      if (session.owned) await bounded(session.browser.close(), 2500).catch(() => {});
      else {
        await bounded(session.page?.close().catch(() => {}) ?? Promise.resolve(), 1500).catch(() => {});
        await bounded(session.browser.disconnect(), 1500).catch(() => {});
      }
      const ended = await this.cleanProcess(session.proc, session.profile);
      if (session.profile && ended) await deleteManagedProfile(session.profile, this.opts.log());
    })();
    return session.disposing;
  }

  private async cleanProcess(proc: ChildProcess | null, profile?: ManagedProfile): Promise<boolean> {
    try {
      if (proc && this.opts.launch?.kill) { await bounded(this.opts.launch.kill(proc), 3000); return true; }
      if (!proc) return true;
      const ownedPath = profile && await validManagedProfile(profile) ? profile.path : undefined;
      return await bounded(terminateOwnedBrowser(proc, ownedPath), 6000);
    } catch { this.opts.log()?.warn('bilibili-video process exit could not be confirmed; profile retained'); return false; }
  }

  private async connectEndpoint(endpoint: DevtoolsEndpoint, signal: AbortSignal, timeout: number, owned: boolean): Promise<Browser> {
    const until = Date.now() + timeout;
    const connect = this.opts.launch?.connect ?? (options => puppeteer.connect(options));
    const browser = await interruptible(connect({ browserWSEndpoint: endpoint.ws, defaultViewport: null }), signal, timeout,
      b => (owned ? b.close() : b.disconnect()).catch(() => {}));
    try {
      await interruptible(browser.version(), signal, Math.min(timeout, 3000));
      return browser;
    } catch (error) { await bounded(owned ? browser.close() : browser.disconnect(), Math.min(1000, remaining(until))).catch(() => {}); throw error; }
  }

  private async launchBrowser(signal: AbortSignal, until: number): Promise<BrowserSession> {
    const runtime = this.opts.launch;
    const fetcher = runtime?.fetch ?? fetch;
    if (this.cfg.cdpUrl.trim()) {
      const diagnostic: EndpointDiagnostic = {};
      try {
        const endpoint = await probeDevtools(this.cfg.cdpUrl.trim(), fetcher, signal, until, undefined, diagnostic);
        diagnostic.stage = 'cdp-connect';
        const browser = await this.connectEndpoint(endpoint, signal, remaining(until), false);
        this.opts.log()?.info('bilibili-video attached to configured CDP', { browser: endpoint.product, port: new URL(endpoint.ws).port });
        return { browser, owned: false, proc: null };
      } catch (error) {
        if (signal.aborted) throw error;
        diagnostic.endpointError = diagnosticError(error);
        this.opts.log()?.warn('bilibili-video configured CDP check failed', diagnostic);
        throw new BrowserRefusal('接管调试地址失败（' + (diagnostic.stage ?? 'endpoint-address') + '）：' + diagnostic.endpointError +
          '；请确认浏览器调试端口、cdpUrl 和远程调试策略。若 WebSocket 返回 403，请检查 --remote-allow-origins 设置；不会另行启动浏览器。');
      }
    }
    const explicitProfile = this.cfg.profileDir.trim();
    let profilePath = '';
    if (explicitProfile) {
      profilePath = resolve(explicitProfile);
      if (isDailyBrowserProfile(profilePath)) throw new BrowserRefusal('请为插件指定独立浏览器资料目录，不能使用日常浏览器的默认资料目录。');
      try { profilePath = await realpath(profilePath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (isDailyBrowserProfile(profilePath)) throw new BrowserRefusal('指定目录实际指向日常浏览器资料目录，请换一个独立目录。');
      const existing = await readDevtoolsPort(profilePath);
      if (existing) {
        try {
          const endpoint = await probeDevtools(existing.url, fetcher, signal, until, existing);
          const browser = await this.connectEndpoint(endpoint, signal, remaining(until), false);
          this.opts.log()?.info('bilibili-video reused configured profile', { profile: profilePath, port: existing.port, browser: endpoint.product });
          return { browser, owned: false, proc: null };
        } catch (error) { if (signal.aborted) throw error; }
      }
    }
    // A configured live endpoint remains usable from a Low host. Only creating a
    // new browser is refused, before any profile directory or stale DAP is changed.
    if (WINDOWS) {
      const query = Promise.resolve().then(() => {
        checkCanceled(signal);
        return (runtime?.integrityRid ?? windowsHostIntegrityRid)();
      }).catch(() => null);
      const rid = await interruptible(bounded(query, HOST_INTEGRITY_TIMEOUT_MS).catch(() => null), signal, remaining(until));
      checkCanceled(signal);
      if (Date.now() >= until) throw new BrowserRefusal('浏览器启动总预算已用尽');
      if (rid !== null && Number.isInteger(rid) && rid >= 0 && rid < 8192) {
        throw new BrowserRefusal('宿主处于低完整性，无法可靠启动浏览器。请把 Coo 程序安装到普通目录，不要改整个工作区的安全标签；桌面 helper + cdpUrl 可临时接管：从桌面运行 scripts/start-browser.ps1，再填写 browser.cdpUrl。');
      }
    }
    if (explicitProfile) {
      await mkdir(profilePath, { recursive: true });
      profilePath = await realpath(profilePath);
      if (isDailyBrowserProfile(profilePath)) throw new BrowserRefusal('指定目录实际指向日常浏览器资料目录，请换一个独立目录。');
      const occupied = await interruptible(profileProcessIds(profilePath), signal, remaining(until));
      if (occupied === null || occupied.length) throw new BrowserRefusal('指定浏览器资料目录可能正被另一个 Edge/Chrome 占用，调试端口不可用；请关闭该专用窗口或改用 cdpUrl 接管。显式目录不会被删除或偷偷更换。');
      await unlink(join(profilePath, 'DevToolsActivePort')).catch(() => {});
    }
    const candidates = await interruptible((runtime?.candidates ?? discoverBrowserCandidates)(this.cfg.executableFile.trim()), signal, remaining(until));
    if (!candidates.length) throw new BrowserRefusal('没找到可启动的 Chrome/Edge；请安装系统浏览器或填写 browser.executableFile。');
    const attempts: LaunchDiagnostic[] = [];
    let pinnedCandidate: string | undefined;
    for (let round = 0; round < 2; round++) {
      for (const file of candidates) {
        checkCanceled(signal);
        if (Date.now() >= until) break;
        // A persistent explicit profile is never tried with a second browser product after spawning.
        if (pinnedCandidate && file !== pinnedCandidate) continue;
        const profile = explicitProfile ? undefined : await createManagedProfile(this.opts.dataDir);
        const selectedProfile = profile?.path ?? profilePath;
        let proc: ChildProcess | null = null;
        let browser: Browser | null = null;
        const state: LaunchState = { exited: false, code: null, signal: null, exitedAt: 0, stderr: '', truncated: false, discardLine: false };
        const args = browserArguments(this.cfg, selectedProfile);
        const started = Date.now();
        const diagnostic: LaunchDiagnostic = { file, args, profile: selectedProfile, uniqueProfile: Boolean(profile), attempt: attempts.length + 1, round: round + 1 };
        const diagnosticNow = () => ({ ...diagnostic, pid: proc?.pid, exitCode: state.code, signal: state.signal,
          aliveMs: Date.now() - started, stderr: safeDiagnostic(state.stderr) || '(no stderr)' });
        try {
          this.opts.log()?.info('bilibili-video browser launch', { ...diagnostic, candidates });
          proc = runtime?.spawn ? runtime.spawn(file, args) : spawn(file, args, { windowsHide: false, detached: false, stdio: ['ignore', 'ignore', 'pipe'] });
          if (explicitProfile && proc.pid) pinnedCandidate = file;
          if (proc.exitCode !== null || proc.signalCode !== null) {
            state.exited = true; state.code = proc.exitCode; state.signal = proc.signalCode; state.exitedAt = Date.now();
          }
          proc.once('error', error => { state.error = error; });
          proc.once('exit', (code, exitSignal) => {
            state.exited = true; state.code = code; state.signal = exitSignal; state.exitedAt = Date.now();
            this.opts.log()?.info('bilibili-video browser launcher exited; CDP decides readiness', diagnosticNow());
          });
          proc.stderr?.setEncoding('utf8').on('data', (chunk: string) => appendStderr(state, chunk));
          const attemptUntil = Math.min(until, Date.now() + 8000);
          const endpoint = await waitForProfileEndpoint(selectedProfile, state, fetcher, signal, attemptUntil,
            runtime?.exitGraceMs ?? 1200, runtime?.pollMs ?? 100, diagnostic);
          diagnostic.port = endpoint.port; diagnostic.wsPath = new URL(endpoint.ws).pathname;
          diagnostic.stage = 'cdp-connect';
          browser = await this.connectEndpoint(endpoint, signal, remaining(attemptUntil), true);
          diagnostic.stage = 'ready';
          this.opts.log()?.info('bilibili-video browser CDP connected', { ...diagnosticNow(), browser: endpoint.product, version: await interruptible(browser.version(), signal, remaining(until)) });
          return { browser, owned: true, proc, profile };
        } catch (error) {
          if (browser) await bounded(browser.close(), 2000).catch(() => {});
          if (diagnostic.stage === 'cdp-connect') diagnostic.endpointError = diagnosticError(error);
          const detail = { ...diagnosticNow(), reason: signal.aborted ? '启动已取消' : launchFailure(error, state) };
          attempts.push(detail);
          this.opts.log()?.warn('bilibili-video browser launch attempt failed', detail);
          const ended = await this.cleanProcess(proc, profile);
          if (profile && ended) await deleteManagedProfile(profile, this.opts.log());
          if (signal.aborted) throw new BrowserRefusal('浏览器启动已取消');
          if (explicitProfile && proc?.pid) break;
        }
      }
      if (Date.now() >= until || explicitProfile) break;
    }
    const last = attempts.at(-1);
    const first = attempts[0];
    throw new BrowserRefusal('浏览器没起来：' + (last?.reason ?? '调试端口未出现') +
      '；已尝试 ' + attempts.length + ' 次' + (attempts.length > 1 ? '，默认目录每次使用新 profile' : '') +
      (first && first !== last && first.reason !== last?.reason ? '。首次原因：' + first.reason : '') +
      '。请检查程序路径/浏览器策略；若宿主内自启动始终未就绪，请从桌面运行 scripts/start-browser.ps1 生成独立浏览器，把它输出的 cdpUrl 填入 browser.cdpUrl。');
  }

  private async attach(page: Page, signal: AbortSignal, until: number): Promise<CDPSession> {
    this.invalidateContent();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.on('dialog', (d) => { void (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {}); });
    page.on('framenavigated', (frame) => {
      if (signal.aborted) return;
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      // Even a same-URL reload invalidates response bodies still being read.
      this.invalidateContent();
      // a goto fires several main-frame navigations (redirects, the page's own history writes);
      // everything inside the window after the World's goto is the World's
      const byWorld = Date.now() < this.ownNavUntil;
      if (url === this.lastNavUrl && Date.now() - this.lastNavAt < 10_000) return;
      this.lastNavUrl = url;
      this.lastNavAt = Date.now();
      this.opts.onNavigated(url, byWorld);
    });
    const cdp = await interruptible(page.createCDPSession(), signal, Math.min(5000, remaining(until)), c => c.detach().catch(() => {}));
    try {
    await interruptible(cdp.send('Network.enable'), signal, Math.min(5000, remaining(until)));
    checkCanceled(signal);
    await interruptible(this.injectCookies(cdp), signal, Math.min(5000, remaining(until)));
    checkCanceled(signal);
    const upos = this.cfg.uposHost.trim();
    if (upos) {
      // media segments are fetched from upos-*.bilivideo.com; redirect them to the configured mirror
      await interruptible(cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*://upos-*.bilivideo.com/*', requestStage: 'Request' }] }), signal, Math.min(5000, remaining(until)));
      checkCanceled(signal);
      cdp.on('Fetch.requestPaused', (e) => {
        if (signal.aborted) return;
        let url = e.request.url;
        try { const u = new URL(url); u.host = upos; url = u.toString(); } catch { /* leave as is */ }
        void cdp.send('Fetch.continueRequest', { requestId: e.requestId, url }).catch(() => {});
      });
    }
    cdp.on('Network.requestWillBeSent', (e) => {
      if (signal.aborted) return;
      const url = e.request.url;
      const content = contentRequest(url);
      if (!content) return;
      if (content.player) this.selectContentCid(content.cid);
      // Record the generation at request time: an old response may arrive after navigation.
      this.pendingBodies.set(e.requestId, { url, cid: content.cid, generation: this.contentGeneration, received: false });
    });
    cdp.on('Network.responseReceived', (e) => {
      if (signal.aborted) return;
      const pending = this.pendingBodies.get(e.requestId);
      const url = e.response.url;
      if (!pending || pending.url !== url || !this.isCurrentContent(pending)) return;
      pending.received = true;
    });
    cdp.on('Network.loadingFailed', (e) => { this.pendingBodies.delete(e.requestId); });
    cdp.on('Network.loadingFinished', (e) => {
      if (signal.aborted) return;
      const pending = this.pendingBodies.get(e.requestId);
      this.pendingBodies.delete(e.requestId);
      if (!pending?.received || !this.isCurrentContent(pending)) return;
      void cdp.send('Network.getResponseBody', { requestId: e.requestId }).then((r) => {
        if (!signal.aborted && this.isCurrentContent(pending)) this.onBody(pending.url, r.body, r.base64Encoded);
      }).catch(() => {});
    });
    checkCanceled(signal);
    return cdp;
    } catch (error) { await bounded(cdp.detach(), 1000).catch(() => {}); throw error; }
  }

  private invalidateContent(): void {
    this.contentGeneration++;
    this.contentCid = 0;
    this.playerInfoCid = 0;
    this.pendingBodies.clear();
  }

  private selectContentCid(cid: number): void {
    if (this.contentCid && this.contentCid !== cid) this.invalidateContent();
    this.contentCid = cid;
  }

  private isCurrentContent(pending: ContentResponse): boolean {
    return pending.generation === this.contentGeneration && (!this.contentCid || pending.cid === this.contentCid);
  }

  private onBody(url: string, body: string, b64: boolean): void {
    if (/seg\.so/.test(url)) {
      if (!b64) return;
      const list = decodeDanmakuSegment(Buffer.from(body, 'base64'));
      if (list.length) this.opts.onDanmaku(list);
      return;
    }
    try {
      const j = JSON.parse(b64 ? Buffer.from(body, 'base64').toString('utf8') : body) as { data?: { subtitle?: { subtitles?: Array<{ lan?: string; lan_doc?: string; subtitle_url?: string }> } } };
      const cid = Number(new URL(url).searchParams.get('cid') ?? 0);
      this.playerInfoCid = cid;
      const tracks = (j.data?.subtitle?.subtitles ?? []).filter((s) => s.subtitle_url).map((s) => ({ lan: s.lan ?? '', label: s.lan_doc ?? s.lan ?? '', url: s.subtitle_url!.startsWith('//') ? `https:${s.subtitle_url}` : s.subtitle_url! }));
      this.opts.onSubtitleTracks(cid, tracks);
    } catch { /* not the shape we read */ }
  }

  /** Writes the jar into the browser; called on attach and again before each navigation the World makes. */
  private async injectCookies(cdp: CDPSession): Promise<void> {
    const cookies = this.opts.jar.load();
    if (!cookies.length) return;
    await cdp.send('Network.setCookies', {
      cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, ...(c.expires ? { expires: c.expires } : {}) })),
    });
  }

  /* ---------- navigation ---------- */

  async goto(url: string): Promise<void> {
    const page = await this.ensure();
    this.invalidateContent();
    if (this.cdp) await this.injectCookies(this.cdp).catch(() => {});
    this.ownNavUntil = Date.now() + OWN_NAV_WINDOW_MS;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      throw new BrowserRefusal(`打不开 ${url}:${(err as Error).message}`);
    }
    this.ownNavUntil = Date.now() + OWN_NAV_WINDOW_MS;
  }

  /** Runs a page function with a deadline; a page that stops answering fails the call instead of hanging it. */
  private async withDeadline<T>(p: Promise<T>, what: string, ms = EVAL_TIMEOUT_MS): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new BrowserRefusal(`${what}:页面 ${ms / 1000} 秒没有应答`)), ms); });
    try { return await Promise.race([p, deadline]); } finally { if (timer) clearTimeout(timer); }
  }

  url(): string { return this.page?.url() ?? ''; }

  /** Who the page thinks is signed in, from the page's own nav call. */
  async identity(): Promise<{ isLogin: boolean; uname?: string }> {
    const page = await this.ensure();
    return page.evaluate(async () => {
      const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
      const j = await r.json();
      return { isLogin: j?.data?.isLogin === true, uname: j?.data?.uname };
    }).catch(() => ({ isLogin: false }));
  }

  /* ---------- the video page ---------- */

  /** Waits for the player's video element after a navigation. */
  async waitForVideo(ms = 15_000): Promise<boolean> {
    const page = await this.ensure();
    return page.waitForSelector('video', { timeout: ms }).then(() => true).catch(() => false);
  }

  async videoInfo(): Promise<VideoInfo | null> {
    const page = await this.ensure();
    const generation = this.contentGeneration;
    const info = await page.evaluate(() => {
      const st = (window as unknown as { __INITIAL_STATE__?: Record<string, unknown> }).__INITIAL_STATE__;
      const v = st?.videoData as Record<string, unknown> | undefined;
      if (!v || typeof v.bvid !== 'string') return null;
      const p = Number(st?.p ?? 1) || 1;
      const pages = Array.isArray(v.pages) ? (v.pages as Array<Record<string, unknown>>) : [];
      const current = pages.find((x) => Number(x.page) === p) ?? pages[0];
      const owner = v.owner as Record<string, unknown> | undefined;
      const stat = v.stat as Record<string, unknown> | undefined;
      const chapters = Array.isArray(st?.viewPoints) ? (st!.viewPoints as Array<Record<string, unknown>>) : [];
      return {
        bvid: v.bvid as string,
        aid: Number(v.aid ?? 0),
        cid: Number(current?.cid ?? v.cid ?? 0),
        title: String(v.title ?? ''),
        owner: String(owner?.name ?? ''),
        duration: Number(current?.duration ?? v.duration ?? 0),
        p,
        parts: pages.map((x) => ({ p: Number(x.page), title: String(x.part ?? ''), duration: Number(x.duration ?? 0) })),
        desc: String(v.desc ?? ''),
        views: Number(stat?.view ?? 0),
        chapters: chapters.map((c) => ({ from: Number(c.from ?? 0), to: Number(c.to ?? 0), title: String(c.content ?? '') })),
      } satisfies VideoInfo;
    });
    if (generation !== this.contentGeneration || page !== this.page) return null;
    if (info && Number.isSafeInteger(info.cid) && info.cid > 0) this.selectContentCid(info.cid);
    return info;
  }

  async playback(): Promise<Playback | null> {
    const page = this.page;
    if (!page || page.isClosed()) return null;
    return page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      const container = document.querySelector('.bpx-player-container');
      let bufferedEnd = 0;
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= v.currentTime + 0.5 && v.buffered.end(i) >= v.currentTime - 0.5) bufferedEnd = v.buffered.end(i);
      }
      const quality = (document.querySelector('.bpx-player-ctrl-quality-result') as HTMLElement | null)?.innerText?.trim() ?? '';
      return { t: v.currentTime, duration: v.duration || 0, paused: v.paused, ended: v.ended, readyState: v.readyState, bufferedEnd, width: v.videoWidth, height: v.videoHeight, webFullscreen: container?.getAttribute('data-screen') === 'web', quality };
    }).catch(() => null);
  }

  /** The player's quality menu: labels in menu order, the active one marked. */
  async qualityOptions(): Promise<Array<{ label: string; active: boolean }>> {
    const page = await this.ensure();
    return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.bpx-player-ctrl-quality-menu-item')).map((el) => ({ label: el.innerText.replace(/\s+/g, ' ').trim(), active: el.classList.contains('bpx-state-active') })));
  }

  /** Clicks the quality menu item whose label contains `want` (the audience sees the menu flash); false when there is none. */
  async setQuality(want: string): Promise<boolean> {
    const page = await this.ensure();
    return this.withDeadline(page.evaluate((w) => {
      const items = Array.from(document.querySelectorAll<HTMLElement>('.bpx-player-ctrl-quality-menu-item'));
      const hit = items.find((el) => el.innerText.replace(/\s+/g, '').includes(w.replace(/\s+/g, '')));
      if (!hit) return false;
      hit.click();
      return true;
    }, want), '切换画质');
  }

  async setWebFullscreen(on: boolean): Promise<void> {
    const page = await this.ensure();
    const now = (await this.playback())?.webFullscreen ?? false;
    if (now === on) return;
    await this.withDeadline(page.evaluate(() => { (document.querySelector('.bpx-player-ctrl-web') as HTMLElement | null)?.click(); }), '网页全屏');
  }

  /** Starts playback; the play() promise is not awaited, the poll sees whether frames arrive. */
  async play(fromSec?: number): Promise<void> {
    const page = await this.ensure();
    await this.withDeadline(page.evaluate((from) => {
      const v = document.querySelector('video');
      if (!v) throw new Error('页面上没有播放器');
      if (typeof from === 'number') v.currentTime = from;
      void v.play().catch(() => {});
    }, fromSec), '播放');
  }

  async pause(): Promise<void> {
    const page = await this.ensure();
    await this.withDeadline(page.evaluate(() => { document.querySelector('video')?.pause(); }), '暂停');
  }

  async seek(sec: number): Promise<void> {
    const page = await this.ensure();
    await this.withDeadline(page.evaluate((s) => { const v = document.querySelector('video'); if (v) v.currentTime = s; }, sec), '跳转');
  }

  /**
   * One frame of the video as a cell-sized JPEG plus a 64×36 luma map; null when the player is
   * not ready. Black bars (pillarbox or letterbox baked into the stream) are cut: a 96×54 probe
   * finds the columns and rows whose brightest pixel stays black, and the crop is the union of
   * the last four probes, so a dark scene does not shrink it and bars must hold ~2 s to do so.
   * The cell takes the picture's orientation: `cellLong`×`cellShort` for landscape, turned for portrait.
   */
  async sample(cellLong: number, cellShort: number, quality: number): Promise<Sample | null> {
    const page = this.page;
    if (!page || page.isClosed()) return null;
    return page.evaluate(`(${SAMPLE_FRAME})(${cellLong}, ${cellShort}, ${quality})`).catch(() => null) as Promise<Sample | null>;
  }

  /** The current frame at up to `maxW`×`maxH`, inside the detected crop, optionally a region of it in 0–1 fractions. */
  async frame(maxW: number, maxH: number, quality: number, region?: { x: number; y: number; width: number; height: number }): Promise<{ jpeg: string; width: number; height: number; t: number } | null> {
    const page = this.page;
    if (!page || page.isClosed()) return null;
    return page.evaluate(`(${LOOK_FRAME})(${maxW}, ${maxH}, ${quality}, ${JSON.stringify(region ?? null)})`).catch(() => null) as Promise<{ jpeg: string; width: number; height: number; t: number } | null>;
  }

  /** Lays cell JPEGs into a row-major grid and returns the grid JPEG. */
  async montage(cells: readonly string[], cols: number, rows: number, cellW: number, cellH: number, quality: number): Promise<string | null> {
    const page = this.page;
    if (!page || page.isClosed()) return null;
    return page.evaluate(async (jpegs, nc, nr, w, h, q) => {
      const c = document.createElement('canvas');
      c.width = nc * w; c.height = nr * h;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, c.width, c.height);
      await Promise.all(jpegs.map((src, i) => new Promise<void>((res) => {
        const im = new Image();
        im.onload = () => { ctx.drawImage(im, (i % nc) * w, Math.floor(i / nc) * h, w, h); res(); };
        im.onerror = () => res();
        im.src = `data:image/jpeg;base64,${src}`;
      })));
      return c.toDataURL('image/jpeg', q).split(',')[1] ?? '';
    }, [...cells], cols, rows, cellW, cellH, quality).catch(() => null);
  }

  async fetchSubtitle(url: string): Promise<SubtitleLine[]> {
    const page = await this.ensure();
    const generation = this.contentGeneration;
    // the subtitle CDN answers with a wildcard CORS origin, which a credentialed fetch rejects
    const json = await page.evaluate(async (u) => {
      for (const credentials of ['omit', 'include'] as const) {
        try {
          const r = await fetch(u, { credentials });
          if (r.ok) return await r.json();
        } catch { /* try the other mode */ }
      }
      return null;
    }, url).catch(() => null);
    return generation === this.contentGeneration && page === this.page ? parseSubtitle(json) : [];
  }

  /* ---------- the page as the audience sees it ---------- */

  async screenshot(quality: number): Promise<{ jpeg: Uint8Array; title: string; url: string }> {
    const page = await this.ensure();
    const jpeg = await page.screenshot({ type: 'jpeg', quality: Math.round(quality * 100), optimizeForSpeed: true });
    return { jpeg, title: await page.title().catch(() => ''), url: page.url() };
  }

  async scrollScreens(n: number): Promise<{ y: number; height: number }> {
    const page = await this.ensure();
    return page.evaluate((k) => {
      window.scrollBy({ top: k * window.innerHeight * 0.8, behavior: 'smooth' });
      return { y: Math.round(window.scrollY), height: Math.round(document.documentElement.scrollHeight) };
    }, n);
  }

  /** Video cards on the current page: every `/video/BV…` link, one entry per video, in page order. */
  async listVideos(opts: { within?: string; exclude?: string; max: number }): Promise<ListEntry[]> {
    const page = await this.ensure();
    return page.evaluate((within, exclude, max) => {
      const scope = (within && document.querySelector(within)) || document.body;
      const seen = new Set<string>();
      const out: Array<{ n: number; bvid: string; url: string; text: string }> = [];
      for (const a of Array.from(scope.querySelectorAll<HTMLAnchorElement>('a[href*="/video/BV"]'))) {
        const m = a.href.match(/\/video\/(BV[0-9A-Za-z]{10})/);
        if (!m || seen.has(m[1]) || m[1] === exclude) continue;
        const card = (a.closest('[class*="card"], li, .video-page-card-small, .bili-video-card') as HTMLElement | null) ?? a;
        const text = (card.innerText || a.title || a.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        seen.add(m[1]);
        out.push({ n: out.length + 1, bvid: m[1], url: `https://www.bilibili.com/video/${m[1]}`, text: text.slice(0, 160) });
        if (out.length >= max) break;
      }
      return out;
    }, opts.within ?? '', opts.exclude ?? '', opts.max);
  }

  /** Scrolls the card for `bvid` into view so the audience sees what is about to open. */
  async revealVideo(bvid: string): Promise<boolean> {
    const page = await this.ensure();
    const shown = await page.evaluate((id) => {
      const a = document.querySelector<HTMLAnchorElement>(`a[href*="/video/${id}"]`);
      if (!a) return false;
      (a.closest('[class*="card"], li') ?? a).scrollIntoView({ behavior: 'smooth', block: 'center' });
      return true;
    }, bvid);
    if (shown) await new Promise((r) => setTimeout(r, 900));
    return shown;
  }

  /** Scrolls to the comment section and reads loaded comments through the component's shadow roots. */
  async readComments(count: number): Promise<Array<{ user: string; likes: string; text: string }>> {
    const page = await this.ensure();
    await page.evaluate(() => { (document.querySelector('#comment, bili-comments, #commentapp') as HTMLElement | null)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    // the component loads once it is in view; poll for it instead of guessing a delay
    // (a string, not a function: the TS loader wraps inner functions in helpers the page does not have)
    let out: Array<{ user: string; likes: string; text: string }> = [];
    for (let i = 0; i < 15 && !out.length; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      // the section loads on an intersection observer; keep nudging the scroll so it fires
      await page.evaluate(() => { (document.querySelector('#comment, bili-comments, #commentapp') as HTMLElement | null)?.scrollIntoView({ block: 'start' }); window.scrollBy(0, 80); }).catch(() => {});
      out = await page.evaluate(`(${READ_COMMENTS})(${count})`) as typeof out;
    }
    return out;
  }
}

/** Only directories bearing this launcher's ownership marker are managed. */
interface ManagedProfile { root: string; path: string; token: string }
interface BrowserSession {
  browser: Browser; owned: boolean; proc: ChildProcess | null; profile?: ManagedProfile;
  page?: Page; disposing?: Promise<void>;
}
interface LaunchState {
  exited: boolean; code: number | null; signal: NodeJS.Signals | null; exitedAt: number;
  stderr: string; truncated: boolean; discardLine: boolean; error?: Error;
}
interface EndpointDiagnostic {
  stage?: 'endpoint-address' | 'dap-read' | 'http' | 'json' | 'devtools-validation' | 'websocket-validation' | 'http-ready' | 'cdp-connect' | 'ready';
  dapSeen?: boolean; dapReadError?: string; endpointError?: string; port?: number; wsPath?: string;
}
interface LaunchDiagnostic extends EndpointDiagnostic {
  file: string; args: string[]; profile: string; uniqueProfile: boolean; attempt: number; round: number;
  pid?: number; port?: number; wsPath?: string; exitCode?: number | null; signal?: NodeJS.Signals | null;
  aliveMs?: number; stderr?: string; reason?: string;
}
interface ProfileEndpoint { port: number; path: string; url: string }
interface DevtoolsEndpoint { ws: string; product: string; port: number }
const PROFILE_OWNER = 'cortico-world-bilibili-video-alont1:temporary-v1';
const PROFILE_MARKER = '.cortico-browser-owner.json';

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
/** Keep transport errno (including fetch's cause/AggregateError) without dumping arbitrary error objects. */
function diagnosticError(error: unknown): string {
  const details: string[] = [errorText(error)];
  const seen = new Set<unknown>();
  const visit = (value: unknown, label: string, depth: number): void => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 3) return;
    seen.add(value);
    const item = value as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown[] };
    if (typeof item.code === 'string' || typeof item.code === 'number') details.push(label + 'code=' + String(item.code).slice(0, 100));
    if (depth > 0 && typeof item.message === 'string' && item.message !== details[0]) details.push(label + item.message.slice(0, 600));
    visit(item.cause, label + 'cause.', depth + 1);
    if (Array.isArray(item.errors)) for (const nested of item.errors.slice(0, 4)) visit(nested, label + 'errors.', depth + 1);
  };
  visit(error, '', 0);
  return safeDiagnostic(details.join('；'));
}
function safeDiagnostic(value: string): string {
  return value
    .replace(/((?:authorization|proxy-authorization|cookie|set-cookie)\s*["']?\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]')
    .replace(/((?:SESSDATA|bili_jct|DedeUserID|access_token|refresh_token|token|password|csrf|qrcode_key|api_key)\s*["']?\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&;,"'\r\n]+)/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .slice(-STDERR_TAIL);
}
function appendStderr(state: LaunchState, chunk: string): void {
  if (state.discardLine) {
    const newline = chunk.indexOf('\n');
    if (newline < 0) return;
    chunk = chunk.slice(newline + 1); state.discardLine = false;
  }
  const combined = state.stderr + chunk;
  if (combined.length <= STDERR_TAIL * 2) { state.stderr = combined; return; }
  const tail = combined.slice(-STDERR_TAIL * 2);
  const newline = tail.indexOf('\n');
  state.stderr = newline >= 0 ? tail.slice(newline + 1) : '';
  state.discardLine = newline < 0;
  state.truncated = true;
}
function checkCanceled(signal: AbortSignal): void {
  if (signal.aborted) throw new BrowserRefusal('浏览器启动已取消');
}
function remaining(until: number): number { return Math.max(1, until - Date.now()); }
function interruptible<T>(promise: Promise<T>, signal: AbortSignal, timeout: number, onLate?: (value: T) => unknown): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clean = () => { if (timer) clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const fail = (error: Error) => { if (done) return; done = true; clean(); reject(error); };
    const abort = () => fail(new BrowserRefusal('浏览器启动已取消'));
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => fail(new BrowserRefusal('浏览器调试端点连接或初始化超时')), Math.max(1, timeout));
    promise.then(value => {
      if (done) { Promise.resolve(onLate?.(value)).catch(() => {}); return; }
      done = true; clean(); resolvePromise(value);
    }, error => { if (!done) { done = true; clean(); reject(error); } });
    if (signal.aborted) abort();
  });
}
function bounded<T>(promise: Promise<T>, timeout: number): Promise<T> {
  return interruptible(promise, new AbortController().signal, timeout);
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolvePromise(); }, Math.max(1, ms));
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new BrowserRefusal('浏览器启动已取消')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
function browserArguments(cfg: BilibiliVideoConfigSection['browser'], profile: string): string[] {
  return [
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-infobars', '--hide-crash-restore-bubble',
    '--window-size=' + cfg.windowWidth + ',' + cfg.windowHeight,
    ...(cfg.windowLeft || cfg.windowTop ? ['--window-position=' + cfg.windowLeft + ',' + cfg.windowTop] : []),
    '--autoplay-policy=no-user-gesture-required', '--disable-features=Translate',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    'about:blank',
  ];
}
async function readDevtoolsPort(profile: string, diagnostic?: EndpointDiagnostic): Promise<ProfileEndpoint | null> {
  if (diagnostic && !diagnostic.dapSeen) diagnostic.stage = 'dap-read';
  try {
    const file = join(profile, 'DevToolsActivePort');
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('DevToolsActivePort 不是安全的常规文件');
    if (stat.size > 4096) throw new Error('DevToolsActivePort 超过 4096 字节');
    const [portLine, pathLine] = (await readFile(file, 'utf8')).trim().split(/\r?\n/);
    if (!/^\d{1,5}$/.test(portLine)) throw new Error('DevToolsActivePort 端口格式无效');
    if (!/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(pathLine ?? '')) throw new Error('DevToolsActivePort 浏览器 WebSocket 路径无效');
    const port = Number(portLine);
    if (port < 1 || port > 65535) throw new Error('DevToolsActivePort 端口超出 1–65535 范围');
    if (diagnostic) { diagnostic.dapSeen = true; diagnostic.port = port; diagnostic.wsPath = pathLine; diagnostic.dapReadError = undefined; }
    return { port, path: pathLine, url: 'http://127.0.0.1:' + port };
  } catch (error) {
    // ENOENT 只是还没写出来，不能当成损坏；真正的读取/校验错误要保留，避免把
    // “端口文件坏/读不了”误报成“没有端口、疑似交给已有实例”。
    if (diagnostic && (error as NodeJS.ErrnoException)?.code !== 'ENOENT') diagnostic.dapReadError = diagnosticError(error);
    return null;
  }
}
async function probeDevtools(base: string, fetcher: typeof fetch, signal: AbortSignal, until: number, expected?: ProfileEndpoint, diagnostic?: EndpointDiagnostic): Promise<DevtoolsEndpoint> {
  checkCanceled(signal);
  if (diagnostic) diagnostic.stage = 'endpoint-address';
  const url = new URL(base.endsWith('/') ? base : base + '/');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('调试地址必须是无内嵌凭据的 HTTP(S) 地址');
  if (diagnostic) diagnostic.stage = 'http';
  const timeout = Math.min(1000, remaining(until));
  const response = await interruptible(fetcher(new URL('json/version', url), { signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) }), signal, timeout);
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error('调试端点 HTTP ' + response.status); }
  if (diagnostic) diagnostic.stage = 'json';
  const body = await interruptible(response.json(), signal, Math.min(1000, remaining(until))) as Record<string, unknown> | null;
  if (diagnostic) diagnostic.stage = 'devtools-validation';
  if (!body || typeof body.Browser !== 'string' || !/Chrome|Chromium|Edg/i.test(body.Browser) || typeof body.webSocketDebuggerUrl !== 'string') throw new Error('端口不是可用的 Chromium DevTools 服务');
  if (diagnostic) diagnostic.stage = 'websocket-validation';
  const ws = new URL(body.webSocketDebuggerUrl);
  if (!['ws:', 'wss:'].includes(ws.protocol) || ws.username || ws.password || !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(ws.pathname)) throw new Error('调试服务返回了无效的浏览器连接地址');
  if (expected && (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(ws.hostname) || Number(ws.port) !== expected.port || ws.pathname !== expected.path || ws.search || ws.hash)) throw new Error('资料目录的调试端口与浏览器地址不对应，可能是残留文件');
  if (diagnostic) { diagnostic.stage = 'http-ready'; diagnostic.endpointError = undefined; }
  return { ws: ws.toString(), port: Number(ws.port) || (ws.protocol === 'wss:' ? 443 : 80), product: body.Browser };
}
async function waitForProfileEndpoint(profile: string, state: LaunchState, fetcher: typeof fetch, signal: AbortSignal, until: number, grace: number, poll: number, diagnostic: EndpointDiagnostic): Promise<DevtoolsEndpoint> {
  const failure = (withoutEndpoint: string) => diagnostic.dapSeen
    ? '已读取 DevToolsActivePort（port=' + diagnostic.port + '），但调试端点健康检查失败（' + diagnostic.stage + '）：' + (diagnostic.endpointError ?? '端点未通过校验')
    : withoutEndpoint + (diagnostic.dapReadError ? '；端口文件读取/校验原因：' + diagnostic.dapReadError : '');
  while (Date.now() < until) {
    checkCanceled(signal);
    const endpoint = await readDevtoolsPort(profile, diagnostic);
    // Probe before interpreting process exit: launch stubs may exit after handing off successfully.
    if (endpoint) {
      try { return await probeDevtools(endpoint.url, fetcher, signal, until, endpoint, diagnostic); }
      catch (error) { if (signal.aborted) throw error; diagnostic.endpointError = diagnosticError(error); }
    }
    if (state.error) throw new BrowserRefusal('程序无法启动（' + safeDiagnostic(String((state.error as NodeJS.ErrnoException).code || 'spawn error')) + '）');
    if (state.exited && (state.code !== 0 || state.signal)) throw new BrowserRefusal('浏览器进程退出（code=' + state.code + (state.signal ? ', signal=' + state.signal : '') + '）');
    if (state.exited && Date.now() - state.exitedAt >= grace) throw new BrowserRefusal(failure('启动程序退出 0，疑似交给已有实例，但本次未获得有效调试端口'));
    await pause(Math.min(Math.max(1, poll), remaining(until)), signal);
  }
  throw new BrowserRefusal(failure('未能读取有效的 DevToolsActivePort'));
}
function launchFailure(error: unknown, state: LaunchState): string {
  const stderr = safeDiagnostic(state.stderr);
  if (/RemoteDebuggingAllowed|remote debugging.{0,60}(?:disabled|disallowed|not allowed|forbid)|policy.{0,40}remote/i.test(stderr)) return 'Edge/Chrome 策略禁止远程调试，请检查策略或用 cdpUrl 手动接管';
  const reason = diagnosticError(error);
  return reason + (stderr ? '；错误输出：' + stderr.slice(-600) : '；无错误输出');
}
async function createManagedProfile(dataDir: string): Promise<ManagedProfile> {
  const rootPath = resolve(dataDir, 'bilibili-video', 'browser-profiles');
  await mkdir(rootPath, { recursive: true });
  const root = await realpath(rootPath);
  const path = await mkdtemp(join(root, 'browser-' + Date.now() + '-'));
  const token = randomUUID();
  await writeFile(join(path, PROFILE_MARKER), JSON.stringify({ owner: PROFILE_OWNER, token, root, name: basename(path), createdAt: Date.now() }), { mode: 0o600, flag: 'wx' });
  return { root, path, token };
}
async function validManagedProfile(profile: ManagedProfile): Promise<boolean> {
  try {
    const stat = await lstat(profile.path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const root = await realpath(profile.root), actual = await realpath(profile.path);
    if (dirname(actual) !== root || !/^browser-\d+-[A-Za-z0-9]+$/.test(basename(actual))) return false;
    const marker = join(actual, PROFILE_MARKER), markerStat = await lstat(marker);
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 2048) return false;
    const data = JSON.parse(await readFile(marker, 'utf8'));
    return data.owner === PROFILE_OWNER && data.token === profile.token && data.root === root && data.name === basename(actual);
  } catch { return false; }
}
async function deleteManagedProfile(profile: ManagedProfile, log: Logger | null): Promise<void> {
  if (!await validManagedProfile(profile)) { log?.warn('bilibili-video profile ownership check failed; directory retained'); return; }
  try {
    await rm(profile.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
    await pruneManagedProfiles(profile.root, log);
  } catch { log?.warn('bilibili-video temporary profile could not be removed; retained for later cleanup', { profile: profile.path }); }
}
async function pruneManagedProfiles(root: string, log: Logger | null): Promise<void> {
  const until = Date.now() + 1500;
  const profiles: Array<ManagedProfile & { createdAt: number }> = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).slice(0, 24)) {
    if (Date.now() >= until) break;
    if (!entry.isDirectory() || !/^browser-\d+-[A-Za-z0-9]+$/.test(entry.name)) continue;
    try {
      const path = join(root, entry.name);
      const markerFile = join(path, PROFILE_MARKER), stat = await lstat(markerFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) continue;
      const marker = JSON.parse(await readFile(markerFile, 'utf8'));
      const profile = { root, path, token: marker.token };
      if (await validManagedProfile(profile)) profiles.push({ ...profile, createdAt: Number(marker.createdAt) || 0 });
    } catch { /* Foreign, unreadable or incomplete directories are never deleted. */ }
  }
  profiles.sort((a, b) => b.createdAt - a.createdAt);
  for (const profile of profiles.slice(2, 4)) {
    if (Date.now() >= until) break;
    const pids = await bounded(profileProcessIds(profile.path), remaining(until)).catch(() => null);
    if (pids === null || pids.length) { log?.warn('bilibili-video old profile retained because process ownership/exit is not confirmed', { profile: profile.path }); continue; }
    if (await validManagedProfile(profile)) await rm(profile.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }).catch(() => {});
  }
}

/** Platform helpers only. No function runs until the caller invokes it. */

const WINDOWS = process.platform === 'win32';
const pathApi = WINDOWS ? win32 : posix;
const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const platformPause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const HOST_INTEGRITY_QUERY_TIMEOUT_MS = 750;
const HOST_INTEGRITY_TIMEOUT_MS = 1500;

/** Localized group names are ignored. Accept only one complete integrity SID field. */
export function parseWindowsIntegrityRid(csv: string): number | null {
  const matches = [...csv.matchAll(/(?:^|,)"S-1-16-([0-9]+)"(?=,|\r?$)/gm)];
  if (matches.length !== 1) return null;
  const rid = Number(matches[0][1]);
  return Number.isSafeInteger(rid) && rid >= 0 && rid <= 0xffffffff ? rid : null;
}

/** Retry one transient failure, share in-flight work, and cache only a known RID. */
export function createWindowsIntegrityDetector(query: () => Promise<number | null>): () => Promise<number | null> {
  let known: number | null = null;
  let pending: Promise<number | null> | undefined;
  return () => {
    if (known !== null) return Promise.resolve(known);
    return pending ??= (async () => {
      const until = Date.now() + HOST_INTEGRITY_TIMEOUT_MS;
      for (let attempt = 0; attempt < 2 && Date.now() < until; attempt++) {
        const rid = await bounded(Promise.resolve().then(query), Math.min(HOST_INTEGRITY_QUERY_TIMEOUT_MS, remaining(until))).catch(() => null);
        if (rid !== null && Number.isSafeInteger(rid) && rid >= 0 && rid <= 0xffffffff) {
          known = rid;
          return rid;
        }
      }
      return null;
    })().finally(() => { pending = undefined; });
  };
}

const queryWindowsHostIntegrityRid = createWindowsIntegrityDetector(() => new Promise<number | null>((done) => {
    execFile(join(system32, 'whoami.exe'), ['/groups', '/fo', 'csv', '/nh'],
      { encoding: 'utf8', windowsHide: true, shell: false, timeout: HOST_INTEGRITY_QUERY_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error, stdout) => done(error ? null : parseWindowsIntegrityRid(stdout)));
}));

/** A normal child inherits the host token. No group names or raw output are retained or logged. */
function windowsHostIntegrityRid(): Promise<number | null> {
  return WINDOWS ? queryWindowsHostIntegrityRid() : Promise.resolve(null);
}

/** Never use a shell or include subprocess output in a log. */
function run(file: string, args: string[], timeout = 1800): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, shell: false, timeout, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout));
  });
}

function fileExists(file: string): boolean {
  try { return statSync(file).isFile(); } catch { return false; }
}

function unquote(value: string): string {
  const s = value.trim();
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

function normalizedPath(value: string): string {
  let p = pathApi.resolve(unquote(value));
  if (WINDOWS) {
    if (p.toLowerCase().startsWith('\\\\?\\unc\\')) p = `\\\\${p.slice(8)}`;
    else if (p.startsWith('\\\\?\\')) p = p.slice(4);
    p = p.toLowerCase();
  }
  const root = pathApi.parse(p).root;
  return p.length > root.length ? p.replace(WINDOWS ? /\\+$/ : /\/+$/, '') : p;
}

/** Explicit configuration stays first, including a missing path, so its error is observable. */
export async function discoverBrowserCandidates(explicit: string): Promise<string[]> {
  const configured = unquote(explicit);
  const home = homedir();
  let detected: string[] = [];
  let common: string[];
  if (WINDOWS) {
    const queries: Promise<string | null>[] = [];
    for (const hive of ['HKCU', 'HKLM']) for (const name of ['chrome.exe', 'msedge.exe', 'chromium.exe']) {
      for (const view of ['64', '32']) queries.push(run(join(system32, 'reg.exe'), [
        'query', `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${name}`, '/ve', `/reg:${view}`,
      ]));
    }
    const registry = await Promise.all(queries);
    detected.push(...registry.flatMap((out) => out?.split(/\r?\n/).flatMap((line) => {
      const hit = line.match(/\bREG_(?:EXPAND_)?SZ\s+(.+)$/i);
      if (!hit) return [];
      const expanded = hit[1].replace(/%([^%]+)%/g, (all, key: string) => process.env[key] ?? all);
      return [unquote(expanded)];
    }) ?? []));
    const onPath = await Promise.all(['chrome.exe', 'msedge.exe', 'chromium.exe'].map((name) => run(join(system32, 'where.exe'), [name])));
    detected.push(...onPath.flatMap((out) => out?.split(/\r?\n/).map(unquote).filter(Boolean) ?? []));
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const roots = [process.env.PROGRAMFILES || 'C:\\Program Files', process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', local];
    common = roots.flatMap((root) => [
      join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(root, 'Chromium', 'Application', 'chrome.exe'),
      join(root, 'Chromium', 'Application', 'chromium.exe'),
      join(root, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'),
      join(root, 'Google', 'Chrome Dev', 'Application', 'chrome.exe'),
      join(root, 'Google', 'Chrome SxS', 'Application', 'chrome.exe'),
      join(root, 'Microsoft', 'Edge Beta', 'Application', 'msedge.exe'),
      join(root, 'Microsoft', 'Edge Dev', 'Application', 'msedge.exe'),
      join(root, 'Microsoft', 'Edge SxS', 'Application', 'msedge.exe'),
    ]);
  } else if (process.platform === 'darwin') {
    common = ['/Applications', join(home, 'Applications')].flatMap((root) => [
      ['Google Chrome', 'Google Chrome'], ['Google Chrome Beta', 'Google Chrome Beta'],
      ['Google Chrome Canary', 'Google Chrome Canary'], ['Google Chrome Dev', 'Google Chrome Dev'], ['Chromium', 'Chromium'],
      ['Microsoft Edge', 'Microsoft Edge'], ['Microsoft Edge Beta', 'Microsoft Edge Beta'],
      ['Microsoft Edge Dev', 'Microsoft Edge Dev'], ['Microsoft Edge Canary', 'Microsoft Edge Canary'],
    ].map(([app, executable]) => join(root, `${app}.app`, 'Contents', 'MacOS', executable)));
  } else {
    const names = ['google-chrome', 'google-chrome-stable', 'google-chrome-beta', 'google-chrome-unstable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'microsoft-edge-beta', 'microsoft-edge-dev'];
    common = ['/usr/bin', '/usr/local/bin', '/snap/bin', join(home, '.local', 'bin')].flatMap((root) => names.map((name) => join(root, name)));
    const onPath = await Promise.all(names.map((name) => run('/usr/bin/which', [name])));
    detected = onPath.flatMap((out) => out?.split(/\r?\n/).map(unquote).filter(Boolean) ?? []);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const file of [configured, ...detected, ...common]) {
    if (!file || (file !== configured && !fileExists(file))) continue;
    const key = normalizedPath(file);
    if (!seen.has(key)) { seen.add(key); result.push(file); }
  }
  return result;
}

/** CommandLineToArgvW-compatible backslash/quote handling for normal browser argv. */
function windowsArgv(command: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i < command.length) {
    while (/\s/.test(command[i] ?? '') && i < command.length) i++;
    if (i >= command.length) break;
    let arg = '', quoted = false;
    while (i < command.length && (quoted || !/\s/.test(command[i]))) {
      let slashes = 0;
      while (command[i] === '\\') { slashes++; i++; }
      if (command[i] === '"') {
        arg += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2) arg += '"';
        else if (quoted && command[i + 1] === '"') { arg += '"'; i++; }
        else quoted = !quoted;
        i++;
      } else {
        arg += '\\'.repeat(slashes);
        if (i < command.length && (quoted || !/\s/.test(command[i]))) arg += command[i++];
      }
    }
    if (quoted) return null;
    out.push(arg);
  }
  return out;
}

function exactProfile(command: string, expected: string): boolean | null {
  const argv = windowsArgv(command);
  if (!argv) return null;
  const values: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--user-data-dir') values.push(argv[++i] ?? '');
    else if (argv[i].startsWith('--user-data-dir=')) values.push(argv[i].slice('--user-data-dir='.length));
  }
  // Ambiguous/repeated/relative switches cannot establish ownership.
  if (values.length !== 1 || !pathApi.isAbsolute(values[0])) return null;
  return normalizedPath(values[0]) === expected;
}

/**
 * null means that occupancy could not be established, not that the profile is free.
 * Reads only Win32 process metadata. No browser/profile files are opened.
 */
export async function profileProcessIds(profile: string): Promise<number[] | null> {
  if (!WINDOWS || !profile.trim()) return null;
  const expected = normalizedPath(profile);
  const needle64 = Buffer.from(expected, 'utf8').toString('base64');
  const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
$OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
$needle=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${needle64}'))
$all=@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe' OR Name='chromium.exe'")
$unknown=@($all | Where-Object { [string]::IsNullOrWhiteSpace($_.CommandLine) }).Count -gt 0
$profileMatches=@($all | Where-Object {
  $line=([string]$_.CommandLine).Replace('/','\\').Replace('\\\\?\\UNC\\','\\\\').Replace('\\\\?\\','')
  $line.IndexOf($needle,[StringComparison]::OrdinalIgnoreCase) -ge 0
} | ForEach-Object { @{pid=[int]$_.ProcessId; commandLine=[string]$_.CommandLine} })
@{unknown=$unknown; matches=$profileMatches} | ConvertTo-Json -Depth 4 -Compress`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const out = await run(join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], 3500);
  if (out === null) return null;
  try {
    const result = JSON.parse(out.replace(/^\uFEFF/, '')) as { unknown?: boolean; matches?: Array<{ pid?: unknown; commandLine?: unknown }> };
    if (result.unknown !== false || !Array.isArray(result.matches)) return null;
    const ids: number[] = [];
    for (const row of result.matches) {
      if (!Number.isSafeInteger(row.pid) || Number(row.pid) <= 0 || typeof row.commandLine !== 'string') return null;
      const match = exactProfile(row.commandLine, expected);
      if (match === null) return null;
      if (match && row.pid !== process.pid) ids.push(Number(row.pid));
    }
    return [...new Set(ids)];
  } catch { return null; }
}

function childAlive(proc: ChildProcess): boolean {
  return !!proc.pid && proc.pid !== process.pid && proc.exitCode === null && proc.signalCode === null;
}

/**
 * The caller must verify ownedProfile's dedicated root, real path and ownership marker.
 * Never pass an explicit/shared user profile here. This function deletes no directories.
 * Windows verifies profile remnants after killing only exact matching PID trees.
 * Elsewhere only the original child can be stopped; profile-tree verification returns false.
 */
export async function terminateOwnedBrowser(proc: ChildProcess, ownedProfile?: string): Promise<boolean> {
  if (proc.pid === process.pid) return false;
  if (childAlive(proc)) {
    if (WINDOWS) await run(join(system32, 'taskkill.exe'), ['/PID', String(proc.pid), '/T', '/F'], 3500);
    else {
      try { proc.kill('SIGTERM'); } catch { /* confirmation below decides success */ }
    }
  }
  const firstDeadline = Date.now() + 1500;
  while (childAlive(proc) && Date.now() < firstDeadline) await platformPause(50);
  if (childAlive(proc)) {
    try { proc.kill('SIGKILL'); } catch { /* confirmation below decides success */ }
  }
  if (ownedProfile) {
    const remaining = await profileProcessIds(ownedProfile);
    if (remaining === null) return false;
    // A launcher may have exited while its real browser remains under the owned profile.
    if (remaining.length) {
      const current = await profileProcessIds(ownedProfile);
      if (current === null) return false;
      const targets = remaining.filter((pid) => current.includes(pid));
      if (targets.length) await run(join(system32, 'taskkill.exe'), [...targets.flatMap((pid) => ['/PID', String(pid)]), '/T', '/F'], 3500);
    }
  }
  const deadline = Date.now() + 2000;
  do {
    const profileIds = ownedProfile ? await profileProcessIds(ownedProfile) : [];
    if (!childAlive(proc) && profileIds !== null && profileIds.length === 0) return true;
    if (profileIds === null) return false;
    await platformPause(100);
  } while (Date.now() < deadline);
  return false;
}

/** Refuses the common daily user-data roots and their profile subdirectories. */
export function isDailyBrowserProfile(profile: string): boolean {
  if (!profile.trim()) return false;
  const home = homedir();
  let roots: string[];
  if (WINDOWS) {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    roots = [
      ['Google', 'Chrome'], ['Google', 'Chrome Beta'], ['Google', 'Chrome Dev'], ['Google', 'Chrome SxS'],
      ['Microsoft', 'Edge'], ['Microsoft', 'Edge Beta'], ['Microsoft', 'Edge Dev'], ['Microsoft', 'Edge SxS'],
      ['Chromium'],
    ].map((parts) => join(local, ...parts, 'User Data'));
  } else if (process.platform === 'darwin') {
    roots = ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Dev', 'Google/Chrome Canary', 'Chromium', 'Microsoft Edge', 'Microsoft Edge Beta', 'Microsoft Edge Dev', 'Microsoft Edge Canary']
      .map((name) => join(home, 'Library', 'Application Support', name));
  } else {
    const cfg = process.env.XDG_CONFIG_HOME || join(home, '.config');
    roots = ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'chromium', 'microsoft-edge', 'microsoft-edge-beta', 'microsoft-edge-dev'].map((name) => join(cfg, name));
    roots.push(join(home, 'snap', 'chromium', 'common', 'chromium'));
  }
  const target = normalizedPath(profile);
  return roots.some((root) => {
    const normalized = normalizedPath(root);
    return target === normalized || target.startsWith(`${normalized}${pathApi.sep}`);
  });
}


/*
 * Page scripts are strings: the TS loader wraps functions it compiles in helpers the page does not have.
 * Crop state lives on `window.__bvCrop` so a look shares the sampler's decision.
 */
const SAMPLE_FRAME = `(cellLong, cellShort, q) => {
  const v = document.querySelector('video');
  if (!v || v.readyState < 2 || !v.videoWidth) return null;
  const W = v.videoWidth, H = v.videoHeight;
  // probe for black bars
  const PW = 96, PH = 54, BLACK = 24;
  const p = window.__bvProbe || (window.__bvProbe = document.createElement('canvas'));
  if (p.width !== PW) { p.width = PW; p.height = PH; }
  const px = p.getContext('2d', { willReadFrequently: true });
  px.drawImage(v, 0, 0, PW, PH);
  const d = px.getImageData(0, 0, PW, PH).data;
  const colMax = new Array(PW).fill(0), rowMax = new Array(PH).fill(0);
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    const i = (y * PW + x) * 4;
    const l = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    if (l > colMax[x]) colMax[x] = l;
    if (l > rowMax[y]) rowMax[y] = l;
  }
  let x0 = 0, x1 = PW - 1, y0 = 0, y1 = PH - 1;
  while (x0 < x1 && colMax[x0] < BLACK) x0++;
  while (x1 > x0 && colMax[x1] < BLACK) x1--;
  while (y0 < y1 && rowMax[y0] < BLACK) y0++;
  while (y1 > y0 && rowMax[y1] < BLACK) y1--;
  let det = { x: x0 / PW, y: y0 / PH, w: (x1 - x0 + 1) / PW, h: (y1 - y0 + 1) / PH };
  if (det.w < 0.2 || det.h < 0.2) det = { x: 0, y: 0, w: 1, h: 1 };
  const hist = window.__bvCropHist || (window.__bvCropHist = []);
  hist.push(det);
  if (hist.length > 4) hist.shift();
  let cx0 = 1, cy0 = 1, cx1 = 0, cy1 = 0;
  for (const r of hist) { cx0 = Math.min(cx0, r.x); cy0 = Math.min(cy0, r.y); cx1 = Math.max(cx1, r.x + r.w); cy1 = Math.max(cy1, r.y + r.h); }
  const crop = { x: Math.round(cx0 * W), y: Math.round(cy0 * H), w: Math.max(16, Math.round((cx1 - cx0) * W)), h: Math.max(16, Math.round((cy1 - cy0) * H)) };
  window.__bvCrop = crop;
  // cell orientation follows the picture
  const portrait = crop.h > crop.w;
  const w = portrait ? cellShort : cellLong, h = portrait ? cellLong : cellShort;
  const c = window.__bvCell || (window.__bvCell = document.createElement('canvas'));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d');
  const s = Math.min(w / crop.w, h / crop.h);
  const dw = Math.round(crop.w * s), dh = Math.round(crop.h * s);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(v, crop.x, crop.y, crop.w, crop.h, Math.floor((w - dw) / 2), Math.floor((h - dh) / 2), dw, dh);
  const jpeg = (c.toDataURL('image/jpeg', q).split(',')[1]) || '';
  const g = window.__bvGray || (window.__bvGray = document.createElement('canvas'));
  if (g.width !== 64) { g.width = 64; g.height = 36; }
  const gx = g.getContext('2d', { willReadFrequently: true });
  gx.drawImage(v, crop.x, crop.y, crop.w, crop.h, 0, 0, 64, 36);
  const gd = gx.getImageData(0, 0, 64, 36).data;
  const gray = [];
  for (let i = 0; i < gd.length; i += 4) gray.push((gd[i] * 299 + gd[i + 1] * 587 + gd[i + 2] * 114) / 1000);
  return { t: v.currentTime, jpeg, gray, w, h, crop };
}`;

const LOOK_FRAME = `(mw, mh, q, r) => {
  const v = document.querySelector('video');
  if (!v || v.readyState < 2 || !v.videoWidth) return null;
  const crop = window.__bvCrop || { x: 0, y: 0, w: v.videoWidth, h: v.videoHeight };
  const sx = crop.x + (r ? r.x * crop.w : 0), sy = crop.y + (r ? r.y * crop.h : 0);
  const sw = r ? r.width * crop.w : crop.w, sh = r ? r.height * crop.h : crop.h;
  const scale = Math.min(1, mw / sw, mh / sh) * (r ? Math.max(1, Math.min(mw / sw, mh / sh)) : 1);
  const w = Math.max(16, Math.round(sw * scale)), h = Math.max(16, Math.round(sh * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(v, sx, sy, sw, sh, 0, 0, w, h);
  return { jpeg: (c.toDataURL('image/jpeg', q).split(',')[1]) || '', width: w, height: h, t: v.currentTime };
}`;

const READ_COMMENTS = `(max) => {
  const deep = (root, sel, acc) => {
    acc = acc || [];
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (el.matches(sel)) acc.push(el);
      if (el.shadowRoot) deep(el.shadowRoot, sel, acc);
    }
    return acc;
  };
  // text sits in nested shadow roots (user info, rich text, action buttons); read through all of them
  const deepText = (node) => {
    let s = '';
    const walk = (n) => {
      if (n.nodeType === 3) { s += n.nodeValue; return; }
      if (n.nodeType === 1 && (n.tagName === 'STYLE' || n.tagName === 'SCRIPT')) return;
      if (n.shadowRoot) walk(n.shadowRoot);
      for (const ch of Array.from(n.childNodes)) walk(ch);
    };
    walk(node);
    return s.replace(/\\s+/g, ' ').trim();
  };
  const pick = (el, sel) => {
    const hits = deep(el.shadowRoot || el, sel);
    return hits.length ? deepText(hits[0]) : '';
  };
  const out = [];
  for (const r of deep(document, 'bili-comment-renderer')) {
    const user = pick(r, '#user-name, .user-name, bili-comment-user-info');
    const text = pick(r, 'bili-rich-text, #content, .content');
    const likes = pick(r, '#like, .like');
    if (text) out.push({ user, likes, text: text.slice(0, 300) });
    if (out.length >= max) break;
  }
  if (out.length) return out;
  for (const el of Array.from(document.querySelectorAll('.reply-item'))) {
    const user = (el.querySelector('.user-name') || {}).textContent || '';
    const text = (el.querySelector('.reply-content') || {}).textContent || '';
    const likes = (el.querySelector('.reply-like') || {}).textContent || '';
    if (text.trim()) out.push({ user: user.trim(), likes: likes.trim(), text: text.trim().slice(0, 300) });
    if (out.length >= max) break;
  }
  return out;
}`;
