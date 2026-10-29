---
description: "规划 Browser-Native DSH 多 Session 挂载、视图切换、事件回放、页面生命周期和 owner 状态的联合验证。"
---

# Browser-Native DSH Session 挂载与恢复验证计划

## Summary

本批验证一个浏览器页面是否可以同时管理多个 DSH Session 的投影，并在切换当前视图时保持其他 Session 的运行状态、事实来源和写权边界。目标不是增加第二个 Agent Loop，也不是把页面关闭后的 Dedicated Worker 描述成后台 Agent。

本批将把已有的 `BrowserNativeSessionCursor` 扩展为 PoC-local mount coordinator。它只协调页面投影、Session owner 状态和执行结果的可见生命周期；DSH Session event log 仍是唯一事实来源，真实 Agent Loop 仍由 Worker 内的 DSH Host 执行。

## 候选范围

| 验证点 | 价值 | 决定 | 主要风险 |
| --- | ---: | --- | --- |
| 一个页面挂载多个 Session，切换 active/parked 视图 | P0 | 纳入 | 切换视图误停正在运行的 turn，或把两个 Session 的事件混入同一投影 |
| history-before-live、重连回放和重复事件去重 | P0 | 纳入 | 断线后重复消息、跳号或同序篡改被静默接受 |
| owner 状态 `occupied`、`busy`、`unavailable` | P0 | 纳入 | 页面把不可写、活动执行和暂时不可用混成可重试的普通错误 |
| 页面关闭、Worker terminate 和晚到结果 | P0 | 纳入 | 未知副作用被显示为成功，或旧 Promise 在新挂载中继续写入 |
| 同一 Session 的读观察者与唯一写 owner | P1 | 通过已有 backend/observer 交叉验证 | 只读观察者误取得写权 |
| active/parked Session 的真实 DSH 工具执行 | P1 | 以已有真实 LLM smoke 为回归，不扩展模型故事 | 为了测试视图切换而创建第二套模型循环 |
| 跨标签页 mount ledger、Web Locks 和多 principal | P1 | 保留为下一批 | 现有恢复锁和 principal 隔离已有独立证据，合并会模糊结论 |
| BFCache、冻结、自然 eviction、OS 崩溃 | P1 | 只记录边界 | Playwright 的故障注入不等于浏览器自发故障 |
| 云端 executor handoff | P0 架构边界 | 不在本批扩展 | Session mount 不等于 Browser-to-Cloud handoff |

## 交付面

### M0：定义挂载状态

新增 PoC-local `BrowserNativeSessionMountCoordinator`，为每个 Session 保存投影游标、当前 owner、可用性、active/parked 状态和执行状态。`activate` 只改变页面投影，不取消 parked Session 的 `running` 或 `waiting` execution；新 prompt 只能从 active Session 发起。

### M1：事件和恢复纪律

每个 mount 使用独立的 `BrowserNativeSessionCursor`。history 未完成时拒绝 live event；相同序号和相同内容只计为 duplicate；跳号、同序不同内容、身份改变和 history cursor 不一致都 fail closed。reconnect 使用新的 Worker identity 重新 hydrate，不复制旧 Worker 内存事件或 Promise。

### M2：owner 状态和页面生命周期

`occupied`、`busy` 和 `unavailable` 是不同的不可用原因。页面关闭或显式 Worker dispose 时，所有 `running`/`waiting` execution 转为 `unknown`，释放本地 mount；晚到 provider 结果只能被计数为 late，不能重新确认结果或写入新 owner 的投影。

### M3：真实 Dedicated Worker 验收

通过 URL-gated Worker test port 在真实 Chrome Dedicated Worker 中执行完整 probe：挂载三个 Session、切换 active/parked、保持一个 parked turn running、回放和去重、模拟占用/忙碌/不可用、reconnect 新 identity，以及 terminate 后 unknown settlement。该 probe 不伪造真实 DSH tool result，也不宣称已完成多 Session 产品 UI。

### M4：回归、真实 LLM smoke 与文档

复跑已有 Session adapter、execution lifecycle、owner handoff、observer 和权限回归，并执行一次真实 LLM Chrome smoke，确认 mount coordinator 不改变普通文件工具、Session durability、刷新恢复和同源凭据边界。更新 PoC README、兼容矩阵、`docs/drafts/README.md`、本批进度和 `change-ledger.md`。

## 验收矩阵

| 场景 | 预期结果 |
| --- | --- |
| A active，B/C parked，A execution running，切换到 B | A 保持 `parked/running`，B 成为 active，事件分别进入各自 cursor |
| live event 在 history hydrate 前到达 | 拒绝，不改变投影 |
| 重连 replay 已有事件 | duplicate，不增加可见事件 |
| 同一序号携带不同事件或出现 seq gap | fail closed，mount 进入 `unavailable` |
| 目标 Session 为 `occupied` | 不激活、不取得写权 |
| 目标 Session 为 `busy` 且没有当前 owner | 不激活为可写执行者，提示需恢复/接管 |
| 目标 Session 为 `unavailable` | 不自动重试为 active，保留失败原因 |
| 页面关闭时有 running/waiting execution | 统一转 `unknown`，不报告 confirmed |
| unknown execution 的晚到结果 | 被忽略并计数，不改变 outcome |
| reconnect 使用新 Worker identity | 重新 hydrate；旧 identity frame 被拒绝 |

## 证据边界

纯 Vitest 证明 coordinator 状态和事件规则；真实 Chrome 证明这些规则确实在 Dedicated Worker bundle 中执行。两者都不证明浏览器会可靠地通知页面关闭，也不证明云端可接管页面关闭后的 Agent。真实 LLM smoke 只证明既有 DSH loop 回归，不证明模型自主选择 Session 或实现多 Session UI。

## 实施顺序

1. 先实现 coordinator 和纯内存测试。
2. 接入 Worker test action 和 Preview URL allowlist，运行真实 Chrome probe。
3. 对照已有 observer、handoff、recovery 和 real LLM smoke，修正状态边界而不扩大声明。
4. 更新文档和账本，运行定向测试、Preview build、typecheck、文档门禁，再提交并推送 `research`。

## 不在本批完成的事项

本批不实现生产级多 Session UI、不修改 DSH Session format、不创建后台 Agent、不实现多实例 backend、不验证自然 storage eviction/OS 崩溃，也不把 `parked` 视图称为云端继续执行。
