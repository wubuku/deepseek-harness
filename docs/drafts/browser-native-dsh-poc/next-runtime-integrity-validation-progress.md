---
description: "记录 Browser-Native DSH 下一批运行时完整性验证的实施进度、Chrome 证据和未完成项。"
---

# Browser-Native DSH 下一批运行时完整性验证进度

## 当前状态

状态：四个验证面均已实施并完成当前 checkout 的 Chrome/scripted 验收；相关文档和目录外变更账本已更新。目标、验收条件与候选边界见[验证计划](next-runtime-integrity-validation-plan.md)。基线是本批开始时干净的 `research` 分支；实施始终在主 worktree，没有隔离 worktree。真实 LLM、Safari/WebKit、自然 storage eviction、OS 级崩溃和生产多实例 backend 不属于本批通过范围。

| 验证面 | 状态 | 当前基线 | 下一步 |
|---|---|---|---|
| 活动 Worker lease 续租和失权 | `complete` | `workspace-writer-heartbeat.e2e.mjs` 真实 Chrome：20 秒 TTL 下等待超过两个 TTL，注入一次 renew 503，后续 renew 成功；竞争标签 claim 返回 409，同一问答 turn 继续至 `write` 和 Session receipt。`workspace-writer-startup-failure.e2e.mjs` 再注入 manifest 503，确认失败 Worker 不再 renew，租约到期后 claim 成功。另复跑 lease、reload 和 expiry E2E。 | 活动页面内 heartbeat 可续租；Workspace 初始化失败会停止本地续租，但服务端 lease 仍要等 TTL 到期；页面冻结/关闭后不能据此推断后台运行或持续持有租约。 |
| Agent `write` 的未知 commit 结果和 backend 重启 | `complete` | `agent-workspace-unknown-commit-recovery.e2e.mjs` 真实 Chrome：backend commit 成功后丢弃响应并终止 Worker，以相同 `dataDir` 重启 backend；刷新后 operation lookup 恢复唯一 revision 与一条 receipt，原工具调用以 `TOOL_OUTCOME_UNKNOWN` 结算且不重跑。 | 仅证明 PoC 单 backend/local dataDir 的恢复与幂等路径，不证明生产多实例或跨服务事务。 |
| legacy HITL 等待中的刷新 | `complete` | `ask-user-refresh-recovery.e2e.mjs` 真实 Chrome：默认 legacy schema 的 `ask_user_question` 持久化后刷新；Session 记录 `TOOL_OUTCOME_UNKNOWN` 和 interrupted turn，旧问题卡不再可回答，刷新不增加 LLM 请求；用户随后可在同一 Session 发起独立新 turn。 | 该结果只描述默认 legacy schema。timed schema 的迟答和 Worker 重建由[独立 timed lifecycle 验证](timed-hitl-lifecycle-validation-plan.md)覆盖；新 turn 不是旧审批答案。 |
| IndexedDB 前向版本和恢复导出 | `complete` | `indexeddb-forward-version-export.e2e.mjs` 真实 Chrome：已有 v2 DB 保持版本、metadata 和未知 object store 内容不变；当前页面拒绝以 v1 运行并导出 Workspace metadata、store 名称和可读 OPFS blob，SHA-256 校验通过。 | exporter 导出 metadata 与识别出的 OPFS bytes，不会自动迁移未知 schema，也不承诺导出未知 object store 的记录。 |

## 里程碑

| 里程碑 | 状态 | 命令/证据 | 结果与阻塞 |
|---|---|---|---|
| M0：基线与候选审查 | `complete` | 检查 `research` HEAD、工作区、worktree、PoC README、兼容矩阵、近期计划/进度、Workspace lease/store/provider 与 ask-user 源码 | 确认工作区干净；已存在的缓存重建、离线/CAS、receipt、resume 重放、正常问答和 crash-window 测试不会重复建设。 |
| M1：活动 lease heartbeat | `complete` | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`；Chrome 155 `workspace-writer-heartbeat.e2e.mjs` 通过。首轮复测发现故障注入早于问题卡出现，测试修正为问答已呈现后注入；最终观察到 renew 503 后恢复、跨两个 TTL 持续续租、竞争 claim 409 和同 turn 文件写入。随后 `workspace-writer-startup-failure.e2e.mjs` 注入 manifest 503，观测到初始 claim 后无 renew，1.5 秒测试 lease 在 1.57 秒后可由新请求接管。 | 复跑 `workspace-writer-lease.e2e.mjs`、`workspace-writer-reload.e2e.mjs`、`workspace-writer-expiry.e2e.mjs`，均通过；失败的 Workspace prepare 会停止 Worker heartbeat，但不会提前释放服务端 lease。 |
| M2：Agent unknown commit + backend restart | `complete` | Chrome `agent-workspace-unknown-commit-recovery.e2e.mjs` 通过；commit 响应丢失并重启 backend 后，commit 请求共 2 次但唯一 operation revision 为 1，DSH write 调用 1 次、receipt 1 条、工具结果为 unknown。 | 没有重放模型 turn 或业务副作用。 |
| M3：legacy HITL refresh | `complete` | Chrome `ask-user-refresh-recovery.e2e.mjs` 通过；刷新后无 legacy 问题卡、调用结果 unknown、turn interrupted；刷新期间 LLM 请求数保持 2；用户发送新消息后同 Session 新 turn completed，问答调用仍为 1，Workspace revision 保持 0。 | 只描述默认 legacy schema；timed schema 的继续问题和迟答另见 timed lifecycle 验证。 |
| M4：IndexedDB v2/export preservation | `complete` | Chrome `indexeddb-forward-version-export.e2e.mjs` 通过；DB version 2、两个 store 和未来数据保留，导出一个 hash 匹配的 OPFS blob，页面无错误或跨源请求。 | 未知 object store 的记录没有导出；只导出当前格式认识的 Workspace metadata 与 Workspace OPFS bytes。 |
| M5：文档、门禁与最终验证 | `complete` | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`、`pnpm run typecheck`、Browser-Native Workspace Vitest 22/22、`backend-v2.test.mjs` 15/15、六项 Chrome E2E（heartbeat、startup failure、unknown commit、HITL refresh、IndexedDB forward version、lease expiry）、`workspace-writer-lease.e2e.mjs`、`workspace-writer-reload.e2e.mjs`、`pnpm run test:docs` 21/21 和 `pnpm run doc-sync` 43/43 均通过。HITL refresh 覆盖显式新 turn；startup failure 验证失败 Worker 不续租且 lease 到期后可接管。 | 证据仅覆盖当前 checkout、Chrome 155、scripted LLM 与单机 PoC backend；真实 LLM、Safari、自然 eviction、OS crash 和生产多实例未验证。 |

## 决策和限制

- 验证以真实 Chrome Dedicated Worker、DSH Host、PoC backend 和 scripted LLM 为主；Safari/WebKit 暂停，真实模型不作为协议恢复通过条件。
- 测试 lease 时长仅用于缩短确定性实验；任何性能、持久性或安全结论都限定于当前 checkout 和单机 PoC backend。
- IndexedDB 前向版本只要求不降级、不静默覆盖和尽力导出可识别的旧记录；本批不自动迁移未知新 schema。
- 前向版本导出不会读取未知 object store 的记录；它列出 store 名称，并导出已识别的 Workspace metadata 和 Workspace OPFS bytes。
- 默认 legacy `ask_user_question` 刷新后，DSH 以 `TOOL_OUTCOME_UNKNOWN` 和 interrupted turn 表示等待 Promise 已丢失；UI 不显示可继续回答的旧问题，也不自动续跑。timed schema 可从 Session projection 恢复同一 callId 并接收迟答，证据及 Stop 限制见[timed HITL 生命周期记录](timed-hitl-lifecycle-validation-progress.md)。
- E2E 读取 Session DTO 时，`assistant/message` 文本位于 `data.message.content` 的文本 block 中；新 turn 必须以目标 `user/message` 之后的 `turn/end` 判断，避免把历史中断 turn 当作续聊结果。
- 真实 browser eviction、OS crash、大文件 chunk sync 和多实例云 backend 暂留后续专批，原因和候选排序见验证计划。
