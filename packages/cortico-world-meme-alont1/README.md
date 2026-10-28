# 梗（cortico-world-meme-alont1）

让 bot 会查网络梗、会接龙，但不硬编、不刷频。

## 工具

| 工具 | 干什么 |
|---|---|
| `meme_search` | 查梗：本地梗库优先，没收录才联网（萌娘百科 → Bing）。返回全称/含义/出处/常见接龙/语气/来源。 |
| `meme_chain` | 验接龙：给梗名（+可选候选句），判断接得对还是假的；不填候选句返回常见接龙。 |
| `meme_note` | 把学到的梗记进本地梗库（`<dataDir>/meme/memes.json`），下次直接命中。 |
| `meme_stats` | 看查梗用量：今天/本小时已用次数、剩余额度、本地库条数。 |

## 频率限制

只约束**联网搜索**（本地命中不算）：`worlds.meme.minIntervalSec`（默认 45 秒）、`hourlyCap`（6/小时）、`dailyCap`（24/天）。超了返回「先别查」的提示，而不是默默失败。

## 梗库

- 内置种子：KSKBL（康神开播了）/ zdjd（真的假的）/ wkzkbl / 丸辣 / city不city / 那咋了 / 包的 / 我老爸得了MVP。
- 她自己记的：`data/meme/memes.json`，上限 300 条。
- KSKBL 的接龙真假写在种子里：下一句接 `zdjd（真的假的）`、`wkzkbl（我靠真开播了）` 都是真的；库里没记录的接法会提示「可能是别家的梗或编的」。
