---
description: "定义并验证父 Session 停止时对子 Agent 的取消传播语义，覆盖 Worker 内 spawn subagent 与真实 LLM 工具执行中断。"
---

# 父 Session 停止的取消传播验证计划

## Summary

本批先定义产品语义，再实现和验证：用户对顶层 Session 执行 Stop 时，必须取消该 Session 拥有的全部活动子 Agent；子 Agent 的 Session 保持可继续，其结算通知记录但不唤醒已停止的父 Agent。目标是消除“Stop 之后子 Agent 继续调用模型或执行工具”的残留运行，并保证 Session 日志能解释取消来源与后续恢复。

## 语义决策

| 问题 | 决定 | 理由 |
| --- | --- | --- |
| 父 Session 停止是否取消子 Agent | 是，递归取消全部活动后代 | Stop 是用户对该 Agent 工作的整体撤回；留下后台子 Agent 会继续产生模型请求与工具副作用，违背最小惊讶原则。 |
| 取消来源如何记录 | 子 Agent 的 `turn/end` reason 为 `aborted`，`reason.kind` 为 `parent` | 与既有 archive stop 传播一致；Session 日志可区分用户直接停止与祖先停止。 |
| 子 Agent 的 Session 是否销毁 | 否，保留为可继续 Session | 用户可能随后恢复会话；销毁会丢失已产生的证据与上下文。 |
| 子 Agent 结算通知如何处理 | 记录到父 Agent inbox，不唤醒 | 已被用户停止的 turn 不应因通知自动开启新 turn；下一次用户输入会先消费该通知。 |
| 定向中断某个子 Agent 是否传播到它的后代 | 否 | 既有行为与 `continuation.spec.ts` 已明确：针对单个 child 的 interrupt 只作用于该 child；本批不改变。 |
| 非用户原因（`disposed`、`error`）是否传播 | 否 | 本批只覆盖可归因于用户 Stop 的 `user` 取消；其它生命周期已有独立处理路径。 |
| 归档 Workspace / `workspace/session-stop` 是否传播 | 保持既有实现 | `archive-admission.ts` 已取消 durable 后代；本批不重复实现。 |

## 实施设计

### M0：运行时归属图

`SubagentManager` 已维护 `resident` Activation 与 `ancestry`（自身与活动祖先 Agent）。新增 `stopDescendants(rootId)`：只处理 `ancestry` 包含被停止 Agent 的活动 Activation；local Activation 调用公开 `Agent.cancel({ kind: 'parent' })`，durable Activation 复用既有 controller abort 与 dispose。

### M1：通知抑制

Activation 增加 `stoppedByAncestor`。`notifySettlement` 遇到该标志时调用 `parent.inject(message)`，只入队不唤醒；普通 settlement 仍按 idle/running 选择 queue/steer。这样 Stop 是终态，但子 Agent 的最终答复不会丢失。

### M2：事件订阅范围

Session 事件通过发起 Agent 的 Cordis fiber 分发，插件 ctx 收不到兄弟 Session 的事件；订阅必须挂在 `ctx.root`。只处理 `header.parentSession === undefined` 的顶层 Session 的 `turn/end`，且 `reason.kind === 'aborted'`、`reason.reason.kind === 'user'`。

### M3：Worker 内 spawn subagent

在 `browser-subagent` validation roster 中挂载 permission probe 并新增 `agent-inbox` test action；E2E 用 scripted barrier 让 parent 与 child 同时停在模型/工具调用，通过公开 `Agent.cancel()` 停止 parent，核对 child 的 `parent` 取消、inbox 通知、无新模型请求，以及下一轮用户输入先回放通知。

### M4：真实 LLM 中断

真实模型冒烟覆盖两条路径：流式文本进行中 Stop，以及 `bash sleep` 工具执行中 Stop。后者必须得到唯一 `turn/end: aborted`、cut 工具的 `isError` 结果、无替代流、下一轮不重放命令。

## 验收矩阵

| 场景 | 通过条件 | 禁止结论 |
| --- | --- | --- |
| 顶层 Session 用户 Stop 且有活动 child | parent `turn/end` = aborted/user；child `turn/end` = aborted/parent；各自只有一个 turn | 页面关闭或 `parked` 等于取消 |
| 停止后 2 秒 | 无新增模型请求；resident Activation 清空；child Session 仍在 | 取消回滚了已发生的工具副作用 |
| 子 Agent 结算 | 通知包含 `Background subagent <childId>`；仅入 inbox，不自动开 turn | 通知等同于用户已读到结果 |
| 下一轮用户输入 | 先回放通知，再处理新 prompt；不重放 cut 工具 | 恢复等于自动重试原请求 |
| 定向 child interrupt | 其后代继续运行（既有断言保持） | 所有取消都无条件递归 |
| 真实 LLM 文本流 Stop | `aborted` 后无替代请求，下一轮完成 | 中途 Stop 等于供应商侧已停止计费 |
| 真实 LLM 工具执行 Stop | cut 调用记录 `Error: tool call aborted`；下一轮不重放 | 工具副作用已回滚 |

## 证据边界

只覆盖 in-worker `spawn` provider 与当前 Chrome Dedicated Worker。外进程/SSH provider、跨标签 Stop、页面关闭后的后台 Agent、Safari/WebKit、OS crash 和生产多实例不在本批结论内。

## 删除条件

当正式 Agent/Subagent 运行时自身提供等价的祖先停止传播与 settlement 抑制语义，并迁移 `stop-propagation.spec.ts` 与两个 E2E 时删除本批新增代码；或者移除 Browser-Native DSH PoC。
