import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import type { ChatMsg } from './proactive.ts';

/**
 * 情绪系统 —— 完整移植自 fat-fish/libs/qq_bot_runtime/emotion.py（功能对齐）。
 *
 * 工作方式（与原版一致）：
 * - 全局一份心情：mood 值(-10~10) + 主导情绪标签{名称/强度/到期/谁引起} + 事件流水（含引起者）。
 * - 感知：每轮用户发言后做一次 LLM 感知（World.handleMessage 异步触发 perceive），由 generate
 *   回调（OpenAI 兼容 chat 补全）抽取 {emotion, strength, why}，再 applyMood 写入档案。
 * - 表达：buildHint() 把「此刻心情 + 起因(谁干的) + 语气指引 + 不迁怒提醒」注入全局上下文
 *   （经 envPromptVars → ENV_PROMPT 的 {{qq.emotion}}，即 cortico 全局 system 前缀）。
 * - 查询：免指令。用户自然语言问（"你心情怎么样"）由 isQuery 识别后注入 system 事件回 describe()；
 *   /心情 命令保留兼容（含 /心情 重置）。
 * - mood 值随时间指数衰减（半衰期 decayHours），主导标签到期自动消散。
 */

export const MOOD_LABELS = [
  '开心', '得意', '被暖到', '被逗乐', '好奇', '惊讶',
  '平静', '无语', '烦躁', '委屈', '低落', '生气', '难过',
];

// 情绪 → 心情值变化（强度 1 档的基准）。负数=坏心情，正数=好心情
const LABEL_IMPACT: Record<string, number> = {
  被暖到: 1.6, 开心: 1.4, 得意: 1.2, 被逗乐: 1.2,
  好奇: 0.4, 惊讶: 0.3, 平静: 0.0,
  无语: -0.6, 烦躁: -1.0, 委屈: -1.4, 低落: -1.5,
  生气: -1.8, 难过: -2.0,
};

// 情绪 → 语气指引。**只写状态，不写演法。**
//
// 这里原来是某一任角色的演法（卖萌、撒娇、嘴硬、"哼"、"哄两句就好了"）。
// 这些字逐字进她的上下文，等于每次都在教她换一个人说话。
// 现在只说她此刻是什么状态；怎么表现由她自己的宪法和记忆决定。
const LABEL_BEHAVIOR: Record<string, string> = {
  开心: '心情好，话比平时多一点，也更愿意主动开口。',
  得意: '有点得意，不介意让人看出来。',
  被暖到: '心里是软的，比平时更容易说实话。',
  被逗乐: '被逗笑了，愿意顺着这个玩笑往下接。',
  生气: '正在气头上，说话会比平时更冲、更短。',
  委屈: '心里憋着，不太想解释，也懒得装没事。',
  低落: '提不起劲，话会变少。',
  难过: '情绪很低，不想多说话。',
  烦躁: '没什么耐心，容易觉得烦。',
  无语: '觉得对方这话没什么好接的。',
  好奇: '对眼下这个话题有兴趣，愿意多问两句。',
  惊讶: '有点意外。',
};

// 强度 → 程度修饰词（build_mood_hint 头用）
const DEGREE_WORD: Record<number, string> = { 1: '有点', 2: '明显', 3: '非常' };
// 问心情口语化（describe 用）：强度前缀
const DEGREE_PHRASE: Record<number, string> = { 1: '有点', 2: '很', 3: '超级' };
// LABEL_HEAD / LABEL_TAIL 删掉了：那张表装的是"回家话"（"哼、哼，才没有被感动呢"），
// 是某一任角色的口气。她怎么描述自己的心情由她的宪法决定，不由这段代码指定。


const EVENT_KEEP = 8;

// 第三人称旁白 → 第一人称（入库前统一改写，避免口吻跳戏）
// 自称由 opts.selfNames 给（部署的 displayName）：别人提起这个名字，写进心情档案就是「我」。
const WHO_FIXES: Array<[string, string]> = [
  ['用户说', 'TA说'], ['用户', 'TA'],
  ['AI', '我'],
];
// 原因开头可剥离的主语（由 causeText 用"谁"补回，避免双主语）
const LEAD_PRONOUN = ['TA说', '他说', '她说', '对方说', 'TA', '他', '她'];
// 泛指称呼（非真实名字）：拼句时需逗号隔开
const GENERIC_NAMES = ['兄弟', '哥们', '朋友', '家伙', '那家伙', '这人', '那个人', '谁', '陌生人'];

// 自然语言问心情的关键词（isQuery 用）
const MOOD_QUERY_WORDS = [
  '心情', '开心', '高兴', '生气', '不高兴', '不开心',
  '委屈', '难过', '低落', '原谅', '哄你', '气消',
];

const MOOD_PROMPT = `你是一个情绪分析器。用户刚给 AI 助手发来一段话，请判断这段话让助手（“我”）产生了怎样的情绪/心情变化，并抽取为结构化信息。

可选的情绪标签（emotion）只有以下之一：
开心, 得意, 被暖到, 被逗乐, 好奇, 惊讶, 平静, 无语, 烦躁, 委屈, 低落, 生气, 难过

输出严格的 JSON（不要任何多余文字、不要 markdown 代码块）：
{
  "emotion": <上述标签之一；若基本无情绪波动取"平静">,
  "strength": <整数 1..3，情绪强度>,
  "why": "<极简短的因果说明（谁/什么事让你有这情绪），用第一人称，不超过 20 字，例如"被夸了""被骂笨蛋">"
}

判断要点：
- 夸奖、关心、好玩、被需要 → 开心/得意/被暖到/被逗乐。
- 冒犯、无理取闹、被无视、被误解 → 生气/委屈/烦躁/低落/难过。
- 对方示弱、求助、真诚分享 → 被暖到/委屈。
- 平淡闲聊、无情绪冲击 → emotion 取"平静"（此时 strength 取 1、why 留空）。
- 按语气照实判，不要加戏；一句话的情绪强度别拔高。`;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function freshState() {
  return { mood: 0, label: null as MoodLabel | null, events: [] as MoodEvent[], ts: 0 };
}

interface MoodLabel {
  name: string;
  strength: number;
  by: string;
  until: number;
}
interface MoodEvent {
  ts: number;
  user: string;
  label: string;
  why: string;
  delta: number;
}
interface MoodState {
  mood: number;
  label: MoodLabel | null;
  events: MoodEvent[];
  ts: number;
}

export interface MoodInfo {
  emotion: string;
  strength: number;
  why: string;
}

export interface EmotionEngineOpts {
  dataDir: string;
  decayHours: number;
  labelMinutes: number;
  log: Logger;
  generate: (messages: ChatMsg[]) => Promise<string | null>;
  /** 别人怎么称呼这个 bot（部署的 `displayName`）；留空则只改「AI」。 */
  selfNames?: readonly string[];
}

function normalizeWhy(why: string, selfNames: readonly string[]): string {
  if (!why) return '';
  let out = why;
  for (const name of selfNames) {
    if (name) out = out.split(name).join('我');
  }
  for (const [old, nw] of WHO_FIXES) out = out.split(old).join(nw);
  out = out.replace(/ /g, '').replace(/　/g, '');
  for (const p of LEAD_PRONOUN) {
    if (out.startsWith(p)) {
      out = out.slice(p.length).replace(/^[，,、 ]/, '');
      break;
    }
  }
  return out.replace(/[。！! ]$/, '').trim().slice(0, 80);
}

function isExplicitName(name: string): boolean {
  return !!name && !name.startsWith('QQ用户') && !GENERIC_NAMES.includes(name) && name !== '某个人';
}

// 把"谁 + 干了啥"拼成通顺半句
function causeText(who: string, why: string): string {
  if (!who) return why;
  if (!why) return who + '引起的';
  if ('说给帮叫夸骂逗哄凶怼暖'.includes(why[0]) && isExplicitName(who)) return who + why;
  return who + '，' + why;
}

export class EmotionEngine {
  private state: MoodState = freshState();
  private readonly file: string;
  private decayHours: number;
  private labelMinutes: number;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly log: Logger;
  private readonly generate: (messages: ChatMsg[]) => Promise<string | null>;
  private readonly selfNames: readonly string[];

  constructor(opts: EmotionEngineOpts) {
    this.file = opts.dataDir ? join(opts.dataDir, 'emotion-data.json') : '';
    this.decayHours = opts.decayHours;
    this.labelMinutes = opts.labelMinutes;
    this.log = opts.log.child('emotion');
    this.generate = opts.generate;
    this.selfNames = opts.selfNames ?? [];
    this.loadState();
  }

  // ---- 持久化 ----
  private loadState(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<MoodState>;
      this.state = {
        mood: typeof raw.mood === 'number' ? raw.mood : 0,
        label: raw.label ?? null,
        events: Array.isArray(raw.events) ? (raw.events as MoodEvent[]) : [],
        ts: typeof raw.ts === 'number' ? raw.ts : 0,
      };
    } catch {
      this.state = freshState();
    }
  }

  private scheduleSave(): void {
    if (!this.file) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveNow();
    }, 1500);
  }

  private saveNow(): void {
    if (!this.file) return;
    try {
      writeFileSync(this.file, JSON.stringify(this.state));
    } catch (e) {
      this.log.warn('情绪状态保存失败 ' + String(e));
    }
  }

  // ---- 衰减（与原版 _decay 对齐）----
  private decay(now: number): void {
    const halfMs = Math.max(this.decayHours, 0.1) * 3_600_000;
    const dt = Math.max(now - this.state.ts, 0);
    const factor = Math.pow(0.5, dt / halfMs);
    this.state.mood = this.state.mood * factor;
    if (Math.abs(this.state.mood) < 0.01) this.state.mood = 0;
    this.state.ts = now;
    const lb = this.state.label;
    if (lb && now > lb.until) this.state.label = null;
  }

  private labelActive(): MoodLabel | null {
    const lb = this.state.label;
    if (lb && Date.now() <= lb.until) return lb;
    return null;
  }

  // ---- 感知：每轮用户发言后由宿主异步调用（与原版每轮都应用一致，不加节流）----
  async perceive(text: string, byName: string): Promise<void> {
    let raw: string | null = null;
    try {
      raw = await this.generate([
        { role: 'system', content: MOOD_PROMPT },
        { role: 'user', content: '用户刚发来的消息：\n' + text.slice(0, 1200) },
      ]);
    } catch (e) {
      this.log.warn('情绪感知调用失败 ' + String(e));
      return;
    }
    const parsed = parseMood(raw);
    if (!parsed) {
      this.log.info('情绪感知未解析出有效 JSON，跳过');
      return;
    }
    this.applyMood(byName, parsed);
  }

  // ---- 写入心情（与原版 apply_mood 对齐）----
  applyMood(by: string, info: MoodInfo): boolean {
    const label = info.emotion;
    if (!label || !(label in LABEL_IMPACT) || LABEL_IMPACT[label] === 0) return false;
    const strength = clamp(Math.round(info.strength || 1), 1, 3);
    const why = normalizeWhy(info.why || '', this.selfNames);
    const now = Date.now();
    this.decay(now);
    const impact = LABEL_IMPACT[label];
    const delta = clamp(impact * strength * 0.6, -3.5, 3.5);
    this.state.mood = clamp(this.state.mood + delta, -10, 10);
    this.state.events.push({ ts: now, user: by, label, why, delta: Math.round(delta * 10) / 10 });
    if (this.state.events.length > EVENT_KEEP) this.state.events = this.state.events.slice(-EVENT_KEEP);
    // 主导情绪标签：持续 EMOTION_LABEL_MINUTES × 强度，记下是谁引起的
    const minutes = Math.max(this.labelMinutes, 5) * strength;
    this.state.label = { name: label, strength, by, until: now + minutes * 60_000 };
    this.state.ts = now;
    this.scheduleSave();
    this.log.info(`情绪 ${by} 引起 ${label}(x${strength}) delta${delta >= 0 ? '+' : ''}${delta}` + (why ? ` 因: ${why}` : ''));
    return true;
  }

  reset(): void {
    this.state = freshState();
    this.state.ts = Date.now();
    this.scheduleSave();
  }

  // ---- 生成注入提示（每轮进入全局上下文；与原版 build_mood_hint 对齐，全局版不针对单会话迁怒）----
  buildHint(): string {
    this.decay(Date.now());
    const mood = this.state.mood;
    const label = this.labelActive();
    if (!label && Math.abs(mood) < 3.0) return '';
    const lines: string[] = [];
    if (label) {
      const deg = DEGREE_WORD[label.strength] || '';
      let head = `【此刻你的心情】${label.name}`;
      if (deg) head += `（${deg}）`;
      lines.push(head);
      // 起因：归到具体的人（取最近 2 小时内的情绪事件）
      const now = Date.now();
      for (const ev of [...this.state.events].reverse()) {
        if (now - ev.ts < 7_200_000 && ev.why) {
          lines.push(`起因：${causeText(ev.user, ev.why)}`);
          break;
        }
      }
      const behavior = LABEL_BEHAVIOR[label.name];
      if (behavior) lines.push(`情绪指引：${behavior}`);
      const negative = (LABEL_IMPACT[label.name] ?? 0) < 0;
      if (negative && label.by) {
        lines.push(`注意：这份情绪是 ${label.by} 引起的，若眼前的人不是 TA，不要迁怒，正常交流。`);
      }
      if (negative && label.strength >= 2) {
        lines.push('状态是状态，事是事：正经问题照样好好答，别拿情绪当借口摆烂。');
      }
      const extra = derivedMoodLine(this.state);
      if (extra) lines.push(`底色：${extra}`);
    } else {
      const head = mood > 0 ? '心情很好' : mood > -6.5 ? '心情不太好' : '心情很差';
      lines.push(`【此刻你的心情】${head}`);
      const extra = derivedMoodLine(this.state);
      if (extra) lines.push(`情绪指引：${extra}`);
    }
    return lines.join('\n');
  }

  // ---- /心情 查询（与原版 describe_mood 对齐）----
  isQuery(text: string): boolean {
    const t = (text || '').trim().replace(/[？?！!。~ ]+$/g, '');
    if (!t || t.length > 30) return false;
    if (!MOOD_QUERY_WORDS.some((w) => t.includes(w))) return false;
    const secondPerson = t.includes('你') || t.includes('您');
    const firstPerson = /我(?!们)/.test(t);
    if (firstPerson && !secondPerson) return false; // 在说用户自己的心情，别抢答
    return secondPerson || /(吗|么|呢|怎么样|咋样|如何)$/.test(t);
  }

  describe(): string {
    this.decay(Date.now());
    const mood = this.state.mood;
    const label = this.labelActive();
    const events = this.state.events;
    if (!label && Math.abs(mood) < 3.0) {
      return '我现在心情挺平静的。';
    }
    // 起因：优先取与主导情绪同一个人最近 2 小时内的事件
    let cause: MoodEvent | null = null;
    const by = label?.by ?? '';
    for (const ev of [...events].reverse()) {
      if (Date.now() - ev.ts < 7_200_000) {
        if (by && ev.user === by) { cause = ev; break; }
        if (!cause) cause = ev;
      }
    }
    if (label) {
      const name = label.name;
      const deg = DEGREE_PHRASE[label.strength] || '有点';
      // "被暖到/被逗乐"是状态词，前面加"很/超级"不通（"很被暖到"），这类不加程度词
      const stateWord = name.startsWith('被');
      let head = stateWord ? `我现在${name}` : `我现在${deg}${name}`;
      const cp = moodCausePhrase(name, cause);
      if (cp) head += `，${cp}`;
      return `${head}。`;
    }
    if (mood >= 6.5) return '我现在心情很好。';
    if (mood >= 3.0) return '我现在心情还不错。';
    if (mood > -3.0) return '心情一般，谈不上好也谈不上坏。';
    if (mood > -6.5) return '我现在心情有点闷，不太想多说话。';
    return '我现在心情很差。';
  }

  stop(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.saveNow();
  }
}

// 无主导情绪标签时，按心情值底色生成一句话（中性返回空）。
// 只写"她现在处在什么状态"，不写"该怎么演"——怎么表现由她的宪法和记忆决定，
// 这段代码不是她的性格说明书（这一条曾经写成"对主人可以撒娇、小请求爽快答应"，已改）。
function derivedMoodLine(st: MoodState): string {
  const m = st.mood;
  if (m >= 6.5) return '心情值很高：话会比平时多，什么事都愿意应一声。';
  if (m >= 3.0) return '心情不错：语气比平时轻快。';
  if (m > -3.0) return '';
  if (m > -6.5) return '心里有点闷：话会少一点，也没那么有耐心。';
  return '心情很差：不想说话，除了正事之外提不起劲。';
}

// 把最近一条情绪事件转成口语化的「归人原因」半句
function moodCausePhrase(label: string, cause: MoodEvent | null): string {
  if (!cause) return '';
  const who = cause.user;
  const why = cause.why;
  const verb = (LABEL_IMPACT[label] ?? 0) < 0 ? '都怪' : '多亏了';
  if (!who) return why;
  if (!why) return `${verb}${who}`;
  return `${verb}${causeText(who, why)}`;
}

function parseMood(raw: string | null): MoodInfo | null {
  if (!raw) return null;
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const open = s.indexOf('{');
  const close = s.lastIndexOf('}');
  if (open < 0 || close < open) return null;
  try {
    const obj = JSON.parse(s.slice(open, close + 1)) as Record<string, unknown>;
    const emotion = typeof obj.emotion === 'string' ? obj.emotion : '';
    if (!emotion || !(emotion in LABEL_IMPACT)) return null;
    const strength = clamp(Number(obj.strength) || 1, 1, 3);
    const why = typeof obj.why === 'string' ? obj.why.slice(0, 40) : '';
    return { emotion, strength, why };
  } catch {
    return null;
  }
}
