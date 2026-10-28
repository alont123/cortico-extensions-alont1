import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** 剪贴板 World 的定义。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts'
import { CLIPBOARD_DEFAULTS, type ClipboardConfigSection } from './config.ts'
import { CLIPBOARD_TOOL_DECLS, ClipboardWorld } from './world.ts'

export const CLIPBOARD: WorldDefinition<ClipboardConfigSection> = withWorldPanel({
  id: 'clipboard',
  label: '剪贴板',
  defaults: () => ({ ...CLIPBOARD_DEFAULTS }),
  create: (ctx) => new ClipboardWorld({ cfg: ctx.cfg }),
  describe: {
    tools: describeTools(CLIPBOARD_TOOL_DECLS, {
      clipboard_read: { zh: '读当前剪贴板里的文字。', en: 'Reads the text currently in the clipboard.' },
    }),
    events: [],
  },
}, PANEL_GUIDE)
