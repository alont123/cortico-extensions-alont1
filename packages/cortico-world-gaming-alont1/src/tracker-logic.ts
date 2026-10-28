import { matchesAnyProcess, normalizeProcess } from './proc.ts'
/**
 * 游戏追踪。
 *
 * 采前台窗口 → 判定是不是游戏 → 维护"这一局"的状态。
 *
 * 判定的两层设计：
 *   - **游戏库里认得的**（按 id / 进程名 / 别名匹配）→ 算游戏，用它自己的名字；
 *   - **库里没有的** → 看进程名像不像游戏（不在黑名单里）+ 有窗口标题，
 *     算作"一个没记下来的游戏"，用标题当名字。这样临时玩个新游戏也能被看到，
 *     代价是个别程序会误判——所以它只报"可能在玩"，不当事实说。
 *
 * 状态落盘在 `<dataDir>/gaming.json`，按天存。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { GameConfig, GamingConfigSection } from './config.ts'
import type { ForegroundWatcher, ForegroundSample } from './tracker-window.ts'

export type GameEventKind =
  /** 开始玩一个游戏 */
  | 'start'
  /** 换了一个游戏（中间没断开） */
  | 'switch'
  /** 停下来了（窗口不再是游戏，且持续够久） */
  | 'stop'
  /** 同一个游戏连着玩了很久 */
  | 'long'
  /** 玩到深夜 */
  | 'late'

export interface GameEvent {
  kind: GameEventKind
  gameId: string
  name: string
  /** 这一次连续玩了多久（分钟），stop / long / late 用 */
  sessionMinutes?: number
  /** 标题里带的细节，给她当参考材料 */
  title?: string
  at: number
}

export interface GameSession {
  gameId: string
  name: string
  title: string
  startedAt: number
  /** 上一次"看到游戏在前台"的时刻。切出去之后它不再更新 */
  lastSeenAt: number
  /** 这一局累计多少分钟，按真实时间差累加 */
  minutes: number
  /** 这一局已经报到第几个"很久了"（避免同一个整数倍重复报） */
  longReported: number
}

export interface GamingState {
  version: number
  /** 状态属于哪一天（本地日期），跨天就重置当日统计 */
  day: string
  session: GameSession | null
  /**
   * 从什么时候起窗口不再是游戏了。
   *
   * 跟 `session.lastSeenAt` 分开记：那个是"最后看到游戏的时刻"，
   * 这个是"第一次发现他切走了的时刻"。退出判定要的是后者——
   * 早先把两者合成一个，导致 awayMinutes 设小了永远判不出退出。
   */
  awaySince: number | null
  /** 每个游戏今天玩了多久 */
  todayMinutes: Record<string, number>
  /** 每个游戏累计玩了多久 */
  totalMinutes: Record<string, number>
  /** 游戏名映射（库里没有、靠标题认出来的那些） */
  learned: Record<string, string>
  /** 最近的事件，新的在后。上限由 cfg.eventKeep 定 */
  events: GameEvent[]
  /** 今天已经主动说过几次话 */
  todayReachCount: number
}

const round1 = (n: number): number => Math.round(n * 10) / 10

/**
 * 现在是不是在深夜时段。跨午夜要能表达：`start > end` 时表示跨了零点。
 *
 * 早先写成 `h >= from || h < 5`，`from` 取默认值 1 时等于「1 点之后全算深夜」，
 * 晚上八点也会被报一次。起止都得写出来，才判得准。
 */
export function inNightWindow(hour: number, start: number, end: number): boolean {
  if (start === end) return false          // 起止相同 = 没设深夜时段
  return start > end ? (hour >= start || hour < end) : (hour >= start && hour < end)
}

/**
 * 单次时间差的上限（分钟）。防的是休眠恢复后一次跳几小时。
 *
 * 它只防休眠恢复后一次跳几小时，所以必须**远大于任何合法的采样间隔**：
 * 取小了会把正常的采样间隔也削平，时长永远累积不到阈值（早先取 5 和 20 都栽在这）。
 * 真正的边界在别处——`awayMinutes` 判退出、跨天重置，那些才是防跑飞的地方。
 */
const MAX_DELTA_MINUTES = 120

/** 默认的"这不是游戏"进程。用户可以改，但默认表得覆盖常见桌面程序。 */
export const DEFAULT_NON_GAME = [
  'explorer', 'msedge', 'chrome', 'firefox', 'brave', 'opera',
  'powershell', 'pwsh', 'cmd', 'conhost', 'windowsterminal', 'wt',
  'code', 'devenv', 'idea64', 'pycharm64', 'notepad', 'notepad++', 'sublime_text',
  'obs64', 'obs32', 'vtuberstudio', 'voicemod', 'streamlabs',
  'qq', 'wechat', 'weixin', 'discord', 'telegram', 'slack', 'dingtalk',
  'taskmgr', 'control', 'systemsettings', 'applicationframehost',
  'searchhost', 'startmenuexperiencehost', 'shellexperiencehost',
  'photos', 'mspaint', 'snippingtool', 'calc', 'mstsc',
]

export function looksLikeGame(sample: ForegroundSample, cfg: GamingConfigSection): boolean {
  const proc = normalizeProcess(sample.proc)
  const nonGame = new Set([...DEFAULT_NON_GAME, ...cfg.nonGameProcesses.map(normalizeProcess)])
  if (nonGame.has(proc)) return false
  // 没有标题的多半是后台窗口或系统组件
  if (!sample.title.trim()) return false
  return true
}

/** 在游戏库里找这个采样属于哪个游戏。进程名优先，其次别名。 */
export function matchGame(sample: ForegroundSample, games: readonly GameConfig[]): GameConfig | null {
  const proc = normalizeProcess(sample.proc)
  const title = sample.title.toLowerCase()
  // 先按进程名精确匹配（最稳）
  for (const g of games) {
    if (matchesAnyProcess(g.processes,proc)) return g
  }
  // 再按标题里的别名匹配（有些游戏进程名是通用的 launcher）
  /*
   * 但跳过那些**本身出现在进程名里**的别名。
   *
   * 别名表里有单词别名 `Launcher`，而 `"bsglauncher".includes("launcher")` 为真 ——
   * 于是塔科夫的启动器窗口被判成"在玩逃离塔科夫"。真正开打的进程是
   * `escapefromtarkov`，那条会走上面的精确匹配，所以这里跳过不丢东西。
   */
  for (const g of games) {
    const all = [g.id, g.name, ...g.aliases]
    if (all.some((a) => {
      const alias = a?.toLowerCase()
      if (!alias) return false
      if (proc.includes(alias)) return false
      return title.includes(alias)
    })) return g
  }
  return null
}

/*
 * 读进来的状态是**外部输入**：可能是旧版本写的，也可能被手改过。
 *
 * 为什么必须逐字段洗：`lastSeenAt` 曾经被写成字符串。字符串进了状态之后，
 * `now - active.lastSeenAt` 是 NaN，而 NaN 参与的每个比较都是 false ——
 * 于是那一局永远收不掉、`awaySince` 永远设不上、文件再也不写。
 * 症状是「她的状态永远停在重启前那一局」，而日志里一条错都没有。
 * 一个字段的类型不对不该能让整个 World 卡死。
 */
function finiteNum(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v)
}

function asNum(v: unknown, fallback = 0): number {
  if (finiteNum(v)) return v as number
  // 字符串形式的数字也收下（旧版本就是这么写的），真读不出来才用兜底
  const n = typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : fallback
}

/**
 * 时间戳必须是数字；给字符串也认，认不出来就当这局无效——宁可丢掉一局，也不能卡死。
 *
 * 字符串有两种：epoch 毫秒（`"1789920000000"`）和 ISO（`"2026-09-21T00:00:00+08:00"`）。
 * 先试 `Number` 再试 `Date.parse` —— 反过来的话 `Date.parse("1789920000000")`
 * 是 NaN（它只认日期格式），而 epoch 字符串正是旧版本写出来的形状。
 */
function asTime(v: unknown): number | null {
  if (finiteNum(v)) return v as number
  if (typeof v !== 'string') return null
  const n = Number(v)
  if (Number.isFinite(n)) return n
  const d = Date.parse(v)
  return Number.isFinite(d) ? d : null
}

function sanitizeSession(v: unknown): GameSession | null {
  if (!v || typeof v !== 'object') return null
  const s = v as Record<string, unknown>
  const startedAt = asTime(s.startedAt)
  let lastSeenAt = asTime(s.lastSeenAt)
  if (startedAt === null && lastSeenAt === null) return null
  // 只有一个时间戳合法时，用另一个补上，别把 undefined 留在状态里
  const start = startedAt ?? lastSeenAt!
  if (lastSeenAt === null) lastSeenAt = start
  if (typeof s.gameId !== 'string' || !s.gameId) return null
  return {
    gameId: s.gameId,
    name: typeof s.name === 'string' && s.name ? s.name : s.gameId,
    title: typeof s.title === 'string' ? s.title : '',
    startedAt: start,
    lastSeenAt,
    minutes: asNum(s.minutes),
    longReported: asNum(s.longReported),
  }
}

function numberMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!v || typeof v !== 'object') return out
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const n = asNum(x, Number.NaN)
    if (Number.isFinite(n)) out[k] = n
  }
  return out
}

function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!v || typeof v !== 'object') return out
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x === 'string') out[k] = x
  }
  return out
}

function isEvent(v: unknown): v is GameEvent {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return typeof e.kind === 'string' && finiteNum(e.at)
}

export class GameTracker {
  private state: GamingState
  private readonly file: string
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly opts: {
      cfg: GamingConfigSection
      dataDir: string
      timezone: string
      watcher: ForegroundWatcher
      /** 本地日期取法由外面给，跟 World 的时区保持一致 */
      today: () => string
      /** 现在几点（0~23），判断深夜用 */
      hour: () => number
      /** 取当前毫秒。抽出来是为了测试能模拟时间流逝。 */
      now?: () => number
    },
  ) {
    this.file = join(opts.dataDir, 'gaming.json')
    this.state = this.load()
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  // ── 持久化 ──────────────────────────────────────────────────────────────

  private load(): GamingState {
    const empty: GamingState = {
      version: 1, day: this.opts.today(), session: null, awaySince: null,
      todayMinutes: {}, totalMinutes: {}, learned: {}, events: [], todayReachCount: 0,
    }
    try {
      if (!existsSync(this.file)) return empty
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<GamingState>
      if (!raw || typeof raw !== 'object') return empty
      const s: GamingState = {
        version: 1,
        day: typeof raw.day === 'string' ? raw.day : empty.day,
        session: sanitizeSession(raw.session),
        awaySince: finiteNum(raw.awaySince) ? (raw.awaySince as number) : null,
        todayMinutes: numberMap(raw.todayMinutes),
        totalMinutes: numberMap(raw.totalMinutes),
        learned: stringMap(raw.learned),
        events: Array.isArray(raw.events) ? (raw.events as GameEvent[]).filter(isEvent) : [],
        todayReachCount: Number(raw.todayReachCount ?? 0),
      }
      // 跨天了：清当日
      if (s.day !== empty.day) {
        s.day = empty.day
        s.todayMinutes = {}
        s.todayReachCount = 0
        s.events = []
        // 跨天时那一局也算结束——不然"玩了一整天"会算错
        s.session = null
        s.awaySince = null
      }
      return s
    } catch {
      return empty
    }
  }

  private save(): void {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush() }, 300)
    this.flushTimer.unref?.()
  }

  private flush(): void {
    if (!this.dirty) return
    this.dirty = false
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, `${JSON.stringify(this.state, null, 1)}\n`, 'utf8')
      renameSync(tmp, this.file)         // 原子替换，写一半断电也不会留半个文件
    } catch { /* 落盘失败不该拖垮 World，下次再试 */ }
  }

  /** World 停机时把攒着的写下去。 */
  close(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
    this.flush()
  }

  // ── 读 ──────────────────────────────────────────────────────────────────

  snapshot(): Readonly<GamingState> {
    return this.state
  }

  current(): GameSession | null {
    return this.state.session
  }

  minutesToday(gameId: string): number {
    return round1(this.state.todayMinutes[gameId] ?? 0)
  }

  /** 今天玩过的游戏，按时间从多到少。 */
  todayRanked(): Array<{ gameId: string; name: string; minutes: number }> {
    return Object.entries(this.state.todayMinutes)
      .filter(([, m]) => m >= 1)
      .map(([gameId, minutes]) => ({ gameId, name: this.nameOf(gameId), minutes: round1(minutes) }))
      .sort((a, b) => b.minutes - a.minutes)
  }

  nameOf(gameId: string): string {
    const g = this.opts.cfg.games.find((x) => x.id === gameId)
    if (g) return g.name
    return this.state.learned[gameId] ?? gameId
  }

  recentEvents(n = 5): GameEvent[] {
    return this.state.events.slice(-n)
  }

  reachedToday(): number {
    return this.state.todayReachCount
  }

  noteReach(): void {
    this.state.todayReachCount += 1
    this.save()
  }

  // ── 每 tick 主逻辑 ──────────────────────────────────────────────────────

  /**
   * 采一次，推进状态，返回这一拍发生的事件（可能为空）。
   *
   * 时长按**真实时间差**累加（单次上限 {@link MAX_DELTA_MINUTES}，防休眠跳变），
   * 不用 tick 计数——采样间隔是可配的，按计数算的话间隔一大就永远累积不到阈值。
   *
   * 退出判定用 `awaySince`：从"第一次发现不是游戏"起算，超过 `awayMinutes` 才算停。
   * 短暂切出去看攻略不该算结束。
   */
  tick(): GameEvent[] {
    const sample = this.opts.watcher.latest()
    const cfg = this.opts.cfg
    const now = this.now()
    const out: GameEvent[] = []
    if (!sample) return out

    const matched = matchGame(sample, cfg.games)
    /*
     * 只认游戏库时，`matched` 就是唯一判据。关掉那个开关才让"有标题就当游戏"
     * 兜底 —— 那条路会把浏览器、加速器、聊天窗口都算成游戏，她就会一句句说错话。
     */
    const isGame = matched !== null || (!cfg.knownGamesOnly && looksLikeGame(sample, cfg))

    if (!isGame) {
      const s = this.state.session
      if (s) {
        if (this.state.awaySince === null) this.state.awaySince = now
        if (now - this.state.awaySince > cfg.awayMinutes * 60_000) {
          out.push(this.endSession(s, 'stop'))
        }
      }
      if (out.length) this.save()
      return out
    }

    // 是游戏：清掉"切走了"的计时
    this.state.awaySince = null
    const gameId = matched ? matched.id : this.learnedId(sample)
    const name = matched ? matched.name : (this.state.learned[gameId] ?? gameId)
    const before = this.state.session

    if (before && before.gameId !== gameId) {
      // 换游戏：先收尾旧的，再开新的
      out.push(this.endSession(before, 'switch'))
    }

    const active = this.state.session
    if (!active) {
      out.push(this.startSession(gameId, name, sample, now))
    } else {
      // 还在同一个游戏：按真实时间差累加
      const deltaMin = Math.min(Math.max(0, (now - active.lastSeenAt) / 60_000), MAX_DELTA_MINUTES)
      active.minutes = round1(active.minutes + deltaMin)
      active.lastSeenAt = now
      active.title = sample.title || active.title
      this.state.todayMinutes[gameId] = round1((this.state.todayMinutes[gameId] ?? 0) + deltaMin)
      this.state.totalMinutes[gameId] = round1((this.state.totalMinutes[gameId] ?? 0) + deltaMin)
    }

    // 长时提醒：每跨越一次 longSessionMinutes 的整数倍就报一次
    const cur = this.state.session
    if (cur) {
      const step = Math.floor(cur.minutes / cfg.longSessionMinutes)
      if (step > cur.longReported && cur.minutes >= cfg.longSessionMinutes) {
        cur.longReported = step
        out.push({ kind: 'long', gameId: cur.gameId, name: cur.name, sessionMinutes: Math.round(cur.minutes), title: cur.title, at: now })
      }
    }

    // 深夜：一天之内同一个游戏只报一次，且**开局那一拍也检查**——
    // 早先只在"还在玩"分支里查，凌晨刚开游戏就漏了
    const h = this.opts.hour()
    if (inNightWindow(h, cfg.lateNightStartHour, cfg.lateNightEndHour)) {
      const already = this.state.events.some((e) => e.kind === 'late' && e.gameId === gameId && this.sameDay(e.at, now))
      if (!already) {
        out.push({
          kind: 'late', gameId, name,
          sessionMinutes: Math.round(this.state.session?.minutes ?? 0),
          title: sample.title, at: now,
        })
      }
    }

    this.save()
    for (const e of out) this.pushEvent(e)
    return out
  }

  private learnedId(sample: ForegroundSample): string {
    // 库里没有的游戏，用进程名当 id（同一个游戏标题会变，进程名不会）
    const id = normalizeProcess(sample.proc)
    if (!this.state.learned[id]) {
      this.state.learned[id] = sample.desc || sample.title.split(/[-—|]/)[0]!.trim() || sample.proc
      this.save()
    }
    return id
  }

  private startSession(gameId: string, name: string, sample: ForegroundSample, now: number): GameEvent {
    this.state.session = {
      gameId, name, title: sample.title, startedAt: now, lastSeenAt: now, minutes: 0, longReported: 0,
    }
    this.save()
    return { kind: 'start', gameId, name, title: sample.title, at: now }
  }

  private endSession(s: GameSession, kind: 'stop' | 'switch'): GameEvent {
    this.state.session = null
    this.state.awaySince = null
    this.save()
    return {
      kind, gameId: s.gameId, name: s.name,
      sessionMinutes: Math.round(s.minutes), title: s.title, at: this.now(),
    }
  }

  private pushEvent(e: GameEvent): void {
    this.state.events.push(e)
    const keep = this.opts.cfg.eventKeep
    if (this.state.events.length > keep) this.state.events = this.state.events.slice(-keep)
    this.save()
  }

  private sameDay(at: number, now: number): boolean {
    return new Date(at).toDateString() === new Date(now).toDateString()
  }
}
