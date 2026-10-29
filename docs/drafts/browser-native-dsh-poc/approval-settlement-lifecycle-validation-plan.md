---
description: "规划 Browser-Native DSH 审批授权、并发队列、取消和迟到决定的真实 Worker 验证。"
---

# Browser-Native DSH 审批结算生命周期验证计划

## Summary

本批验证 Worker 中真实 DSH ApprovalService、远程 UI answerer、Session 审计和工具副作用是否对同一审批请求给出唯一且可恢复的结算。重点是 Allow once、同一模型响应中多个审批调用的串行 FIFO、Worker 测试通道触发的 Agent 取消，以及 `tool/result` 后迟到的 `approval/decided` 不得被投影成有效决定；刷新恢复作为既有回归，不恢复原 Promise 或重复执行工具。

## 候选范围与取舍

| 验证点 | 价值 | 本批选择 | 证据目标 |
| --- | ---: | --- | --- |
| 有效 `allowed-once` 的授权、Session audit 与副作用 | P0 | 纳入 | 正式 UI 回答后，原 call 恰好执行一次，`approval/decided` 与 `tool/result` 身份一致。 |
| 同一模型响应中的多个审批保护工具调用 | P0 | 纳入，但按正式调度器实测 | 核对 bash 的 exclusive scheduling 是否使审批逐个产生；逐项允许/拒绝并验证 request/call 不交叉。 |
| 两个同时 pending 的 approval queue FIFO | P1 | 不用 bash 场景冒充；PoC projection 已有 FIFO probe | 当前 profile 中 `bash` 是 exclusive tool；若没有可同时审批的 concurrency-safe 工具，真实 UI 不会自然形成两个待处理审批。 |
| 取消活动审批 | P0 | 纳入；由专用 Worker test MessagePort 调用公开 `Agent.cancel()` | DSH 将请求记为 `cancelled`，不产生受保护文件，turn 结束后可继续新 turn；不以此宣称用户界面提供 Stop 控件。 |
| Tool 已结算后的迟到 approval decision | P0 | 纳入修复与回归 | Projection 产生 `DECISION_CALL_SETTLED`，不把迟到决定纳入 durable decision 投影。 |
| 刷新/Worker detach 时审批待处理 | P0 | 回归 | 只得到 `TOOL_OUTCOME_UNKNOWN`/interrupted，不重新发 prompt、LLM 请求或副作用。 |
| 没有 UI answerer 时的 `unavailable` | P0 | 本批不伪造；沿用 ApprovalService 单测，另列后续 | 需要一个不装载 `ui-approval` 的真实 Browser client composition，当前 preview 没有已验证的此类开关。 |
| 同 callId 重复与两个 Session 的 owner 隔离 | P1 | 延后 | 需要同时操纵两条真实 Agent/Session scope，不能仅凭无 agentId 的 approval audit 事件推断 owner。 |
| 自然页面冻结、浏览器进程强杀和 OS crash | P1 | 延后 | 需真实浏览器/操作系统生命周期故障，不由 scripted approval 路由替代。 |
| 真实 LLM 自主触发审批 | P2 | 不作通过条件 | 真实模型选择有方差；模型用于独立的多轮记忆与 todo tool smoke，审批时序由确定性 tool calls 控制。 |

## 设计约束

- DSH ApprovalService 是决定、权限与 Session audit 的唯一权威；UI answerer 只返回一次性 outcome。
- 每个 request 以 `approval/asked.id` 对齐 `approval/decided.id`，再以 `callId` 对齐原 `tool/call` 和一个 `tool/result`。
- Allow once 与 Reject 由真实 Web UI 按钮回答；测试不直接写 Session 决定事件。
- 多审批场景由 scripted LLM 在同一模型响应中返回两个不同 callId 的 bash 工具调用，给出可区分的审批 reason 和不同文件副作用；通过真实事件确认 DSH exclusive scheduler 逐个 dispatch，先允许第一项再拒绝第二项。该测试不宣称两个请求同时 pending。
- 取消场景在审批卡可见时，通过 URL-gated Worker test MessagePort 调用公开 `Agent.cancel({ kind: 'user' }, { keepInbox: true })`，等待正式 audit 和 tool settlement 后检查副作用，再提交新 turn 验证 Agent 可继续。该路径验证 Worker Agent/ApprovalService 生命周期，不验证用户界面 Stop 控件。
- Projection 仅投影经调用方按 Session 隔离的事件；tool/result 后的决定、重复决定和未知决定都不能成为有效授权状态。
- 真实 LLM 不负责触发审批；单独多轮记忆与 todo tool smoke 只检查 Browser Agent、Session 和工具路径仍可工作。

## 实施里程碑

### M1：封闭 projection 的 late-decision 缺口

检查 `approval/decided` 对应 call 是否仍未结算。为 tool/result 后决定增加诊断码和单测，并让真实 Worker probe 验证此输入不进入 decisions。

### M2：真实 Allow-once 闭环

扩展 scripted LLM marker，使其请求一个受审批保护的文件写入。Chrome 通过 UI 选择 Allow once，检查 Session 中一对唯一 asked/decided、同 callId 的成功 tool/result、唯一文件副作用和完成 turn。

### M3：多审批串行调度与身份隔离

一个模型响应返回两个审批保护的 bash 调用。Chrome 检查 DSH exclusive scheduler 只在首项结算后才 dispatch 第二项；逐 call 对账两条 audit pair、两个 tool results、只有首项副作用，以及一次模型调用发出原始两个 tool calls 后仅有一次工具续接 LLM 请求。projection 同时 pending FIFO 仍由 M1 的真实 Worker probe 和单测覆盖，不推导为正式 UI 队列行为。

### M4：Agent 取消与后续恢复

审批卡出现后通过 URL-gated Worker test MessagePort 调用公开 Agent `cancel()` 取消当前 turn。检查 `approval/decided(cancelled)`、同 call 的失败/取消 result、无文件副作用、无重发模型请求和无残留审批卡；随后提交一个普通新 turn 并确认 Agent 可继续。PoC 审批卡当前没有 Stop 控件，因此本项不能证明用户可从正式 UI 停止。

### M5：已有刷新恢复与真实模型冒烟

复跑审批等待期间刷新场景，确认 unknown settlement 和零重放。最后以真实模型完成三轮同 Session token 记忆与单次 todo 写入 smoke，收集模型请求、Session seq、工具结果和浏览器错误证据。

## 验收矩阵

| 场景 | 通过条件 | 禁止结果 |
| --- | --- | --- |
| Allow once | 一条 asked、同 id 的 allowed-once decided、同 callId 一个成功 tool/result、文件恰好写入一次 | 未决定先写、重复执行或决定落到其他 call |
| 同一模型响应的两项 exclusive 审批 | 第二项只在首项结算后产生；两个 request/call 一一对应；第一项允许、第二项拒绝；仅第一文件存在 | 两卡同时可答、跨 call 决定、重复副作用或遗漏终态 |
| Worker 取消活动审批 | 公开 `Agent.cancel()` 返回已取消、outcome 为 cancelled、tool 失败/取消、无文件，后续新 turn 可完成 | 取消被解释为批准、原 turn 自动重跑或新 turn 被旧请求阻塞 |
| 迟到决定 | `DECISION_CALL_SETTLED` diagnostic，decisions 不包含该决定 | 将迟到 allowed-once 重建为有效批准 |
| 刷新活动审批 | `TOOL_OUTCOME_UNKNOWN`、interrupted、无新 LLM 请求、无文件和无审批卡 | 恢复旧 Promise、重发 prompt 或静默授权 |

## 证据与限制

Chrome E2E 使用真实 Dedicated Worker、Browser-Native DSH Host、正式 ApprovalService、正式页面 answerer、同源 Session API 和 PoC scripted LLM endpoint。取消通过 URL-gated test MessagePort 调用 Agent 的公开 `cancel()`；它不代表当前 UI 有 Stop 控件或验证 Stop 交互。真实模型 smoke 不承担审批选择。`unavailable` 仍由 DSH ApprovalService 包测试覆盖，本批不将预置返回 `unavailable` 的测试 listener 冒充“没有 answerer”。该批不证明多标签/跨设备 answerer 所有权、自然 eviction、OS crash、Safari/WebKit 或生产认证。

## 验证命令

```sh
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-approval-projection.spec.ts
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
pnpm exec tsc -p apps/web/tsconfig.json --noEmit --pretty false
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/approval-settlement-lifecycle.e2e.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/approval-integrity-recovery.e2e.mjs
```

## 非目标

本批不修改正式 ApprovalService、权限 preset、Session schema、Agent Loop 或默认 Browser profile；不把 UI 本地 claim 当成 durable approval，不将 `unavailable` mock route 宣称成缺少 answerer 的证明，也不将 Worker 描述为页面关闭后运行的后台 Agent。
