/**
 * 引擎后端：用 PowerShell 调 Win32（替代 koffi 原生绑定）。
 *
 * 为什么换：koffi 需要现场用 CMake + MSVC 编译，这台机器上编不出来
 * （CMake 4.1 与 VS 2022 BuildTools 的 configure 直接崩）。PowerShell 自带 .NET，
 * 能调同一套 Win32，不需要任何构建步骤；代价是每次调用几十毫秒。
 *
 * 做法：常驻一个 PowerShell 进程，启动时 Add-Type 一次 C# 垫片（并声明 DPI 感知），
 * 之后按行收发 base64 JSON。进程死了下次调用自动拉起。
 * 对外接口与 win32.ts 完全一致，所以 engine-child.ts 只换 import。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WindowInfo } from '../engine-ipc.ts';

export type { WindowInfo };

const PS_SCRIPT = "$ErrorActionPreference = 'Stop'\n[Console]::InputEncoding = [System.Text.Encoding]::UTF8\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n# flush explicitly after every response\n\n$csharp = @'\nusing System;\nusing System.Text;\nusing System.Runtime.InteropServices;\nusing System.Collections.Generic;\nusing System.Drawing;\nusing System.Drawing.Imaging;\n\npublic class CuaHost {\n  public const uint GW_HWNDNEXT = 2;\n  public const int SW_RESTORE = 9;\n\n  [DllImport(\"user32.dll\")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);\n  [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();\n  [DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int i);\n  [DllImport(\"user32.dll\")] public static extern uint GetDpiForSystem();\n  [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x, int y);\n  [DllImport(\"user32.dll\")] public static extern bool GetCursorPos(out POINT p);\n  [DllImport(\"user32.dll\")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO li);\n  [DllImport(\"kernel32.dll\")] public static extern ulong GetTickCount64();\n  [DllImport(\"user32.dll\")] public static extern uint SendInput(uint n, INPUT[] e, int size);\n  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();\n  [DllImport(\"user32.dll\")] public static extern IntPtr GetTopWindow(IntPtr h);\n  [DllImport(\"user32.dll\")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);\n  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);\n  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr h);\n  [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h);\n  [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr h, out RECT r);\n  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);\n  [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int cmd);\n  [DllImport(\"user32.dll\")] public static extern IntPtr GetDC(IntPtr h);\n  [DllImport(\"user32.dll\")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);\n  [DllImport(\"gdi32.dll\")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);\n  [DllImport(\"gdi32.dll\")] public static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);\n  [DllImport(\"gdi32.dll\")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);\n  [DllImport(\"gdi32.dll\")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);\n  [DllImport(\"gdi32.dll\")] public static extern int GetDIBits(IntPtr dc, IntPtr bmp, uint start, uint lines, byte[] bits, ref BITMAPINFOHEADER bi, uint usage);\n  [DllImport(\"gdi32.dll\")] public static extern bool DeleteDC(IntPtr dc);\n  [DllImport(\"gdi32.dll\")] public static extern bool DeleteObject(IntPtr o);\n  [DllImport(\"gdi32.dll\")] public static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFOHEADER pbmi, uint usage, out IntPtr bits, IntPtr section, uint offset);\n\n  [StructLayout(LayoutKind.Sequential)]\n  public struct BITMAPINFOHEADER {\n    public uint biSize;\n    public int biWidth;\n    public int biHeight;\n    public ushort biPlanes;\n    public ushort biBitCount;\n    public uint biCompression;\n    public uint biSizeImage;\n    public int biXPelsPerMeter;\n    public int biYPelsPerMeter;\n    public uint biClrUsed;\n    public uint biClrImportant;\n  }\n  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }\n  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left; public int top; public int right; public int bottom; }\n  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }\n  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }\n  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }\n  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }\n  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }\n\n  public static void NoDpi() { }\n  public static void Init() {\n    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); return; } catch {}\n    try { SetProcessDPIAware(); } catch {}\n  }\n  public static int[] ScreenInfo() {\n    return new int[] { GetSystemMetrics(0), GetSystemMetrics(1), (int)GetDpiForSystem() };\n  }\n  public static int[] Cursor() {\n    POINT p;\n    if (!GetCursorPos(out p)) return new int[] { 0, 0 };\n    return new int[] { p.x, p.y };\n  }\n  public static uint Idle() {\n    LASTINPUTINFO li = new LASTINPUTINFO();\n    li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));\n    if (!GetLastInputInfo(ref li)) return uint.MaxValue;\n    return (uint)(GetTickCount64() - li.dwTime);\n  }\n  public static void Move(int x, int y) {\n    if (!SetCursorPos(x, y)) throw new Exception(\"SetCursorPos failed\");\n  }\n  static INPUT MouseEv(uint flags) {\n    INPUT e = new INPUT();\n    e.type = 0;\n    e.u.mi.dwFlags = flags;\n    return e;\n  }\n  static void Send(INPUT[] evs) {\n    uint n = SendInput((uint)evs.Length, evs, Marshal.SizeOf(typeof(INPUT)));\n    if (n != (uint)evs.Length) throw new Exception(\"SendInput only delivered \" + n + \"/\" + evs.Length);\n  }\n  public static void Mouse(uint down, uint up, int count) {\n    List<INPUT> list = new List<INPUT>();\n    for (int i = 0; i < Math.Max(1, count); i++) { list.Add(MouseEv(down)); list.Add(MouseEv(up)); }\n    Send(list.ToArray());\n  }\n  public static void MouseOne(uint flags) {\n    Send(new INPUT[] { MouseEv(flags) });\n  }\n  public static void Wheel(int delta) {\n    INPUT e = new INPUT();\n    e.type = 0;\n    e.u.mi.dwFlags = 0x0800;\n    e.u.mi.mouseData = (uint)(delta * 120);\n    Send(new INPUT[] { e });\n  }\n  public static void TypeUnicode(string text) {\n    List<INPUT> list = new List<INPUT>();\n    foreach (char c in text) {\n      INPUT d = new INPUT(); d.type = 1; d.u.ki.dwFlags = 0x0004; d.u.ki.wScan = (ushort)c; list.Add(d);\n      INPUT u = new INPUT(); u.type = 1; u.u.ki.dwFlags = 0x0004 | 0x0002; u.u.ki.wScan = (ushort)c; list.Add(u);\n    }\n    Send(list.ToArray());\n  }\n  public static void Keys(int[] vks) {\n    List<INPUT> list = new List<INPUT>();\n    for (int i = 0; i < vks.Length; i++) {\n      INPUT d = new INPUT(); d.type = 1; d.u.ki.wVk = (ushort)vks[i]; list.Add(d);\n    }\n    for (int i = vks.Length - 1; i >= 0; i--) {\n      INPUT u = new INPUT(); u.type = 1; u.u.ki.wVk = (ushort)vks[i]; u.u.ki.dwFlags = 0x0002; list.Add(u);\n    }\n    Send(list.ToArray());\n  }\n  public static object[] Windows() {\n    List<object> outl = new List<object>();\n    IntPtr fg = GetForegroundWindow();\n    IntPtr h = GetTopWindow(IntPtr.Zero);\n    StringBuilder sb = new StringBuilder(512);\n    int guard = 0;\n    while (h != IntPtr.Zero && guard++ < 4000) {\n      if (IsWindowVisible(h)) {\n        sb.Length = 0;\n        int len = GetWindowText(h, sb, 512);\n        string title = len > 0 ? sb.ToString() : \"\";\n        if (title.Trim().Length > 0) {\n          RECT r;\n          GetWindowRect(h, out r);\n          outl.Add(new object[] { title, r.left, r.top, Math.Max(0, r.right - r.left), Math.Max(0, r.bottom - r.top), IsIconic(h), h == fg });\n        }\n      }\n      h = GetWindow(h, GW_HWNDNEXT);\n    }\n    return outl.ToArray();\n  }\n  // 整屏截图：BitBlt 到兼容位图，然后直接从位图存 BMP。\n  // 两个坑都记着：1) 绝不能带 CAPTUREBLT（这台机器上会返回花屏）；\n  // 2) 别自己取原始像素再交给 Node 解释，走 System.Drawing 存文件才稳。\n  public static int[] CaptureToBmp(string path) {\n    int w = GetSystemMetrics(0);\n    int h = GetSystemMetrics(1);\n    IntPtr screen = GetDC(IntPtr.Zero);\n    IntPtr mem = CreateCompatibleDC(screen);\n    IntPtr bmp = CreateCompatibleBitmap(screen, w, h);\n    IntPtr old = SelectObject(mem, bmp);\n    try {\n      if (!BitBlt(mem, 0, 0, w, h, screen, 0, 0, 0x00CC0020)) throw new Exception(\"BitBlt failed\");\n    } finally {\n      SelectObject(mem, old);\n      DeleteDC(mem);\n      ReleaseDC(IntPtr.Zero, screen);\n    }\n    try {\n      using (Bitmap shot = Image.FromHbitmap(bmp)) {\n        shot.Save(path, ImageFormat.Bmp);\n        w = shot.Width;\n        h = shot.Height;\n      }\n    } finally { DeleteObject(bmp); }\n    return new int[] { w, h, 0 };\n  }\n  public static string Focus(string needle) {\n    string low = needle.ToLowerInvariant();\n    IntPtr fg = GetForegroundWindow();\n    IntPtr h = GetTopWindow(IntPtr.Zero);\n    StringBuilder sb = new StringBuilder(512);\n    int guard = 0;\n    while (h != IntPtr.Zero && guard++ < 4000) {\n      if (IsWindowVisible(h)) {\n        sb.Length = 0;\n        int len = GetWindowText(h, sb, 512);\n        string title = len > 0 ? sb.ToString() : \"\";\n        if (title.Length > 0 && title.ToLowerInvariant().Contains(low)) {\n          if (IsIconic(h)) ShowWindow(h, SW_RESTORE);\n          if (h != fg) SetForegroundWindow(h);\n          return title;\n        }\n      }\n      h = GetWindow(h, GW_HWNDNEXT);\n    }\n    return null;\n  }\n}\n'@\n\nAdd-Type -TypeDefinition $csharp -Language CSharp -ReferencedAssemblies System.Drawing\n[void][CuaHost]::Init()\n\n\n$buttons = @{ left = @(2, 4); right = @(8, 16); middle = @(32, 64) }\n\nfunction Invoke-Cua($cmd) {\n  switch ($cmd.op) {\n    'screen' { $s = [CuaHost]::ScreenInfo(); return @{ width = $s[0]; height = $s[1]; dpi = $s[2] } }\n    'shot' { $r = [CuaHost]::CaptureToBmp($cmd.path); return @{ width = $r[0]; height = $r[1] } }\n    'cursor' { $c = [CuaHost]::Cursor(); return @{ x = $c[0]; y = $c[1] } }\n    'idle' { return @{ ms = [double][CuaHost]::Idle() } }\n    'move' { [CuaHost]::Move([int]$cmd.x, [int]$cmd.y); return @{ done = $true } }\n    'click' {\n      $p = $buttons[$cmd.button]\n      if ($null -eq $p) { $p = $buttons['left'] }\n      [CuaHost]::Mouse([uint32]$p[0], [uint32]$p[1], [int]$cmd.clicks)\n      return @{ done = $true }\n    }\n    'down' {\n      $p = $buttons[$cmd.button]\n      if ($null -eq $p) { $p = $buttons['left'] }\n      [CuaHost]::MouseOne([uint32]$p[0])\n      return @{ done = $true }\n    }\n    'up' {\n      $p = $buttons[$cmd.button]\n      if ($null -eq $p) { $p = $buttons['left'] }\n      [CuaHost]::MouseOne([uint32]$p[1])\n      return @{ done = $true }\n    }\n    'scroll' { [CuaHost]::Wheel([int]$cmd.delta); return @{ done = $true } }\n    'type' { [CuaHost]::TypeUnicode([string]$cmd.text); return @{ done = $true } }\n    'keys' {\n      $vks = New-Object int[] $cmd.vks.Count\n      for ($i = 0; $i -lt $cmd.vks.Count; $i++) { $vks[$i] = [int]$cmd.vks[$i] }\n      [CuaHost]::Keys($vks)\n      return @{ done = $true }\n    }\n    'windows' { return [CuaHost]::Windows() }\n    'focus' { return @{ title = [CuaHost]::Focus([string]$cmd.title) } }\n    default { throw ('unknown op: ' + $cmd.op) }\n  }\n}\n\nwhile ($true) {\n  $line = [Console]::In.ReadLine()\n  if ($null -eq $line) { break }\n  if ($line.Length -eq 0) { continue }\n  $out = $null\n  try {\n    $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($line))\n    $cmd = $json | ConvertFrom-Json\n    if ($cmd.op -eq 'bye') {\n      $out = @{ ok = $true; result = @{ bye = $true } }\n    } else {\n      $out = @{ ok = $true; result = (Invoke-Cua $cmd) }\n    }\n  } catch {\n    $out = @{ ok = $false; error = [string]$_.Exception.Message }\n  }\n  $resp = ($out | ConvertTo-Json -Compress -Depth 8)\n  [Console]::Out.WriteLine([System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($resp)))\n  [Console]::Out.Flush()\n  if ($null -ne $cmd -and $cmd.op -eq 'bye') { break }\n}\n";

const PS_EXE = 'powershell.exe';
const START_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 20_000;

let workDir: string | null = null;
let scriptPath: string | null = null;
let child: ChildProcessWithoutNullStreams | null = null;
let stdoutBuf = '';
let stderrTail = '';
let shotSeq = 0;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}
const pending: Pending[] = [];

function ensureWorkDir(): string {
  if (workDir) return workDir;
  workDir = mkdtempSync(join(tmpdir(), 'cua-ps-'));
  scriptPath = join(workDir, 'cua-host.ps1');
  // Windows PowerShell 5.1 默认按 ANSI 读 .ps1，中文注释会变乱码；带 BOM 才会按 UTF-8 读。
  writeFileSync(scriptPath, '\uFEFF' + PS_SCRIPT, 'utf8');
  return workDir;
}

function failAllAll(message: string): void {
  const list = pending.splice(0, pending.length);
  for (const p of list) {
    clearTimeout(p.timer);
    p.reject(new Error(message));
  }
}

function onStdout(chunk: string): void {
  stdoutBuf += chunk;
  for (;;) {
    const idx = stdoutBuf.indexOf('\n');
    if (idx < 0) break;
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    const p = pending.shift();
    if (!p) continue;
    clearTimeout(p.timer);
    try {
      const text = Buffer.from(line, 'base64').toString('utf8');
      const msg = JSON.parse(text) as { ok: boolean; result?: unknown; error?: string };
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? 'engine error'));
    } catch (e) {
      p.reject(new Error('引擎回了个看不懂的包：' + String((e as Error)?.message ?? e)));
    }
  }
}

function ensureChild(): ChildProcessWithoutNullStreams {
  if (child && child.exitCode === null && !child.killed) return child;
  ensureWorkDir();
  stderrTail = '';
  stdoutBuf = '';
  child = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath as string], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', onStdout);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => {
    stderrTail = (stderrTail + d).slice(-4000);
  });
  child.on('exit', (code) => {
    child = null;
    failAllAll('PowerShell 引擎退出（code=' + String(code) + '）' + (stderrTail ? '：' + stderrTail.slice(-300) : ''));
  });
  child.on('error', (err) => {
    child = null;
    failAllAll('PowerShell 引擎起不来：' + String(err?.message ?? err));
  });
  return child;
}

function call<T>(cmd: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = ensureChild();
    } catch (e) {
      reject(e as Error);
      return;
    }
    const timer = setTimeout(() => {
      const i = pending.findIndex((x) => x.timer === timer);
      if (i >= 0) pending.splice(i, 1);
      reject(new Error('引擎超时 ' + timeoutMs + 'ms'));
    }, timeoutMs);
    pending.push({ resolve: resolve as (v: unknown) => void, reject, timer });
    const payload = Buffer.from(JSON.stringify(cmd), 'utf8').toString('base64');
    try {
      proc.stdin.write(payload + '\n');
    } catch (e) {
      clearTimeout(timer);
      const i = pending.findIndex((x) => x.timer === timer);
      if (i >= 0) pending.splice(i, 1);
      reject(new Error('往引擎写数据失败：' + String((e as Error)?.message ?? e)));
    }
  });
}

/** 必须在任何坐标/尺寸调用之前执行一次；DPI 感知在 PS 进程启动时已声明，这里只是接口对齐。 */
export function setDpiAware(): void {
  ensureChild();
}

export async function screenInfo(): Promise<{ width: number; height: number; dpi: number }> {
  return call<{ width: number; height: number; dpi: number }>({ op: 'screen' }, START_TIMEOUT_MS);
}

/**
 * 主屏整屏截图，返回 BGRA（自上而下）。
 *
 * 为什么让 PowerShell 存 BMP 而不是直接交原始像素：这台机器上「自己取像素再解释」会毁图
 * （HDR / 虚拟显示驱动的坑），走 `System.Drawing` 存文件才稳。BMP 是未压缩的，
 * 解析只比原始像素多两个头字段，代价可以忽略。
 */
export async function captureScreen(): Promise<{ bgra: Buffer; width: number; height: number }> {
  const dir = ensureWorkDir();
  const path = join(dir, 'shot-' + (++shotSeq) + '.bmp');
  try {
    await call<{ width: number; height: number }>({ op: 'shot', path }, START_TIMEOUT_MS);
    const raw = readFileSync(path);
    return decodeBmp(raw);
  } finally {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
}

/** 解析 24/32 位的未压缩 BMP，统一成自上而下的 BGRA。 */
function decodeBmp(raw: Buffer): { bgra: Buffer; width: number; height: number } {
  if (raw.length < 54 || raw[0] !== 0x42 || raw[1] !== 0x4d) throw new Error('不是 BMP：' + raw.slice(0, 2).toString('hex'));
  const offset = raw.readUInt32LE(10);
  const width = raw.readInt32LE(18);
  const rawH = raw.readInt32LE(22);
  const bpp = raw.readUInt16LE(28);
  const compression = raw.readUInt32LE(30);
  if (compression !== 0) throw new Error('BMP 有压缩（' + compression + '），不支持');
  if (bpp !== 24 && bpp !== 32) throw new Error('BMP 位深不支持：' + bpp);
  const height = Math.abs(rawH);
  const topDown = rawH < 0;
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcRow = offset + (topDown ? y : height - 1 - y) * rowSize;
    if (srcRow + rowSize > raw.length) throw new Error('BMP 数据不完整');
    let si = srcRow;
    let di = y * width * 4;
    for (let x = 0; x < width; x++) {
      out[di] = raw[si];
      out[di + 1] = raw[si + 1];
      out[di + 2] = raw[si + 2];
      out[di + 3] = bpp === 32 ? raw[si + 3] : 255;
      si += bpp >> 3;
      di += 4;
    }
  }
  return { bgra: out, width, height };
}

export async function cursorPos(): Promise<{ x: number; y: number }> {
  return call<{ x: number; y: number }>({ op: 'cursor' });
}

/** 距最后一次键鼠输入的毫秒数（越大说明用户越闲）。 */
export async function idleMs(): Promise<number> {
  const r = await call<{ ms: number }>({ op: 'idle' });
  const n = Number(r.ms);
  if (!Number.isFinite(n) || n >= 4294967295) return Number.MAX_SAFE_INTEGER;
  return n;
}

export async function moveTo(x: number, y: number): Promise<void> {
  await call({ op: 'move', x: Math.round(x), y: Math.round(y) });
}

export async function click(button: 'left' | 'right' | 'middle', clicks: number): Promise<void> {
  await call({ op: 'click', button, clicks: Math.max(1, Math.round(clicks)) });
}

/** 按下不放（拖拽用）。 */
export async function mouseDown(button: 'left' | 'right' | 'middle'): Promise<void> {
  await call({ op: 'down', button });
}

/** 抬起（拖拽用）。 */
export async function mouseUp(button: 'left' | 'right' | 'middle'): Promise<void> {
  await call({ op: 'up', button });
}

export async function scroll(delta: number): Promise<void> {
  await call({ op: 'scroll', delta: Math.round(delta) });
}

/** 任意语言：逐 UTF-16 单元发 unicode 键，与输入法状态无关。 */
export async function typeText(text: string): Promise<void> {
  if (!text) return;
  await call({ op: 'type', text });
}

const VK: Record<string, number> = {
  ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, win: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20,
  backspace: 0x08, delete: 0x2e, insert: 0x2d, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  capslock: 0x14, printscreen: 0x2c,
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf,
};
for (const c of 'abcdefghijklmnopqrstuvwxyz') VK[c] = c.toUpperCase().charCodeAt(0);

export async function pressKeys(keys: string[]): Promise<void> {
  for (const combo of keys) {
    const parts = combo.split('+').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const vks: number[] = [];
    for (const p of parts) {
      const vk = VK[p];
      if (!vk) throw new Error('不认识的键名：' + p);
      vks.push(vk);
    }
    if (!vks.length) continue;
    await call({ op: 'keys', vks });
  }
}

export async function listWindows(): Promise<WindowInfo[]> {
  const rows = await call<unknown[][]>({ op: 'windows' });
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    title: String(r[0] ?? ''),
    x: Number(r[1] ?? 0),
    y: Number(r[2] ?? 0),
    width: Number(r[3] ?? 0),
    height: Number(r[4] ?? 0),
    minimized: Boolean(r[5]),
    foreground: Boolean(r[6]),
  }));
}

export async function focusWindow(titlePart: string): Promise<string | null> {
  const r = await call<{ title: string | null }>({ op: 'focus', title: titlePart });
  const title = r?.title ?? null;
  if (!title) return null;
  // null 经过 ConvertTo-Json 会变成 $null，这里再兜一次。
  return String(title) === '' ? null : String(title);
}

/** 关掉常驻 PowerShell；引擎子进程退出时调用。 */
export function dispose(): void {
  const proc = child;
  child = null;
  failAllAll('引擎已关闭');
  if (!proc) return;
  try { proc.stdin.write(Buffer.from(JSON.stringify({ op: 'bye' }), 'utf8').toString('base64') + '\n'); } catch { /* ignore */ }
  try { proc.stdin.end(); } catch { /* ignore */ }
  const timer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 1500);
  timer.unref?.();
  proc.on('exit', () => clearTimeout(timer));
}
