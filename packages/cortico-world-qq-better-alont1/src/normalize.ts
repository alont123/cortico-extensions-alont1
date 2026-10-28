import { nowIso, shortTime } from 'cortico/core/util.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { faceName, faceIdByName } from './qface-map.ts';
import type { OneBotSegment } from './types.ts';

/** 把 OneBot 消息段数组渲染为对模型友好的纯文本（含引用/表情/@ 标注）。 */
export function renderIncoming(
  segments: OneBotSegment[] | string | undefined,
  ctx: { timezone: string; selfId: number; replyText?: string; replyRef?: string },
): string {
  if (typeof segments === 'string') return segments;
  if (!segments || !Array.isArray(segments)) return '';
  const out: string[] = [];
  if (ctx.replyText && ctx.replyRef) {
    out.push(`「引用 ${ctx.replyRef}${ctx.replyText ? '：' + ctx.replyText : ''}」`);
  }
  for (const seg of segments) {
    switch (seg.type) {
      case 'text':
        out.push(seg.data.text ?? '');
        break;
      case 'at':
        out.push(formatMention(seg.data.qq, seg.data.name, ctx.selfId));
        break;
      case 'face':
        out.push(`[表情${seg.data.id}：${faceName(Number(seg.data.id))}]`);
        break;
      case 'image':
        out.push(seg.data.summary ? `[图片：${seg.data.summary}]` : '[图片]');
        break;
      case 'record':
        out.push('[语音]');
        break;
      case 'video':
        out.push('[视频]');
        break;
      case 'file':
        out.push(`[文件：${seg.data.name ?? seg.data.file}]`);
        break;
      case 'forward':
        out.push('[合并转发消息]');
        break;
      case 'json':
      case 'xml': {
        const card = parseJsonCard(seg.data.data);
        out.push(card ? `[卡片：${card}]` : '[卡片]');
        break;
      }
      default:
        out.push(`[${seg.type}]`);
    }
  }
  return out.join('').trim();
}

function formatMention(qq: string, name: string | undefined, selfId: number): string {
  const id = Number(qq);
  // 点到她本人写成 `@你`：这是"有人在跟你说话"的标记，Persona 靠它决定要不要催她回话。
  // 写成 `@我` 的话从她那一侧读出来是"我自己 @ 了自己"，那条判据整条失效。
  if (id === selfId) return '@你';
  return name ? `@${name}` : `@${qq}`;
}

/** 纯文本形态（无引用），用于历史/搜索展示。 */
export function renderSegmentsPlain(segments: OneBotSegment[] | string | undefined): string {
  if (typeof segments === 'string') return segments;
  if (!segments || !Array.isArray(segments)) return '';
  return segments
    .map((seg) => {
      switch (seg.type) {
        case 'text':
          return seg.data.text ?? '';
        case 'at':
          return `@${seg.data.name ?? seg.data.qq}`;
        case 'face':
          return `[表情${seg.data.id}]`;
        case 'image':
          return '[图片]';
        case 'record':
          return '[语音]';
        case 'video':
          return '[视频]';
        case 'file':
          return `[文件:${seg.data.name ?? ''}]`;
        case 'forward':
          return '[合并转发]';
        default:
          return `[${seg.type}]`;
      }
    })
    .join('');
}

/**
 * 把待发送文本构建为 OneBot 发送段（对齐 fat-fish parse_reply_segments）：
 *   - [表情包:文件名] → image 段（本地文件，位于 emojiDir 下；文件缺失则丢弃，不报错）
 *   - [表情N] / [表情N:名称] → face 段
 *   - [中文表情名]（命中映射，如 [旺柴]/[笑哭]）→ face 段
 *   - @QQ号，或 @名字（对得上本会话里的某个人）→ at 段
 *   - 其它 [..] → 普通文本（保留方括号原样）
 * emojiDir 为空时不解析表情包标记。
 *
 * `@` 只在两种情况下当提到人：后面直接是号码，或者名字能解析成一个真人。
 * 别的一律按普通字符发出去——中文里"被@出来""别乱@"这种写法很常见，
 * 当成 at 段就是把一段散文交给 NapCat 去解析成 uid，解析不了整条消息都发不出去
 * （2026-09-23 12:53 真踩过：一条主动消息因为正文里有"被@出来"，NapCat 回 Get Uid Error，0/1 段）。
 * 认人还要求 `@` 前面是行首或空白/标点：紧跟在汉字后面的 `@` 是行文，不是点名。
 */
export function buildOutgoing(
  text: string,
  emojiDir = '',
  resolveMention?: (name: string) => string | undefined,
): OneBotSegment[] {
  const segments: OneBotSegment[] = [];
  const re = /\[([^\[\]]{1,40})\]|(?:^|(?<=[\s，。！？、：；,.!?;:…]))@([^\s@]{1,30})/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segments.push({ type: 'text', data: { text: text.slice(last, m.index) } });
    let nextLast = re.lastIndex;
    if (m[1] !== undefined) {
      const inner = m[1];
      const whole = m[0];
      if (inner.startsWith('表情包:')) {
        const fname = inner.slice('表情包:'.length).trim();
        if (emojiDir && fname) {
          const p = join(emojiDir, fname);
          if (existsSync(p)) segments.push({ type: 'image', data: { file: p } });
        }
        // 目录未配置或文件缺失：丢弃该标记
      } else if (/^表情\s*\d+(?:[:：][^\]]*)?$/.test(inner)) {
        const id = inner.match(/^表情\s*(\d+)/)![1];
        segments.push({ type: 'face', data: { id } });
      } else {
        const fid = faceIdByName(inner);
        if (fid !== null) segments.push({ type: 'face', data: { id: String(fid) } });
        else segments.push({ type: 'text', data: { text: whole } });
      }
    } else if (m[2] !== undefined) {
      // 名字后面常紧跟标点或下一句，不留空格：先按"切掉尾部标点"整串试，
      // 不成再找**最长的已知名字前缀**（`@某某什么时候回来` 里的 `@某某` 也算点到人）。
      const raw = m[2];
      const digits = raw.match(/^\d{5,}/)?.[0];
      let qq: string | undefined;
      let used = 0;
      if (digits) {
        qq = digits;
        used = digits.length;
      } else {
        const trimmed = raw.replace(/[，。！？、：；,.!?;:…）)】」"'”’]+$/, '');
        const exact = trimmed === '' ? undefined : resolveMention?.(trimmed);
        if (exact !== undefined) {
          qq = exact;
          used = trimmed.length;
        } else {
          for (let len = raw.length; len >= 2; len--) {
            const hit = resolveMention?.(raw.slice(0, len));
            if (hit !== undefined) { qq = hit; used = len; break; }
          }
        }
      }
      if (qq !== undefined) {
        segments.push({ type: 'at', data: { qq } });
        nextLast = m.index + 1 + used;
      } else {
        segments.push({ type: 'text', data: { text: m[0] } });
      }
    }
    last = nextLast;
    re.lastIndex = nextLast;
  }
  if (last < text.length) segments.push({ type: 'text', data: { text: text.slice(last) } });
  if (segments.length === 0) segments.push({ type: 'text', data: { text } });
  return segments;
}

export interface SplitReplyOptions {
  /** 是否按句拆分（false 则整段作为一条）。 */
  splitBySentence: boolean;
  /** 每条消息最多容纳句数。 */
  sentencesPerMessage: number;
  /** 单条消息字节上限，超过则对文字再按字节硬切。 */
  maxBytes: number;
  splitParagraphs?: boolean;
  stripTrailingPeriod?: boolean;
  minChars?: number;
  maxMessages?: number;
  coalesceShortSentences?: boolean;
}

/**
 * 把构建好的发送段拆成多条消息（对齐 fat-fish split_text_segments_by_sentence
 * + split_text_and_images）：文字按句标点拆分，face 跟随最后一条，image 独立成条；
 * 单条仍超 maxBytes 时再按字节硬切。splitBySentence=false 则整体一条。
 */
export function splitReplyIntoMessages(segments: OneBotSegment[], opts: SplitReplyOptions): OneBotSegment[][] {
  const images = segments.filter((s) => s.type === 'image');
  const textParts = segments.filter((s) => s.type !== 'image');
  const groups: OneBotSegment[][] = [];
  const strip = (text: string): string => opts.stripTrailingPeriod ? text.replace(/。\s*$/, '') : text;
  const faces = textParts.filter((segment) => segment.type === 'face');
  const hasStructure = textParts.some((segment) => segment.type !== 'text' && segment.type !== 'face');
  if (hasStructure) {
    // Mentions, replies and platform segments keep their relative position.
    const copied = textParts.map((segment) => segment.type === 'text'
      ? { ...segment, data: { ...segment.data } } : segment);
    const last = copied.findLastIndex((segment) => segment.type !== 'face');
    if (copied[last]?.type === 'text') copied[last].data.text = strip(String(copied[last].data.text ?? ''));
    let current: OneBotSegment[] = [];
    let currentBytes = 0;
    const byteLimit = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : Infinity;
    for (const segment of copied) {
      if (segment.type !== 'text') { current.push(segment); continue; }
      let piece = '';
      for (const character of String(segment.data.text ?? '')) {
        const size = Buffer.byteLength(character, 'utf8');
        if (size > byteLimit) throw new Error('单个字符超过消息字节上限；未发送，请增大单条字节上限。');
        if (currentBytes + size > byteLimit) {
          if (piece) current.push({ type: 'text', data: { text: piece } });
          groups.push(current); current = []; currentBytes = 0; piece = '';
        }
        piece += character;
        currentBytes += size;
      }
      if (piece) current.push({ type: 'text', data: { text: piece } });
    }
    if (current.length) groups.push(current);
  } else if (textParts.length) {
    const fullText = textParts.filter((segment) => segment.type === 'text')
      .map((segment) => String(segment.data.text ?? '')).join('');
    const minChars = Number.isFinite(opts.minChars) ? Math.max(0, Math.floor(opts.minChars!)) : 0;
    const canSplit = Array.from(fullText).length >= minChars;
    const paragraphs = canSplit && opts.splitParagraphs ? fullText.split(/\r?\n\s*\r?\n+/).map((text) => text.trim()).filter(Boolean) : [fullText];
    const perMessage = Number.isFinite(opts.sentencesPerMessage) ? Math.max(1, Math.floor(opts.sentencesPerMessage)) : 1;
    for (const paragraph of paragraphs) {
      const splitSentence = canSplit && opts.splitBySentence;
      const sentences = splitSentence ? paragraph.split(/(?<=[。！？!?；;\n])/).map((text) => text.trim()).filter(Boolean) : [paragraph];
      for (let i = 0; i < sentences.length; i += splitSentence ? perMessage : 1) {
        const text = strip(sentences.slice(i, i + (splitSentence ? perMessage : 1)).join(''));
        if (!text) continue;
        for (const piece of splitLongText(text, opts.maxBytes)) groups.push([{ type: 'text', data: { text: piece } }]);
      }
    }
    if (faces.length) {
      if (!groups.length) groups.push([]);
      groups[groups.length - 1].push(...faces);
    }
  }
  const textOf = (group: OneBotSegment[]) => group.filter(segment => segment.type === 'text').map(segment => String(segment.data.text ?? '')).join('');
  const textOnly = (group: OneBotSegment[]) => group.every(segment => segment.type === 'text');
  const fits = (text: string) => !Number.isFinite(opts.maxBytes) || opts.maxBytes <= 0 || Buffer.byteLength(text, 'utf8') <= opts.maxBytes;
  const mergeAt = (index: number) => { groups.splice(index, 2, [{ type: 'text', data: { text: textOf(groups[index]) + textOf(groups[index + 1]) } }]); };
  if (opts.coalesceShortSentences) {
    for (let i = 0; i < groups.length - 1;) {
      const left = textOf(groups[i]), right = textOf(groups[i + 1]);
      if (textOnly(groups[i]) && textOnly(groups[i + 1]) && (Array.from(left).length < (opts.minChars ?? 0) || Array.from(right).length < (opts.minChars ?? 0)) && fits(left + right)) mergeAt(i);
      else i++;
    }
  }
  const maxMessages = Number.isFinite(opts.maxMessages) ? Math.max(1, Math.floor(opts.maxMessages!)) : Infinity;
  while (groups.length + images.length > maxMessages) {
    const index = groups.findIndex((group, i) => i + 1 < groups.length && textOnly(group) && textOnly(groups[i + 1]) && fits(textOf(group) + textOf(groups[i + 1])));
    if (index < 0) break;
    mergeAt(index);
  }
  if (groups.length + images.length > maxMessages && groups.every(textOnly)) {
    const compact = splitLongText(groups.map(textOf).join(''), opts.maxBytes);
    groups.splice(0, groups.length, ...compact.map(text => [{ type: 'text' as const, data: { text } }]));
  }
  for (const img of images) groups.push([img]);
  if (groups.some(group => !fits(textOf(group)))) throw new Error('完整字符无法放入消息字节上限；未发送，请增大单条字节上限。');
  if (groups.length > maxMessages) throw new Error('完整消息需要 ' + groups.length + ' 条，超过单次上限 ' + maxMessages + '；未发送，请缩短正文、减少图片或调整拆条配置。');
  return groups.length ? groups : [[{ type: 'text', data: { text: '' } }]];
}

/** 把 [表情N] 标记展开成可读名称（用于 env/正文展示）。 */
export function renderTextWithFaces(text: string): string {
  return text.replace(/\[表情(\d+)(?::[^\]]*)?\]/g, (_m, id) => `[表情${id}：${faceName(Number(id))}]`);
}

/** 把长文本按字节数切分为多条（fat-fish split_for_sending 思路）。 */
export function splitLongText(text: string, maxBytes: number): string[] {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || Buffer.byteLength(text, 'utf8') <= maxBytes) return [text];
  const chunks: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (cur && bytes + size > maxBytes) {
      chunks.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += character;
    bytes += size;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** 解析 OneBot json 卡片描述（minimax / 掘地求生 / 红石等小游戏卡片）。 */
export function parseJsonCard(data: string | undefined): string | null {
  if (!data) return null;
  try {
    const card = JSON.parse(data);
    const prompt = card?.meta?.detail_1?.text ?? card?.prompt;
    if (typeof prompt === 'string' && prompt.trim()) return prompt.trim().slice(0, 200);
    if (Array.isArray(card?.app) === false && typeof card?.text === 'string') return card.text.slice(0, 200);
  } catch {
    /* 非 JSON，忽略 */
  }
  return null;
}

/** 事件行时间戳前缀。 */
export function eventClock(timezone: string, d: Date = new Date()): string {
  return shortTime(timezone, d);
}

export function eventTs(timezone: string, d: Date = new Date()): string {
  return nowIso(timezone, d);
}
