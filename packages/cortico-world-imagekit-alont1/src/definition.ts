import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** 图片与头像的定义。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { IMAGEKIT_DEFAULTS, normalizeImagekitConfig, type ImagekitConfigSection } from './config.ts';
import { IMAGEKIT_TOOL_DECLS, ImagekitWorld } from './world.ts';

export const definition: WorldDefinition<ImagekitConfigSection> = withWorldPanel({
  id: 'imagekit',
  label: '图片与头像',
  defaults: () => ({ ...IMAGEKIT_DEFAULTS }),
  create(ctx) {
    return new ImagekitWorld({ botDir: ctx.botDir, dataDir: ctx.dataDir, cfg: normalizeImagekitConfig(ctx.cfg) });
  },
  describe: {
    tools: describeTools(IMAGEKIT_TOOL_DECLS, {
      image_search: { zh: '搜图片直链', en: 'Search image URLs' },
      image_download: { zh: '下载图片到扩展数据目录', en: 'Download an image into extension data' },
      image_list: { zh: '列已下载的图', en: 'List downloaded images' },
      avatar_set: { zh: '换 QQ 头像', en: 'Set the QQ avatar' },
    }),
    events: [],
  },
}, PANEL_GUIDE);
