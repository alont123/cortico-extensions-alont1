/**
 * 主进程 ↔ 引擎子进程的消息协议。
 *
 * 分进程的理由只有一个：PowerShell/.NET 调用 Win32 出问题时要能只死这一个进程，
 * 不能把 bot 一起带走。这里只放跨进程要传的形状，不放实现。
 */

/** 坐标一律是**主屏物理像素**；缩放成模型看的那张图由引擎负责换算。 */
export interface InputRequest {
  kind: 'move' | 'click' | 'drag' | 'scroll' | 'type' | 'key';
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  button?: 'left' | 'right' | 'middle';
  clicks?: number;
  /** 滚轮格数，正=向下。 */
  delta?: number;
  /** 要打的字（任何语言，走 unicode 输入，与输入法状态无关）。 */
  text?: string;
  /** 要按的键名序列：'ctrl+s' 这种写法由 world 层解析好再传进来。 */
  keys?: string[];
  /**
   * 使用者动过键鼠后要等多少毫秒才动手。
   * 引擎在每个输入动作前检查「最后一次用户输入」的时刻。
   */
  idleMs: number;
}

export type MainToChild =
  | { id: number; op: 'shot'; shot: number; quality: number; drawCursor: boolean }
  | { id: number; op: 'windows' }
  | { id: number; op: 'focus'; title: string }
  | { id: number; op: 'input'; req: InputRequest }
  | { id: number; op: 'activity' };

export interface ScreenInfo {
  width: number;
  height: number;
  dpi: number;
}

export interface ShotResult {
  /** 缩放后的 JPEG。 */
  jpeg: Buffer;
  width: number;
  height: number;
  /** 截图像素 → 物理像素的比（= 物理宽 / 截图宽）。 */
  scale: number;
  /** 截图上光标的位置（缩放后坐标系）；没画光标时为 null。 */
  cursor: { x: number; y: number } | null;
  /** 截这张图的时刻（毫秒）。 */
  atMs: number;
}

export interface WindowInfo {
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  foreground: boolean;
}

export type ChildToMain =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  | { type: 'ready'; screen: ScreenInfo };
