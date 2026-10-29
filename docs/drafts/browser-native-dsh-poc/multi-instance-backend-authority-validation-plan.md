---
description: "规划 Browser-Native DSH 多 backend 共享权威、路由切换和未知结果恢复验证。"
---

# Browser-Native DSH 多 backend 共享权威验证计划

## Summary

DSH-TUI 的会话挂载规则要求执行权、观察权和终态由会话事实源裁决，而不是由某个界面进程的内存决定。当前 Browser-Native PoC 已经让单个 backend 在 `dataDir` 上 fail closed，但这不是横向扩展方案。本批使用一个独立的 PoC 共享状态服务和两个同源 backend 实例，验证 Session、Workspace、操作账本和 LLM 请求在路由切换后仍使用同一事实源。

共享状态服务使用现有 PoC 的 JSON durability store，不冒充 PostgreSQL、对象存储、跨主机锁或生产 HA。它的价值是把“backend 实例必须无状态地委托哪些状态”变成可执行证据，并暴露只在单进程测试中看不到的 owner、revision、receipt 和 response-loss 错误。

## 候选范围与取舍

| 候选验证点 | 价值 | 本批决定 |
|---|---|---|
| 两个 backend 共享 Session/Workspace/ledger 权威 | 现有单进程锁无法证明横向扩展安全 | 纳入，P0 |
| 同源 round-robin 路由下的 Worker/DSH 闭环 | 证明请求不依赖 sticky session | 纳入，P0 |
| backend 实例重启、路由切换和旧 owner fencing | 直接对应 DSH-TUI 的执行者生命周期 | 纳入，P0 |
| state authority response loss、幂等和查询恢复 | 验证未知结果不会重复 prompt、commit 或业务 effect | 纳入，P0 |
| authority 进程重启后的 Session/Workspace 恢复 | 检查共享事实源的 durable reload | 纳入，P0 |
| 生产数据库事务、跨主机网络分区和多区域故障 | 当前 PoC 没有生产存储或部署环境 | 不纳入，保留限制 |
| Cloud Durable Worker 迁移活动模型流和插件内存 | 需要新的服务端执行模型，不是 backend 路由验证 | 不纳入，单独立项 |
| 多租户登录、正式授权和密钥托管 | 当前 principal 是 PoC cookie | 不纳入，保留限制 |
| Safari/WebKit、自然 eviction、OS 级崩溃 | 本轮继续只验 Chrome；故障注入不能冒充自然事件 | 不纳入 |

## 选定交付面

### M1：共享状态 authority seam

新增仅供 PoC backend 实例使用的状态转发路径。Session、Workspace、cross-store operation 和业务 receipt 请求必须由共享 authority 处理；转发保留同源 Cookie、HTTP 状态、`Set-Cookie`、流式 blob 响应和结构化错误。LLM 请求仍由接收请求的 backend 实例处理，但其 owner 校验必须回到 authority，不能使用本地空 Session store。

共享 authority 使用明确的内部请求标记，浏览器不能通过该标记绕过外部 backend。它不返回模型凭据、owner bearer 或内部 dataDir 路径。

### M2：两个 backend 的确定性路由验证

新增 round-robin HTTP proxy 和真实 Chrome E2E。单个页面的 Session create/open/read/append、Workspace upload/commit/read、refresh hydrate 和 LLM 请求必须跨越两个 backend 实例；Session seq、Workspace revision、fencing token、receipt 和模型请求计数保持唯一且连续。测试同时保留请求实际命中的 backend 标签。

### M3：重启与未知结果矩阵

在真实 Chrome/Worker 中覆盖：一个 backend 实例在请求间重启、共享 authority 重启并重新加载 durable state、authority 接收 Session append 或 Workspace commit 后丢弃响应、旧 owner 在路由切换后继续写入。每个未知结果必须通过原 operation/seq 查询解决，或保持 `unknown`；不得自动重放模型 prompt、Workspace 副作用或外部业务 effect。

### M4：真实 LLM 多实例冒烟

使用同源 backend 代理和本机 `docs/drafts/.env` 的真实模型尝试最小 `write → read → refresh → read` 闭环。只有模型实际产生工具调用时才将文件闭环计为通过；模型未产生工具调用时，仅记录模型流、Session 恢复和多实例路由 smoke，不把模型行为当作竞态或故障证据。模型密钥只能由 backend 读取。

### M5：文档、限制和交付

更新 README、兼容矩阵、`docs/drafts/README.md` 和 `change-ledger.md`，记录命令、Chrome/Node 版本、路由命中、Session/Workspace/ledger 计数和失败样本。明确 PoC authority 仍是单进程 JSON service；没有生产数据库、跨主机 fencing、HA、RPO/RTO 或 exactly-once 保证。

## 不变的语义

- DSH Session event log 仍是对话、工具调用和模型可见上下文的唯一事实源。
- Workspace revision/CAS、writer fencing、operationId 幂等和业务服务 durable receipt 不合并成跨存储事务。
- Worker 关闭、页面刷新和 backend 路由切换不等于后台 Agent；活动 JS、模型流和插件内存不会迁移。
- 未知响应不代表失败；没有可查询的 durable 结果时必须保留 `unknown` 并阻止盲目重试。

## 退出条件

1. 两个 backend 实例在同一 authority 上可由 round-robin proxy 服务同一个真实 Chrome 页面。
2. authority 重启后，Session event、Workspace manifest、operation receipt 和 principal 隔离均可恢复。
3. 旧 owner、旧 fencing token 和重复 operation 在任一 backend 上均被拒绝或返回原始结果，不产生第二次副作用。
4. response loss 后没有重复 Session prompt、Workspace revision、ledger receipt 或外部业务 effect。
5. 真实 LLM smoke、focused tests、preview build、文档门禁和 pre-push typecheck 均通过；若真实模型未产生工具调用，必须把文件闭环标为未验证并明确记录。

## 非目标

本批不实现生产共享数据库适配器、不宣称跨主机锁安全、不迁移 DSH Agent Loop 到云端、不验证 Cloud Durable Worker、不改变正式 packages 或 Session format，也不运行 Safari/WebKit。

## 参考

- [DSH-TUI 参考架构备忘](../dsh-tui-reference-architecture-memo.md)
- [执行写权交接验证](execution-owner-handoff-validation-plan.md)
- [跨存储业务副作用对账](external-business-idempotency-validation-plan.md)
- [Browser-Native PoC](README.md)
