---
description: "规划 Browser-Native DSH 审批请求完整性、一次性决策、撤销、无 answerer 和 Worker 恢复验证。"
---

# Browser-Native DSH 审批完整性与恢复验证计划

## Summary

本批把 dsh-TUI 审批实现中的安全原则迁移到 Browser-Native DSH：审批 UI 只能展示仍锚定在当前 Session 未结算 `tool/call` 的请求；请求按队列顺序呈现；`callId` 或 request id 重复、迟到答案、取消和卸载都必须 fail closed。审批结果仍由 DSH `ApprovalService` 和 Session event log 决定，浏览器侧只做 projection 和一次性 UI claim，不创建第二个权限事实源。

当前权限批次已经验证三种 preset、拒绝和 Full access 风险确认，但明确留下 `allowed-once`、answerer cancel/timeout/unavailable 和 Worker 终止后的专门恢复缺口。本批不添加隐藏的 YOLO 参数；`never` 只能来自显式权限策略，不能由模型、URL 或前端按钮静默升级。

## 候选范围与取舍

| 验证点 | 价值 | 本批决定 | 要回答的问题 |
| --- | ---: | --- | --- |
| approval request 与未结算 tool call 的身份绑定 | P0 | 本批完成 projection 绑定与正式拒绝路径 | 页面是否可能把历史文本或伪造 waterfall 请求当成当前 Agent 的待审批操作？ |
| FIFO 队列、同 callId 重复和一次性 settlement | P0 | 本批完成 projection FIFO/claim 和重复、未知、迟到输入诊断 | 并行工具或重复事件是否产生多个可点击审批，导致一个调用获得相反或重复决定？ |
| `allowed-once`、`rejected`、`cancelled`、`unavailable` | P0 | 仅实测正式 `rejected`；`allowed-once` 仅测 durable replay；其余延后 | 所有非允许结果是否都阻止被保护副作用，并留下可回放的 `approval/decided`？ |
| 页面卸载、Worker terminate、答案提交竞态 | P0 | 实测审批等待中的刷新收束为 unknown；答案提交竞态与独立 terminate 矩阵延后 | UI 断开后是否错误地把 Promise 当作成功，或刷新后重复提交原工具？ |
| 同一 Session 双标签审批 claim | P1 | 延后 | 一个页面回答后，另一个页面的迟到回答是否被拒绝且不重复副作用？ |
| `never`/YOLO 策略 | P0 | 复用既有权限批次证据；本批未增加策略测试 | 是否能证明策略是 Session 可回放状态，而不是隐藏快捷开关？ |
| 跨设备审批投递、生产身份与多 backend | P1 | 延后 | 需要生产认证、跨设备 answerer 路由和分布式 owner，不在 PoC 内伪造。 |
| 真实模型自主生成审批请求 | P1 | 不作为通过标准 | 模型选择有方差；用 deterministic tool call 验证审批时序，真实模型只做普通接线 smoke。 |

## 选定交付面

### M1：Browser approval projection

新增 PoC-local `BrowserNativeApprovalProjection`，输入已经由调用方按 Session 隔离的事件流，输出 active approval snapshot 与 FIFO queue。正式 approval 事件本身不携带独立 agent id，因此 projection 不伪造 agent 过滤；调用方必须先绑定正确的 Session。它只接受存在未结算 `tool/call` 的 `approval/asked`，用事件中的 `approval/decided` 和对应 `tool/result` 标记为已消费；重复 request id、重复 `callId`、无 callId、未知 callId 和已结算 call 都显示为 fail-closed diagnostic，不能显示为可允许的真实命令。

projection 从 `tool/call` 事件恢复命令摘要和 tool name，不复制或信任 approval request 携带的任意前端文本；超长参数只显示有界摘要。调用方必须先提供已按 Session 隔离的事件流；正式 approval event 没有独立 agent id，因此 projection 不声称按 agent 过滤。该对象不调用权限服务、不写 Session，也不授予 owner。

### M2：一次性决定与终态

对 projection 的 `claim(requestId, outcome)` 只允许 active request 的第一次 UI claim；它返回 `durable:false`，不追加事件，也不授予工具权限。本批只实测正式 `rejected` 的 Session 终态；`allowed-once` 只验证 projection 以 `approval/decided` replay 重建，不代表真实 Chrome 完成 Allow once。`cancelled`、`unavailable`、重复决定、旧 Session 决定和跨页面重复 answer 的正式服务行为没有在本批 E2E 覆盖。projection 只在重新读取事件后更新，因此刷新会丢弃未提交 claim，而不会把 UI 内存状态伪装成 durable decision。

### M3：Worker/Chrome 故障矩阵

使用真实 Dedicated Worker 和同源 backend 的 deterministic approval scenario，本批验证正式拒绝无 Workspace 副作用，以及审批等待期间刷新后原 tool call 结算为 unknown、无新 LLM 请求且不恢复原 Promise。真实 Allow once 写入、取消/无 answerer、双标签迟到决定和独立 Worker terminate 矩阵留待后续批次；刷新后不得自动重放原 prompt、tool call 或副作用。

### M4：策略与真实模型接线

复用正式权限 preset 和 `never` 证据，确认 `never` 没有 approval UI，且其策略变化进入同一 Session 的权限事件。最后运行一次真实 Chrome、同源 backend、真实模型的普通 `read → write → read` smoke；不把真实模型是否自主选择审批写入通过条件。

## 验收矩阵

| 场景 | 预期结果 | 禁止结果 |
| --- | --- | --- |
| 未结算 tool call 的 approval | 显示 tool、call id 和有界命令摘要 | 只凭 request 文本显示可执行审批 |
| 无 callId、未知 callId、已结算 call | fail-closed diagnostic；不得允许 | 把伪造请求渲染成真实命令 |
| 两个相同 callId/requestId | 只保留一个可决定项，其他标记重复 | 两个按钮分别执行或一个覆盖另一个 |
| `allowed-once` | 原 tool 继续，Workspace/业务副作用至多一次，Session 一条 decided | 自动变成 always/never 或重复执行 |
| `rejected`/`cancelled`/`unavailable` | tool 失败或取消，Session 记录终态，无后续受保护写入 | 把失败当成功、静默等待或自动重试 |
| Worker terminate / refresh | 原 Promise 不恢复；已 durable 的 approval 事件可重建 projection | 自动重发原 prompt/tool 或丢失已记录决定 |
| 双页面迟到决定 | 只有当前 owner/active claim 能结算；另一页面收到结构化拒绝 | 两个页面都写入决定或产生两个副作用 |

## 证据和限制

Vitest 证明 projection 的身份、队列和一次性规则；Chrome E2E 证明适配器在 Dedicated Worker、真实 DSH Host 和同源 Session 中运行，并观察实际 Workspace/Session 结果；真实 LLM smoke 只证明普通 Agent Loop 没有退化。该批不证明生产多租户授权、跨设备审批、分布式 answerer、OS 崩溃恢复、自然 eviction、Safari/WebKit 或页面关闭后的后台 Agent。

## 实施顺序

1. 先实现 plan 中的 projection 和单元 conformance，固定 request/call/session 身份规则。
2. 将 probe 加入 Worker test port，运行模型无关的 Chrome approval/refresh/late-decision 矩阵。
3. 复跑已有权限与 HITL E2E，确保不破坏 preset、Stop、timed question 和普通 Session。
4. 运行真实 LLM Chrome smoke，更新 README、兼容矩阵、docs/drafts 索引、progress 和 change ledger。
5. 运行定向构建、类型、文档门禁，提交并推送 `research`。

## 非目标

本批不修改正式 `dsh-user-approval`、权限 preset 或 Agent Loop，不把 projection 变成第二个审批服务，不实现静默 YOLO，不把 `parked` 或 Worker terminate 后的 projection 描述为后台执行。

## 本批结果边界

已实现 `BrowserNativeApprovalProjection`、Worker URL-gated `approval-projection-probe` 和 Chrome scripted E2E。当前实测包括 projection FIFO、一次性非 durable claim、durable `allowed-once` replay、invalid-event diagnostics、正式 `rejected` 及审批等待期间刷新后的 `TOOL_OUTCOME_UNKNOWN`；拒绝路径没有 Workspace 副作用，刷新后没有新 LLM 请求或审批卡片。真实 Allow once 工具完成、cancelled/unavailable、双标签 owner 竞态、单独 terminate 与 answer-submission race 未验证，不得按验收矩阵的预期结果宣称通过。
