/** 相册扩展的配置段：worlds.album。 */
import type { ConfigGroup } from 'cortico/core/types.ts';

export interface AlbumConfigSection {
  enabled: boolean;
  /** 一次最多翻开几张（她一次要看很多时就按这个截断）。 */
  maxViewsPerCall: number;
  /** 单条回复里最多记多少张（列表用的行数）。 */
  listLimit: number;
  /** 扫描事件库时一次读多少条，避免一次性把整库拉进内存。 */
  scanChunk: number;
}

export const ALBUM_DEFAULTS: AlbumConfigSection = {
  enabled: false,
  maxViewsPerCall: 4,
  listLimit: 30,
  scanChunk: 2000,
};

export const ALBUM_CONFIG_GROUP: ConfigGroup = {
  id: 'world:album',
  owner: 'world:album',
  schema: {
    type: 'object',
    title: '相册',
    description: '把收到过与发出去的图存成一份能翻的册子；她自己写标题与备注。',
    properties: {
      'worlds.album.maxViewsPerCall': {
        type: 'integer', title: '一次最多看几张', minimum: 1, maximum: 12,
        'x-suffix': '张', 'x-hot': true,
        description: '一次翻开太多会挤占上下文，也会让一轮请求变贵。',
      },
      'worlds.album.listLimit': {
        type: 'integer', title: '一次列几条', minimum: 5, maximum: 200,
        'x-suffix': '条', 'x-hot': true,
        description: '只影响列出来的行数，不影响册子里存了多少。',
      },
      'worlds.album.scanChunk': {
        type: 'integer', title: '扫描批大小', minimum: 200, maximum: 20000,
        'x-hot': true,
        description: '往册子里补图时一次读多少条事件。库里事件多时调大更慢、调小更碎。',
      },
    },
  },
};
