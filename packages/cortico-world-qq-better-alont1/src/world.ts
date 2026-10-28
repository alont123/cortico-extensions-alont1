import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { nowIso, shortTime } from 'cortico/core/util.ts';
import { type BlobInput, type EventEnvelope, type Logger, type PromptDocDecl, type ToolDef, type World, type WorldWebUiDecl, type WorldHost, type WorldLamp, type WorldPanelDecl, type WorldStreamSocket } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { OneBotDriver } from './driver.ts';
import { QZonePoster, type QZoneConfig } from './qzone.ts';
import { QQ_CONFIG_GROUP, QQ_DEFAULTS, normalizeConfig, toIds, type QQConfigSection, type QQWorldConfig } from './config.ts';
import { isAbsolute, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOutgoing, eventClock, eventTs, renderIncoming, renderSegmentsPlain, splitReplyIntoMessages } from './normalize.ts';
import { clampText, stripLoneSurrogates } from './text-guard.ts';
import { type ExtWorldHost } from './types-extras.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));
import { type Conv, type OneBotMessage, type OneBotSegment, type QQIdentity, type QQSenderBrief } from './types.ts';
import { Vision } from './vision.ts';
import { StickerStore, listStickerFiles } from './sticker.ts';
import { Notebook } from './notebook.ts';
import { ProactiveSpeaker, type ProactiveTarget } from './proactive.ts';
import { VoiceClient } from './voice.ts';
import { makeHistoryTools, HISTORY_TOOL_DECLS } from './history-tools.ts';
import { QQ_ADDITIONAL_TOOL_DECLS } from './additional-tools.ts';
import { PeopleBook, PEOPLE_NOTE_MAX, PEOPLE_THREAD_CHARS, PEOPLE_THREAD_MAX, normalizeQq } from './people.ts';
import { GroupBook, GROUP_LORE_CHARS, GROUP_LORE_MAX, GROUP_NOTE_MAX, normalizeGroup } from './groups.ts';
import { festivalText } from './festival.ts';
import { ReminderStore, parseWhen, formatWhen } from './reminder.ts';
import { readResponseBytes } from './http.ts';

const SOURCE = 'qqbot';
/** 到点提醒多久查一次（秒级反馈没必要，命中的都是分钟级约定）。 */
const REMINDER_POLL_MS = 20_000;
/** 合并转发节点里取不到昵称时的占位（对齐内置 qq 的 'QQ用户' 占位）。 */
const PLACEHOLDER_NICKNAME = 'QQ用户';

/** 合并转发节点的渲染结果（对齐内置 qq 的 ForwardNode）。 */
interface ForwardNode {
  line: string;
  body: string;
  named: boolean;
  time?: number;
  userId?: string;
  messageType?: string;
}

interface PendingSend {
  address: string;
  label: string;
  text: string;
  createdAt: number;
  /** 绑定到本草稿的引用回复消息编号（跨会话校验后写入）。 */
  replyMessageId?: number;
  /** qqbot_send 是否已直接发出（去掉强制草稿门后通常为 true）。 */
  sent?: boolean;
}

function bareGroupName(label: string): string {
  // 这个扩展的群 label 是「群「深夜食堂」」；读数里要用的是「深夜食堂」本身。
  return label.replace(/^群「|」$/g, '');
}

export class QQWorld implements World {
  readonly id = 'qqbot';
  private config: QQWorldConfig = QQ_DEFAULTS;
  private host: ExtWorldHost | null = null;
  private log: Logger = consoleLogger();
  private driver: OneBotDriver | null = null;
  private identity: QQIdentity | null = null;
  private readonly convs = new Map<string, Conv>();
  private readonly pendingSends = new Map<string, PendingSend>();
  /** 自己发出的消息索引（message_id → 会话），用于引用回复自己刚发的消息。 */
  private readonly knownMessages = new Map<string, { conv: string; ts: number }>();
  /** 私聊聚合窗口里攒下的附件（图/语音），冲刷时随那一段一起投出去。 */
  private readonly aggBlobs = new Map<string, BlobInput[]>();
  /** 群号 → 群名。掉线后 identity 取不到，靠这份记着（读数里要有群名才有用）。 */
  private readonly groupNames = new Map<number, string>();
  /** 最近收到的图片 URL 缓冲（供 qqbot_view_image 主动重看，无需事件里带 URL）。 */
  private readonly recentImages: Array<{ url: string; conv: string; at: number }> = [];
  private vision: Vision;
  private stickers: StickerStore | null = null;
  /** 智能体私人笔记本（本地 notebook.jsonl）。 */
  private notebook: Notebook | null = null;
  private proactive: ProactiveSpeaker | null = null;
  private qzone: QZonePoster | null = null;
  /** 语音合成；没配服务地址时 enabled=false，`qqbot_send` 的 voice 参数也不会出现。 */
  private readonly voice: VoiceClient;
  private connected = false;
  private sendGeneration = 0;
  /** sendTo 因限速/防死循环而拦截时返回的字符串前缀，便于 qqbot_send 工具区分“已发送”与“被拦截”。 */
  private static readonly SEND_BLOCKED = '[send blocked] ';
  /** NapCat 一次调用都没成功时的回执前缀（同 SEND_BLOCKED 的用法，但原因在调用本身）。 */
  private static readonly SEND_FAILED = '[send failed] ';
  /** 只发出去一部分时的回执前缀：主句不能写成"已发送"，否则她以为整条都送到了。 */
  private static readonly SEND_PARTIAL = '[send partial] ';
  /** 发图上限：QQ 侧对超大图会直接失败，而且这条路会把整份读进内存再 base64。 */
  private static readonly IMAGE_MAX_BYTES = 8 * 1024 * 1024;
  /** 群聊发言频率限制：group:<id> -> 已发出消息的时间戳数组（用于滑动窗口计数）。 */
  private groupSpeakStamps = new Map<string, number[]>();
  /** 防死循环：会话地址 -> 自上次对方发言以来的 bot 连续发送条数。 */
  private botStreak = new Map<string, number>();
  /** 防死循环：会话地址 -> 最近一次收到对方发言的时间戳（用于 idle 收尾判断）。 */
  private lastUserMsgAt = new Map<string, number>();
  private readonly eventSockets = new Set<WorldStreamSocket>();
  private packageDir = '';
  /** 仓库根（来自 ctx.repoRoot）：找 ffmpeg-static 这类框架自带的二进制时要用。 */
  private repoRoot = '';
  /** 部署的密钥库（来自 ctx.secret）：`.env` 里的密钥框架不注入 process.env，只能这么拿。 */
  private secretLookup?: (name: string) => string | undefined;
  /** 这个 bot 的展示名（来自 ctx.botName）；情绪档案把它当自称。 */
  private botName = '';
  /** 人册：按 QQ 号记「这人是谁」。见 people.ts。 */
  private readonly people: PeopleBook;
  /** 群册：按群记「这是个什么地方、有什么梗」。见 groups.ts。 */
  private readonly groups: GroupBook;
  /** 已经试通的 ffmpeg（试通一次就记住，免得每条语音都从头试）。 */
  private ffmpegResolved: string | null = null;
  private ffmpegWarned = false;
  private emojiDirAbs = '';
  private stickerDirAbs = '';
  /** 实际使用的表情包库目录：sticker.dir → emojiDir → <dataDir>/stickers。 */
  private stickerLibAbs = '';
  /** 状态持久化目录（来自 ctx.dataDir），用于跨重启重建 knownMessages（防串台索引）。 */
  private dataDir = '';
  /** 每个 QQ 最后一次来信的时刻（毫秒）；life/主动联系判断「多久没说话」要用它。 */
  private lastInbound = new Map<string, number>();
  /** 待处理的好友申请 flag → 申请人信息（NapCat 只有 flag 能批）。 */
  private friendReqs = new Map<string, { userId: number; comment: string; at: number }>();
  private inboundFile = '';
  private inboundTimer: ReturnType<typeof setTimeout> | null = null;
  private stateFile = '';
  private stateSaveTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  /**
   * 串行处理链（对齐内置 qq 的 msgChain）。所有消息/通知都接到这条 Promise 链上依次执行，
   * 严格保证按到达顺序落库，避免并发时 knownMessages / convs / 聚合窗口交叉污染导致串台。
   */
  private msgChain: Promise<void> = Promise.resolve();

  /** 到点提醒的存档;没有 dataDir 时为 undefined（不落盘就不启用）。 */
  private reminders: ReminderStore | undefined = undefined;
  private reminderTimer: ReturnType<typeof setInterval> | undefined = undefined;

  constructor(
    config?: Partial<QQWorldConfig>,
    packageDir?: string,
    dataDir = '',
    repoRoot = '',
    secretLookup?: (name: string) => string | undefined,
    botName = '',
  ) {
    this.config = normalizeConfig((config ?? {}) as QQConfigSection);
    this.packageDir = packageDir ?? '';
    this.dataDir = dataDir;
    this.repoRoot = repoRoot || '';
    this.secretLookup = secretLookup;
    this.botName = botName;
    this.people = new PeopleBook(dataDir || '.');
    this.groups = new GroupBook(dataDir || '.');
    this.stateFile = dataDir ? join(dataDir, 'qqbot-known-messages.json') : '';
    this.inboundFile = dataDir ? join(dataDir, 'qq-last-inbound.json') : '';
    this.loadInbound();
    this.emojiDirAbs = this.config.emojiDir
      ? isAbsolute(this.config.emojiDir)
        ? this.config.emojiDir
        : join(this.packageDir, this.config.emojiDir)
      : '';
    this.stickerDirAbs = this.config.sticker.dir
      ? isAbsolute(this.config.sticker.dir)
        ? this.config.sticker.dir
        : join(this.packageDir, this.config.sticker.dir)
      : this.emojiDirAbs;
    // 默认目录：两个配置都没填时落到 <dataDir>/stickers。
    // 以前落到 packageDir/emoji：插件升级/重装会丢，而且 emojiDir 空着时 [表情包:文件名] 根本不被解析。
    this.stickerLibAbs = this.stickerDirAbs || this.emojiDirAbs || join(this.dataDir || this.packageDir || '.', 'stickers');
    if (!this.emojiDirAbs) this.emojiDirAbs = this.stickerLibAbs;
    if (!this.stickerDirAbs) this.stickerDirAbs = this.stickerLibAbs;
    this.vision = new Vision(this.config.vision, consoleLogger());
    this.voice = new VoiceClient(this.config.voice);
  }

  // ---- 生命周期 ----
  async start(host: WorldHost): Promise<void> {
    this.host = this.wrapHost(host);
    this.log = this.host.log.child('qq');
    this.vision = new Vision(this.config.vision, this.log, this.dataDir, (name) => this.resolveSecret(name));
    this.stickers = new StickerStore(this.stickerLibAbs, this.config.vision, this.log, this.dataDir);
    this.notebook = new Notebook(this.dataDir, this.log.child('notebook'));
    this.syncConfigRoster();
    this.driver = new OneBotDriver({
      mode: this.config.mode,
      wsUrl: this.config.wsUrl,
      wsHost: this.config.wsHost,
      wsPort: this.config.wsPort,
      wsPath: this.config.wsPath,
      token: this.config.token,
      log: this.log,
      onEvent: (ev) => void this.handleEvent(ev),
      onConnectionChange: (c) => {
        this.connected = c;
        if (c) void this.reloadIdentity();
      },
    });
    await this.driver.start();
    this.loadState();
    this.initProactive();
    this.initQzone();
    this.initReminders();
  }

  /**
   * 到点提醒（移植自上游 0.1.63 的 reminder）。
   *
   * 没有开关：没有待提醒时这一圈什么都不做，所以对老部署是零影响；
   * 落盘在 dataDir/reminders.json，重启后还在。
   */
  private initReminders(): void {
    if (!this.dataDir) {
      this.log.warn('没有 dataDir，到点提醒不落盘（重启会丢），已停用');
      return;
    }
    this.reminders = new ReminderStore(this.dataDir, this.log.child('reminder'));
    const pending = this.reminders.list(true).length;
    if (pending > 0) this.log.info(`到点提醒已就绪，待提醒 ${pending} 条`);
    this.reminderTimer = setInterval(
      () => void this.checkReminders().catch((e) => this.log.warn('到点提醒检查异常', { err: String(e) })),
      REMINDER_POLL_MS,
    );
    this.reminderTimer.unref?.();
  }

  /** 到点的提醒各推一条内部事件；落库失败就不标完成，留给下一圈重试。 */
  private async checkReminders(): Promise<void> {
    if (!this.reminders || !this.host) return;
    for (const r of this.reminders.due()) {
      const address = r.address ?? '';
      if (!address) {
        this.reminders.markDone(r.id);
        continue;
      }
      const wait = r.when - r.createdAt;
      const waited = wait >= 86_400_000
        ? `约 ${Math.round(wait / 86_400_000)} 天`
        : wait >= 3_600_000
          ? `约 ${Math.round(wait / 3_600_000)} 小时`
          : `约 ${Math.max(1, Math.round(wait / 60_000))} 分钟`;
      const text = `[到点提醒] 这是你 ${waited}前让提醒的：${r.text}\n`
        + `要现在就在这个会话里处理，就用 qqbot_send 发到 ${address}（正文自己写）。`;
      try {
        await this.host.pushEvent({
          type: 'qq.reminder',
          ts: eventTs(this.config.timezone),
          source: SOURCE,
          text,
          senderKey: address,
        });
        this.reminders.markDone(r.id);
      } catch (e) {
        this.log.warn('到点提醒投递失败，下一圈重试', { id: r.id, err: String(e) });
      }
    }
    this.reminders.flush();
  }

  /** 装配 QQ 空间动态发布器（发/删动态、按对话记忆自动冒泡、评论回复）。 */
  private initQzone(): void {
    const cfg = this.config.qzone as QZoneConfig;
    if (!cfg.enabled) {
      this.log.info('QQ空间动态未开启');
      return;
    }
    this.qzone = new QZonePoster({
      cfg,
      log: this.log,
      dataDir: this.dataDir,
      callApi: (action, params) => this.driver?.callApi(action, params) ?? Promise.reject(new Error('未连接到 NapCat')),
      isPaused: () => this.paused(),
      timezone: this.config.timezone,
      pushEvent: (e) => this.host?.pushEvent(e as never, { trigger: 'piggyback' }) ?? Promise.resolve(),
    });
    this.qzone.start();
  }

  /** Scheduling reports an eligible conversation without drafting or sending. */
  private initProactive(): void {
    this.proactive = new ProactiveSpeaker({
      cfg: this.config.proactive, log: this.log, dataDir: this.dataDir,
      getTargets: () => this.proactiveTargets(),
      isPaused: () => this.paused(),
      request: async target => {
        const host = this.host;
        if (!host || this.paused()) return false;
        await host.pushEvent({ type: 'qq.proactive', ts: eventTs(this.config.timezone), source: SOURCE,
          origin: 'external', senderKey: target.address,
          text: '监听会话进入候选时段：' + JSON.stringify({ address: target.address, label: target.label }) + '。是否回应由 Persona 决定；需要发送时使用显式 QQ 工具。',
          meta: { kind: 'proactive_candidate', address: target.address, conversationKind: target.kind,
            lastInboundAt: this.lastUserMsgAt.get(target.address) ?? (target.kind === 'private' ? this.lastInbound.get(target.address.slice('private:'.length)) : undefined) ?? null },
        }, { trigger: 'piggyback' });
        return this.host === host;
      },
    });
    this.proactive.start();
  }

  /** 按 mode 过滤出可主动说话的监听会话。 */
  /**
   * 这个会话的图要不要直接当附件交给模型。总开关关着就一律不给；
   * 开着时私聊一律给看，群里按 `deliverImageAttachmentsInGroups` 定——
   * 群图量大，一张图就是一份 token，默认不给。
   */
  private attachesHere(conv: Conv): boolean {
    if (!this.config.deliverImageAttachments) return false;
    return conv.kind !== 'group' || this.config.deliverImageAttachmentsInGroups;
  }

  /**
   * 进群流水：`{ts, gid, userId, name}` 一行一次，追加到 `<dataDir>/group-entry.jsonl`。
   * 好感 World 读它给新人按群起步分；两个 World 之间只有这一个文件。
   * `userId` 存**字符串**——那边的读法就是 `userId?: string` 再 `Number()`，
   * 这个文件的既有行也都是字符串。
   */
  private journalGroupEntry(gid: number, userId: number, name: string): void {
    if (!this.dataDir) return;
    const file = join(this.dataDir, 'group-entry.jsonl');
    const line = JSON.stringify({ ts: eventTs(this.config.timezone), gid, userId: String(userId), name }) + '\n';
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, line, 'utf8');
    } catch (e) {
      // 流水写不进去只影响好感起步分，不该让"她进了个群"这件事本身失败
      this.log.warn('进群流水写入失败 ' + String(e));
    }
  }

  /**
   * 各群安静了多久（分钟），按由久到近排。只报参与度 >= minActive 的群。
   *
   * 心跳里那条"群里：xxx 安静 N 分钟"就是这个读数——全局安静时长计的是**任何**外部事件，
   * 别的 World 一直在推就永远只有几秒，靠它判断不出"这个群多久没人说话了"。
   * 数据源是 knownMessages：她自己发出去的也会回录，所以刚说完话不会被算成安静了很久。
   * 从来没收到过消息的群报 null（"不知道"，不是"安静 0 分钟"），排在最后。
   */
  quietByConversation(minActive: number): Array<{ label: string; quietMinutes: number | null }> {
    const now = Date.now();
    const lastAt = new Map<string, number>();
    for (const { conv, ts } of this.knownMessages.values()) {
      const at = typeof ts === 'number' ? ts : Date.parse(String(ts));
      if (!Number.isFinite(at)) continue;
      const seen = lastAt.get(conv);
      if (seen === undefined || at > seen) lastAt.set(conv, at);
    }
    // 连着的时候顺手把群名记下来：掉线后只剩群号的读数差得多
    if (this.identity) {
      for (const [id, name] of this.identity.groups) {
        if (name && name !== String(id)) this.groupNames.set(id, name);
      }
    }
    const out: Array<{ label: string; quietMinutes: number | null }> = [];
    for (const c of this.convs.values()) {
      if (c.kind !== 'group' || !c.active) continue;
      const active = this.config.groupProfiles?.[String(c.id)]?.active ?? this.config.groupActiveDefault;
      if (active < minActive) continue;
      const at = lastAt.get(c.address);
      out.push({
        label: `${this.groupNames.get(c.id) ?? bareGroupName(c.label)}(${c.id})`,
        quietMinutes: at === undefined ? null : Math.max(0, Math.floor((now - at) / 60_000)),
      });
    }
    // null = 一条消息都没见过，不是"安静很久"；其余按安静时长降序
    out.sort((a, b) => (b.quietMinutes ?? -1) - (a.quietMinutes ?? -1));
    return out;
  }

  /** 这个会话上次有动静是几分钟前；从没收到过消息返回 null。 */
  private quietMinutesOf(address: string): number | null {
    const now = Date.now();
    let latest: number | undefined;
    for (const rec of this.knownMessages.values()) {
      if (rec.conv !== address) continue;
      if (latest === undefined || rec.ts > latest) latest = rec.ts;
    }
    return latest === undefined ? null : Math.max(0, Math.floor((now - latest) / 60_000));
  }

  /**
   * 这个会话里今天别人说过的话（事件库原文，掐头去尾取最近一小段）。
   *
   * 只取 `senderKey === address` 的：素材是"这个会话里真发生过的事"，
   * 不是"库里的随便什么话"。另一个私聊里的原话搬到这个会话就是泄露。
   */
  private recentWordsOf(address: string): string {
    try {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const events = (this.host?.store?.range?.({ source: SOURCE, senderKey: address, limit: 120 }) ?? []) as Array<{ text?: string; ts?: string; origin?: string }>;
      const today = events.filter((e) => e.origin === 'external' && e.ts && Date.parse(e.ts) >= startOfDay.getTime());
      return clampText(stripLoneSurrogates(today.slice(-14).map((e) => String(e.text ?? '')).filter(Boolean).join('\n')), 2500);
    } catch {
      return '';
    }
  }

  private proactiveTargets(): ProactiveTarget[] {
    const mode = this.config.proactive.mode;
    const out: ProactiveTarget[] = [];
    for (const c of this.convs.values()) {
      if (!c.active) continue;
      if (c.id <= 0) continue;
      if (mode === 'private' && c.kind !== 'private') continue;
      if (mode === 'group' && c.kind !== 'group') continue;
      // 参与度低的群是"别硬凑"的群：主动冒泡只去够得着的地方。
      if (c.kind === 'group') {
        const active = this.config.groupProfiles?.[String(c.id)]?.active ?? this.config.groupActiveDefault;
        if (active < this.config.proactiveMinActive) continue;
      } else {
        // 私聊只主动找"最近跟自己说过话"的人（三天内）。监听名单里有两个群的全部人，
        // 少了这条她会挨个去私聊从没说过话的陌生人。
        const talked = this.talkingConvs().get(c.address) ?? 0;
        if (talked < Date.now() - 3 * 86400_000) continue;
      }
      out.push({ address: c.address, kind: c.kind, label: this.convTag(c.address) });
    }
    return out;
  }

  /** Credentials are resolved only through this deployment's explicit secret name. */
  private resolveSecret(name: string): string | undefined { return this.secretLookup?.(name) || process.env[name]; }

  async stop(): Promise<void> {
    const driver = this.driver;
    // Reject fresh calls from the moment stop begins, including while driver.stop awaits.
    this.driver = null;
    this.sendGeneration++;
    // 到点提醒：先停表，再把内存里那几条落盘（不然刚加的提醒重启就没了）。
    if (this.reminderTimer) {
      clearInterval(this.reminderTimer);
      this.reminderTimer = undefined;
    }
    this.reminders?.flush();
    // 私聊聚合窗口里还没投递的那几条，停之前先交出去：清掉计时器等于把它们永久丢掉
    // （既不进她的上下文，也不进事件库，连历史查询都找不到）。
    for (const c of this.convs.values()) {
      if (c.aggregationTimer) {
        clearTimeout(c.aggregationTimer);
        c.aggregationTimer = undefined;
      }
      this.flushAggregated(c);
    }
    if (this.stateSaveTimer) {
      clearTimeout(this.stateSaveTimer);
      this.stateSaveTimer = undefined;
    }
    this.saveState();
    this.people.flush();
    this.groups.flush();
    this.stickers?.flush();
    this.proactive?.stop();
    this.qzone?.stop();
    if (driver) await driver.stop();
    this.connected = false;
    for (const s of this.eventSockets) s.close('world stopped');
    this.eventSockets.clear();
  }

  /** 一轮自然收束：未确认的草稿只在本轮内有效（对齐内置 qq 的 onTurnEnded 作废草稿）。 */
  onTurnEnded(): void {
    this.pendingSends.clear();
  }

  // ---- 状态持久化（跨重启重建 knownMessages，防串台索引不丢）----
  /**
   * 索引只留最近这么多条。
   *
   * 这个表只服务于两件事：引用回复时的跨会话校验（`sameConversation`）和"这个会话安静了多久"。
   * 两件都只看最近的消息，但表只进不出：线上已经 3481 条 / 209KB，而每次追加都整表同步写盘。
   * 7×24 跑下去只会一直涨。
   */
  private static readonly KNOWN_MESSAGES_CAP = 2000;

  /** 超出上限就按时间丢掉最老的。 */
  private pruneKnownMessages(): void {
    const cap = QQWorld.KNOWN_MESSAGES_CAP;
    if (this.knownMessages.size <= cap) return;
    const sorted = [...this.knownMessages.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (const [key] of sorted.slice(0, this.knownMessages.size - cap)) this.knownMessages.delete(key);
  }

  private loadState(): void {
    if (!this.stateFile || !existsSync(this.stateFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as { knownMessages?: Record<string, { conv: string; ts: number }> };
      const km = raw.knownMessages ?? {};
      for (const [k, v] of Object.entries(km)) this.knownMessages.set(k, { conv: v.conv, ts: v.ts });
      this.pruneKnownMessages();
      this.log.info('已恢复 knownMessages', { count: this.knownMessages.size });
    } catch (e) {
      this.log.warn('读取 qqbot 状态失败', { err: String(e) });
    }
  }

  private saveState(): void {
    if (!this.stateFile) return;
    try {
      this.pruneKnownMessages();
      const obj = { knownMessages: Object.fromEntries(this.knownMessages) };
      writeFileSync(this.stateFile, JSON.stringify(obj), 'utf8');
    } catch (e) {
      this.log.warn('保存 qqbot 状态失败', { err: String(e) });
    }
  }

  /** 防抖落盘：每条消息索引更新后调用，1.5s 内合并一次写入。 */
  private scheduleSaveState(): void {
    if (!this.stateFile) return;
    if (this.stateSaveTimer) return;
    this.stateSaveTimer = setTimeout(() => {
      this.stateSaveTimer = undefined;
      this.saveState();
    }, 1500);
  }

  private async reloadIdentity(): Promise<void> {
    if (!this.driver) return;
    try {
      this.identity = await this.driver.refreshIdentity();
      this.log.info('已加载身份', { selfId: this.identity.selfId, groups: this.identity.groups.size });
      this.syncConfigRoster();
      this.syncFriendRoster();
      this.refreshConvLabels();
      await this.seedGroupMembers();
    } catch (e) {
      this.log.warn('加载身份失败', { err: String(e) });
    }
  }

  private syncConfigRoster(): void {
    for (const g of toIds(this.config.groups)) this.ensureConv('group', g);
    for (const p of toIds(this.config.privates)) this.ensureConv('private', p);
  }
  /**
   * 私聊配成 *（所有好友都能找她）时，把好友列表里的人全部补进监听名单。
   * 否则名单里只有群里的人：新加的好友能发进来，但控制台名单/前缀里看不到他，
   * 发消息也少一条已验证的会话。好友列表由 NapCat get_friend_list 提供，每次身份加载/通过好友时同步。
   */
  private syncFriendRoster(): void {
    if (!this.privateAll() || !this.identity) return;
    let added = 0;
    for (const id of this.identity.knownPeers.keys()) {
      const address = 'private:' + id;
      if (!this.convs.has(address)) {
        this.ensureConv('private', id);
        added++;
      }
    }
    if (added > 0) this.log.info('私聊监听名单已补齐好友', { added, total: this.identity.knownPeers.size });
  }

  /**
   * 启动时把监听群的成员名单拉下来。
   *
   * 两件事靠它：`@名字` 要能解析成号码（名单里没有的名字只能按普通文字发），
   * 私聊标签要能显示名字（监听名单里有群里所有人，光看号码认不出谁是谁）。
   * 拉不到就跳过——号码永远是准的，名字只是好读。
   */
  private async seedGroupMembers(): Promise<void> {
    if (!this.driver) return;
    for (const gid of toIds(this.config.groups)) {
      const members = await this.driver.getGroupMemberList(gid);
      if (!members.length) continue;
      const conv = this.ensureConv('group', gid);
      conv.members ??= new Map();
      for (const m of members) {
        conv.members.set(m.userId, m);
        const pc = this.convs.get(`private:${m.userId}`);
        if (pc && (!pc.label || pc.label === String(pc.id))) pc.label = m.name;
      }
      this.log.info('已加载群成员', { group: gid, members: members.length });
    }
  }

  private ensureConv(kind: 'group' | 'private', id: number): Conv {
    const address = `${kind}:${id}`;
    let c = this.convs.get(address);
    if (!c) {
      c = {
        kind,
        id,
        address,
        label: kind === 'group' ? (this.identity?.groups.get(id) ?? `群${id}`) : this.peerName(id),
        active: true,
      };
      this.convs.set(address, c);
    }
    return c;
  }

  /** 私聊对方的名字：身份里有昵称就用昵称，没有就退回 QQ 号（号码永远是对的）。 */
  private peerName(id: number): string {
    const p = this.identity?.knownPeers.get(id);
    return p?.nickname || p?.card || String(id);
  }

  /** 身份到手后把已有会话的名字补齐（群名、私聊昵称）；号码不变，标签只是给人读的。 */
  private refreshConvLabels(): void {
    for (const c of this.convs.values()) {
      if (c.kind === 'group') {
        const name = this.identity?.groups.get(c.id) ?? this.groupNames.get(c.id);
        if (name) c.label = name;
      } else {
        c.label = this.peerName(c.id);
      }
    }
  }

  /** 最近一次算"谁跟自己说过话"的时刻与结果（见 `talkingConvs`）。 */
  private talkingCache: { at: number; map: Map<string, number> } | null = null;

  /**
   * 最近这些天跟自己说过话的会话（地址 → 最近一次的时间戳）。跨重启成立。
   *
   * 为什么不用 `conv.lastMessageAt`：那是内存里的，一重启就空——她刚醒来时
   * "谁跟我说过话"会变成一个人都没有，连主人都从名单里消失。
   * 事件库里的原文才是这件事的凭据。她自己冒的泡（origin=internal）不算。
   */
  private talkingConvs(days = 30): Map<string, number> {
    const now = Date.now();
    if (this.talkingCache && now - this.talkingCache.at < 600_000) return this.talkingCache.map;
    const map = new Map<string, number>();
    try {
      const fromTs = new Date(now - days * 86400_000).toISOString();
      const events = (this.host?.store?.range?.({ source: SOURCE, fromTs, limit: 8000 }) ?? []) as Array<{
        type?: string;
        senderKey?: string;
        origin?: string;
        ts?: string;
      }>;
      for (const e of events) {
        if (e.type !== 'qq.message' || e.origin === 'internal' || !e.senderKey) continue;
        const ts = e.ts ? Date.parse(e.ts) : 0;
        const prev = map.get(e.senderKey) ?? 0;
        if (ts > prev) map.set(e.senderKey, ts);
      }
    } catch { /* 读不到事件库就当没有——宁可不列，也不编 */ }
    this.talkingCache = { at: now, map };
    return map;
  }

  private convLabel(address: string): string {
    return this.convs.get(address)?.label ?? address;
  }

  /**
   * 模型可见的会话死标签：**号码在前，名字在后**。
   *
   * 她是靠事件文本认人的（Core 只把 `e.text` 渲染进上下文，meta 到不了她眼前），
   * 所以事件行里必须有号码——只给群名，她就得自己把名字翻成号码，翻错就是把话说给另一个人听。
   * 这个标签同时充当 `qqbot_send` 的 `to`（`group:<群号>` / `private:<QQ号>`）的抄写来源。
   */
  private convTag(address: string): string {
    const c = this.convs.get(address);
    if (!c) return address;
    const named = c.label && c.label !== String(c.id) && c.label !== `群${c.id}` ? `「${c.label}」` : '';
    return c.kind === 'group' ? `群${c.id}${named}` : `私聊${c.id}${named}`;
  }

  /** 合批后逐行带标签时用的短标签（只有号码，没有名字）。 */
  private convTagShort(address: string): string {
    const c = this.convs.get(address);
    return c ? (c.kind === 'group' ? `群${c.id}` : `私聊${c.id}`) : address;
  }

  /** 监听名单里每个会话的会话标号 + 人话名字，一行一个。 */
  private addressList(): string {
    const out: string[] = [];
    for (const c of this.convs.values()) {
      if (!c.active || c.id <= 0) continue;
      out.push(`- ${c.address}　${this.convTag(c.address)}`);
    }
    return out.join('\n') || '（当前没有监听中的会话）';
  }

  // ---- 事件处理 ----
  /** 好友/群申请事件：好友申请按配置自动通过，并推给她知道。 */
  private handleRequest(ev: Record<string, unknown>): void {
    const type = String(ev.request_type ?? '');
    if (type !== 'friend') return;
    const flag = String(ev.flag ?? '');
    const userId = Number(ev.user_id ?? 0);
    const comment = String(ev.comment ?? '').trim();
    if (!flag || !userId) return;
    this.friendReqs.set(flag, { userId, comment, at: Date.now() });
    const auto = this.config.friendAutoAdd === true;
    const note = comment ? '（留言：' + comment.slice(0, 80) + '）' : '';
    if (auto) {
      const p = this.driver?.callApi('set_friend_add_request', { flag, approve: true });
      if (!p) return;
      void p
        .then(() => {
          this.friendReqs.delete(flag);
          try {
            this.identity?.knownPeers.set(userId, { nickname: String(userId) });
            const conv = this.ensureConv('private', userId);
            if (!conv.label || conv.label === String(userId)) conv.label = String(userId);
            this.log.info('新好友已加入监听名单', { userId });
          } catch { /* 名单补不上不影响通过好友 */ }
          void this.host?.pushEvent({
            type: 'qq.friend_added', ts: new Date().toISOString(), source: this.id, senderKey: String(userId),
            text: '有人加你好友，已经自动通过了：' + userId + note + '。以后他私聊你就能收到。',
          });
        })
        .catch((e: unknown) => {
          void this.host?.pushEvent({
            type: 'qq.friend_add_failed', ts: new Date().toISOString(), source: this.id, senderKey: String(userId),
            text: '有人加你好友，自动通过失败了（' + String((e as Error)?.message ?? e).slice(0, 120) + '）：' + userId + note + '。你可以用 qqbot_friend_approve 手动批。',
          });
        });
    } else {
      void this.host?.pushEvent({
        type: 'qq.friend_request', ts: new Date().toISOString(), source: this.id, senderKey: String(userId),
        text: '有人加你好友：' + userId + note + '。想通过就用 qqbot_friend_approve（flag=' + flag.slice(0, 40) + '）；不想理就 qqbot_friend_approve approve=false。',
      });
    }
  }

  private handleEvent(ev: OneBotMessage): void {
    if (!this.host) return;
    if (ev.post_type === 'meta_event') return;
    if (ev.post_type === 'notice') {
      this.enqueue(() => this.handleNotice(ev));
      return;
    }
    // QQ 空间互动事件（评论/点赞等）：交给 qzone 发布器处理，不进入聊天消息流。
    // post_type 用 string 比较：本扩展给 OneBotMessage 的 post_type 收窄成了消息类取值，
    // 而空间互动是协议端自己加的类型（qzone/interact），不在那个联合里。
    const postType = ev.post_type as string;
    if (postType === 'qzone' || postType === 'interact' || /qzone/i.test(String((ev as unknown as Record<string, unknown>).detail_type ?? (ev as unknown as Record<string, unknown>).sub_type ?? ''))) {
      if (this.qzone) void this.enqueue(() => this.qzone!.onEvent(ev as unknown as Record<string, unknown>));
      return;
    }
    if (ev.post_type === 'request') {
      this.handleRequest(ev as unknown as Record<string, unknown>);
      return;
    }
    if (ev.post_type !== 'message' && ev.post_type !== 'message_sent') return;
    if (ev.post_type === 'message_sent') return; // 忽略自己发出的回显，避免回环
    const kind = ev.message_type === 'private' ? 'private' : 'group';
    const id = kind === 'group' ? ev.group_id! : ev.user_id!;
    // 自己回声丢弃（双重保险：NapCat reverse 有时把自身消息以普通 message 回报）
    if (this.identity && Number(ev.user_id) === this.identity.selfId) return;
    if (!this.isListened(kind, id)) return;
    const conv = this.ensureConv(kind, id);
    conv.lastMessageAt = Date.now();
    this.proactive?.notifyReply(conv.address);
    // 收到对方发言：清零该会话的“bot 连续发言”计数，并刷新最后发言时间（防死循环）。
    this.botStreak.set(conv.address, 0);
    this.lastUserMsgAt.set(conv.address, Date.now());
    const sender = this.resolveSender(ev, kind, id);
    this.enqueue(() => this.handleMessage(ev, conv, sender));
  }

  /** 把一条事件处理任务接到串行链上（对齐内置 qq 的 enqueueMessage）。 */
  private enqueue(task: () => Promise<void>): void {
    this.msgChain = this.msgChain.then(task).catch((e) => {
      this.log.error('消息处理链异常', { err: String(e) });
    });
  }

  /** privates 里写了 * 就表示所有私聊都监听（所有好友都能找她）。 */
  private privateAll(): boolean {
    const raw = this.config.privates;
    const text = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
    return /(^|[\s,])[*]([\s,]|$)/.test(text) || text.trim() === 'all';
  }

  private isListened(kind: 'group' | 'private', id: number): boolean {
    if (kind === 'group') {
      const ids = toIds(this.config.groups);
      return ids.length === 0 || ids.includes(id);
    }
    return this.privateAll() || toIds(this.config.privates).includes(id);
  }

  private resolveSender(ev: OneBotMessage, kind: 'group' | 'private', id: number): QQSenderBrief {
    const s = ev.sender ?? {};
    const userId = ev.user_id ?? 0;
    let name = s.card || s.nickname || `用户${userId}`;
    let role = s.role;
    let title = s.title;
    if (kind === 'group' && this.driver) {
      // 名片可能为空，尝试补一次群成员信息
      if (!s.card && (s.nickname === undefined || s.nickname === '')) {
        void this.driver.getMemberInfo(id, userId).then((info) => {
          if (info) {
            const c = this.convs.get(`group:${id}`);
            if (c?.members) {
              const prev = c.members.get(userId);
              if (prev) c.members.set(userId, { ...prev, card: info.card, name: info.nickname, role: info.role, title: info.title });
            }
          }
        });
      }
      const conv = this.convs.get(`group:${id}`);
      if (conv) {
        conv.members ??= new Map();
        conv.members.set(userId, { userId, name, card: s.card, role, title });
      }
    }
    void this.identity?.knownPeers.set(userId, { nickname: s.nickname ?? name, card: s.card });
    return { userId, name, card: s.card, role, title };
  }

  /** 读上次落盘的最后来信时间。 */
  private loadInbound(): void {
    if (!this.inboundFile || !existsSync(this.inboundFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.inboundFile, 'utf8')) as Record<string, number>;
      for (const [qq, at] of Object.entries(raw ?? {})) {
        const n = Number(at);
        if (Number.isFinite(n) && n > 0) this.lastInbound.set(qq, n);
      }
    } catch { /* 坏了就当没有，下一次会重建 */ }
  }

  private scheduleSaveInbound(): void {
    if (!this.inboundFile || this.inboundTimer) return;
    this.inboundTimer = setTimeout(() => {
      this.inboundTimer = null;
      this.saveInbound();
    }, 3000);
    this.inboundTimer.unref?.();
  }

  private saveInbound(): void {
    if (!this.inboundFile) return;
    try {
      mkdirSync(dirname(this.inboundFile), { recursive: true });
      writeFileSync(this.inboundFile, JSON.stringify(Object.fromEntries(this.lastInbound)), 'utf8');
    } catch { /* 落盘失败不影响聊天 */ }
  }

  /** 记一条来信时间；同一 QQ 只留最新。 */
  private markInbound(qq: number | string): void {
    try {
      const key = String(qq ?? '');
      if (!key) return;
      if (!this.lastInbound) this.lastInbound = new Map();
      this.lastInbound.set(key, Date.now());
      this.scheduleSaveInbound();
    } catch { /* 记时间失败绝不能影响收消息 */ }
  }

  private async handleMessage(ev: OneBotMessage, conv: Conv, sender: QQSenderBrief): Promise<void> {
    // 私聊标签补上对方昵称：号码才是身份，名字只是让事件行和读数好认人。
    // 不补的话，好友列表没拿到时这里只剩一串号码，她认不出眼前这个人是谁。
    if (conv.kind === 'private' && sender.name) conv.label = sender.name;
    // 人册里见过这个人一面（有备注才记，见 PeopleBook.saw）
    this.people.saw(sender.userId, sender.name);
    // 记下他最后一次来信的时刻（生命/主动联系判断「多久没说话」用）
    this.markInbound(sender.userId);
    // 收到即索引 message_id → 会话（防串台核心：引用回复与跨会话校验都靠它，对齐内置）。
    if (ev.message_id != null) {
      this.knownMessages.set(String(ev.message_id), { conv: conv.address, ts: Date.now() });
      this.scheduleSaveState();
    }
    const host = this.host!;
    const segs: OneBotSegment[] =
      typeof ev.message === 'string' ? [{ type: 'text', data: { text: ev.message } }] : (ev.message ?? []);
    const selfId = this.identity?.selfId ?? 0;
    const atMe = segs.some((s) => s.type === 'at' && Number((s as { data: { qq: string } }).data.qq) === selfId);

    // 引用回复
    let replyText: string | undefined;
    let replyRef: string | undefined;
    const replySeg = segs.find((s) => s.type === 'reply');
    if (replySeg) {
      const rid = Number((replySeg as { data: { id: string } }).data.id);
      const q = await this.resolveQuoted(rid);
      replyRef = q.ref;
      replyText = q.text || undefined;
    }

    let text = renderIncoming(segs, { timezone: this.config.timezone, selfId, replyText, replyRef });
    let messageText = renderIncoming(segs.filter(segment => segment.type !== 'reply'), { timezone: this.config.timezone, selfId });
    // 语音：本地 ASR 转文字，转出来的话并进正文。
    // 并进正文而不是另开一条，是因为下游（情绪、事件行、她读到的、历史检索）都按这一份文本走——
    // 分开两处就会出现"她情绪上听见了、读到的却是 [语音]"这种自相矛盾。
    const said = await this.transcribeVoice(segs);
    // `renderIncoming` 已经给语音段渲染了 `[语音]`，这里把识别结果接在它后面，
    // 不是再补一个前缀——补前缀会变成 `[语音] [语音] 他说的话`。
    // 用函数式 replace：识别文本里可能有 `$&` 之类，字符串替换会被当成替换模式。
    if (said) {
      text = text ? text.replace(/\[语音\]/g, () => `[语音] ${said}`) : `[语音] ${said}`;
      messageText = messageText ? messageText.replace(/\[语音\]/g, () => `[语音] ${said}`) : `[语音] ${said}`;
    }
    this.log.info('HANDLE_IN kind=' + conv.kind + ' text=' + JSON.stringify(text).slice(0, 40));
    // 合并转发：异步展开内容作为补充事件（不阻塞主消息投递，对齐内置 lookupForward）
    const fwdSeg = segs.find((s) => s.type === 'forward');
    if (fwdSeg) {
      const fwdId = String((fwdSeg as { data: { id: string } }).data.id ?? '');
      if (fwdId) this.lookupForward(fwdId, conv, ev.message_id ?? '');
    }
    // 纯表情消息（无文字）：face 段无 url 无法收藏但仍需进入处理链（避免静默丢弃）；
    // sticker/image 段会在下方循环里判定是否收藏。
    if (!text && !segs.some((s) => s.type === 'image' || s.type === 'record' || s.type === 'forward' || s.type === 'sticker' || s.type === 'face')) return;

    const blobs: BlobInput[] = [];
    for (const s of segs) {
      if (s.type === 'image' && (s.data as { url?: string }).url) {
        const url = (s.data as { url: string }).url!;
        const digest = url.split('?')[0];
        this.recentImages.push({ url, conv: conv.address, at: Date.now() });
        if (this.recentImages.length > 50) this.recentImages.shift();
        if (this.attachesHere(conv) && host.modelFacts.accepts('image/png')) {
          const bytes = await this.fetchBytes(url);
          if (bytes) blobs.push({ bytes, mime: 'image/jpeg', name: 'qq-image', fallbackText: '[图片]' });
        }
        // 群里可以单独关掉被动识图：群图量大且大多与她无关，那是这一路最贵的开销。
        // 关掉只影响"收到就自动送去识别"，她主动看图（qqbot_view_image）照旧。
        const visionHere = this.config.vision.enabled
          && (conv.kind !== 'group' || this.config.visionInGroups);
        if (visionHere && !this.paused()) {
          void this.vision.register(url, Date.now() + 60_000)?.then((desc) => {
            if (desc && this.host) {
              void this.host.pushEvent({
                type: 'qq.image',
                ts: eventTs(this.config.timezone),
                source: SOURCE,
                text: `图片内容（${this.convTag(conv.address)}）：${desc}`,
                senderKey: `${conv.address}:vision`,
                meta: { conv: { kind: conv.kind, id: conv.id } },
              });
            }
          });
        }
        // 图片作为表情包收藏：该图片本身就得是表情（NapCat 推来的表情包常是 image 段，
        // 但 subType 往往为 null，仅靠 subType 会漏采；故同时认 summary 里的表情标记）。
        if (this.config.sticker.enabled && this.stickers) {
          const sd = s.data as { subType?: string; summary?: string };
          const summary = typeof sd.summary === 'string' ? sd.summary : '';
          const isStickerLike = sd.subType === 'sticker' || /\[?(动画)?表情|贴纸|sticker|emoji/i.test(summary);
          const asSticker = isStickerLike || this.config.sticker.captureMode === 'allImages';
          if (asSticker && !this.paused()) {
            this.stickers.ingest(url, conv.address, summary);
          }
        }
      } else if (s.type === 'sticker' && (s.data as { url?: string }).url) {
        // 真实表情包段（type=sticker）必须在顶层处理，不能塞进 image 分支里。
        if (this.config.sticker.enabled && this.stickers) {
          const url = (s.data as { url: string }).url!;
          const sd = s.data as { subType?: string; summary?: string };
          const summary = typeof sd.summary === 'string' ? sd.summary : '';
          if (!this.paused()) this.stickers.ingest(url, conv.address, summary);
        }
      } else if (s.type === 'record' && (s.data as { url?: string }).url) {
        // 已经转成文字并进正文了（见 handleMessage 开头），这里不必再来一遍；
        // 没配识别服务/识别失败时才留一个音频附件占位，让她知道"这是一条语音"。
        if (said) continue;
        const wav = await this.decodeVoice((s.data as { url: string }).url!);
        if (wav) blobs.push({ bytes: wav, mime: 'audio/wav', name: 'qq-voice', fallbackText: '[语音]' });
      }
    }

    const baseMeta = {
      // 对齐内置 qq World 的 `meta.conv = { kind, id }`：Persona 靠 `.kind` 判断这条是不是私聊。
      conv: { kind: conv.kind, id: conv.id },
      role: sender.role,
      user: sender.userId,
      atMe,
      card: sender.card,
      title: sender.title,
      platformMessageId: String(ev.message_id ?? ''),
      channel: 'qq',
      direction: 'inbound',
      messageText,
      messageTextBasis: 'normalized-message',
      messageTs: eventTs(this.config.timezone, new Date((ev.time ?? Date.now() / 1000) * 1000)),
    };

    if (conv.kind === 'private' && this.config.privateAggregationWindow > 0) {
      this.aggregatePrivate(conv, sender, text, blobs, baseMeta);
      return;
    }

    let sendClock = '';
    try { sendClock = shortTime(this.config.timezone, new Date((ev.time ?? Date.now() / 1000) * 1000)); } catch (e) { this.log.warn('shortTime FAIL ' + String(e)); }
    // 每行都带会话标号（号码）。合批会把几个会话的消息拼进同一轮，
    // 少了号码她就得靠昵称猜是谁、猜完还得把名字翻成号码——猜错就是把话说给另一个人听。
    const tag = this.convTag(conv.address);
    // 人册：说话那个人自己那一行带一句"你记的：…"。只在有备注时出现，
    // 也只在**他本人那一行**——不是把所有人的备注塞进每一轮前缀。
    const known = this.people.line(sender.userId, this.config.peopleNoteChars);
    const whoLine = known ? `（你记的：${known}）` : '';
    // 群册：这个地方的底细（什么分寸、有什么梗）。有时间闸门——同一个群
    // `groupLoreGapMs` 之内只贴一次，否则一天几百条群消息条条都带着它。
    const groupLine = conv.kind === 'group' && this.groups.shouldShow(conv.id, this.config.groupLoreGapMs)
      ? (() => {
          const l = this.groups.line(conv.id, this.config.groupLoreChars);
          return l ? `（这群：${l}）` : '';
        })()
      : '';
    const channelPrefix = conv.kind === 'group'
      ? `【${tag} ${sendClock}】${sender.name}(${sender.userId})${whoLine}${groupLine}`
      : `【${tag} ${sendClock}】${whoLine}`;
    // 直接对着她说的消息带一句提示。
    // 为什么需要：提示词里写了"回消息只有 qqbot_send 一条路"，但整批纯文本时她可能只把话写出来、
    // 不调工具——2026-09-23 凌晨交接之后连踩两条，主人那边一个字都没收到。
    // 只在她被叫到的时候加，其余消息保持安静。
    const cue = conv.kind === 'private' ? this.config.replyCue
      : (this.config.replyCueGroup && atMe ? this.config.replyCueGroup : '');
    this.log.info('HANDLE_PUSH pre kind=' + conv.kind);
    try {
      // 合批分档：私聊要"像在想一下"，群可以多攒一会儿。
      // 安静窗口取最宽、批次时限取最小，所以群里带上宽窗口不会拖慢私聊的回复。
      const quietGapMs = conv.kind === 'group' ? this.config.groupQuietGapMs : undefined;
      const maxBatchAgeMs = conv.kind === 'group'
        ? this.config.groupMaxBatchAgeMs
        : this.config.privateMaxBatchAgeMs;
      await host.pushEvent({
        type: 'qq.message',
        ts: eventTs(this.config.timezone, new Date((ev.time ?? Date.now() / 1000) * 1000)),
        source: SOURCE,
        origin: 'external',
        text: `${channelPrefix}：${text}${cue}`,
        senderKey: conv.address,
        meta: { ...baseMeta, sender: sender.name },
        blobs: blobs.length ? blobs : undefined,
        }, {
          trigger: atMe ? 'flush' : 'debounce',
          ...(quietGapMs !== undefined ? { quietGapMs } : {}),
          ...(maxBatchAgeMs !== undefined ? { maxBatchAgeMs } : {}),
        });
        this.log.info('HANDLE_PUSH ok');
    } catch (e) {
      this.log.error('HANDLE_PUSH FAIL ' + String(e));
    }
  }

  private aggregatePrivate(conv: Conv, sender: QQSenderBrief, text: string, blobs: BlobInput[], meta: Record<string, unknown>): void {
    const now = Date.now(), win = this.config.privateAggregationWindow;
    let pending = conv.pendingAggregatedText;
    if (pending && now - pending.firstAt >= win) {
      if (conv.aggregationTimer) clearTimeout(conv.aggregationTimer);
      conv.aggregationTimer = undefined;
      this.flushAggregated(conv);
      pending = undefined;
    }
    const message = { messageId: String(meta.platformMessageId ?? ''), ts: String(meta.messageTs ?? eventTs(this.config.timezone)), text: typeof meta.messageText === 'string' ? meta.messageText : text };
    const line = '【' + this.convTagShort(conv.address) + '】' + sender.name + '：' + text;
    if (blobs.length) this.aggBlobs.set(conv.address, [...(this.aggBlobs.get(conv.address) ?? []), ...blobs].slice(-4));
    if (pending) {
      pending.text += '\n' + line;
      pending.messages.push(message);
      return;
    }
    conv.pendingAggregatedText = { text: line, firstAt: now, meta: { ...meta }, messages: [message] };
    conv.aggregationTimer = setTimeout(() => {
      conv.aggregationTimer = undefined;
      this.flushAggregated(conv);
    }, win);
  }

  /** 取走这个会话攒着的附件（私聊聚合用）。 */
  private takeAggBlobs(address: string): BlobInput[] | undefined {
    const kept = this.aggBlobs.get(address);
    this.aggBlobs.delete(address);
    return kept?.length ? kept : undefined;
  }

  /** 聚合来源按平台消息保留，前缀、联系人备注和回复提示不混入 messageText。 */
  private flushAggregated(conv: Conv): void {
    const pending = conv.pendingAggregatedText, host = this.host;
    if (!pending || !host) return;
    conv.pendingAggregatedText = undefined;
    const messages = pending.messages.map(message => ({ ...message }));
    void host.pushEvent({
      type: 'qq.message', ts: messages[0].ts, source: SOURCE, origin: 'external',
      text: pending.text, senderKey: conv.address,
      meta: { ...pending.meta, conv: { kind: conv.kind, id: conv.id }, sender: '对话',
        platformMessageId: messages.length === 1 ? messages[0].messageId : null,
        messageText: messages.map(message => message.text).join('\n'), messageTextBasis: 'aggregated-normalized-messages', messages },
      blobs: this.takeAggBlobs(conv.address),
    }).catch(error => this.log.error('私聊聚合投递失败', { address: conv.address, count: messages.length, err: String(error) }));
  }

  /** 实时拉取被引用消息（对齐 fat-fish get_quoted_message 的 get_msg 路径）。 */
  private async resolveQuoted(rid: number): Promise<{ text?: string; ref?: string }> {    if (!this.driver) return {};
    try {
      const r: any = await this.driver.callApi('get_msg', { message_id: rid });
      if (!r) return {};
      const sender = r.sender ?? {};
      const ref = sender.nickname || (sender.user_id != null ? String(sender.user_id) : undefined);
      const text = renderIncoming(r.message, { timezone: this.config.timezone, selfId: 0 });
      return { text: text || '', ref };
    } catch (e) {
      this.log.warn('获取引用消息失败', { err: String(e), rid });
      return {};
    }
  }

  private async handleNotice(ev: OneBotMessage): Promise<void> {
    const host = this.host!;
    const t = ev.notice_type;
    if (t === 'group_recall' || t === 'friend_recall') {
      const id = ev.group_id ?? ev.user_id ?? 0;
      // 事件里没带会话号就丢掉这一条：造出一个 `private:0` 会一直挂在监听名单里，
      // 还会被当成可以主动打招呼的会话。
      if (!id) return;
      const conv = this.ensureConv(ev.group_id ? 'group' : 'private', id);
      const who = ev.user_id ?? 0;
      await host.pushEvent({
        type: 'qq.recall',
        ts: eventTs(this.config.timezone),
        source: SOURCE,
        text: `${this.convTag(conv.address)} 中 ${who} 撤回了一条消息`,
        senderKey: conv.address,
      });
    } else if (t === 'group_increase' || t === 'group_decrease') {
      if (!ev.group_id) return;
      const conv = this.ensureConv('group', ev.group_id);
      const op = ev.operator_id ?? 0;
      const who = ev.user_id ?? 0;
      const verb = t === 'group_increase' ? '加入' : '退出';
      // 进群流水落盘：好感 World 只读这个文件，给新人一个按群配的起步分。
      // 两个 World 之间只有这一个文件，写坏了那边只是少一个好感的起点。
      if (t === 'group_increase') {
        this.journalGroupEntry(ev.group_id ?? 0, who, this.convs.get(conv.address)?.members?.get(who)?.name ?? String(who));
      }
      await host.pushEvent({
        type: 'qq.member',
        ts: eventTs(this.config.timezone),
        source: SOURCE,
        text: `${this.convTag(conv.address)}：${who} ${verb}（操作者 ${op}）`,
        senderKey: conv.address,
      });
    } else if (t === 'notify') {
      const sub = ev.sub_type;
      const id = ev.group_id ?? ev.user_id ?? 0;
      if (!id) return;
      const conv = this.ensureConv(ev.group_id ? 'group' : 'private', id);
      if (sub === 'poke') {
        await host.pushEvent({
          type: 'qq.poke',
          ts: eventTs(this.config.timezone),
          source: SOURCE,
          text: `${this.convTag(conv.address)}：${ev.user_id} 戳了 ${ev.target_id}`,
          senderKey: conv.address,
        });
      } else if (sub === 'emoji') {
        await host.pushEvent({
          type: 'qq.react',
          ts: eventTs(this.config.timezone),
          source: SOURCE,
          text: `${this.convTag(conv.address)}：${ev.user_id} 对消息做了表情回应`,
          senderKey: conv.address,
        });
      }
    }
  }

  /** 从文本或显式 hint 解析引用消息编号（对齐内置 qq 的 #<id> 约定）。 */
  private resolveReplyMessageId(text: string, idHint?: number): number | undefined {
    if (idHint != null && Number.isFinite(idHint)) return idHint;
    const m = String(text ?? '').match(/#(\d+)/);
    return m ? Number(m[1]) : undefined;
  }

  /** 校验被引用消息是否属于同一会话（跨会话引用会误发 quote，必须拒绝）。 */
  private sameConversation(conv: string, id: number): boolean {
    const m = this.knownMessages.get(String(id));
    return !!m && m.conv === conv;
  }

  /**
   * 把 `to` 解析成一个监听中的会话地址（`group:<群号>` / `private:<QQ号>`）。
   *
   * 认下来的写法：事件行里的抄件（`group:123` / `private:123` / `群123` / `私聊123`）、
   * 光秃秃的号码（群里只有一个匹配时），以及**唯一**对得上的名字。
   * 认不出来或者对上好几个就报错——**绝不猜**：猜错就是把话说给另一个人听，
   * 收不回来，也没有第二次机会解释。
   */
  private resolveAddress(to: string): { address: string } | { error: string } {
    let raw = String(to ?? '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
    if (raw.startsWith('「') && raw.endsWith('」')) raw = raw.slice(1, -1).trim();
    if (!raw) return { error: `to 不能为空。当前会话标号：\n${this.addressList()}` };
    // 先整串认；认不出再取开头那一段（她常把回执里的「private:123（私聊123「某人」）」整条抄回来）。
    const whole = this.matchAddress(raw);
    if (whole) return whole;
    const lead = raw.match(/^(?:(group|private|群聊|群|私聊|好友|私)\s*[:：]?\s*)?(\d{5,12})/i);
    if (lead && lead[0].length < raw.length) {
      const viaLead = this.matchAddress(lead[0]);
      if (viaLead && 'address' in viaLead) return viaLead;
    }
    const hits = [...this.convs.values()].filter(
      (c) => c.active && (c.label === raw || this.convTag(c.address) === raw || bareGroupName(c.label) === raw),
    );
    if (hits.length === 1) return this.listenedAddress(hits[0].kind, hits[0].id);
    if (hits.length > 1) {
      return { error: `「${raw}」对上 ${hits.length} 个会话，分不清是哪个。请直接抄会话标号：\n${hits.map((c) => `- ${c.address}　${this.convTag(c.address)}`).join('\n')}` };
    }
    return { error: `认不出「${raw}」是哪个会话。当前会话标号（to 直接抄第一列）：\n${this.addressList()}` };
  }

  /** 认「带号码的一段」，认不出返回 null（交给名字匹配去试）。 */
  private matchAddress(raw: string): { address: string } | { error: string } | null {
    const m = raw.match(/^(?:(group|private|群聊|群|私聊|好友|私)\s*[:：]?\s*)?(\d{5,12})$/i);
    if (!m) return null;
    const word = (m[1] ?? '').toLowerCase();
    const id = Number(m[2]);
    if (word) {
      const kind: 'group' | 'private' = word === 'group' || word === '群' || word === '群聊' ? 'group' : 'private';
      return this.listenedAddress(kind, id);
    }
    // 没写 kind：群号和 QQ 号长得一样，只有唯一命中才敢发。
    const hits = [...this.convs.values()].filter((c) => c.active && c.id === id);
    if (hits.length === 1) return this.listenedAddress(hits[0].kind, hits[0].id);
    if (hits.length > 1) return { error: `${id} 同时是群号和 QQ 号，分不清要发哪个。请写全：group:${id} 或 private:${id}。` };
    return { error: `监听名单里没有 ${id}。当前会话标号：\n${this.addressList()}` };
  }

  private listenedAddress(kind: 'group' | 'private', id: number): { address: string } | { error: string } {
    if (!this.isListened(kind, id)) {
      return { error: `${kind === 'group' ? '群' : '私聊'} ${id} 不在监听名单里，无法发送。当前会话标号：\n${this.addressList()}` };
    }
    return { address: `${kind}:${id}` };
  }

  /** 合并转发节点渲染结果（对齐内置 qq 的 ForwardNode）。 */
  private renderForwardNode(value: OneBotMessage): ForwardNode {
    const sender = value.sender ?? {};
    const uid = sender.user_id;
    const isSelf = uid !== undefined && this.identity !== null && uid === this.identity.selfId;
    const nickname = sender.nickname || sender.card;
    const named = isSelf || (nickname !== undefined && nickname !== '' && nickname !== PLACEHOLDER_NICKNAME);
    const name = isSelf ? '你' : nickname ?? (uid !== undefined ? String(uid) : '?');
    const body = typeof value.message === 'string' ? value.message : renderSegmentsPlain(value.message ?? []);
    return {
      line: `${name}${uid !== undefined ? `(${uid})` : ''}: ${body}`,
      body,
      named,
      time: value.time != null ? Number(value.time) : undefined,
      userId: uid !== undefined ? String(uid) : undefined,
      messageType: value.message_type,
    };
  }

  /** 转发节点是否都是匿名（身份塌缩）：此时无法分辨发言人，提示可能是多人。 */
  private forwardIdentityCollapsed(nodes: ForwardNode[]): boolean {
    if (nodes.length < 2 || nodes.some((n) => n.named)) return false;
    const ids = new Set(nodes.map((n) => n.userId));
    return ids.size === 1 && !ids.has(undefined);
  }

  /** 展开合并转发消息并作为补充事件投递（对齐内置 qq 的 lookupForward）。 */
  private lookupForward(resId: string, conv: Conv, ofMessageId: number | string): void {
    const driver = this.driver;
    const host = this.host;
    if (!driver || !host) return;
    void driver
      .getForwardMessages(resId, this.config.forwardExpandLimit)
      .then((nodes) => {
        if (!this.host) return;
        const rendered = nodes.map((n) => this.renderForwardNode(n));
        // 一条都没取到：既不能编内容，也不能写成"你在转发里发的内容"（那是假的），直说取不到。
        if (!rendered.length) {
          void this.host.pushEvent({
            type: 'qq.forward',
            ts: eventTs(this.config.timezone),
            source: SOURCE,
            text: `[系统] #${ofMessageId} 的合并转发一条都没展开出来（记录可能已失效，或这个 OneBot 实现不支持 get_forward_msg）。`,
            senderKey: conv.address,
            meta: { conv: conv.address, forward_id: resId },
          });
          return;
        }
        // 合并转发自身节点塌缩补回（NapCat 常把“你转发的内容”单独成段但省略身份，需补全为“你”）
        if (this.identity && !rendered.some((n) => n.userId != null && Number(n.userId) === this.identity!.selfId)) {
          rendered.unshift({
            line: `你(${this.identity.selfId}): （你在转发里发的内容）`,
            body: '（你在转发里发的内容）',
            named: true,
            userId: String(this.identity.selfId),
          });
        }
        const collapsed = this.forwardIdentityCollapsed(rendered);
        const body = rendered.length ? rendered.map((n) => n.line).join('\n') : '(转发记录是空的)';
        const header = collapsed
          ? `[系统] #${ofMessageId} 引用的转发消息展开如下（里面的发言人身份没能取到，可能是多个人在说话）：`
          : `[系统] #${ofMessageId} 引用的转发消息展开如下：`;
        void this.host.pushEvent({
          type: 'qq.forward',
          ts: eventTs(this.config.timezone),
          source: SOURCE,
          text: `${header}\n${body}`,
          senderKey: conv.address,
          meta: { conv: conv.address, forward_id: resId },
        });
      })
      .catch((err) => {
        this.log.warn('展开合并转发失败', { err: String(err), resId });
        if (!this.host) return;
        void this.host.pushEvent({
          type: 'qq.forward',
          ts: eventTs(this.config.timezone),
          source: SOURCE,
          text: `[系统] #${ofMessageId} 引用的转发消息展开失败：${String(err)}`,
          senderKey: conv.address,
          meta: { conv: conv.address, forward_id: resId },
        });
      });
  }

  // ---- 发送（草稿-确认门）----
  // ---- 群聊发言限速 / 话题防死循环 ----
  private groupSpeakWindow(address: string): number[] {
    const gs = this.config.groupSpeak;
    if (!gs.enabled || !address.startsWith('group:')) return [];
    const now = Date.now();
    const winMs = Math.max(1, gs.windowSec) * 1000;
    const stamps = (this.groupSpeakStamps.get(address) ?? []).filter((t) => now - t < winMs);
    this.groupSpeakStamps.set(address, stamps);
    return stamps;
  }
  /** 群聊发言频率限制：超过窗口上限返回拦截文案（带 SEND_BLOCKED 前缀），否则 null。 */
  private checkGroupSpeak(address: string): string | null {
    const gs = this.config.groupSpeak;
    if (!gs.enabled || !address.startsWith('group:')) return null;
    const stamps = this.groupSpeakWindow(address);
    if (stamps.length >= Math.max(1, gs.maxPerWindow)) {
      return QQWorld.SEND_BLOCKED + `群 ${this.convLabel(address)} 发言频率已达上限（${gs.maxPerWindow}/${gs.windowSec}s），先不说了。`;
    }
    return null;
  }
  private recordGroupSpeak(address: string): void {
    if (!this.config.groupSpeak.enabled || !address.startsWith('group:')) return;
    const stamps = this.groupSpeakStamps.get(address) ?? [];
    stamps.push(Date.now());
    this.groupSpeakStamps.set(address, stamps);
  }
  /** 话题自动结束 / 防死循环：连续发言超限或对方长时间静默则拦截，返回带 SEND_BLOCKED 前缀的文案。 */
  private checkAntiLoop(address: string): string | null {
    const al = this.config.antiLoop;
    if (!al.enabled) return null;
    const streak = this.botStreak.get(address) ?? 0;
    const lastUser = this.lastUserMsgAt.get(address);
    // 没有“对方发言基线”时不启用 idle 收尾，否则会话启动后 bot 发第一条就会被永久拦住
    const sinceUser = lastUser == null ? -1 : Date.now() - lastUser;
    if (streak >= al.maxConsecutiveBotTurns) {
      return QQWorld.SEND_BLOCKED + `该会话已连续发言 ${streak} 次，自动结束话题（等对方先开口再继续）。`;
    }
    if (al.idleToEndSec > 0 && streak >= 1 && sinceUser >= 0 && sinceUser > al.idleToEndSec * 1000) {
      return QQWorld.SEND_BLOCKED + `对方已静默 ${Math.round(sinceUser / 1000)}s，话题自动收尾，先不说了。`;
    }
    return null;
  }
  private recordAntiLoop(address: string): void {
    if (!this.config.antiLoop.enabled) return;
    this.botStreak.set(address, (this.botStreak.get(address) ?? 0) + 1);
  }

  /**
   * 发出前把正文合成为语音、整条以语音条发出去。
   *
   * 合成失败、服务没配、或者字数超上限时**退回文字**，并在回执里说明原因——
   * 一条发不出去的语音比一条文字更糟。语音只有一段，不参与按句拆分。
   */
  async sendVoice(address: string, text: string, replyMessageId?: number, signal?: AbortSignal): Promise<string> {
    const generation = this.sendGeneration;
    const spoken = text.trim();
    const fallback = async (why: string) => `${await this.sendTo(address, text, replyMessageId, signal)}\n${why}`;
    if (!this.voice.enabled) return fallback('[voice unavailable, text fallback attempted]');
    if (!spoken) return this.sendTo(address, text, replyMessageId, signal);
    if (spoken.length > this.voice.maxChars) {
      return fallback(`[voice ignored: 正文 ${spoken.length} 字，超过 ${this.voice.maxChars} 字上限，尝试改发文字]`);
    }
    let bytes: Uint8Array;
    try {
      bytes = await this.voice.synthesize(spoken);
    } catch (e) {
      if (generation !== this.sendGeneration || signal?.aborted) return QQWorld.SEND_BLOCKED + '语音合成期间发送已取消，未尝试发送。';
      return fallback(`[voice failed, text fallback attempted] ${e instanceof Error ? e.message : String(e)}`);
    }
    if (generation !== this.sendGeneration || signal?.aborted) return QQWorld.SEND_BLOCKED + '语音合成期间发送已取消，未尝试发送。';
    const sent = await this.sendSegments(
      address,
      [{ type: 'record', data: { file: `base64://${Buffer.from(bytes).toString('base64')}` } }],
      replyMessageId,
      signal,
    );
    return `${sent}\n[voice: ${spoken.length} 字 → ${Math.round(bytes.byteLength / 1024)} KB]`;
  }

  private async sendTo(address: string, text: string, replyMessageId?: number, signal?: AbortSignal): Promise<string> {
    return this.sendSegments(address, buildOutgoing(text, this.stickerLibAbs, this.mentionResolver(address)), replyMessageId, signal);
  }

  /**
   * 本会话里按名字找一个人，供 `@名字` 发成 at 段。
   *
   * 只在群里查得到成员名单；私聊、或者名单里没有这个名字，就返回 undefined——
   * 那段文字原样发出去，比发一个 NapCat 解析不了的 at 段强。
   */
  private mentionResolver(address: string): (name: string) => string | undefined {
    const c = this.convs.get(address);
    if (!c || c.kind !== 'group') return () => undefined;
    return (name: string) => {
      for (const m of c.members?.values() ?? []) {
        if (m.name === name || m.card === name || String(m.userId) === name) return String(m.userId);
      }
      return undefined;
    };
  }

  /** 一段（或几段）已经组装好的段发出去；合批、限速、防死循环都在这里统一生效。 */
  private async sendSegments(address: string, outgoing: OneBotSegment[], replyMessageId?: number, signal?: AbortSignal): Promise<string> {
    const driver = this.driver, host = this.host, generation = this.sendGeneration;
    if (!driver) return QQWorld.SEND_BLOCKED + '未连接到 NapCat，未尝试发送。';
    if (signal?.aborted) return QQWorld.SEND_BLOCKED + '发送已取消，未尝试发送。';
    const gl = this.checkGroupSpeak(address);
    if (gl) return gl;
    const al = this.checkAntiLoop(address);
    if (al) return al;
    const [kind, idStr] = address.split(':');
    const id = Number(idStr);
    const paramsBase: Record<string, unknown> = kind === 'group'
      ? { message_type: 'group', group_id: id } : { message_type: 'private', user_id: id };
    const split = this.config.splitReplyBySentence && (kind === 'group' || this.config.splitPrivateReplies);
    let messages: OneBotSegment[][];
    try {
      messages = splitReplyIntoMessages(outgoing, {
        splitBySentence: split,
        sentencesPerMessage: this.config.sentencesPerMessage,
        maxBytes: this.config.maxMessageBytes,
        splitParagraphs: split && this.config.splitParagraphs,
        stripTrailingPeriod: this.config.stripTrailingPeriod,
        minChars: this.config.splitMinChars,
        maxMessages: this.config.splitReplyMaxMessages,
        coalesceShortSentences: this.config.coalesceShortSentences,
      }).map(segments => segments.filter(segment => segment.type !== 'text' || segment.data.text.trim())).filter(segments => segments.length);
    } catch (error) { return QQWorld.SEND_BLOCKED + (error instanceof Error ? error.message : String(error)); }
    if (!messages.length) return QQWorld.SEND_BLOCKED + '消息转换后没有可发送的段，未尝试发送。';
    if (replyMessageId != null) messages[0] = [{ type: 'reply', data: { id: String(replyMessageId) } }, ...messages[0]];
    const total = messages.length, ids: string[] = [];
    let accepted = 0, attempted = 0, receiptFailures = 0;
    let cancelled = false;
    for (let index = 0; index < total; index++) {
      if (this.driver !== driver || generation !== this.sendGeneration || signal?.aborted) { cancelled = true; break; }
      const segments = messages[index];
      attempted++;
      let response: any;
      try { response = await driver.callApi('send_msg', { ...paramsBase, message: segments }); }
      catch (error) {
        this.log.warn('发送结果未确认，停止后续分条', { err: String(error), address, attempted, total });
        break;
      }
      accepted++;
      const rawId = response?.message_id;
      const messageId = (typeof rawId === 'string' && rawId.trim()) || (typeof rawId === 'number' && Number.isFinite(rawId)) ? String(rawId) : null;
      if (messageId !== null) {
        ids.push(messageId);
        if (generation === this.sendGeneration) {
          this.knownMessages.set(messageId, { conv: address, ts: Date.now() });
          this.scheduleSaveState();
        }
      }
      const deliveredText = renderSegmentsPlain(segments.filter(segment => segment.type !== 'reply'));
      if (host) {
        try {
          await host.pushEvent({
            type: 'qq.sent', ts: eventTs(this.config.timezone), source: SOURCE, origin: 'external', tags: ['speak'], senderKey: address,
            text: '发送到 ' + address + ' 的第 ' + (index + 1) + '/' + total + ' 条已被服务受理（未确认对方已读；message_id: ' + (messageId ?? '未返回') + '）：\n' + deliveredText,
            meta: { conv: { kind, id, address }, direction: 'outbound', delivery: 'accepted', messageId, segmentIndex: index + 1, segmentCount: total, text: deliveredText },
          }, { trigger: 'piggyback' });
        } catch (error) {
          receiptFailures++;
          this.log.warn('发送已受理但回执事件记录失败', { err: String(error), address, messageId });
        }
      }
      if (index + 1 < total && this.config.sendIntervalMs > 0 && generation === this.sendGeneration && !signal?.aborted) await sleep(this.config.sendIntervalMs);
    }
    if (accepted && generation === this.sendGeneration) { this.recordGroupSpeak(address); this.recordAntiLoop(address); }
    const unconfirmed = attempted - accepted, unattempted = total - attempted;
    const detail = '共 ' + total + ' 条：服务已受理 ' + accepted + '，结果未确认 ' + unconfirmed + '，未尝试 ' + unattempted + '。'
      + (ids.length ? ' message_id: ' + ids.join(', ') + '。' : '')
      + (accepted > ids.length ? '其中 ' + (accepted - ids.length) + ' 条已受理但服务未返回 message_id，编号未知。' : '')
      + (cancelled ? '发送期间已停止或取消。' : '')
      + (receiptFailures ? '其中 ' + receiptFailures + ' 条回执事件未能记录；不要因此重发。' : '');
    if (!attempted) return QQWorld.SEND_BLOCKED + detail;
    if (!accepted) return QQWorld.SEND_FAILED + detail + '未收到成功回执；超时或断线时不能认定对方未收到，禁止自动整条重发。';
    if (accepted < total) return QQWorld.SEND_PARTIAL + detail + '请核对未确认部分；后续条目已停止，不要整条重发。';
    return '已向 ' + this.convLabel(address) + ' 发送 ' + accepted + '/' + total + ' 段（服务受理，非已读确认）。' + detail;
  }

  /** 包装宿主：在 pushEvent 后向控制台事件流广播（仅广播本扩展产生的事件）。 */
  private wrapHost(host: WorldHost): WorldHost {
    const base = host;
    const self = this;
    return {
      ...base,
      async pushEvent(e, opts) {
        const saved = await base.pushEvent(e, opts);
        if (saved.source === SOURCE) self.broadcastEvent(saved);
        return saved;
      },
    };
  }

  // ---- 工具 ----
  /**
   * 宿主是否处于暂停（她不说话）。宿主比线上框架的类型可能多带 `isPaused`，
   * 类型上没有这一项，所以在这里收窄一次；宿主没提供就当作没暂停。
   */
  private paused(): boolean {
    const h = this.host as (ExtWorldHost & { isPaused?: () => boolean }) | null;
    return h?.isPaused?.() ?? false;
  }

  tools(): ToolDef[] {
    const send: ToolDef = {
      name: 'qqbot_send',
      tags: ['speak'],
      barrierAfter: true,
      description:
        '回复 QQ 消息事件的唯一渠道：发送一条发往 QQ 群或私聊的消息（不要用 terminal_send，那只会发到控制台终端）。调用即直接发送，无需再确认。'
        + 'to 填事件行方括号里的会话标号——群是 "group:<群号>"，私聊是 "private:<QQ号>"，照抄那一行的号码，不要自己改、不要凭记忆写；不确定就先调 qqbot_conversations 看清单。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '发送目标，原样抄事件行最前面的会话标号：群 "group:<群号>"，私聊 "private:<QQ号>"。' },
          text: { type: 'string', description: '要发送的消息正文。可用 #编号 引用回复某条消息。' },
          reply_message_id: { type: 'number', description: '可选：引用回复的目标消息编号（也可在 text 里写 #编号）。必须是同一会话内的消息，否则会被拒绝。' },
          // 只有真配了语音服务才给她这个参数：给一个永远失败的能力只会让她反复试。
          ...(this.voice.enabled
            ? {
                voice: {
                  type: 'boolean',
                  description:
                    '把这条合成语音、以语音条发出去。默认是打字，语音是例外不是另一种常规选择。'
                    + `正文要短（不超过约 ${this.voice.maxChars} 字），合成失败或超长会自动改发文字并在回执里说明。`,
                },
              }
            : {}),
        },
        required: ['to', 'text'],
      },
      handler: async (args, ctx) => {
        const to = String(args.to ?? '').trim();
        const text = String(args.text ?? '').trim();
        this.log.info('qqbot_send调用参数', { to, textLength: text.length });
        if (!text) return { text: 'text 不能为空。', failed: true };
        const resolved = this.resolveAddress(to);
        if ('error' in resolved) return { text: resolved.error, failed: true };
        const address = resolved.address;
        const rid = this.resolveReplyMessageId(text, args.reply_message_id != null ? Number(args.reply_message_id) : undefined);
        if (rid !== undefined && !this.sameConversation(address, rid)) {
          return `[send failed] 引用消息 #${rid} 属于其他会话，不能作为「${this.convLabel(address)}」的引用回复。`;
        }
        const id = `d${Math.random().toString(36).slice(2, 8)}`;
        this.pendingSends.set(id, { address, label: this.convLabel(address), text, createdAt: Date.now(), replyMessageId: rid, sent: true });
        // 直接发送（去掉强制草稿门：LLM 起草后常常不调 qqbot_confirm_send，导致消息发不出去）
        const res = args.voice === true
          ? await this.sendVoice(address, text, rid, ctx?.signal)
          : await this.sendTo(address, text, rid, ctx?.signal);
        const entry = this.pendingSends.get(id);
        if (entry) entry.sent = true;
        // 暂停期间已到达的外部事件先排到下一轮
        if (this.host && typeof (this.host as { drainPendingEvents?: unknown }).drainPendingEvents === 'function') {
          const drained = await this.host.drainPendingEvents((e) => e.source === SOURCE);
          ctx?.queueExternalEvents?.(drained);
        }
        if (res.startsWith(QQWorld.SEND_BLOCKED)) {
          return `未能发送（编号 ${id}）到 ${address}（${this.convTag(address)}）：${res.slice(QQWorld.SEND_BLOCKED.length)}\n${rid !== undefined ? `（引用回复 #${rid} 未发出）\n` : ''}`;
        }
        if (res.startsWith(QQWorld.SEND_FAILED)) {
          return `发送失败（编号 ${id}）到 ${address}（${this.convTag(address)}）：${res.slice(QQWorld.SEND_FAILED.length)}\n`
            + '请先核对会话后再决定是否重试，避免在回执丢失时重复发送。\n';
        }
        if (res.startsWith(QQWorld.SEND_PARTIAL)) {
          return `只发出去一部分（编号 ${id}）到 ${address}（${this.convTag(address)}）：${res.slice(QQWorld.SEND_PARTIAL.length)}\n`
            + '请先核对未确认的段，不要整条重复发送。\n';
        }
        return `已发送（编号 ${id}）到 ${address}（${this.convTag(address)}）：${res}\n${rid !== undefined ? `（已绑定引用回复 #${rid}）\n` : ''}`;
      },
    };

    const conversations: ToolDef = {
      name: 'qqbot_conversations',
      tags: ['read'],
      barrierAfter: true,
      description:
        '列出当前监听的所有会话：会话标号（qqbot_send 的 to 要用它）、群名或对方昵称。'
        + '要发消息但不确定 to 该填什么号码时先查这里，不要凭记忆写号码。',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const rows = [...this.convs.values()].filter((c) => c.active && c.id > 0);
        if (!rows.length) return '当前没有监听中的会话。';
        const lines = rows.map((c) => {
          const profile = c.kind === 'group'
            ? `，参与度 ${this.config.groupProfiles?.[String(c.id)]?.active ?? this.config.groupActiveDefault}`
            : '';
          return `- ${c.address}　${this.convTag(c.address)}${profile}`;
        });
        return `监听中的会话（to 直接抄第一列）：\n${lines.join('\n')}`;
      },
    };

    const confirm: ToolDef = {
      name: 'qqbot_confirm_send',
      tags: ['speak'],
      barrierAfter: true,
      description: '（兼容别名）qqbot_send 现已直接发送，通常无需调用本工具；仅当仍有未发送草稿时可补发。',
      parameters: {
        type: 'object',
        properties: {
          draft: { type: 'string', description: 'qqbot_send 返回的草稿编号；留空则发送最近一条草稿。' },
        },
        required: [],
      },
      handler: async (args) => {
        const id = typeof args.draft === 'string' && args.draft ? args.draft : Array.from(this.pendingSends.keys()).pop();
        if (!id || !this.pendingSends.has(id)) return '没有待确认的草稿（qqbot_send 现已直接发送，通常无需调用本工具）。';
        const p = this.pendingSends.get(id)!;
        if (p.sent) return '该草稿已执行过发送尝试，请按原回执核对结果；为避免重复，本工具不再次发送。';
        this.pendingSends.delete(id);
        return await this.sendTo(p.address, p.text, p.replyMessageId);
      },
    };

    const viewImage: ToolDef = {
      name: 'qqbot_view_image',
      tags: ['read'],
      barrierAfter: true,
      description:
        '看一张 QQ 图片，返回文字描述。群里发的图平时只留一个 `[图片]` 占位，'
        + '你想知道那是什么就调这个（**要花一次视觉调用，别每张都看**）。'
        + '不传 url 时按 conv + index 到最近收到的图里找：conv 抄事件行的会话标号，index 是那个会话里往前数第几张（0=最新）。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '可选：直接给图片链接（事件里带的图）或本地文件路径；给了就不再翻缓冲。' },
          conv: { type: 'string', description: '可选：会话标号（如 group:100001）。留空 = 所有会话最近收到的那张。' },
          index: { type: 'number', description: '可选：往前数第几张，0=最新（默认 0）。' },
        },
        required: [],
      },
      handler: async (args) => {
        // 这里只管"她想看"这条路：只要配了视觉端点就能用，**不要求被动识图开着**。
        // 两者混在一起的话，关掉群里那笔最贵的自动开销时，会把"她想看才看"也一起关掉
        // ——群图于是只剩 `[图片]`，她连主动看一眼都做不到。
        if (!this.vision.ready) {
          return '看不了图：视觉端点没配（`worlds.qqbot.vision`）。让主人开一下。';
        }
        let url = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : '';
        if (!url) {
          const idxRaw = typeof args.index === 'number' && Number.isFinite(args.index) ? Math.max(0, Math.floor(args.index)) : 0;
          let pool = this.recentImages;
          const convArg = typeof args.conv === 'string' ? args.conv.trim() : '';
          if (convArg) {
            const r = this.resolveAddress(convArg);
            if ('error' in r) return r.error;
            pool = pool.filter((p) => p.conv === r.address);
          }
          // 从最新往回数：0=最新，和她说"刚那张"是同一个方向。
          const rec = pool[pool.length - 1 - idxRaw];
          if (!rec) {
            return convArg
              ? `这个会话最近没有收到过图片（缓冲里最近 50 张，可能已经翻过去了）。`
              : '还没有收到过任何图片，无法查看。';
          }
          url = rec.url;
        }
        // 本地路径也认：Vision 那边走 fetch，`file://` 它读不了，所以这里把文件读成 data URL。
        if (!/^(https?|data):/i.test(url)) {
          const p = isAbsolute(url) ? url : join(this.packageDir || '.', url);
          try {
            if (!existsSync(p)) return `本地没有这个文件：${p}`;
            const buf = readFileSync(p);
            if (buf.byteLength > this.config.vision.maxBytes) {
              return `图太大了（${Math.round(buf.byteLength / 1024 / 1024)} MB，上限 ${Math.round(this.config.vision.maxBytes / 1024 / 1024)} MB）：${p}`;
            }
            const mime = /\.png$/i.test(p) ? 'image/png'
              : /\.gif$/i.test(p) ? 'image/gif'
                : /\.webp$/i.test(p) ? 'image/webp'
                  : 'image/jpeg';
            url = `data:${mime};base64,${buf.toString('base64')}`;
          } catch (e) {
            return `读不了这个文件：${String(e)}`;
          }
        }
        const desc = await this.vision.viewImage(url);
        return desc ? `图片描述：${desc}` : '看图失败（下载或视觉端点异常，可稍后重试）。';
      },
    };

    const sendImage: ToolDef = {
      name: 'qqbot_send_image',
      tags: ['speak'],
      barrierAfter: true,
      description:
        '给某个会话发一张图。`image` 给本地文件路径或 http(s) 链接（本机下载后再发），二者挑一个。'
        + '配 `text` 就是"图 + 一句话"。发文字还是走 qqbot_send。'
        + `图片上限 ${Math.round(QQWorld.IMAGE_MAX_BYTES / 1024 / 1024)} MB，发不动会在回执里说明原因。`,
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '发送目标，原样抄事件行最前面的会话标号：群 "group:<群号>"，私聊 "private:<QQ号>"。' },
          image: { type: 'string', description: '本地文件路径（如 /home/user/pics/a.png）或 http(s) 链接。' },
          text: { type: 'string', description: '可选：跟图一起发的一句话。' },
        },
        required: ['to', 'image'],
      },
      handler: async (args, context) => {
        const generation = this.sendGeneration;
        const to = String(args.to ?? '').trim();
        const image = String(args.image ?? '').trim();
        const caption = String(args.text ?? '').trim();
        if (!image) return { text: 'image 不能为空（要给本地路径或链接）。', failed: true };
        const resolved = this.resolveAddress(to);
        if ('error' in resolved) return { text: resolved.error, failed: true };
        const address = resolved.address;
        const loaded = await this.loadOutgoingImage(image);
        if ('error' in loaded) return { text: loaded.error, failed: true };
        if (generation !== this.sendGeneration || context?.signal?.aborted) return { text: '图片读取期间发送已取消，未尝试发送。', failed: true };
        const segs: OneBotSegment[] = [
          { type: 'image', data: { file: `base64://${Buffer.from(loaded.bytes).toString('base64')}` } },
        ];
        if (caption) segs.push({ type: 'text', data: { text: caption } });
        const res = await this.sendSegments(address, segs, undefined, context?.signal);
        if (res.startsWith(QQWorld.SEND_BLOCKED)) return `未能发送到 ${address}：${res.slice(QQWorld.SEND_BLOCKED.length)}`;
        if (res.startsWith(QQWorld.SEND_FAILED) || res.startsWith(QQWorld.SEND_PARTIAL)) return `发送结果未完全确认到 ${address}：${res}请先核对会话，避免重复发送。`;
        return `已发送（${Math.round(loaded.bytes.byteLength / 1024)} KB 的图，来源 ${loaded.from}）到 ${address}（${this.convTag(address)}）：${res}`;
      },
    };

    const peopleNote: ToolDef = {
      name: 'qqbot_people_note',
      tags: ['write'],
      barrierAfter: true,
      description:
        '在**人册**里给某个人记一句：这人是谁、怎么处、别提什么。按 QQ 号记，跨群通用——'
        + '同一个人换昵称、换群，你照样认得出。以后他跟你说的话，那一行事件里会自动带上这句提醒。'
        + '记**你自己想记的**：一句就够，别把聊天记录抄进来（那些在历史里）。',
      parameters: {
        type: 'object',
        properties: {
          qq: { type: 'string', description: '那个人的 QQ 号（事件行里 `昵称(QQ号)` 括号里的数字）。' },
          note: { type: 'string', description: `一两句：他是谁、怎么处、别提什么。上限 ${PEOPLE_NOTE_MAX} 字。` },
          name: { type: 'string', description: '可选：记下他现在的昵称，方便你自己认。' },
        },
        required: ['qq', 'note'],
      },
      handler: async (args) => {
        const qq = String(args.qq ?? '').trim();
        const note = String(args.note ?? '').trim();
        if (!qq) return 'qq 不能为空（要那个人的号码）。';
        if (!note) return 'note 不能为空——空备注等于没记。';
        const key = this.people.set(qq, note, String(args.name ?? '').trim() || undefined);
        this.people.flush();
        return `记下了：${key} —— ${this.people.get(key)?.note ?? ''}`;
      },
    };

    const peopleList: ToolDef = {
      name: 'qqbot_people_list',
      tags: ['read'],
      barrierAfter: true,
      description: '看人册里都记了谁（按最近改过排序）。要确认自己记过谁、或者想改一条之前先看这里。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: '返回几条，默认 30。' } },
        required: [],
      },
      handler: async (args) => {
        const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.max(1, Math.min(200, args.limit)) : 30;
        const rows = this.people.list(limit);
        if (!rows.length) return '人册还是空的——想记谁就调 qqbot_people_note。';
        return `人册（${this.people.size} 人，列 ${rows.length} 条）：\n`
          + rows.map((r) => `- ${r.qq}${r.name ? `（${r.name}）` : ''}：${r.note}`).join('\n');
      },
    };

    const peopleForget: ToolDef = {
      name: 'qqbot_people_forget',
      tags: ['write'],
      barrierAfter: true,
      description: '从人册里删掉一个人的备注（记错了、或者不想再记着这个人）。',
      parameters: {
        type: 'object',
        properties: { qq: { type: 'string', description: '那个人的 QQ 号。' } },
        required: ['qq'],
      },
      handler: async (args) => {
        const qq = String(args.qq ?? '').trim();
        if (!qq) return 'qq 不能为空。';
        const ok = this.people.forget(qq);
        if (ok) this.people.flush();
        return ok ? `删掉了 ${normalizeQq(qq)} 的备注。` : `人册里没有 ${normalizeQq(qq)}。`;
      },
    };

    const peopleThread: ToolDef = {
      name: 'qqbot_people_thread',
      tags: ['write'],
      barrierAfter: true,
      description:
        '记一条**还没说完的话头**：下次这个人开口时，他那一行会带一句提醒你接上。'
        + '只记真的悬着的（"他说周五要交东西""约了周末打游戏"），不记流水、不记你自己的想法；'
        + `一个人最多 ${PEOPLE_THREAD_MAX} 条。说完了用 qqbot_people_thread_done 结掉。`,
      parameters: {
        type: 'object',
        properties: {
          qq: { type: 'string', description: '那个人的 QQ 号。' },
          text: { type: 'string', description: `那句话头（上限 ${PEOPLE_THREAD_CHARS} 字）。` },
        },
        required: ['qq', 'text'],
      },
      handler: async (args) => {
        const r = this.people.addThread(String(args.qq ?? ''), String(args.text ?? ''));
        if (!r.ok) return r.why;
        this.people.flush();
        return `记下了。他这儿挂着：${r.threads.map((t, i) => `${i + 1}. ${t}`).join('　')}`;
      },
    };

    const peopleThreadDone: ToolDef = {
      name: 'qqbot_people_thread_done',
      tags: ['write'],
      barrierAfter: true,
      description: '结掉一条话头（说完了、或者那事已经过去了）。序号或那句话里的几个字都行。',
      parameters: {
        type: 'object',
        properties: {
          qq: { type: 'string', description: '那个人的 QQ 号。' },
          which: { type: 'string', description: '第几条（1 起），或者那句话里包含的几个字。' },
        },
        required: ['qq', 'which'],
      },
      handler: async (args) => {
        const r = this.people.closeThread(String(args.qq ?? ''), String(args.which ?? ''));
        if (!r.ok) return r.why;
        this.people.flush();
        return `结掉了：${r.closed}${r.left.length ? `\n还挂着：${r.left.join('；')}` : '\n他这儿没有悬着的事了。'}`;
      },
    };

    const groupNote: ToolDef = {
      name: 'qqbot_group_note',
      tags: ['write'],
      barrierAfter: true,
      description:
        '给一个群记一句**这地方是什么样**：什么气氛、什么分寸、谁是自己人、什么话题别碰。'
        + `一句话，上限 ${GROUP_NOTE_MAX} 字。以后你在这个群说话时，那一行会（隔一阵）带出来提醒你。`,
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string', description: '群号（会话标号里的数字，如 100001）。' },
          note: { type: 'string', description: '一句话：这地方是什么样。' },
          name: { type: 'string', description: '可选：群名。' },
        },
        required: ['group', 'note'],
      },
      handler: async (args) => {
        const group = String(args.group ?? '').trim();
        if (!normalizeGroup(group)) return 'group 要填群号。';
        const key = this.groups.setNote(group, String(args.note ?? ''), String(args.name ?? '').trim() || undefined);
        this.groups.flush();
        return `记下了 ${key}：${this.groups.get(key)?.note ?? ''}`;
      },
    };

    const groupLore: ToolDef = {
      name: 'qqbot_group_lore',
      tags: ['write'],
      barrierAfter: true,
      description:
        '往一个群里添一条**这儿的梗 / 黑话 / 内部说法**——那种别人一提就懂、你不懂的词。'
        + `最多 ${GROUP_LORE_MAX} 条、每条不超过 ${GROUP_LORE_CHARS} 字。不是记别人的事，是记这地方的话怎么讲。`,
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string', description: '群号。' },
          text: { type: 'string', description: `那条梗 / 那个说法（上限 ${GROUP_LORE_CHARS} 字）。` },
        },
        required: ['group', 'text'],
      },
      handler: async (args) => {
        const r = this.groups.addLore(String(args.group ?? ''), String(args.text ?? ''));
        if (!r.ok) return r.why;
        this.groups.flush();
        return `记下了。这儿的梗：${r.lore.join('；')}`;
      },
    };

    const stickerSave: ToolDef = {
      name: 'qqbot_sticker_save',
      tags: ['write'],
      barrierAfter: true,
      description:
        '收藏一张表情包：给图片 URL（http/https）或本机文件路径，下载/复制进表情包目录并登记索引。'
        + '返回里会有真实文件名；之后把 [表情包:文件名] 写进回复文本就能把它发出去。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '图片 URL（http/https）。' },
          path: { type: 'string', description: '本机图片文件路径。' },
          summary: { type: 'string', description: '可选：这张表情包叫什么/什么情绪（会显示在列表里）。' },
        },
        required: [],
      },
      handler: async (args) => {
        this.log.info('调用 qqbot_sticker_save');
        const source = String(args.url ?? args.path ?? '').trim();
        if (!source) return '[没做] 给 url 或 path。';
        if (!this.stickers) return '[没做] 表情包存储没初始化（world 还没 start）。';
        try {
          const r = await this.stickers.saveFrom(source, String(args.summary ?? ''));
          if (!r) return '[失败] 取不到这张图（URL 打不开，或者本地文件不存在）。';
          return `[已收藏] ${r.file}（${r.label}${r.emotion !== '未知' ? ' / ' + r.emotion : ''}）\n发的时候写：[表情包:${r.file}]`;
        } catch (e) {
          return '[失败] ' + String((e as Error)?.message ?? e).slice(0, 200);
        }
      },
    };

    const stickerStats: ToolDef = {      name: 'qqbot_sticker_stats',
      tags: ['read'],
      barrierAfter: true,
      description:
        '看表情包：本地目录里现在能发几张（附真实文件名），以及自动收藏索引的统计（总数、按情感分布、最近若干条）。想给 QQ 回复发表情包图片时，先调本工具拿到真实文件名（返回里的 [表情包:xxx.jpg]），再把整段 [表情包:文件名] 写进回复文本即可自动发出；不要编造不存在的文件名。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: '返回最近几条，默认 10。' } },
        required: [],
      },
      handler: async (args) => {
        this.log.info('调用 qqbot_sticker_stats');
        const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.max(1, Math.min(50, args.limit)) : 10;
        const lib = listStickerFiles(this.stickerLibAbs);
        const head = lib.length
          ? `本地表情包目录里能直接发 ${lib.length} 张，这些名字都能用：\n${lib.slice(0, limit).map((f) => `- [表情包:${f}]`).join('\n')}`
          : '本地表情包目录里没有图片文件（看 worlds.qqbot.emojiDir 指的是哪个目录）。';
        if (!this.stickers) return head;
        const s = this.stickers.stats(limit);
        if (!s.total) return `${head}\n自动收藏的索引还是空的（worlds.qqbot.sticker.enabled 关着就不会往里写）。`;
        const lines = s.recent.map(
          (m) =>
            `- [表情包:${m.file}] ${m.label}（情感:${m.emotion} / 用处:${m.usage}${m.tag ? ' / 标签:' + m.tag : ''} / 出现${m.count}次）`,
        );
        const byEmo = Object.entries(s.byEmotion).map(([k, v]) => `${k}:${v}`).join('，') || '无';
        return `${head}\n自动收藏 ${s.total} 张；情感分布：${byEmo}\n最近：\n${lines.join('\n')}`;
      },
    };

    // ---- 戳一戳 ----
    const pokeTool: ToolDef = {
      name: 'qqbot_poke',
      tags: ['speak'],
      barrierAfter: false,
      description:
        '戳一戳某个人（群戳一戳或私聊戳一戳）。target 为会话地址 group:<群号> 或 private:<QQ号>（原样复制事件 meta 里的 conv 字段）；'
        + 'user 为要戳的人的 QQ 号或群内昵称（私聊戳一戳时留空表示戳对话对象）。这是一个动作，不是文字消息。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '会话地址，原样复制事件 meta 里的 conv 字段。' },
          user: { type: 'string', description: '要戳的人的 QQ 号或群内昵称；私聊戳一戳时留空表示戳对话对象。' },
        },
        required: ['target'],
      },
      handler: async (args) => {
        this.log.info('调用 qqbot_poke');
        const to = String(args.target ?? '').trim();
        const parsed = this.resolveAddress(to);
        if ('error' in parsed) return parsed.error;
        const address = parsed.address;
        const sep = address.indexOf(':');
        const kind: 'group' | 'private' = address.slice(0, sep) === 'group' ? 'group' : 'private';
        const id = Number(address.slice(sep + 1));
        if (!Number.isFinite(id)) return 'target 格式应为 group:<群号> 或 private:<QQ号>。';
        if (!this.isListened(kind, id)) return '该会话不在监听名单内，无法戳一戳。';
        const driver = this.driver;
        if (!driver) return '未连接到 NapCat。';
        const userRaw = args.user != null ? String(args.user).replace(/^@/, '').trim() : '';
        let userId: number | null = null;
        if (!userRaw) {
          if (kind === 'private') userId = id;
          else return '群戳一戳需要指定 user（QQ 号或群内昵称）。';
        } else if (/^\d{5,}$/.test(userRaw)) {
          userId = Number(userRaw);
        } else {
          const conv = this.convs.get(address);
          if (conv?.members) {
            for (const m of conv.members.values()) {
              if (m.name === userRaw || m.card === userRaw) { userId = m.userId; break; }
            }
          }
        }
        if (userId == null) return `无法把 "${userRaw}" 解析成 QQ 号（私聊只能填 QQ 号；群内昵称需为本群成员）。`;
        try {
          if (kind === 'group') await driver.callApi('group_poke', { group_id: id, user_id: userId });
          else await driver.callApi('friend_poke', { user_id: userId });
          try {
            // 这是动作回执，不是 Persona 自言自语；internal 里只放确认过的数值编号。
            const text = `QQ 戳一戳动作已完成：会话 ${address}，目标 QQ ${userId}。`;
            await this.host?.pushEvent({
              type: 'qq.poke',
              ts: eventTs(this.config.timezone),
              source: SOURCE,
              origin: 'internal',
              text,
              senderKey: address,
              meta: { conv: address, kind: 'action_receipt', targetQQ: userId },
            } as never, { trigger: 'piggyback' });
          } catch (fe) {
            this.log.warn('qqbot_poke 回灌上下文失败 ' + String(fe));
          }
          return `已戳一戳 ${userRaw || '对话对象'}（QQ ${userId}）。`;
        } catch (e) {
          return '戳一戳失败：' + String((e as Error)?.message ?? e).slice(0, 200);
        }
      },
    };

    // ---- 智能体私人笔记本（本地 notebook.jsonl）----
    const noteSave: ToolDef = {
      name: 'qqbot_note_save',
      tags: ['write'],
      description:
        '把显式提供的 text 保存到本扩展本地笔记本；文本可由 qqbot_note_get 查看，不调用其他扩展或 Persona 的 Memory 工具。',
      parameters: { type: 'object', properties: { text: { type: 'string', description: '要记的内容' } }, required: ['text'] },
      handler: async (args) => {
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!text) return { text: 'text 不能为空', error: 'text 不能为空', ok: false };
        if (!this.notebook) return { text: '笔记本未初始化（world 还没 start）', error: '笔记本未初始化（world 还没 start）', ok: false };
        const r = await this.notebook.save(text);
        const preview = text.length > 60 ? text.slice(0, 60) + '…' : text;
        return { text: `已记到笔记本（本地）：${preview}`, ok: true, id: r.id, backend: r.backend };
      },
    };
    const noteList: ToolDef = {
      name: 'qqbot_note_list',
      tags: ['read'],
      description: '列出私人笔记本里的全部条目（本地 notebook.jsonl）。用于回看你记过什么。',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        if (!this.notebook) return { text: '笔记本未初始化', error: '笔记本未初始化', ok: false };
        const entries = await this.notebook.list();
        if (!entries.length) return { text: '笔记本还是空的，还没记过东西。', ok: true, count: 0, backend: this.notebook.backend, entries: [] };
        const lines = entries.map((e) => `-${e.id} ${e.text}`);
        return { text: `笔记本（本地）共 ${entries.length} 条：\n` + lines.join('\n'), ok: true, count: entries.length, backend: this.notebook.backend, entries: entries.map((e) => ({ id: e.id, text: e.text, ts: e.ts })) };
      },
    };
    const noteGet: ToolDef = {
      name: 'qqbot_note_get',
      tags: ['read'],
      description: '按 id 查看某条笔记本内容。id 来自 qqbot_note_list 的条目 id。',
      parameters: { type: 'object', properties: { id: { type: 'string', description: '条目 id' } }, required: ['id'] },
      handler: async (args) => {
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (!id) return { text: 'id 不能为空', error: 'id 不能为空', ok: false };
        if (!this.notebook) return { text: '笔记本未初始化', error: '笔记本未初始化', ok: false };
        const e = await this.notebook.get(id);
        if (!e) return { text: `没找到 id=${id} 的笔记。`, ok: true, found: false };
        return { text: `笔记 #${id}：${e.text}`, ok: true, found: true, id: e.id, content: e.text, ts: e.ts };
      },
    };
    const noteForget: ToolDef = {
      name: 'qqbot_note_forget',
      tags: ['write'],
      description: '删除一条笔记本（你确定不再需要它时）。id 来自 qqbot_note_list 的条目 id。',
      parameters: { type: 'object', properties: { id: { type: 'string', description: '条目 id' } }, required: ['id'] },
      handler: async (args) => {
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (!id) return { text: 'id 不能为空', error: 'id 不能为空', ok: false };
        if (!this.notebook) return { text: '笔记本未初始化', error: '笔记本未初始化', ok: false };
        const ok = await this.notebook.forget(id);
        return ok ? { text: `已删除笔记本 #${id}。`, ok: true, id } : { text: `没找到 id=${id} 的笔记，未删除。`, ok: true, found: false };
      },
    };

    const proactiveStatus: ToolDef = {
      name: 'qqbot_proactive_status',
      tags: ['read'],
      barrierAfter: true,
      description: '查看主动说话调度器状态：运行态（暖场/稳定/静默）、今日已发/配额、各会话未回复与静默情况、最近主动说过的话。',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        if (!this.proactive) return '主动说话调度器未启用。';
        const s = this.proactive.status(this.proactiveTargets().length);
        const per = Object.entries(s.perAddr)
          .map(([a, v]) => `- ${a}：态=${v.state} 未回复=${v.unreplied}${v.silentUntil ? ' 静默至=' + new Date(v.silentUntil).toISOString() : ''}`)
          .join('\n') || '（无会话状态）';
        const recent = s.recent.length ? s.recent.slice(-5).map((t, i) => `  ${i + 1}. ${t}`).join('\n') : '（暂无）';
        return `候选调度：${s.runState}；今日 ${s.dailyCount}/${s.dailyQuota}；可主动会话 ${s.targets}\n会话状态：\n${per}\n最近候选：\n${recent}`;
      },
    };

    const proactiveTrigger: ToolDef = {
      name: 'qqbot_proactive_trigger',
      tags: ['write'],
      barrierAfter: true,
      description: '请求一个监听会话候选事件；可指定 address。不会发送消息，正文与是否发送由 Persona 决定。',
      parameters: {
        type: 'object',
        properties: { address: { type: 'string', description: '可选：目标会话地址，如 private:123 / group:456；留空则随机。' } },
        required: [],
      },
      handler: async (args) => {
        if (!this.proactive) return '主动说话调度器未启用（先在控制台开 worlds.qqbot.proactive.enabled）。';
        const addr = typeof args.address === 'string' && args.address ? args.address : undefined;
        return this.proactive.trigger(addr);
      },
    };

    const qzonePost: ToolDef = {
      name: 'qqbot_qzone_post',
      tags: ['speak'],
      barrierAfter: true,
      description:
        '在 QQ 空间发布明确提供的 content 正文。仅附上 images 中明确指定的图片，不读取聊天或自动生成。permission 默认公开；确认内容和图片适合公开后调用。返回 tid 供后续删除/回复。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要发布的完整正文，不能为空。' },
          topic: { type: 'string', description: '已弃用；请在 content 中提供完整正文。' },
          images: { type: 'array', items: { type: 'string' }, description: '附图链接数组（file:// / http(s):// / base64://）。' },
          ats: { type: 'array', items: { type: 'string' }, description: '@的人：昵称或 QQ 号数组。' },
          permission: { type: 'number', description: '可见权限 ugc_right，默认 1=公开。' },
        },
        required: ['content'],
      },
      handler: async (args) => {
        if (!this.qzone) return 'QQ空间动态未启用（先在控制台开 worlds.qqbot.qzone.enabled 并重启）。';
        const r = await this.qzone.post({
          content: typeof args.content === 'string' ? args.content : undefined,
          topic: typeof args.topic === 'string' ? args.topic : undefined,
          images: Array.isArray(args.images) ? args.images.filter((x) => typeof x === 'string') : undefined,
          ats: Array.isArray(args.ats) ? args.ats.filter((x) => typeof x === 'string') : undefined,
          permission: typeof args.permission === 'number' ? args.permission : undefined,
        });
        return r.ok
          ? `已发 QQ空间动态。tid=${r.tid ?? '(未知)'}；内容：${r.text ?? ''}`
          : `发 QQ空间动态失败：${r.error ?? '未知错误'}`;
      },
    };

    const qzoneDelete: ToolDef = {
      name: 'qqbot_qzone_delete',
      tags: ['speak'],
      barrierAfter: true,
      description: '删除一条 QQ 空间动态。tid 来自 qqbot_qzone_post 的返回或 qqbot_qzone_status 的最近列表。',
      parameters: {
        type: 'object',
        properties: { tid: { type: 'string', description: '要删除的动态 tid。' } },
        required: ['tid'],
      },
      handler: async (args) => {
        if (!this.qzone) return 'QQ空间动态未启用。';
        const tid = String(args.tid ?? '');
        if (!tid) return '缺少 tid。';
        const r = await this.qzone.delete(tid);
        return r.ok ? `已删除 QQ空间动态 tid=${tid}。` : `删除失败：${r.error ?? '未知错误'}`;
      },
    };

    const qzoneReply: ToolDef = {
      name: 'qqbot_qzone_reply',
      tags: ['speak'],
      barrierAfter: true,
      description: '通过明确配置的 qzone.commentAction 回复指定空间评论。需要 tid、comment_id 与显式正文；未配置或协议端不支持时返回失败，不依赖其他扩展。',
      parameters: {
        type: 'object',
        properties: {
          tid: { type: 'string', description: '动态 tid。' },
          comment_id: { type: 'string', description: '评论 id。' },
          content: { type: 'string', description: '回复内容。' },
        },
        required: ['tid', 'comment_id', 'content'],
      },
      handler: async (args) => {
        if (!this.qzone) return 'QQ空间动态未启用。';
        const tid = String(args.tid ?? '');
        const cid = String(args.comment_id ?? '');
        const content = typeof args.content === 'string' ? args.content : '';
        if (!tid || !cid || !content) return 'tid / comment_id / content 都不能为空。';
        const r = await this.qzone.replyComment(tid, cid, content);
        return r.ok
          ? `已回复 QQ空间评论（tid=${tid}, comment_id=${cid}）。`
          : `回复不了：${r.error ?? '未知错误'}`;
      },
    };

    const qzoneFeeds: ToolDef = {
      name: 'qqbot_qzone_feeds',
      tags: ['read'],
      barrierAfter: true,
      description: '查看自己的 QQ 空间动态列表（尽力而为；依赖 NapCat 的 get_qzone_msg_list 是否支持）。',
      parameters: {
        type: 'object',
        properties: { num: { type: 'number', description: '返回条数，默认 5。' } },
        required: [],
      },
      handler: async (args) => {
        if (!this.qzone) return 'QQ空间动态未启用。';
        const num = typeof args.num === 'number' && Number.isFinite(args.num) ? Math.max(1, Math.min(50, args.num)) : 5;
        const r = await this.qzone.getFeeds(num);
        if (!r.ok) return `获取动态列表失败：${r.error ?? '未知错误'}`;
        return `最近 ${num} 条动态：\n${JSON.stringify(r.feeds ?? []).slice(0, 2000)}`;
      },
    };

    const qzoneStatus: ToolDef = {
      name: 'qqbot_qzone_status',
      tags: ['read'],
      barrierAfter: true,
      description: '查看 QQ 空间动态发布器状态：是否开启、今日已发/配额、自动回复评论是否开、最近发的动态（含 tid）。',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        if (!this.qzone) return 'QQ空间动态未启用（先在控制台开 worlds.qqbot.qzone.enabled 并重启）。';
        const s = this.qzone.status();
        const posts = (s.lastPosts as Array<{ tid?: string; text: string }>).map((p) => `- tid=${p.tid ?? '?'}：${p.text}`).join('\n') || '（暂无）';
        return `QQ空间动态：开启=${s.enabled}；今日自动 ${s.dailyCount}/${s.dailyQuota}；自动回评=${s.autoReply}（今日 ${s.replyDailyCount}）；最近动态：\n${posts}`;
      },
    };

    // ---- 到点提醒（移植自上游 0.1.63 的 reminder）----
    // 「等会儿要做的事」不落盘就等于没记；这条让她能自己定闹钟，到点由这台机器
    // 主动把她叫醒（推一条内部事件），而不是指望她记得几分钟前答应过什么。
    const reminderAdd: ToolDef = {
      name: 'qqbot_reminder_add',
      description:
        '给自己定一条到点提醒（闹钟）。到点会推给你一条内部事件，提示你当时记下的事，'
        + '要不要在那个会话里说、说什么，到点你自己定。用来兜住「等会儿要做的事」' 
        + '和「跟人说好了几点」——不记下来就会忘。',
      tags: ['write'],
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要提醒自己的内容（写清楚要做什么，别只写"那件事"）。' },
          time: {
            type: 'string',
            description: '什么时候提醒。支持：`30分钟后`/`2小时`/`3天`、`今天 21:30`/`明天 09:00`、'
              + '或绝对时间 `2026-10-12T09:00:00+08:00`。',
          },
          address: {
            type: 'string',
            description: '到点在哪个会话提醒（`group:<群号>` 或 `private:<QQ号>`）。不填＝记住当前这个会话。',
          },
        },
        required: ['text', 'time'],
      },
      handler: async (args, ctx) => {
        const text = String(args.text ?? '').trim();
        if (!text) return '[提醒没记下] text 不能为空。';
        const when = parseWhen(String(args.time ?? ''));
        if (when === null) {
          return '[提醒没记下] 时间没看懂。用 `30分钟后`、`2小时`、`明天 09:00` 或 `2026-10-12T09:00:00+08:00` 这种写法。';
        }
        let address = String(args.address ?? '').trim();
        if (address) {
          const r = this.resolveAddress(address);
          if ('error' in r) return `[提醒没记下] ${r.error}`;
          address = r.address;
        } else {
          // 本机框架的 ToolCallContext 带会话地址；线上框架的类型还没有这一项（运行时缺了就是 undefined）。
          const inConv = (ctx as { conv?: string }).conv;
          address = inConv ?? '';
          if (!address) return '[提醒没记下] 没说在哪个会话提醒，而且当前这句不是在某个 QQ 会话里说的——把 address 填上。';
        }
        const r = this.reminders?.add(text, when, { address });
        if (!r) return '[提醒没记下] 这台部署没有数据目录，提醒存不下来。';
        this.log.info('记了一条到点提醒', { id: r.id, when: formatWhen(when), address });
        return { text: `记下了（id=${r.id}）：${formatWhen(when)} 在 ${address} 提醒你「${text}」。`, ok: true, id: r.id, when: formatWhen(when), address };
      },
    };

    const reminderList: ToolDef = {
      name: 'qqbot_reminder_list',
      description: '列出还没到点的提醒（记事）。要删哪条就用这里的 id。',
      tags: ['read'],
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const list = this.reminders?.list(true) ?? [];
        if (!list.length) return { text: '没有待提醒的事。', ok: true, count: 0, reminders: [] };
        const lines = list.map((r) => `- ${r.id}　${formatWhen(r.when)}　${r.address ?? '(没指定会话)'}　${r.text}`).join('\n');
        return {
          text: `待提醒 ${list.length} 条：\n${lines}`,
          ok: true,
          count: list.length,
          reminders: list.map((r) => ({ id: r.id, text: r.text, when: formatWhen(r.when), address: r.address ?? '' })),
        };
      },
    };

    const reminderCancel: ToolDef = {
      name: 'qqbot_reminder_cancel',
      description: '取消一条还没到点的提醒。传 qqbot_reminder_list 里的 id。',
      tags: ['write'],
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '要取消的提醒 id。' } },
        required: ['id'],
      },
      handler: async (args) => {
        const id = String(args.id ?? '').trim();
        if (!id) return '[没取消] 要传 id。';
        const ok = this.reminders?.remove(id) ?? false;
        return ok ? `[已取消] ${id}` : `[没取消] 没有这个 id：${id}`;
      },
    };

    // ── 群管（2026-10-17 学 QQ ProMAX 的做法自己实现；授权按群，不按人） ─────
    /** 群号通过检查返回 null，否则返回拒绝话术。空名单 = 群管全关。 */
    const denyAdmin = (gid: number): string | null => {
      const allowed = toIds(this.config.adminGroups);
      if (!allowed.length) return '群管没开：先在配置「群管授权群」里填上允许的群号。';
      if (!allowed.includes(gid)) return '群 ' + gid + ' 不在群管授权名单里。';
      return null;
    };
    /** 参数里的群号（容忍 group:123 写法）。 */
    const groupArg = (raw: unknown): number => {
      const n = Number(String(raw ?? '').replace(/^group:/, '').trim());
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const adminApi = async (action: string, params: Record<string, unknown>): Promise<string> => {
      if (!this.driver) return '[没做] 还没连上协议端。';
      try { await this.driver.callApi(action, params); return ''; }
      catch (e) { return '[没做] ' + String((e as Error).message ?? e); }
    };

    const adminRecall: ToolDef = {
      name: 'qqbot_admin_recall',
      tags: ['write'],
      barrierAfter: true,
      description: '撤回一条群消息（仅授权群；只能撤回自己发的、或近 2 分钟内的）。messageId 是消息开头那个 #数字。',
      parameters: { type: 'object', properties: {
        messageId: { type: 'string', description: '要撤回的 message_id，可带 #。' },
        group: { type: 'string', description: '群号（必填）。' },
      }, required: ['messageId', 'group'] },
      handler: async (args) => {
        const gid = groupArg(args.group);
        if (!gid) return '[没撤] 要传群号。';
        const deny = denyAdmin(gid); if (deny) return '[没撤] ' + deny;
        const id = Number(String(args.messageId ?? '').replace(/^#/, '').trim());
        if (!Number.isFinite(id)) return '[没撤] messageId 要填数字。';
        const bad = await adminApi('delete_msg', { message_id: id });
        return bad || ('[已撤回] #' + id);
      },
    };

    const adminAtAll: ToolDef = {
      name: 'qqbot_admin_at_all',
      tags: ['speak'],
      barrierAfter: true,
      description: '在授权群里发一条带 @全体成员 的消息。留给真正的公告/通知，别当打招呼用。',
      parameters: { type: 'object', properties: {
        group: { type: 'string', description: '群号（必填）。' },
        text: { type: 'string', description: '公告正文。' },
      }, required: ['group', 'text'] },
      handler: async (args) => {
        const gid = groupArg(args.group);
        if (!gid) return '[没发] 要传群号。';
        const deny = denyAdmin(gid); if (deny) return '[没发] ' + deny;
        const text = String(args.text ?? '').trim();
        if (!text) return '[没发] 正文是空的。';
        const bad = await adminApi('send_group_msg', { group_id: gid, message: [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text } }] });
        return bad || ('[已发] 群 ' + gid + '（带 @全体）');
      },
    };

    const adminNotice: ToolDef = {
      name: 'qqbot_admin_notice',
      tags: ['write'],
      barrierAfter: true,
      description: '给授权群发一条群公告（进群公告栏，不是聊天消息）。',
      parameters: { type: 'object', properties: {
        group: { type: 'string', description: '群号（必填）。' },
        content: { type: 'string', description: '公告正文。' },
      }, required: ['group', 'content'] },
      handler: async (args) => {
        const gid = groupArg(args.group);
        if (!gid) return '[没发] 要传群号。';
        const deny = denyAdmin(gid); if (deny) return '[没发] ' + deny;
        const content = String(args.content ?? '').trim();
        if (!content) return '[没发] 公告是空的。';
        const bad = await adminApi('send_group_notice', { group_id: gid, content });
        return bad || ('[已发公告] 群 ' + gid);
      },
    };

    const adminJoinList: ToolDef = {
      name: 'qqbot_admin_join_list',
      tags: ['read'],
      description: '列出待处理的加群请求（协议端支持 get_group_system_msg 时才有）。',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const allowed = toIds(this.config.adminGroups);
        if (!allowed.length) return '[没查] 群管没开：先在配置「群管授权群」里填群号。';
        if (!this.driver) return '[没查] 还没连上协议端。';
        try {
          const r = await this.driver.callApi('get_group_system_msg', {});
          return '[加群请求] ' + JSON.stringify(r).slice(0, 1500);
        } catch (e) { return '[没查] 协议端不支持 get_group_system_msg：' + String((e as Error).message ?? e); }
      },
    };

    const adminJoinTool = (approve: boolean): ToolDef => ({
      name: approve ? 'qqbot_admin_join_approve' : 'qqbot_admin_join_reject',
      tags: ['write'],
      barrierAfter: true,
      description: (approve ? '通过' : '拒绝') + '一条加群请求。flag 来自 qqbot_admin_join_list；group 用来核对授权群。',
      parameters: { type: 'object', properties: {
        flag: { type: 'string', description: '加群请求的 flag（qqbot_admin_join_list 里那条）。' },
        group: { type: 'string', description: '这条请求要进的群号（必填，用来核对授权）。' },
        ...(approve ? {} : { reason: { type: 'string', description: '拒绝理由（可选）。' } }),
      }, required: ['flag', 'group'] },
      handler: async (args) => {
        const gid = groupArg(args.group);
        if (!gid) return '[没处理] 要传群号。';
        const deny = denyAdmin(gid); if (deny) return '[没处理] ' + deny;
        const flag = String(args.flag ?? '').trim();
        if (!flag) return '[没处理] 要传 flag。';
        const params: Record<string, unknown> = { flag, sub_type: 'add', approve };
        if (!approve) params.reason = String(args.reason ?? '');
        const bad = await adminApi('set_group_add_request', params);
        return bad || ((approve ? '[已通过] ' : '[已拒绝] ') + '群 ' + gid);
      },
    });

    const adminTitle: ToolDef = {
      name: 'qqbot_admin_title',
      tags: ['write'],
      barrierAfter: true,
      description: '给群成员设专属头衔（仅授权群，通常要群主权限）。空字符串=取消头衔。',
      parameters: { type: 'object', properties: {
        group: { type: 'string', description: '群号（必填）。' },
        user: { type: 'string', description: '对方 QQ 号。' },
        title: { type: 'string', description: '头衔内容。' },
      }, required: ['group', 'user', 'title'] },
      handler: async (args) => {
        const gid = groupArg(args.group);
        if (!gid) return '[没设] 要传群号。';
        const deny = denyAdmin(gid); if (deny) return '[没设] ' + deny;
        const user = Number(String(args.user ?? '').trim());
        if (!Number.isFinite(user)) return '[没设] user 要填 QQ 号。';
        const bad = await adminApi('set_group_special_title', { group_id: gid, user_id: user, special_title: String(args.title ?? '') });
        return bad || ('[已设] 群 ' + gid + ' / ' + user);
      },
    };

    const adminBan: ToolDef = {
      name: 'qqbot_admin_ban',
      tags: ['write'],
      barrierAfter: true,
      description: '禁言群成员（仅授权群，需要管理员权限）。duration 秒；0=解除禁言。',
      parameters: { type: 'object', properties: {
        group: { type: 'string', description: '群号（必填）。' },
        user: { type: 'string', description: '对方 QQ 号。' },
        duration: { type: 'integer', description: '禁言秒数；0=解除。' },
      }, required: ['group', 'user', 'duration'] },
      handler: async (args) => {
        const gid = groupArg(args.group);
        if (!gid) return '[没做] 要传群号。';
        const deny = denyAdmin(gid); if (deny) return '[没做] ' + deny;
        const user = Number(String(args.user ?? '').trim());
        const duration = Number(args.duration ?? 0);
        if (!Number.isFinite(user)) return '[没做] user 要填 QQ 号。';
        if (!Number.isFinite(duration) || duration < 0) return '[没做] duration 要填秒数，0=解除。';
        const bad = await adminApi('set_group_ban', { group_id: gid, user_id: user, duration });
        return bad || (duration === 0 ? ('[已解除禁言] 群 ' + gid + ' / ' + user) : ('[已禁言 ' + duration + ' 秒] 群 ' + gid + ' / ' + user));
      },
    };

    const adminKick: ToolDef = {
      name: 'qqbot_admin_kick',
      tags: ['write'],
      barrierAfter: true,
      description: '把成员移出群（仅授权群，需要管理员权限）。rejectAgain=true 时同时拒绝他再加群。',
      parameters: { type: 'object', properties: {
        group: { type: 'string', description: '群号（必填）。' },
        user: { type: 'string', description: '对方 QQ 号。' },
        rejectAgain: { type: 'boolean', description: '是否同时拒绝再加群。' },
      }, required: ['group', 'user'] },
      handler: async (args) => {
        const gid = groupArg(args.group);
        if (!gid) return '[没做] 要传群号。';
        const deny = denyAdmin(gid); if (deny) return '[没做] ' + deny;
        const user = Number(String(args.user ?? '').trim());
        if (!Number.isFinite(user)) return '[没做] user 要填 QQ 号。';
        const bad = await adminApi('set_group_kick', { group_id: gid, user_id: user, reject_add_request: args.rejectAgain === true });
        return bad || ('[已移出] 群 ' + gid + ' / ' + user);
      },
    };

    const friendReqsTool: ToolDef = {
      name: 'qqbot_friend_requests',
      tags: ['read'],
      description: '看谁想加你好友（待处理的申请）。flag 后面批的时候要用。',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        if (!this.friendReqs.size) return '现在没有待处理的好友申请。';
        return [...this.friendReqs.entries()].map(([flag, r]) =>
          r.userId + (r.comment ? '（留言：' + r.comment.slice(0, 60) + '）' : '') + '  flag=' + flag.slice(0, 60)).join('\n');
      },
    };

    const friendApproveTool: ToolDef = {
      name: 'qqbot_friend_approve',
      tags: ['write'], barrierAfter: true,
      description: '通过/拒绝一条好友申请。flag 来自 qqbot_friend_requests；approve=false 就是拒绝。',
      parameters: { type: 'object', properties: {
        flag: { type: 'string', description: '申请的 flag（qqbot_friend_requests 里那条）。' },
        approve: { type: 'boolean', description: 'true=通过（默认），false=拒绝。' },
      }, required: ['flag'] },
      handler: async (args) => {
        const flag = String(args.flag ?? '').trim();
        if (!flag) return '[没做] 要传 flag（先 qqbot_friend_requests 看）。';
        if (!this.driver) return '[未处理] 未连接到 NapCat，未提交好友审批。';
        const approve = args.approve === false ? false : true;
        try {
          await this.driver.callApi('set_friend_add_request', { flag, approve });
          this.friendReqs.delete(flag);
          if (approve) {
            const idNum = Number((flag.match(/\d{5,}/) ?? [])[0] ?? NaN);
            if (Number.isFinite(idNum)) {
              try {
                this.identity?.knownPeers.set(idNum, { nickname: String(idNum) });
                this.ensureConv('private', idNum);
                this.log.info('新好友已加入监听名单', { userId: idNum });
              } catch { /* ignore */ }
            }
          }
          return approve ? '[已通过] 好友申请。' : '[已拒绝] 好友申请。';
        } catch (e) {
          return '[失败] ' + String((e as Error)?.message ?? e).slice(0, 160);
        }
      },
    };

    const declarations = [...qqBetterToolDecls(this.voice.enabled, this.voice.maxChars, QQWorld.IMAGE_MAX_BYTES), ...HISTORY_TOOL_DECLS, ...QQ_ADDITIONAL_TOOL_DECLS];
    return [send, conversations, confirm, viewImage, sendImage, peopleNote, peopleThread, peopleThreadDone, peopleList, peopleForget, groupNote, groupLore, stickerSave, stickerStats, pokeTool, noteSave, noteList, noteGet, noteForget, proactiveStatus, proactiveTrigger, qzonePost, qzoneDelete, qzoneReply, qzoneFeeds, qzoneStatus, reminderAdd, reminderList, reminderCancel, friendReqsTool, friendApproveTool,
      adminRecall, adminAtAll, adminNotice, adminJoinList, adminJoinTool(true), adminJoinTool(false), adminTitle, adminBan, adminKick,
      ...makeHistoryTools({
      getHost: () => this.host,
      sourceId: SOURCE,
      timezone: this.config.timezone,
      convLabel: (a) => `${a}（${this.convTag(a)}）`,
      resolveAddress: (to) => this.resolveAddress(to),
    })].map(tool => ({ ...declarations.find(decl => decl.name === tool.name)!, handler: async (args, context) => {
      const result = await tool.handler(args, context);
      if (['qqbot_send', 'qqbot_send_image', 'qqbot_confirm_send'].includes(tool.name) && typeof result === 'string'
        && /^(?:\[send (?:blocked|failed|partial)\]|未能发送|发送失败|只发出去一部分|发送结果未完全确认)/.test(result)) return { text: result, failed: true as const };
      return result;
    } }));
  }

  // ---- 控制台 ----
  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const lamps: WorldLamp[] = [
      {
        label: 'NapCat 连接',
        state: this.connected ? 'online' : this.config.mode === 'reverse' ? 'loading' : 'offline',
        hint: this.connected ? '已连接' : this.config.mode === 'reverse' ? '等待 NapCat 反向连入' : '未连接',
      },
      {
        label: '身份',
        state: this.identity ? 'online' : 'offline',
        hint: this.identity ? `QQ ${this.identity.selfId}（${this.identity.nickname}）` : '未加载',
      },
      {
        label: 'QQ空间动态',
        state: this.qzone ? 'online' : 'offline',
        hint: this.qzone ? `开启（今日 ${this.qzone.status().dailyCount}/${this.qzone.status().dailyQuota}${this.qzone.status().autoReply ? '，自动回评开' : ''}）` : '未开启',
      },
      {
        label: '群聊限速/防死循环',
        state: this.config.groupSpeak.enabled || this.config.antiLoop.enabled ? 'online' : 'offline',
        hint: `群发言限速=${this.config.groupSpeak.enabled ? `${this.config.groupSpeak.maxPerWindow}/${this.config.groupSpeak.windowSec}s` : '关'}；话题防死循环=${this.config.antiLoop.enabled ? `连续≤${this.config.antiLoop.maxConsecutiveBotTurns}/静默${this.config.antiLoop.idleToEndSec}s收尾` : '关'}`,
      },
      {
        label: '到点提醒',
        state: this.reminders ? 'online' : 'offline',
        hint: this.reminders ? `可用·待提醒 ${this.reminders.list(true).length} 条` : '不可用（没有数据目录）',
      },
    ];
    // 这栏报的是"现在能发几张"，不是自动收藏索引的条数——收藏关着时索引永远是空的。
    const stickerLib = listStickerFiles(this.stickerLibAbs);
    const panels: WorldPanelDecl[] = [
      { id: 'roster', title: '监听名单', description: '当前监听的群与私聊及未读情况。', getMethods: ['getRoster'] },
      { id: 'events', title: '实时事件', description: 'QQ 消息与通知的实时流。' },
    ];
    return {
      label: 'QQ 群聊',
      lamps,
      badges: [
        { label: '自身 QQ', value: this.identity?.selfId ?? '-', tone: 'on' },
        { label: '监听会话', value: this.convs.size, tone: 'on' },
        { label: '表情包', value: stickerLib.length, tone: stickerLib.length ? 'on' : 'plain' },
        { label: '主动', value: this.proactive?.status().runState ?? '关', tone: this.proactive?.status().enabled ? 'on' : 'plain' },
        { label: '空间动态', value: this.qzone ? '开' : '关', tone: this.qzone ? 'on' : 'plain' },
        { label: '群限速', value: this.config.groupSpeak.enabled ? `开(${this.config.groupSpeak.maxPerWindow}/${this.config.groupSpeak.windowSec}s)` : '关', tone: this.config.groupSpeak.enabled ? 'on' : 'plain' },
        { label: '防死循环', value: this.config.antiLoop.enabled ? `开(≤${this.config.antiLoop.maxConsecutiveBotTurns})` : '关', tone: this.config.antiLoop.enabled ? 'on' : 'plain' },
        { label: '模式', value: this.config.mode === 'reverse' ? '反向' : '正向', tone: 'plain' },
      ],
      panels,
      invoke: (panel, method, args) => this.invoke(panel, method, args),
      stream: (panel, socket) => this.stream(panel, socket),
      promptDocs: [
        {
          key: 'worlds.qqbot.envPrompt',
          title: 'QQ 环境描述',
          description: '注入 system 前缀的 QQ 身份与监听名单说明。',
          role: 'envPrompt',
          path: ENV_PROMPT_FILE,
          vars: [
            { name: 'qq.self', description: '当前 QQ 身份说明。' },
            { name: 'qq.activeGroups', description: '正在监听的群列表。', multiline: true },
            { name: 'qq.activePrivates', description: '正在监听的私聊列表。', multiline: true },
            { name: 'qq.qzone', description: 'QQ 空间动态能力说明（是否开启、可用工具）。', multiline: true },
            { name: 'qq.groupSpeak', description: '群聊发言限速说明（是否开启、窗口与上限）。' },
            { name: 'qq.antiLoop', description: '话题防死循环规则说明（连续发言上限、静默收尾、何时该停）。' },
          ],
        },
      ],
      config: [QQ_CONFIG_GROUP],
    };
  }

  private async invoke(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (panel === 'roster' && method === 'getRoster') {
      const list = [...this.convs.values()].map((c) => ({
        address: c.address,
        label: c.label,
        kind: c.kind,
        active: c.active,
        members: c.members?.size ?? 0,
        lastMessageAt: c.lastMessageAt ? new Date(c.lastMessageAt).toISOString() : null,
      }));
      return { selfId: this.identity?.selfId ?? null, mode: this.config.mode, groups: toIds(this.config.groups), privates: toIds(this.config.privates), convs: list };
    }
    return { error: 'unknown method' };
  }

  private stream(panel: string, socket: WorldStreamSocket): void {
    if (panel !== 'events') {
      socket.close('no such stream');
      return;
    }
    this.eventSockets.add(socket);
    socket.onClose(() => this.eventSockets.delete(socket));
    // 先回放最近 20 条
    if (this.host) {
      const recent = this.host.store.range({ source: SOURCE, limit: 20 }).reverse();
      for (const e of recent) socket.send(JSON.stringify({ ts: e.ts, type: e.type, senderKey: e.senderKey, text: e.text }));
    }
  }

  private broadcastEvent(e: EventEnvelope): void {
    const payload = JSON.stringify({ ts: e.ts, type: e.type, senderKey: e.senderKey, text: e.text });
    for (const s of this.eventSockets) s.send(payload);
  }

  // ---- 环境提示词 ----
  /**
   * 节日/节气/农历感知（按配置时区推算），供环境提示词用。
   *
   * 上游 0.1.63 的 `festival.ts` 原样拿过来：零依赖、零网络，1900–2100 的农历表
   * 加节气近似公式。有了它她才懂"今天是什么日子"——中秋主动问一句、冬至聊吃饺子，
   * 而不是被问到才去猜。出错就返回空串，绝不因为一个日历问题把环境提示词搞没。
   */
  private festivalLine(): string {
    try {
      return festivalText(this.config.timezone);
    } catch {
      return '';
    }
  }

  envPromptVars(): Record<string, string> | null {
    const self = this.identity
      ? `当前连接的 QQ 账号为 ${this.identity.selfId}；昵称等外部资料通过工具或事件读取。`
      : 'QQ 身份尚未加载，等待 NapCat 连接。';
    const activeGroups = [...this.convs.values()].filter((c) => c.kind === 'group' && c.active && c.id > 0);
    const activePrivates = [...this.convs.values()].filter((c) => c.kind === 'private' && c.active && c.id > 0);
    const groupLines = activeGroups.map((c) => `- 群号 ${c.id}，to 填 group:${c.id}`).join('\n') || '- 无';
    // 私聊只列"跟她说过话的人"：监听名单里有群里所有人，一百多行陌生名字会把读数淹掉，
    // 而且没说过话的人她本来也不需要主动开口。要用号码时查 qqbot_conversations。
    const talked = this.talkingConvs();
    const shown = activePrivates
      .filter((c) => talked.has(c.address))
      .sort((a, b) => (talked.get(b.address) ?? 0) - (talked.get(a.address) ?? 0))
      .slice(0, 40);
    const privLines = (shown.map((c) => `- QQ ${c.id}，to 填 private:${c.id}`).join('\n') || '- 无')
      + (activePrivates.length > shown.length
        ? `\n（监听名单里还有 ${activePrivates.length - shown.length} 人没跟你说过话，没列出来；要给谁发消息，先用 qqbot_conversations 查号码。）`
        : '');
    let nowStr = '';
    try {
      nowStr = new Intl.DateTimeFormat('zh-CN', {
        timeZone: this.config.timezone,
        year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).format(new Date());
    } catch {
      nowStr = new Date().toLocaleString('zh-CN');
    }
    const qzoneLine = this.qzone
      ? 'QQ 空间可用：qqbot_qzone_post 发布显式正文和图片，qqbot_qzone_delete 删除，qqbot_qzone_reply 回复评论，qqbot_qzone_feeds 查询列表，qqbot_qzone_status 查询记录。'
      : '';
    // 各群分寸：参与度与备注是配置里她自己的生态位，不注入就等于没有。
    const profileLines = activeGroups
      .map((c) => {
        const p = this.config.groupProfiles?.[String(c.id)];
        const active = p?.active ?? this.config.groupActiveDefault;
        const note = (p?.note ?? '').trim();
        return `- 群号 ${c.id}（to 填 group:${c.id}）配置参与度 ${active}${note ? `，操作者备注：${note}` : ''}`;
      })
      .join('\n');
    // 状态 + 行为规则合成一段：规则绑在她自己身上（不绑机制在不在），模板的 `|` 只兜"没这个群"。
    const gs = this.config.groupSpeak;
    const groupSpeakLine = gs.enabled
      ? `群聊发送窗口为 ${gs.windowSec} 秒，每窗口最多 ${gs.maxPerWindow} 次发送；达到限制会返回拦截回执。`
      : '群聊发送窗口限速已关闭。';
    const al = this.config.antiLoop;
    // 只讲"她连着说满会被拦"这条硬上限。
    // 「对方静默就自动收尾」那条默认关着——她的毛病是太安静，不是话多；
    // 一个没人接的话头不该变成禁令（2026-09-23 上午真把它当禁令了）。
    // 「防死循环」整条默认关着（部署侧把 antiLoop.enabled 设为 false）。
    // 这机制是给"话太多、没人理还一直说"的 bot 写的，而她的毛病是太安静：
    // 2026-09-23 上午她抛了个话头没人接，5 分钟后想再抛一句，被这条规则拦回来了，
    // 还把它读成了禁令。既然要她主动起话头，就不该有东西在她背后把嘴捂上。
    // 真要说满屏，还有 groupSpeak 那道频率限制兜着。
    const antiLoopLine = al.enabled
      ? `该会话连续发送上限为 ${al.maxConsecutiveBotTurns} 次，对方新消息会重置计数；静默结束阈值为 ${al.idleToEndSec} 秒（0 表示关闭）。达到限制会拦截下一次发送。`
      : '连续发言防循环拦截已关闭。';
    return {
      'qq.self': self,
      'qq.activeGroups': groupLines,
      'qq.activePrivates': privLines,
      'qq.now': `现在是 ${nowStr}（${this.config.timezone}）。有人问几点、星期几、几号，看这个答，别猜。`,
      'qq.festival': this.festivalLine(),
      'qq.qzone': qzoneLine,
      'qq.groupSpeak': groupSpeakLine,
      'qq.antiLoop': antiLoopLine,
      'qq.groupProfiles': profileLines || '（目前只在私聊里。）',
      'qq.emotion': '',
    };
  }

  // ---- 工具：抓取与解码 ----
  private async fetchBytes(url: string): Promise<Uint8Array | null> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return null;
      return await readResponseBytes(res, QQWorld.IMAGE_MAX_BYTES);
    } catch {
      return null;
    }
  }

  /**
   * 取一张要发出去的图：本地文件或 http(s) 链接，二选一。
   *
   * 上限是硬的（见 IMAGE_MAX_BYTES）：QQ 侧对超大图会直接失败，
   * 而且这条路径会把整个文件读进内存再 base64——不许它变成一条吃内存的路。
   */
  private async loadOutgoingImage(image: string): Promise<{ bytes: Uint8Array; from: string } | { error: string }> {
    if (/^https?:\/\//i.test(image)) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      try {
        const res = await fetch(image, { signal: ctrl.signal });
        if (!res.ok) return { error: `下载失败（HTTP ${res.status}）：${image}` };
        const type = res.headers.get('content-type') ?? '';
        if (type && !type.startsWith('image/')) { await res.body?.cancel(); return { error: `那不是图片（content-type: ${type}）：${image}` }; }
        const buf = Buffer.from(await readResponseBytes(res, QQWorld.IMAGE_MAX_BYTES));
        if (!buf.byteLength) return { error: `下载下来是空的：${image}` };
        if (buf.byteLength > QQWorld.IMAGE_MAX_BYTES) {
          return { error: `图太大了（${Math.round(buf.byteLength / 1024 / 1024)} MB，上限 ${Math.round(QQWorld.IMAGE_MAX_BYTES / 1024 / 1024)} MB）：${image}` };
        }
        return { bytes: buf, from: 'url' };
      } catch (e) {
        return { error: `下载失败：${String(e)}` };
      } finally {
        clearTimeout(timer);
      }
    }
    const p = isAbsolute(image) ? image : join(this.packageDir || '.', image);
    try {
      if (!existsSync(p)) return { error: `本地没有这个文件：${p}` };
      if (statSync(p).size > QQWorld.IMAGE_MAX_BYTES) return { error: `图太大了（上限 ${Math.round(QQWorld.IMAGE_MAX_BYTES / 1024 / 1024)} MB）：${p}` };
      const buf = readFileSync(p);
      if (buf.byteLength > QQWorld.IMAGE_MAX_BYTES) {
        return { error: `图太大了（${Math.round(buf.byteLength / 1024 / 1024)} MB，上限 ${Math.round(QQWorld.IMAGE_MAX_BYTES / 1024 / 1024)} MB）：${p}` };
      }
      if (!buf.byteLength) return { error: `文件是空的：${p}` };
      return { bytes: buf, from: p };
    } catch (e) {
      return { error: `读不了这个文件：${String(e)}` };
    }
  }

  /** 语音 best-effort 解码：用 ffmpeg 把 NapCat 提供的语音转成 wav；失败返回 null（不阻塞）。 */
  private decodeVoice(url: string): Promise<Uint8Array | null> {
    return this.decodeVoiceWith(url, 0);
  }

  /**
   * 解码器按候选顺序试，第一个能出字节的就记住。
   *
   * 为什么不是一个固定的 `ffmpeg`：这台机器的 PATH 里没有 ffmpeg，`ffmpeg-static`
   * 也没下二进制——所以过去每一条语音都在这里静默失败（`[语音]` 明明该出现却从没出现过）。
   * 现在按 配置 → PATH → 仓库里的 ffmpeg-static 依次试，失败就换下一个。
   */
  private async decodeVoiceWith(url: string, index: number): Promise<Uint8Array | null> {
    const candidates = this.ffmpegCandidates();
    if (index >= candidates.length) {
      if (candidates.length && !this.ffmpegWarned) {
        this.ffmpegWarned = true;
        this.log.warn('语音解码失败：一个可用的 ffmpeg 都没有', { tried: candidates });
      }
      return null;
    }
    const bin = this.ffmpegResolved ?? candidates[index];
    const bytes = await new Promise<Uint8Array | null>((resolve) => {
      let proc: ReturnType<typeof spawn> | null = null;
      try {
        proc = spawn(bin, ['-y', '-i', url, '-f', 'wav', '-ac', '1', '-ar', '16000', 'pipe:1'], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const chunks: Buffer[] = [];
        proc.stdout?.on('data', (d) => chunks.push(d as Buffer));
        proc.on('close', (code) => resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null));
        proc.on('error', () => resolve(null));
        setTimeout(() => {
          try {
            proc?.kill();
          } catch {
            /* ignore */
          }
          resolve(null);
        }, 20000);
      } catch {
        resolve(null);
      }
    });
    if (bytes) {
      if (!this.ffmpegResolved) {
        this.ffmpegResolved = bin;
        this.log.info('语音解码器就位', { ffmpeg: bin });
      }
      return bytes;
    }
    // 这个候选不行：换下一个（记住的那个如果坏了也重新找）
    this.ffmpegResolved = null;
    return this.decodeVoiceWith(url, index + 1);
  }

  /** 候选 ffmpeg：配置里那份 → PATH 里的 → 仓库 node_modules 里 ffmpeg-static 的。 */
  private ffmpegCandidates(): string[] {
    const out: string[] = [];
    if (this.config.voice.ffmpegPath) out.push(this.config.voice.ffmpegPath);
    out.push('ffmpeg');
    if (this.repoRoot) {
      out.push(join(this.repoRoot, 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'));
    }
    return out;
  }

  /**
   * 语音 → 文字（本地 ASR）。
   *
   * 不配 `voice.transcribeUrl`、解码失败、识别超时或报错，一律返回空串——
   * 调用方退回 `[语音]` 占位。这条路上任何一步都不许把消息卡住。
   */
  private async transcribeVoice(segs: OneBotSegment[]): Promise<string> {
    const base = this.config.voice.transcribeUrl.trim();
    if (!base) return '';
    const rec = segs.find((s) => s.type === 'record' && (s.data as { url?: string }).url);
    if (!rec) return '';
    const url = (rec.data as { url: string }).url!;
    const wav = await this.decodeVoice(url);
    if (!wav) return '';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(1000, this.config.voice.transcribeTimeoutMs));
    try {
      const res = await fetch(`${base.replace(/\/+$/, '')}/asr`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: Buffer.from(wav),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        this.log.warn('语音识别失败', { status: res.status });
        return '';
      }
      const j = (await res.json()) as { ok?: boolean; text?: string };
      const said = String(j.text ?? '').trim();
      if (said) this.log.info('语音转文字', { chars: said.length, head: said.slice(0, 24) });
      return said;
    } catch (e) {
      this.log.warn('语音识别异常', { err: String(e) });
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  shutdownVerification() {
    return [
      {
        key: 'qq-conn',
        label: 'NapCat 连接',
        status: this.connected ? ('verified-ended' as const) : ('still-live' as const),
        detail: this.connected ? '已连接，停止后连接将关闭。' : '未连接。',
        manualAction: '在 NapCat 中停止 OneBot 连接或关闭本扩展。',
      },
    ];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function consoleLogger(): Logger {
  const noop = () => {};
  const l: Logger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, emit: noop, child: () => l };
  return l;
}

/** 全部工具的声明;自描述要列出 tools() 能返回的每一个。 */
export function qqBetterToolDecls(voiceEnabled: boolean, voiceMaxChars: number, imageMaxBytes: number): ReadonlyArray<Omit<ToolDef, 'handler'>> {
  return [
  {
    name: 'qqbot_send',
    tags: ['speak'],
    barrierAfter: true,
    description:
      '回复 QQ 消息事件的唯一渠道：发送一条发往 QQ 群或私聊的消息（不要用 terminal_send，那只会发到控制台终端）。调用即直接发送，无需再确认。'
      + 'to 填事件行方括号里的会话标号——群是 "group:<群号>"，私聊是 "private:<QQ号>"，照抄那一行的号码，不要自己改、不要凭记忆写；不确定就先调 qqbot_conversations 看清单。'
      + '私聊默认合并，条数超限整次拒绝。按回执区分已受理、结果未确认和未尝试；部分失败会停止，不得自动整条重发。已受理不是已读。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '发送目标，原样抄事件行最前面的会话标号：群 "group:<群号>"，私聊 "private:<QQ号>"。' },
        text: { type: 'string', description: '要发送的消息正文。可用 #编号 引用回复某条消息。' },
        reply_message_id: { type: 'number', description: '可选：引用回复的目标消息编号（也可在 text 里写 #编号）。必须是同一会话内的消息，否则会被拒绝。' },
        // 只有真配了语音服务才给她这个参数：给一个永远失败的能力只会让她反复试。
        ...(voiceEnabled
          ? {
              voice: {
                type: 'boolean',
                description:
                  '把这条合成语音、以语音条发出去。默认是打字，语音是例外不是另一种常规选择。'
                  + `正文要短（不超过约 ${voiceMaxChars} 字），合成失败或超长会自动改发文字并在回执里说明。`,
              },
            }
          : {}),
      },
      required: ['to', 'text'],
    },
  },
  {
    name: 'qqbot_conversations',
    tags: ['read'],
    barrierAfter: true,
    description:
      '列出当前监听的所有会话：会话标号（qqbot_send 的 to 要用它）、群名或对方昵称。'
      + '要发消息但不确定 to 该填什么号码时先查这里，不要凭记忆写号码。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'qqbot_confirm_send',
    tags: ['speak'],
    barrierAfter: true,
    description: '（兼容别名）qqbot_send 现已直接发送，通常无需调用本工具；仅当仍有未发送草稿时可补发。',
    parameters: {
      type: 'object',
      properties: {
        draft: { type: 'string', description: 'qqbot_send 返回的草稿编号；留空则发送最近一条草稿。' },
      },
      required: [],
    },
  },
  {
    name: 'qqbot_view_image',
    tags: ['read'],
    barrierAfter: true,
    description:
      '看一张 QQ 图片，返回文字描述。群里发的图平时只留一个 `[图片]` 占位，'
      + '你想知道那是什么就调这个（**要花一次视觉调用，别每张都看**）。'
      + '不传 url 时按 conv + index 到最近收到的图里找：conv 抄事件行的会话标号，index 是那个会话里往前数第几张（0=最新）。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '可选：直接给图片链接（事件里带的图）或本地文件路径；给了就不再翻缓冲。' },
        conv: { type: 'string', description: '可选：会话标号（如 group:100001）。留空 = 所有会话最近收到的那张。' },
        index: { type: 'number', description: '可选：往前数第几张，0=最新（默认 0）。' },
      },
      required: [],
    },
  },
  {
    name: 'qqbot_send_image',
    tags: ['speak'],
    barrierAfter: true,
    description:
      '给某个会话发一张图。`image` 给本地文件路径或 http(s) 链接（本机下载后再发），二者挑一个。'
      + '配 `text` 就是"图 + 一句话"。发文字还是走 qqbot_send。'
      + `图片上限 ${Math.round(imageMaxBytes / 1024 / 1024)} MB，发不动会在回执里说明原因。`,
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '发送目标，原样抄事件行最前面的会话标号：群 "group:<群号>"，私聊 "private:<QQ号>"。' },
        image: { type: 'string', description: '本地文件路径（如 /home/user/pics/a.png）或 http(s) 链接。' },
        text: { type: 'string', description: '可选：跟图一起发的一句话。' },
      },
      required: ['to', 'image'],
    },
  },
  {
    name: 'qqbot_people_note',
    tags: ['write'],
    barrierAfter: true,
    description:
      '在**人册**里给某个人记一句：这人是谁、怎么处、别提什么。按 QQ 号记，跨群通用——'
      + '同一个人换昵称、换群，你照样认得出。以后他跟你说的话，那一行事件里会自动带上这句提醒。'
      + '记**你自己想记的**：一句就够，别把聊天记录抄进来（那些在历史里）。',
    parameters: {
      type: 'object',
      properties: {
        qq: { type: 'string', description: '那个人的 QQ 号（事件行里 `昵称(QQ号)` 括号里的数字）。' },
        note: { type: 'string', description: `一两句：他是谁、怎么处、别提什么。上限 ${PEOPLE_NOTE_MAX} 字。` },
        name: { type: 'string', description: '可选：记下他现在的昵称，方便你自己认。' },
      },
      required: ['qq', 'note'],
    },
  },
  {
    name: 'qqbot_people_list',
    tags: ['read'],
    barrierAfter: true,
    description: '看人册里都记了谁（按最近改过排序）。要确认自己记过谁、或者想改一条之前先看这里。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: '返回几条，默认 30。' } },
      required: [],
    },
  },
  {
    name: 'qqbot_people_forget',
    tags: ['write'],
    barrierAfter: true,
    description: '从人册里删掉一个人的备注（记错了、或者不想再记着这个人）。',
    parameters: {
      type: 'object',
      properties: { qq: { type: 'string', description: '那个人的 QQ 号。' } },
      required: ['qq'],
    },
  },
  {
    name: 'qqbot_people_thread',
    tags: ['write'],
    barrierAfter: true,
    description:
      '记一条**还没说完的话头**：下次这个人开口时，他那一行会带一句提醒你接上。'
      + '只记真的悬着的（"他说周五要交东西""约了周末打游戏"），不记流水、不记你自己的想法；'
      + `一个人最多 ${PEOPLE_THREAD_MAX} 条。说完了用 qqbot_people_thread_done 结掉。`,
    parameters: {
      type: 'object',
      properties: {
        qq: { type: 'string', description: '那个人的 QQ 号。' },
        text: { type: 'string', description: `那句话头（上限 ${PEOPLE_THREAD_CHARS} 字）。` },
      },
      required: ['qq', 'text'],
    },
  },
  {
    name: 'qqbot_people_thread_done',
    tags: ['write'],
    barrierAfter: true,
    description: '结掉一条话头（说完了、或者那事已经过去了）。序号或那句话里的几个字都行。',
    parameters: {
      type: 'object',
      properties: {
        qq: { type: 'string', description: '那个人的 QQ 号。' },
        which: { type: 'string', description: '第几条（1 起），或者那句话里包含的几个字。' },
      },
      required: ['qq', 'which'],
    },
  },
  {
    name: 'qqbot_group_note',
    tags: ['write'],
    barrierAfter: true,
    description:
      '给一个群记一句**这地方是什么样**：什么气氛、什么分寸、谁是自己人、什么话题别碰。'
      + `一句话，上限 ${GROUP_NOTE_MAX} 字。以后你在这个群说话时，那一行会（隔一阵）带出来提醒你。`,
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '群号（会话标号里的数字，如 100001）。' },
        note: { type: 'string', description: '一句话：这地方是什么样。' },
        name: { type: 'string', description: '可选：群名。' },
      },
      required: ['group', 'note'],
    },
  },
  {
    name: 'qqbot_group_lore',
    tags: ['write'],
    barrierAfter: true,
    description:
      '往一个群里添一条**这儿的梗 / 黑话 / 内部说法**——那种别人一提就懂、你不懂的词。'
      + `最多 ${GROUP_LORE_MAX} 条、每条不超过 ${GROUP_LORE_CHARS} 字。不是记别人的事，是记这地方的话怎么讲。`,
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '群号。' },
        text: { type: 'string', description: `那条梗 / 那个说法（上限 ${GROUP_LORE_CHARS} 字）。` },
      },
      required: ['group', 'text'],
    },
  },
  {
    name: 'qqbot_proactive_status',
    tags: ['read'],
    barrierAfter: true,
    description: '查看主动说话调度器状态：运行态（暖场/稳定/静默）、今日已发/配额、各会话未回复与静默情况、最近主动说过的话。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'qqbot_proactive_trigger',
    tags: ['write'],
    barrierAfter: true,
    description: '请求一个监听会话候选事件；可指定 address。不会发送消息，正文与是否发送由 Persona 决定。',
    parameters: {
      type: 'object',
      properties: { address: { type: 'string', description: '可选：目标会话地址，如 private:123 / group:456；留空则随机。' } },
      required: [],
    },
  },
  {
    name: 'qqbot_qzone_post',
    tags: ['speak'],
    barrierAfter: true,
    description:
      '在 QQ 空间发布明确提供的 content 正文。仅附上 images 中明确指定的图片，不读取聊天或自动生成。permission 默认公开；确认内容和图片适合公开后调用。返回 tid 供后续删除/回复。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要发布的完整正文，不能为空。' },
        topic: { type: 'string', description: '已弃用；请在 content 中提供完整正文。' },
        images: { type: 'array', items: { type: 'string' }, description: '附图链接数组（file:// / http(s):// / base64://）。' },
        ats: { type: 'array', items: { type: 'string' }, description: '@的人：昵称或 QQ 号数组。' },
        permission: { type: 'number', description: '可见权限 ugc_right，默认 1=公开。' },
      },
      required: ['content'],
    },
  },
  {
    name: 'qqbot_qzone_delete',
    tags: ['speak'],
    barrierAfter: true,
    description: '删除一条 QQ 空间动态。tid 来自 qqbot_qzone_post 的返回或 qqbot_qzone_status 的最近列表。',
    parameters: {
      type: 'object',
      properties: { tid: { type: 'string', description: '要删除的动态 tid。' } },
      required: ['tid'],
    },
  },
  {
  "name": "qqbot_qzone_reply",
  "tags": [
    "speak"
  ],
  "barrierAfter": true,
  "description": "通过明确配置的 qzone.commentAction 回复指定空间评论。需要 tid、comment_id 与显式正文；未配置或协议端不支持时返回失败，不依赖其他扩展。",
  "parameters": {
    "type": "object",
    "properties": {
      "tid": {
        "type": "string",
        "description": "动态 tid。"
      },
      "comment_id": {
        "type": "string",
        "description": "评论 id。"
      },
      "content": {
        "type": "string",
        "description": "回复内容。"
      }
    },
    "required": [
      "tid",
      "comment_id",
      "content"
    ]
  }
},
  {
    name: 'qqbot_qzone_feeds',
    tags: ['read'],
    barrierAfter: true,
    description: '查看自己的 QQ 空间动态列表（尽力而为；依赖 NapCat 的 get_qzone_msg_list 是否支持）。',
    parameters: {
      type: 'object',
      properties: { num: { type: 'number', description: '返回条数，默认 5。' } },
      required: [],
    },
  },
  {
    name: 'qqbot_qzone_status',
    tags: ['read'],
    barrierAfter: true,
    description: '查看 QQ 空间动态发布器状态：是否开启、今日已发/配额、自动回复评论是否开、最近发的动态（含 tid）。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'qqbot_reminder_add',
    description:
      '给自己定一条到点提醒（闹钟）。到点会推给你一条内部事件，提示你当时记下的事，'
      + '要不要在那个会话里说、说什么，到点你自己定。用来兜住「等会儿要做的事」' 
      + '和「跟人说好了几点」——不记下来就会忘。',
    tags: ['write'],
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要提醒自己的内容（写清楚要做什么，别只写"那件事"）。' },
        time: {
          type: 'string',
          description: '什么时候提醒。支持：`30分钟后`/`2小时`/`3天`、`今天 21:30`/`明天 09:00`、'
            + '或绝对时间 `2026-10-12T09:00:00+08:00`。',
        },
        address: {
          type: 'string',
          description: '到点在哪个会话提醒（`group:<群号>` 或 `private:<QQ号>`）。不填＝记住当前这个会话。',
        },
      },
      required: ['text', 'time'],
    },
  },
  {
    name: 'qqbot_reminder_list',
    description: '列出还没到点的提醒（记事）。要删哪条就用这里的 id。',
    tags: ['read'],
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'qqbot_reminder_cancel',
    description: '取消一条还没到点的提醒。传 qqbot_reminder_list 里的 id。',
    tags: ['write'],
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '要取消的提醒 id。' } },
      required: ['id'],
    },
  },
  {
    name: 'qqbot_sticker_stats',
    tags: ['read'],
    barrierAfter: true,
    description:
      '看表情包：本地目录里现在能发几张（附真实文件名），以及自动收藏索引的统计（总数、按情感分布、最近若干条）。想给 QQ 回复发表情包图片时，先调本工具拿到真实文件名（返回里的 [表情包:xxx.jpg]），再把整段 [表情包:文件名] 写进回复文本即可自动发出；不要编造不存在的文件名。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: '返回最近几条，默认 10。' } },
      required: [],
    },
  },
  // ── 群管（2026-10-17）：与 tools() 里那 9 个一一对应，声明在这里是为了 describe.json ──
  {
    name: 'qqbot_admin_recall',
    tags: ['write'],
    barrierAfter: true,
    description: '撤回一条群消息（仅授权群；只能撤回自己发的、或近 2 分钟内的）。messageId 是消息开头那个 #数字。',
    parameters: { type: 'object', properties: { messageId: { type: 'string', description: '要撤回的 message_id，可带 #。' }, group: { type: 'string', description: '群号（必填）。' } }, required: ['messageId', 'group'] },
  },
  {
    name: 'qqbot_admin_at_all',
    tags: ['speak'],
    barrierAfter: true,
    description: '在授权群里发一条带 @全体成员 的消息。留给真正的公告/通知，别当打招呼用。',
    parameters: { type: 'object', properties: { group: { type: 'string', description: '群号（必填）。' }, text: { type: 'string', description: '公告正文。' } }, required: ['group', 'text'] },
  },
  {
    name: 'qqbot_admin_notice',
    tags: ['write'],
    barrierAfter: true,
    description: '给授权群发一条群公告（进群公告栏，不是聊天消息）。',
    parameters: { type: 'object', properties: { group: { type: 'string', description: '群号（必填）。' }, content: { type: 'string', description: '公告正文。' } }, required: ['group', 'content'] },
  },
  {
    name: 'qqbot_admin_join_list',
    tags: ['read'],
    description: '列出待处理的加群请求（协议端支持 get_group_system_msg 时才有）。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'qqbot_admin_join_approve',
    tags: ['write'],
    barrierAfter: true,
    description: '通过一条加群请求。flag 来自 qqbot_admin_join_list；group 用来核对授权群。',
    parameters: { type: 'object', properties: { flag: { type: 'string', description: '加群请求的 flag（qqbot_admin_join_list 里那条）。' }, group: { type: 'string', description: '这条请求要进的群号（必填，用来核对授权）。' } }, required: ['flag', 'group'] },
  },
  {
    name: 'qqbot_admin_join_reject',
    tags: ['write'],
    barrierAfter: true,
    description: '拒绝一条加群请求。flag 来自 qqbot_admin_join_list；group 用来核对授权群。',
    parameters: { type: 'object', properties: { flag: { type: 'string', description: '加群请求的 flag（qqbot_admin_join_list 里那条）。' }, group: { type: 'string', description: '这条请求要进的群号（必填，用来核对授权）。' }, reason: { type: 'string', description: '拒绝理由（可选）。' } }, required: ['flag', 'group'] },
  },
  {
    name: 'qqbot_admin_title',
    tags: ['write'],
    barrierAfter: true,
    description: '给群成员设专属头衔（仅授权群，通常要群主权限）。空字符串=取消头衔。',
    parameters: { type: 'object', properties: { group: { type: 'string', description: '群号（必填）。' }, user: { type: 'string', description: '对方 QQ 号。' }, title: { type: 'string', description: '头衔内容。' } }, required: ['group', 'user', 'title'] },
  },
  {
    name: 'qqbot_admin_ban',
    tags: ['write'],
    barrierAfter: true,
    description: '禁言群成员（仅授权群，需要管理员权限）。duration 秒；0=解除禁言。',
    parameters: { type: 'object', properties: { group: { type: 'string', description: '群号（必填）。' }, user: { type: 'string', description: '对方 QQ 号。' }, duration: { type: 'integer', description: '禁言秒数；0=解除。' } }, required: ['group', 'user', 'duration'] },
  },
  {
    name: 'qqbot_admin_kick',
    tags: ['write'],
    barrierAfter: true,
    description: '把成员移出群（仅授权群，需要管理员权限）。rejectAgain=true 时同时拒绝他再加群。',
    parameters: { type: 'object', properties: { group: { type: 'string', description: '群号（必填）。' }, user: { type: 'string', description: '对方 QQ 号。' }, rejectAgain: { type: 'boolean', description: '是否同时拒绝再加群。' } }, required: ['group', 'user'] },
  },
  {
  "name": "qqbot_friend_requests",
  "tags": [
    "read"
  ],
  "description": "看谁想加你好友（待处理的申请）。flag 后面批的时候要用。",
  "parameters": {
    "type": "object",
    "properties": {}
  }
},
  {
  "name": "qqbot_friend_approve",
  "tags": [
    "write"
  ],
  "barrierAfter": true,
  "description": "通过/拒绝一条好友申请。flag 来自 qqbot_friend_requests；approve=false 就是拒绝。",
  "parameters": {
    "type": "object",
    "properties": {
      "flag": {
        "type": "string",
        "description": "申请的 flag（qqbot_friend_requests 里那条）。"
      },
      "approve": {
        "type": "boolean",
        "description": "true=通过（默认），false=拒绝。"
      }
    },
    "required": [
      "flag"
    ]
  }
},
];
}
