/**
 * Gaming World（查看主人在玩什么）。
 *
 * 它只做两件事：**知道他在玩什么**，以及**在值得说一句的时候把这个事实交给她**。
 * 具体说什么、用什么口气，由她的人格和环境提示词决定——这里不预设台词，
 * 只保证事实准确、不重复、不打扰。
 *
 * 为什么不做成"自动发言"：World 不该替 Persona 决定口吻。这里推的是事件，
 * 她收到后按自己的性子决定理不理、说什么。所以 `reachOut` 关掉之后，
 * 它依然是个有用的东西——她知道你在玩，你说话时她接得上。
 */
import { fileURLToPath } from 'node:url'
import type { ShutdownExternalCheck, ToolDef, World, WorldWebUiDecl, WorldHost } from 'cortico/core/types.ts'
import type { Language } from 'cortico/core/language.ts'
import { nowIso } from 'cortico/core/util.ts'
import { GAMING_CONFIG_GROUP, GAMING_QUICK_CONFIG_GROUP, GAMING_SECRETS, type GameConfig, type GamingConfigSection } from './config.ts'
import { buildGameLibrary, saveLibrary, loadLibrary } from './games-lib.ts'
import { ScreenWatcher, type ScreenPhase, type ScreenReading } from './screen.ts'
import { listVisibleWindows } from './storyboard.ts'
import { fetchBalance, durabilityOf, type BalanceInfo } from './balance.ts'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ForegroundWatcher, type ForegroundSample } from './tracker-window.ts'
import { matchesAnyProcess, normalizeProcess } from './proc.ts'
import { GameTracker, type GameEvent, type GameSession } from './tracker-logic.ts'

/** 环境提示词模板。role=envPrompt 的声明缺了就不进系统前缀，所以必须在 console() 里报出来。 */
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url))

/** 局面说成人话。 */
const PHASE_LABEL: Record<ScreenPhase, string> = {
  fight: '正在打',
  result: '一局刚结束',
  menu: '在菜单或准备',
  other: '看不太出来',
}

/** 画面读数的有效期。比看画的间隔长一点，免得两次看之间她那儿忽然空了。 */
const READING_TTL_MS = 4 * 60_000

/** 从 HTML 片段里去掉标签与实体，只留文字。 */
function stripHtml(s: string): string {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** 比"同一件事"用的键：去掉空白和标点，只留下字。 */
function momentKey(moment: string): string {
  return moment.replace(/[\s，。、！？：；""''（）()·,.!?:;"']/g, '')
}


const round1 = (n: number): number => Math.round(n * 10) / 10

/** 分钟数说成人话：90 → "一个半小时"。 */
function humanMinutes(m: number): string {
  if (m < 1) return '不到一分钟'
  if (m < 60) return `${Math.round(m)} 分钟`
  const h = Math.floor(m / 60)
  const rest = Math.round(m - h * 60)
  return rest === 0 ? `${h} 小时` : `${h} 小时 ${rest} 分钟`
}

export class GamingWorld implements World {
  readonly id = 'gaming'
  private readonly watcher = new ForegroundWatcher()
  private readonly tracker: GameTracker
  private readonly screen: ScreenWatcher
  private host: WorldHost | null = null
  private observationQueued = false
  private observationGeneration = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private lastReachAt = 0
  private stats = { ticks: 0, events: 0, reaches: 0 }
  /** 当前可见窗口的进程名，给控制台"只看这个窗口"下拉用；每 20 秒刷一次。 */
  private windowCatalog: string[] = []
  private windowTimer: ReturnType<typeof setInterval> | null = null
  /** 已经搜过资料的游戏（这次进程内去重；跨重启按日期记在 dataDir）。 */
  private learnedGames = new Set<string>()
  /** 最近一次查到的余额（耐久度按它换算）。 */
  private balance: BalanceInfo | null = null
  private balanceTimer: ReturnType<typeof setInterval> | null = null
  private lastWarnAt = 0
  /** 游戏库解析时的提醒（配置格子填错之类），start 时写日志。 */
  private libraryWarnings: string[] = []
  /** 手动指定的窗口目标（覆盖 config），保存在 dataDir/gaming-target.json。 */
  private manualTarget = ''
  private manualTargetTitle = ''
  private readonly targetFile: string

  /** 抽帧的节流。间隔是分钟级，所以按时刻比而不是别一个定时器。 */
  private lastLookAt = 0
  private looksInSession = 0
  private lastLookGameId = ''
  /** 上一次因画面开口的时刻。结算和局中共用这一个下限，免得两条路各说一次。 */
  private lastSpeakAt = 0
  /** 上一次说过的"因由"，用来防同一件事重复说。 */
  private lastMomentKey = ''
  private lastReading: ScreenReading | null = null

  constructor(private readonly options: { cfg: GamingConfigSection; dataDir: string; timezone: string; apiKey: string }) {
    const { cfg, dataDir, timezone } = options
    // 游戏库三处来源合并：原有 games 数组 + 配置界面 6 个格子 + data/gaming-lib.json
    const lib = buildGameLibrary(cfg, dataDir)
    this.libraryWarnings = lib.warnings
    cfg.games = lib.games
    this.targetFile = join(dataDir, 'gaming-target.json')
    this.screen = new ScreenWatcher({ cfg: cfg.watch, apiKey: options.apiKey || cfg.watch.apiKey })
    // 看画面走的是 World 自己的模型调用，Core 看不见，得主动上报，否则那部分开销
    // 在 session 统计和 usage.jsonl 里都是空的。
    this.screen.setUsageSink((usage, model) => {
      this.host?.reportUsage(
        { ...usage, cacheHitTokens: 0, cacheMissTokens: 0 },
        { model, label: '看画面' },
      )
    })
    this.tracker = new GameTracker({
      cfg,
      dataDir,
      timezone,
      watcher: this.watcher,
      today: () => this.localDay(),
      // 从 ISO 串里取钟点，不用 Date.getHours()——那个按系统本地时区算，
      // 跟 World 的 timezone 不是一回事（这台机器是 UTC，会把白天判成深夜）
      hour: () => Number(nowIso(timezone).slice(11, 13)),
    })
  }

  /** 本地日期（跟 World 的时区一致，不跟系统时区）。 */
  private localDay(): string {
    return nowIso(this.options.timezone).slice(0, 10)
  }

  private localClock(): string {
    return nowIso(this.options.timezone).slice(11, 16)
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  async start(host: WorldHost): Promise<void> {
    this.host = host
    this.observationGeneration++
    this.observationQueued = false
    this.loadTargetFile()
    if (this.options.cfg.games.length > 0) {
      host.log.info('陪玩：游戏库已加载', { games: this.options.cfg.games.map((g) => g.name).join('、') })
    }
    for (const w of this.libraryWarnings) host.log.warn('陪玩：游戏库配置有问题 ' + w)
    this.watcher.start()
    this.arm()
    // 窗口清单给控制台下拉用；不阻塞启动
    const refresh = () => {
      void listVisibleWindows(12000).then((list) => {
        const procs = [...new Set(list.map((w) => w.proc))].filter(Boolean)
        if (procs.length) this.windowCatalog = procs
      }).catch(() => {})
    }
    refresh()
    this.windowTimer = setInterval(refresh, 20_000)
    this.windowTimer.unref?.()
    // 看图工具耐久度：启动先查一次，之后按配置的间隔查
    if (this.options.cfg.balance?.enabled !== false) {
      void this.checkBalance()
      const every = Math.max(5, Number(this.options.cfg.balance?.checkEveryMin ?? 30)) * 60_000
      this.balanceTimer = setInterval(() => void this.checkBalance(), every)
      this.balanceTimer.unref?.()
    }
    this.publishObservation()
  }

  async stop(): Promise<void> {
    this.observationGeneration++
    this.observationQueued = false
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.windowTimer) { clearInterval(this.windowTimer); this.windowTimer = null }
    if (this.balanceTimer) { clearInterval(this.balanceTimer); this.balanceTimer = null }
    this.watcher.stop()
    this.tracker.close()
    this.host = null
  }

  private arm(): void {
    if (this.timer) clearInterval(this.timer)
    // 采样间隔与判定间隔分开：采得勤（pollMs），判定跟着采样的节奏走。
    // 这里用一个比 pollMs 稍大的间隔去做判定，免得读到上一拍的旧值。
    const period = Math.max(1000, this.options.cfg.pollMs)
    this.timer = setInterval(() => { void this.tick() }, period)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    this.stats.ticks++
    if (!this.host) return
    let events: GameEvent[] = []
    try {
      events = this.tracker.tick()
    } catch (e) {
      this.host.log.warn(`陪玩：这一拍出错 ${String(e)}`)
      return
    }
    for (const e of events) {
      if (e.kind === 'start' || e.kind === 'switch') void this.learnGame(e)
      if (!this.shouldReach(e)) continue
      await this.reach(e)
    }
    await this.maybeLook()
  }

  // ── 看画面 ──────────────────────────────────────────────────────────────

  /**
   * 隔一阵抓一张他的画面读一次。
   *
   * 只在游戏确实在前台时抓：切出去看攻略的时候抓到的会是浏览器，
   * 那种画面拿来说"你这局怎么样"就是胡说。
   */
  private async maybeLook(): Promise<void> {
    const host = this.host
    const cfg = this.options.cfg
    if (!host || !this.screen.ready()) return

    const session = this.tracker.current()
    if (!session) { this.looksInSession = 0; this.lastLookGameId = ''; return }
    if (session.gameId !== this.lastLookGameId) { this.looksInSession = 0; this.lastLookGameId = session.gameId }

    if (cfg.watch.maxLooksPerSession > 0 && this.looksInSession >= cfg.watch.maxLooksPerSession) return
    if (Date.now() - this.lastLookAt < Math.max(30, cfg.watch.everySec) * 1000) return

    const sample = this.watcher.latest()
    const game = cfg.games.find((g) => g.id === session.gameId)
    if (!sample || !game) return
    if (!this.canCapture(game,sample)) return

    this.lastLookAt = Date.now()
    this.looksInSession++
    // 把上一次的画面描述一起给模型，它才知道哪些是新事、哪些还挂在屏幕上
    const reading = await this.screen.look(sample.proc, session.name, game.watchFor, this.lastReading?.scene, this.effectiveTarget(), this.effectiveTargetTitle())
    if (!reading) return
    // 只在"刚进入结算"这一刻开口。结算画面会挂很久，抽帧连着看到的每一张都是 result，
    // 按状态判断而不是按时间判断，同一局就只会被报一次。
    const wasResult = this.lastReading?.phase === 'result'
    this.lastReading = reading
    if (reading.phase === 'result') {
      if (!wasResult) await this.reachMatch(session, reading)
      return
    }
    if (cfg.watch.midMatch && reading.speak) await this.reachMoment(session, reading)
  }

  /** 一局刚打完，把看到的交给她。 */
  private async reachMatch(session: GameSession, reading: ScreenReading): Promise<void> {
    await this.publish(session, 'match', `他刚打完一局「${session.name}」。你从他屏幕上看到的：${reading.scene}`)
  }

  /** 局中值得说一句的事——刚击杀、刚买到装备、血量见底。 */
  private async reachMoment(session: GameSession, reading: ScreenReading): Promise<void> {
    // 同一件事只说一次。模型偶尔会把还挂在屏幕上的那次击杀再说一遍。
    const key = momentKey(reading.moment)
    if (!key || key === this.lastMomentKey) return
    this.lastMomentKey = key
    await this.publish(session, 'moment', `他正在玩「${session.name}」，你刚从他屏幕上看到：${reading.moment}`)
  }

  /**
   * 把一条画面事件交给她。
   *
   * 口吻留给 Persona：这里只陈述看到的事实，说不说由她决定。
   */
  private async publish(session: GameSession, kind: 'match' | 'moment', text: string): Promise<void> {
    const host = this.host
    const cfg = this.options.cfg
    if (!host || !cfg.reachOut) return
    if (cfg.reachMaxPerDay > 0 && this.tracker.reachedToday() >= cfg.reachMaxPerDay) return
    if (Date.now() - this.lastSpeakAt < Math.max(30, cfg.watch.speakGapSec) * 1000) return

    this.lastSpeakAt = Date.now()
    this.tracker.noteReach()
    this.stats.events++
    try {
      await host.pushEvent({
        type: `gaming.${kind}`,
        ts: nowIso(this.options.timezone),
        source: this.id,
        origin: 'external',
        senderKey: this.id,
        text,
        meta: {
          kind,
          game: session.gameId,
          name: session.name,
          phase: this.lastReading?.phase ?? 'other',
          clock: this.localClock(),
        },
      })
    } catch (err) {
      host.log.warn(`陪玩：推事件失败 ${String(err)}`)
    }
  }

  // ── 什么时候把事实交给她 ────────────────────────────────────────────────

  /**
   * 这一条值不值得推给她。
   *
   * 约束靠"事件本身稀疏"（开局、换游戏、玩太久、深夜）而不是"压间隔"：
   * 间隔只是兜底，免得换个游戏又换回来被当成两次开局。
   */
  private shouldReach(e: GameEvent): boolean {
    const cfg = this.options.cfg
    if (!cfg.reachOut) return false
    if (cfg.reachMaxPerDay > 0 && this.tracker.reachedToday() >= cfg.reachMaxPerDay) return false
    const gapMs = cfg.reachMinGapMinutes * 60_000
    if (Date.now() - this.lastReachAt < gapMs) return false

    // 刚开始玩：刚玩过又开一局不值得说，隔了一阵才算"重新开张"
    if (e.kind === 'start') {
      const prev = this.tracker.recentEvents(10).filter((x) => x.kind === 'stop' && x.gameId === e.gameId).pop()
      if (prev && (e.at - prev.at) / 3_600_000 < cfg.freshSessionAfterHours) return false
    }
    return true
  }

  /** 推一条事件给她。文本只陈述事实，口吻留给 Persona。 */
  private async reach(e: GameEvent): Promise<void> {
    const host = this.host
    if (!host) return
    this.lastReachAt = Date.now()
    this.tracker.noteReach()
    this.stats.reaches++
    const text = this.renderEvent(e)
    try {
      await host.pushEvent({
        type: `gaming.${e.kind}`,
        ts: nowIso(this.options.timezone),
        source: this.id,
        origin: 'external',
        senderKey: this.id,
        text,
        meta: {
          kind: e.kind,
          game: e.gameId,
          name: e.name,
          ...(e.sessionMinutes !== undefined ? { sessionMinutes: e.sessionMinutes } : {}),
          ...(e.title ? { title: e.title } : {}),
          clock: this.localClock(),
        },
      })
    } catch (err) {
      host.log.warn(`陪玩：推事件失败 ${String(err)}`)
    }
  }

  /**
   * 事件正文。
   *
   * 写成"她看到的事实"而不是"系统通知"——她是要拿这句话去开口的，
   * 所以给它一个能直接接话的形状，同时把细节（标题）留在里面给她自己挑。
   */
  private renderEvent(e: GameEvent): string {
    const track = this.tracker
    const todayLine = (() => {
      const rank = track.todayRanked()
      if (rank.length === 0) return ''
      return `今天他玩过：${rank.slice(0, 3).map((r) => `${r.name} ${humanMinutes(r.minutes)}`).join('、')}。`
    })()
    const title = e.title ? `（窗口标题：「${e.title}」）` : ''
    switch (e.kind) {
      case 'start':
        return `他开游戏了——正在玩「${e.name}」。${title}${todayLine}`
      case 'switch':
        return `他换游戏了——从上一款换到「${e.name}」。${title}`
      case 'stop': {
        const m = e.sessionMinutes ?? 0
        return `他退出了「${e.name}」，这一局玩了 ${humanMinutes(m)}。`
      }
      case 'long': {
        const m = e.sessionMinutes ?? 0
        return `他玩「${e.name}」已经连着 ${humanMinutes(m)} 了，还开着。`
      }
      case 'late':
        return `都 ${this.localClock()} 了他还在玩「${e.name}」，已经 ${humanMinutes(e.sessionMinutes ?? 0)}。`
    }
  }

  // ── 给她的接口 ──────────────────────────────────────────────────────────

  envPromptVars(): Record<string, string> {
    const session = this.tracker.current()
    const reading = this.lastReading
    const screen = !this.screen.ready()
      ? `- 当前不能看画面：${this.screen.blockedReason()}。`
      : !session
        ? '- 当前没有游戏会话。'
        : !reading || Date.now() - reading.at > READING_TTL_MS
          ? '- 当前没有有效的画面读数；可调用 gaming_look。'
          : `- 最近的画面读数距今 ${Math.max(0, Math.round((Date.now() - reading.at) / 60_000))} 分钟，内容见外部观察事件或 gaming_look。`
    return {
      'gaming.now': session
        ? `- 当前有游戏会话，已持续 ${humanMinutes(session.minutes)}；名称和窗口标题可调用 gaming_now 查询。`
        : '- 当前没有游戏会话；近期记录可调用 gaming_recent 查询。',
      'gaming.screen': screen,
      'gaming.tools': this.balance
        ? `- 看图工具耐久度 ${this.durability() ?? 0}%；余额明细可调用 gaming_balance。`
        : '- 看图工具余额尚未查到。',
    }
  }

  onHandoffEnded(): void {
    this.publishObservation()
  }

  onTurnEnded(): void {
    this.publishObservation()
  }

  private publishObservation(): void {
    const host = this.host
    if (!host || this.observationQueued) return
    const generation = this.observationGeneration
    this.observationQueued = true
    try {
      host.pushDeferred({
        type: 'gaming.observation',
        origin: 'external',
        senderKey: this.id,
        tags: ['snapshot'],
        render: () => {
          if (this.host !== host || this.observationGeneration !== generation) return null
          this.observationQueued = false
          return [this.nowBlock(), this.screenBlock(), this.balanceLine()].join('\n')
        },
      }, { trigger: 'piggyback' })
    } catch (err) {
      this.observationQueued = false
      host.log.warn(`陪玩：推观察状态失败 ${String(err)}`)
    }
  }

  /**
   * 她看到的画面。只报读数，不解释怎么来的——来源不该出现在她的话里。
   *
   * 过期就不给了：抽帧是分钟级的，一条十分钟前的"你正在菜单里"，
   * 现在他可能正打到一半，说出来就是错的。
   */
  private screenBlock(): string {
    if (!this.screen.ready()) return `- 你现在看不了他的屏幕（${this.screen.blockedReason()}）。`
    if (!this.tracker.current()) return '- 他没在玩游戏，屏幕上没什么可看的。'
    const r = this.lastReading
    if (!r || Date.now() - r.at > READING_TTL_MS) return '- 这一局你还没看过他的屏幕。'
    const mins = Math.round((Date.now() - r.at) / 60_000)
    const ago = mins < 1 ? '刚刚' : `${mins} 分钟前`
    return `- ${ago}你从他屏幕上看到：${r.scene}（${PHASE_LABEL[r.phase]}）`
  }

  /** 她每轮都能看到的状态块。没在玩就给一句"没在玩"，不留半截话。 */
  private nowBlock(): string {
    const track = this.tracker
    const s = track.current()
    const lines: string[] = []
    if (s) {
      lines.push(`- 他现在在玩「${s.name}」，这一局已经 ${humanMinutes(s.minutes)}。`)
      if (s.title) lines.push(`  窗口标题：「${s.title}」——标题里可能有关卡或地图，别当成确凿的事实说。`)
    } else {
      const last = track.recentEvents(10).filter((e) => e.kind === 'stop').pop()
      if (last) {
        const mins = Math.round((Date.now() - last.at) / 60_000)
        const ago = mins < 60 ? `${mins} 分钟前` : `${Math.round(mins / 60)} 小时前`
        lines.push(`- 他现在没在玩游戏（${ago}退出了「${last.name}」）。`)
      } else {
        lines.push('- 他现在没在玩游戏。')
      }
    }
    const rank = track.todayRanked()
    if (rank.length) {
      lines.push(`- 今天玩过：${rank.slice(0, 3).map((r) => `${r.name} ${humanMinutes(r.minutes)}`).join('、')}。`)
    }
    return lines.join('\n')
  }

  // ── 窗口选择 / 游戏资料 ─────────────────────────────────────────────────

  /** 看图工具的耐久度（余额换算）。没查过就返回 null。 */
  private durability(): number | null {
    const b = this.balance
    if (!b) return null
    const cfg = this.options.cfg.balance
    const warnBelow = Number(cfg?.warnBelow ?? 10)
    const full = Number(cfg?.fullBalance ?? 0) > 0 ? Number(cfg.fullBalance) : warnBelow * 5
    return durabilityOf(b.total, full)
  }

  /** 查一次余额；低于预警线就按冷却时间提醒她一次"看图工具耐久度不足"。 */
  private async checkBalance(): Promise<void> {
    const cfg = this.options.cfg.balance
    if (!cfg || cfg.enabled === false) return
    const key = (cfg.apiKey || this.options.apiKey || '').trim()
    if (!key) return
    const info = await fetchBalance({ baseUrl: cfg.baseUrl || 'https://api.deepseek.com', apiKey: key, timeoutMs: 15000 })
    if (!info) return
    this.balance = info
    const warnBelow = Number(cfg.warnBelow ?? 10)
    if (info.available === false || info.total <= warnBelow) {
      const cooldown = Math.max(1, Number(cfg.cooldownHours ?? 12)) * 3600_000
      if (Date.now() - this.lastWarnAt < cooldown) return
      this.lastWarnAt = Date.now()
      const full = Number(cfg.fullBalance ?? 0) > 0 ? Number(cfg.fullBalance) : warnBelow * 5
      const durability = durabilityOf(info.total, full)
      const text = String(cfg.warnText || '看图工具耐久度不足了（余额 {balance} {currency}，预警线 {below}）。省着点用，跟他说一句。')
        .replace(/\{durability\}/g, String(durability))
        .replace(/\{balance\}/g, info.total.toFixed(2))
        .replace(/\{below\}/g, String(warnBelow))
        .replace(/\{currency\}/g, info.currency)
      try {
        await this.host?.pushEvent({
          type: 'gaming.balance',
          ts: nowIso(this.options.timezone),
          source: 'gaming',
          origin: 'external',
          text: '【看图工具】' + text,
        })
      } catch { /* 推不出去就算，下次冷却后再试 */ }
    }
  }

  private balanceLine(): string {
    const b = this.balance
    if (!b) return '- 看图工具的耐久度还没查（余额没查到）。'
    const cfg = this.options.cfg.balance
    const warnBelow = Number(cfg?.warnBelow ?? 10)
    const d = this.durability()
    const full = Number(cfg?.fullBalance ?? 0) > 0 ? Number(cfg.fullBalance) : warnBelow * 5
    const state = b.available === false ? '已经停用' : b.total <= warnBelow ? '低于预警线，看画面要省着用' : '够用'
    return '- 看图工具耐久度 ' + (d ?? 0) + '%（余额 ' + b.total.toFixed(2) + ' ' + b.currency + '，预警线 ' + warnBelow + '，满格 ' + full + '）：' + state + '。'
  }

  /** 主动查一次余额（工具，也用于控制台）。 */
  private balanceTool(): ToolDef {
    return {
      name: 'gaming_balance',
      description: '查看图工具的"耐久度"（DeepSeek 账户余额、预警线、够不够继续看画面）。想知道还能看多久画面时用。',
      tags: ['read'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => {
        const cfg = this.options.cfg.balance
        const key = (cfg?.apiKey || this.options.apiKey || '').trim()
        if (!key) return '看图工具没配密钥，查不了余额（在 worlds.gaming.balance.apiKey 或视觉模型密钥里填）。'
        const info = await fetchBalance({ baseUrl: cfg?.baseUrl || 'https://api.deepseek.com', apiKey: key, timeoutMs: 15000 })
        if (!info) return '余额没查到（接口不通或返回异常）。'
        this.balance = info
        const warnBelow = Number(cfg?.warnBelow ?? 10)
        const full = Number(cfg?.fullBalance ?? 0) > 0 ? Number(cfg.fullBalance) : warnBelow * 5
        const d = durabilityOf(info.total, full)
        return '看图工具耐久度 ' + d + '%：余额 ' + info.total.toFixed(2) + ' ' + info.currency + '（赠金 ' + info.granted.toFixed(2) + '，充值 ' + info.toppedUp.toFixed(2) + '），预警线 ' + warnBelow + '，满格 ' + full + '，账户' + (info.available ? '可用' : '已停用') + '。'
      },
    }
  }

  private canCapture(game: GameConfig, sample: ForegroundSample): boolean {
    return Boolean(this.effectiveTarget() || this.effectiveTargetTitle()) || matchesAnyProcess(game.processes,sample.proc)
  }

  private effectiveTarget(): string {
    return normalizeProcess(this.manualTarget || this.manualTargetTitle ? this.manualTarget : this.options.cfg.watch.target || '')
  }

  private effectiveTargetTitle(): string {
    return (this.manualTarget || this.manualTargetTitle ? this.manualTargetTitle : this.options.cfg.watch.targetTitle || '').trim()
  }

  private loadTargetFile(): void {
    try {
      if (!existsSync(this.targetFile)) return
      const raw = JSON.parse(readFileSync(this.targetFile, 'utf8')) as { target?: string; title?: string }
      this.manualTarget = typeof raw.target === 'string' ? raw.target : ''
      this.manualTargetTitle = typeof raw.title === 'string' ? raw.title : ''
    } catch { /* 文件坏了就当没有 */ }
  }

  private saveTargetFile(): void {
    try {
      mkdirSync(this.options.dataDir, { recursive: true })
      writeFileSync(this.targetFile, JSON.stringify({ target: this.manualTarget, title: this.manualTargetTitle }, null, 2), 'utf8')
    } catch { /* 写不了就只在这次进程里生效 */ }
  }

  /** 控制台配置组：把"只看这个窗口"渲染成当前可见窗口的下拉列表。 */
  private windowConfigGroup(): unknown {
    const g = JSON.parse(JSON.stringify(GAMING_QUICK_CONFIG_GROUP)) as { schema?: { properties?: Record<string, { enum?: string[] }> } }
    const prop = g.schema?.properties?.['worlds.gaming.watch.target']
    if (prop) prop.enum = ['', ...this.windowCatalog.slice(0, 40)]
    return g
  }

  /** 游戏库管理：列出/添加/删除；加的游戏落 data/gaming-lib.json。 */
  private libraryTool(): ToolDef {
    return {
      name: 'gaming_library',
      description: '游戏库管理：列出当前认得的游戏、添加一个游戏、或删掉之前加的游戏。添加会写进 data/gaming-lib.json（重启后还在）。',
      tags: ['write'],
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'remove'], description: 'list=看；add=加；remove=删。' },
          process: { type: 'string', description: '进程名（add/remove 用；不带 .exe，小写）。' },
          name: { type: 'string', description: '显示名（add 用，可空）。' },
          aliases: { type: 'string', description: '标题别名，逗号分隔（add 用，可空）。' },
          watchFor: { type: 'string', description: '这游戏里留意什么（add 用，可空）。' },
        },
        required: ['action'],
      },
      handler: async (args) => {
        const action = String(args.action ?? '').trim()
        const games = this.options.cfg.games
        if (action === 'list') {
          if (!games.length) return '游戏库现在是空的。可以在控制台「① 快速配置」的 6 个格子里填，或让我用 gaming_library add 加。'
          return '游戏库（' + games.length + ' 个）：\n' + games.map((g) => '- ' + g.name + '｜进程 ' + g.processes.join(',') + '｜别名 ' + (g.aliases.join(',') || '无') + (g.watchFor ? '｜看什么：' + g.watchFor : '')).join('\n')
        }
        const proc = normalizeProcess(String(args.process ?? ''))
        if (!proc) return '要给 process（进程名）。'
        const disk = loadLibrary(this.options.dataDir)
        if (action === 'add') {
          if (games.some((g) => matchesAnyProcess(g.processes,proc))) return '游戏库已经有这个进程了：' + proc
          const game: GameConfig = {
            id: proc.replace(/[^a-z0-9_-]+/g, '-'),
            name: String(args.name ?? '').trim() || proc,
            processes: [proc],
            aliases: String(args.aliases ?? '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean),
            watchFor: String(args.watchFor ?? '').trim() || undefined,
          }
          games.push(game)
          disk.push(game)
          saveLibrary(this.options.dataDir, disk)
          return '已加入游戏库：' + game.name + '（进程 ' + proc + '）。下次它在前台就认得出来了。'
        }
        if (action === 'remove') {
          const before = games.length
          this.options.cfg.games = games.filter((g) => !matchesAnyProcess(g.processes,proc))
          const diskAfter = disk.filter((g) => !matchesAnyProcess(g.processes,proc))
          const removedDisk = disk.length - diskAfter.length
          saveLibrary(this.options.dataDir, diskAfter)
          const removed = before - this.options.cfg.games.length
          return removed > 0
            ? '已从运行时游戏库删掉 ' + removed + ' 条（落盘 ' + removedDisk + ' 条）。如果它来自 config.json 的 games 或快速配置格子，重启后还会出现，要去那里删。'
            : '游戏库里没有这个进程：' + proc
        }
        return '不认识 action：' + action
      },
    }
  }

  private windowsTool(): ToolDef {
    return {
      name: 'gaming_windows',
      description: '列出她现在能看到的窗口（进程名 + 标题 + 尺寸），用来挑一个"只看这个窗口"。只在 Windows 上有效。',
      tags: ['read'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => {
        const list = await listVisibleWindows()
        if (!list.length) return '现在没看到能抓的窗口（这个功能只在 Windows 上有效）。'
        const lines = list.slice(0, 20).map((w, i) => (i + 1) + '. ' + w.proc + '｜' + w.title.slice(0, 60) + '｜' + w.w + 'x' + w.h)
        return '能看到的窗口：\n' + lines.join('\n') + '\n\n要只看某个就调 gaming_watch_window：target 填进程名，或 title 填标题里的关键字；clear=true 恢复自动。'
      },
    }
  }

  private watchWindowTool(): ToolDef {
    return {
      name: 'gaming_watch_window',
      description: '指定她看哪个窗口（而不是跟着正在玩的游戏进程）。Windows 用。target=进程名，title=标题关键字，clear=true 恢复自动。',
      tags: ['write'],
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          target: { type: 'string', description: '进程名，比如 chrome、notepad。' },
          title: { type: 'string', description: '窗口标题里包含的关键字。' },
          clear: { type: 'boolean', description: 'true = 恢复跟着游戏进程自动选。' },
        },
        required: [],
      },
      handler: async (args) => {
        if (args.clear === true) {
          this.manualTarget = ''
          this.manualTargetTitle = ''
          this.saveTargetFile()
          return '已恢复：跟着正在玩的游戏窗口自动选。'
        }
        const target = normalizeProcess(String(args.target ?? ''))
        const title = String(args.title ?? '').trim()
        if (!target && !title) return '给 target（进程名）或 title（标题关键字）；要恢复自动就 clear=true。'
        this.manualTarget = target
        this.manualTargetTitle = title
        this.saveTargetFile()
        return '以后只看：' + (target || '（任意进程）') + (title ? '｜标题含「' + title + '」' : '') + '。'
      },
    }
  }

  /**
   * 开局/换游戏时后台搜一次这个游戏的资料。
   *
   * 只搜一次、只推一条：她要知道的是"这游戏怎么玩、有什么术语、该报什么点"，
   * 不是每局都背一遍wiki。搜不到就安静，不影响别的。
   */
  private async learnGame(e: GameEvent): Promise<void> {
    if (!this.options.cfg.watch.learnOnStart) return
    const key = e.gameId + '@' + this.localDay()
    if (this.learnedGames.has(key)) return
    this.learnedGames.add(key)
    try {
      const snippets = await this.webSearch(e.name + ' 新手 玩法 术语 报点 攻略')
      if (!snippets.length) return
      this.saveGameNote(e, snippets)
      const body = snippets.slice(0, 5).map((s) => '- ' + s.slice(0, 220)).join('\n')
      await this.host?.pushEvent({
        type: 'gaming.learned',
        ts: nowIso(this.options.timezone),
        source: this.id,
        origin: 'external',
        senderKey: this.id,
        text: '「' + e.name + '」的网页搜索摘要：\n' + body,
      }, { trigger: 'piggyback' })
    } catch { /* 搜不到就当没发生 */ }
  }

  private saveGameNote(e: GameEvent, snippets: string[]): void {
    try {
      const file = join(this.options.dataDir, 'game-notes.json')
      let all: Record<string, unknown> = {}
      if (existsSync(file)) {
        try { all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> } catch { all = {} }
      }
      all[e.gameId] = { name: e.name, day: this.localDay(), at: new Date().toISOString(), snippets: snippets.slice(0, 6) }
      mkdirSync(this.options.dataDir, { recursive: true })
      writeFileSync(file, JSON.stringify(all, null, 2), 'utf8')
    } catch { /* 落盘失败不影响 */ }
  }

  /** 搜一下（Bing 网页结果摘要）。失败返回空数组，调用方安静跳过。 */
  private async webSearch(query: string, timeoutMs = 15000): Promise<string[]> {
    try {
      const res = await fetch('https://cn.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN', {
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', accept: 'text/html' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) return []
      const html = await res.text()
      const out: string[] = []
      const re = /<li class="b_algo"[\s\S]*?<\/li>/g
      let m: RegExpExecArray | null
      while ((m = re.exec(html)) && out.length < 6) {
        const block = m[0]
        const tm = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+>([\s\S]*?)<\/a>/)
        const pm = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)
        const title = stripHtml(tm?.[1] ?? '')
        const snip = stripHtml(pm?.[1] ?? '')
        if (title) out.push(title + (snip ? '：' + snip : ''))
      }
      return out
    } catch {
      return []
    }
  }

  tools(): ToolDef[] {
    return [this.nowTool(), this.recentTool(), this.lookTool(), this.windowsTool(), this.watchWindowTool(), this.balanceTool(), this.libraryTool()]
  }

  /**
   * 现在就看一眼。绕过抽帧间隔——她问了就该给最新的，不该拿几分钟前的读数应付。
   */
  private lookTool(): ToolDef {
    return {
      name: 'gaming_look',
      description: '现在看一眼主人的游戏画面，说说屏幕上是什么样。想知道他打到哪了、这一局怎么样了时用。',
      tags: ['read'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => {
        if (!this.screen.ready()) return `现在看不了他的屏幕：${this.screen.blockedReason()}。`
        const session = this.tracker.current()
        if (!session) return '他现在没在玩游戏，屏幕上没什么可看的。'
        const sample = this.watcher.latest()
        const game = this.options.cfg.games.find((g) => g.id === session.gameId)
        if (!sample || !game) return '看不到他的屏幕。'
        if (!this.canCapture(game,sample)) {
          const foreground = (sample.title || sample.proc || '未知窗口').replace(/\s+/g,' ').slice(0,120)
          return `他现在没把「${session.name}」放在前台（前台是「${foreground}」），这拍看不到游戏画面。`
        }
        const reading = await this.screen.look(sample.proc, session.name, game.watchFor, undefined, this.effectiveTarget(), this.effectiveTargetTitle())
        if (!reading) return `看一眼没看成：${this.screen.errorText() || '抓不到画面'}。`
        this.lastReading = reading
        return `${reading.scene}（${PHASE_LABEL[reading.phase]}）`
      },
    }
  }

  private nowTool(): ToolDef {
    return {
      name: 'gaming_now',
      description: '看主人现在在玩什么游戏、这一局玩了多久。想知道"要不要接一句游戏的话"时用。',
      tags: ['read'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => this.nowBlock().replace(/^- /gm, ''),
    }
  }

  private recentTool(): ToolDef {
    return {
      name: 'gaming_recent',
      description: '看最近他在玩什么——开局、换游戏、退出的记录。翻"他今天玩了啥"时用。',
      tags: ['read'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', description: '看几条，默认 8。' },
        },
        required: [],
      },
      handler: async (args) => {
        const raw = Number(args.count ?? 8)
        const n = Number.isSafeInteger(raw) ? Math.min(Math.max(raw, 1), 40) : 8
        const evs = this.tracker.recentEvents(n)
        if (!evs.length) return '还没有记录——他最近没在你看着的时候玩游戏。'
        const kind: Record<string, string> = { start: '开了', switch: '换了', stop: '退了', long: '玩了很久', late: '深夜还在玩' }
        return evs.map((e) => {
          const t = nowIso(this.options.timezone, new Date(e.at)).slice(11, 16)
          const extra = e.sessionMinutes !== undefined ? ` ${humanMinutes(e.sessionMinutes)}` : ''
          return `${t} ${kind[e.kind] ?? e.kind}「${e.name}」${extra}`
        }).join('\n')
      },
    }
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const s = this.tracker.current()
    const rank = this.tracker.todayRanked()
    const sample = this.watcher.latest()
    return {
      lamps: [
        {
          label: '采集',
          state: this.watcher.alive() ? 'online' : 'offline',
          /*
           * 这里必须把"采到过没有"也说出来。
           *
           * 采集器进程活着不等于采到了：PowerShell 起得来、却一行都没吐出来时，
           * `alive()` 照样为真，而 tracker 因为 `latest()` 恒为 null 每拍直接 early
           * return —— 现象是「灯说在采、状态却永远停在重启前那一局」，查起来毫无线索。
           */
          hint: !this.watcher.alive()
            ? '采集器没起来（只在 Windows 上能跑）'
            : sample
              ? `在采前台窗口 · 最近一次「${sample.proc}」· ticks=${this.stats.ticks}`
              : `采集器活着但一行都没采到（ticks=${this.stats.ticks}）`,
        },
        {
          label: '在玩',
          state: s ? 'online' : 'offline',
          /*
           * 游戏库空着、又开着 knownGamesOnly 时，这个 World 永远判"没在玩"——不报错、不打日志。
           * 刚装完的人看到的和"你没在打游戏"一模一样，查不出来是自己没配。所以这里必须说破。
           */
          hint: s
            ? `${s.name} · ${humanMinutes(s.minutes)}`
            : this.options.cfg.games.length === 0 && this.options.cfg.knownGamesOnly
              ? '游戏库是空的，认不出任何游戏——先在 config.json 的 worlds.gaming.games 里填上你玩的'
              : '现在没在玩',
        },
        {
          label: '看图工具',
          state: this.balance ? (this.durability() !== null && this.durability()! > 20 ? 'online' : 'error') : 'loading',
          hint: this.balance ? this.balanceLine().replace('- ', '') : '余额还没查',
        },
        {
          label: '看画面',
          state: this.screen.ready() ? 'online' : 'offline',
          hint: !this.screen.ready()
            ? this.screen.blockedReason()
            : this.lastReading
              ? `${PHASE_LABEL[this.lastReading.phase]} · 看过 ${this.looksInSession} 次${this.screen.errorText() ? ` · 上次失败：${this.screen.errorText()}` : ''}`
              : '还没看过',
        },
      ],
      badges: [
        { label: '今天', value: rank.length ? rank.slice(0, 2).map((r) => `${r.name} ${Math.round(r.minutes)}m`).join(' · ') : '没玩' },
        { label: '主动', value: String(this.tracker.reachedToday()) },
      ],
      config: [this.windowConfigGroup() as never, GAMING_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.gaming.envPrompt',
          title: '陪玩 · 环境提示词',
          description: '告诉她怎么用"他在玩什么"这个事实，别把标题当确凿事实说。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'gaming.now', description: '游戏会话是否存在、持续时间和查询工具。' },
            { name: 'gaming.screen', description: '看画面是否可用、读数有效期和查询工具。' },
            { name: 'gaming.tools', description: '看图工具耐久度和余额查询工具。' },
          ],
        },
      ],
    }
  }

  /** 停机后的外部状态检查：采集器该没了。 */
  shutdownVerification(): readonly ShutdownExternalCheck[] {
    const alive = this.watcher.alive()
    return [{
      key: 'gaming.window-watcher',
      label: '前台窗口采集器',
      status: alive ? 'still-live' : 'verified-ended',
      detail: alive ? '采集器进程还活着' : '已停止',
      manualAction: '结束遗留的 powershell.exe 进程',
    }]
  }
}

/** 全部工具的声明;自描述要列出 tools() 能返回的每一个。 */
export const GAMING_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'gaming_look',
    description: '现在看一眼主人的游戏画面，说说屏幕上是什么样。想知道他打到哪了、这一局怎么样了时用。',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'gaming_now',
    description: '看主人现在在玩什么游戏、这一局玩了多久。想知道"要不要接一句游戏的话"时用。',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'gaming_library',
    description: '游戏库管理：列出/添加/删除她能认出来的游戏。添加会写进 data/gaming-lib.json。',
    tags: ['write'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove'], description: 'list=看；add=加；remove=删。' },
        process: { type: 'string', description: '进程名（add/remove 用）。' },
        name: { type: 'string', description: '显示名（add 用，可空）。' },
        aliases: { type: 'string', description: '标题别名，逗号分隔（add 用，可空）。' },
        watchFor: { type: 'string', description: '这游戏里留意什么（add 用，可空）。' },
      },
      required: ['action'],
    },
  },
  {
    name: 'gaming_balance',
    description: '查看图工具的"耐久度"（DeepSeek 账户余额、预警线、够不够继续看画面）。想知道还能看多久画面时用。',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'gaming_windows',
    description: '列出她现在能看到的窗口（进程名 + 标题 + 尺寸），用来挑一个"只看这个窗口"。只在 Windows 上有效。',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'gaming_watch_window',
    description: '指定她看哪个窗口（而不是跟着正在玩的游戏进程）。target=进程名，title=标题关键字，clear=true 恢复自动。',
    tags: ['write'],
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        target: { type: 'string', description: '进程名，比如 chrome、notepad。' },
        title: { type: 'string', description: '窗口标题里包含的关键字。' },
        clear: { type: 'boolean', description: 'true = 恢复跟着游戏进程自动选。' },
      },
      required: [],
    },
  },
  {
    name: 'gaming_recent',
    description: '看最近他在玩什么——开局、换游戏、退出的记录。翻"他今天玩了啥"时用。',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        count: { type: 'integer', description: '看几条，默认 8。' },
      },
      required: [],
    },
  },
];
