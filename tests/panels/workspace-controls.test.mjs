import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { createWebUi } from 'cortico/web/client/ui/index.ts'
import { createWorkspacePanel } from '../../packages/cortico-bot-xiaoshen-alont1/webui/workspace.ts'
import { GitWorkspaceMemory } from '../../packages/cortico-bot-xiaoshen-alont1/persona/memory.ts'
import { workspaceInvoke } from '../../packages/cortico-bot-xiaoshen-alont1/persona/webUiSurface.ts'

const settle = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

/** Real panel, SDK controls and workspace service; only transport timing/failure is controlled. */
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cortico-workspace-buttons-'))
  const dom = new JSDOM('<!doctype html><body><main></main></body>', { url: 'http://localhost/' })
  const controller = new dom.window.AbortController()
  const previousCSS = globalThis.CSS
  const previousAbortController = globalThis.AbortController
  // jsdom 26 omits CSS.escape; these fixtures use only simple ASCII file names.
  globalThis.CSS = { escape: value => {
    assert.match(value, /^[a-z]+\.md$/)
    return value
  } }
  globalThis.AbortController = dom.window.AbortController
  t.after(() => {
    controller.abort()
    dom.window.close()
    if (previousCSS === undefined) delete globalThis.CSS
    else globalThis.CSS = previousCSS
    globalThis.AbortController = previousAbortController
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()))
    rmSync(dir, { recursive: true, force: true })
  })
  writeFileSync(join(dir, 'a.md'), 'original a')
  writeFileSync(join(dir, 'b.md'), 'original b')
  const memory = new GitWorkspaceMemory({ memoryDir: dir })
  const rpc = workspaceInvoke(memory, 'zh')
  const root = dom.window.document.querySelector('main')
  const memoValues = new Map()
  const memo = { get: (key, fallback) => memoValues.has(key) ? memoValues.get(key) : fallback, set: (key, value) => memoValues.set(key, value) }
  const ui = createWebUi({ memo, overlayHost: dom.window.document.body, signal: controller.signal })
  const calls = []
  let transport = async (_method, _args, dispatch) => dispatch()
  const ctx = {
    root, ui, memo, language: 'zh', signal: controller.signal,
    guardLeave: () => ({ dispose() {} }),
    invoke: (method, args = []) => {
      calls.push({ method, args: structuredClone(args) })
      return transport(method, args, () => rpc('workspace', method, args))
    },
  }
  createWorkspacePanel().mount(ctx)
  await settle()
  const button = (label, scope = root) => {
    const found = [...scope.querySelectorAll('button')].find(node => node.textContent === label)
    assert.ok(found, `button ${label} exists`)
    return found
  }
  const editor = () => root.querySelector('textarea.ct-textarea')
  const edit = (value) => {
    editor().value = value
    editor().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  }
  const open = async (path) => {
    root.querySelector(`.treerow[data-path="${path}"]`).click()
    await settle()
    const confirm = dom.window.document.querySelector('.confirm-card button.danger')
    if (confirm) { confirm.click(); await settle() }
  }
  return { dir, root, calls, button, editor, edit, open, abort: () => controller.abort(), transport: fn => { transport = fn } }
}

test('workspace refresh reports transport failure without losing the edited draft', async t => {
  const f = await fixture(t)
  await f.open('a.md')
  f.edit('unsaved draft')
  f.transport(async (method, _args, dispatch) => {
    if (method === 'tree') throw new Error('fixture connection unavailable')
    return dispatch()
  })
  f.button('刷新').click()
  await settle()
  assert.match(f.root.querySelector('.msgline').textContent, /fixture connection unavailable/)
  assert.equal(f.root.querySelector('.msgline').classList.contains('bad'), true)
  assert.equal(f.editor().value, 'unsaved draft')
  assert.ok(f.root.querySelector('.treerow[data-path="a.md"]'))
})

for (const samePath of [false, true]) {
  test(`a delayed save cannot replace the ${samePath ? 'reopened same file' : 'next file'} revision or draft`, async t => {
    const f = await fixture(t)
    await f.open('a.md')
    f.edit('saved a')
    const hold = deferred()
    let firstWrite = true
    f.transport(async (method, _args, dispatch) => {
      const result = await dispatch()
      if (method === 'write' && firstWrite) { firstWrite = false; await hold.promise }
      return result
    })
    f.button('保存').click()
    await settle()
    const current = samePath ? 'a.md' : 'b.md'
    if (samePath) writeFileSync(join(f.dir, current), 'external newer a')
    await f.open(current)
    const baseline = samePath ? 'external newer a' : 'original b'
    assert.equal(f.editor().value, baseline)
    f.edit('new draft')
    hold.resolve()
    await settle()
    assert.equal(f.editor().value, 'new draft')
    f.button('保存').click()
    await settle()
    assert.equal(readFileSync(join(f.dir, current), 'utf8'), 'new draft')
    assert.equal(f.root.querySelector('.msgline').classList.contains('bad'), false)
  })
}

test('typing while a save is pending keeps the newer draft and does not send duplicate writes', async t => {
  const f = await fixture(t)
  await f.open('a.md')
  f.edit('first edit')
  const hold = deferred()
  let firstWrite = true
  f.transport(async (method, _args, dispatch) => {
    const result = await dispatch()
    if (method === 'write' && firstWrite) { firstWrite = false; await hold.promise }
    return result
  })
  f.button('保存').click()
  await settle()
  f.edit('newer edit')
  f.button('保存').click()
  await settle()
  assert.equal(f.calls.filter(call => call.method === 'write').length, 1)
  hold.resolve()
  await settle()
  assert.equal(f.editor().value, 'newer edit')
  assert.equal(f.button('保存').disabled, false)
  f.button('保存').click()
  await settle()
  assert.equal(readFileSync(join(f.dir, 'a.md'), 'utf8'), 'newer edit')
})

test('a save response after unmount does not mutate the disposed panel', async t => {
  const f = await fixture(t)
  await f.open('a.md')
  f.edit('saved while leaving')
  const hold = deferred()
  f.transport(async (method, _args, dispatch) => {
    const result = await dispatch()
    if (method === 'write') await hold.promise
    return result
  })
  f.button('保存').click()
  await settle()
  f.abort()
  const snapshot = f.root.innerHTML
  hold.resolve()
  await settle()
  assert.equal(f.root.innerHTML, snapshot)
})
