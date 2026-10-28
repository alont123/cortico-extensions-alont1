import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** 下载管家 World 的定义。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts'
import { DOWNLOADS_DEFAULTS, type DownloadsConfigSection } from './config.ts'
import { DOWNLOADS_TOOL_DECLS, DownloadsWorld } from './world.ts'

export const DOWNLOADS: WorldDefinition<DownloadsConfigSection> = withWorldPanel({
  id: 'downloads',
  label: '下载管家',
  defaults: () => ({ ...DOWNLOADS_DEFAULTS }),
  create: (ctx) => new DownloadsWorld({ cfg: ctx.cfg, dataDir: ctx.dataDir, timezone: ctx.timezone }),
  describe: {
    tools: describeTools(DOWNLOADS_TOOL_DECLS, {
      downloads_recent: { zh: '看下载夹最近的文件。', en: 'Lists recent files in the downloads folder.' },
      downloads_stats: { zh: '下载夹的数量和大小。', en: 'Counts and totals the downloads folder.' },
    }),
    events: [
      { type: 'downloads.new', description: { zh: '下载夹里多了新文件。', en: 'New files appeared in the downloads folder.' } },
    ],
  },
}, PANEL_GUIDE)
