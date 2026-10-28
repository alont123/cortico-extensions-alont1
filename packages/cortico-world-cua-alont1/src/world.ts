import { CUA_TOOL_DECLS } from './tool-decls.ts';
/**
 * 电脑操作 World：让 bot 看见并操作这台电脑的主屏幕。
 *
 * 设计上的三条线（学业界 CUA 的做法，自己实现）：
 * 1. **原生调用隔离在引擎子进程**：PowerShell/.NET 后端退出后由主进程重启；
 * 2. **与使用者共用这台电脑**：每次输入前问引擎"使用者闲了多久"，没闲够就不动手；
 * 3. **不可逆操作先问**：登录/密码/验证码/支付这类由提示词约束（ENV_PROMPT 里写明），
 *    框架不硬拦——这层是语义，不是网关。
 *
 * 权限只有一道硬门：`worlds.cua.allowInput`。关着时只有只读能力（截图/列窗口/等待）。
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { childExecArgv } from 'cortico/extensions/runtime.ts';
import type { Language } from 'cortico/core/language.ts';
import type { ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { CUA_CONFIG_GROUP, CUA_DEFAULTS, type CuaConfigSection } from './config.ts';
import type { ChildToMain, InputRequest, MainToChild, ShotResult, WindowInfo } from './engine-ipc.ts';

const CHILD_ENTRY = fileURLToPath(new URL('./engine-child.ts', import.meta.url));

export interface CuaWorldOptions {
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export class CuaWorld implements World {
  readonly id = 'cua';
  host: WorldHost | null = null;
  private readonly cfg: CuaConfigSection;
  private readonly opts: CuaWorldOptions;
  private child: ChildProcess | null = null;
  private ready = false;
  private stopping = false;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }>();
  private lastShot: ShotResult | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  // 自由玩与危险审批
  private freeUntil = 0;
  private freeSessionsToday = 0;
  private freeDay = '';
  private lastFreeNoticeAt = 0;
  private dangerSeq = 0;
  private readonly dangerPending = new Map<number, { label: string; run: () => Promise<void> }>();

  constructor(cfg: CuaConfigSection, opts: CuaWorldOptions = {}) {
    this.cfg = cfg;
    this.opts = opts;
  }

  envPromptVars(): Record<string, string> {
    const allow = this.cfg.allowInput;
    return {
      'cua.os': 'Windows',
      'cua.control': allow ? '可以点击、拖拽、滚动、打字、按键' : '**只能看**：截图、列窗口、等待；点击/打字这类操作被关掉了',
      'cua.shot': String(this.cfg.shot),
      'cua.idle': (this.cfg.idleMs / 1000).toFixed(1),
      'cua.keys': allow ? '组合键写法：ctrl+s、alt+tab、shift+enter；单键：enter/tab/esc/space/up/down/left/right/f1…f12。' : '',
      'cua.permission': allow
        ? '主人在配置里打开了「允许操作键鼠」。'
        : '主人没打开「允许操作键鼠」，你只能看不能动。',
      'cua.freeplay': !allow ? '（没开输入，谈不上自己玩）'
        : !this.cfg.freePlay.enabled ? '（没开「允许申请自己玩」）'
          : this.freeActive() ? '自由时间还剩 ' + this.freeLeftMin() + ' 分钟；危险动作仍会先问主人。'
            : '你可以用 cua_free_play 申请自己玩一段时间，要主人批准。',
    };
  }

  private freeActive(): boolean { return Date.now() < this.freeUntil; }
  private freeLeftMin(): number { return Math.max(0, Math.ceil((this.freeUntil - Date.now()) / 60_000)); }
  private today(): string { return new Date().toISOString().slice(0, 10); }

  /** 危险判定：窗口标题、输入内容、组合键。命中就返回一句说明（不执行）。 */
  private async dangerOf(action: { text?: string; keys?: string[] }): Promise<string | null> {
    if (!this.cfg.freePlay.enabled) return null;
    const keys = (action.keys ?? []).join(' ').toLowerCase();
    if (/delete/.test(keys) && /(ctrl|shift)/.test(keys)) return '组合键删除';
    if (/alt\+f4/.test(keys)) return '关闭窗口';
    if (action.text && /(密码|password|验证码|支付|转账|购买|下单|确认支付)/i.test(action.text)) return '输入里带敏感词';
    try {
      const list = (await this.rpc({ id: 0, op: 'windows' })) as WindowInfo[];
      const fg = list.find((w) => w.foreground);
      const t = (fg?.title ?? '').toLowerCase();
      if (/(支付|购买|订单|付费|password|密码|验证码|账户|设置|控制面板|删除|格式化|卸载|管理员|防火墙|微信|qq|邮件|登录|注册)/i.test(t)) return '前台窗口「' + (fg?.title ?? '').slice(0, 30) + '」';
    } catch { /* 拿不到窗口就不拦 */ }
    return null;
  }

  /** 危险动作：不执行，挂起来等主人回。 */
  private async askDanger(label: string, run: () => Promise<void>): Promise<ToolOutcome> {
    const id = ++this.dangerSeq;
    this.dangerPending.set(id, { label, run });
    try {
      await this.host?.pushEvent({
        type: 'cua.danger_request',
        ts: new Date().toISOString(),
        source: this.id,
        senderKey: this.id,
        text: '危险动作待确认：' + label + '（编号 ' + id + '）。先问主人；他说行之后你用 cua_danger_allow(' + id + ') 执行，说不行就用 cua_danger_deny(' + id + ')。',
        meta: { id, label },
      });
    } catch { /* 宿主不在时照样拒绝动作 */ }
    return { text: '这个动作越过了危险线（' + label + '），没有执行。挂起编号 ' + id + '：先在聊天里问主人，他同意后用 cua_danger_allow(' + id + ') 执行，不同意就 cua_danger_deny(' + id + ')。他没回之前别重试。' };
  }

  tools(): ToolDef[] {
    const inputDenied = '没开「允许操作键鼠」：现在只有只读能力（截图/列窗口/等待）。要动手让主人打开配置。';
    const withShot = async (): Promise<ToolOutcome> => {
      const s = await this.shot();
      return { text: '（附新截图）', blobs: [{ bytes: s.jpeg, mime: 'image/jpeg', name: 'screen.jpg', fallbackText: '[截图]' }] };
    };
    const shotOutcome = (s: ShotResult, note: string): ToolOutcome => ({
      text: note + '截图 ' + s.width + '×' + s.height + '（物理 ' + Math.round(s.width * s.scale) + '×' + Math.round(s.height * s.scale) + '）',
      blobs: [{ bytes: s.jpeg, mime: 'image/jpeg', name: 'screen.jpg', fallbackText: '[截图]' }],
    });

    const screenshot: ToolDef = {
      name: 'cua_screenshot',
      tags: ['read'],
      description: '截取主屏幕：返回缩放后的图片（画着光标位置）。所有工具的坐标都用这张截图的像素。',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const s = await this.shot();
        return shotOutcome(s, '现在屏幕：');
      },
    };

    const move: ToolDef = {
      name: 'cua_move',
      tags: ['write'],
      description: '把鼠标移到 (x, y)，不点击；用于悬停出提示或菜单。坐标用最近一张截图。',
      parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
      handler: async (args) => {
        if (!this.cfg.allowInput) return inputDenied;
        await this.doInput({ kind: 'move', x: Number(args.x), y: Number(args.y) });
        return '已移到 (' + args.x + ', ' + args.y + ')。' + (await withShot()).text;
      },
    };

    const click: ToolDef = {
      name: 'cua_click',
      tags: ['write'],
      description: '把鼠标移到 (x, y) 并点击。clicks：1 单击（默认）、2 双击、3 三击。button：left/right/middle。',
      parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, clicks: { type: 'integer' } }, required: ['x', 'y'] },
      handler: async (args) => {
        if (!this.cfg.allowInput) return inputDenied;
        const danger = await this.dangerOf({});
        if (danger) return this.askDanger(danger, async () => {
          await this.doInput({ kind: 'click', x: Number(args.x), y: Number(args.y), button: (args.button as 'left' | 'right' | 'middle') ?? 'left', clicks: Number(args.clicks ?? 1) });
        });
        await this.doInput({ kind: 'click', x: Number(args.x), y: Number(args.y), button: (args.button as 'left' | 'right' | 'middle') ?? 'left', clicks: Number(args.clicks ?? 1) });
        return '已点击 (' + args.x + ', ' + args.y + ')。' + (await withShot()).text;
      },
    };

    const drag: ToolDef = {
      name: 'cua_drag',
      tags: ['write'],
      description: '按住左键从 (fromX, fromY) 拖到 (toX, toY) 再松开。',
      parameters: { type: 'object', properties: { fromX: { type: 'number' }, fromY: { type: 'number' }, toX: { type: 'number' }, toY: { type: 'number' } }, required: ['fromX', 'fromY', 'toX', 'toY'] },
      handler: async (args) => {
        if (!this.cfg.allowInput) return inputDenied;
        const danger = await this.dangerOf({});
        if (danger) return this.askDanger(danger, async () => {
          await this.doInput({ kind: 'drag', x: Number(args.fromX), y: Number(args.fromY), toX: Number(args.toX), toY: Number(args.toY), button: 'left' });
        });
        await this.doInput({ kind: 'drag', x: Number(args.fromX), y: Number(args.fromY), toX: Number(args.toX), toY: Number(args.toY), button: 'left' });
        return '已拖拽。' + (await withShot()).text;
      },
    };

    const scroll: ToolDef = {
      name: 'cua_scroll',
      tags: ['write'],
      description: '把鼠标移到 (x, y) 滚动滚轮。delta 为正向下、为负向上（单位=一"格"）。',
      parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, delta: { type: 'integer' } }, required: ['x', 'y', 'delta'] },
      handler: async (args) => {
        if (!this.cfg.allowInput) return inputDenied;
        await this.doInput({ kind: 'scroll', x: Number(args.x), y: Number(args.y), delta: Number(args.delta ?? 1) });
        return '已滚动 ' + args.delta + ' 格。' + (await withShot()).text;
      },
    };

    const type: ToolDef = {
      name: 'cua_type',
      tags: ['write'],
      description: '在当前输入焦点处打字（任何语言，与输入法状态无关）。打之前先点中输入框。',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      handler: async (args) => {
        if (!this.cfg.allowInput) return inputDenied;
        const text = String(args.text ?? '');
        if (!text) return '没给要打的字。';
        const danger = await this.dangerOf({ text });
        if (danger) return this.askDanger(danger, async () => { await this.doInput({ kind: 'type', text }); });
        await this.doInput({ kind: 'type', text });
        return '已打 ' + text.length + ' 个字符。' + (await withShot()).text;
      },
    };

    const key: ToolDef = {
      name: 'cua_key',
      tags: ['write'],
      description: '按键或组合键。组合用 + 连：ctrl+s、alt+tab、shift+enter；多个键用逗号分先后：ctrl+a, delete。',
      parameters: { type: 'object', properties: { keys: { type: 'string', description: '如 ctrl+s 或 ctrl+a, delete' } }, required: ['keys'] },
      handler: async (args) => {
        if (!this.cfg.allowInput) return inputDenied;
        const keys = String(args.keys ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        if (!keys.length) return '没给键名。';
        const danger = await this.dangerOf({ keys });
        if (danger) return this.askDanger(danger, async () => { await this.doInput({ kind: 'key', keys }); });
        await this.doInput({ kind: 'key', keys });
        return '已按键：' + keys.join(', ') + '。' + (await withShot()).text;
      },
    };

    const windows: ToolDef = {
      name: 'cua_windows',
      tags: ['read'],
      description: '列出可见的顶层窗口：标题、位置（物理像素）、是否最小化、是否前台。',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const list = (await this.rpc({ id: 0, op: 'windows' })) as WindowInfo[];
        if (!list.length) return '没有可见窗口。';
        return list.slice(0, 30).map((w) => (w.foreground ? '★ ' : '  ') + w.title + '  [' + w.x + ',' + w.y + ' ' + w.width + '×' + w.height + ']' + (w.minimized ? ' (最小化)' : '')).join('\n');
      },
    };

    const focus: ToolDef = {
      name: 'cua_focus',
      tags: ['write'],
      description: '把一个窗口切到前台（最小化的先还原）。title 用标题里的连续几个字，不必写全。',
      parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      handler: async (args) => {
        if (!this.cfg.allowInput) return inputDenied;
        const title = String(args.title ?? '').trim();
        if (!title) return '没给窗口标题。';
        const hit = (await this.rpc({ id: 0, op: 'focus', title })) as string | null;
        return hit ? '已切到：' + hit : '没找到标题含「' + title + '」的窗口。先用 cua_windows 看看。';
      },
    };

    const wait: ToolDef = {
      name: 'cua_wait',
      tags: ['read'],
      description: '等待若干秒（最多 30）让界面加载，然后附一张截图。等待本身不消耗别的东西。',
      parameters: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] },
      handler: async (args) => {
        const s = Math.min(30, Math.max(0.2, Number(args.seconds ?? 1)));
        await new Promise((r) => setTimeout(r, s * 1000));
        const shot = await this.shot();
        return shotOutcome(shot, '等了 ' + s + ' 秒。');
      },
    };

    const freePlay: ToolDef = {
      name: 'cua_free_play',
      tags: ['write'],
      description: '申请一段自己玩电脑的时间。这一步只是记一笔；主人在聊天里（QQ/控制台都算）说「行/好/允许」之后，你自己调 cua_free_allow 开时间，不需要他点任何按钮。',
      parameters: { type: 'object', properties: { minutes: { type: 'integer', description: '想玩几分钟；不填用配置值。' } } },
      handler: async (args) => {
        if (!this.cfg.freePlay.enabled) return '没开「允许申请自己玩」。';
        if (!this.cfg.allowInput) return inputDenied;
        const day = this.today();
        if (this.freeDay !== day) { this.freeDay = day; this.freeSessionsToday = 0; }
        if (this.freeSessionsToday >= this.cfg.freePlay.maxSessionsPerDay) return '今天已经批过 ' + this.freeSessionsToday + ' 次了，明天再说。';
        if (this.freeActive()) return '你正在自由时间里（还剩 ' + this.freeLeftMin() + ' 分钟）。';
        const minutes = Math.min(120, Math.max(1, Number(args.minutes ?? this.cfg.freePlay.minutesPerSession)));
        await this.host?.pushEvent({ type: 'cua.free_play_request', ts: new Date().toISOString(), source: this.id, senderKey: this.id, text: '自由时间申请（' + minutes + ' 分钟）已记下。去聊天里问主人；他说「行/好/允许」之后，你自己调 cua_free_allow 开时间，不需要他点任何按钮。', meta: { minutes } });
        return '已记下申请（' + minutes + ' 分钟）。去聊天里问主人：他同意后你自己调 cua_free_allow 开时间，不需要控制台操作。';
      },
    };
    const freeAllow: ToolDef = {
      name: 'cua_free_allow',
      tags: ['write'],
      description: '主人已经同意（聊天里说「行/好/允许」都算）：调它给自己开一段自由时间。minutes 可不填，用配置值。',
      parameters: { type: 'object', properties: { minutes: { type: 'integer' } } },
      handler: async (args) => {
        const minutes = Math.min(120, Math.max(1, Number(args.minutes ?? this.cfg.freePlay.minutesPerSession)));
        const day = this.today();
        if (this.freeDay !== day) { this.freeDay = day; this.freeSessionsToday = 0; }
        this.freeUntil = Date.now() + minutes * 60_000;
        this.freeSessionsToday += 1;
        return '好，' + minutes + ' 分钟。危险动作我还会再问。';
      },
    };
    const freeDeny: ToolDef = {
      name: 'cua_free_deny',
      tags: ['write'],
      description: '主人没同意：记一下，回去做自己的事。',
      parameters: { type: 'object', properties: {} },
      handler: async () => '好，不去。',
    };
    const freeStatus: ToolDef = {
      name: 'cua_free_status',
      tags: ['read'],
      description: '看自己玩的状态：还剩多久、今天批过几次。',
      parameters: { type: 'object', properties: {} },
      handler: async () => this.freeActive()
        ? '自由时间还剩 ' + this.freeLeftMin() + ' 分钟；今天批过 ' + this.freeSessionsToday + ' 次。'
        : '现在没有自由时间；今天批过 ' + this.freeSessionsToday + ' 次。',
    };
    const dangerAllow: ToolDef = {
      name: 'cua_danger_allow',
      tags: ['write'],
      description: '主人已经同意那条危险动作：用挂起时给的编号执行。',
      parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
      handler: async (args) => {
        const id = Number(args.id);
        const p = this.dangerPending.get(id);
        if (!p) return '没有这条待批动作（可能已经处理过了）。';
        this.dangerPending.delete(id);
        await p.run();
        return '已执行：' + p.label + '。';
      },
    };
    const dangerDeny: ToolDef = {
      name: 'cua_danger_deny',
      tags: ['write'],
      description: '主人不同意那条危险动作：用编号取消它。',
      parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
      handler: async (args) => {
        const id = Number(args.id);
        const p = this.dangerPending.get(id);
        this.dangerPending.delete(id);
        return p ? '好，不做：' + p.label + '。' : '没有这条待批动作。';
      },
    };
    return [screenshot, move, click, drag, scroll, type, key, windows, focus, wait, freePlay, freeAllow, freeDeny, freeStatus, dangerAllow, dangerDeny].map(tool => ({ ...CUA_TOOL_DECLS.find(decl => decl.name === tool.name)!, handler: tool.handler }));
  }

  webUi(_language: Language = 'zh'): WorldWebUiDecl {
    return {
      label: '电脑操作',
      promptDocs: [
        {
          key: 'worlds.cua.envPrompt',
          title: '电脑操作环境',
          description: '注入 system 前缀：这台电脑怎么用、能干什么、分寸在哪。',
          role: 'envPrompt',
          path: fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url)),
          vars: [
            { name: 'cua.os', description: '操作系统名。' },
            { name: 'cua.control', description: '能做什么（能不能动手）。' },
            { name: 'cua.shot', description: '截图最长边（像素）。' },
            { name: 'cua.idle', description: '使用者静止多少秒才动手。' },
            { name: 'cua.keys', description: '组合键写法。' },
            { name: 'cua.permission', description: '当前授权状态。' },
            { name: 'cua.freeplay', description: '自由玩的状态（可申请/剩余几分钟/没开）。' },
          ],
        },
      ],
      config: [CUA_CONFIG_GROUP],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.stopping = false;
    if (!this.cfg.enabled) { this.log('info', '电脑操作已关闭'); return; }
    await this.spawn();
    if (this.cfg.freePlay.enabled && !this.tickTimer) {
      this.tickTimer = setInterval(() => { void this.freeTick(); }, 60_000);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.host = null;
    this.freeUntil = 0;
    this.dangerPending.clear();
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    this.killChild();
  }

  /** 每隔一小时最多提一次：你有一会儿没事干，可以申请自己玩。 */
  private async freeTick(): Promise<void> {
    if (!this.host || !this.cfg.freePlay.enabled || this.freeActive()) return;
    if (this.lastFreeNoticeAt && Date.now() - this.lastFreeNoticeAt < 3_600_000) return;
    this.lastFreeNoticeAt = Date.now();
    try {
      await this.host.pushEvent({
        type: 'cua.free_time',
        ts: new Date().toISOString(),
        source: this.id,
        senderKey: this.id,
        text: '电脑操作扩展的申请提醒间隔已到。若当前适合操作电脑，可以申请自由时间；是否申请由 Persona 决定。',
      });
    } catch { /* 宿主没了就算了 */ }
  }

  // ---- 引擎子进程 ----

  private log(level: 'info' | 'warn' | 'error', msg: string): void {
    this.opts.log?.(level, msg);
  }

  private async spawn(): Promise<void> {
    if (this.stopping || this.child) return;
    // serialization:'advanced' 是必须的：截图是 Buffer，默认的 JSON 序列化会把它变成普通对象。
    const child = fork(CHILD_ENTRY, [], { execArgv: childExecArgv(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced' });
    this.child = child;
    child.on('message', (raw: unknown) => this.onMessage(raw as ChildToMain));
    child.on('exit', (code) => this.onExit(code));
    child.on('error', (err: unknown) => this.log('warn', '引擎子进程出错：' + String(err)));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('引擎子进程 15 秒内没就绪')), 15_000);
      const onReady = (raw: unknown) => {
        const m = raw as ChildToMain;
        if ('type' in m && m.type === 'ready') { clearTimeout(timer); child.off('message', onReady); this.ready = true; this.log('info', '引擎子进程已就绪 pid=' + child.pid + ' 屏幕 ' + m.screen.width + '×' + m.screen.height + ' dpi=' + m.screen.dpi); resolve(); }
      };
      child.on('message', onReady);
    }).catch((e: unknown) => { this.log('error', String((e as Error).message ?? e)); this.killChild(); });
  }

  private killChild(): void {
    const c = this.child;
    this.child = null;
    this.ready = false;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('引擎子进程已退出')); }
    this.pending.clear();
    if (c) { try { c.kill(); } catch { /* 已经没了 */ } }
  }

  private onExit(code: number | null): void {
    const wasStopping = this.stopping;
    this.killChild();
    if (wasStopping) return;
    this.log('warn', '引擎子进程退出(code=' + code + ')，2 秒后重启');
    this.restartTimer = setTimeout(() => { this.restartTimer = null; void this.spawn(); }, 2000);
  }

  private onMessage(msg: ChildToMain): void {
    if ('type' in msg) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  }

  private async rpc(msg: MainToChild, timeoutMs = 20_000): Promise<unknown> {
    if (!this.ready || !this.child) throw new Error('引擎子进程还没就绪');
    const id = ++this.seq;
    const withId = { ...msg, id } as MainToChild;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('引擎子进程 ' + timeoutMs / 1000 + ' 秒没回话')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.child?.send(withId); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  private async shot(): Promise<ShotResult> {
    const s = (await this.rpc({ id: 0, op: 'shot', shot: this.cfg.shot, quality: this.cfg.quality, drawCursor: true })) as ShotResult;
    this.lastShot = s;
    return s;
  }

  /** 工具坐标（截图坐标系）→ 物理像素。没有截图时先截一张定比例。 */
  private async physical(x: number, y: number): Promise<{ x: number; y: number }> {
    const s = this.lastShot ?? (await this.shot());
    return { x: Math.round(x * s.scale), y: Math.round(y * s.scale) };
  }

  private async doInput(req: Omit<InputRequest, 'idleMs'>): Promise<void> {
    const out: InputRequest = { ...req, idleMs: this.cfg.idleMs };
    if (req.kind !== 'type' && req.kind !== 'key') {
      const from = await this.physical(req.x ?? 0, req.y ?? 0);
      out.x = from.x;
      out.y = from.y;
      if (req.kind === 'drag') {
        const to = await this.physical(req.toX ?? 0, req.toY ?? 0);
        out.toX = to.x;
        out.toY = to.y;
      }
    }
    await this.rpc({ id: 0, op: 'input', req: out }, 30_000);
  }
}
