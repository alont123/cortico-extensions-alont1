/**
 * 自我运维：让她能看自己的运行状态。
 *
 * 今天卡了两个小时她只能干等——如果她能自己读到「LLM 调用失败」「world 没挂上」「上下文快满了」，
 * 就能在聊天里说出来，而不是等人发现。这里全部只读；重启仍由主人决定。
 */
import type { ToolDef, World } from 'cortico/core/types.ts';
import type { SelfkitConfigSection } from './config.ts';
import { autoWebUi } from './panel.ts';
import { SELFKIT_DEFAULTS } from './config.ts';

export const SELFKIT_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'self_status',
    tags: ['read'],
    description: '看自己的运行状态：循环在不在跑、模型通不通、消息数/上下文、已经运行多久、有没有错误在刷。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'self_log',
    tags: ['read'],
    description: '看自己最近的告警/错误日志（时间、来源、一句话）。觉得「不对劲」时先看这个。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { count: { type: 'integer', description: '看几条，默认用配置值。' } },
    },
  },
  {
    name: 'self_worlds',
    tags: ['read'],
    description: '看自己挂了哪些世界/扩展、哪些没挂上。工具在不在手边一眼就知道。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];

export class SelfkitWorld implements World {
  readonly id = 'selfkit';
  private readonly cfg: SelfkitConfigSection;

  constructor(cfg: SelfkitConfigSection) {
    this.cfg = cfg;
  }

  envPromptVars(): Record<string, string> {
    return { 'selfkt.port': String(this.cfg.consolePort) };
  }

  private base(): string {
    return 'http://127.0.0.1:' + this.cfg.consolePort;
  }

  private async getJson(path: string, timeoutMs = 8000): Promise<unknown> {
    const res = await fetch(this.base() + path, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  tools(): ToolDef[] {
    const status: ToolDef = {
      ...SELFKIT_TOOL_DECLS[0],
      tags: ['read'],
      handler: async () => {
        try {
          const s = (await this.getJson('/api/status')) as {
            displayName?: string; modelConnection?: { ready?: boolean; model?: string };
            loop?: { running?: boolean; paused?: boolean; messageCount?: number; estTokens?: number; batchesHandled?: number; phase?: { state?: string }; behind?: number };
            uptimeSec?: number; context?: { maxTokens?: number };
          };
          const loop = s.loop ?? {};
          const up = typeof s.uptimeSec === 'number' ? String(Math.round(s.uptimeSec / 60)) : '未知';
          return [
            '我是' + (s.displayName ?? '（未命名）'),
            '循环：' + (loop.running === undefined ? '未知' : loop.running ? '在跑' : '停了') + ' / ' + (loop.paused === undefined ? '未知' : loop.paused ? '暂停中' : '未暂停') + ' / 现在 ' + (loop.phase?.state ?? '?'),
            '模型：' + (s.modelConnection?.ready === undefined ? '未知' : s.modelConnection.ready ? '通（' + (s.modelConnection.model ?? '') + '）' : '不通'),
            '消息 ' + (loop.messageCount ?? 0) + ' 条，上下文约 ' + Math.round((loop.estTokens ?? 0) / 1000) + 'k / ' + Math.round((s.context?.maxTokens ?? 0) / 1000) + 'k',
            '已处理批次 ' + (loop.batchesHandled ?? 0) + '，积压 ' + (loop.behind ?? 0),
            '已运行 ' + up + ' 分钟',
          ].join('\n');
        } catch (e) {
          return '读不到自己的状态（控制台没通？）：' + String((e as Error)?.message ?? e);
        }
      },
    };

    const log: ToolDef = {
      ...SELFKIT_TOOL_DECLS[1],
      tags: ['read'],
      handler: async (args: Record<string, unknown>) => {
        const count = Math.min(100, Math.max(5, Number(args.count ?? this.cfg.logLines)));
        try {
          const d = (await this.getJson('/api/diagnostics', 20000)) as { log?: { warn?: Array<{ ts?: string; level?: string; area?: string; msg?: string }> } };
          if (!Array.isArray(d.log?.warn)) return '控制台没有返回可识别的告警列表，无法判断日志状态。';
          const items = d.log.warn.slice(-count);
          if (!items.length) return '本次返回的告警列表为空。';
          return '最近 ' + items.length + ' 条告警：\n' + items.map((w) =>
            '[' + String(w.ts ?? '').slice(11, 19) + '] ' + (w.level ?? '') + '/' + (w.area ?? '') + ' ' + (w.msg ?? '')).join('\n');
        } catch (e) {
          return '读不到日志：' + String((e as Error)?.message ?? e);
        }
      },
    };

    const worlds: ToolDef = {
      ...SELFKIT_TOOL_DECLS[2],
      tags: ['read'],
      handler: async () => {
        try {
          const d = (await this.getJson('/api/worlds')) as { worlds?: Array<{ id?: string; status?: string; active?: boolean; visible?: boolean }> };
          const list = d.worlds ?? [];
          const on = list.filter((w) => w.active || w.visible).map((w) => w.id);
          const off = list.filter((w) => !(w.active || w.visible)).map((w) => w.id);
          let tools = 0;
          try {
            const t = (await this.getJson('/api/tool-schemas')) as { tools?: unknown[] };
            tools = t.tools?.length ?? 0;
          } catch { /* 工具表读不到不算错 */ }
          return '挂着 ' + on.length + ' 个世界：' + on.join('、')
            + '\n没挂的：' + (off.length ? off.join('、') : '（无）')
            + '\n工具 ' + tools + ' 个';
        } catch (e) {
          return '读不到世界列表：' + String((e as Error)?.message ?? e);
        }
      },
    };

    return [status, log, worlds];
  }

  webUi() {
    return autoWebUi('selfkit', '自我运维', SELFKIT_DEFAULTS)
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}
