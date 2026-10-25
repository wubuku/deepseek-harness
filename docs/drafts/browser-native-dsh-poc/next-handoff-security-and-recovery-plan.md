---
description: "规划 Browser-Native DSH Session handoff 的凭据隔离、未结算工作拒绝、提交结果不确定和 owner 恢复验证。"
---

# Browser-Native DSH handoff 安全与恢复验证计划

## Summary

本批重新审查 Browser Worker 向另一个执行者交接 Session 写权时的安全和恢复语义。上一批的 backend 测试和 Chrome Worker 测试通过，但复核发现：已持久化的 handoff receipt 包含旧、新 owner bearer token；旧 owner 携带旧 token 和相同 `handoffId` 重放时，服务会再次返回新 token。另一个未覆盖点是 checkpoint 接受未结算的 Workspace operation 和 Agent execution ID，而 PoC 没有让新 owner 恢复这些执行的协议。

DSH-TUI 的可迁移启发是把 Session 连续性、执行 owner、取消结算和能力生命周期分别验证，而不是仅凭 UI 或一次续接成功推断 handoff 正确。本批据此检验交接授权、durable receipt、owner fencing 和 unknown recovery；不把 TUI 的主机进程模型当作 Browser Worker 实现，也不把 PoC Session handoff 说成完整 Cloud Agent 接管。

## 候选范围

| 验证点 | 价值 | 本批决定 | 原因 |
|---|---:|---|---|
| Handoff bearer token 不写入持久化 receipt，旧 owner 重放不能取回新 token | P0 | 纳入 M1 | 当前实现可让已被 fencing 的旧 owner 重新取得写凭据，直接破坏交接安全目标。 |
| handoff 响应丢失后的未知结果与重试 | P0 | 纳入 M2 | 客户端可能不知道服务端是否已提交；重试必须不重复交接，也不能重新泄露新 token。 |
| 原子 rename 后目录同步失败的未知 durability | P0 | 纳入 M2 | 当前 catch 会回滚内存 owner，即使新 handoff 文件可能已发布，造成运行中状态与磁盘状态分叉。 |
| 未结算 operation/execution 的 handoff 语义 | P0 | 纳入 M3 | 新 owner 没有恢复 pending tool、HITL 或 Workspace operation 的通用协议；接受非空列表会暗示未实现的恢复能力。 |
| 并发重复 handoff、不同 handoff ID、旧 owner 对写 API 的竞态 | P1 | 纳入 M4 | 需要证实 per-Session 串行化和 fencing 对并发与所有相关写入口仍成立。 |
| Session bearer token 的账户、租户和 origin 授权 | P0 产品风险 | 记录限制，不实现 | 当前 backend 是无账户认证的同源 PoC；正式授权模型需要身份、租户和部署拓扑决策。 |
| 多实例 backend、共享存储锁与跨节点 fencing | P0 产品风险 | 后续独立批次 | 当前 backend 明确是单实例 PoC；本批不能用同进程测试冒充分布式协调。 |
| 新 owner 同时取得 Workspace lease、对象存储访问权并启动真实 Cloud Host | P0 产品能力 | 不纳入 | 当前仓库没有 Cloud Agent runner 或跨域凭据委派；Session token handoff 不等于完整执行迁移。 |
| 浏览器冻结、断网与自然 Worker 终止时的自动安全交接 | P1 | 不纳入 | 浏览器生命周期无法保证运行清理回调；应在安全交接协议稳定后单独验证显式接管。 |
| Session 大事件、附件和 Workspace blob 的远端引用恢复 | P1 | 不纳入 | 这是数据传输和存储引用协议，不应与 owner 授权修复混成一个批次。 |
| 运行时 capability 撤销和活动工具调用中止 | P1 | 保留候选 | capability preflight 已验证发布，不代表运行中撤销；和本批 owner handoff 的主要缺陷无直接依赖。 |

## 目标与非目标

目标是让 PoC 的 Session handoff 在凭据保密、重复请求、已知失败和未知提交结果下 fail closed；仅允许没有待处理 operation/execution 的 checkpoint；通过真实 Chrome Dedicated Worker 和同源 backend 验证浏览器侧可观察结果。Session event log 仍是唯一对话事实源。

本批不增加正式 DSH package、Session format、默认 profile 或根依赖，不实现账号认证、多租户、Cloud Agent Loop、Workspace lease 的跨执行者转移或生产级 HA。除真实 LLM 普通聊天回归外，handoff 协议使用确定性故障注入；不得把 scripted LLM 描述为真实模型验收。

## 选定交付面

### M0：核实现状与测试基线

确认 handoff receipt 持久化字段、重放响应、checkpoint 允许的 pending ID、per-Session queue、Session flush 的 `write → file sync → rename → directory sync` 顺序。复跑现有 backend contract tests 和 Chrome Worker handoff；记录这些测试目前通过但未覆盖凭据回放与 post-rename unknown 的事实。

### M1：凭据隔离与旧 receipt 兼容

持久化 receipt 只保留 Session ID、handoff ID、checkpoint、epoch、durability receipt 和用于旧 owner 请求核验的单向 token digest，不保留 bearer token。新 handoff 的新 owner token 只在首次成功响应中返回；旧 owner 重放得到明确的“已提交但凭据不可重放”结果，不返回 owner 凭据。已存在的 PoC JSON receipt 必须在 backend 提供服务前去除旧、新 token，并同步迁移后的文件；迁移失败则 backend 启动失败。

### M2：handoff 提交与 unknown durability

将 flush 失败区分为 rename 前的确定未发布和 rename 后的提交结果不确定。前者可以恢复旧 owner；后者不能回滚内存 fencing，必须阻止该 Session 的新写入和 owner claim，直到 backend 重启后从实际持久化记录恢复。增加“已提交但 HTTP 响应丢失”的故障注入，覆盖客户端重试不产生第二次交接、也不重新取回新 owner token。

### M3：安全点与 pending work

handoff checkpoint 中的 `pendingOperationIds` 和 `pendingExecutionIds` 必须为空。非空时在任何 owner epoch、receipt 或 Session file 变化之前拒绝，要求调用方先完成、取消或明确 settle 未完成工作。该策略不声称能够迁移模型流、tool Promise、HITL Promise 或 Workspace outbox。

### M4：fencing、并发与真实 Worker 验收

验证同一 handoff ID 的并发重试、不同 handoff ID 的冲突、旧 token 对 append/LLM/flush/close 的请求、lease 到期后的新 owner claim、backend 重启后的恢复，以及一次真实 Chrome Worker 中的响应丢失。响应丢失后的首次调用可能返回传输错误，也可能被浏览器透明重试并返回无凭据回执；显式重试必须保持同一结果。核对 Session event count、owner epoch、持久化 JSON 和写权限，不把传输层结果等同于服务端提交状态。

### M5：文档和回归

更新 PoC README、handoff 计划/进度、兼容矩阵、目录导读和 `change-ledger.md`。运行 backend/adapter tests、聚焦 Chrome E2E、preview build、typecheck 与适用的文档门禁；检查是否仍有文字宣称 M4 是安全的 Browser-to-Cloud Agent handoff。

## 验收矩阵

| 场景 | 预期结果 |
|---|---|
| 首次 handoff 成功 | epoch 单调增加；新 token 仅出现在初次 HTTP 响应，不出现在 Session 文件或持久化 receipt。 |
| 旧 token、相同 handoff ID 重放 | 明确报告已提交；响应不包含 owner token；不会恢复旧 owner 或重复增加 epoch。 |
| 相同 handoff ID、不同 checkpoint | `HANDOFF_CONFLICT`；owner 和已提交 checkpoint 不变。 |
| 非空 pending operation/execution | 在状态变更前拒绝；原 owner 仍有效，Session 和 receipt 不变。 |
| rename 前 flush 失败 | handoff 未发布，旧 owner 可继续；无 receipt 泄漏。 |
| rename 后目录同步失败 | 结果标为 unknown；当前 backend 对该 Session 的写入/claim fail closed；重启从实际文件状态恢复且旧 token 无效。 |
| durable commit 后响应丢失 | 首次 Worker 调用可能得到传输错误，或因浏览器透明重试直接得到无凭据回执；显式重试得到已提交回执但不含新 token；等待租约到期或 backend restart 后由新 claimant 获取更高 epoch。 |
| 两个并发 handoff | 最多一个 checkpoint 成功提交；另一个得到冲突或旧 owner 拒绝；不产生双 owner。 |
| 旧 owner 写入口 | append、LLM、flush 和 close 均不得接受 handoff 前的 token/epoch。 |
| 旧版 receipt 迁移 | 迁移后文件不含旧、新 token；迁移失败时服务不开始监听。 |

## 执行与证据纪律

先完成 M0 并保留当前通过但覆盖不足的基线，再依次实施 M1–M4。协议故障使用 Node fault injection；至少一个关键 unknown-response 流程必须经真实 Chrome Dedicated Worker 调用同源 backend。Safari/WebKit 暂停。真实 LLM 只作为普通 DSH 对话回归，不作为故障协议证据。所有命令、版本、结果、失败观察、截图或脱敏响应写入进度文档。

## 关键限制

Browser-Native DSH Worker 仍依赖页面生命周期。此 handoff 仅转移 PoC Session 写权；新 owner 不会自动获得 Workspace writer lease、凭据、插件 Host、进行中的模型流或实际 Cloud Agent。无账户认证的 PoC bearer token 不是 SaaS 授权方案；生产部署还需租户授权、token 绑定与撤销、跨实例 fencing、共享持久化和审计。
