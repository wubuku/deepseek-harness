---
description: "规划 Browser-Native DSH Session projection 的基线、按 Session 过滤、reseed、卸载和写权观察者联合验证。"
---

# Browser-Native DSH Session Projection 与写权观察验证计划

## Summary

本批把 dsh-TUI 的两个可迁移原则落到 Browser-Native DSH：页面展示读取与 Session 写权判定分离；切换 Session 时先读取新 Session 的基线，再接受该 Session 的 live projection，不能让后台 Session 的更新覆盖当前页面。浏览器没有 TUI 的 PID 账本，因此写权仍由同源 Session authority、Web Locks 和 Worker owner fencing 提供，不能用页面内存 projection 代替授权。

本批不实现正式多 Session UI，不新增 Agent Loop，也不把 Browser Worker 变成页面关闭后继续运行的后台 Agent。

## 候选范围与取舍

| 验证点 | 价值 | 决定 | 主要风险 |
| --- | ---: | --- | --- |
| projection store 的 Session 过滤与 baseline seed | P0 | 纳入 | 后台 Session 的状态污染当前视图，或切换后等待下一条 live 事件才显示内容 |
| projection reseed、provider 重挂载和 detach | P0 | 纳入 | 服务重建、历史恢复或 projection 定义变化后页面保留旧值 |
| mount view 与 projection 的联合状态 | P0 | 纳入 | `parked` 仍能执行，但其投影错误地成为 active；dispose 后晚到更新复活旧 UI |
| 双页面唯一写 owner 与只读 observer | P0 | 通过真实 authority 回归 | 展示读取被误当作写权，或 claim 失败被降级成“无人占用” |
| 同一页面多个真实 DSH Agent Loop | P1 | 只做能力边界探针 | 当前 Worker Host 入口是单 Host；不要用合成 coordinator 宣称多 Agent 已实现 |
| 多标签页、本地 Web Locks、Session owner 和 Workspace lease 联合准入 | P1 | 复用既有证据并补交叉矩阵 | 重复既有 first-claim、tab-recovery 和 shared-authority 测试，无法增加结论 |
| projection 的分页/虚拟化和长 Session 性能 | P1 | 延后 | 当前 store 只管理当前投影值，长日志由既有 Session hydrate 证据覆盖 |
| 云端 handoff、跨设备 projection 和自然 eviction | P0 架构边界 | 不在本批扩展 | projection continuity 不等于 Durable Worker 或云端接管 |

## 设计

### 1. Projection store

新增 PoC-local `BrowserNativeSessionProjectionStore<T>`。它保存当前绑定的 `sessionId`、经 `narrow` 验证的值和 source snapshot；`bind()` 先清除旧 Session 的值，再读取新 Session 的 baseline；`update()` 只接受当前绑定 Session，重复引用不触发通知；`reseed()` 重新读取 authority snapshot，允许 projection 被删除后清空；source detach 会清除可见值但保留绑定意图，后续 reattach 必须重新 seed。

### 2. Mount 联合纪律

现有 `BrowserNativeSessionMountCoordinator` 继续负责 active/parked、owner、execution、cursor 和 unknown settlement。Projection store 只负责页面 read model；它不能授予 owner、确认 tool result 或改变 Session event log。页面切换的验收必须同时观察 mount view 和 projection session id，证明两者不会串线。

### 3. Authority 与 observer

真实双页面验证使用已有同源 Session API：一个页面取得 write owner，另一个页面只读同一 Session；并行 write claim 必须得到一个成功和一个明确 `SESSION_ALREADY_OWNED`，observer 仍可读取最新 event cursor 但 append 被 `SESSION_OWNERSHIP_LOST` 拒绝。该测试不新增另一套浏览器 mount ledger；服务端 owner epoch 仍是写权权威。

### 4. Worker probe

通过 URL-gated `session-projection` test action 在真实 Chrome Dedicated Worker 中执行 source attach、A/B bind、跨 Session live update、duplicate update、reseed、detach 和 mount dispose。probe 输出只包含计数、Session id 和值摘要，不输出凭据、完整 prompt 或工具参数。

## 验收矩阵

| 场景 | 预期结果 |
| --- | --- |
| bind A，source 有 A baseline | 立即显示 A baseline，不等待下一条 live event |
| 当前绑定 A，收到 B update | 丢弃，不通知、不改变 A |
| A 收到相同 raw 引用两次 | 只通知一次 |
| 从 A 切换 B | 先清空 A，再 seed B；A 的晚到 update 不能复活 A |
| B snapshot 被删除后 reseed | 当前值变为 undefined，并通知一次 |
| source detach | 当前值清空；重新 attach 后按 source snapshot 重新 seed |
| Session observer 读取最新事件 | 成功，但不获得 append 权 |
| 两个页面同时 claim 同一 Session | 一个 200 owner，一个 409 `SESSION_ALREADY_OWNED`；无额外模型请求、Session event 或 Workspace commit |
| mount dispose 后晚到 projection update | 不进入新 mount；未结算 execution 仍是 unknown |

## 证据边界

Vitest 证明 projection store 的状态规则；真实 Chrome Worker 证明 source 在 Worker bundle 中执行；双页面 authority E2E 证明同源服务的 observer/owner 分离。三者都不证明正式多 Session UI、同一 Worker 内多个真实 Agent Loop、页面关闭后的后台 Agent、跨设备授权、生产 HA 或云端 executor handoff。

## 实施顺序

1. 先实现 projection store、纯内存 conformance 和 Worker probe。
2. 将 projection probe 与已有 mount probe 的 active/parked/dispose 规则放入同一次真实 Chrome 验收。
3. 运行双页面 Session observer/owner authority 回归，并复跑真实 LLM 普通文件 smoke。
4. 更新 README、兼容矩阵、目录索引、进度和 change ledger，运行构建与文档门禁后提交推送 `research`。

## 非目标

本批不把页面 projection 当作 Session 事实源，不复制 DSH Agent Loop，不实现 TUI 的本机 PID 文件账本，不把只读 observer 写成 writer，不实现云端 handoff 或页面关闭后的执行延续。
