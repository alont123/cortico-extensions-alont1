/** 截图日记 World：截图存到当天，note 由她自己写。 */
import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ToolDef, World } from 'cortico/core/types.ts'
import { nowIso } from 'cortico/core/util.ts'
import { autoWebUi } from './panel.ts'
import { DIARY_DEFAULTS } from './config.ts'

const execFileAsync = promisify(execFile)

export const DIARY_TOOL_DECLS = [
  {
    name: 'diary_snap',
    description: '截一张现在的屏幕，存进今天的日记；可以附一句今天的话。',
    tags: ['write'] as const,
    parameters: {
      type: 'object' as const, additionalProperties: false,
      properties: { note: { type: 'string' as const, description: '今天的一句话，可选。' } },
    },
  },
  {
    name: 'diary_today',
    description: '看今天日记里有没有图，以及当时写的话。',
    tags: ['read'] as const,
    parameters: { type: 'object' as const, additionalProperties: false, properties: {} },
  },
  {
    name: 'diary_list',
    description: '最近几天的日记（按天）。',
    tags: ['read'] as const,
    parameters: {
      type: 'object' as const, additionalProperties: false,
      properties: { days: { type: 'integer' as const, description: '看最近几天，默认 7，最多 30。' } },
    },
  },
]

export class DiaryWorld implements World {
  readonly id = 'diary'
  private readonly outDir: string
  private readonly maxPerDay: number
  private readonly timezone: string
  private capturing = false

  constructor(opts: { cfg: { outDir: string; maxPerDay: number }; dataDir: string; timezone: string }, private readonly capture = captureScreen) {
    this.outDir = join(opts.dataDir, opts.cfg.outDir.replace(/^data[\\/]/, ''))
    this.maxPerDay = Math.max(1, opts.cfg.maxPerDay)
    this.timezone = opts.timezone
  }

  envPromptVars(): Record<string, string> {
    return {}
  }

  webUi() {
    return autoWebUi('diary', '截图日记', DIARY_DEFAULTS)
  }
  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  tools(): ToolDef[] {
    return [
      {
        ...DIARY_TOOL_DECLS[0],
        tags: [...DIARY_TOOL_DECLS[0].tags],
        handler: async (args: Record<string, unknown>) => {
          if (this.capturing) return '上一次日记截图尚未完成，请等待回执。'
          this.capturing = true
          try {
          const note = String(args.note ?? '').trim()
          const day = this.day()
          const dir = join(this.outDir, day)
          mkdirSync(dir, { recursive: true })
          const pictures = readdirSync(dir).filter((f) => f.endsWith('.png'))
          const count = pictures.length
          if (count >= this.maxPerDay) return `今天的日记已经有 ${count} 张了（上限 ${this.maxPerDay}）。`
          // 删除过中间一张时，不能按文件数覆盖后面仍存在的照片。
          const sequence = pictures.reduce((max, name) => /^\d+\.png$/.test(name) ? Math.max(max, Number.parseInt(name)) : max, 0) + 1
          const file = join(dir, `${String(sequence).padStart(2, '0')}.png`)
          const ok = await this.capture(file)
          if (!ok || !existsSync(file) || statSync(file).size === 0) return '截图失败：系统未生成有效图片。'
          const meta = { at: nowIso(this.timezone), note }
          writeFileSync(file.replace(/\.png$/, '.json'), JSON.stringify(meta, null, 2))
          return `截好了：${day} ${count + 1} 张。${note ? ' 记的是：' + note : ''}`
          } finally { this.capturing = false }
        },
      },
      {
        ...DIARY_TOOL_DECLS[1],
        tags: [...DIARY_TOOL_DECLS[1].tags],
        handler: async () => {
          const day = this.day()
          const dir = join(this.outDir, day)
          if (!existsSync(dir)) return `今天（${day}）还没有日记。`
          const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
          if (!files.length) return `今天（${day}）还没有写日记。`
          return files.map((f) => {
            const m = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { at: string; note: string }
            return `${m.at.slice(11, 16)} ${m.note || '（没写话）'}`
          }).join('\n')
        },
      },
      {
        ...DIARY_TOOL_DECLS[2],
        tags: [...DIARY_TOOL_DECLS[2].tags],
        handler: async (args: Record<string, unknown>) => {
          const days = Math.min(30, Math.max(1, Number(args.days ?? 7)))
          if (!existsSync(this.outDir)) return '还没有日记。'
          const list = readdirSync(this.outDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort()
            .reverse()
            .slice(0, days)
          if (!list.length) return '还没有日记。'
          return list.map((d) => {
            const dir = join(this.outDir, d)
            const n = readdirSync(dir).filter((f) => f.endsWith('.png')).length
            return `${d}：${n} 张`
          }).join('\n')
        },
      },
    ]
  }

  private day(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: this.timezone })
  }
}

/** 用 PowerShell 截主屏到 PNG；失败返回 false。 */
async function captureScreen(outPath: string): Promise<boolean> {
  const safe = outPath.replace(/'/g, "''")
  const script = `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ` +
    `$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ` +
    `$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; ` +
    `$g = [System.Drawing.Graphics]::FromImage($bmp); ` +
    `$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); ` +
    `$bmp.Save('${safe}', [System.Drawing.Imaging.ImageFormat]::Png); ` +
    `$g.Dispose(); $bmp.Dispose()`
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 })
    return true
  } catch {
    return false
  }
}
