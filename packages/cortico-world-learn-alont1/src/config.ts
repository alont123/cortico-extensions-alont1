/** 学习扩展的配置段：worlds.learn。 */
import type { ConfigGroup } from 'cortico/core/types.ts';

export interface LearnConfigSection {
  enabled: boolean;
  /** 最多存多少条笔记，超了丢最旧的 */
  maxNotes: number;
  /** 往系统前缀里注入几条 */
  injectCount: number;
  /** 单个源的超时 */
  searchTimeoutMs: number;
  /** 每个源最多取几条结果 */
  resultsPerSource: number;
  /**
   * 自定义搜索源：一个 JSON 数组字符串。空 = 只用内置的四个源。
   * 模板与字段说明见本扩展 README 的「加自己的搜索源」。
   */
  customSources: string;
  /** 小红书登录后的 Cookie；给了才能用要登录态的源（比如它）。空 = 不带。 */
  xhsCookie: string;
}

export const LEARN_DEFAULTS: LearnConfigSection = {
  enabled: false,
  maxNotes: 120,
  injectCount: 12,
  searchTimeoutMs: 15_000,
  resultsPerSource: 8,
  customSources: '',
  xhsCookie: '',
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
      'worlds.learn.customSources': {
        type: 'string', title: '自定义搜索源（JSON）', 'x-hot': true,
        description:
          '一个 JSON 数组，加自己的搜索源。例（可用的「小红书」模板，360 认 site: 限定）：'
          + '[{"name":"小红书","kind":"list","url":"https://www.so.com/s?q={q}%20site%3Axiaohongshu.com",'
          + '"headers":{"Referer":"https://www.so.com/"},'
          + '"extract":"<h3[^>]*>\\\\s*<a[^>]*>([\\\\s\\\\S]{4,120}?-\\\\s*小红书)</a>"}]。'
          + 'kind 是 list（取一串标题）或 definition（取一段正文）；url 里的 {q} 换成搜索词；'
          + 'extract 是取内容的正则（list 取第 1 个捕获组当标题，JSON 里反斜杠要写两个）。'
          + '写错了不影响内置的四个源，报错会写进查询结果里。'
          + '更多模板见本扩展 README 的「加自己的搜索源」。',
      },
      'worlds.learn.xhsCookie': {
        type: 'string', title: '小红书 Cookie', 'x-hot': true,
        description:
          '可选。小红书没有公开搜索接口（未登录直接 406、接口要 JS 签名），'
          + '要查它得用登录后的 Cookie。留空 = 不用它。',
      },
    },
  },
};
