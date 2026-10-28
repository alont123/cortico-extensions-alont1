/**
 * 前台窗口采集器。
 *
 * 为什么用常驻 PowerShell 进程而不是每次 spawn：编译那段 C#（Add-Type）要 300~600ms，
 * 每轮都编译就为了读一个窗口句柄，太浪费。起一次，之后每 tick 只收一行 JSON。
 *
 * 编码：PowerShell 的输出编码在中文 Windows 上是 GBK，而窗口标题里有中文。
 * 所以脚本第一件事就是把 OutputEncoding 设成 UTF-8，Node 侧按 UTF-8 解。
 * （不设的话标题会变成乱码——实测过。）
 *
 * 拿不到 `MainModule.FileVersionInfo` 是常态（权限、保护进程），所以那段单独 try：
 * 进程名和窗口标题才是主要信号。
 */
import { spawn } from 'node:child_process'

/** Windows 下没有 py/pwsh 依赖，用系统自带的 powershell.exe。 */
const PS_EXE = 'powershell.exe'

/**
 * 每 tick 输出一行 JSON：
 * `{"ok":true,"proc":"notepad","desc":"记事本","title":"…","pid":123}`
 * 拿不到前台窗口时 `proc` 为空串。
 */
const SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class CorticoFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
}
"@

while ($true) {
  $h = [CorticoFg]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][CorticoFg]::GetWindowText($h, $sb, 512)
  $procId = 0
  [void][CorticoFg]::GetWindowThreadProcessId($h, [ref]$procId)
  $proc = ''
  $desc = ''
  if ($procId -gt 0) {
    try {
      $p = Get-Process -Id $procId -ErrorAction Stop
      $proc = $p.ProcessName
      try { $desc = $p.MainModule.FileVersionInfo.FileDescription } catch {}
    } catch {}
  }
  $o = [ordered]@{ ok = $true; pid = $procId; proc = $proc; desc = $desc; title = $sb.ToString() }
  Write-Output ($o | ConvertTo-Json -Compress)
  Start-Sleep -Milliseconds 2000
}
`

export interface ForegroundSample {
  pid: number
  proc: string
  desc: string
  title: string
}

/**
 * 常驻采集器。`start()` 起进程，`latest()` 取最近一次采样。
 *
 * 采不到就保持上一次的值——前台窗口在切换的瞬间可能读空，
 * 一次空读不该被当成"他去干别的了"。
 */
export class ForegroundWatcher {
  private child: ReturnType<typeof spawn> | null = null
  private last: ForegroundSample | null = null
  private buf = ''
  private stopped = false

  start(): void {
    if (this.child) return
    this.stopped = false
    this.child = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    this.child.stdout?.setEncoding('utf8')
    this.child.stdout?.on('data', (chunk: string) => this.feed(chunk))
    // 进程自己退了（被杀、PowerShell 崩）就重启，不然扩展会一直读到旧值
    this.child.on('exit', () => {
      this.child = null
      if (!this.stopped) setTimeout(() => this.start(), 5000).unref?.()
    })
  }

  stop(): void {
    this.stopped = true
    try { this.child?.kill() } catch { /* 已经没了 */ }
    this.child = null
    this.buf = ''
  }

  private feed(chunk: string): void {
    this.buf += chunk
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      try {
        const o = JSON.parse(line) as Partial<ForegroundSample>
        if (typeof o.proc === 'string' && o.proc) {
          this.last = { pid: Number(o.pid ?? 0), proc: o.proc, desc: String(o.desc ?? ''), title: String(o.title ?? '') }
        }
      } catch { /* 非 JSON 行（PowerShell 的杂音）忽略 */ }
    }
  }

  /** 最近一次采样；还没采到就是 null。 */
  latest(): ForegroundSample | null {
    return this.last
  }

  /** 采集器活着吗（调试用）。 */
  alive(): boolean {
    return this.child !== null
  }
}
