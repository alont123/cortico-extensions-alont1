/**
 * B站：给一个视频链接或 BV 号，读标题、UP 主、简介、分P、播放数据；有字幕就把字幕拉下来。
 * 全部走公开 API（view / player/v2），不登录、不下载视频。
 */
import type { ToolDef, World } from 'cortico/core/types.ts';
import type { BiliConfigSection } from './config.ts';
import { autoWebUi } from './panel.ts';
import { BILI_DEFAULTS } from './config.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const HDR = { 'user-agent': UA, referer: 'https://www.bilibili.com/' };

export const BILI_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'bili_video', tags: ['read'],
    description: '看一个 B站视频的信息：给 BV 号或视频链接，返回标题、UP 主、简介、时长、分P、播放/点赞数。',
    parameters: { type: 'object', additionalProperties: false, properties: { url: { type: 'string', description: 'BV 号或视频链接。' } }, required: ['url'] },
  },
  {
    name: 'bili_subtitle', tags: ['read'],
    description: '拉一个 B站视频的字幕（有的话），返回字幕文本前几千字；没有字幕会直说。',
    parameters: { type: 'object', additionalProperties: false, properties: { url: { type: 'string', description: 'BV 号或视频链接。' }, part: { type: 'integer', description: '第几个分P，从 1 开始，默认 1。' } }, required: ['url'] },
  },
];

function bvidOf(input: string): string | null {
  const m = input.match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : null;
}
async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: HDR, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
function secs(t: number): string {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') : m + ':' + String(s).padStart(2, '0');
}

export class BiliWorld implements World {
  readonly id = 'bili';
  constructor(private readonly cfg: BiliConfigSection) {}
  envPromptVars(): Record<string, string> { return { 'bili.enabled': this.cfg.enabled ? '开' : '关' }; }

  async videoInfo(input: string): Promise<{ text: string; data?: any }> {
    const bvid = bvidOf(input);
    if (!bvid) return { text: '认不出 BV 号（要形如 BV1xx411c7xx 或视频链接）。' };
    const j = await getJson('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid);
    if (j.code !== 0) return { text: 'B站拒绝了：' + j.code + ' ' + (j.message ?? '') };
    const d = j.data ?? {};
    const pages = (d.pages ?? []).map((p: any, i: number) => i + 1 + '. ' + p.part + '（' + secs(p.duration) + '）').join('\n');
    const text = [
      '标题：' + d.title,
      'UP主：' + (d.owner?.name ?? '?'),
      '时长：' + secs(d.duration ?? 0) + '，分P：' + (d.pages?.length ?? 1),
      '播放：' + (d.stat?.view ?? 0) + '，点赞：' + (d.stat?.like ?? 0) + '，弹幕：' + (d.stat?.danmaku ?? 0),
      '简介：' + String(d.desc === '-' ? '（无）' : d.desc ?? '').slice(0, 300),
      pages ? '分P：\n' + pages : '',
      '链接：https://www.bilibili.com/video/' + bvid,
    ].filter(Boolean).join('\n');
    return { text, data: d };
  }

  tools(): ToolDef[] {
    const video: ToolDef = { ...BILI_TOOL_DECLS[0], tags: ['read'], handler: async (args) => {
      try { return (await this.videoInfo(String(args.url ?? ''))).text; } catch (e) { return '读不了：' + String((e as Error)?.message ?? e); }
    } };
    const subtitle: ToolDef = { ...BILI_TOOL_DECLS[1], tags: ['read'], handler: async (args) => {
      try {
        const input = String(args.url ?? '');
        const part = Number(args.part ?? 1);
        if (!Number.isInteger(part) || part < 1) return 'part 必须是从 1 开始的分P整数。';
        const info = await this.videoInfo(input);
        if (!info.data) return info.text;
        const pages = info.data.pages ?? [];
        if (part > pages.length) return '不存在第 ' + part + ' 个分P；该视频共有 ' + pages.length + ' 个分P。';
        const cid = pages[part - 1]?.cid;
        if (!cid) return '这个视频没有分P信息，读不到字幕。';
        const j = await getJson('https://api.bilibili.com/x/player/v2?bvid=' + bvidOf(input) + '&cid=' + cid);
        if (j.code !== 0) return '字幕接口拒绝了请求：' + j.code + ' ' + (j.message ?? '');
        const subs = j.data?.subtitle?.subtitles ?? [];
        if (!subs.length) return '这个视频没有字幕（或字幕要登录才给）。标题：' + info.data.title;
        const pick = subs.find((s: any) => /zh|ai-zh/i.test(s.lan ?? '')) ?? subs[0];
        const res = await fetch(pick.subtitle_url.startsWith('//') ? 'https:' + pick.subtitle_url : pick.subtitle_url, { headers: HDR, signal: AbortSignal.timeout(20000) });
        if (!res.ok) return '字幕下载失败：HTTP ' + res.status;
        const sj = await res.json();
        const body = (sj.body ?? []).map((b: any) => b.content).join(' ');
        return '字幕（' + (pick.lan_doc ?? pick.lan) + '，前 3000 字）：\n' + body.slice(0, 3000);
      } catch (e) { return '读字幕失败：' + String((e as Error)?.message ?? e); }
    } };
    return [video, subtitle];
  }
  webUi() {
    return autoWebUi('bili', 'B站', BILI_DEFAULTS)
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}
