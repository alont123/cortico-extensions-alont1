/** 七个模块共享 World 生命周期；持久状态与宿主只读数据使用各自目录。 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Language } from 'cortico/core/language.ts'
import type {
  OutputTap,
  PromptVarDecl,
  ShutdownExternalCheck,
  ToolDef,
  World,
  WorldWebUiDecl,
  WorldHost,
  WorldLamp,
  WorldPanelDecl,
  WorldStreamSocket,
} from 'cortico/core/types.ts'

/** 控制台一个 World 最多画几盏灯；与框架里的上限一致（api 5 的 core/types.ts 没导出那个常量）。 */
const LAMP_MAX = 7
import { HUMANLIKE_CONFIG_GROUPS, type HumanlikeConfigSection } from './config.ts'
import { migrateLegacyData, type MigrationResult } from './migrate.ts'
import { AffinityWorld } from './modules/affinity/world.ts'
import { LearnWorld } from './modules/learn/world.ts'
import { LifeWorld } from './modules/life/world.ts'
import { ClockWorld } from './modules/clock/world.ts'
import { TogetherWorld } from './modules/together/world.ts'
import { MindWorld } from './modules/mind/world.ts'
import { RealWorld } from './modules/real/world.ts'

/** 合并后的环境提示词模板；七个模块正文在 `console()` 里只报这一份。 */
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url))

/**
 * 合并后那份模板的占位符表：逐个模块从它们自己的 promptDocs 里取。
 * 变量名各带模块前缀，浅合并不会撞；来源模板的 key 也照原样留着（控制台按它回链）。
 */
const ENV_PROMPT_VARS = [
  ...promptVarsOf(AffinityWorld),
  ...promptVarsOf(LearnWorld),
  ...promptVarsOf(LifeWorld),
  ...promptVarsOf(ClockWorld),
  ...promptVarsOf(TogetherWorld),
  ...promptVarsOf(MindWorld),
  ...promptVarsOf(RealWorld),
]

/** 一个模块实例的固定形状：World 契约里它实现了的那几项。 */
interface Module {
  world: World
  label: string
}

export interface HumanlikeWorldOptions {
  cfg: HumanlikeConfigSection
  dataDir: string
  timezone: string
  botDir?: string
  consolePort?: number
}

export class HumanlikeWorld implements World {
  readonly id = 'humanlike'
  private readonly cfg: HumanlikeConfigSection
  private readonly modules: Module[]
  private host: WorldHost | null = null
  /** 旧版数据迁移结果；start 时写进日志。 */
  private migration: MigrationResult | null = null

  constructor(options: HumanlikeWorldOptions) {
    this.cfg = options.cfg
    const { dataDir, timezone } = options
    // 七个模块的状态文件名与独立扩展重名(together.json / life.json / …)。收进 humanlike/ 一层,
    // 否则和独立安装的同一个 World 抢着写同一个文件,后落盘的覆盖前者。
    const moduleDataDir = join(dataDir, 'humanlike')
    // 根目录文件也可能属于独立扩展，只有明确选择旧版迁移才读取。
    if (this.cfg.migrateLegacyData === true) this.migration = migrateLegacyData(dataDir)
    const cfg = this.cfg

    // 七个内置模块共享宿主管理的总开关；不改写配置中的遗留子 enabled 字段。
    const modules: Module[] = [
      { label: '情绪与交情', world: new AffinityWorld({ cfg: cfg.affinity, dataDir: moduleDataDir, timezone }) },
      { label: '学过的东西', world: new LearnWorld({ cfg: cfg.learn, dataDir: moduleDataDir, timezone }) },
      { label: '作息', world: new LifeWorld({ cfg: cfg.life, dataDir: moduleDataDir, timezone, affinityCfg: cfg.affinity }) },
      { label: '时间感', world: new ClockWorld({ cfg: cfg.clock, timezone }) },
      { label: '一起过的时间', world: new TogetherWorld({ cfg: cfg.together, dataDir: moduleDataDir, timezone }) },
      { label: '它自己惦记的事', world: new MindWorld({ cfg: cfg.mind, dataDir: moduleDataDir, timezone }) },
      { label: '看得见的', world: new RealWorld({ cfg: cfg.real, dataDir, timezone, botDir: options.botDir, consolePort: options.consolePort }) },
    ]
    this.modules = modules
  }

  // ── World 契约 ──────────────────────────────────────────────────────────

  /**
   * 七个模块的工具按模块顺序拼起来，共 21 个（名字带各自前缀，互不重名）。
   * 重名在这里就抛出来：框架按名字归属工具，重名的后果是后者顶掉前者且没人报错。
   */
  tools(): ToolDef[] {
    const out: ToolDef[] = []
    const seen = new Map<string, string>()
    for (const { world, label } of this.modules) {
      for (const tool of world.tools()) {
        const owner = seen.get(tool.name)
        if (owner) throw new Error(`工具名「${tool.name}」在「${owner}」和「${label}」里各有一个，合并后重名`)
        seen.set(tool.name, label)
        out.push(tool)
      }
    }
    return out
  }

  /** 七份变量对象浅合并；键名各带模块前缀，不会互相覆盖。 */
  async envPromptVars(): Promise<Record<string, string>> {
    const vars: Record<string, string> = {}
    for (const { world } of this.modules) {
      const part = await world.envPromptVars()
      // null = 这个模块不进前缀；合并体里只有整份模板，没有"省略某一段"这回事。
      if (part) Object.assign(vars, part)
    }
    return vars
  }

  async start(host: WorldHost): Promise<void> {
    if (this.migration && this.migration.migrated.length > 0) {
      host.log.info('人味：已从旧版迁移数据', {
        target: this.migration.targetDir,
        files: this.migration.migrated.map((m) => m.file),
      })
    }
    this.host = host
    const started: World[] = []
    try {
      for (const { world } of this.modules) {
        started.push(world)
        const moduleHost = Object.create(host) as WorldHost
        moduleHost.pushEvent = (event, options) => host.pushEvent({
          ...event, source: this.id,
          senderKey: event.senderKey === world.id ? `${this.id}.${world.id}` : event.senderKey,
          meta: { ...event.meta, component: world.id },
        }, options)
        moduleHost.pushDeferred = (event, options) => host.pushDeferred({
          ...event,
          senderKey: event.senderKey === world.id ? `${this.id}.${world.id}` : event.senderKey,
          meta: { ...event.meta, component: world.id },
        }, options)
        await world.start(moduleHost)
      }
    } catch (error) {
      for (const world of started.reverse()) {
        try { await world.stop() } catch (stopError) {
          host.log.warn(`人味：启动回滚失败 ${String(stopError)}`)
        }
      }
      this.host = null
      throw error
    }
  }

  /**
   * 逐个停。一个模块停失败不能把后面的留在原地——它们各有计时器和没落盘的账，
   * 少停一个就是少写一次盘。所以这里记下第一个错误、停完再抛。
   */
  async stop(): Promise<void> {
    let first: unknown
    let failed = false
    for (const { world } of this.modules) {
      try {
        await world.stop()
      } catch (e) {
        if (!failed) {
          failed = true
          first = e
        }
      }
    }
    this.host = null
    if (failed) throw first
  }

  /** 合并后的控制台声明：灯取自各模块、面板去重、配置组与提示词模板各一份。 */
  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const decls = this.modules.map(({ world }) => {
      try {
        return world.webUi?.(language) ?? {}
      } catch {
        // 控制台声明异常不该让整个页面消失；该模块的灯和面板这次就少一份。
        return {}
      }
    })

    const panels: WorldPanelDecl[] = []
    const panelIds = new Set<string>()
    for (const decl of decls) {
      for (const panel of decl.panels ?? []) {
        if (panelIds.has(panel.id)) continue
        panelIds.add(panel.id)
        panels.push(panel)
      }
    }

    const lamps: WorldLamp[] = []
    for (const decl of decls) {
      for (const lamp of decl.lamps ?? []) {
        if (lamps.length >= LAMP_MAX) break
        lamps.push(lamp)
      }
    }

    const anyStream = this.modules.some(({ world }) => typeof world.webUi === 'function')

    const decl: WorldWebUiDecl = {
      label: '人味',
      config: [...HUMANLIKE_CONFIG_GROUPS],
      promptDocs: [
        {
          key: 'worlds.humanlike.envPrompt',
          title: '人味 · 环境提示词',
          description: '七个模块各自的正文拼成这一份（情绪与交情、学过的东西、作息、时间感、一起过的时间、它自己惦记的事、看得见的）。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: ENV_PROMPT_VARS,
        },
      ],
    }
    if (lamps.length) decl.lamps = lamps
    if (panels.length) decl.panels = panels
    if (anyStream) {
      decl.invoke = (panel, method, args) => this.invoke(panel, method, args)
      decl.stream = (panel, socket) => this.stream(panel, socket)
    }
    return decl
  }

  outputTap(): OutputTap | undefined {
    for (const { world } of this.modules) {
      const tap = world.outputTap?.()
      if (tap) return tap
    }
    return undefined
  }

  onHandoffEnded(): void {
    for (const { world } of this.modules) world.onHandoffEnded?.()
  }

  onTurnEnded(): void {
    for (const { world } of this.modules) world.onTurnEnded?.()
  }

  shutdownVerification(language: Language): readonly ShutdownExternalCheck[] {
    const out: ShutdownExternalCheck[] = []
    for (const { world } of this.modules) {
      // 往下传 language:上游的 World 契约就是这么签的,不传的话在别人的框架上类型过不了。
      for (const check of world.shutdownVerification?.(language) ?? []) out.push(check)
    }
    return out
  }

  // ── 控制台转发 ──────────────────────────────────────────────────────────
  //
  // 七个模块都没有面板，所以现在不会有人走到这里。留着是因为声明里报了 panels
  // 却没有 invoke 时控制台只会回 503，那比报错更难查。

  private async invoke(panel: string, method: string, args: unknown[]): Promise<unknown> {
    for (const { world } of this.modules) {
      const decl = world.webUi?.()
      if (!decl?.panels?.some((p) => p.id === panel)) continue
      if (!decl.invoke) break
      return decl.invoke(panel, method, args)
    }
    throw new Error(`没有哪个模块认领面板「${panel}」`)
  }

  private stream(panel: string, socket: WorldStreamSocket): void {
    for (const { world } of this.modules) {
      const decl = world.webUi?.()
      if (!decl?.panels?.some((p) => p.id === panel)) continue
      decl.stream?.(panel, socket)
      return
    }
    throw new Error(`没有哪个模块认领面板「${panel}」`)
  }
}

/** 从一个模块类里问出它那份环境提示词的占位符表；取不到就是空表。 */
function promptVarsOf(ctor: abstract new (...args: never[]) => World): readonly PromptVarDecl[] {
  try {
    const probe = Object.create(ctor.prototype) as World
    const doc = probe.webUi?.('zh')?.promptDocs?.find((d) => d.role === 'envPrompt')
    return doc?.vars ?? []
  } catch {
    return []
  }
}
