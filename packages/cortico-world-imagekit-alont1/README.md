<!-- Owner: src/world.ts, src/definition.ts -->
# 图片与头像（cortico-world-imagekit-alont1）

让 bot 自己找图、存图、换 QQ 头像。

| 工具 | 说明 |
|---|---|
| `image_search({query, count?})` | Bing 图片搜索，返回直链（不下载） |
| `image_download({url, name?})` | 下载到 `本扩展 dataDir/imagekit/avatar/`，只收图片、限大小 |
| `image_list()` | 列已下载的图 |
| `avatar_set({file?})` | 调 OneBot v11 `set_qq_avatar`（SnowLuma / NapCat）换 QQ 头像；本地文件走 base64:// |

配置：`worlds.imagekit.{enabled, httpUrl, maxBytes, maxResults}`，`httpUrl` 是 OneBot v11 协议端（SnowLuma / NapCat）的 HTTP 地址，默认 `http://127.0.0.1:3000`。

安装后需要在部署配置里开：`worlds.imagekit = { "enabled": true }`。

## 控制台面板

控制台显示扩展声明的标量配置；修改后重新挂载扩展生效。面板列出的复杂结构需在 config.json 中编辑。


## 头像上传恢复致谢（2026-10-22）

2026-10-22 晚间，QQ 头像上传在 SnowLuma 侧失败：腾讯返回的上传节点有个别不响应，协议端在 highway 上传阶段停住。**煎蛋（GitHub [@DrSmoothl](https://github.com/DrSmoothl)，SnowLuma 维护者）** 提交了修复：

- 上游 commit：[SnowLuma@79522d94](https://github.com/SnowLuma/SnowLuma/commit/79522d94)「fix(protocol): recover highway uploads after missing responses」——传输无响应时切换可用上传节点，保留已确认分片和当前 session，未确认的传输明确报错。

本地按这个 commit 对 1.14.21 运行包做了小范围回补（未整体升级 SnowLuma）：

- 回补前备份：`D:/DownLoad/SnowLuma-highway-recovery-20261022/`
- 原 QQ 环境提示词备份：`D:/DownLoad/cortico-avatar-fix-20261022/QQ-ENV-before-SnowLuma.md`

实测用本扩展的 `avatar_set`（tiger-cat.jpg）真实上传成功，回执「头像换了（tiger-cat.jpg）」，用时 2228ms。**特别感谢煎蛋的修复。**

注意：本地回补可能被未来整体升级覆盖；升级 SnowLuma 时请用包含上述 commit 的版本，并复核兼容性。

## 独立数据目录

生成产物改存于本扩展 dataDir/imagekit/avatar/，不会探测或写入 Persona Memory，也无需安装其他扩展。旧 workspace 中的产物保持原样；需要保留在新版列表或作品页中时，停用扩展后手动复制到新数据目录对应位置，再重新挂载。跨工具引用文件时使用回执给出的实际路径。

## 行为边界

下载按响应流计字节，超限会停止读取；搜图和换头像设有请求超时，HTTP 失败不会报告成功。
