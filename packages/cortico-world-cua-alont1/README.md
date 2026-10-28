<!-- Owner: src/world.ts -->
# cortico-world-cua-alont1

一个 World：让 bot 看见并操作这台电脑的主屏幕——截图、鼠标、键盘、窗口列表。十个工具。

## 它怎么保证不出大事

1. **原生调用隔离在引擎子进程**：由 PowerShell/.NET 调用 Win32，引擎退出后由主进程重启。
2. **与使用者共用电脑**：每次输入前问系统「使用者闲了多久」；没闲够就不动手。打字途中使用者一动，打字停在已打出的地方。
3. **权限只有一道硬门**：`worlds.cua.allowInput`。关着（默认）只有只读能力——截图、列窗口、等待。要让它动手，主人在控制台打开这一项。
4. **不可逆的事先问**：登录/密码/验证码/支付/双重验证停手交给人；发消息/删文件/提交表单/购买先问——这一层写在 ENV_PROMPT 里，是语义约束，不是网关。

## 配置

| 键 | 默认 | 什么 |
|---|---|---|
| `worlds.cua.enabled` | false | 挂不挂这个 World |
| `worlds.cua.shot` | 1280 | 截图最长边（像素）；工具坐标按这张图 |
| `worlds.cua.quality` | 70 | JPEG 质量 |
| `worlds.cua.idleMs` | 1200 | 使用者静止多久才动手 |
| `worlds.cua.allowInput` | **false** | 是否允许点击/打字/按键 |

## 平台与实现

- 只在 **Windows** 上实现（Win32：GDI BitBlt 截图、SendInput 输入、GetLastInputInfo 感知用户、GetTopWindow 枚举窗口）。
- 进程启动时先声明 per-monitor DPI 感知 v2——不做这件事，坐标会全部按缩放后的逻辑像素算（150% 缩放下 2560×1600 会被报成 1707×1067）。
- 运行时依赖 `jpeg-js`；系统后端使用 Windows PowerShell/.NET，无需安装原生编译工具。

## 行为边界

停止 World 时清除未完成动作许可与自由时段；重新挂载后不会执行旧审批。自由时间提醒仅说明计时条件，不断言 Persona 当前没有任务。
