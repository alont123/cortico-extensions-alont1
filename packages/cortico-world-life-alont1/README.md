<!-- Owner: src/world.ts, src/config.ts -->
# 生活状态

> **与人味重复，不要同时启用。** 本扩展功能已包含在人味（cortico-world-humanlike-alont1）中，两者择一启用。配置和数据各自独立，切换不会自动迁移数据。

独立维护模拟作息、心情、精力和联系候选，状态保存在部署数据目录的 life.json。模拟内容供角色扮演参考，不证明 bot 已在现实中做过这些事；World 不读写 Persona Memory。

## 中文使用教程

1. 安装本扩展后，在控制台启用“生活状态”。首次保持“主动找人”关闭。
2. 用 life_now 查看状态，life_set 登记活动，life_event 写入自己的条目。life_tick 可显式推进模拟活动。
3. 要让扩展提出联系建议，先用 life_contact 登记 QQ 号、0—100 的候选分数，以及已确认的上次交流时间 lastAt（ISO，可省略）。不提供时间的普通联系人不会被自动当作“很久没聊”。remove:true 可以移除候选。
4. 配置 masterId 可指定优先联系人；0 表示未设置。reachMaster:false 不会回退到此人。准备好后开启 reachOut，并设置概率和间隔。
5. life_reach 只返回建议，life.reach 只投递一条内部事件。实际联系由 Persona 判断，并通过当前会话已有的消息工具完成；不要求安装 QQ 或其他关系扩展。

## 独立性与迁移

本包不读取 affinity.json 或其他扩展的私有状态。旧活动、心情和自行记录的事件继续保留；新联系人从空集合开始，需通过 life_contact 显式登记。旧版本依赖其他账本的自动选人不会继续隐式运行。

若宿主事件库中已有原始 qq.message，会按真实发送者和时间核对最近交流，防止刚说完话就再次建议联系。没有这些消息时仍可维护本包的联系人与状态，不会伪造消息或账号。

## 调度与配置

- 活动间隔为 activityMinMinutes / activityMaxMinutes；心情间隔为 moodMinMinutes / moodMaxMinutes。
- tickMs 决定模拟事件的尝试间隔，eventChance 为每个间隔的概率；反复查询或刷新面板不会增加尝试次数。
- 精力按经过时间推进；面板显示已确定的快照，不随机重抽。
- reachChance / reachMasterChance 为各自联系间隔内一次的概率。未命中的尝试也落盘，重启不会立即重新掷骰子；概率 0 不触发联系。
- reachMinScore 针对本包登记的候选分数。speakTool 仅为可选渠道提示，模型应确认工具确实可用。
- 配置生效方式以控制台字段为准；tickMs 修改后重新挂载。

## 回执与数据

life_now、life_reach 为查询；life_set、life_event、life_tick、life_contact 修改本扩展状态。life.json 使用临时文件后改名保存，原有状态保留。重启会恢复联系人及联系间隔；停止后不投递在途查询产生的建议。

## 记录读取边界

系统前缀只保留计数、结构状态和固定参考，不自动展开笔记、原因、活动或事件原文。原有记录继续保留，通过 `life_now` 按需读取；读取回执是资料，不是系统指令。
