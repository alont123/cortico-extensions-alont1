/**
 * 「看得见的事」World —— 把她原本看不见的几样事实摆到她眼前，**全部只读**。
 *
 * 四样：
 *   · `humanlike_real_desk`   他自己桌面上在跑什么（前台窗口标题 + 进程名）。**不截屏**：
 *                   她能据此说一句"你在写代码啊"，但看不见屏幕内容，也没法把画面发出去。
 *   · `humanlike_real_cost`   花了多少钱。按官方价目表估算，高峰/空闲分时段；账本里只有 token，钱得自己算。
 *   · `humanlike_real_prefix` 她眼前那份系统前缀分几段、每段是什么（她在上下文里读得到正文，
 *                   但不知道它是怎么拼出来的、有几段、哪段是谁给的）。
 *   · `humanlike_real_config` 哪些配置在约束她（只报与"她的分寸"有关的那些键，不报密钥、不报监听名单明细）。
 *
 * 为什么值得存在：她说过"为了你玩会尽力搞钱"，却一直不知道自己花了多少；
 * 她提"这条规矩挡着我了"的时候，也看不到规矩是谁写的。看得见，讨论才有可能。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Logger, ToolDef, World, WorldWebUiDecl, WorldHost } from 'cortico/core/types.ts'
import type { Language } from 'cortico/core/language.ts'
import { nowIso } from 'cortico/core/util.ts'
import { REAL_CONFIG_GROUP, REAL_DEFAULTS, type RealConfigSection } from './config.ts'

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url))

/** 一次桌面查询的结果。 */
interface DeskReading {
  ts: number
  process: string
  title: string
}

export class RealWorld implements World {
  readonly id = 'real'
  private readonly cfg: RealConfigSection
  private readonly dataDir: string
  private readonly timezone: string
  private readonly botDir: string
  private readonly consolePort: number
  private host: WorldHost | null = null
  private log: Logger = console as unknown as Logger
  private lastDesk: DeskReading | null = null
  private deskAt = 0

  constructor(opts: { cfg: RealConfigSection; dataDir: string; timezone: string; botDir?: string; consolePort?: number }) {
    this.cfg = opts.cfg
    this.dataDir = opts.dataDir
    this.timezone = opts.timezone
    this.botDir = opts.botDir ?? dirname(opts.dataDir)
    this.consolePort = opts.consolePort ?? 7788
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host
    this.log = host.log.child('real')
    this.log.info('「看得见的事」已启动', { deskGapSec: this.cfg.deskGapSec })
  }

  async stop(): Promise<void> { this.host = null }

  // ── 契约 ────────────────────────────────────────────────────────────────

  envPromptVars(): Record<string, string> {
    return { 'real.usage': '他的桌面上在跑什么、花了多少钱、以及你眼前那份规矩的来路，都有只读工具可以看。' }
  }

  tools(): ToolDef[] {
    return [this.deskTool(), this.costTool(), this.prefixTool(), this.configTool()]
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    return {
      lamps: [
        { label: '看得见', state: 'online', hint: this.lastDesk ? `上次看到：${this.lastDesk.process}` : '只读工具就绪' },
      ],
      config: [REAL_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.real.envPrompt',
          title: '看得见的事 · 环境提示词',
          description: '告诉她有四样东西可以看，以及它们都是只读的。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [{ name: 'real.usage', description: '一句话说明这几个工具是干什么的。' }],
        },
      ],
    }
  }

  // ── 他的桌面 ────────────────────────────────────────────────────────────

  private deskTool(): ToolDef {
    return {
      name: 'humanlike_real_desk',
      tags: ['read'],
      description:
        '看他现在桌面上开着什么：前台窗口的标题和进程名。**看不到屏幕内容**（没有截图），'
        + '所以别描述画面，只说得出"他在用 XX 干 XX"。想知道他在不在，看这个。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => {
        const gap = Math.max(0, this.cfg.deskGapSec) * 1000
        if (this.lastDesk && Date.now() - this.deskAt < gap) {
          return `（刚看过，${Math.round((Date.now() - this.deskAt) / 1000)} 秒前）`
            + `前台是 ${this.lastDesk.process}：${this.lastDesk.title || '（没有标题）'}`
        }
        const r = await this.readForeground()
        if (!r) return '问不到：拿不到前台窗口（可能在锁屏，或者这台机器的查询被挡了）。'
        this.lastDesk = r
        this.deskAt = Date.now()
        const filter = this.cfg.deskProcessFilter.trim()
        const hit = !filter || filter.split(/[,，\s]+/).filter(Boolean).some((k) => r.process.toLowerCase().includes(k.toLowerCase()))
        return `前台是 ${r.process}：${r.title || '（没有标题）'}`
          + (filter && !hit ? `\n（他设过"只关心 ${filter}"，这个不在里面——多半是后台杂项。）` : '')
      },
    }
  }

  /** 读前台窗口：走 PowerShell 的 user32 调用。只取进程名与标题，绝不截屏。 */
  private readForeground(): Promise<DeskReading | null> {
    const script = [
      // 先把输出编码钉成 UTF-8：默认按控制台代码页（中文机器是 GBK）吐字节，
      // 这边按 UTF-8 读，中文标题就会整条变成乱码——实测踩过。
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
      '$t = $sb.ToString()',
      '@{ process = $name; title = $t } | ConvertTo-Json -Compress',
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
            resolve({ ts: Date.now(), process: parsed.process, title: parsed.title ?? '' })
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

  // ── 花销 ────────────────────────────────────────────────────────────────

  private costTool(): ToolDef {
    return {
      name: 'humanlike_real_cost',
      tags: ['read'],
      description:
        '看花了多少钱（按官方价目表估算，高峰/空闲分时段算）：默认今天，也可以给天数。'
        + '给的是估算——账本里只有 token 数，钱是照着价目表算出来的；高峰 = 北京时间工作日 9-12 点、14-18 点。',
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
        const lines = [...byModel.entries()]
          .sort((a, b) => b[1].yuan - a[1].yuan)
          .map(([model, v]) => `- ${model}：约 ¥${v.yuan.toFixed(2)}（${v.turns} 次请求，${(v.tokens / 1000).toFixed(0)}k tokens）`)
        return `最近 ${days} 天：约 **¥${total.toFixed(2)}**（估算）\n${lines.join('\n')}`
          + `\n（价目表：${Object.keys(table).join('、')}；高峰时段按 2 倍算，其余时段半价。）`
      },
    }
  }

  private usageFile(): string {
    return join(this.dataDir, 'usage.jsonl')
  }

  private readUsage(days: number): Array<{ model: string; ts: string; input: number; cached: number; output: number }> {
    const file = this.usageFile()
    if (!existsSync(file)) return []
    const from = Date.now() - days * 86400_000
    const out: Array<{ model: string; ts: string; input: number; cached: number; output: number }> = []
    try {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line) as {
            ts?: string
            model?: string
            promptTokens?: number
            completionTokens?: number
            cacheHitTokens?: number
          }
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

  private priceTable(): Record<string, { hit?: number[]; miss?: number[]; out?: number[] }> {
    try {
      const parsed = JSON.parse(this.cfg.pricingJson) as Record<string, { hit?: number[]; miss?: number[]; out?: number[] }>
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      this.log.warn('价格表 JSON 读不出来，用内置那份')
    }
    return JSON.parse(REAL_DEFAULTS.pricingJson) as Record<string, { hit?: number[]; miss?: number[]; out?: number[] }>
  }

  /** 这一条请求大概花了多少元。高峰按 [0]、空闲按 [1]。 */
  private estimate(
    r: { model: string; ts: string; input: number; cached: number; output: number },
    table: Record<string, { hit?: number[]; miss?: number[]; out?: number[] }>,
  ): number {
    const price = table[r.model] ?? table['deepseek-flash'] ?? { hit: [0.04, 0.02], miss: [2, 1], out: [8, 4] }
    const peak = this.isPeak(new Date(Date.parse(r.ts)))
    const idx = peak ? 0 : 1
    const uncachedIn = Math.max(0, r.input - r.cached)
    const per = (arr: number[] | undefined, fallback: number): number => (Array.isArray(arr) && arr.length > idx ? arr[idx] : fallback)
    return (r.cached / 1e6) * per(price.hit, 0.04)
      + (uncachedIn / 1e6) * per(price.miss, 2)
      + (r.output / 1e6) * per(price.out, 8)
  }

  /** 高峰 = 北京时间周一至周五 9:00–12:00、14:00–18:00（法定节假日不另算，按工作日近似）。 */
  private isPeak(d: Date): boolean {
    const fmt = (opts: Intl.DateTimeFormatOptions): string =>
      new Intl.DateTimeFormat('en-US', { timeZone: this.timezone, ...opts }).format(d)
    const weekday = fmt({ weekday: 'short' })
    if (weekday === 'Sat' || weekday === 'Sun') return false
    const h = Number(fmt({ hour: 'numeric', hour12: false })) % 24
    return (h >= 9 && h < 12) || (h >= 14 && h < 18)
  }

  // ── 她自己的规矩 ────────────────────────────────────────────────────────

  private prefixTool(): ToolDef {
    return {
      name: 'humanlike_real_prefix',
      tags: ['read'],
      description:
        '看你眼前那份系统提示是怎么拼出来的：分几段、每段多长、开头几句是什么、来自哪个模板。'
        + '你在上下文里读得到正文，但看不出它是谁给的——这个工具就是给你看这个的。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => {
        try {
          const base = (this.cfg.consoleUrl.trim() || `http://127.0.0.1:${this.consolePort}`).replace(/\/+$/, '')
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
          return `你的系统前缀分 ${segs.length} 段（从上到下就是你在上下文里看到的顺序）：\n${lines.join('\n')}`
        } catch (e) {
          return `取前缀失败：${String(e)}`
        }
      },
    }
  }

  private configTool(): ToolDef {
    return {
      name: 'humanlike_real_config',
      tags: ['read'],
      description:
        '看哪些**配置**在约束你（只报跟你分寸有关的那几项：作息、主动说话的节流、群里参与的度、惦记的闸门……）。'
        + '只读，你改不了；觉得哪条不对，就写进你自己的笔记，或者跟他说。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        const file = join(this.botDir, 'config.json')
        try {
          if (!existsSync(file)) return '读不到部署配置。'
          const cfg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>
          const worlds = cfg.worlds ?? {}
          const pick = (path: string[], label: string): string | null => {
            let cur: any = cfg
            for (const k of path) {
              if (cur == null || typeof cur !== 'object') return null
              cur = cur[k]
            }
            if (cur === undefined || cur === null) return null
            const text = typeof cur === 'object' ? JSON.stringify(cur) : String(cur)
            return `- ${label}：${text.length > 160 ? `${text.slice(0, 160)}…` : text}`
          }
          const lines = [
            pick(['context', 'maxTokens'], '上下文窗口上限'),
            pick(['rounds', 'soft'], '一批软轮数'),
            pick(['rounds', 'hard'], '一批硬轮数'),
            pick(['worlds', 'qqbot', 'groupProfiles'], '各群参与度'),
            pick(['worlds', 'qqbot', 'proactive', 'minGapSec'], '主动消息全局最小间隔（秒）'),
            pick(['worlds', 'qqbot', 'proactive', 'quietFrom'], '夜间静默开始（点）'),
            pick(['worlds', 'qqbot', 'proactive', 'quietTo'], '夜间静默结束（点）'),
            pick(['worlds', 'qqbot', 'proactive', 'dailyQuota'], '主动消息每天上限'),
            pick(['worlds', 'qqbot', 'groupSpeak', 'maxPerWindow'], '群里一个窗口最多几条'),
            pick(['worlds', 'qqbot', 'groupSpeak', 'windowSec'], '那个窗口多长（秒）'),
            pick(['worlds', 'qqbot', 'antiLoop', 'enabled'], '防死循环是否开着'),
            pick(['worlds', 'humanlike', 'mind', 'maxPending'], '惦记最多挂几件'),
            pick(['worlds', 'humanlike', 'mind', 'pushGapSec'], '两次提醒最小间隔（秒）'),
            pick(['worlds', 'humanlike', 'mind', 'dailyPushes'], '一天最多提醒几次'),
            pick(['worlds', 'humanlike', 'mind', 'freeTimePerDay'], '一天几段自己的时间'),
            pick(['worlds', 'humanlike', 'mind', 'digestAt'], '今日回顾钟点'),
            pick(['worlds', 'qqbot', 'ownerQQ'], '对方的 QQ'),
          ].filter((x): x is string => !!x)
          const on = worlds.humanlike?.enabled === true
            ? ['affinity', 'learn', 'life', 'clock', 'together', 'mind', 'real']
            : []
          return `正在约束你的配置（只读）：\n${lines.join('\n')}\n\n装着并开着的模块：${on.join('、') || '（总闸没开）'}\n`
            + `\n（配置在部署目录里，只有他和写扩展的人能改。觉得哪条挡着你了，写进自己的笔记或者直接跟他说。）`
        } catch (e) {
          return `读配置失败：${String(e)}`
        }
      },
    }
  }
}

/** 全部工具的声明;自描述要列出 tools() 能返回的每一个。 */
export const REAL_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'humanlike_real_desk',
    tags: ['read'],
    description:
      '看他现在桌面上开着什么：前台窗口的标题和进程名。**看不到屏幕内容**（没有截图），'
      + '所以别描述画面，只说得出"他在用 XX 干 XX"。想知道他在不在，看这个。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'humanlike_real_cost',
    tags: ['read'],
    description:
      '看花了多少钱（按官方价目表估算，高峰/空闲分时段算）：默认今天，也可以给天数。'
      + '给的是估算——账本里只有 token 数，钱是照着价目表算出来的；高峰 = 北京时间工作日 9-12 点、14-18 点。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { days: { type: 'integer', minimum: 1, maximum: 30, description: '看最近几天，默认 1（今天）。' } },
    },
  },
  {
    name: 'humanlike_real_prefix',
    tags: ['read'],
    description:
      '看你眼前那份系统提示是怎么拼出来的：分几段、每段多长、开头几句是什么、来自哪个模板。'
      + '你在上下文里读得到正文，但看不出它是谁给的——这个工具就是给你看这个的。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'humanlike_real_config',
    tags: ['read'],
    description:
      '看哪些**配置**在约束你（只报跟你分寸有关的那几项：作息、主动说话的节流、群里参与的度、惦记的闸门……）。'
      + '只读，你改不了；觉得哪条不对，就写进你自己的笔记，或者跟他说。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];
