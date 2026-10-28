/**
 * 好感度 World 的配置段：worlds.humanlike.affinity。
 *
 * 数值、档位态度、以及那个"待遇特殊的人"都在这里，都可以改。
 * 默认值是中性的：一条从陌生到好朋友的关系曲线，不含任何具体角色设定。
 */
import type { ConfigGroup } from 'cortico/core/types.ts';

/** 一个关系档位。分数落在哪一档，就用哪一档的态度说话。 */
export interface AffinityTier {
  /** 这一档的下限 */
  min: number;
  /** 档位名，会出现在提示词和工具回执里 */
  name: string;
  /** 用第一人称写这个档位该怎么对待对方，直接进提示词 */
  say: string;
}

/**
 * 默认档位表。文案用第一人称、不含具体角色，装到哪个 bot 上都读得通。
 *
 * 想换成自己角色的口气就整表覆盖（`worlds.humanlike.affinity.tiers`），
 * 或者只改某几档的 `say`——分数段和档位名不必跟着动。
 */
export const DEFAULT_TIERS: readonly AffinityTier[] = [
  { min: 80, name: '好朋友', say: '很亲近。会关心他、会惦记他，软的那面露得多一点' },
  { min: 55, name: '朋友', say: '不用装了。会主动说话、会开玩笑、愿意帮忙' },
  { min: 35, name: '熟人', say: '能聊两句了。会接梗、会搭话，但还端着' },
  { min: 15, name: '眼熟', say: '认识的人。他跟我说话我会接，就是不热络' },
  { min: 0, name: '陌生群友', say: '客气。他跟我说话我回，但话短、别热络，私人问题敷衍过去' },
];

export interface AffinityConfigSection {
  // ── 那个待遇特殊的人 ──
  // 留 0 就没有这个人：所有人一视同仁，按分数说话。
  /** 特别优待的那个人的账号 id（QQ 号）。0 = 不设。 */
  favoredId: number;
  /** 这个人的分数。设了 favoredId 就固定在这个数，不涨不跌。 */
  favoredScore: number;
  /**
   * 怎么对待这个人。用第一人称写，直接进提示词。
   * 只在设了 favoredId 时出现。
   */
  favoredSay: string;

  // ── 分数曲线 ──
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
  /**
   * 最狠的那种冒犯掉多少。默认对应的是一种人身攻击——
   * 具体是什么随角色定，`lossHarshNote` 里写给她看。
   */
  lossHarsh: number;
  /** `lossHarsh` 指什么。写进工具描述，让她知道哪种话该重罚。 */
  lossHarshNote: string;
  /** 命令式使唤 */
  lossCommand: number;
  /** 成为朋友后的保底分，疏远也掉不破 */
  friendFloor: number;
  /** 分数下限 */
  minScore: number;
  /** 分数上限（那个特殊的人之外） */
  maxScore: number;
  /** 关系档位表。空数组 = 用 DEFAULT_TIERS。 */
  tiers: AffinityTier[];

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
  favoredId: 0,
  favoredScore: 100,
  favoredSay: '满分的意思是不用收着——想说什么就说，想找他就找，他半天没动静可以直接问一句。',

  startScore: 0,
  gainPerMessage: 0.4,
  dailyGainCap: 12,
  gainPraise: 0.6,
  gainShare: 0.8,
  lossInsult: 1.5,
  lossHarsh: 3,
  lossHarshNote: '拿身体或外貌开那种玩笑（说了会立刻炸毛的那类）',
  lossCommand: 0.3,
  friendFloor: 55,
  minScore: 0,
  maxScore: 100,
  tiers: [],

  emotionHalfLifeMinutes: 90,
  emotionFloor: 0.15,
  emotionInPrompt: 3,
};

export const AFFINITY_CONFIG_GROUP: ConfigGroup = {
  id: 'world:affinity',
  owner: 'world:affinity',
  schema: {
    type: 'object',
    title: '好感度',
    description: '按账号记住关系分数，回话前查档位。改动热生效。',
    properties: {
      'worlds.affinity.favoredId': {
        type: 'integer',
        title: '特别优待的那个人',
        'x-hot': false,
        description: '这个账号分数固定、永不掉分。0 = 不设，所有人按分数一视同仁。改完重启生效。',
      },
      'worlds.affinity.favoredScore': {
        type: 'number',
        title: '那个人的分数',
        minimum: 0,
        maximum: 100,
        'x-hot': false,
        description: '设了「特别优待的那个人」才有效。默认 100（满分）。',
      },
      'worlds.affinity.favoredSay': {
        type: 'string',
        title: '怎么对待那个人',
        'x-hot': false,
        description: '用第一人称写，直接进提示词。只在设了那个人时出现。',
      },
      'worlds.affinity.startScore': {
        type: 'number',
        title: '初次见面的起始分',
        minimum: 0,
        maximum: 100,
        'x-hot': true,
        description: '第一次见到某人给多少分。档位默认是 0 陌生 / 15 眼熟 / 35 熟人 / 55 朋友 / 80 好朋友；'
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
      'worlds.affinity.lossHarsh': {
        type: 'number',
        title: '最狠的冒犯掉多少',
        minimum: 0,
        maximum: 20,
        'x-hot': true,
        description: '对应哪种话由「最狠的冒犯指什么」定。掉得最狠的那一档。',
      },
      'worlds.affinity.lossHarshNote': {
        type: 'string',
        title: '最狠的冒犯指什么',
        'x-hot': true,
        description: '写给她看的一句话，进工具描述。比如「拿体重开玩笑」——'
          + '她会据此判断哪种话该重罚。',
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
    },
  },
};
