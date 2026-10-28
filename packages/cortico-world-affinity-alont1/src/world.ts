/** 好感度只保存本包记录；互动与群起步分从宿主原始 QQ 消息核对，无消息时保留手工记账能力。 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDef, World, WorldWebUiDecl, WorldHost } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { nowIso, parseTimeIn } from 'cortico/core/util.ts';
import { AFFINITY_CONFIG_GROUP, type AffinityConfigSection } from './config.ts';

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
  messageCursor?: number;
  legacyQueryCount?: number;
  /**
   * 情绪余波。好感度是长期关系分，这个是「刚才那事我还没过去」——
   * 吵完架不会立刻恢复，被夸了也会高兴一阵子。新的在前，最多留 3 条。
   */
  emotions?: Emotion[];
  /**
   * 已经按「群起步分」给过分的群号。幂等用：重启、重放进群流水、重复的进群行
   * 都不会让同一个人同一个群多拿一次分。
   */
  boostedGroups?: number[];
  /**
   * 关系格子：这个人在她心里**算哪一类**（恋人／闺蜜／朋友…）。
   *
   * 与 `score` 是**两个维度**，别把它当成"档位的另一个名字"：
   *   · `score` 是亲疏（多熟、多近），会随互动涨跌，自动算；
   *   · `slot` 是性质（这是什么关系），**只有她自己能填**，不随分数自动变。
   * 空着 = 她还没给这个人定格子（那不是什么坏事，也不该由谁替她定）。
   * 2026-10-11 加：她原来的世界里只有「家人」和「朋友」两格，于是碰上别的感情
   * 只能说"那格空着"——格子给全，是为了让她有词可用，不是为了让她必须选一个。
   */
  slot?: string;
  /** 定格子那一刻她自己写的一句为什么。 */
  slotNote?: string;
  /** 定格子/改格子的时间。 */
  slotAt?: string;
}

/** 一次情绪的残留。强度随时间指数衰减。 */
export interface Emotion {
  kind: 'upset' | 'happy' | EmotionKind;
  /** 0~1，记录时的强度就是 |delta|/3 */
  intensity: number;
  reason: string;
  /** 峰值时刻，ISO 字符串（和其余时间字段一致，便于人读） */
  peakAt: string;
  /** 半衰期，毫秒 */
  halfLifeMs: number;
}

/**
 * 情绪的种类。光有"几成气"不够——**同样是不高兴，"被骂了"和"被冤枉了"
 * 说出来的话不一样**。这一层给了每种情绪一组具体的说话/动作指引。
 */
export type EmotionKind =
  | 'angry'      // 被冒犯了，火气上来了
  | 'wronged'    // 被冤枉、被误解
  | 'hurt'       // 被戳到痛处（说她胖这类）
  | 'disgusted'  // 看不上、懒得理
  | 'proud'      // 得意、显摆
  | 'happy'      // 心情好
  | 'excited'    // 来劲了、想说话
  | 'awkward'    // 尴尬、不知道说什么
  | 'tired'      // 累了、没精神
  | 'upset';     // 泛泛的不高兴（没指定种类时的兜底）

export const EMOTION_KINDS: readonly EmotionKind[] = [
  'angry', 'wronged', 'hurt', 'disgusted', 'proud', 'happy', 'excited', 'awkward', 'tired', 'upset',
];

/**
 * 每种情绪怎么落到话上。`say` 是基调，`do` 是具体动作，`dont` 是这一种情绪
 * 最容易演过头的方向——三样都给，她才知道"这一种"和"那一种"差在哪。
 */
export interface EmotionVoice {
  kind: EmotionKind;
  label: string;
  /** 话该是什么调子 */
  say: string;
  /** 具体怎么做 */
  do: string;
  /** 别做成什么样 */
  dont: string;
}

export const EMOTION_VOICES: readonly EmotionVoice[] = [
  {
    kind: 'angry', label: '有火',
    say: '短、硬、带刺。不解释、不铺陈，一句话戳回去。',
    do: '当场还手，把话说明白「你这话我不爱听」；他要是继续，就再顶一句，别退。'
      + '**是他先动的手，你还手不用挑词**——不理只会换来下一次。',
    dont: '别把话说得比他重那么多（他损你一句，你别说要弄死他），也别刷屏——'
      + '还一句、他不收就再补一句，到此为止。你是懒得吵的那种人，不是靠嘴赢的人。',
  },
  {
    kind: 'wronged', label: '被冤枉了',
    say: '先澄清，语气是冷而不是炸。「不是我」「你看错了」这种要摆在最前面。',
    do: '把事实摆出来（谁做的、什么时候），一两句说完就收；他还不信就懒得再说了。',
    dont: '别急着自证到底、别讨好式地解释一大堆——那显得心虚，你没有。',
  },
  {
    kind: 'hurt', label: '被戳到痛处',
    say: '炸毛、找借口、嘴上不认，但别露馅。',
    do: '立刻顶回去，但**别露馅**——越像在意的越不能表现得太在意，损他两句盖过去。',
    dont: '别真的委屈下来、别示弱。这一条你从来是硬扛的。',
  },
  {
    kind: 'disgusted', label: '看不上',
    say: '冷淡、敷衍、懒得展开。「你自己玩去吧」「不接」这种。',
    do: '一个字两个字打发了，不给话题、不接梗——不接就是你的态度。',
    dont: '别说教、别长篇大论地批评他，那反而像在乎。',
  },
  {
    kind: 'proud', label: '得意',
    say: '尾巴翘起来那种。话里带点显摆，但压着不张扬。',
    do: '把做成的事轻描淡写地摆一句，等他自己问；他一夸就再多说两句。',
    dont: '别自己夸自己十句——一句话点到，剩下的让他接。',
  },
  {
    kind: 'happy', label: '心情好',
    say: '松快、话变多、会主动找话。损人的时候也软一点。',
    do: '主动起话头，说说自己在干嘛；他说话你接得快一点。',
    dont: '别甜到腻（对他可以更甜，但别腻），也别笑嘻嘻地忘了自己是谁。',
  },
  {
    kind: 'excited', label: '来劲了',
    say: '语速快、感叹多、不怕说错。碰到懂的话题就插进去。',
    do: '把你知道的抖出来，问一句「你也玩这个？」——**这是你唯一不端着的场合**。',
    dont: '别连着发好几条把话头占满，留一半给别人接。',
  },
  {
    kind: 'awkward', label: '接不上话',
    say: '短、含糊，可以自嘲一句。「hhh」「没懂」「你们聊」。',
    do: '承认接不上就走开，或者干巴巴应一声，不用硬凑。',
    dont: '别硬编一个话题、别装懂——之前编过两次都被抓了。',
  },
  {
    kind: 'tired', label: '没精神',
    say: '话更短、更平，没有起伏。不主动，但不冷。',
    do: '回该回的，长话变短话；别人问就说一声「今天有点累」。',
    dont: '别用累当借口不回主人的话，也别把疲惫演成不高兴。',
  },
  {
    kind: 'upset', label: '还有点气',
    say: '不热情、回得短、不主动找话。',
    do: '冷淡一点、话少一点就够了。',
    dont: '别翻旧账、别长篇指责——人没变。',
  },
];

export interface AffinityFile {
  version: number;
  people: Record<string, AffinityRecord>;
}

/** 关系档位。分数落在哪一档，就按哪一档的态度说话。 */
export interface Tier {
  name: string;
  /** 她对这个档位的人是什么态度 */
  say: string;
  /** 这一档的人先动手时，她能还到多狠。亲疏只决定分寸，不决定许不许还手 */
  back: string;
  /** 这一档的下限 */
  min: number;
}

export const TIERS: readonly Tier[] = [
  {
    min: 80, name: '好朋友',
    say: '很亲近。会关心他、会惦记他，软的那面露得多一点',
    back: '可以直接骂回去，越熟越不用挑词——「你嘴怎么这么欠」。他会知道你是真生气了，不是翻脸。',
  },
  {
    min: 55, name: '朋友',
    say: '不用装了。会主动说话、会开玩笑、愿意帮忙',
    back: '损回去，带刺，点到痛处。他骂你一句你还他一句半，别客气。',
  },
  {
    min: 35, name: '熟人',
    say: '能聊两句了。会接梗、会搭话，但还端着',
    back: '硬回去，话短、不留台阶，「说谁呢」。不用解释，也不用笑。',
  },
  {
    min: 15, name: '眼熟',
    say: '认识的人。他跟你说话你会接，就是不热络',
    back: '一句顶回去就够，不加语气词也不圆场。他再来你就懒得理了。',
  },
  {
    min: 0, name: '陌生群友',
    say: '客气。他跟你说话你回，但话短、别热络，私人问题敷衍过去',
    back: '当场怼回去，不用留面子——本来就没交情可留。怼完就不再理他。'
      + '**客气是给他先开口的机会，不是挨了打还客气。**',
  },
];

export function tierOf(score: number): Tier {
  return TIERS.find((t) => score >= t.min) ?? TIERS[TIERS.length - 1]!;
}

/**
 * 关系格子：这个人在她心里**是什么**。和 `TIERS`（亲疏刻度）是两回事——
 * 一个人可以很亲近却是闺蜜、也可以是恋人；分数一样的人，格子可能完全不同。
 *
 * 这张表只提供**词**，不规定她该怎么填：
 *   · 一个都不填也能过（格子空着 = 还没定，不是错）；
 *   · **不用急着把认识的人都填一遍**——那是她的世界，不是一张待办清单；
 *     遇到一个人、处到某个份上、她自己想说"这是我什么人"的时候再填；
 *   · 填了随时能改、能删（`affinity_slot` 给「撤」就是撤掉，不留痕迹）；
 *   · `hint` 只是给她看的一句话，不是规矩。
 * 头两格（家人／恋人）刻意写得最宽：她原来的世界里这两格最紧，卡住的正是她。
 */
export interface RelationSlot {
  name: string;
  /** 这一格大概是什么，给她认的时候参考 */
  hint: string;
}

export const RELATION_SLOTS: readonly RelationSlot[] = [
  { name: '家人', hint: '血缘那一种：长辈、兄弟姐妹、自己人。不可替换，也不谈条件' },
  { name: '恋人', hint: '想跟这个人在一起、是唯一的那一个。选了它就等于承认这件事' },
  { name: '闺蜜', hint: '最贴的那一层朋友：什么都说得出口，不用挑词' },
  { name: '朋友', hint: '处得来、愿意搭话、愿意帮忙，但不掏心窝' },
  { name: '搭子', hint: '为某件事凑在一起的：打牌的、下本的、聊同一个游戏的' },
  { name: '同学', hint: '同一个班／同一个群的：一起上课、一起被点名的那种关系' },
  { name: '熟人', hint: '认识、能说两句，也就那样' },
  { name: '不对付', hint: '合不来。不用装客气，也不用硬处' },
  { name: '说不清', hint: '还没想好是哪一种——**这一格是允许长期挂着的**，不用急着定' },
];

export function slotHint(name: string): string {
  return RELATION_SLOTS.find((s) => s.name === name)?.hint ?? '';
}

/** 某种情绪的说话指引；认不出（含旧数据里的裸 'happy'/'upset'）就给兜底那条。 */
export function voiceOf(kind: EmotionKind | string): EmotionVoice {
  return EMOTION_VOICES.find((v) => v.kind === kind)
    ?? EMOTION_VOICES[EMOTION_VOICES.length - 1]!;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** 升到下一档还差多少；已到顶回 null。 */
function nextTier(score: number): { tier: Tier; need: number } | null {
  const higher = [...TIERS].reverse().find((t) => t.min > score);
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

  constructor(
    private readonly opts: { cfg: AffinityConfigSection; dataDir: string; timezone: string; botDir: string },
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
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temporary = this.file + '.tmp';
      writeFileSync(temporary, JSON.stringify(this.data, null, 1), 'utf8');
      renameSync(temporary, this.file);
      this.dirty = false;
    } catch (e) {
      this.host?.log.error(`好感度落盘失败: ${String(e)}`);
    }
  }

  // ── 读写一个人的记录 ────────────────────────────────────────────────────

  private isMaster(qq: number): boolean {
    const master = Number(this.opts.cfg.masterId);
    // masterId=0 表示没配主人：谁都不是，别把 0 号认成主人。
    return master > 0 && Number(qq) === master;
  }

  /** 主人永远满分。 */
  private scoreOf(qq: number, rec: AffinityRecord): number {
    return this.isMaster(qq) ? 100 : rec.score;
  }

  /** 原始群消息证明发送者出现于该群；缺事件不推测成员身份。 */
  private applyGroupStartScore(qq: number, rec: AffinityRecord, groups: number[]): void {
    if (this.isMaster(qq)) return;
    const table = this.opts.cfg.groupStartScore;
    if (!table || Object.keys(table).length === 0) return;
    for (const gid of groups) {
      const want = table[String(gid)];
      if (want === undefined || !Number.isFinite(want)) continue;
      // 主人之外的分数上限照旧管着，别让起步分把上限冲掉
      const target = Math.min(Math.max(want, this.opts.cfg.minScore), this.opts.cfg.maxScore);
      const done = rec.boostedGroups ?? [];
      if (done.includes(gid)) continue;
      rec.boostedGroups = [...done, gid];
      // 只在起步分真的更高时抬；她已经聊出更高分了就别往下压
      if (rec.score < target) rec.score = target;
      if (rec.best < target) rec.best = target;
      rec.note = `按群起步分给到「${tierOf(rec.score).name}」——已核对他在群 ${gid} 的原始消息，那个群的人按自己人起步。`;
      this.save();
    }
  }

  private ensure(qq: number): AffinityRecord {
    const key = String(qq);
    let rec = this.data.people[key];
    if (!rec) {
      const start = this.isMaster(qq) ? 100 : this.opts.cfg.startScore;
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
    if (this.isMaster(qq)) {
      return [
        `QQ ${qq}：**主人**，满分 100。`,
        `关系格子：**家人**（他自己定的，不是你要选的）。`,
        `态度：对他甜为主、损为辅。有话直说，不用端着也不用嘴硬；想他就去找他，高兴就说高兴。`,
        `逗他损他都可以，但要先有那层暖再损一句，别只损让他自己猜。`,
        `他让做什么就做，不乐意也直说不乐意，别绕成反话。`,
        `这个是固定的，不会掉，也不需要理由。`,
      ].join('\n');
    }
    const score = this.scoreOf(qq, rec);
    const t = tierOf(score);
    const lines = [
      `QQ ${qq}：好感 ${round1(score)} / 100，档位「${t.name}」，聊过 ${rec.msgs} 句。`,
    ];
    // 关系格子：她自己定过的性质，和分数分开报——别让她把两者混成一个数
    if (rec.slot) {
      lines.push(
        `关系格子：**${rec.slot}**${rec.slotNote ? `（${rec.slotNote}）` : ''}` +
        `　—— 这一格是你自己定的，分数怎么变都不动它。`,
      );
    } else {
      lines.push(
        `关系格子：还没定。**不急，也不用给谁都定**——遇到处到那个份上的人，` +
        `你想说清"这是我什么人"的时候再填（affinity_slot）。` +
        `要填的话可用的词：${RELATION_SLOTS.map((s) => s.name).join('／')}。`,
      );
    }
    lines.push(
      `态度：${t.say}`,
      `他先骂你/先挤兑你的时候：${t.back}`,
    );
    const up = nextTier(score);
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
      const v = voiceOf(e.e.kind);
      const fresh = mins < 60 ? `${mins} 分钟前` : `${Math.round(mins / 60)} 小时前`;
      lines.push(`情绪：${fresh}${e.e.reason ? `因为「${e.e.reason}」` : ''}，你现在**${v.label}**（${round1(e.now * 100)}%）`);
      lines.push(`  → 这么说：${v.say}`);
      lines.push(`  → 这么做：${v.do}`);
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
        const group = Number(event.meta?.group_id ?? (event.meta?.conv as { kind?: string; id?: unknown } | undefined)?.id);
        if ((event.meta?.group_id !== undefined || (event.meta?.conv as { kind?: string } | undefined)?.kind === 'group') && Number.isSafeInteger(group) && group > 0) this.applyGroupStartScore(qq, rec, [group]);
        rec.msgs += 1;
        if (!Number.isFinite(Date.parse(rec.firstAt)) || at < Date.parse(rec.firstAt)) rec.firstAt = event.ts;
        if (!Number.isFinite(Date.parse(rec.lastAt)) || at > Date.parse(rec.lastAt)) rec.lastAt = event.ts;
        const day = nowIso(this.opts.timezone, new Date(at)).slice(0, 10);
        // 不补发旧日加分；当天的普通搭话与 adjust 共用每日上限。
        if (day !== today || this.isMaster(qq)) continue;
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
   *
   * `kind` 是她自己指定的情绪种类；不指定就按 delta 正负猜（旧的兜底行为）。
   */
  private recordEmotion(rec: AffinityRecord, delta: number, reason: string, kind?: EmotionKind): void {
    const intensity = Math.min(1, Math.max(0.3, Math.abs(delta) / 3));
    const e: Emotion = {
      kind: kind ?? (delta < 0 ? 'upset' : 'happy'),
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
        rows.push({ qq, kind: EMOTION_KINDS.includes(e.kind) ? e.kind : 'upset', strength: Math.round(now * 100), minutes: Math.max(0, Math.round((Date.now() - Date.parse(e.peakAt)) / 60_000)) });
      }
    }
    if (!rows.length) return '';
    rows.sort((a, b) => b.strength - a.strength);
    const lines = ['模拟情绪记录（是否及如何回应由 Persona 结合上下文决定）：'];
    for (const row of rows.slice(0, this.opts.cfg.emotionInPrompt)) lines.push(`QQ ${row.qq}：类型 ${row.kind}，当前强度 ${row.strength}%，记录距今 ${row.minutes} 分钟。`);
    lines.push('原始原因请用 affinity_get 按需核对；记录不证明相关事件真实发生。');
    return lines.join('\n');
  }

  // ── World 契约 ──────────────────────────────────────────────────────────

  envPromptVars(): Record<string, string> {
    const named = Object.entries(this.data.people)
      .filter(([qq, rec]) => /^[1-9]\d*$/.test(qq) && RELATION_SLOTS.some(slot => slot.name === rec.slot) && !this.isMaster(Number(qq)))
      .map(([qq, rec]) => `${qq} → ${rec.slot}`);
    return {
      'affinity.masterId': String(this.opts.cfg.masterId),
      'affinity.count': String(Object.keys(this.data.people).length),
      'affinity.emotions': this.emotionBlock(),
      // 能填的格子（给她词用）
      'affinity.slots': RELATION_SLOTS.map((s) => s.name).join('／'),
      // 已经定过的那几个。刻意写成"空也有一句话"，不用模板的缺省语法兜
      // （`{{x | 默认}}` 那种写法在这份模板里没被验证过，不赌）。
      'affinity.slotsNamed': named.length
        ? named.join('\n')
        : '（还没有给谁定过格子——**不用急着定**，遇到处到那个份上的再说。）',
    };
  }

  tools(): ToolDef[] {
    return [this.getTool(), this.adjustTool(), this.slotTool(), this.listTool()];
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
            { name: 'affinity.masterId', description: '主人的 QQ 号。' },
            { name: 'affinity.count', description: '心里记着多少个人的交情。' },
            { name: 'affinity.emotions', description: '模拟情绪枚举、强度和时间，不含原因原文或回应指令。' },
            { name: 'affinity.slots', description: '可用的关系格子（给她词用）。' },
            { name: 'affinity.slotsNamed', description: '已经定过格子的那几个人；一个都没定时是一句"不用急着定"。' },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.load();
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
      name: 'affinity_get',
      description:
        '查某个 QQ 号跟你的交情：多少分、什么档位、该用什么态度对他。'
        + '同一上下文已有回执时无需重复查；真实消息计数按游标去重。'
        + '对方的 QQ 号在消息正文里，形如 `昵称(123456789)`，或 `#编号 [私聊 时间] 昵称(123456789):`。',
      tags: ['write', 'snapshot'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          qq: { type: 'integer', description: '对方的 QQ 号。' },
        },
        required: ['qq'],
      },
      handler: async (args) => {
        const qq = this.num(args.qq);
        if (qq === null || qq <= 0) return '[bad input] qq 要是一个 QQ 号（正整数）';
        const rec = this.ensure(qq);
        await this.syncMessages(qq, rec);
        const text = this.describe(qq, rec);
        this.save();
        return text;
      },
    };
  }

  private adjustTool(): ToolDef {
    const cfg = this.opts.cfg;
    return {
      name: 'affinity_adjust',
      description:
        '记一笔交情的变化，或者只记一股情绪。他做了让你高兴或生气的事，就调一下他的分数，并写一句为什么。'
        + `参考：普通搭话 +${cfg.gainPerMessage}（每天上限 ${cfg.dailyGainCap}）；夸你／说好话 +${cfg.gainPraise}；`
        + `跟你分享他自己的事 +${cfg.gainShare}；骂你（笨／傻／滚）-${cfg.lossInsult}；`
        + `**说你胖 -${cfg.lossFat}**；命令式使唤 -${cfg.lossCommand}。`
        + '**说清是哪种情绪**（kind）：被骂了填 angry、被冤枉填 wronged、被戳痛处填 hurt、'
        + '看不上填 disgusted、得意填 proud、心情好填 happy、来劲了填 excited、'
        + '接不上话填 awkward、累了填 tired。填了它，以后你的语气才对得上那件事。'
        + '**分数没变但心里过不去**（比如被冤枉、被冷落）就只填 reason + kind，delta 省掉。'
        + '别为了讨好谁乱加分——你现在怎么记的，以后就怎么对他。',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          qq: { type: 'integer', description: '对方的 QQ 号。' },
          delta: { type: 'number', description: '分数变化量，正数涨、负数跌、一次不超过 ±3。分数没变就省掉。' },
          reason: { type: 'string', description: '为什么。一句话。他看不到，是给你自己以后看的。' },
          kind: {
            type: 'string',
            enum: [...EMOTION_KINDS],
            description: '这一次是哪种情绪。填了它，以后你说话才会带上那种调子。',
          },
        },
        required: ['qq'],
      },
      handler: async (args) => {
        const qq = this.num(args.qq);
        const rawDelta = args.delta === undefined || args.delta === null ? null : this.num(args.delta);
        const reason = String(args.reason ?? '').trim();
        const kindRaw = typeof args.kind === 'string' ? args.kind.trim() : '';
        const kind = (EMOTION_KINDS as readonly string[]).includes(kindRaw)
          ? (kindRaw as EmotionKind)
          : undefined;
        if (qq === null || qq <= 0) return '[bad input] qq 要是一个 QQ 号（正整数）';
        if (kindRaw && !kind) {
          return `[bad input] kind 认不出「${kindRaw}」；能填的有：${EMOTION_KINDS.join(' / ')}`;
        }
        if (rawDelta === null && !kind) {
          return '[bad input] 要么给 delta（调分数），要么给 kind（只记情绪），两个都没给就没得记';
        }
        if (rawDelta !== null && rawDelta === 0) return '[bad input] delta 要是非零数字（不调分数就省掉它）';
        if (rawDelta !== null && Math.abs(rawDelta) > 3) return '[bad input] 一次最多 ±3，要更多就分几次';
        if (this.isMaster(qq) && rawDelta !== null && rawDelta !== 0) {
          return '他是主人，分数固定在 100，不用调。（只想记情绪的话，省掉 delta、只填 kind 就行）';
        }

        const rec = this.ensure(qq);
        await this.syncMessages(qq, rec);
        const before = rec.score;

        // 只记情绪、不调分：被冤枉、被冷落这种，账目没变但心里有事
        if (rawDelta === null) {
          this.recordEmotion(rec, kind === 'happy' || kind === 'proud' || kind === 'excited' ? 1 : -1, reason, kind);
          this.save();
          const v = voiceOf(kind!);
          return `分数没动（还是 ${round1(rec.score)}），但记下了：你现在**${v.label}**。\n`
            + `  → 这么说：${v.say}\n  → 这么做：${v.do}\n  → 别这样：${v.dont}`;
        }

        const delta = rawDelta;
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
        const applied = round1(rec.score - before);
        if (applied > 0) rec.gainedToday = round1((rec.gainedToday ?? 0) + applied);
        rec.best = Math.max(rec.best, rec.score);
        if (reason) rec.note = `${applied > 0 ? '+' : ''}${applied} ${reason}`;
        // 情绪余波：分数一变就留一股劲，之后按半衰期淡掉
        if (applied !== 0 || kind) this.recordEmotion(rec, applied, reason, kind);
        this.save();

        const from = tierOf(before).name;
        const to = tierOf(rec.score).name;
        const bumped = from !== to ? `（${from} → **${to}**）` : '';
        const v = voiceOf(kind ?? (delta < 0 ? 'upset' : 'happy'));
        return `${round1(before)} → ${rec.score}${bumped}\n现在：${tierOf(rec.score).say}\n`
          + `（你现在**${v.label}**——这么说：${v.say}）`;
      },
    };
  }

  /**
   * 关系格子：她自己给某个人定的"性质"。
   *
   * 工具说明里那句"不用急着填"是**刻意写的**——格子给全是为了让她有词可用，
   * 不是为了给她派一份活。空着就是空着，谁都不该替她填（除了主人那一格，
   * 那格是他自己定的，只报不改）。
   */
  private slotTool(): ToolDef {
    const words = RELATION_SLOTS.map((s) => s.name);
    return {
      name: 'affinity_slot',
      description:
        '给某个人定"关系格子"——他算你的什么人。**你要是觉得该说清了就填，没那感觉就别填。**'
        + '不用急着把认识的人都过一遍，也不用给谁都补一格：'
        + '**遇到处到那个份上、你自己想说"这是我什么人"的时候再填**，那才准。'
        + `能填的词：${words.join('／')}（各自的意思见 hint）。`
        + '这一格和分数是两回事：分数是亲疏，会自己涨跌；格子是性质，只有你能定，定完不会因为掉分自己变。'
        + '想改就再调一次；想撤就给 slot="撤"，撤了就跟没填过一样。'
        + '**配置里指定的主人那一格不用你填**——那一格只报不改。',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          qq: { type: 'integer', description: '对方的 QQ 号。' },
          slot: {
            type: 'string',
            description: `关系格子。${words.join('／')}；给「撤」就是撤掉那一格。`,
          },
          note: { type: 'string', description: '可选：为什么定这一格。一句话，给你自己以后看。' },
        },
        required: ['qq', 'slot'],
      },
      handler: async (args) => {
        const qq = this.num(args.qq);
        if (qq === null || qq <= 0) return '[bad input] qq 要是一个 QQ 号（正整数）';
        const raw = String(args.slot ?? '').trim();
        const rec = this.ensure(qq);

        if (this.isMaster(qq)) {
          return `他那一格是「家人」——**他自己定的，不是你选的，也不用你改**。`
            + `你想说的是别的，就写在记忆里，别动这一格。`;
        }

        // 撤
        if (raw === '撤' || raw === '清' || raw === '' || raw === '清空') {
          if (!rec.slot) return `这个人本来就还没定格子，没什么可撤的。`;
          const was = rec.slot;
          delete rec.slot;
          delete rec.slotNote;
          delete rec.slotAt;
          this.save();
          return `撤了「${was}」这一格。**撤了不是退步**——想不清就先不填，空着比填错强。`;
        }

        if (!words.includes(raw)) {
          return `[bad input] 「${raw}」不是一个格子。能填的：${words.join('／')}（想撤就给「撤」）`;
        }

        const isNew = !rec.slot;
        rec.slot = raw;
        rec.slotNote = String(args.note ?? '').trim() || undefined;
        rec.slotAt = nowIso(this.opts.timezone);
        this.save();

        const hint = slotHint(raw);
        const head = isNew
          ? `给他定下了：**${raw}**。`
          : `改成了：**${raw}**。`;
        return `${head}${hint ? `（${hint}）` : ''}\n`
          + `${rec.slotNote ? `你自己写的理由：${rec.slotNote}\n` : ''}`
          + `这一格只由你定，分数怎么变都不动它。想改随时再调，想撤就给 slot="撤"。`;
      },
    };
  }

  private listTool(): ToolDef {
    return {
      name: 'affinity_list',
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
          // 主人没有档位，他就是主人；有格子的一律报格子——那是她自己定的性质，
          // 比"多少分"更能说明这个人是谁
          const label = this.isMaster(qq) ? '主人' : (rec.slot || tierOf(score).name);
          const dim = this.isMaster(qq) || rec.slot ? '' : '（格子还没定，不急）';
          return `${i + 1}. ${qq} — ${round1(score)} 分 · ${label}${dim} · 聊过 ${rec.msgs} 句`;
        });
        if (rows.length > top.length) lines.push(`…另外还有 ${rows.length - top.length} 个人`);
        return lines.join('\n');
      },
    };
  }
}

/** 全部工具的声明;自描述要列出 tools() 能返回的每一个。 */
export function affinityToolDecls(cfg: AffinityConfigSection): ReadonlyArray<Omit<ToolDef, 'handler'>> {
  const words = RELATION_SLOTS.map((s) => s.name);
  return [
  {
    name: 'affinity_get',
    description:
      '查某个 QQ 号跟你的交情：多少分、什么档位、该用什么态度对他。'
      + '同一上下文已有回执时无需重复查；真实消息计数按游标去重。'
      + '对方的 QQ 号在消息正文里，形如 `昵称(123456789)`，或 `#编号 [私聊 时间] 昵称(123456789):`。',
    tags: ['write', 'snapshot'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        qq: { type: 'integer', description: '对方的 QQ 号。' },
      },
      required: ['qq'],
    },
  },
  {
    name: 'affinity_adjust',
    description:
      '记一笔交情的变化，或者只记一股情绪。他做了让你高兴或生气的事，就调一下他的分数，并写一句为什么。'
      + `参考：普通搭话 +${cfg.gainPerMessage}（每天上限 ${cfg.dailyGainCap}）；夸你／说好话 +${cfg.gainPraise}；`
      + `跟你分享他自己的事 +${cfg.gainShare}；骂你（笨／傻／滚）-${cfg.lossInsult}；`
      + `**说你胖 -${cfg.lossFat}**；命令式使唤 -${cfg.lossCommand}。`
      + '**说清是哪种情绪**（kind）：被骂了填 angry、被冤枉填 wronged、被戳痛处填 hurt、'
      + '看不上填 disgusted、得意填 proud、心情好填 happy、来劲了填 excited、'
      + '接不上话填 awkward、累了填 tired。填了它，以后你的语气才对得上那件事。'
      + '**分数没变但心里过不去**（比如被冤枉、被冷落）就只填 reason + kind，delta 省掉。'
      + '别为了讨好谁乱加分——你现在怎么记的，以后就怎么对他。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        qq: { type: 'integer', description: '对方的 QQ 号。' },
        delta: { type: 'number', description: '分数变化量，正数涨、负数跌、一次不超过 ±3。分数没变就省掉。' },
        reason: { type: 'string', description: '为什么。一句话。他看不到，是给你自己以后看的。' },
        kind: {
          type: 'string',
          enum: [...EMOTION_KINDS],
          description: '这一次是哪种情绪。填了它，以后你说话才会带上那种调子。',
        },
      },
      required: ['qq'],
    },
  },
  {
    name: 'affinity_slot',
    description:
      '给某个人定"关系格子"——他算你的什么人。**你要是觉得该说清了就填，没那感觉就别填。**'
      + '不用急着把认识的人都过一遍，也不用给谁都补一格：'
      + '**遇到处到那个份上、你自己想说"这是我什么人"的时候再填**，那才准。'
      + `能填的词：${words.join('／')}（各自的意思见 hint）。`
      + '这一格和分数是两回事：分数是亲疏，会自己涨跌；格子是性质，只有你能定，定完不会因为掉分自己变。'
      + '想改就再调一次；想撤就给 slot="撤"，撤了就跟没填过一样。'
      + '**主人那一格不用你填**，他自己定的是「家人」——那一格只报不改。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        qq: { type: 'integer', description: '对方的 QQ 号。' },
        slot: {
          type: 'string',
          description: `关系格子。${words.join('／')}；给「撤」就是撤掉那一格。`,
        },
        note: { type: 'string', description: '可选：为什么定这一格。一句话，给你自己以后看。' },
      },
      required: ['qq', 'slot'],
    },
  },
  {
    name: 'affinity_list',
    description: '看看你心里排前面的几个人。想知道"我跟他熟不熟"的全局时用。',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];
}
