---
description: "规划 Browser-Native DSH handoff 的服务端安全点判定、Session 事件核对、并发 fencing 与真实 Worker 验收。"
---

# Browser-Native DSH handoff 安全点验证计划

## 目标

在 Browser Worker 与未来执行者之间转移 Session 写权时，必须由服务端现存的 DSH Session event log 判定执行是否已结算；客户端 checkpoint 中的空 `pendingOperationIds` 和 `pendingExecutionIds` 只能作为附加声明，不能证明 Agent Loop 已停止。

本批吸收 `dsh-TUI` 的 Session 连续性、取消结算和执行 owner 分离原则，但不移植 TUI 的进程 handoff。验证只处理 PoC Session owner handoff，不创建 Cloud Agent、不转移 Workspace writer lease，也不搬运 Worker 内存或 Promise。

## 候选范围与取舍

| 候选验证点 | 价值 | 可验证性 | 本批决定 | 取舍依据 |
| --- | --- | --- | --- | --- |
| 服务端从 Session 事件判定 handoff 是否处于安全点 | P0 | backend 合同测试和真实 Chrome Worker 可稳定控制运行中的 turn | 纳入 M1-M3 | 当前实现只校验客户端报告的 pending ID 和 Session seq；空列表可以与仍打开的 turn 并存。 |
| handoff 与 Session append、turn settlement 的并发顺序 | P0 | 同进程 per-Session queue 可用 barrier 和并发请求重现 | 纳入 M2-M3 | 必须证明 turn 结束事件先后顺序决定 handoff 接受或旧 owner fencing，不存在中间双写。 |
| Workspace revision、receipt outbox 与 Session checkpoint 的服务端对账 | P0 | 需要把 Session、Workspace 身份和本地 outbox 纳入同一协议 | 保留为下一项 | 当前 Session header 没有权威 Workspace ID；单改 revision 字段会制造虚假的跨存储一致性保证。 |
| Session 与 Workspace owner 的原子转移或可恢复 saga | P0 | 需定义两套 lease 的权威顺序、补偿和未知状态 | 暂不实现 | 现有 handoff 不转移 Workspace lease；缺少真实 Cloud owner 和跨存储事务，无法把局部 mock 结果称为完整交接。 |
| 多实例 backend 的 Session/Workspace CAS、租约与 GC fencing | P0 产品风险 | 需选定并运行生产数据库/共享对象存储 | 暂缓 | 当前 backend 用 `dataDir` 单写锁拒绝第二实例；内存 mock 不能证明数据库事务或跨主机一致性。 |
| 用户、租户、Workspace 和 Session 的授权及 Origin/CSRF 防护 | P0 产品风险 | 需先定 SaaS 身份、cookie、租户和部署模型 | 暂缓 | 当前 PoC bearer 是无账户的实验凭据；临时加身份假设会误导产品安全结论。 |
| 活动 turn 中撤销 capability 并取消当前工具 | P1 | 可用测试策略与 Worker tool delay 确定性触发 | 保留候选 | 运行时撤销与工具副作用取消语义独立于 handoff 安全点。 |
| Worker 重建后的 history/live 连续性与重复 frame | P1 | 已有 adapter 单测；跨刷新 live race 尚需精确观测 | 保留候选 | 需先区分 Session 重放与 Agent turn 恢复，不和 handoff 混为一批。 |
| 插件反复 mount/unmount 的资源泄漏与 dispose 顺序 | P1 | 可用 Chrome 多轮 Worker teardown 和资源计数 | 保留候选 | 对正式长驻页面重要，但不是当前可伪造 handoff 成功的直接根因。 |
| 自然 storage eviction、浏览器进程/OS 崩溃 | P1 | 局部删除和 CDP quota 可注入，真实自然 eviction 不稳定 | 暂缓自然故障；保留已有故障注入 | 不把可控模拟描述成浏览器自发驱逐或断电。 |
| Session 附件、二进制内容和大工具结果引用恢复 | P1 | 可构造跨边界负载测试 | 保留候选 | 需先定义授权、blob 生命周期与 Session 可见性。 |
| Worker Node builtin、动态依赖与 WASI/Shell 扩展 | P2 | 可逐包 smoke，但覆盖范围大 | 暂缓 | 先保证默认 profile 的当前能力，不扩大为任意 Node 兼容承诺。 |

## 本批交付面

### M0：核对 DSH 事件语义

以 DSH Session 类型和 `ToolCallRecovery` 为依据，确认 `turn/start`、`turn/end`、`step/start`、`step/end`、`assistant/message` tool-call block 与 `tool/result.message.source.callId` 的配对规则；tool-call ID 按 turn/step 配对，不能假设全 Session 唯一。也核对 compaction 对已结算 tool result 的 `surfaceOp: replace` 语义。记录当前 backend handoff 只验证 `nextSessionSeq` 与调用方 pending 列表，未检查 event log 是否仍有打开 turn 或未结算工具。

### M1：服务端 quiescence 判定

在 `backend-v2.mjs` 的 Session handoff 路径中，从同一把 per-Session queue 保护下的 event log 派生安全状态。只允许没有打开 turn/step 且没有未结算工具调用的 Session；缺少配对、重复 start、错误 turn/step 关闭或无法解释的关键字段必须拒绝，不得信任客户端空列表覆盖服务端观察到的活动状态。已结算 tool result 的历史 compaction replacement 必须引用当前已知的源结果和完整 replacement range；重复 call ID 通过 `(turn, step, callId)` 区分。

安全点拒绝使用结构化 `HANDOFF_BUSY`/`HANDOFF_STATE_INVALID` 错误，并发生在提升 owner epoch、生成新 token、写 receipt 或 flush Session 文件之前。已完整结束的 `completed`、`aborted`、`error`、`interrupted` turn 可在其工具结果已结算后 handoff。

### M2：事件状态合同与并发

合同测试覆盖空 Session、正常结束 turn、活动 turn、打开 step、未结算 `tool/call`、assistant 消息中尚未结算的 tool call、已结算的错误工具结果、损坏的 turn/step 顺序，以及客户端将 pending 列表伪报为空的情形。每个拒绝用例核对 owner token/epoch、receipt、事件数、durable 文件均未改变；允许用例核对 receipt 和新 owner 正常产生。

handoff 与 `append(turn/end)` 的并发测试只接受两种串行结果：terminal events 先追加时，旧 checkpoint cursor 失效且 handoff 返回 `CHECKPOINT_INVALID`，旧 owner 仍持有写权并可用新 cursor 重试；handoff 先取得锁时，活动 turn 使 handoff 返回 `HANDOFF_BUSY`，旧 owner 随后可以追加 terminal events。不得出现 handoff 成功后旧 owner 仍能追加，或 handoff 拒绝后却发出新 owner 凭据。

### M3：真实 Chrome Worker 活跃 turn 验收

在真实 Chrome 的 Dedicated Worker/DSH Host 中启动一轮可控的 delayed LLM stream，等 backend 已观察到 `turn/start` 后，使用 Worker test port 和空 pending 列表尝试 handoff。预期服务端返回 busy，epoch、receipt 和写权不变；模型 turn 在原 Worker 中完成且不重复请求。随后在同一 Session、同一 Worker 的已结算边界完成 handoff，并复用既有 response-drop/reclaim 断言。

至少另以真实 DSH `tool/call` 未产生 `tool/result` 的服务端事件状态覆盖一条负例；若 Worker 时序不允许稳定构造，则用 backend 合同测试覆盖并在记录中明确，不将 stream-only Chrome 结果称为 tool-awaiting E2E。

### M4：分页兼容、回归与文档

handoff 集成回归同时验证远端 Session 适配器的默认全量读取。适配器须把 DSH `SessionHandle.read()` 的“读取剩余日志”语义映射到后端每页最多 2048 条的 API，并校验跨页 seq 连续性；不得因一页限制而让已有 Session 无法恢复。更新 handoff README 段落、兼容矩阵、handoff 安全计划/进度、`docs/drafts/README.md` 与 `change-ledger.md`。复跑 backend tests、handoff/session-read Vitest、session-owner-handoff Chrome E2E、已有 Workspace Worker handoff E2E、preview build、typecheck 和文档门禁；Chrome 为本批浏览器目标，Safari/WebKit 暂停。

## 验收标准

| 场景 | 预期 |
| --- | --- |
| 客户端 pending 列表为空、Session 有 `turn/start` 无 `turn/end` | `HANDOFF_BUSY`；owner、epoch、receipt 和文件均不变化。 |
| Session 有未结算工具 call，即使 caller 显示无 pending execution | `HANDOFF_BUSY`；旧 owner 仍可写入实际 tool result 并正常结束 turn。 |
| turn/step 边界不配对或顺序损坏 | `HANDOFF_STATE_INVALID`；不发放新 owner token。 |
| turn 和所有工具已结算，checkpoint seq 与当前事件数相同 | handoff 成功，epoch 只递增一次。 |
| terminal append 与 handoff 并发 | append 先到时旧 cursor 拒绝 handoff、刷新 cursor 后可重试；handoff 先到时因活动 turn 被拒且 append 仍成功；无双 owner 或丢失 terminal event。 |
| Chrome 活跃 turn 中请求 handoff | 请求被拒；原 turn 完成一次；随后可在 terminal boundary handoff。 |

## 限制与后续决策

服务端检查 Session event log 只能证明 DSH 记录的 turn/tool 已结算；它不能证明客户端 OPFS/IndexedDB outbox 已清空，也不能将 Workspace writer lease 与 Session owner 原子转移。本批继续拒绝把 Session handoff 写成 Browser-to-Cloud execution handoff。

下一批优先评估是否建立有权威 Workspace 身份的跨存储 checkpoint/receipt 协议；在身份、事务和云端 executor 未定义前，不增加 `workspaceRevision` 的服务端保证，不实现自称原子的双 lease handoff。
