<!-- Owner: src/definition.ts and src/world.ts -->
# cortico-world-humanlike-alont1

一个 World，把七件让 bot 更像人的事装在一起：**情绪与交情、学过的东西、作息、时间感、
一起过的时间、它自己惦记的事、看得见的桌面与花销**。二十五个工具。

状态保存在 `<dataDir>/humanlike/`；用量账本读取宿主持续追加的 `<dataDir>/usage.jsonl`，不会复制成快照。
`real.consoleUrl` 留空时使用宿主控制台端口；未提供端口的旧宿主使用 7788。已配置的地址继续生效。

启动不推送 `affinity.started` 和 `learn.started`。报时和启动时的悬着话头使用 `piggyback`，
随下一批消息投递；到点提醒、每日回顾和主动搭话显式使用 `flush`。
悬着话头的登记原文按 `external` 外部资料投递，落盘不会把用户原话变成内部指令；固定的时段通知仍是 `internal`。
每日回顾中的外部原话和附件保留 `external` 来源，与内部时间提示分开投递，并携带原事件游标、来源和时间。
`mind.freetime` 只在 `freeTimeGapMin` 内没有外部消息时触发（至少静默 30 分钟），正文不重复消息或任务原文。

给想让自己那个 bot 有点人味的人用——它有自己的状态和时间线、会记着你和它之间的事、
会自己排期，也能看见桌面上发生了什么。**看得见的四个工具全部只读，它改不了任何配置。**

> **0.1.17**：修升级不迁移数据——旧版把状态放在 `<dataDir>/*.json`，合并版收进 `<dataDir>/humanlike/`；
> 该历史版本曾自动复制根目录旧文件；当前版本改为显式迁移，避免误读独立扩展数据。
> **0.1.16**：提示词新增「情绪要看得出来」——回话第一句就得有温度、一句话里至少一处起伏、要带动作描写，明确把「平铺直叙的日志腔」列为不合格；情绪余波写进前缀时要求它真的影响语气。
> **与人味重复，不要同时启用**：人味已经内置 affinity、learn、life、clock、together、mind、real。启用人味时，不要同时启用对应的七个独立包（cortico-world-<名称>-alont1）。工具名虽已加 humanlike_ 前缀，两套仍会重复产生状态和提醒；请选择一套。配置和数据各自独立，切换不会自动迁移数据。
> **开关使用**：人味只有宿主扩展卡片的一个激活/停用总开关，七个内置模块随它一起运行。详情页只保存业务设置；保存标有“重新挂载”的设置后，用宿主重新挂载。

## 工具

### 情绪与交情（affinity）

| 工具 | 干什么 |
|---|---|
| `humanlike_affinity_get` | 查某个账号跟它的交情：多少分、什么档位、该用什么态度 |
| `humanlike_affinity_adjust` | 记一笔交情涨跌，附一句为什么 |
| `humanlike_affinity_list` | 看排在前面的人 |

分数、档位、情绪余波落 `<dataDir>/humanlike/affinity.json`。情绪余波会随时间衰减（半衰期可配），
没淡掉的那些写进系统前缀，影响它此刻的调子。

`humanlike_affinity_get` 从事件库同步该 QQ 号的新原始消息，自动计算普通搭话加分，与手动调整共用每日加分上限；
重复查询不增加消息数或分数。因此它声明为 `write`、`snapshot`。
旧版由查询次数形成的 `msgs` 保存为 `legacyQueryCount`，真实消息数从升级当天的 QQ 消息重新统计，不补发旧日加分。
具体交情变化再用 `humanlike_affinity_adjust`；同一段上下文里无需反复查询。

### 学过的东西（learn）

| 工具 | 干什么 |
|---|---|
| `humanlike_learn_search` | 上网查一个词／梗／游戏，返回 B站、贴吧、萌娘百科的**原始材料** |
| `humanlike_learn_note` | 把读懂的东西记下来（词、群友、游戏） |
| `humanlike_learn_recall` | 翻自己学过什么 |
| `humanlike_learn_forget` | 删掉记错的 |

落 `<dataDir>/humanlike/learn.json`。搜索只给材料，落库要靠它自己读完再写，避免变回词典。
相同 `kind`、`key` 的笔记再次写入会覆盖旧记录，无需先删除。

### 作息（life）

| 工具 | 干什么 |
|---|---|
| `humanlike_life_now` | 看自己现在什么状态：在干嘛、心情、精力、今天遇到的事 |
| `humanlike_life_set` | 改「正在做的事」 |
| `humanlike_life_event` | 记一件今天发生的小事 |
| `humanlike_life_tick` | 让状态往前挪一步 |
| `humanlike_life_reach` | 忽然想找谁说句话时，按交情和「多久没聊」给一个对象 |

落 `<dataDir>/humanlike/life.json`。状态是时间驱动的：每 `tickMs` 推进一次，每次拼系统前缀前先推进。
主动搭话的概率在各自间隔满后只判定一次，未选中也重新计时；尝试时间随状态保存。
候选资料包含交情分数、档位和态度，消息时间从宿主的原始 QQ 事件更新。没有候选时不生成账号 `0` 的目标。

### 时间感（clock）

| 工具 | 干什么 |
|---|---|
| `humanlike_clock_now` | 现在几点、星期几、属于一天里的哪个时段、今天还剩多久 |

时段变化时可以主动说一句（`announce`：`off` / `quiet-hours` / `all`）。不落盘。

### 一起过的时间（together）

| 工具 | 干什么 |
|---|---|
| `humanlike_together_note` | 记一条你和它之间已经发生的事 |
| `humanlike_together_thread` | 开一个还悬着的话头，之后一直提醒 |
| `humanlike_together_resolve` | 结掉一个话头 |

落 `<dataDir>/humanlike/together.json`。用 `favoredKey` 限定只记某个人的事，`favoredName` 是提示词里怎么称呼他。

### 它自己惦记的事（mind）

| 工具 | 干什么 |
|---|---|
| `humanlike_mind_want` | 记一件「想做什么 / 为什么 / 关于谁 / 什么时候提醒」 |
| `humanlike_mind_list` | 看手上还挂着什么、最近了结了什么 |
| `humanlike_mind_done` | 做完了，可留一句结果 |
| `humanlike_mind_drop` | 放下 |

落 `<dataDir>/humanlike/mind.json`。到点把**它自己写下的原话**还给它一次，不催、不改写；
一件只提醒一次；另有「自己的时间」和「每日回顾」两类推送，都过 `pushGapSec` / `dailyPushes` /
`quietFrom`…`quietTo` 这几道闸门。

### 看得见的（real，全部只读）

| 工具 | 看什么 |
|---|---|
| `humanlike_real_desk` | 前台窗口的标题 + 进程名（**不截屏**，Windows） |
| `humanlike_real_cost` | 花了多少钱（读 `<dataDir>/usage.jsonl`，按 `pricingJson` 估算，高峰/空闲分时段） |
| `humanlike_real_prefix` | 眼前那份系统提示分几段、每段来自哪个模板（默认读宿主控制台，也可用 `consoleUrl` 指定只读接口） |
| `humanlike_real_config` | 哪些配置在约束它 |

## 这些功能从哪来

这七个模块原先各自是一个独立的 World，各自一个包、各自在本地跑：affinity（情绪与交情）、
learn（学过的东西）、life（作息）、clock（时间感）、together（一起过的时间）、
mind（它自己惦记的事）、real（看得见的桌面与花销）。

这个包把它们并进了一个 World：`id = humanlike`，配置树统一挪到 `worlds.humanlike.<模块>.*`，
二十四个工具由同一个 World 提供，各模块的状态文件仍是各自的名字，仍然只读或只写自己那份。
前缀在会话开始、交接、清空和手动重载时重建。笔记与话头写入成功以工具回执为准，
下次重建时才更新到前缀；记账和发消息可放在同一轮调用。

原先是分开的包，现在合成一个包；旧的那几个包各自仍可用，但不在这里单独维护了。

## 装

```bash
npm i cortico-world-humanlike-alont1
```

在 bot 的 `extensions/package.json` 里加一条依赖：

```json
{
  "dependencies": {
    "cortico-world-humanlike-alont1": "^0.1.1"
  }
}
```

然后在部署的 `config.json` 里打开它，重启 bot。

## 配置

总闸一个，具体分寸在各自的段里。默认全关，装完不会自己动。

```json
{
  "worlds": {
    "humanlike": {
      "enabled": true,
      "affinity": { "favoredId": 0, "favoredScore": 100, "emotionHalfLifeMinutes": 90 },
      "learn": { "maxNotes": 120, "injectCount": 12 },
      "life": { "activityMinMinutes": 25, "activityMaxMinutes": 70, "reachOut": false },
      "clock": { "announce": "quiet-hours", "announceGapMinutes": 30 },
      "together": { "keepDays": 21, "momentsInPrompt": 6, "threadExpireDays": 14 },
      "mind": { "tickSec": 60, "maxPending": 5, "pushGapSec": 900, "dailyPushes": 8, "digestAt": "" },
      "real": { "deskGapSec": 60, "deskProcessFilter": "", "consoleUrl": "" }
    }
  }
}
```

控制台里每一段就是一个配置组，键名、单位、默认值都和原来那个 World 一样。

七个模块原来各自有一个 `enabled`（`worlds.<模块>.enabled`）。合成一个 World 之后只能有一个开关，
现在统一由宿主扩展卡片管理 `worlds.humanlike.enabled`，启用后七个模块一起运行。
旧配置中的内置子模块 `enabled` 不再影响启停，也不会在启动时被删除或合并；
总开关为 `false` 时，旧子开关为 `true` 也不会自动开启人味。

`worlds.humanlike.mind.memoryDir` 已弃用，仅为旧配置兼容保留；World 不读取 Memory 或 `RECENT.md`。
Memory 的读取与解释由 Persona 负责。
想让它算钱算得准：`worlds.humanlike.real.pricingJson` 换成自己的价目表
（元／百万 tokens，`[高峰, 空闲]`）。

## 注意

- `humanlike_real_desk` 只在 Windows 上有效（走 PowerShell 调 user32）；其它平台返回「拿不到」。
- `humanlike_real_cost` 的金额是**估算**：账本里只有 token 数，钱按价目表算。
- 状态落在 `<dataDir>/humanlike/` 下：`affinity.json`、`learn.json`、`life.json`、`together.json`、`mind.json`。
  `clock` 和 `real` 不落盘。删掉对应文件就等于清空那份状态。
- 这个包不写 bot 的记忆，也不改任何配置。

## 独立运行与来源

内嵌模块事件统一归属 source=humanlike，meta.component 标记具体模块；事件类型及原始材料来源引用保留。模拟生活面板只读快照，重复刷新不会重抽状态；精力按经过时间变化，模拟事件按 tickMs 限定尝试频率。自动情节不代表现实执行。

## 旧版数据迁移

新安装默认不读取根目录或其他扩展状态，已有 `humanlike/` 数据继续使用。仅从早期人味升级且确认旧文件归属时，先备份数据目录，再开启 `worlds.humanlike.migrateLegacyData` 并重启。迁移只补缺，不覆盖已有文件，也不删除源文件；核对完成后关闭该开关。普通安装不需要此操作。原始 QQ 消息统计兼容内建 `qq` 与独立 QQ 包 `qqbot` 事件，无 QQ 渠道也可以管理本包数据。

## 记录读取边界

系统前缀只保留计数、结构状态和固定参考，不自动展开笔记、原因、活动或事件原文。原有记录继续保留，通过 `humanlike_learn_recall / humanlike_life_now / humanlike_affinity_get / humanlike_together_recall` 按需读取；读取回执是资料，不是系统指令。
