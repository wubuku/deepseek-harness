---
description: "规划 Browser-Native DSH 的运行中输入、刷新后模型 route 恢复和 Session fork 分支连续性验证。"
---

# Browser-Native DSH Session 连续性验证计划

## Summary

本批验证成熟 Agent UI 在浏览器中最容易丢失语义的三类操作：Agent 忙碌时用户继续输入、Worker 重建后恢复同一 Session 的最近模型 route，以及从精确历史前缀创建可继续的分支。目标是证明这些操作都由 DSH Session event log 和正式 Agent API 驱动；页面投影、内存队列和 URL 参数不能成为第二事实源。

## 候选范围与取舍

| 候选验证点 | 价值 | 决定 | 原因 |
| --- | ---: | --- | --- |
| 运行中追加 next-turn 输入 | P0 | 纳入 | 用户在模型或工具运行时继续输入时，必须 durable、有序且只消费一次。 |
| 取消后的 `keepInbox` 语义 | P0 | 纳入 | Stop 不能静默丢弃用户已提交的后续意图，也不能未经用户同意自动重放副作用。 |
| 刷新后恢复上一次已记录 model route | P0 | 纳入 | DSH-TUI 的 `/model` 语义要求 Session resume 保留历史 route；Browser Worker 不能回退到页面默认值而不被察觉。 |
| 精确前缀 fork 与 branch continuation | P0 | 纳入 | rewind/fork 需要继承边界、open-tail 的 forked 结算、parent lineage 和新 Agent 的模型可见上下文一致；open tool 的 unknown 语义保留为后续缺口。 |
| fork 后 Workspace 自动复制或合并 | P1 | 只记录缺口 | Workspace 是独立事实源，本批不伪造 Session/Workspace 原子 fork；后续应验证显式 workspace snapshot 策略。 |
| fork/rewind 正式页面 UI 与 session tree | P1 | 不纳入 | 先验证 DSH 原生 fork/seed 语义，避免把 UI 投影误当成持久化能力。 |
| 全局持久化 model preference | P1 | 不纳入 | Browser 身份、租户和跨设备偏好尚无正式 owner；本批只验证 Session 最近 route。 |
| 真实模型自主排队、fork 和 route switch | P1 | 不纳入 | 真实 LLM smoke 保持普通文件回归；确定性 barrier 负责精确时序，不把 scripted 选择写成模型能力。 |

## 实施设计

### M0：连续性 probe

在 validation-only profile 中增加一个 Worker probe，使用正式 `ctx.agents.create()`、`ctx.agents.resume()`、`Agent.followup()`、`Agent.cancel({ keepInbox: true })` 和 DSH Session `buildForkSeed`。probe 只持有 Agent handle、route selection 和分支关系；Session event 仍由正式 Agent Loop 写入。

### M1：busy input 与 cancel 保留

用 scripted backend barrier 让第一轮模型请求保持在途，在同一 Agent 上提交第二条 follow-up。验证第二条 user message 先进入 `agent/inbox/spliced`，第一轮结束后只启动一次第二轮；中途 Stop 使用 `keepInbox: true` 时，队列保持可见并可由后续显式 wake 消费，未产生隐式模型请求或工具副作用。

### M2：resume route fidelity

第一阶段用非默认 model route 完成一个 durable turn，释放 Agent 并模拟 Worker 生命周期结束。第二阶段用 `ctx.agents.resume()` 重新挂载同一 Session；setup 从已恢复 Session 的最后 `request/header` 读取 provider/model，再安装 `installModelSelection()`。下一轮请求必须使用历史 route，且不伪造新的 model-selection notice；新 Session 仍使用显式默认 route。

### M3：fork branch continuation

对一个已完成 parent turn 和一个仍在模型请求中的 text open-tail 分别构造精确 fork seed。child 通过 `ctx.agents.create({ seed, inheritedEventCount, meta: { parentSession, isSeeded } })` 发布，验证 parent event log 不变、child header 保留 lineage、继承 cut 不包含 child-owned events、open tail 只产生 forked closer，不为继承的在途 prompt 重发模型请求。open tool 的 `TOOL_OUTCOME_UNKNOWN` 分支不在本批通过项内。child 随后完成独立 follow-up，且其模型输入包含继承历史和 child prompt 各一次。

### M4：真实 LLM 与回归

每次实现修改后运行一次真实 Chrome `gpt-5.6-sol` 普通 `read → write → read` 与刷新 smoke。连续性 E2E 使用 scripted LLM 证明精确时序；不得把真实 smoke 写成真实模型自主排队、route switch 或 fork 证明。

## 验收矩阵

| 场景 | 通过条件 | 禁止结论 |
| --- | --- | --- |
| busy Agent 收到 follow-up | inbox event durable；第一轮后只消费一次；第二轮 prompt 顺序正确 | 页面内临时数组可以替代 Session inbox |
| Stop + `keepInbox` | 活动 turn 以 cancelled/aborted 结算，queued message 保留，显式继续后只请求一次 | 已发生的工具副作用已回滚 |
| Worker resume | 下一 request 使用最后已记录 provider/model；无重复 prompt；新 Session 不继承旧 route | 已建立跨设备或全局偏好同步 |
| closed-turn fork | child 精确继承 prefix，parent 不变，child 新 turn 可继续 | Workspace bytes 已自动复制或两边原子一致 |
| open text-tail fork | 只补 forked closer，不为继承的在途 prompt 发请求；child 可独立继续 | open tool 的未知副作用已被判定为失败或成功 |

## 证据边界

本批只证明当前 Chrome Dedicated Worker、同源 PoC backend 和 DSH Session/Agent API 的连续性语义。Worker 仍不是后台 Agent；Session fork 与 Workspace snapshot 不构成跨存储原子事务。真实 provider 多 Agent、自主 route 选择、自然 eviction、OS crash、生产多实例 backend 和 Safari 仍不在本批结论内。

## 删除条件

当正式 Browser-Native Session UI 提供等价的 durable inbox、resume route 和 fork/branch API，并迁移这些 E2E 与故障证据时，删除 validation-only probe；或者移除 Browser-Native DSH PoC。
