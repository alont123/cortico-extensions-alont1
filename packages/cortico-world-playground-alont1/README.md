<!-- Owner: src/world.ts, src/definition.ts -->
# 玩具世界（cortico-world-playground）

在自己的 `本扩展 dataDir/playground/play/` 里写并跑一小段 JS，用来给自己玩。**不联网、不碰外面文件、超时就停**。没有提醒。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `worlds.playground.enabled` | `false` | 开关 |
| `worlds.playground.timeoutSec` | `5` | 单次运行上限（秒，1-30） |

## 工具

- `play_run({code, name?})`：存到 `play/<name>` 并执行，返回 console 输出与返回值。
- `play_list()`：列出 `play/` 里的 .js。

## 注意

沙箱只有基本对象和 console；没有 `require`、没有网络、没有文件系统。写玩具够用，别指望跑 npm 包。

## 控制台面板

控制台显示扩展声明的标量配置；修改后重新挂载扩展生效。面板列出的复杂结构需在 config.json 中编辑。

执行在独立 Node 子进程中进行，采用空环境、受限文件读取、禁用动态代码生成与执行超时。vm 用于运行本地 bot 生成的玩具代码，不提供面向恶意代码的完整系统隔离。

## 独立数据目录

生成产物改存于本扩展 dataDir/playground/play/，不会探测或写入 Persona Memory，也无需安装其他扩展。旧 workspace 中的产物保持原样；需要保留在新版列表或作品页中时，停用扩展后手动复制到新数据目录对应位置，再重新挂载。跨工具引用文件时使用回执给出的实际路径。
