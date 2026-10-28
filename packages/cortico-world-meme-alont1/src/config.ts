/** 梗扩展配置：worlds.meme. */
import type { ConfigGroup } from 'cortico/core/types.ts';

export interface MemeConfigSection {
  enabled: boolean;
  /** 两次查梗之间至少隔多少秒（本地库命中不算） */
  minIntervalSec: number;
  /** 每小时最多联网搜几次 */
  hourlyCap: number;
  /** 每天最多联网搜几次 */
  dailyCap: number;
  /** 联网搜索超时（毫秒） */
  fetchTimeoutMs: number;
}

export const MEME_DEFAULTS: MemeConfigSection = {
  enabled: false,
  minIntervalSec: 45,
  hourlyCap: 6,
  dailyCap: 24,
  fetchTimeoutMs: 12000,
};

export const MEME_CONFIG_GROUP: ConfigGroup = {
  id: 'world:meme',
  owner: 'world:meme',
  schema: {
    type: 'object',
    title: '梗',
    description: '查梗与接龙：本地梗库优先，没命中才联网；有频率限制。改动热生效。',
    properties: {
      'worlds.meme.enabled': { type: 'boolean', title: '启用', 'x-hot': false, description: '需重启生效。' },
      'worlds.meme.minIntervalSec': { type: 'integer', title: '查梗最短间隔', minimum: 0, maximum: 3600, 'x-hot': true, description: '两次联网搜梗之间至少隔多少秒。' },
      'worlds.meme.hourlyCap': { type: 'integer', title: '每小时上限', minimum: 0, maximum: 120, 'x-hot': true, description: '每小时最多联网搜几次。' },
      'worlds.meme.dailyCap': { type: 'integer', title: '每天上限', minimum: 0, maximum: 500, 'x-hot': true, description: '每天最多联网搜几次。' },
      'worlds.meme.fetchTimeoutMs': { type: 'integer', title: '搜索超时', minimum: 1000, maximum: 60000, 'x-hot': true, description: '联网搜索单次超时（毫秒）。' },
    },
  },
};
