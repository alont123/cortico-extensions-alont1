/**
 * 梗 World：本地梗库优先，没命中才联网搜；带接龙真假判定和频率限制。
 *
 * 设计要点：
 *  - 本地库（种子 + 自己记的）命中不联网、不占额度，响应快。
 *  - 联网搜兜底：萌娘百科 API → Bing 网页 → 都失败就诚实说查不到。
 *  - 频率限制只卡「联网搜索」：最短间隔、每小时、每天。超了直接告诉她先别查。
 *  - meme_chain 用来验接龙：给候选下一句，返回真的/假的/不知道，避免把陷阱梗当真。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type { PromptVarDecl, ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { MEME_CONFIG_GROUP, type MemeConfigSection } from './config.ts';
import { SEED_MEMES, type MemeFollowup, type SeedMeme } from './data.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface StoredMeme extends SeedMeme {
  /** 来源：seed=内置，self=她自己记的 */
  from: 'seed' | 'self';
  createdAt?: string;
}

interface UsageFile {
  /** 每次联网搜索的时间戳（毫秒） */
  searches: number[];
  /** 每天计数：日期 → 次数 */
  days: Record<string, number>;
}

export const MEME_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'meme_search',
    tags: ['read'],
    description:
      '查一个网络梗/缩写/黑话是什么意思、怎么来的。先查本地梗库，没命中才联网（受频率限制）。'
      + '返回：全称、含义、出处、常见接龙、语气，以及来源链接。查到的梗可以用 meme_note 记下来，下次不用再查。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        q: { type: 'string', description: '要查的梗：缩写（如 KSKBL）、全称或一句描述。' },
        web: { type: 'boolean', description: '本地没命中时是否允许联网搜（默认 true）。' },
      },
      required: ['q'],
    },
  },
  {
    name: 'meme_chain',
    tags: ['read'],
    description:
      '验接龙：给一个梗和（可选的）你想接的下一句，判断这个接法是真是假。'
      + '只给梗名时，返回这个梗的常见下一句。别把「真的假的」这类当普通问句答，先用它验一下。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        q: { type: 'string', description: '梗名/缩写，比如 KSKBL。' },
        candidate: { type: 'string', description: '你想接的那一句；不填就返回常见接龙。' },
      },
      required: ['q'],
    },
  },
  {
    name: 'meme_note',
    tags: ['write'],
    description:
      '把一个梗记进本地梗库（自己学到的/网上查到的）。记清了下次直接命中，不用反复查。'
      + '记的是「在你们这儿这梗怎么用」，不是百科抄录。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        q: { type: 'string', description: '梗名或缩写（主键）。' },
        full: { type: 'string', description: '全称/完整说法。' },
        meaning: { type: 'string', description: '含义与用法（一两句，写清场景和语气）。' },
        origin: { type: 'string', description: '出处（可选，不确定可不填）。' },
        followups: { type: 'string', description: '常见接龙，逗号分隔；分不清真假就不用填（可选）。' },
        source: { type: 'string', description: '来源链接或出处（可选）。' },
      },
      required: ['q', 'meaning'],
    },
  },
  {
    name: 'meme_stats',
    tags: ['read'],
    description: '看查梗用量：今天联网搜了几次、本小时几次、还剩多少额度。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];

/** 归一化：去空白、转小写、全角标点转半角。 */
function norm(s: string): string {
  return String(s ?? '')
    .replace(/[\u3000\s]+/g, '')
    .replace(/[，。！？、；：""''（）【】]/g, (m) => ({ '，': ',', '。': '.', '！': '!', '？': '?', '、': ',', '；': ';', '：': ':', '“': '"', '”': '"', '‘': "'", '’': "'", '（': '(', '）': ')', '【': '[', '】': ']' } as Record<string, string>)[m] ?? m)
    .toLowerCase();
}

/** A stored followup may name an abbreviation and its expansion in parentheses. */
function followupMatches(text: string, candidate: string): boolean {
  const normalized = norm(text);
  if (normalized === candidate) return true;
  const parts = /^([^()]+)\(([^()]+)\)$/.exec(normalized);
  return parts !== null && (parts[1] === candidate || parts[2] === candidate);
}

function stripHtml(s: string): string {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function todayKey(timezone: string): string {
  // 用本地日期即可：部署与机器时区一致，跨时区误差可接受。
  const d = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return get('year') + '-' + get('month') + '-' + get('day');
}

export class MemeWorld implements World {
  readonly id = 'meme';
  private readonly cfg: MemeConfigSection;
  private readonly dataDir: string;
  private readonly timezone: string;
  private host: WorldHost | null = null;
  private memes: StoredMeme[] = [];
  private usage: UsageFile = { searches: [], days: {} };
  private readonly memesFile: string;
  private readonly usageFile: string;

  constructor(opts: { cfg: MemeConfigSection; dataDir: string; timezone: string }) {
    this.cfg = opts.cfg;
    this.dataDir = opts.dataDir;
    this.timezone = opts.timezone || 'Asia/Shanghai';
    const dir = join(opts.dataDir, 'meme');
    this.memesFile = join(dir, 'memes.json');
    this.usageFile = join(dir, 'usage.json');
  }

  // ── 持久化 ──────────────────────────────────────────────────────────────

  private load(): void {
    try {
      if (existsSync(this.memesFile)) {
        const raw = JSON.parse(readFileSync(this.memesFile, 'utf8')) as { memes?: StoredMeme[] };
        if (Array.isArray(raw.memes)) this.memes = raw.memes.filter((m) => m && typeof m.id === 'string');
      }
    } catch { this.memes = []; }
    try {
      if (existsSync(this.usageFile)) {
        const raw = JSON.parse(readFileSync(this.usageFile, 'utf8')) as UsageFile;
        if (raw && Array.isArray(raw.searches) && raw.days && typeof raw.days === 'object') this.usage = raw;
      }
    } catch { this.usage = { searches: [], days: {} }; }
  }

  private saveMemes(): void {
    try {
      mkdirSync(dirname(this.memesFile), { recursive: true });
      writeFileSync(this.memesFile, JSON.stringify({ version: 1, memes: this.memes }, null, 2), 'utf8');
    } catch (e) { this.host?.log.warn('梗库写入失败: ' + String(e)); }
  }

  private saveUsage(): void {
    try {
      mkdirSync(dirname(this.usageFile), { recursive: true });
      // 只保留最近 48 小时的搜索记录
      const cutoff = Date.now() - 48 * 3600_000;
      this.usage.searches = this.usage.searches.filter((t) => t >= cutoff);
      // 只保留最近 7 天计数
      const days = Object.keys(this.usage.days).sort();
      for (const d of days.slice(0, Math.max(0, days.length - 7))) delete this.usage.days[d];
      writeFileSync(this.usageFile, JSON.stringify(this.usage, null, 2), 'utf8');
    } catch (e) { this.host?.log.warn('梗用量写入失败: ' + String(e)); }
  }

  // ── 查询 ────────────────────────────────────────────────────────────────

  private allMemes(): StoredMeme[] {
    const selfIds = new Set(this.memes.map((m) => norm(m.id)));
    return [...this.memes, ...SEED_MEMES.filter((s) => !selfIds.has(norm(s.id))).map((s) => ({ ...s, followups: s.followups ?? [], from: 'seed' as const }))];
  }

  private find(q: string): StoredMeme | null {
    const n = norm(q);
    if (!n) return null;
    const list = this.allMemes();
    const exact = list.find((m) => norm(m.id) === n || (m.abbr && norm(m.abbr) === n) || norm(m.full) === n || (m.aliases ?? []).some((a) => norm(a) === n));
    if (exact) return exact;
    // 长句包含匹配
    const contains = list.find((m) => n.length >= 2 && (norm(m.full).includes(n) || norm(m.meaning).includes(n) || (m.aliases ?? []).some((a) => norm(a).includes(n) || n.includes(norm(a)))));
    return contains ?? null;
  }

  /** 联网额度检查：返回 null 表示允许，否则返回拒绝原因。 */
  private rateLimit(): string | null {
    const now = Date.now();
    const day = todayKey(this.timezone);
    const dayCount = this.usage.days[day] ?? 0;
    if (this.cfg.dailyCap > 0 && dayCount >= this.cfg.dailyCap) {
      return '今天联网查梗的额度用完了（' + dayCount + '/' + this.cfg.dailyCap + '），先凭我知道的接，别硬查。';
    }
    if (this.cfg.hourlyCap > 0) {
      const hourAgo = now - 3600_000;
      const hourCount = this.usage.searches.filter((t) => t >= hourAgo).length;
      if (hourCount >= this.cfg.hourlyCap) return '这一小时已经查了 ' + hourCount + ' 次梗，先歇一会儿，凭印象接。';
    }
    if (this.cfg.minIntervalSec > 0 && this.usage.searches.length) {
      const last = this.usage.searches[this.usage.searches.length - 1]!;
      const wait = Math.ceil((this.cfg.minIntervalSec * 1000 - (now - last)) / 1000);
      if (wait > 0) return '刚查过梗，' + wait + ' 秒后再查；先接话。';
    }
    return null;
  }

  private recordSearch(): void {
    const now = Date.now();
    this.usage.searches.push(now);
    const day = todayKey(this.timezone);
    this.usage.days[day] = (this.usage.days[day] ?? 0) + 1;
    this.saveUsage();
  }

  // ── 联网搜索 ────────────────────────────────────────────────────────────

  private async fetchJson(url: string): Promise<any> {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(this.cfg.fetchTimeoutMs) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  private async fetchText(url: string): Promise<string> {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(this.cfg.fetchTimeoutMs) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  }

  /** 萌娘百科搜索：返回 {title, snippet, url}[]。 */
  private async moegirl(q: string): Promise<Array<{ title: string; snippet: string; url: string }>> {
    const url = 'https://zh.moegirl.org.cn/api.php?action=query&list=search&srsearch=' + encodeURIComponent(q) + '&srlimit=4&format=json&utf8=1';
    const j = await this.fetchJson(url);
    const out: Array<{ title: string; snippet: string; url: string }> = [];
    for (const r of j?.query?.search ?? []) {
      const title = String(r.title ?? '').trim();
      const snippet = stripHtml(String(r.snippet ?? ''));
      if (title) out.push({ title, snippet, url: 'https://zh.moegirl.org.cn/' + encodeURIComponent(title) });
    }
    return out;
  }

  /** Bing 网页搜索兜底：解析 b_algo 块。 */
  private async bing(q: string): Promise<Array<{ title: string; snippet: string; url: string }>> {
    const html = await this.fetchText('https://cn.bing.com/search?q=' + encodeURIComponent(q + ' 是什么梗 出处') + '&setlang=zh-CN&ensearch=0');
    const out: Array<{ title: string; snippet: string; url: string }> = [];
    const re = /<li class="b_algo"[\s\S]*?<\/li>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && out.length < 4) {
      const block = m[0];
      const tm = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      const pm = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      if (tm) {
        out.push({ title: stripHtml(tm[2]!), snippet: pm ? stripHtml(pm[1]!) : '', url: tm[1]! });
      }
    }
    return out;
  }

  private async webSearch(q: string): Promise<Array<{ title: string; snippet: string; url: string }>> {
    const tries: Array<() => Promise<Array<{ title: string; snippet: string; url: string }>>> = [
      () => this.moegirl(q),
      () => this.bing(q),
    ];
    for (const t of tries) {
      try {
        const r = await t();
        if (r.length) return r;
      } catch { /* 换下一个源 */ }
    }
    return [];
  }

  // ── 输出格式 ────────────────────────────────────────────────────────────

  private formatMeme(m: StoredMeme, opts: { source?: string } = {}): string {
    const lines: string[] = [];
    lines.push('【' + (m.abbr || m.id) + '】' + m.full);
    lines.push('含义：' + m.meaning);
    if (m.origin) lines.push('出处：' + m.origin);
    if (m.tone) lines.push('语气：' + m.tone);
    if (m.followups?.length) {
      lines.push('常见接龙：');
      for (const f of m.followups) lines.push('  - ' + f.text + '（' + (f.real ? '真·常用接法' : '假·别用') + '）' + (f.note ? ' —— ' + f.note : ''));
    }
    if (m.source) lines.push('来源：' + m.source);
    lines.push('（' + (opts.source ?? (m.from === 'seed' ? '本地梗库' : '她自己记的')) + '）');
    return lines.join('\n');
  }

  // ── 工具实现 ────────────────────────────────────────────────────────────

  private async searchTool(args: Record<string, unknown>): Promise<string> {
    const q = String(args.q ?? '').trim();
    if (!q) return '要给个梗名才能查。';
    const hit = this.find(q);
    if (hit) return this.formatMeme(hit);
    if (args.web === false) return '本地梗库没有「' + q + '」。要去网上查就再调一次（web 不关），或者让我用 web_find 查。';
    const block = this.rateLimit();
    if (block) return '本地没有「' + q + '」。' + block;
    this.recordSearch();
    const results = await this.webSearch(q);
    if (!results.length) return '本地没有「' + q + '」，联网也没搜到能用的材料。别硬编出处；可以说「这梗我没跟上」，或者先看别人怎么用。';
    const lines = ['本地没收录「' + q + '」，联网查到的材料（自己判断真伪，别照抄）：'];
    for (const r of results.slice(0, 4)) {
      lines.push('- ' + r.title + (r.snippet ? '：' + r.snippet.slice(0, 180) : ''));
      if (r.url) lines.push('  ' + r.url);
    }
    lines.push('（联网查梗 · 今天第 ' + (this.usage.days[todayKey(this.timezone)] ?? 1) + '/' + this.cfg.dailyCap + ' 次）');
    return lines.join('\n');
  }

  private chainTool(args: Record<string, unknown>): string {
    const q = String(args.q ?? '').trim();
    if (!q) return '要给个梗名才能验接龙。';
    const candidate = String(args.candidate ?? '').trim();
    const meme = this.find(q);
    if (!meme) return '本地梗库里没有「' + q + '」，没法判断接龙真假。先 meme_search 查一下这个梗。';
    const followups = meme.followups ?? [];
    if (!candidate) {
      if (!followups.length) return '【' + meme.full + '】没有记录常见接龙；它一般就是单独用的。';
      return '【' + meme.full + '】常见接龙：\n' + followups.map((f) => '- ' + f.text + '（' + (f.real ? '真·常用' : '假·别用') + '）' + (f.note ? ' —— ' + f.note : '')).join('\n');
    }
    const nc = norm(candidate);
    const exact = followups.find((f) => followupMatches(f.text, nc));
    if (exact) return (exact.real ? '接得上，是真的：' + exact.note : '这个接法是假的/别用：' + exact.note) + '\n（梗：【' + meme.full + '】）';
    // 没在库里：给候选对照
    return '本地没有把「' + candidate + '」记成【' + meme.full + '】的接法——可能是别家的梗，也可能是编的。'
      + (followups.length ? '\n库里的接龙：' + followups.map((f) => f.text + (f.real ? '（真）' : '（假）')).join('、') : '')
      + '\n拿不准就先搜一下，或者直说「这梗我没跟上」。';
  }

  private noteTool(args: Record<string, unknown>): string {
    const q = String(args.q ?? '').trim();
    const meaning = String(args.meaning ?? '').trim();
    if (!q || !meaning) return '至少要给梗名和含义（q、meaning）。';
    const full = String(args.full ?? q).trim();
    const origin = String(args.origin ?? '').trim();
    const source = String(args.source ?? '').trim();
    const followupsRaw = String(args.followups ?? '').trim();
    const followups: MemeFollowup[] = followupsRaw
      ? followupsRaw.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean).map((text) => ({ text, real: true, note: '' }))
      : [];
    const id = norm(q);
    const entry: StoredMeme = { id, aliases: [q, full], abbr: /^[a-zA-Z]{2,10}$/.test(q) ? q.toUpperCase() : undefined, full, meaning, origin: origin || '（她自己记的，出处未记）', followups, tone: '', source: source || '（自己记的）', from: 'self', createdAt: nowIso(this.timezone) };
    const idx = this.memes.findIndex((m) => norm(m.id) === id);
    if (idx >= 0) this.memes[idx] = { ...this.memes[idx], ...entry, createdAt: this.memes[idx]!.createdAt ?? entry.createdAt };
    else this.memes.push(entry);
    // 上限
    if (this.memes.length > 300) this.memes = this.memes.slice(-300);
    this.saveMemes();
    return '已记下【' + full + '】：' + meaning.slice(0, 80);
  }

  private statsTool(): string {
    const hourAgo = Date.now() - 3600_000;
    const hourCount = this.usage.searches.filter((t) => t >= hourAgo).length;
    const day = todayKey(this.timezone);
    const dayCount = this.usage.days[day] ?? 0;
    return '查梗用量：今天联网 ' + dayCount + '/' + this.cfg.dailyCap + ' 次，本小时 ' + hourCount + '/' + this.cfg.hourlyCap + ' 次；本地梗库 ' + this.allMemes().length + ' 条（自己记的 ' + this.memes.length + ' 条）。';
  }

  // ── World 契约 ──────────────────────────────────────────────────────────

  envPromptVars(): Record<string, string> {
    const day = todayKey(this.timezone);
    const dayCount = this.usage.days[day] ?? 0;
    return {
      'meme.usageLine': '今天联网查梗 ' + dayCount + '/' + this.cfg.dailyCap + ' 次；本地梗库 ' + this.allMemes().length + ' 条。',
    };
  }

  tools(): ToolDef[] {
    return [
      { ...MEME_TOOL_DECLS[0]!, handler: async (args) => { try { return await this.searchTool(args as Record<string, unknown>); } catch (e) { return '查梗失败：' + String((e as Error)?.message ?? e) + '（先凭你知道的接，别硬编）'; } } },
      { ...MEME_TOOL_DECLS[1]!, handler: async (args) => { try { return this.chainTool(args as Record<string, unknown>); } catch (e) { return '验接龙失败：' + String((e as Error)?.message ?? e); } } },
      { ...MEME_TOOL_DECLS[2]!, handler: async (args) => { try { return this.noteTool(args as Record<string, unknown>); } catch (e) { return '记梗失败：' + String((e as Error)?.message ?? e); } } },
      { ...MEME_TOOL_DECLS[3]!, handler: async () => this.statsTool() },
    ];
  }

  webUi(_language?: Language): WorldWebUiDecl {
    return {
      label: '梗',
      lamps: [{ label: '梗库', state: 'online', hint: '本地 ' + this.allMemes().length + ' 条' }],
      badges: [{ label: '今日联网', value: (this.usage.days[todayKey(this.timezone)] ?? 0) + '/' + this.cfg.dailyCap, tone: 'plain' }],
      config: [MEME_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.meme.envPrompt',
          title: '梗 · 环境提示词',
          description: '告诉她什么时候查梗、怎么接、怎么不硬编。这段进系统前缀。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [{ name: 'meme.usageLine', description: '今天查梗用量与本地梗库条数。' }] as PromptVarDecl[],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.load();
    host.log.info('梗 World 已就绪：本地 ' + this.allMemes().length + ' 条，今天联网 ' + (this.usage.days[todayKey(this.timezone)] ?? 0) + ' 次');
  }

  async stop(): Promise<void> {
    this.saveMemes();
    this.saveUsage();
  }
}
