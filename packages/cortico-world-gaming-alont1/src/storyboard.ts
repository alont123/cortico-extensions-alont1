/**
 * 窗口清单 + 多帧分镜抓图。
 *
 * 抓画面的思路照搬 cortico-world-bilibili-video：不是只截一张静图，而是连抓几帧、
 * 用 dHash/亮度把它们去重，再把挑出来的几帧拼成一张分镜网格，一次喂给视觉模型。
 * 模型看到的是「这几秒里发生了几件事」，而不是一张不知道前因后果的截图。
 *
 * 全部走一次性 PowerShell：Add-Type 编译 C# 要几百毫秒，但看画面的间隔是分钟级，
 * 不值得为它常驻进程（前台窗口采集器 tracker-window.ts 才是常驻的）。
 */
import { mkdir, rm } from 'node:fs/promises'

import { capturePreamble, CaptureError, captureErrorCode, captureErrorText, parseCaptureOutput, psString, runPowerShell, windowTargetHead, type CaptureErrorCode, type PowerShellRunner } from './capture.ts'

export interface WindowInfo {
  pid: number
  proc: string
  title: string
  w: number
  h: number
}

/** 列出当前可见的顶层窗口（有标题、客户区够大的），给"选一个她看的窗口"用。 */
const LIST_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class GamingWindows {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  public static List<string> List() {
    var outList = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      int n = GetWindowText(h, sb, 512);
      string title = sb.ToString().Trim();
      if (n <= 0 || title.Length == 0) return true;
      RECT r, c;
      if (!GetWindowRect(h, out r)) return true;
      if (!GetClientRect(h, out c)) return true;
      int w = c.R - c.L, hh = c.B - c.T;
      if (w < 160 || hh < 120) return true;
      int pid = 0;
      GetWindowThreadProcessId(h, out pid);
      string proc = "";
      try { proc = System.Diagnostics.Process.GetProcessById(pid).ProcessName; } catch { return true; }
      if (proc == "explorer" || proc == "SystemSettings") return true;
      outList.Add(pid + "\t" + proc + "\t" + w + "\t" + hh + "\t" + title);
      return true;
    }, IntPtr.Zero);
    return outList;
  }
}
"@
[GamingWindows]::List() | ForEach-Object { Write-Output $_ }
`;



/**
 * 连抓 N 帧并输出 dHash/亮度。与单帧共用进程、标题和前台约束。
 */
const HASH_SOURCE = String.raw`
public static class HashUtil {
  public static string Dhash(System.Drawing.Bitmap bmp) {
    var small = new System.Drawing.Bitmap(9, 8);
    using (var g = System.Drawing.Graphics.FromImage(small)) {
      g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
      g.DrawImage(bmp, 0, 0, 9, 8);
    }
    var cells = new double[72];
    for (int y = 0; y < 8; y++) {
      for (int x = 0; x < 9; x++) {
        System.Drawing.Color c = small.GetPixel(x, y);
        cells[y * 9 + x] = 0.299 * c.R + 0.587 * c.G + 0.114 * c.B;
      }
    }
    small.Dispose();
    var sb = new System.Text.StringBuilder(16);
    for (int y = 0; y < 8; y++) {
      int hi = 0, lo = 0;
      for (int x = 0; x < 4; x++) hi = (hi << 1) | (cells[y * 9 + x] > cells[y * 9 + x + 1] ? 1 : 0);
      for (int x = 4; x < 8; x++) lo = (lo << 1) | (cells[y * 9 + x] > cells[y * 9 + x + 1] ? 1 : 0);
      sb.Append(hi.ToString("x")).Append(lo.ToString("x"));
    }
    return sb.ToString();
  }

  public static double Luma(System.Drawing.Bitmap bmp) {
    var small = new System.Drawing.Bitmap(9, 8);
    using (var g = System.Drawing.Graphics.FromImage(small)) {
      g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
      g.DrawImage(bmp, 0, 0, 9, 8);
    }
    double s = 0;
    for (int y = 0; y < 8; y++) for (int x = 0; x < 9; x++) { System.Drawing.Color c = small.GetPixel(x, y); s += 0.299 * c.R + 0.587 * c.G + 0.114 * c.B; }
    small.Dispose();
    return s / 72.0;
  }

  public static System.Drawing.Bitmap Scale(System.Drawing.Bitmap src, int maxWidth) {
    if (maxWidth <= 0 || src.Width <= maxWidth) return new System.Drawing.Bitmap(src);
    int w = maxWidth, h = (int)System.Math.Round(src.Height * (double)maxWidth / src.Width);
    var outBmp = new System.Drawing.Bitmap(w, h);
    using (var g = System.Drawing.Graphics.FromImage(outBmp)) {
      g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
      g.DrawImage(src, 0, 0, w, h);
    }
    return outBmp;
  }
}
`
export const MULTI_SCRIPT = `${capturePreamble(HASH_SOURCE)}
try {
  $h = [GamingCapture]::FindWindow($WindowProcess,$WindowTitle)
  $frameList = @()
  for ($i=1; $i -le $FrameCount; $i++) {
    $result = [GamingCapture]::Capture($h,$RequireForeground)
    if ($null -eq $result.Image) {
      Write-Output (@{ok=$false;frames=@();code=$result.Code} | ConvertTo-Json -Compress)
      exit 0
    }
    try {
      $bmp = $result.Image
      $hash = [HashUtil]::Dhash($bmp)
      $luma = [HashUtil]::Luma($bmp)
      $scaled = [GamingCapture]::Scale($bmp,$MaxWidth)
      $file = Join-Path $FramesDir ('f' + $i + '.png')
      try { $scaled.Save($file,[System.Drawing.Imaging.ImageFormat]::Png) } finally { $scaled.Dispose() }
      $frameList += @{file=$file;t=[DateTimeOffset]::Now.ToUnixTimeMilliseconds();hash=$hash;luma=$luma;method=$result.Method}
    } finally { $result.Image.Dispose() }
    if ($i -lt $FrameCount) { Start-Sleep -Milliseconds $IntervalMs }
  }
  Write-Output (@{ok=$true;frames=@($frameList)} | ConvertTo-Json -Compress -Depth 5)
} catch { Write-Output '{"ok":false,"frames":[],"code":"CAPTURE_FAIL"}' }
`

/** 已抓取帧的离线拼图，不会访问屏幕。 */
const COMPOSE_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$files = @($Files)
$n = $files.Count
if ($n -eq 0) { Write-Output '{"ok":false,"error":"没有帧"}'; exit 0 }
$cols = if ($n -le 1) { 1 } elseif ($n -eq 2) { 2 } elseif ($n -le 4) { 2 } elseif ($n -le 6) { 3 } else { 3 }
$rows = [Math]::Ceiling($n / $cols)
$cellW = $CellWidth
$cellH = $CellHeight
$pad = 6
$labelH = 22
$W = $cols * $cellW + ($cols - 1) * $pad
$H = $rows * ($cellH + $labelH) + ($rows - 1) * $pad
$canvas = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($canvas)
$g.Clear([System.Drawing.Color]::Black)
$font = New-Object System.Drawing.Font 'Consolas', 12
$brush = [System.Drawing.Brushes]::White
for ($i = 0; $i -lt $n; $i++) {
  $img = [System.Drawing.Image]::FromFile($files[$i])
  $col = $i % $cols
  $row = [Math]::Floor($i / $cols)
  $x = $col * ($cellW + $pad)
  $y = $row * ($cellH + $labelH + $pad)
  $ratio = [Math]::Min($cellW / $img.Width, $cellH / $img.Height)
  $dw = [int]($img.Width * $ratio)
  $dh = [int]($img.Height * $ratio)
  $dx = $x + [int](($cellW - $dw) / 2)
  $dy = $y + $labelH + [int](($cellH - $dh) / 2)
  $g.DrawImage($img, $dx, $dy, $dw, $dh)
  $label = ($i + 1).ToString() + ' / ' + $n
  $g.DrawString($label, $font, $brush, $x + 4, $y + 2)
  $img.Dispose()
}
$g.Dispose()
$canvas.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$canvas.Dispose()
Write-Output ('{"ok":true,"width":' + $W + ',"height":' + $H + '}')


`;

function psEscape(s: string): string {
  return s.replace(/'/g, "''")
}

/** 列出可见窗口。给工具和控制台选窗口用。 */
export async function listVisibleWindows(timeoutMs = 15000): Promise<WindowInfo[]> {
  try {
    const out = await runPowerShell(LIST_SCRIPT, timeoutMs)
    const list: WindowInfo[] = []
    for (const line of out.split(/\r?\n/)) {
      const parts = line.split('\t')
      if (parts.length < 5) continue
      const pid = Number(parts[0])
      if (!Number.isFinite(pid)) continue
      list.push({ pid, proc: parts[1]!, w: Number(parts[2]) || 0, h: Number(parts[3]) || 0, title: parts.slice(4).join('\t') })
    }
    return list
  } catch {
    return []
  }
}

export interface CapturedFrame {
  file: string
  t: number
  hash: string
  luma: number
}

export interface MultiCaptureResult {
  ok: boolean
  frames: CapturedFrame[]
  error?: string
  code?: CaptureErrorCode
}

/** 连抓几帧。target 为进程，targetTitle 为标题；两项填写时同时匹配。 */
export async function captureFrames(opts: {
  proc: string; target: string; targetTitle?: string; frames: number; intervalMs: number
  maxWidth: number; outDir: string; timeoutMs: number
}, run: PowerShellRunner = runPowerShell): Promise<MultiCaptureResult> {
  try {
    await mkdir(opts.outDir, { recursive: true })
    const head = [windowTargetHead(opts), '$FramesDir = ' + psString(opts.outDir),
      '$FrameCount = ' + Math.max(1,Math.min(9,Math.round(opts.frames))),
      '$IntervalMs = ' + Math.max(0,Math.round(opts.intervalMs)),
      '$MaxWidth = ' + Math.max(0,Math.round(opts.maxWidth))].join('\n')
    const parsed = parseCaptureOutput(await run(head + '\n' + MULTI_SCRIPT,opts.timeoutMs))
    if (parsed.ok !== true) throw new CaptureError(captureErrorCode(parsed.code))
    const frames = parsed.frames
    if (!Array.isArray(frames) || !frames.length || frames.some(frame => !frame || typeof frame.file !== 'string' || typeof frame.hash !== 'string' || !Number.isFinite(frame.t) || !Number.isFinite(frame.luma))) throw new CaptureError('CAPTURE_FAIL')
    return { ok: true, frames }
  } catch (error) {
    const code = error instanceof CaptureError ? error.code : 'SCRIPT_FAIL'
    return { ok: false, frames: [], code, error: captureErrorText(code) }
  }
}

/** 把选中的帧拼成一张分镜网格。失败返回 false。 */
export async function composeStoryboard(opts: {
  files: string[]
  out: string
  cellWidth: number
  timeoutMs: number
}, run: PowerShellRunner = runPowerShell): Promise<boolean> {
  const files = opts.files.map((f) => "'" + psEscape(f) + "'").join(',')
  const head = [
    '$Files = @(' + files + ')',
    "$Out = '" + psEscape(opts.out) + "'",
    '$CellWidth = ' + Math.max(160, Math.round(opts.cellWidth)),
    '$CellHeight = ' + Math.max(120, Math.round(opts.cellWidth * 0.62)),
  ].join('\n')
  try {
    const out = (await run(head + '\n' + COMPOSE_SCRIPT, opts.timeoutMs)).trim()
    return out.includes('"ok":true')
  } catch {
    return false
  }
}

/** 从抓到的帧里挑几帧拼分镜：最新一帧必留，再挑差异最大的、避开近重复。 */
export function pickFrames(frames: CapturedFrame[], maxFrames: number): CapturedFrame[] {
  if (frames.length <= 1 || maxFrames <= 1) return frames.slice(-Math.max(1, maxFrames))
  const last = frames[frames.length - 1]!
  const picked: CapturedFrame[] = [last]
  const hashDist = (a: string, b: string): number => {
    let d = 0
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      let x = parseInt(a[i] ?? '0', 16) ^ parseInt(b[i] ?? '0', 16)
      while (x) { d += x & 1; x >>= 1 }
    }
    return d
  }
  const candidates = frames.slice(0, -1).filter((f) => f.luma > 6)
  candidates.sort((a, b) => {
    const da = Math.min(...picked.map((p) => hashDist(a.hash, p.hash)))
    const db = Math.min(...picked.map((p) => hashDist(b.hash, p.hash)))
    return db - da
  })
  for (const f of candidates) {
    if (picked.length >= maxFrames) break
    if (picked.some((p) => hashDist(p.hash, f.hash) < 8)) continue
    picked.push(f)
  }
  picked.sort((a, b) => a.t - b.t)
  return picked
}

export async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}
