import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** 好感度 World 的定义。挂载后提供三个工具：查交情、记一笔、看排行。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import type { ToolDef, World, WorldWebUiDecl, WorldHost } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { AFFINITY_DEFAULTS, AFFINITY_CONFIG_GROUP, type AffinityConfigSection } from './config.ts';
import { AffinityWorld, affinityToolDecls } from './world.ts';

export interface AffinityDeps {
  dataDir: string;
  timezone: string;
  /** 部署目录；消息统计使用宿主事件，不读取其他扩展账本。 */
  botDir: string;
}

export function createAffinityWorld(cfg: AffinityConfigSection, deps: AffinityDeps): AffinityWorld {
  return new AffinityWorld({ cfg, dataDir: deps.dataDir, timezone: deps.timezone, botDir: deps.botDir });
}

export const AFFINITY: WorldDefinition<AffinityConfigSection> = withWorldPanel({
  id: 'affinity',
  label: '好感度',
  defaults: () => ({ ...AFFINITY_DEFAULTS }),
  create: (ctx) => createAffinityWorld(ctx.cfg, {
    dataDir: ctx.dataDir,
    timezone: ctx.timezone,
    botDir: ctx.botDir,
  }),
  describe: {
    tools: describeTools(affinityToolDecls(AFFINITY_DEFAULTS).map(tool => tool.name === 'affinity_slot' ? {
      ...tool,
      description: tool.description.replace('**主人那一格不用你填**，他自己定的是「家人」——那一格只报不改。', '**配置里指定的主人那一格不用你填**——那一格只报不改。'),
    } : tool), {
      affinity_get: { zh: '查某个人在你这里的交情分数。', en: "Looks up someone's closeness score." },
      affinity_adjust: { zh: '记一笔交情的变化,或者只记一股情绪。', en: 'Records a change in closeness, or just a feeling.' },
      affinity_slot: { zh: '给某个人定「关系格子」——他算你的什么人。', en: 'Sets what someone is to you.' },
      affinity_list: { zh: '看交情排行的前几名。', en: 'Lists the closest people.' },
    }),
    events: [
      {
        type: 'affinity.started',
        description: { zh: '好感度 World 挂载后开始工作。', en: 'The affinity World started working.' },
      },
    ],
  },
}, PANEL_GUIDE);

export type { AffinityWorld, ToolDef, World, WorldWebUiDecl, WorldHost };
export { AFFINITY_CONFIG_GROUP };
