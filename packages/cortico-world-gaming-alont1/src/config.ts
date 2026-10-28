/**
 * Gaming World 的配置段：worlds.gaming。
 *
 * 默认值是中性的：不预置任何具体游戏，游戏库为空，靠"没认出来的也照样跟"兜底。
 * 想让它认得自己常玩的游戏就填 `games`——填了之后显示的是你给的名字，
 * 不填就用窗口标题里那截。
 */
import type { ConfigGroup } from 'cortico/core/types.ts'

/** 游戏库里的一条。只为"认得出来 + 显示成我习惯的名字"服务。 */
export interface GameConfig {
  /** 稳定 id，会写进状态文件和小节标题。建议用英文短名。 */
  id: string
  /** 显示名。不进状态文件里的键，只用来给她看。 */
  name: string
  /** 进程名（不带 .exe），小写。最稳的匹配依据。 */
  processes: string[]
  /** 标题里可能出现的别名。进程名是通用启动器时用这个兜底。 */
  aliases: string[]
  /** 这个游戏里她可以留意什么。一句话，进提示词。 */
  watchFor?: string
}

/** 配置界面快速区的 6 个游戏格（一行一个游戏）。 */
export interface SimpleGamesConfig {
  slot1: string
  slot2: string
  slot3: string
  slot4: string
  slot5: string
  slot6: string
}

export const SIMPLE_GAMES_DEFAULTS: SimpleGamesConfig = { slot1: '', slot2: '', slot3: '', slot4: '', slot5: '', slot6: '' }

export interface GamingConfigSection {
  enabled: boolean

  /** 游戏库。空数组 = 不预置，靠标题认。 */
  games: GameConfig[]

  /** 配置界面快速区的 6 个游戏格；启动时会被合并进游戏库。 */
  simple: SimpleGamesConfig

  /**
   * 只认游戏库里列的游戏。
   *
   * 关掉时，库里没有的窗口只要有标题就算成"在玩某个游戏"——那本意是"她也能发现
   * 你没告诉她新游戏"，实际用起来太吵：浏览器、加速器、聊天窗口全都会被当成游戏，
   * 她就一句句说错话。黑名单（`nonGameProcesses`）挡不住，因为漏一个就报一个。
   *
   * 开着时行为是可预测的：游戏库里没有，就是"没在玩"。
   */
  knownGamesOnly: boolean

  /**
   * 不算游戏的进程名（小写）。默认表覆盖浏览器、编辑器、聊天工具这些——
   * 它们经常在前台，不排掉的话她会以为你一直在"玩"。
   *
   * 只在 `knownGamesOnly` 关掉时才有用。
   */
  nonGameProcesses: string[]

  /** 多久采一次前台窗口（毫秒）。太快没必要，切窗口没那么勤。 */
  pollMs: number

  /**
   * 切出去多久才算"不玩了"（分钟）。
   * 短暂切出去看攻略不算结束——不然"这一局玩了多久"会碎成一片。
   */
  awayMinutes: number

  /** 同一个游戏连着玩多久算"很久了"（分钟）。每跨越这个数报一次。 */
  longSessionMinutes: number

  /**
   * 深夜时段的起止小时。跨午夜要能表达（比如 1 点到 5 点）。
   *
   * 早先只有一个 `lateNightFromHour` 配一个 `|| h < 5` 的兜底，结果默认值 1
   * 让「1 点之后一直算深夜」——晚上八点也被报了一次。区间必须写全。
   */
  lateNightStartHour: number
  lateNightEndHour: number

  /** 状态里留最近多少条事件。 */
  eventKeep: number

  // ── 主动性 ──
  /** 开不开主动搭话。关掉就只是"她知道你在玩"，你不理她不打扰。 */
  reachOut: boolean
  /**
   * 两次主动之间至少隔多久（分钟）。
   *
   * 这个值不该设太大——陪伴感就来自"她在旁边看着"。约束靠"不重复"和
   * 事件本身的稀疏（开局、换游戏、玩太久、深夜），不靠硬压间隔。
   */
  reachMinGapMinutes: number
  /** 一天最多主动几次。0 = 不限。 */
  reachMaxPerDay: number
  /** 长时间没玩之后重新开，也算一次值得说话的开局（小时）。 */
  freshSessionAfterHours: number

  /** 看画面。 */
  watch: GamingWatchConfig

  /** 看图工具的"耐久度"：查 DeepSeek 余额，低了提醒她省着用。 */
  balance: BalanceConfigSection
}

/**
 * 看画面：抓游戏窗口交给视觉模型读，读出来的一局结束就告诉她。
 *
 * 默认关着。它每次都要调用一次视觉模型，开着就有费用，所以由部署显式打开。
 */
export interface GamingWatchConfig {
  enabled: boolean

  /** 隔多久看一次（秒）。它是抽帧，看到的不是连续过程。 */
  everySec: number

  /**
   * 两次因为画面而开口之间至少隔多久（秒）。
   *
   * 结算画面会挂好几十秒，抽帧会连着看到好几次；没有这个间隔她会把同一局报成好几局。
   */
  speakGapSec: number

  /**
   * 局中也插话。
   *
   * 关掉就只在"一局刚打完"时开口。开着时模型还会判断每一帧有没有新发生的事
   * ——刚击杀、刚买到装备、血量见底——有就交给她。
   */
  midMatch: boolean

  /** 一次连续游戏里最多看几次。0 = 不限。 */
  maxLooksPerSession: number

  /** 视觉模型端点，OpenAI 兼容。 */
  baseUrl: string

  /** 视觉模型名。空 = 看画面不可用。 */
  model: string

  maxTokens: number

  /** 单次抓图或读图的时限。 */
  timeoutMs: number

  /** 送模型前把截图缩到这个宽度以内。越小越省。 */
  maxWidth: number

  /**
   * 只看哪个窗口：进程名（如 escapefromtarkov），空 = 跟随正在玩的那个游戏进程。
   * 控制台会把它渲染成"当前可见窗口"的下拉列表。
   */
  target: string

  /** 更精确的窗口匹配：标题里包含这个关键字（可选，配合 target 用）。 */
  targetTitle: string

  /** 一次看画面连抓几帧拼成分镜。1 = 单帧（老行为），4 左右最合适。 */
  framesPerLook: number

  /** 连抓多帧时的帧间隔（毫秒）。 */
  frameIntervalMs: number

  /** 视觉模型密钥明文；留空就用部署 .env 里的密钥（Coo 用户可在这里直接填）。 */
  apiKey: string

  /** 新开一局时自动搜一次这个游戏的资料。 */
  learnOnStart: boolean
}

/** 看图工具耐久度：余额查询与预警。 */
export interface BalanceConfigSection {
  enabled: boolean
  /** 余额接口（DeepSeek 官方 /user/balance）。 */
  baseUrl: string
  /** 余额查询密钥明文；留空就用视觉模型那把。 */
  apiKey: string
  /** 多久查一次（分钟）。 */
  checkEveryMin: number
  /** 预警线：余额低于这个数（币种单位）就开始提醒。 */
  warnBelow: number
  /** 耐久度满格对应的余额；0 = warnBelow × 5。 */
  fullBalance: number
  /** 提醒文案模板，可用 {durability} {balance} {below} {currency}。 */
  warnText: string
  /** 两次预警之间至少隔多少小时。 */
  cooldownHours: number
}

export const BALANCE_DEFAULTS: BalanceConfigSection = {
  enabled: true,
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  checkEveryMin: 30,
  warnBelow: 10,
  fullBalance: 0,
  warnText: '看图工具耐久度掉到 {durability}% 了（余额 {balance} {currency}，预警线 {below}）。接下来看画面要省着点，顺口跟他说一句。',
  cooldownHours: 12,
}

/** 视觉模型密钥的存放名，与识图共用同一个。 */
export const GAMING_SECRETS = { vision: 'OPENROUTER_API_KEY' } as const

export const GAMING_WATCH_DEFAULTS: GamingWatchConfig = {
  enabled: false,
  everySec: 90,
  speakGapSec: 180,
  midMatch: true,
  maxLooksPerSession: 0,
  baseUrl: 'https://api.openai.com',
  model: '',
  maxTokens: 400,
  timeoutMs: 30000,
  maxWidth: 1024,
  target: '',
  targetTitle: '',
  framesPerLook: 4,
  frameIntervalMs: 800,
  apiKey: '',
  learnOnStart: true,
}

export const GAMING_DEFAULTS: GamingConfigSection = {
  enabled: false,
  games: [],
  simple: { ...SIMPLE_GAMES_DEFAULTS },
  knownGamesOnly: true,
  nonGameProcesses: [],
  pollMs: 2000,
  awayMinutes: 8,
  longSessionMinutes: 120,
  lateNightStartHour: 1,
  lateNightEndHour: 5,
  eventKeep: 40,

  reachOut: true,
  reachMinGapMinutes: 12,
  reachMaxPerDay: 0,
  freshSessionAfterHours: 4,

  watch: { ...GAMING_WATCH_DEFAULTS },
  balance: { ...BALANCE_DEFAULTS },
}

/**
 * 快速配置组：控制台里排在最前面。
 * 窗口选择 + 游戏库 6 格，配一个教程；改完重启生效（游戏库在启动时合并）。
 */
export const GAMING_QUICK_CONFIG_GROUP: ConfigGroup = {
  id: 'world:gaming:quick',
  owner: 'world:gaming',
  schema: {
    type: 'object',
    title: '① 快速配置：看哪个窗口 + 游戏库',
    description:
      '先配这两块，游戏库认不认得出来全看这里。\n'
      + '1) 「只看这个窗口」：下拉里选一个当前开着的窗口，她只抓这个窗口的画面；留空就跟随正在玩的那个游戏进程。'
      + '如果游戏窗口不在下拉里，把游戏打开再刷新控制台。\n'
      + '2) 游戏库：6 个格子，一行一个游戏，格式「进程名 | 显示名 | 别名,别名 | 看什么」。'
      + '进程名必填（任务管理器里 .exe 去掉后缀，小写）；显示名是给你看的；别名是标题里可能出现的词；'
      + '看什么会写进提示词，比如「这局活着出来没、带出多少」。\n'
      + '例子：escapefromtarkov | 逃离塔科夫 | 塔科夫,Tarkov | 这局活着出来没、带出多少\n'
      + '也可以在聊天里让 AI 用 gaming_library 工具加/删游戏；改完重启进程生效。',
    properties: {
      'worlds.gaming.watch.target': {
        type: 'string',
        title: '只看这个窗口（进程名）',
        enum: [],
        'x-hot': false,
        description: '下拉里选一个当前可见窗口的进程名；留空 = 跟随正在玩的游戏进程。',
      },
      'worlds.gaming.watch.targetTitle': {
        type: 'string',
        title: '窗口标题关键字（可选）',
        'x-hot': false,
        description: '进程名对不上时用：标题里包含这个词才认。',
      },
      'worlds.gaming.simple.slot1': { type: 'string', title: '游戏库 1', 'x-hot': false, description: '进程名 | 显示名 | 别名,别名 | 看什么（进程名必填）' },
      'worlds.gaming.simple.slot2': { type: 'string', title: '游戏库 2', 'x-hot': false, description: '同上；留空就是不用这个格子。' },
      'worlds.gaming.simple.slot3': { type: 'string', title: '游戏库 3', 'x-hot': false, description: '同上。' },
      'worlds.gaming.simple.slot4': { type: 'string', title: '游戏库 4', 'x-hot': false, description: '同上。' },
      'worlds.gaming.simple.slot5': { type: 'string', title: '游戏库 5', 'x-hot': false, description: '同上。' },
      'worlds.gaming.simple.slot6': { type: 'string', title: '游戏库 6', 'x-hot': false, description: '同上。' },
    },
  },
}

export const GAMING_CONFIG_GROUP: ConfigGroup = {
  id: 'world:gaming',
  owner: 'world:gaming',
  schema: {
    type: 'object',
    title: '陪玩',
    description: '看你在玩什么游戏，偶尔搭一句。只认游戏库里列的游戏。改动热生效。',
    properties: {
      'worlds.gaming.knownGamesOnly': {
        type: 'boolean',
        title: '只认游戏库里的游戏',
        'x-hot': true,
        description: '开着时，游戏库里没有就说"没在玩"，行为可预测。'
          + '关掉的话任何有标题的窗口都算游戏——浏览器、加速器、聊天窗口都会被她当成游戏，'
          + '她会一句句说错话。建议一直开着。',
      },
      'worlds.gaming.reachOut': {
        type: 'boolean',
        title: '主动搭话',
        'x-hot': true,
        description: '开着她会在开局、换游戏、玩太久、深夜还在玩的时候说一句。关掉就只在你找她时接得上。',
      },
      'worlds.gaming.reachMinGapMinutes': {
        type: 'integer',
        title: '两次主动至少隔',
        minimum: 1,
        maximum: 240,
        'x-suffix': '分钟',
        'x-hot': true,
        description: '别设太大——陪伴感来自"她在旁边看着"。约束主要靠不重复，不靠硬压间隔。',
      },
      'worlds.gaming.reachMaxPerDay': {
        type: 'integer',
        title: '一天最多主动几次',
        minimum: 0,
        maximum: 100,
        'x-suffix': '次',
        'x-hot': true,
        description: '0 = 不限。',
      },
      'worlds.gaming.longSessionMinutes': {
        type: 'integer',
        title: '连着玩多久算久',
        minimum: 30,
        maximum: 600,
        'x-suffix': '分钟',
        'x-hot': true,
        description: '每跨越一次这个数，她会提一句该歇歇了。',
      },
      'worlds.gaming.lateNightStartHour': {
        type: 'integer',
        title: '深夜从几点开始',
        minimum: 0,
        maximum: 23,
        'x-suffix': '点',
        'x-hot': true,
        description: '深夜还在玩会提一句。默认 1 点（到 5 点）。',
      },
      'worlds.gaming.lateNightEndHour': {
        type: 'integer',
        title: '深夜到几点结束',
        minimum: 0,
        maximum: 23,
        'x-suffix': '点',
        'x-hot': true,
        description: '比起始小表示跨午夜（1 → 5 就是凌晨一点到五点）。',
      },
      'worlds.gaming.awayMinutes': {
        type: 'integer',
        title: '切出去多久算不玩了',
        minimum: 1,
        maximum: 60,
        'x-suffix': '分钟',
        'x-hot': true,
        description: '短暂切出去看攻略不算结束，不然"这一局玩了多久"会碎成一片。',
      },
      'worlds.gaming.pollMs': {
        type: 'integer',
        title: '多久采一次',
        minimum: 500,
        maximum: 30000,
        'x-suffix': '毫秒',
        'x-hot': true,
        description: '切窗口没那么勤，太快没必要。',
      },
      'worlds.gaming.watch.enabled': {
        type: 'boolean',
        title: '看他的画面',
        'x-hot': true,
        // x-quick 让这一项出现在控制台首页的开关块；官方 cortico 的类型里还没有这个提示，
        // 用展开写法保住运行时字段，认它的控制台照常显示。
        ...({ 'x-quick': true } as Record<string, unknown>),
        description: '抓游戏窗口交给视觉模型读，读出"一局刚打完"就交给她。每次都要调用模型，开着有费用。',
      },
      'worlds.gaming.watch.everySec': {
        type: 'integer',
        title: '隔多久看一眼',
        minimum: 30,
        maximum: 900,
        'x-suffix': '秒',
        'x-hot': true,
        description: '抽帧，看到的不是连续过程。结算画面会挂一阵，90 秒够看到。',
      },
      'worlds.gaming.watch.speakGapSec': {
        type: 'integer',
        title: '两次开口至少隔',
        minimum: 30,
        maximum: 1800,
        'x-suffix': '秒',
        'x-hot': true,
        description: '结算画面会连着被看到好几次，间隔太短她会把同一局报成好几局。',
      },
      'worlds.gaming.watch.midMatch': {
        type: 'boolean',
        title: '局中也插话',
        'x-hot': true,
        description: '关掉就只在"一局刚打完"时开口。开着时刚击杀、刚买到装备、血量见底这类新事也会交给她。',
      },
      'worlds.gaming.watch.maxLooksPerSession': {
        type: 'integer',
        title: '一次游戏最多看几次',
        minimum: 0,
        maximum: 500,
        'x-suffix': '次',
        'x-hot': true,
        description: '0 = 不限。',
      },
      'worlds.gaming.watch.model': {
        type: 'string',
        title: '视觉模型',
        'x-hot': true,
        description: '空 = 看画面不可用。密钥用识图那把。',
      },
      'worlds.gaming.watch.baseUrl': {
        type: 'string',
        title: '视觉模型端点',
        'x-hot': true,
        description: 'OpenAI 兼容的 /chat/completions。',
      },
      'worlds.gaming.watch.maxWidth': {
        type: 'integer',
        title: '截图缩到多宽',
        minimum: 256,
        maximum: 2560,
        'x-suffix': '像素',
        'x-hot': true,
        description: '送模型前缩到这个宽度以内。越小越省。',
      },
      'worlds.gaming.watch.framesPerLook': {
        type: 'integer',
        title: '一次看几帧',
        minimum: 1,
        maximum: 9,
        'x-suffix': '帧',
        'x-hot': true,
        description: '连抓几帧拼成一张分镜再交给视觉模型。1 = 老的单帧。',
      },
      'worlds.gaming.watch.frameIntervalMs': {
        type: 'integer',
        title: '帧间隔',
        minimum: 0,
        maximum: 5000,
        'x-suffix': '毫秒',
        'x-hot': true,
        description: '连抓多帧时的间隔。',
      },
      'worlds.gaming.watch.apiKey': {
        type: 'string',
        title: '视觉模型密钥',
        'x-hot': true,
        description: '留空就用部署 .env 里的密钥；Coo 用户可以在这里直接填。',
      },
      'worlds.gaming.watch.learnOnStart': {
        type: 'boolean',
        title: '开新游戏时自动搜资料',
        'x-hot': true,
        description: '每次开始玩一个新游戏，后台搜一次它的术语/玩法/报点，交给模型参考。',
      },
      'worlds.gaming.balance.enabled': {
        type: 'boolean',
        title: '查余额（看图工具耐久度）',
        'x-hot': false,
        description: '定期查 DeepSeek 余额，低了会提醒她省着看画面。改完需重启。',
      },
      'worlds.gaming.balance.baseUrl': {
        type: 'string',
        title: '余额接口',
        'x-hot': false,
        description: 'DeepSeek 官方余额接口，默认 https://api.deepseek.com。',
      },
      'worlds.gaming.balance.apiKey': {
        type: 'string',
        title: '余额查询密钥',
        'x-hot': false,
        description: '留空就用视觉模型那把密钥。Coo 用户可在这里直接填。',
      },
      'worlds.gaming.balance.checkEveryMin': {
        type: 'integer',
        title: '多久查一次余额',
        minimum: 5,
        maximum: 1440,
        'x-suffix': '分钟',
        'x-hot': false,
        description: '默认 30 分钟。',
      },
      'worlds.gaming.balance.warnBelow': {
        type: 'number',
        title: '余额预警线',
        minimum: 0,
        'x-hot': false,
        description: '余额低于这个数就提醒。耐久度按它换算（它对应 20%）。',
      },
      'worlds.gaming.balance.fullBalance': {
        type: 'number',
        title: '耐久度满格余额',
        minimum: 0,
        'x-hot': false,
        description: '多少余额算 100% 耐久度。0 = 预警线 × 5。',
      },
      'worlds.gaming.balance.warnText': {
        type: 'string',
        title: '预警文案',
        'x-hot': false,
        description: '可用占位符：{durability} {balance} {below} {currency}。这段会作为提醒内容交给她。',
      },
      'worlds.gaming.balance.cooldownHours': {
        type: 'integer',
        title: '两次预警至少隔',
        minimum: 1,
        maximum: 168,
        'x-suffix': '小时',
        'x-hot': false,
        description: '默认 12 小时，防止余额低时反复念。',
      },
    },
  },
}
