<!-- Owner: packages/*/src, scripts/dependencies.mjs and templates/panel-runtime.ts -->
# 2026-10-25 独立扩展更新

本轮按已发布 npm 源码核对主仓 35 包，并在独立交付中包含 memory-brain、bilibili-video。仓库原 package name/version 与 npm baseline 保留；新候选版本、CHANGELOG、作者标签和平台声明只写入独立候选目录。勿将仓库旧版本直接用于本轮发布。

## 行为边界

- 各包只依赖 Core 公开契约与声明的通用库，不导入其他扩展、不默认读取兄弟扩展的私有文件。humanlike 的内部模块随其包内置。
- memory-doctor、memsearch 的来源改为显式配置，不自动探测 Persona Memory；sourceDir 为空时说明配置要求。
- QQ 后台私聊和空间发言改为候选事件，由 Persona 决定是否调用显式动作。42 个工具使用 qqbot_，与 Core 内建 QQ 避免冲突；完整映射在 QQ README。
- 自由登记原文、昵称、图片说明等不作为系统前缀或内部指令。前缀保留计数与合法结构值，既有原文仍可通过工具读取；新增 together_recall 和 humanlike_together_recall。固定机械通知与外部材料事件分开。
- affinity 查询不增加互动；life 自有联系人不再借 affinity 账本。humanlike 的早期共享目录迁移必须显式启用。

## 数据和生命周期

- QQ 与 Qzone 分别使用 dataDir/qqbot 和 dataDir/qzone；旧共享图库不能自动认定归属，必须明确配置或手动选图复制。其余产物迁移详见对应 README。
- 不删除旧数据，升级前停用并备份。相册旧版发生漏扫时，执行一次 album_scan({all:true}) 补回早期图片。
- 面板保留快速交替启停的最后一次停止，统计执行中调用、耗时及 failed:true 失败回执。
- 下载扫描、HTTP 大小与超时、截图编号、OneBot 解包、好友审批和发送失败均有实际行为回归。

## 验证

运行 npm test、npm run typecheck、npm run panels:check、npm run check；同步指南后需运行 node scripts/sync-panel-runtime.mjs --check。修改包文件后先审阅 diff，再记录 package-changes.json，禁止改写 baseline 掩盖差异。

新增依赖保护覆盖 npm alias、类型引用、动态导入、ImportEqualsDeclaration、相对路径与链接越界。交付进一步使用 SDK 0.2.7、World API 6 / Bot API 7 做实际 tgz 解包检查，与内建及所有候选的工具做冲突核对。

真实 QQ、桌面、浏览器登录、手机、绘图与其他外部服务须在各自授权测试部署联调。本轮不启动生产机器人、不发布 npm，也不自动申请撤销市场维护者风险标签。
