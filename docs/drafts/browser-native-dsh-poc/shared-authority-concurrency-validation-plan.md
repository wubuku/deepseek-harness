---
description: "规划 Browser-Native DSH 多 backend 共享 authority 的并发写权、业务幂等、主体隔离和失联恢复验证。"
---

# Browser-Native DSH 共享 authority 并发与恢复验证计划

## Summary

本批验证两个同源 backend 同时接收同一 Session、Workspace 和业务 operation 请求时，共享 authority 是否仍能裁决唯一写者、唯一 revision 和可查询副作用。目标是排除“单 backend 顺序路由通过，但并发或 authority 暂停时发生双写、跨主体读取或误报成功”的风险；authority 仍使用 PoC JSON store，不视为生产 HA。

## Table of Contents

- [候选评估](#候选评估)
- [选定验证](#选定验证)
- [验收标准](#验收标准)
- [非目标和限制](#非目标和限制)

-----

## 候选评估

DSH-TUI 的可迁移纪律是：同一执行链只有一个 active writer，Session event 是事实源，跨边界操作必须有稳定身份，unknown 不得解释成失败后盲目重做。本批据此比较尚未有多 backend 证据的风险点。

| 候选验证点 | 失败后果 | 本批决定 |
|---|---|---|
| Session 同 ID 并发创建、write claim 和相同 seq append | 两个 backend 可能授予双写权或接受分叉事件 | 纳入，M1 |
| Workspace 并发 claim、同 operation replay 和不同 operation 的 CAS 竞争 | 双 writer、重复 revision 或错误覆盖文件 | 纳入，M1 |
| 独立业务 API 的同 operation 并发与 response loss 经不同 backend 恢复 | 真实 SaaS 副作用可能重复，或 DSH ledger 与业务 receipt 分叉 | 纳入，M2 |
| 不同 principal 通过不同 backend 访问相同 Session/Workspace/operation | authority 路由可能破坏资源归属检查 | 纳入，M1/M2 |
| authority 暂停、处理后丢响应、重启和恢复查询 | backend 可能把 unavailable 当作未执行或回退到本地空 store | 纳入，M3 |
| 真实 Chrome 双页面经 round-robin 同时竞争 Session/Workspace 写权 | HTTP 单测无法覆盖页面 cookie、Worker、IndexedDB 和本地锁交互 | 纳入，M2/M3 |
| LLM 授权后 owner 过期/被接管时的长流终止与旧输出 | 旧执行者可能继续消耗模型或尝试迟到写入 | 单独立项；本批只检查静态 owner 授权和新请求 fencing |
| backend 版本滚动升级、旧/新协议混跑 | 不兼容节点可能产生不一致数据或错误回退 | 单独立项；需要两个真实构建版本和迁移策略 |
| blob GC 与上传/下载并发、对象 store 多副本 | 活跃文件块可能被回收或下载损坏 | 单独立项；需要对象 store 生命周期和锁策略 |
| 真实模型自主调用工具、生成大型参数和处理并发冲突 | 模型选择和指令遵循不确定 | 只做真实 LLM 冒烟；不作为协议竞态的确定性证明 |
| PostgreSQL/分布式锁/跨主机网络分区与区域故障 | 关系到正式部署与灾备 | 不伪造生产环境；本 PoC 不具备可验证的生产后端 |

## 选定验证

### M1：共享 authority 的并发 Session、Workspace 与主体隔离合同

在 Node 合同测试中启动两个独立 backend 和一个 authority，使用 authority 签发的相同或不同 principal cookie，从两个 backend 同时发出请求。覆盖同一 Session ID 并发 create、双 write claim、相同 `expectedNextSeq` 的 append、同一 Workspace 双 lease claim、同 operationId/相同 payload commit、同 operationId/不同 payload 冲突，以及不同 operationId 竞争同一 `baseRevision`。每项检查双方 HTTP 状态、最终 event seq、owner epoch/fencing token、manifest revision、内容 hash 和 receipt 数量。

### M2：外部业务 effect 跨 backend 去重

共享 authority 配置独立 PoC business service。两个 backend 同时接收同一 operation intent/effect；重复请求必须返回同一个 durable business receipt，effect count 为 1。丢弃 business response 或 DSH ledger receipt 后，从另一个 backend 查询并完成对账；同 operationId 的 payload 或 principal 不同必须冲突。Authority 重启后重复查询仍返回同一 receipt。

### M3：真实 Chrome 双页面与 authority unavailable/recovery

使用真实 Dedicated Worker 完成一次 DSH 文件写入，再让同一 Chrome BrowserContext 的两个页面经 round-robin proxy 同时调用 Session/Workspace claim API。最多一个 claim 成功；不同 BrowserContext 的 principal 不能读取原 Session/Workspace。停止 authority HTTP 服务时，两个 backend 的 Session、Workspace 和 LLM 授权请求必须 fail closed，且本地 store 不得出现共享记录；使用同一 `dataDir` 重建 authority 后，刷新 Worker 必须读回本地文件和远端 blob，并在原 Session 续聊且不重复原 prompt 或 commit。

这项 Chrome 验证不运行两个并行 Agent Loop，也不强杀 authority OS 进程；浏览器双页只证明 API claim、cookie、round-robin 和真实 Worker 恢复路径。协议并发由 Node 合同测试覆盖，真实进程崩溃和多 Agent 协作另行验证。

### M4：真实模型 smoke 和文档交付

使用现有真实 Chrome 多 backend 入口和本机 backend-only LLM 配置复跑多轮对话、刷新和服务实例重建。只在真实模型实际产生 `tool/call` 并完成读写时记录真实工具闭环；否则只记录模型流、Session 和 authority 恢复 smoke。同步 README、兼容矩阵、drafts 索引、变更账本和实际进度。

## 验收标准

1. 两个 backend 的并发请求均由同一 authority 处理；每个 Session 和 Workspace 竞争最终只有一个合法写者/版本推进者。
2. 同 operationId 且身份与 payload 相同的重试返回原结果；身份或 payload 不同的重放 fail closed。
3. authority 已提交但响应丢失时，通过原 operationId 查询恢复；模型 prompt、Session event、Workspace revision 和业务 effect 均不重复。
4. authority 不可达时 backend 不读取本地副本冒充权威状态；重建 authority 实例后可从同一 `dataDir` 恢复。
5. Chrome 双页面无未捕获页面错误、无跨源请求，Session、Workspace、receipt 和模型请求计数可核对；结论不得外推为两个并行 Agent Loop。
6. 真实 LLM 结果独立标注；模型未调用工具不得写成真实文件闭环通过。

## 非目标和限制

本批不实现 PostgreSQL adapter、跨主机锁、跨区域复制、生产认证、Cloud Durable Worker、exactly-once 或灾备 SLA，也不验证多 Agent Loop 协作或 authority OS 进程强杀。单进程 authority 即使在双 backend/Chrome 故障测试中通过，也只证明当前 PoC 请求委托和同机 durable store 重载行为。浏览器 Worker 仍受页面生命周期约束。

## Dev Note

测试脚本与数据均属于 `docs/drafts/browser-native-dsh-poc/`；本批不修改正式 DSH package、Session format、Agent Loop、根依赖或已有其他 PoC 的运行行为。
