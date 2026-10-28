/** 显式运行的 Windows 真实窗口验收；npm test 不操作桌面。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CAPTURE_PREAMBLE, CaptureError, captureWindow, parseCaptureOutput, runPowerShell, type PowerShellRunner } from '../../packages/cortico-world-gaming-alont1/src/capture.ts'
import { captureFrames, composeStoryboard } from '../../packages/cortico-world-gaming-alont1/src/storyboard.ts'

if(process.platform!=='win32') throw Error('Windows interactive desktop required')
const reportFile=resolve(process.env.GAMING_SMOKE_REPORT || 'reports/gaming-windows.json')
const dir=await mkdtemp(join(tmpdir(),'gaming-smoke-'))
const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./windows-fixture.ps1',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe']})
const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]()
let fixtureError=''
child.stderr.on('data',data=>{ fixtureError+=String(data) })
async function next():Promise<Record<string,unknown>> {
  let timer:ReturnType<typeof setTimeout>|undefined
  try {
    const result=await Promise.race([lines.next(),new Promise<never>((_,reject)=>{ timer=setTimeout(()=>reject(Error('fixture response timeout')),15000) })])
    if(result.done) throw Error('fixture exited: '+fixtureError.slice(0,100))
    const data=JSON.parse(result.value) as Record<string,unknown>
    assert.equal(data.ok,true);return data
  } finally { if(timer)clearTimeout(timer) }
}
async function command(action:string,details:Record<string,unknown>={}) {
  child.stdin.write(JSON.stringify({action,...details})+'\n');return (await next()).value
}
async function activate(key:string) { assert.equal(await command('activate',{key}),true,'Windows must confirm fixture foreground') }
const checks:Array<Record<string,unknown>>=[]
async function check(name:string,run:()=>Promise<unknown>) {
  try { const detail=await run();checks.push({name,passed:true,detail});console.log('PASS '+name) }
  catch(error) { checks.push({name,passed:false,error:error instanceof Error?error.message:String(error)});throw error }
}
let startup:Record<string,unknown>|undefined, failed:unknown
try {
  startup=await next()
  const prefix=String(startup.prefix),proc=String(startup.proc)
  const opts={proc:'SearchHost',target:'',targetTitle:prefix+' MAIN',maxWidth:0,timeoutMs:20000}
  async function inspect(file:string,expected:number[],tolerance=0) {
    const pixels=String(await command('inspect',{file})).split(',').map(Number)
    assert.deepEqual(pixels.slice(0,2),expected.slice(0,2))
    for(let channel=2;channel<5;channel++)assert.ok(Math.abs(pixels[channel]!-expected[channel]!)<=tolerance,'fixture color mismatch: '+pixels.join(','))
    return pixels
  }
  async function blankRunner(raceAfter=0):Promise<PowerShellRunner> {
    const cover=String(await command('handle',{key:'cover'}))
    // 确定性模拟 GPU 的 PrintWindow 空白；窗口状态、裁剪、CopyFromScreen 全走真实 Win32。
    // 此替换仅存在于显式测试 runner，生产捕获代码没有测试开关。
    const declaration='[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);'
    const shim=`
    [DllImport("user32.dll",EntryPoint="PrintWindow")] static extern bool NativePrintWindow(IntPtr h,IntPtr dc,uint flags);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from,uint to,bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    static int printCount;
    static int raceAfter=${raceAfter};
    public static bool PrintWindow(IntPtr h,IntPtr dc,uint flags) {
      StringBuilder title=new StringBuilder(2048);GetWindowText(h,title,title.Capacity);
      if(title.ToString().IndexOf(" BLANK",StringComparison.Ordinal)<0)return NativePrintWindow(h,dc,flags);
      RECT bounds;GetWindowRect(h,out bounds);POINT origin=new POINT();ClientToScreen(h,ref origin);
      using(Graphics g=Graphics.FromHdc(dc)){g.Clear(Color.Black);g.FillRectangle(Brushes.Magenta,0,0,bounds.R-bounds.L,origin.Y-bounds.T);}
      printCount++;
      if(raceAfter>0 && printCount>=raceAfter) {
        int pid;uint fg=GetWindowThreadProcessId(GetForegroundWindow(),out pid),current=GetCurrentThreadId();
        bool attached=fg!=0 && fg!=current && AttachThreadInput(current,fg,true);
        try{SetForegroundWindow(new IntPtr(${cover}L));}finally{if(attached)AttachThreadInput(current,fg,false);}
      }
      return true;
    }`
    return (script,timeout)=>{
      assert.ok(script.includes(declaration));return runPowerShell(script.replace(declaration,shim),timeout)
    }
  }
  async function kernel(key:string,foreground:boolean,run:PowerShellRunner=runPowerShell) {
    const h=String(await command('handle',{key}))
    const script=CAPTURE_PREAMBLE+`\n$r=[GamingCapture]::Capture([IntPtr]::new([long]${h}),$${foreground?'true':'false'});try { @{ok=($null -ne $r.Image);code=$r.Code;method=$r.Method}|ConvertTo-Json -Compress } finally {if($null -ne $r.Image){$r.Image.Dispose()}}`
    return parseCaptureOutput(await run(script,20000))
  }
  await check('single title pin: case-insensitive largest match and correct client crop',async()=>{
    await activate('normal');const file=join(dir,'single.png')
    await captureWindow({...opts,targetTitle:(prefix+' main').toUpperCase(),file})
    return await inspect(file,[640,360,34,139,34])
  })
  await check('multi title pin uses the same largest window and crop',async()=>{
    await activate('normal')
    const cap=await captureFrames({...opts,outDir:join(dir,'frames'),frames:2,intervalMs:100})
    assert.equal(cap.ok,true,cap.error);assert.equal(cap.frames.length,2)
    for(const frame of cap.frames) await inspect(frame.file,[640,360,34,139,34])
    const grid=join(dir,'grid.png')
    assert.equal(await composeStoryboard({files:cap.frames.map(f=>f.file),out:grid,cellWidth:200,timeoutMs:20000}),true)
    return {frames:cap.frames.length,grid:true}
  })
  await check('process pin normalizes quotes/case/.exe and chooses largest visible window',async()=>{
    await activate('cover');const file=join(dir,'process.png')
    await captureWindow({...opts,target:' " '+proc.toUpperCase()+'.EXE " ',targetTitle:'',file})
    return await inspect(file,[800,500,65,105,225])
  })
  await check('process plus title require both; missing title never falls back to current process',async()=>{
    await assert.rejects(captureWindow({...opts,target:proc,targetTitle:prefix+' MISSING',file:join(dir,'missing.png')}),(e:unknown)=>e instanceof CaptureError&&e.code==='NOHWND')
    await assert.rejects(captureWindow({...opts,target:'not-a-real-process',file:join(dir,'wrong.png')}),(e:unknown)=>e instanceof CaptureError&&e.code==='NOHWND')
  })
  await check('automatic kernel rejects a covered/background window',async()=>{
    await activate('cover');assert.equal((await kernel('normal',true)).code,'NOT_FOREGROUND')
  })
  await check('explicit background pin reads its own PrintWindow content, never the covering window',async()=>{
    await activate('cover');const file=join(dir,'background.png')
    await captureWindow({...opts,file});return await inspect(file,[640,360,34,139,34])
  })
  await check('single minimized target returns MINIMIZED',async()=>{
    await command('minimize',{key:'normal'})
    await assert.rejects(captureWindow({...opts,file:join(dir,'min.png')}),(e:unknown)=>e instanceof CaptureError&&e.code==='MINIMIZED')
  })
  await check('multi minimized target returns MINIMIZED with no frames',async()=>{
    const cap=await captureFrames({...opts,outDir:join(dir,'min-frames'),frames:2,intervalMs:100})
    assert.equal(cap.code,'MINIMIZED');assert.deepEqual(cap.frames,[])
  })
  const blank={...opts,targetTitle:prefix+' BLANK'}
  const injectedBlank=await blankRunner()
  await check('blank client plus colored title bar uses FromScreen only while foreground',async()=>{
    await activate('blank');const result=await kernel('blank',false,injectedBlank)
    assert.equal(result.ok,true);assert.equal(result.method,'FromScreen')
    const file=join(dir,'fallback.png');await captureWindow({...blank,file},injectedBlank)
    return await inspect(file,[500,300,0,128,128],24)
  })
  await check('multi FromScreen captures only the selected foreground client',async()=>{
    await activate('blank');const cap=await captureFrames({...blank,outDir:join(dir,'fallback-frames'),frames:2,intervalMs:100},injectedBlank)
    assert.equal(cap.ok,true,cap.error)
    for(const frame of cap.frames) await inspect(frame.file,[500,300,0,128,128],24)
    return {frames:cap.frames.length}
  })
  await check('single blank background never falls back to screen',async()=>{
    await activate('cover')
    await assert.rejects(captureWindow({...blank,file:join(dir,'forbidden.png')},injectedBlank),(e:unknown)=>e instanceof CaptureError&&e.code==='NOT_FOREGROUND')
  })
  await check('multi blank background discards every frame and preserves NOT_FOREGROUND',async()=>{
    const cap=await captureFrames({...blank,outDir:join(dir,'forbidden-frames'),frames:2,intervalMs:100},injectedBlank)
    assert.equal(cap.code,'NOT_FOREGROUND');assert.deepEqual(cap.frames,[])
  })
  await check('foreground changes during PrintWindow: single cannot fall back',async()=>{
    const race=await blankRunner(1);await activate('blank')
    await assert.rejects(captureWindow({...blank,file:join(dir,'race.png')},race),(e:unknown)=>e instanceof CaptureError&&e.code==='NOT_FOREGROUND')
  })
  await check('foreground changes during PrintWindow: multi cannot fall back',async()=>{
    const race=await blankRunner(2);await activate('blank')
    const cap=await captureFrames({...blank,outDir:join(dir,'race-frames'),frames:2,intervalMs:100},race)
    assert.equal(cap.code,'NOT_FOREGROUND');assert.deepEqual(cap.frames,[])
  })
  await check('PowerShell script failures and timeouts do not expose commands or stderr',async()=>{
    for(const [script,timeout,code] of [["throw 'fixture private failure'",20000,'SCRIPT_FAIL'],['Start-Sleep -Seconds 20',100,'CAPTURE_TIMEOUT']] as const) {
      await assert.rejects(runPowerShell(script,timeout),(error:unknown)=>error instanceof CaptureError && error.code===code && !/powershell|private|Command failed/i.test(error.message))
    }
  })
} catch(error) { failed=error;console.error(error instanceof Error?error.message:error) }
finally {
  try { if(startup) await command('stop') } catch { /* 紧接着关闭本测试拥有的 helper。 */ }
  child.stdin.end()
  const stopped=await Promise.race([new Promise<boolean>(resolve=>child.once('exit',()=>resolve(true))),new Promise<boolean>(resolve=>{const timer=setTimeout(()=>resolve(false),4000);timer.unref()})])
  if(!stopped)child.kill()
  lines.return?.()
  await rm(dir,{recursive:true,force:true})
  await mkdir(resolve(reportFile,'..'),{recursive:true})
  await writeFile(reportFile,JSON.stringify({checkedAt:new Date().toISOString(),fixtureOnly:true,blankPrintWindowFaultInjected:true,productionModified:false,checks,passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length,completed:!failed,unverified:['真实游戏与独占全屏','反截屏/受保护窗口','多显示器与混合 DPI','常驻置顶覆盖层']},null,2)+'\n')
}
if(failed)process.exitCode=1
