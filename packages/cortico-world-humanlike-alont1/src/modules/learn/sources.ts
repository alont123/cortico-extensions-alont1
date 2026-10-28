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

export interface GatherResult { material: string; sources: string[] }

/**
 * 汇总三个源。任一失败都只记一笔，不影响其它。
 * material 是要交给模型读的原始材料——**注意它是材料，不是结论**。
 */
export async function gather(term: string, opts: { limit: number; timeoutMs: number }): Promise<GatherResult> {
  const { limit, timeoutMs } = opts;
  const jobs: Array<[string, Promise<string[] | TiebaPost[] | string>]> = [
    ['B站', bilibili(term, limit, timeoutMs)],
    ['贴吧', tieba(term, limit, timeoutMs)],
    ['萌娘百科', moegirl(term, timeoutMs)],
  ];

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

  return { material: parts.join('\n\n'), sources };
}
