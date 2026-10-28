export interface BrainConfig {
  enabled: boolean
  workspaceSubdir: string
  include: string[]
  exclude: string[]
  includeJson: string
  excludeJson: string
  includeConversations: boolean
  maxResults: number
  maxChunkChars: number
  minChunkChars: number
  syncOnStart: boolean
  syncIntervalMin: number
  maxFilesPerSync: number
  maxFileBytes: number
  review: { enabled: boolean; dailyLimit: number; intervals: number[]; intervalsJson: string; dueCheckMin: number; idleDaysForStale: number }
  llm: { enabled: boolean; baseUrl: string; model: string; apiKeySecret: string; maxCallsPerHour: number }
  dbFile: string
  archive: { enabled: boolean; include: string[]; includeJson: string; dbFile: string; maxResults: number; weight: number }
}
export const BRAIN_DEFAULTS: BrainConfig = {
  enabled: false, workspaceSubdir: '',
  include: ['MEMORY.md', 'RECENT.md', 'memories/**/*.md', 'notes/**/*.md'],
  exclude: ['**/node_modules/**', '**/.git/**', '**/blobs/**'], includeJson: '', excludeJson: '',
  includeConversations: false, maxResults: 8, maxChunkChars: 1000, minChunkChars: 40,
  syncOnStart: true, syncIntervalMin: 15, maxFilesPerSync: 200, maxFileBytes: 1024 * 1024,
  review: { enabled: true, dailyLimit: 5, intervals: [1, 3, 7, 15, 30, 60], intervalsJson: '', dueCheckMin: 30, idleDaysForStale: 180 },
  llm: { enabled: false, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKeySecret: 'BRAIN_LLM_API_KEY', maxCallsPerHour: 20 },
  dbFile: 'brain.db',
  archive: { enabled: false, include: ['handoffs/**/*.md'], includeJson: '', dbFile: 'archive.db', maxResults: 5, weight: 0.25 },
}
export function integer(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
}
export function safeRelative(value: string, glob = false): string {
  const path = value.replaceAll('\\', '/')
  if (!path || path.startsWith('/') || path.includes(':') || path.split('/').some(part => !part || part === '..' || part === '.' || /[. ]$/.test(part)) || (!glob && /[?*\x00]/.test(path)) || path.includes('\x00')) throw new Error('配置路径必须是工作区内的相对路径')
  return path
}
function list(value: unknown, fallback: string[], json: unknown): string[] {
  const selected: unknown = typeof json === 'string' && json.trim() ? JSON.parse(json) : value ?? fallback
  if (!Array.isArray(selected) || selected.length > 100 || selected.some(item => typeof item !== 'string')) throw new Error('路径列表必须是最多 100 项的 JSON 字符串数组')
  return selected.map(item => safeRelative(item, true))
}
export function normalizeConfig(raw: Partial<BrainConfig> = {}): BrainConfig {
  const base = structuredClone(BRAIN_DEFAULTS)
  const review = { ...base.review, ...raw.review }
  const llm = { ...base.llm, ...raw.llm }
  const archive = { ...base.archive, ...raw.archive }
  const cfg = { ...base, ...raw, review, llm, archive }
  for (const value of [cfg.enabled, cfg.includeConversations, cfg.syncOnStart, review.enabled, llm.enabled, archive.enabled]) if (typeof value !== 'boolean') throw new Error('开关配置必须使用布尔值')
  for (const value of [cfg.workspaceSubdir, cfg.dbFile, cfg.includeJson, cfg.excludeJson, review.intervalsJson, llm.baseUrl, llm.model, llm.apiKeySecret, archive.dbFile, archive.includeJson]) if (typeof value !== 'string') throw new Error('文本配置类型不正确')
  cfg.workspaceSubdir = cfg.workspaceSubdir.trim() ? safeRelative(cfg.workspaceSubdir.trim()) : ''
  cfg.dbFile = safeRelative(String(cfg.dbFile))
  if (cfg.dbFile.includes('/')) throw new Error('dbFile 只能是文件名')
  archive.dbFile = safeRelative(archive.dbFile)
  if (archive.dbFile.includes('/') || archive.dbFile.toLowerCase() === cfg.dbFile.toLowerCase() || [cfg.dbFile.toLowerCase() + '-wal', cfg.dbFile.toLowerCase() + '-shm'].includes(archive.dbFile.toLowerCase()) || [archive.dbFile.toLowerCase() + '-wal', archive.dbFile.toLowerCase() + '-shm'].includes(cfg.dbFile.toLowerCase())) throw new Error('档案数据库需使用独立文件名，不能与核心库或其日志重合')
  archive.include = list(raw.archive?.include, base.archive.include, archive.includeJson)
  archive.maxResults = integer(archive.maxResults, 5, 1, 50)
  if (typeof archive.weight !== 'number' || !Number.isFinite(archive.weight) || archive.weight <= 0 || archive.weight >= 1) throw new Error('档案权重必须大于 0 且小于 1')
  cfg.include = list(raw.include, base.include, raw.includeJson)
  cfg.exclude = list(raw.exclude, base.exclude, raw.excludeJson)
  cfg.maxResults = integer(cfg.maxResults, 8, 1, 50)
  cfg.maxChunkChars = integer(cfg.maxChunkChars, 1000, 100, 10000)
  cfg.minChunkChars = integer(cfg.minChunkChars, 40, 1, cfg.maxChunkChars)
  cfg.syncIntervalMin = integer(cfg.syncIntervalMin, 15, 1, 1440)
  cfg.maxFilesPerSync = integer(cfg.maxFilesPerSync, 200, 1, 200)
  cfg.maxFileBytes = integer(cfg.maxFileBytes, 1048576, 1024, 16 * 1048576)
  review.dailyLimit = integer(review.dailyLimit, 5, 1, 50)
  review.dueCheckMin = integer(review.dueCheckMin, 30, 1, 1440)
  review.idleDaysForStale = integer(review.idleDaysForStale, 180, 1, 3650)
  const intervals: unknown = review.intervalsJson.trim() ? JSON.parse(review.intervalsJson) : review.intervals
  if (!Array.isArray(intervals) || !intervals.length || intervals.length > 20 || intervals.some(n => !Number.isInteger(n) || n < 1 || n > 365)) throw new Error('复习间隔必须是 1–365 天的整数数组')
  review.intervals = [...new Set(intervals as number[])].sort((a, b) => a - b)
  llm.maxCallsPerHour = integer(llm.maxCallsPerHour, 20, 1, 1000)
  if (llm.enabled) { const url = new URL(llm.baseUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('LLM 地址需为不含凭据的 HTTP(S) 地址') }
  return cfg
}
