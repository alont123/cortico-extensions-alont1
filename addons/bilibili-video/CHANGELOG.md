# Changelog

## 0.2.5（本地修复版）

- 定位本机 Coo 自动启动根因：程序继承沙箱工作区 Low 完整性标签。相同二进制从普通目录启动后，完整 Coo 0.2.4 与 Edge 恢复 Medium，面板自动启动正常。
- Windows 新建浏览器前只读检查继承完整性；低于 Medium 提前给出中文安装修复指引，不创建 profile 或启动 Edge。检查有短时限，未知结果继续原流程，正常 cdpUrl/显式 profile 接管保留。
- 新增完整性解析、低/中/未知、检测失败、取消和接管回归；不增加启动超时、不修改系统标签或宿主策略。

## 0.2.4（本地审查版）

- 正式说明 Coo 的桌面 helper + cdpUrl 接管路径，播放面板加入可展开中文教程；不宣称宿主内自动启动已修好。
- helper 每个候选均使用新 profile，正确引用 Windows 参数；校验参数范围及普通目录，拒绝输出路径中的链接。限制 DAP/HTTP 大小、时间和本机 WS 对应关系，拒绝重定向与嵌入凭据。
- 先写临时文件，再更新连接记录；启动失败保留目录/原记录，不修改 Coo 配置、不自动接管、不终止用户窗口。
- cmd 保留正常 PowerShell 执行策略，移除默认 Bypass；PS 使用带 BOM 的 UTF-8，支持 Windows PowerShell 5.1 中文。
- 新增 helper 隔离回归；最终 Coo/Edge 验收范围见 0.2.4 报告。未发布、未部署生产，Coo 0.2.8 未验证。

## 0.2.3（ALonT1 本地修复 fork）

- 基于 Phantivia 上游 0.2.2，commit `8fca68d2960784ee35aab4b729d1f120478bd849`。包名改为 `cortico-world-bilibili-video-alont1`，保留作者与 MIT，设为 `private: true`；World id `bilibili-video`、API 6 和配置路径不变。
- 默认每次启动创建带归属标记的独立临时 profile；使用 `--remote-debugging-port=0`，读取 `DevToolsActivePort`，校验 `/json/version` 的浏览器类型、端口及 WebSocket 路径，再连接 CDP。启动桩退出 0 时先检查端点，不把进程是否存活当作浏览器就绪条件。
- 补齐 spawn error、非零退出、退出 0 无端点、初始化失败和取消的处理；在总预算内依次回退候选，默认 profile 重试时重新创建。上游 0.2.2 已有 20 秒启动超时、stderr 和退出日志，本版改进启动判定及清理，不以增加超时替代修复。
- 支持 registry App Paths、PATH 与常用安装目录发现浏览器。`executableFile` 仍优先，`profileDir`、`cdpUrl` 保持兼容。
- 显式 profile 健康时复用，无法确认空闲时明确拒绝；不删除该目录、不偷偷换目录、不杀外部实例，并拒绝日常浏览器默认资料目录。`cdpUrl` 不健康时返回说明，不盲目启动浏览器。
- 接管外部浏览器时只创建并关闭插件自己的新标签页；停止时 disconnect，不关闭已有页面和窗口。自启动会话只清理精确归属的进程与临时目录，无法确认退出时保留目录。
- 保留扫码 CookieJar 注入、弹幕/字幕旁听和选帧逻辑；新增启动状态机隔离单测、显式运行的 Windows Edge smoke 脚本与中文使用说明。增加 `build:console` 构建别名和 `test:edge`，不升级依赖。
- Coo 0.2.4 宿主内自启动仍可能失败：启动桩 exit 0、DAP 已出现但 Core 访问端点 HTTP/WS 失败。新增 DAP 读取、HTTP、JSON、WS 校验的分阶段诊断，区分“没写端口”与“端点已出现但不健康”；不再一律误报“疑似已有实例”。
- 新增 `scripts/start-browser.ps1` + `start-browser.cmd`：Coo 宿主内自启动未就绪时，从正常桌面启动独立 Edge，校验 DAP/HTTP/WS 后输出 `cdpUrl`；helper 不自动改配置、不接管、不删除目录。README 与配置说明同步。
- 本地源码供审查，不包含生产部署、发布或 Coo 0.2.8 市场安装/宿主按钮验收结论。

## 0.2.2

- 浏览器没起来时，日志里记下浏览器程序路径、启动参数、存活时长和浏览器的错误输出。

## 0.2.1

- 在去掉了内置平台 World 的 Cortico 构建(如 Coopanion)里能加载了:弹幕解码改用包内自带的 protobuf 读取器。

## 0.2.0

- 适配 Cortico 0.2.0(world 契约 6):面板改名 WebUI,产物换成 `dist/webui.js`,构建脚本改为 `pnpm build:webui`。
- 定义加 `describe`,附 `describe.json` 给扩展市场读。
