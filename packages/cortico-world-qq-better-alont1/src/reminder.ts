import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';

/** 一条提醒/记事（闹钟）。 */
export interface Reminder {
  id: string;
  /** 提醒内容（要定时做的事 / 约定）。 */
  text: string;
  /** 目标触发时间（epoch ms）。 */
  when: number;
  /** 到点发到哪个会话（group:群号 / private:QQ）；缺省取记录时的会话。 */
  address?: string;
  /** 可选备注（谁的事 / 相关人）。 */
  scope?: string;
  createdAt: number;
  done: boolean;
  doneAt?: number;
}

function genId(): string {
  return 'rm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * 相对时间：`in 30m` / `30分钟后` / `2小时` / `3天` / `2 天以后`。
 *
 * 本地修正（与上游不同）：单位那组**长的必须排在短的前面**。上游写成
 * `(m|…|h|…|d|天|日|分钟|小时)`，`d` 在 `天`/`日` 前面，于是 `30天后` 先匹配到 `d`、
 * 把中文单位当成了尾巴；`m` 在 `分钟` 前面同理。后果是**中文相对时间全被算成"天"**：
 * `30分钟后` → 30 天后、`2小时` → 2 天后（都是静默算错，不报错）。2026-10-11 实测到。
 */
const REL_RE = /^(?:in\s+)?(\d+)\s*(分钟|小时|天|日|minutes|mins|minute|min|hours|hour|hr|days|day|m|h|d)\s*(?:后|以后|之后)?$/i;

/**
 * 解析时间字符串为 epoch ms（按本地时区）。支持：
 *  - 绝对 ISO 8601（含 T / Z / ±偏移 / 日期）
 *  - HH:MM[:SS]（今天；若已过去则顺延到明天）
 *  - today HH:MM / 今天 HH:MM / tomorrow HH:MM / 明天 HH:MM
 *  - 相对：in 30m / 30分钟后 / 2小时 / 3天 / 3天后 / in 2 hours
 * 解析失败返回 null。
 */
export function parseWhen(input: string, now: Date = new Date()): number | null {
  const s = (input || '').trim();
  if (!s) return null;
  const lower = s.toLowerCase();

  // 相对时间
  const rel = REL_RE.exec(lower);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    // 中文单位不认 startsWith('m'/'h')（那是给英文缩写用的），单独判，别落到"天"兜底里。
    const isMinute = unit === '分钟' || unit.startsWith('m');
    const isHour = unit === '小时' || unit.startsWith('h');
    const ms = isMinute ? n * 60_000 : isHour ? n * 3_600_000 : n * 86_400_000;
    return now.getTime() + ms;
  }

  // 绝对 ISO
  if (/t|\d{4}-\d{2}-\d{2}|z$|[+-]\d{2}:?\d{2}$/i.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.getTime();
  }

  // 今天 / 明天 HH:MM[:SS]
  let base = new Date(now);
  const tmr = lower.match(/^(?:tomorrow|明天)\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  const tm = lower.match(/^(?:today|今天)?\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  let m: RegExpMatchArray | null = null;
  if (tmr) { m = tmr; base.setDate(base.getDate() + 1); }
  else if (tm) { m = tm; }
  if (m) {
    const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10), ss = m[3] ? parseInt(m[3], 10) : 0;
    if (hh > 23 || mm > 59 || ss > 59) return null;
    const d = new Date(base);
    d.setHours(hh, mm, ss, 0);
    // 今天模式且时间已过 → 顺延明天
    if (!tmr && d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

/** 把 epoch ms 格式化成对人友好的相对日期+时间（今天/明天/X月X日 HH:MM）。 */
export function formatWhen(ms: number, now: Date = new Date()): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const datePart = sameDay(d, now)
    ? '今天'
    : sameDay(d, new Date(now.getTime() + 86_400_000))
      ? '明天'
      : `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${datePart} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 定时提醒 / 记事本存储，落盘到 dataDir/reminders.json。 */
export class ReminderStore {
  private readonly file: string;
  private readonly log: Logger;
  private items: Reminder[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly hasDir: boolean;

  constructor(dataDir: string, log: Logger) {
    this.hasDir = !!dataDir;
    this.file = dataDir ? join(dataDir, 'reminders.json') : '';
    this.log = log;
    if (this.file && existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Reminder[];
        if (Array.isArray(raw)) this.items = raw.filter((r) => r && typeof r.id === 'string');
      } catch {
        this.log.warn('读取提醒存档失败，已忽略', { file: this.file });
      }
    }
  }

  private scheduleFlush(): void {
    if (!this.hasDir || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, 2000);
  }

  flush(): void {
    if (!this.file) return;
    try {
      writeFileSync(this.file, JSON.stringify(this.items, null, 2), 'utf8');
    } catch (e) {
      this.log.warn('提醒持久化失败', { err: String(e) });
    }
  }

  add(text: string, when: number, opts: { address?: string; scope?: string } = {}): Reminder {
    const r: Reminder = {
      id: genId(),
      text,
      when,
      address: opts.address,
      scope: opts.scope,
      createdAt: Date.now(),
      done: false,
    };
    this.items.push(r);
    this.scheduleFlush();
    return r;
  }

  list(pendingOnly = true): Reminder[] {
    const arr = pendingOnly ? this.items.filter((r) => !r.done) : this.items.slice();
    return arr.sort((a, b) => a.when - b.when);
  }

  get(id: string): Reminder | undefined {
    return this.items.find((r) => r.id === id);
  }

  remove(id: string): boolean {
    const i = this.items.findIndex((r) => r.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    // 本地修正（与上游不同）：删除**立刻落盘**。上游这里跟 add 一样只排 2 秒后的
    // 延迟写，于是"刚删掉就崩/被杀"会让删掉的提醒复活。加/删不对称没有道理。
    this.flush();
    return true;
  }

  /** 标记已触发（到点已提醒）。 */
  markDone(id: string): void {
    const r = this.get(id);
    if (!r || r.done) return;
    r.done = true;
    r.doneAt = Date.now();
    // 同上：完成状态立刻落盘，否则崩在 2 秒窗口里会重复提醒同一条。
    this.flush();
  }

  /** 取所有已到期且未完成的提醒。 */
  due(now: number = Date.now()): Reminder[] {
    return this.items.filter((r) => !r.done && r.when <= now);
  }
}
