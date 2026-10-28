---
description: "规划 Browser-Native DSH 与独立业务 API 之间的幂等、副作用未知结果和刷新恢复验证。"
---

# 独立业务 API 幂等与未知副作用验证计划

## 决策问题

当前跨存储 ledger 已能在同一 PoC backend 内记录业务 effect，但这仍把“业务副作用”和 DSH ledger 放在同一进程与同一持久化模型中。成熟 SaaS 的真实业务 API 通常是独立服务，DSH 不能依靠 Session、Workspace 或自身 ledger 的写入来证明业务请求是否已经执行。本批验证独立业务服务发生响应丢失、服务重启和不同 backend 重试时，稳定 `operationId`、业务服务自己的幂等记录和状态查询能否避免重复副作用，并明确无法证明 exactly-once 时的 `unknown` 语义。

## 候选范围与取舍

| 验证点 | 价值 | 本批决定 | 取舍 |
| --- | --- | --- | --- |
| 独立业务服务与 DSH ledger 分离 | P0 | 纳入 | 当前 effect 仍由同一 ledger 模拟，证据边界不足。 |
| 业务 API 以 `operationId` 提供幂等键 | P0 | 纳入 | 重试是否重复业务写入的核心前提。 |
| 业务服务在提交后丢响应 | P0 | 纳入 | 最常见的 unknown 窗口，必须查询而不是盲重试。 |
| 业务服务进程重启后查询 | P0 | 纳入 | 证明业务 receipt 不是 backend 内存投影。 |
| DSH backend 在业务提交后崩溃 | P0 | 纳入 | 验证 DSH ledger receipt 缺失时的恢复顺序。 |
| 两个 DSH backend 共享业务服务 | P1 | 纳入 | 不要求共享 DSH JSON `dataDir`；验证 stateless backend 通过同一业务幂等边界重试。 |
| 相同 operationId 不同 payload/租户 | P0 | 纳入负例 | 必须拒绝，不能返回第一次请求的成功冒充第二次请求。 |
| 业务服务未知结果的自动重试 | P0 | 禁止 | 没有服务端查询或幂等保证时不得自动重放。 |
| receipt TTL、GC 和人工对账 | P1 | 只记录设计边界 | 不在本批扩展为生命周期系统。 |
| 真实 LLM 自主触发业务工具 | P1 | 普通 smoke | 故障切点仍由 scripted 流程控制；真实模型不作为精确故障证据。 |

## 设计原则

1. **三份事实分离。** Workspace receipt、DSH operation ledger 和业务服务 receipt 由不同持久化目录维护；任何一个服务的 HTTP 200 都不替代另外两份事实。
2. **稳定身份贯穿重试。** 业务请求使用同一个 `(principalId, operationId, payloadDigest)`；HTTP `requestId` 可以变化，但不能成为幂等键。
3. **未知结果保守结算。** 业务服务响应丢失时，DSH backend 先查询原 operation；查询不到明确 `absent/failed` 时保持 `unknown`，不重新调用业务副作用。
4. **租户与 payload 绑定。** 业务服务同时校验 principal、operationId 和 payload digest；不同租户或不同 payload 重用 operationId 必须返回结构化冲突。
5. **不宣称 exactly-once。** 本批只证明在业务服务提供 durable idempotency record 的条件下，重试不会产生第二个 mock effect；网络分区、服务永久丢失其记录和真实生产事务仍属于 unknown。

## 交付面

### M0：事实和协议冻结

定义业务服务的 intent、effect receipt、query response、`absent/committed/unknown/conflict` 状态和 operation identity；明确 DSH ledger 与业务 receipt 的字段映射。

### M1：独立业务服务

新增 PoC-only 独立 HTTP 服务和 JSON durable store。服务提供 intent/effect/query，使用原子发布、业务副作用计数和 payload digest；故障点覆盖提交前失败、提交后响应丢失和重启加载。

### M2：DSH backend adapter

让同源 DSH backend 的 cross-store business route 调用独立业务服务，再写入自身 ledger receipt。backend 可在业务成功后、ledger receipt 前故障；恢复只查询业务服务并补 receipt，不再次执行 Workspace 或业务 effect。

### M3：真实 Chrome 恢复矩阵

通过真实 Dedicated Worker、OPFS、IndexedDB、Session、Workspace commit 和独立业务服务验证：响应丢失、业务服务重启、DSH backend 重启、两个 backend retry、不同 payload 冲突和租户隔离。取证包括业务 effect count、业务 receipt、Workspace revision、Session seq、ledger decision 和模型请求数。

### M4：真实模型 smoke 与交付

真实 Chrome/LLM 完成普通 Browser-Native 文件/Session smoke；更新 README、进度、兼容矩阵、目录索引和 change ledger。未执行的真实模型故障注入、多实例生产数据库和 exactly-once 必须明确标记。

## 验收矩阵

| 场景 | 必须观察 |
| --- | --- |
| 业务提交前失败 | 无业务 effect；operation 为 failed/absent；同 operation 可按策略重试。 |
| 业务提交后响应丢失 | 业务 effect count 为 1；查询得到 committed receipt；不产生第二次 effect。 |
| 业务服务重启后查询 | receipt 和 effect count 保留；DSH ledger 可补齐，不重新调用业务写入。 |
| DSH backend 在业务提交后退出 | 新 backend 查询业务 receipt，补写自己的 ledger；Workspace/Session 不重复。 |
| 两个 DSH backend 同时重试 | 业务服务只接受一个 payload；第二个请求返回同一 receipt 或明确 replayed。 |
| 同 operationId 不同 payload/principal | 结构化 conflict；业务 effect count、Workspace 和 Session 不改变。 |
| 业务服务不可查询 | DSH 保持 unknown；页面不显示“已完成”，不自动重放未知副作用。 |
| 普通真实 LLM smoke | 同源请求、Session durable、工具执行和 secret redaction 通过；不把它当作故障注入证据。 |

## 非目标与限制

本批不引入生产数据库、消息队列、正式租户系统或根级依赖，不修改正式 Agent Loop 和 Session format。独立业务服务仍是 PoC mock；其 JSON store、锁和 HTTP 语义不能代表 SaaS 生产事务。浏览器 Worker 仍受页面生命周期约束；页面关闭不会让未完成业务 Promise 继续运行。

## Dev Note

最重要的负例是：业务 API 已产生 effect，但 DSH 自身没有收到 response。只有业务服务提供可查询的 durable idempotency record 时，DSH 才能安全把 unknown 变成 committed；否则必须保留 unknown 并交给人工或业务侧对账。
