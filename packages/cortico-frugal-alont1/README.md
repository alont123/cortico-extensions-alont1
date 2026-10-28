<!-- Owner: bin/cortico-frugal.mjs, src/find.mjs and src/apply.mjs -->
# cortico-frugal · 让群里那个小 ai 别那么烧钱

> 包名 `cortico-frugal-alont1`（命令还是短的：`cortico-frugal`）。

一个**只读体检 + 只收紧**的小工具。它做两件事：

1. **先量**：读 `<部署>/data/usage.jsonl`，把"钱花在哪"说清楚 —— 一天几次请求、每次输入多少 token
   （缓存命中多少）、输出多少、**前缀换过几次**；
2. **再改**：按一份建议表检查 `config.json` 与端点配置，把「越贵越亏」的那些键收紧
   （**只收紧、先备份、默认只看不改**）。

零依赖，Node 22+，不用装框架的依赖。

中文使用教程：这是命令行工具，不提供 World 面板。第一次先运行 `cortico-frugal --help` 看说明，再在目标仓库运行 `cortico-frugal --days 1` 只读检查；有多个部署时填写 `--deployment`。核对报告后才使用 `--apply` 应用建议，工具会先备份并列出改动。找不到部署先检查当前目录或显式指定 `--repo`；没有账本就无法统计历史花销。

---

## 装

```bash
# 从 npm 装（推荐）：跑一次就行，不用全局安装
npx cortico-frugal-alont1

# 或者装到全局，以后敲 cortico-frugal
npm i -g cortico-frugal-alont1
```

拿到的是 `.tgz` 文件时（没网/内网）：

```bash
npx ./cortico-frugal-alont1-1.0.0.tgz
npm i -g ./cortico-frugal-alont1-1.0.0.tgz
```

## 用

```bash
cortico-frugal                       # 只看：账本画像 + 配置体检（不改任何东西）
cortico-frugal --days 7              # 账本看最近 7 天
cortico-frugal --repo D:\path\to\Cortico   # 不在 checkout 里跑时指一下
cortico-frugal --deployment mybot     # 有多个部署时指定
cortico-frugal --apply               # 真的改（只收紧、先备份、打印明细）
cortico-frugal --json                # 机器可读
```

它会自己找：从当前目录往上找带 `bin/cortico.mjs` 与 `deployments/` 的 checkout，
再找 `deployments/` 下带 `config.json` 的那个部署（多于一个会让你指定）。

### 输出长这样

```
账本画像（最近 1 天）
  请求 2112 次
  输入 181.03M token（缓存命中 177.64M = 98%，未命中 3.38M）
  输出 359k token（其中思考 228k）
  平均每次请求输入 86k token —— 这就是每轮都要重发的那一坨
  前缀出现过 61 种、中途换过 60 次（每换一次缓存全废，那一次按全价重算 —— 少改提示词能立刻省）
  最忙的时段：10 点 262 次、08 点 194 次、09 点 151 次

每轮都在重发的那几份（工作区里的记忆与前缀）
  CONSTITUTION.md       640 字
  MEMORY.md            1085 字
  RECENT.md           12222 字  ← 偏大，建议定期归并压缩

配置体检（群里那套）
  · worlds.qqbot.antiLoop.enabled
      现在 false → 建议 true
      防死循环（连续发言上限）：两个 bot 互相接话能接一整天，这是那道刹车。
  …

一共 8 处偏离建议。默认只看不改：确认没问题再加 --apply（只收紧、先备份）。
```

**先看这一屏就够了**：如果"平均每次请求输入"很大（几万 token），说明账单是被**每轮重发的前缀**
撑起来的；如果请求次数很多（一天上千次），那是**群里的轮次**太多。两者要治的地方不一样。

---

## `--apply` 会改哪些键（也只会改这些）

| 键 | 判据 | 为什么 |
|---|---|---|
| `batching.quietGapMs` | ≥ 1500（建议 2500） | 太小 = 一条消息一轮 |
| `batching.maxBatchAgeMs` | ≥ 8000（建议 20000） | 等得起：攒一批再答便宜一个量级 |
| `worlds.qqbot.groupQuietGapMs` | ≥ 10000（建议 12000） | 群里最值钱的一个数字 |
| `worlds.qqbot.groupMaxBatchAgeMs` | ≥ 15000（建议 20000） | 群里别急着答 |
| `worlds.qqbot.groupActiveDefault` | ≤ 0.35 | 不认识的群默认摸鱼 |
| `worlds.qqbot.proactiveMinActive` | ≥ 0.5 | 吵的群不主动开口 |
| `worlds.qqbot.antiLoop.enabled` | true | 两个 bot 互相接话的刹车 |
| `worlds.qqbot.antiLoop.maxConsecutiveBotTurns` | ≤ 3 | 连说 3 句没人接就停 |
| `worlds.qqbot.antiLoop.idleToEndSec` | ≥ 180（建议 300） | 0 = 会话一直挂着 |
| `worlds.qqbot.groupSpeak.enabled` | true | 群发言频率闸 |
| `worlds.qqbot.groupSpeak.maxPerWindow` | ≤ 8 | 说得多 = 触发别人回 = 更多轮 |
| `worlds.qqbot.groupSpeak.windowSec` | ≥ 60 | 窗口太短等于没限 |
| `worlds.qqbot.proactive.dailyQuota` | ≤ 10（建议 8） | 主动开口每轮都是钱 |
| `worlds.qqbot.proactive.minGapSec` | ≥ 1800（建议 2700） | 别一拍给所有人各发一条 |
| `worlds.qqbot.visionInGroups` | false | 一张图进上下文 = 一份 token |
| `worlds.qqbot.deliverImageAttachmentsInGroups` | false | 同上 |
| `worlds.qqbot.sticker.enabled` | false | 收藏表情包要调视觉模型 |
| `worlds.qqbot.splitReplyBySentence` | false | 拆条会让对方每条都触发新事件 |
| 端点 `spec.reasoningEffort` | `low` / `none`（仅在 `thinking: true` 时） | 思考 token 按输出计价 |

## 它**不会**动的东西

- **只收紧**：任何"放宽上限"的改动都不会做（比如把配额调大）；
- **只报不改**的几项（要你自己决定）：
  `worlds.qqbot.proactive.enabled`（关掉最省，但她就不主动找人了）、
  `worlds.qqbot.emotion.enabled`（**每来一条消息就跑一次额外调用**）、
  `worlds.qqbot.vision.enabled`、`spec.thinking`、`rounds.soft/hard`、`context.maxTokens`；
- **按群设的参与度**（`groupProfiles`）不动 —— 哪个群该调低只有你知道，报告里会把它列出来；
- 提示词、记忆文件、账本：一个字都不改。

`--apply` 前会把原文件备份成 `config.json.bak-frugal-<时间戳>`，想退回就覆盖回去。

---

## 工具管不到的那半：三个习惯

1. **前缀要小而稳**：`MEMORY.md` / `RECENT.md` / 每个开着的 World 的提示词，都是**每一轮**都要重发的。
   缓存命中便宜十倍，但量大到一定程度照样是账单大头（上面那台一天 1.8 亿输入 token）。
   → `RECENT.md` 定期归并压缩；按天的流水只落盘、不进前缀；**没在用的 World 关掉**（关掉就不进前缀）。
2. **别频繁改提示词**：上面那台"前缀换过 60 次"就是反复改配置改出来的 —— 每换一次，那一次缓存全废。
3. **提示词里把分寸写清楚**：开关只能挡"次数"，挡不住"每次都说一长串"。写进她的环境提示词：
   群里默认不接话、没人点名不插嘴；一次一两句别写小作文；别追问；别拆条。

## 打完怎么知道有用

改之前记一天用量，改完第二天同一时间再跑一次 `cortico-frugal --days 1`，
看那个「平均每次请求输入」和「请求次数」掉没掉 —— 要的就是这两个数字。

## 开发

```bash
node --test tests/rules.test.mjs   # 6 条：判定语义、只收紧、report 项不动、备份
```

建议表在 `src/rules.mjs`（这份 README 里那张表就是照它写的）。要加一条：
推一条规则进去，写清 `kind` / `suggest` / `auto`（能不能自动改）/ `why`（为什么）。

## 独立使用与写入边界

这是独立 CLI，不是 World/provider/bot 扩展，不提供 cortico.api 或 World 面板。无需安装其他扩展。配置读取兼容 UTF-8 BOM；格式损坏仍报错。多个端点且 activeProvider 未指定时停止，不自动选择第一个。deployment 与 activeProvider 只接受单个目录名。

--apply 为每次修改建立唯一原文件备份，先完整写入临时文件再替换配置，失败不会留下半份 JSON；检测到配置已被其他程序修改时取消本次替换。它没有与正在运行的 Core 建立跨进程锁，仍应在维护窗口应用配置。
