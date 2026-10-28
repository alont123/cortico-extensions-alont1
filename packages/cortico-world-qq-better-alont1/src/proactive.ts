import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';

/** Scheduling configuration is retained; autonomous drafting and sending are retired. */
export interface ProactiveTarget {
  address: string; // 'private:123' | 'group:456'
  kind: 'private' | 'group';
  label: string;
}

/** 发送回执看起来像失败：被限速/防死循环拦下、没连上 NapCat、或者一段都没发出去。 */
export function isSendFailure(res: string): boolean {
  return /^\[send (?:blocked|failed|partial)\] /.test(res) || res.includes('未连接到 NapCat') || /发送 0\/\d+ 段/.test(res);
}

export interface ProactiveConfig {
  enabled: boolean;
  /** 候选范围：private=私聊，group=群，both=两类。 */
  mode: 'private' | 'group' | 'both';
  /** 以下独立 LLM、预热和话题去重字段仅兼容旧配置，已停用。 */
  systemPrompt: string;
  endpoint: string;
  apiKeySecret: string;
  model: string;
  warmupMin: number;
  warmupChance: number;
  unrepliedThreshold: number;
  silentHours: number;
  dedupWindow: number;
  topicSimilarity: number;
  /** 检查周期（秒）。 */
  tickSec: number;
  /** 每次检查生成一个候选的概率；0 表示永不定时生成。 */
  stableChancePerTick: number;
  /** 同一私聊/群候选的最小间隔（秒）。 */
  privateCooldownSec: number;
  groupCooldownSec: number;
  /** 每日候选上限（0=不限），不是实际发言次数。 */
  dailyQuota: number;
  /** 本地静默时段；两值相等表示不静默。 */
  quietFrom: number;
  quietTo: number;
  /** 跨会话候选最小间隔（秒）；每 tick 至多投递一个目标。 */
  minGapSec: number;
  /** 追加随机等待 0..gapJitterSec 秒。 */
  gapJitterSec: number;
}

export type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string };

export interface ProactiveStatus {
  enabled: boolean;
  runState: '关' | '暖场' | '稳定' | '静默';
  dailyCount: number;
  dailyQuota: number;
  targets: number;
  recent: string[];
  perAddr: Record<string, { state: string; unreplied: number; silentUntil: number; lastSent: number }>;
}

/** A scheduler emits candidate events; only Persona tools can send messages. */
export class ProactiveSpeaker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private busy = false;
  private generation = 0;
  private dailyCount = 0;
  private day = new Date().toDateString();
  private lastEmitAt = 0;
  private nextGapJitterMs = 0;
  private lastByAddress: Record<string, number> = {};
  private readonly stateFile: string;
  constructor(private readonly opts: {
    cfg: ProactiveConfig; log: Logger; dataDir: string;
    getTargets: () => ProactiveTarget[];
    request: (target: ProactiveTarget) => Promise<boolean>;
    isPaused?: () => boolean;
  }) {
    this.stateFile = opts.dataDir ? join(opts.dataDir, 'proactive-nudges.json') : '';
    if (this.stateFile && existsSync(this.stateFile)) {
      try {
        const saved = JSON.parse(readFileSync(this.stateFile, 'utf8').replace(/^\uFEFF/, ''));
        if (typeof saved.day === 'string') this.day = saved.day;
        if (Number.isFinite(saved.dailyCount)) this.dailyCount = Math.max(0, saved.dailyCount);
        if (Number.isFinite(saved.lastEmitAt)) this.lastEmitAt = saved.lastEmitAt;
        if (Number.isFinite(saved.nextGapJitterMs)) this.nextGapJitterMs = Math.max(0, saved.nextGapJitterMs);
        if (saved.lastByAddress && typeof saved.lastByAddress === 'object') for (const [address, at] of Object.entries(saved.lastByAddress)) if (Number.isFinite(at)) this.lastByAddress[address] = Number(at);
      } catch (error) { opts.log.warn('主动候选状态读取失败', { error: String(error) }); }
    }
  }
  start(): void {
    if (this.running) return;
    this.running = true; this.generation++;
    if (!this.opts.cfg.enabled) return;
    this.timer = setInterval(() => void this.tick().catch(error => this.opts.log.warn('主动候选调度失败', { error: String(error) })), Math.max(5, this.opts.cfg.tickSec) * 1000);
  }
  stop(): void { this.running = false; this.generation++; if (this.timer) clearInterval(this.timer); this.timer = undefined; this.save(); }
  notifyReply(_address: string): void { /* Candidate events are not messages awaiting a reply. */ }
  status(targets = this.opts.getTargets().length): ProactiveStatus {
    this.rollover();
    return { enabled: this.opts.cfg.enabled, runState: !this.running || !this.opts.cfg.enabled ? '关' : this.inQuietHours() ? '静默' : '稳定', dailyCount: this.dailyCount, dailyQuota: this.opts.cfg.dailyQuota, targets, recent: [], perAddr: Object.fromEntries(Object.entries(this.lastByAddress).map(([address, at]) => [address, { state: '候选已投递', unreplied: 0, silentUntil: 0, lastSent: at }])) };
  }
  async trigger(address?: string): Promise<string> {
    const targets = this.opts.getTargets();
    const target = address ? targets.find(item => item.address === address) : targets[Math.floor(Math.random() * targets.length)];
    if (!target) return address ? '目标不在允许的监听会话内，未投递候选。' : '没有可用的监听会话。';
    return await this.emit(target) ? '已投递会话候选，尚未发送消息；是否回应及正文由 Persona 决定。' : '本次未投递候选（已停止、暂停、静默、冷却或配额限制）。';
  }
  private async tick(): Promise<void> {
    if (!this.allowed()) return;
    if (Math.random() >= Math.max(0, Math.min(1, this.opts.cfg.stableChancePerTick))) return;
    const targets = this.opts.getTargets();
    if (!targets.length) return;
    await this.emit(targets[Math.floor(Math.random() * targets.length)]!);
  }
  private allowed(): boolean {
    this.rollover();
    return this.running && this.opts.cfg.enabled && !this.busy && !this.opts.isPaused?.() && !this.inQuietHours()
      && (!this.opts.cfg.dailyQuota || this.dailyCount < this.opts.cfg.dailyQuota)
      && Date.now() >= this.lastEmitAt + Math.max(0, this.opts.cfg.minGapSec) * 1000 + this.nextGapJitterMs;
  }
  private async emit(target: ProactiveTarget): Promise<boolean> {
    if (!this.allowed()) return false;
    const cfg = this.opts.cfg;
    const cooldown = target.kind === 'private' ? cfg.privateCooldownSec : cfg.groupCooldownSec;
    if (Date.now() - (this.lastByAddress[target.address] ?? 0) < Math.max(0, cooldown) * 1000) return false;
    const generation = this.generation; this.busy = true;
    try {
      if (!this.running || this.opts.isPaused?.()) return false;
      const accepted = await this.opts.request(target);
      if (!accepted || !this.running || generation !== this.generation) return false;
      this.lastEmitAt = Date.now(); this.lastByAddress[target.address] = this.lastEmitAt;
      this.nextGapJitterMs = Math.floor(Math.random() * Math.max(0, cfg.gapJitterSec) * 1000);
      this.dailyCount++; this.save(); return true;
    } finally { this.busy = false; }
  }
  inQuietHours(d = new Date()): boolean { const h = d.getHours(), { quietFrom, quietTo } = this.opts.cfg; return quietFrom > quietTo ? h >= quietFrom || h < quietTo : h >= quietFrom && h < quietTo; }
  private rollover(): void { const day = new Date().toDateString(); if (day !== this.day) { this.day = day; this.dailyCount = 0; } }
  private save(): void {
    if (!this.stateFile) return;
    try { mkdirSync(dirname(this.stateFile), { recursive: true }); writeFileSync(this.stateFile, JSON.stringify({ day: this.day, dailyCount: this.dailyCount, lastEmitAt: this.lastEmitAt, nextGapJitterMs: this.nextGapJitterMs, lastByAddress: this.lastByAddress })); }
    catch (error) { this.opts.log.warn('主动候选状态保存失败', { error: String(error) }); }
  }
}
