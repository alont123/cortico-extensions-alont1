/**
 * QQ 空间 World。
 *
 * 它能发说说了。走 NapCat 的扩展接口 `send_qzone_msg`（不是 OneBot 标准动作）：
 *   POST http://127.0.0.1:3000/send_qzone_msg
 *   { content, ugc_right, images?: string[] }
 *
 * 两个坑，都写在代码里：
 * 1. **图片路径**：qq world 用 blob store 的 `mem:` 句柄发图，那条路只服务 QQ 消息；
 *    空间这边要自己给 NapCat 一个它能读的东西。NapCat 配置里 `enableLocalFile2Url`
 *    可能关闭，因此使用 base64。未确认成功时不自动重发，避免重复发布。
 * 2. **删除走 `delete_qzone_msg`，只需 tid**（2026-09-21 实测可用），tid 就是
 *    `send_qzone_msg` 回执里的 `data.tid`。`publish()` 现在把它存进记录，`qzone_status`
 *    报出来，`qzone_delete` 拿它删。**tid 只能从回执里来**：09-22 之前发的那些记录里没有，
 *    删不了 —— 读说说没有接口（`get_qzone_msg` 返回「不支持的Api」），旧 tid 拿不回来。
 *    每日限额与静默时段照旧都在发之前。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDef, World, WorldWebUiDecl, WorldHost } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { nowIso } from 'cortico/core/util.ts';
import { QZONE_CONFIG_GROUP, type QzoneConfigSection } from './config.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp)$/i;
export interface QzonePost {
  ts: string;
  content: string;
  images: number;
  ok: boolean;
  detail: string;
  /** NapCat 回执里的说说 id，删它用。09-22 之前发的记录里没有这一项。 */
  tid?: string;
  /** 删掉的时间。删过的仍留在记录里，只是标一下，别当成还在空间里。 */
  deletedAt?: string;
}

interface State {
  posts: QzonePost[];
  day: string;
  todayCount: number;
}

export class QzoneWorld implements World {
  readonly id = 'qzone';
  private host: WorldHost | null = null;
  private state: State;
  private readonly file: string;
  private readonly stickerDir: string;
  /** 「要不要发条说说」的提醒节拍。见 shouldNudge。 */
  private nudgeTimer: ReturnType<typeof setInterval> | null = null;
  private lastNudgeAt: number | null = null;
  private publishing = false;

  constructor(private readonly opts: {
    cfg: QzoneConfigSection;
    dataDir: string;
    botDir: string;
    timezone: string;
    /** NapCat 的 HTTP 服务地址 */
    httpUrl?: string;
  }) {
    const ownDir = join(opts.dataDir, this.id);
    this.file = join(ownDir, 'qzone.json');
    this.stickerDir = opts.cfg.stickerDir?.trim() ? resolve(ownDir, opts.cfg.stickerDir.trim()) : join(ownDir, 'stickers');
    this.state = this.load();
  }

  // ── 持久化 ──────────────────────────────────────────────────────────────

  private load(): State {
    try {
      if (existsSync(this.file)) {
        const s = JSON.parse(readFileSync(this.file, 'utf8')) as State;
        if (s && Array.isArray(s.posts)) return { posts: s.posts.slice(-60), day: s.day ?? '', todayCount: s.todayCount ?? 0 };
      }
    } catch (e) {
      this.host?.log.warn(`QQ空间记录读取失败: ${String(e)}`);
    }
    return { posts: [], day: '', todayCount: 0 };
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.state, null, 1), 'utf8');
    } catch (e) {
      this.host?.log.error(`QQ空间记录落盘失败: ${String(e)}`);
    }
  }

  // ── 限额 ────────────────────────────────────────────────────────────────

  /** 跨天就重置当日计数。返回今天还能发几条。 */
  private refreshDay(): number {
    const today = nowIso(this.opts.timezone).slice(0, 10);
    if (this.state.day !== today) {
      this.state.day = today;
      this.state.todayCount = 0;
      this.save();
    }
    return Math.max(0, this.opts.cfg.maxPerDay - this.state.todayCount);
  }

  private inQuietHours(d = new Date()): boolean {
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: this.opts.timezone, hour: '2-digit', hourCycle: 'h23' }).format(d));
    const { quietFrom, quietTo } = this.opts.cfg;
    // 跨夜（如 23 → 9）
    return quietFrom > quietTo ? (h >= quietFrom || h < quietTo) : (h >= quietFrom && h < quietTo);
  }

  // ── 配图 ────────────────────────────────────────────────────────────────

  /**
   * 挑一张表情包当配图。返回 NapCat 能吃的东西：
   * 优先 data URL（base64），因为 NapCat 的 enableLocalFile2Url 关着；
   * 未确认成功时不自动更换表示重发，调用方需要先核对空间。
   */
  private pickImage(): { dataUrl: string; name: string } | null {
    const cfg = this.opts.cfg;
    if (Math.random() > cfg.withImageChance) return null;
    try {
      if (!existsSync(this.stickerDir)) return null;
      const files = readdirSync(this.stickerDir).filter((f) => IMAGE_EXT.test(f)).filter((f) => {
        try { return statSync(join(this.stickerDir, f)).size <= cfg.maxImageBytes; } catch { return false; }
      });
      if (!files.length) return null;
      const name = files[Math.floor(Math.random() * files.length)]!;
      const bytes = readFileSync(join(this.stickerDir, name));
      return {
        dataUrl: `base64://${bytes.toString('base64')}`,
        name,
      };
    } catch {
      return null;
    }
  }

  // ── NapCat ──────────────────────────────────────────────────────────────

  /** NapCat 扩展接口的地址。 */
  private napcat(action: string): string {
    return `${(this.opts.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')}/${action}`;
  }

  // ── 发布 ────────────────────────────────────────────────────────────────

  /** 真的发出去。返回一条人话回执。 */
  async publish(content: string, opts: { withImage?: boolean } = {}): Promise<string> {
    if (this.publishing) return '[没法发] 上一次发布尚未完成，请等待回执。';
    this.publishing = true;
    try { return await this.publishOnce(content, opts); }
    finally { this.publishing = false; }
  }

  private async publishOnce(content: string, opts: { withImage?: boolean }): Promise<string> {
    const cfg = this.opts.cfg;
    const text = content.trim();
    if (!text) return '[没法发] 说说不能是空的';
    if (text.length > cfg.maxChars) return `[没法发] 太长了（${text.length} 字，上限 ${cfg.maxChars}）`;

    const left = this.refreshDay();
    if (left <= 0) return `[没发] 今天已经发过 ${cfg.maxPerDay} 条了，明天再说`;
    if (this.inQuietHours()) return `[没发] 现在是静默时段（${cfg.quietFrom}点~${cfg.quietTo}点），别发`;

    const picked = opts.withImage === false ? null : this.pickImage();
    const base = { content: text, ugc_right: cfg.ugcRight };

    const url = this.napcat('send_qzone_msg');
    const post = async (images?: string[]): Promise<{ ok: boolean; detail: string; tid?: string }> => {
      const body = images?.length ? { ...base, images } : base;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        const txt = await res.text();
        let j: { status?: string; retcode?: number; message?: string; data?: { tid?: string } } | null = null;
        try { j = JSON.parse(txt); } catch { /* 非 JSON */ }
        if (res.ok && j && (j.status === 'ok' || j.retcode === 0)) {
          const tid = j.data?.tid;
          return tid ? { ok: true, detail: 'ok', tid } : { ok: true, detail: 'ok' };
        }
        return { ok: false, detail: (j?.message ?? txt).slice(0, 200) };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    };

    // 发布接口没有幂等键。断网或超时后可能已成功，不能换配图再自动重发。
    const result = await post(picked ? [picked.dataUrl] : undefined);
    const usedImages = picked ? 1 : 0;

    const record: QzonePost = {
      ts: nowIso(this.opts.timezone),
      content: text,
      images: usedImages,
      ok: result.ok,
      detail: result.detail,
    };
    // tid 是日后删这条的唯一凭据，回执给了就留下
    if (result.tid) record.tid = result.tid;
    this.state.posts.push(record);
    this.state.posts = this.state.posts.slice(-60);
    if (result.ok) this.state.todayCount += 1;
    this.save();

    if (!result.ok) return `[未确认发布] ${result.detail}。未收到成功回执；请先核对空间再决定是否重试，本工具不会自动重发。`;
    const withImg = usedImages ? `，带了一张图（${picked?.name}）` : '';
    return `发出去了${withImg}。今天第 ${this.state.todayCount} 条，还剩 ${Math.max(0, cfg.maxPerDay - this.state.todayCount)} 条。`;
  }

  // ── 删除 ────────────────────────────────────────────────────────────────

  /**
   * 删掉一条自己发过的说说。tid 是 `send_qzone_msg` 回执里那个，`qzone_status` 报出来。
   *
   * 先在本记录里认这条，再动接口：tid 抄错、或者那条不是从这儿发的，都不该去撞接口。
   * 删掉不退还当天额度 —— 额度数的是「今天发过几条」，不是空间里还剩几条。
   */
  async remove(tid: string): Promise<string> {
    const key = tid.trim();
    if (!key) return '[没删] 得说删哪条：qzone_status 里那条后面就有它的 tid';

    const rec = this.state.posts.find((p) => p.tid === key);
    if (!rec) return `[没删] 记录里没有 tid 是 ${key} 的说说。09-22 之前发的那些没存 tid，删不了。`;
    if (rec.deletedAt) return `[没删] 这条已经删过了：[${rec.ts.slice(5, 16).replace('T', ' ')}] ${rec.content.slice(0, 40)}`;

    try {
      const res = await fetch(this.napcat('delete_qzone_msg'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tid: key }),
        signal: AbortSignal.timeout(30_000),
      });
      const txt = await res.text();
      let j: { status?: string; retcode?: number; message?: string } | null = null;
      try { j = JSON.parse(txt); } catch { /* 非 JSON */ }
      if (!(res.ok && j && (j.status === 'ok' || j.retcode === 0))) {
        return `[没删成] ${(j?.message ?? txt).slice(0, 200)}`;
      }
    } catch (e) {
      return `[没删成] ${e instanceof Error ? e.message : String(e)}`;
    }

    rec.deletedAt = nowIso(this.opts.timezone);
    this.save();
    return `删掉了：[${rec.ts.slice(5, 16).replace('T', ' ')}] ${rec.content.slice(0, 40)}`;
  }

  // ── World 契约 ──────────────────────────────────────────────────────────

  envPromptVars(): Record<string, string> {
    const left = this.refreshDay();
    return {
      'qzone.left': String(left),
      'qzone.quiet': this.inQuietHours() ? '是（现在不该发）' : '否',
      'qzone.maxChars': String(this.opts.cfg.maxChars),
    };
  }

  tools(): ToolDef[] {
    return [this.postTool(), this.statusTool(), this.deleteTool()];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    return {
      config: [QZONE_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.qzone.envPrompt',
          title: 'QQ空间 · 环境提示词',
          description: '告诉它可以发说说、什么时候不该发。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'qzone.left', description: '今天还能发几条。' },
            { name: 'qzone.quiet', description: '现在是不是静默时段。' },
            { name: 'qzone.maxChars', description: '正文长度上限。' },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    if (this.host) return;
    this.host = host;
    const left = this.refreshDay();
    try { await host.pushEvent({
      type: 'qzone.started',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text: `QQ 空间已就绪，今天还能发 ${left} 条。`,
    }, { trigger: 'piggyback' }); }
    catch (error) { if (this.host === host) this.host = null; throw error; }
    if (this.host !== host) return;

    // 光有提示词它不会想起来空间存在：它只在被事件叫醒时才思考，而那时前缀里那句
    // 「想发就发」淹在几万字上下文里。所以照 life 扩展那套，单独起一个慢节拍"起个念"。
    const everyMs = this.opts.cfg.nudgeEveryMinutes * 60_000;
    if (everyMs > 0) {
      this.nudgeTimer = setInterval(() => {
        void this.maybeNudge().catch((e) => host.log.warn(`空间发帖提醒检查失败: ${String(e)}`));
      }, Math.max(60_000, everyMs));
      this.nudgeTimer.unref?.();
    }
  }

  async stop(): Promise<void> {
    this.host = null;
    if (this.nudgeTimer) clearInterval(this.nudgeTimer);
    this.nudgeTimer = null;
    this.save();
  }

  // ── 主动性 ──────────────────────────────────────────────────────────────
  //
  // 这里只负责「起个念」：推一条内部事件进总线，剩下的交给正常的对话流程。
  // 发不发是它的判断 —— 这道闸门只决定"要不要让它想起来有这回事"。

  /**
   * 到点没到点。静默时段、今天没额度了、刚提醒过，三者有一个就不提。
   */
  shouldNudge(): boolean {
    const cfg = this.opts.cfg;
    if (!cfg.enabled) return false;
    if (cfg.nudgeMinGapMinutes <= 0) return false;
    // refreshDay 有副作用:跨天时它会重置当日计数并落盘,所以先调它再读结果
    if (this.refreshDay() <= 0) return false;
    if (this.inQuietHours()) return false;
    const last = this.lastNudgeAt;
    if (last !== null && (Date.now() - last) / 60_000 < cfg.nudgeMinGapMinutes) return false;
    return true;
  }

  /** 到点了就推一条"你空间还有额度"的念头。返回这条念起没起。 */
  async maybeNudge(): Promise<boolean> {
    const host = this.host;
    if (!host || !this.shouldNudge()) return false;

    const left = this.refreshDay();
    this.lastNudgeAt = Date.now();
    await host.pushEvent({
      type: 'qzone.nudge',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text: `QQ 空间发布候选时段已到；今日剩余额度 ${left} 条，尚未发布。是否使用 qzone_post 由 Persona 判断。`,
    }, { trigger: 'piggyback' });
    return true;
  }

  // ── 工具 ────────────────────────────────────────────────────────────────

  private postTool(): ToolDef {
    return {
      name: 'qzone_post',
      description:
        '发一条 QQ 空间说说。发出去别人就看得见了，所以按下去之前自己想清楚。'
        + '正文由调用方显式提供，with_image 控制是否从明确配置的素材目录选配图。'
        + '真发错了可以用 qzone_delete 收回（先 qzone_status 拿那条的 tid）。',
      tags: ['act'],
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          content: { type: 'string', description: '说说的正文。一两句话。' },
          with_image: { type: 'boolean', description: '要不要带一张表情包配图。默认按配置随机。' },
        },
        required: ['content'],
      },
      handler: async (args) => {
        const content = String(args.content ?? '');
        const withImage = typeof args.with_image === 'boolean' ? args.with_image : undefined;
        return this.publish(content, withImage === undefined ? {} : { withImage });
      },
    };
  }

  private statusTool(): ToolDef {
    return {
      name: 'qzone_status',
      description: '看看 QQ 空间今天还能发几条、刚才发过什么、现在能不能发。',
      tags: ['read'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => {
        const left = this.refreshDay();
        const lines = [
          `今天还能发 ${left} 条（上限 ${this.opts.cfg.maxPerDay}）。`,
          this.inQuietHours() ? `现在是静默时段（${this.opts.cfg.quietFrom}点~${this.opts.cfg.quietTo}点），发不了。` : '现在可以发。',
        ];
        // 列 10 条：删的时候 tid 只能从这儿看，列太少它昨天发的就够不着了
        const recent = this.state.posts.slice(-10).reverse();
        if (recent.length) {
          lines.push('', '最近发过的：');
          for (const p of recent) {
            const when = p.ts.slice(5, 16).replace('T', ' ');
            const mark = !p.ok ? '✗' : p.deletedAt ? '✓已删' : '✓';
            const tid = p.tid ? `  tid ${p.tid}` : '';
            lines.push(`  ${mark} [${when}] ${p.content.slice(0, 40)}${p.images ? '（带图）' : ''}${tid}`);
          }
        } else lines.push('', '还没发过。');
        return lines.join('\n');
      },
    };
  }

  private deleteTool(): ToolDef {
    return {
      name: 'qzone_delete',
      description:
        '删掉一条自己发过的说说。要 tid —— qzone_status 里最近那条后面就带着它。'
        + '删了就真没了，所以先看清是哪条再删。'
        + '（09-22 之前发的那些记录里没有 tid，删不了。）',
      tags: ['act'],
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          tid: { type: 'string', description: '删哪条。qzone_status 里那条后面的 tid。' },
        },
        required: ['tid'],
      },
      handler: async (args) => this.remove(String(args.tid ?? '')),
    };
  }
}

/** 全部工具的声明;自描述要列出 tools() 能返回的每一个。 */
export const QZONE_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'qzone_post',
    description:
      '发一条 QQ 空间说说。发出去别人就看得见了，所以按下去之前自己想清楚。'
      + '正文由调用方显式提供，with_image 控制是否从明确配置的素材目录选配图。'
      + '真发错了可以用 qzone_delete 收回（先 qzone_status 拿那条的 tid）。',
    tags: ['act'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        content: { type: 'string', description: '说说的正文。一两句话。' },
        with_image: { type: 'boolean', description: '要不要带一张表情包配图。默认按配置随机。' },
      },
      required: ['content'],
    },
  },
  {
    name: 'qzone_status',
    description: '看看 QQ 空间今天还能发几条、刚才发过什么、现在能不能发。',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'qzone_delete',
    description:
      '删掉一条自己发过的说说。要 tid —— qzone_status 里最近那条后面就带着它。'
      + '删了就真没了，所以先看清是哪条再删。'
      + '（09-22 之前发的那些记录里没有 tid，删不了。）',
    tags: ['act'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        tid: { type: 'string', description: '删哪条。qzone_status 里那条后面的 tid。' },
      },
      required: ['tid'],
    },
  },
];
