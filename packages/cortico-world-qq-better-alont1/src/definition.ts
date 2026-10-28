import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { QQWorld, qqBetterToolDecls } from './world.ts';
import { HISTORY_TOOL_DECLS } from './history-tools.ts';
import { QQ_ADDITIONAL_TOOL_DECLS } from './additional-tools.ts';
import { QQ_DEFAULTS, qqDefaults, type QQConfigSection } from './config.ts';
import { join } from 'node:path';

export const definition: WorldDefinition<QQConfigSection> = withWorldPanel({
  id: 'qqbot',
  label: 'QQ 群聊',
  defaults: qqDefaults,
  create(ctx) {
    return new QQWorld(ctx.cfg, ctx.packageDir, join(ctx.dataDir, 'qqbot'), ctx.repoRoot, ctx.secret, ctx.botName);
  },
  describe: {
    tools: describeTools([...qqBetterToolDecls(false, QQ_DEFAULTS.voice.maxChars, 8 * 1024 * 1024), ...HISTORY_TOOL_DECLS, ...QQ_ADDITIONAL_TOOL_DECLS], {}),
    events: [
      { type: 'qq.sent', tags: ['speak'], description: { zh: '一段发送已被服务受理，含会话、时间、原文和可用的消息编号；不表示对方已读。', en: 'A sent segment accepted by the service, with conversation, time, text and available message id; not a read receipt.' } },
      { type: 'qq.proactive', description: { zh: '监听会话候选时段，不自动发送。', en: 'An eligible conversation window; no automatic message.' } },
      { type: 'qq.qzone', description: { zh: '空间评论或互动的外部原文。', en: 'External Qzone comment or interaction.' } },
      { type: 'qq.qzone_nudge', description: { zh: '空间发言候选时段，不自动发布。', en: 'An opportunity to consider a Qzone post.' } },
      { type: 'qq.message', description: { zh: '收到一条 QQ 消息（群聊或私聊）。', en: 'A QQ message arrived (group or private).' } },
      { type: 'qq.poke', description: { zh: '有人戳了一戳。', en: 'Someone poked.' } },
      { type: 'qq.image', description: { zh: '收到一张图片。', en: 'An image arrived.' } },
      { type: 'qq.member', description: { zh: '群成员变动（进群、退群、改名等）。', en: 'Group membership changed.' } },
      { type: 'qq.forward', description: { zh: '收到合并转发的聊天记录。', en: 'A forwarded chat record arrived.' } },
      { type: 'qq.recall', description: { zh: '有人撤回了一条消息。', en: 'Someone recalled a message.' } },
      { type: 'qq.react', description: { zh: '有人对消息做了表态（表情回应）。', en: 'Someone reacted to a message.' } },
      { type: 'qq.reminder', description: { zh: '到点了，这条提醒该提了。', en: 'A reminder is due.' } },
    ],
  },
}, PANEL_GUIDE);
