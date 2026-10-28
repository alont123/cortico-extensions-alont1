<!-- Owner: src/world.ts -->
# 自我运维（cortico-world-selfkit-alont1）

只读地看自己的运行状态，方便出问题时第一时间说出来。

| 工具 | 说明 |
|---|---|
| `self_status()` | 循环/模型/上下文/积压/运行时长 |
| `self_log({count?})` | 最近告警日志 |
| `self_worlds()` | 已挂/未挂世界 + 工具数 |

配置：`worlds.selfkit.{enabled, consolePort, logLines}`，端口默认 7788。

## 控制台面板

控制台显示扩展声明的标量配置；修改后重新挂载扩展生效。面板列出的复杂结构需在 config.json 中编辑。

## 行为边界

控制台未返回对应字段时报告未知；告警列表缺失不推断为一切正常。
