/** 自我运维的配置。 */
export interface SelfkitConfigSection {
  enabled: boolean;
  /** 自己控制台的端口（读 /api/status 等）。 */
  consolePort: number;
  /** 日志最多看多少条。 */
  logLines: number;
}

export const SELFKIT_DEFAULTS: SelfkitConfigSection = {
  enabled: false,
  consolePort: 7788,
  logLines: 20,
};

export function normalizeSelfkitConfig(raw: unknown): SelfkitConfigSection {
  const c = { ...SELFKIT_DEFAULTS };
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (typeof r.enabled === 'boolean') c.enabled = r.enabled;
    if (typeof r.consolePort === 'number' && Number.isFinite(r.consolePort)) c.consolePort = Math.min(65535, Math.max(1, Math.round(r.consolePort)));
    if (typeof r.logLines === 'number' && Number.isFinite(r.logLines)) c.logLines = Math.min(100, Math.max(5, Math.round(r.logLines)));
  }
  return c;
}
