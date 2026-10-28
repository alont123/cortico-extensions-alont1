/** 仪式感 World 的配置。 */
export interface RitualConfigSection {
  enabled: boolean
  /** 早安时间，HH:MM。 */
  morningAt: string
  /** 晚安时间，HH:MM。 */
  nightAt: string
}

export const RITUAL_DEFAULTS: RitualConfigSection = {
  enabled: false,
  morningAt: '08:00',
  nightAt: '23:00',
}
