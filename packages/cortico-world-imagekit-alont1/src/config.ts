/** 图片与头像的配置。 */
export interface ImagekitConfigSection {
  enabled: boolean;
  /** OneBot v11 协议端（SnowLuma / NapCat）的 HTTP 地址（set_qq_avatar 走它）。 */
  httpUrl: string;
  /** 单张图下载上限（字节）。 */
  maxBytes: number;
  /** 一次搜索最多返回多少条。 */
  maxResults: number;
}

export const IMAGEKIT_DEFAULTS: ImagekitConfigSection = {
  enabled: false,
  httpUrl: 'http://127.0.0.1:3000',
  maxBytes: 4_000_000,
  maxResults: 8,
};

export function normalizeImagekitConfig(raw: unknown): ImagekitConfigSection {
  const c = { ...IMAGEKIT_DEFAULTS };
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (typeof r.enabled === 'boolean') c.enabled = r.enabled;
    if (typeof r.httpUrl === 'string' && r.httpUrl.trim()) c.httpUrl = r.httpUrl.trim();
    if (typeof r.maxBytes === 'number' && Number.isFinite(r.maxBytes)) c.maxBytes = Math.min(20_000_000, Math.max(100_000, Math.round(r.maxBytes)));
    if (typeof r.maxResults === 'number' && Number.isFinite(r.maxResults)) c.maxResults = Math.min(20, Math.max(1, Math.round(r.maxResults)));
  }
  return c;
}
