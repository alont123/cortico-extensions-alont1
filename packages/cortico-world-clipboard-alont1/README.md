# 剪贴板（cortico-world-clipboard）

读当前剪贴板里的文字。**Windows 专用**，默认关闭（隐私开关）。

## 装

```bash
cd <部署目录>/extensions && pnpm add cortico-world-clipboard-alont1
```

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `worlds.clipboard.enabled` | `false` | 开关；关着时不注册工具 |
| `worlds.clipboard.maxChars` | `2000` | 返回的最大字数，超出截断 |

## 工具

- `clipboard_read()`：返回当前剪贴板文本；空/图片/文件时返回说明。

## 注意

只读，不写剪贴板；不含历史记录（只看当前）。开之前想清楚：剪贴板里可能有密码和私人内容。

## 控制台面板

控制台显示扩展声明的标量配置；修改后重新挂载扩展生效。面板列出的复杂结构需在 config.json 中编辑。
