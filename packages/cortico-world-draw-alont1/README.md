<!-- Owner: src/world.ts, src/definition.ts -->
# 画图（cortico-world-draw-alont1）

本地生图：调 ComfyUI 上的 MOSS-Image（int8 DiT + 4bit 文本编码器 + Flux2 VAE），默认二次元日漫风格。

| 工具 | 说明 |
|---|---|
| `draw_image({prompt, style?, width?, height?, steps?, seed?})` | 生成一张，存 本扩展 dataDir/draw/，图以 blob 返回 |
| `draw_status()` | ComfyUI 是否在线、显存、队列 |

配置：`worlds.draw.{enabled, httpUrl, modelUnet, modelClip, modelVae, style, width, height, steps, cfg, shift, textDevice, timeoutSec}`。

风格：anime（默认）/ chibi / real / watercolor / ink。

## 控制台面板

控制台显示扩展声明的标量配置；修改后重新挂载扩展生效。面板列出的复杂结构需在 config.json 中编辑。

## 独立数据目录

生成产物改存于本扩展 dataDir/draw/，不会探测或写入 Persona Memory，也无需安装其他扩展。旧 workspace 中的产物保持原样；需要保留在新版列表或作品页中时，停用扩展后手动复制到新数据目录对应位置，再重新挂载。跨工具引用文件时使用回执给出的实际路径。
