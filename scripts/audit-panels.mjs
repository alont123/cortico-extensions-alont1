import { register } from 'tsx/esm/api'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
register()
const { fakeWorldContext, fakeLoadedConfig } = await import('cortico/extensions/dry-mount.ts')
const { coerceGroupValues, getByPath, isConfigGroup } = await import('cortico/core/config-schema.ts')
const root = fileURLToPath(new URL('../', import.meta.url))
mkdirSync(join(root, 'scratch'), { recursive: true }); mkdirSync(join(root, 'reports'), { recursive: true })
const scratch = mkdtempSync(join(root, 'scratch/panels-'))
const rows = [], previews = []
const entries = readdirSync(join(root, 'packages')).sort().map(name => ({ name, dir: join(root, 'packages', name) }))
const brain = join(root, 'addons/memory-brain')
if (existsSync(join(brain, 'package.json'))) entries.push({ name: 'cortico-world-memory-brain-alont1', dir: brain })
try {
  for (const { name, dir } of entries) {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const row = { name, kind: manifest.cortico?.kind ?? 'cli', issues: [], notes: [], fields: 0, tools: 0, tutorials: 0 }
    if (row.kind === 'cli') {
      row.tutorials = readFileSync(join(dir, 'README.md'), 'utf8').includes('中文使用教程') ? 1 : 0
      if (!row.tutorials) row.issues.push('缺中文使用教程')
      row.notes.push('命令行工具，教程由 --help/README 展示，没有 World 面板')
      rows.push(row); continue
    }
    const def = (await import(pathToFileURL(join(dir, manifest.main)).href)).default
    if (row.kind === 'bot') {
      const cfg = def.defaults(), parts = def.build(fakeLoadedConfig(cfg, { scratchDir: join(scratch, name), packageDir: dir }), [])
      const groups = parts.webUi?.configGroups ?? []
      row.tutorials = groups.filter(group => /中文使用教程/.test(group.schema.title)).length
      row.fields = groups.reduce((n, group) => n + Object.keys(group.schema.properties).length, 0)
      if (!row.tutorials) row.issues.push('缺中文使用教程')
      previews.push({ name, id: 'xiaoshen', title: '小深人格', kind: 'bot', lamps: [], config: groups.map(group => ({ group, values: Object.fromEntries(Object.entries(group.schema.properties).map(([key]) => [key, getByPath(cfg, key)])) })) })
      rows.push(row); continue
    }
    const ctx = fakeWorldContext(def, { scratchDir: join(scratch, name), packageDir: dir })
    const before = JSON.stringify(ctx.cfg)
    const world = def.create(ctx), ui = world.webUi?.('zh') ?? {}
    row.id = world.id; row.tools = world.tools().length
    const seen = new Set()
    for (const group of ui.config ?? []) {
      if (!isConfigGroup(group)) { row.issues.push('无效配置组'); continue }
      if (/中文使用教程/.test(group.schema.title)) row.tutorials++
      for (const [key, property] of Object.entries(group.schema.properties)) {
        row.fields++
        if (key === `worlds.${world.id}.enabled`) row.issues.push('根启用状态只能由宿主激活入口管理：' + key)
        if (world.id === 'humanlike' && /^worlds\.humanlike\.(affinity|learn|life|clock|together|mind|real)\.enabled$/.test(key)) row.issues.push('人味内置模块不支持独立启停：' + key)
        if (seen.has(key)) row.issues.push('重复配置路径：' + key)
        seen.add(key)
        const value = getByPath({ worlds: { [def.id]: def.defaults() } }, key)
        if (value === undefined) { row.issues.push('无默认值：' + key); continue }
        if (property.type === 'object') continue
        const result = coerceGroupValues({ ...group, schema: { ...group.schema, properties: { [key]: property } } }, { [key]: value }, 'zh')
        if ('error' in result) row.issues.push('默认值不能按面板原样保存：' + key + ' / ' + result.error)
        else if (JSON.stringify(result.values[key]) !== JSON.stringify(value)) {
          if (row.id === 'qqbot' && /^worlds\.qqbot\.(groups|privates|adminGroups)$/.test(key)) row.notes.push('账号名单支持字符串/数组两种形式：' + key)
          else row.issues.push('保存改变默认值类型/内容：' + key)
        }
      }
    }
    if (!row.tutorials) row.issues.push('缺中文使用教程')
    for (const doc of ui.promptDocs ?? []) if (!existsSync(doc.path)) row.issues.push('提示词文件不存在：' + doc.key)
    row.lampsBeforeStart = (ui.lamps ?? []).map(lamp => ({ label: lamp.label, state: lamp.state }))
    if (row.lampsBeforeStart.some(lamp => lamp.state === 'online')) row.issues.push('未启动即宣称在线')
    if (JSON.stringify(ctx.cfg) !== before) row.notes.push('构造对配置进行了规范化或补齐部署默认值')
    previews.push({ name, id: world.id, title: ui.label ?? def.label, kind: 'world', lamps: ui.lamps ?? [], config: (ui.config ?? []).map(group => ({ group, values: Object.fromEntries(Object.entries(group.schema.properties).map(([key]) => [key, getByPath({ worlds: { [def.id]: def.defaults() } }, key)])) })) })
    rows.push(row)
  }
} finally { rmSync(scratch, { recursive: true, force: true }) }
writeFileSync(join(root, 'reports/panels.json'), JSON.stringify(rows, null, 2) + '\n')
writeFileSync(join(root, 'reports/panel-preview.json'), JSON.stringify(previews, null, 2) + '\n')
for (const row of rows) console.log(`${row.name}: ${row.fields} 配置 / ${row.tools} 工具 / ${row.tutorials} 教程${row.issues.length ? ' — ' + row.issues.join('；') : ''}`)
console.log(`${rows.length} packages; ${rows.filter(row => row.kind === 'world').length} worlds; ${rows.reduce((n, row) => n + row.issues.length, 0)} findings`)
if (process.argv.includes('--check') && rows.some(row => row.issues.length)) process.exitCode = 1
