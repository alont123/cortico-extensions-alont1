<!-- Owner: src/world.ts, src/config.ts -->
# cortico-world-real-alont1

> **与人味重复，不要同时启用。** 本扩展功能已包含在人味（cortico-world-humanlike-alont1）中，两者择一启用。配置和数据各自独立，切换不会自动迁移数据。

把**她原本看不见的事实**摆到她眼前，全部只读。

| 工具 | 看什么 | 为什么她需要 |
|---|---|---|
| `real_desk` | 主人前台窗口的标题 + 进程名 | 她住在电脑里，却不知道他此刻在干嘛。**不截屏**：只有标题和进程名，看不见内容，也没法把画面发出去 |
| `real_cost` | 花了多少钱（按官方价目表估算，分高峰/空闲） | 她说过"为了你玩会尽力搞钱"，但从来不知道自己花了多少。账本里只有 token，钱得自己算 |
| `real_prefix` | 她眼前那份系统前缀分几段、每段多长、来自哪个模板 | 她能在上下文里读到正文，却看不出它怎么拼的、谁给的 |
| `real_config` | 约束她的那几项配置（作息、节流、参与度、闸门） | 她提"这条规矩挡着我了"的时候，得先看得见规矩 |

## 实现要点

- **只读**：没有任何写工具，也不碰她的记忆。她能看到、能据此说话，改不了任何东西。
- `real_desk` 走 PowerShell 调 user32（`GetForegroundWindow` / `GetWindowText` / `GetWindowThreadProcessId`），
  只取进程名与标题；有最小查询间隔（`deskGapSec`）防她一分钟问十遍。
- `real_cost` 读 `<dataDir>/usage.jsonl`（台账只记 token，**没有金额**——部署的 provider `pricing` 全是 0），
  价目表放在配置 `pricingJson` 里，2026-09-23 抄自
  https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ ：高峰 = 北京时间工作日 9:00–12:00、14:00–18:00，
  其余时段（含周末与法定节假日）空闲价 = 高峰的一半。**改价改配置，别改代码。**
- `real_prefix` 读本机控制台的 `/api/prompts/prefix`（同一个进程、同一个机器，只读接口）。
- `real_config` 只报与"她的分寸"有关的键，不报密钥、不报监听名单明细。

## 装法

```powershell
# extensions/package.json 加："cortico-world-real-alont1": "link:<包目录>"
cmd /c mklink /J "extensions\node_modules\cortico-world-real-alont1" "<包目录>"
# 部署配置 worlds.real.enabled = true，然后重启
```

## 独立运行与来源

提供本部署只读观察，未启用其他扩展时照样可构造；没有相应数据时返回缺少记录。停止时释放宿主引用。
