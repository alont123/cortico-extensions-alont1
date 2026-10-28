/**
 * 手机世界：把 MuMu 模拟器当她自己的手机用。
 *
 * 全部走本机 adb（MuMu 自带 adb.exe）+ MuMuManager 启动/查询，不经过任何云服务。
 * 按主人要求：**手机里不给她做限制**，随便装、随便点；只保留「关机」这种显式动作。
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BlobInput, ToolDef, World } from 'cortico/core/types.ts';
import type { PhoneConfigSection } from './config.ts';
import { autoWebUi } from './panel.ts';
import { PHONE_DEFAULTS } from './config.ts';

const KEYMAP: Record<string, number> = {
  home: 3, back: 4, menu: 82, recent: 187, power: 26, wake: 224, sleep: 223,
  volume_up: 24, volume_down: 25, enter: 66, delete: 67, tab: 61, escape: 111,
  up: 19, down: 20, left: 21, right: 22,
};

export const PHONE_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  { name: 'phone_status', tags: ['read'],
    description: '看手机（MuMu 模拟器）在不在：开机没有、屏幕多大、电量多少。',
    parameters: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'phone_launch', tags: ['write'],
    description: '开手机。没开机就先开，等开机完成再返回；已经开着就直接返回状态。',
    parameters: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'phone_screenshot', tags: ['read'],
    description: '截一张手机屏幕给自己看（返回图片）。看 App 里现在是什么样、点了有没有反应都靠它。',
    parameters: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'phone_tap', tags: ['write'],
    description: '点一下屏幕某处。坐标来自 phone_screenshot（左上角原点）。',
    parameters: { type: 'object', additionalProperties: false, properties: { x: { type: 'integer' }, y: { type: 'integer' } }, required: ['x', 'y'] } },
  { name: 'phone_swipe', tags: ['write'],
    description: '在屏幕上滑一下（滑动/拖拽）。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      x1: { type: 'integer' }, y1: { type: 'integer' }, x2: { type: 'integer' }, y2: { type: 'integer' },
      ms: { type: 'integer', description: '滑多久，默认 300 毫秒。' },
    }, required: ['x1', 'y1', 'x2', 'y2'] } },
  { name: 'phone_text', tags: ['write'],
    description: '往输入框里打字：英文/数字走 input text；中文/日文等 Unicode 会自动切到 ADBKeyboard 打进去，打完再切回原来的输入法。',
    parameters: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'phone_key', tags: ['write'],
    description: '按一个键：home / back / menu / recent / power / wake / sleep / volume_up / volume_down / enter / up / down / left / right。',
    parameters: { type: 'object', additionalProperties: false, properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'phone_apps', tags: ['read'],
    description: '看看手机里装了哪些自己下的应用（包名）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'phone_open', tags: ['write'],
    description: '打开一个应用（给包名，phone_apps 里有）。',
    parameters: { type: 'object', additionalProperties: false, properties: { package: { type: 'string' } }, required: ['package'] } },
  { name: 'phone_sh', tags: ['write'],
    description: '在手机里直接跑一条 adb shell 命令（手机里没有限制，想干嘛都行）。',
    parameters: { type: 'object', additionalProperties: false, properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
  { name: 'phone_close', tags: ['write'],
    description: '把手机关掉（关模拟器）。一般不用关，除非要释放内存。',
    parameters: { type: 'object', additionalProperties: false, properties: {} } },
];

interface RunResult { stdout: string; stderr: string; code: number | null }

export class PhoneWorld implements World {
  readonly id = 'phone';
  private readonly cfg: PhoneConfigSection;
  private readonly shotDir: string;
  private adbHost = '127.0.0.1';
  private adbPort = 0;

  constructor(opts: { cfg: PhoneConfigSection; botDir: string; dataDir?: string }) {
    this.cfg = opts.cfg;
    this.shotDir = join(opts.dataDir ?? join(opts.botDir, 'data'), 'phone', 'screenshots');
  }

  envPromptVars(): Record<string, string> {
    return { 'phone.dir': this.shotDir };
  }

  private bin(name: string): string {
    if (!this.cfg.mumuDir) throw new Error('没有配置 worlds.phone.mumuDir（MuMu 安装目录，里面有 MuMuManager.exe 和 adb.exe）');
    return join(this.cfg.mumuDir, name);
  }

  private run(file: string, args: string[], timeoutMs = 120000): Promise<{ buf: Buffer; stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve) => {
      execFile(file, args, { encoding: 'buffer', maxBuffer: 60 * 1024 * 1024, timeout: timeoutMs, windowsHide: true }, (err, stdoutBuf, stderrBuf) => {
        resolve({
          buf: stdoutBuf ?? Buffer.alloc(0),
          stdout: stdoutBuf?.toString('utf8') ?? '',
          stderr: stderrBuf?.toString('utf8') ?? '',
          code: err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : -1) : 0,
        });
      });
    });
  }

  private async manager(args: string[], timeoutMs = 120000): Promise<RunResult> {
    const r = await this.run(this.bin('MuMuManager.exe'), args, timeoutMs);
    return { stdout: r.stdout, stderr: r.stderr, code: r.code };
  }

  private async info(): Promise<Record<string, unknown> | null> {
    const r = await this.manager(['info', '-v', String(this.cfg.vmIndex)], 30000);
    try {
      const m = r.stdout.match(/\{[\s\S]*\}/);
      return m ? (JSON.parse(m[0]) as Record<string, unknown>) : null;
    } catch { return null; }
  }

  private async connect(): Promise<string | null> {
    const info = await this.info();
    const port = Number(info?.adb_port ?? 0);
    if (!port) return null;
    this.adbHost = String(info?.adb_host_ip ?? '127.0.0.1');
    this.adbPort = port;
    const target = this.adbHost + ':' + this.adbPort;
    await this.run(this.bin('adb.exe'), ['connect', target], 20000);
    const dev = await this.run(this.bin('adb.exe'), ['devices'], 20000);
    if (dev.stdout.includes(target + '\tdevice') || dev.stdout.includes(target + ' device')) return target;
    return null;
  }

  private async shell(cmd: string, timeoutMs = 60000): Promise<RunResult> {
    const target = await this.connect();
    if (!target) return { stdout: '', stderr: '手机还没开（phone_launch 开一下）', code: -1 };
    const r = await this.run(this.bin('adb.exe'), ['-s', target, 'shell', cmd], timeoutMs);
    return { stdout: r.stdout.trim(), stderr: r.stderr.trim(), code: r.code };
  }

  private async ensureOn(): Promise<{ ok: boolean; text: string }> {
    let info = await this.info();
    if (!info) return { ok: false, text: 'MuMuManager 读不到实例信息（路径或实例序号不对）' };
    if (info.is_android_started !== true) {
      await this.manager(['control', '-v', String(this.cfg.vmIndex), 'launch'], 60000);
      const deadline = Date.now() + this.cfg.bootTimeoutSec * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 4000));
        info = await this.info();
        if (info?.is_android_started === true) break;
      }
      if (info?.is_android_started !== true) return { ok: false, text: '等了 ' + this.cfg.bootTimeoutSec + ' 秒还没开机完成' };
    }
    const target = await this.connect();
    if (!target) return { ok: false, text: '开机了但 adb 连不上' };
    return { ok: true, text: target };
  }

  tools(): ToolDef[] {
    const status: ToolDef = { ...PHONE_TOOL_DECLS[0], tags: ['read'], handler: async () => {
      const info = await this.info();
      if (!info) return '读不到手机实例（检查 mumuDir / vmIndex）。';
      if (info.is_android_started !== true) return '手机现在是关机状态（phone_launch 能开）。';
      const target = await this.connect();
      if (!target) return '开机了，但 adb 没连上（再试一次 phone_status 或 phone_launch）。';
      const size = await this.shell('wm size');
      const battery = await this.shell('dumpsys battery | grep -E "level|status"');
      return '手机开着：' + target + '\n屏幕：' + (size.stdout || '?') + '\n' + (battery.stdout || '');
    } };

    const launch: ToolDef = { ...PHONE_TOOL_DECLS[1], tags: ['write'], handler: async () => {
      const r = await this.ensureOn();
      if (!r.ok) return '没开成：' + r.text;
      const size = await this.shell('wm size');
      return '手机开好了（' + r.text + '）。' + (size.stdout ? '屏幕 ' + size.stdout.replace('Physical size: ', '') : '');
    } };

    const screenshot: ToolDef = { ...PHONE_TOOL_DECLS[2], tags: ['read'], handler: async () => {
      const on = await this.ensureOn();
      if (!on.ok) return '手机不在：' + on.text;
      const target = on.text;
      const r = await this.run(this.bin('adb.exe'), ['-s', target, 'exec-out', 'screencap', '-p'], 60000);
      let buf = r.buf;
      if (buf.length < 1000) {
        mkdirSync(this.shotDir, { recursive: true });
        const tmp = join(this.shotDir, '_tmp.png');
        await this.shell('screencap -p /sdcard/_shot.png');
        await this.run(this.bin('adb.exe'), ['-s', target, 'pull', '/sdcard/_shot.png', tmp], 60000);
        buf = existsSync(tmp) ? readFileSync(tmp) : buf;
      }
      if (buf.length < 1000) return '截屏失败：' + (r.stderr || '没有拿到图');
      mkdirSync(this.shotDir, { recursive: true });
      const name = 'phone-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '.png';
      writeFileSync(join(this.shotDir, name), buf);
      const blob: BlobInput = { bytes: new Uint8Array(buf), mime: 'image/png', name, fallbackText: '[手机屏幕]' };
      return { text: '手机屏幕截好了，保存路径：' + join(this.shotDir, name) + '。', blobs: [blob] } as never;
    } };

    const tap: ToolDef = { ...PHONE_TOOL_DECLS[3], tags: ['write'], handler: async (args) => {
      const x = Math.round(Number(args.x)); const y = Math.round(Number(args.y));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return '坐标呢？x、y 都要给。';
      const r = await this.shell('input tap ' + x + ' ' + y);
      return r.code === 0 ? '点了 (' + x + ',' + y + ')。' : '点失败：' + (r.stderr || r.stdout);
    } };

    const swipe: ToolDef = { ...PHONE_TOOL_DECLS[4], tags: ['write'], handler: async (args) => {
      const x1 = Math.round(Number(args.x1)); const y1 = Math.round(Number(args.y1));
      const x2 = Math.round(Number(args.x2)); const y2 = Math.round(Number(args.y2));
      const ms = Math.round(Number(args.ms ?? 300));
      const r = await this.shell('input swipe ' + x1 + ' ' + y1 + ' ' + x2 + ' ' + y2 + ' ' + ms);
      return r.code === 0 ? '滑了 (' + x1 + ',' + y1 + ') → (' + x2 + ',' + y2 + ')。' : '滑失败：' + (r.stderr || r.stdout);
    } };

    const text: ToolDef = { ...PHONE_TOOL_DECLS[5], tags: ['write'], handler: async (args) => {
      const t = String(args.text ?? '');
      if (!t) return '打什么字？';
      const ascii = /^[\x20-\x7e]*$/.test(t);
      if (ascii) {
        const cleaned = t.replace(/[\\"'$]/g, '');
        const r = await this.shell('input text "' + cleaned + '"');
        return r.code === 0 ? '打进去了：' + t : '打失败：' + (r.stderr || r.stdout);
      }
      // 非 ASCII：临时切 ADBKeyboard，广播 base64，再把原输入法切回去
      const imeList = await this.shell('ime list -s');
      if (!imeList.stdout.includes('com.android.adbkeyboard/.AdbIME')) {
        return '中文输入需要 ADBKeyboard（这台手机上没装/没启用）。可以用 phone_sh 装一下。';
      }
      const prev = (await this.shell('settings get secure default_input_method')).stdout.trim();
      await this.shell('ime set com.android.adbkeyboard/.AdbIME');
      await new Promise((r) => setTimeout(r, 400));
      const b64 = Buffer.from(t, 'utf8').toString('base64');
      const r = await this.shell('am broadcast -a ADB_INPUT_B64 --es msg ' + b64);
      await new Promise((r) => setTimeout(r, 400));
      if (prev && prev !== 'com.android.adbkeyboard/.AdbIME') await this.shell('ime set ' + prev);
      return /Broadcast completed/.test(r.stdout) ? '打进去了：' + t : '打失败：' + (r.stdout || r.stderr);
    } };
    const key: ToolDef = { ...PHONE_TOOL_DECLS[6], tags: ['write'], handler: async (args) => {
      const k = String(args.key ?? '').trim();
      const code = KEYMAP[k] ?? (Number.isFinite(Number(k)) ? Number(k) : null);
      if (code == null) return '不认识的键：' + k + '。能按：' + Object.keys(KEYMAP).join(' / ');
      const r = await this.shell('input keyevent ' + code);
      return r.code === 0 ? '按了 ' + k + '。' : '按失败：' + (r.stderr || r.stdout);
    } };

    const apps: ToolDef = { ...PHONE_TOOL_DECLS[7], tags: ['read'], handler: async () => {
      const r = await this.shell('pm list packages -3');
      if (r.code !== 0) return '看不了：' + (r.stderr || r.stdout);
      const list = r.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.replace(/^package:/, ''));
      return list.length ? '手机里自己下的应用：\n' + list.join('\n') : '还没装什么应用。';
    } };

    const open: ToolDef = { ...PHONE_TOOL_DECLS[8], tags: ['write'], handler: async (args) => {
      const pkg = String(args.package ?? '').trim();
      if (!pkg) return '给个包名（phone_apps 里能看）。';
      const r = await this.shell('monkey -p ' + pkg + ' -c android.intent.category.LAUNCHER 1');
      return /Events injected/.test(r.stdout) || r.code === 0 ? '打开 ' + pkg + ' 了。' : '打不开：' + (r.stdout || r.stderr);
    } };

    const sh: ToolDef = { ...PHONE_TOOL_DECLS[9], tags: ['write'], handler: async (args) => {
      const cmd = String(args.cmd ?? '').trim();
      if (!cmd) return '跑什么命令？';
      const r = await this.shell(cmd, 120000);
      return (r.stdout || r.stderr || '（没有输出）').slice(0, 4000);
    } };

    const close: ToolDef = { ...PHONE_TOOL_DECLS[10], tags: ['write'], handler: async () => {
      const r = await this.manager(['control', '-v', String(this.cfg.vmIndex), 'shutdown'], 60000);
      return r.code === 0 ? '手机关了。' : '关失败：' + r.stderr;
    } };

    return [status, launch, screenshot, tap, swipe, text, key, apps, open, sh, close];
  }

  webUi() {
    return autoWebUi('phone', '手机', PHONE_DEFAULTS)
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}
