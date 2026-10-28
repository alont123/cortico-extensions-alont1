/** 玩具世界：在自己的 play/ 目录里跑一小段 JS。没有网络、没有文件系统，超时就停。 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { ToolDef, World } from 'cortico/core/types.ts'
import { autoWebUi } from './panel.ts'
import { PLAYGROUND_DEFAULTS } from './config.ts'

const RUNNER_FILE = fileURLToPath(new URL('./runner.mjs', import.meta.url))
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split('.').map(Number)
const PERMISSION_FLAG = NODE_MAJOR === 22 && NODE_MINOR < 13 ? '--experimental-permission' : '--permission'

export const PLAYGROUND_TOOL_DECLS = [
  {
    name: 'play_run',
    description: '在自己的玩具目录里跑一小段 JS：不联网、不碰外面文件，最多几秒。console.log 的输出会回来。',
    tags: ['write'] as const,
    parameters: {
      type: 'object' as const, additionalProperties: false,
      properties: {
        code: { type: 'string' as const, description: 'JS 源码。' },
        name: { type: 'string' as const, description: '存成什么文件，默认 toy.js。' },
      },
      required: ['code'] as const,
    },
  },
  {
    name: 'play_list',
    description: '看看玩具目录里有什么。',
    tags: ['read'] as const,
    parameters: { type: 'object' as const, additionalProperties: false, properties: {} },
  },
]

export class PlaygroundWorld implements World {
  readonly id = 'playground'
  private readonly dir: string
  private readonly timeoutSec: number

  constructor(opts: { botDir: string; dataDir?: string; cfg: { timeoutSec: number } }) {
    this.dir = join(opts.dataDir ?? join(opts.botDir, 'data'), 'playground', 'play')
    this.timeoutSec = Math.min(30, Math.max(1, opts.cfg.timeoutSec))
  }

  envPromptVars(): Record<string, string> {
    return {}
  }

  tools(): ToolDef[] {
    return [
      {
        ...PLAYGROUND_TOOL_DECLS[0],
        tags: [...PLAYGROUND_TOOL_DECLS[0].tags],
        handler: async (args: Record<string, unknown>) => {
          const code = String(args.code ?? '')
          if (!code.trim()) return '没给代码。'
          const rawName = String(args.name ?? 'toy.js').replace(/[^\w.-]/g, '_')
          const name = rawName.endsWith('.js') ? rawName : rawName + '.js'
          mkdirSync(this.dir, { recursive: true })
          writeFileSync(join(this.dir, name), code)
          return new Promise<string>((resolve) => {
            const child = execFile(process.execPath, [PERMISSION_FLAG, '--allow-fs-read=' + RUNNER_FILE, RUNNER_FILE], {
              timeout: this.timeoutSec * 1000 + 1000,
              maxBuffer: 128 * 1024,
              windowsHide: true,
              cwd: this.dir,
              env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {},
            }, (error, stdout) => {
              if (error) { resolve('跑挂了：代码执行失败或超时。'); return }
              try {
                const result = JSON.parse(stdout) as { ok: boolean; text: string }
                resolve(result.ok && typeof result.text === 'string' ? result.text + '\n（已存到 play/' + name + '）' : '跑挂了：代码执行失败（语法、运行限制或超时）。')
              } catch { resolve('跑挂了：执行结果无法读取。') }
            })
            child.stdin?.on('error', () => {})
            child.stdin?.end(JSON.stringify({ code, name, timeoutMs: this.timeoutSec * 1000 }))
          })
        },
      },
      {
        ...PLAYGROUND_TOOL_DECLS[1],
        tags: [...PLAYGROUND_TOOL_DECLS[1].tags],
        handler: async () => {
          try {
            const list = readdirSync(this.dir).filter((f) => f.endsWith('.js'))
            return list.length ? list.join('\n') : '玩具目录还是空的。'
          } catch {
            return '玩具目录还没建。'
          }
        },
      },
    ]
  }

  webUi() {
    return autoWebUi('playground', '玩具世界', PLAYGROUND_DEFAULTS)
  }
  async start(): Promise<void> {}

  async stop(): Promise<void> {}
}
