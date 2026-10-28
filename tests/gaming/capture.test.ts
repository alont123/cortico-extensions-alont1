import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GAMING_DEFAULTS } from '../../packages/cortico-world-gaming-alont1/src/config.ts'
import { GamingWorld } from '../../packages/cortico-world-gaming-alont1/src/world.ts'
import { ScreenWatcher } from '../../packages/cortico-world-gaming-alont1/src/screen.ts'
import { captureWindow, CaptureError, captureErrorText, parseCaptureOutput, windowTargetHead, type CaptureErrorCode, type PowerShellRunner } from '../../packages/cortico-world-gaming-alont1/src/capture.ts'
import { captureFrames, pickFrames } from '../../packages/cortico-world-gaming-alont1/src/storyboard.ts'
import { matchGame, looksLikeGame } from '../../packages/cortico-world-gaming-alont1/src/tracker-logic.ts'
import { parseGameLine, buildGameLibrary } from '../../packages/cortico-world-gaming-alont1/src/games-lib.ts'
import { normalizeProcess } from '../../packages/cortico-world-gaming-alont1/src/proc.ts'
import type { WorldHost } from 'cortico/core/types.ts'

const game = { id: 'endfield', name: '终末地', processes: [' " Endfield.EXE " '], aliases: [] }
const sample = { pid: 1, proc: 'SearchHost', desc: '', title: 'Windows 搜索' }
const reading = { at: Date.now(), phase: 'other' as const, scene: '测试画面', speak: false, moment: '', raw: '' }
type Internals = {
  tracker: { current: () => unknown }; watcher: { latest: () => typeof sample }
  screen: ScreenWatcher; host: WorldHost; maybeLook: () => Promise<void>
}
const forbidden = /powershell|Command failed|[A-Z]:\\|gaming-screen-|gaming-frames-|private-token/i
function simulatedWindowsScreen(t: test.TestContext, options: ConstructorParameters<typeof ScreenWatcher>[0] & { runPowerShell: PowerShellRunner }): ScreenWatcher {
  const screen = new ScreenWatcher(options)
  // 捕获流程使用注入的离线 runner；仅模拟 Windows 就绪门禁，真实门禁另行验证。
  t.mock.method(screen, 'blockedReason', () => '')
  return screen
}

test('readiness preserves native platform and configuration guards without capture or vision calls', async t => {
  const cfg = structuredClone(GAMING_DEFAULTS.watch); cfg.enabled = true; cfg.model = 'fake'
  let captures = 0
  const runPowerShell: PowerShellRunner = async () => { captures++; throw Error('Capture must not run') }
  t.mock.method(globalThis, 'fetch', async () => { throw Error('Vision must not run') })
  const screen = new ScreenWatcher({ cfg, apiKey: 'fake', runPowerShell })
  assert.equal(screen.blockedReason(), process.platform === 'win32' ? '' : '只在 Windows 上能抓图')
  assert.equal(screen.ready(), process.platform === 'win32')
  if (process.platform !== 'win32') assert.equal(await screen.look('Endfield', '终末地', undefined), null)
  for (const [options, reason] of [
    [{ cfg: { ...cfg, enabled: false }, apiKey: 'fake', runPowerShell }, '看画面没开'],
    [{ cfg: { ...cfg, model: '' }, apiKey: 'fake', runPowerShell }, '没配视觉模型名'],
    [{ cfg, apiKey: '', runPowerShell }, '没配视觉模型的密钥'],
  ] as const) {
    const blocked = new ScreenWatcher(options)
    assert.equal(blocked.blockedReason(), reason)
    assert.equal(blocked.ready(), false)
    assert.equal(await blocked.look('Endfield', '终末地', undefined), null)
  }
  assert.equal(captures, 0)
})

async function worldFixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(),'gaming-world-'))
  t.after(() => rm(dir,{recursive:true,force:true}))
  const cfg = structuredClone(GAMING_DEFAULTS)
  cfg.games = [structuredClone(game)]; cfg.watch.enabled = true; cfg.watch.model = 'fake-vision'
  let captures = 0
  const screen = simulatedWindowsScreen(t, {cfg:cfg.watch,apiKey:'test-key',runPowerShell:async()=>{ captures++; return '{"ok":false,"code":"NOHWND"}' }})
  const world = new GamingWorld({cfg,dataDir:dir,timezone:'Asia/Shanghai',apiKey:'test-key'})
  const internal = world as unknown as Internals
  internal.tracker.current = () => ({gameId:game.id,name:game.name,minutes:1})
  internal.watcher.latest = () => sample
  internal.screen = screen as Internals['screen']
  internal.host = {} as WorldHost
  return {world,internal,cfg,dir,captures:()=>captures,tool:(name:string)=>world.tools().find(tool=>tool.name===name)!}
}

test('SearchHost + retained game session: manual and automatic look launch zero PowerShell calls', async t => {
  const f=await worldFixture(t)
  const reply=await f.tool('gaming_look').handler({},{} as never)
  assert.match(String(reply),/没把「终末地」放在前台.*Windows 搜索/)
  await f.internal.maybeLook()
  assert.equal(f.captures(),0)
})
test('normalized actual game process permits manual and automatic capture', async t => {
  const f=await worldFixture(t)
  f.internal.watcher.latest=()=>({...sample,proc:'ENDFIELD.exe',title:'终末地'})
  await f.tool('gaming_look').handler({},{} as never)
  await f.internal.maybeLook()
  assert.equal(f.captures(),2)
})
test('empty quoted process pin cannot bypass the foreground guard',async t=>{
  const f=await worldFixture(t);f.cfg.watch.target='" "'
  assert.match(String(await f.tool('gaming_watch_window').handler({target:'" "'},{} as never)),/给 target/)
  assert.match(String(await f.tool('gaming_look').handler({},{} as never)),/没把/)
  await f.internal.maybeLook();assert.equal(f.captures(),0)
})
for (const pin of [{target:'notepad.EXE'},{title:'专用窗口'},{target:'notepad',title:'专用窗口'}]) {
  test('explicit pin bypasses the game-process guard in both paths: '+JSON.stringify(pin),async t=>{
    const f=await worldFixture(t)
    let looks=0
    t.mock.method(f.internal.screen,'look',async (...[_proc,_name,_watch,_previous,target,title]:Parameters<ScreenWatcher['look']>)=>{looks++;assert.equal(target,normalizeProcess(pin.target));assert.equal(title,pin.title??'');return reading})
    await f.tool('gaming_watch_window').handler(pin,{} as never)
    await f.tool('gaming_look').handler({},{} as never)
    await f.internal.maybeLook()
    assert.equal(looks,2)
    await f.tool('gaming_watch_window').handler({clear:true},{} as never)
    assert.match(String(await f.tool('gaming_look').handler({},{} as never)),/没把/)
    assert.equal(looks,2)
  })
}
test('manual title replaces the entire configured pin, without retaining its process restriction',async t=>{
  const f=await worldFixture(t); f.cfg.watch.target='chrome';f.cfg.watch.targetTitle='旧标题'
  t.mock.method(f.internal.screen,'look',async (...[_p,_n,_w,_s,target,title]:Parameters<ScreenWatcher['look']>)=>{assert.equal(target,'');assert.equal(title,'新标题');return reading})
  await f.tool('gaming_watch_window').handler({title:'新标题'},{} as never)
  await f.tool('gaming_look').handler({},{} as never)
})
test('library, tracker and non-game guard share process normalization',async t=>{
  const f=await worldFixture(t)
  assert.equal(matchGame({...sample,proc:'Endfield'},[game])?.id,game.id)
  assert.equal(looksLikeGame({...sample,proc:' " SearchHost.EXE " '},f.cfg),false)
  assert.deepEqual(parseGameLine('" Endfield.exe "|终末地')?.processes,['endfield'])
  assert.equal(buildGameLibrary({games:[game,{...game,id:'duplicate',processes:['endfield']}]},f.dir).games.length,1)
  assert.match(String(await f.tool('gaming_library').handler({action:'add',process:'ENDFIELD.exe'},{} as never)),/已经有/)
  assert.match(String(await f.tool('gaming_now').handler({},{} as never)),/终末地/)
  assert.equal(typeof await f.tool('gaming_recent').handler({},{} as never),'string')
})

const opts={proc:'SearchHost',target:'',frames:3,intervalMs:0,maxWidth:200,outDir:'',timeoutMs:1000}
for (const pin of [{target:' " Endfield.EXE " ',targetTitle:''},{target:'',targetTitle:"My Window's NAME"},{target:'endfield',targetTitle:'专用窗口'}]) {
  test('single/multi use identical strict selector: '+JSON.stringify(pin),async t=>{
    const dir=await mkdtemp(join(tmpdir(),'gaming-selector-'));t.after(()=>rm(dir,{recursive:true,force:true}))
    const scripts:string[]=[]
    const run:PowerShellRunner=async script=>{scripts.push(script);return '{"ok":false,"code":"NOHWND"}'}
    await assert.rejects(captureWindow({...opts,...pin,file:join(dir,'single.png')},run),CaptureError)
    await captureFrames({...opts,...pin,outDir:dir},run)
    assert.equal(scripts.length,2)
    const head=windowTargetHead({...opts,...pin})
    assert.ok(scripts.every(script=>script.startsWith(head)))
    assert.match(head,/\$RequireForeground = \$false/)
    if(!pin.target) assert.match(head,/\$WindowProcess = ''/)
    assert.ok(scripts.every(script=>script.includes('[GamingCapture]::FindWindow($WindowProcess,$WindowTitle)')))
  })
}
test('automatic selection is normalized and requires foreground',()=>{
  assert.equal(windowTargetHead({proc:' " Endfield.EXE " '}),"$WindowProcess = 'endfield'\n$WindowTitle = ''\n$RequireForeground = $true")
})
for(const code of ['NOHWND','NOT_FOREGROUND','MINIMIZED','CAPTURE_FAIL','CAPTURE_TIMEOUT','SCRIPT_FAIL'] as CaptureErrorCode[]) {
  test('multi capture '+code+' preserves safe reason without retry or vision call',async t=>{
    const cfg=structuredClone(GAMING_DEFAULTS.watch);cfg.enabled=true;cfg.model='fake';cfg.framesPerLook=3
    let calls=0
    const screen=simulatedWindowsScreen(t, {cfg,apiKey:'fake',runPowerShell:async()=>{calls++;return JSON.stringify({ok:false,code,error:'Command failed: powershell.exe D:\\private-token\\gaming-frames-'})}})
    t.mock.method(globalThis,'fetch',async()=>{throw Error('Vision must not run')})
    assert.equal(await screen.look('Endfield','终末地',undefined),null)
    assert.equal(screen.errorText(),captureErrorText(code));assert.doesNotMatch(screen.errorText(),forbidden)
    assert.equal(calls,1)
  })
}
for(const output of ['Command failed: powershell.exe D:\\private-token','{"ok":false,"code":"D:\\\\private-token"}','null','[]','{bad-json']) {
  test('unknown/malformed capture output never becomes a raw user error: '+output.slice(0,20),async t=>{
    const cfg=structuredClone(GAMING_DEFAULTS.watch);cfg.enabled=true;cfg.model='fake';cfg.framesPerLook=1
    const screen=simulatedWindowsScreen(t, {cfg,apiKey:'fake',runPowerShell:async()=>output})
    assert.equal(await screen.look('Endfield','终末地',undefined),null)
    assert.doesNotMatch(screen.errorText(),forbidden)
    assert.ok(screen.errorText())
  })
}
test('capture callback errors, including timeout, remain typed and sanitized',async t=>{
  const cfg=structuredClone(GAMING_DEFAULTS.watch);cfg.enabled=true;cfg.model='fake';cfg.framesPerLook=3
  const screen=simulatedWindowsScreen(t, {cfg,apiKey:'fake',runPowerShell:async()=>{throw new CaptureError('CAPTURE_TIMEOUT')}})
  assert.equal(await screen.look('Endfield','终末地',undefined),null)
  assert.match(screen.errorText(),/超时/)
  assert.throws(()=>parseCaptureOutput('powershell.exe D:\\private-token'),CaptureError)
})
test('partial multi-frame failure discards all frames',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'gaming-partial-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const result=await captureFrames({...opts,outDir:dir},async()=>'{"ok":false,"code":"NOT_FOREGROUND","frames":[{"file":"private-token"}]}')
  assert.equal(result.code,'NOT_FOREGROUND');assert.deepEqual(result.frames,[])
})

test('only post-capture image failure falls back to single; pinned prompt and temp cleanup preserved',async t=>{
  const cfg=structuredClone(GAMING_DEFAULTS.watch);cfg.enabled=true;cfg.model='fake';cfg.framesPerLook=3
  let calls=0,shot='';let request=''
  const screen=simulatedWindowsScreen(t, {cfg,apiKey:'fake',runPowerShell:async script=>{
    calls++
    if(calls===1) return '{"ok":true,"frames":[{"file":"not-existing-fixture.png","t":1,"hash":"00","luma":20}]}'
    shot=/\$Out = '([^']+)'/.exec(script)![1]!
    await writeFile(shot,Buffer.from('fake-image'))
    return '{"ok":true}'
  }})
  t.mock.method(globalThis,'fetch',async(_url:Parameters<typeof fetch>[0],init?:RequestInit)=>{request=String(init?.body);return new Response(JSON.stringify({choices:[{message:{content:'画面：专用窗口\n局面：其他\n可说：否\n因由：无'}}]}))})
  const result=await screen.look('SearchHost','终末地',undefined,undefined,'','专用窗口')
  assert.equal(result?.scene,'专用窗口');assert.equal(calls,2);assert.match(request,/手动指定窗口/)
  assert.match(request,/不保证属于当前游戏/);assert.equal(screen.errorText(),'')
  await assert.rejects(readFile(shot),{code:'ENOENT'})
})
test('vision HTTP failure neither leaks body nor recaptures',async t=>{
  const cfg=structuredClone(GAMING_DEFAULTS.watch);cfg.enabled=true;cfg.model='fake';cfg.framesPerLook=1
  let calls=0
  const screen=simulatedWindowsScreen(t, {cfg,apiKey:'fake',runPowerShell:async script=>{calls++;await writeFile(/\$Out = '([^']+)'/.exec(script)![1]!,Buffer.from('fixture'));return '{"ok":true}'}})
  t.mock.method(globalThis,'fetch',async()=>new Response('powershell.exe D:\\private-token',{status:401}))
  assert.equal(await screen.look('Endfield','终末地',undefined),null)
  assert.equal(calls,1);assert.match(screen.errorText(),/HTTP 401/);assert.doesNotMatch(screen.errorText(),forbidden)
})
for(const composeOk of [true,false]) {
  test('successful multi capture '+(composeOk?'composes a grid':'uses the last existing frame after compose failure')+' with one vision request',async t=>{
    const cfg=structuredClone(GAMING_DEFAULTS.watch);cfg.enabled=true;cfg.model='fake';cfg.framesPerLook=2
    let calls=0,requests=0,usage=0,directory='';let body=''
    const screen=simulatedWindowsScreen(t, {cfg,apiKey:'fake',runPowerShell:async script=>{
      calls++
      if(calls===1) {
        directory=/\$FramesDir = '([^']+)'/.exec(script)![1]!
        const frames=[{file:join(directory,'f1.png'),t:1,hash:'00',luma:20},{file:join(directory,'f2.png'),t:2,hash:'ff',luma:40}]
        for(const frame of frames) await writeFile(frame.file,Buffer.from('fixture'))
        return JSON.stringify({ok:true,frames})
      }
      assert.match(script,/\$Files = @/)
      if(composeOk)await writeFile(/\$Out = '([^']+)'/.exec(script)![1]!,Buffer.from('grid'))
      return JSON.stringify({ok:composeOk})
    }})
    screen.setUsageSink(()=>{usage++})
    t.mock.method(globalThis,'fetch',async(_url:Parameters<typeof fetch>[0],init?:RequestInit)=>{requests++;body=String(init?.body);return new Response(JSON.stringify({choices:[{message:{content:'画面：场景\n局面：其他\n可说：否\n因由：无'}}],usage:{prompt_tokens:10,completion_tokens:2}}))})
    assert.equal((await screen.look('Endfield','终末地',undefined))?.scene,'场景')
    assert.equal(calls,2);assert.equal(requests,1);assert.equal(usage,1)
    if(composeOk)assert.match(body,/2 帧/)
    else assert.doesNotMatch(body,/连续画面/)
    await assert.rejects(readFile(join(directory,'f1.png')),{code:'ENOENT'})
  })
}
test('storyboard dedup still retains the latest frame',()=>{
  const frames=[{file:'one',t:1,hash:'00',luma:20},{file:'two',t:2,hash:'ff',luma:20},{file:'last',t:3,hash:'00',luma:20}]
  assert.equal(pickFrames(frames,3).at(-1)?.file,'last')
})
