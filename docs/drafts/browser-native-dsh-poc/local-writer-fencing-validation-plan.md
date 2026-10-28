---
description: "验证多 Worker 的本地 Workspace 写权、snapshot 代际、旧数据升级和完整 Host 接管。"
---

# Workspace 本地写权与代际验证计划

## 决策问题

DSH-TUI 强调单写者、多观察者和显式执行权交接。浏览器中，backend lease、页面恢复凭据锁、每次存储操作的 Web Lock 分别保护不同资源，不能相互替代。上一批的 record 比较拒绝普通旧 snapshot，但相同内容经过修改后恢复原样时可能产生 ABA；远端失效也不自动阻止旧 Worker 排队中的本地持久化。本批验证这些组合，保留 Session 唯一事实来源和 Workspace 非原子事务语义。

## 候选范围与选择

| 候选 | 产品前需要回答的问题 | 本批选择 |
|---|---|---|
| 本地 snapshot 代际 | 内容相同是否仍能识别 intervening write、clear/recreate？ | P0 |
| 本地 writer fencing | 旧 Worker 能否在远端失去写权后写入或清理共享 OPFS/IDB？ | P0 |
| 完整 Host 双标签组合 | observer 是否不碰 dirty 状态，接管是否保留原 operation 身份？ | P0 |
| 本地数据升级 | 旧 snapshot、pending、retry、receipt、下载意图是否可保留升级？ | P0 |
| 大文件 observer 的内存 | observer 当前 resident 下载能否满足低内存设备预算？ | 后续，记录限制 |
| 长时间离线编辑 | 跨设备 rename/delete、冲突副本和用户决策如何结合？ | 后续 |
| 多实例 backend | metadata、GC、块引用和 lease 如何跨进程互斥？ | 后续 |
| 生产对象存储 | IAM、版本控制、条件写入和失败账单如何验证？ | 后续 |
| 本地空间压力 | quota、eviction、用户清站点数据后如何解释恢复能力？ | 保持现有故障覆盖，不外推自然 eviction |
| 长 Session 与工具大结果 | 分页、内存、模型上下文和回放能否共同有界？ | 后续 |
| 浏览器升级和旧页面共存 | 不同代码版本同时写入时是否明确拒绝？ | 纳入本地升级验收 |
| Browser/Cloud 执行交接 | 未完成工具与副作用 unknown 如何转交？ | 后续独立批次 |
| capability 与插件兼容 | 何时拒绝 Node、Shell、WASI 或外部进程依赖？ | 维持现有分层 |
| 本地敏感数据治理 | 清除、保留周期和多身份隔离能否审计？ | 后续 |

## 四个交付面

1. **Snapshot 代际。** 保存具有独立于文件内容和远端 revision 的本地代际；load/save 只更新已成功观察的代际，失败事务不消耗已提交代际。相同内容回写和 clear/recreate 也不得使旧实例重新获得修改资格。
2. **本地写权。** Writer 在启动恢复前显式获得本地身份；每次变更在 Workspace 操作锁内检查身份。新的合法接管使旧身份失效；旧 Worker 的 load 不得隐式重新授权。backend lease 保持远端权威，无 lease 模式也必须有本地保护。release、失效和失败不得删除新 owner 的待提交内容。
3. **升级与保留。** 若需要调整 IndexedDB schema，保留旧 Workspace snapshot 及 OPFS 文件，显式处理升级被旧连接阻挡、未知版本和事务 abort；不清共享缓存，不修改 Session 格式。恢复必须区分 metadata 损坏、写权失效和普通 snapshot 冲突。
4. **完整运行时验收。** 在真实 Chrome Dedicated Worker、OPFS 和 IndexedDB 中验证两个完整 DSH Host 的 observer、接管和迟到持久化；使用显式 barrier 确认竞争，不能以重复运行或固定 sleep 代证。保留直接存储反例与旧行为负对照，另跑同源代理真实 LLM 文件闭环和刷新恢复。

## 验收矩阵

| 场景 | 验收要求 |
|---|---|
| 相同内容两次保存后旧 save | 拒绝；不得仅比较 JSON 内容 |
| clear/recreate 后旧实例 | 拒绝；不得把不存在或相同内容当作未发生变化 |
| 新 owner 已启动，旧 Worker load/save/cache/GC | load 不重新授权，变更拒绝，保留新 pending/retry/receipt |
| 旧 owner release 晚到 | 不撤销新 owner，不删除数据 |
| 本地事务 abort | 旧 durable 数据与代际一致，失败不能宣称 durable |
| 旧数据首次升级 | pending、retry、receipt 与 bytes 保留，hash 一致 |
| 未知或损坏控制数据 | fail closed，不自动清除或猜测 writer |
| 完整 Host observer | 能读已提交版本，不修改 shared dirty 状态，不重复 prompt 或副作用 |
| 持锁 Worker 强杀 | 浏览器释放锁；后继完成恢复，无遗留等待者 |
| 完整 Host 正常刷新与接管 | Session 和 Workspace 身份连续，原 operation 只结算一次 |
| 真实 LLM | 后端独占凭据，真实 read/write/read、刷新和记忆通过，无额外模型循环 |

本批不验证恶意同源脚本、OS crash、电源中断、自然 eviction、跨浏览器锁或生产 HA。本地 fencing 不替代服务器认证或远端 lease；Worker 仍受页面生命周期约束。设计选择、执行命令、失败和结果记录在[进度](local-writer-fencing-validation-progress.md)。

## Dev Note

本计划先于编码。先建立可重复的旧行为反例，再以真实存储事务和完整 Host 证明修复；如果新旧版本共存不能安全写入，应明确拒绝，不静默降级。
