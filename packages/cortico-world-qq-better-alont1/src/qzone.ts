import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';

/** Explicit Qzone actions and external interaction events; scheduling never drafts or posts. */

export interface QZoneAutoReplyConfig {
  enabled: boolean;
  systemPrompt: string;
  dailyQuota: number;
  cooldownSec: number;
}

export interface QZoneConfig {
  enabled: boolean;
  systemPrompt: string;
  endpoint: string;
  apiKeySecret: string;
  model: string;
  /** 候选事件检查周期（秒）；不会自动发布。 */
  tickSec: number;
  /** 每个 tick 生成候选事件的概率。 */
  chancePerTick: number;
  /** 每日候选事件上限（0=不限）；显式发布次数另行记录。 */
  dailyQuota: number;
  /** 可见权限 ugc_right：1=公开（默认），其余值随 NapCat 版本。 */
  permission: number;
  /** 旧配置兼容字段，已停用；配图只接受显式工具参数。 */
  imageMode: 'none' | 'recent';
  autoReplyComments: QZoneAutoReplyConfig;
  /** 回复评论用的 OneBot action（不同 NapCat 版本可能不同）。 */
  commentAction: string;
}

export interface QZonePosterOpts {
  cfg: QZoneConfig;
  log: Logger;
  dataDir: string;
  /** 调 OneBot action（NapCat 扩展接口）。 */
  callApi: (action: string, params: Record<string, unknown>) => Promise<unknown>;
  timezone?: string;
  isPaused?: () => boolean;
  /** 把一条外部交互（如评论）推给 host（用于记忆沉淀/让 bot 看到）。 */
  pushEvent: (e: unknown) => Promise<unknown>;
}

export interface QZonePostResult {
  ok: boolean;
  tid?: string;
  text?: string;
  error?: string;
}

const POST_ACTION = 'send_qzone_msg';
const DELETE_ACTION = 'delete_qzone_msg';
const GET_LIST_ACTION = 'get_qzone_msg_list';

function startOfDay(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 去掉模型常给的包裹引号 / 代码围栏 / 多余空行。 */
function cleanText(t: string): string {
  let s = (t ?? '').trim();
  if (!s) return s;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('“') && s.endsWith('”'))) s = s.slice(1, -1).trim();
  if (s.startsWith('```') || s.startsWith('···')) {
    const nl = s.search(/\n/);
    if (nl >= 0) s = s.slice(nl + 1);
    if (s.endsWith('```') || s.endsWith('···')) s = s.slice(0, -3);
    s = s.trim();
  }
  return s;
}

/** 从一段文本里抽出纯数字的 uin（用于 @目标）。 */
function extractUins(ats: string[]): number[] {
  const out: number[] = [];
  for (const a of ats) {
    const n = Number(a);
    if (Number.isFinite(n) && a.trim() !== '' && /^\d+$/.test(a.trim())) out.push(n);
  }
  return out;
}

/** 兼容不同 NapCat 版本对 QZone 互动事件的字段命名。 */
function parseQzoneEvent(ev: Record<string, any>): { tid?: string; commentId?: string; operatorId?: number; operatorNick?: string; text?: string; subType?: string } | null {
  if (!ev || typeof ev !== 'object') return null;
  const post = String(ev.post_type ?? '');
  const detail = String(ev.detail_type ?? ev.sub_type ?? '');
  const isQzone = post === 'qzone' || post === 'interact' || /qzone/i.test(detail) || /qzone/i.test(String(ev.notice_type ?? ''));
  if (!isQzone) return null;
  const tid = ev.tid ?? ev.feed_id ?? ev.feedId ?? (typeof ev.feed === 'object' ? ev.feed?.tid : undefined);
  const commentId = ev.comment_id ?? ev.commentId ?? ev.cid ?? ev.comment?.id;
  const operatorId = typeof ev.operator_id === 'number' ? ev.operator_id : typeof ev.user_id === 'number' ? ev.user_id : undefined;
  const operatorNick = ev.operator_nick ?? ev.operatorNick ?? ev.user_nick ?? ev.nickname ?? (typeof ev.operator === 'object' ? ev.operator?.nickname : undefined);
  const text = ev.content ?? (typeof ev.comment === 'object' ? ev.comment?.content ?? ev.comment?.text : ev.comment) ?? ev.comment_text ?? ev.text;
  return { tid: tid ? String(tid) : undefined, commentId: commentId ? String(commentId) : undefined, operatorId, operatorNick: operatorNick ? String(operatorNick) : undefined, text: text ? String(text) : undefined, subType: detail };
}

export class QZonePoster {
  private readonly cfg: QZoneConfig;
  private readonly log: Logger;
  private readonly dataDir: string;
  private readonly stateFile: string;
  private readonly opts: QZonePosterOpts;

  private running = false;
  private busy = false;
  private nudgeCount = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastPosts: { tid?: string; text: string; at: number }[] = [];
  private dailyCount = 0;
  private dayStart = startOfDay();
  private processedComments = new Set<string>();
  private pendingComments = new Set<string>();
  private lastReplyAt = 0;
  private replyDailyCount = 0;

  constructor(opts: QZonePosterOpts) {
    this.opts = opts;
    this.cfg = opts.cfg;
    this.log = opts.log.child('qzone');
    this.dataDir = opts.dataDir;
    this.stateFile = opts.dataDir ? join(opts.dataDir, 'qzone-state.json') : '';
    this.load();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (!this.cfg.enabled) {
      this.log.info('QQ空间动态未开启');
      return;
    }
    this.timer = setInterval(() => void this.tick().catch((e) => this.log.warn('QQ空间 tick 异常', { err: String(e) })), Math.max(10, this.cfg.tickSec) * 1000);
    this.log.info('QQ空间动态发布器已启动', { tickSec: this.cfg.tickSec, permission: this.cfg.permission });
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.save();
  }

  /** Publish only explicitly supplied text and images. */
  async post(opts: { content?: string; topic?: string; images?: string[]; ats?: string[]; permission?: number }): Promise<QZonePostResult> {
    const content = opts.content ? cleanText(opts.content) : '';
    if (!content) return { ok: false, error: '请提供 content 正文；由 Persona 决定内容，本扩展不自动生成。' };

    // @人：文本里嵌入 @昵称；纯数字则同时作为 target_uins（NapCat 可见/互动对象）
    const ats = opts.ats ?? [];
    let body = content;
    for (const a of ats) {
      const name = /^\d+$/.test(a.trim()) ? a.trim() : a.trim();
      if (!body.includes('@' + name)) body = `@${name} ` + body;
    }

    const images: string[] = [...(opts.images ?? [])];
    const params: Record<string, unknown> = { content: body };
    if (images.length) params.images = images;
    params.ugc_right = typeof opts.permission === 'number' ? opts.permission : this.cfg.permission;
    const uins = extractUins(ats);
    if (uins.length) params.target_uins = uins;

    try {
      // OneBotDriver.callApi 已解包 data；同时保留旧适配器返回整份回执的兼容性。
      const r = (await this.opts.callApi(POST_ACTION, params)) as { tid?: string | number; data?: { tid?: string | number } } | undefined;
      const data = r?.data ?? r;
      const tid = data?.tid != null ? String(data.tid) : undefined;
      this.recordPost(tid, body);
      this.log.info('已发 QQ空间动态', { tid, text: body.slice(0, 60) });
      return { ok: true, tid, text: body };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn('发 QQ空间动态失败', { err: msg });
      return { ok: false, error: msg };
    }
  }

  /** 删除一条动态。 */
  async delete(tid: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.opts.callApi(DELETE_ACTION, { tid });
      this.lastPosts = this.lastPosts.filter((p) => p.tid !== tid);
      this.save();
      this.log.info('已删 QQ空间动态', { tid });
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn('删 QQ空间动态失败', { err: msg });
      return { ok: false, error: msg };
    }
  }

  /** 回复某条动态下的一条评论。 */
  async replyComment(tid: string, commentId: string, content: string): Promise<{ ok: boolean; error?: string }> {
    const text = cleanText(content);
    if (!text) return { ok: false, error: '回复内容为空' };
    // 没配 action 就别去撞一个空名字：NapCat 至今只注册了发/删说说两个空间动作，
    // 评论这条根本没有接口（见 config.ts 里 commentAction 那段说明）。
    if (!this.cfg.commentAction) {
      return { ok: false, error: '协议端没有评论回复接口（NapCat 的空间扩展只有发/删说说）' };
    }
    try {
      await this.opts.callApi(this.cfg.commentAction, { tid, content: text, comment_id: commentId });
      this.log.info('已回复 QQ空间评论', { tid, commentId, text: text.slice(0, 40) });
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn('回复 QQ空间评论失败', { err: msg, action: this.cfg.commentAction });
      return { ok: false, error: msg };
    }
  }

  /** 取自己的动态列表（尽力而为；get_qzone_msg_list 不一定所有 NapCat 版本都支持）。 */
  async getFeeds(num = 5): Promise<{ ok: boolean; feeds?: unknown[]; error?: string }> {
    try {
      const r = await this.opts.callApi(GET_LIST_ACTION, { num });
      const data = r && typeof r === 'object' && 'data' in r ? (r as { data: unknown }).data : r;
      const feeds = Array.isArray(data) ? data : (data as { feeds?: unknown[] } | undefined)?.feeds;
      if (!Array.isArray(feeds)) return { ok: false, error: '协议端未返回可识别的动态列表，不能当作空列表。' };
      return { ok: true, feeds };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn('获取 QQ空间动态列表失败', { err: msg });
      return { ok: false, error: msg };
    }
  }

  /** Forward each comment once; replies require the explicit reply tool. */
  async onEvent(ev: Record<string, any>): Promise<void> {
    if (!this.running || !this.cfg.enabled) return;
    const p = parseQzoneEvent(ev);
    if (!p) return;
    const key = p.tid && p.commentId ? p.tid + '#' + p.commentId : null;
    if (key && (this.processedComments.has(key) || this.pendingComments.has(key))) return;
    if (key) this.pendingComments.add(key);
    try { await this.opts.pushEvent({
      type: 'qq.qzone', ts: nowIso(this.opts.timezone ?? 'UTC'), source: 'qqbot', origin: 'external', senderKey: 'qqbot.qzone',
      text: 'QQ 空间互动：' + JSON.stringify(p) + '。需要回复时使用 qqbot_qzone_reply，允许不回应。',
      meta: { kind: 'qzone_interact', ...p },
    });
    if (key) { this.processedComments.add(key); this.save(); }
    } finally { if (key) this.pendingComments.delete(key); }
  }

  private async tick(): Promise<void> {
    if (!this.running || !this.cfg.enabled || this.busy || this.opts.isPaused?.()) return;
    this.rolloverDay();
    if (this.cfg.dailyQuota > 0 && this.nudgeCount >= this.cfg.dailyQuota) return;
    if (Math.random() >= Math.max(0, Math.min(1, this.cfg.chancePerTick))) return;
    this.busy = true;
    try {
      await this.opts.pushEvent({ type: 'qq.qzone_nudge', ts: nowIso(this.opts.timezone ?? 'UTC'), source: 'qqbot', origin: 'internal', senderKey: 'qqbot.qzone',
        text: '空间候选时段已到。是否发言及正文由 Persona 决定；发布需要显式调用 qqbot_qzone_post。', meta: { kind: 'qzone_candidate' } });
      if (this.running) { this.nudgeCount++; this.save(); }
    } finally { this.busy = false; }
  }

  private recordPost(tid: string | undefined, text: string): void {
    this.lastPosts.push({ tid, text, at: Date.now() });
    while (this.lastPosts.length > 20) this.lastPosts.shift();
    this.rolloverDay();
    this.dailyCount += 1;
    this.save();
  }

  private rolloverDay(): void {
    const today = startOfDay();
    if (today !== this.dayStart) {
      this.dayStart = today;
      this.dailyCount = 0;
      this.nudgeCount = 0;
      this.replyDailyCount = 0;
    }
  }

  private rolloverReplyDay(): void {
    const today = startOfDay();
    if (today !== this.dayStart) {
      this.dayStart = today;
      this.replyDailyCount = 0;
    }
  }

  status(): Record<string, unknown> {
    return {
      enabled: this.cfg.enabled,
      dailyCount: this.dailyCount,
      nudgeCount: this.nudgeCount,
      dailyQuota: this.cfg.dailyQuota,
      autoReply: false,
      replyDailyCount: this.replyDailyCount,
      lastPosts: this.lastPosts.slice(-8).map((p) => ({ tid: p.tid, text: p.text.slice(0, 60), at: p.at })),
    };
  }

  private load(): void {
    if (!this.stateFile || !existsSync(this.stateFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as {
        lastPosts?: { tid?: string; text: string; at: number }[];
        dailyCount?: number;
        nudgeCount?: number;
        dayStart?: number;
        processedComments?: string[];
        replyDailyCount?: number;
        lastReplyAt?: number;
      };
      this.lastPosts = Array.isArray(raw.lastPosts) ? raw.lastPosts : [];
      this.dailyCount = typeof raw.dailyCount === 'number' ? raw.dailyCount : 0;
      this.nudgeCount = typeof raw.nudgeCount === 'number' ? raw.nudgeCount : 0;
      this.dayStart = typeof raw.dayStart === 'number' ? raw.dayStart : startOfDay();
      this.processedComments = new Set(Array.isArray(raw.processedComments) ? raw.processedComments : []);
      this.replyDailyCount = typeof raw.replyDailyCount === 'number' ? raw.replyDailyCount : 0;
      this.lastReplyAt = typeof raw.lastReplyAt === 'number' ? raw.lastReplyAt : 0;
    } catch {
      /* 忽略损坏状态文件 */
    }
  }

  private save(): void {
    if (!this.stateFile) return;
    try {
      const obj = {
        lastPosts: this.lastPosts,
        dailyCount: this.dailyCount,
        nudgeCount: this.nudgeCount,
        dayStart: this.dayStart,
        processedComments: [...this.processedComments],
        replyDailyCount: this.replyDailyCount,
        lastReplyAt: this.lastReplyAt,
      };
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify(obj), 'utf8');
    } catch {
      /* 忽略写入失败 */
    }
  }
}
