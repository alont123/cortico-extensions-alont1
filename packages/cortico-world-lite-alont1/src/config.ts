/**
 * 轻量 World 的配置段：worlds.lite。
 *
 * 故意做得又扁又少：**小模型场景下，每一个多出来的旋钮都是在偷它的上下文和注意力**。
 * 没有嵌套、没有枚举、没有百分比——能让它一次读懂的，就别让它算。
 */
import type { ConfigGroup } from 'cortico/core/types.ts'

export interface LiteConfigSection {
  enabled: boolean
  /** 把"现在几点"补进上下文，并给她一个现问现答的工具。 */
  clockEnabled: boolean
  /** 让她能记下"关于他的事"，并在上下文里看到最近几条。 */
  notesEnabled: boolean
  /** 记多少条就满了。满了挤掉最旧的——不做淘汰判断，小模型判断不了。 */
  maxNotes: number
  /** 单条最多几个字。 */
  noteChars: number
}

export const LITE_DEFAULTS: LiteConfigSection = {
  enabled: false,
  clockEnabled: true,
  notesEnabled: true,
  maxNotes: 20,
  noteChars: 60,
}

export const LITE_CONFIG_GROUP: ConfigGroup = {
  id: 'world:lite',
  owner: 'world:lite',
  schema: {
    type: 'object',
    title: '轻量（小模型专用）',
    description: '只补两样：现在几点、记得他说过的事。没有主动推送、没有情绪与记账——'
      + '小模型的上下文和指令空间都紧张，多一样都是负担。改动热生效。',
    properties: {
      'worlds.lite.clockEnabled': {
        type: 'boolean',
        title: '补上现在几点',
        'x-hot': true,
        description: '不加工具，只是把"现在几点"写进她每轮都看得到的地方；问她也能现算。',
      },
      'worlds.lite.notesEnabled': {
        type: 'boolean',
        title: '让她记得住他说的事',
        'x-hot': true,
        description: '她可以记一行"关于他的事"，最近几条会出现在她眼前。',
      },
      'worlds.lite.maxNotes': {
        type: 'integer',
        title: '最多记几条',
        minimum: 3,
        maximum: 100,
        'x-suffix': '条',
        'x-hot': true,
        description: '记满就挤掉最旧的。小模型不做淘汰判断，只按先来后到。',
      },
      'worlds.lite.noteChars': {
        type: 'integer',
        title: '单条最多几个字',
        minimum: 10,
        maximum: 200,
        'x-suffix': '字',
        'x-hot': true,
        description: '写太长会挤掉别人，也容易被小模型理解错。',
      },
    },
  },
}
