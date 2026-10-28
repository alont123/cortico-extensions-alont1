/** 截图日记 World 的配置。 */
export interface DiaryConfigSection {
  enabled: boolean
  /** 日记存放目录（相对部署目录）。 */
  outDir: string
  /** 每天最多留几张。 */
  maxPerDay: number
}

export const DIARY_DEFAULTS: DiaryConfigSection = {
  enabled: false,
  outDir: 'data/diary',
  maxPerDay: 5,
}
