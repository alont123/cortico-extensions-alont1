<!-- Owner: packaged source and lifecycle contract -->
# 更新记录

## 0.3.1 - 2026-10-26

- 详情配置不再包含宿主启用总开关，避免过期表单保存其他设置时意外关闭扩展。
- 启用/停用统一使用宿主卡片；真实业务子开关仍可配置，中文教程明确保存与重新挂载的区别。

迁移：升级后重载宿主并刷新控制台页面；如果旧版已把总开关保存为 false，请在宿主卡片重新激活一次。若旧实例仍显示在线，可先停用再激活。修复不会猜测或覆盖用户已有停用选择。

<!-- Owner: package.json and packaged source -->
# 更新记录

## 0.3.0 - 2026-10-25

- 默认关闭且 workspaceSubdir 为空；明确配置后只读索引资料来源，不探测 Persona Memory。
- 核心/档案索引及复习数据仍仅写在宿主 dataDir/brain 下，数据库绑定来源相对目录，换源拒绝混用。
- 事件 brain.review-due 改为 brain.review_due，brain.sync-failed 改为 brain.sync_failed，不双发；复习标题与来源显式 external、固定故障通知 internal；失败回执明确标记 failed:true，零命中仍是成功结果。
- 面板保留快速交替启停的最终停止，显示执行中调用与耗时，按 failed:true 统计失败；面板代码随包内置。
- 按 Cortico 0.2.7 的 World API 6 / Bot API 7 检查适用契约；单包产物不引入其他扩展。

迁移：新默认 enabled=false、workspaceSubdir 为空；保留已有显式启用值，补齐相对宿主 botDir 的资料目录（不接受绝对路径或越界路径）并重新挂载。原索引仍在宿主 dataDir/brain 下；来源未变时沿用原 dbFile 和 archive.dbFile，无需搬动原文或重建索引。无来源标识的旧库首次绑定当前配置，升级前务必核实原来源；切换来源必须选新 dbFile，启用档案时也选新 archive.dbFile，旧库保留。将 brain.review-due / brain.sync-failed 订阅分别改为 brain.review_due / brain.sync_failed。

