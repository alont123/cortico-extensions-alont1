/** Bounded copies of original delivered private events; no access to the Core event store. */
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { collectDialogueEvents } from './dialogue-recovery.ts';
import { CONVERSATION_DEFAULTS, conversationPolicy, prioritySenders, type ConversationPolicy } from './conversation-policy.ts';

const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_AGGREGATED_MESSAGES = 500;
export const CONVERSATION_SOURCE_FILE = '.persona/recent-sources.json';

function info(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
/** Only a contiguous prefix is retained. No head/tail join can manufacture a new quotation. */
function prefix(text: string, limit: number): string {
  const end = text.length > limit && /[\uD800-\uDBFF]/.test(text.charAt(limit - 1)) ? limit - 1 : limit;
  return text.slice(0, Math.max(0, end));
}
function recentTime(event: EventEnvelope): number {
  const entries = collectDialogueEvents([event]);
  return Math.max(...entries.map(entry => Date.parse(entry.ts)));
}

export class ConversationSources {
  private events: EventEnvelope[] = [];
  private damaged = false;
  private failure: string | null = null;
  private readonly file: string;

  constructor(
    private readonly memoryDir: string,
    private readonly policy: () => ConversationPolicy = () => CONVERSATION_DEFAULTS,
    private readonly now: () => number = Date.now,
  ) {
    this.file = join(memoryDir, CONVERSATION_SOURCE_FILE);
    try {
      this.assertOrdinaryPath();
      const fileInfo = info(this.file);
      if (!fileInfo) return;
      if (fileInfo.size > MAX_CACHE_BYTES) throw new Error('Source cache exceeds size limit');
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      if (data?.version !== 1 || !Array.isArray(data.events)) throw new Error('Unsupported source cache');
      if (data.events.some((event: unknown) => !this.valid(event))) throw new Error('Invalid source event in cache');
      this.events = data.events.map((event: EventEnvelope) => this.copy(event));
      this.prune();
    } catch {
      this.damaged = true;
      this.failure = '来源缓存不可读取，保留原文件；本次只核对重新观察到的事件。请备份并检查 .persona/recent-sources.json。';
    }
  }

  private config(): ConversationPolicy { return conversationPolicy(this.policy()); }

  private assertOrdinaryPath(): void {
    const root = resolve(this.memoryDir), path = resolve(this.file), rel = relative(root, path);
    if (rel === '..' || rel.startsWith('..' + sep)) throw new Error('Invalid source cache path');
    for (const item of [root, dirname(path), path]) {
      const stat = info(item);
      if (!stat) continue;
      if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1) throw new Error('Linked source cache is not writable');
      if (item === path ? !stat.isFile() : !stat.isDirectory()) throw new Error('Invalid source cache location');
    }
  }

  private valid(value: unknown): value is EventEnvelope {
    const event = object(value) as unknown as EventEnvelope | null;
    if (!event || !Number.isSafeInteger(event.cursor) || event.cursor < 1 || typeof event.text !== 'string' ||
      typeof event.ts !== 'string' || !Number.isFinite(Date.parse(event.ts)) ||
      event.run !== undefined && typeof event.run !== 'string' ||
      event.senderKey !== undefined && (typeof event.senderKey !== 'string' || event.senderKey.length > 128) ||
      event.tags !== undefined && (!Array.isArray(event.tags) || event.tags.some(tag => tag !== 'speak' && tag !== 'snapshot'))) return false;
    const meta = object(event.meta);
    if (meta?.messageTextBasis === 'aggregated-normalized-messages') {
      if (!Array.isArray(meta.messages) || !meta.messages.length || meta.messages.length > MAX_AGGREGATED_MESSAGES) return false;
      if (meta.messages.some(value => {
        const item = object(value);
        return !item || typeof item.text !== 'string' || typeof item.ts !== 'string' || !Number.isFinite(Date.parse(item.ts));
      })) return false;
    }
    try { return collectDialogueEvents([event]).length > 0; } catch { return false; }
  }

  private copy(event: EventEnvelope): EventEnvelope {
    const cfg = this.config(), entry = collectDialogueEvents([event])[0]!;
    const original = event.meta ?? {};
    const text = prefix(event.text, cfg.sourceMaxChars);
    const meta: Record<string, unknown> = {
      conv: { kind: 'private', id: entry.conversation.slice('private:'.length) },
      sourceTextTruncated: original.sourceTextTruncated === true || event.text.length > text.length,
    };
    for (const key of ['user', 'user_id', 'platformMessageId', 'message_id', 'direction', 'delivery', 'messageId', 'segmentIndex', 'segmentCount', 'messageTextBasis', 'messageTs']) {
      const value = original[key];
      if (typeof value === 'string') meta[key] = prefix(value, 256);
      else if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' || value === null) meta[key] = value;
    }
    for (const key of ['text', 'messageText']) if (typeof original[key] === 'string') {
      const value = prefix(original[key], cfg.sourceMaxChars);
      meta[key] = value;
      meta[key + 'Truncated'] = original[key + 'Truncated'] === true || value.length < original[key].length;
    }
    if (original.messageTextBasis === 'aggregated-normalized-messages' && Array.isArray(original.messages)) {
      let remaining = cfg.sourceMaxChars;
      const messages: Array<Record<string, unknown>> = [];
      for (let index = original.messages.length - 1; index >= 0; index--) {
        const item = object(original.messages[index])!;
        const body = prefix(item.text as string, remaining);
        remaining -= body.length;
        // Empty placeholders retain original message indexes when older content exceeds the cap.
        messages[index] = {
          messageId: typeof item.messageId === 'string' ? prefix(item.messageId, 256) : typeof item.messageId === 'number' ? item.messageId : null,
          ts: item.ts, text: body, textTruncated: item.textTruncated === true || body.length < (item.text as string).length,
        };
      }
      meta.messages = messages;
      meta.sourceMessagesTruncated = messages.some(item => item.textTruncated);
    }
    return {
      cursor: event.cursor, ts: event.ts, type: event.type, source: event.source, origin: 'external', senderKey: event.senderKey,
      text, meta, ...(event.run ? { run: prefix(event.run, 128) } : {}), ...(event.tags ? { tags: [...event.tags] } : {}),
    };
  }

  private priority(event: EventEnvelope, cfg: ConversationPolicy): boolean {
    const keys = prioritySenders(cfg);
    return collectDialogueEvents([event]).some(entry => keys.some(key =>
      key === entry.senderKey || key === entry.conversation || key === entry.conversation.slice('private:'.length)));
  }

  /** Lowest priority first, then oldest source time. Both count and byte caps use this order. */
  private ordered(cfg: ConversationPolicy): EventEnvelope[] {
    return [...this.events].sort((a, b) => Number(this.priority(a, cfg)) - Number(this.priority(b, cfg)) ||
      recentTime(a) - recentTime(b) || a.cursor - b.cursor);
  }

  private prune(): void {
    const cfg = this.config(), current = this.now(), earliest = current - cfg.sourceRetentionHours * 3600000;
    const inWindow = (at: string) => Date.parse(at) >= earliest && Date.parse(at) <= current;
    this.events = this.events.filter(event => {
      const messages = event.meta?.messages;
      if (!Array.isArray(messages)) return inWindow(event.ts);
      let removed = false;
      const retained = messages.map(value => {
        const item = object(value)!;
        if (inWindow(item.ts as string)) return item;
        removed ||= typeof item.text === 'string' && item.text.length > 0;
        return { ...item, text: '', textTruncated: true };
      });
      if (!retained.some(item => typeof item.text === 'string' && item.text.length > 0)) return false;
      event.meta!.messages = retained;
      if (removed) {
        // Aggregate prose may contain expired text; only per-message retained originals remain usable.
        event.text = '';
        event.meta!.messageText = '';
        event.meta!.sourceTextTruncated = true;
        event.meta!.messageTextTruncated = true;
        event.meta!.sourceMessagesTruncated = true;
      }
      return true;
    });
    this.events = this.ordered(cfg).slice(-cfg.sourceMaxEvents).sort((a, b) => a.cursor - b.cursor);
  }

  observe(events: readonly EventEnvelope[]): void {
    const current = new Map(this.events.map(event => [event.cursor, event]));
    let changed = false;
    for (const event of events) {
      if (!event || !Number.isSafeInteger(event.cursor) || event.cursor < 1) continue;
      const cursor = event.cursor;
      const previous = current.get(cursor);
      // The host may recreate its event store while keeping Memory. A newly observed
      // cursor then supersedes the old source, even if it is no longer a private event.
      if (!this.valid(event)) {
        if (previous) { current.delete(cursor); changed = true; }
        continue;
      }
      const copy = this.copy(event);
      if (!this.valid(copy)) continue;
      if (previous && JSON.stringify(previous) === JSON.stringify(copy)) continue;
      current.set(copy.cursor, copy); changed = true;
    }
    this.events = [...current.values()];
    this.prune();
    if (!changed || this.damaged) return;
    let temp: string | null = null;
    try {
      this.assertOrdinaryPath();
      mkdirSync(dirname(this.file), { recursive: true });
      const rows = this.ordered(this.config()).map(event => ({ event, json: JSON.stringify(event) }));
      let bytes = Buffer.byteLength('{"version":1,"events":[]}\n') + rows.reduce((sum, row) => sum + Buffer.byteLength(row.json) + 1, 0);
      while (bytes > MAX_CACHE_BYTES && rows.length) {
        const removed = rows.shift()!;
        bytes -= Buffer.byteLength(removed.json) + 1;
      }
      this.events = rows.map(row => row.event).sort((a, b) => a.cursor - b.cursor);
      const data = JSON.stringify({ version: 1, events: this.events }) + '\n';
      temp = this.file + '.tmp-' + randomUUID();
      writeFileSync(temp, data, { encoding: 'utf8', flag: 'wx' });
      this.assertOrdinaryPath();
      renameSync(temp, this.file);
      temp = null;
      this.failure = null;
    } catch {
      this.failure = '本次对话来源未能保存，当前进程仍可核对；重启后可能需要重新观察原始消息。';
    } finally {
      if (temp) { try { unlinkSync(temp); } catch { /* Preserve the original save error. */ } }
    }
  }

  get(cursor: number): EventEnvelope | undefined {
    this.prune();
    const event = this.events.find(event => event.cursor === cursor);
    return event ? structuredClone(event) : undefined;
  }
  snapshot(): EventEnvelope[] { this.prune(); return structuredClone(this.events); }
  status(): string | null { return this.failure; }

  /** Explicit Persona storage clearing only removes this cache, never another Memory file. */
  clear(): void {
    this.assertOrdinaryPath();
    if (info(this.file)) unlinkSync(this.file);
    this.events = [];
    this.damaged = false;
    this.failure = null;
  }
}
