<!-- Owner: src/world.ts, src/definition.ts -->
# 手机（cortico-world-phone-alont1）

把 MuMu 模拟器当她自己的手机：MuMuManager 负责开机/关机/查询，adb 负责截图和输入。

| 工具 | 说明 |
|---|---|
| `phone_status` | 开关机、adb、屏幕、电量 |
| `phone_launch` | 开机（没开就开，等待就绪） |
| `phone_screenshot` | 截屏（blob + 存 本扩展 dataDir/phone/screenshots/） |
| `phone_tap` / `phone_swipe` / `phone_key` | 点、滑、按键 |
| `phone_text` | 输入 ASCII（中文有限制） |
| `phone_apps` / `phone_open` | 应用列表 / 打开 |
| `phone_sh` | 任意 adb shell |
| `phone_close` | 关机 |

配置：`worlds.phone.{enabled, mumuDir, vmIndex, bootTimeoutSec}`。`mumuDir` 必填，指向 MuMu 安装目录（含 MuMuManager.exe、adb.exe）；`vmIndex` 是实例序号（默认 0）。

## 控制台面板

控制台显示扩展声明的标量配置；修改后重新挂载扩展生效。面板列出的复杂结构需在 config.json 中编辑。

## 独立数据目录

生成产物改存于本扩展 dataDir/phone/screenshots/，不会探测或写入 Persona Memory，也无需安装其他扩展。旧 workspace 中的产物保持原样；需要保留在新版列表或作品页中时，停用扩展后手动复制到新数据目录对应位置，再重新挂载。跨工具引用文件时使用回执给出的实际路径。
