/**
 * 人册 —— 按 QQ 号记「这人是谁、怎么处、别提什么」。
 *
 * 为什么按号码：她认人只认号码（事件行里是 `昵称(QQ号)`），昵称会改、会撞车，
 * 群里两个人都叫「。」的时候只有号码分得清。
 *
 * 为什么不做成每轮前缀：好感度那边把所有人的号码、原因原文都塞进每一轮前缀，
 * 结果她跟主人说话时也挂着对群里某人的火。人册只在**说话那个人自己那一行**带一句，
 * 她跟谁说话就看见谁。
 *
 * 落盘 `<dataDir>/people.json`，先写临时文件再改名（这台机器常被强杀）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface PersonNote {
  /** QQ 号，字符串存（前导零、大数都安全） */
  qq: string;
  /** 她自己写的一两句：这人是谁、怎么处、别提什么 */
  note: string;
  /** 最近一次见到的昵称，只是给读数好认 */
  name?: string;
  updatedAt: number;
  /** 最近一次见到这个人的时间（事件行里要它排序） */
  seenAt?: number;
  /**
   * 还没说完的话头：下次他开口时提醒她接上（最多 3 条）。
   *
   * 这是"关系续得上"的那一半：`note` 说他是谁，这里说上次聊到哪。
   * 只记真的悬着的（"他说周五要交东西""约了周末打游戏"），不记流水。
   */
  threads?: string[];
}

/** 一条备注最多多少字（写进来的，不是注入的；注入那边另有上限）。 */
export const PEOPLE_NOTE_MAX = 200;
/** 一个人最多挂几条未完的话头。多了就变成待办清单，不是"关系"。 */
export const PEOPLE_THREAD_MAX = 3;
/** 单条话头最多多少字。 */
export const PEOPLE_THREAD_CHARS = 60;

export class PeopleBook {
  private readonly file: string;
  private readonly notes = new Map<string, PersonNote>();
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'people.json');
    this.load();
  }

  get size(): number {
    return this.notes.size;
  }

  /** 这个人的备注（没有就是 undefined）。 */
  get(qq: string | number): PersonNote | undefined {
    return this.notes.get(String(qq));
  }

  /** 记/改一条。返回归一化后的 QQ 号。 */
  set(qq: string | number, note: string, name?: string): string {
    const key = normalizeQq(qq);
    const text = String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, PEOPLE_NOTE_MAX);
    const prev = this.notes.get(key);
    this.notes.set(key, {
      qq: key,
      note: text,
      ...(name ? { name } : prev?.name ? { name: prev.name } : {}),
      updatedAt: Date.now(),
      ...(prev?.seenAt ? { seenAt: prev.seenAt } : {}),
    });
    this.markDirty();
    return key;
  }

  /** 删掉一条。 */
  forget(qq: string | number): boolean {
    const ok = this.notes.delete(normalizeQq(qq));
    if (ok) this.markDirty();
    return ok;
  }

  /** 见过这个人一面：补上/刷新昵称，顺便记下最近一次见到的时间。 */
  saw(qq: string | number, name?: string): void {
    const key = normalizeQq(qq);
    const prev = this.notes.get(key);
    if (!prev) return;                       // 没记过就不建条目：人册是她自己写的，不是自动抓的
    prev.seenAt = Date.now();
    if (name && name !== prev.name) {
      prev.name = name;
      this.markDirty();
    }
  }

  /** 最近更新过的若干条（读数用）。 */
  list(limit = 50): PersonNote[] {
    return [...this.notes.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, limit));
  }

  /** 事件行里带出来的那一句（超长截断，空备注返回空串）。 */
  line(qq: string | number, maxChars: number): string {
    const rec = this.get(qq);
    if (!rec) return '';
    const threads = (rec.threads ?? []).filter(Boolean);
    const tail = threads.length ? `${rec.note ? '｜' : ''}还悬着：${threads.join('；')}` : '';
    const text = `${rec.note}${tail}`;
    if (!text) return '';
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }

  /** 记一条"还没说完"的话头。返回这句话，或说明为什么没收。 */
  addThread(qq: string | number, text: string): { ok: true; threads: string[] } | { ok: false; why: string } {
    const key = normalizeQq(qq);
    const rec = this.notes.get(key);
    if (!rec) return { ok: false, why: `人册里没有 ${key}——先用 qqbot_people_note 记一句他是谁，再记话头。` };
    const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, PEOPLE_THREAD_CHARS);
    if (!t) return { ok: false, why: '要记的那句话是空的。' };
    const threads = rec.threads ?? [];
    if (threads.some((x) => x === t)) return { ok: true, threads };
    if (threads.length >= PEOPLE_THREAD_MAX) {
      return { ok: false, why: `他这儿已经挂着 ${threads.length} 条了（上限 ${PEOPLE_THREAD_MAX}）：${threads.join('；')}。先 qqbot_people_thread_done 结掉一条。` };
    }
    rec.threads = [...threads, t];
    rec.updatedAt = Date.now();
    this.markDirty();
    return { ok: true, threads: rec.threads };
  }

  /** 结掉一条话头（`which` 给序号 1 起，或给那句话里包含的几个字）。 */
  closeThread(qq: string | number, which: string): { ok: true; closed: string; left: string[] } | { ok: false; why: string } {
    const key = normalizeQq(qq);
    const rec = this.notes.get(key);
    const threads = rec?.threads ?? [];
    if (!rec || !threads.length) return { ok: false, why: `${key} 这儿没有挂着的话头。` };
    const raw = String(which ?? '').trim();
    const index = Number(raw);
    const at = Number.isInteger(index) && index >= 1 && index <= threads.length
      ? index - 1
      : threads.findIndex((t) => raw && t.includes(raw));
    if (at < 0) return { ok: false, why: `认不出「${raw}」是哪一条。现在挂着：${threads.map((t, i) => `${i + 1}. ${t}`).join('　')}` };
    const [closed] = threads.splice(at, 1);
    rec.threads = threads;
    rec.updatedAt = Date.now();
    this.markDirty();
    return { ok: true, closed, left: threads };
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { people?: Record<string, PersonNote> };
      for (const [k, v] of Object.entries(raw.people ?? {})) {
        if (!v || typeof v.note !== 'string') continue;
        const key = normalizeQq(v.qq ?? k);
        const threads = Array.isArray(v.threads)
          ? v.threads.filter((t): t is string => typeof t === 'string' && !!t).slice(0, PEOPLE_THREAD_MAX)
          : [];
        this.notes.set(key, {
          qq: key,
          note: v.note,
          ...(v.name ? { name: v.name } : {}),
          updatedAt: Number.isFinite(v.updatedAt) ? v.updatedAt : Date.now(),
          ...(Number.isFinite(v.seenAt) ? { seenAt: v.seenAt } : {}),
          ...(threads.length ? { threads } : {}),
        });
      }
    } catch {
      // 读不出来就当空册子：宁可少认人，也不能让一条坏记录把 World 带崩
      this.notes.clear();
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 1000);
  }

  /** 立刻落盘（stop 时用）。 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, people: Object.fromEntries(this.notes) }, null, 1), 'utf8');
      renameSync(tmp, this.file);
    } catch {
      // 落盘失败下次还会再试；人册不是关键路径
    }
  }
}

/** QQ 号统一成字符串（去掉非数字，空则原样返回）。 */
export function normalizeQq(qq: string | number): string {
  const digits = String(qq ?? '').replace(/\D/g, '');
  return digits || String(qq ?? '').trim();
}
