/** B站配置。 */
export interface BiliConfigSection { enabled: boolean; }
export const BILI_DEFAULTS: BiliConfigSection = { enabled: false };
export function normalizeBiliConfig(raw: unknown): BiliConfigSection {
  const c = { ...BILI_DEFAULTS };
  if (raw && typeof raw === 'object' && typeof (raw as any).enabled === 'boolean') c.enabled = (raw as any).enabled;
  return c;
}
