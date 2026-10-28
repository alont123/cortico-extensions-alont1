/** Package entry: the default export is the `WorldDefinition`. */
import { BILIBILI_VIDEO } from './definition.ts';

export default BILIBILI_VIDEO;

export { BILIBILI_VIDEO };
export { BILIBILI_VIDEO_DEFAULTS, BILIBILI_VIDEO_CONFIG_GROUP, BILIBILI_VIDEO_ID } from './config.ts';
export type { BilibiliVideoConfigSection } from './config.ts';
export { BilibiliVideoWorld, type BilibiliVideoWorldOptions } from './world.ts';
export { BILIBILI_VIDEO_TOOL_DECLS } from './tools.ts';
