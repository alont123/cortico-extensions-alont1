/** 生活状态的配置段：worlds.life。 */
import type { ConfigGroup } from 'cortico/core/types.ts';

export interface LifeConfigSection {
  /** 可选消息工具提示；使用前仍需确认当前会话实际提供该工具。 */
  speakTool: string;
  enabled: boolean;
  /** 换「在干嘛」的间隔下限（分钟） */
  activityMinMinutes: number;
  /** 换「在干嘛」的间隔上限（分钟） */
  activityMaxMinutes: number;
  /** 换心情的间隔下限（分钟） */
  moodMinMinutes: number;
  /** 换心情的间隔上限（分钟） */
  moodMaxMinutes: number;
  /** 一天最多攒几条小事 */
  maxEventsPerDay: number;
  /** 攒一条小事的概率（每次 tick，tick 默认每分钟一次） */
  eventChance: number;
  /** 往系统前缀里放几条最近的小事 */
  eventsInPrompt: number;
  /** 刷新间隔（毫秒）。状态随时可算，这个主要决定落盘频率 */
  tickMs: number;

  // ── 主动性 ──
  // 真人不会只在被叫的时候才存在；会突然想起某个人，主动说句话。
  /** 开不开主动搭话 */
  reachOut: boolean;
  /** 两次主动之间至少隔多久（分钟） */
  reachMinGapMinutes: number;
  /** 每次检查时出手的概率（0~1） */
  reachChance: number;
  /** 至少要这个交情才主动找别人 */
  reachMinScore: number;
  /** 主人的 QQ 号 */
  masterId: number;
  /**
   * 也把主人当成主动搭话的对象，而且优先于别人。
   *
   * 关着的时候主人被排除在候选之外，只在「没别人可找」时才退而求其次想他 ——
   * 那是「找别人聊天，顺手想起你」。开着才是「想他了就去找他」。
   */
  reachMaster: boolean;
  /** 找主人隔多久算合适（分钟）。跟他可以比跟别人勤得多 */
  reachMasterGapMinutes: number;
  /** 找主人时每次检查出手的概率（0~1） */
  reachMasterChance: number;
}

export const LIFE_DEFAULTS: LifeConfigSection = {
  speakTool: '',
  enabled: false,
  activityMinMinutes: 25,
  activityMaxMinutes: 70,
  moodMinMinutes: 15,
  moodMaxMinutes: 45,
  maxEventsPerDay: 5,
  eventChance: 0.012,
  eventsInPrompt: 3,
  tickMs: 60_000,
  reachOut: false,
  reachMinGapMinutes: 180,
  reachChance: 0.25,
  reachMinScore: 40,
  masterId: 0,
  reachMaster: true,
  reachMasterGapMinutes: 55,
  reachMasterChance: 0.4,
};

export const LIFE_CONFIG_GROUP: ConfigGroup = {
  id: 'world:life',
  owner: 'world:life',
  schema: {
    type: 'object',
    title: '生活状态',
    description: '她自己的一条时间线：这会儿在干嘛、心情如何、今天遇到了什么。改完热生效。',
    properties: {
      'worlds.life.activityMinMinutes': {
        type: 'integer', title: '换「在干嘛」最短', minimum: 5, maximum: 240,
        'x-suffix': '分钟', 'x-hot': true, description: '太短会显得坐不住，太长会显得僵。',
      },
      'worlds.life.activityMaxMinutes': {
        type: 'integer', title: '换「在干嘛」最长', minimum: 5, maximum: 480,
        'x-suffix': '分钟', 'x-hot': true, description: '一般 25~70 分钟最像人。',
      },
      'worlds.life.moodMinMinutes': {
        type: 'integer', title: '换心情最短', minimum: 5, maximum: 240,
        'x-suffix': '分钟', 'x-hot': true, description: '心情比在干嘛飘得勤。',
      },
      'worlds.life.moodMaxMinutes': {
        type: 'integer', title: '换心情最长', minimum: 5, maximum: 480,
        'x-suffix': '分钟', 'x-hot': true, description: '',
      },
      'worlds.life.maxEventsPerDay': {
        type: 'integer', title: '一天最多几件小事', minimum: 0, maximum: 20,
        'x-suffix': '条', 'x-hot': true, description: '太多了就不像"小事"了。',
      },
      'worlds.life.eventChance': {
        type: 'number', title: '攒事的概率', minimum: 0, maximum: 1,
        'x-hot': false, description: '每次刷新一次判定。0.012 约等于每 1.4 小时一件。',
      },
      'worlds.life.eventsInPrompt': {
        type: 'integer', title: '提示词里放几条', minimum: 0, maximum: 10,
        'x-suffix': '条', 'x-hot': true, description: '仅为兼容旧配置保留，不再把活动或事件原文放入前缀；请使用 life_now 读取。',
      },
      'worlds.life.reachOut': {
        type: 'boolean', title: '让她主动找人说话',
        'x-hot': true,
        description: '按已登记的候选与间隔投递联系建议；是否联系由 Persona 决定，扩展不直接发送消息。',
      },
      'worlds.life.reachMinGapMinutes': {
        type: 'integer', title: '两次主动至少隔', minimum: 10, maximum: 2880,
        'x-suffix': '分钟', 'x-hot': true,
        description: '防骚扰的主要闸门。默认 180 分钟（3 小时）。',
      },
      'worlds.life.reachChance': {
        type: 'number', title: '每次检查出手的概率', minimum: 0, maximum: 1,
        'x-hot': true,
        description: '每个普通联系间隔只判定一次，未命中的尝试也记录；概率 0 不产生建议。',
      },
      'worlds.life.reachMinScore': {
        type: 'number', title: '至少这个交情才主动', minimum: 0, maximum: 100,
        'x-hot': true,
        description: '针对 life_contact 登记的本包候选分数，不读取其他关系扩展。',
      },
      'worlds.life.reachMaster': {
        type: 'boolean', title: '也主动找主人，且优先于别人',
        'x-hot': true,
        description: '关闭后不选择该账号，也不会在没有候选时回退到该账号。',
      },
      'worlds.life.reachMasterGapMinutes': {
        type: 'integer', title: '找主人至少隔', minimum: 5, maximum: 2880,
        'x-suffix': '分钟', 'x-hot': true,
        description: '跟他可以比跟别人勤得多。默认 55 分钟；觉得太黏就往上调。',
      },
      'worlds.life.reachMasterChance': {
        type: 'number', title: '找主人每次出手的概率', minimum: 0, maximum: 1,
        'x-hot': true,
        description: '跟上面那条一起决定频率。默认 0.4。',
      },
    },
  },
};
