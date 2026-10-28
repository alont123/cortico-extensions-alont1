/** 好感度 World 的配置段：worlds.affinity。数值都可调，默认值沿用本地那套规则。 */
import type { ConfigGroup } from 'cortico/core/types.ts';

export interface AffinityConfigSection {
  enabled: boolean;
  /** 主人的 QQ 号。这个人满分且永不掉分。 */
  masterId: number;
  /** 第一次见到某人时的起始分 */
  startScore: number;
  /** 单条消息的基础加分 */
  gainPerMessage: number;
  /** 每天的加分上限（防刷） */
  dailyGainCap: number;
  /** 夸她 / 说好话 */
  gainPraise: number;
  /** 分享自己的事 */
  gainShare: number;
  /** 骂她（笨／傻／滚） */
  lossInsult: number;
  /** 说她胖——死穴，掉得最狠 */
  lossFat: number;
  /** 命令式使唤 */
  lossCommand: number;
  /** 成为朋友后的保底分，疏远也掉不破 */
  friendFloor: number;
  /** 分数下限 */
  minScore: number;
  /** 分数上限（主人之外） */
  maxScore: number;

  /**
   * 某些群的起步分：键是群号，值是这个群里新人的初始分。
   *
   * 宿主事件库里的原始 QQ 群消息证明发送者出现于该群后，应用已配置的起步分。
   * 不读取其他扩展文件；没有事件证据时使用 startScore。
   *
   * 每条记录只认一次（把人加进 `boostedGroups`），所以重启、重放、重复的进群行
   * 都不会多给分。
   */
  groupStartScore: Record<string, number>;

  // ── 情绪余波 ──
  // 好感度是长期的关系分，余波是「刚才那事我还没过去」。
  // 真人吵完架不会立刻恢复，被夸了也会高兴一阵子。
  /** 情绪半衰期（分钟）。到时间强度减半，依次类推 */
  emotionHalfLifeMinutes: number;
  /** 低于这个强度就不再影响语气 */
  emotionFloor: number;
  /** 系统前缀里最多列几条余波 */
  emotionInPrompt: number;
}

export const AFFINITY_DEFAULTS: AffinityConfigSection = {
  enabled: false,
  masterId: 0,
  startScore: 0,
  gainPerMessage: 0.4,
  dailyGainCap: 12,
  gainPraise: 0.6,
  gainShare: 0.8,
  lossInsult: 1.5,
  lossFat: 3,
  lossCommand: 0.3,
  friendFloor: 55,
  minScore: 0,
  maxScore: 100,
  emotionHalfLifeMinutes: 90,
  emotionFloor: 0.15,
  emotionInPrompt: 3,
  groupStartScore: {},
};

export const AFFINITY_CONFIG_GROUP: ConfigGroup = {
  id: 'world:affinity',
  owner: 'world:affinity',
  schema: {
    type: 'object',
    title: '好感度',
    description: '她按 QQ 号记住关系分数，回话前查档位。改动热生效。',
    properties: {
      'worlds.affinity.masterId': {
        type: 'integer',
        title: '主人的 QQ 号',
        'x-hot': false,
        description: '这个人满分且永不掉分。改完重启生效。',
      },
      'worlds.affinity.startScore': {
        type: 'number',
        title: '初次见面的起始分',
        minimum: 0,
        maximum: 100,
        'x-hot': true,
        description: '第一次见到某人给多少分。档位是 0 陌生 / 15 眼熟 / 35 熟人 / 55 朋友 / 80 好朋友；'
          + '给太低等于每个人开局都在最冷的档。改动热生效。',
      },
      'worlds.affinity.gainPerMessage': {
        type: 'number',
        title: '每句话加分',
        minimum: 0,
        maximum: 5,
        'x-hot': true,
        description: '有来有回就算一次互动。',
      },
      'worlds.affinity.dailyGainCap': {
        type: 'number',
        title: '每日加分上限',
        minimum: 0,
        maximum: 100,
        'x-hot': true,
        description: '防刷：一天之内靠说话最多涨这么多。',
      },
      'worlds.affinity.lossFat': {
        type: 'number',
        title: '说她胖掉多少',
        minimum: 0,
        maximum: 20,
        'x-hot': true,
        description: '死穴，掉得最狠。',
      },
      'worlds.affinity.lossInsult': {
        type: 'number',
        title: '骂她掉多少',
        minimum: 0,
        maximum: 20,
        'x-hot': true,
        description: '笨／傻／滚这类。',
      },
      'worlds.affinity.friendFloor': {
        type: 'number',
        title: '朋友保底分',
        minimum: 0,
        maximum: 100,
        'x-hot': true,
        description: '到过这个分数就一直保底，疏远也掉不破。',
      },
      'worlds.affinity.emotionHalfLifeMinutes': {
        type: 'integer',
        title: '情绪半衰期',
        minimum: 5,
        maximum: 1440,
        'x-suffix': '分钟',
        'x-hot': true,
        description: '被夸或挨骂之后，那股劲多久减一半。90 分钟意味着大约三四个小时后淡掉。',
      },
      'worlds.affinity.emotionFloor': {
        type: 'number',
        title: '情绪淡出阈值',
        minimum: 0,
        maximum: 1,
        'x-hot': true,
        description: '强度低于它就不写进提示词了，免得旧情绪一直挂着。',
      },
      'worlds.affinity.emotionInPrompt': {
        type: 'integer',
        title: '提示词里放几条余波',
        minimum: 0,
        maximum: 10,
        'x-suffix': '条',
        'x-hot': true,
        description: '只列还没淡掉的那些，新的在前。',
      },
      'worlds.affinity.groupStartScore': {
        type: 'object',
        title: '某些群的起步分',
        'x-hot': true,
        description: '键是群号、值是分数。名单里那些人一进那个群就按这个分起步（不再走「第一次见面」的 0 分），'
          + '每人每群只给一次。用来表达「这个群都是自己人」。',
      },
    },
  },
};
