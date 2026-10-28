/** 情绪天气 World：前台窗口 + 空闲时长 → 状态；状态变化时推一条。 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ToolDef, World, WorldHost } from 'cortico/core/types.ts'
import { nowIso } from 'cortico/core/util.ts'
import { autoWebUi } from './panel.ts'
import { MOOD_DEFAULTS } from './config.ts'

const execFileAsync = promisify(execFile)

export const MOOD_TOOL_DECLS = [
  {
    name: 'mood_now',
    description: '看使用者现在在干嘛：前台窗口、离开多久、大概是什么状态（在忙 / 在玩 / 闲着 / 离开了）。判断该不该打扰时用。',
    tags: ['read'] as const,
    parameters: { type: 'object' as const, additionalProperties: false, properties: {} },
  },
]

type MoodState = 'left' | 'idle' | 'busy' | 'play' | 'use'

const STATE_TEXT: Record<MoodState, string> = {
  left: '较长时间未检测到键鼠输入，不能据此确定是否离开。',
  idle: '最近没有键鼠输入，不能据此确定是否忙碌。',
  busy: '前台进程符合工作类规则；这是启发式分类，不代表正在工作。',
  play: '前台进程或标题符合游戏类规则；这是启发式分类，不代表正在游玩。',
  use: '已读取前台窗口，当前规则无法确定活动类别。',
}

export class MoodWorld implements World {
  readonly id = 'mood'
  private host: WorldHost | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private last: MoodState | null = null
  private lastEventAt = 0
  private checking = false
  private generation = 0
  private readonly tickSec: number
  private readonly minEventGapSec: number
  private readonly timezone: string

  constructor(opts: { cfg: { tickSec: number; minEventGapSec: number }; dataDir: string; timezone: string }) {
    this.tickSec = Math.max(30, opts.cfg.tickSec)
    this.minEventGapSec = Math.max(60, opts.cfg.minEventGapSec)
    this.timezone = opts.timezone
  }

  envPromptVars(): Record<string, string> {
    return {}
  }

  tools(): ToolDef[] {
    return MOOD_TOOL_DECLS.map((decl) => ({
      ...decl,
      tags: [...decl.tags],
      handler: async () => {
        const s = await this.readSnapshot()
        if (!s) return '看不出来：系统没给前台窗口。'
        const m = classify(s)
        return `${STATE_TEXT[m]}（前台：${s.process || '未知'}「${s.title.slice(0, 40)}」，距最近键鼠输入 ${s.idleSec} 秒）`
      },
    }))
  }

  webUi() {
    return autoWebUi('mood', '情绪天气', MOOD_DEFAULTS)
  }
  async start(host: WorldHost): Promise<void> {
    this.generation++
    this.host = host
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => { void this.check().catch(error => host.log.warn('窗口状态检查失败：' + String(error))) }, this.tickSec * 1000)
    this.timer.unref?.()
    try { await this.check() } catch (error) { await this.stop(); throw error }
  }

  async stop(): Promise<void> {
    this.generation++
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.host = null
  }

  private async check(): Promise<void> {
    const host = this.host
    const generation = this.generation
    if (!host || this.checking) return
    this.checking = true
    try {
    const s = await this.readSnapshot()
    if (!s || this.host !== host || generation !== this.generation) return
    const m = classify(s)
    if (m === this.last) return
    // 状态来回切时别反复唤醒模型：两次事件之间至少隔 minEventGapSec。
    if (Date.now() - this.lastEventAt < this.minEventGapSec * 1000) return
    await host.pushEvent({
      type: 'mood.changed',
      ts: nowIso(this.timezone),
      source: this.id,
      senderKey: this.id,
      origin: 'external',
      text: `${STATE_TEXT[m]}距最近键鼠输入 ${s.idleSec} 秒。前台进程：${s.process || '未知'}；标题：${s.title.slice(0, 80)}`,
      meta: { state: m, heuristic: true, process: s.process, title: s.title.slice(0, 80), idleSec: s.idleSec },
    })
    if (this.host === host && generation === this.generation) { this.last = m; this.lastEventAt = Date.now() }
    } finally { this.checking = false }
  }

  private readSnapshot(): Promise<Snapshot | null> { return snapshot() }
}

interface Snapshot { title: string; process: string; idleSec: number }

function classify(s: Snapshot): MoodState {
  if (s.idleSec >= 600) return 'left'
  if (s.idleSec >= 120) return 'idle'
  const text = (s.process + ' ' + s.title).toLowerCase()
  if (/steam|game|三角洲|delta|minecraft|league|lol|valorant|原神|cs2/i.test(text)) return 'play'
  if (/code|devenv|idea|sublime|notepad|typora|obsidian|winword|excel|powerpnt/i.test(s.process.toLowerCase())) return 'busy'
  return 'use'
}

const SNAPSHOT_SCRIPT = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
  [DllImport("kernel32.dll")] public static extern ulong GetTickCount64();
}
"@
$h = [W]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][W]::GetWindowText($h, $sb, 512)
$procId = 0
[void][W]::GetWindowThreadProcessId($h, [ref]$procId)
$li = New-Object W+LASTINPUTINFO
$li.cbSize = 8
[void][W]::GetLastInputInfo([ref]$li)
$tick32 = [W]::GetTickCount64() % 4294967296
$idle = (($tick32 - [uint64]$li.dwTime + 4294967296) % 4294967296) / 1000
$p = Get-Process -Id $procId -ErrorAction SilentlyContinue
@{ title = $sb.ToString(); process = $(if($p){$p.ProcessName}else{""}); idleSec = [int]$idle } | ConvertTo-Json -Compress
`

/** -EncodedCommand 要 UTF-16LE 的 base64，省得在命令行里跟引号打架。 */
function encode(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

async function snapshot(): Promise<Snapshot | null> {
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(SNAPSHOT_SCRIPT)], {
      windowsHide: true, timeout: 8000, encoding: 'utf8',
    })
    const j = JSON.parse(stdout.trim()) as { title?: string; process?: string; idleSec?: number }
    if (typeof j.title !== 'string' || typeof j.process !== 'string' || !Number.isFinite(j.idleSec) || Number(j.idleSec) < 0) return null
    return { title: j.title, process: j.process, idleSec: Number(j.idleSec) }
  } catch {
    return null
  }
}
