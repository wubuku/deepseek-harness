---
description: "验证旧本地修改、未知提交与新远端版本相遇时的恢复一致性。"
---

# Workspace 恢复一致性验证计划

## 决策问题

正式产品需要证明刷新恢复的是一个可解释的文件版本。仅有 commit CAS 不足以保护模型读取：先下载最新 manifest、再叠加旧 pending，会在提交冲突之前产生混合快照；把 retry 与后续 pending 合并排序，还可能复活已删除文件。DSH-TUI 对 occupied、busy、unavailable 的区分提供另一条原则：未查明的操作结果不能当成未发生。

## 候选与取舍

| 候选 | 产品价值 | 本批选择 |
|---|---|---|
| 跨批次 replay 顺序 | 刷新不复活删除，不逆转 rename | P0，修复与负对照 |
| 旧 baseline 与新 manifest | 模型不能读来源混杂的 Workspace | P0，下载前判定并隔离 |
| unknown operation 对账 | 响应丢失后不重放已提交写入 | P0，查询与请求摘要核对 |
| 冲突与故障可见恢复 | 用户能取回保留的 bytes | P0，复用恢复包导出 |
| Session receipt 恢复 | 已提交操作不变成重复副作用 | P0，保留原 tool 身份与 receipt outbox |
| rename/delete/create 交错 | 文件树与时间层次一致 | P0，单测及真实 Chrome |
| 基于共同祖先的三方合并 | 降低长离线冲突成本 | 暂缓；当前 snapshot 未保存 base manifest，不能安全推断 |
| 多 backend 与全局 GC | 生产高可用与跨进程原子性 | 后续独立存储批次 |
| origin 级资源预算 | 多 Workspace 不耗尽磁盘与句柄 | 后续；不以私有缓存预算冒充 |
| 大 Session 分页与投影 | 控制文件之外的内存成本 | 后续独立批次 |
| Browser/Cloud 执行交接 | 页面关闭后的可续接任务 | 后续；不能迁移活动 Promise |
| 自然 eviction、OS crash | 真实平台失效行为 | 本批只对确定性故障与刷新作结论 |

## 四个交付面

1. **恢复前分类。** 在 hydrate、blob GC 和 snapshot 改写前核对本地 baseline、远端 revision 和 retry 的操作状态。同 baseline 允许恢复；旧 dirty 遇到新远端版本、远端回退或查询不可用均拒绝启动文件执行者，保留原本地数据。不自动 rebase、LWW 或静默丢弃。
2. **操作身份与分层重放。** operation 查询返回服务端既有请求摘要；客户端用原 baseRevision、规范化 changes 的 SHA-256 核对，区分 confirmed absent、committed、unknown。已提交 retry 不再覆盖最新远端文件；有后续 pending 时只允许其直接基线仍然匹配。未提交 retry 先重放，后续 pending 再独立重放，不把两个时间层合并排序。
3. **用户与 Session 恢复。** 冲突或查询失败可通过现有恢复包下载保留数据；提示不声称已同步。恢复已提交操作时保留原 operationId、DSH tool-call 身份及 receipt outbox，待 Session 确认后再删除。最小页面接线如需目录外修改，在 change-ledger 说明原因与重放方式。
4. **真实运行时验收。** 单测覆盖 write→delete、rename/delete、相同 revision、远端领先/回退、查询失败、身份/摘要不匹配、已提交 retry 后又有远端写入。真实 Chrome 完整 Host 验证刷新隔离、导出字节不变、未重复 commit、已提交 receipt 恢复；保留旧行为负对照。最终代码运行同源真实 LLM 文件闭环、记忆、刷新与冷恢复。

## 安全与范围

不改 Agent Loop、Session 格式或 IndexedDB schema。操作请求摘要是 PoC HTTP 查询的附加字段，使用同一 checkout 的 Worker 与 backend；旧响应缺少身份字段时恢复拒绝，不能把无法核对的 receipt 当成功。当前单 backend 的 operation 查询仍是单次观察，不提供跨请求事务；后续 commit 继续受 CAS 保护。没有 base manifest，因此本批优先保留数据并阻止混合读取，不宣称完成自动冲突解决。

先记录本计划和[进度](workspace-recovery-consistency-progress.md)，再编码。全部真实命令与失败留在进度文件；真实模型与 scripted 故障证据分开记录。

## Dev Note

本批重点是可恢复、可解释的文件事实，而非增加工具种类。未知查询失败必须阻止恢复决策；允许网络重试不等于允许在未知 baseline 上启动模型工具。
