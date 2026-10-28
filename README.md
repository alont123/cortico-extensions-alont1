# Cortico alont1 扩展与入门教程

本仓库维护 35 个独立包的源码、两个独立附加工程和从零开始的中文教程。各扩展按需安装；协作使用 Cortico 的标准事件、工具和附件能力，由 Persona 决定何时调用。

## 第一次使用

先读 [零基础入门手册](docs/beginner/README.md)。它从文件夹、配置和启用操作讲起，每课有操作位置、预期结果、排查方法和练习答案。手机可下载同目录的 DOCX，HTML 可保存后离线阅读。

使用 Coo / Coopanion 时，在宿主扩展管理中安装需要的包，再在配置中启用和保存。源码开发者参照各包 README。不要在不确定的目录执行安装命令，也不要复制别人的 deployment 数据。

## 源码与发行版本

此仓首次公开于 2026-10-28，包含 npm 基线之后的维护补丁及互联首阶段代码。表中的版本来自本地 package.json，**不表示这些新补丁已经发布到 npm**。35 包的历史版本保持不变；正式发布需另外准备版本候选、运行检查并审核差异。本次没有执行 npm publish。

| 包 | 源码基线版本 | 类型 |
|---|---|---|
| [cortico-bot-xiaoshen-alont1](packages/cortico-bot-xiaoshen-alont1) | 0.1.1 | bot |
| [cortico-frugal-alont1](packages/cortico-frugal-alont1) | 1.0.0 | CLI |
| [cortico-world-affinity-alont1](packages/cortico-world-affinity-alont1) | 0.1.16 | world |
| [cortico-world-album-alont1](packages/cortico-world-album-alont1) | 0.1.13 | world |
| [cortico-world-alive-alont1](packages/cortico-world-alive-alont1) | 0.1.12 | world |
| [cortico-world-bili-alont1](packages/cortico-world-bili-alont1) | 0.1.2 | world |
| [cortico-world-clipboard-alont1](packages/cortico-world-clipboard-alont1) | 0.1.2 | world |
| [cortico-world-clock-alont1](packages/cortico-world-clock-alont1) | 0.1.12 | world |
| [cortico-world-cua-alont1](packages/cortico-world-cua-alont1) | 0.2.2 | world |
| [cortico-world-diary-alont1](packages/cortico-world-diary-alont1) | 0.1.2 | world |
| [cortico-world-downloads-alont1](packages/cortico-world-downloads-alont1) | 0.1.1 | world |
| [cortico-world-draw-alont1](packages/cortico-world-draw-alont1) | 0.1.1 | world |
| [cortico-world-gaming-alont1](packages/cortico-world-gaming-alont1) | 0.1.15 | world |
| [cortico-world-humanlike-alont1](packages/cortico-world-humanlike-alont1) | 0.1.17 | world |
| [cortico-world-imagekit-alont1](packages/cortico-world-imagekit-alont1) | 0.1.2 | world |
| [cortico-world-learn-alont1](packages/cortico-world-learn-alont1) | 0.1.13 | world |
| [cortico-world-life-alont1](packages/cortico-world-life-alont1) | 0.1.16 | world |
| [cortico-world-lite-alont1](packages/cortico-world-lite-alont1) | 0.1.12 | world |
| [cortico-world-meme-alont1](packages/cortico-world-meme-alont1) | 0.1.0 | world |
| [cortico-world-memory-doctor-alont1](packages/cortico-world-memory-doctor-alont1) | 0.1.13 | world |
| [cortico-world-memsearch-alont1](packages/cortico-world-memsearch-alont1) | 0.1.1 | world |
| [cortico-world-mind-alont1](packages/cortico-world-mind-alont1) | 0.1.1 | world |
| [cortico-world-mood-alont1](packages/cortico-world-mood-alont1) | 0.1.1 | world |
| [cortico-world-phone-alont1](packages/cortico-world-phone-alont1) | 0.1.2 | world |
| [cortico-world-playground-alont1](packages/cortico-world-playground-alont1) | 0.1.1 | world |
| [cortico-world-qq-better-alont1](packages/cortico-world-qq-better-alont1) | 0.1.68 | world |
| [cortico-world-qzone-alont1](packages/cortico-world-qzone-alont1) | 0.1.13 | world |
| [cortico-world-real-alont1](packages/cortico-world-real-alont1) | 0.1.1 | world |
| [cortico-world-ritual-alont1](packages/cortico-world-ritual-alont1) | 0.1.1 | world |
| [cortico-world-selfkit-alont1](packages/cortico-world-selfkit-alont1) | 0.1.1 | world |
| [cortico-world-todo-alont1](packages/cortico-world-todo-alont1) | 0.1.1 | world |
| [cortico-world-together-alont1](packages/cortico-world-together-alont1) | 0.1.12 | world |
| [cortico-world-weather-alont1](packages/cortico-world-weather-alont1) | 0.1.2 | world |
| [cortico-world-web-alont1](packages/cortico-world-web-alont1) | 0.1.1 | world |
| [cortico-world-works-alont1](packages/cortico-world-works-alont1) | 0.1.1 | world |

## 独立附加工程

- [记忆大脑](addons/memory-brain)：实验性读取与检索扩展，要求 Node.js 24 或更新；不会自动取代 Persona 的 Memory 协议。
- [B 站视频补丁](addons/bilibili-video)：基于 Phantivia 的 MIT 项目，保留作者、许可证与上游来源记录；与 `cortico-world-bili-alont1` 是两个不同的包。

附加工程保留自己的依赖、构建和测试。它们不是其他 35 个包的安装前提。

## 单独用与组合用

首阶段见 [图片附件协作](docs/ecosystem.md)。相册等工具返回图片句柄后，作品页可显式导入；没有来源扩展、句柄已失效或宿主不支持时给出失败回执，原有作品页工具继续可用。

“全套更好”指按场景选择互补功能，不是全部开关一起打开。**人味与 affinity、clock、learn、life、mind、real、together 七个独立扩展存在重复，按各包说明择一启用。** 不同消息平台和数据作用域也不要自动混合。

## 本地开发与验证

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run check
npm run pack:all
```

根项目建议 Node.js 24。`pack:all` 检查安装包文件清单，不会上传 npm。新增协作代码须证明单装、组合、缺失能力与重复调用行为；不要启动真实 bot 或给真实群聊发送测试消息。

附加工程在其目录单独安装依赖和验证。贡献流程见 [CONTRIBUTING](CONTRIBUTING.md)，后续方向见 [生态路线](docs/roadmap.md)。报告问题时附包名、版本、宿主版本、复现步骤和脱敏日志。

## 许可证与来源

根项目使用 [MIT](LICENSE)。各包及附加工程保留自己的许可证、原作者和上游记录。不要将第三方作品、账号凭据、聊天记录或 deployment 数据提交到本仓。
