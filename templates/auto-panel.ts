/** ConfigGroup 标量与数值二元组声明；由 scripts/sync-panels.mjs 同步到独立发布包。 */
import type { ConfigGroup, ConfigProperty, WorldWebUiDecl } from 'cortico/core/types.ts'

export type AutoPanelFields = Record<string, Partial<Omit<ConfigProperty, 'type' | 'items'>>>

function propertyFor(value: unknown): ConfigProperty | undefined {
  const base = { title: '', 'x-hot': false }
  if (typeof value === 'string') return { ...base, type: 'string' }
  if (typeof value === 'boolean') return { ...base, type: 'boolean' }
  // 默认值为整数不能证明配置只接受整数，例如 cfg=3、maxFileMB=2。
  if (typeof value === 'number' && Number.isFinite(value)) return { ...base, type: 'number' }
  if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'number' && Number.isFinite(v)) && value[0] <= value[1]) {
    return { ...base, type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }
  }
  return undefined
}

export function autoWebUi(worldId: string, title: string, defaults: object, fields: AutoPanelFields = {}): WorldWebUiDecl {
  const properties: Record<string, ConfigProperty> = {}
  const unsupported: string[] = []
  const flatten = (value: object, prefix: string): void => {
    for (const [key, item] of Object.entries(value)) {
      // 根 enabled 由宿主激活/停用接口管理；普通配置保存不会同步挂载状态。
      // 子配置中的 enabled 是业务开关，仍须正常显示。
      if (!prefix && key === 'enabled') continue
      const path = prefix ? prefix + '.' + key : key
      const property = propertyFor(item)
      if (property) {
        properties['worlds.' + worldId + '.' + path] = { ...property, title: key, ...fields[path] }
      } else if (item && typeof item === 'object' && !Array.isArray(item)) {
        flatten(item, path)
      } else {
        unsupported.push(path)
      }
    }
  }
  flatten(defaults, '')
  const group: ConfigGroup = {
    id: 'world:' + worldId,
    owner: `world:${worldId}`,
    schema: {
      type: 'object',
      title,
      description: '启用或停用请使用宿主 World 页的激活/停用按钮。配置默认在重新挂载扩展后生效。'
        + (unsupported.length ? ' 以下配置需在 config.json 中编辑：' + unsupported.join('、') + '。' : ''),
      properties,
    },
  }
  return { config: [group] }
}
