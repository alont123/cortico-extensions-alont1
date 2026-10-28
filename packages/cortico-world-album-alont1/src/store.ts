/**
 * 相册的册子：`<dataDir>/album.json`。
 *
 * 一条记录 = 一张存得住的图（正文之外的字节放在事件库里，这里只记句柄与来路）。
 * 写入走「临时文件 + rename」；册子只增不删，她自己写的标题与备注改在条目上。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AlbumEntry {
  /** 稳定键：句柄 + 首次出现的时刻，避免同一张图被重复记两条。 */
  id: string;
  /** `log:` 或 `mem:` 句柄，取字节时交给宿主解析。 */
  handle: string;
  mime: string;
  /** 平台侧的附件名（QQ 图片是图片 id）。 */
  name?: string;
  /** 这张图的文本说明（事件里那句 fallbackText）。 */
  caption?: string;
  /** UTC ISO：这张图出现在上下文里的时刻。 */
  at: string;
  /** 谁发的：`me` = 她自己发出去的，其余是对方 id。 */
  from: string;
  /** 对方显示名（有就记，方便她按人找）。 */
  fromName?: string;
  /** 哪个会话来的（`group:123` 这种），私聊与群分开。 */
  conversation?: string;
  /** 她自己写的标题。 */
  title?: string;
  /** 她自己的备注（当时是什么情况）。 */
  note?: string;
}

interface AlbumFile {
  version: 1;
  /** 事件库已经扫到哪个游标（含）。 */
  scannedCursor: number;
  entries: AlbumEntry[];
}

export class AlbumStore {
  private readonly file: string;
  private data: AlbumFile = { version: 1, scannedCursor: 0, entries: [] };

  constructor(private readonly dir: string) {
    this.file = join(dir, 'album.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AlbumFile>;
      const entries = Array.isArray(raw.entries) ? raw.entries : [];
      this.data = {
        version: 1,
        scannedCursor: typeof raw.scannedCursor === 'number' ? raw.scannedCursor : 0,
        entries: entries.filter((e): e is AlbumEntry =>
          !!e && typeof e.id === 'string' && typeof e.handle === 'string' && typeof e.at === 'string'),
      };
    } catch {
      // 册子读坏了就当空的：相册坏掉不该让她起不来。
      this.data = { version: 1, scannedCursor: 0, entries: [] };
    }
  }

  private save(): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.file);
  }

  get scannedCursor(): number {
    return this.data.scannedCursor;
  }

  get size(): number {
    return this.data.entries.length;
  }

  /** 记一批（同一张图重复出现时只补缺的字段，不重记）。 */
  add(entries: AlbumEntry[], scannedCursor: number): number {
    const byId = new Map(this.data.entries.map((e) => [e.id, e]));
    let added = 0;
    for (const e of entries) {
      const old = byId.get(e.id);
      if (!old) {
        byId.set(e.id, e);
        added++;
        continue;
      }
      // 后到的信息更全就补上：标题与备注是她写的，永不被覆盖。
      if (!old.caption && e.caption) old.caption = e.caption;
      if (!old.fromName && e.fromName) old.fromName = e.fromName;
      if (!old.conversation && e.conversation) old.conversation = e.conversation;
    }
    this.data.entries = [...byId.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    this.data.scannedCursor = Math.max(this.data.scannedCursor, scannedCursor);
    this.save();
    return added;
  }

  /** 按条件翻。时间倒序（最近的先看到）。 */
  query(o: {
    person?: string;
    conversation?: string;
    since?: string;
    until?: string;
    hasNote?: boolean;
    limit: number;
  }): AlbumEntry[] {
    const person = o.person?.trim().toLowerCase();
    const sinceMs = o.since ? Date.parse(o.since) : NaN;
    const untilMs = o.until ? Date.parse(o.until) : NaN;
    let rows = this.data.entries.filter((e) => {
      if (person) {
        const id = e.from.toLowerCase();
        const name = (e.fromName ?? '').toLowerCase();
        if (id !== person && name !== person && !name.includes(person)) return false;
      }
      if (o.conversation && e.conversation !== o.conversation) return false;
      const t = Date.parse(e.at);
      if (!Number.isNaN(sinceMs) && t < sinceMs) return false;
      if (!Number.isNaN(untilMs) && t > untilMs) return false;
      if (o.hasNote && !e.note && !e.title) return false;
      return true;
    });
    rows = rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return o.limit > 0 ? rows.slice(0, o.limit) : rows;
  }

  get(id: string): AlbumEntry | undefined {
    return this.data.entries.find((e) => e.id === id);
  }

  /** 她自己写标题/备注。返回改到的条数。 */
  annotate(ids: string[], patch: { title?: string; note?: string }): number {
    let hit = 0;
    for (const e of this.data.entries) {
      if (!ids.includes(e.id)) continue;
      if (patch.title !== undefined) e.title = patch.title;
      if (patch.note !== undefined) e.note = patch.note;
      hit++;
    }
    if (hit) this.save();
    return hit;
  }

  /** 出现过的人（按出现次数），给她「找谁」时选。 */
  people(limit: number): Array<{ key: string; name?: string; count: number; lastAt: string }> {
    const map = new Map<string, { key: string; name?: string; count: number; lastAt: string }>();
    for (const e of this.data.entries) {
      if (e.from === 'me') continue;
      const cur = map.get(e.from);
      if (!cur) {
        map.set(e.from, { key: e.from, ...(e.fromName ? { name: e.fromName } : {}), count: 1, lastAt: e.at });
        continue;
      }
      cur.count++;
      if (e.at > cur.lastAt) cur.lastAt = e.at;
      if (!cur.name && e.fromName) cur.name = e.fromName;
    }
    return [...map.values()].sort((a, b) => b.count - a.count).slice(0, limit);
  }

  /**
   * 迁移：把"发件人是个世界名"的记录改成"我发的"。
   *
   * 为什么是这条判据：`from` 只会是三类东西 —— 号码/名字（人）、`me`（她自己发的）、
   * 或**世界的 id**（旧代码把 `senderKey` 直接当发件人存了下来，而世界推自己的事件时
   * 常用裸 senderKey）。前两类正常运行不会再产生世界名，所以这条迁移是**幂等且收敛**的：
   * 跑一次之后册子里就不会再有世界名当发件人。
   *
   * 传入的世界名由调用方从事件库现读（每个 World 的 id）。
   */
  migrateWorldSenders(worldIds: readonly string[]): number {
    const names = new Set(worldIds.filter(Boolean));
    if (names.size === 0) return 0;
    let hit = 0;
    for (const e of this.data.entries) {
      if (!names.has(e.from)) continue;
      e.from = 'me';
      hit++;
    }
    if (hit) this.save();
    return hit;
  }

  /** 按句柄回填发件人。用于修正老记录：判发件人的逻辑改好之后， */
  /** 册子里已经存下的那批还是旧的值（比如把会话名当成了人名）。 */
  /**
   * 只改 `from` 与 `fromName`（这两个是"这条记录是谁的"），不动她自己写的标题备注。
   */
  fixSenders(fix: (handle: string) => { from: string; fromName?: string } | null): number {
    let hit = 0;
    for (const e of this.data.entries) {
      const want = fix(e.handle);
      if (!want) continue;
      if (e.from !== want.from) {
        e.from = want.from;
        hit++;
      }
      if (!e.fromName && want.fromName) e.fromName = want.fromName;
    }
    if (hit) this.save();
    return hit;
  }

  /** 体检用：按年月的分布，看册子是不是只堆在最近几天。 */
  byMonth(): Array<{ month: string; count: number }> {
    const map = new Map<string, number>();
    for (const e of this.data.entries) {
      const month = e.at.slice(0, 7);
      map.set(month, (map.get(month) ?? 0) + 1);
    }
    return [...map.entries()].map(([month, count]) => ({ month, count })).sort((a, b) => a.month.localeCompare(b.month));
  }
}

/** 扫到的一张图（还没进册子）。 */
export interface FoundImage {
  handle: string;
  mime: string;
  name?: string;
  caption?: string;
  at: string;
  from: string;
  fromName?: string;
  conversation?: string;
}

export function entryIdOf(img: FoundImage): string {
  return `${img.handle}@${img.at}`;
}

export function toEntry(img: FoundImage): AlbumEntry {
  return {
    id: entryIdOf(img),
    handle: img.handle,
    mime: img.mime,
    ...(img.name ? { name: img.name } : {}),
    ...(img.caption ? { caption: img.caption } : {}),
    at: img.at,
    from: img.from,
    ...(img.fromName ? { fromName: img.fromName } : {}),
    ...(img.conversation ? { conversation: img.conversation } : {}),
  };
}
