---
description: "Browser-Native durable 审批：危险写入工具必须经 `ask` 决策；未获批不执行，跨客户端只结算一次，超时与取消以明确错误结算。"
---

# durable 审批

## 范围

durable host 仍只执行 `read`/`write` 两个 Workspace 工具。`write` 属于危险工具，模型调用后必须先经页面批准；`read` 自动放行。审批只覆盖 durable 路径，Worker 自有 turn 的审批走既有链路。

## 请求与响应

审核状态由 `GET /api/browser-native/session/durable?turnId=` 暴露：

```json
{"pendingApproval":{"approvalId":"...","callId":"durable-call-1","name":"write","target":"/dsh/home/workspace/note.txt","requestedAt":123}}
```

`target` 取参数中的 `file_path` 或 `url`，截断到 200 字符；不返回完整参数或内容。

决策路由：

```http
POST /api/browser-native/session/durable/approve
content-type: application/json
cookie: dsh-browser-native-session-principal=...

{"protocolVersion":1,"requestId":"...","turnId":"...","approvalId":"...","decision":"approve"}
```

- session principal 缺失或无效：401 `UNAUTHENTICATED`。
- `turnId` 不存在或属于其他 principal：404 `TURN_NOT_FOUND`。
- `approvalId` 不匹配当前待决审批：409 `APPROVAL_NOT_PENDING`。
- 同一审批已决策：409 `APPROVAL_ALREADY_DECIDED`，先到者生效。
- 首次决策：202 `{approvalId, decision}`。

## 结算语义

- **批准**：工具执行一次，`tool/result` 返回写入字节数，模型继续下一步；Workspace 只在批准后出现文件。
- **拒绝**：工具不执行，`tool/result` 为 `isError: true` 并写明 rejected；turn 继续并正常完成。
- **超时**：`durableApprovalTimeoutMs`（默认 60 000 ms）到期后 `tool/result` 为 `isError: true`，turn 以 `DURABLE_APPROVAL_TIMEOUT` 失败结算。
- **取消**：等待审批时 stop 立即拒绝审批等待，`tool/result` 为 `isError: true`，turn 以 `aborted`/`user` 结算为 `cancelled`。
- 拒绝、超时与取消都先写 `tool/result` 再结束 turn，保证 `tool/call` 与 `tool/result` 数量相等；Session 不会因为悬挂调用阻塞下一 turn。
- 审批等待计入 `durableTurns.approvals`：`pending`、`requested`、`approved`、`rejected`、`timedOut`、`cancelled`。

## 可判定输出

`tests/durable-approval.test.mjs` 1/1：

```text
{"result":"passed","scope":"durable-approval","rejected":{"status":"completed","wroteFile":false},"approved":{"status":"completed","wroteFile":true},"doubleDecision":"APPROVAL_ALREADY_DECIDED","timeout":{"status":"failed","code":"DURABLE_APPROVAL_TIMEOUT"},"cancellation":{"status":"cancelled","pendingApproval":null},"approvals":{"pending":0,"requested":6,"approved":2,"rejected":1,"timedOut":1,"cancelled":2},"toolCallsBalanced":true,"foreignDecision":404,"anonymousDecision":401}
```

| 断言 | 观测 |
|---|---|
| 未获批不执行 | 待决时 manifest 无目标文件；拒绝后仍无；批准后才出现 `approval-approved.txt` |
| 单次决策 | 同一 `approvalId` 第二次 reject 返回 409 `APPROVAL_ALREADY_DECIDED`，turn 只结算一次 |
| 超时 | 900 ms 未决策的 turn `failed` + `DURABLE_APPROVAL_TIMEOUT`；`tool/result` 含 not approved；目标文件不存在 |
| 取消 | 待决时 stop → `cancelled`、`pendingApproval` 清除、文件不存在、`tool/result` 含 cancelled |
| 事件平衡 | 全程 `tool/call` 数等于 `tool/result` 数；取消后的 turn 仍能继续开始新 turn |
| 归属 | 其他 principal 决策 404 `TURN_NOT_FOUND`；匿名 401 |
| 计数 | `approvals={pending:0,requested:6,approved:2,rejected:1,timedOut:1,cancelled:2}` |

同批复跑 `durable-tool-attach`（其写入现需批准，已在测试中补决策）、`durable-host`、`durable-cancellation`、`observability`、`resource-limits` 共 7/7。

## 失败场景清单（仍可能成立）

1. **审批只覆盖 durable 路径**：Worker 自有 turn 的写盘仍走既有审批链路，两者策略未统一。
2. **策略硬编码**：`requiresApproval` 只对 `write` 生效；新增危险工具（egress、shell）需要同步修改 backend 映射。
3. **无审批理由/风险摘要**：页面只看到工具名与目标路径，看不到内容、diff 或风险等级。
4. **决策无身份细分**：同一 principal 的任意标签都可决策，没有标签级或角色级限制。
5. **取消延迟**：工具已经开始执行后 stop 不会中断，仍以 `aborted` 结束后结算。
6. **重启丢失待决审批**：审批状态在内存，backend 重启后既无法批准也无法恢复，Session 可能留下未结算 turn（下一点处理）。
7. **审批不持久**：批准/拒绝不写 Session 事件，审计只能依赖日志与指标计数。
8. **无速率限制**：同一 turn 的恶意模型可反复请求审批；当前只受 step 上限约束。

## 边界

- 使用 `llmMode: "scripted"`；未调用真实 provider。
- 未改 `packages/`，无需 `build:artifacts`/`build:check`。
- 未覆盖真实 Chrome 双标签、审批持久化、重启恢复与其他危险工具。
