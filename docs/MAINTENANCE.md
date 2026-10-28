# 源码维护

本页对应根 package.json、scripts/baseline.mjs 和 scripts/check-packages.mjs。

packages 包含35个既有包的维护源码。基线清单保存 npm 来源版本与文件摘要；package-changes.json 记录经过审阅的差异。先检查 diff，再记录差异，然后运行 test、typecheck、build、check、pack:all。

addons 是独立工程，各自使用自己的锁文件、构建和测试。公开源码不等于 npm 已发布；正式发行另行升级版本和验收。不要将本机数据、历史验收附件、账号或密钥放入仓库。
