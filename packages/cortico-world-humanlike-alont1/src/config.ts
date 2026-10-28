/**
 * 人味 World 的配置段：worlds.humanlike。
 *
 * 七个模块的参数放在 `worlds.humanlike.<模块>` 下，保留参数的含义和单位。
 * 启停只由宿主的 `worlds.humanlike.enabled` 控制，内置模块不再声明无效的子开关。
 */
import type { ConfigGroup, ConfigProperty } from 'cortico/core/types.ts'
import { AFFINITY_CONFIG_GROUP, AFFINITY_DEFAULTS, type AffinityConfigSection } from './modules/affinity/config.ts'
import { LEARN_CONFIG_GROUP, LEARN_DEFAULTS, type LearnConfigSection } from './modules/learn/config.ts'
import { LIFE_CONFIG_GROUP, LIFE_DEFAULTS, type LifeConfigSection } from './modules/life/config.ts'
import { CLOCK_CONFIG_GROUP, CLOCK_DEFAULTS, type ClockConfigSection } from './modules/clock/config.ts'
import { TOGETHER_CONFIG_GROUP, TOGETHER_DEFAULTS, type TogetherConfigSection } from './modules/together/config.ts'
import { MIND_CONFIG_GROUP, MIND_DEFAULTS, type MindConfigSection } from './modules/mind/config.ts'
import { REAL_CONFIG_GROUP, REAL_DEFAULTS, type RealConfigSection } from './modules/real/config.ts'

export interface HumanlikeConfigSection {
  enabled: boolean
  /** 仅从旧版人味升级时，由操作者显式选择复制根目录旧文件。 */
  migrateLegacyData: boolean

  /** 情绪与交情（好感账、情绪块）。 */
  affinity: AffinityConfigSection
  /** 学过的东西（知识条目 + 上网查的源）。 */
  learn: LearnConfigSection
  /** 作息与存在节律。 */
  life: LifeConfigSection
  /** 时间感。 */
  clock: ClockConfigSection
  /** 一起过的时间（共同经历、悬着的话头）。 */
  together: TogetherConfigSection
  /** 它自己惦记的事（排期、自己的时间、每日回顾）。 */
  mind: MindConfigSection
  /** 看得见的事（桌面、花销、前缀来路、配置；全部只读）。 */
  real: RealConfigSection
}

export const HUMANLIKE_DEFAULTS: HumanlikeConfigSection = {
  enabled: false,
  migrateLegacyData: false,
  affinity: { ...AFFINITY_DEFAULTS },
  learn: { ...LEARN_DEFAULTS },
  life: { ...LIFE_DEFAULTS },
  clock: { ...CLOCK_DEFAULTS },
  together: { ...TOGETHER_DEFAULTS },
  mind: { ...MIND_DEFAULTS },
  real: { ...REAL_DEFAULTS },
}

/** 兼容早期显式配置迁移的模块列表。 */
const MODULE_NAMES = ['affinity', 'learn', 'life', 'clock', 'together', 'mind', 'real'] as const

/**
 * 仅供显式迁移旧配置使用；运行中的 World 不调用它，不改写宿主持有的配置。
 * 已有总开关时以总开关为准，不能用遗留子开关覆盖操作者明确保存的 false。
 * @deprecated 新配置只使用 worlds.humanlike.enabled。
 */
export function hoistEnabled(section: Record<string, unknown>): void {
  const hasRoot = typeof section.enabled === 'boolean'
  let on = hasRoot ? section.enabled : false
  for (const name of MODULE_NAMES) {
    const sub = section[name]
    if (!sub || typeof sub !== 'object') continue
    const cfg = sub as Record<string, unknown>
    if (!hasRoot && cfg.enabled === true) on = true
    delete cfg.enabled
  }
  section.enabled = on
}

/** 总开关由宿主扩展卡片管理；这里只声明人味自己的配置。 */
const HUMANLIKE_ROOT_GROUP: ConfigGroup = {
  id: 'world:humanlike',
  owner: 'world:humanlike',
  schema: {
    type: 'object',
    title: '人味',
    description: '情绪与交情、学过的东西、作息、时间感、一起过的时间、它自己惦记的事、看得见的只读工具。'
      + '每一段就是原来那个 World 的配置，键名和含义不变。',
    properties: {
      'worlds.humanlike.migrateLegacyData': {
        type: 'boolean',
        title: '迁移旧版人味数据',
        'x-hot': false,
        description: '默认关闭。仅在确认根目录文件属于旧版人味并已备份时开启；重启后只复制 humanlike/ 内缺少的文件，不覆盖现有状态。迁移完成后关闭，避免以后误读独立扩展数据。',
      },
    },
  },
}

/** 把模块自己的键（`worlds.<模块>.x`）挪到 `worlds.humanlike.<模块>.x`；已经是新路径的原样留下。 */
function rebasedProperties(group: ConfigGroup, module: string): Record<string, ConfigProperty> {
  const from = `worlds.${module}.`
  const to = `worlds.humanlike.${module}.`
  const out: Record<string, ConfigProperty> = {}
  for (const [path, prop] of Object.entries(group.schema.properties)) {
    if (path.startsWith(to)) out[path] = prop
    else if (path.startsWith(from)) out[to + path.slice(from.length)] = prop
    else throw new Error(`配置组 world:${module} 的「${path}」既不在 ${from} 段也不在 ${to} 段里`)
  }
  return out
}

/** 模块自己的配置组：id、owner 与每条路径改到本 World 上，标题和内容原样。 */
function rebaseGroup(group: ConfigGroup, module: string): ConfigGroup {
  return {
    id: `world:humanlike.${module}`,
    owner: 'world:humanlike',
    schema: {
      type: 'object',
      title: group.schema.title,
      description: group.schema.description,
      properties: rebasedProperties(group, module),
    },
  }
}

/** 控制台按声明顺序渲染：总闸在前，随后是七个模块。 */
export const HUMANLIKE_CONFIG_GROUPS: readonly ConfigGroup[] = [
  HUMANLIKE_ROOT_GROUP,
  rebaseGroup(AFFINITY_CONFIG_GROUP, 'affinity'),
  rebaseGroup(LEARN_CONFIG_GROUP, 'learn'),
  rebaseGroup(LIFE_CONFIG_GROUP, 'life'),
  rebaseGroup(CLOCK_CONFIG_GROUP, 'clock'),
  rebaseGroup(TOGETHER_CONFIG_GROUP, 'together'),
  rebaseGroup(MIND_CONFIG_GROUP, 'mind'),
  rebaseGroup(REAL_CONFIG_GROUP, 'real'),
]
