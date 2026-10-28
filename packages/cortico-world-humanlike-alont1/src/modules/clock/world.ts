/**
 * Clock World（现在几点）。
 *
 * 它只做一件事：**把她上下文里唯一会断掉的那条线索补上 —— 时间**。
 *
 * 为什么需要它：她能看到的其他时间都来自消息自带的时间戳，一下午没人说话，
 * 她看到的最后一个时间就是几小时前的。系统前缀里的时间又会僵住（前缀是缓存的），
 * 所以这里给的是两条活路：她问就现算（`humanlike_clock_now`），时段变化时主动说一句。
 *
 * 为什么分发率和时段挂钩而不是按固定间隔报：固定间隔是噪音，一天开始和该睡了
 * 这两个点才有意义。中午十二点报一句"现在是中午"，对她没有任何用。
 */
import { fileURLToPath } from 'node:url'
import type { ShutdownExternalCheck, ToolDef, World, WorldWebUiDecl, WorldHost } from 'cortico/core/types.ts'
import type { Language } from 'cortico/core/language.ts'
import { hourIn, nowIso } from 'cortico/core/util.ts'
import { CLOCK_CONFIG_GROUP, type ClockConfigSection } from './config.ts'
import { PERIOD_NOTES, clockLine, dayProgress, humanMinutes, periodOf, type PeriodName } from './clock.ts'

/** 环境提示词模板。role=envPrompt 的声明缺了就不进系统前缀，所以必须在 console() 里报出来。 */
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url))

/** 轮询间隔。时段边界以小时计，一分钟一次足够了。 */
const POLL_MS = 60_000

/** 主动报时里算"有意义"的那两个时段：一天开始，和该睡了。 */
const QUIET_HOURS: readonly PeriodName[] = ['清晨', '深夜']

export class ClockWorld implements World {
  readonly id = 'clock'
  private host: WorldHost | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  /** 上一次看到的时段。启动时先记下当前值，免得重启就把"刚进入某时段"误报一次。 */
  private lastPeriod: PeriodName
  private lastAnnounceAt = 0

  constructor(private readonly options: { cfg: ClockConfigSection; timezone: string }) {
    this.lastPeriod = this.period()
  }

  private period(): PeriodName {
    return periodOf(hourIn(this.options.timezone))
  }

  private stamp(): string {
    return nowIso(this.options.timezone)
  }

  private weekday(): string {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: this.options.timezone,
      weekday: 'short',
    }).format(new Date())
  }

  /** `9月21日 13:24 周一，下午`。 */
  private line(): string {
    return clockLine(this.stamp(), this.weekday())
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  async start(host: WorldHost): Promise<void> {
    this.host = host
    this.lastPeriod = this.period()
    this.timer = setInterval(() => { void this.tick() }, POLL_MS)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.host = null
  }

  private async tick(): Promise<void> {
    const host = this.host
    if (!host) return
    const period = this.period()
    if (period === this.lastPeriod) return
    this.lastPeriod = period
    if (!this.shouldAnnounce(period)) return

    this.lastAnnounceAt = Date.now()
    try {
      await host.pushEvent({
        type: 'clock.period',
        ts: this.stamp(),
        source: this.id,
        origin: 'internal',
        senderKey: this.id,
        text: `现在是 ${this.line()}。${PERIOD_NOTES[period]}`,
        meta: { period, clock: this.stamp().slice(11, 16) },
      }, { trigger: 'piggyback' })
    } catch (err) {
      host.log.warn(`现在几点：推事件失败 ${String(err)}`)
    }
  }

  /**
   * 这一拍该不该主动开口。
   *
   * 间隔是兜底：重启、校时都可能让同一个时段在几分钟内被判成"刚进入"两次。
   */
  private shouldAnnounce(period: PeriodName): boolean {
    const cfg = this.options.cfg
    if (cfg.announce === 'off') return false
    if (Date.now() - this.lastAnnounceAt < Math.max(1, cfg.announceGapMinutes) * 60_000) return false
    return cfg.announce === 'all' ? true : QUIET_HOURS.includes(period)
  }

  // ── 她能看到什么 ────────────────────────────────────────────────────────

  envPromptVars(): Record<string, string> {
    return { 'clock.now': this.line() }
  }

  tools(): ToolDef[] {
    return [{
      name: 'humanlike_clock_now',
      description: '现在几点、几号、星期几，属于一天里的哪个时段，今天还剩多久。'
        + '想知道现在是不是深夜了、离上次说话过了多长时间时用。',
      tags: ['read'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => {
        const { leftMinutes } = dayProgress(this.stamp())
        const period = this.period()
        return `现在是 ${this.line()}。${PERIOD_NOTES[period]}今天还剩 ${humanMinutes(leftMinutes)}。`
      },
    }]
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const cfg = this.options.cfg
    const period = this.period()
    return {
      lamps: [
        { label: '钟点', state: 'online', hint: this.line() },
        {
          label: '主动报时',
          state: cfg.announce === 'off' ? 'offline' : 'online',
          hint: cfg.announce === 'off'
            ? '不主动说，只能她问'
            : cfg.announce === 'all'
              ? '每个时段都说'
              : '只在清晨和深夜说',
        },
      ],
      badges: [
        { label: '时段', value: period },
        { label: '今天还剩', value: humanMinutes(dayProgress(this.stamp()).leftMinutes) },
      ],
      config: [CLOCK_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.clock.envPrompt',
          title: '现在几点 · 环境提示词',
          description: '告诉她时间与时段怎么读，并说明前缀里那行是生成时写下的、会过期。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [{ name: 'clock.now', description: '生成这段前缀时的钟点与时段。' }],
        },
      ],
    }
  }

  /** 停机后的外部状态检查：这个 World 不拉外部进程，永远干净。 */
  shutdownVerification(): readonly ShutdownExternalCheck[] {
    return []
  }
}

/** 全部工具的声明;自描述要列出 tools() 能返回的每一个。 */
export const CLOCK_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'humanlike_clock_now',
    description: '现在几点、几号、星期几，属于一天里的哪个时段，今天还剩多久。'
      + '想知道现在是不是深夜了、离上次说话过了多长时间时用。',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];
