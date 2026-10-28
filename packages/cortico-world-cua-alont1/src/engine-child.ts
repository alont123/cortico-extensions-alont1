/**
 * 引擎子进程入口（由 world.ts fork，不手动运行）。
 *
 * 这里拥有**所有**操作系统调用：截图、SendInput、窗口枚举。后端换成了 PowerShell
 * （见 engine/ps.ts）——koffi 要现场编译，这台机器编不出来；PowerShell 自带 .NET，能调同一套 Win32。
 *
 * 协议：主进程发 MainToChild，这里回 {id, ok, result}；启动时先发 {type:'ready'} 报屏幕尺寸。
 * 所有后端调用都是异步的（常驻 PowerShell 进程按行收发），所以这里一律 await。
 */
import jpeg from 'jpeg-js';
import { downscale, drawCursor } from './engine/image.ts';
import type { ChildToMain, InputRequest, MainToChild, ShotResult } from './engine-ipc.ts';
import * as native from './engine/ps.ts';

const send = (msg: ChildToMain): void => { process.send?.(msg); };

const reply = (id: number, ok: true, result: unknown): void => send({ id, ok, result });
const fail = (id: number, error: unknown): void => send({ id, ok: false, error: String((error as Error)?.message ?? error) });

/** 物理像素 → 截图坐标。 */
function toShot(x: number, y: number, scale: number): { x: number; y: number } {
  return { x: Math.round(x / scale), y: Math.round(y / scale) };
}

async function takeShot(shot: number, quality: number, draw: boolean): Promise<ShotResult> {
  const { bgra, width, height } = await native.captureScreen();
  const scaled = downscale(bgra, width, height, shot);
  const scale = width / scaled.width;
  let cursor: { x: number; y: number } | null = null;
  if (draw) {
    const p = await native.cursorPos();
    cursor = toShot(p.x, p.y, scale);
    drawCursor(scaled.rgb, scaled.width, scaled.height, cursor.x, cursor.y);
  }
  const encoded = jpeg.encode({ data: scaled.rgb, width: scaled.width, height: scaled.height }, quality);
  return { jpeg: encoded.data, width: scaled.width, height: scaled.height, scale, cursor, atMs: Date.now() };
}

/** 输入前等使用者停手；使用者一直在动就拒绝这次操作。 */
async function waitForIdle(minIdleMs: number): Promise<void> {
  if (minIdleMs <= 0) return;
  const idle = await native.idleMs();
  if (idle < minIdleMs) {
    throw new Error('使用者正在用这台电脑（' + Math.round(idle) + 'ms 前刚动过键鼠），这次操作没有执行。');
  }
}

async function applyInput(req: InputRequest): Promise<void> {
  await waitForIdle(req.idleMs);
  switch (req.kind) {
    case 'move':
      await native.moveTo(req.x ?? 0, req.y ?? 0);
      return;
    case 'click':
      await native.moveTo(req.x ?? 0, req.y ?? 0);
      await native.click(req.button ?? 'left', req.clicks ?? 1);
      return;
    case 'drag': {
      const from = { x: req.x ?? 0, y: req.y ?? 0 };
      const to = { x: req.toX ?? 0, y: req.toY ?? 0 };
      await native.moveTo(from.x, from.y);
      await native.mouseDown(req.button ?? 'left');
      try {
        const steps = 12;
        for (let i = 1; i <= steps; i++) {
          await native.moveTo(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
        }
      } finally {
        await native.mouseUp(req.button ?? 'left');
      }
      return;
    }
    case 'scroll':
      await native.moveTo(req.x ?? 0, req.y ?? 0);
      await native.scroll(req.delta ?? 1);
      return;
    case 'type':
      await native.typeText(req.text ?? '');
      return;
    case 'key':
      await native.pressKeys(req.keys ?? []);
      return;
    default:
      throw new Error('不认识的输入类型：' + String((req as { kind?: string }).kind));
  }
}

async function handle(msg: MainToChild): Promise<void> {
  switch (msg.op) {
    case 'shot':
      reply(msg.id, true, await takeShot(msg.shot, msg.quality, msg.drawCursor));
      return;
    case 'windows':
      reply(msg.id, true, await native.listWindows());
      return;
    case 'focus':
      reply(msg.id, true, await native.focusWindow(msg.title));
      return;
    case 'activity': {
      const [idle, cursor] = await Promise.all([native.idleMs(), native.cursorPos()]);
      reply(msg.id, true, { idleMs: idle, cursor });
      return;
    }
    case 'input':
      await applyInput(msg.req);
      reply(msg.id, true, { done: msg.req.kind });
      return;
    default:
      throw new Error('不认识的指令');
  }
}

process.on('message', (raw: unknown) => {
  const msg = raw as MainToChild;
  void handle(msg).catch((e: unknown) => fail(msg.id, e));
});

process.on('exit', () => {
  native.dispose();
});

// 先声明 DPI 感知（ps.ts 在进程启动时做），再取尺寸。
void (async () => {
  native.setDpiAware();
  try {
    send({ type: 'ready', screen: await native.screenInfo() });
  } catch (e) {
    fail(0, e);
  }
})();
