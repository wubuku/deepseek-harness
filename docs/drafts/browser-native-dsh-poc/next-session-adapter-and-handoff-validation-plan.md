---
description: "规划 Browser-Native DSH 下一批 Session 回放、生命周期、能力发布和 Browser-to-Cloud 执行交接验证，区分已有 Workspace lease 证据与尚未证明的 Agent owner handoff。"
---

# Browser-Native DSH Session 适配与执行交接验证计划

## Summary

本批验证 Browser-Native DSH 从页面 Worker 运行到可交接执行者时最容易被误解的四个问题：Session 历史是否先于 live event 完成、取消和销毁是否保留未知结果、能力是否经过证据后才进入模型工具清单，以及 Browser Worker 是否能在安全点把同一 Session 的写权交给云端执行者。本批不把 UI 投影、Workspace writer lease 或 Worker 重启自动称为完整 Agent handoff。

目标是形成可复跑的 conformance 证据，而不是再增加几个孤立的工具测试。DSH Session 仍是对话和工具事实源；Workspace revision、operationId、Session seq、owner epoch 和 fencing token 各自保持独立。Browser Worker 仍受页面生命周期约束；云端接管只有在显式 handoff 协议和新 owner fencing 都成立时才存在。

## 候选范围

| 候选验证点 | 价值 | 本批决定 | 主要风险 |
|---|---:|---|---|
| Session history、live event 和重连去重 | P0 | 纳入 M1 | 历史未完成时提前显示 live event，重连造成重复 prompt 或事件间隙被静默吞掉 |
| cancel、dispose、late result 的 settlement 矩阵 | P0 | 纳入 M2 | 取消被误报成功，未知业务副作用被重放，旧 HITL Promise 继续写入新 Worker |
| capability declared/staged/live/degraded/permission publication | P0 | 纳入 M3 | 仅因模块可加载就把主机能力发布给模型，或把 degraded 能力伪装成完整能力 |
| Browser-to-Cloud Session owner handoff | P0 | 纳入 M4 | 旧 Worker 的迟到 append、renew 或 tool result 越过交接写入 Session |
| 多观察者只读订阅与版本连续性 | P1 | M1 一并覆盖 | observer 断线后无法判断 gap，UI projection 与事实源分叉 |
| Session 与 Workspace receipt 的跨存储 reconciliation | P1 | M2/M4 复用已有 receipt 测试 | 两边一边 committed、一边 unknown 时误报“已保存” |
| 页面冻结、浏览器进程退出和自然 storage eviction | P1 | 只保留失败注入边界 | Playwright 无法等价模拟自然 eviction 或 OS crash |
| 多实例 backend、生产对象存储和跨节点锁 | P1 | 不伪造完成 | 当前 PoC 单进程和本地 `dataDir` 不能提供 HA 证据 |
| 大型真实 LLM tool arguments 和流式断线 | P1 | 复用已有上限，另列后续 | 上游模型超时会污染协议结论，真实大型参数仍缺稳定样本 |
| Browser capability registry 与业务 capability | P1 | M3 只验证发布机制 | SaaS 领域动作需要授权、幂等和 receipt，不能由静态文件工具推导 |
| Native/WASI/Shell provider 分层 | P2 | 不纳入 | 运行时引入会扩大问题，不能替代 Browser-safe capability |
| 后台 Agent 与 Durable Worker 长任务 | P0 架构边界 | M4 只验证显式交接 | Dedicated Worker 不是后台 Agent，页面关闭后的执行必须由云端 owner 承担 |

## 选定交付面

### M1：Session adapter conformance

新增与 DSH Session transport 无关的 adapter conformance helper，要求：

- `history()` 完成前不接受 live projection；
- history 的 `seq` 必须连续，live event 只能从明确的 `nextSeq` 开始；
- 相同 seq 和相同事件可去重，相同 seq 的不同事件必须 fail closed；
- event gap、version rollback、未知 required event 和 identity 不匹配必须拒绝；
- `sessionId`、backend identity、worker instance 和 owner epoch 必须分别可观察；
- Worker 重启只能从 Session authority hydration，不得从页面内存补造事件。

测试使用纯内存 provider 和真实 Session DTO fixture；它证明 adapter 纪律，不宣称已替换 DSH 正式 persistence API。

### M2：cancel/dispose conformance

建立统一的执行 settlement：`confirmed`、`unknown`、`failed`。覆盖模型流中断、工具执行中止、Workspace commit unknown、HITL 等待、Worker terminate、Session dispose 和 late callback。重复 cancel/dispose 必须幂等；late result 只能被记录为 late/ignored，不能改变已 settlement 的业务结果。测试同时核对“不重放原始 prompt、不伪造工具成功、不保留失效 HITL 卡片”。

### M3：capability publication/preflight

扩展当前静态 preflight，使 capability descriptor 能表达声明、检测、probe、发布、degraded 和 permission grant。只有带 probe 证据且处于 `live` 的子能力进入模型 tool roster；`degraded` 必须拆分后发布，权限拒绝与能力不支持必须区分。测试覆盖模块可加载但 host subprocess 不可用、服务存在但 probe 失败、可选能力缺失、权限撤销和未知 capability。

### M4：Browser-to-Cloud execution handoff

新增 PoC-local handoff coordinator 和 fencing 测试协议。Browser owner 必须在安全点记录当前 Session/Workspace/receipt 状态并进入 draining；云端 owner 取得更高 epoch/fencing token 后才能继续。旧 owner 的 append、renew、tool result 和 receipt acknowledgement 必须被拒绝或标成 late；新 owner 只能从同一 Session hydration，不复制 Worker 内存状态。未完成模型流、工具 Promise 和 HITL 等待必须转成 interrupted/unknown。该 M4 不把现有 Workspace lease handoff E2E 重新命名为完整 Agent handoff。

## 验证矩阵与退出条件

| 交付面 | 单元/协议 | 真实 Chrome | 真实 LLM | 退出条件 |
|---|---|---|---|---|
| M1 | 必须 | 至少一个 Worker history/reconnect fixture | 不需要 | history-before-live、去重、gap 和 identity fail-closed 全通过 |
| M2 | 必须 | 至少一个 Worker terminate/late callback fixture | 不需要 | 三种 settlement 与幂等 cancel/dispose 全通过 |
| M3 | 必须 | 默认 profile preflight 仍可启动 | 不需要 | 只有 live/probed/authorized tool 可发布，degraded 不可整包发布 |
| M4 | 必须 | 至少一个真实 Worker handoff fixture | 不需要 | 旧 fencing token 全部拒绝，新 owner 可从 Session 继续；明确 Workspace-only 与 Agent handoff 差异 |

真实 LLM 仅作为已有普通聊天和工具回归，不作为 handoff、取消或未知结果的唯一证据。Chrome 测试使用临时 profile、动态端口和隔离 `dataDir`；Safari/WebKit、自然 eviction、OS 级崩溃、生产多实例 backend 和真正后台 Agent 明确不在本批通过范围。

## 实施顺序

1. 先写 M1/M2 的纯内存 conformance 模块和测试，固定状态机与事件语义。
2. 扩展 capability descriptor 与 preflight，补齐 publication/permission 负例。
3. 实现 PoC-local handoff coordinator；先验证旧 owner fencing，再接真实 Worker test seam。
4. 用已有 Workspace receipt、HITL、Worker lifecycle 和 lease E2E 作为交叉回归，不重复宣称它们证明完整 handoff。
5. 更新 README、兼容矩阵、progress 和 `change-ledger.md`；运行聚焦测试、Chrome E2E 与文档门禁，最后提交 `research`。

## 设计限制

- 这些 conformance helper 是 `docs/drafts/browser-native-dsh-poc` 的 PoC 适配层，不修改正式 Agent Loop、Session format 或默认 profile。
- `unknown` 是业务语义，不是失败的别名；未知状态必须保留 operationId、callId、owner epoch 和可查询 receipt。
- handoff 只在新 owner 明确取得 fencing 后成立。浏览器页面关闭不自动触发可靠 handoff，也不能由 Worker timer 保证云端继续运行。
- 本批不把单进程 backend 的文件锁、本地 JSON persistence 或 Workspace CAS 外推为生产分布式一致性。
