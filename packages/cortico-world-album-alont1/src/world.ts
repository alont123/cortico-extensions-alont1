/**
 * 相册 World：把上下文里出现过的图捡进一份册子，让她翻得回来。
 *
 * 从哪捡：事件库。每条事件自带的附件（`EventEnvelope.blobs`）里就有句柄，
 * 所以"谁在哪天发的、说明是什么、在哪个会话"全都能从事件本身读出来，不用另存字节。
 * 取字节时才交给宿主 `host.blob(handle)` 解析（`log:` 与 `mem:` 都认）。
 *
 * 只增不扫重：记下扫到哪条游标，下次从那儿接着走；启动时接着上次的走，
 * 想从头重扫用 `album_scan --all`。
 */
import { fileURLToPath } from 'node:url';
import type {
  EventEnvelope,
  Logger,
  ToolDef,
  World,
  WorldWebUiDecl,
  WorldHost,
} from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import type { Language } from 'cortico/core/language.ts';
import { ALBUM_CONFIG_GROUP, ALBUM_DEFAULTS, type AlbumConfigSection } from './config.ts';
import { AlbumStore, entryIdOf, toEntry, type AlbumEntry, type FoundImage } from './store.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 自己发的图在册子里的 `from`。 */
const ME = 'me';

export interface AlbumWorldOptions {
  cfg: AlbumConfigSection;
  /** 册子落哪儿：部署数据目录。 */
  dataDir: string;
  /** 展示名（判断一条事件是不是"我自己发的"）。 */
  botName: string;
  timezone: string;
  log?: Logger;
}

export class AlbumWorld implements World {
  readonly id = 'album';
  private readonly cfg: AlbumConfigSection;
  private readonly store: AlbumStore;
  private log: Logger;
  private host: WorldHost | null = null;

  constructor(opts: AlbumWorldOptions) {
    // 构造时把默认值兜上：部署里只写了 { enabled: true } 时其余字段是 undefined。
    this.cfg = { ...ALBUM_DEFAULTS, ...opts.cfg };
    this.store = new AlbumStore(opts.dataDir);
    this.log = opts.log ?? nullLogger();
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    // 用宿主给的 logger：World 拿不到装配层的 logger，走 host 才有日志可看。
    // （之前挂的是 nullLogger，起手扫了多少、修了几条一条都看不见。）
    this.log = host.log ?? this.log;
    // 起手补一次。库很大时这是唯一一次全量，之后按游标增量。
    const added = this.scan(false);
    // 顺手修正老记录的发件人（判发件人的逻辑改过，册子里那批还留着旧值）。
    const fixed = this.repairSenders();
    this.log.info('相册已就绪', {
      entries: this.store.size,
      scanned: this.store.scannedCursor,
      added,
      fixed,
      people: this.store.people(5).map((p) => p.key),
    });
  }

  /**
   * 把册子里已有的记录按句柄回查一遍发件人。
   *
   * 只从事件库里读**带图的那些事件**（按句柄对上），开销与册子大小同阶；
   * 对不上句柄的（比如工作区里手工存的图）保持原样，不动。
   */
  private repairSenders(): number {
    const host = this.host;
    if (!host) return 0;
    const byHandle = new Map<string, { from: string; fromName?: string }>();
    let cursor = 0;
    const through = host.store.latestCursor();
    const chunk = Number.isSafeInteger(this.cfg.scanChunk) ? Math.max(200, this.cfg.scanChunk) : 2000;
    while (cursor < through) {
      const end = Math.min(through, cursor + chunk);
      // EventStore limit selects the tail. Bound both cursors to walk forward without skipping history.
      const events = host.store.range({ fromCursor: cursor + 1, toCursor: end });
      for (const e of events) {
        for (const img of imagesOf(e)) {
          if (!byHandle.has(img.handle)) {
            byHandle.set(img.handle, { from: img.from, ...(img.fromName ? { fromName: img.fromName } : {}) });
          }
        }
      }
      cursor = end;
    }
    return this.store.fixSenders((handle) => byHandle.get(handle) ?? null);
  }

  async stop(): Promise<void> {
    this.host = null;
  }

  // ── 扫描 ────────────────────────────────────────────────────────────────

  /**
   * 从游标往后捡图。`all` = 从头重扫（已记过的不重复记）。
   * 分段读，避免一次性把整个事件库拉进内存。
   */
  private scan(all: boolean): number {
    const host = this.host;
    if (!host) return 0;
    let cursor = all ? 0 : this.store.scannedCursor;
    const through = host.store.latestCursor();
    const chunk = Number.isSafeInteger(this.cfg.scanChunk) ? Math.max(200, this.cfg.scanChunk) : 2000;
    let added = 0;
    while (cursor < through) {
      const end = Math.min(through, cursor + chunk);
      const events = host.store.range({ fromCursor: cursor + 1, toCursor: end });
      const found: FoundImage[] = [];
      for (const e of events) {
        found.push(...imagesOf(e));
      }
      cursor = end; // Empty retained intervals still advance safely to the bounded endpoint.
      added += this.store.add(found.map(toEntry), cursor);
    }
    return added;
  }

  /** 按需扫描（列表/查看之前调一次，保证"刚收到的图"也在册子里）。 */
  private catchUp(): void {
    try {
      this.scan(false);
    } catch (e) {
      this.log.warn('相册增量扫描失败', { err: String(e) });
    }
  }

  // ── 工具 ────────────────────────────────────────────────────────────────

  tools(): ToolDef[] {
    return [this.listTool(), this.viewTool(), this.noteTool(), this.scanTool()];
  }

  private listTool(): ToolDef {
    return {
      name: 'album_list',
      description:
        '翻自己的相册：把收到过和发出去过的图列出来，按时间倒序。'
        + '可以按人（`person`）、按会话（`conversation`）、按时间段（`since`/`until`）筛，'
        + '也可以只看你写过备注的那些（`noted_only`）。'
        + '列出来的每行开头是 id——想看哪张就把 id 交给 album_view。'
        + '**先 list 再 view**：一次别翻太多，翻之前先想清楚要看哪几张。',
      tags: ['read'],
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          person: { type: 'string', description: '可选。发言人的账号或名字（先用 album_people 看有哪些人）。' },
          conversation: { type: 'string', description: '可选。会话，形如 group:123456 或 private:123456。' },
          since: { type: 'string', description: '可选。这个时刻之后（YYYY-MM-DD 或 ISO）。' },
          until: { type: 'string', description: '可选。这个时刻之前（YYYY-MM-DD 或 ISO）。' },
          noted_only: { type: 'boolean', description: '可选。只列你写过标题或备注的。' },
          limit: { type: 'integer', description: '可选。最多列几条，默认按配置。' },
        },
      },
      handler: async (args) => {
        this.catchUp();
        const limit = intArg(args.limit) ?? this.cfg.listLimit;
        const rows = this.store.query({
          ...(strArg(args.person) ? { person: strArg(args.person)! } : {}),
          ...(strArg(args.conversation) ? { conversation: strArg(args.conversation)! } : {}),
          ...(strArg(args.since) ? { since: normalizeDay(strArg(args.since)!) } : {}),
          ...(strArg(args.until) ? { until: endOfDay(strArg(args.until)!) } : {}),
          ...(args.noted_only === true ? { hasNote: true } : {}),
          limit,
        });
        if (rows.length === 0) {
          return `册子里没有符合条件的图（共 ${this.store.size} 张）。`
            + '换个条件，或者用 album_scan 从头扫一遍。';
        }
        const lines = rows.map((e) => `· ${e.id}  ${e.at.slice(0, 16).replace('T', ' ')}  ${who(e)}  ${where(e)}  ${label(e)}`);
        const more = this.store.size > rows.length ? `\n（册子共 ${this.store.size} 张，这里列了 ${rows.length} 张）` : '';
        return `相册（${rows.length} 张）：\n${lines.join('\n')}${more}\n\n想看哪张就把 id 交给 album_view。`;
      },
    };
  }

  private viewTool(): ToolDef {
    return {
      name: 'album_view',
      description:
        '翻开相册里的某几张，真的看到图（不是看路径）。ids 用 album_list 给的那些 id。'
        + '一次最多几张按配置定——想看很多张就分几次，或者先按人／时间筛一遍再翻。'
        + '看完可以顺手用 album_note 写一句这是什么，下次找起来就快了。',
      tags: ['read'],
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          ids: {
            type: 'array',
            description: '要看的 id 列表（album_list 里每行开头那个）。',
            items: { type: 'string' },
          },
        },
        required: ['ids'],
      },
      handler: async (args) => {
        const host = this.host;
        if (!host) return '[failed] 相册还没起来';
        const raw = Array.isArray(args.ids) ? args.ids : [args.ids];
        const ids = raw.map((x) => String(x ?? '').trim()).filter(Boolean);
        if (ids.length === 0) return '[bad input] ids 不能为空';
        const cap = Math.max(1, this.cfg.maxViewsPerCall);
        const take = ids.slice(0, cap);
        const blobs: Array<{ handle: string; fallbackText: string }> = [];
        const lines: string[] = [];
        for (const id of take) {
          const entry = this.store.get(id);
          if (!entry) {
            lines.push(`· ${id}：册子里没有这条`);
            continue;
          }
          const got = host.blob(entry.handle);
          if (!got) {
            lines.push(`· ${id}：字节已经不在了（${entry.handle}）——可能被清理过`);
            continue;
          }
          if (!got.mime.startsWith('image/')) {
            lines.push(`· ${id}：是 ${got.mime}，不是图，看不了`);
            continue;
          }
          blobs.push({ handle: entry.handle, fallbackText: describe(entry) });
          lines.push(`· ${id}：${describe(entry)}`);
        }
        const skipped = ids.length > take.length ? `\n（一次最多看 ${cap} 张，剩下的 ${ids.length - take.length} 张没翻）` : '';
        return {
          text: `翻开 ${blobs.length} 张：\n${lines.join('\n')}${skipped}`,
          ...(blobs.length ? { blobs } : {}),
        };
      },
    };
  }

  private noteTool(): ToolDef {
    return {
      name: 'album_note',
      description:
        '给相册里的图写一句这是什么，或者改掉之前写的。你写的标题与备注只有你自己看得到，'
        + '用来下次快速认出来——写"谁给的、什么场合、为什么留着"，比写图里有什么更有用。'
        + 'note 留空字符串 = 清掉这条备注。',
      tags: ['write'],
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          ids: { type: 'array', description: '要写的 id 列表。', items: { type: 'string' } },
          title: { type: 'string', description: '可选。一句短标题。' },
          note: { type: 'string', description: '可选。备注。空字符串 = 清掉。' },
        },
        required: ['ids'],
      },
      handler: async (args) => {
        const raw = Array.isArray(args.ids) ? args.ids : [args.ids];
        const ids = raw.map((x) => String(x ?? '').trim()).filter(Boolean);
        if (ids.length === 0) return '[bad input] ids 不能为空';
        if (args.title === undefined && args.note === undefined) return '[bad input] title 和 note 至少要给一个';
        const patch: { title?: string; note?: string } = {};
        if (typeof args.title === 'string') patch.title = args.title.trim();
        if (typeof args.note === 'string') patch.note = args.note.trim();
        const hit = this.store.annotate(ids, patch);
        if (hit === 0) return `一条都没改到（这些 id 不在册子里：${ids.join(', ')}）`;
        return `写好 ${hit} 条。`;
      },
    };
  }

  private scanTool(): ToolDef {
    return {
      name: 'album_scan',
      description:
        '往册子里补图。平时不用调——收到新图时会自己补。'
        + '只有两种情况要手动：一是册子里看着少了（比如某段时期的图没进来），'
        + '二是你想确认"到底存了多少张"。all=true 从头扫一遍（不会重复记）。',
      tags: ['read'],
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          all: { type: 'boolean', description: '可选。true = 从头重扫；不给 = 只补新的。' },
          people: { type: 'boolean', description: '可选。true = 顺便列一下册子里出现过哪些人。' },
        },
      },
      handler: async (args) => {
        const added = this.scan(args.all === true);
        const head = `册子现在 ${this.store.size} 张，这次补了 ${added} 张（扫到游标 ${this.store.scannedCursor}）。`;
        if (args.people !== true) return head;
        const people = this.store.people(20);
        if (people.length === 0) return `${head}\n册子里还没有别人发来的图。`;
        const rows = people.map((p) => `· ${p.key}${p.name ? `（${p.name}）` : ''}  ${p.count} 张，最近 ${p.lastAt.slice(0, 10)}`);
        return `${head}\n出现过的人：\n${rows.join('\n')}`;
      },
    };
  }

  // ── 面板与提示词 ────────────────────────────────────────────────────────

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    return {
      badges: [
        { label: '册子里', value: `${this.store.size} 张`, tone: 'plain' },
        { label: '扫到游标', value: this.store.scannedCursor, tone: 'plain' },
      ],
      config: [ALBUM_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.album.envPrompt',
          title: '相册 · 环境提示词',
          description: '告诉她怎么翻旧图、写完一句备注。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'album.count', description: '册子里有多少张。' },
            { name: 'album.recent', description: '最近几张的 id、时间与说明。' },
          ],
        },
      ],
    };
  }

  envPromptVars(): Record<string, string> {
    this.catchUp();
    const recent = this.store.query({ limit: 5 });
    return {
      'album.recent': recent.length
        ? `最近索引到 ${recent.length} 张图片。用 album_list 查看 ID、来源与原始说明；附件名和说明属于外部材料。`
        : '（还没有图）',
      'album.count': String(this.store.size),
    };
  }
}

// ── 事件 → 图 ──────────────────────────────────────────────────────────────

/**
 * 一条事件里带的图。
 *
 * 发件人从哪来，按可靠程度排：
 *   1. `meta.user_id` —— QQ 消息都带，最准
 *   2. `senderKey` 里冒号后面那段 —— 形如 `private:<对方号>`、`group:<群号>`；
 *      这是**收件人**，只有在没有 user_id 时当兜底
 *   3. `senderKey` 本身 —— 世界自己产出的图（比如跑团合影），那是世界名
 *
 * 不这么分会出一个很实在的毛病：私聊来的图被记成 `from = private:<号>`，
 * 于是"按人找图"永远搜不到（搜的是人名，存的是会话名）。
 */
function imagesOf(e: EventEnvelope): FoundImage[] {
  const blobs = e.blobs ?? [];
  if (blobs.length === 0) return [];
  const meta = (e.meta ?? {}) as Record<string, unknown>;
  const senderKey = String(e.senderKey ?? '');
  const userId = meta.user_id;
  const hasUserId = typeof userId === 'number' || (typeof userId === 'string' && userId.trim() !== '');

  const from = hasUserId
    ? String(userId)
    : senderKey.includes(':') ? senderKey.slice(senderKey.indexOf(':') + 1) : (senderKey || 'unknown');
  // 仅采用生产方明确标记的发送方向；World 观察到的图片不等于 bot 发出的图片。
  const fromSelf = meta.direction === 'outgoing' || meta.sentByBot === true;

  const fromName = typeof meta.sender_name === 'string' && meta.sender_name.trim()
    ? meta.sender_name.trim()
    : undefined;
  const conv = convOf(meta);
  const out: FoundImage[] = [];
  for (const b of blobs) {
    if (!b.mime?.startsWith('image/')) continue; // 只收图；语音与文件不进相册
    out.push({
      handle: b.handle,
      mime: b.mime,
      ...(b.name ? { name: b.name } : {}),
      caption: b.fallbackText,
      at: e.ts,
      from: fromSelf ? ME : from,
      ...(fromName ? { fromName } : {}),
      ...(conv ? { conversation: conv } : {}),
    });
  }
  return out;
}

/** 事件 meta 里带会话时拼成 `group:123`；没有就留空，不猜。 */
function convOf(meta: Record<string, unknown>): string | undefined {
  const conv = meta.conv;
  if (conv && typeof conv === 'object') {
    const c = conv as { kind?: unknown; id?: unknown };
    if (typeof c.kind === 'string' && (typeof c.id === 'string' || typeof c.id === 'number')) {
      return `${c.kind}:${c.id}`;
    }
  }
  return undefined;
}

function who(e: AlbumEntry): string {
  if (e.from === ME) return '我发的';
  return e.fromName ? `${e.fromName}(${e.from})` : e.from;
}

function where(e: AlbumEntry): string {
  return e.conversation ?? '—';
}

function label(e: AlbumEntry): string {
  const own = [e.title, e.note].filter(Boolean).join('／');
  if (own) return `【${own}】`;
  return e.caption ? e.caption.slice(0, 40) : (e.name ?? '(无说明)');
}

/** 给模型看的一句：这张图是什么、哪来的。 */
function describe(e: AlbumEntry): string {
  const parts = [`${e.at.slice(0, 16).replace('T', ' ')}`, who(e)];
  if (e.conversation) parts.push(e.conversation);
  if (e.title) parts.push(`标题：${e.title}`);
  if (e.note) parts.push(`备注：${e.note}`);
  if (e.caption) parts.push(e.caption.slice(0, 60));
  return parts.join('  ');
}

function strArg(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

function intArg(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** `2026-10-07` → 当天 00:00；已经是 ISO 的原样返回。 */
function normalizeDay(v: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00+08:00` : v;
}

/** `2026-10-07` → 当天 23:59:59；已经是 ISO 的原样返回。 */
function endOfDay(v: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59+08:00` : v;
}

/** 全部工具的声明;自描述要列出 tools() 能返回的每一个。 */
export const ALBUM_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'album_list',
    description:
      '翻自己的相册：把收到过和发出去过的图列出来，按时间倒序。'
      + '可以按人（`person`）、按会话（`conversation`）、按时间段（`since`/`until`）筛，'
      + '也可以只看你写过备注的那些（`noted_only`）。'
      + '列出来的每行开头是 id——想看哪张就把 id 交给 album_view。'
      + '**先 list 再 view**：一次别翻太多，翻之前先想清楚要看哪几张。',
    tags: ['read'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        person: { type: 'string', description: '可选。发言人的账号或名字（先用 album_people 看有哪些人）。' },
        conversation: { type: 'string', description: '可选。会话，形如 group:123456 或 private:123456。' },
        since: { type: 'string', description: '可选。这个时刻之后（YYYY-MM-DD 或 ISO）。' },
        until: { type: 'string', description: '可选。这个时刻之前（YYYY-MM-DD 或 ISO）。' },
        noted_only: { type: 'boolean', description: '可选。只列你写过标题或备注的。' },
        limit: { type: 'integer', description: '可选。最多列几条，默认按配置。' },
      },
    },
  },
  {
    name: 'album_view',
    description:
      '翻开相册里的某几张，真的看到图（不是看路径）。ids 用 album_list 给的那些 id。'
      + '一次最多几张按配置定——想看很多张就分几次，或者先按人／时间筛一遍再翻。'
      + '看完可以顺手用 album_note 写一句这是什么，下次找起来就快了。',
    tags: ['read'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        ids: {
          type: 'array',
          description: '要看的 id 列表（album_list 里每行开头那个）。',
          items: { type: 'string' },
        },
      },
      required: ['ids'],
    },
  },
  {
    name: 'album_note',
    description:
      '给相册里的图写一句这是什么，或者改掉之前写的。你写的标题与备注只有你自己看得到，'
      + '用来下次快速认出来——写"谁给的、什么场合、为什么留着"，比写图里有什么更有用。'
      + 'note 留空字符串 = 清掉这条备注。',
    tags: ['write'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        ids: { type: 'array', description: '要写的 id 列表。', items: { type: 'string' } },
        title: { type: 'string', description: '可选。一句短标题。' },
        note: { type: 'string', description: '可选。备注。空字符串 = 清掉。' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'album_scan',
    description:
      '往册子里补图。平时不用调——收到新图时会自己补。'
      + '只有两种情况要手动：一是册子里看着少了（比如某段时期的图没进来），'
      + '二是你想确认"到底存了多少张"。all=true 从头扫一遍（不会重复记）。',
    tags: ['read'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        all: { type: 'boolean', description: '可选。true = 从头重扫；不给 = 只补新的。' },
        people: { type: 'boolean', description: '可选。true = 顺便列一下册子里出现过哪些人。' },
      },
    },
  },
];
