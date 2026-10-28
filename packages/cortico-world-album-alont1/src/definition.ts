import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** 相册 World 的定义。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { ALBUM_DEFAULTS, ALBUM_CONFIG_GROUP, type AlbumConfigSection } from './config.ts';
import { AlbumWorld, ALBUM_TOOL_DECLS } from './world.ts';

export const ALBUM: WorldDefinition<AlbumConfigSection> = withWorldPanel({
  id: 'album',
  label: '相册',
  defaults: () => ({ ...ALBUM_DEFAULTS }),
  create: (ctx) => new AlbumWorld({
    cfg: ctx.cfg,
    dataDir: ctx.dataDir,
    botName: ctx.botName,
    timezone: ctx.timezone,
  }),
  describe: {
    tools: describeTools(ALBUM_TOOL_DECLS, {}),
    events: [],
  },
}, PANEL_GUIDE);

export { ALBUM_CONFIG_GROUP };
