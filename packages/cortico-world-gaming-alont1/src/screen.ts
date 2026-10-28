/**
 * 看他的屏幕。
 *
 * 抓游戏窗口的画面，交给视觉模型读，产出一句话的「画面」和一个「局面」。
 * 前台窗口采集器（tracker-window.ts）只知道进程名，看不到屏幕里发生了什么；
 * 这里是补上那一半。
 *
 * 抓图走一个一次性的 PowerShell 进程：Add-Type 编译那段 C# 要几百毫秒，
 * 但看的间隔是分钟级，不值得为它常驻一个进程。
 */
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { GamingWatchConfig } from './config.ts'
import { captureFrames, pickFrames, composeStoryboard, cleanupDir } from './storyboard.ts'
import { captureWindow, CaptureError, runPowerShell, type PowerShellRunner } from './capture.ts'

/** 屏幕上这一刻是什么局面。`result` 就是"一局刚打完"。 */
export type ScreenPhase = 'fight' | 'result' | 'menu' | 'other'

export interface ScreenReading {
  at: number
  phase: ScreenPhase
  /** 一句话，模型看到的画面内容。 */
  scene: string
  /** 这一帧有没有值得跟他说一句的事。模型判的。 */
  speak: boolean
  /** 值得说时的一句话——刚发生了什么。不值得说就是空串。 */
  moment: string
  /** 模型原文，排查用。 */
  raw: string
}

/** 判定顺序即优先级：结算画面里通常也有"战斗"字样，先认结算。 */
const PHASE_RULES: ReadonlyArray<readonly [ScreenPhase, RegExp]> = [
  ['result', /结算|战后|战果|战绩|复盘|撤离|阵亡|死亡|失败|胜利|结束|排名|得分/],
  ['fight', /交战|战斗|对局|进行中|存活|击杀/],
  ['menu', /菜单|准备|配装|大厅|主界面|商城|仓库|匹配|加载/],
]

function classify(text: string): ScreenPhase {
  for (const [phase, re] of PHASE_RULES) if (re.test(text)) return phase
  return 'other'
}

/**
 * 从模型回复里取四样东西。
 *
 * 缺「可说」那一行时按"不说"处理：判不出来就别打扰他，
 * 这比赌一把、把没事的一帧说成有事要安全。
 */
export function parseReading(text: string, at: number): ScreenReading | null {
  const raw = text.trim()
  if (!raw) return null
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
  const scene = /画\s*面[：:]\s*(.+)/.exec(raw)?.[1]?.trim() ?? lines[0] ?? ''
  const phaseText = /局\s*面[：:]\s*(.+)/.exec(raw)?.[1]?.trim() ?? raw
  const speakText = /可\s*说[：:]\s*(.+)/.exec(raw)?.[1]?.trim() ?? ''
  const speak = /^(是|要|有|值得)/.test(speakText)
  const moment = (/因\s*由[：:]\s*(.+)/.exec(raw)?.[1]?.trim() ?? '').replace(/^(无|没有|暂无)[。.]?$/, '')
  return {
    at,
    phase: classify(phaseText),
    scene: scene.slice(0, 300),
    speak: speak && moment !== '',
    moment: moment.slice(0, 200),
    raw: raw.slice(0, 2000),
  }
}

/** 喂给视觉模型的提示词。 */
function buildPrompt(name: string, watchFor: string | undefined, previousScene: string | undefined, gridFrames = 1, windowLabel = ''): string {
  const intro = gridFrames > 1
    ? `这是他正在玩的游戏「${name}」的连续画面：${gridFrames} 帧按时间顺序（先左后右、先上后下）拼成一张分镜网格，每格左上角有序号。用中文回答，只输出下面四行，不要别的话：`
    : `这是他正在玩的游戏「${name}」的画面截图。用中文回答，只输出下面四行，不要别的话：`
  const lines = [
    windowLabel ? `这是手动指定窗口「${windowLabel}」的${gridFrames > 1 ? '连续分镜' : '截图'}，不保证属于当前游戏「${name}」。只描述实际可见内容，用中文回答下面四行：` : intro,
    '',
    '局面：交战中 / 结算或战后 / 主菜单或准备 / 其他　（四选一，照抄一个）',
    '画面：一句话说清屏幕上发生了什么，带上你确实看到的数字、地图名、结果',
    '可说：是 / 否　（这一帧有没有值得跟他说一句的事）',
    '因由：可说时一句话说清"刚发生了什么"，不可说就写"无"',
  ]
  if (watchFor) lines.push(`留意：${watchFor}`)
  if (previousScene) {
    lines.push(
      '',
      `你上一次看的时候是：${previousScene}`,
      '对比一下。画面基本没变、或者只是同一次击杀/同一件装备还挂在屏幕上，就说"否"——',
      '同一件事只说一次。真正值得说的是"新发生的事"：刚击杀或刚被击杀、刚买到或解锁装备、',
      '血量或弹药见底、刚开局落地、刚拿到高价值物资、局势明显转了向。',
    )
  }
  return lines.join('\n')
}

/** 一次读图的用量，交给宿主记进 session 统计和 usage.jsonl。 */
export interface ScreenUsage {
  promptTokens: number
  completionTokens: number
}

class VisionError extends Error {}

interface LookOptions {
  cfg: GamingWatchConfig
  apiKey: string
  runPowerShell?: PowerShellRunner
}

/**
 * 抓图 + 读图。
 *
 * 就绪与否分开报（`ready` / `blockedReason`），因为没配好和抓图失败是两回事：
 * 前者是配置问题，后者是运行时问题，控制台的提示语不一样。
 */
export class ScreenWatcher {
  private lastError = ''
  private usageSink: ((usage: ScreenUsage, model: string) => void) | null = null

  constructor(private readonly options: LookOptions) {}

  /**
   * 每次读图后回调一次用量。
   *
   * Core 不管 World 自有模型的运行时，所以花费要主动上报，否则看画面这一路的开销
   * 在 usage.jsonl 里完全看不见。
   */
  setUsageSink(sink: (usage: ScreenUsage, model: string) => void): void {
    this.usageSink = sink
  }

  /** 能不能用。不能用时 `blockedReason` 说明缺什么。 */
  ready(): boolean {
    return this.blockedReason() === ''
  }

  blockedReason(): string {
    const { cfg, apiKey } = this.options
    if (!cfg.enabled) return '看画面没开'
    if (!cfg.model) return '没配视觉模型名'
    if (!apiKey) return '没配视觉模型的密钥'
    if (process.platform !== 'win32') return '只在 Windows 上能抓图'
    return ''
  }

  errorText(): string {
    return this.lastError
  }

  /**
   * 抓一次、读一次。任何一步失败都返回 null，调用方当作"这一拍没看到"。
   *
   * `previousScene` 是上一次读到的那句话。给模型做对比用——只看单帧判断不出"刚发生了什么"，
   * 有了上一帧的描述它才能说清哪些是新事、哪些还挂在屏幕上。
   */
  async look(
    proc: string, name: string, watchFor: string | undefined, previousScene?: string,
    target = '', targetTitle = '',
  ): Promise<ScreenReading | null> {
    if (!this.ready()) return null
    const { cfg, apiKey } = this.options
    const run = this.options.runPowerShell ?? runPowerShell
    const frames = Math.max(1, Math.min(9, Math.round(cfg.framesPerLook || 1)))
    let bytes: Uint8Array | undefined, used = 1
    this.lastError = ''
    if (frames > 1) {
      const dir = join(tmpdir(), 'gaming-frames-' + randomUUID())
      try {
        const cap = await captureFrames({ proc, target, targetTitle, frames, intervalMs: cfg.frameIntervalMs || 800,
          maxWidth: cfg.maxWidth, outDir: dir, timeoutMs: cfg.timeoutMs }, run)
        // 抓图失败不重复抓；仅成功抓图后的拼图/文件读取故障允许转单帧。
        if (!cap.ok) { this.lastError = cap.error || '窗口抓不出有效画面'; return null }
        const picked = pickFrames(cap.frames, frames)
        if (picked.length >= 2) {
          const gridFile = join(dir, 'grid.png')
          const cols = picked.length <= 4 ? 2 : 3
          const ok = await composeStoryboard({ files: picked.map(frame => frame.file), out: gridFile,
            cellWidth: Math.max(220, Math.round(cfg.maxWidth / cols)), timeoutMs: cfg.timeoutMs }, run)
          if (ok) { bytes = await readFile(gridFile); used = picked.length }
        }
        if (!bytes?.length) {
          const last = picked.at(-1) ?? cap.frames.at(-1)!
          bytes = await readFile(last.file); used = 1
        }
      } catch { bytes = undefined; used = 1 }
      finally { await cleanupDir(dir) }
    }
    if (!bytes?.length) {
      const file = join(tmpdir(), 'gaming-screen-' + randomUUID() + '.png')
      try {
        await captureWindow({ proc, target, targetTitle, file, maxWidth: cfg.maxWidth, timeoutMs: cfg.timeoutMs }, run)
        bytes = await readFile(file)
        if (!bytes.length) { this.lastError = '抓到的图是空的'; return null }
      } catch (error) {
        this.lastError = error instanceof CaptureError ? error.message : '抓图或画面文件读取失败'
        return null
      } finally { await rm(file, { force: true }).catch(() => {}) }
    }
    try {
      const text = await this.read(bytes, name, watchFor, previousScene, cfg, apiKey, used, targetTitle || target)
      const reading = parseReading(text, Date.now())
      if (!reading) { this.lastError = '视觉模型返回了空内容'; return null }
      this.lastError = ''
      return reading
    } catch (error) {
      this.lastError = error instanceof VisionError ? error.message
        : error instanceof Error && /^(TimeoutError|AbortError)$/.test(error.name) ? '读图超时，请稍后再试'
        : '视觉模型请求或响应读取失败，请检查模型配置'
      return null
    }
  }

  private async read(
    bytes: Uint8Array,
    name: string,
    watchFor: string | undefined,
    previousScene: string | undefined,
    cfg: GamingWatchConfig,
    apiKey: string,
    gridFrames = 1,
    windowLabel = '',
  ): Promise<string> {
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        // 关思维链要按端点方言给参数，两个都发：写错的那个会被静默忽略。
        // 只发一个而打到 DeepSeek 上时，思维链和正文共用 max_tokens，图一复杂就吃光预算，
        // content 返回空串而 HTTP 仍是 200——调用方看到的是"识别成功但什么都没说"。
        thinking: { type: 'disabled' },
        reasoning: { enabled: false },
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}` } },
            { type: 'text', text: buildPrompt(name, watchFor, previousScene, gridFrames, windowLabel) },
          ],
        }],
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    })
    if (!res.ok) throw new VisionError(`视觉模型请求失败（HTTP ${res.status}）`)
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    this.usageSink?.(
      { promptTokens: body.usage?.prompt_tokens ?? 0, completionTokens: body.usage?.completion_tokens ?? 0 },
      cfg.model,
    )
    const text = body.choices?.[0]?.message?.content
    if (typeof text !== 'string') throw new VisionError('视觉模型返回的结构不对')
    return text
  }
}
