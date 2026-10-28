/**
 * 扩展用到的、**线上框架还没有**的那几个类型成员，在这里就地声明。
 *
 * 背景：`host` 传进来的是本扩展自己 `wrapHost()` 包过一层的东西，它比框架的类型
 * 多出几项（`isPaused`），而 `pushEvent` 的合批上限、工具上下文里的会话地址
 * 是这台机器的框架后加的。用线上框架（`cortico@0.1.13`）的类型检查扩展时，
 * 这些成员都不存在，`npx tsc --noEmit` 直接失败——但那只是**类型**对不上：
 * 三处调用都写成可选（`this.host?.isPaused?.()`、`ctx.conv ?? ''`、
 * `maxBatchAgeMs` 省略即用默认），真实运行时缺了也不会出错。
 *
 * 所以这里只补类型，不改行为。全用可选字段：宿主给了就用，没给就当没有。
 */
import type { PushOptions, ToolCallContext, ToolDef, ToolOutcome, WorldHost } from 'cortico/core/types.ts';

/** 宿主被封了一层之后可能带上的字段。 */
export interface HostExtras {
  /** 处于暂停（她不说话）时不再往 PUSH 里塞东西。宿主没提供时视为未暂停。 */
  isPaused?: () => boolean;
}

/** 传给 World 的宿主：要么是框架的 WorldHost，要么是包过一层、多带字段的那个。 */
export type ExtWorldHost = WorldHost | (WorldHost & HostExtras);

/** 工具上下文可能带上"这句话是在哪个会话里说的"。 */
export interface ToolCallContextExtras {
  /** 'group:123' | 'private:123'；不在会话里调用时没有这一项。 */
  conv?: string;
}

/**
 * 工具声明的上下文。用更宽的参数类型：调用方可能给 `ToolCallContext`，
 * 也可能给带 `conv` 的版本，两种都得接受。
 */
export type ToolContext =
  | ToolCallContext
  | (ToolCallContext & ToolCallContextExtras)
  | Record<string, unknown>;

/** 工具声明（与框架的 ToolDef 同形，只有上下文的参数类型更宽）。 */
export type ToolDefWithConv = Omit<ToolDef, 'handler'> & {
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string | ToolOutcome>;
};

/** 合批参数里比线上框架多的一项（本机框架后加）。 */
export interface PushOptionsExtras {
  maxBatchAgeMs?: number;
}

/** `pushEvent` 接受的参数。 */
export type PushOptionsAll = PushOptions & PushOptionsExtras;
