<!-- Owner: src/world.ts, src/config.ts, src/proactive.ts, src/qzone.ts -->
# QQ 群聊扩展

包名为 `cortico-world-qq-better-alont1`，World ID 为 `qqbot`。通过本实例单独配置的 OneBot/NapCat 收发消息、查询历史、管理监听名单和执行显式授权的群管动作。不要求安装其他扩展。

## 中文使用教程

1. 在 NapCat 登录 QQ，为本实例配置正向 WebSocket 或反向连接。扩展面板中的模式、地址、端口和 Token 必须与 NapCat 一致；凭据保存在部署配置中。
2. 在面板填写允许监听的群和私聊。先查看连接及身份状态，再收到一条测试消息，用 `qqbot_conversations` 核对会话地址。
3. 发消息时使用 `qqbot_send`，`to` 原样采用 `group:群号` 或 `private:QQ号`。该工具会真实发送；收到成功回执前不能认定发出。收图、发图、历史查询和人册工具可按需要单独使用。
4. 群管功能须另填 `adminGroups`。未授权群不会因已在监听名单中而自动获得管理权限。好友自动通过由 `friendAutoAdd` 单独控制。
5. 可选视觉、语音服务需要各自明确配置的接口及密钥名称。密钥仅从宿主的 `ctx.secret` 或同名进程环境变量读取；不搜索其他 provider 的文件。
6. 候选调度和空间功能可单独开启。候选事件只是可考虑的时机，是否发言、内容是什么由 Persona 判断。发布空间使用 `qqbot_qzone_post`，必须显式传入正文，配图也必须显式指定。

## 拆条与发送回执

私聊默认将一段回复合并发送；群聊默认只有达到 120 字符才允许按句拆分，相邻短句会合并。单次工具调用最多 2 条，图片也计入条数。较长内容仍受每条字节上限约束；超过最大条数且无法无损合并时整次拒绝，返回原因，不截掉后文。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `splitReplyBySentence` | `true` | 自愿拆句总开关；旧配置明确为 `false` 时仍不按句或空行拆分 |
| `splitPrivateReplies` | `false` | 私聊拆句需要单独开启，且总开关必须开启 |
| `splitMinChars` | `120` | 少于此字符数时优先合并；强制字节限制继续生效 |
| `splitReplyMaxMessages` | `2` | 单次调用最大消息条数，包含图片，范围 1–20 |
| `coalesceShortSentences` | `true` | 在字节限制内合并相邻短句 |

回执区分“服务已受理”“结果未确认”“未尝试”。第一个异常后停止后续条目；部分发送、超时或断线返回失败标志，不自动整条重发。旧确认工具也不会重新发送已经尝试过的草稿。停止扩展或取消调用后，不继续发送剩余条目；已经提交给服务的请求仍可能到达。

每条成功受理的消息产生公开 `qq.sent` 事件（`origin: external`、`tags: [speak]`），只记录该条实际发送的内容和返回的消息编号。`meta.delivery: accepted` 表示服务受理，不表示对方已读；缺少编号时 `meta.messageId` 为 `null`。事件记录失败会在工具回执中单独说明，不能因此再次发送。工具参数和失败片段不能作为已发原话。

收到的 `qq.message` 提供 `meta.messageText`、`messageTs` 与 `messageTextBasis: normalized-message`，正文不含扩展添加的频道前缀、人册备注、回复提示或展开的被引用消息。引用内容仍保留在展示文本中，但不归为当前发言者的话。私聊聚合保留 `meta.messages` 中每条消息的 `messageId`、`ts`、`text`，并将聚合正文标为 `aggregated-normalized-messages`。这些是规范化后的消息文本，图片占位、转写等不应被称为原始音频或未经转换的原文。Persona 可通过这些公开事件维护双向对话依据，无需读取本包目录。

## 独立运行与数据边界

笔记、人册、群册、提醒、候选计数及默认表情包保存在部署数据根下独占的 `dataDir/qqbot` 子目录。扩展不读取 Persona 的 `RECENT.md`，不猜其他扩展的目录或服务地址；显式配置的表情包路径继续支持。宿主事件存储用于查询本 World 已收取的 QQ 历史，宿主附件引用按原有契约处理。

QQ 消息、昵称、群名、合并转发和空间评论都是外部资料。原文走 external 事件或工具回执，不拼入 system 前缀。环境前缀只说明能力、数值身份和监听编号。

NapCat 是可选外部前置服务，不是其他扩展；连接失败时会显示实际错误。未配置视觉、语音、空间或群管功能，不影响基础文字收发。

## 本次迁移

- 所有工具统一为 `qqbot_` 前缀，不再注册与 Core 内置 QQ 重名的工具。旧提示词、脚本和工作流需按下表改名；World ID、配置键 `worlds.qqbot`、持久化目录和既有 QQ 事件名保持兼容。
- 原后台 LLM 主动生成并直接发消息改成 `qq.proactive` 候选事件；频率、额度、冷却和静默配置仍控制候选节奏。预热、去重模型、独立提示词/接口等旧字段不再参与行为。旧已发送计数不会混入新的 `proactive-nudges.json` 候选计数。
- 原空间自动生成/自动回复改成 `qq.qzone_nudge` 候选和 `qq.qzone` 外部评论事件。保留显式发布、删除、查看及回复工具；不会汇总私聊来生成公开说说，也不自动附加最近收到的图片。`topic` 旧参数不再替代正文。
- 旧独立情绪推断及其 system 注入已停用；`/心情` 作为普通外部消息交给 Persona。旧相关字段可读取，但不再执行。
- 候选计数不是实际发送数；Persona 可以不回应候选。扩展停止时关闭定时器，重复 start 不增加循环。

## 工具名迁移表

旧名只作为迁移说明保留，不注册兼容别名。

| 旧工具名 | 新工具名 |
| --- | --- |
| `group_lore` | `qqbot_group_lore` |
| `group_note` | `qqbot_group_note` |
| `people_forget` | `qqbot_people_forget` |
| `people_list` | `qqbot_people_list` |
| `people_note` | `qqbot_people_note` |
| `people_thread` | `qqbot_people_thread` |
| `people_thread_done` | `qqbot_people_thread_done` |
| `qq_admin_at_all` | `qqbot_admin_at_all` |
| `qq_admin_ban` | `qqbot_admin_ban` |
| `qq_admin_join_approve` | `qqbot_admin_join_approve` |
| `qq_admin_join_list` | `qqbot_admin_join_list` |
| `qq_admin_join_reject` | `qqbot_admin_join_reject` |
| `qq_admin_kick` | `qqbot_admin_kick` |
| `qq_admin_notice` | `qqbot_admin_notice` |
| `qq_admin_recall` | `qqbot_admin_recall` |
| `qq_admin_title` | `qqbot_admin_title` |
| `qq_confirm_send` | `qqbot_confirm_send` |
| `qq_conversations` | `qqbot_conversations` |
| `qq_friend_approve` | `qqbot_friend_approve` |
| `qq_friend_requests` | `qqbot_friend_requests` |
| `qq_note_forget` | `qqbot_note_forget` |
| `qq_note_get` | `qqbot_note_get` |
| `qq_note_list` | `qqbot_note_list` |
| `qq_note_save` | `qqbot_note_save` |
| `qq_poke` | `qqbot_poke` |
| `qq_proactive_status` | `qqbot_proactive_status` |
| `qq_proactive_trigger` | `qqbot_proactive_trigger` |
| `qq_qzone_delete` | `qqbot_qzone_delete` |
| `qq_qzone_feeds` | `qqbot_qzone_feeds` |
| `qq_qzone_post` | `qqbot_qzone_post` |
| `qq_qzone_reply` | `qqbot_qzone_reply` |
| `qq_qzone_status` | `qqbot_qzone_status` |
| `qq_recent` | `qqbot_recent` |
| `qq_reminder_add` | `qqbot_reminder_add` |
| `qq_reminder_cancel` | `qqbot_reminder_cancel` |
| `qq_reminder_list` | `qqbot_reminder_list` |
| `qq_search` | `qqbot_search` |
| `qq_send` | `qqbot_send` |
| `qq_send_image` | `qqbot_send_image` |
| `qq_sticker_save` | `qqbot_sticker_save` |
| `qq_sticker_stats` | `qqbot_sticker_stats` |
| `qq_view_image` | `qqbot_view_image` |

## 验证范围

仓库包含隔离数据目录和模拟 NapCat/HTTP 的回归测试，覆盖候选调度不直接发送、外部资料边界、工具改名路由、额度及停止行为，以及短句合并、条数上限、部分失败不重发、受理事件和聚合消息来源。真实 QQ、群管、语音和空间发布需要用户在自己的授权测试账号中验收；本次代码检查没有调用真实账号或服务。

## 数据目录迁移

`ctx.dataDir` 是部署共享根目录，本包只在其 `qqbot/` 子目录写入状态。默认图库为 `dataDir/qqbot/stickers`，独立空间扩展使用 `dataDir/qzone/stickers`，不会互相借图。显式配置的 emojiDir/sticker.dir 仍按原规则使用。

更新前停用扩展并备份。只在确认属于此 QQ 扩展时，将旧数据根中的以下文件按原文件名复制到 `dataDir/qqbot/`：`qqbot-known-messages.json`、`qq-last-inbound.json`、`people.json`、`groups.json`、`group-entry.jsonl`、`notebook.jsonl`、`reminders.json`、`sticker-index.json`、`vision-seen.json`、`vision-accounting.jsonl`、`qzone-state.json`；使用过候选版时还可复制 `proactive-nudges.json`。默认不扫描或自动导入这些旧文件。

旧 `dataDir/stickers` 的归属不能自动确认；用户只复制明确选择的图片到新 QQ 图库，或显式配置旧目录。旧目录和文件均保留。
