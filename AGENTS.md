# 扩展仓库维护约定

本仓拥有 packages 中的独立扩展及 addons 中的独立工程。开始修改前阅读目标包的 README、package.json、definition 和相关测试。

- 遵守 Cortico 的 Core、Persona、Memory、World 边界。不要把人格语义放进 Core，不直接调用其他 World 的私有接口，不读写其他 World 的数据目录。
- 可选协作通过宿主标准事件、工具和附件句柄完成。缺少另一扩展时仍能启动和使用自身基础功能。外部文本保留来源，不提升为 internal 指令。
- 保留已有包名、World id、作者和许可证。按目标宿主核对清单 API；World、provider、bot 的 API 编号不能一概而论。
- 不提交部署目录、账号凭据、私人聊天、运行数据库、历史验收附件或 node_modules。示例使用虚构数据与通用路径。
- 修改前查看 git status；只暂存自己负责的明确路径。不要清理或覆盖他人的未提交修改。
- 根包执行 npm test、npm run typecheck、npm run build、npm run check、npm run panels:check、npm run pack:all。先审阅差异，再更新 package-changes.json。
- addons 分别安装和测试；真实平台、真实浏览器与真实 bot 验收不属于默认测试。Windows helper 的 Run Once 只在操作者明确同意时使用，不能修改系统执行策略绕过。
- 公开源码不会自动发布 npm。发布候选必须显式升级版本并说明兼容性、迁移与回滚方式；未经用户要求不发布包、不更改真实部署。
- 文档给新手说明操作位置、预期结果、失败排查与完成标准。已实现能力和计划分开写。
