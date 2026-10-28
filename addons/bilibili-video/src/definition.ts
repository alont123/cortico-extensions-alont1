import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { BILIBILI_VIDEO_DEFAULTS, BILIBILI_VIDEO_ID, type BilibiliVideoConfigSection } from './config.ts';
import { BILIBILI_VIDEO_TOOL_DECLS } from './tools.ts';
import { BilibiliVideoWorld } from './world.ts';

export const BILIBILI_VIDEO: WorldDefinition<BilibiliVideoConfigSection> = {
  id: BILIBILI_VIDEO_ID,
  label: 'B 站视频',
  defaults: () => structuredClone(BILIBILI_VIDEO_DEFAULTS),
  // ctx.cfg is the live `worlds.bilibili-video` section: every key is read at use
  create: (ctx) => new BilibiliVideoWorld({ cfg: ctx.cfg, timezone: ctx.timezone, dataDir: ctx.dataDir }),
  describe: {
    tools: describeTools(BILIBILI_VIDEO_TOOL_DECLS, {
      bilibili_video_browser: { zh: '打开或关闭观众看到的 B 站浏览器窗口。', en: 'Opens or closes the bilibili browser window the audience sees.' },
      bilibili_video_open: { zh: '打开一个 B 站视频页、列表里的一条或首页,回执带视频信息。', en: 'Opens a bilibili video, an item from the last list, or the home page, and reports the video details.' },
      bilibili_video_play: { zh: '全屏播放当前视频,之后定时收到画面、字幕和弹幕。', en: 'Plays the current video full screen; frames, subtitles and danmaku then arrive at intervals.' },
      bilibili_video_pause: { zh: '暂停播放。', en: 'Pauses playback.' },
      bilibili_video_seek: { zh: '跳到视频的某一秒,或前后跳一段。', en: 'Jumps to a second in the video, or forward or back by an offset.' },
      bilibili_video_look: { zh: '取当前一帧的大图,可放大局部。', en: 'Takes a large image of the current frame, optionally zoomed into a region.' },
      bilibili_video_quality: { zh: '查看或切换播放画质。', en: 'Shows or changes the playback quality.' },
      bilibili_video_exit: { zh: '退出全屏并暂停,回到可以浏览页面的状态。', en: 'Leaves full screen and pauses, back to browsing the page.' },
      bilibili_video_search: { zh: '搜索 B 站视频,回执是编号的结果列表。', en: 'Searches bilibili and returns a numbered list of results.' },
      bilibili_video_related: { zh: '列出当前视频的相关推荐。', en: "Lists the current video's related recommendations." },
      bilibili_video_comments: { zh: '读取当前视频的评论,热评在前。', en: "Reads the current video's comments, top comments first." },
      bilibili_video_scroll: { zh: '上下滚动当前页面。', en: 'Scrolls the current page up or down.' },
      bilibili_video_snapshot: { zh: '截一张当前窗口的图,带网址和标题。', en: 'Captures the current window with its URL and title.' },
    }),
    events: [
      {
        type: 'bilibili-video.state',
        description: {
          zh: '浏览器窗口或播放状态变了:窗口开关、操作员换页或暂停继续、播放完、卡住加载与恢复。',
          en: 'The browser window or playback changed: window opened or closed, the operator navigated, paused or resumed, the video ended, or playback stalled or recovered.',
        },
        trigger: 'flush',
      },
      {
        type: 'bilibili-video.scene',
        description: {
          zh: '观看时定时送来的一张观察帧:这段画面的拼图,以及这段的字幕和视频弹幕。',
          en: 'A periodic observation while watching: a grid of frames from the last stretch, with its subtitles and the video danmaku.',
        },
        trigger: 'debounce',
      },
    ],
  },
};
