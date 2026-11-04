---
description: "系统级幂等：逐项列出状态变更接口的幂等键或自然幂等保证，验证双击 Send、网络重试与并发重复请求不产生第二次副作用。"
---

# 系统级幂等

本验证按接口逐一核对“状态变更只结算一次”：每个写操作要么以 `requestId`/`operationId`/`turnId` 重放已完成的结果，要么天然幂等（覆盖写、内容寻址），要么在无法证明同一请求时 fail-closed（不产生第二次副作用）。浏览器侧另测真实 composer 的双击 Send 与真实 Worker 的网络重试。

## 接口清单与保证

| 接口 | 幂等键 / 保证 | 证据 |
| --- | --- | --- |
| `session/create` | `requestId` 收据重放；同键不同 header → 409 `IDEMPOTENCY_CONFLICT`；并发重复同键返回同一 owner lease | 本次新增；`state-change-idempotency.test.mjs` |
| `session/append` | `requestId` 收据 + 请求摘要比对；重放返回 `replayed:true`，不追加事件 | 本次测试覆盖（既有实现） |
| `session/branch` | `requestId` 收据；重放返回同一 child | `session-branch-rollback.test.mjs`（BN-P2-148） |
| `session/flush` | 重复 flush 只推进 `durableThroughSeq`，不写事件 | 既有 durability 测试 |
| `session/open` | 挂载/owner lease 覆盖写；重复 read 不改变数据 | `session-mount-lifecycle` 系列 |
| `session/close` | 成功后再次 close 返回 403 `OWNER_REQUIRED`，不写事件 | 本次测试读事件长度不变 |
| `session/share` | 授予按 `(sessionId, viewerPrincipalId)` 覆盖写，列表始终 1 项 | 本次新增断言 |
| `session/import` | 目标 id 已存在 → 409 `SESSION_ALREADY_EXISTS`，原 Session 与事件不变 | 本次新增断言 |
| `session/export` | 仅读；重复 POST 不改变事件或 revision | `session-export-import.e2e.mjs` |
| `session/transfer` | 成功后目标已成为 owner，重试 409 `INVALID_REQUEST`，无第二次转移 | 代码审查 |
| `session/durable` | `turnId` 串行化注册（journal 持久化前先登记 run），并发重复返回 202/200 且只跑一个 turn | 本次修复；`state-change-idempotency.test.mjs` |
| `session/durable/stop` | 重复 stop 返回同一终态，不追加事件 | 本次断言 |
| `session/durable/approve` | 每个审批只结算一次，重复决策 `APPROVAL_ALREADY_DECIDED` | `durable-approval.test.mjs` |
| `workspace/create` | `requestId` 收据，且检查与创建在同一 identity 锁内；并发重复返回同一 `activeWorkspaceId` | 本次修复与测试 |
| `workspace/select` | 覆盖写 identity，重复选择同一 workspace 无副作用 | `state-change-idempotency.test.mjs` |
| `workspace/commit` | `operationId` 收据 + `baseRevision` CAS；重放同一 revision，冲突 409 | `shared-authority-concurrency.test.mjs` |
| `workspace/lease` claim | `requestId` 收据：同一有效 writer 上重放同一 token/fencing；不同 request 仍 409 `WORKSPACE_ALREADY_OWNED`；release 后同键重新 claim 得到新 token | 本次修复与测试 |
| `workspace/lease` renew/release | 按 token/epoch 覆盖，重复调用不增加 writer | 既有 writer-expiry 测试 |
| `blob-upload` / `blob-batch` / attachment PUT | 内容寻址 SHA-256；已存在且校验通过则 `reused`，不写第二份 | `attachment-backend.test.mjs`、`workspace-durability.test.mjs` |
| `cross-store-operation` intent/receipt/business | 稳定 `operationId` + 对账 | `external-business-idempotency.test.mjs` |
| `auth/exchange` | Bearer 每次签发同一 principal 的 cookie；重复 exchange 不创建第二个身份 | 代码审查 |

## 浏览器侧：双击 Send 与网络重试

`tests/idempotent-send.e2e.mjs` 在同一个任务里对 Send 按钮调用两次 `click()`（绕过 Playwright 的可操作性重试），并捕获真实 Worker 发出的 append 请求：

- 双击后 Session 日志只有 1 条用户消息、1 个 `turn/start`、1 个 `turn/end`；transcript 只有 1 个 `[data-chat-flow-kind="user"]`，页面错误 0。
- 末次 `/session/append` 请求重放返回 200 `replayed:true`、`acceptedCount` 不变，事件总数不变。
- 同一请求并发重放两次都返回 200，事件总数不变。
- 用同一 `requestId` 篡改事件体 → 409 `IDEMPOTENCY_CONFLICT`，日志不变。

## 本次修复

1. `session/create` 增加 `requestId` 收据（含 header 摘要），并发重复创建返回同一 owner lease，不再以 409 结束重试。
2. `workspace/create` 的收据检查与创建移入同一个 `exclusive('identities')` 临界区；原先两个并发同键请求会在收据写入前各自创建一个 workspace。
3. `workspace/lease` claim 增加 `requestId` 收据，并在“已有活跃 writer”的 409 之前检查；response 丢失后可重放同一 writer token，不同 requestId 仍然被拒绝。
4. `session/durable` 在 `persistJournal()` await 之前登记 run；原先两个并发同 `turnId` 请求都能通过存在性检查，第二个会触发 `SESSION_TURN_ACTIVE`。

## 结论

- 所有状态变更接口都有明确结算规则：重放、自然幂等或 fail-closed；没有发现第二份 Session、事件批次、share、workspace、writer lease 或 durable turn。
- 双击 Send 与网络重试在真实浏览器路径上不产生重复副作用；并发重复同样只结算一次。
- 回归：`attachment-backend`、`session-branch-rollback`、`shared-authority-concurrency`、`durable-approval`、`workspace-durability` 等 12 个 backend 用例全部通过；`session-export-import.e2e.mjs` 通过。

## 边界与未覆盖

- `session/append`、`session/branch`、`session/create` 的收据是进程内 Map（上限 1,000）；backend 重启后同一 `requestId` 重试会得到 `SEQ_CONFLICT` 而不是重放。`workspace/commit` 的 operation 收据随 workspace 持久化，`durable` 的 `turnId` 随 journal 持久化。
- 收据只覆盖单进程；多实例共享存储下的跨进程去重未实现。
- `session/close`、`session/transfer`、`auth/exchange` 通过“重复请求 fail-closed 且无第二次副作用”满足要求，但不是重放语义。
- 未覆盖浏览器标签页在响应丢失后自行重试的完整恢复脚本；本次只手动重放捕获的 append 请求。
- `workspace-sync.e2e.mjs` 需要 `DSH_POC_LLM=real` 与真实 key；其 Node 侧 `session/read` 助手不携带 Session principal cookie，本批未运行通过，未用于本结论。

## 复跑

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/state-change-idempotency.test.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/idempotent-send.e2e.mjs
```
