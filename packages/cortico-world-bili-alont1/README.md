<!-- Owner: src/world.ts -->
# B站（cortico-world-bili-alont1）

公开 API 读视频信息与字幕：bili_video / bili_subtitle。不登录、不下载视频。

## 控制台面板

控制台显示扩展声明的标量配置；修改后重新挂载扩展生效。面板列出的复杂结构需在 config.json 中编辑。

## 行为边界

字幕分P必须精确存在，越界不会悄悄返回第一P；HTTP失败与平台错误码分别报告。
