---
description: "Browser-Native durable 取消：POST /session/durable/stop 中止在途模型请求、以 aborted 结算、释放租约，并保持幂等与事件一致。"
---

# durable 取消

## 范围

本页说明 `POST /api/browser-native/session/durable/stop` 的行为边界：只取消由 durable host 执行、仍在运行的 turn。浏览器 Worker 自有的 turn、审批、进程重启恢复和其他工具不在范围内。

## 请求与响应

```http
POST /api/browser-native/session/durable/stop
content-type: application/json
cookie: dsh-browser-native-session-principal=...

{"protocolVersion":1,"requestId":"...","turnId":"..."}
```

- session principal 缺失或无效：401 `UNAUTHENTICATED`。
- `turnId` 不存在或属于其他 principal：404 `TURN_NOT_FOUND`。
- 运行中：202，`cancelRequested: true`；响应返回取消前的状态，turn 随后异步结算。
- 已结算：202，返回原状态，`cancelRequested` 保留为该 turn 是否曾被取消；不新增事件、不重新执行模型。

## 结算语义

取消时 `AbortController` 中止 durable host 到同源 LLM 路由的 fetch。backend 观察到客户端断开后停止脚本模型输出；durable host 以 `DURABLE_TURN_CANCELLED` 结算：

- `turn/end` 使用 `{ kind: "aborted", reason: { kind: "user" } }`，与 DSH Session 的取消原因一致。
- 未结束的 step 补写 `step/end`，事件 `seq` 连续。
- 状态接口返回 `status: "cancelled"` 与 `error.code: "DURABLE_TURN_CANCELLED"`；metrics 计入 `durableTurns.cancelled` 与 `durable_turns_cancelled`，不计入 `failed`。
- Session 租约与 mount 释放，重开页面可 `session/open` 取得写租约。
- 已持久化的 `turn/start`、`user/message`、`step/start` 保留；不写 assistant 消息，不伪造工具结果。

取消在 step 边界检查。若停止请求到达时工具正在执行，当前工具会跑完并以 `tool/result` 落盘，随后 turn 以 `aborted` 结算；不会重复执行，也不会留下未结算的工具调用。

## 事件一致性

取消后 `GET /session/durable/stream?fromSeq=0` 回放的事件与 Session 日志逐字段相等，并以 `{kind:"settled", status:"cancelled"}` 结束；对同一 `turnId` 再次 `POST /session/durable` 返回 `status: "cancelled"`，不产生新的模型请求。

## 可判定输出

`tests/durable-cancellation.test.mjs` 1/1：

```text
{"result":"passed","scope":"durable-cancellation","status":"cancelled","errorCode":"DURABLE_TURN_CANCELLED","events":5,"turnEndReason":{"kind":"aborted","reason":{"kind":"user"}},"modelRequests":1,"clientClosed":1,"repeatedStopStatus":"cancelled","foreignStop":404,"anonymousStop":401,"leaseTakeover":200,"cancelledGauge":1}
```

| 断言 | 观测 |
|---|---|
| 中止在途模型 | 模型只被请求 1 次；backend 收到 1 次客户端断开（`onLlmClientClose`），屏障释放后不再写 assistant 文本 |
| 结算 | 状态 `cancelled`、`error.code=DURABLE_TURN_CANCELLED`；事件 5 条，末条 `turn/end` 且 `reason.kind=aborted`、`reason.reason.kind=user` |
| 事件一致 | 5 条事件 `seq` 0–4 连续；attach 流回放与 Session 日志 deepEqual，settled 行 `status=cancelled` |
| 幂等 | 第二次 stop 返回 `cancelled`，Session 事件不变；重放 turnId 返回 `cancelled`，模型请求仍为 1 |
| 归属 | 其他 principal 404 `TURN_NOT_FOUND`，未知 turnId 404，匿名 401 |
| 租约 | 结算后 `session/open` 写租约 200 |
| 指标 | `durableTurns.cancelled=1`，Prometheus 含 `dsh_browser_native_durable_turns_cancelled 1` |

同批复跑 `durable-host`、`durable-tool-attach`、`resource-limits`、`observability` 共 7/7。

## 失败场景清单（仍可能成立）

1. **工具步骤内的取消有延迟**：停止只在下一次 step 边界生效，当前工具必须完成；长工具不受取消中止。
2. **进程重启丢取消**：`runs` 在内存，backend 重启后无法对旧 `turnId` 发起 stop，Session 可能留下未结算 turn。
3. **真实 provider 的断连依赖上游**：脚本模型通过 `isClientClosed` 停止；真实 provider 是否立即停止计费取决于上游对断开的响应。
4. **无审批语义**：取消不是拒批；dangerous 工具的 `ask` 审批仍未接入 durable host。
5. **取消不区分原因**：所有停止都记为 `reason.kind=user`，没有超时取消或系统取消的分类。
6. **跨标签竞争**：两个标签同时 stop 和 replay 时以先到达者为准；没有取消令牌或版本比较。
7. **attach 流不跨 turn**：`fromSeq` 对已取消 turn 只回放该 turn 事件，跨 turn 过滤未实现。

## 边界

- 使用 `llmMode: "scripted"`；未调用真实 provider。
- 未改 `packages/`，无需 `build:artifacts`/`build:check`。
- 未覆盖进程重启、审批、长工具、真实 Chrome 多标签竞争。
