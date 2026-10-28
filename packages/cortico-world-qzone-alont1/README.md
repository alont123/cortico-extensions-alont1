<!-- Owner: src/world.ts, src/config.ts -->
# QQ 空间扩展

包名 `cortico-world-qzone-alont1`，World ID `qzone`。独立连接明确配置的 NapCat HTTP 接口；不要求安装 QQ 或其他扩展。

## 中文使用教程

1. 在 NapCat 登录目标账号并开启 HTTP 服务，将本实例端点填入面板的 `httpUrl`。同机多个账号必须各自核对端口。
2. 开启扩展，设置每日限额、静默时段和正文长度。默认每天最多 1 条，23 点至次日 9 点静默；时间采用宿主配置时区。
3. 需要配图时，将图片放入本扩展 `dataDir/qzone/stickers`，或明确填写 `stickerDir`。相对路径从部署 `dataDir/qzone` 解析；绝对路径按配置使用。未配置素材不会自动寻找其他扩展的表情包。
4. 使用 `qzone_post` 提供正文；`with_image: false` 强制纯文字，其余情况按 `withImageChance` 从配置目录抽取配图。该工具会实际发布。
5. 使用 `qzone_status` 查看本地回执及 `tid`；`qzone_delete` 仅删除本扩展记录中有 `tid` 的条目。删除不会返还当天发布额度。

## 提醒与发布

定时器只产生 `qzone.nudge` 候选事件，由 Persona 决定是否调用发布工具。候选不等于已经发布，也不强制发言。`nudgeEveryMinutes` 控制检查周期，`nudgeMinGapMinutes` 控制提醒间隔；任一设为 0 可关闭提醒。

| 工具 | 行为 |
| --- | --- |
| `qzone_post` | 发布显式提供的 `content`，可控制是否配图 |
| `qzone_status` | 查看本地回执、剩余额度和已记录的 `tid` |
| `qzone_delete` | 根据本扩展记录的 `tid` 删除一条动态 |

发布与删除调用的是 NapCat 扩展动作，具体可见范围及支持情况以当前协议端为准。发布使用 `send_qzone_msg`，删除使用 `delete_qzone_msg`；本扩展状态页不读取空间线上完整列表。

## 本次修复与迁移

- 默认配图库由自动读取 Persona 的 `workspace/blobs/stickers` 改为本扩展 `dataDir/qzone/stickers`。旧文件不移动、不删除；需要沿用时由用户明确填写旧目录或复制选定素材。
- 同一实例串行处理发布，避免并发调用一起越过每日限额。额度跨日和静默时段均按宿主时区计算。
- 发布没有可用的幂等键，断线或超时可能发生在对方已接收之后。因此不再自动执行“base64 → 文件 URL → 纯文字”重复发送。未收到成功回执会明确显示“未确认发布”；请先查看空间实际内容，再决定是否手动重试。
- 重复启动不叠加定时器；停止后清理宿主引用；启动事件失败时不留下半启动状态。
- 记录保存在本扩展 `dataDir/qzone/qzone.json`。本地失败记录只说明未确认成功，不能证明远端没有发布。

## 排错

未就绪时先核对 NapCat 端点和扩展加载状态；达到限额或处于静默时段会在请求发出前拦截。没有配图时检查素材目录、文件大小和抽样概率。真实发布、删除验收应在本人授权的测试账号操作；本次回归仅使用模拟 HTTP，没有调用真实 QQ 空间。

旧版本包记录 `dataDir/qzone.json` 可在停用扩展并备份后手动复制到 `dataDir/qzone/qzone.json`。旧 `dataDir/stickers` 可能属于 QQ，不自动读取或搬运；只复制你明确选定的配图，或填写明确的 stickerDir。
