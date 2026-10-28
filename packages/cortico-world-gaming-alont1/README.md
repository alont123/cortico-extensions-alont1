<!-- Owner: src/definition.ts, src/world.ts, src/ENV_PROMPT.md -->

# cortico-world-gaming-alont1

> **0.1.15**：控制台最前面加「① 快速配置」——窗口选择下拉 + 游戏库 6 个格子（带教程），
> 游戏库三处来源（原 games 数组 / 快速格子 / data/gaming-lib.json）自动合并；新增 gaming_library 工具增删游戏。
> **0.1.14**：内置余额查询/看图工具"耐久度"——定期查 DeepSeek 余额，低于预警线时提醒她"看图工具耐久度不足了"；
> 预警线、满格余额、提醒文案、查询间隔都可在 `worlds.gaming.balance` 改；另有 `gaming_balance` 工具随时查。
> **0.1.13**：画面改成"刷 B 站"那套抓帧法——一次连抓 4 帧、dHash 去重、拼成一张分镜网格再喂视觉模型；
> 控制台的"只看这个窗口"会列出当前可见窗口供快速选择（也可用工具 gaming_windows / gaming_watch_window 选）；
> 每次开新游戏自动搜一次资料；对局中改为"多报点、少讲理解、可以就画面闲聊"。

> **本地待发布修复（2026-10-23）**：自动看图与 `gaming_look` 都先确认前台进程属于当前游戏；切到搜索框、桌面或浏览器时直接说明“游戏没在前台”，不启动抓图。进程名兼容大小写、引号与 `.exe`。`gaming_watch_window` 的 `target` 是进程、`title` 是标题关键字（不分大小写），同时填写时必须同时满足；单帧、多帧使用同一选择器，取最大的匹配窗口。主窗最小化不会改抓同名小窗。手动钉窗口可用 PrintWindow 读取后台窗口自身的画面；屏幕兜底仅在该窗口处于前台且未最小化时允许，切走的帧会丢弃。没有窗口、最小化、不在前台、超时均返回中文原因，不回传命令或临时路径。多帧抓图失败不重复执行单帧；只有后续拼图/文件读取失败才允许单帧兜底。真实游戏、独占全屏与反截屏支持仍需单独验证。

陪玩 World：读前台窗口，知道主人（或使用者）在玩哪款游戏、玩了多久，
在开局 / 换游戏 / 玩太久 / 深夜还在玩的时候递一句过去。不玩游戏的时候安静待着。

打开 `watch` 之后还会**看画面**：定期抓一张游戏截图交给视觉模型读，
读出"这一局刚打完"就把看到的东西交给她。

**只支持 Windows**——靠 Windows API 读前台窗口和抓图。

## 它做什么、不做什么

**做**：知道他在玩什么，以及在他可能想被搭话的时候把这个事实交给模型。

**不做**：不替模型决定说什么。推过去的是一条事件（"他开游戏了，正在玩 X"），
模型按自己的人格决定理不理、说什么口吻。所以 `reachOut` 关掉之后它依然有用——
它还是个"她知道你在玩"的上下文来源，你说话时她接得上。

## 装

控制台「扩展」页搜 `cortico-world`，或者：

```bash
cd extensions
corepack pnpm add --ignore-workspace cortico-world-gaming-alont1
```

`--ignore-workspace` 不能省。装完**重启进程**，World 定义在启动时读取。

## 开

部署的 `config.json`：

```jsonc
{
  "worlds": {
    "gaming": {
      "enabled": true,
      "reachOut": true,
      "games": [
        {
          "id": "tarkov",
          "name": "逃离塔科夫",
          "processes": ["escapefromtarkov"],
          "aliases": ["塔科夫", "Tarkov"],
          "watchFor": "活着出来没、带出多少"
        }
      ]
    }
  }
}
```

**`games` 必须填，不然它什么都看不到。** 默认 `knownGamesOnly: true`，含义是
"游戏库里没有的就不算游戏"——库空着就等于永久判定"没在玩"，而且不报错、不打日志。
控制台「陪玩」页的「在玩」那盏灯会直接告诉你库是空的。

`processes` 填任务管理器里那个进程名（不带 `.exe`，小写）；`aliases` 填窗口标题里可能出现的
别名，进程名是通用启动器时用它兜底。两个都对不上就认不出来。

**不想先填库**：把 `knownGamesOnly` 设成 `false`，任何非黑名单程序只要有窗口标题就算在玩。
装完立刻有反应，代价是浏览器、加速器、聊天窗口偶尔会被当成游戏。

## 它怎么看出来的

每 `pollMs`（默认 2 秒）读一次前台窗口的**进程名 + 窗口标题**。

判定分两层，**第 2 层默认是关的**：

1. **游戏库里认得的** —— 按进程名或标题里的别名匹配。最稳，默认就走这条。
2. **库里没有的** —— 进程名不在"这不是游戏"的默认表里（浏览器、编辑器、聊天工具
   等几十个），而且窗口有标题。算作"一个没记下来的游戏"，用文件描述当名字。
   **只有把 `knownGamesOnly` 设成 `false` 才会走这一层。**

第 2 层是为了**临时玩个新游戏也能被看到**，代价是个别程序会误判。
所以环境提示词里明确写了：**别把这件事当确凿事实说**。

窗口标题会一起交给她当**参考材料**——有些游戏标题里有关卡或地图名，
她能用上就更具体。但标题也可能夹着不相干的字，所以提示词里写了"读错了比不读更难看"。

## 看画面（可选，默认关）

进程名看不出屏幕里发生了什么。打开 `watch` 之后，游戏确实在前台时每 `everySec`
抓一张客户区截图，缩到 `maxWidth` 以内，交给视觉模型读成四行：

```
局面：交战中 / 结算或战后 / 主菜单或准备 / 其他
画面：一句话说清屏幕上发生了什么
可说：是 / 否　（这一帧有没有值得跟他说一句的事）
因由：可说时一句话说清"刚发生了什么"，不可说就写"无"
```

**一局刚打完就把「画面」交给她**，这是最能接上话的一刻。`midMatch` 开着时，
**局中值得说的事也会交给她**——刚击杀、刚被击杀、刚买到或解锁装备、血量见底。
平时读到的内容通过 `gaming.observation` 外部状态事件，在其他事件唤醒时附带投递。
游戏名称、窗口标题、网页搜索摘要和画面读数不进入 system 前缀。
`gaming_now`、`gaming_recent` 和 `gaming_look` 提供当前状态与历史记录。

几处刻意的设计：

- **只在游戏确实在前台时抓。** 切出去看攻略时抓到的是浏览器，拿来说"你这局怎么样"就是胡说。
- **上次的画面描述一起给模型。** 单帧判断不出"刚发生了什么"；有了上一帧它才能分清
  哪些是新事、哪些还挂在屏幕上。实测：同一个界面第二次看会判"否"。
- **"刚打完"按状态判断，不按时间。** 结算画面会挂几十秒，抽帧连着看到的每一张都是
  `result`；只在从非 `result` 进入 `result` 那一刻开口，同一局就只报一次。
- **局中的事前后的「因由」去重。** 说不出来由、或者跟上一句是同一件事，就不说。
- **读数有有效期。** 超过 4 分钟就不进入新的观察状态事件——一条十分钟前的"你正在菜单里"，
  现在他可能正打到一半，说出来就是错的。提示词里也写了"画面只是抽的一帧，别说成你现在"。
- **`watchFor` 是给这个游戏的提示。** 写在游戏库那条上，比如"打的是哪张图、赢没赢"，
  模型会顺着它多看几眼。

每次都是真调一次视觉模型，**开着就有费用**。用量上报给宿主，记进 session 统计和
`usage.jsonl`（标签 `看画面`）。

网页搜索摘要使用 `origin: external`，按 `piggyback` 投递；搜索失败不影响窗口识别与看图。
`gaming.observation` 在启动、上下文交接和主循环结束后排队，投递时读取最新状态，带 `snapshot` 标签。
关闭 `reachOut` 只关闭主动提醒，观察状态仍可随其他事件投递。环境提示词只保留会话、
看图能力、读数有效期与耐久度等固定状态；工具回执中的标题、网页和画面文字保持其观察资料的来源。

关闭思维链要按端点方言给参数，`thinking:{type:'disabled'}`（DeepSeek 原生）和
`reasoning:{enabled:false}`（OpenRouter）**两个都发**：写错的那个会被静默忽略，
而思维链和正文共用 `max_tokens`，图一复杂就把预算吃光，`content` 返回空串而 HTTP 仍是 200。

## 配置

控制台「陪玩」页，或直接改 `config.json`：

```jsonc
{
  "worlds": {
    "gaming": {
      "enabled": true,
      "reachOut": true,
      "reachMinGapMinutes": 12,
      "reachMaxPerDay": 0,
      "longSessionMinutes": 120,
      "lateNightStartHour": 1,
      "lateNightEndHour": 5,
      "awayMinutes": 8,
      "pollMs": 2000,
      "games": [
        {
          "id": "tarkov",
          "name": "逃离塔科夫",
          "processes": ["escapefromtarkov"],
          "aliases": ["塔科夫", "Tarkov"],
          "watchFor": "活着出来没、带出多少"
        }
      ],
      "nonGameProcesses": ["某些我不想被当成游戏的程序"]
    }
  }
}
```

| 旋钮 | 默认 | 说明 |
|---|---|---|
| `reachOut` | `true` | 关掉就只提供上下文，不主动推事件 |
| `reachMinGapMinutes` | `12` | 两次主动的兜底间隔。**别设太大**——陪伴感来自"她在旁边看着" |
| `reachMaxPerDay` | `0` | 0 = 不限 |
| `longSessionMinutes` | `120` | 每跨越一次这个数报一次"该歇歇了" |
| `lateNightStartHour` / `lateNightEndHour` | `1` / `5` | 深夜时段。**跨午夜用起始 > 结束表达** |
| `awayMinutes` | `8` | 切出去多久才算不玩了。看攻略不算结束 |
| `pollMs` | `2000` | 采样间隔 |
| `games` | `[]` | 游戏库。留空就全靠标题认 |
| `nonGameProcesses` | `[]` | 追加的"这不是游戏"进程名 |
| `watch.enabled` | `false` | 看画面总开关。开着会调视觉模型，有费用 |
| `watch.everySec` | `90` | 隔多久看一眼。抽帧，看到的不是连续过程 |
| `watch.speakGapSec` | `180` | 两次因画面开口的兜底间隔（结算和局中共用） |
| `watch.midMatch` | `true` | 局中也插话。关掉就只在"一局刚打完"时开口 |
| `watch.maxLooksPerSession` | `0` | 一次连续游戏里最多看几次。0 = 不限 |
| `watch.baseUrl` / `watch.model` | — | OpenAI 兼容端点与模型名。模型空 = 不可用 |
| `watch.maxWidth` | `1024` | 截图缩到这个宽度以内再送模型。越小越省 |

看画面要一把视觉模型的密钥，名字固定是 `OPENROUTER_API_KEY`（和框架内建的识图共用同一个名字，
但填谁的 key 由你决定）——写进**部署目录的 `.env`**，和 `config.json` 同一层。
没填就是「看画面不可用」，其余功能不受影响。

**你还需要什么**：一个能跑扩展的 Cortico 实例（契约 `cortico.api` = 4）。
其余都不需要——这个包没有任何第三方依赖，也不依赖别的 World 扩展。

### 关于主动频率

`reachMinGapMinutes` 只是个兜底。真正的约束是**事件本身稀疏**——
开局、换游戏、玩太久、深夜。所以它不会变成刷屏，也不该靠压间隔来防刷：

- 想更黏人 → `reachMinGapMinutes` 调到 5~10，`longSessionMinutes` 调小
- 想安静 → 把 `reachOut` 关掉，需要时模型自己查 `gaming_now`

## 它给模型什么

三个工具：

| 工具 | 干什么 |
|---|---|
| `gaming_now` | 现在在玩什么、这一局多久、今天玩过什么 |
| `gaming_recent` | 最近的开局/换游戏/退出记录 |
| `gaming_look` | 现在看一眼他的画面。绕开抽帧间隔，给的是最新的 |

加上两段进系统前缀的环境提示词（陪玩、最近一次看到的画面），每轮都带着当前状态。
所以**他不说话的时候她也知道**，不用等事件。

## 状态文件

`<dataDir>/gaming.json`，按天存：

```jsonc
{
  "day": "2026-09-20",
  "session": { "gameId": "tarkov", "minutes": 47, ... },   // 没在玩就是 null
  "todayMinutes": { "tarkov": 132, "pixel": 25 },
  "totalMinutes": { "tarkov": 1400 },
  "learned": { "stardew": "Stardew Valley" },              // 库里没有、靠标题认的
  "events": [ /* 最近 40 条 */ ],
  "todayReachCount": 3
}
```

跨天自动重置当日统计。文件用临时文件 + 原子 rename 写，写一半断电不会留半个文件。

## 排错

**控制台「采集」灯是 offline**
采集器没起来。它是常驻的 `powershell.exe`；如果这台机器禁了 PowerShell 或者不是
Windows，它起不来。看日志里有没有 `World 已启动: gaming`。

**一直显示在玩某个奇怪的东西**
那是第 2 层判定（库外程序）误判了。把它的进程名加进 `nonGameProcesses`。
进程名就是任务管理器里那个。

**时长不涨**
`awayMinutes` 设太小会让它在切窗口时反复结束重开。默认 8 分钟是给"切出去看攻略"留的余量。

**它主动得太少**
先看 `reachMinGapMinutes`。再看是不是每次都在"刚玩过又开"的窗口里——
`freshSessionAfterHours`（默认 4 小时）内的重开不算新开局。

**深夜提醒在白天响**
`lateNightStartHour` / `lateNightEndHour` 配错了。这个区间**跨午夜用起始 > 结束**表达；
起止相同表示没有深夜时段（不提醒）。

## 开发

```bash
corepack pnpm install
corepack pnpm typecheck
```

测试（用假窗口和假时钟，不碰真桌面）：

```bash
node --import tsx tests/logic-test.mjs      # 判定与状态机
node --import tsx tests/screen-test.mjs     # 画面读数解析与可用性判定
node --import tsx tests/tracker-selftest.mjs  # 真读一次前台窗口，验编码没问题
```

看画面那条链要真窗口和真密钥，测试里不跑。手工验：

```bash
node --import tsx <某处>/screen-look-test.mjs [进程名] [游戏名] [留意什么]
```

`"type": "module"` 是硬要求。契约版本 `cortico.api` 是 4。

## 许可

MIT
