/**
 * Persona 收到的原始私聊事件转为有界交接资料。只选一个明确会话，按原始时间和游标呈现；
 * assistant 条目必须来自带机械受理结果的发送事件，正文或工具调用本身不算已发送。
 */
import type { EventEnvelope } from 'cortico/core/types.ts';
import { estimateTokens } from 'cortico/core/util.ts';

export interface DialogueEntry {
  ts: string;
  source: string;
  eventType: string;
  senderKey: string;
  conversation: string;
  role: 'user' | 'assistant';
  text: string;
  cursor: number;
  platformMessageIds?: string[];
  /** 同一聚合事件内的原始消息序号；游标仍指向该事件。 */
  sourceIndex?: number;
  delivery?: 'accepted';
  /** Cached contiguous prefix only, never a complete original message. */
  truncated?: boolean;
  textBasis?: 'normalized-message' | 'world-delivered' | 'service-accepted';
}

export interface DialogueOptions {
  windowMinutes: number;
  maxMessages: number;
  reserveTokens: number;
  prioritizeSenderKeys: readonly string[];
}

export interface DialogueSelection {
  entries: DialogueEntry[];
  text: string;
  tokens: number;
  conversation: string | null;
  omittedByCount: number;
  omittedByBudget: number;
}

const SOURCE_IDS = new Set(['qq', 'qqbot']);
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const safeText = (text: string): string => text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');

function privateConversation(meta: Record<string, unknown>): string | null {
  const conv = object(meta.conv);
  if (conv?.kind !== 'private') return null;
  const id = String(conv.id ?? '');
  return /^[1-9]\d*$/.test(id) ? 'private:' + id : null;
}

/** 只读取 World 的公开元数据；不根据昵称、正文、转发文本或摘要猜收件人。 */
export function collectDialogueEvents(events: readonly EventEnvelope[]): DialogueEntry[] {
  const out: DialogueEntry[] = [];
  for (const event of events) {
    if (!SOURCE_IDS.has(event.source) || event.origin !== 'external' ||
      !Number.isSafeInteger(event.cursor) || event.cursor < 1 || !Number.isFinite(Date.parse(event.ts))) continue;
    const meta = object(event.meta);
    const conversation = meta && privateConversation(meta);
    if (!meta || !conversation) continue;
    const contact = conversation.slice('private:'.length);
    if (event.senderKey && event.senderKey !== contact && event.senderKey !== conversation) continue;
    const inbound = event.type === 'qq.message' && meta.direction !== 'outbound' && !event.tags?.includes('speak');
    const outbound = event.type === 'qq.sent' && event.tags?.includes('speak') &&
      meta.direction === 'outbound' && meta.delivery === 'accepted' && typeof meta.text === 'string';
    if (!inbound && !outbound) continue;
    const fromUser = meta.user ?? meta.user_id;
    if (inbound && fromUser !== undefined && String(fromUser) !== contact) continue;
    if (inbound && meta.messageTextBasis === 'aggregated-normalized-messages') {
      if (!Array.isArray(meta.messages)) continue;
      meta.messages.forEach((value, sourceIndex) => {
        const item = object(value);
        if (!item || typeof item.text !== 'string' || !item.text.trim() ||
          typeof item.ts !== 'string' || !Number.isFinite(Date.parse(item.ts))) return;
        const id = item.messageId !== undefined && item.messageId !== null && String(item.messageId) !== '' ? [String(item.messageId)] : undefined;
        out.push({
          ts: item.ts, source: event.source, eventType: event.type, senderKey: event.senderKey ?? conversation,
          conversation, role: 'user', text: safeText(item.text), cursor: event.cursor, sourceIndex,
          textBasis: 'normalized-message', ...(item.textTruncated === true ? { truncated: true } : {}),
          ...(id ? { platformMessageIds: id } : {}),
        });
      });
      continue;
    }
    const normalized = meta.messageTextBasis === 'normalized-message' && typeof meta.messageText === 'string';
    const text = outbound ? meta.text as string : normalized ? meta.messageText as string : event.text;
    if (!text.trim()) continue;
    const messageId = outbound ? meta.messageId : meta.platformMessageId ?? meta.message_id;
    const ids = messageId !== undefined && messageId !== null && String(messageId) !== '' ? [String(messageId)] : undefined;
    const truncated = outbound ? meta.textTruncated === true : normalized ? meta.messageTextTruncated === true : meta.sourceTextTruncated === true;
    out.push({
      ts: event.ts, source: event.source, eventType: event.type, senderKey: event.senderKey ?? conversation,
      conversation, role: outbound ? 'assistant' : 'user', text: safeText(text), cursor: event.cursor,
      textBasis: outbound ? 'service-accepted' : normalized ? 'normalized-message' : 'world-delivered',
      ...(truncated ? { truncated: true } : {}),
      ...(ids ? { platformMessageIds: ids } : {}), ...(outbound ? { delivery: 'accepted' as const } : {}),
    });
  }
  return out;
}

function render(entries: readonly DialogueEntry[], conversation: string, omittedByCount: number, omittedByBudget: number): string {
  const header = '# 交接笔记 · 最近双向对话\n\n会话：' + conversation +
    '。以下是先前收到的外部对话资料；时间为原始发生时间，不是本次交接时间。' +
    '用户条目注明正文形式，旧投递文字可能含频道前缀；assistant 条目仅表示发送服务已受理，不证明对方收到或已读。';
  const omissions = omittedByCount || omittedByBudget
    ? '\n本会话窗口内另有 ' + omittedByCount + ' 条因条数上限、' + omittedByBudget + ' 条因原文预算未收录；未收录不表示没有发生。' : '';
  return header + omissions + '\n\n' + entries.map(entry => {
    const ref = entry.source + '/' + entry.eventType + ' cursor ' + entry.cursor +
      (entry.sourceIndex === undefined ? '' : ' messageIndex ' + entry.sourceIndex);
    const ids = entry.platformMessageIds?.length ? '；平台消息 ' + entry.platformMessageIds.join(', ') : '';
    const basis = (entry.textBasis === 'normalized-message' ? '规范化消息正文'
      : entry.role === 'assistant' ? '服务已受理的段落' : '旧 World 投递文字，可能含频道说明')
      + (entry.truncated ? '（缓存仅保留连续前缀，非完整原文）' : '');
    return '## ' + entry.ts + ' · ' + entry.role + '\n来源：' + ref + ids + '\n正文形式：' + basis + '\n' + entry.text;
  }).join('\n\n');
}

/** 预留原文不做年龄衰减；超限省略整条，不能把残句表示成完整原话。 */
export function selectDialogue(
  entries: readonly DialogueEntry[],
  options: DialogueOptions & { now: Date; budgetTokens: number },
): DialogueSelection {
  const empty: DialogueSelection = { entries: [], text: '', tokens: 0, conversation: null, omittedByCount: 0, omittedByBudget: 0 };
  const now = options.now.getTime();
  const maxMessages = Math.max(0, Math.min(200, Math.floor(options.maxMessages)));
  const budget = Math.max(0, Math.min(Math.floor(options.reserveTokens), Math.floor(options.budgetTokens)));
  if (!Number.isFinite(now) || !Number.isFinite(maxMessages) || !Number.isFinite(budget) ||
    !Number.isFinite(options.windowMinutes) || options.windowMinutes <= 0 || maxMessages === 0 || budget === 0) return empty;
  const from = now - options.windowMinutes * 60_000;
  const scoped = entries.filter(entry => {
    const at = Date.parse(entry.ts);
    return SOURCE_IDS.has(entry.source) && Number.isSafeInteger(entry.cursor) && entry.cursor > 0 &&
      /^private:[1-9]\d*$/.test(entry.conversation) && typeof entry.text === 'string' && entry.text.trim() &&
      (entry.role === 'user' && entry.eventType === 'qq.message' ||
        entry.role === 'assistant' && entry.eventType === 'qq.sent' && entry.delivery === 'accepted') &&
      Number.isFinite(at) && at >= from && at <= now &&
      (!options.prioritizeSenderKeys.length || options.prioritizeSenderKeys.some(key =>
        key === entry.senderKey || key === entry.conversation || key === entry.conversation.slice('private:'.length)));
  }).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.cursor - b.cursor);
  // 未配置身份时只恢复最近一位来信人的会话；不把同一批其他联系人的消息合并进来。
  const conversation = [...scoped].reverse().find(entry => entry.role === 'user')?.conversation ?? scoped.at(-1)?.conversation;
  if (!conversation) return empty;
  const unique = new Map<string, DialogueEntry>();
  for (const entry of scoped) {
    if (entry.conversation !== conversation) continue;
    const id = entry.platformMessageIds?.length ? entry.platformMessageIds.join(',') : 'cursor:' + entry.cursor + ':' + (entry.sourceIndex ?? '');
    unique.set(entry.source + '\0' + conversation + '\0' + entry.role + '\0' + id, entry);
  }
  const all = [...unique.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.cursor - b.cursor);
  const capped = all.slice(-maxMessages);
  const omittedByCount = Math.max(0, all.length - capped.length);
  let selected: DialogueEntry[] = [];
  let text = '';
  for (let i = capped.length - 1; i >= 0; i--) {
    const candidate = [capped[i], ...selected];
    const candidateText = render(candidate, conversation, omittedByCount, i);
    if (estimateTokens(candidateText) > budget) break;
    selected = candidate; text = candidateText;
  }
  return {
    entries: selected, text, tokens: estimateTokens(text), conversation,
    omittedByCount, omittedByBudget: capped.length - selected.length,
  };
}
