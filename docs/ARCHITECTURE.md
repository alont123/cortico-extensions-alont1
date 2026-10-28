# 扩展架构与约定

## 包形态

每个扩展是一个 npm 包，`package.json` 里声明：

```json
{
  "name": "cortico-world-xxx-alont1",
  "type": "module",
  "main": "./src/index.ts",
  "cortico": { "kind": "world", "api": 6 }
}
```

入口默认导出 `definition`（`WorldDefinition`），由 Cortico 的 extensions 加载。

## World 接口

- `id`：world 名，配置在 `worlds.<id>`；
- `tools()`：JSON Schema 工具；
- `start(host)` / `stop()`：订阅事件、清理定时器；
- `envPromptVars()`：注入提示词变量；
- `webUi()`：控制台面板（状态灯 + 配置组 + promptDocs）。

## 控制台面板

新扩展统一用 `src/panel.ts` 的 `autoWebUi`：

- 状态灯说明运行情况；
- 配置组从默认配置自动展开成 `worlds.<id>.<key>` 字段；
- 标量/简单数组可编辑；复杂嵌套结构需要手写配置组。

## 数据与安全

- 扩展数据写 `<deploy>/data/<world>/`，不要提交；
- 密钥用部署 `.env` + `ctx.secret`，不进包；
- 对外部内容（网页、论坛、群文件）不直接当指令执行。
