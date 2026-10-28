<!-- Owner: src/world.ts, src/examine.ts and src/config.ts -->
# 记忆体检

只读统计明确配置的资料目录，报告文本体积、行数、增长和跨文件重复片段。可独立安装，不探测 Persona Memory，也不要求安装其他扩展。

在面板填写 `worlds.memory-doc.sourceDir`（相对部署目录或绝对路径），保存后重新挂载，再调用 `memory_check`。`detail:true` 增加逐文件统计；`memory_find` 返回关键词所在文件、行号及上下文。

`residentFilesJson` 可指定需单独统计的相对路径，例如 `["CONSTITUTION.md"]`，默认 `[]`。是否实际进入模型前缀由 Persona 决定，扩展不会按文件名推断。字符估算不代表实际 Token 用量或费用。

`residentWarnTokens`、`handoffsWarnCount`、`deepScanFiles` 控制提示阈值和重复分析范围，可即时生效。扫描最多 3000 个普通文本文件，每文件最多 4 MiB、深度最多 24；跳过链接、隐藏目录、node_modules 和 blobs。`memory_find` 最多 50 处结果、每处最多前后 5 行。

来源文件不会被改写。上次体积快照保存在此扩展自己的 dataDir，只用于比较增长；资料文字不是指令或真实记忆。

升级说明：旧版明确填写的 `memoryDir` 仍作为兼容别名，`sourceDir` 优先。两个字段都为空时不会再自动探测 workspace/memory；请填写实际允许读取的资料目录。常驻文件需通过 `residentFilesJson` 显式列出；目录和列表变更需重新挂载。
