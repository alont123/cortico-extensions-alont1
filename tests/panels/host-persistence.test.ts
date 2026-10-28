import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { WorldAssembly, type WorldContext, type WorldDefinition } from 'cortico/world.ts'
import { CORE_DEFAULTS, type LoadedConfig } from 'cortico/core/config.ts'
import type { CoreConfig, World, WorldHost } from 'cortico/core/types.ts'
import { coerceGroupValues, readGroupValues, setByPath, type ConfigGroup } from 'cortico/core/config-schema.ts'
import { updateJsonObject } from 'cortico/config-file.ts'
import { autoWebUi } from '../../templates/auto-panel.ts'
import { withWorldPanel } from '../../templates/panel-runtime.ts'

type FixtureSection = { enabled: boolean; pollSec: number; feature: { enabled: boolean } }
type FixtureConfig = CoreConfig & { worlds: { fixture: FixtureSection } }
const guide = { title: '本地验证', purpose: '验证重载', setup: '宿主激活', firstUse: '查看状态', troubleshoot: '查看日志' }
const worldHost = {} as WorldHost
const legacyGroup: ConfigGroup = {
  id: 'world:fixture', owner: 'world:fixture', schema: {
    type: 'object', title: '旧版表单', properties: {
      'worlds.fixture.enabled': { type: 'boolean', title: '启用' },
      'worlds.fixture.pollSec': { type: 'number', title: '检查间隔' },
      'worlds.fixture.feature.enabled': { type: 'boolean', title: '业务功能' },
    },
  },
}

function fixture(t: TestContext, legacy = false) {
  const tempRoot = resolve(tmpdir())
  const dir = mkdtempSync(join(tempRoot, 'cortico-host-persistence-'))
  const configFile = join(dir, 'config.json')
  const contexts: WorldContext<FixtureSection>[] = []
  const assemblies: WorldAssembly[] = []
  const base: WorldDefinition<FixtureSection> = {
    id: 'fixture', label: '本地验证',
    defaults: () => ({ enabled: false, pollSec: 30, feature: { enabled: false } }),
    create(ctx) {
      contexts.push(ctx)
      return {
        id: 'fixture', envPromptVars: () => ({}), tools: () => [],
        async start() {}, async stop() {},
        webUi: () => legacy ? { config: [structuredClone(legacyGroup)] }
          : autoWebUi('fixture', '本地验证', base.defaults()),
      }
    },
  }
  const definition = legacy ? base : withWorldPanel(base, guide)
  const initial: FixtureConfig = { ...structuredClone(CORE_DEFAULTS), worlds: { fixture: base.defaults() } }
  writeFileSync(configFile, JSON.stringify(initial), 'utf8')
  function assemble() {
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as FixtureConfig
    const loaded: LoadedConfig<FixtureConfig> = {
      config, rootDir: dir, dataDir: dir, memoryDir: dir, secret: () => '',
    }
    // Only the platform mount adapter is controlled. Assembly, config coercion,
    // shared live references and atomic disk persistence use production code.
    const assembly = new WorldAssembly(loaded, [definition], [])
    assembly.bind({
      async mount(world: World) {
        await world.start(worldHost)
        if (!assembly.mounted.includes(world)) assembly.mounted.push(world)
      },
      async unmount(id: string) {
        const index = assembly.mounted.findIndex(world => world.id === id)
        if (index < 0) return
        await assembly.mounted[index].stop()
        assembly.mounted.splice(index, 1)
      },
    })
    assemblies.push(assembly)
    return { assembly, loaded }
  }
  t.after(async () => {
    for (const assembly of assemblies) for (const world of assembly.mounted) await world.stop()
    const withinTemp = relative(tempRoot, resolve(dir))
    assert.ok(withinTemp && !withinTemp.startsWith('..') && !withinTemp.includes(':'))
    rmSync(dir, { recursive: true, force: true })
  })
  // Equivalent to /api/config: coerce against the current declaration, then
  // update the live config and config.json. This operation does not activate.
  function save(loaded: LoadedConfig<FixtureConfig>, group: ConfigGroup, body: Record<string, unknown>) {
    const result = coerceGroupValues(group, body)
    assert.ok('values' in result)
    for (const [path, value] of Object.entries(result.values)) setByPath(loaded.config as unknown as Record<string, unknown>, path, value)
    updateJsonObject(configFile, raw => {
      for (const [path, value] of Object.entries(result.values)) setByPath(raw, path, value)
    })
    return result.values
  }
  return { assemble, save, latestContext: () => contexts.at(-1)!,
    disk: () => JSON.parse(readFileSync(configFile, 'utf8')) as FixtureConfig }
}

test('reproduction: a stale legacy config group silently disables the next process startup', async t => {
  const f = fixture(t, true), { assembly, loaded } = f.assemble()
  const staleForm = readGroupValues(loaded.config, legacyGroup)
  assert.equal(staleForm['worlds.fixture.enabled'], false)
  await assembly.activate('fixture')
  assert.equal(f.disk().worlds.fixture.enabled, true)

  f.save(loaded, legacyGroup, { ...staleForm, 'worlds.fixture.pollSec': 60 })
  assert.equal(assembly.slot('fixture').mounted, true, 'ordinary config saves do not unmount')
  assert.equal(f.disk().worlds.fixture.enabled, false)
  await assembly.restart('fixture')
  assert.equal(assembly.slot('fixture').mounted, true, 'explicit restart itself does not clear enabled')
  const originalContext = f.latestContext()
  assert.equal(f.assemble().assembly.slot('fixture').mounted, false, 'a new process obeys the saved false')
  // Extension reload actions also obey the live false value.
  await originalContext.restart()
  assert.equal(assembly.slot('fixture').mounted, false)
})

test('fixed config forms preserve activation through business saves, world reload and process restart', async t => {
  const f = fixture(t), { assembly, loaded } = f.assemble()
  const groups = assembly.slot('fixture').instance.webUi!().config!
  assert.ok(groups.every(group => !('worlds.fixture.enabled' in group.schema.properties)))
  const group = groups.find(item => 'worlds.fixture.pollSec' in item.schema.properties)!
  const staleForm = readGroupValues(loaded.config, group)
  await assembly.activate('fixture')
  const saved = f.save(loaded, group, {
    ...staleForm, 'worlds.fixture.pollSec': 60,
    'worlds.fixture.feature.enabled': true,
    // An old browser tab may still submit the deleted root switch. Current
    // server-side schema coercion must ignore it rather than disabling startup.
    'worlds.fixture.enabled': false,
  })
  assert.equal(saved['worlds.fixture.enabled'], undefined)
  assert.equal(loaded.config.worlds.fixture.enabled, true)
  assert.equal(loaded.config.worlds.fixture.feature.enabled, true)
  assert.equal(f.disk().worlds.fixture.enabled, true)
  await f.latestContext().restart()
  assert.equal(assembly.slot('fixture').mounted, true)
  await assembly.restart('fixture')
  assert.equal(assembly.slot('fixture').mounted, true)
  assert.equal(f.disk().worlds.fixture.enabled, true)
  const restarted = f.assemble()
  assert.equal(restarted.assembly.slot('fixture').mounted, true)
  assert.equal(restarted.loaded.config.worlds.fixture.pollSec, 60)
  assert.equal(restarted.loaded.config.worlds.fixture.feature.enabled, true)
})

test('explicit host deactivation remains off after reload; the panel never auto-enables it', async t => {
  const f = fixture(t), { assembly } = f.assemble()
  await assembly.activate('fixture')
  await assembly.deactivate('fixture')
  assert.equal(assembly.slot('fixture').mounted, false)
  assert.equal(f.disk().worlds.fixture.enabled, false)
  await f.latestContext().restart()
  assert.equal(assembly.slot('fixture').mounted, false)
  assert.equal(f.assemble().assembly.slot('fixture').mounted, false)
})
