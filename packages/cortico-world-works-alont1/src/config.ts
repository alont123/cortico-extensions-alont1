/** 作品页配置。 */
export interface WorksConfigSection { enabled: boolean; }
export const WORKS_DEFAULTS: WorksConfigSection = { enabled: false };
export function normalizeWorksConfig(raw: unknown): WorksConfigSection {
  const c = { ...WORKS_DEFAULTS };
  if (raw && typeof raw === 'object' && typeof (raw as any).enabled === 'boolean') c.enabled = (raw as any).enabled;
  return c;
}
