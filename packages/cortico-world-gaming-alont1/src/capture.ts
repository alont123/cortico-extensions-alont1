/** 单帧和分镜共用窗口选择、客户区裁剪及屏幕兜底边界。 */
import { execFile } from 'node:child_process'
import { normalizeProcess } from './proc.ts'

const ERROR_TEXT = {
  NOHWND: '没找到指定窗口（可能没开或还在启动）',
  MINIMIZED: '窗口最小化了，抓不到画面',
  NOT_FOREGROUND: '目标窗口不在前台，这拍抓不到画面',
  CAPTURE_FAIL: '窗口抓不出有效画面',
  CAPTURE_TIMEOUT: '抓图超时，请稍后再试',
  SCRIPT_FAIL: '抓图程序执行失败，请检查本机抓图环境',
} as const
export type CaptureErrorCode = keyof typeof ERROR_TEXT
export const captureErrorText = (code: CaptureErrorCode): string => ERROR_TEXT[code]
export function captureErrorCode(value: unknown): CaptureErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_TEXT, value) ? value as CaptureErrorCode : 'CAPTURE_FAIL'
}
export class CaptureError extends Error {
  constructor(readonly code: CaptureErrorCode) { super(captureErrorText(code)) }
}
export type PowerShellRunner = (script: string, timeoutMs: number) => Promise<string>
export const runPowerShell: PowerShellRunner = (script, timeoutMs) => new Promise((resolve, reject) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  }, (error, stdout) => {
    if (error) { reject(new CaptureError(error.killed || error.code === 'ETIMEDOUT' ? 'CAPTURE_TIMEOUT' : 'SCRIPT_FAIL')); return }
    resolve(String(stdout ?? ''))
  })
})
export const psString = (value: string): string => "'" + value.replace(/'/g, "''") + "'"
export interface WindowTarget { proc: string; target?: string; targetTitle?: string }
export function windowTargetHead(opts: WindowTarget): string {
  const target = normalizeProcess(opts.target), title = (opts.targetTitle ?? '').trim()
  const pinned = Boolean(target || title)
  return [
    '$WindowProcess = ' + psString(target || (title ? '' : normalizeProcess(opts.proc))),
    '$WindowTitle = ' + psString(title),
    '$RequireForeground = ' + (pinned ? '$false' : '$true'),
  ].join('\n')
}

export const WINDOW_CAPTURE_SOURCE = String.raw`
using System;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public class GamingCaptureResult {
  public Bitmap Image;
  public string Code;
  public string Method;
}
public static class GamingCapture {
  public delegate bool EnumProc(IntPtr h, IntPtr parameter);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct PLACEMENT { public int Length, Flags, Show; public POINT Min, Max; public RECT Normal; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref PLACEMENT placement);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT point);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static string NormalizeProcess(string value) {
    string name = (value ?? "").Trim();
    while (name.Length >= 2 && ((name[0] == '"' && name[name.Length-1] == '"') || (name[0] == '\'' && name[name.Length-1] == '\''))) name = name.Substring(1, name.Length-2).Trim();
    if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length-4).Trim();
    return name.ToLowerInvariant();
  }
  // 标题只匹配标题；两项同时填写必须同时满足。
  // 最小化窗口用恢复前面积，避免主窗最小化后偷偷改选同名小窗。
  public static IntPtr FindWindow(string process, string title) {
    string wanted = NormalizeProcess(process), keyword = (title ?? "").Trim();
    if (wanted.Length == 0 && keyword.Length == 0) return IntPtr.Zero;
    IntPtr selected = IntPtr.Zero;
    long largest = -1;
    EnumWindows(delegate(IntPtr h, IntPtr parameter) {
      if (!IsWindowVisible(h)) return true;
      int pid;
      GetWindowThreadProcessId(h, out pid);
      if (wanted.Length > 0) {
        try { if (NormalizeProcess(System.Diagnostics.Process.GetProcessById(pid).ProcessName) != wanted) return true; }
        catch { return true; }
      }
      if (keyword.Length > 0) {
        StringBuilder text = new StringBuilder(2048);
        GetWindowText(h, text, text.Capacity);
        if (text.ToString().IndexOf(keyword, StringComparison.OrdinalIgnoreCase) < 0) return true;
      }
      RECT bounds;
      if (IsIconic(h)) {
        PLACEMENT placement = new PLACEMENT();
        placement.Length = Marshal.SizeOf(typeof(PLACEMENT));
        if (!GetWindowPlacement(h,ref placement)) return true;
        bounds=placement.Normal;
      } else if (!GetWindowRect(h,out bounds)) return true;
      long area = Math.Max(0,bounds.R-bounds.L) * (long)Math.Max(0,bounds.B-bounds.T);
      if (area > largest) { largest = area; selected = h; }
      return true;
    }, IntPtr.Zero);
    return selected;
  }
  private static GamingCaptureResult Fail(string code) { return new GamingCaptureResult { Code=code }; }
  private static string StateError(IntPtr h, bool foreground) {
    if (h == IntPtr.Zero || !IsWindowVisible(h)) return "NOHWND";
    if (IsIconic(h)) return "MINIMIZED";
    if (foreground && GetForegroundWindow() != h) return "NOT_FOREGROUND";
    return null;
  }
  private static bool Blank(Bitmap image) {
    using (Bitmap small = new Bitmap(16,16)) {
      using (Graphics g = Graphics.FromImage(small)) { g.DrawImage(image,0,0,16,16); }
      int black=0, white=0;
      for (int y=0; y<16; y++) for (int x=0; x<16; x++) {
        Color c = small.GetPixel(x,y);
        if (c.R<10 && c.G<10 && c.B<10) black++;
        if (c.R>245 && c.G>245 && c.B>245) white++;
      }
      return black>=250 || white>=250;
    }
  }
  public static Bitmap Scale(Bitmap image, int maxWidth) {
    if (maxWidth<=0 || image.Width<=maxWidth) return new Bitmap(image);
    int height = Math.Max(1,(int)Math.Round(image.Height*(double)maxWidth/image.Width));
    Bitmap scaled = new Bitmap(maxWidth,height);
    using (Graphics g = Graphics.FromImage(scaled)) {
      g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
      g.DrawImage(image,0,0,maxWidth,height);
    }
    return scaled;
  }
  public static GamingCaptureResult Capture(IntPtr h, bool requireForeground) {
    string error = StateError(h,requireForeground);
    if (error!=null) return Fail(error);
    Bitmap image=null;
    try {
      RECT window,client;
      POINT origin = new POINT();
      if (!GetWindowRect(h,out window) || !GetClientRect(h,out client) || !ClientToScreen(h,ref origin)) return Fail("CAPTURE_FAIL");
      int w=client.R-client.L, height=client.B-client.T;
      int ww=window.R-window.L, wh=window.B-window.T;
      int dx=origin.X-window.L, dy=origin.Y-window.T;
      if (w<=0 || height<=0 || ww<=0 || wh<=0 || (long)ww*wh>100000000 || dx<0 || dy<0 || dx+w>ww || dy+height>wh) return Fail("CAPTURE_FAIL");
      using (Bitmap full = new Bitmap(ww,wh,PixelFormat.Format32bppArgb)) {
        bool printed;
        using (Graphics g = Graphics.FromImage(full)) {
          IntPtr dc = g.GetHdc();
          try { printed=PrintWindow(h,dc,2); } finally { g.ReleaseHdc(dc); }
        }
        if (printed) image=full.Clone(new Rectangle(dx,dy,w,height),PixelFormat.Format32bppArgb);
      }
      error=StateError(h,requireForeground);
      if (error!=null) { if (image!=null) image.Dispose(); return Fail(error); }
      // 检查裁过的客户区，标题栏有颜色不能证明游戏客户区有效。
      if (image!=null && !Blank(image)) return new GamingCaptureResult { Image=image,Method="PrintWindow" };
      if (image!=null) { image.Dispose(); image=null; }
      // 屏幕兜底前后检查同一个 hwnd，切走/最小化/移动的帧一律丢弃。
      error=StateError(h,true);
      if (error!=null) return Fail(error);
      image=new Bitmap(w,height,PixelFormat.Format32bppArgb);
      using (Graphics g = Graphics.FromImage(image)) { g.CopyFromScreen(origin.X,origin.Y,0,0,new Size(w,height),CopyPixelOperation.SourceCopy); }
      error=StateError(h,true);
      RECT after;
      POINT position=new POINT();
      if (error!=null || !GetClientRect(h,out after) || !ClientToScreen(h,ref position) || position.X!=origin.X || position.Y!=origin.Y || after.R-after.L!=w || after.B-after.T!=height || Blank(image)) {
        image.Dispose(); image=null; return Fail(error ?? "CAPTURE_FAIL");
      }
      return new GamingCaptureResult { Image=image,Method="FromScreen" };
    } catch { if (image!=null) image.Dispose(); return Fail("CAPTURE_FAIL"); }
  }
}
`
export const capturePreamble = (extraSource = ''): string => `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$gamingCaptureSource = @'
${WINDOW_CAPTURE_SOURCE}
${extraSource}
'@
Add-Type -TypeDefinition $gamingCaptureSource -ReferencedAssemblies System.Drawing
[void][GamingCapture]::SetProcessDPIAware()
`
export const CAPTURE_PREAMBLE = capturePreamble()
export const SINGLE_CAPTURE_SCRIPT = `${CAPTURE_PREAMBLE}
try {
  $h = [GamingCapture]::FindWindow($WindowProcess,$WindowTitle)
  $result = [GamingCapture]::Capture($h,$RequireForeground)
  if ($null -eq $result.Image) { Write-Output (@{ok=$false;code=$result.Code} | ConvertTo-Json -Compress); exit 0 }
  try {
    $scaled = [GamingCapture]::Scale($result.Image,$MaxWidth)
    try { $scaled.Save($Out,[System.Drawing.Imaging.ImageFormat]::Png) } finally { $scaled.Dispose() }
    Write-Output (@{ok=$true;method=$result.Method;width=$result.Image.Width;height=$result.Image.Height} | ConvertTo-Json -Compress)
  } finally { $result.Image.Dispose() }
} catch { Write-Output '{"ok":false,"code":"CAPTURE_FAIL"}' }
`
export function parseCaptureOutput(output: string): Record<string, unknown> {
  try {
    const line=output.trim().split(/\r?\n/).reverse().find(line => line.trim().startsWith('{'))
    const parsed: unknown=JSON.parse(line ?? '')
    if (parsed && typeof parsed==='object' && !Array.isArray(parsed)) return parsed as Record<string,unknown>
  } catch { /* 只接受结构化结果，绝不回传脚本输出。 */ }
  throw new CaptureError('SCRIPT_FAIL')
}
export async function captureWindow(opts: WindowTarget & { file: string; maxWidth: number; timeoutMs: number }, run = runPowerShell): Promise<void> {
  const head=windowTargetHead(opts)+'\n$Out = '+psString(opts.file)+'\n$MaxWidth = '+Math.max(0,Math.round(opts.maxWidth))
  const result=parseCaptureOutput(await run(head+'\n'+SINGLE_CAPTURE_SCRIPT,opts.timeoutMs))
  if (result.ok!==true) throw new CaptureError(captureErrorCode(result.code))
}
