// Owner: Persona recent-ledger source validation and persistence.
/**
 * RECENT 的来源台账：逐字引用绑定已观察的原始消息，独立笔记始终标待核。
 * 来源核对只证明引用存在，不证明陈述为真；原文只供工具读取，前缀仅给状态。
 */
import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { EventEnvelope, ToolDef } from 'cortico/core/types.ts';

export const RECENT_LEDGER_FILE = '.persona/recent-ledger.json';
export const RECENT_SOURCE_FILE = '.persona/recent-sources.json';
const LEGACY_FILE = 'RECENT.md';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 4000;

export interface RecentSource {
  cursor: number;
  senderKey: string;
  source: string;
  type: string;
  ts: string;
  hash: string;
  textBasis: 'normalized-message' | 'formatted-event-quote';
  /** The matched source field is only a retained prefix, not the entire original message. */
  truncated?: boolean;
  messageId?: string;
}

export type RecentEntry =
  | { id: string; kind: 'source-quote'; createdAt: string; quote: string; source: RecentSource }
  | { id: string; kind: 'pending'; createdAt: string; text: string };

export type RecentAppend =
  | { kind: 'quote'; quote: string; source: { cursor: number; senderKey: string; messageId?: string } }
  | { kind: 'pending'; text: string };

export interface RecentLedgerOptions {
  memoryDir: string;
  /** 只返回 Persona 已实际观察的原始入站消息，不得从模型提供的 JSON 造事件。 */
  resolveSource(cursor: number): EventEnvelope | undefined;
  now?: () => Date;
  maxEntries?: number;
}

function checkedText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' 不能为空');
  if (value.length > MAX_TEXT_CHARS) throw new Error(label + ' 超过 ' + MAX_TEXT_CHARS + ' 字符上限');
  return value;
}

function isOriginalPrivateMessage(event: EventEnvelope): boolean {
  const conv = event.meta?.conv;
  const conversation = conv && typeof conv === 'object' ? conv as Record<string, unknown> : undefined;
  return event.origin === 'external' && event.type === 'qq.message'
    && (event.source === 'qq' || event.source === 'qqbot')
    && typeof event.senderKey === 'string' && !!event.senderKey
    && (conversation?.kind === 'private' || /^private:[^:]+$/.test(event.senderKey))
    && !event.senderKey.startsWith('group:')
    && conversation?.kind !== 'group' && conversation?.type !== 'group'
    && event.meta?.direction !== 'outgoing'
    && event.meta?.direction !== 'outbound'
    && event.meta?.replay !== true && event.meta?.replayed !== true;
}

function sourceHash(event: EventEnvelope): string {
  const messages = Array.isArray(event.meta?.messages) ? event.meta.messages.map(item => {
    const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return [entry.messageId, entry.ts, entry.text, entry.textTruncated];
  }) : null;
  return createHash('sha256').update(JSON.stringify([
    event.cursor, event.ts, event.source, event.type, event.senderKey, event.text, event.origin,
    event.meta?.messageText, event.meta?.messageTextBasis, event.meta?.messageTs, messages,
    event.meta?.sourceTextTruncated, event.meta?.messageTextTruncated, event.meta?.sourceMessagesTruncated,
  ])).digest('hex');
}

function messageId(value: unknown): string | undefined {
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) return undefined;
  const result = String(value);
  return result.length ? result : undefined;
}

function sourceText(event: EventEnvelope, quote: string, requestedId?: string): { text: string; basis: RecentSource['textBasis']; ts: string; messageId?: string; truncated: boolean } {
  if (event.meta?.messageTextBasis === 'aggregated-normalized-messages') {
    if (!Array.isArray(event.meta.messages)) throw new Error('聚合事件缺少逐条原始消息，不能用汇总日期代替来源日期');
    const matches = event.meta.messages.filter(item => item && typeof item === 'object').map(item => item as Record<string, unknown>)
      .filter(item => typeof item.text === 'string' && item.text.includes(quote)
        && (requestedId === undefined || messageId(item.messageId) === requestedId));
    if (matches.length === 0) throw new Error('引用与单条来源原文不符，不可跨聚合条目拼接');
    if (matches.length !== 1) throw new Error('引文命中多条聚合消息；请用 source.messageId 指定原始消息');
    const item = matches[0];
    if (typeof item.ts !== 'string' || !Number.isFinite(Date.parse(item.ts))) throw new Error('聚合原始消息缺少有效日期');
    const id = messageId(item.messageId);
    return { text: item.text as string, basis: 'normalized-message', ts: item.ts, truncated: item.textTruncated === true,
      ...(id !== undefined ? { messageId: id } : {}) };
  }
  const platformId = messageId(event.meta?.platformMessageId ?? event.meta?.message_id);
  if (requestedId !== undefined && platformId !== requestedId) throw new Error('source.messageId 与来源消息不符');
  if (event.meta?.messageTextBasis === 'normalized-message' && typeof event.meta.messageText === 'string') {
    return { text: event.meta.messageText, basis: 'normalized-message', ts: event.ts,
      truncated: event.meta.messageTextTruncated === true,
      ...(platformId !== undefined ? { messageId: platformId } : {}) };
  }
  return { text: event.text, basis: 'formatted-event-quote', ts: event.ts,
    truncated: event.meta?.sourceTextTruncated === true,
    ...(platformId !== undefined ? { messageId: platformId } : {}) };
}

function canonical(path: string): string {
  return path.replaceAll('\\', '/').split('/').map(part => part.replace(/[ .]+$/g, '').split(':')[0]).join('/').toLowerCase();
}

/** Resolve an existing link or the real parent of a not-yet-created file. */
function physical(path: string, depth = 0): string {
  if (depth > 32) throw new Error('路径链接层数超过上限');
  try { return realpathSync(path); } catch (error) {
    if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
  let parent = path;
  const tail: string[] = [];
  while (true) {
    try {
      const entry = lstatSync(parent);
      if (entry.isSymbolicLink()) {
        const target = resolve(dirname(parent), readlinkSync(parent));
        return resolve(physical(target, depth + 1), ...tail);
      }
      return resolve(realpathSync(parent), ...tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const next = dirname(parent);
      if (next === parent) return path;
      tail.unshift(parent.slice(next.length).replace(/^[/\\]/, ''));
      parent = next;
    }
  }
}

export class RecentLedger {
  readonly file: string;
  private readonly root: string;
  private readonly protectedFiles: string[];
  private readonly maxEntries: number;
  private readonly now: () => Date;

  constructor(private readonly options: RecentLedgerOptions) {
    this.root = resolve(options.memoryDir);
    this.file = join(this.root, RECENT_LEDGER_FILE);
    this.protectedFiles = [LEGACY_FILE, RECENT_LEDGER_FILE, RECENT_SOURCE_FILE].map(file => join(this.root, file));
    if (options.maxEntries !== undefined && (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1)) throw new Error('maxEntries 必须是正整数');
    this.maxEntries = Math.min(2000, Math.max(1, Math.trunc(options.maxEntries ?? 500)));
    this.now = options.now ?? (() => new Date());
  }

  /** Model file tools call this before writes; it is not an OS or shell sandbox. */
  guardPath(path: string): string | null {
    const candidate = resolve(this.root, path.replaceAll('\\', '/'));
    const lexical = canonical(relative(this.root, candidate));
    if (lexical === 'recent.md' || lexical === '.persona' || lexical.startsWith('.persona/')) return this.denied();
    try {
      const realRoot = physical(this.root);
      const realCandidate = physical(candidate);
      const realRelative = canonical(relative(realRoot, realCandidate));
      if (realRelative === 'recent.md' || realRelative === '.persona' || realRelative.startsWith('.persona/')) return this.denied();
      if (existsSync(candidate)) {
        const target = statSync(candidate);
        for (const file of this.protectedFiles) {
          if (!existsSync(file)) continue;
          const original = statSync(file);
          if (target.dev === original.dev && target.ino === original.ino) return this.denied();
        }
      }
    } catch {
      return '无法确认写入路径的真实位置，未执行写入。';
    }
    return null;
  }

  private denied(): string {
    return 'RECENT 与来源台账由 Persona 管理；用 recent_append 记录逐字来源或待核笔记，recent_read 查看。';
  }

  private assertOwnedFile(path: string): void {
    const realRoot = physical(this.root);
    const actual = physical(path);
    const rel = relative(realRoot, actual);
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('台账路径越出 Memory');
    // Check each owned component, including dangling links that existsSync would miss.
    const parts = relative(this.root, path).split(sep);
    let current = this.root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      let info;
      try { info = lstatSync(current); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (info.isSymbolicLink()) throw new Error('台账路径包含链接，未操作');
      if (index === parts.length - 1 && (!info.isFile() || info.nlink > 1)) throw new Error('台账路径不是独占普通文件');
      if (index < parts.length - 1 && !info.isDirectory()) throw new Error('台账父路径不是目录');
    }
  }

  private load(): RecentEntry[] {
    if (!existsSync(this.file)) return [];
    this.assertOwnedFile(this.file);
    if (statSync(this.file).size > MAX_FILE_BYTES) throw new Error('来源台账超过读取上限；原文件已保留');
    let data: unknown;
    try { data = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('来源台账 JSON 损坏；原文件已保留，未覆盖'); }
    const record = data as { version?: unknown; entries?: unknown };
    if (!record || record.version !== 1 || !Array.isArray(record.entries)) throw new Error('来源台账格式不受支持；原文件已保留');
    const ids = new Set<string>();
    for (const entry of record.entries) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || ids.has(entry.id)
          || typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt))) throw new Error('来源台账条目损坏；原文件已保留');
      ids.add(entry.id);
      if (entry.kind === 'pending') checkedText(entry.text, '待核正文');
      else if (entry.kind === 'source-quote') {
        checkedText(entry.quote, '引用');
        const source = entry.source;
        if (!source || !Number.isSafeInteger(source.cursor) || source.cursor < 1
          || typeof source.senderKey !== 'string' || !source.senderKey
          || !['qq', 'qqbot'].includes(source.source) || source.type !== 'qq.message'
          || typeof source.ts !== 'string' || !Number.isFinite(Date.parse(source.ts))
          || !['normalized-message', 'formatted-event-quote'].includes(source.textBasis)
          || (source.truncated !== undefined && typeof source.truncated !== 'boolean')
          || (source.messageId !== undefined && (typeof source.messageId !== 'string' || !source.messageId))
          || typeof source.hash !== 'string' || !/^[a-f0-9]{64}$/.test(source.hash)) throw new Error('来源字段损坏；原文件已保留');
      } else throw new Error('来源台账条目类型不受支持');
    }
    return record.entries as RecentEntry[];
  }

  append(input: RecentAppend): RecentEntry {
    const createdAt = this.now().toISOString();
    let entry: RecentEntry;
    if (input.kind === 'pending') {
      entry = { id: randomUUID(), kind: 'pending', createdAt, text: checkedText(input.text, '待核正文') };
    } else if (input.kind === 'quote') {
      const quote = checkedText(input.quote, '引用');
      if (!input.source || !Number.isSafeInteger(input.source.cursor) || input.source.cursor < 1 || typeof input.source.senderKey !== 'string') {
        throw new Error('逐字引用必须提供 source.cursor 和 source.senderKey；无法找到来源时用 kind=pending');
      }
      if (input.source.messageId !== undefined && (typeof input.source.messageId !== 'string' || !input.source.messageId)) throw new Error('source.messageId 必须是非空字符串');
      const event = this.options.resolveSource(input.source.cursor);
      if (!event || event.cursor !== input.source.cursor || !isOriginalPrivateMessage(event)) throw new Error('未找到可核对的原始私聊来源；可改记待核');
      if (event.senderKey !== input.source.senderKey) throw new Error('来源属于其他联系人，未写入');
      const material = sourceText(event, quote, input.source.messageId);
      if (!material.text.includes(quote)) throw new Error('引用与来源原文不符，未写入');
      if (!Number.isFinite(Date.parse(event.ts))) throw new Error('来源日期无效，未写入');
      entry = { id: randomUUID(), kind: 'source-quote', createdAt, quote, source: {
        cursor: event.cursor, senderKey: event.senderKey!, source: event.source,
        type: event.type, ts: material.ts, hash: sourceHash(event), textBasis: material.basis,
        truncated: material.truncated,
        ...(material.messageId !== undefined ? { messageId: material.messageId } : {}),
      } };
    } else throw new Error('kind 必须是 quote 或 pending');

    this.assertOwnedFile(this.file);
    mkdirSync(dirname(this.file), { recursive: true });
    const lock = this.file + '.lock';
    let fd: number;
    try { fd = openSync(lock, 'wx'); } catch { throw new Error('来源台账正被写入或有未清理的锁；未执行本次写入'); }
    const temp = this.file + '.tmp-' + randomUUID();
    try {
      const before = existsSync(this.file) ? readFileSync(this.file) : null;
      const entries = this.load();
      if (entry.kind === 'source-quote') {
        const duplicate = entries.find(item => item.kind === 'source-quote' && item.source.cursor === entry.source.cursor
          && item.source.hash === entry.source.hash && item.quote === entry.quote
          && item.source.messageId === entry.source.messageId && item.source.ts === entry.source.ts);
        if (duplicate) return structuredClone(duplicate);
      }
      if (entries.length >= this.maxEntries) throw new Error('来源台账已满；请先由操作者归档，旧记录未删除');
      const payload = JSON.stringify({ version: 1, entries: [...entries, entry] }, null, 2) + '\n';
      if (Buffer.byteLength(payload) > MAX_FILE_BYTES) throw new Error('来源台账超过容量上限；旧记录未删除');
      writeFileSync(temp, payload, { encoding: 'utf8', flag: 'wx' });
      const current = existsSync(this.file) ? readFileSync(this.file) : null;
      if (before === null ? current !== null : current === null || !before.equals(current)) throw new Error('来源台账已被其他程序修改，本次写入取消');
      renameSync(temp, this.file);
      return structuredClone(entry);
    } finally {
      closeSync(fd);
      if (existsSync(temp)) unlinkSync(temp);
      unlinkSync(lock);
    }
  }

  /** Explicit operator storage clearing; preserves legacy RECENT and every other file. */
  clear(): void {
    this.assertOwnedFile(this.file);
    const lock = this.file + '.lock';
    if (!existsSync(dirname(this.file))) return;
    let fd: number;
    try { fd = openSync(lock, 'wx'); } catch { throw new Error('来源台账正被写入或有未清理的锁；未执行清除'); }
    try {
      this.assertOwnedFile(this.file);
      if (existsSync(this.file)) unlinkSync(this.file);
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }

  read(options: { limit?: number } = {}) {
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100)) throw new Error('limit 必须为 1–100 整数');
    const limit = options.limit ?? 20;
    const entries = this.load();
    const selected = entries.slice(-limit).map(entry => {
      if (entry.kind !== 'source-quote') return { ...entry, status: 'pending' as const };
      const current = this.options.resolveSource(entry.source.cursor);
      const status = current ? isOriginalPrivateMessage(current) && sourceHash(current) === entry.source.hash ? 'source-matches' : 'source-changed' : 'source-unavailable';
      return { ...entry, status };
    });
    const legacyPath = join(this.root, LEGACY_FILE);
    let legacy: { status: 'legacy-unsourced'; text: string; truncated: boolean } | null = null;
    if (existsSync(legacyPath)) {
      this.assertOwnedFile(legacyPath);
      if (statSync(legacyPath).size > MAX_FILE_BYTES) throw new Error('旧 RECENT 超过读取上限；文件仍原位保留');
      const text = readFileSync(legacyPath, 'utf8');
      legacy = { status: 'legacy-unsourced', text: text.slice(0, 8000), truncated: text.length > 8000 };
    }
    return { notice: '来源核对仅证明逐字引用出现在指定材料中，不证明陈述为真或归因正确。normalized-message 是 World 规范化消息正文；formatted-event-quote 可能含渠道标记、备注或提示，不可自动改写为“对方说”。source.truncated=true 表示核对材料仅为保留的连续前缀，不能推断完整原文。source-unavailable 需要找回来源；source-changed 不可沿用旧核对。待核及旧 RECENT 均不是已证实事实。',
      total: entries.length, omitted: Math.max(0, entries.length - selected.length), entries: selected, legacy };
  }

  /** Only numbers and fixed instructions may be used in the system prefix. */
  prefixStatus(): string {
    try {
      const entries = this.load();
      const quotes = entries.filter(entry => entry.kind === 'source-quote').length;
      return 'RECENT 来源台账：' + quotes + ' 条逐字引用、' + (entries.length - quotes) + ' 条待核笔记。'
        + (existsSync(join(this.root, LEGACY_FILE)) ? '旧 RECENT 保留为 legacy-unsourced。' : '')
        + '需要原文时调用 recent_read；引用日期以来源 ts 为准，记录日期不是事情发生日期。';
    } catch {
      return 'RECENT 来源台账暂不可读取；原文件保留。调用 recent_read 查看错误，不把未知状态当作已核实事实。';
    }
  }
}

export const RECENT_TOOL_DECLS: Array<Omit<ToolDef, 'handler'>> = [
  {
    name: 'recent_append', tags: ['write'],
    description: 'Record an exact quote from observed private-message material, or a pending note. textBasis distinguishes normalized message text from a legacy formatted event that may contain labels and notes. A matching source proves the quote exists, not its truth or speaker attribution. Dates come from the original event.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', enum: ['quote', 'pending'] },
      quote: { type: 'string', description: 'Exact source substring for kind=quote.' },
      text: { type: 'string', description: 'Unverified note for kind=pending.' },
      source: { type: 'object', additionalProperties: false, properties: {
        cursor: { type: 'integer', minimum: 1 }, senderKey: { type: 'string' },
        messageId: { type: 'string', description: 'Select one original message when a cursor contains multiple matching aggregated messages.' },
      }, required: ['cursor', 'senderKey'] },
    }, required: ['kind'] },
  },
  {
    name: 'recent_read', tags: ['read'],
    description: 'Read bounded recent quote records and pending notes. Legacy RECENT text remains explicitly unsourced. A source date is distinct from when this note was recorded.',
    parameters: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } },
  },
];

export function createRecentTools(ledger: RecentLedger): ToolDef[] {
  return RECENT_TOOL_DECLS.map(declaration => ({
    ...declaration,
    handler: async args => {
      try {
        if (declaration.name === 'recent_read') {
          if (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 100)) throw new Error('limit 必须为 1–100 整数');
          return JSON.stringify(ledger.read({ limit: args.limit as number | undefined }));
        }
        if (Object.keys(args).some(key => !['kind', 'quote', 'text', 'source'].includes(key))) throw new Error('不接受模型填写的日期或其他来源字段');
        if (args.kind === 'quote' && args.text !== undefined) throw new Error('quote 只保存逐字引用，不接受附加事实摘要');
        if (args.kind === 'pending' && (args.quote !== undefined || args.source !== undefined)) throw new Error('pending 只保存未核实正文，不带已核对来源声明');
        const source = args.source;
        if (source && typeof source === 'object' && Object.keys(source).some(key => !['cursor', 'senderKey', 'messageId'].includes(key))) throw new Error('source 只接受 cursor、senderKey 和可选 messageId，日期从原始事件取得');
        return JSON.stringify({ written: ledger.append(args as unknown as RecentAppend), notice: 'quote 仅核对指定材料中的逐字来源；textBasis 标明规范化消息或可能含备注的格式化事件，不证明内容真伪或归因。pending 始终待核。' });
      } catch (error) {
        return { text: error instanceof Error ? error.message : String(error), failed: true as const };
      }
    },
  }));
}
