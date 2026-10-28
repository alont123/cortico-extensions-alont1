import { build } from 'esbuild'
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'tsx/esm/api'

register()
const { exportDescribe } = await import('cortico/extensions/describe-export.ts')
const root = fileURLToPath(new URL('../', import.meta.url))
mkdirSync(join(root, 'scratch/build'), { recursive: true })
const { mkdtempSync, rmSync } = await import('node:fs')
const scratch = mkdtempSync(join(root, 'scratch/build/run-'))
try {
  for (const name of readdirSync(join(root, 'packages')).sort()) {
    const dir = join(root, 'packages', name)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (!manifest.cortico) continue
    if (manifest.cortico.webUiClient) {
      const entry = name === 'cortico-bot-xiaoshen-alont1' ? 'webui/client.ts' : 'src/console/client.ts'
      await build({ entryPoints: [join(dir, entry)], outfile: join(dir, manifest.cortico.webUiClient), bundle: true,
        platform: 'browser', format: 'esm', target: 'es2022', minify: true, logLevel: 'warning' })
    }
    const definition = (await import(pathToFileURL(join(dir, manifest.main)).href)).default
    const description = await exportDescribe(manifest.cortico.kind, definition, { scratchDir: join(scratch, name), packageDir: dir, repoRoot: root })
    if (!description) throw new Error(`${name}: no describe metadata`)
    writeFileSync(join(dir, manifest.cortico.describe), JSON.stringify(description, null, 2) + '\n')
    console.log(`Built ${name}`)
  }
} finally { rmSync(scratch, { recursive: true, force: true }) }
