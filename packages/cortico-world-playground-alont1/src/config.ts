/** 玩具世界的配置。 */
export interface PlaygroundConfigSection {
  enabled: boolean
  /** 单次运行最多多少秒。 */
  timeoutSec: number
}

export const PLAYGROUND_DEFAULTS: PlaygroundConfigSection = {
  enabled: false,
  timeoutSec: 5,
}
