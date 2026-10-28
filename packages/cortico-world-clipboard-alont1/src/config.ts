/** 剪贴板 World 的配置。 */
export interface ClipboardConfigSection {
  enabled: boolean
  /** 返回的最大字数，超出截断。 */
  maxChars: number
}

export const CLIPBOARD_DEFAULTS: ClipboardConfigSection = {
  enabled: false,
  maxChars: 2000,
}
