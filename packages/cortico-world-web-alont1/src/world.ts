/**
 * 联网：网页搜索 + 读网页正文。
 *
 * 搜索用 Bing 的 HTML 页面（不要 key），读页面时把标签剥掉只留正文。
 * 只读，不登录、不提交表单。
 */
import type { ToolDef, World } from 'cortico/core/types.ts';
import type { WebConfigSection } from './config.ts';
import { autoWebUi } from './panel.ts';
import { WEB_DEFAULTS } from './config.ts';
import { readResponseBytes } from './http.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export const WEB_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'web_find',
    tags: ['read'],
    description: '联网搜索（Bing），返回标题、链接和摘要。查资料、看新闻、了解一件事的现状用这个。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string', description: '搜什么，中英文都行。' },
        count: { type: 'integer', description: '要几条，默认用配置值。' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_read',
    tags: ['read'],
    description: '打开一个网页，返回去掉标签后的正文（截断）。搜索结果里挑一条读全文用这个。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'http(s) 链接。' },
        max_chars: { type: 'integer', description: '最多返回多少字符，默认用配置值。' },
      },
      required: ['url'],
    },
  },
];

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (entity, n) => { const code = Number(n); return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity; });
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

export class WebWorld implements World {
  readonly id = 'web';
  private readonly cfg: WebConfigSection;

  constructor(cfg: WebConfigSection) {
    this.cfg = cfg;
  }

  envPromptVars(): Record<string, string> {
    return { 'web.results': String(this.cfg.maxResults) };
  }

  private async get(url: string): Promise<Response> {
    return fetch(url, {
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
  }

  tools(): ToolDef[] {
    const search: ToolDef = {
      ...WEB_TOOL_DECLS[0],
      tags: ['read'],
      handler: async (args: Record<string, unknown>) => {
        const query = String(args.query ?? '').trim();
        if (!query) return '没给要搜的词。';
        const count = Math.min(15, Math.max(1, Number(args.count ?? this.cfg.maxResults)));
        const url = 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&form=QBLH&setlang=zh-CN';
        try {
          const res = await this.get(url);
          if (!res.ok) return '搜索失败：HTTP ' + res.status + '（可能被网络挡了）';
          const html = new TextDecoder().decode(await readResponseBytes(res, 4_000_000));
          const chunks = html.split('<li class="b_algo"').slice(1);
          const items: Array<{ title: string; href: string; snippet: string }> = [];
          for (const chunk of chunks) {
            const a = chunk.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
            if (!a) continue;
            const snippet = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/);
            items.push({ href: a[1] as string, title: stripTags(a[2] as string).slice(0, 120), snippet: snippet ? stripTags(snippet[1] as string).slice(0, 220) : '' });
            if (items.length >= count) break;
          }
          if (!items.length) return '搜索没有解析出结果（页面结构可能变了，或者被挡了）。';
          return '「' + query + '」搜索结果（' + items.length + ' 条）：\n' + items.map((it, i) =>
            (i + 1) + '. ' + it.title + '\n   ' + it.href + (it.snippet ? '\n   ' + it.snippet : '')).join('\n');
        } catch (e) {
          return '搜索失败：' + String((e as Error)?.message ?? e);
        }
      },
    };

    const read: ToolDef = {
      ...WEB_TOOL_DECLS[1],
      tags: ['read'],
      handler: async (args: Record<string, unknown>) => {
        const url = String(args.url ?? '').trim();
        if (!/^https?:\/\//i.test(url)) return '只接受 http(s) 链接。';
        const maxChars = Math.min(20000, Math.max(500, Number(args.max_chars ?? this.cfg.maxChars)));
        try {
          const res = await this.get(url);
          if (!res.ok) return '打不开：HTTP ' + res.status;
          const type = res.headers.get('content-type') ?? '';
          if (!/html|text/i.test(type)) { await res.body?.cancel(); return '这个链接不是文本网页（content-type: ' + type + '）。'; }
          const body = new TextDecoder().decode(await readResponseBytes(res, 4_000_000));
          const text = stripTags(body);
          const cut = text.length > maxChars ? text.slice(0, maxChars) + '\n…（截断，原文 ' + text.length + ' 字）' : text;
          return '「' + url + '」正文：\n' + cut;
        } catch (e) {
          return '打不开：' + String((e as Error)?.message ?? e);
        }
      },
    };

    return [search, read];
  }

  webUi() {
    return autoWebUi('web', '联网', WEB_DEFAULTS)
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}
