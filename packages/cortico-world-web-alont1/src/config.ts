/** 联网的配置。 */
export interface WebConfigSection {
  enabled: boolean;
  /** 一次搜索最多返回几条。 */
  maxResults: number;
  /** 读网页时最多返回多少字符。 */
  maxChars: number;
  /** 单次请求超时（毫秒）。 */
  timeoutMs: number;
}

export const WEB_DEFAULTS: WebConfigSection = {
  enabled: false,
  maxResults: 6,
  maxChars: 4000,
  timeoutMs: 15000,
};

export function normalizeWebConfig(raw: unknown): WebConfigSection {
  const c = { ...WEB_DEFAULTS };
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (typeof r.enabled === 'boolean') c.enabled = r.enabled;
    if (typeof r.maxResults === 'number' && Number.isFinite(r.maxResults)) c.maxResults = Math.min(15, Math.max(1, Math.round(r.maxResults)));
    if (typeof r.maxChars === 'number' && Number.isFinite(r.maxChars)) c.maxChars = Math.min(20000, Math.max(500, Math.round(r.maxChars)));
    if (typeof r.timeoutMs === 'number' && Number.isFinite(r.timeoutMs)) c.timeoutMs = Math.min(60000, Math.max(3000, Math.round(r.timeoutMs)));
  }
  return c;
}
