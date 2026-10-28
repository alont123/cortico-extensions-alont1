/**
 * 中文网络用语查询源。从本地 harness 的 src/sources.js 移植。
 *
 * 为什么不用通用搜索：Bing 遇到「破防」这种词会返回单字字典页，五种写法结果一样，没用。
 * 实测三个源都比它强，而且都不需要密钥：
 *   · B站搜索 API    —— 视频标题就是真实用法，能看出语气和语境
 *   · 贴吧移动版     —— 帖子标题，黑话的源头（返回的是 JSON，字段在 data.post_list）
 *   · 萌娘百科       —— 直接给释义，ACG 用语最准
 *
 * 任何一个源挂了都不影响其它源。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 贴吧要个 cookie 才不 403（随便一个假的就行） */
const TIEBA_COOKIE = 'BAIDUID=00000000000000000000000000000000:FG=1; BIDUPSID=0000; PSTM=1700000000';

async function httpText(url: string, headers: Record<string, string> = {}, timeoutMs = 15_000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', ...headers },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function stripTags(s: unknown): string {
  return String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ① B站：视频标题，能看出这词怎么用 */
async function bilibili(term: string, limit: number, timeoutMs: number): Promise<string[]> {
  const url = `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(term)}`;
  const txt = await httpText(url, { Referer: 'https://search.bilibili.com/' }, timeoutMs);
  const j = JSON.parse(txt) as { code?: number; data?: { result?: Array<{ result_type?: string; data?: Array<{ title?: string }> }> } };
  if (j.code !== 0) throw new Error(`B站 code=${j.code}`);
  const out: string[] = [];
  for (const blk of j.data?.result ?? []) {
    if (blk.result_type !== 'video') continue;
    for (const v of blk.data ?? []) {
      const title = stripTags(v.title);
      if (title) out.push(title);
      if (out.length >= limit) break;
    }
    break;
  }
  return out;
}

export interface TiebaPost { forum: string; title: string; content: string }

/** ② 贴吧：帖子标题 + 头几句。注意返回的是 JSON，不是 HTML。 */
async function tieba(term: string, limit: number, timeoutMs: number): Promise<TiebaPost[]> {
  const url = `https://tieba.baidu.com/mo/q/search/thread?word=${encodeURIComponent(term)}`;
  const txt = await httpText(url, { Cookie: TIEBA_COOKIE, Referer: 'https://tieba.baidu.com/' }, timeoutMs);

  type Raw = { title?: string; content?: string; forum_name?: string };
  let list: Raw[] | null = null;
  try {
    const j = JSON.parse(txt) as { no?: number; data?: { post_list?: Raw[] } };
    if (j.no !== 0) throw new Error(`no=${j.no}`);
    list = j.data?.post_list ?? [];
  } catch {
    list = null; // 万一哪天又改回 HTML
  }

  if (!list) {
    const out: TiebaPost[] = [];
    const re = /<a[^>]+href="[^"]*\/p\/\d+[^"]*"[^>]*>([\s\S]{4,120}?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(txt)) && out.length < limit) {
      const t = stripTags(m[1]);
      if (t.length >= 4 && !out.some((x) => x.title === t)) out.push({ forum: '', title: t, content: '' });
    }
    return out;
  }

  const out: TiebaPost[] = [];
  const seen = new Set<string>();
  for (const p of list) {
    const title = stripTags(p.title);
    if (title.length < 4 || seen.has(title)) continue;
    const content = stripTags(p.content).slice(0, 70);
    // 网盘引流小广告，跟词义无关
    if (/提取码|网盘链接|pan\.baidu|\?推荐[:：]/.test(content) || /提取码|网盘链接/.test(title)) continue;
    seen.add(title);
    out.push({ forum: stripTags(p.forum_name), title, content });
    if (out.length >= limit) break;
  }
  return out;
}

/** ③ 萌娘百科：直接给释义 */
async function moegirl(term: string, timeoutMs: number): Promise<string> {
  const url = `https://zh.moegirl.org.cn/${encodeURIComponent(term)}`;
  const html = await httpText(url, {}, Math.max(timeoutMs, 20_000));
  if (/找不到这个页面|没有找到/.test(html.slice(0, 4000))) return '';
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
  const cut = body.search(/基本信息|用语名称|简介|娘化|本条目/);
  if (cut > 0) body = body.slice(cut);
  return body.slice(0, 1200).trim();
}

/**
 * ④ 百度百科：官方开放接口，直接给释义。
 *
 * 为什么不抓词条页：词条页对非浏览器 UA 一律回「百度安全验证」（403），
 * 换头、带 Referer、先取 cookie 都过不去。这个 openapi 是给第三方读词条摘要用的，
 * 不需要密钥，返回结构化 JSON：`abstract` 是摘要，`card` 是信息卡（含义/流行时间/拼音…）。
 */
async function baike(term: string, timeoutMs: number): Promise<string> {
  const url = 'https://baike.baidu.com/api/openapi/BaikeLemmaCardApi'
    + `?scope=103&format=json&appid=379020&bk_key=${encodeURIComponent(term)}&bk_length=600`;
  const txt = await httpText(url, { Referer: 'https://baike.baidu.com/' }, timeoutMs);
  const j = JSON.parse(txt) as {
    errno?: number;
    title?: string;
    abstract?: string;
    desc?: string;
    card?: Array<{ name?: string; value?: unknown }>;
  };
  // errno 非 0 或没有 abstract 都算"这个词条没有"，不是错误。
  if (j.errno !== undefined && j.errno !== 0) return '';
  const lines: string[] = [];
  const title = stripTags(j.title);
  if (title) lines.push(`词条：${title}${j.desc ? `（${stripTags(j.desc)}）` : ''}`);
  const abstract = stripTags(j.abstract);
  if (abstract) lines.push(abstract);
  for (const c of j.card ?? []) {
    const name = stripTags(c.name);
    // value 有时是数组有时是字符串；取第一个非空的。
    const rawValue = Array.isArray(c.value) ? c.value[0] : c.value;
    const value = stripTags(rawValue);
    if (name && value && value !== title) lines.push(`${name}：${value}`);
    if (lines.length >= 8) break;
  }
  return lines.join('\n');
}

export interface GatherResult { material: string; sources: string[] }

// ── 自定义搜索源（配置里导入） ──────────────────────────────────────────────
//
// 为什么做成"配置即源"而不是内置一个爬虫：站点的反爬随时会变，写死在代码里的爬虫
// 坏了要等我们发新版；写成配置，坏了当场改一行 JSON 就能修。
//
// 而且老实说：**小红书没有可用的公开入口**（实测：搜索页只回 SPA 空壳、
// 接口要登录态与 JS 签名，未登录直接 406）。所以它作为模板给在这里——
// 用通用搜索按 `site:` 限定取它的标题与摘要，站方改版时改 url 即可。

/**
 * 一个自定义源。
 *
 * - `kind: 'list'`     —— 取一串标题（`extract` 用带 `g` 的正则，取第 1 个捕获组）
 * - `kind: 'definition'` —— 取一段正文（`extract` 不带 `g`，取第 1 个捕获组当正文）
 *
 * `url` 里的 `{q}` 会换成 URL 编码后的搜索词；`headers` 用来带 Cookie / Referer 这类头。
 */
export interface CustomSource {
  name: string;
  url: string;
  kind: 'list' | 'definition';
  /** 提取正文的正则（字符串形式，写进 JSON 不用转义反斜杠两次）。 */
  extract?: string;
  /** 额外请求头，例如 Cookie、Referer。 */
  headers?: Record<string, string>;
  /** 这个源用哪个 cookie 配置项（只认 `xiaohongshu`，由 xhsCookie 提供）。 */
  cookie?: 'xiaohongshu';
  /** 关掉的源留着配置不生效。 */
  enabled?: boolean;
  /** 失败/为空时的说明，给她看的。 */
  note?: string;
}

const SOURCE_NAME_MAX = 16;

/** 解析配置里的 JSON。返回可用的源与**给人看的**错误说明（错误不抛，只报告）。 */
export function parseCustomSources(raw: string | undefined): { sources: CustomSource[]; errors: string[] } {
  const text = String(raw ?? '').trim();
  if (!text) return { sources: [], errors: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { sources: [], errors: [`不是合法 JSON（${e instanceof Error ? e.message : String(e)}）`] };
  }

  const list = Array.isArray(parsed) ? parsed : [parsed];
  const sources: CustomSource[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  list.forEach((item, i) => {
    const at = `第 ${i + 1} 个`;
    if (!item || typeof item !== 'object') { errors.push(`${at}不是对象`); return; }
    const o = item as Record<string, unknown>;
    const name = String(o.name ?? '').trim();
    const url = String(o.url ?? '').trim();
    const kind = o.kind === 'definition' ? 'definition' : o.kind === 'list' ? 'list' : null;

    if (!name) { errors.push(`${at}缺 name`); return; }
    if (name.length > SOURCE_NAME_MAX) { errors.push(`「${name}」名字太长（≤${SOURCE_NAME_MAX} 字）`); return; }
    if (!url) { errors.push(`「${name}」缺 url`); return; }
    if (!url.includes('{q}')) { errors.push(`「${name}」的 url 里要有 {q} 占位（会被换成搜索词）`); return; }
    if (!kind) { errors.push(`「${name}」的 kind 只能是 list 或 definition`); return; }
    if (o.extract !== undefined) {
      try { new RegExp(String(o.extract)); } catch { errors.push(`「${name}」的 extract 不是合法正则`); return; }
    }
    if (seen.has(name)) { errors.push(`有重名的源「${name}」`); return; }
    seen.add(name);

    const headers = o.headers && typeof o.headers === 'object'
      ? Object.fromEntries(Object.entries(o.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : undefined;

    sources.push({
      name, url, kind,
      ...(o.extract !== undefined ? { extract: String(o.extract) } : {}),
      ...(headers ? { headers } : {}),
      ...(o.cookie === 'xiaohongshu' ? { cookie: 'xiaohongshu' as const } : {}),
      enabled: o.enabled !== false,
      ...(o.note !== undefined ? { note: String(o.note) } : {}),
    });
  });

  return { sources, errors };
}

/** 跑一个自定义源。返回它的材料（标题表或正文）。 */
async function runCustomSource(
  s: CustomSource,
  term: string,
  limit: number,
  timeoutMs: number,
  xhsCookie: string | undefined,
): Promise<string[] | string> {
  const headers: Record<string, string> = { ...(s.headers ?? {}) };
  if (s.cookie === 'xiaohongshu' && xhsCookie) headers.Cookie = xhsCookie;

  const url = s.url.replace(/\{q\}/g, encodeURIComponent(term));
  const body = await httpText(url, headers, timeoutMs);

  if (s.kind === 'definition') {
    if (!s.extract) return '';
    const m = body.match(new RegExp(s.extract));
    return stripTags(m?.[1] ?? '').slice(0, 1200);
  }

  // list：没有 extract 就退化成"抓页面里的链接文字"，通常不好用，所以默认必须给 extract。
  const out: string[] = [];
  if (!s.extract) return out;
  const re = new RegExp(s.extract, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null && out.length < limit) {
    const text = stripTags(m[1] ?? '');
    if (text.length >= 2 && !out.includes(text)) out.push(text);
    if (m.index === re.lastIndex) re.lastIndex++; // 防零宽匹配死循环
  }
  return out;
}

/**
 * 汇总所有源。任一失败都只记一笔，不影响其它。
 * material 是要交给模型读的原始材料——**注意它是材料，不是结论**。
 */
export async function gather(
  term: string,
  opts: { limit: number; timeoutMs: number; customJson?: string; xhsCookie?: string },
): Promise<GatherResult> {
  const { limit, timeoutMs } = opts;
  const builtin: Array<[string, Promise<string[] | TiebaPost[] | string>]> = [
    ['B站', bilibili(term, limit, timeoutMs)],
    ['贴吧', tieba(term, limit, timeoutMs)],
    ['萌娘百科', moegirl(term, timeoutMs)],
    ['百度百科', baike(term, timeoutMs)],
  ];

  const parsed = parseCustomSources(opts.customJson);
  const custom = parsed.sources
    .filter((s) => s.enabled !== false)
    .map(
      (s) => [s.name, runCustomSource(s, term, limit, timeoutMs, opts.xhsCookie)] as [string, Promise<string[] | TiebaPost[] | string>],
    );

  const jobs = [...builtin, ...custom];
  const results = await Promise.all(
    jobs.map(([name, p]) => p.then((r) => [name, r] as const).catch((e: unknown) => [name, { error: e instanceof Error ? e.message : String(e) }] as const)),
  );

  const parts: string[] = [];
  const sources: string[] = [];
  for (const [name, r] of results) {
    if (r && typeof r === 'object' && 'error' in r) {
      sources.push(`${name}✗(${r.error})`);
      continue;
    }
    if (Array.isArray(r) && r.length === 0) continue;
    if (typeof r === 'string' && !r) continue;
    sources.push(name);

    if (typeof r === 'string') {
      parts.push(`【${name}】释义：\n${r}`);
    } else if (Array.isArray(r) && typeof r[0] === 'string') {
      parts.push(`【${name}】相关标题（能看出这词怎么用）：\n${(r as string[]).map((x) => '· ' + x).join('\n')}`);
    } else {
      const lines = (r as TiebaPost[]).map((p) => {
        const head = p.forum ? `（${p.forum}吧）` : '';
        return `· ${head}${p.title}${p.content ? `\n  ${p.content}` : ''}`;
      });
      parts.push(`【${name}】真实帖子（看别人怎么用这词）：\n${lines.join('\n')}`);
    }
  }

  // 配置写错时说清楚，不然她只会看到"某个源没结果"，查不出来为什么。
  if (parsed.errors.length) {
    parts.push(`【自定义源没生效】${parsed.errors.join('；')}`);
    sources.push(`自定义源✗(${parsed.errors.length} 处配置问题)`);
  }

  return { material: parts.join('\n\n'), sources };
}
