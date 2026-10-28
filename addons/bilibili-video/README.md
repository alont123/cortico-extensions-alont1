<!-- Owner: src/definition.ts, src/world.ts -->

# cortico-world-bilibili-video-alont1

基于 [Phantivia 的 `cortico-world-bilibili-video` 0.2.2](https://github.com/Phantivia/cortico-world-bilibili-video/tree/8fca68d2960784ee35aab4b729d1f120478bd849)，基线 commit 为 `8fca68d2960784ee35aab4b729d1f120478bd849`。这是 ALonT1 的浏览器启动修复 fork，保留 Phantivia 作者署名与 MIT 许可。npm 已发布基线为 0.2.3；此源码包含后续未发布更新，候选版本以交付包的 package.json 为准。

World id 仍为 `bilibili-video`，配置仍在 `worlds.bilibili-video`，API 仍为 6；改包名不要求改这些字段。上游 0.2.2 已有 20 秒启动超时、stderr 与退出日志，本版修复独立 profile、CDP 就绪判定、候选回退与会话清理。

> 此乃直播测试验证之后的world，和其他 Persona / 非直播场景的兼容性有待测试。

[Cortico](https://github.com/Pal-AI-Lab/Cortico) 的 B 站视频 World(id `bilibili-video`),一个独立的扩展包。
它开一个登录了 B 站的浏览器窗口,这个窗口就是直播画面:bot 在里面逛 B 站、挑视频、看视频,观众看同一个窗口。

## 中文使用说明

本包独立连接 Chrome/Edge 和 B 站，不要求安装 QQ、人味、记忆大脑或直播 World。当前发布候选声明 Windows；需要本机安装 Chrome/Edge，扫码登录属于可选的网页账号授权。它不会替换用户的日常浏览器资料目录。

标题、账号名、字幕和弹幕属于外部内容，只通过外部事件与工具回执进入模型；系统环境段仅说明机械运行状态。停止、重挂载和换页会使旧采样、字幕、导航和延迟观察失效，避免把上一页材料混入新会话。Cookie 文件位置不变，数据页存储项改名为 `bilibili-video.cookies`。

1. 将 Coo 程序安装在普通应用目录，启用「B 站视频」。首次使用保留 `browser.executableFile`、`browser.profileDir`、`browser.cdpUrl` 为空，点击「播放状态」里的「打开浏览器」，或让助手调用 `bilibili_video_browser open`。World 启动本身不会自动打开窗口。如果之前用过 helper，先关闭插件浏览器并清空旧 `browser.cdpUrl`，再验证直接启动。
2. 打开「B 站授权」，生成二维码，用手机 B 站扫码并确认，然后点击「核验登录」。扫码 CookieJar 才是登录凭据的持久保存位置；临时浏览器目录每次可更换。二维码过期或登录失效时重新授权，不需要改用户日常 Edge 的资料目录。
3. 让助手调用 `bilibili_video_search` 搜视频，或用 `bilibili_video_open` 打开 BV 号/网址，再调用 `bilibili_video_play` 播放。打开视频页不会自动播放；暂停、跳转、画质与观察工具见下表。
4. 点击关闭或调用 `bilibili_video_browser close` 后可以再次打开。默认会使用新的独立临时 profile，并从 CookieJar 注入登录态。修改 `browser.*` 设置后先关闭再重新打开浏览器，使新设置生效。
5. 若提示「宿主处于低完整性」，将 Coo 程序安装到普通目录，并保留原部署数据；不要修改整个工作区的安全标签。其他启动错误按程序、profile、端口和退出诊断排查。需要临时接管时，可从正常桌面运行 helper，将输出的 HTTP 调试地址填写到 `browser.cdpUrl`；不要填写日常浏览器的默认资料目录。

## 两种状态

浏览器窗口默认关着,World 启动不开它。打开的途径:WebUI「播放状态」面板的「打开浏览器」按钮、bot 的
`bilibili_video_browser open`、或 bot 直接 `bilibili_video_open` / `bilibili_video_search`。操作员开关和手动关窗口都投
`bilibili-video.state` 事件告诉 bot。

| 状态 | 进入 | 工具 |
|---|---|---|
| 窗口没开 | 启动时;`bilibili_video_browser close`;窗口被关 | `bilibili_video_browser`、`bilibili_video_open`、`bilibili_video_search` |
| 逛页面 | 窗口打开;`bilibili_video_exit`;操作员在窗口里换页 | `bilibili_video_open`(BV 号、网址、上次列表的序号,或回首页)、`bilibili_video_search`、`bilibili_video_related`、`bilibili_video_comments`、`bilibili_video_scroll`、`bilibili_video_snapshot` |
| 看视频 | `bilibili_video_play` | `bilibili_video_pause`、`bilibili_video_seek`、`bilibili_video_look`、`bilibili_video_quality`、`bilibili_video_exit` |

所有工具都作用在可见窗口上:搜索是真的打开搜索页再读页面上的卡片;按序号打开先把那张卡片滚进视口;读评论先滚到评论区。
打开视频页不播放;`bilibili_video_play` 进入网页全屏并播放。

操作员直接在窗口里换视频或暂停、继续,World 按主框架导航和播放器状态识别出来,投一条 `bilibili-video.state`
事件说明,不替 bot 做决定:换过的视频等 bot 自己 `bilibili_video_play`。

## 观察帧

看视频时,每隔 `observe.minIntervalSec`(默认 5 秒)投一条 `bilibili-video.scene`,在投递那一刻生成
(`pushDeferred`),所以上一轮模型跑得久,这一张就覆盖更长的一段:

1. 播放器以 `observe.captureFps` 抽帧进候选池(页内 canvas 画 `<video>`,每帧一张单格 JPEG 和 64×36 亮度图)。
   烧在画面里的黑边先裁掉:96×54 的探针找出最亮像素仍是黑的整列整行,裁剪框取最近四次探测的并集,黑边持续约 2 秒才收缩。
   竖屏画面把格子转成竖的(`cellHeight`×`cellWidth`),`bilibili_video_look` 用同一个裁剪框。
2. 格数 = 间隔 × `frameDensity`,封顶 `maxFrames`;采样点从最新帧往回按公比 `ratio` 等比排布(0.618 即黄金分割),每个点在自己的半间距内吸附到亮度差超过 `cutThreshold` 的切换帧。
3. dHash 汉明距离小于 `dedupeHamming` 的帧只留一张,黑场只留一张;剩几帧用几格(1×1、2×1、2×2、3×2、3×3),行优先按时间排。
4. 正文:现在的时刻、每格的时刻、检测到的画面切换与黑场、进入的章节、这段的字幕、这段的视频弹幕(引用上限 `danmaku.maxPerScene`,其余只计数)。

字幕来自页面自己请求的 `x/player/wbi/v2` 里的字幕列表(优先 `ai-zh`),文件由页面用登录态去取;
弹幕来自页面自己拉的 `dm/wbi/web/seg.so` 分段(protobuf,6 分钟一包),按弹幕 id 去重。两者都是旁听页面响应,
World 不自己调 B 站接口。画面里烧进去的硬字幕由模型从帧里读。

## 登录

WebUI「B 站授权」面板:生成二维码,手机 B 站扫码,确认后 World 从 `qrcode/poll` 的响应里拿到整套 cookie,
存到 `<数据目录>/bilibili-video/cookies.json`;浏览器每次启动和每次导航前经 DevTools 协议注入。
可用画质与字幕取决于 B 站页面、账号权限及视频本身；临时目录不会自行持久保存新登录态。「核验登录」调 `x/web-interface/nav` 看 CookieJar 中的 cookie 是否仍有效。
「数据」页签可清除 cookie。

## 卡住、画质与 CDN

播放没有推进超过 `playback.stallSec`(默认 6 秒)投一条 `bilibili-video.state`,带缓冲到的位置和当前画质;恢复再投一条。
`bilibili_video_quality` 不带参数列出播放器画质菜单的档位,带 `level` 就点菜单里的那一档;标「大会员」或「登录即享」的档位点了不生效。
`browser.uposHost` 填了主机名(海外常用 `upos-hz-mirrorakam.akamaized.net`)时,World 用 DevTools 的请求拦截把
`upos-*.bilivideo.com` 的分片请求改到那台主机;留空由播放器自己选 CDN。

## 浏览器

默认使用本机已安装的 Chrome 或 Edge，不下载或依赖 Playwright Chromium。Windows 会从 registry App Paths、PATH 与常用安装目录发现候选；显式 `browser.executableFile` 优先。在剩余总启动预算内按候选尝试，每个候选最多两轮；默认临时 profile 每次重试都会更换。错误程序、浏览器策略或启动桩退出不会形成未处理的 `error` 事件。

未设置 `browser.profileDir` 时，资料目录为 `<数据目录>/bilibili-video/browser-profiles/browser-<时间>-<随机串>`，与日常浏览器隔离。浏览器用 `--remote-debugging-port=0` 自选端口；插件读取该目录的 `DevToolsActivePort`，核对 `/json/version` 与 WebSocket 路径，再连接 CDP。子进程退出 0 后如果端点有效仍可成功；没有端点则在短暂宽限后报告疑似交给已有实例，并在预算内重试，不继续盲等。

关闭或启动失败后，只清理本次有归属标记且已确认进程退出的临时目录。另以短预算检查最多 24 个旧目录，保留检查结果中最新 2 个，单次最多清理 2 个更旧目录。归属或退出无法确认时保留，因此不保证残留目录总数硬上限；不会全局杀 Edge/Chrome 来满足数量要求。

显式 `browser.profileDir` 适合专门给插件使用的独立目录：已有健康 CDP 端点会复用；端点失效而目录可能被占用时返回说明。显式目录不会被删除或偷偷更换，也不会为解锁它而杀外部实例。日常 Chrome/Edge 的默认资料目录及其 profile 子目录会被拒绝。

`browser.cdpUrl` 填写已专门用远程调试启动的浏览器 HTTP 地址（如 `http://127.0.0.1:9333`），健康检查失败时提示确认端口与策略，不另行启动浏览器。通过 `cdpUrl` 或显式 profile 复用外部浏览器时，插件新建自己的标签页；关闭插件只关这张新页并断开 CDP，保留原窗口和原标签页。OBS 可用窗口捕获取插件窗口；声音走浏览器的默认输出设备。

World 自己启动的浏览器带 `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
--disable-background-timer-throttling`,窗口被挡住也照常渲染和滚动。接管的浏览器要自己带上这三个参数,
否则窗口被挡住或最小化时页面停止渲染:滚动不生效、评论区不加载、抽到的帧停在老位置。

### Coo 的安装位置与自动启动

0.2.5 已定位本机 Coo 自动启动失败的原因：DSH 持久工作区带 Windows Low 完整性标签，安装在其下的 Coo 程序继承了该标签。隔离对照使用 SHA256 相同的 Coo 可执行文件：原目录中的 Core 和子 Edge 都为 Low（RID 4096）；普通目录中的两者恢复 Medium（RID 8192），调试端点约 1.6 秒就绪，完整 Coo 0.2.4 桌面面板可以直接打开浏览器。此结论来自本机对照，不代表所有 Coo 安装都存在相同问题。

解决方式是将 **Coo 程序安装到普通应用目录**。迁移前关闭 Coo，备份并保留原部署数据；使用新程序时确认仍指向原部署、配置和登录数据。程序安装位置和 helper 所需的 data 目录是两回事。不要修改整个工作区的 ACL 或安全标签，也不要把 Coo 可执行程序继续放在带 Low 标签的沙箱工作区内。安装完成后清空旧 `browser.cdpUrl`，在「播放状态」直接打开浏览器；这一流程不需要 helper。

本版在 Windows 创建新浏览器前只读检测继承完整性：确认低于 Medium 时立即显示中文安装位置指引，不启动浏览器、不创建 profile、不删除显式目录中的旧端口文件；检测失败或未知时继续原逻辑。已有健康 `cdpUrl` 或独立 profile 的接管保持可用。检测最多尝试两次，每次 750 ms、合计最多 1500 ms，并计入原启动总预算；只缓存已确认的完整性结果，临时失败不会导致后续一直跳过检测。不增加浏览器启动超时。

需要临时从桌面启动独立浏览器时，仍可运行包内 helper：

    powershell.exe -NoProfile -File scripts\start-browser.ps1 -DataDir "<Coo 的数据目录>"

这里的目录是 Coo 部署的 data 目录（例如独立测试部署的 home/companion/data），不是程序安装目录。也可双击 scripts\start-browser.cmd，在提示中输入该目录；成功后窗口会保留，便于复制地址。脚本会：

- 每次运行及每个候选均使用新独立 profile，启动 Chrome/Edge，--remote-debugging-port=0；
- 读取有限大小的 DevToolsActivePort；直接请求本机 HTTP，不跟随重定向，限制响应大小与时间，校验浏览器类型和 WebSocket 的端口/路径一致；
- 输出真实的 cdpUrl，并写 <Coo 数据目录>/bilibili-video/external-browser-connection.json；
- **不修改任何配置、不自动接管、不自动启用自启动、不删除目录**。

把输出的 cdpUrl 填到「配置 → 接管已开的浏览器」。需要登录时再在「B 站授权」扫码。这个 Edge 窗口归用户所有，关闭插件只关插件新建的标签页；窗口关掉后需要重新运行 helper，并更新 cdpUrl。helper 不会自动读取旧连接记录替你接管；失败时保留专用 profile 和已有连接记录，可能已出现的窗口由用户关闭。确认所有窗口已关闭后，才由用户自行整理这些专用目录。

脚本保留 PowerShell 的正常执行策略。如果系统询问是否运行，先阅读脚本，再由操作者决定是否“运行一次”；如果组织策略禁止执行，应联系管理员，不默认绕过策略或删除来源标记。脚本使用 UTF-8 BOM，兼容 Windows PowerShell 5.1 的中文。

## 本地审查与构建

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build:console
```

`build:console` 是现有 `build:webui` 的别名，产物仍为 `dist/webui.js`。此 fork 供本地源码和打包审查，不自动安装、部署、重启机器人、推送 Git 或执行 `npm publish`。通过审查后的安装由装机者另行操作。

## 开发

```bash
pnpm typecheck
pnpm test

# 仅在明确准备好打开独立测试 Edge 窗口时运行
pnpm test:edge
```

`pnpm test` 使用假进程和假 CDP 验证启动状态机、退出与 spawn error、端点归属、候选回退、总预算、显式目录/接管边界、取消和清理；默认真实 spawn 被拦截。既有选帧、弹幕解码、字幕和 cookie 解析测试继续保留。helper 新测试会运行实际 PowerShell 函数，但硬拦截真实 Start-Process；HTTP 对照仅访问自己创建的本机假 DevTools 服务。这些隔离测试不代表真实浏览器窗口已经启动成功。若 Windows 因路径区域要求“运行一次”，测试默认非交互拒绝；操作者审阅并明确同意本轮执行后，才可设置 $env:BILI_HELPER_RUN_ONCE_APPROVED='1' 再运行测试。该标记只供测试回答运行确认，不写入系统执行策略，也不被生产 helper 读取。

`pnpm test:edge` 单独运行 `scripts/edge-smoke.ts`，真实打开系统 Edge，使用全新的专用临时根与空 CookieJar，结果写入 `scratch/edge-smoke.json`。它检查自动发现、已有专用 Edge 时再开独立窗口、真实 DAP/CDP、匿名首页导航、关闭重开、对象重建、`cdpUrl`/显式 profile 接管，以及真实错误程序的失败文案。候选列表的控制与假浏览器应在结果中区分；不会读取个人浏览器资料或真实登录凭据。精确归属或退出无法确认时保留测试目录，不杀无关浏览器。

0.2.4 历史验收在独立测试数据目录运行 Coo 0.2.4 的实际 CoreHost、Electron NodeMode Core 和原版 WebUI，验证 helper 接管、关闭、World 重启及 Core 重启后再次接管；当时外层管理器为 Node，未验完整 Electron 桌面设置窗口，宿主内自动启动尚未解决。

0.2.5 本轮使用普通目录中的完整 Coo 0.2.4 桌面程序和独立测试数据，已通过真实 GUI 面板打开、关闭浏览器，以及 World 重启、Core 重启后再次打开。上述流程直接由宿主启动浏览器，未使用 helper 或 `cdpUrl`。扩展通过本地源码链接加载；市场安装、Coo 0.2.8、真人登录及视频播放仍未验。独立 Edge smoke 的通过不替代这些安装版本或账号验收。

## 许可

MIT；原作者 Phantivia，本地启动修复维护 ALonT1。
