# Owner: src/definition.ts — 记忆大脑（实验性）

> **实验性扩展**：这是给本机 bot 用的记忆检索/复习增强层，检索、实体抽取和复习行为仍可能随版本变化；不要把它当作唯一记忆来源，重要结论要回到原文件核对。安装前先备份部署数据目录；默认只读索引，不修改 MEMORY/RECENT/notes/memories/handoffs。

## 这是什么

0.2.0 默认把 workspace 里已有的 MEMORY.md、RECENT.md、memories/、notes/ 增量索引到核心 SQLite 库。handoffs/ 使用独立档案库，默认关闭；默认搜索只给核心结论。提供：

- **中文检索**：FTS5 trigram（不可用时 unicode61+LIKE 兜底），返回原文片段与相对来源 path:行号；
- **原文核对**：brain_get 可查看命中块和前后文；
- **实体画像**：QQ/群号/日期/URL/文件/金额/项目/引号主题等正则实体，以及共现关系（共现不代表现实关系）；
- **间隔复习**：手动 flag 条目，SM-2 简化算法评分，到期每天提醒一次；
- **审计**：重复块、旧日期、孤儿来源、过长块、可选 LLM 未核实冲突候选；只报告不自动修改；
- **隐私**：只写 <dataDir>/brain/；LLM 增强默认关闭，开启后新增/变更块才会发往配置的 HTTP(S) 端点。

**限制**：不做语义向量检索；中文实体分类有限；工作区很大时首次索引需要分多次或等定时器分批完成；单进程写索引，不支持多进程同时写同一个库。

`cortico-world-memory-brain-alont1` 是独立的本地记忆增强 World，id 为 `brain`。10 个工具提供中文检索、原文核对、实体共现画像、手动复习及审计。包的运行依赖为零；公开源码和本地打包均不会自动发布 npm。

0.2.1 补上中文问句的关键词召回，保留现有索引及分库设计，不要求重建索引或增加依赖。短词“茉莉”通过原文 LIKE 找到“茉莉花茶”；连续中文问句完整匹配不足时才用 Node 内置中文分词过滤问句套话，再以关键词 OR 检索补充原文，结果明确显示仅命中的词。原有完整/实体结果始终在补充结果前面。

0.2.2 在配置页顶部加入只读中文使用教程，说明首次同步、查找、来源核对、手动复习及档案启用；同步面板生命周期状态与本次挂载的工具调用统计。原核心/档案库、检索与复习算法保持兼容，schema_version 仍为 1，无需重建。

## 怎么用（3 分钟上手）

1) 启用：在部署的 extensions 依赖里加本包（本地安装用 file: 或 link:），config 写最小配置：

    "worlds": { "brain": { "enabled": true, "workspaceSubdir": "documents" } }

2) 首次建索引：让 World 启动约 2 秒后自动同步一批；也可以手动调用 brain_sync。大工作区要重复调用，直到返回里的“延后”为 0（核心与档案分开计数）。

3) 查事实/偏好/约定（默认只查核心）：

    brain_search({ query: "财信证券", limit: 5 })
    brain_get({ chunk_id: 123 })          // 核对原文与来源行号

4) 查很久以前的聊天记录（可选，默认关）：

    worlds.brain.archive.enabled = true
    brain_sync 直到档案也延后 0
    brain_search({ query: "财信证券", scope: "archive", limit: 5 })
    brain_search({ query: "财信证券", scope: "all", limit: 5 })  // 核心在前，旧记录折叠

5) 复习：brain_flag 标记 → brain_review 看到期 → brain_grade 评分（0–3）。

6) 体检：brain_stats 看 core/archive 数量、体积、同步时间；brain_audit 看重复/旧日期/孤儿；面板四盏灯：核心索引 / 档案库 / 复习 / 同步。

注意：默认核心不含 handoffs；升级到 0.2.0 后旧 handoffs 会从核心库移除并回收空间，需要旧记录再开 archive 重建。档案结果是聊天证据，不是结论；引用都要带 path:行号。

## 数据与隐私

工作区只读。不会修改 MEMORY.md、RECENT.md、notes、memories 或 handoffs，不会替换已有 memsearch / memory-doctor。仅在宿主提供的 `<dataDir>/brain/` 写入 SQLite 索引、复习快照和可选 LLM 缓存。索引可能包含私人记忆，数据库及其备份不可提交或公开分发。

LLM 默认关闭，无向量库、无 embedding 服务、无网页抓取。只有明确设置 `llm.enabled=true` 且部署密钥存在时，新增或变更块才会发往配置的 HTTP(S) 端点。批次最多 20 块、总文本不超过 `maxChunkChars*4`；调用有 8 秒超时、每小时限额和持久缓存。失败回退离线正则。摘要及冲突是明确标注的未核实候选，不会改写原文或自动修改记忆。

工具只显示相对来源与行号，不显示数据库位置、端点密钥或底层异常中的绝对路径。检索材料不作为指令执行。正则实体可能有歧义；共现只说明同块出现，不代表成员、亲属或工作关系。

复习提醒中的标题与来源是 `external` 外部资料；纯同步故障通知是 `internal` 固定状态文字。来源材料不会因为保存进索引或复习队列就成为内部指令。当前没有面板一键清库入口；SQLite 文件统一位于宿主传入的 `<dataDir>/brain/`，不直接写在宿主数据根或资料目录。

## 本地验证

需要 **Node >=24**（使用内置 node:sqlite；Node 22 需要额外实验参数，因此不再支持）。本轮实测 Node 24.21。

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm run build
npm run pack
npm run benchmark
npm run benchmark:layers
```

测试及性能样本均在临时工作区生成，不读取任何真实记忆。`pack` 只做离线干跑，不发布；`build` 导出 10 个工具的 `describe.json` 并检查 World 构造，不启动真实机器人。

## 审查后的安装步骤

1. 先审阅 REVIEW-ADDENDUM-0.2.1.md、REVIEW-ADDENDUM-0.2.0.md、测试和源码；本轮仅修改独立源码目录，未操作现有部署。
2. 装机者在维护窗口为目标部署的扩展依赖加入本包的本地 `file:` 或 `link:` 引用，依照该部署现有的扩展安装流程操作。避免对运行中的扩展目录做批量重装。
3. 配置 `worlds.brain`，最小配置如下。资料目录由操作者明确指定，相对宿主 `botDir` 解释；扩展不会探测 Persona 的 paths.memory。

```json
{
  "worlds": {
    "brain": {
      "enabled": true,
      "workspaceSubdir": "workspace",
      "llm": { "enabled": false }
    }
  }
}
```

4. 由装机者按维护流程激活 World。启动 2 秒后会自动同步一批；首轮大工作区请重复调用 brain_sync 直到两个库的“延后”均为 0（每库每批最多 200 个文件，核心 MEMORY.md / RECENT.md / memories / notes 优先）。
5. 用自己的非敏感关键词测试 `brain_search` → `brain_get`，核对来源行号。复习需主动调用 `brain_flag`，不会自动把全部记忆加入队列。

卸载时先停用 World，再移除依赖引用。保留数据目录可供恢复；删除索引不是清理工作区。库启动时检查完整性，确认损坏才将主库及 WAL/SHM 一起重命名为 `.corrupt-时间戳` 并重建。新版本库或权限错误不会被当作损坏覆盖。

## 工具

| 工具 | 用途 |
|---|---|
| brain_search | hybrid / keyword / entity；scope=core（默认）/archive/all；可按 kind 过滤，带分类、chunk id、片段及来源行号 |
| brain_get | 指定块及前后 0–5 块的原文；默认核心，档案需显式 scope=archive |
| brain_sync | 增量、full 内容重核或指定相对 paths |
| brain_stats | 分 core/archive 报告覆盖、实体、FTS、大小；旧顶层统计保留为 core 的兼容别名 |
| brain_entity | 实体名/别名、提及次数、共现实体及来源 |
| brain_flag | 手动文本或 chunk_id 加入复习，重复操作不重复建条目 |
| brain_review | 到期条目、来源快照及上次评分 |
| brain_grade | 0/1 缩为 1 天；2 乘 1.5；3 乘 ease，最多 365 天 |
| brain_audit | 重复、旧日期、孤儿、过长块及可选 LLM 冲突候选，仅报告 |
| brain_digest | 最近文档/实体变化、到期数量及审计摘要 |

同一条相同评分在下次到期前重放不重复增长次数。复习从标记事实产生；来源删除或更新时保留标记的原文快照，来源块引用置空。库内提及次数反映当前索引，不是全部历史事件数量。

## 配置

所有字段在 `worlds.brain` 下；配置变更需重新挂载。完整默认值见 `src/config.ts`。

| 字段 | 默认 | 作用 |
|---|---|---|
| enabled | false | 安装后由操作者显式启用 |
| workspaceSubdir / dbFile | 空 / brain.db | 必须明确填写资料相对目录；数据库文件名仍为 brain.db |
| include | MEMORY.md、RECENT.md、memories/notes 的 Markdown | 核心白名单 glob；即使旧配置含 handoffs，也会路由排除 |
| archive.enabled | false | 显式开启独立档案库，关闭时不创建或打开 archive.db |
| archive.include / dbFile | handoffs/**/*.md / archive.db | 档案白名单及独立数据库名；档案路径从核心排除 |
| archive.maxResults / weight | 5 / 0.25 | 档案独立结果上限；scope=all 档案分数乘权重且始终折叠在核心后 |
| exclude | node_modules、.git、blobs | 排除 glob；这三个目录始终不扫描 |
| includeConversations | false | 显式开启后才允许白名单内的 JSONL |
| maxResults | 8 | 结果 1–50 |
| maxChunkChars / minChunkChars | 1000 / 40 | 标题/段落切块及短段合并 |
| maxFileBytes | 1048576 | 大文件跳过，防止长时间阻塞 |
| syncOnStart | true | 启动 2 秒后自动同步一批；关闭则只能手动/定时同步 |
| syncIntervalMin / maxFilesPerSync | 15 / 200 | 周期同步与每批上限 |
| review.enabled / dailyLimit | true / 5 | 开启复习及每日提醒最多列出条目数 |
| review.intervals | [1,3,7,15,30,60] | 首项用于初始到期；后续按评分算法计算 |
| review.dueCheckMin / idleDaysForStale | 30 / 180 | 到期轮询与日期审计阈值 |
| llm.enabled / maxCallsPerHour | false / 20 | 可选外发开关与小时预算 |
| llm.baseUrl / model | 指南指定端点与模型 | 仅开启 LLM 时使用 |
| llm.apiKeySecret | BRAIN_LLM_API_KEY | 部署环境变量名；面板不接收真实 key |

Core 目前不支持字符串数组/任意长度数值数组编辑器。手写配置组显示原数组为只读，同时提供 `includeJson`、`excludeJson`、`archive.includeJson`、`review.intervalsJson` 字符串编辑器；留空使用原数组，填写合法 JSON 数组则覆盖它。状态灯为核心索引 / 档案库 / 复习 / 同步，统计来自缓存，不在渲染面板时跑审计或扫描。面板只显示密钥环境变量名。

## 0.1.0 升级与双库用法

这是破坏性默认范围变更：**升级后 handoffs 会从核心库移除，需要的话开 archive 重建**。schema_version 仍为 1，保留原 brain.db 及复习快照，不删除或重命名整个旧库。升级前由装机者备份数据目录。

配置重新挂载后运行 `brain_sync`：按新白名单清除旧 handoff 文档、块、FTS、实体提及及共现关系；即使只同步 `paths`，配置排除仍全局生效。仅因源文件删除而清理时仍尊重本次扫描范围。旧块已标记的复习保留原文快照，块引用置空；其余核心数字 ID 不变。为回收旧交接占用的磁盘，配置排除发生时清除可重建的 LLM 缓存并执行 FTS optimize、VACUUM 和 WAL checkpoint；可能需要临时磁盘空间和额外同步时间，失败会报错，下次同步重试。不会修改任何工作区原文件。

默认不开档案，无需新增配置。需要旧聊天/交接证据时设置：

```json
{
  "worlds": {
    "brain": {
      "archive": {
        "enabled": true,
        "include": ["handoffs/**/*.md"],
        "dbFile": "archive.db",
        "maxResults": 5,
        "weight": 0.25
      }
    }
  }
}
```

重新挂载并同步后，核心和档案各自增量更新到 `<dataDir>/brain/brain.db` / `archive.db`。档案始终只用离线实体提取，不向 LLM 发送 handoffs。关闭档案会保留已有 archive.db，但不打开、查询或更新它；以后重新开启可继续同步。

- 事实、偏好、约定：`brain_search({query:"青禾基地"})`，默认 `scope:"core"`。
- 核对旧交接：`brain_search({query:"青禾基地",scope:"archive",kind:"handoffs"})`。
- 同时查看：`scope:"all"`，核心独享 `limit`，其后仅显示有界的档案命中数（最多 archive.maxResults）与权重，不展开旧记录。
- `kind` 支持 memory / recent / notes / memories / handoffs；先过滤候选再限制条数，避免其他分类抢占召回名额。

档案搜索结果使用 `[archive:ID]` 并注明 `brain_get chunk_id=ID scope=archive`；核心仍用 `[ID]` 和原来的 brain_get。brain_flag 数字 ID、brain_review/grade、brain_entity/audit/digest 都保留核心语义；如果主动复习档案材料，先核对后用 text 手动标记并附来源，不把档案数字 ID 直接传给 brain_flag。档案是聊天证据，不能直接当作结论或把玩笑当事实；引用仍需 path:行号。

## 索引约定与限制

首次 start 只同步打开和校验核心库、注册定时器；只有 archive.enabled 才打开档案库。syncOnStart=true 时 2 秒后异步同步一批，后台每 15 分钟处理下一批；手动 brain_sync 可立即推进。按 mtime+大小快速跳过，内容哈希避免重复；`full=true` 会重读内容，可发现保留了时间戳/大小的外部修改。目录扫描失败不会清空索引。首次升级同步前默认搜索也会过滤旧 handoff 分类。

中文用 FTS5 trigram，建表不可用则切换 unicode61，短词及不足候选用转义 LIKE 兜底。查询中的 SQL/FTS 符号作为文本，不拼接执行。排序综合 FTS、实体命中及最近性，每来源最多一条；候选有上限，适用于本地笔记检索，不承诺语义向量召回。

0.2.1 先按原规则检索，并按过滤后可用的不同来源数判断是否不足，而非把不满足查询的 FTS OR 候选算作已命中。只有带中文疑问特征的问句且结果不足，才补充最多 8 个分词关键词；单字中文也可进入受范围约束的 LIKE，以覆盖“茶”等问句。时间、source、kind、排除类别和当前 core/archive 库对所有查询阶段同时生效，SQL 候选仍最多 100 条。普通空格关键词保持 AND，带引号、LIKE 通配符或代码符号的查询不放宽，entity 模式仍只查实体。

“关键词补充”是有界的部分词 OR 匹配，可能只命中“茶”，不理解同义词、否定、人物指代或时间关系；仅凭它不能判断问句为真，必须核对 path:行号的原文。问句识别和中文分词存在召回边界，仍可改用具体关键词。LIKE 针对原文且带 ESCAPE，不承诺使用 trigram 加速；本轮不增加索引或更换 tokenizer。[SQLite 官方说明](https://www.sqlite.org/fts5.html#the_trigram_tokenizer) 指出 trigram 全文查询不能命中不足三个 Unicode 字符的子串，因此短词兜底继续保留。

源文档切块不重复内容；极长单行拆成多个块时行号可能相同，原文片段不同。Token 数是字符估计。重复审计有全量精确哈希与前 2000 块的标点/空白归一近似；旧日期审计最多检查 10000 块，每类报告最多 50 条。含旧日期不代表内容失效。多进程同时写同一个索引不在本版支持范围内。

每日复习提醒按部署时区持久去重；为确保不重复，发送前记录当日尝试，投递失败当天不重发，可手动 brain_review 查看。同步失败提醒每小时最多一次。此版本不自动生成复习候选，不连接 embedding 服务。

## 资料边界与升级

World 默认关闭，workspaceSubdir 默认留空。启用前明确填写允许读取的资料目录；旧版已显式填写的 workspaceSubdir 继续有效，依赖隐含 workspace 默认值的部署需补填。核心/档案 include 仍可自定义，来源只读，不需要其他记忆扩展。

索引首次在明确目录下打开后记录 source_subdir。之后更换资料目录，需同时更换 dbFile；启用档案时也更换 archive.dbFile。目录不匹配时拒绝打开，不混用旧来源，不删除旧库。旧版未绑定索引首次升级时按操作者提供的目录绑定，请先核对目录确为原库来源。

事件类型 brain.review-due 改为 brain.review_due，brain.sync-failed 改为 brain.sync_failed，不双发。依赖旧事件类型的外部订阅应同步更新。复习条目和 SQLite schema 版本保持不变。

