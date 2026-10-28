/** 剪贴板 World：只读地取当前剪贴板里的文字。 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ToolDef } from 'cortico/core/types.ts'
import { autoWebUi } from './panel.ts'
import { CLIPBOARD_DEFAULTS } from './config.ts'

const execFileAsync = promisify(execFile)

export const CLIPBOARD_TOOL_DECLS = [
  {
    name: 'clipboard_read',
    description: '读当前剪贴板里的文字。使用者说「我刚复制的那个」「剪贴板里那条」时用。只能读文字，图片和文件读不了。',
    tags: ['read'] as const,
    parameters: { type: 'object' as const, additionalProperties: false, properties: {} },
  },
]

export class ClipboardWorld {
  readonly id = 'clipboard'
  private readonly maxChars: number

  constructor(opts: { cfg: { maxChars: number } }) {
    this.maxChars = opts.cfg.maxChars
  }

  envPromptVars(): Record<string, string> {
    return {}
  }

  webUi() {
    return autoWebUi('clipboard', '剪贴板', CLIPBOARD_DEFAULTS)
  }
  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  tools(): ToolDef[] {
    return CLIPBOARD_TOOL_DECLS.map((decl) => ({
      ...decl,
      tags: [...decl.tags],
      handler: async () => {
        const text = await readClipboard()
        if (text === null) return '读剪贴板失败：系统没给出来。'
        if (!text) return '剪贴板里没有文字（可能是空的、或者里面是图片/文件）。'
        return text.length > this.maxChars
          ? text.slice(0, this.maxChars) + '\n（太长，截断了）'
          : text
      },
    }))
  }
}

/** 走 PowerShell 取剪贴板文本；失败返回 null。 */
async function readClipboard(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
      { windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    )
    return stdout.replace(/\r?\n$/, '')
  } catch {
    return null
  }
}
