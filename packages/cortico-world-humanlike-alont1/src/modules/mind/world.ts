/**
 * Mind World 的持久化排期与定时回顾。
 * 调度通知使用 internal；记录字段和历史事件材料使用 external。
 * World 不读取 Persona Memory；条目只提醒一次，推送共用间隔与每日配额。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BlobInput, EventEnvelope, Logger, ToolDef, World, WorldWebUiDecl, WorldHost } from 'cortico/core/types.ts'
import type { Language } from 'cortico/core/language.ts'
import { nowIso } from 'cortico/core/util.ts'
import { MIND_CONFIG_GROUP, MIND_DEFAULTS, type MindConfigSection } from './config.ts'

/** 环境提示词模板。role=envPrompt 的声明缺了就不进系统前缀，所以必须在 console() 里报出来。 */
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url))

export interface MindItem {
  id: string
  /** 她自己写的那句"我想做什么"——提醒时逐字用它 */
  text: string
  /** 她写的"为什么"：没有理由的事不值得排期 */
  why: string
  /** 可选：这件事是关于谁、或要发给谁（她自己填），原样回给她 */
  about?: string
  /** 到点时刻（ISO）；不填 = 只挂着，不提醒 */
  dueAt?: string
  createdAt: string
  /** 提醒过几次（设计上最多 1） */
  pushedCount: number
  lastPushedAt?: string
  doneAt?: string
  outcome?: string
  droppedAt?: string
}

export interface MindData {
  version: 1
  items: MindItem[]
  /** 了结的（做完/放下/过期），只留最近若干条给她自己查 */
  recent: MindItem[]
  /** 当天提醒了几次 + 那天是哪天 */
  day: string
  pushesToday: number
  lastPushAt: number
  /** 今天已经给过几段「自己的时间」+ 上一段的时刻 */
  freeToday: number
  lastFreeAt: number
  /** 上一次"今日回顾"是哪天（避免同一天推两次） */
  lastDigestDay: string
}

const RECENT_CAP = 30
const TEXT_MAX = 200
const WHY_MAX = 200
const ABOUT_MAX = 40
/** 素材片段的总字数上限：材料是给她起个话头的，不是让她读全日志。 */
const MATERIAL_MAX = 2200

function freshData(): MindData {
  return {
    version: 1, items: [], recent: [], day: '', pushesToday: 0, lastPushAt: 0,
    freeToday: 0, lastFreeAt: 0, lastDigestDay: '',
  }
}

interface Material {
  text: string
  meta: Record<string, unknown>
  blobs?: BlobInput[]
}

export class MindWorld implements World {
  readonly id = 'mind'
  private readonly cfg: MindConfigSection
  private readonly timezone: string
  private readonly file: string
  private host: WorldHost | null = null
  private log: Logger = console as unknown as Logger
  private data: MindData = freshData()
  private timer: ReturnType<typeof setInterval> | null = null
  private dirty = false
  private nextId = 1
  private startedAt = 0
  private ticking = false
  private pendingTick: Promise<void> = Promise.resolve()

  constructor(opts: { cfg: MindConfigSection; dataDir: string; timezone: string }) {
    this.cfg = opts.cfg
    this.timezone = opts.timezone
    this.file = join(opts.dataDir, 'mind.json')
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  async start(host: WorldHost): Promise<void> {
    this.host = host
    this.log = host.log.child('mind')
    this.startedAt = Date.now()
    this.load()
    this.arm()
    void this.tick()
    this.log.info('惦记 World 已启动', {
      pending: this.pending().length,
      tickSec: this.cfg.tickSec,
    })
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.host = null
    await this.pendingTick
    this.flush()
  }

  private arm(): void {
    if (this.timer) clearInterval(this.timer)
    const every = Math.max(10, this.cfg.tickSec) * 1000
    this.timer = setInterval(() => { void this.tick() }, every)
    // 别让这个定时器把进程吊住：她那边该退就退。
    this.timer.unref?.()
  }

  // ── 状态 ────────────────────────────────────────────────────────────────

  private pending(): MindItem[] {
    return this.data.items
  }

  private today(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.timezone }).format(new Date())
  }

  private clock(at: Date = new Date()): string {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: this.timezone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(at)
  }

  private inQuietHours(d = new Date()): boolean {
    if (this.cfg.quietFrom === this.cfg.quietTo) return false
    const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: this.timezone, hour: 'numeric', hour12: false }).format(d)) % 24
    return this.cfg.quietFrom > this.cfg.quietTo
      ? (h >= this.cfg.quietFrom || h < this.cfg.quietTo)
      : (h >= this.cfg.quietFrom && h < this.cfg.quietTo)
  }

  /**
   * 到点就把她自己的原话还给她。
   *
   * 每个条目只提醒一次：提醒过就算说了。反复冒出来不叫"惦记"，叫唠叨，
   * 而且会把她自己的判断挤掉——她要么去做，要么 `humanlike_mind_drop`，两条路都在她手上。
   */
  private tick(): Promise<void> {
    if (this.ticking) return this.pendingTick
    this.ticking = true
    this.pendingTick = this.runTick().finally(() => { this.ticking = false })
    return this.pendingTick
  }

  private async runTick(): Promise<void> {
    try {
      const now = Date.now()
      const day = this.today()
      if (this.data.day !== day) {
        this.data.day = day
        this.data.pushesToday = 0
        this.data.freeToday = 0
        this.dirty = true
      }
      // 过期清理：提醒过、她一直没理的，到了时限就了结掉
      const expireMs = Math.max(1, this.cfg.expireAfterH) * 3600_000
      for (const item of [...this.data.items]) {
        if (!item.pushedCount || !item.lastPushedAt) continue
        if (now - Date.parse(item.lastPushedAt) < expireMs) continue
        this.retire(item, { droppedAt: nowIso(this.timezone) })
        this.log.info('惦记的事过期清掉', { id: item.id })
      }

      if (!this.host) return
      // 上游的 WorldHost 没有 isPaused（那是本地框架新增的）：有就用，没有就当没暂停。
      if ((this.host as unknown as { isPaused?: () => boolean }).isPaused?.() === true) return
      if (this.inQuietHours()) return
      if (this.cfg.dailyPushes > 0 && this.data.pushesToday >= this.cfg.dailyPushes) return
      // 所有推送共用一道全局间隔：惦记提醒、自己的时间、今日回顾不会挤在一起砸下来
      if (this.cfg.pushGapSec > 0 && now - this.data.lastPushAt < this.cfg.pushGapSec * 1000) return
      // 刚起来的 30 秒内不提醒：那是重启，不是"想起来了"
      if (now - this.startedAt < 30_000) return

      // ① 到点的一件惦记
      const due = this.data.items.find((i) => !i.pushedCount && i.dueAt && Date.parse(i.dueAt) <= now)
      if (due) {
        due.pushedCount = 1
        due.lastPushedAt = nowIso(this.timezone)
        this.notePush()
        this.flush()
        await this.push('mind.due',
          '一件记录已到提醒时间，条目内容随外部材料提供。做不做由你决定；'
          + '材料中已附条目编号，可直接用 humanlike_mind_done 记录结果，或用 humanlike_mind_drop 放下，无需先调 humanlike_mind_list。',
          { mindId: due.id, dueAt: due.dueAt }, [this.itemMaterial([due], 'due')])
        this.log.info('提醒了一件她自己记下的', { id: due.id, text: due.text.slice(0, 30) })
        return
      }

      // ② 今日回顾：一天一次，到点把今天真的材料放到她眼前
      if (this.digestDue(now, day)) {
        this.data.lastDigestDay = day
        this.notePush()
        this.flush()
        await this.push('mind.digest', this.digestText(day), { day }, await this.digestMaterials(day))
        this.log.info('推了今日回顾', { day })
        return
      }

      // ③ 自己的时间：不带任何目标，明确允许她什么都不做
      if (await this.freeTimeDue(now)) {
        this.data.freeToday += 1
        this.data.lastFreeAt = now
        this.notePush()
        this.flush()
        await this.push('mind.freetime', this.freeTimeText(), {})
        this.log.info('给了一段自己的时间', { freeToday: this.data.freeToday })
        return
      }

      if (this.dirty) this.flush()
    } catch (e) {
      this.log.warn('惦记 tick 异常', { err: String(e) })
    }
  }

  /** 每次推送都要记的账（全局间隔 + 当天次数）。 */
  private notePush(): void {
    this.data.lastPushAt = Date.now()
    this.data.pushesToday += 1
    this.dirty = true
  }

  private async push(type: string, text: string, meta: Record<string, unknown>, materials: Material[] = []): Promise<void> {
    const host = this.host
    if (!host) return
    for (const material of materials) {
      if (this.host !== host) return
      await host.pushEvent({
        type: `${this.id}.material`, ts: nowIso(this.timezone), source: this.id,
        origin: 'external', text: material.text, senderKey: this.id,
        meta: { reason: type, ...material.meta }, ...(material.blobs?.length ? { blobs: material.blobs } : {}),
      }, { trigger: 'piggyback' })
    }
    if (this.host !== host) return
    await host.pushEvent({
      type, ts: nowIso(this.timezone), source: this.id, origin: 'internal', text,
      senderKey: this.id, meta,
    }, { trigger: 'flush' })
  }

  private async freeTimeDue(now: number): Promise<boolean> {
    if (this.cfg.freeTimePerDay <= 0) return false
    if (this.data.freeToday >= this.cfg.freeTimePerDay) return false
    const gapMs = Math.max(30, this.cfg.freeTimeGapMin) * 60_000
    if (now - this.data.lastFreeAt < gapMs) return false
    try {
      const events = await this.host!.store.range({
        origin: 'external', fromTs: nowIso(this.timezone, new Date(now - gapMs)), limit: 400,
      })
      return !events.some((event) => event.origin === 'external' && event.source !== this.id
        && !event.meta?.materialKind && Date.parse(event.ts) >= now - gapMs)
    } catch (error) {
      this.log.warn('空闲时段的事件查询失败', { err: String(error) })
      return false
    }
  }

  private digestDue(now: number, day: string): boolean {
    const at = String(this.cfg.digestAt ?? '').trim()
    if (!/^\d{1,2}:\d{2}$/.test(at)) return false
    if (this.data.lastDigestDay === day) return false
    const [hh, mm] = at.split(':').map(Number)
    if (hh > 23 || mm > 59) return false
    const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: this.timezone, hour: 'numeric', hour12: false }).format(new Date(now))) % 24
    const m = Number(new Intl.DateTimeFormat('en-US', { timeZone: this.timezone, minute: 'numeric' }).format(new Date(now)))
    return h > hh || (h === hh && m >= mm)
  }

  private freeTimeText(): string {
    return '现在有一段自己的时间。想做什么由你决定，也可以什么都不做，直接结束本轮。'
  }

  private digestText(day: string): string {
    const done = this.data.recent.filter((item) => (item.doneAt ?? '').startsWith(day) || (item.droppedAt ?? '').startsWith(day))
    return `现在是 ${this.clock()}。每日回顾时间已到。`
      + `当前记着 ${this.pending().length} 件，今天了结 ${done.length} 件。`
      + '是否回顾、记录什么由你决定，也可以直接结束本轮。'
  }

  private itemMaterial(items: MindItem[], section: string): Material {
    return {
      text: JSON.stringify({ section, items }, null, 2),
      meta: { materialKind: 'item', file: this.file, section },
    }
  }

  private async digestMaterials(day: string): Promise<Material[]> {
    const done = this.data.recent.filter((item) => (item.doneAt ?? '').startsWith(day) || (item.droppedAt ?? '').startsWith(day))
    return [
      ...(this.pending().length ? [this.itemMaterial(this.pending(), 'pending')] : []),
      ...(done.length ? [this.itemMaterial(done, 'completed')] : []),
      ...await this.eventMaterials(day),
    ]
  }

  private async eventMaterials(day?: string): Promise<Material[]> {
    try {
      const events = await this.host!.store.range({ origin: 'external', limit: 400 })
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: this.timezone })
      const selected = events.filter((event: EventEnvelope) => {
        if (event.origin !== 'external' || event.source === this.id || event.meta?.materialKind) return false
        if (!event.text && !event.blobs?.length) return false
        const at = new Date(event.ts)
        return !day || (Number.isFinite(at.getTime()) && date.format(at) === day)
      }).slice(-Math.max(4, this.cfg.digestEvents))
      let remaining = MATERIAL_MAX
      const materials: Material[] = []
      for (const event of selected.reverse()) {
        if (remaining <= 0) break
        const text = event.text.slice(-remaining)
        remaining -= text.length
        const sourceEvent = {
          cursor: event.cursor, run: event.run, source: event.source, type: event.type,
          senderKey: event.senderKey, ts: event.ts,
        }
        const truncated = text.length < event.text.length
        materials.unshift({
          text: JSON.stringify({ sourceEvent, text, truncated }, null, 2),
          meta: { materialKind: 'event', sourceEvent, truncated },
          ...(event.blobs?.length ? { blobs: event.blobs.map((blob) => ({ handle: blob.handle, fallbackText: blob.fallbackText })) } : {}),
        })
      }
      return materials
    } catch (error) {
      this.log.warn('回顾素材查询失败', { err: String(error) })
      return []
    }
  }

  private retire(item: MindItem, patch: Partial<MindItem>): void {
    Object.assign(item, patch)
    this.data.items = this.data.items.filter((i) => i.id !== item.id)
    this.data.recent = [item, ...this.data.recent].slice(0, RECENT_CAP)
    this.dirty = true
  }

  // ── 契约 ────────────────────────────────────────────────────────────────

  envPromptVars(): Record<string, string> {
    const pending = this.pending()
    const due = pending.filter((item) => item.dueAt && Date.parse(item.dueAt) <= Date.now()).length
    return { 'mind.pending': pending.length ? `记着 ${pending.length} 件，其中 ${due} 件已到点。用 humanlike_mind_list 查看条目内容。` : '' }
  }

  tools(): ToolDef[] {
    return [this.wantTool(), this.listTool(), this.doneTool(), this.dropTool()]
  }

  private wantTool(): ToolDef {
    return {
      name: 'humanlike_mind_want',
      description:
        '**给你自己记一件事**：你想做什么、为什么、大概什么时候做。到点我会把你写下的原话还给你一次，'
        + '做不做那一刻由你决定。要说的话、要发的消息都还是走你当前渠道已提供的发送工具，'
        + '这里只管"记住我想做这件事"。\n'
        + '**别拿它排满日程**——攒上好几件就变成待办清单了，那不是我。真的心里挂着才记。',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', maxLength: TEXT_MAX, description: `一句话：你想做什么（上限 ${TEXT_MAX} 字）。` },
          why: { type: 'string', maxLength: WHY_MAX, description: `为什么想做——没有理由的事不值得记（上限 ${WHY_MAX} 字）。` },
          about: { type: 'string', maxLength: ABOUT_MAX, description: '可选：这事关于谁，或者要发给谁（如「主人」）。到点会原样提醒你。' },
          afterMinutes: { type: 'integer', minimum: 1, maximum: 20160, description: '多少分钟之后提醒我（1 分钟 ~ 14 天）。' },
          atTime: { type: 'string', description: '或者直接给钟点，形如 "21:30"；已经过了就是明天这个点。' },
        },
        required: ['text', 'why'],
      },
      handler: async (args) => {
        const text = String(args.text ?? '').trim()
        const why = String(args.why ?? '').trim()
        if (!text) return 'text 不能为空——要记的是你想做的那件事。'
        if (!why) return 'why 不能为空——没有理由的事不值得占一个位置。'
        const pending = this.pending()
        if (pending.length >= Math.max(1, this.cfg.maxPending)) {
          return `已经惦记着 ${pending.length} 件了（上限 ${this.cfg.maxPending}）。`
            + `先 humanlike_mind_done 或 humanlike_mind_drop 掉一件，或者干脆别记——手上这些做完了再说。\n`
            + pending.map((i) => `- [${i.id}] ${i.text}`).join('\n')
        }
        const id = `m${this.nextId++}`
        let dueAt: string | undefined
        const afterMinutes = Number(args.afterMinutes)
        const atTime = String(args.atTime ?? '').trim()
        if (Number.isFinite(afterMinutes) && afterMinutes > 0) {
          dueAt = nowIso(this.timezone, new Date(Date.now() + Math.min(afterMinutes, 20160) * 60_000))
        } else if (/^\d{1,2}:\d{2}$/.test(atTime)) {
          const [hh, mm] = atTime.split(':').map(Number)
          if (hh <= 23 && mm <= 59) {
            const target = new Date()
            target.setHours(hh, mm, 0, 0)
            if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1)
            dueAt = nowIso(this.timezone, target)
          }
        }
        const item: MindItem = {
          id,
          text: text.slice(0, TEXT_MAX),
          why: why.slice(0, WHY_MAX),
          ...(String(args.about ?? '').trim() ? { about: String(args.about).trim().slice(0, ABOUT_MAX) } : {}),
          ...(dueAt ? { dueAt } : {}),
          createdAt: nowIso(this.timezone),
          pushedCount: 0,
        }
        this.data.items.push(item)
        this.dirty = true
        this.flush()
        return dueAt
          ? `记下了 [${id}]：${item.text}\n到点（${this.clock(new Date(Date.parse(dueAt))) }）我会把你这句话还给你一次，做不做那时候再说。`
          : `记下了 [${id}]：${item.text}\n没定时间——它只挂在 humanlike_mind_list 里，你想起来的时候自己看。`
      },
    }
  }

  private listTool(): ToolDef {
    return {
      name: 'humanlike_mind_list',
      tags: ['read'],
      description: '看你手上还惦记着什么（含到点时间），以及最近了结掉的几件（做完的、放掉的、过期的）。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => {
        const now = Date.now()
        const pending = this.pending()
        const head = pending.length
          ? pending.map((i) => {
              const when = i.dueAt
                ? Date.parse(i.dueAt) <= now ? '**已到点**' : `到点 ${this.clock(new Date(Date.parse(i.dueAt)))}`
                : '没定时间'
              return `- [${i.id}] ${i.text}${i.about ? `（关于 ${i.about}）` : ''}　${when}　（因为：${i.why}）`
            }).join('\n')
          : '（手上没有惦记的事——这很正常。）'
        const recent = this.data.recent.slice(0, 8).map((i) => {
          const how = i.doneAt ? `做完了${i.outcome ? `：${i.outcome}` : ''}` : i.droppedAt ? '放下了' : '过期了'
          return `- [${i.id}] ${i.text}　→ ${how}`
        }).join('\n')
        return `还惦记着的（${pending.length}/${this.cfg.maxPending}）：\n${head}`
          + (recent ? `\n\n最近了结的：\n${recent}` : '')
      },
    }
  }

  private doneTool(): ToolDef {
    return {
      name: 'humanlike_mind_done',
      tags: ['write'],
      description: '把惦记的一件标记成做完了，可以顺手写一句结果（那句话会留在你自己的账里）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '条目编号，如 m1（humanlike_mind_list 里的那个）。' },
          outcome: { type: 'string', maxLength: TEXT_MAX, description: '可选：后来怎么了。' },
        },
        required: ['id'],
      },
      handler: async (args) => {
        const item = this.find(String(args.id ?? ''))
        if (!item) return `没有编号 ${String(args.id ?? '')} 这一条（用 humanlike_mind_list 看编号）。`
        const outcome = String(args.outcome ?? '').trim()
        this.retire(item, { doneAt: nowIso(this.timezone), ...(outcome ? { outcome: outcome.slice(0, TEXT_MAX) } : {}) })
        this.flush()
        return `了了 [${item.id}]：${item.text}${outcome ? `\n（记了一句：${outcome}）` : ''}`
      },
    }
  }

  private dropTool(): ToolDef {
    return {
      name: 'humanlike_mind_drop',
      tags: ['write'],
      description: '把惦记的一件放掉（不想做了、或者那件事已经不成立了）。放下也是回答，别让它在账上反复出现。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', description: '条目编号。' } },
        required: ['id'],
      },
      handler: async (args) => {
        const item = this.find(String(args.id ?? ''))
        if (!item) return `没有编号 ${String(args.id ?? '')} 这一条（用 humanlike_mind_list 看编号）。`
        this.retire(item, { droppedAt: nowIso(this.timezone) })
        this.flush()
        return `放下了 [${item.id}]：${item.text}`
      },
    }
  }

  private find(id: string): MindItem | undefined {
    const key = id.trim().replace(/^\[|\]$/g, '')
    return this.data.items.find((i) => i.id === key)
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const now = Date.now()
    const pending = this.pending()
    const due = pending.filter((i) => i.dueAt && Date.parse(i.dueAt) <= now).length
    return {
      lamps: [
        {
          label: '惦记',
          state: this.host ? 'online' : 'offline',
          hint: pending.length ? `挂着 ${pending.length} 件（到点未提醒 ${due}）` : '没有惦记的事',
        },
      ],
      config: [MIND_CONFIG_GROUP],
      // role=envPrompt 的声明缺了，这段就不进她的系统前缀——她也就不知道自己有这个口子。
      promptDocs: [
        {
          key: 'worlds.mind.envPrompt',
          title: '惦记 · 环境提示词',
          description: '告诉她这是她自己的账、四个工具怎么用、以及到点只提醒一次。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [{ name: 'mind.pending', description: '记着的条目数与到点数；没有条目时为空串。' }],
        },
      ],
    }
  }

  // ── 落盘 ────────────────────────────────────────────────────────────────

  private load(): void {
    this.data = freshData()
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<MindData>
      const items = Array.isArray(raw.items) ? raw.items.filter((i) => i && typeof i.text === 'string') : []
      this.data = {
        version: 1,
        items: items.map((i) => ({ ...i, pushedCount: Number.isFinite(i.pushedCount) ? i.pushedCount : 0 })),
        recent: Array.isArray(raw.recent) ? raw.recent.slice(0, RECENT_CAP) : [],
        day: typeof raw.day === 'string' ? raw.day : '',
        pushesToday: Number.isFinite(raw.pushesToday) ? Number(raw.pushesToday) : 0,
        lastPushAt: Number.isFinite(raw.lastPushAt) ? Number(raw.lastPushAt) : 0,
        freeToday: Number.isFinite(raw.freeToday) ? Number(raw.freeToday) : 0,
        lastFreeAt: Number.isFinite(raw.lastFreeAt) ? Number(raw.lastFreeAt) : 0,
        lastDigestDay: typeof raw.lastDigestDay === 'string' ? raw.lastDigestDay : '',
      }
      // 编号接着最大的往下发，重启后不会撞号
      const maxId = [...this.data.items, ...this.data.recent]
        .map((i) => Number(String(i.id).replace(/^m/, '')))
        .filter((n) => Number.isFinite(n))
        .reduce((a, b) => Math.max(a, b), 0)
      this.nextId = maxId + 1
    } catch (e) {
      this.log.warn(`惦记账本读取失败，从空账开始: ${String(e)}`)
      this.data = freshData()
    }
  }

  private flush(): void {
    this.dirty = false
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8')
      renameSync(tmp, this.file)
    } catch (e) {
      this.log.warn(`惦记账本落盘失败: ${String(e)}`)
    }
  }
}

export { MIND_DEFAULTS }

/** 全部工具的声明;自描述要列出 tools() 能返回的每一个。 */
export const MIND_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'humanlike_mind_want',
    description:
      '**给你自己记一件事**：你想做什么、为什么、大概什么时候做。到点我会把你写下的原话还给你一次，'
      + '做不做那一刻由你决定。要说的话、要发的消息都还是走你当前渠道已提供的发送工具，'
      + '这里只管"记住我想做这件事"。\n'
      + '**别拿它排满日程**——攒上好几件就变成待办清单了，那不是我。真的心里挂着才记。',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', maxLength: TEXT_MAX, description: `一句话：你想做什么（上限 ${TEXT_MAX} 字）。` },
        why: { type: 'string', maxLength: WHY_MAX, description: `为什么想做——没有理由的事不值得记（上限 ${WHY_MAX} 字）。` },
        about: { type: 'string', maxLength: ABOUT_MAX, description: '可选：这事关于谁，或者要发给谁（如「主人」）。到点会原样提醒你。' },
        afterMinutes: { type: 'integer', minimum: 1, maximum: 20160, description: '多少分钟之后提醒我（1 分钟 ~ 14 天）。' },
        atTime: { type: 'string', description: '或者直接给钟点，形如 "21:30"；已经过了就是明天这个点。' },
      },
      required: ['text', 'why'],
    },
  },
  {
    name: 'humanlike_mind_list',
    tags: ['read'],
    description: '看你手上还惦记着什么（含到点时间），以及最近了结掉的几件（做完的、放掉的、过期的）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'humanlike_mind_done',
    tags: ['write'],
    description: '把惦记的一件标记成做完了，可以顺手写一句结果（那句话会留在你自己的账里）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '条目编号，如 m1（humanlike_mind_list 里的那个）。' },
        outcome: { type: 'string', maxLength: TEXT_MAX, description: '可选：后来怎么了。' },
      },
      required: ['id'],
    },
  },
  {
    name: 'humanlike_mind_drop',
    tags: ['write'],
    description: '把惦记的一件放掉（不想做了、或者那件事已经不成立了）。放下也是回答，别让它在账上反复出现。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string', description: '条目编号。' } },
      required: ['id'],
    },
  },
];
