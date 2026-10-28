import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** 生活状态 World 的定义。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { LIFE_DEFAULTS, LIFE_CONFIG_GROUP, type LifeConfigSection } from './config.ts';
import { LifeWorld, LIFE_TOOL_DECLS } from './world.ts';

export const LIFE: WorldDefinition<LifeConfigSection> = withWorldPanel({
  id: 'life',
  label: '生活状态',
  defaults: () => ({ ...LIFE_DEFAULTS }),
  create: (ctx) =>
    new LifeWorld({ cfg: ctx.cfg, dataDir: ctx.dataDir, timezone: ctx.timezone, botDir: ctx.botDir }),
  describe: {
    tools: describeTools(LIFE_TOOL_DECLS.map(tool => tool.name === 'life_reach' ? {
      ...tool,
      description: '忽然想找某个人说句话。想不起该找谁时用它，它会按交情和"多久没聊"给你一个对象。'
        + '拿到之后用 当前会话已提供的消息工具 说点具体的——别问"在吗"。',
    } : tool), {
      life_now: { zh: '看看自己现在的状态：在干嘛、心情、精力。', en: 'Looks at its own current state: activity, mood, energy.' },
      life_set: { zh: '改自己「正在做的事」。', en: 'Changes what it is doing right now.' },
      life_event: { zh: '记一件今天发生的小事。', en: 'Notes one small thing that happened today.' },
      life_tick: { zh: '把时间往前推一段,看这段时间里自己做了什么。', en: 'Advances time and reports what it did in that span.' },
      life_reach: { zh: '想找某个人说句话,按交情挑一个人。', en: 'Picks someone to reach out to, by closeness.' },
      life_contact: { zh: '登记或移除本扩展自己的联系候选。', en: 'Registers or removes a contact in this extension.' },
    }),
    events: [
      {
        type: 'life.reach',
        description: { zh: '她想找某个人说话了。', en: 'It wants to reach out to someone.' },
      },
    ],
  },
}, PANEL_GUIDE);

export { LIFE_CONFIG_GROUP };
