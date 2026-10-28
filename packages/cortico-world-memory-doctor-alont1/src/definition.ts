import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** 记忆体检 World 的定义。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import {
  MEMORY_DOCTOR_CONFIG_GROUP,
  MEMORY_DOCTOR_DEFAULTS,
  type MemoryDoctorConfigSection,
} from './config.ts';
import { MemoryDoctorWorld, MEMORY_DOCTOR_TOOL_DECLS } from './world.ts';

export const MEMORY_DOCTOR: WorldDefinition<MemoryDoctorConfigSection> = withWorldPanel({
  id: 'memory-doc',
  label: '记忆体检',
  defaults: () => ({ ...MEMORY_DOCTOR_DEFAULTS }),
  create: (ctx) => new MemoryDoctorWorld({
    cfg: ctx.cfg,
    botDir: ctx.botDir,
    dataDir: ctx.dataDir,
    timezone: ctx.timezone,
  }),
  describe: {
    tools: describeTools(MEMORY_DOCTOR_TOOL_DECLS, {}),
    events: [],
  },
}, PANEL_GUIDE);

export { MEMORY_DOCTOR_CONFIG_GROUP };
