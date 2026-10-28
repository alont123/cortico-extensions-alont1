/** 下载管家 World：只读地看下载目录，新文件落地时报一声。 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ToolDef, World, WorldHost } from 'cortico/core/types.ts'
import { nowIso } from 'cortico/core/util.ts'
import { autoWebUi } from './panel.ts'
import { DOWNLOADS_DEFAULTS } from './config.ts'

export const DOWNLOADS_TOOL_DECLS = [
  {
    name: 'downloads_recent',
    description: '看下载夹里最近的新文件：名字、大小、改时间。',
    tags: ['read'] as const,
    parameters: {
      type: 'object' as const, additionalProperties: false,
      properties: { limit: { type: 'integer' as const, description: '看几个，默认 10，最多 30。' } },
    },
  },
  {
    name: 'downloads_stats',
    description: '下载夹里有多少文件、一共占多大。',
    tags: ['read'] as const,
    parameters: { type: 'object' as const, additionalProperties: false, properties: {} },
  },
]

interface SeenEntry { mtimeMs: number }
interface DownloadsData { seen: Record<string, SeenEntry> }

const MAX_SEEN = 500

export class DownloadsWorld implements World {
  readonly id = 'downloads'
  private host: WorldHost | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly dir: string
  private readonly scanSec: number
  private readonly dataFile: string
  private data: DownloadsData
  private readonly timezone: string
  private scanning = false

  constructor(opts: { cfg: { dir: string; scanSec: number }; dataDir: string; timezone: string }) {
    this.dir = opts.cfg.dir || join(homedir(), 'Downloads')
    this.scanSec = Math.max(15, opts.cfg.scanSec)
    this.timezone = opts.timezone
    this.dataFile = join(opts.dataDir, 'downloads.json')
    this.data = this.load()
  }

  private load(): DownloadsData {
    try {
      if (existsSync(this.dataFile)) {
        const value = JSON.parse(readFileSync(this.dataFile, 'utf8').replace(/^\uFEFF/, '')) as DownloadsData
        if (value?.seen && typeof value.seen === 'object' && !Array.isArray(value.seen)) return value
      }
    } catch { /* 读坏了重来 */ }
    return { seen: {} }
  }

  private save(): void {
    mkdirSync(dirname(this.dataFile), { recursive: true })
    writeFileSync(this.dataFile, JSON.stringify(this.data, null, 2))
  }

  envPromptVars(): Record<string, string> {
    return {}
  }

  tools(): ToolDef[] {
    return [
      {
        ...DOWNLOADS_TOOL_DECLS[0],
        tags: [...DOWNLOADS_TOOL_DECLS[0].tags],
        handler: async (args: Record<string, unknown>) => {
          const limit = Math.min(30, Math.max(1, Number(args.limit ?? 10)))
          const list = this.listFiles().slice(0, limit)
          if (!list.length) return '下载夹里没有文件。'
          return list.map((f) => f.name + ' · ' + formatSize(f.size) + ' · ' + formatTime(f.mtimeMs, this.timezone)).join('\n')
        },
      },
      {
        ...DOWNLOADS_TOOL_DECLS[1],
        tags: [...DOWNLOADS_TOOL_DECLS[1].tags],
        handler: async () => {
          const list = this.listFiles()
          const total = list.reduce((s, f) => s + f.size, 0)
          return '下载夹：' + list.length + ' 个文件，共 ' + formatSize(total) + '。'
        },
      },
    ]
  }

  webUi() {
    return autoWebUi('downloads', '下载管家', DOWNLOADS_DEFAULTS)
  }
  async start(host: WorldHost): Promise<void> {
    if (this.host) return
    this.host = host
    try { await this.scan() }
    catch (error) { this.host = null; throw error }
    if (this.host === host) this.timer = setInterval(() => { void this.scan().catch(error => host.log.warn('下载目录扫描失败', { error: String(error) })) }, this.scanSec * 1000)
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.host = null
  }

  private listFiles(): Array<{ name: string; size: number; mtimeMs: number }> {
      return readdirSync(this.dir, { withFileTypes: true })
        .filter((d) => d.isFile())
        .flatMap((d) => {
          try { const st = statSync(join(this.dir, d.name)); return [{ name: d.name, size: st.size, mtimeMs: st.mtimeMs }] }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  private async scan(): Promise<void> {
    const host = this.host
    if (!host || this.scanning) return
    this.scanning = true
    try {
    const fresh: Array<{ name: string; size: number }> = []
    const next: DownloadsData = { seen: {} }
    for (const f of this.listFiles().slice(0, MAX_SEEN)) {
      const prev = this.data.seen[f.name]
      next.seen[f.name] = { mtimeMs: f.mtimeMs }
      if (!prev) fresh.push({ name: f.name, size: f.size })
    }
    if (fresh.length) {
      await host.pushEvent({
        type: 'downloads.new',
        ts: nowIso(this.timezone),
        source: this.id,
        origin: 'external',
        senderKey: this.id,
        text: '下载夹里多了 ' + fresh.length + ' 个新文件：' + fresh.slice(0, 5).map((f) => f.name).join('、') + (fresh.length > 5 ? ' 等' : ''),
        meta: { files: fresh.slice(0, 20) },
      })
    }
    if (this.host === host) { this.data = next; this.save() }
    } finally { this.scanning = false }
  }
}

function formatSize(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB'
  return (n / 1073741824).toFixed(2) + ' GB'
}

function formatTime(ms: number, timezone: string): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false, timeZone: timezone }).slice(5, 16)
}
