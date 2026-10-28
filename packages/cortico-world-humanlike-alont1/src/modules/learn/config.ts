/** 学习扩展的配置段：worlds.learn。 */
import type { ConfigGroup } from 'cortico/core/types.ts';

export interface LearnConfigSection {
  /** 最多存多少条笔记，超了丢最旧的 */
  maxNotes: number;
  /** 往系统前缀里注入几条 */
  injectCount: number;
  /** 单个源的超时 */
  searchTimeoutMs: number;
  /** 每个源最多取几条结果 */
  resultsPerSource: number;
}

export const LEARN_DEFAULTS: LearnConfigSection = {
  maxNotes: 120,
  injectCount: 12,
  searchTimeoutMs: 15_000,
  resultsPerSource: 8,
};

export const LEARN_CONFIG_GROUP: ConfigGroup = {
  id: 'world:learn',
  owner: 'world:learn',
  schema: {
    type: 'object',
    title: '学习',
    description: '她自己上网查词汇、记群友，学到的会进系统前缀。',
    properties: {
      'worlds.learn.maxNotes': {
        type: 'integer', title: '最多记多少条', minimum: 10, maximum: 1000,
        'x-suffix': '条', 'x-hot': true, description: '超了丢最旧的。',
      },
      'worlds.learn.injectCount': {
        type: 'integer', title: '旧版前缀条数（兼容项）', minimum: 0, maximum: 50,
        'x-suffix': '条', 'x-hot': true, description: '仅为兼容旧配置保留，不再把笔记原文放入前缀；请使用 recall 工具读取。',
      },
      'worlds.learn.searchTimeoutMs': {
        type: 'integer', title: '搜索超时', minimum: 3000, maximum: 60000,
        'x-suffix': 'ms', 'x-hot': true, description: '单个源的超时，各源独立。',
      },
      'worlds.learn.resultsPerSource': {
        type: 'integer', title: '每个源取几条', minimum: 1, maximum: 20,
        'x-hot': true, description: '取太多会淹没有效信息。',
      },
    },
  },
};
