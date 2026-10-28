/**
 * 图片与头像：让 bot 自己找图、存图、换 QQ 头像。
 *
 * 三个能力串起来就是「自己换头像」：
 *   image_search 搜到直链 → image_download 存进本扩展 dataDir/imagekit/avatar/ → avatar_set 设成头像。
 * 换头像是公开的，别人看得见，所以工具描述里写明要想清楚。
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import type { ToolDef, World, WorldHost } from 'cortico/core/types.ts';
import type { ImagekitConfigSection } from './config.ts';
import { autoWebUi } from './panel.ts';
import { IMAGEKIT_DEFAULTS } from './config.ts';
import { readResponseBytes } from './http.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

export const IMAGEKIT_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'image_search',
    tags: ['read'],
    description: '搜图片，返回若干张图的直链（可直接给 image_download）。用来给自己找头像、配图。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string', description: '搜什么，中英文都行。' },
        count: { type: 'integer', description: '要几张，默认用配置值（最多 20）。' },
      },
      required: ['query'],
    },
  },
  {
    name: 'image_download',
    tags: ['write'],
    description: '把一张图下载到本扩展的数据目录（只收图片，限大小），返回路径。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        url: { type: 'string', description: '图片直链（image_search 给的那种）。' },
        name: { type: 'string', description: '存成什么名字，可不填。' },
      },
      required: ['url'],
    },
  },
  {
    name: 'image_list',
    tags: ['read'],
    description: '看看本扩展 avatar 目录里已经有哪些图。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'avatar_set',
    tags: ['write'],
    description: '把自己的 QQ 头像换成指定图片（OneBot v11 set_qq_avatar，SnowLuma / NapCat 都走这个接口）。本地路径或 http(s) 链接；不填就用最近下载的那张。换头像是公开的，别人看得见，换之前想清楚。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        file: { type: 'string', description: '本地路径或图片链接。不填就用 avatar 目录里最新的一张。' },
      },
    },
  },
];

/** 按文件头判断图片类型，返回扩展名；不是图片就 null。 */
function sniffImage(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.slice(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf.slice(0, 2).toString('ascii') === 'BM') return 'bmp';
  return null;
}

function safeName(name: string): string {
  return name.replace(/[^\w.\u4e00-\u9fa5-]+/g, '_').replace(/^_+/, '').slice(0, 60) || 'image';
}

export class ImagekitWorld implements World {
  readonly id = 'imagekit';
  host: WorldHost | null = null;
  private readonly cfg: ImagekitConfigSection;
  private readonly avatarDir: string;

  constructor(opts: { botDir: string; dataDir?: string; cfg: ImagekitConfigSection }) {
    this.cfg = opts.cfg;
    this.avatarDir = join(opts.dataDir ?? join(opts.botDir, 'data'), 'imagekit', 'avatar');
  }

  envPromptVars(): Record<string, string> {
    return { 'imagekit.dir': this.avatarDir };
  }

  private ensureDir(): string {
    mkdirSync(this.avatarDir, { recursive: true });
    return this.avatarDir;
  }

  private listFiles(): Array<{ name: string; size: number; mtime: number }> {
    try {
      return readdirSync(this.avatarDir)
        .filter((f) => IMAGE_EXT.test(f))
        .map((f) => {
          const st = statSync(join(this.avatarDir, f));
          return { name: f, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return [];
    }
  }

  tools(): ToolDef[] {
    const search: ToolDef = {
      ...IMAGEKIT_TOOL_DECLS[0],
      tags: ['read'],
      handler: async (args: Record<string, unknown>) => {
        const query = String(args.query ?? '').trim();
        if (!query) return '没给要搜的词。';
        const count = Math.min(20, Math.max(1, Number(args.count ?? this.cfg.maxResults)));
        const url = 'https://www.bing.com/images/search?q=' + encodeURIComponent(query) + '&form=HDRSC2&first=1';
        try {
          const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' }, signal: AbortSignal.timeout(15000) });
          if (!res.ok) return '搜图失败：HTTP ' + res.status;
          const html = new TextDecoder().decode(await readResponseBytes(res, 4_000_000));
          const urls = [...html.matchAll(/murl&quot;:&quot;(https?:\/\/[^&"]+)/g)].map((m) => m[1] as string);
          const titles = [...html.matchAll(/t&quot;:&quot;([^&"]*)/g)].map((m) => m[1] as string);
          const uniq = [...new Set(urls)].slice(0, count);
          if (!uniq.length) return '搜是搜到了，但没解析出图片直链（页面结构可能变了）。';
          const lines = uniq.map((u, i) => (i + 1) + '. ' + u + (titles[i] ? '  # ' + titles[i].slice(0, 40) : ''));
          return '「' + query + '」的图（' + uniq.length + ' 张，挑一张用 image_download 存）：\n' + lines.join('\n');
        } catch (e) {
          return '搜图失败：' + String((e as Error)?.message ?? e);
        }
      },
    };

    const download: ToolDef = {
      ...IMAGEKIT_TOOL_DECLS[1],
      tags: ['write'],
      handler: async (args: Record<string, unknown>) => {
        const url = String(args.url ?? '').trim();
        if (!/^https?:\/\//i.test(url)) return '只接受 http(s) 图片链接。';
        try {
          const res = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.bing.com/' }, signal: AbortSignal.timeout(20000) });
          if (!res.ok) return '下载失败：HTTP ' + res.status;
          const buf = Buffer.from(await readResponseBytes(res, this.cfg.maxBytes));
          if (buf.length > this.cfg.maxBytes) return '图太大（' + Math.round(buf.length / 1024) + 'KB，上限 ' + Math.round(this.cfg.maxBytes / 1024) + 'KB）。';
          const ext = sniffImage(buf);
          if (!ext) return '这不是图片（或者格式不支持）。';
          const raw = String(args.name ?? '').trim() || basename(new URL(url).pathname) || 'image';
          const name = safeName(raw.replace(IMAGE_EXT, '')) + '.' + ext;
          const dir = this.ensureDir();
          writeFileSync(join(dir, name), buf);
          return '已存到 ' + join(dir, name) + '（' + Math.round(buf.length / 1024) + 'KB）。要设成头像就 avatar_set。';
        } catch (e) {
          return '下载失败：' + String((e as Error)?.message ?? e);
        }
      },
    };

    const list: ToolDef = {
      ...IMAGEKIT_TOOL_DECLS[2],
      tags: ['read'],
      handler: async () => {
        const files = this.listFiles();
        if (!files.length) return 'avatar 目录还是空的。';
        return this.avatarDir + '：\n' + files.map((f) => '  ' + f.name + '（' + Math.round(f.size / 1024) + 'KB）').join('\n');
      },
    };

    const avatar: ToolDef = {
      ...IMAGEKIT_TOOL_DECLS[3],
      tags: ['write'],
      handler: async (args: Record<string, unknown>) => {
        const given = String(args.file ?? '').trim();
        let payload: string | null = null;
        let label = '';
        if (/^https?:\/\//i.test(given)) {
          payload = given;
          label = given.slice(0, 80);
        } else {
          let target = given;
          if (!target) {
            const files = this.listFiles();
            if (!files.length) return 'avatar 目录里没有图；先 image_search + image_download。';
            target = join(this.avatarDir, files[0]!.name);
            label = files[0]!.name;
          }
          const abs = isAbsolute(target) ? target : join(this.avatarDir, target);
          try {
            if (statSync(abs).size > this.cfg.maxBytes) return '图片超过配置的大小上限：' + abs;
            const buf = readFileSync(abs);
            const ext = sniffImage(buf);
            if (!ext) return '这个文件不是图片：' + abs;
            payload = 'base64://' + buf.toString('base64');
            label = label || basename(abs);
          } catch (e) {
            return '读不到这个文件：' + abs + '（' + String((e as Error)?.message ?? e) + '）';
          }
        }
        try {
          const res = await fetch(this.cfg.httpUrl.replace(/\/+$/, '') + '/set_qq_avatar', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ file: payload }),
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) return '换头像请求失败：HTTP ' + res.status;
          const j = (await res.json()) as { status?: string; retcode?: number; message?: string };
          if (j?.status === 'ok') return '头像换了（' + label + '）。别人那边也看得见。';
          return '没换成：' + (j?.message || JSON.stringify(j).slice(0, 200));
        } catch (e) {
          return '换头像请求失败：' + String((e as Error)?.message ?? e);
        }
      },
    };

    return [search, download, list, avatar];
  }

  webUi() {
    return autoWebUi('imagekit', '图片与头像', IMAGEKIT_DEFAULTS)
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

/** 取图片直链用的正则说明：Bing 把 murl 转义在 HTML 里，这里按 HTML 实体取。 */
export const BING_MURL_PATTERN = /murl&quot;:&quot;(https?:\/\/[^&"]+)/g;
