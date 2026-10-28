import type { ConfigGroup, ConfigProperty, WorldWebUiDecl } from 'cortico/core/types.ts'
export interface BrainStatus { online: boolean; docs: number; chunks: number; entities: number; due: number; lastSync: number; error: string; archive?: { enabled: boolean; docs: number; chunks: number; entities: number } }
const number = (title: string, minimum: number, maximum: number): ConfigProperty => ({ type: 'integer', title, minimum, maximum, 'x-hot': false })
const string = (title: string, description?: string): ConfigProperty => ({ type: 'string', title, description, 'x-hot': false })
const boolean = (title: string): ConfigProperty => ({ type: 'boolean', title, 'x-hot': false })
const fields: Record<string, ConfigProperty> = {
  enabled: boolean('启用'), workspaceSubdir: string('资料相对目录', '必须明确填写相对部署目录的资料路径；留空不读取。修改目录请同时使用独立数据库文件名。'), dbFile: string('数据库文件名'),
  include: { type: 'object', title: '索引路径数组（只读；下方 JSON 可覆盖）' }, exclude: { type: 'object', title: '排除路径数组（只读）' },
  includeJson: string('索引路径 JSON', '留空使用 include 数组，或填写 JSON 字符串数组。'), excludeJson: string('排除路径 JSON', '留空使用 exclude 数组。'),
  syncOnStart: boolean('启动后自动同步一批'),
  'archive.enabled': boolean('启用独立档案库（旧记录）'), 'archive.dbFile': string('档案数据库文件名'),
  'archive.include': { type: 'object', title: '档案路径数组（只读）' }, 'archive.includeJson': string('档案路径 JSON', '留空默认 handoffs/**/*.md；不参与核心索引。'),
  'archive.maxResults': number('档案结果上限', 1, 50), 'archive.weight': { type: 'number', title: '合并查询档案权重（大于 0、小于 1）', minimum: 0, maximum: 1, 'x-hot': false },
  includeConversations: boolean('允许 JSONL 对话文件'), maxResults: number('搜索结果上限', 1, 50), maxChunkChars: number('块最大字符数', 100, 10000), minChunkChars: number('块最小合并字符数', 1, 10000),
  syncIntervalMin: number('同步间隔（分钟）', 1, 1440), maxFilesPerSync: number('每次最多处理文件数', 1, 200), maxFileBytes: number('文件大小上限（字节）', 1024, 16777216),
  'review.enabled': boolean('开启复习'), 'review.dailyLimit': number('提醒中最多条目数', 1, 50), 'review.dueCheckMin': number('到期检查间隔（分钟）', 1, 1440), 'review.idleDaysForStale': number('审计旧日期阈值（天）', 1, 3650),
  'review.intervals': { type: 'object', title: '复习间隔数组（只读）' }, 'review.intervalsJson': string('复习间隔 JSON', '留空使用 intervals；首项用于首次到期，后续按评分算法计算。'),
  'llm.enabled': boolean('开启 LLM 外发增强'), 'llm.baseUrl': string('LLM HTTP(S) 端点'), 'llm.model': string('LLM 模型'), 'llm.apiKeySecret': string('密钥环境变量名', '这里只填变量名；真实密钥保存在部署 .env。'), 'llm.maxCallsPerHour': number('LLM 每小时最多调用', 1, 1000),
}
export const BRAIN_CONFIG_GROUP: ConfigGroup = { id: 'world:brain', owner: 'world:brain', schema: { type: 'object', title: '记忆大脑', description: '配置变更重新挂载后生效；LLM 默认关闭，启用会把选中的文本块发送到指定端点。', properties: Object.fromEntries(Object.entries(fields).map(([key, value]) => ['worlds.brain.' + key, value])) } }
export function panel(status: BrainStatus): WorldWebUiDecl {
  return { lamps: [
    { label: '核心索引', state: status.online ? 'online' : 'offline', hint: `${status.docs} 文档 / ${status.chunks} 块 / ${status.entities} 实体` },
    { label: '档案库', state: status.online && status.archive?.enabled ? 'online' : 'offline', hint: status.archive?.enabled ? `${status.archive.docs} 文档 / ${status.archive.chunks} 块 / ${status.archive.entities} 实体` : '未启用；默认检索只读核心' },
    { label: '复习', state: status.online ? 'online' : 'offline', hint: `${status.due} 条到期` },
    { label: '同步', state: status.error ? 'error' : status.online ? 'online' : 'offline', hint: status.error || (status.lastSync ? new Date(status.lastSync).toISOString() : '尚未同步') },
  ], badges: [{ label: '核心文档', value: status.docs }, { label: '核心块', value: status.chunks }, { label: '核心实体', value: status.entities }, { label: '档案文档', value: status.archive?.docs ?? 0 }, { label: '档案块', value: status.archive?.chunks ?? 0 }, { label: '待复习', value: status.due }], config: [BRAIN_CONFIG_GROUP] }
}
