/**
 * Alive World 的持久化排期与定时回顾。
 * 调度通知使用 internal；记录字段和历史事件材料使用 external。
 * World 不读取 Persona Memory；条目只提醒一次，推送共用间隔与每日配额。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { BlobInput, EventEnvelope, Logger, ToolDef, World, WorldWebUiDecl, WorldHost } from 'cortico/core/types.ts'
import type { Language } from 'cortico/core/language.ts'
import { nowIso } from 'cortico/core/util.ts'
import { ALIVE_CONFIG_GROUP, ALIVE_DEFAULTS, type AliveConfigSection } from './config.ts'

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url))

/** 记着的一件事。 */
export interface AliveItem {
  id: string
  /** 它自己写的那句"我想做什么"——推送时逐字用它 */
  text: string
  /** 它写的"为什么" */
  why: string
  /** 可选：这事关于谁 / 要发给谁，原样回给它 */
  about?: string
  /** 到点时刻（ISO）；不填 = 只记着，不提醒 */
  dueAt?: string
  createdAt: string
  pushedCount: number
  lastPushedAt?: string
  doneAt?: string
  outcome?: string
  droppedAt?: string
}

export interface AliveData {
  version: 1
  items: AliveItem[]
  recent: AliveItem[]
  day: string
  pushesToday: number
  lastPushAt: number
  freeToday: number
  lastFreeAt: number
  lastDigestDay: string
}

interface DeskReading {
  process: string
  title: string
}

const RECENT_CAP = 30
const TEXT_MAX = 200
const WHY_MAX = 200
const ABOUT_MAX = 40
/** 素材片段总字数上限：材料是起话头用的，不是让它读全日志。 */
const MATERIAL_MAX = 2200

function freshData(): AliveData {
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

export class AliveWorld implements World {
  readonly id = 'alive'
  private readonly cfg: AliveConfigSection
  private readonly timezone: string
  private readonly file: string
  private host: WorldHost | null = null
  private log: Logger = console as unknown as Logger
  private data: AliveData = freshData()
  private timer: ReturnType<typeof setInterval> | null = null
  private dirty = false
  private nextId = 1
  private startedAt = 0
  private ticking = false
  private pendingTick: Promise<void> = Promise.resolve()
  private lastDesk: DeskReading | null = null
  private deskAt = 0

  constructor(opts: { cfg: AliveConfigSection; dataDir: string; timezone: string }) {
    this.cfg = opts.cfg
    this.timezone = opts.timezone
    this.file = join(opts.dataDir, 'alive.json')
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  async start(host: WorldHost): Promise<void> {
    this.host = host
    this.log = host.log.child('alive')
    this.startedAt = Date.now()
    this.load()
    this.arm()
    void this.tick()
    this.log.info('能动性 World 已启动', {
      pending: this.items().length,
      tickSec: this.cfg.tickSec,
      freeTimePerDay: this.cfg.freeTimePerDay,
      digestAt: this.cfg.digestAt || '（不推）',
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
    this.timer = setInterval(() => { void this.tick() }, Math.max(10, this.cfg.tickSec) * 1000)
    this.timer.unref?.()
  }

  // ── 小工具 ──────────────────────────────────────────────────────────────

  private items(): AliveItem[] {
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

  private hour(d = new Date()): number {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: this.timezone, hour: 'numeric', hour12: false }).format(d)) % 24
  }

  private minute(d = new Date()): number {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: this.timezone, minute: 'numeric' }).format(d))
  }

  private inQuietHours(d = new Date()): boolean {
    if (this.cfg.quietFrom === this.cfg.quietTo) return false
    const h = this.hour(d)
    return this.cfg.quietFrom > this.cfg.quietTo
      ? (h >= this.cfg.quietFrom || h < this.cfg.quietTo)
      : (h >= this.cfg.quietFrom && h < this.cfg.quietTo)
  }

  // ── 节拍 ────────────────────────────────────────────────────────────────

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
      // 过期清理：提醒过、一直没理的，到了时限就了结（没做也是一种回答）
      const expireMs = Math.max(1, this.cfg.expireAfterH) * 3600_000
      for (const item of [...this.data.items]) {
        if (!item.pushedCount || !item.lastPushedAt) continue
        if (now - Date.parse(item.lastPushedAt) < expireMs) continue
        this.retire(item, { droppedAt: nowIso(this.timezone) })
        this.log.info('记着的事过期清掉', { id: item.id })
      }

      if (!this.host) return
      // 运维暂停时不做这些：`isPaused` 是较新的宿主成员，老框架没有，所以防御式问一句。
      if ((this.host as { isPaused?: () => boolean }).isPaused?.() === true) return
      if (this.inQuietHours()) return
      if (this.cfg.dailyPushes > 0 && this.data.pushesToday >= this.cfg.dailyPushes) return
      if (this.cfg.pushGapSec > 0 && now - this.data.lastPushAt < this.cfg.pushGapSec * 1000) return
      // 刚起来 30 秒内不推送：那是重启，不是"想起来了"
      if (now - this.startedAt < 30_000) return

      const due = this.data.items.find((i) => !i.pushedCount && i.dueAt && Date.parse(i.dueAt) <= now)
      if (due) {
        due.pushedCount = 1
        due.lastPushedAt = nowIso(this.timezone)
        this.notePush()
        this.flush()
        await this.push('alive.due',
          '一件记录已到提醒时间，条目内容随外部材料提供。做不做由你决定；'
          + '材料中已附条目编号；做完用 alive_done 记录结果，不想继续用 alive_drop 放下，无需先调 alive_list。',
          { itemId: due.id, dueAt: due.dueAt }, [this.itemMaterial([due], 'due')])
        this.log.info('提醒了一件它自己记下的', { id: due.id, text: due.text.slice(0, 30) })
        return
      }

      if (this.digestDue(day)) {
        this.data.lastDigestDay = day
        this.notePush()
        this.flush()
        await this.push('alive.digest', this.digestText(day), { day }, await this.digestMaterials(day))
        this.log.info('推了每日回顾', { day })
        return
      }

      if (await this.freeTimeDue(now)) {
        this.data.freeToday += 1
        this.data.lastFreeAt = now
        this.notePush()
        this.flush()
        await this.push('alive.freetime', this.freeTimeText(), {})
        this.log.info('给了一段自己的时间', { freeToday: this.data.freeToday })
        return
      }

      if (this.dirty) this.flush()
    } catch (e) {
      this.log.warn('节拍异常', { err: String(e) })
    }
  }

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

  private digestDue(day: string): boolean {
    const at = String(this.cfg.digestAt ?? '').trim()
    if (!/^\d{1,2}:\d{2}$/.test(at)) return false
    if (this.data.lastDigestDay === day) return false
    const [hh, mm] = at.split(':').map(Number)
    if (hh > 23 || mm > 59) return false
    const h = this.hour()
    const m = this.minute()
    return h > hh || (h === hh && m >= mm)
  }

  private freeTimeText(): string {
    return '现在有一段自己的时间。想做什么由你决定，也可以什么都不做，直接结束本轮。'
  }

  private digestText(day: string): string {
    const done = this.data.recent.filter((item) => (item.doneAt ?? '').startsWith(day) || (item.droppedAt ?? '').startsWith(day))
    return `现在是 ${this.clock()}。每日回顾时间已到。`
      + `当前记着 ${this.items().length} 件，今天了结 ${done.length} 件。`
      + '是否回顾、记录什么由你决定，也可以直接结束本轮。'
  }

  private itemMaterial(items: AliveItem[], section: string): Material {
    return {
      text: JSON.stringify({ section, items }, null, 2),
      meta: { materialKind: 'item', file: this.file, section },
    }
  }

  private async digestMaterials(day: string): Promise<Material[]> {
    const done = this.data.recent.filter((item) => (item.doneAt ?? '').startsWith(day) || (item.droppedAt ?? '').startsWith(day))
    return [
      ...(this.items().length ? [this.itemMaterial(this.items(), 'pending')] : []),
      ...(done.length ? [this.itemMaterial(done, 'completed')] : []),
      ...await this.eventMaterials(undefined),
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

  private retire(item: AliveItem, patch: Partial<AliveItem>): void {
    Object.assign(item, patch)
    this.data.items = this.data.items.filter((i) => i.id !== item.id)
    this.data.recent = [item, ...this.data.recent].slice(0, RECENT_CAP)
    this.dirty = true
  }

  // ── 契约 ────────────────────────────────────────────────────────────────

  envPromptVars(): Record<string, string> {
    const pending = this.items()
    const due = pending.filter((item) => item.dueAt && Date.parse(item.dueAt) <= Date.now()).length
    return { 'alive.pending': pending.length ? `记着 ${pending.length} 件，其中 ${due} 件已到点。用 alive_list 查看条目内容。` : '' }
  }

  tools(): ToolDef[] {
    return [
      this.wantTool(), this.listTool(), this.doneTool(), this.dropTool(),
      this.deskTool(), this.costTool(), this.prefixTool(), this.configTool(),
    ]
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const now = Date.now()
    const items = this.items()
    const due = items.filter((i) => i.dueAt && Date.parse(i.dueAt) <= now).length
    return {
      lamps: [
        { label: '记着的事', state: items.length ? 'online' : 'offline', hint: items.length ? `${items.length} 件（到点未提醒 ${due}）` : '没有记着的事' },
        { label: '自己的时间', state: this.cfg.freeTimePerDay > 0 ? 'online' : 'offline', hint: `今天 ${this.data.freeToday}/${this.cfg.freeTimePerDay} 段` },
        { label: '看得见', state: 'online', hint: this.lastDesk ? `上次看到：${this.lastDesk.process}` : '只读工具就绪' },
      ],
      config: [ALIVE_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.alive.envPrompt',
          title: '能动性 · 环境提示词',
          description: '说明它自己记着的事、自己的时间、每日回顾，以及四个只读的"看得见"工具。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [{ name: 'alive.pending', description: '记着的条目数与到点数；没有条目时为空串。' }],
        },
      ],
    }
  }

  // ── ① 它自己的事：四个工具 ──────────────────────────────────────────────

  private wantTool(): ToolDef {
    return {
      name: 'alive_want',
      tags: ['write'],
      description:
        '**给你自己记一件事**：你想做什么、为什么、大概什么时候做。到点我会把你写下的原话还给你一次，'
        + '做不做那一刻由你决定。要说的话、要发的消息都还是走你自己的工具，这里只管"记住我想做这件事"。\n'
        + '**别拿它排满日程**——攒上好几件就变成待办清单了。真的心里挂着才记。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', maxLength: TEXT_MAX, description: `一句话：你想做什么（上限 ${TEXT_MAX} 字）。` },
          why: { type: 'string', maxLength: WHY_MAX, description: `为什么想做——没有理由的事不值得记（上限 ${WHY_MAX} 字）。` },
          about: { type: 'string', maxLength: ABOUT_MAX, description: '可选：这事关于谁、或者要发给谁。到点会原样提醒你。' },
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
        const items = this.items()
        if (items.length >= Math.max(1, this.cfg.maxPending)) {
          return `已经记着 ${items.length} 件了（上限 ${this.cfg.maxPending}）。`
            + `先 alive_done 或 alive_drop 掉一件，或者干脆别记——手上这些做完了再说。\n`
            + items.map((i) => `- [${i.id}] ${i.text}`).join('\n')
        }
        const id = `a${this.nextId++}`
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
        const item: AliveItem = {
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
          ? `记下了 [${id}]：${item.text}\n到点（${this.clock(new Date(Date.parse(dueAt)))}）我会把你这句话还给你一次，做不做那时候再说。`
          : `记下了 [${id}]：${item.text}\n没定时间——它只挂在 alive_list 里，你想起来的时候自己看。`
      },
    }
  }

  private listTool(): ToolDef {
    return {
      name: 'alive_list',
      tags: ['read'],
      description: '看你手上还记着什么（含到点时间），以及最近了结掉的几件（做完的、放掉的、过期的）。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => {
        const now = Date.now()
        const items = this.items()
        const head = items.length
          ? items.map((i) => {
              const when = i.dueAt
                ? Date.parse(i.dueAt) <= now ? '**已到点**' : `到点 ${this.clock(new Date(Date.parse(i.dueAt)))}`
                : '没定时间'
              return `- [${i.id}] ${i.text}${i.about ? `（关于 ${i.about}）` : ''}　${when}　（因为：${i.why}）`
            }).join('\n')
          : '（手上没有记着的事——这很正常。）'
        const recent = this.data.recent.slice(0, 8).map((i) => {
          const how = i.doneAt ? `做完了${i.outcome ? `：${i.outcome}` : ''}` : i.droppedAt ? '放下了' : '过期了'
          return `- [${i.id}] ${i.text}　→ ${how}`
        }).join('\n')
        return `还记着的（${items.length}/${this.cfg.maxPending}）：\n${head}` + (recent ? `\n\n最近了结的：\n${recent}` : '')
      },
    }
  }

  private doneTool(): ToolDef {
    return {
      name: 'alive_done',
      tags: ['write'],
      description: '把记着的一件标记成做完了，可以顺手写一句结果。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '条目编号，如 a1（alive_list 里的那个）。' },
          outcome: { type: 'string', maxLength: TEXT_MAX, description: '可选：后来怎么了。' },
        },
        required: ['id'],
      },
      handler: async (args) => {
        const item = this.find(String(args.id ?? ''))
        if (!item) return `没有编号 ${String(args.id ?? '')} 这一条（用 alive_list 看编号）。`
        const outcome = String(args.outcome ?? '').trim()
        this.retire(item, { doneAt: nowIso(this.timezone), ...(outcome ? { outcome: outcome.slice(0, TEXT_MAX) } : {}) })
        this.flush()
        return `了了 [${item.id}]：${item.text}${outcome ? `\n（记了一句：${outcome}）` : ''}`
      },
    }
  }

  private dropTool(): ToolDef {
    return {
      name: 'alive_drop',
      tags: ['write'],
      description: '把记着的一件放掉（不想做了、或者那件事已经不成立了）。放下也是回答。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', description: '条目编号。' } },
        required: ['id'],
      },
      handler: async (args) => {
        const item = this.find(String(args.id ?? ''))
        if (!item) return `没有编号 ${String(args.id ?? '')} 这一条（用 alive_list 看编号）。`
        this.retire(item, { droppedAt: nowIso(this.timezone) })
        this.flush()
        return `放下了 [${item.id}]：${item.text}`
      },
    }
  }

  private find(id: string): AliveItem | undefined {
    const key = id.trim().replace(/^\[|\]$/g, '')
    return this.data.items.find((i) => i.id === key)
  }

  // ── ② 看得见的事：四个只读工具 ──────────────────────────────────────────

  private deskTool(): ToolDef {
    return {
      name: 'alive_desk',
      tags: ['read'],
      description:
        '看运维此刻在桌面上开着什么：前台窗口的标题和进程名。**看不到屏幕内容**（没有截图），'
        + '所以别描述画面，只说得出"在用某样东西干某事"。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => {
        const gap = Math.max(0, this.cfg.deskGapSec) * 1000
        if (this.lastDesk && Date.now() - this.deskAt < gap) {
          return `（刚看过，${Math.round((Date.now() - this.deskAt) / 1000)} 秒前）`
            + `前台是 ${this.lastDesk.process}：${this.lastDesk.title || '（没有标题）'}`
        }
        const r = await this.readForeground()
        if (!r) return '问不到：拿不到前台窗口（系统可能不支持，或当前在锁屏）。'
        this.lastDesk = r
        this.deskAt = Date.now()
        const filter = this.cfg.deskProcessFilter.trim()
        const hit = !filter || filter.split(/[,，\s]+/).filter(Boolean).some((k) => r.process.toLowerCase().includes(k.toLowerCase()))
        return `前台是 ${r.process}：${r.title || '（没有标题）'}`
          + (filter && !hit ? `\n（配置里写了"只关心 ${filter}"，这个不在里面——多半是后台杂项。）` : '')
      },
    }
  }

  /** 读前台窗口：Windows 上走 PowerShell 调 user32。只取进程名与标题，绝不截屏。 */
  private readForeground(): Promise<DeskReading | null> {
    if (process.platform !== 'win32') return Promise.resolve(null)
    const script = [
      // 先把输出编码钉成 UTF-8：PowerShell 默认按控制台代码页吐字节，中文标题会整条乱码。
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$OutputEncoding = [System.Text.Encoding]::UTF8',
      '$sig = @"',
      'using System; using System.Text; using System.Runtime.InteropServices;',
      'public class Fg {',
      '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
      '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
      '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
      '}',
      '"@',
      'Add-Type -TypeDefinition $sig -ErrorAction Stop',
      '$h = [Fg]::GetForegroundWindow()',
      'if ($h -eq [IntPtr]::Zero) { Write-Output "{}"; exit 0 }',
      '$sb = New-Object System.Text.StringBuilder 512',
      '[void][Fg]::GetWindowText($h, $sb, 512)',
      '$procId = 0',
      '[void][Fg]::GetWindowThreadProcessId($h, [ref]$procId)',
      '$p = Get-Process -Id $procId -ErrorAction SilentlyContinue',
      '$name = if ($p) { $p.ProcessName } else { "?" }',
      '@{ process = $name; title = $sb.ToString() } | ConvertTo-Json -Compress',
    ].join('\n')
    return new Promise((resolve) => {
      let proc: ReturnType<typeof spawn> | null = null
      try {
        proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        })
        const chunks: Buffer[] = []
        proc.stdout?.on('data', (d) => chunks.push(d as Buffer))
        proc.on('close', (code) => {
          if (code !== 0) return resolve(null)
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8').trim() || '{}') as { process?: string; title?: string }
            if (!parsed.process) return resolve(null)
            resolve({ process: parsed.process, title: parsed.title ?? '' })
          } catch {
            resolve(null)
          }
        })
        proc.on('error', () => resolve(null))
        setTimeout(() => {
          try {
            proc?.kill()
          } catch {
            /* ignore */
          }
          resolve(null)
        }, 15000)
      } catch {
        resolve(null)
      }
    })
  }

  private costTool(): ToolDef {
    return {
      name: 'alive_cost',
      tags: ['read'],
      description:
        '看花了多少钱（按配置里的价目表估算，高峰/空闲分时段）：默认今天，也可以给天数。'
        + '给的是估算——用量账本里只有 token 数，钱是照价目表算出来的。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { days: { type: 'integer', minimum: 1, maximum: 30, description: '看最近几天，默认 1（今天）。' } },
      },
      handler: async (args) => {
        const days = Math.max(1, Math.min(30, Number(args.days) || 1))
        const rows = this.readUsage(days)
        if (!rows.length) return `最近 ${days} 天账本里没有记录。`
        const table = this.priceTable()
        let total = 0
        const byModel = new Map<string, { yuan: number; turns: number; tokens: number }>()
        for (const r of rows) {
          const yuan = this.estimate(r, table)
          total += yuan
          const cur = byModel.get(r.model) ?? { yuan: 0, turns: 0, tokens: 0 }
          cur.yuan += yuan
          cur.turns += 1
          cur.tokens += r.input + r.output
          byModel.set(r.model, cur)
        }
        const lines = [...byModel.entries()].sort((a, b) => b[1].yuan - a[1].yuan)
          .map(([model, v]) => `- ${model}：约 ¥${v.yuan.toFixed(2)}（${v.turns} 次请求，${(v.tokens / 1000).toFixed(0)}k tokens）`)
        return `最近 ${days} 天：约 **¥${total.toFixed(2)}**（估算）\n${lines.join('\n')}`
          + `\n（价目表：${Object.keys(table).join('、')}；高峰时段按 2 倍算，其余时段半价。）`
      },
    }
  }

  private readUsage(days: number): Array<{ model: string; ts: string; input: number; cached: number; output: number }> {
    const file = join(this.dataDirOf(), 'usage.jsonl')
    if (!existsSync(file)) return []
    const from = Date.now() - days * 86400_000
    const out: Array<{ model: string; ts: string; input: number; cached: number; output: number }> = []
    try {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line) as { ts?: string; model?: string; promptTokens?: number; completionTokens?: number; cacheHitTokens?: number }
          if (!r.ts || Date.parse(r.ts) < from) continue
          out.push({
            model: String(r.model ?? '?'),
            ts: r.ts,
            input: Number(r.promptTokens ?? 0),
            cached: Number(r.cacheHitTokens ?? 0),
            output: Number(r.completionTokens ?? 0),
          })
        } catch {
          /* 坏行跳过：账本是外部输入 */
        }
      }
    } catch {
      return []
    }
    return out
  }

  private dataDirOf(): string {
    return dirname(this.file)
  }

  private priceTable(): Record<string, { hit?: number[]; miss?: number[]; out?: number[] }> {
    try {
      const parsed = JSON.parse(this.cfg.pricingJson) as Record<string, { hit?: number[]; miss?: number[]; out?: number[] }>
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      this.log.warn('价格表 JSON 读不出来，用内置那份')
    }
    return JSON.parse(ALIVE_DEFAULTS.pricingJson) as Record<string, { hit?: number[]; miss?: number[]; out?: number[] }>
  }

  /** 这一条请求大概花了多少元：高峰取 [0]、空闲取 [1]。 */
  private estimate(
    r: { model: string; ts: string; input: number; cached: number; output: number },
    table: Record<string, { hit?: number[]; miss?: number[]; out?: number[] }>,
  ): number {
    const price = table[r.model] ?? table['deepseek-flash'] ?? { hit: [0.04, 0.02], miss: [2, 1], out: [8, 4] }
    const idx = this.isPeak(new Date(Date.parse(r.ts))) ? 0 : 1
    const uncachedIn = Math.max(0, r.input - r.cached)
    const per = (arr: number[] | undefined, fallback: number): number => (Array.isArray(arr) && arr.length > idx ? arr[idx] : fallback)
    return (r.cached / 1e6) * per(price.hit, 0.04)
      + (uncachedIn / 1e6) * per(price.miss, 2)
      + (r.output / 1e6) * per(price.out, 8)
  }

  /** 高峰 = 工作日 9:00–12:00、14:00–18:00（按部署时区的钟点判断；法定节假日不另算）。 */
  private isPeak(d: Date): boolean {
    const fmt = (opts: Intl.DateTimeFormatOptions): string =>
      new Intl.DateTimeFormat('en-US', { timeZone: this.timezone, ...opts }).format(d)
    const weekday = fmt({ weekday: 'short' })
    if (weekday === 'Sat' || weekday === 'Sun') return false
    const h = Number(fmt({ hour: 'numeric', hour12: false })) % 24
    return (h >= 9 && h < 12) || (h >= 14 && h < 18)
  }

  private prefixTool(): ToolDef {
    return {
      name: 'alive_prefix',
      tags: ['read'],
      description:
        '看你眼前那份系统提示是怎么拼出来的：分几段、每段多长、开头几句是什么、来自哪个模板。'
        + '你在上下文里读得到正文，但看不出它是谁给的——这个工具就是给你看这个的。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => {
        const base = String(this.cfg.consoleUrl || 'http://127.0.0.1:7788').replace(/\/+$/, '')
        try {
          const res = await fetch(`${base}/api/prompts/prefix`, { signal: AbortSignal.timeout(8000) })
          if (!res.ok) return `从控制台取前缀失败（HTTP ${res.status}）。`
          const data = (await res.json()) as { segments?: Array<{ title?: string; text?: string; sourceKey?: string }> }
          const segs = data.segments ?? []
          if (!segs.length) return '控制台说当前没有可读的前缀分段。'
          const lines = segs.map((s, i) => {
            const head = String(s.text ?? '').replace(/\s+/g, ' ').slice(0, 100)
            return `${i + 1}. ${s.title ?? '(无标题)'}　${String(s.text ?? '').length} 字`
              + (s.sourceKey ? `　← ${s.sourceKey}` : '')
              + (head ? `\n     ${head}…` : '')
          })
          return `你的系统提示分 ${segs.length} 段（从上到下就是你在上下文里看到的顺序）：\n${lines.join('\n')}`
        } catch (e) {
          return `取前缀失败：${String(e)}`
        }
      },
    }
  }

  private configTool(): ToolDef {
    return {
      name: 'alive_config',
      tags: ['read'],
      description:
        '看哪些**配置**在约束你（只报跟你分寸有关的那几项：回合上限、作息、节流、闸门……）。'
        + '只读，你改不了；觉得哪条不对，就写进你自己的记忆，或者跟运维说。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => {
        const file = join(this.dataDirOf(), '..', 'config.json')
        try {
          if (!existsSync(file)) return '读不到部署配置。'
          const cfg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>
          const worlds = (cfg.worlds ?? {}) as Record<string, any>
          const pick = (path: string[], label: string): string | null => {
            let cur: any = cfg
            for (const k of path) {
              if (cur == null || typeof cur !== 'object') return null
              cur = cur[k]
            }
            if (cur === undefined || cur === null) return null
            const text = typeof cur === 'object' ? JSON.stringify(cur) : String(cur)
            return `- ${label}：${text.length > 200 ? `${text.slice(0, 200)}…` : text}`
          }
          const lines = [
            pick(['context', 'maxTokens'], '上下文窗口上限'),
            pick(['rounds', 'soft'], '一批软轮数'),
            pick(['rounds', 'hard'], '一批硬轮数'),
            pick(['worlds', 'alive', 'maxPending'], '最多记着几件事'),
            pick(['worlds', 'alive', 'pushGapSec'], '两次推送最小间隔（秒）'),
            pick(['worlds', 'alive', 'dailyPushes'], '一天最多推送几次'),
            pick(['worlds', 'alive', 'freeTimePerDay'], '一天几段自己的时间'),
            pick(['worlds', 'alive', 'digestAt'], '每日回顾钟点'),
          ].filter((x): x is string => !!x)
          const on = Object.entries(worlds).filter(([, v]) => v && (v as { enabled?: boolean }).enabled).map(([k]) => k)
          return `正在约束你的配置（只读）：\n${lines.join('\n')}\n\n装着并开着的 World：${on.join('、')}\n`
            + `\n（配置在部署目录里，只有运维能改。觉得哪条挡着你了，写进自己的记忆或者直接说。）`
        } catch (e) {
          return `读配置失败：${String(e)}`
        }
      },
    }
  }

  // ── 落盘 ────────────────────────────────────────────────────────────────

  private load(): void {
    this.data = freshData()
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AliveData>
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
      const maxId = [...this.data.items, ...this.data.recent]
        .map((i) => Number(String(i.id).replace(/^a/, '')))
        .filter((n) => Number.isFinite(n))
        .reduce((a, b) => Math.max(a, b), 0)
      this.nextId = maxId + 1
    } catch (e) {
      this.log.warn(`账本读取失败，从空账开始: ${String(e)}`)
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
      this.log.warn(`账本落盘失败: ${String(e)}`)
    }
  }
}

/** 全部工具的声明;自描述要列出 tools() 能返回的每一个。 */
export const ALIVE_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'alive_want',
    tags: ['write'],
    description:
      '**给你自己记一件事**：你想做什么、为什么、大概什么时候做。到点我会把你写下的原话还给你一次，'
      + '做不做那一刻由你决定。要说的话、要发的消息都还是走你自己的工具，这里只管"记住我想做这件事"。\n'
      + '**别拿它排满日程**——攒上好几件就变成待办清单了。真的心里挂着才记。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', maxLength: TEXT_MAX, description: `一句话：你想做什么（上限 ${TEXT_MAX} 字）。` },
        why: { type: 'string', maxLength: WHY_MAX, description: `为什么想做——没有理由的事不值得记（上限 ${WHY_MAX} 字）。` },
        about: { type: 'string', maxLength: ABOUT_MAX, description: '可选：这事关于谁、或者要发给谁。到点会原样提醒你。' },
        afterMinutes: { type: 'integer', minimum: 1, maximum: 20160, description: '多少分钟之后提醒我（1 分钟 ~ 14 天）。' },
        atTime: { type: 'string', description: '或者直接给钟点，形如 "21:30"；已经过了就是明天这个点。' },
      },
      required: ['text', 'why'],
    },
  },
  {
    name: 'alive_list',
    tags: ['read'],
    description: '看你手上还记着什么（含到点时间），以及最近了结掉的几件（做完的、放掉的、过期的）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'alive_done',
    tags: ['write'],
    description: '把记着的一件标记成做完了，可以顺手写一句结果。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '条目编号，如 a1（alive_list 里的那个）。' },
        outcome: { type: 'string', maxLength: TEXT_MAX, description: '可选：后来怎么了。' },
      },
      required: ['id'],
    },
  },
  {
    name: 'alive_drop',
    tags: ['write'],
    description: '把记着的一件放掉（不想做了、或者那件事已经不成立了）。放下也是回答。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string', description: '条目编号。' } },
      required: ['id'],
    },
  },
  {
    name: 'alive_desk',
    tags: ['read'],
    description:
      '看运维此刻在桌面上开着什么：前台窗口的标题和进程名。**看不到屏幕内容**（没有截图），'
      + '所以别描述画面，只说得出"在用某样东西干某事"。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'alive_cost',
    tags: ['read'],
    description:
      '看花了多少钱（按配置里的价目表估算，高峰/空闲分时段）：默认今天，也可以给天数。'
      + '给的是估算——用量账本里只有 token 数，钱是照价目表算出来的。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { days: { type: 'integer', minimum: 1, maximum: 30, description: '看最近几天，默认 1（今天）。' } },
    },
  },
  {
    name: 'alive_prefix',
    tags: ['read'],
    description:
      '看你眼前那份系统提示是怎么拼出来的：分几段、每段多长、开头几句是什么、来自哪个模板。'
      + '你在上下文里读得到正文，但看不出它是谁给的——这个工具就是给你看这个的。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'alive_config',
    tags: ['read'],
    description:
      '看哪些**配置**在约束你（只报跟你分寸有关的那几项：回合上限、作息、节流、闸门……）。'
      + '只读，你改不了；觉得哪条不对，就写进你自己的记忆，或者跟运维说。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];
