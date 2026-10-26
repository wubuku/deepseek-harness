---
description: "规划 Browser-Native DSH Session 与 Workspace 双写权交接的顺序、未知结果恢复和真实 Chrome Worker 验证。"
---

# Browser-Native Session 与 Workspace 写权交接验证计划

## 目标

验证 Browser-Native DSH 在两个浏览器 Worker 之间移交同一执行任务时，如何依次结算 Session 与 Workspace 状态、转移各自写权，并在请求结果未知或 Worker 消失后安全恢复。本批补上已有 Session handoff 与 Workspace writer lease 各自正确、但未共同验证的缺口。

本批实现 PoC-local 有序协调器，不声称跨文件事务、分布式租约或 Browser-to-Cloud Agent handoff。Session 和 Workspace 仍是各自存储的权威；DSH Session event log 仍是 Agent 运行事实，Workspace revision/receipt 仍是文件状态事实。协调器必须把已完成、明确失败和结果未知分开。

## 候选范围与取舍

| 候选验证点 | 价值 | 选择 | 依据 |
|---|---:|---|---|
| Session handoff 与 Workspace lease 分开转移导致的部分所有权状态 | P0 | 纳入 | 已有 Session event-log safe point 和 Workspace fencing，但没有共同顺序；可在真实 Chrome 双 Worker 中复现。 |
| 协调器字段与既有 Session wire 字段不一致 | P0 | 纳入 | 协调器使用 `ownerEpoch`，既有 Session API 使用 `epoch`；必须在 Worker adapter 显式映射并由真实请求验证。 |
| Workspace identity cookie 不必要地发送给 LLM proxy | P0 | 纳入 | handoff 同时核验 Workspace writer；授权 cookie 应只匹配 Workspace 与 handoff 路径，不得扩展到模型请求。 |
| Worker 在 handoff 请求响应丢失或 terminate 后的双租约恢复 | P0 | 纳入 | 可用同源 backend 故障钩子、短租约和真实 Worker 终止验证，不依赖自然 OS 崩溃。 |
| 接收方是否在取得 Session owner 和 Workspace lease 前运行模型/工具 | P0 | 纳入 | 需要实际请求计数、Session epoch、Workspace fencing 与副作用 receipt 共同证明。 |
| Session receipt 与 Workspace manifest revision 的交接 checkpoint 是否一致 | P0 | 纳入 | 两侧数据分别持久化；checkpoint 必须记录 seq、durable watermark、workspace identity/revision、fencing token 和未结算 receipt 数。 |
| 浏览器 pagehide 中 Session flush、Workspace 本地 flush 和 release 的统一屏障 | P0 | 保留为后续项 | pagehide 不保证异步工作完成；与显式 Worker-to-Worker handoff 是不同生命周期，本批不把页面关闭伪装成可靠交接。 |
| 后台恢复、多个 backend 实例和跨主机 fencing | P0 产品风险 | 不纳入 | 当前 backend 明确是单实例 PoC；本批不能从单进程队列推断分布式一致性。 |
| 动态 capability probe 结果驱动运行中 tool schema 撤销 | P1 | 保留候选 | 最近批次已完成启动前依赖探测；运行时撤销还需单独验证 DSH 工具调用取消语义。 |
| 大 Session 流式 hydrate、附件引用和数据保留/清除 | P1 | 保留候选 | 这些问题不应与两个 owner store 的交接顺序混在一起。 |
| 插件卸载时未完成 HITL、工具 Promise 与资源清理 | P1 | 保留候选 | 是独立的 Worker/Host teardown 生命周期面。 |

## 当前事实与交接顺序

- Session `handoff` 在服务端检查已追加的 DSH turn、step 与 tool/result 是否结算，验证 checkpoint cursor 后提升 owner epoch；相同 `handoffId` 的重放不会再次返回新 bearer。
- Workspace `lease` 分别提供 `claim`、`renew`、`release` 和 `resume`，用 `fencingToken` 拒绝旧 writer；当前没有与 Session handoff 共用的事务或 owner generation。
- Workspace tool receipt 必须已进入 Session 并 durable，Workspace mutation 必须已 commit，且本地 OPFS/IndexedDB snapshot 必须完成，交接才可开始。
- 本批顺序固定为：等待执行静止 → flush Workspace 云端 revision 与本地 snapshot → flush Session outbox 并核对 `durableThroughSeq` → 以 Workspace 身份、revision、fencing token 和 Session cursor 构造 checkpoint → Session handoff → 释放旧 Workspace lease → 接收方 claim Workspace 并以转交的 Session owner credential 打开同一 Session。
- Session handoff 未明确成功时，不释放 Workspace lease；handoff 已成功但 Workspace release 返回错误时，报告 `session-transferred/workspace-unknown`，接收方等待旧 Workspace lease 失效后再 claim。任何 `unknown` 都不得自动重放 prompt、工具或业务副作用。
- Workspace 身份使用两个 HttpOnly cookie：原 principal cookie 只匹配 `/api/browser-native/workspace`，handoff 专用 cookie 只匹配 `/api/browser-native/session/handoff`；LLM route 不接收任一 cookie。Worker adapter 将 checkpoint 内部的 `ownerEpoch` 映射到既有 wire 字段 `epoch`。
- 如果 Session handoff 响应丢失，旧 owner 不可用同一 handoff receipt 取回新 bearer；双方租约到期后，接收方可从已 durable 的 Session 和 Workspace 状态重新 claim。等待期间不启动模型请求。

## 实施范围

### M0：协议、身份与已有能力审查

- 核对 Session checkpoint schema、Session `nextSeq`/`durableThroughSeq`、Workspace revision、receipt outbox、lease token 与 fencing token 的当前实现。
- 明确 checkpoint 不把 Workspace revision 声称为 Session backend 已独立验证的事实；协调器在同一 backend 中读取两侧状态并将结果保存在测试证据中。
- 复用现有 Session handoff、Workspace flush/lease API、PoC Worker test port 和 Chrome 多页面入口；不新增正式 package、Session event type、全局依赖或独立 Agent Loop。

### M1：handoff 状态机与 checkpoint

- 新增 PoC-local `BrowserNativeExecutionHandoff` 协调器，按固定顺序运行 Workspace durability、Session durability、Session handoff 和 Workspace release。
- checkpoint 至少记录 `sessionId`、旧 owner epoch、`nextSessionSeq`、`durableThroughSeq`、`workspaceId`、Workspace revision、旧 fencing token 与待结算 receipt 数。
- 前置检查不通过时不得调用 Session handoff；handoff 明确未提交时不得释放 Workspace lease；handoff 后的网络失败返回结构化 unknown 状态和 `handoffId`。
- 只有接收方成功获得两侧写权并重新打开原 Session 后，才能发送模型请求或执行文件工具。

### M2：合同与故障测试

- 单测覆盖顺序、Session 未 durable、Workspace dirty/local snapshot 未 durable、存在 pending receipt、Session handoff 失败、handoff response lost、Workspace release response lost、重复恢复与 checkpoint identity mismatch。
- 每个失败断言都核对尚未调用的下一阶段回调，避免测试只检查最终错误字符串。
- 使用 response-loss 负例证明协调器不把同一 handoff receipt 重放成可取回 bearer；任何恢复都只能走新 owner claim 或原 lease 到期路径。

### M3：真实 Chrome 双 Worker 交接

- Worker A 通过真实 DSH `write` 产生 Workspace commit、Session tool/result 和 Workspace receipt；等待 Session durable watermark 与 Workspace revision 稳定。
- 正常路径由 A 执行协调器交接；Worker B claim 新 Workspace fencing token、用 handoff owner credential 打开同一 Session，随后完成第二轮真实 DSH 文件工具。
- 响应丢失路径在 Session handoff 已提交后丢弃响应并终止 A；B 在 Session/Workspace lease 到期前不得发出 LLM 请求，过期后重新 claim 两侧状态并继续原 Session。
- 交接前置 flush 失败与 Workspace release 响应丢失各覆盖一条可控故障；断言没有重复 Workspace revision、重复 tool call 或错误的 Session receipt。
- 检查 browser request、Session log、page error 与 backend 记录，不包含模型凭据或 owner bearer 日志；请求不得离开同源。
- 检查浏览器请求头，确认两类 principal cookie 都不会发送到 `/api/browser-native/llm`。

### M4：真实模型 smoke、文档与交付

- 在本批代码稳定后，用现有同源 backend 与 `docs/drafts/.env` 跑真实 Chrome LLM 的两轮 `write → handoff → write/read` 冒烟；handoff 故障语义仍由模型无关测试证明。
- 更新 Browser-Native PoC README、兼容矩阵、`docs/drafts/README.md`、change ledger 和本计划/进度。
- 运行 handoff 单测、backend contract tests、Chrome 双 Worker E2E、真实 LLM smoke、preview build、Web typecheck 和文档门禁；Safari/WebKit 暂停。

## 验收矩阵

| 场景 | 预期 | 证据 |
|---|---|---|
| Workspace 仍 dirty 或本地 snapshot 未持久化 | handoff 不调用 Session endpoint；两类旧 owner 均有效 | 单测回调顺序、Chrome 故障路径 |
| Session `durableThroughSeq < nextSessionSeq - 1` 或 receipt 未结算 | handoff fail closed；Workspace lease 不释放 | 单测与真实 Worker event/readback |
| Session handoff 明确失败 | 不释放 Workspace lease；旧 Worker 可在同 Session 继续 | backend 注入与 Chrome 续聊 |
| Session handoff 已提交但响应丢失 | 不释放 Workspace lease、不猜测成功；同 receipt 重放不给 bearer | response-drop Chrome E2E、backend handoff contract |
| Session handoff 成功、Workspace release 响应未知 | 返回 `session-transferred/workspace-unknown`；接收方等 lease 到期或确认 release 后 claim | Chrome 请求和 fencing 计数 |
| 两侧 owner 都成功转移 | B 获得更高 Session epoch 和 Workspace fencing token；原 Session 只产生一次副作用并能继续 | Chrome DSH tool loop、Session/Workspace records |
| A 的旧 Session/Workspace token 在 handoff 后迟到 | append、LLM、renew、commit 均被拒绝；manifest 与 receipt 不变 | backend API 与 E2E stale-token assertions |

## 限制

本批协调的是同一个 PoC backend 管理的 Session 与 Workspace，不提供跨文件原子事务。Session 和 Workspace 仍由各自 store 持久化；协调器只能按顺序提交并保守处理 unknown。双 Worker Chrome 结果不证明多实例 backend、跨主机 fencing、SaaS 身份授权、Cloud Durable Worker、pagehide 回调必达或 OS 级崩溃恢复。
