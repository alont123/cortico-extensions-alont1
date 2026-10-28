/** 独立包内的面板契约；只读教程、生命周期状态和配置声明，不探测外部服务。 */
import type { ConfigGroup, ConfigProperty, World, WorldLamp, WorldWebUiDecl } from 'cortico/core/types.ts'
import type { WorldDefinition, WorldSection } from 'cortico/world.ts'

export interface PanelGuide {
  title: string
  purpose: string
  setup: string
  firstUse: string
  troubleshoot: string
  fields?: Record<string, Partial<ConfigProperty>>
  remount?: string[]
  omit?: string[]
}

export function usageGroup(id: string, guide: PanelGuide): ConfigGroup {
  return { id: `world:${id}.usage`, owner: `world:${id}`, schema: {
    type: 'object', title: `${guide.title} · 中文使用教程`, properties: {},
    description: `用途：${guide.purpose} 启用与停用统一使用宿主扩展卡片的激活控件；详情配置不会改变启用状态。启用：${guide.setup} 第一次使用：${guide.firstUse} 排查：${guide.troubleshoot} 配置生效：标有“重新挂载”的字段保存后重新挂载本扩展，其余按字段说明生效。状态灯只说明对应组件；外部服务是否可用，以实际工具回执为准。`,
  } }
}

const privateField = (key: string) => /(?:^|\.)(?:token|password|apiKey|xhsCookie)$/i.test(key)
const labels: Record<string, string> = { enabled: '启用', maxResults: '返回结果上限', maxChars: '文字长度上限', timeoutMs: '请求超时（毫秒）', timeoutSec: '超时（秒）', city: '默认城市', outDir: '输出目录', maxPerDay: '每日上限', dir: '扫描目录', scanSec: '扫描间隔（秒）', maxFiles: '文件数上限', maxFileMB: '单文件大小上限（MB）', consolePort: '控制台端口', logLines: '日志行数', httpUrl: '服务地址', maxBytes: '文件大小上限（字节）', modelUnet: '扩散模型文件', modelClip: '文本编码器文件', modelVae: 'VAE 模型文件', style: '默认画风', width: '图片宽度', height: '图片高度', steps: '采样步数', cfg: '提示词强度', shift: '偏移', textDevice: '文本编码器设备', tickSec: '检查间隔（秒）', minEventGapSec: '事件最小间隔（秒）', morningAt: '早安时间（HH:MM）', nightAt: '晚安时间（HH:MM）', mumuDir: 'MuMu 安装目录', vmIndex: '模拟器实例序号', bootTimeoutSec: '启动等待上限（秒）' }

export function completeConfig(id: string, defaults: object, ui: WorldWebUiDecl, guide: PanelGuide): ConfigGroup[] {
  const prefix = `worlds.${id}.`
  const seen = new Set<string>(), manual: string[] = []
  const config: ConfigGroup[] = (ui.config ?? []).filter(group => group.id !== `world:${id}.usage`).map(group => ({ ...group, schema: { ...group.schema, properties: Object.fromEntries(Object.entries(group.schema.properties).filter(([key]) => key !== prefix + 'enabled' && !guide.omit?.includes(key.slice(prefix.length)) && !privateField(key.slice(prefix.length))).map(([key, prop]) => {
    seen.add(key)
    const path = key.slice(prefix.length)
    const leaf = path.split('.').at(-1)!
    return [key, { 'x-hot': false, ...prop, ...(prop.title === leaf && labels[leaf] ? { title: labels[leaf] } : {}), ...guide.fields?.[path], ...(guide.remount?.includes(path) ? { 'x-hot': false, description: `${prop.description ?? ''} 保存后重新挂载本扩展生效。` } : {}) }]
  })) } }))
  const additional: Record<string, ConfigProperty> = {}
  const visit = (value: object, base = '') => {
    for (const [key, item] of Object.entries(value)) {
      const path = base ? `${base}.${key}` : key, full = prefix + path
      // Root activation belongs to the host; a stale config form must never overwrite it.
      if (path === 'enabled' || guide.omit?.includes(path)) continue
      if (privateField(path)) { manual.push(`${path}（凭据仅在部署侧维护，面板不显示）`); continue }
      if (seen.has(full)) continue
      let type: ConfigProperty['type'] | undefined
      if (typeof item === 'string' || typeof item === 'boolean') type = typeof item as 'string' | 'boolean'
      else if (typeof item === 'number' && Number.isFinite(item)) type = 'number'
      if (type) additional[full] = { type, title: labels[key] ?? key, 'x-hot': false, ...guide.fields?.[path] }
      else if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length) visit(item, path)
      else manual.push(path)
    }
  }
  visit(defaults)
  if (Object.keys(additional).length) config.push({ id: `world:${id}.additional`, owner: `world:${id}`, schema: { type: 'object', title: '其他配置', properties: additional } })
  const usage = usageGroup(id, guide)
  if (manual.length) usage.schema.description += ' 部署侧配置：' + manual.join('、') + '。'
  return [usage, ...config]
}

export function withWorldPanel<S extends WorldSection>(definition: WorldDefinition<S>, guide: PanelGuide): WorldDefinition<S> {
  return { ...definition, defaults: () => structuredClone(definition.defaults()), create(ctx) {
    const world = definition.create(ctx)
    return attachPanel(world, structuredClone(definition.defaults()), guide)
  } }
}

export function attachPanel<T extends World>(world: T, defaults: object, guide: PanelGuide): T {
  const originalUi = world.webUi?.bind(world), originalStart = world.start.bind(world), originalStop = world.stop.bind(world), originalTools = world.tools.bind(world)
  let state: WorldLamp['state'] = 'offline', calls = 0, failures = 0, activeCalls = 0, lastTool = '', lastDurationMs = 0
  let queue: Promise<void> = Promise.resolve()
  let tail: { kind: 'start' | 'stop'; promise: Promise<void> } | undefined
  const enqueue = (kind: 'start' | 'stop', action: () => Promise<void> | void) => {
    // Only adjacent requests may coalesce; stop/start/stop must retain the final stop.
    if (tail?.kind === kind) return tail.promise
    if (!tail && kind === 'start' && state === 'online') return Promise.resolve()
    const task = queue.then(async () => {
      state = 'loading'
      try { await action(); state = kind === 'start' ? 'online' : 'offline' }
      catch (error) {
        // Startup rollback belongs to the World; repeating it can stop modules
        // that were never started (notably the combined humanlike World).
        state = 'error'; throw error
      }
    }).finally(() => { if (tail?.promise === task) tail = undefined })
    tail = { kind, promise: task }; queue = task.catch(() => {})
    return task
  }
  world.start = host => enqueue('start', () => originalStart(host))
  world.stop = () => enqueue('stop', originalStop)
  world.tools = () => originalTools().map(tool => ({ ...tool, handler: async (args, context) => {
    calls++; activeCalls++; lastTool = tool.name
    const beganAt = performance.now()
    try {
      const result = await tool.handler(args, context)
      if (result && typeof result === 'object' && (('failed' in result && result.failed) || ('isError' in result && result.isError))) failures++
      return result
    } catch (error) { failures++; throw error }
    finally { activeCalls--; lastDurationMs = Math.max(0, Math.round(performance.now() - beganAt)) }
  } }))
  world.webUi = language => {
    let ui: WorldWebUiDecl = {}, renderFailed = false
    try { ui = originalUi?.(language) ?? {} } catch { renderFailed = true }
    const hint = state === 'online' ? '本地扩展已启动；外部能力请用工具核对' : state === 'loading' ? '扩展正在启动或停止' : state === 'error' ? '生命周期操作失败，请查看日志后重新挂载' : '扩展尚未启动或已停止'
    const visibleState = renderFailed ? 'error' : state
    const visibleHint = renderFailed ? '面板状态读取失败，请检查日志；配置与教程仍可查看' : hint
    const lamps: WorldLamp[] = ui.lamps?.length ? ui.lamps.map(lamp => visibleState === 'online' ? { ...lamp } : { ...lamp, state: visibleState, hint: visibleHint }) : [{ label: '扩展运行', state: visibleState, hint: visibleHint }]
    return { ...ui, lamps, config: completeConfig(world.id, defaults, ui, guide), badges: [...(ui.badges ?? []), { label: '工具调用', value: calls }, { label: '执行中', value: activeCalls }, { label: '异常回执', value: failures }, { label: '最近工具', value: lastTool || '尚未调用' }, { label: '最近完成耗时', value: `${lastDurationMs} ms` }] }
  }
  return world
}
