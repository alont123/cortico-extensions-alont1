<!-- Owner: src/world.ts and src/config.ts -->
# 记忆检索

在操作者指定的资料目录中进行本地词面检索，返回文件、行号和上下文。可独立安装，不读取其他扩展的数据，不假定 Persona 使用文件式 Memory。

在面板填写 `worlds.memsearch.sourceDir`，相对路径以部署目录为基准，也可用绝对路径。默认留空，留空时工具报告待配置，不自动扫描 workspace。更改后重新挂载。

先调用 `mem_stats` 刷新覆盖，再用 `mem_search({query:"关键词",count:6})` 查找。中文支持双字片段和单字，英文按词；这是词面检索，不能当作语义理解。

配置 `maxResults`、`maxFiles` 和 `maxFileMB` 控制结果数、文件数和单文件大小。仅扫描普通文本文件，跳过链接、隐藏目录、node_modules、blobs；递归深度最多 24。搜索缓存最多保留两分钟，`mem_stats` 立即重扫并移除已删除文件，停止后清空缓存。

升级前依赖自动扫描 workspace 的部署，需明确填写 `sourceDir:"workspace"` 并核对需要公开给此 World 的资料范围。来源是只读材料，不会被写入 Persona Memory。
