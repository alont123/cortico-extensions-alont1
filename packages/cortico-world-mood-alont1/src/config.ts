/** 情绪天气 World 的配置。 */
export interface MoodConfigSection {
  enabled: boolean
  /** 检查间隔（秒）。读的是前台窗口和键鼠空闲，开销小但要省电就调大。 */
  tickSec: number
  /** 两次事件之间至少隔多少秒：状态来回切时别反复唤醒模型。 */
  minEventGapSec: number
}

export const MOOD_DEFAULTS: MoodConfigSection = {
  enabled: false,
  tickSec: 300,
  minEventGapSec: 600,
}
