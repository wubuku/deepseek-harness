---
description: "规划 Browser-Native DSH 中 Session、Workspace 与工具副作用之间的跨存储 checkpoint 和 receipt 对账验证。"
---

# 跨存储 checkpoint 与 receipt 对账验证计划

## 决策问题

Browser-Native DSH 的 Session event log、Workspace manifest/outbox 和业务工具副作用不共享事务。真实产品不能把某一次 `flush()` 返回、某个页面状态或某个 Workspace revision 当作三者已经一致的证明。本批验证一套保守的 checkpoint/receipt 协议：每个工具副作用都有稳定 operation identity；Session 只记录已观察到的状态；恢复时通过后端查询将 `committed`、`pending`、`unknown`、`conflict` 和 `failed` 分开，不重复执行未知副作用，也不把本地 pending 伪装成已保存。

## 候选范围与取舍

| 候选验证点 | 产品价值 | 本批决定 | 取舍依据 |
| --- | --- | --- | --- |
| Workspace commit 与 Session receipt 的四种交错结果 | P0 | 纳入 | 直接决定刷新后是否重复工具副作用或错误显示成功。 |
| checkpoint 中的 Session seq、Workspace revision、receipt outbox | P0 | 纳入 | 需要明确恢复所依据的观察点，不接受单字段“已同步”。 |
| operation receipt 查询和幂等重放 | P0 | 纳入 | 响应丢失时必须查询原 operation，而不是再次执行模型工具。 |
| 同一工具调用的 duplicate receipt | P0 | 纳入 | 同一 `(session, turn, step, callId, toolCallSeq)` 只能结算一次。 |
| receipt 与 DSH tool/result 事件配对 | P0 | 纳入 | 模型可见的成功必须可从 Session 重建。 |
| Session flush 失败、Workspace commit 成功 | P0 | 纳入 | 典型跨存储 partial success，需可恢复但不重复 Workspace 写入。 |
| Session flush 成功、Workspace commit pending/unknown | P0 | 纳入 | 工具结果不能被写成 completed；恢复需要继续查询原 operation。 |
| 两边都 unknown 与页面刷新 | P0 | 纳入 | 必须停止自动副作用重放，保留人工/查询恢复路径。 |
| Session owner handoff 与 checkpoint cursor | P1 | 纳入回归 | 已有安全点 handoff，需证明新 owner 接管不会重复 receipt。 |
| Workspace writer lease 与 Session owner 双 lease | P0 | 仅验证拒绝边界 | 不声称原子转移；无法证明时必须返回可操作的 partial/unknown。 |
| checkpoint 过期、跨 Session/Workspace 身份错配 | P0 | 纳入 | 防止旧页面或错误租户提交 receipt。 |
| 多 backend 共享 Session/Workspace 事务 | P0 | 设计/模拟边界 | 当前 PoC 单进程 dataDir，不能用 mock 宣称生产 HA。 |
| 大工具结果、附件和 blob 引用 | P1 | 纳入 bounded receipt | receipt 只保存引用和摘要，不把文件 bytes 塞入 Session。 |
| outbox compaction、GC 与 receipt 保留 | P1 | 纳入生命周期单测 | 未确认 receipt 不能被 GC；已确认 receipt 才可清理。 |
| 真实业务 API 幂等键 | P0 | 纳入 mock 业务端点 | 证明 DSH operationId 必须传到业务副作用，而不是只保护 Workspace。 |
| 自然 eviction、OS crash、生产对象存储 | P1 | 保留限制 | 继续使用确定性故障注入，不把注入结果外推为自然故障。 |
| Browser-to-Cloud execution handoff | P0 | 保留边界 | 本批只交接已持久化 checkpoint，不迁移 Worker Promise、模型流或 HITL 等待。 |

## 设计原则

1. **事实分层。** Session event log 是模型可见事实；Workspace receipt 是文件提交事实；业务 receipt 是外部副作用事实；checkpoint 只引用三者已观察的 seq、revision 和 operation status，不替代任何事实源。
2. **状态保守。** `committed` 才能结算成功，`pending` 只能表示仍需查询，`unknown` 禁止自动重放，`conflict` 需要用户/业务解决，`failed` 才能在明确没有副作用的前提下重试。任何缺字段、身份错配或过期 cursor 都 fail closed。
3. **稳定身份。** `operationId` 在所有重试、Session receipt、Workspace commit 和业务 API 幂等键中保持不变；每次 HTTP 请求可以有新的 `requestId`。工具调用身份使用 `(sessionId, turn, step, callId, toolCallSeq)`，不能只依赖 callId。
4. **可恢复而非原子幻觉。** 采用可查询 saga：先持久化 intent/checkpoint，再执行副作用，最后追加 receipt；每个阶段可重启、可查询、可对账。若阶段顺序无法证明，显示 partial/unknown，不发出新的模型成功结果。
5. **有界载荷。** receipt 只保存 hash、bytes、paths、status、provider 和业务 response digest；大结果使用已授权 blob 引用。Session 中的 receipt 仍须满足 Model-visible ⟺ logged。

## 本批交付面

### M0：事实与协议定义

核对当前 DSH Session event、Workspace receipt、handoff checkpoint 和业务工具调用字段；建立严格的 `CrossStoreOperation`、`Checkpoint`、`ReceiptStatus` 和 `ReconciliationDecision` 纯函数，不扩大正式 Session format。明确可观察状态与推断状态的证据等级。

### M1：同源 backend 对账端点

在 PoC backend 增加受 principal 和 Session owner 保护的 operation ledger 查询/写入。ledger 保存 operation identity、intent、Workspace receipt 摘要、Session receipt seq、业务副作用 receipt 和状态代际；相同 operation 重试返回同一记录，冲突摘要返回结构化错误。服务端队列保证同一 operation 串行，但文档明确这不是多实例数据库事务。

### M2：Worker/Session 适配与故障注入

让一个已有 DSH 文件工具流程使用稳定 operationId 写入 Workspace 和 receipt outbox；在 Session append、Workspace commit、业务 mock API 的响应前后注入失败。恢复只查询原 operation，禁止再次发模型 prompt、禁止重复业务副作用；Session/Workspace receipt 通过已有 Session event 投影可重建。

### M3：Chrome 与真实模型

真实 Chrome Dedicated Worker/OPFS/IndexedDB 验证四种 partial success、刷新、owner handoff、过期 checkpoint、双标签竞争和大 receipt 摘要。脚本 LLM 只用于确定性故障；真实 LLM 至少完成一个普通文件工具 smoke，统计模型请求、业务请求、Workspace commit、Session receipt 和 operation ledger 数量。

### M4：文档、限制与交付

更新 README、兼容矩阵、进度、变更账本和 drafts 索引；记录真实命令、artifact、服务 URL、数据目录、停止方式和未完成的多实例/生产存储工作。不得把 partial saga 写成跨存储 atomic commit，也不得把 Browser Worker 写成页面关闭后继续运行的后台 Agent。

## 验收矩阵

| 场景 | 必须观察 |
| --- | --- |
| Workspace 与业务都 committed，Session receipt 响应丢失 | 原 operation 查询得到两份 receipt，模型只得到一份结算事件。 |
| Workspace committed、Session append 失败 | 文件保留，operation 为 partial，恢复只补 Session receipt，不重做业务副作用。 |
| Session receipt committed、Workspace unknown | 模型不显示文件成功；刷新继续查询原 operation，不能重新 prompt 或写文件。 |
| 业务 API unknown | 禁止重试业务调用，状态可见为 unknown；只有服务端确认 absent/failed 才可按策略重试。 |
| 两边都 unknown | 保留本地 outbox 和 Session intent，页面显示恢复动作，不宣称成功。 |
| 摘要、Session、Workspace 或 principal 不匹配 | 结构化拒绝；owner、revision、receipt 和文件均不改变。 |
| 同 operationId 不同 payload | `OPERATION_ID_REUSED`；不执行第二个副作用。 |
| owner handoff 后旧 Worker 重试 | 旧 epoch 被拒；新 owner 查询同一 receipt，不重复执行。 |
| 大工具 response | Session 仅含受限摘要/引用；bytes、hash、上限均可核对。 |

## 非目标与限制

本批不引入数据库、消息队列、对象存储或正式 SaaS 身份系统，不改 Agent Loop 核心、正式 Session format 或根级依赖；PoC ledger 只验证协议与恢复语义。单进程 backend 的 per-key queue 不等于多实例 HA；跨存储 saga 仍可能出现 partial/unknown，产品必须把它们显示出来。Browser Worker 仍受页面生命周期约束，关闭页面不会继续执行未完成模型流或业务 Promise。

## Dev Note

本批最重要的负例是“看起来两个 receipt 都成功但实际发生两次业务副作用”。所有 E2E 必须从服务端计数、Session event、Workspace manifest 和 ledger 同时取证；仅断言 UI 文本或 HTTP 200 不足以通过。
