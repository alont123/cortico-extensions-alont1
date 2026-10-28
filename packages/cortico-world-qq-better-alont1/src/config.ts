import type { ConfigGroup } from 'cortico/core/types.ts';
import type { WorldSection } from 'cortico/world.ts';
import type { QZoneConfig } from './qzone.ts';

/** fat-fish qq_bot 的关键参数 + Cortico 内置 world 的可选项，统一为一份配置。 */
export interface QQWorldConfig {
  /** 连接模式：reverse=Cortico 开 WS 服务端等 NapCat 连（fat-fish 风格）；forward=Cortico 连 NapCat 的 wsUrl（内置风格）。 */
  mode: 'reverse' | 'forward';
  /** forward 模式：NapCat 暴露的 WebSocket 地址。 */
  wsUrl: string;
  /** reverse 模式：Cortico 在哪个 host/port/path 监听 NapCat 反向连接。 */
  wsHost: string;
  wsPort: number;
  wsPath: string;
  /** NapCat 接入 Token（OneBot access_token），二选一生效。 */
  token: string;
  /** 监听中的群（fat-fish 的 GROUP_WHITELIST / 内置的 activeGroupIds）；控制台以空格/逗号分隔字符串编辑。 */
  groups: string | number[];
  /** 监听中的私聊对方 QQ（activePrivatePeers）；同上，字符串或数组皆可。 */
  privates: string | number[];
  /** 好友申请自动通过（NapCat 只有 set_friend_add_request，不能主动加人）。 */
  friendAutoAdd: boolean;
  /** 主人的 QQ 号；不再读取或公开该联系人的 Persona 记忆。 */
  ownerQQ: number;
  /**
   * 允许她用**群管工具**（撤回 / @全体 / 公告 / 入群审批 / 头衔 / 禁言 / 踢人）的群。
   *
   * 空 = 群管全关。授权按**群**、不按人：工具 handler 拿不到「是谁在命令」
   * （`ToolCallContext` 没有发送者），与其猜，不如让主人自己圈出可信的群。
   * 空格或逗号分隔的群号。
   */
  adminGroups: string | number[];
  /** 私聊聚合窗口（ms），fat-fish PRIVATE_AGGREGATION_WINDOW。 */
  privateAggregationWindow: number;
  /** 连续消息最大间隔（ms），超出视为新主题（fat-fish MAX_SEQUENCE_GAP）。 */
  maxSequenceGap: number;
  /** 引用回看窗口（秒），fat-fish REPLY_MAX_GAP_SEC。 */
  replyMaxGapSec: number;
  /** 长文本按此字节数强制分句（fat-fish IMAGE_URL_MAX_CHARS 思路复用）。 */
  maxMessageBytes: number;
  /** 合并转发消息最多展开条数。 */
  forwardExpandLimit: number;
  /** 本地表情包图片目录（相对扩展或绝对路径），供发送 `[表情包:文件名]` 标记使用。 */
  emojiDir: string;
  /** 是否把图片作为附件交给模型（需要模型支持图像）。 */
  deliverImageAttachments: boolean;
  /**
   * 群里要不要被动识图。私聊不受它管；关掉后群图只留 `[图片]` 占位。
   *
   * 群图量大且大多与她无关，被动识图是这一路最贵的开销。她主动看图
   * （`qqbot_view_image`）照旧，这里只管"收到就自动送去识别"。
   */
  visionInGroups: boolean;
  /**
   * 群里要不要把图片直接当附件交给模型（要求模型本身能看图）。
   *
   * 和 `visionInGroups` 是两条不同的路：这条不调外部视觉模型，图片直接进上下文，
   * 所以"便宜"只是相对 VLM 而言——一张图仍然要花 token，群里一晚上几十张就是几十份。
   * 私聊不受它管，私聊的图一律给看。
   */
  deliverImageAttachmentsInGroups: boolean;
  /**
   * 群消息的安静窗口（毫秒）：最后一条之后等这么久再一起交给她。
   * 一批事件只花一次模型往返，而每次往返都要重发整个上下文，所以群里等久一点更省。
   */
  groupQuietGapMs: number;
  /**
   * 群消息的批次时限（毫秒）：一批最多压这么久。
   *
   * 话密的时候安静窗口会被下一条消息一直顶掉，真正决定投递节奏的是这个上限。
   * 给得比私聊宽——一群人的话本来就不必逐条跟。
   */
  groupMaxBatchAgeMs: number;
  /**
   * 私聊的批次时限（毫秒）。私聊一对一，压久了就是"她要想一下才回"，
   * 所以按最常见的"最后一条之后 2.5 秒"留一点余量。
   */
  privateMaxBatchAgeMs: number;
  /** 发送时按句拆分多条（fat-fish SPLIT_REPLY_BY_SENTENCE）。 */
  splitReplyBySentence: boolean;
  /** 私聊也允许按句拆分；总开关关闭时此项不生效。 */
  splitPrivateReplies: boolean;
  /** 少于此字符数时不做按句或空行拆分，字节上限仍生效。 */
  splitMinChars: number;
  /** 一次工具调用最多发送的条数；无法无损合并时不发送。 */
  splitReplyMaxMessages: number;
  /** 合并相邻短句，减少只有几字的消息。 */
  coalesceShortSentences: boolean;
  /** 每条消息最多容纳句数（fat-fish SENTENCES_PER_MESSAGE）。 */
  sentencesPerMessage: number;
  /** 按空行拆段：一段说完拆成一条消息，不在一条里空行。 */
  splitParagraphs: boolean;
  /** 去掉每条消息末尾的句号（语气标点保留）。 */
  stripTrailingPeriod: boolean;
  /** 逐条发送之间的间隔毫秒（fat-fish SEND_INTERVAL_SECONDS），0 表示不限速。 */
  sendIntervalMs: number;
  /** 被动视觉：自动用 VLM 描述图片（off 则不调用外部 API，仅留占位）。 */
  vision: {
    enabled: boolean;
    endpoint: string;
    apiKeySecret: string;
    model: string;
    maxConcurrent: number;
    maxBytes: number;
    timeoutMs: number;
  };
  /** 表情包自动收藏：下载 + 情感/用处标注 + 内容去重。 */
  sticker: {
    /** 是否自动收藏表情包。 */
    enabled: boolean;
    /** 采集范围：sticker=仅 OneBot sticker/image.subType=sticker；allImages=所有图片都当表情候选。 */
    captureMode: 'sticker' | 'allImages';
    /** 表情包落盘目录（相对扩展或绝对），空则复用 emojiDir。 */
    dir: string;
  };
  /** 会话候选调度：按频率、额度、冷却生成候选事件，由 Persona 自己决定是否发言。旧模型和预热字段仅保留配置兼容。 */
  proactive: {
    enabled: boolean;
    mode: 'private' | 'group' | 'both';
    systemPrompt: string;
    endpoint: string;
    apiKeySecret: string;
    model: string;
    tickSec: number;
    warmupMin: number;
    stableChancePerTick: number;
    warmupChance: number;
    privateCooldownSec: number;
    groupCooldownSec: number;
    unrepliedThreshold: number;
    silentHours: number;
    dailyQuota: number;
    dedupWindow: number;
    /** 主动消息与近期已发内容的相似度上限（0~1，字符二元组 Jaccard），超过则跳过，防同一话题反复换汤不换药。 */
    topicSimilarity: number;
    /** 夜间静默：从几点起不主动发（本地时间，24 小时制）。跨夜写法同 qzone 的 quietFrom/quietTo。 */
    quietFrom: number;
    /** 夜间静默：到几点止。两值相等 = 不静默。 */
    quietTo: number;
    /**
     * 全局最小间隔（秒）：上一句主动消息之后不到这个时间，一拍里一个人都不发。
     *
     * 移植时漏在接口外了——值一直在用（proactive.ts 的全局节流），类型里却没有，
     * 于是任何按类型读配置的地方都看不见它。
     */
    minGapSec: number;
    /**
     * 在最小间隔之上再等一段随机时间（秒），下一次开口落在
     * `minGapSec + random(0, 它)` 之后。
     *
     * 0 = 不抖动（每次都卡在整间隔上，一下午像上了发条）。
     */
    gapJitterSec: number;
  };
  /** QQ 空间（动态/说说）：按对话与记忆发表自己的看法/吐槽/简介，可附图与@，支持删除与评论回复。 */
  qzone: QZoneConfig;
  /** 群聊发言频率限制：限制每个群在单位时间窗口内被 bot 主动+回复发出的消息总量，防止刷屏。 */
  groupSpeak: {
    /** 是否启用群聊发言频率限制。 */
    enabled: boolean;
    /** 滑动窗口内允许发出的最大消息条数。 */
    maxPerWindow: number;
    /** 滑动窗口长度（秒）。 */
    windowSec: number;
  };
  /** 话题自动结束 / 防死循环：统计单会话内 bot 连续发言次数，超过阈值或对方长时间未接话则自动收尾。 */
  antiLoop: {
    /** 是否启用防死循环。 */
    enabled: boolean;
    /** 单会话内 bot 连续发言上限（对方发来任意消息即清零），超过则本次发言被拦截并提示收尾。 */
    maxConsecutiveBotTurns: number;
    /** 对方静默超过该秒数且 bot 已发过言，则自动收尾（0=关闭该规则）。 */
    idleToEndSec: number;
  };
  /** 情绪系统：移植自 fat-fish qq_bot 的 emotion 模块，全局维护一份心情，注入上下文并支持 /心情 查询。 */
  emotion: {
    /** 是否启用情绪感知与注入。 */
    enabled: boolean;
    /** 情绪感知所用 chat 端点（OpenAI 兼容）。 */
    endpoint: string;
    /** 端点密钥的环境变量名。 */
    apiKeySecret: string;
    /** 感知模型。 */
    model: string;
    /** 心情自然衰减半衰期（小时），越小忘得越快。对齐 fat-fish EMOTION_DECAY_HOURS。 */
    decayHours: number;
    /** 主导情绪标签冷却（分钟）：冷却期内不切换到新标签，避免来回横跳。对齐 EMOTION_LABEL_MINUTES。 */
    labelMinutes: number;
  };
  /** 时区，用于时间戳与 env 提示。 */
  timezone: string;
  /**
   * 私聊消息末尾带的一句提示。空串 = 不带。
   *
   * 为什么不靠提示词就够：整批都是纯文本时，模型可能只把话写出来、不调 `qqbot_send`，
   * 于是"她回了、主人一个字没收到"（2026-09-23 凌晨真踩过）。
   * 这条直接挂在**那条消息上**，只在有人对着她说话时出现，其余消息保持安静。
   */
  replyCue: string;
  /** 群里被 @ 时的同一句提示（群消息多，不能每条都挂）。 */
  replyCueGroup: string;
  /** Deprecated: World no longer reads Persona Memory. */
  memoryDir: string;
  /**
   * 她对各个群的参与度（键是群号字符串）。主场群给高值、只在该被点到才吭声的群给低值。
   *
   * 这一项同时管两件事：`quietByConversation` 只报参与度达门槛的群
   * （低参与度的群本来就不该硬凑），主动说话也按它挑该去的地方。
   */
  groupProfiles?: Record<string, { active: number; note?: string }>;
  /** 没单独配的群用这个参与度。 */
  groupActiveDefault: number;
  /** 主动冒泡的参与度门槛：低于它的群不去主动说话（那是"别硬凑"的群）。 */
  proactiveMinActive: number;
  /**
   * 语音：把一句话合成成语音条发出去。合成在本机服务里做，这里只管把文本换成 WAV 字节。
   *
   * `serviceUrl` 空 = 没有语音能力，`qqbot_send` 的 `voice` 参数不出现（她也就不会用）。
   */
  voice: {
    /** 语音服务地址，形如 `http://127.0.0.1:5000`（POST /tts）。空=关闭。 */
    serviceUrl: string;
    /** 单次合成超时。 */
    timeoutMs: number;
    /** 最长多少字才给发语音：太长的一条没法听，退回打字。 */
    maxChars: number;
    /** 声线，交给服务端解释（GPT-SoVITS 里是声线名）。 */
    voice: string;
    /**
     * 入站语音的识别服务地址，形如 `http://127.0.0.1:5001`（POST /asr，收 WAV 字节）。
     * 空 = 听不懂语音，事件里只留 `[语音]`。
     *
     * 识别结果并进事件正文（`[语音] 他说的话`），所以情绪、记忆、她自己读到的都是同一份文本。
     */
    transcribeUrl: string;
    /** 单次识别超时。识别失败或超时都退回 `[语音]`，绝不阻塞消息。 */
    transcribeTimeoutMs: number;
    /**
     * 解码语音用的 ffmpeg。空 = 依次找 PATH、`<repoRoot>/node_modules/ffmpeg-static/ffmpeg.exe`。
     *
     * 为什么要配：这台机器 PATH 里没有 ffmpeg、ffmpeg-static 也没下二进制，
     * 于是 NapCat 推来的 SILK/AMR 语音一条都解不开——语音通道一直是哑的。
     */
    ffmpegPath: string;
  };
  /**
   * 人册：按 QQ 号记「这人是谁、怎么处、别提什么」，在**那一行事件里**带一句。
   *
   * 只在说话那个人自己那一行出现（不像好感度那样把所有人塞进每轮前缀）——
   * 她跟谁说话就看见谁，跨群也认得出同一个人。
   */
  peopleNoteChars: number;
  /**
   * 群册注入的间隔（毫秒）：同一个群在这个间隔内只把"这群是什么样"带出来一次。
   *
   * 群消息一天几百条，条条都贴会把上下文淹掉；隔一阵贴一次，够她重新想起这地方的分寸。
   */
  groupLoreGapMs: number;
  /** 群册单次注入的字数上限。 */
  groupLoreChars: number;
}


export const QQ_DEFAULTS: QQWorldConfig = {
  mode: 'reverse',
  wsUrl: 'ws://127.0.0.1:3001',
  wsHost: '0.0.0.0',
  wsPort: 8080,
  wsPath: '/onebot/v11/ws',
  token: '',
  groups: [],
  privates: [],
  friendAutoAdd: false,
  privateAggregationWindow: 0,
  maxSequenceGap: 8000,
  replyMaxGapSec: 600,
  maxMessageBytes: 1500,
  forwardExpandLimit: 20,
  emojiDir: '',
  deliverImageAttachments: true,
  visionInGroups: false,
  deliverImageAttachmentsInGroups: false,
  groupQuietGapMs: 12000,
  groupMaxBatchAgeMs: 20000,
  privateMaxBatchAgeMs: 5000,
  splitReplyBySentence: true,
  splitPrivateReplies: false,
  splitMinChars: 120,
  splitReplyMaxMessages: 2,
  coalesceShortSentences: true,
  sentencesPerMessage: 1,
  splitParagraphs: false,
  stripTrailingPeriod: false,
  sendIntervalMs: 600,
  vision: {
    enabled: false,
    endpoint: 'https://openrouter.ai/api/v1',
    apiKeySecret: 'OPENROUTER_API_KEY',
    model: 'google/gemini-2.5-flash',
    maxConcurrent: 3,
    maxBytes: 8_000_000,
    timeoutMs: 30000,
  },
  sticker: {
    enabled: true,
    captureMode: 'sticker',
    dir: '',
  },
  proactive: {
    enabled: false,
    mode: 'private',
    systemPrompt:
      '现在你要主动找对方说话（不是回复，是主动冒泡）。' +
      '说点自然、轻松、像真人在摸鱼时随手发的闲聊：关心一下、抛个小话题、分享点碎碎念都行。' +
      '一两句就够，别太长别太正式，别用「请问/您好」这种客服腔，也别每条都问「在吗」。',
    endpoint: 'https://openrouter.ai/api/v1',
    apiKeySecret: 'OPENROUTER_API_KEY',
    model: 'google/gemini-2.5-flash',
    tickSec: 45,
    warmupMin: 2,
    stableChancePerTick: 0.2,
    warmupChance: 0.7,
    privateCooldownSec: 120,
    groupCooldownSec: 20,
    unrepliedThreshold: 3,
    silentHours: 6,
    dailyQuota: 20,
    dedupWindow: 12,
    topicSimilarity: 0.6,
    quietFrom: 23,
    quietTo: 9,
    // 一句之后至少隔这么久才再主动开口：把话摊开，别一拍给所有人各发一条。
    minGapSec: 600,
    gapJitterSec: 900,
  },
  qzone: {
    enabled: false,
    systemPrompt:
      '现在你要以第一人称在 QQ 空间发一条动态（说说）。内容像随手写的一条：可以对最近某件事、某个人说句真话，吐槽或安利，也可以就是说当下在干嘛。别太长（一两句），不要写成回复、不要「在吗」、不要客服腔、不要卖萌。',
    endpoint: 'https://openrouter.ai/api/v1',
    apiKeySecret: 'OPENROUTER_API_KEY',
    model: 'google/gemini-2.5-flash',
    tickSec: 900,
    chancePerTick: 0.15,
    dailyQuota: 5,
    permission: 1,
    imageMode: 'none',
    autoReplyComments: {
      enabled: false,
      systemPrompt:
        'QQ 空间有人评论了你的动态，回一句。像随口接话，短、不客套、不卖萌。',
      dailyQuota: 20,
      cooldownSec: 30,
    },
    // 空 = 回评这条路没打通。NapCat 4.18.28 的空间扩展只注册了两个动作
    // （send_qzone_msg 发说说、delete_qzone_msg 删说说），**没有任何评论相关 action**：
    // 评论回复要的 OneBot action。不同 NapCat 版本支持不同：NapCat4 只内置了
    // send_qzone_msg / delete_qzone_msg，调 send_qzone_comment 会回「不支持的Api」；
    // 新一点的服务端可能支持。默认填上，不支持时回执会原样带回服务端的错误。
    commentAction: 'send_qzone_comment',
  },
  groupSpeak: {
    enabled: true,
    maxPerWindow: 12,
    windowSec: 60,
  },
  antiLoop: {
    enabled: true,
    maxConsecutiveBotTurns: 5,
    idleToEndSec: 300,
  },
  emotion: {
    enabled: true,
    endpoint: 'https://api.deepseek.com/v1',
    apiKeySecret: 'DEEPSEEK_API_KEY',
    model: 'deepseek-chat',
    decayHours: 2.0,
    labelMinutes: 40,
  },
  timezone: 'Asia/Shanghai',
  replyCue: '\n（要回的话，正文直接填进 qqbot_send 的 text 里，to 抄这一行最前面的会话标号——写出来不等于发出去。）',
  replyCueGroup: '\n（要接的话，正文直接填进 qqbot_send 的 text 里，to 抄这一行最前面的会话标号——写出来不等于发出去。）',
  ownerQQ: 0,
  adminGroups: [],
  memoryDir: '',
  groupActiveDefault: 0.35,
  proactiveMinActive: 0.5,
  voice: {
    serviceUrl: '',
    timeoutMs: 60000,
    maxChars: 120,
    voice: '',
    transcribeUrl: '',
    transcribeTimeoutMs: 60000,
    ffmpegPath: '',
  },
  peopleNoteChars: 60,
  groupLoreGapMs: 600_000,
  groupLoreChars: 120,
};

export const QQ_SECRETS = ['QQ_ACCESS_TOKEN', 'OPENROUTER_API_KEY'];

/** worlds.qq 配置段：业务参数 + 必需的 enabled 开关。 */
export type QQConfigSection = QQWorldConfig & WorldSection;

export function qqDefaults(): QQConfigSection {
  return { ...QQ_DEFAULTS, enabled: false };
}

/** 控制台可编辑的连接/监听配置组（JSON Schema 形态）。 */
export const QQ_CONFIG_GROUP: ConfigGroup = {
  id: 'world:qqbot',
  owner: 'world:qqbot',
  schema: {
    type: 'object',
    title: 'QQ · 连接与监听',
    description: 'OneBot v11 / NapCat 连接参数与监听名单；连接类改动需重启生效。',
    properties: {
      'worlds.qqbot.mode': {
        type: 'string',
        title: '连接模式',
        enum: ['reverse', 'forward'],
        'x-hot': false,
        description: 'reverse=Cortico 开 WS 服务端等 NapCat 反向连（fat-fish 风格）；forward=Cortico 主动连 NapCat 的 wsUrl。',
      },
      'worlds.qqbot.wsUrl': { type: 'string', title: '正向 WS 地址', 'x-hot': false },
      'worlds.qqbot.wsHost': { type: 'string', title: '反向监听地址', 'x-hot': false },
      'worlds.qqbot.wsPort': { type: 'integer', title: '反向监听端口', minimum: 1, maximum: 65535, 'x-hot': false },
      'worlds.qqbot.wsPath': { type: 'string', title: '反向监听路径', 'x-hot': false },
      'worlds.qqbot.token': { type: 'string', title: 'OneBot Token', 'x-hot': false },
      'worlds.qqbot.groups': { type: 'string', title: '监听群', 'x-hot': true, description: '监听的群号，用空格或逗号分隔；空=全部群。改完即时生效，不用重启。' },
      'worlds.qqbot.privates': { type: 'string', title: '监听私聊', 'x-hot': true, description: '监听的私聊对方 QQ 号，用空格或逗号分隔；填 * 表示所有私聊都监听（所有好友都能找她）。改完即时生效，不用重启。' },
      'worlds.qqbot.friendAutoAdd': { type: 'boolean', title: '好友申请自动通过', 'x-hot': true, description: '别人加她好友时自动通过（NapCat 没有主动加人的接口，只能批申请）。改完即时生效。' },
      'worlds.qqbot.ownerQQ': { type: 'integer', title: '主人 QQ', minimum: 0, 'x-hot': true, description: '指定主要私聊联系人；0 表示未指定。本包不读取或附带 Persona 记事，是否优先保留其对话由 Persona 配置决定。' },
      'worlds.qqbot.adminGroups': { type: 'string', title: '群管授权群', 'x-hot': false, description: '允许她用群管工具（撤回 / @全体 / 公告 / 入群审批 / 头衔 / 禁言 / 踢人）的群号，空格或逗号分隔；空=群管全关。按群授权，不按人。' },
      'worlds.qqbot.deliverImageAttachments': { type: 'boolean', title: '图片作为模型附件', 'x-hot': true },
      'worlds.qqbot.emojiDir': { type: 'string', title: '表情包目录', 'x-hot': false, description: '本地表情包图片目录（相对扩展或绝对路径），供发送 [表情包:文件名] 标记。留空则用 <部署 dataDir>/qqbot/stickers。' },
      'worlds.qqbot.voice.serviceUrl': { type: 'string', title: '语音合成服务', 'x-hot': false, description: 'POST /tts 的地址（形如 http://127.0.0.1:5000）；空 = 她不能发语音。' },
      'worlds.qqbot.voice.voice': { type: 'string', title: '语音声线', 'x-hot': true, description: '交给语音服务解释的声线名（如 E）。' },
      'worlds.qqbot.voice.maxChars': { type: 'integer', title: '语音最长字数', minimum: 1, maximum: 500, 'x-hot': true, description: '超过这个字数的正文改发文字——太长的一条没法听。' },
      'worlds.qqbot.voice.transcribeUrl': { type: 'string', title: '语音识别服务', 'x-hot': true, description: 'POST /asr 的地址（形如 http://127.0.0.1:5001，收 WAV 字节）；空 = 听不懂语音，只留 [语音]。' },
      'worlds.qqbot.voice.transcribeTimeoutMs': { type: 'integer', title: '语音识别超时', minimum: 1000, maximum: 300000, 'x-suffix': 'ms', 'x-hot': true, description: '识别失败或超时都退回 [语音]，不阻塞消息。' },
      'worlds.qqbot.voice.ffmpegPath': { type: 'string', title: 'ffmpeg 路径', 'x-hot': false, description: '解码语音用。空 = 依次找 PATH 与仓库里的 ffmpeg-static；本机 PATH 里没有，要指到现成那一份上。' },
      'worlds.qqbot.peopleNoteChars': { type: 'integer', title: '人册注入字数', minimum: 10, maximum: 200, 'x-suffix': '字', 'x-hot': true, description: '事件行里替她带出的"你记的：…"最多几个字。人册按 QQ 号记，只在说话那个人那一行出现；未完的话头也并在这句里。' },
      'worlds.qqbot.groupLoreGapMs': { type: 'integer', title: '群册注入间隔', minimum: 0, maximum: 86400000, 'x-suffix': 'ms', 'x-hot': true, description: '同一个群隔多久才把"这群是什么样"带出来一次；0 = 每次都带（不建议）。' },
      'worlds.qqbot.groupLoreChars': { type: 'integer', title: '群册注入字数', minimum: 20, maximum: 400, 'x-suffix': '字', 'x-hot': true, description: '群册单次注入的字数上限（底细 + 这儿的梗）。' },
      'worlds.qqbot.splitParagraphs': { type: 'boolean', title: '按空行拆段发送', 'x-hot': true, description: '开启后把回复里用空行隔开的几段拆成几条消息发（一段说完就发，不在一条里空行）。' },
      'worlds.qqbot.stripTrailingPeriod': { type: 'boolean', title: '去掉末尾句号', 'x-hot': true, description: '开启后每条消息末尾的句号自动去掉，问号/感叹号/省略号保留。' },
      'worlds.qqbot.splitReplyBySentence': { type: 'boolean', title: '允许按句拆分', 'x-hot': true, description: '总开关；关闭时不按句或空行拆分，单条字节上限仍生效。' },
      'worlds.qqbot.splitPrivateReplies': { type: 'boolean', title: '私聊也允许拆句', 'x-hot': true, description: '默认关闭，私聊优先合并；群聊仍按总开关和长度配置处理。' },
      'worlds.qqbot.splitMinChars': { type: 'integer', title: '开始拆句的字符数', minimum: 0, maximum: 10000, 'x-hot': true, description: '短于此长度不按句或空行拆分；0 表示不限制起拆长度。' },
      'worlds.qqbot.splitReplyMaxMessages': { type: 'integer', title: '单次发送条数上限', minimum: 1, maximum: 20, 'x-hot': true, description: '含图片；先无损合并，仍超过上限则整次不发送并说明，正文不会截断。' },
      'worlds.qqbot.coalesceShortSentences': { type: 'boolean', title: '合并相邻短句', 'x-hot': true, description: '将不足起拆字符数的相邻短句合并，仍遵守单条字节上限。' },
      'worlds.qqbot.sentencesPerMessage': { type: 'integer', title: '每条句数', minimum: 1, maximum: 10, 'x-hot': true },
      'worlds.qqbot.sendIntervalMs': { type: 'integer', title: '发送间隔(ms)', minimum: 0, maximum: 5000, 'x-hot': true, description: '逐条发送之间的间隔，0 表示不限速。' },
      'worlds.qqbot.vision.enabled': { type: 'boolean', title: '开启辅助视觉', 'x-hot': false },
      'worlds.qqbot.visionInGroups': {
        type: 'boolean',
        title: '群里也识图',
        'x-hot': true,
        description: '关掉后群里发的图不再自动送视觉模型，只留可读占位；私聊不受影响。'
          + '群图量大且大多与她无关，这是这一路最贵的开销。她主动看图不受影响。',
      },
      'worlds.qqbot.groupQuietGapMs': {
        type: 'integer',
        title: '群消息等多久再一起交给她',
        minimum: 500,
        maximum: 60000,
        multipleOf: 500,
        'x-suffix': 'ms',
        'x-hot': true,
        description: '群消息的安静窗口。一批只花一次模型往返，而每次往返都要重发整个上下文，'
          + '所以群里等久一点更省。话密的时候这个窗口会被下一条消息顶掉，'
          + '那时实际节奏由批次的时限决定。私聊的窗口和上限都独立。',
      },
      'worlds.qqbot.groupMaxBatchAgeMs': {
        type: 'integer',
        title: '群批次时限',
        minimum: 1000,
        maximum: 300000,
        multipleOf: 500,
        'x-suffix': 'ms',
        'x-hot': true,
        description: '群消息一批最多压这么久。话密时真正决定投递节奏的是它，不是安静窗口。调大更省、回群更慢。',
      },
      'worlds.qqbot.privateMaxBatchAgeMs': {
        type: 'integer',
        title: '私聊批次时限',
        minimum: 1000,
        maximum: 60000,
        multipleOf: 500,
        'x-suffix': 'ms',
        'x-hot': true,
        description: '私聊一条消息最多压多久再交给她。一对一压久了就是"她要想一下才回"。',
      },
      'worlds.qqbot.vision.model': { type: 'string', title: 'VLM 模型', 'x-hot': false },
      'worlds.qqbot.sticker.enabled': { type: 'boolean', title: '自动收藏表情包', 'x-hot': false, description: '开启后自动下载消息里的表情包并标注情感/用处、内容去重，存到表情包目录（默认 <部署 dataDir>/qqbot/stickers）。' },
      'worlds.qqbot.sticker.captureMode': {
        type: 'string',
        title: '采集范围',
        enum: ['sticker', 'allImages'],
        'x-hot': false,
        description: 'sticker=仅 OneBot 表情包段；allImages=所有图片都当表情候选收藏。',
      },
      'worlds.qqbot.proactive.enabled': { type: 'boolean', title: '主动说话调度器', 'x-hot': false, description: '按配置节奏投递会话候选事件，是否回应及发送正文由 Persona 决定。' },
      'worlds.qqbot.proactive.mode': {
        type: 'string',
        title: '主动范围',
        enum: ['private', 'group', 'both'],
        'x-hot': true,
        description: 'private=仅私聊；group=仅群；both=都主动。',
      },
      'worlds.qqbot.proactive.dailyQuota': { type: 'integer', title: '每日上限', minimum: 0, maximum: 200, 'x-hot': true, description: '每日候选事件上限（0=不限），不代表已发送消息数。' },
      'worlds.qqbot.qzone.enabled': { type: 'boolean', title: 'QQ空间动态', 'x-hot': false, description: '开启显式发布/删除/评论工具与候选事件；不会自动生成或发送。需重新挂载。' },
      'worlds.qqbot.qzone.dailyQuota': { type: 'integer', title: '每日空间候选上限', minimum: 0, maximum: 50, 'x-hot': true, description: '空间候选事件的每日上限（0=不限）。' },
      'worlds.qqbot.qzone.permission': { type: 'integer', title: '动态可见权限', minimum: 0, maximum: 10, 'x-hot': true, description: 'ugc_right：1=公开（默认），其余值随 NapCat 版本。' },
      'worlds.qqbot.qzone.commentAction': { type: 'string', title: '评论回复 action', 'x-hot': true, description: '回复评论用的 OneBot action（不同 NapCat 版本可能不同，默认 send_qzone_comment）。' },
      'worlds.qqbot.proactive.quietFrom': { type: 'integer', title: '夜间静默开始（点）', minimum: 0, maximum: 23, 'x-suffix': '时', 'x-hot': true, description: '这个时间之后不主动发消息。跨夜按 quietFrom > quietTo 读；两个值相等=不静默。' },
      'worlds.qqbot.proactive.quietTo': { type: 'integer', title: '夜间静默结束（点）', minimum: 0, maximum: 23, 'x-suffix': '时', 'x-hot': true, description: '这个时间之前不主动发消息。' },
      'worlds.qqbot.proactive.minGapSec': { type: 'integer', title: '两次主动最小间隔', minimum: 0, maximum: 86400, 'x-suffix': '秒', 'x-hot': true, description: '两次候选事件之间的最小间隔（全局，不分会话）。' },
      'worlds.qqbot.proactive.gapJitterSec': { type: 'integer', title: '间隔随机抖动', minimum: 0, maximum: 86400, 'x-suffix': '秒', 'x-hot': true, description: '在最小间隔之上再随机等 0~这个秒数。0 = 每次都卡在整间隔上，看起来像排程。' },
      'worlds.qqbot.groupSpeak.enabled': { type: 'boolean', title: '群聊发言限速', 'x-hot': true, description: '开启后限制每个群在单位窗口内被 bot 发出的消息总量，防止刷屏/死循环灌水。' },
      'worlds.qqbot.groupSpeak.maxPerWindow': { type: 'integer', title: '窗口内最大条数', minimum: 1, maximum: 200, 'x-hot': true, description: '滑动窗口内允许发出的群消息上限（含主动与回复）。' },
      'worlds.qqbot.groupSpeak.windowSec': { type: 'integer', title: '窗口长度(秒)', minimum: 1, maximum: 3600, 'x-hot': true, description: '限速滑动窗口长度。' },
      'worlds.qqbot.antiLoop.enabled': { type: 'boolean', title: '话题自动结束', 'x-hot': true, description: '开启后统计单会话 bot 连续发言次数与对方静默时长，超限自动收尾，避免话题死循环。' },
      'worlds.qqbot.antiLoop.maxConsecutiveBotTurns': { type: 'integer', title: '连续发言上限', minimum: 1, maximum: 50, 'x-hot': true, description: '单会话内 bot 连续发言达到该次数（对方发消息即清零），下次发言被拦截并提示收尾。' },
      'worlds.qqbot.antiLoop.idleToEndSec': { type: 'integer', title: '对方静默收尾(秒)', minimum: 0, maximum: 86400, 'x-hot': true, description: '对方静默超过该秒数且 bot 已发过言则自动收尾；0=关闭该规则。' },
    },
  },
};

/**
 * 原地补全缺省值并保持对象身份：让 World 持有的 this.config 就是 ctx.cfg 的同一引用，
 * 这样控制台的 x-hot 配置改动（groups / privates / 发送节奏等）能即时对 World 生效，无需重启。
 */
/** 把“空格/逗号分隔字符串”或“数字数组”统一成数字数组（过滤非有限值）。控制台以字符串编辑，运行时以数组使用。 */
export function toIds(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number).filter((n) => Number.isFinite(n));
  if (typeof raw === 'string') return raw.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
  return [];
}

export function normalizeConfig(raw: QQConfigSection): QQWorldConfig {
  const c = raw as unknown as QQWorldConfig & Record<string, unknown>;
  for (const [k, v] of Object.entries(QQ_DEFAULTS)) {
    if (c[k] === undefined) c[k] = v;
  }
  c.groups = toIds(c.groups);
  // privates 里写 * 表示所有好友私聊都监听，不能被 toIds 吃掉
  {
    const raw = c.privates as unknown;
    const text = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
    c.privates = text.trim() === '*' || /(^|[\s,])all([\s,]|$)/i.test(text) ? '*' : toIds(raw);
  }
  c.adminGroups = toIds(c.adminGroups);
  if (typeof c.ownerQQ !== 'number' || !Number.isFinite(c.ownerQQ) || c.ownerQQ < 0) c.ownerQQ = QQ_DEFAULTS.ownerQQ;
  if (typeof c.privateAggregationWindow !== 'number') c.privateAggregationWindow = QQ_DEFAULTS.privateAggregationWindow;
  if (typeof c.maxSequenceGap !== 'number') c.maxSequenceGap = QQ_DEFAULTS.maxSequenceGap;
  if (typeof c.replyMaxGapSec !== 'number') c.replyMaxGapSec = QQ_DEFAULTS.replyMaxGapSec;
  if (typeof c.maxMessageBytes !== 'number') c.maxMessageBytes = QQ_DEFAULTS.maxMessageBytes;
  if (typeof c.forwardExpandLimit !== 'number') c.forwardExpandLimit = QQ_DEFAULTS.forwardExpandLimit;
  if (typeof c.splitReplyBySentence !== 'boolean') c.splitReplyBySentence = true;
  if (typeof c.splitPrivateReplies !== 'boolean') c.splitPrivateReplies = QQ_DEFAULTS.splitPrivateReplies;
  if (typeof c.coalesceShortSentences !== 'boolean') c.coalesceShortSentences = QQ_DEFAULTS.coalesceShortSentences;
  for (const [key, min, max] of [['splitMinChars', 0, 10000], ['splitReplyMaxMessages', 1, 20]] as const) {
    const value = c[key];
    c[key] = typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : QQ_DEFAULTS[key];
  }
  if (typeof c.splitParagraphs !== 'boolean') c.splitParagraphs = false;
  if (typeof c.stripTrailingPeriod !== 'boolean') c.stripTrailingPeriod = false;
  if (typeof c.sentencesPerMessage !== 'number') c.sentencesPerMessage = 1;
  if (typeof c.sendIntervalMs !== 'number') c.sendIntervalMs = QQ_DEFAULTS.sendIntervalMs;
  if (typeof c.deliverImageAttachments !== 'boolean') c.deliverImageAttachments = QQ_DEFAULTS.deliverImageAttachments;
  if (typeof c.emojiDir !== 'string' || !c.emojiDir) c.emojiDir = QQ_DEFAULTS.emojiDir;
  if (typeof c.timezone !== 'string' || !c.timezone) c.timezone = QQ_DEFAULTS.timezone;
  if (typeof c.mode !== 'string') c.mode = 'reverse';
  if (typeof c.token !== 'string') c.token = '';
  if (typeof c.wsUrl !== 'string') c.wsUrl = QQ_DEFAULTS.wsUrl;
  if (typeof c.wsHost !== 'string') c.wsHost = QQ_DEFAULTS.wsHost;
  if (typeof c.wsPort !== 'number') c.wsPort = QQ_DEFAULTS.wsPort;
  if (typeof c.wsPath !== 'string') c.wsPath = QQ_DEFAULTS.wsPath;
  // vision 子对象原地合并，保持引用身份（x-hot 生效）
  c.vision = c.vision ?? {};
  Object.assign(c.vision, { ...QQ_DEFAULTS.vision, ...(c.vision as object) });
  // sticker 子对象原地合并
  c.sticker = c.sticker ?? {};
  Object.assign(c.sticker, { ...QQ_DEFAULTS.sticker, ...(c.sticker as object) });
  if (typeof c.sticker.enabled !== 'boolean') c.sticker.enabled = true;
  if (c.sticker.captureMode !== 'sticker' && c.sticker.captureMode !== 'allImages') c.sticker.captureMode = 'sticker';
  if (typeof c.sticker.dir !== 'string') c.sticker.dir = '';
  // proactive 子对象原地合并
  c.proactive = c.proactive ?? {};
  Object.assign(c.proactive, { ...QQ_DEFAULTS.proactive, ...(c.proactive as object) });
  const p = c.proactive as Record<string, unknown>;
  if (typeof p.enabled !== 'boolean') p.enabled = false;
  if (p.mode !== 'private' && p.mode !== 'group' && p.mode !== 'both') p.mode = 'private';
  if (typeof p.systemPrompt !== 'string' || !p.systemPrompt) p.systemPrompt = QQ_DEFAULTS.proactive.systemPrompt;
  if (typeof p.endpoint !== 'string' || !p.endpoint) p.endpoint = QQ_DEFAULTS.proactive.endpoint;
  if (typeof p.apiKeySecret !== 'string' || !p.apiKeySecret) p.apiKeySecret = QQ_DEFAULTS.proactive.apiKeySecret;
  if (typeof p.model !== 'string' || !p.model) p.model = QQ_DEFAULTS.proactive.model;
  if (typeof p.tickSec !== 'number') p.tickSec = QQ_DEFAULTS.proactive.tickSec;
  if (typeof p.warmupMin !== 'number') p.warmupMin = QQ_DEFAULTS.proactive.warmupMin;
  if (typeof p.stableChancePerTick !== 'number') p.stableChancePerTick = QQ_DEFAULTS.proactive.stableChancePerTick;
  if (typeof p.warmupChance !== 'number') p.warmupChance = QQ_DEFAULTS.proactive.warmupChance;
  if (typeof p.privateCooldownSec !== 'number') p.privateCooldownSec = QQ_DEFAULTS.proactive.privateCooldownSec;
  if (typeof p.groupCooldownSec !== 'number') p.groupCooldownSec = QQ_DEFAULTS.proactive.groupCooldownSec;
  if (typeof p.unrepliedThreshold !== 'number') p.unrepliedThreshold = QQ_DEFAULTS.proactive.unrepliedThreshold;
  if (typeof p.silentHours !== 'number') p.silentHours = QQ_DEFAULTS.proactive.silentHours;
  if (typeof p.dailyQuota !== 'number') p.dailyQuota = QQ_DEFAULTS.proactive.dailyQuota;
  if (typeof p.dedupWindow !== 'number') p.dedupWindow = QQ_DEFAULTS.proactive.dedupWindow;
  if (typeof p.topicSimilarity !== 'number' || (p.topicSimilarity as number) < 0 || (p.topicSimilarity as number) > 1) p.topicSimilarity = QQ_DEFAULTS.proactive.topicSimilarity;
  if (typeof p.quietFrom !== 'number') p.quietFrom = QQ_DEFAULTS.proactive.quietFrom;
  if (typeof p.quietTo !== 'number') p.quietTo = QQ_DEFAULTS.proactive.quietTo;
  if (typeof p.minGapSec !== 'number' || (p.minGapSec as number) < 0) p.minGapSec = QQ_DEFAULTS.proactive.minGapSec;
  if (typeof p.gapJitterSec !== 'number' || (p.gapJitterSec as number) < 0) p.gapJitterSec = QQ_DEFAULTS.proactive.gapJitterSec;
  // qzone 子对象原地合并
  const qzoneMerged = Object.assign(
    { ...QQ_DEFAULTS.qzone },
    (c.qzone && typeof c.qzone === 'object' ? c.qzone : {}) as unknown as Record<string, unknown>,
  ) as unknown as QZoneConfig;
  c.qzone = qzoneMerged;
  const q = qzoneMerged as unknown as Record<string, unknown>;
  if (typeof q.enabled !== 'boolean') q.enabled = false;
  if (typeof q.systemPrompt !== 'string' || !q.systemPrompt) q.systemPrompt = QQ_DEFAULTS.qzone.systemPrompt;
  if (typeof q.endpoint !== 'string' || !q.endpoint) q.endpoint = QQ_DEFAULTS.qzone.endpoint;
  if (typeof q.apiKeySecret !== 'string' || !q.apiKeySecret) q.apiKeySecret = QQ_DEFAULTS.qzone.apiKeySecret;
  if (typeof q.model !== 'string' || !q.model) q.model = QQ_DEFAULTS.qzone.model;
  if (typeof q.tickSec !== 'number') q.tickSec = QQ_DEFAULTS.qzone.tickSec;
  if (typeof q.chancePerTick !== 'number') q.chancePerTick = QQ_DEFAULTS.qzone.chancePerTick;
  if (typeof q.dailyQuota !== 'number') q.dailyQuota = QQ_DEFAULTS.qzone.dailyQuota;
  if (typeof q.permission !== 'number') q.permission = QQ_DEFAULTS.qzone.permission;
  if (q.imageMode !== 'none' && q.imageMode !== 'recent') q.imageMode = 'none' as const;
  const ar = (q.autoReplyComments ??= {}) as Record<string, unknown>;
  Object.assign(ar, { ...QQ_DEFAULTS.qzone.autoReplyComments, ...ar });
  if (typeof ar.enabled !== 'boolean') ar.enabled = false;
  if (typeof ar.systemPrompt !== 'string' || !ar.systemPrompt) ar.systemPrompt = QQ_DEFAULTS.qzone.autoReplyComments.systemPrompt;
  if (typeof ar.dailyQuota !== 'number') ar.dailyQuota = QQ_DEFAULTS.qzone.autoReplyComments.dailyQuota;
  if (typeof ar.cooldownSec !== 'number') ar.cooldownSec = QQ_DEFAULTS.qzone.autoReplyComments.cooldownSec;
  if (typeof q.commentAction !== 'string' || !q.commentAction) q.commentAction = QQ_DEFAULTS.qzone.commentAction;
  // groupSpeak / antiLoop 子对象原地合并
  c.groupSpeak = c.groupSpeak ?? {};
  Object.assign(c.groupSpeak, { ...QQ_DEFAULTS.groupSpeak, ...(c.groupSpeak as object) });
  const gs = c.groupSpeak as Record<string, unknown>;
  if (typeof gs.enabled !== 'boolean') gs.enabled = true;
  if (typeof gs.maxPerWindow !== 'number' || (gs.maxPerWindow as number) < 1) gs.maxPerWindow = QQ_DEFAULTS.groupSpeak.maxPerWindow;
  if (typeof gs.windowSec !== 'number' || (gs.windowSec as number) < 1) gs.windowSec = QQ_DEFAULTS.groupSpeak.windowSec;
  c.antiLoop = c.antiLoop ?? {};
  Object.assign(c.antiLoop, { ...QQ_DEFAULTS.antiLoop, ...(c.antiLoop as object) });
  const al = c.antiLoop as Record<string, unknown>;
  if (typeof al.enabled !== 'boolean') al.enabled = true;
  if (typeof al.maxConsecutiveBotTurns !== 'number' || (al.maxConsecutiveBotTurns as number) < 1) al.maxConsecutiveBotTurns = QQ_DEFAULTS.antiLoop.maxConsecutiveBotTurns;
  if (typeof al.idleToEndSec !== 'number' || (al.idleToEndSec as number) < 0) al.idleToEndSec = QQ_DEFAULTS.antiLoop.idleToEndSec;
  // voice 子对象原地合并：部署里已经写了 voice 段，缺的新键要在这里补齐，
  // 否则 `transcribeUrl` 之类会是 undefined（默认值只在整段缺席时才补）。
  c.voice = c.voice ?? {};
  Object.assign(c.voice, { ...QQ_DEFAULTS.voice, ...(c.voice as object) });
  const vc = c.voice as Record<string, unknown>;
  if (typeof vc.serviceUrl !== 'string') vc.serviceUrl = QQ_DEFAULTS.voice.serviceUrl;
  if (typeof vc.timeoutMs !== 'number' || (vc.timeoutMs as number) <= 0) vc.timeoutMs = QQ_DEFAULTS.voice.timeoutMs;
  if (typeof vc.maxChars !== 'number' || (vc.maxChars as number) < 1) vc.maxChars = QQ_DEFAULTS.voice.maxChars;
  if (typeof vc.voice !== 'string') vc.voice = QQ_DEFAULTS.voice.voice;
  if (typeof vc.transcribeUrl !== 'string') vc.transcribeUrl = QQ_DEFAULTS.voice.transcribeUrl;
  if (typeof vc.transcribeTimeoutMs !== 'number' || (vc.transcribeTimeoutMs as number) <= 0) vc.transcribeTimeoutMs = QQ_DEFAULTS.voice.transcribeTimeoutMs;
  if (typeof vc.ffmpegPath !== 'string') vc.ffmpegPath = QQ_DEFAULTS.voice.ffmpegPath;
  if (typeof c.peopleNoteChars !== 'number' || (c.peopleNoteChars as number) < 10) c.peopleNoteChars = QQ_DEFAULTS.peopleNoteChars;
  if (typeof c.groupLoreGapMs !== 'number' || (c.groupLoreGapMs as number) < 0) c.groupLoreGapMs = QQ_DEFAULTS.groupLoreGapMs;
  if (typeof c.groupLoreChars !== 'number' || (c.groupLoreChars as number) < 20) c.groupLoreChars = QQ_DEFAULTS.groupLoreChars;
  // emotion 子对象原地合并
  c.emotion = c.emotion ?? {};
  Object.assign(c.emotion, { ...QQ_DEFAULTS.emotion, ...(c.emotion as object) });
  const em = c.emotion as Record<string, unknown>;
  if (typeof em.enabled !== 'boolean') em.enabled = true;
  if (typeof em.endpoint !== 'string' || !em.endpoint) em.endpoint = QQ_DEFAULTS.emotion.endpoint;
  if (typeof em.apiKeySecret !== 'string' || !em.apiKeySecret) em.apiKeySecret = QQ_DEFAULTS.emotion.apiKeySecret;
  if (typeof em.model !== 'string' || !em.model) em.model = QQ_DEFAULTS.emotion.model;
  if (typeof em.decayHours !== 'number' || (em.decayHours as number) <= 0) em.decayHours = QQ_DEFAULTS.emotion.decayHours;
  if (typeof em.labelMinutes !== 'number' || (em.labelMinutes as number) < 0) em.labelMinutes = QQ_DEFAULTS.emotion.labelMinutes;
  return c;
}

export function parseNumberSeq(v: unknown): number[] {
  if (Array.isArray(v)) return v.map((x) => Number(x)).filter((x) => Number.isFinite(x));
  if (typeof v === 'string') {
    return v
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n));
  }
  return [];
}
