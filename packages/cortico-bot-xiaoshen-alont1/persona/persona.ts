/**
 * 文件式工作区 Persona：声明 session 与工具，装配前缀，管理心跳、上下文压力和交接。
 * memory.ts 提供存储，workspaceTools.ts 与 blobs.ts 提供工具，handoffNote.ts 渲染交接笔记。
 * protected 成员供变体继承，不属于公共 API。
 */
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSections, renderTemplate } from 'cortico/core/template.ts';
import { pick, type Language } from 'cortico/core/language.ts';
import { historyPanelDecl, workspaceInvoke, workspacePanelDecl } from './webUiSurface.ts';
import { HANDOFF_NOTE_TYPE, handoffNoteStamp, renderHandoffNote } from './handoffNote.ts';
import { SAVE_BLOB_DECL, saveBlobTool } from './blobs.ts';
import { BLOBS_DIR, GitWorkspaceMemory, normalizeWorkspacePath, type WorkspaceBlobStore } from './memory.ts';
import { WORKSPACE_TOOL_DECLS, workspaceTools } from './workspaceTools.ts';
import { countFold, dateRangeFold, listFold, renderWorkspaceListing, type ListingFold } from './workspaceListing.ts';
import { Heartbeat, quietLine } from './heartbeat.ts';
import { conversationPolicy, prioritySenders, type ConversationPolicy } from './conversation-policy.ts';
import { ConversationSources } from './conversation-sources.ts';
import { collectDialogueEvents, selectDialogue, type DialogueOptions } from './dialogue-recovery.ts';
import { repeatedQuestionEvidence } from './conversation-repetition.ts';
import { RecentLedger, RECENT_TOOL_DECLS, createRecentTools } from './recent-ledger.ts';
import type { ContextRecord, Item } from 'cortico/protocol/open-responses/context.ts';
import type {
  ContextHandoffResult,
  EventEnvelope,
  CoreApi,
  World,
  WorldLifecycleEvent,
  OutputTap,
  PersonaWebUiDecl,
  DescribeText,
  Persona,
  PrefixSegment,
  PromptDocDecl,
  SessionDecl,
  SessionOpeningReason,
  SystemPrefixContext,
  ToolDef,
  ToolTag,
} from 'cortico/core/types.ts';
// interrupt 要靠它判断"这一轮有没有已经外化的输出"；taps 没实现 externalizes 时用它兜底。
import { defaultExternalizes } from 'cortico/core/types.ts';

/** 默认的存在方式自述源文件;bot 不覆盖 orientation 时读它,控制台可编辑同一份。 */
/** 前缀装配模板与 World 段模板住在软件包里(跟着代码走),不在人格工作区。 */
export const CORE_DIR = dirname(fileURLToPath(import.meta.url));
export const CORMINI_ORIENTATION_FILE = join(CORE_DIR, 'ORIENTATION.md');

/**
 * 合成首轮对话(风格锚)三段的源文件名,住在部署目录的 `prompts/` 下。
 * 内容是部署者手写的私有文本,代码包不带默认;文件缺失或为空 = 不注入。
 */
export const FIRST_TURN_FILES = {
  user: 'FIRST_TURN_USER.md',
  thinking: 'FIRST_TURN_THINKING.md',
  reply: 'FIRST_TURN_REPLY.md',
} as const;

/** 控制台段名与可编辑源映射，不写入前缀。 */
const CORMINI_SEGMENT_TITLES: Record<string, string> = {
  'persona.orientation': 'ORIENTATION',
  'persona.constitution': 'CONSTITUTION',
  'persona.partner': 'PARTNER',
  'persona.memoryNote': 'MEMORY',
  'persona.recent': 'RECENT',
  'persona.workspace': 'WORKSPACE',
};

const CORMINI_SEGMENT_SOURCES: Record<string, string> = {
  'persona.orientation': 'orientation',
  'persona.constitution': 'constitution',
};

const CONSTITUTION_FILE = 'CONSTITUTION.md';
/**
 * 另一份常驻档：**近期**。与 MEMORY.md 分开是为了让两份都能守住"每轮都用得上"这条线——
 * 长期那份装人、分寸、偏好（变得慢），这份装这几天的事和还没做完的（变得快）。
 * 挤在一个文件里，快的会把慢的挤出去，而两份都每轮重发，一起变胖就是每个请求都变贵。
 */
const RECENT_FILE = 'RECENT.md';
/**
 * 写入只读机制说明时的拒绝理由。理由里带上"该往哪写":她多半是想记一条规矩,
 * 而规矩该落在工作区那两份常驻档里,不是落在这份随版本走的说明上。
 */
const CORE_RULES_READONLY = 'CORE.md 是随软件版本走的机制说明,只读;要记自己的规矩写 CONSTITUTION.md 或 MEMORY.md。';
/**
 * 小家族在前缀清单里最多列几个名字。超过就退回件数——名字从"信息"变成"占地"的
 * 那条线,按行数估的:一屏名字读起来就不再是"我知道有什么",而是"我在翻目录"。
 */
const SMALL_FAMILY_NAMES = 12;
/** 主 session 声明 id(子类的 sessionInfo 查询也用它) */
export const MAIN = 'main';
/** 交接笔记目录:每次交接一份,文件名是 UTC 时间戳(见 handoffNoteStamp) */
export const HANDOFF_DIR = 'handoffs/';

/** `end_turn` 的声明;自描述要列出全部工具,所以与实现分开。 */
export const END_TURN_DECL: Omit<ToolDef, 'handler'> = {
  name: 'end_turn',
  description:
    'End this turn: nothing more you want to say or do right now. ' +
    'New events or the heartbeat will wake you again. ' +
    'This is the normal way to finish a turn — do not idle with empty actions.',
  tags: ['flow'],
  barrierAfter: true,
  endsTurn: true,
  parameters: { type: 'object', properties: {}, required: [] },
};

/** Cormini 自有工具的声明:文件工具、`save_blob` 与 `end_turn`;变体在其上追加自己的。 */
export const CORMINI_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  ...WORKSPACE_TOOL_DECLS,
  SAVE_BLOB_DECL,
  ...RECENT_TOOL_DECLS,
  END_TURN_DECL,
];

/** Cormini 自有工具给人看的一句话,进 bot 的自描述。 */
export const CORMINI_TOOL_SUMMARIES: Readonly<Record<string, DescribeText>> = {
  read_file: { zh: '读工作区里的一个文件,可以只读一段行。', en: 'Reads a workspace file, whole or a range of lines.' },
  write_file: { zh: '新建或整份重写工作区里的一个文件。', en: 'Creates or fully rewrites a workspace file.' },
  edit_file: { zh: '把文件里一段原文换成新文字,其余不动。', en: 'Replaces one exact passage in a file and leaves the rest as is.' },
  append_file: { zh: '在文件末尾追加文字,文件不存在就新建。', en: 'Appends text to the end of a file, creating it if missing.' },
  delete_file: { zh: '删除工作区里的一个文件;进系统前缀的文件不能删。', en: 'Deletes a workspace file; files in the system prefix cannot be deleted.' },
  list_files: { zh: '列出工作区里的文件,点名的目录列全。', en: 'Lists workspace files; a named directory is listed in full.' },
  glob_files: { zh: '按文件名模式找文件,最近改过的在前。', en: 'Finds files by name pattern, most recently modified first.' },
  grep_files: { zh: '用正则搜工作区文件的内容。', en: 'Searches workspace file contents with a regular expression.' },
  save_blob: {
    zh: '把看到过的图片等二进制附件存进工作区,换来长期可用的句柄。',
    en: 'Saves an image or other binary attachment it has seen into the workspace and gets a lasting handle.',
  },
  end_turn: { zh: '结束这一轮,等新事件或心跳再醒。', en: 'Ends the turn until a new event or the heartbeat wakes the bot.' },
  recent_append: { zh: '保存带来源的逐字引用或待核笔记；日期来自原始消息。', en: 'Records a source quote or pending note, using the source date.' },
  recent_read: { zh: '读取近期台账；区分来源匹配、待核及旧的无来源记录。', en: 'Reads recent records with source status and unsourced legacy notes.' },
};

/**
 * 显式结束本次唤醒的 yield 工具，仅挂在主 session。fork 以最后一段文本作为返回值，不挂终止工具。
 */
export function endTurnTool(): ToolDef {
  return {
    ...END_TURN_DECL,
    handler: async () => '[turn ended]',
  };
}

/** 阶段预算、软阈值比例和交接笔记预算比例。 */
export interface ContextStagePolicy {
  maxTokens: number;
  softRatio: number;
  keepRatio: number;
  /** 是否把部署 prompts/ 里的首轮对话作为合成开头送进请求;内容为空时不送。 */
  firstTurn: boolean;
}

export const CORMINI_CONTEXT_DEFAULTS: ContextStagePolicy = { maxTokens: 64000, softRatio: 0.85, keepRatio: 1 / 3, firstTurn: false };

export interface CorminiOptions {
  /** 工作区目录 = 记忆。不存在则创建。 */
  memoryDir: string;
  /** 上下文阶段裁量。每次现读,控制台改了即生效;不给=CORMINI_CONTEXT_DEFAULTS。 */
  context?: () => ContextStagePolicy;
  /** Persona-owned dialogue recovery and provenance limits, read on each use. */
  handoff?: () => Partial<ConversationPolicy>;
  /**
   * 工作区还没有宪法时写进去的初始文本(出厂内容)。
   * 只在首次创建时用一次;之后这份文件归 bot 与运维,种子不再覆盖它。
   */
  seedConstitution?: string;
  /** 单次唤醒的工具循环上限 */
  rounds?: { soft: number; hard: number };
  /**
   * 已挂载 World。工具表由Persona声明(schema/handler 归人格),
   * core 只按可见性摘掉隐藏 World 的那些名字。
   */
  worlds?: World[];
  /**
   * 覆盖默认的存在方式自述(direct 投递的分叉换成直投口径)。不给=读
   * orientationFile。传函数则每次拼系统前缀时重取——源文件在控制台
   * 改过后,重载前缀即生效。
   */
  orientation?: string | (() => string);
  /**
   * 存在方式自述的源文件。Persona把它自报为可编辑的静态前缀源(Persona卡
   * 与「设置 → 静态前缀」共用同一份);不给=包内默认 CORMINI_ORIENTATION_FILE。
   * 没给 orientation 覆盖时,前缀也从它现读。
   */
  orientationFile?: string;
  /**
   * 这份自述在**部署侧**的覆盖文件。存在就用它(前缀与控制台读同一份),不存在则用
   * 包里那份;控制台保存一律写到这里——部署者微调出来的提示词是私有资产,不进代码包。
   */
  orientationOverrideFile?: string;
  /**
   * 首轮对话(风格锚)三份源文件所在目录,即这份部署的 `prompts/`。
   * 不给 = 这个Persona没有首轮对话(不注入,控制台也不列源)。
   */
  firstTurnDir?: string;
  /**
   * 心跳基线:距下次主动 tick 的毫秒数,null=现在不心跳。不给=从不心跳,
   * 纯被动人格。连着空拍时基线逐次翻倍(见 heartbeat.ts);World 要更密的
   * 唤醒就自己投 flush 事件。
   */
  tickDelayMs?: (now: Date) => number | null;
  /** save_blob 不带目录的名字提示落进哪个工作区子目录。不给=blobs/。 */
  blobsDir?: string;
}

/** 控制台文案,两种语言各一张表;`en: typeof zh` 由 tsc 保证键集一致。 */
const CONSOLE_TEXT = {
  zh: {
    orientation: 'Persona的存在方式与元认知说明。',
    constitution: 'Persona 的长期原则。重载系统前缀或开始新上下文后生效。',
    memoryNote: '记忆约定:她的档案怎么存、什么时候会自动浮现。',
    recent: '近期来源台账：前缀只展示状态，逐字引用与待核正文通过 recent_read 查看。',
    workspaceLabel: '工作区(她自己写的记忆文件)',
    workspaceNote: '删除宪法之外的可见工作区文件；对话缓存与台账由独立存储项清除，隐藏检查点不动',
    workspaceStat: (n: number) => `${n}个文件(宪法之外)`,
    workspaceCleared: (n: number) => `已删除 ${n} 个工作区文件;宪法未动`,
    firstTurnUser: '首轮·用户输入',
    firstTurnUserDesc: '合成首轮对话的 user 消息。与回复任一为空则整轮不注入。',
    firstTurnThinking: '首轮·思维链',
    firstTurnThinkingDesc: '合成首轮 assistant 的思维链(reasoning_content);为空则该轮不带。注:openai-responses-compat 方言不回传思维链,这段在该类端点上不出线。',
    firstTurnReply: '首轮·回复',
    firstTurnReplyDesc: '合成首轮对话的 assistant 回复正文。',
  },
  en: {
    orientation: 'How the Persona exists and its metacognition notes.',
    constitution: 'The Persona\'s long-term principles. Changes take effect after a system prefix reload or when a new context starts.',
    memoryNote: 'Memory conventions: how her files are stored and when they surface on their own.',
    recent: 'Recent source ledger: only status enters the prefix. Read quotes and pending notes with recent_read.',
    workspaceLabel: 'Workspace (memory files she wrote herself)',
    workspaceNote: 'Deletes visible workspace files except the constitution. Conversation sources and ledger have a separate storage item; hidden checkpoints stay.',
    workspaceStat: (n: number) => `${n} file${n === 1 ? '' : 's'} (besides the constitution)`,
    workspaceCleared: (n: number) => `Deleted ${n} workspace file${n === 1 ? '' : 's'}; the constitution is untouched`,
    firstTurnUser: 'First turn · user input',
    firstTurnUserDesc: 'The user message of the synthesized first turn. When either this or the reply is empty, the whole turn is not injected.',
    firstTurnThinking: 'First turn · reasoning',
    firstTurnThinkingDesc: 'The reasoning (reasoning_content) of the synthesized first assistant turn; empty = the turn carries none. The openai-responses-compat dialect does not return reasoning, so this part never goes on the wire for such endpoints.',
    firstTurnReply: 'First turn · reply',
    firstTurnReplyDesc: 'The assistant reply text of the synthesized first turn.',
  },
};

export class Cormini implements Persona {
  readonly memoryDir: string;
  protected readonly caps: { soft: number; hard: number };
  /** 挂载表的活引用(装配层与 core 共用);用时按 id 排序,顺序决定前缀缓存命中。 */
  private readonly worlds: World[];
  private readonly orientationFile: string;
  private readonly orientationOverrideFile: string | null;
  protected readonly firstTurnDir: string | null;
  private readonly orientation: () => string;
  private readonly heartbeat: Heartbeat;
  protected core: CoreApi | null = null;
  protected readonly context: () => ContextStagePolicy;
  private readonly conversationSettings: () => ConversationPolicy;
  private readonly conversationSources: ConversationSources;
  private readonly recentLedger: RecentLedger;
  private readonly restoredSources = new Set<string>();
  private sourceWarning: string | null = null;
  /** 软压力速记提醒已注入(交接时重置) */
  protected pressureWarned = false;
  /** 本批有人直接对着她说话；`onTurnWouldEnd` 据此决定要不要催她动手。 */
  protected batchNeedsReply = false;
  /** 软阈值那一刻(epoch ms);null=这一窗还没越过软阈值。交接后重置 */
  protected pressureWarnedAt: number | null = null;
  /** 最近一份交接笔记的工作区路径;醒来那句话用它指路 */
  protected lastHandoffFile: string | null = null;
  readonly memory: GitWorkspaceMemory;
  /** 工作区二进制附件；mem: 句柄保存相对路径。 */
  readonly blobs: WorkspaceBlobStore;

  constructor(opts: CorminiOptions) {
    this.memory = new GitWorkspaceMemory({
      memoryDir: opts.memoryDir,
      ...(opts.blobsDir !== undefined ? { blobsDir: opts.blobsDir } : {}),
      // attach 前使用 console；闭包在调用时选择当前日志入口。
      warn: (msg, data) => {
        if (this.core) this.core.log.warn(msg, data);
        else console.warn(`[workspaceGit] ${msg}`, data ?? '');
      },
    });
    this.memoryDir = this.memory.memoryDir;
    this.blobs = this.memory.blobs;
    this.context = opts.context ?? ((): ContextStagePolicy => CORMINI_CONTEXT_DEFAULTS);
    this.conversationSettings = () => conversationPolicy(opts.handoff?.());
    this.conversationSources = new ConversationSources(this.memoryDir, this.conversationSettings);
    this.recentLedger = new RecentLedger({ memoryDir: this.memoryDir, resolveSource: cursor => this.conversationSources.get(cursor) });
    this.caps = opts.rounds ?? { soft: 6, hard: 12 };
    this.orientationFile = opts.orientationFile ?? CORMINI_ORIENTATION_FILE;
    this.orientationOverrideFile = opts.orientationOverrideFile ?? null;
    this.firstTurnDir = opts.firstTurnDir ?? null;
    const orientation = opts.orientation;
    this.orientation = typeof orientation === 'function'
      ? orientation
      : () => orientation ?? readFileSync(this.orientationSource(), 'utf8').trim();
    this.worlds = opts.worlds ?? [];
    const baseline = opts.tickDelayMs ?? ((): null => null);
    this.heartbeat = new Heartbeat(
      baseline,
      () => {
        // 心跳文本在投递时按当前安静时长生成，并以同一文本入库。
        this.core?.injectDeferred('tick', () => this.tickText(this.heartbeat.quietSeconds()));
      },
    );
    this.memory.seed([[
      CONSTITUTION_FILE,
      opts.seedConstitution ?? '# Who I am\n\n(Write here, or let the bot write here.)\n',
    ]]);
  }

  attach(core: CoreApi): void {
    this.core = core;
  }

  /**
   * 心跳那一行的文本(投递刻渲染);变体覆写(如带上时刻)。
   *
   * 除了全局安静时长,还报**各群安静了多久**——全局那个数被 Minecraft 之类
   * 一直在刷的 World 压到几秒,靠它判断不了"这个群多久没人说话了"。
   * 她在主场群的规矩是"安静超过二十分钟就自己起个话头",那需要一个能读到的读数。
   */
  protected tickText(quietSeconds: number): string {
    // 空闲时没有外部事件，onDelivery 那条 notice 不会触发，所以钟点得在这里也报一次。
    // 这也是 framework 原作者给变体留的口子（见上面那句注释）。
    const base = `${quietLine(quietSeconds)}现在是 ${this.clockStamp()}。`;
    const groups = this.quietGroupLine();
    return groups ? `${base}${groups}` : base;
  }

  /**
   * 「主场群各安静了多久」那一行;没有可报的群就返回空串。
   *
   * 只问带群概念的那个 World,且只问参与度 0.5 以上的群。
   * `qq` 是内建那个、`qqbot` 是扩展那个,同时只有一个在跑;
   * 两个都挂着时**先问真正在读消息的那个**(取不到读数的会抛,或者给空数组)。
   * 全都取不到就静默省略——心跳不该因为某个 World 没挂上而报错。
   */
  private quietGroupLine(): string {
    const worlds = this.worlds.filter((w) => w.id === 'qqbot' || w.id === 'qq') as Array<{
      quietByConversation?: (minActive: number) => Array<{ label: string; quietMinutes: number | null }>;
    }>;
    for (const world of worlds) {
      if (typeof world.quietByConversation !== 'function') continue;
      let rows: Array<{ label: string; quietMinutes: number | null }>;
      try {
        rows = world.quietByConversation(0.5);
      } catch {
        continue; // 这个 World 答不上来就换下一个
      }
      const parts = rows
        .filter((r) => r.quietMinutes !== null)
        .slice(0, 3)
        .map((r) => `${r.label} 安静 ${r.quietMinutes} 分钟`);
      if (parts.length) return ` 群里：${parts.join('、')}。`;
    }
    return '';
  }

  /** 此刻该读哪份自述:部署侧有覆盖就是它,否则是包里那份。 */
  protected orientationSource(): string {
    return this.orientationOverrideFile && existsSync(this.orientationOverrideFile)
      ? this.orientationOverrideFile
      : this.orientationFile;
  }

  /** 按界面语言声明控制台文案；源 key、路径与清除动作保持一致。 */
  webUi(language: Language = 'zh'): PersonaWebUiDecl {
    const t = pick(language, CONSOLE_TEXT);
    return {
      promptDocs: [
        {
          key: 'orientation',
          title: 'ORIENTATION',
          description: t.orientation,
          path: this.orientationSource(),
          ...(this.orientationOverrideFile ? { deploymentPath: this.orientationOverrideFile } : {}),
        },
        {
          key: 'constitution',
          title: 'CONSTITUTION',
          description: t.constitution,
          path: join(this.memoryDir, CONSTITUTION_FILE),
        },
        ...(this.memoryNoteFile()
          ? [{
              key: 'memoryNote',
              title: 'MEMORY',
              description: t.memoryNote,
              path: this.memoryNoteFile() as string,
            }]
          : []),
        ...(this.recentNoteFile()
          ? [{
              key: 'recent',
              title: 'RECENT',
              description: t.recent,
              path: this.recentNoteFile() as string,
            }]
          : []),
        ...this.firstTurnDocs(language),
      ],
      memory: {
        panels: [workspacePanelDecl(language), historyPanelDecl(language)],
        // 工作区记忆跨场保留，但属于“清除所有数据”的范围。宪法由人格检查点管理，不随数据清除。
        storage: [
          {
            key: 'conversation-records',
            label: language === 'zh' ? '对话来源缓存与近期台账' : 'Conversation sources and recent ledger',
            kind: 'disk', location: 'workspace/.persona/', danger: true,
            note: language === 'zh' ? '清除来源缓存与新台账；旧 RECENT 不由此项删除。后续新事件会重新记录。' : 'Clears the source cache and ledger, preserving legacy RECENT. New events are recorded afterward.',
            stat: () => this.recentLedger.prefixStatus(),
            clear: () => {
              this.recentLedger.clear();
              this.conversationSources.clear();
              this.restoredSources.clear();
              return language === 'zh' ? '已清除对话来源缓存与近期台账。' : 'Conversation sources and ledger cleared.';
            },
          },
          {
            key: 'workspace',
            label: t.workspaceLabel,
            kind: 'disk',
            location: 'workspace/',
            danger: true,
            note: t.workspaceNote,
            stat: () => t.workspaceStat(this.workspaceFiles().length),
            clear: () => {
              const files = this.workspaceFiles();
              for (const f of files) rmSync(join(this.memoryDir, f), { force: true });
              return t.workspaceCleared(files.length);
            },
          },
        ],
      },
      invoke: workspaceInvoke(this.memory, language),
    };
  }

  /** 工作区里可清除的文件:宪法之外的全部(walk 本就跳过点开头,.git 不在其中) */
  private workspaceFiles(): string[] {
    return this.memory.walkFiles().filter((f) => f !== CONSTITUTION_FILE);
  }

  startRhythm(): void {
    this.heartbeat.start();
  }

  stopRhythm(): void {
    this.heartbeat.stop();
  }


  /**
   * 前缀 = 一份顶层装配模板 + 若干段模板,全部可编辑。段的数量、顺序、标题与
   * 分隔样式都在 `PREFIX.md` 里,代码只负责把值算出来。
   */
  async systemSegments(ctx: SystemPrefixContext): Promise<PrefixSegment[]> {
    // 记下时区给投递 notice 报钟点用（core 的 PersonaCoreApi 不暴露 timezone）。
    if (ctx.timezone) this.clockTz = ctx.timezone;
    // 每个 World 独占前缀段,使可见性变更保持原子性;段的外壳套同一份模板。
    const envSection = readFileSync(this.templateFile('ENV_SECTION.md'), 'utf8');
    const moduleSections = ctx.worlds
      .filter((m) => m.envPrompt.trim())
      .map((m) => ({
        id: m.id,
        sourceKey: m.sourceKey,
        text: renderTemplate(envSection, {
          'world.id': m.id,
          'world.envPrompt': m.envPrompt.trim(),
        }).trimEnd(),
      }));

    const rendered = renderSections(readFileSync(this.templateFile('PREFIX.md'), 'utf8'), {
      ...this.prefixVars(ctx),
      'worlds.envPrompts': moduleSections.map((s) => s.text).join('\n'),
    });

    const sources = this.segmentSources();
    const titles = this.segmentTitles();

    return rendered.sections.flatMap((section): PrefixSegment[] => {
      if (section.name !== 'worlds.envPrompts') {
        return [{
          title: titles[section.name] ?? section.name,
          text: section.text,
          ...(sources[section.name] ? { sourceKey: sources[section.name] } : {}),
        }];
      }
      if (moduleSections.length === 0) return [{ title: 'ENVIRONMENT(无)', text: section.text }];
      const joined = moduleSections.map((s) => s.text).join('\n');
      const lead = section.text.slice(0, section.text.length - joined.length);
      return moduleSections.map((s, i) => ({
        title: `ENVIRONMENT · ${s.id}`,
        text: (i === 0 ? lead : '\n') + s.text,
        ...(s.sourceKey ? { sourceKey: s.sourceKey } : {}),
      }));
    });
  }

  /** PREFIX.md、ENV_SECTION.md 等模板路径；变体可按文件名覆盖。 */
  protected templateFile(name: string): string {
    return join(CORE_DIR, name);
  }

  /**
   * 机制说明的源文件:讲这台机器怎么运转,不讲她是谁。
   *
   * 它住在代码包里而不是工作区,所以随软件版本走,写进去会被 writeGuard 拒;
   * read_file('CORE.md') 拿到的是这里的内容(见 readOverride),工作区里不必存在
   * 这个文件。人格与记忆的分界就在这条线上:能改的放工作区,该跟着版本走的放这里。
   */
  protected coreRulesFile(): string | null {
    const file = join(CORE_DIR, 'CORE.md');
    return existsSync(file) ? file : null;
  }

  /** 前缀模板各占位符的值(`worlds.envPrompts` 由 systemSegments 自己算);变体覆写成自己的那组。 */
  protected prefixVars(_ctx: SystemPrefixContext): Record<string, string> {
    return {
      'persona.orientation': this.orientation(),
      'persona.constitution': readFileSync(join(this.memoryDir, CONSTITUTION_FILE), 'utf8').trim(),
      'persona.partner': this.partnerDoc(),
      'persona.memoryNote': this.memoryNote(),
      'persona.recent': this.recentNote(),
      'persona.coreRules': this.coreRulesText(),
      'persona.workspace': this.prefixWorkspaceListing(),
    };
  }

  /** 机制说明的正文;没有这份文件时给空串,模板的缺省分支接住。 */
  protected coreRulesText(): string {
    const file = this.coreRulesFile();
    return file ? readFileSync(file, 'utf8').trim() : '';
  }

  /** 段名 → 控制台标签(不进前缀)。 */
  protected segmentTitles(): Record<string, string> {
    return { ...CORMINI_SEGMENT_TITLES, 'persona.coreRules': 'CORE' };
  }

  /** 段名 → 可编辑源的 promptDoc key。记忆段有源可指只在变体给了模板文件时成立。 */
  protected segmentSources(): Record<string, string> {
    return {
      ...CORMINI_SEGMENT_SOURCES,
      ...(this.memoryNoteFile() ? { 'persona.memoryNote': 'memoryNote' } : {}),
      ...(this.recentNoteFile() ? { 'persona.recent': 'recent' } : {}),
    };
  }

  /**
   * 记忆约定说明的源文件(CortiV 的观众档案约定);基类没有这一段,返回 null
   * 走模板缺省。给了路径就自动成为一份可编辑的 promptDoc,段能指回源。
   */
  protected memoryNoteFile(): string | null {
    // 让 MEMORY 段注入工作区里的 MEMORY.md：她对自己的记忆不需要「想起来去读」，
    // 那几行本来就在眼前。文件由她自己维护（write_file / edit_file），
    // 所以内容要短——它每次请求都在前缀里。
    const file = join(this.memoryDir, 'MEMORY.md');
    return existsSync(file) ? file : null;
  }

  /**
   * 搭档主档的源文件(一对一关系记忆,如 CortiV 的 PHANT.md);基类没有这一段,
   * 返回 null 展开成空串。文件通常住工作区(她与梦都会改),所以读取要容错:
   * 「清除所有数据」会把它删掉,前缀装配不能因此炸掉。
   */
  protected partnerDocFile(): string | null {
    return null;
  }

  /** 前缀 PARTNER 段此刻的文本;现读,编辑即生效(与 ORIENTATION 同)。 */
  protected partnerDoc(): string {
    const file = this.partnerDocFile();
    if (!file) return '';
    try {
      return readFileSync(file, 'utf8').trim();
    } catch {
      return '';
    }
  }

  /** 前缀 MEMORY 段此刻的文本;现读,编辑即生效(与 ORIENTATION 同)。 */
  protected memoryNote(): string {
    const file = this.memoryNoteFile();
    return file ? readFileSync(file, 'utf8').trim() : '';
  }

  /**
   * 第二份常驻档的源文件。和 MEMORY.md 同样处理：她自己维护、每轮现读、
   * 文件不在就返回空（模板的 `|` 缺省文案接手）。
   */
  protected recentNoteFile(): string | null {
    // Legacy text is external evidence, not an editable system-prompt source.
    return null;
  }

  /** 前缀 RECENT 段此刻的文本;现读,编辑即生效。 */
  protected recentNote(): string {
    return this.recentLedger.prefixStatus();
  }

  /**
   * 合成开头 = 首轮对话(风格锚):三份源文件各一段,开关 context.firstTurn。user 或 reply
   * 为空白时整轮不送,文件缺失当空。item id 固定:内容不变时每次请求的前缀逐字相同。
   */
  sessionHead(): Item[] {
    const dir = this.firstTurnDir;
    if (!dir || !this.context().firstTurn) return [];
    const read = (name: string): string => {
      try {
        return readFileSync(join(dir, name), 'utf8').trim();
      } catch {
        return '';
      }
    };
    const user = read(FIRST_TURN_FILES.user);
    const reply = read(FIRST_TURN_FILES.reply);
    if (!user || !reply) return [];
    const thinking = read(FIRST_TURN_FILES.thinking);
    const items: Item[] = [
      { type: 'message', id: 'msg_first_turn_user', status: 'completed', role: 'user', content: [{ type: 'input_text', text: user }] },
    ];
    if (thinking) items.push({ type: 'reasoning', id: 'rs_first_turn', summary: [], content: [{ type: 'reasoning_text', text: thinking }] });
    items.push({ type: 'message', id: 'msg_first_turn_reply', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: reply, annotations: [] }] });
    return items;
  }

  /** 首轮对话三份源文件的控制台声明(Persona 页提示词页签经 /api/prompts 读写)。 */
  protected firstTurnDocs(language: Language = 'zh'): PromptDocDecl[] {
    const dir = this.firstTurnDir;
    if (!dir) return [];
    const t = pick(language, CONSOLE_TEXT);
    return [
      {
        key: 'firstTurn.user',
        title: t.firstTurnUser,
        description: t.firstTurnUserDesc,
        path: join(dir, FIRST_TURN_FILES.user),
      },
      {
        key: 'firstTurn.thinking',
        title: t.firstTurnThinking,
        description: t.firstTurnThinkingDesc,
        path: join(dir, FIRST_TURN_FILES.thinking),
      },
      {
        key: 'firstTurn.reply',
        title: t.firstTurnReply,
        description: t.firstTurnReplyDesc,
        path: join(dir, FIRST_TURN_FILES.reply),
      },
    ];
  }

  /** 各模板占位符此刻的值(纯展示,控制台旁注用)。 */
  promptVarValues(_ctx?: { now: Date; timezone: string }): Record<string, string> {
    return {
      'persona.orientation': this.orientation(),
      'persona.constitution': readFileSync(join(this.memoryDir, CONSTITUTION_FILE), 'utf8').trim(),
      'persona.memoryNote': this.memoryNote(),
      'persona.recent': this.recentNote(),
      'persona.coreRules': this.coreRulesText(),
      'persona.workspace': this.prefixWorkspaceListing(),
    };
  }

  /**
   * 前缀里的工作区清单。大目录折叠为一行摘要(每场几十份交接笔记会撑爆缓存前缀);
   * list_files 指定目录时全量。清单怎么排由 workspaceListing.ts 决定,这里只喂数据;
   * 变体经 prefixFolds() 追加自己的折叠目录。
   */
  protected prefixWorkspaceListing(): string {
    return renderWorkspaceListing(this.memory.walkFiles(), this.prefixFolds());
  }

  /**
   * 清单里折叠为一行摘要的家族;变体覆写时先取 super 再追加。
   *
   * 顺序有意义:先命中的先算,所以更细的口子要写在更粗的前面
   * (`notes/playbook/` 在 `notes/` 前面),否则细的那条永远轮不到。
   * 折叠名单不长的家族(notes/)仍逐个列名——读的人要知道有什么可读;
   * 一天一份、只会越堆越多的家族(memories/)折成件数加日期跨度。
   */
  protected prefixFolds(): ListingFold[] {
    return [
      listFold('notes/', SMALL_FAMILY_NAMES, '要读就直接点名'),
      dateRangeFold('memories/', '按天流水,越靠后越新;'),
      {
        match: (path) => path.startsWith(HANDOFF_DIR),
        summary: (members) => `${HANDOFF_DIR} (${members.length} 份交接笔记;list_files 指定 dir 为 ${HANDOFF_DIR.replace(/\/$/, '')} 可列出全部)`,
      },
      countFold(BLOBS_DIR, '二进制,read_file 看图;'),
    ];
  }

  onOpening(ctx: { reason: SessionOpeningReason }): void {
    this.restoredSources.clear();
    const text = ctx.reason === 'restarted' ? '[system] 进程重启,session 已续上。' : '[system] session 已开始。';
    this.core?.injectInternal(text, 'opening');
    if (ctx.reason === 'restarted') this.recoverDialogue();
  }

  /** World 装卸与可见性变化只报一句;工具与环境提示词的增减随前缀重载自然体现。 */
  onWorldLifecycle(event: WorldLifecycleEvent): void {
    const what = event.kind === 'visibility'
      ? (event.visible ? '重新对你可见' : '已对你隐藏,它的事件不再送到你这里')
      : event.kind === 'mounted' ? '已激活'
        : event.kind === 'unmounted' ? '已停用' : '已重启';
    this.core?.injectInternal(`[system] World 「${event.label}」${what}。`, 'notice');
  }

  private dialogueOptions(): DialogueOptions {
    const policy = this.conversationSettings();
    return { windowMinutes: policy.dialogueWindowMinutes, maxMessages: policy.dialogueMaxMessages,
      reserveTokens: policy.dialogueReserveTokens, prioritizeSenderKeys: prioritySenders(policy) };
  }

  /** Restore only absent originals, as external material. Explicit context clears never call this. */
  private recoverDialogue(conversation?: string): void {
    if (!this.core) return;
    const info = this.core.sessionInfo(MAIN);
    const refs = (info.snapshot ?? []).flatMap(record => record.context?.frame?.events ?? []);
    // After a process restart, a persisted handoff already holds the recovery material.
    if (!conversation && refs.some(ref => ref.source === 'persona' && [HANDOFF_NOTE_TYPE, 'dialogue.recovered'].includes(ref.type))) return;
    const visible = new Set(refs.map(ref => ref.source + ':' + ref.cursor));
    const candidates = collectDialogueEvents(this.conversationSources.snapshot())
      .filter(entry => !visible.has(entry.source + ':' + entry.cursor) && !this.restoredSources.has(entry.source + ':' + entry.cursor));
    const options = this.dialogueOptions();
    if (conversation) {
      options.prioritizeSenderKeys = [conversation];
      options.windowMinutes = this.conversationSettings().answeredTopicWindowMinutes;
    }
    const headroom = info.hardTokens === null ? options.reserveTokens
      : Math.max(0, info.hardTokens - (info.estTokens ?? info.hardTokens) - 512);
    const selected = selectDialogue(candidates, { ...options, now: new Date(), budgetTokens: headroom });
    if (!selected.entries.length) return;
    this.core.injectExternal(selected.text, 'dialogue.recovered');
    for (const entry of selected.entries) this.restoredSources.add(entry.source + ':' + entry.cursor);
  }

  onDelivery(ctx: { events: EventEnvelope[] }): void {
    this.conversationSources.observe(ctx.events);
    const warning = this.conversationSources.status();
    if (warning && warning !== this.sourceWarning) this.core?.log.warn(warning);
    this.sourceWarning = warning;
    // These are explicit World candidate targets, never recipient guesses from body text.
    const targets = new Set<string>();
    for (const event of ctx.events) {
      const target = event.type === 'qq.proactive' && ['qq', 'qqbot'].includes(event.source)
        ? event.meta?.address
        : event.type === 'life.reach' && ['life', 'humanlike'].includes(event.source)
          ? 'private:' + String(event.meta?.targetQQ ?? '') : null;
      if (typeof target === 'string' && /^private:[1-9]\d*$/.test(target)) targets.add(target);
    }
    // A batch with competing targets must not combine multiple private conversations.
    if (targets.size === 1) this.recoverDialogue([...targets][0]);
    const externals = ctx.events.filter((e) => e.origin === 'external');
    if (externals.length === 0) return;
    // 新的一批 = 新的一轮待办。这一批里有没有人直接对着她说话，决定要不要催她动手。
    this.batchNeedsReply = externals.some((e) => this.isDirectAddress(e));
    // 外部事件投递复位静默时长。
    this.heartbeat.noteActivity();
    // 报这一刻的钟点。
    //
    // 为什么不放系统前缀里：前缀是缓存的，只在会话交接时重建。实测上一次重建到下一次之间
    // 能隔两个多小时，前缀里的时间会一直僵在那儿——报一个错的时间比不报更糟。
    // 这条 notice 是每批现注入的，位置在上下文末尾，也不动前缀那 100% 的缓存命中。
    //
    // 为什么不在别处报：她上下文里的时间只能从各 World 自己写的时间戳推。
    // 要是一下午没人说话，她看到的最后一个时间是几小时前的，自然就乱了。
    this.core?.injectInternal(`[system] ${externals.length} 条新事件。现在是 ${this.clockStamp()}。`, 'notice');
  }

  /**
   * 这一批里有人直接对着她说话，而她一轮里什么都没往外送——提醒一句再走一轮。
   *
   * 为什么需要：某些渠道的回话全靠发言工具送出去，而"把话写出来"在她那边
   * 看起来也算说完了。2026-09-23 凌晨连踩两次：她把两句安慰话写得挺好，
   * 一条都没出门，主人那边只看到她不理人。提示词里写清楚了也没用，
   * 所以改成机制上兜一下——只在"有人对着她说、她连一个工具都没调"时催，
   * 别的时候一声不吭。
   */
  onTurnWouldEnd(): string | null {
    if (!this.batchNeedsReply) return null;
    this.batchNeedsReply = false; // 一批只催一次
    const names = [...(this.core?.toolsTagged('speak') ?? [])].join('、');
    return '[系统] 刚才有人直接跟你说话。正文不一定由当前渠道对外发送；请核对当前渠道的输出方式和回执。'
      + (names ? '可用发言工具：' + names + '。收件人以原始事件的会话标识为准，按工具 schema 填写。' : '')
      + '确实不想回就调用 end_turn。';
  }

  /**
   * 这条外部事件是不是"有人对着她说话"：私聊，或者群里 @ 了她。
   *
   * 群里 @ 她的判据是 World 渲染时加的标记，不是她自己猜的：
   * 内置 qq World 写 `(你)`，扩展写 `@你`（更早的版本写 `@我`，也认着）。
   * 群里的泛聊不该催，那是噪音。
   *
   * `meta.conv` 两种形状都认：内置 qq World 给的是 `{ kind, id }`，
   * 扩展曾经给过 `'private:123'` 这样的字符串；只认一种就会整条判据静默失效。
   */
  private isDirectAddress(e: EventEnvelope): boolean {
    if (e.source !== 'qq' && e.source !== 'qqbot') return false;
    if (e.type !== 'qq.message') return false;
    const conv = (e.meta as { conv?: unknown } | undefined)?.conv;
    const kind = typeof conv === 'string' ? conv.split(':')[0] : (conv as { kind?: string } | undefined)?.kind;
    if (kind === 'private') return true;
    if (typeof e.text !== 'string') return false;
    if (e.text.includes('(你)') || e.text.includes('@你')) return true;
    if (e.text.includes('【私聊')) return true;
    return /@我(?![\u4e00-\u9fa5])/.test(e.text);
  }

  /** 投递 notice 里用的时区；systemSegments 重建前缀时刷新，之前用默认值。 */
  private clockTz = 'Asia/Shanghai';

  /** 这一刻的钟点:`9月21日 13:23 周一`。 */
  private clockStamp(): string {
    const d = new Date();
    const opts = { timeZone: this.clockTz } as const;
    // 用中文的月日而不是 09-21 / 21/09：后者在中文语境里会被读成月日或日月，含混。
    const day = new Intl.DateTimeFormat('zh-CN', { ...opts, month: 'long', day: 'numeric' }).format(d);
    const time = new Intl.DateTimeFormat('zh-CN', { ...opts, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    const week = new Intl.DateTimeFormat('zh-CN', { ...opts, weekday: 'short' }).format(d);
    return `${day} ${time} ${week}`;
  }

  /**
   * 批末压力裁量:超软阈值先注入速记提醒(她拿到一轮落笔时间——提醒项挂 flush,
   * 下一批必含它),再超就请求交接。阶段预算是自己的裁量;越过模型物理上限的
   * 强制交接在 core。
   */
  onBatchEnd(): void {
    const core = this.core;
    if (!core) return;
    const info = core.sessionInfo(MAIN);
    if (info.estTokens === null) return;
    const { maxTokens, softRatio } = this.context();
    if (info.estTokens <= maxTokens * softRatio) return;
    if (!this.pressureWarned) {
      this.pressureWarned = true;
      // 这一刻是"当前语境"的起点:交接笔记按它把上一窗切成更早的历史与最近的一段。
      this.pressureWarnedAt = Date.now();
      core.injectInternal(this.pressureNote(), 'notice');
      return;
    }
    core.requestContextHandoff();
  }

  /** 软阈值那一轮的速记提醒。 */
  protected pressureNote(): string {
    return (
      '[system] 交接快来了。交接会把上文全部清空,清空前最近的一段会写成交接笔记送到新会话。' +
      '很早以前的事里,你还在跟的、还想做的,现在就写进文件,再过一会儿上下文就没了。'
    );
  }

  /**
   * 卡住恢复的成文:core 只报 {count, quietMs} 机械事实。一次抖动不值得占一条上下文。
   */
  onStallsRecovered({ count, quietMs }: { count: number; quietMs: number }): string | null {
    if (count < 2) return null;
    const span = quietMs >= 60_000
      ? `约 ${Math.round(quietMs / 60_000)} 分钟`
      : `约 ${Math.round(quietMs / 1000)} 秒`;
    return `[系统] 你刚才卡住了 ${count} 次,${span}没能说出话——不是你选择不说。现在恢复了。`;
  }

  /**
   * 交接:交回空尾,上一窗的 assistant 消息与思维链签名不回灌。清空前的一段按软阈值时刻
   * 切成"更早"与"最近"两段渲染成交接笔记,写进 handoffs/,再各以外部事件投递进新 session
   * 第一批;醒来那句话经 injectInternal 同批到达。事务期间总线不投递。
   */
  async onHandoff(snapshot: ContextRecord[], _ctx: { hardTokens: number | null }): Promise<ContextHandoffResult> {
    const tagged = (tag: ToolTag): ReadonlySet<string> => this.core?.toolsTagged(tag) ?? new Set<string>();
    const now = new Date();
    const { maxTokens, keepRatio } = this.context();
    const budgetTokens = Math.max(0, Math.min(16384, Math.floor(maxTokens * keepRatio),
      _ctx.hardTokens === null ? Infinity : Math.floor(_ctx.hardTokens / 2)));
    const dialogue = collectDialogueEvents(this.conversationSources.snapshot());
    const dialogueOptions = this.dialogueOptions();
    const note = renderHandoffNote(snapshot, {
      speechTools: tagged('speak'),
      flowTools: tagged('flow'),
      snapshotTools: tagged('snapshot'),
      now,
      // 笔记预算：封顶 16384（handoffNote 里兜底 4096 的 4 倍），且不超过"阶段预算 × keepRatio"。
      // 原来直接用 maxTokens × keepRatio：300k × 0.5 = 15 万，一份按分钟分组的流水能吃下
      // 约 7 万 token，而它常驻上下文、每次唤醒都要重读（2026-10-14 体检，见交接第 65 章）。
      budgetTokens,
      dialogue, dialogueOptions,
      // 软阈值那一刻之后的是"当前语境",之前的是"更早的历史";分两条投递。
      splitAtMs: this.pressureWarnedAt,
    });
    this.restoredSources.clear();
    for (const entry of selectDialogue(dialogue, { ...dialogueOptions, now, budgetTokens }).entries) {
      this.restoredSources.add(entry.source + ':' + entry.cursor);
    }
    const file = `${HANDOFF_DIR}${handoffNoteStamp(now)}.md`;
    const abs = join(this.memoryDir, file);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, note.text, 'utf8');
    this.lastHandoffFile = file;
    this.pressureWarned = false;
    this.pressureWarnedAt = null;
    // 醒来那句话读 lastHandoffFile,所以先写文件。
    this.core?.injectInternal(this.handoffNote(), 'handoff');
    // 两段各是一条事件,同批投递(渲染进同一帧);远近之分靠各自的抬头与时间范围。
    for (const part of note.parts) this.core?.injectExternal(part.text, HANDOFF_NOTE_TYPE);
    return { tail: this.handoffTail(snapshot) };
  }

  /** 交接后带进新 session 的尾巴。空:新 session 只有前缀、醒来那句话和交接笔记。 */
  protected handoffTail(_snapshot: ContextRecord[]): ContextRecord[] {
    return [];
  }

  /** 交接醒来那句话:各句由 handoffNoteLines() 给,变体在其间插自己的句子。 */
  protected handoffNote(): string {
    return this.handoffNoteLines().join('');
  }

  /**
   * 交接告知使用中文以保持上下文语种。先说明空台词不能播出，再给出可执行的后续动作。
   */
  protected handoffNoteLines(): string[] {
    return [
      '[system] 交接完了。之前的上下文已经全部清空,工作区的文件都还在。',
      `清空前的一段写成了交接笔记,随这一批送到,也存在 ${this.lastHandoffFile ?? HANDOFF_DIR} 里:`,
      '指定会话的最近双向对话优先保留原始日期与来源；其他内容再按时间分段，省略条数会明确标注。',
      '只有最近段保留对外发言的具体入参与实际回执,更早段整条省略这类调用。',
      '入参是当时拟发出的内容,对方是否收到、收到多少要看回执和后续事件;已受理不代表已经送达。',
      '自然接续当前话题或动作,不必口头表示意识到暂停、清空或交接。旧发言和折叠后的片段不作句式或长短的范本。',
      '对外交流的工具不要输出空内容,空的一个字也发不出去。',
      '想说话就把话直接写进调用里。这轮不想说,就调 end_turn。',
    ];
  }


  declareSessions(): SessionDecl[] {
    const self = this;
    return [
      {
        id: MAIN,
        label: 'main',
        rounds: () => ({ soft: this.caps.soft, hard: this.caps.hard, softHint: () => this.softCapHint() }),
        persistent: true,
        receivesEvents: true,
        get outputTap() { return self.outputTap(); },
        // 自有尾巴排在 World 工具之后:工具表顺序直接影响请求前缀的缓存命中
        tools: () => [...this.tools(), ...this.ioTools(), ...this.mainTailTools()],
      },
    ];
  }

  /** 主 session 排在 World 工具之后的自有工具;变体追加自己的(闹钟)。 */
  protected mainTailTools(): ToolDef[] {
    return [endTurnTool()];
  }

  /** 自有工具 = 文件工具面 + 主 session 尾巴;各 session 声明里 World 之外的都出自这两处。 */
  ownToolNames(): string[] {
    return [...new Set([...this.tools(), ...this.mainTailTools()].map((t) => t.name))];
  }

  private sortedWorlds(): World[] {
    return [...this.worlds].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 软轮数上限那一轮拼在回执末尾的提醒;变体可改措辞或返回 null 不提醒。 */
  protected softCapHint(): string | null {
    return '[system] 这一轮已经连续行动很多步。手上的事做完就调 end_turn 结束这一轮。';
  }

  /** 挂载 World 的工具(可给 tag 只取一类,如 fork 只拿 read 类);World 可见性由 core 在工具装配后过滤。 */
  protected ioTools(tag?: ToolTag): ToolDef[] {
    const all = this.sortedWorlds().flatMap((m) => m.tools()).map(tool => {
      if (!tool.tags.includes('speak')) return tool;
      return { ...tool, handler: async (args, ctx) => {
        const policy = this.conversationSettings();
        if (policy.repeatQuestionFallbackEnabled && typeof args.text === 'string' && typeof args.to === 'string') {
          const evidence = repeatedQuestionEvidence({ text: args.text, conversation: args.to,
            events: this.conversationSources.snapshot(), now: new Date(), windowMinutes: policy.answeredTopicWindowMinutes });
          if (evidence) return { failed: true as const,
            text: '未发送：Persona 重复问句 fallback 发现该会话近期已有明确回答。来源 cursor ' + evidence.sourceCursor
              + '，原始时间 ' + evidence.sourceTs + '。请先核对上下文；这只匹配有限短问句，不判断对方现在的状态。可在 handoff.repeatQuestionFallbackEnabled 关闭。' };
        }
        return tool.handler(args, ctx);
      } } satisfies ToolDef;
    });
    return tag ? all.filter((t) => t.tags.includes(tag)) : all;
  }

  /**
   * 主 session 的输出旁路:挂载 World 的接收器扇成一个 tap。没有任何接收器时不声明,
   * session 不走流式。每批投递时现取,World 运行中挂载/卸载即生效。
   */
  private outputTap(): OutputTap | undefined {
    // outputTap 现在允许返回 undefined（这一刻没有接收器），所以要在这里滤掉，
    // 否则下面每处 `t.onXxx()` 都会是 possibly undefined。
    const taps = this.sortedWorlds().flatMap((m) => {
      const tap = m.outputTap?.();
      return tap ? [tap] : [];
    });
    if (taps.length === 0) return undefined;
    if (taps.length === 1) return taps[0];
    return {
      onEvent: (event) => { for (const t of taps) t.onEvent(event); },
      externalizes: (event) => taps.some((t) => (t.externalizes?.(event) ?? defaultExternalizes(event))),
      onRoundEnd: () => { for (const t of taps) t.onRoundEnd?.(); },
      onAbort: (reason) => { for (const t of taps) t.onAbort?.(reason); },
    };
  }


  /**
   * 她对记忆的全部动作面。换记忆实现就是换掉这一份的内容(见 workspaceTools.ts);
   * 传进去的四项是工具要问Persona的事,变体覆写哪个方法就改哪处行为。
   */
  protected tools(): ToolDef[] {
    return [
      ...createRecentTools(this.recentLedger),
      ...workspaceTools({
        memory: this.memory,
        writeGuard: (op, path, role) => this.recentLedger.guardPath(path) ?? this.writeGuard(op, path, role),
        readOverride: (path) => this.readRecentLedger(path) ?? this.readOverride(path),
        prefixResidentFiles: () => this.prefixResidentFiles(),
      }),
      saveBlobTool({
        blobs: this.blobs,
        core: () => this.core,
        guard: (path, role) => this.recentLedger.guardPath(path) ?? this.writeGuard('write', path, role),
      }),
    ];
  }

  /**
   * 写类工具的准入:返回一句拒绝理由就不动文件,null 放行。基类不设限;变体按自己的
   * 写纪律覆写(按 session 角色分区、容量守门)。`role` 是调用方 session id。
   */
  protected writeGuard(_op: 'write' | 'append' | 'rename' | 'delete', _path: string, _role: string): string | null {
    const recent = this.recentLedger.guardPath(_path);
    if (recent) return recent;
    if (this.isCoreRulesPath(_path)) return CORE_RULES_READONLY;
    return null;
  }

  /**
   * read_file 的虚拟文件:返回正文就不读盘(如随软件走的机制说明);null 走正常读取。
   *
   * CORE.md 不在工作区里,工作区里建同名文件也没用——读的是包内那份。代价是这条
   * 路径不走 workspaceTools 的 offset/limit 分片:这份文件本来就是整段进前缀的,
   * 要哪一段从眼前抄,不必回头翻。
   */
  protected readOverride(path: string): string | null {
    if (!this.isCoreRulesPath(path)) return null;
    const file = this.coreRulesFile();
    if (file === null) return `[not found] ${path}(软件包内没有这份机制说明)`;
    return readFileSync(file, 'utf8');
  }

  /** Own ledger policy also applies when a variant overrides its ordinary file policy. */
  private readRecentLedger(path: string): string | null {
    return normalizeWorkspacePath(path).replace(/[ .]+$/, '').toLowerCase() === RECENT_FILE.toLowerCase()
      ? JSON.stringify(this.recentLedger.read()) : null;
  }

  /**
   * 路径是不是那份只读机制说明。判名字而不是判完整路径:它不在工作区里,
   * 任何目录前缀下的同名文件都不该被当成她自己的文件写进去。
   */
  protected isCoreRulesPath(path: string): boolean {
    const file = this.coreRulesFile();
    return file !== null && basename(normalizeWorkspacePath(path)) === basename(file);
  }

  /** 逐字进系统前缀的文件:删掉它们等于改前缀,所以 delete_file 不认。 */
  protected prefixResidentFiles(): string[] {
    const partner = this.partnerDocFile();
    return [join(this.memoryDir, CONSTITUTION_FILE), ...(partner ? [partner] : [])];
  }

}
