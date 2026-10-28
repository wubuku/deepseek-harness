---
description: "规划 Browser-Native DSH 工具调用跨 Session 与 Workspace 持久化断点的恢复验证。"
---

# Browser-Native DSH 跨存储工具恢复验证计划

## Summary

本批针对真实 DSH 文件工具的 Workspace receipt 已被 Session backend 持久化、但 `session/flush` 响应丢失的时序，验证 Worker 与同一 dataDir backend 重建后能否从 Session、Workspace operation receipt 和 IndexedDB outbox 对账，且不伪造成功或重复工具副作用。Session event log、Workspace manifest/operation receipt 和浏览器本地 outbox 仍是各自存储的事实来源；本批不宣称跨存储原子事务或全局 exactly-once。

DSH-TUI 的可迁移经验是 live/replay 使用同一 Session 事实、区分 confirmed/unknown/failed，并将执行者身份与 Session ID 分开。本批将这些原则应用到真实 Browser Worker 与 DSH Host，不复制 TUI 的主机进程模型。

## 候选范围

| 候选点 | 价值 | 本批处理 | 原因 |
|---|---|---|---|
| Workspace commit 已提交、响应丢失、Worker 重建 | 高 | 作为既有覆盖回归 | [unknown commit E2E](tests/agent-workspace-unknown-commit-recovery.e2e.mjs)已验证查询原 operation receipt，未重放 commit。 |
| Session receipt append 未到 backend 时 Worker 终止 | 高 | 作为既有覆盖回归 | [receipt recovery E2E](tests/agent-workspace-receipt-recovery.e2e.mjs)原覆盖此时序；本批改为验证更晚的 durable flush 响应丢失。 |
| 普通 Session durable flush 响应丢失、Worker 重建 | 高 | 作为既有覆盖回归 | [Session outbox E2E](tests/session-outbox-recovery.e2e.mjs)已覆盖 prompt marker 与 durable watermark，但未关联 Workspace tool receipt。 |
| Workspace receipt durable、flush 响应丢失、Worker 与 backend 重启 | 很高 | 新增 | 同一场景串联真实 DSH 工具、两份存储、durable watermark 与恢复，不把单 store 测试拼成跨 store 结论。 |
| receipt 的 call、Session、Workspace、revision、digest 或 paths 错配 | 很高 | 新增 | 当前 provider 原先只比对部分字段，可能把不同 receipt 当成已协调并清除 outbox。 |
| pending receipt 与 execution-owner handoff | 高 | 回归 | 既有 handoff 从 Session 事实校验未结算 call，并检查 Workspace receipt；不重复扩展相同场景。 |
| Session append 接受后响应丢失、无 Worker 重启 | 中 | 不新增 | [Session transport E2E](tests/session-transport-resilience.e2e.mjs)已有 backend 提交后丢弃响应并对账。 |
| 自然 quota eviction、浏览器 OS 崩溃、磁盘损坏 | 很高 | 后续独立攻关 | 当前注入测试不等价于平台自然故障；需要可重复且可观察的浏览器/存储故障环境。 |
| 多 backend/跨主机 metadata CAS 与 lease fencing | 很高 | 后续独立攻关 | 当前文件 backend 的进程锁与共享存储不是生产 HA 证据；应先确定生产存储原语。 |
| 租户授权撤销、真实 SaaS 权限变化 | 高 | 暂缓 | PoC principal 不代表正式身份、授权和撤销语义。 |
| 大型真实 LLM tool arguments 与 VFS 峰值内存 | 高 | 后续独立批次 | 与此处持久化时序正交，需单独对模型输入、工具 schema 和内存上限取证。 |

## 实施范围

### M0：事实与既有证据

- 核对 `tool/call`、`tool/result`、Workspace commit、`browser-native/workspace-receipt` append、Session flush、durable watermark 和 IndexedDB receipt outbox 的顺序。
- 复跑已有 Workspace commit unknown、receipt append 前中断、Session outbox durable response loss 与 execution-owner handoff 测试，按它们实际触发的断点记录基线。
- 不把旧测试结果算成本批新增证据。

### M1：Receipt 身份匹配

- 对账字段包括 `sessionId`、`turn`、`step`、`callId`、`toolName`、`toolCallSeq`、`operationId`、`workspaceId`、`baseRevision`、`revision`、`manifestDigest`、`paths` 和 `replayed`。
- 同一 operationId 只有在完整 receipt 与 originating DSH call 均一致时才能确认 outbox；任一字段不符都保留 outbox 并 fail closed。
- Session owner epoch、Workspace revision 与 Workspace fencing token 分开解释；不将它们压成一个全局版本。
- 不新增正式 Session event type/version；继续使用 PoC `ignorable` receipt event。

### M2：Durable receipt 确认丢失

- 由 scripted LLM 触发真实 DSH `write`，等待 receipt append 到达 backend；让 `session/flush` 成功并核对 `durableThroughSeq` 覆盖 receipt seq。
- 在 flush 响应交还 Worker 前终止 Dedicated Worker、重启使用相同 dataDir 与端口的 PoC backend，并丢弃响应。
- 刷新同一 Session/Workspace；检查 Session seq 连续且 durable、唯一 tool call/result/receipt、唯一 Workspace revision、原 operationId 和本地 outbox 最终清空。
- 确认刷新不重发原 prompt/LLM 请求、不重新 dispatch 原工具、不新增 Workspace commit 或 Session receipt；不要求已中断的 assistant turn 被伪造为正常完成。
- 测试通过 Session cookie 从 backend 直接读回事实，避免 UI 状态或页面连接重建误作持久化证据。

### M3：交叉回归

- 逐字段篡改 receipt 身份与提交数据，验证恢复路径拒绝错配，不确认 IndexedDB outbox。
- 复跑 execution-owner handoff 合同和 Chrome E2E，验证新 owner 未取得 Session/Workspace 写权前不会请求 LLM。
- 确认 Workspace 的 `synced` 只表示 Workspace 后端 revision；不能解读为 Session receipt 与 Workspace 的跨存储原子提交。

### M4：正常模型路径与交付

- 运行真实 Chrome + 真实 LLM `read → write → read` smoke，验证本批 adapter 变更没有破坏正常 DSH Agent Loop；它不是故障恢复证据。
- 运行相关 Node/Vitest、Chrome E2E、preview build、Web typecheck、文档检查和 diff 检查；逐项记录执行结果。
- 更新进度、PoC README、兼容矩阵、drafts 索引和 change ledger，只写本 checkout 与本轮实际验证内容。

## 退出条件

- 故障点能被确定地观察到：Session receipt 已 durable、Worker 未收到对应 flush response、backend 已从同一 dataDir 重启。
- 恢复后同一 operation 最多对应一个 Workspace revision；Session 中该 DSH call、tool result 与 receipt 各只有一份；outbox 清除前已核实 Session durable watermark。
- 原 prompt 与副作用不自动重放；不确定状态不标记为已保存。
- 结论限定于当前 checkout、Chrome、同一 PoC dataDir/backend 与注入的请求响应故障；不声称跨存储事务、生产 HA、自然 eviction、OS crash 或普遍 exactly-once。

## 明确限制

Session 与 Workspace 独立持久化，顺序协调不能消除任意崩溃时的部分提交。恢复依据是稳定 operationId、Workspace operation query、Session readback、durable watermark 和本地 outbox。页面关闭仍会终止 Dedicated Worker；本批 backend 重启和响应丢失不是 OS/磁盘崩溃、多实例存储或生产授权证据。
