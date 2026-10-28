/**
 * 找框架 checkout 与部署目录。
 *
 * 规则（都不猜，找不到就说找不到）：
 *   · checkout：--repo 给了就用；否则从 cwd 往上找带 `bin/cortico.mjs` 且带 `deployments/` 的目录。
 *   · 部署：--deployment 给了就用 `<repo>/deployments/<name>`；否则用 `deployments/` 下
 *     唯一带 `config.json` 的那个；多于一个就报出来让调用方指定。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export function findRepo(from = process.cwd(), explicit) {
  if (explicit) {
    const dir = resolve(explicit)
    if (!looksLikeRepo(dir)) throw new Error(`--repo 指的不是一个 Cortico checkout：${dir}（要能看到 bin/cortico.mjs 与 deployments/）`)
    return dir
  }
  let dir = resolve(from)
  for (let i = 0; i < 8; i++) {
    if (looksLikeRepo(dir)) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  throw new Error(`没找到 Cortico checkout（从 ${from} 往上看了 8 层）。用 --repo <checkout 路径> 指定。`)
}

function looksLikeRepo(dir) {
  try {
    return existsSync(join(dir, 'bin', 'cortico.mjs')) && existsSync(join(dir, 'deployments'))
  } catch {
    return false
  }
}

export function findDeployment(repo, explicit) {
  const root = join(repo, 'deployments')
  if (explicit) {
    singleName(explicit, 'deployment')
    const dir = join(root, explicit)
    if (!existsSync(join(dir, 'config.json'))) throw new Error(`没有这个部署：${dir}（里面要有 config.json）`)
    return { name: explicit, dir }
  }
  const names = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
    .map((e) => e.name)
    .filter((name) => {
      try { return statSync(join(root, name, 'config.json')).isFile() } catch { return false }
    })
  if (names.length === 0) throw new Error(`${root} 下没有带 config.json 的部署`)
  if (names.length > 1) throw new Error(`这里有多个部署（${names.join('、')}），用 --deployment <名字> 指定一个`)
  return { name: names[0], dir: join(root, names[0]) }
}

/** 这个部署用的端点（共享 providers 目录里的那个）。找不到返回 null。 */
export function findProvider(repo, deploymentDir, activeName) {
  const roots = [join(deploymentDir, 'providers'), join(repo, 'deployments', 'providers')]
  if (activeName) singleName(activeName, 'activeProvider')
  const candidates = new Map()
  for (const root of roots) {
    if (!existsSync(root)) continue
    const names = activeName
      ? [activeName]
      : readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    for (const name of names) {
      const file = join(root, name, 'config.json')
      if (existsSync(file) && !candidates.has(name)) candidates.set(name, { name, file, dir: join(root, name) })
    }
  }
  if (candidates.size > 1) throw new Error('存在多个端点且未配置 activeProvider；请先指定当前端点，不会自动选择或修改其中一个')
  return [...candidates.values()][0] ?? null
}

function singleName(value, field) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/:\x00]/u.test(value) || /[. ]$/u.test(value)) throw new Error(`${field} 必须是单个目录名`)
}
