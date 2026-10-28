/** 记忆检索配置。 */
export interface MemsearchConfigSection {
  enabled: boolean;
  /** Explicit read-only source directory, relative to deployment or absolute. */
  sourceDir: string;
  /** 一次返回几条。 */
  maxResults: number;
  /** 单个文件超过这个大小就跳过（MB）。 */
  maxFileMB: number;
  /** 最多索引多少个文件。 */
  maxFiles: number;
}
export const MEMSEARCH_DEFAULTS: MemsearchConfigSection = { enabled: false, sourceDir: '', maxResults: 6, maxFileMB: 2, maxFiles: 800 };
export function normalizeMemsearchConfig(raw: unknown): MemsearchConfigSection {
  const c = { ...MEMSEARCH_DEFAULTS };
  if (raw && typeof raw === 'object') {
    const r = raw as any;
    if (typeof r.enabled === 'boolean') c.enabled = r.enabled;
    if (typeof r.sourceDir === 'string') c.sourceDir = r.sourceDir.trim();
    if (Number.isFinite(r.maxResults)) c.maxResults = Math.min(20, Math.max(1, Math.round(r.maxResults)));
    if (Number.isFinite(r.maxFileMB)) c.maxFileMB = Math.min(20, Math.max(0.5, r.maxFileMB));
    if (Number.isFinite(r.maxFiles)) c.maxFiles = Math.min(3000, Math.max(50, Math.round(r.maxFiles)));
  }
  return c;
}
