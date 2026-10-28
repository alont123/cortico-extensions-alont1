/**
 * 群册 —— 按群记「这是个什么地方、有什么梗、什么不能提」。
 *
 * 为什么按群而不是按人：她在两个群里说话，手上只有群名和一个参与度数字。
 * 群里几十上百号人，她认得出谁是谁（人册）、但认不出**这个地方的脾气**——
 * 哪个群能开玩笑、哪句在这儿是内部梗、谁跟谁不对付。她在那儿就像个外人。
 *
 * 为什么不在每条消息上都贴：群消息一天几百条，每行都带一句群底细会把上下文淹掉。
 * 所以有时间闸门：同一个群 `groupLoreGapMs` 之内只贴一次，够了就不重复。
 *
 * 落盘 `<dataDir>/groups.json`，先写临时文件再改名。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface GroupNote {
  /** 群号（字符串） */
  id: string;
  /** 最近一次见到的群名，只是给读数好认 */
  name?: string;
  /** 一句话：这是个什么地方、什么分寸 */
  note: string;
  /** 这儿的梗 / 黑话 / 内部说法（最多 8 条，每条短） */
  lore: string[];
  updatedAt: number;
}

export const GROUP_NOTE_MAX = 200;
export const GROUP_LORE_MAX = 8;
export const GROUP_LORE_CHARS = 50;

export class GroupBook {
  private readonly file: string;
  private readonly notes = new Map<string, GroupNote>();
  private readonly lastShown = new Map<string, number>();
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'groups.json');
    this.load();
  }

  get size(): number {
    return this.notes.size;
  }

  get(id: string | number): GroupNote | undefined {
    return this.notes.get(normalizeGroup(id));
  }

  /** 记/改这个群的一句话底细。 */
  setNote(id: string | number, note: string, name?: string): string {
    const key = normalizeGroup(id);
    const prev = this.notes.get(key);
    const text = String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, GROUP_NOTE_MAX);
    this.notes.set(key, {
      id: key,
      note: text,
      ...(name ? { name } : prev?.name ? { name: prev.name } : {}),
      lore: prev?.lore ?? [],
      updatedAt: Date.now(),
    });
    this.markDirty();
    return key;
  }

  /** 添一条这儿的梗 / 黑话。 */
  addLore(id: string | number, text: string): { ok: true; lore: string[] } | { ok: false; why: string } {
    const key = normalizeGroup(id);
    const rec = this.notes.get(key);
    if (!rec) return { ok: false, why: `群册里还没有 ${key}——先用 qqbot_group_note 记一句这地方是什么样。` };
    const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, GROUP_LORE_CHARS);
    if (!t) return { ok: false, why: '要记的那句是空的。' };
    if (rec.lore.includes(t)) return { ok: true, lore: rec.lore };
    if (rec.lore.length >= GROUP_LORE_MAX) {
      return { ok: false, why: `这个群已经记了 ${rec.lore.length} 条（上限 ${GROUP_LORE_MAX}）：${rec.lore.join('；')}。太多了就不叫"梗"了。` };
    }
    rec.lore = [...rec.lore, t];
    rec.updatedAt = Date.now();
    this.markDirty();
    return { ok: true, lore: rec.lore };
  }

  /** 事件行里带出来的那一句（没有备注返回空串）。 */
  line(id: string | number, maxChars: number): string {
    const rec = this.get(id);
    if (!rec || (!rec.note && !rec.lore.length)) return '';
    const lore = rec.lore.length ? `${rec.note ? '｜' : ''}这儿的梗：${rec.lore.join('；')}` : '';
    const text = `${rec.note}${lore}`;
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }

  /**
   * 现在该不该在事件行里贴这个群的底细：同一个群 `gapMs` 之内只贴一次。
   *
   * 读一次就记一次时间——不是"有备注就贴"，否则一天几百条群消息条条都带着它。
   */
  shouldShow(id: string | number, gapMs: number, now = Date.now()): boolean {
    const key = normalizeGroup(id);
    if (!this.line(key, 9999)) return false;
    const last = this.lastShown.get(key) ?? 0;
    if (now - last < Math.max(0, gapMs)) return false;
    this.lastShown.set(key, now);
    return true;
  }

  list(): GroupNote[] {
    return [...this.notes.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { groups?: Record<string, GroupNote> };
      for (const [k, v] of Object.entries(raw.groups ?? {})) {
        if (!v || typeof v.note !== 'string') continue;
        const key = normalizeGroup(v.id ?? k);
        this.notes.set(key, {
          id: key,
          note: v.note,
          ...(v.name ? { name: v.name } : {}),
          lore: Array.isArray(v.lore) ? v.lore.filter((t): t is string => typeof t === 'string' && !!t).slice(0, GROUP_LORE_MAX) : [],
          updatedAt: Number.isFinite(v.updatedAt) ? v.updatedAt : Date.now(),
        });
      }
    } catch {
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
      writeFileSync(tmp, JSON.stringify({ version: 1, groups: Object.fromEntries(this.notes) }, null, 1), 'utf8');
      renameSync(tmp, this.file);
    } catch {
      /* 落盘失败下次再试；群册不是关键路径 */
    }
  }
}

/** 群号统一成字符串（去掉非数字）。 */
export function normalizeGroup(id: string | number): string {
  const digits = String(id ?? '').replace(/\D/g, '');
  return digits || String(id ?? '').trim();
}
