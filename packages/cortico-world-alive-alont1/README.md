<!-- Owner: src/world.ts, src/config.ts, src/ENV_PROMPT.md -->

# cortico-world-alive-alont1

记录想做的事，按时间提醒，并提供桌面和用量的只读查询。World id 为 `alive`，配置段为 `worlds.alive`，默认关闭。

## 工具

| 工具 | 功能 |
|---|---|
| `alive_want` | 记录内容、理由、对象和可选提醒时间 |
| `alive_list` | 查看待处理和最近了结的条目 |
| `alive_done` / `alive_drop` | 记录结果或放下条目 |
| `alive_desk` | 查询 Windows 前台窗口标题和进程名，不截图 |
| `alive_cost` | 按配置价目表估算 `<dataDir>/usage.jsonl` 的用量金额 |
| `alive_prefix` | 从 `consoleUrl` 的只读接口查询提示词组成 |
| `alive_config` | 查看当前约束配置 |

## 事件与来源

`alive.due`、`alive.digest`、`alive.freetime` 使用 `origin: internal`，正文只有到点、计数或空闲等机械通知。
任务原文、理由、对象和完成结果通过 `alive.material` 作为 `origin: external` 投递；从磁盘加载的既有记录采用相同规则。

每日回顾附带最近的外部事件，每条材料保留 `cursor`、`run`、`source`、`type`、`senderKey` 和 `ts`。
原事件附件通过已有句柄附在外部材料上。回顾原话正文合计最多 2200 字，截断会标记；派生材料不再被重新采样。
材料先以 `piggyback` 排队，随后机械通知以 `flush` 触发同一批投递。

`{{alive.pending}}` 只提供条目数和到点数，详细内容通过 `alive_list` 查询，不进入环境提示词前缀。
World 不读取 Persona Memory。旧 `memoryDir`、`recentFile` 配置仍能加载，但已不读取对应文件；需要回忆时由 Persona 使用自己的 Memory 工具。

## 调度

一件事只提醒一次。提醒、回顾和自己的时间共用 `pushGapSec`、`dailyPushes`、`quietFrom/quietTo` 和暂停状态；启动后 30 秒内不推送。
`expireAfterH` 控制已提醒条目的保留时间。

自己的时间只给纯时间提示，不附任务或原话。两次之间至少相隔 `freeTimeGapMin` 分钟，且同样长的窗口内没有新的外部事件；窗口至少为 30 分钟。
`freeTimePerDay: 0` 关闭此功能；`digestAt` 为空时关闭每日回顾。

## 使用

1. 在 WebUI 扩展页按包名或本机目录安装。
2. 启用 `worlds.alive.enabled` 并重启，设置静默时段与提醒上限。
3. 用 `alive_want` 记一件事，`alive_list` 查看，完成后用 `alive_done`。
4. 金额按 `pricingJson` 估算；需要时配置自己的价目表。

状态保存在 `<dataDir>/alive.json`，以临时文件后改名写入；World 不修改 Memory。
