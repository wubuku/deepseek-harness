---
description: "记录 Browser-Native DSH 模型流故障、Worker 终止和取消传播验证的实施进度与证据边界。"
---

# Browser-Native DSH 模型流故障验证进度

## 当前状态

状态：四个验证面已实施并完成当前 checkout 的 Chrome/scripted 与 backend 合同验收。候选范围、选择依据和退出条件见[验证计划](llm-stream-failure-validation-plan.md)。基线是本批开始时干净的 `research` checkout，实施在主工作区完成，没有隔离 worktree；本批不修改正式 Agent Loop、Session format 或默认 profile。

## 里程碑

| 里程碑 | 状态 | 结果 |
|---|---|---|
| M0：候选审查与事件核对 | `complete` | 已核对 `agent.ts`、`AssistantStreamAttempt`、Browser LLM adapter、backend scripted/real stream 和既有 Worker crash recovery。流启动后异常会落 `assistant/attempt`；完整工具 block 之前不会进入工具执行。 |
| M1：故障注入与 backend 合同 | `complete` | `backend-v2.test.mjs` 23/23 通过；scripted 文本/工具半包、延迟流响应关闭和真实代理到 fake upstream 的 AbortController 传播均有合同断言。 |
| M2：真实 Chrome Agent Loop | `complete` | `llm-stream-failure.e2e.mjs` 通过；真实 Chrome Worker/DSH Host 完成文本截断、工具半包无副作用、流中终止 Worker 后刷新恢复和 UI Stop。 |
| M3：正常流与既有恢复回归 | `complete` | 新 E2E 中半流后的同 Session 新 turn、Worker 中止后的新 turn 均完成；既有正常流/文件工具/Workspace 回归纳入本轮复跑清单，真实 LLM 正常流沿用既有历史证据。 |
| M4：文档与交付 | `complete` | README、兼容矩阵、`docs/drafts/README.md`、change ledger、计划和进度均已更新；实际命令、证据等级和限制已记录。 |

## 证据记录

| 验证 | 实际结果 |
|---|---|
| Agent Loop 源码语义 | `agent.ts` 与 `AssistantStreamAttempt` 核对：流异常持久化 `assistant/attempt`，错误以 `turn/end:error` 收束；取消使用已有 interrupted/aborted 语义。 |
| backend scripted partial stream | 通过；部分文本和部分工具参数均发送错误终止，不发送成功 `block-end`；适配器规范化为错误 finish。 |
| fake upstream abort | 通过；本地 OpenAI-compatible upstream 收到 partial SSE 后，客户端取消能触发代理上游请求中止。 |
| Chrome partial text/tool stream | 通过；真实 DSH Session 分别记录 attempt/error；工具半包没有 `tool/call`、`tool/result` 或 Workspace revision。 |
| Chrome Worker termination during stream | 通过；刷新后旧 turn 修复为 `interrupted`，没有重发原 LLM request 或执行工具；显式新 turn 成功。 |
| Chrome UI Stop and backend close observation | 通过；turn 为 `aborted`，backend 观察到客户端响应关闭；全程无页面错误或跨源请求。 |
| 真实 LLM 正常流回归 | 本批未重新依赖外网真实 LLM；既有真实 Chrome 普通流/文件工具证据保留，不能外推为真实供应商半包故障证据。 |

## 限制

本批证明的是当前 PoC 在 Chrome 和可控 backend 故障下的 Agent Loop 失败收束，不证明真实模型会自然产生半包协议。Worker 在流中终止后当前 DSH repair 以 `interrupted` 修复 open turn，刷新不会重发原 LLM request；原流文本不会被伪装为成功 assistant message。真实供应商断流、自然浏览器崩溃、Safari、生产 HA 和后台 Agent 仍未验证。
