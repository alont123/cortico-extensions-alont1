/**
 * Bilibili sign-in by QR code and the cookie jar it fills. The QR flow is the web one:
 * `qrcode/generate` gives a URL to encode and a key; `qrcode/poll` with that key answers
 * 86101 (not scanned), 86090 (scanned, not confirmed), 86038 (expired) or 0 with the session
 * cookies in `Set-Cookie`. Cookies live in `<dataDir>/bilibili-video/cookies.json`, a list of
 * DevTools `Network.setCookies` entries, and are injected into every page the World opens.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/** The QR code is valid this long on the bilibili side. */
export const QR_LIFETIME_MS = 180_000;
const POLL_MS = 2000;

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Unix seconds; absent for session cookies. */
  expires?: number;
}

export type QrStatus = 'none' | 'pending' | 'scanned' | 'authorized' | 'expired' | 'error';

export interface QrState {
  status: QrStatus;
  /** Text to encode while pending or scanned. */
  qrText?: string;
  startedAt?: string;
  detail?: string;
}

export interface Identity {
  isLogin: boolean;
  uname?: string;
  mid?: number;
}

export class CookieJar {
  constructor(private readonly file: string) {}

  load(): StoredCookie[] {
    if (!existsSync(this.file)) return [];
    const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
    return Array.isArray(raw) ? (raw as StoredCookie[]) : [];
  }

  save(cookies: readonly StoredCookie[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(cookies, null, 1));
    renameSync(tmp, this.file);
  }

  clear(): void {
    if (existsSync(this.file)) writeFileSync(this.file, '[]');
  }

  get path(): string { return this.file; }

  /** `name=value; ...` for the cookies that apply to api.bilibili.com. */
  header(): string {
    return this.load().filter((c) => c.domain.endsWith('bilibili.com')).map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /** When the SESSDATA cookie expires, if the jar says. */
  expiresAt(): Date | null {
    const s = this.load().find((c) => c.name === 'SESSDATA');
    return s?.expires ? new Date(s.expires * 1000) : null;
  }
}

/** Parses one `Set-Cookie` header value into a stored cookie for `.bilibili.com`. */
export function parseSetCookie(line: string): StoredCookie | null {
  const [pair, ...attrs] = line.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  const out: StoredCookie = { name, value, domain: '.bilibili.com', path: '/', secure: true, httpOnly: false };
  for (const a of attrs) {
    const [k, v = ''] = a.trim().split('=');
    const key = k.toLowerCase();
    if (key === 'domain' && v) out.domain = v.startsWith('.') ? v : `.${v}`;
    else if (key === 'path' && v) out.path = v;
    else if (key === 'httponly') out.httpOnly = true;
    else if (key === 'expires' && v) { const t = Date.parse(v); if (Number.isFinite(t)) out.expires = Math.floor(t / 1000); }
    else if (key === 'max-age' && v) { const n = Number(v); if (Number.isFinite(n)) out.expires = Math.floor(Date.now() / 1000) + n; }
  }
  return out;
}

/** Cookies named in the confirm URL's query (`SESSDATA`, `bili_jct`, `DedeUserID`...), used when `Set-Cookie` is absent. */
export function cookiesFromConfirmUrl(url: string): StoredCookie[] {
  let u: URL;
  try { u = new URL(url); } catch { return []; }
  const wanted = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];
  const out: StoredCookie[] = [];
  for (const name of wanted) {
    const v = u.searchParams.get(name);
    if (v) out.push({ name, value: v, domain: '.bilibili.com', path: '/', secure: true, httpOnly: name === 'SESSDATA', expires: Math.floor(Date.now() / 1000) + 180 * 86400 });
  }
  return out;
}

export interface QrLoginOptions {
  jar: CookieJar;
  onChange?: (state: QrState) => void;
  fetchImpl?: typeof fetch;
}

/** One QR sign-in attempt at a time; `start()` replaces a running one. */
export class QrLogin {
  private state: QrState = { status: 'none' };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt: AbortController | null = null;
  private key = '';
  private readonly f: typeof fetch;

  constructor(private readonly opts: QrLoginOptions) {
    this.f = opts.fetchImpl ?? fetch;
    if (opts.jar.load().some((c) => c.name === 'SESSDATA')) this.state = { status: 'authorized' };
  }

  get current(): QrState { return this.state; }

  private set(next: QrState): void {
    this.state = next;
    this.opts.onChange?.(next);
  }

  async start(): Promise<QrState> {
    this.stopPolling();
    const attempt = new AbortController();
    this.attempt = attempt;
    try {
      const r = await this.f(GENERATE_URL, { headers: { 'user-agent': UA }, signal: attempt.signal });
      if (!this.isCurrent(attempt)) return this.state;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json() as { code?: number; data?: { url?: string; qrcode_key?: string }; message?: string };
      if (!this.isCurrent(attempt)) return this.state;
      if (j.code !== 0 || !j.data?.url || !j.data.qrcode_key) throw new Error(j.message || `generate 返回 code ${j.code}`);
      this.key = j.data.qrcode_key;
      this.set({ status: 'pending', qrText: j.data.url, startedAt: new Date().toISOString() });
      this.schedule(attempt);
    } catch (err) {
      if (this.isCurrent(attempt)) this.set({ status: 'error', detail: `取二维码失败:${(err as Error).message}` });
    }
    return this.state;
  }

  logout(): void {
    this.stopPolling();
    this.opts.jar.clear();
    this.set({ status: 'none' });
  }

  stop(): void { this.stopPolling(); }

  private stopPolling(): void {
    this.attempt?.abort();
    this.attempt = null;
    this.key = '';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private isCurrent(attempt: AbortController): boolean {
    return this.attempt === attempt && !attempt.signal.aborted;
  }

  private schedule(attempt: AbortController): void {
    if (!this.isCurrent(attempt)) return;
    this.timer = setTimeout(() => { void this.poll(attempt); }, POLL_MS);
    this.timer.unref?.();
  }

  private async poll(attempt: AbortController): Promise<void> {
    if (!this.isCurrent(attempt)) return;
    this.timer = null;
    if (this.state.status !== 'pending' && this.state.status !== 'scanned') return;
    try {
      const r = await this.f(`${POLL_URL}?qrcode_key=${encodeURIComponent(this.key)}`, { headers: { 'user-agent': UA }, signal: attempt.signal });
      if (!this.isCurrent(attempt)) return;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json() as { code?: number; data?: { code?: number; message?: string; url?: string } };
      if (!this.isCurrent(attempt)) return;
      if (j.code !== 0) throw new Error(`poll 返回 code ${j.code}`);
      const code = j.data?.code;
      if (code === 0) {
        const fromHeaders = (r.headers.getSetCookie?.() ?? []).map(parseSetCookie).filter((c): c is StoredCookie => !!c);
        const cookies = fromHeaders.length ? fromHeaders : cookiesFromConfirmUrl(j.data?.url ?? '');
        if (!cookies.some((c) => c.name === 'SESSDATA')) throw new Error('确认成功但响应里没有 SESSDATA');
        const kept = this.opts.jar.load().filter((c) => !cookies.some((n) => n.name === c.name));
        this.opts.jar.save([...kept, ...cookies]);
        this.set({ status: 'authorized' });
        return;
      }
      if (code === 86038) { this.set({ status: 'expired', detail: '二维码已过期,重新生成一个。' }); return; }
      if (code === 86090 && this.state.status !== 'scanned') this.set({ ...this.state, status: 'scanned', detail: '已扫码,在手机上确认登录。' });
      if (this.state.startedAt && Date.now() - Date.parse(this.state.startedAt) > QR_LIFETIME_MS) { this.set({ status: 'expired', detail: '二维码已过期,重新生成一个。' }); return; }
      if (code !== 86101 && code !== 86090) throw new Error(j.data?.message || `poll 返回状态 ${code}`);
      this.schedule(attempt);
    } catch (err) {
      if (this.isCurrent(attempt)) this.set({ status: 'error', detail: `轮询失败:${(err as Error).message}` });
    }
  }

  /** Who the jar signs in as, by the nav endpoint; network errors come back as `isLogin: false` with a detail. */
  async whoami(): Promise<Identity & { detail?: string }> {
    const cookie = this.opts.jar.header();
    if (!cookie) return { isLogin: false };
    try {
      const r = await this.f(NAV_URL, { headers: { cookie, 'user-agent': UA, referer: 'https://www.bilibili.com/' } });
      const j = await r.json() as { data?: { isLogin?: boolean; uname?: string; mid?: number } };
      return { isLogin: j.data?.isLogin === true, uname: j.data?.uname, mid: j.data?.mid };
    } catch (err) {
      return { isLogin: false, detail: (err as Error).message };
    }
  }
}
