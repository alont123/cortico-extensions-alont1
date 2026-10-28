<!-- Owner: src/world.ts -->
# 联网（cortico-world-web-alont1）

网页搜索（Bing HTML，不要 key）+ 读网页正文。

| 工具 | 说明 |
|---|---|
| `web_find({query,count?})` | 返回标题/链接/摘要 |
| `web_read({url,max_chars?})` | 抓网页、剥标签、只留正文 |

配置：`worlds.web.{enabled, maxResults, maxChars, timeoutMs}`。

## 控制台面板

控制台显示扩展声明的标量配置；修改后重新挂载扩展生效。面板列出的复杂结构需在 config.json 中编辑。

## 行为边界

网页响应最多读取 4000000 字节；非文本响应不读取正文。无效 HTML 数字实体原样保留，不导致整个页面解析失败。
