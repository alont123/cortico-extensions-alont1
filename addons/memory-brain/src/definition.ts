import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
import { describeTools, type WorldDefinition } from 'cortico/world.ts'
import { BRAIN_DEFAULTS, normalizeConfig, type BrainConfig } from './config.ts'
import { BrainWorld, BRAIN_TOOL_DECLS } from './world.ts'

export const definition: WorldDefinition<BrainConfig> = withWorldPanel({
  id: 'brain', label: '记忆大脑', defaults: () => structuredClone(BRAIN_DEFAULTS),
  preflight(ctx) { normalizeConfig(ctx.cfg) },
  create(ctx) { return new BrainWorld({ cfg: ctx.cfg, botDir: ctx.botDir, dataDir: ctx.dataDir, timezone: ctx.timezone, secret: ctx.secret }) },
  describe: { tools: describeTools(BRAIN_TOOL_DECLS, {}), events: [
    { type: 'brain.review_due', description: { zh: '手动标记的复习到期；标题与来源为 external 外部资料，每天最多尝试推送一次。', en: 'Flagged reviews are due; titles and sources are external material, with at most one delivery attempt per local day.' } },
    { type: 'brain.sync_failed', description: { zh: '本地资料索引同步失败的 internal 固定状态通知；每小时最多一次。', en: 'A fixed internal indexing-failure status; at most once per hour.' } },
  ] },
}, PANEL_GUIDE)
