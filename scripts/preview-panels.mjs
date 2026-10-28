/** 使用已安装 Core 的真实配置渲染器；纯预览，所有写入留在浏览器模拟响应里。 */
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url))
const data = readFileSync(join(root, 'reports/panel-preview.json'), 'utf8').replaceAll('<', '\\u003c')
const result = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
import { createConfigView } from './node_modules/cortico/src/web/client/features/config/view.ts'
import { createWebUi } from './node_modules/cortico/src/web/client/ui/index.ts'
import { Lifecycle } from './node_modules/cortico/src/web/client/core/lifecycle.ts'
const entries = ${data}
let current = entries.find(e => e.id === 'todo') ?? entries[0], lifetime
window.previewWrites = []
window.fetch = async (input, init = {}) => {
  const path = String(input)
  if (path === '/api/config') {
    if (init.method === 'POST') { window.previewWrites.push(JSON.parse(init.body)); return new Response(JSON.stringify({ result: '预览已保存；未写入真实部署' }), { headers: { 'content-type': 'application/json' } }) }
    return new Response(JSON.stringify({ groups: current.config }), { headers: { 'content-type': 'application/json' } })
  }
  if (path.startsWith('/api/config/options/')) return new Response(JSON.stringify({ items: [] }), { headers: { 'content-type': 'application/json' } })
  throw new Error('预览禁止连接真实服务：' + path)
}
const select = document.querySelector('#package-select')
for (const entry of entries) { const option = document.createElement('option'); option.value = entry.id; option.textContent = entry.title + ' · ' + entry.id; select.append(option) }
select.value = current.id
async function render() {
  lifetime?.dispose(); lifetime = new Lifecycle()
  const ui = createWebUi({ memo: { get: (_key, fallback) => fallback, set() {}, remove() {} }, overlayHost: document.body, signal: lifetime.signal })
  const view = createConfigView({ ui, lifecycle: lifetime, signal: lifetime.signal, showOwner: false })
  document.querySelector('#config-root').replaceChildren(view.el)
  document.querySelector('#panel-name').textContent = current.title
  document.querySelector('#lamps').replaceChildren(...current.lamps.map(lamp => { const node = document.createElement('span'); node.className = 'lamp ' + lamp.state; node.textContent = lamp.label + ' · ' + ({ online: '在线', offline: '未启动', loading: '处理中', error: '错误' }[lamp.state]); node.title = lamp.hint ?? ''; return node }))
  await view.load(); window.previewReady = current.id
}
select.addEventListener('change', () => { current = entries.find(e => e.id === select.value); void render() })
void render().catch(error => { document.querySelector('#config-root').textContent = String(error) })
` }, bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022', minify: true, logLevel: 'warning' })
const js = result.outputFiles[0].text.replaceAll('</script', '<\\/script')
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>扩展面板中文教程 · 隔离预览</title><style>
:root{color-scheme:dark;font-family:system-ui,"Microsoft YaHei",sans-serif;background:#10151d;color:#e5edf7;font-size:15px}body{max-width:1120px;margin:0 auto;padding:28px 24px 70px}h1{font-size:25px;margin:0 0 10px}.notice{color:#a6b4c8;line-height:1.7;margin:0 0 22px}header{display:flex;align-items:center;gap:18px;flex-wrap:wrap}select,input,button,textarea{font:inherit;background:#1c2736;color:#e5edf7;border:1px solid #3c4c62;border-radius:7px;padding:8px 10px;max-width:100%;box-sizing:border-box}#package-select{min-width:240px}.lamp{display:inline-block;padding:5px 10px;margin:9px 10px 10px 0;border-radius:30px;font-size:12px;background:#263246;color:#b9c7d9}.lamp.online{color:#8de2bb;background:#1e4639}#config-root{background:#151e2a;border:1px solid #2f4055;border-radius:16px;padding:20px 24px}.tsection{font-weight:650;font-size:18px;padding:17px 0 12px;border-bottom:1px solid #2b3a4e}.tsection:first-child{padding-top:0}.tsecdesc{line-height:1.85;color:#c1cfdf;padding:16px 18px;margin:12px 0 18px;background:#1c3040;border-left:3px solid #6ab8b0;border-radius:7px;overflow-wrap:anywhere}.trow{display:grid;grid-template-columns:210px minmax(180px,1fr) minmax(190px,1.4fr);align-items:start;gap:16px;padding:14px 0;border-bottom:1px solid #233145}.tlabel{font-size:14px;padding-top:7px}.ttag{font-size:11px;color:#8fb0ce;display:block;margin-top:5px}.tdesc{font-size:12px;line-height:1.65;color:#8e9db2;padding-top:6px}.tfield{display:flex;align-items:center;gap:6px}.tfield>input,.tfield>select{width:100%;min-width:0}.tunit{font-size:12px;color:#9baac0}.actions{padding-top:18px}.msgline{color:#91dabb}.pairfield{display:flex;gap:6px}.placeholder{color:#9baac0;padding:12px}#panel-name{font-size:20px;margin:22px 0 5px}button{cursor:pointer}@media(max-width:760px){body{padding:18px 12px}#config-root{padding:14px}.trow{grid-template-columns:1fr}.tdesc{padding:0}.tlabel{padding:0}.ttag{display:inline;margin-left:8px}.tsecdesc{padding:12px}}
</style><h1>扩展面板与中文教程</h1><p class="notice">隔离预览：使用 Cortico 0.2.1 原有配置渲染器，显示默认值与未启动状态。表单修改仅产生浏览器内模拟回执，不写入部署，不连接 QQ、桌面或外部服务。正式教程位于每个扩展的“配置”页顶部。</p><header><label for="package-select">选择扩展</label><select id="package-select"></select></header><h2 id="panel-name"></h2><div id="lamps"></div><main id="config-root"></main><script>${js}</script></html>`
writeFileSync(join(root, 'reports/panel-preview.html'), html)
console.log(`Core renderer preview: ${JSON.parse(data).length} panels, ${Buffer.byteLength(html)} bytes`)
