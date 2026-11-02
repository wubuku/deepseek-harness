---
description: "记录父 Session 停止取消传播的实现、单元测试、Worker E2E 与真实 LLM 工具中断证据。"
---

# 父 Session 停止的取消传播实施进度

## Summary

语义与实现已落地。`SubagentManager.stopDescendants()` 沿 `ancestry` 取消活动后代，`stoppedByAncestor` 让结算通知只入队不唤醒，订阅挂在 `ctx.root` 并只处理顶层 Session 的用户 Stop。subagent 包单测、Worker 内 spawn E2E、真实 LLM 流式中断与 `bash sleep` 执行中中断均通过。

## 实现

| 位置 | 变更 |
| --- | --- |
| [activation.ts](../../../packages/subagent/subagent/src/activation.ts) | `ActivationBase` 增加 `stoppedByAncestor`，记录祖先停止来源。 |
| [manager.ts](../../../packages/subagent/subagent/src/manager.ts) | 新增 `stopDescendants(rootId)`；`notifySettlement` 对 `stoppedByAncestor` 使用 `inject`。 |
| [stop-propagation.ts](../../../packages/subagent/subagent/src/stop-propagation.ts) | `ctx.root.on('session/event')` 过滤顶层 `turn/end` + `aborted/user`。 |
| [index.ts](../../../packages/subagent/subagent/src/index.ts) | 与 archive admission 一并安装取消传播监听。 |
| [stop-propagation.spec.ts](../../../packages/subagent/subagent/tests/stop-propagation.spec.ts) | 三例：传播与通知入队、事件过滤、普通 turn 结束不传播。 |
| [in-worker-subagent-stop.e2e.mjs](tests/in-worker-subagent-stop.e2e.mjs) | Worker 内 parent/child 双 barrier，公开 `Agent.cancel()` 停止 parent。 |
| [real-stop-during-tool.e2e.mjs](tests/real-stop-during-tool.e2e.mjs) | 真实模型 `bash sleep` 执行中 UI Stop。 |

## 证据

- `pnpm exec vitest run packages/subagent/subagent/tests/stop-propagation.spec.ts packages/subagent/subagent/tests/continuation.spec.ts packages/subagent/subagent/tests/archive-admission.spec.ts`：通过。
- Chrome `156.0.8078.79` scripted E2E：parent `aborted/user`、child `aborted/parent`、2 个 Session、停止后 2 秒内模型请求数不变、settlement 通知先入 inbox 再由下一轮 prompt 前回放、页面/Worker 错误与跨源请求为 0。
- 真实 LLM（`.env` 的 `OPENAI_*` 与 LongCat 兼容端点，`OPENAI_NEXT_GPT_*` 当次 403 quota）：`runtime-real-lifecycle.e2e.mjs` 完成 `aborted → completed`，durableThroughSeq=24；`real-stop-during-tool.e2e.mjs` 完成 `sleep 4` 执行中 Stop，cut 调用记录 `Error: tool call aborted`，下一轮 `REAL_TOOL_STOP_RECOVERY_OK` 完成且 bash 调用数保持 1。
- 修复 `runtime-real-lifecycle.e2e.mjs` 缺失的 `rememberSessionPrincipal()`，否则 Node 侧无法读取浏览器 Session。

## 限制

只验证 in-worker `spawn` provider；进程外/SSH provider、跨标签 Stop、页面关闭后的后台 Agent、Safari/WebKit、OS 崩溃和生产多实例未验证。真实模型中断只代表客户端停止，不代表供应商侧停止计费。
