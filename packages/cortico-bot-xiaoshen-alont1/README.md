<!-- Owner: index.ts and persona configuration, conversation recovery and recent ledger modules. -->
# 小深（cortico-bot-xiaoshen-alont1）

Cortico bot 扩展：一个带性格的桌宠人格。默认种子已脱敏，可替换。

## 装

Coopanion 扩展页搜 `cortico-bot-xiaoshen-alont1` 安装，重启后在 bot 设置里选它。

## 包含

- `index.ts`：bot 定义（id `xiaoshen`，只声明 console）
- `persona/`：人格运行时
- `persona/CONSTITUTION.seed.md`：出厂种子，可改

## 配置

- `context`：上下文阶段预算
- `rounds`：单轮工具调用软/硬上限
- `tick.intervalMinutes`：基线唤醒间隔，null 关闭
- `handoff`：私聊续接、来源缓存、有限重复问句回退，在人格配置页直接调整

本包只声明内建终端，不要求其他第三方 World；可按部署需要另行挂载。每次 defaults() 返回独立配置，不与其他部署共享可变对象。tick.intervalMinutes 的非有限值、零或负值按暂停处理，超长定时不触发 Node 的 1 毫秒溢出回退；暂停期间每 30 分钟重新检查配置。

## 中文使用教程

1. 在「语言模型」页填端点、模型、真实窗口与输出上限；在提示词页核对自述和宪法，再从内建终端发一条问候。可另外挂载 QQ World，私聊相关行为只在有对应事件时发生。
2. 先沿用「上下文与交接」「私聊续接与来源核对」的默认配置。交接或重启时，Persona 从自己已观察的事件中恢复一个私聊的双向对话，保留原时间和事件游标。默认最近 120 分钟、最多 30 条、预留 2048 tokens；仍受总预算限制，遗漏或截断会标明。
3. 用 `recent_append` 记录近期内容，用 `recent_read` 查看。逐字引用必须提供真实 `cursor`、`senderKey` 和能匹配的 `quote`；同一聚合事件有多条匹配时还需 `messageId`。没有来源就写 `kind=pending`。工具自己取原消息日期，记笔记的日期不会替换事情发生日期。
4. 在「存储」页可单独清除对话来源缓存与新台账。此项保留旧 `RECENT.md`；清除普通工作区是另一项操作。排错先看日志、端点和 Memory 路径，不要用清数据代替排查。

`source-matches` 只说明逐字引用与当前保存的来源材料一致，**不证明内容为真或讲话人归因正确**。规范化消息正文不含渠道提示、人册备注及展开的被引用消息；旧 World 的格式化事件标为 `formatted-event-quote`，不可直接改写成“对方说”。截断来源只核对已保留前缀。旧 `RECENT.md` 保持原文件，读取时标 `legacy-unsourced`，不自动迁成已核对记录；外部原文与旧笔记不会逐字进入系统前缀，前缀只展示台账状态。

来源缓存默认保留 7 天、500 个事件、每个事件最多 8192 字符，仅来自实际投递给此 Persona 的私聊事件，不回扫 Core 的历史库。聚合事件按原条目的时间和正文核对，不能跨消息拼成引用。来源到期、被淘汰、清除或发生变化时分别明确显示不可用或变化；新台账默认最多 500 条，满时拒绝追加，不静默删除旧记录。

## 续接设置

以下键位于 `handoff`，可在面板修改；后续投递、读取或交接按新值处理。

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `dialogueWindowMinutes` | 120 | 恢复私聊的时间窗，单位分钟 |
| `dialogueMaxMessages` | 30 | 单次恢复的双向消息数上限 |
| `dialogueReserveTokens` | 2048 | 为选中私聊预留的 token 额度，计入交接总预算 |
| `prioritizeSenderKeys` | 空字符串 | 用空格或逗号分隔 `private:QQ号`；从这些联系人中选最近一个会话。为空时先使用配置中的 QQ `ownerQQ`，否则从已观察私聊中选最近有入站消息的会话 |
| `sourceRetentionHours` | 168 | 来源按原日期保留的小时数 |
| `sourceMaxEvents` | 500 | 来源缓存事件数上限；一个聚合事件可能含多条消息 |
| `sourceMaxChars` | 8192 | 单事件正文上限，超长保留连续前缀并标记 |
| `answeredTopicWindowMinutes` | 240 | 有限重复问句回退使用的原回答时间窗，单位分钟 |
| `repeatQuestionFallbackEnabled` | true | 是否启用有限重复问句回退 |

重复问句回退只覆盖“吃了吗、在干嘛、睡了吗”等少数完整短问句，要求同一私聊有明确、未截断的规范化原回答；命中后发送工具返回未发送和原始证据，不伪造成功回执。它不是通用语义识别，也不推断对方现在仍保持相同状态，操作者可关闭。

QQ 的 `qq.sent` 仅表示服务受理了相应片段，不等于送达、已读或对方回应。只有真实受理事件进入已发送对话，Persona 的内部文字不当作对外发言。

## 文件与安全边界

新台账与来源缓存分别在当前 Memory 的 `.persona/recent-ledger.json` 和 `.persona/recent-sources.json`，由 Persona 管理，不访问其他 Persona 的 Memory。文件工具及 `save_blob` 对 `RECENT.md`、`.persona/` 和可识别链接别名有写保护；新引用与待核笔记走专用工具。该保护不是操作系统沙箱，不能阻止宿主外部程序或已获能力的任意终端命令改盘，不应通过它们绕过台账流程。

台账按临时文件与替换方式持久化；检测到损坏、并发锁或不安全链接时保留现有数据并报错。缓存损坏不会被新的事件静默覆盖，恢复应由操作者检查或通过独立存储项清除。

工作区的初始化、同步和异步提交在自动暂存时都排除这两份来源文件及其锁，即使已有 `.gitignore` 也生效，其他 `.persona/` 文件保留原历史行为。该排除不会重写旧 Git 历史、移除已有跟踪或暂存状态。缓存保留期限和存储清除只针对当前数据，不是安全擦除；既有历史、手动提交副本与外部备份需由操作者另行管理。文件保存成功也不等于 Git 提交或 checkpoint 成功，以实际回执为准。
