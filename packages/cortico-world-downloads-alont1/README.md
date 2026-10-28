<!-- Owner: src/world.ts -->
# 下载管家（cortico-world-downloads）

看下载夹最近的文件、数量与大小；新文件落地时冒一句。**只读，不移动、不删除文件。**

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `worlds.downloads.enabled` | `false` | 开关 |
| `worlds.downloads.dir` | `''` | 下载目录；空表示系统默认（home/Downloads） |
| `worlds.downloads.scanSec` | `60` | 扫描间隔（秒，最少 15） |

## 工具

- `downloads_recent({limit})`：最近文件（名字/大小/时间）。
- `downloads_stats()`：文件数与总大小。

## 事件

`downloads.new`：新文件出现（meta.files 带前 20 个）。

## 控制台面板

控制台显示扩展声明的标量配置；修改后重新挂载扩展生效。面板列出的复杂结构需在 config.json 中编辑。

## 行为边界

监听窗口只保留最新500个文件，避免大目录的旧文件反复被误报为新下载。目录不可读会报告失败；后台错误写日志，停止后不再扫描。
