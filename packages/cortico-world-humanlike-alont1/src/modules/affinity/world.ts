/**
 * 好感度 World。
 *
 * 普通互动从事件库按游标去重计数；有具体缘由的涨跌由模型通过 adjust 记录。
 *
 * 分数、档位与情绪余波都落盘在 `<dataDir>/affinity.json`。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDef, World, WorldWebUiDecl, WorldHost } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts'
import { nowIso, parseTimeIn } from 'cortico/core/util.ts';
import { AFFINITY_CONFIG_GROUP, DEFAULT_TIERS, type AffinityConfigSection, type AffinityTier } from './config.ts';

/** 环境提示词模板。role=envPrompt 的声明缺了就不进系统前缀，所以必须在 console() 里报出来。 */
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 一个人的好感度记录。 */
export interface AffinityRecord {
  /** 0~100 */
  score: number;
  /** 累计互动句数 */
  msgs: number;
  /** 历史最高分——用来实现朋友保底 */
  best: number;
  firstAt: string;
  lastAt: string;
  /** 最后一次涨跌的原因，方便她回溯 */
  note: string;
  /** 上次涨分算在哪一天（每日上限用） */
  day?: string;
  /** 那天已经涨了多少 */
  gainedToday?: number;
  /** 已核对的 QQ 消息游标；旧版本的查询次数另存，不冒充真实句数。 */
  messageCursor?: number;
  legacyQueryCount?: number;
  /**
   * 情绪余波。好感度是长期关系分，这个是「刚才那事我还没过去」——
   * 吵完架不会立刻恢复，被夸了也会高兴一阵子。新的在前，最多留 3 条。
   */
  emotions?: Emotion[];
}

/** 一次情绪的残留。强度随时间指数衰减。 */
export interface Emotion {
  kind: 'upset' | 'happy';
  /** 0~1，记录时的强度就是 |delta|/3 */
  intensity: number;
  reason: string;
  /** 峰值时刻，ISO 字符串（和其余时间字段一致，便于人读） */
  peakAt: string;
  /** 半衰期，毫秒 */
  halfLifeMs: number;
}

export interface AffinityFile {
  version: number;
  people: Record<string, AffinityRecord>;
}

/**
 * 关系档位。分数落在哪一档，就按哪一档的态度说话。
 *
 * 只是 `AffinityTier` 的别名——档位表现在是配置（`worlds.humanlike.affinity.tiers`），
 * 这个类型保留给按名字导入的老代码。
 */
export type Tier = AffinityTier;

/** 默认档位表。配置里给了 tiers 就用配置的。 */
export const TIERS: readonly Tier[] = DEFAULT_TIERS;

export function tierOf(score: number, tiers: readonly Tier[] = DEFAULT_TIERS): Tier {
  const sorted = [...tiers].sort((a, b) => b.min - a.min);
  return sorted.find((t) => score >= t.min) ?? sorted[sorted.length - 1]!;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** 升到下一档还差多少；已到顶回 null。 */
function nextTier(score: number, tiers: readonly Tier[] = DEFAULT_TIERS): { tier: Tier; need: number } | null {
  const higher = [...tiers].sort((a, b) => a.min - b.min).find((t) => t.min > score);
  return higher ? { tier: higher, need: round1(higher.min - score) } : null;
}

export class AffinityWorld implements World {
  readonly id = 'affinity';
  private data: AffinityFile = { version: 1, people: {} };
  private host: WorldHost | null = null;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly file: string;
  private syncTail: Promise<void> = Promise.resolve();
  private readonly recentReads = new Map<number, { at: number; text: string }>();

  constructor(
    private readonly opts: { cfg: AffinityConfigSection; dataDir: string; timezone: string },
  ) {
    this.file = join(opts.dataDir, 'affinity.json');
    this.load();
  }

  // ── 持久化 ──────────────────────────────────────────────────────────────

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as AffinityFile;
      if (raw && typeof raw === 'object' && raw.people && typeof raw.people === 'object') {
        this.data = { version: 1, people: raw.people };
      }
    } catch (e) {
      this.host?.log.warn(`好感度文件读取失败，从空开始: ${String(e)}`);
    }
  }

  /** 攒 300ms 再落盘：一次对话里可能连着调几次工具。 */
  private save(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 300);
  }

  private flush(): void {
    this.flushTimer = null;
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      // 先写临时文件再改名：直接覆盖时，进程在写的中途被强杀（这台机器常用任务管理器/
      // start.bat 重启，Windows 不给清理机会）会留下半截 JSON，下次启动整本账归零。
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8');
      renameSync(tmp, this.file);
    } catch (e) {
      this.host?.log.error(`好感度落盘失败: ${String(e)}`);
    }
  }

  /** 关系档位表：配置里给了就用配置的，没给用默认。 */
  private tiers(): readonly AffinityTier[] {
    const t = this.opts.cfg.tiers;
    return Array.isArray(t) && t.length > 0 ? t : DEFAULT_TIERS;
  }

  /** 工具参数描述里提示一下那个人是谁；没设就什么都不说。 */
  private favoredHint(): string {
    const id = this.opts.cfg.favoredId;
    return id === 0 ? '' : `分数固定的那个人是 ${id}。`;
  }

  // ── 读写一个人的记录 ────────────────────────────────────────────────────

  private isFavored(qq: number): boolean {
    const id = this.opts.cfg.favoredId;
    return id !== 0 && Number(qq) === Number(id);
  }

  /** 那个人分数固定，不涨不跌。 */
  private scoreOf(qq: number, rec: AffinityRecord): number {
    return this.isFavored(qq) ? this.opts.cfg.favoredScore : rec.score;
  }

  private ensure(qq: number): AffinityRecord {
    const key = String(qq);
    let rec = this.data.people[key];
    if (!rec) {
      const start = this.isFavored(qq) ? this.opts.cfg.favoredScore : this.opts.cfg.startScore;
      rec = { score: start, msgs: 0, best: start, firstAt: '', lastAt: '', note: '' };
      this.data.people[key] = rec;
    }
    return rec;
  }

  /**
   * 按分数算出"该用什么态度"那段文本。档位、下一档差多少都写清楚，
   * 免得她自己猜。
   */
  private describe(qq: number, rec: AffinityRecord): string {
    if (this.isFavored(qq)) {
      return [
        `QQ ${qq}：分数固定 ${this.opts.cfg.favoredScore}，不进涨跌。`,
        `态度：${this.opts.cfg.favoredSay}`,
        `这个是固定的，不会掉，也不需要理由。`,
      ].join('\n');
    }
    const score = this.scoreOf(qq, rec);
    const t = tierOf(score, this.tiers());
    const lines = [
      `QQ ${qq}：好感 ${round1(score)} / 100，档位「${t.name}」，聊过 ${rec.msgs} 句。`,
      `态度：${t.say}`,
    ];
    const up = nextTier(score, this.tiers());
    if (up) lines.push(`再涨 ${up.need} 分进「${up.tier.name}」档。`);
    if (rec.best >= this.opts.cfg.friendFloor) {
      lines.push(`他做过朋友，所以掉不破 ${this.opts.cfg.friendFloor} 分。`);
    }
    if (rec.note) lines.push(`上次变动：${rec.note}`);

    // 对这个人的情绪还没过去的话，一并报出来——不然她可能嘴上说"没事"但心里其实有气
    const live = this.liveEmotions(rec);
    if (live.length) {
      const e = live[0]!;
      const mins = Math.max(0, Math.round((Date.now() - Date.parse(e.e.peakAt)) / 60_000));
      const feel = e.e.kind === 'upset' ? '还有点气' : '还挺高兴';
      const fresh = mins < 60 ? `${mins} 分钟前` : `${Math.round(mins / 60)} 小时前`;
      lines.push(`情绪：${fresh}${e.e.reason ? `因为「${e.e.reason}」` : ''}，你现在${feel}（${round1(e.now * 100)}%）`);
    }
    return lines.join('\n');
  }

  /** 只统计 QQ 平台的原始消息；转述、截图分析、报时与材料回放不记互动。 */
  private syncMessages(qq: number, rec: AffinityRecord): Promise<void> {
    const run = this.syncTail.then(async () => {
      const host = this.host;
      if (!host?.store?.range) return;
      const first = rec.messageCursor === undefined;
      const today = nowIso(this.opts.timezone).slice(0, 10);
      const throughCursor = await host.store.latestCursor();
      const events = await host.store.range({
        origin: 'external', senderKey: String(qq), toCursor: throughCursor,
        ...(first
          ? { fromTs: new Date(parseTimeIn(this.opts.timezone, `${today}T00:00:00`)).toISOString() }
          : { fromCursor: rec.messageCursor! + 1 }),
      });
      if (this.host !== host) return;
      if (first) { rec.legacyQueryCount = rec.msgs; rec.msgs = 0; rec.messageCursor = 0; rec.lastAt = ''; }
      const seen = new Set<number>();
      for (const event of [...events].sort((a, b) => a.cursor - b.cursor)) {
        if (!Number.isSafeInteger(event.cursor) || event.cursor <= (rec.messageCursor ?? 0)
          || event.cursor > throughCursor || seen.has(event.cursor)) continue;
        seen.add(event.cursor);
        rec.messageCursor = event.cursor;
        if (event.origin !== 'external' || !['qq', 'qqbot'].includes(event.source) || event.type !== 'qq.message'
          || event.senderKey !== String(qq) || event.meta?.materialKind || event.meta?.sourceEvent
          || (event.meta?.user_id !== undefined && String(event.meta.user_id) !== String(qq))) continue;
        const at = Date.parse(event.ts);
        if (!Number.isFinite(at) || at > Date.now()) continue;
        rec.msgs += 1;
        if (!Number.isFinite(Date.parse(rec.firstAt)) || at < Date.parse(rec.firstAt)) rec.firstAt = event.ts;
        if (!Number.isFinite(Date.parse(rec.lastAt)) || at > Date.parse(rec.lastAt)) rec.lastAt = event.ts;
        const day = nowIso(this.opts.timezone, new Date(at)).slice(0, 10);
        // 不补发旧日加分；当天的普通搭话与 adjust 共用每日上限。
        if (day !== today || this.isFavored(qq)) continue;
        if (rec.day !== today) { rec.day = today; rec.gainedToday = 0; }
        const gain = Math.max(0, Math.min(this.opts.cfg.gainPerMessage, this.opts.cfg.dailyGainCap - (rec.gainedToday ?? 0), this.opts.cfg.maxScore - rec.score));
        const before = rec.score;
        rec.score = round1(rec.score + gain);
        rec.gainedToday = round1((rec.gainedToday ?? 0) + rec.score - before);
        rec.best = Math.max(rec.best, rec.score);
      }
      rec.messageCursor = throughCursor;
      this.save();
    });
    this.syncTail = run.catch(() => {});
    return run;
  }

  // ── 情绪余波 ────────────────────────────────────────────────────────────
  //
  // 好感度是长期的关系分，余波是「刚才那事我还没过去」。
  // 真人吵完架不会立刻恢复，被夸了也会高兴一阵子——这一层让语气有惯性。

  /** 当下还剩多少强度。指数衰减，半衰期到了减半。 */
  private decayedIntensity(e: Emotion): number {
    const elapsed = Date.now() - Date.parse(e.peakAt);
    if (!Number.isFinite(elapsed) || elapsed <= 0) return e.intensity;
    return e.intensity * Math.pow(0.5, elapsed / e.halfLifeMs);
  }

  /** 这个人的情绪余波里还没淡掉的那些（强度已按当下算过）。 */
  private liveEmotions(rec: AffinityRecord): Array<{ e: Emotion; now: number }> {
    const floor = this.opts.cfg.emotionFloor;
    return (rec.emotions ?? [])
      .map((e) => ({ e, now: this.decayedIntensity(e) }))
      .filter((x) => x.now >= floor);
  }

  /**
   * 记一次情绪。强度取 |delta| / 3 —— 所以骂一句（-1.5）留半劲，
   * 说她胖（-3）留满劲。只留最近三条，免得旧情绪一直挂着。
   */
  private recordEmotion(rec: AffinityRecord, delta: number, reason: string): void {
    const intensity = Math.min(1, Math.max(0.3, Math.abs(delta) / 3));
    const e: Emotion = {
      kind: delta < 0 ? 'upset' : 'happy',
      intensity: round1(intensity),
      reason: reason || '（没记原因）',
      peakAt: nowIso(this.opts.timezone),
      halfLifeMs: this.opts.cfg.emotionHalfLifeMinutes * 60_000,
    };
    rec.emotions = [e, ...(rec.emotions ?? [])].slice(0, 3);
  }

  /** 情绪余波写进系统前缀的那一段；没有就返回空串。 */
  private emotionBlock(): string {
    const rows: Array<{ qq: string; kind: string; strength: number; minutes: number }> = [];
    for (const [qq, rec] of Object.entries(this.data.people)) {
      if (!/^[1-9]\d*$/.test(qq)) continue;
      for (const { e, now } of this.liveEmotions(rec)) {
        rows.push({ qq, kind: e.kind === 'upset' ? 'upset' : 'happy', strength: Math.round(now * 100), minutes: Math.max(0, Math.round((Date.now() - Date.parse(e.peakAt)) / 60_000)) });
      }
    }
    if (!rows.length) return '';
    rows.sort((a, b) => b.strength - a.strength);
    const lines = ['模拟情绪记录（是否及如何回应由 Persona 结合上下文决定）：'];
    for (const row of rows.slice(0, this.opts.cfg.emotionInPrompt)) lines.push(`QQ ${row.qq}：类型 ${row.kind}，当前强度 ${row.strength}%，记录距今 ${row.minutes} 分钟。`);
    lines.push('原始原因请用 humanlike_affinity_get 按需核对；记录不证明相关事件真实发生。');
    return lines.join('\n');
  }

  // ── World 契约 ──────────────────────────────────────────────────────────

  envPromptVars(): Record<string, string> {
    const favored = this.opts.cfg.favoredId;
    return {
      'affinity.favoredLine': favored === 0
        ? '- 没有特别优待的人：所有人都按分数说话。\n'
        : `- 有一个分数固定的人：${favored}。他不用查，你也知道怎么对他。\n`
          + `  固定分数的意思是：**对他你不需要收着**。${this.opts.cfg.favoredSay}\n`
          + '  别人按分数算，主人固定。\n',
      'affinity.count': String(Object.keys(this.data.people).length),
      'affinity.emotions': this.emotionBlock(),
    };
  }

  tools(): ToolDef[] {
    return [this.getTool(), this.adjustTool(), this.listTool()];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    return {
      config: [AFFINITY_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.affinity.envPrompt',
          title: '好感度 · 环境提示词',
          description: '告诉她回话前先查交情、什么时候该记一笔。这段进系统前缀。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'affinity.favoredLine', description: '那个分数固定的人怎么对待；没设就是一句「没有」。' },
            { name: 'affinity.count', description: '心里记着多少个人的交情。' },
            { name: 'affinity.emotions', description: '还没过去的那些事，会影响此刻的调子。' },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.load();
    this.recentReads.clear();
  }

  async stop(): Promise<void> {
    this.host = null;
    await this.syncTail;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flush();
  }

  // ── 工具 ────────────────────────────────────────────────────────────────

  private num(v: unknown): number | null {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  private getTool(): ToolDef {
    return {
      name: 'humanlike_affinity_get',
      description:
        '查某个 QQ 号跟你的交情：多少分、什么档位、该用什么态度对他。'
        + '这段上下文里查过的人不用再查，分数变了以 adjust 的返回为准。同步新消息的普通互动加分，重复查询不加分。'
        + '对方的 QQ 号在消息正文里，形如 `昵称(123456789)`，或 `#编号 [私聊 时间] 昵称(123456789):`。',
      tags: ['write', 'snapshot'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          qq: { type: 'integer', description: `对方的 QQ 号。${this.favoredHint()}` },
        },
        required: ['qq'],
      },
      handler: async (args) => {
        const qq = this.num(args.qq);
        if (qq === null || !Number.isSafeInteger(qq) || qq <= 0) return '[bad input] qq 要是一个 QQ 号（正整数）';
        const rec = this.ensure(qq);
        await this.syncMessages(qq, rec);
        const text = this.describe(qq, rec);
        const recent = this.recentReads.get(qq);
        if (recent && Date.now() - recent.at < 5 * 60_000 && recent.text === text) {
          const tier = tierOf(this.scoreOf(qq, rec), this.tiers());
          return `QQ ${qq}：刚查过，没有变化。${this.isFavored(qq) ? `固定 ${this.opts.cfg.favoredScore} 分；态度：${this.opts.cfg.favoredSay}` : `${rec.score} 分，${tier.name}；态度：${tier.say}`}。`;
        }
        this.recentReads.set(qq, { at: Date.now(), text });
        this.save();
        return text;
      },
    };
  }

  private adjustTool(): ToolDef {
    const cfg = this.opts.cfg;
    return {
      name: 'humanlike_affinity_adjust',
      description:
        '记一笔交情的变化。他做了让你高兴或生气的事，就调一下他的分数，并写一句为什么。'
        + `普通搭话已由事件库自动记分，不要再手动加；每日加分上限 ${cfg.dailyGainCap}。参考：夸你／说好话 +${cfg.gainPraise}；`
        + `跟你分享他自己的事 +${cfg.gainShare}；骂你（笨／傻／滚）-${cfg.lossInsult}；`
        + `**${cfg.lossHarshNote} -${cfg.lossHarsh}**；命令式使唤 -${cfg.lossCommand}。`
        + '别为了讨好谁乱加分——你现在怎么记的，以后就怎么对他。',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          qq: { type: 'integer', description: '对方的 QQ 号。' },
          delta: { type: 'number', description: '变化量，正数涨、负数跌。一次不要超过 ±3。' },
          reason: { type: 'string', description: '为什么变。一句话。他看不到，是给你自己以后看的。' },
        },
        required: ['qq', 'delta'],
      },
      handler: async (args) => {
        const qq = this.num(args.qq);
        const delta = this.num(args.delta);
        const reason = String(args.reason ?? '').trim();
        if (qq === null || !Number.isSafeInteger(qq) || qq <= 0) return '[bad input] qq 要是一个 QQ 号（正整数）';
        if (delta === null || delta === 0) return '[bad input] delta 要是非零数字';
        if (Math.abs(delta) > 3) return '[bad input] 一次最多 ±3，要更多就分几次';
        if (this.isFavored(qq)) {
          return `这个人的分数固定在 ${cfg.favoredScore}，不进涨跌。`;
        }

        const rec = this.ensure(qq);
        await this.syncMessages(qq, rec);
        const before = rec.score;
        let next = before + delta;

        if (delta > 0) {
          // 每日加分上限
          const today = nowIso(this.opts.timezone).slice(0, 10);
          if (rec.day !== today) { rec.day = today; rec.gainedToday = 0; }
          const room = Math.max(0, cfg.dailyGainCap - (rec.gainedToday ?? 0));
          const applied = Math.min(delta, room);
          next = before + applied;
        }

        // 朋友保底：到过 friendFloor 就一直保底
        if (rec.best >= cfg.friendFloor && next < cfg.friendFloor) next = cfg.friendFloor;
        next = Math.min(cfg.maxScore, Math.max(cfg.minScore, next));

        rec.score = round1(next);
        rec.best = Math.max(rec.best, rec.score);
        const appliedDelta = round1(rec.score - before);
        if (appliedDelta > 0) rec.gainedToday = round1((rec.gainedToday ?? 0) + appliedDelta);
        if (appliedDelta !== 0) {
          if (reason) rec.note = `${appliedDelta > 0 ? '+' : ''}${appliedDelta} ${reason}`;
          this.recordEmotion(rec, appliedDelta, reason);
        }
        this.recentReads.delete(qq);
        this.save();

        if (appliedDelta === 0) return `${rec.score} → ${rec.score}\n分数未变：已达${delta > 0 ? '每日加分上限或分数上限' : '分数下限或朋友保底'}。`;

        const tiers = this.tiers();
        const from = tierOf(before, tiers).name;
        const to = tierOf(rec.score, tiers).name;
        const bumped = from !== to ? `（${from} → **${to}**）` : '';
        const feel = appliedDelta < 0 ? '你现在还有点气，别装作没事' : '你现在心情不错，这股劲会持续一阵';
        return `${round1(before)} → ${rec.score}${bumped}\n现在：${tierOf(rec.score, tiers).say}\n（${feel}）`;
      },
    };
  }

  private listTool(): ToolDef {
    return {
      name: 'humanlike_affinity_list',
      description: '看看你心里排前面的几个人。想知道"我跟他熟不熟"的全局时用。',
      tags: ['read'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => {
        const rows = Object.entries(this.data.people)
          .map(([qq, rec]) => ({ qq: Number(qq), rec, score: this.scoreOf(Number(qq), rec) }))
          .sort((a, b) => b.score - a.score);
        if (!rows.length) return '还没有记下任何人。';
        const top = rows.slice(0, 25);
        const lines = top.map(({ qq, rec, score }, i) => {
          // 固定的那个人没有档位
          const label = this.isFavored(qq) ? '固定' : tierOf(score, this.tiers()).name;
          return `${i + 1}. ${qq} — ${round1(score)} 分 · ${label} · 聊过 ${rec.msgs} 句`;
        });
        if (rows.length > top.length) lines.push(`…另外还有 ${rows.length - top.length} 个人`);
        return lines.join('\n');
      },
    };
  }
}

/** 全部工具的声明;自描述要列出 tools() 能返回的每一个。 */
export function affinityToolDecls(cfg: AffinityConfigSection, favoredId: number): ReadonlyArray<Omit<ToolDef, 'handler'>> {
  const favoredHint = favoredId === 0 ? '' : `分数固定的那个人是 ${favoredId}。`
  return [
  {
    name: 'humanlike_affinity_get',
    description:
      '查某个 QQ 号跟你的交情：多少分、什么档位、该用什么态度对他。'
      + '这段上下文里查过的人不用再查，分数变了以 adjust 的返回为准。同步新消息的普通互动加分，重复查询不加分。'
      + '对方的 QQ 号在消息正文里，形如 `昵称(123456789)`，或 `#编号 [私聊 时间] 昵称(123456789):`。',
    tags: ['write', 'snapshot'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        qq: { type: 'integer', description: `对方的 QQ 号。${favoredHint}` },
      },
      required: ['qq'],
    },
  },
  {
    name: 'humanlike_affinity_adjust',
    description:
      '记一笔交情的变化。他做了让你高兴或生气的事，就调一下他的分数，并写一句为什么。'
      + `普通搭话已由事件库自动记分，不要再手动加；每日加分上限 ${cfg.dailyGainCap}。参考：夸你／说好话 +${cfg.gainPraise}；`
      + `跟你分享他自己的事 +${cfg.gainShare}；骂你（笨／傻／滚）-${cfg.lossInsult}；`
      + `**${cfg.lossHarshNote} -${cfg.lossHarsh}**；命令式使唤 -${cfg.lossCommand}。`
      + '别为了讨好谁乱加分——你现在怎么记的，以后就怎么对他。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        qq: { type: 'integer', description: '对方的 QQ 号。' },
        delta: { type: 'number', description: '变化量，正数涨、负数跌。一次不要超过 ±3。' },
        reason: { type: 'string', description: '为什么变。一句话。他看不到，是给你自己以后看的。' },
      },
      required: ['qq', 'delta'],
    },
  },
  {
    name: 'humanlike_affinity_list',
    description: '看看你心里排前面的几个人。想知道"我跟他熟不熟"的全局时用。',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];
}
