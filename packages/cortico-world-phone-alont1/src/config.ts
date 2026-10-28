/** 手机（MuMu 模拟器）配置。 */
export interface PhoneConfigSection {
  enabled: boolean;
  /** MuMu 安装目录（含 MuMuManager.exe、adb.exe）。 */
  mumuDir: string;
  /** 实例序号。 */
  vmIndex: number;
  /** 启动后最多等多久。 */
  bootTimeoutSec: number;
}
export const PHONE_DEFAULTS: PhoneConfigSection = {
  enabled: false,
  mumuDir: '',
  vmIndex: 0,
  bootTimeoutSec: 240,
};
export function normalizePhoneConfig(raw: unknown): PhoneConfigSection {
  const c = { ...PHONE_DEFAULTS };
  if (raw && typeof raw === 'object') {
    const r = raw as any;
    if (typeof r.enabled === 'boolean') c.enabled = r.enabled;
    if (typeof r.mumuDir === 'string' && r.mumuDir.trim()) c.mumuDir = r.mumuDir.trim();
    if (Number.isFinite(r.vmIndex)) c.vmIndex = Math.max(0, Math.round(r.vmIndex));
    if (Number.isFinite(r.bootTimeoutSec)) c.bootTimeoutSec = Math.min(600, Math.max(30, Math.round(r.bootTimeoutSec)));
  }
  return c;
}
