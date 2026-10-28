/**
 * 轻量 World（小模型专用）。
 *
 * 它只做两件事：**把"现在几点"补上**、**让她记得住他说过的事**。
 *
 * 为什么单独做一个：我们另外那些人味包（人味/能动性/在玩什么）是给 1M 上下文、
 * 会自己思考的模型写的——它们自带约 1 万 token 的提示词与工具定义，还会推"你有自己的时间"
 * "允许什么都不做"这类自主性指令。4B 级小模型读到这些会把它们当**任务**执行，
 * 表现为"自己有主意、不服管"，而它的窗口又装不下那么多人设与工具。
 *
 * 所以这里刻意什么都不加：
 *   · **没有定时器、没有主动推送**——她只在被说话时动；
 *   · **没有情绪、没有亲密度记账、没有"被冒犯要还手"**——那些是给强模型的护栏，
 *     小模型会把它们读成"可以凶"；
 *   · **没有淘汰判断**——记满就按先来后到挤掉最旧的；
 *   · 三个工具，描述都在一行以内。
 *
 * 状态落 `<dataDir>/lite.json`（先写临时文件再改名，写坏了按空的继续）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Logger, ToolDef, World, WorldWebUiDecl, WorldHost } from 'cortico/core/types.ts'
import type { Language } from 'cortico/core/language.ts'
import { nowIso } from 'cortico/core/util.ts'
import { LITE_CONFIG_GROUP, LITE_DEFAULTS, type LiteConfigSection } from './config.ts'

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url))

/** 一条"关于他的事"。 */
interface LiteNote {
  at: string
  text: string
}

interface LiteData {
  version: 1
  notes: LiteNote[]
}

/** 显式查询默认返回的最近笔记条数。 */
const DEFAULT_RECALL_COUNT = 5

export class LiteWorld implements World {
  readonly id = 'lite'
  private readonly cfg: LiteConfigSection
  private readonly timezone: string
  private readonly file: string
  private host: WorldHost | null = null
  private log: Logger = console as unknown as Logger
  private data: LiteData = { version: 1, notes: [] }

  constructor(opts: { cfg: LiteConfigSection; dataDir: string; timezone: string }) {
    this.cfg = opts.cfg
    this.timezone = opts.timezone
    this.file = join(opts.dataDir, 'lite.json')
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  async start(host: WorldHost): Promise<void> {
    this.host = host
    this.log = host.log.child('lite')
    this.load()
    this.log.info('轻量 World 已启动', {
      clock: this.cfg.clockEnabled,
      notes: this.cfg.notesEnabled,
      saved: this.data.notes.length,
    })
  }

  async stop(): Promise<void> {
    this.persist()
    this.host = null
  }

  // ── 存储 ────────────────────────────────────────────────────────────────

  private load(): void {
    if (!this.file || !existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<LiteData>
      const notes = Array.isArray(raw.notes) ? raw.notes : []
      this.data = {
        version: 1,
        notes: notes
          .filter((n): n is LiteNote => !!n && typeof n.text === 'string' && n.text.trim() !== '')
          .map((n) => ({ at: typeof n.at === 'string' ? n.at : '', text: n.text.trim() })),
      }
    } catch (err) {
      this.log.warn('轻量 World 的记录读不出来，按空的继续', { err: String(err) })
    }
  }

  private persist(): void {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8')
      renameSync(tmp, this.file)
    } catch (err) {
      this.log.warn('轻量 World 的记录写不进去', { err: String(err) })
    }
  }

  // ── 时间与小工具 ────────────────────────────────────────────────────────

  private stamp(): string {
    return nowIso(this.timezone)
  }

  /** `9月21日 13:24 周一，下午`。 */
  private clockLine(): string {
    const d = new Date()
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: this.timezone,
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'short',
    }).formatToParts(d)
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
    const hour = Number(get('hour'))
    const period = hour < 5 ? '深夜' : hour < 9 ? '清晨' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 23 ? '晚上' : '深夜'
    return `${get('month')}${get('day')} ${get('hour')}:${get('minute')} ${get('weekday')}，${period}`
  }

  /** 最近几条笔记，最新的在前。 */
  private recentNotes(limit = DEFAULT_RECALL_COUNT): LiteNote[] {
    return [...this.data.notes].slice(-limit).reverse()
  }

  // ── 她能看到什么 ────────────────────────────────────────────────────────

  envPromptVars(): Record<string, string> {
    const vars: Record<string, string> = {}
    if (this.cfg.clockEnabled) vars['lite.now'] = this.clockLine()
    if (this.cfg.notesEnabled) vars['lite.notes'] = String(this.data.notes.length)
    return vars
  }

  tools(): ToolDef[] {
    const cfg = this.cfg
    const tools: ToolDef[] = []

    if (cfg.clockEnabled) {
      tools.push({
        name: 'lite_time',
        description: '现在几点、几号、星期几。不确定时间的时候用。',
        tags: ['read'],
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        handler: async () => `现在是 ${this.clockLine()}。`,
      })
    }

    if (cfg.notesEnabled) {
      tools.push({
        name: 'lite_note',
        description: `记一件关于他的事，一句话，最多 ${cfg.noteChars} 个字。`,
        tags: ['write'],
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', description: '要记的那句话。' },
          },
          required: ['text'],
        },
        handler: async (args) => {
          const raw = typeof args.text === 'string' ? args.text.trim() : ''
          if (!raw) return '没写内容，没记。'
          const text = raw.length > cfg.noteChars ? `${raw.slice(0, cfg.noteChars)}…` : raw
          this.data.notes.push({ at: this.stamp(), text })
          const cap = Math.max(3, cfg.maxNotes)
          while (this.data.notes.length > cap) this.data.notes.shift()
          this.persist()
          return `记下了：${text}（现在一共 ${this.data.notes.length} 条）`
        },
      })

      tools.push({
        name: 'lite_recall',
        description: '看看你记的关于他的事。',
        tags: ['read'],
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        handler: async () => {
          const notes = this.recentNotes(cap(this.cfg.maxNotes))
          if (!notes.length) return '你还没记过什么。'
          return `你记着这些：\n${notes.map((n) => `· ${n.text}`).join('\n')}`
        },
      })
    }

    return tools
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const cfg = this.cfg
    return {
      lamps: [
        {
          label: '轻量',
          state: cfg.clockEnabled || cfg.notesEnabled ? 'online' : 'offline',
          hint: `补时间${cfg.clockEnabled ? '✓' : '✗'}・记事${cfg.notesEnabled ? '✓' : '✗'}`,
        },
      ],
      badges: [
        { label: '记着的', value: cfg.notesEnabled ? this.data.notes.length : '关' },
        { label: '工具', value: this.tools().length },
      ],
      config: [LITE_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.lite.envPrompt',
          title: '轻量 · 环境提示词',
          description: '小模型专用：告诉她现在几点、她记着什么，以及三句说话规矩。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'lite.now', description: '生成这段前缀时的钟点。' },
            { name: 'lite.notes', description: '已登记的笔记数量；原文由 lite_recall 显式读取。' },
          ],
        },
      ],
    }
  }
}

function cap(n: number): number {
  return Math.max(3, Math.min(100, Math.floor(n)))
}

export { LITE_DEFAULTS }

/** 全部工具的声明;自描述要列出 tools() 能返回的每一个。 */
export function liteToolDecls(noteChars: number): ReadonlyArray<Omit<ToolDef, 'handler'>> {
  return [
  {
    name: 'lite_time',
    description: '现在几点、几号、星期几。不确定时间的时候用。',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'lite_note',
    description: `记一件关于他的事，一句话，最多 ${noteChars} 个字。`,
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '要记的那句话。' },
      },
      required: ['text'],
    },
  },
  {
    name: 'lite_recall',
    description: '看看你记的关于他的事。',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];
}
