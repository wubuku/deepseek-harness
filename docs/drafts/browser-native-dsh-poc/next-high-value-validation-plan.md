---
description: "规划 Browser-Native DSH 下一批 P0 PoC，验证本地 durable store 崩溃恢复、真实 Agent Loop receipt 和 Worker 生命周期恢复。"
---

# Browser-Native DSH 下一批 P0 验证计划

## Summary

本批次不扩展 SaaS 或聊天 UI，目标是证明 Browser-Native DSH 在浏览器本地存储、Dedicated Worker 和 Agent Loop 同时发生失败或重建时，仍能保持可恢复、可解释且不重复副作用的执行语义。

当前 PoC 已证明 Workspace 上传失败、commit 结果未知、writer lease/fencing 和基本 VFS 能力，但 Session/Workspace receipt 仍是协议级实验，本地 durable store 还没有覆盖崩溃一致性故障矩阵，Worker 重建也没有与真实 Agent turn 完整关联。

## 验证面

### P0-1：本地 durable store 崩溃一致性

- 在 VFS mutation、OPFS blob 写入、IndexedDB snapshot 更新和恢复读取之间注入故障。
- 在真实 Chrome Worker 的 IndexedDB read-write transaction 中先 `put` 再 `abort()`，验证失败响应、pending retry 和云端 manifest 状态。
- 覆盖 IndexedDB transaction abort、snapshot 损坏、OPFS blob 缺失、blob hash 不匹配和本地记录与 blob 不一致。
- 验证启动结果只能是可恢复 pending、明确 local-corrupt/error 或从远端重建，不能静默显示 cloud committed。
- 明确 VFS post-commit 到本地 snapshot commit 之间仍存在的窗口，不把故障注入接缝写成生产事务日志。

### P0-2：真实 DSH Agent Loop receipt 闭环

- 由真实 Browser-Native Worker Host 中的 DSH 文件工具产生写入、重命名或删除。
- 验证 `VFS mutation → local snapshot → Workspace commit → receipt → Session event` 的关联字段和去重语义。
- Session receipt 使用 PoC 专属、`ignorable: true` 的只读事件，不修改正式 Session 格式或模型可见消息；Worker provider 仅在发往持久化端时添加兼容标记。
- Workspace receipt 先进入本地 durable outbox，再写入 Session；刷新后按 `operationId` 去重，避免 Session append 重试造成重复记录。
- Session 写入失败不回滚 Workspace commit；恢复时以 Workspace operation 查询为准，pending/unknown 不得显示为已完成。
- 故障注入应暂停 receipt append，在确认 Workspace 已提交且本地 outbox 已持久化后终止 Worker；刷新并重开同一 Session，验证只补写一条 receipt，且不重放文件工具或 Workspace commit。
- 使用 scripted LLM 先证明确定性闭环；若真实 provider 可用，再追加真实 Chrome/LLM 证据，但不以 provider 稳定性替代协议验证。
- 同一 `operationId`、Session event seq 和 tool call id 必须能在刷新后重建，不能重复业务副作用。

### P0-3：Worker/页面生命周期恢复

- 在 Agent turn 等待 LLM、文件上传、commit 请求、Session append 和 receipt append 前后终止 Worker 或刷新页面。
- 验证新的 Worker 从同一 Session 和 Workspace durable state 恢复，旧 writer lease 不会继续写入，未确定结果保持 unknown/pending。
- 明确页面关闭后不提供后台 Agent 语义；只验证已落盘状态、可重试操作和用户可见状态。

## 证据等级

1. 浏览器无关单测：验证状态机、snapshot 校验、receipt 映射和故障分类。
2. 真实 Chrome Worker E2E：验证 OPFS、IndexedDB、同源 backend、Worker 重建和页面生命周期。
3. scripted Agent Loop E2E：验证 DSH Host、Session、文件工具和 Workspace 的真实接线。
4. 真实 LLM E2E：只作为模型可用性和多轮上下文补充，不替代前三类证据。

## 退出条件

- 每类本地损坏和事务失败都有明确恢复或失败状态；没有把 pending/unknown 写成已保存。
- 至少一个真实 DSH 文件工具 turn 产生可追踪 Workspace receipt，并写入同一 Session 的 durable event；刷新后读取到相同 receipt，且不重复 commit 或重复写入 Session event。
- Worker 重建后能恢复已落盘的 Session/Workspace 状态；同一 operation 不重复提交。
- README、进度、change-ledger 和测试记录包含实际命令、证据等级、限制和未完成项。

## 非目标

- 不实现生产级 OPFS-backed Node 文件系统、chunk-level delta、CRDT 或后台 Agent。
- 不把 PoC JSON backend 当成生产云存储、跨进程锁或跨服务事务协调器。
- 不把一次真实 LLM 成功扩大解释为浏览器故障恢复、性能或灾备证明。
