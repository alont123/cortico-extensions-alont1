import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** Gaming World 的定义。挂载后她会知道他在玩什么，并提供两个查询工具。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts'
import { GAMING_DEFAULTS, GAMING_CONFIG_GROUP, GAMING_SECRETS, GAMING_WATCH_DEFAULTS, type GamingConfigSection } from './config.ts'
import { GamingWorld, GAMING_TOOL_DECLS } from './world.ts'

export interface GamingDeps {
  dataDir: string
  timezone: string
  /** 视觉模型密钥。空串 = 看画面不可用。 */
  apiKey: string
}

export function createGamingWorld(cfg: GamingConfigSection, deps: GamingDeps): GamingWorld {
  return new GamingWorld({ cfg, dataDir: deps.dataDir, timezone: deps.timezone, apiKey: deps.apiKey })
}

/** 读密钥：名字不存在时安静返回空串（不同部署的 .env 变量名不一样）。 */
function readSecret(ctx: { secret: (name: string) => string }, name: string): string {
  try { return ctx.secret(name) || '' } catch { return '' }
}

export const GAMING: WorldDefinition<GamingConfigSection> = withWorldPanel({
  id: 'gaming',
  label: '陪玩',
  defaults: () => ({ ...GAMING_DEFAULTS, watch: { ...GAMING_WATCH_DEFAULTS } }),
  preflight: (ctx) => {
    // 前台窗口靠 Windows API 读，别的平台上这个 World 没有意义。
    if (process.platform !== 'win32') {
      throw new Error(`cortico-world-gaming 只支持 Windows，当前平台是 ${process.platform}`)
    }
    const games = ctx.cfg.games
    if (!Array.isArray(games)) throw new Error('worlds.gaming.games 要是数组')
    for (const [i, g] of games.entries()) {
      if (!g || typeof g !== 'object') throw new Error(`games[${i}] 要是对象`)
      if (!g.id) throw new Error(`games[${i}] 缺 id`)
      if (!g.name) throw new Error(`games[${i}]（${g.id}）缺 name`)
      if (!Array.isArray(g.processes)) throw new Error(`games[${i}]（${g.id}）的 processes 要是数组`)
    }
  },
  create: (ctx) => createGamingWorld(ctx.cfg, {
    dataDir: ctx.dataDir,
    timezone: ctx.timezone,
    apiKey: readSecret(ctx, GAMING_SECRETS.vision) || readSecret(ctx, 'DEEPSEEK_API_KEY') || ctx.cfg.watch.apiKey || ctx.cfg.balance?.apiKey || '',
  }),
  describe: {
    tools: describeTools(GAMING_TOOL_DECLS.map(tool => {
      if (tool.name === 'gaming_watch_window') return {
        ...tool, description: '指定她看哪个窗口（而不是跟着正在玩的游戏进程）。Windows 用。target=进程名，title=标题关键字，clear=true 恢复自动。',
      }
      if (tool.name === 'gaming_library') return {
        ...tool,
        description: '游戏库管理：列出当前认得的游戏、添加一个游戏、或删掉之前加的游戏。添加会写进 data/gaming-lib.json（重启后还在）。',
        parameters: { ...tool.parameters, properties: {
          ...(tool.parameters.properties as Record<string, unknown>),
          process: { type: 'string', description: '进程名（add/remove 用；不带 .exe，小写）。' },
        } },
      }
      return tool
    }), {}),
    events: [
      { type: 'gaming.start', description: '识别到游戏会话开始（外部观察）' },
      { type: 'gaming.switch', description: '识别到游戏切换（外部观察）' },
      { type: 'gaming.stop', description: '识别到游戏会话结束（外部观察）' },
      { type: 'gaming.long', description: '游戏时长达到提醒阈值（外部观察）' },
      { type: 'gaming.late', description: '深夜仍在游戏（外部观察）' },
      { type: 'gaming.match', description: '画面识别到一局结束（外部视觉材料）' },
      { type: 'gaming.moment', description: '画面识别到值得注意的时刻（外部视觉材料）' },
      { type: 'gaming.observation', description: '投递时生成的当前游戏、画面及余额快照（外部材料）', trigger: 'piggyback', tags: ['snapshot'] },
      { type: 'gaming.learned', description: '开新游戏时自动搜索的网页摘要（外部材料）', trigger: 'piggyback' },
      { type: 'gaming.balance', description: '看图工具耐久度（余额）低于预警线时的提醒' },
    ],
  },
}, PANEL_GUIDE)

export { GAMING_CONFIG_GROUP }
