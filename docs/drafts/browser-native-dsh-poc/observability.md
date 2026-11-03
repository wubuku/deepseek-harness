---
description: "Browser-Native PoC 的可观测性：HTTP/模型/队列/租约/durable turn 指标、Prometheus 导出，以及定位单次失败的最小证据集。"
---

# 可观测性

## 范围

本页面说明 backend 暴露哪些结构化指标、如何导出，以及一次失败需要哪些证据才能定位。指标只覆盖同源 Node backend；Worker 内部的模型循环、浏览器存储和页面生命周期仍由既有 `browser-native-*` E2E 覆盖。

## 导出入口

| 路由 | 认证 | 输出 |
|---|---|---|
| `GET /api/browser-native/observability/metrics` | 无（同源 loopback） | JSON 快照 |
| `GET /api/browser-native/observability/metrics?format=prometheus` | 无（同源 loopback） | Prometheus 文本，`text/plain; version=0.0.4` |
| `GET /api/browser-native/observability/failure?turnId=...` | session principal cookie | 单次 durable turn 的证据包 |

指标据在进程内累积；backend 重启后归零。Prometheus 文本按 scrape 时的快照渲染，gauge 直接取当前值，counter 与 histogram 取累计值。

## JSON 快照字段

- `metricsVersion: 1`、`capturedAt`、`uptimeMs`。
- `process`：`rssBytes`、`heapUsedBytes`、`heapTotalBytes`；`process.memoryUsage()` 失败时该对象为空，其余字段照常导出。
- `requests`：`total`、`active`（当前未完成请求数）、`aborted`、`byRouteStatus`（`"GET /path 200"` 或 `"GET /path aborted"` 为键）、`failuresByCode`、`durationMs`（全体请求直方图）、`routes`（按路由的直方图）。
- `model`：`requests`、`failures`、`failuresByCode`、`durationMs`、`queueWaitMs`。
- `queue`：`activeTurns`、`queuedTurns`、`limits`、`mountedSessions`、`counters`（`admitted`/`completed`/`timedOut`/`aborted`/`maxQueueWaitMs`/`maxActiveTurns`）。
- `leases`：`sessions`、`held`、`expired`、`writeBlocked`、`unsupportedFormats`。
- `durableTurns`：`version`、`total`、`running`、`completed`、`failed`、`runningTurns`（最近 16 条，仅 `turnId`/`sessionId`/`startedAt`/`elapsedMs`/`step`）、`recentSettled`（最近 12 条，含 `status`、`errorCode`、`elapsedMs`）。

直方图结构为 `{count, sumMs, buckets:[{le, count}]}`，桶边界固定为 5、10、25、50、100、250、500、1 000、2 500、5 000、10 000、30 000、60 000、120 000 ms 与 `+Inf`，计数为累计值。

路由标签先做标识符归一：UUID、32 位以上 hex、纯数字串替换为 `:id`，超过 120 字符截断。每个标签 map 最多 48 个键，溢出合并到 `other`，因此请求方无法通过构造路径或错误码增长内存。

## Prometheus 文本

前缀统一为 `dsh_browser_native_`，主要指标：

| 指标 | 类型 | 标签 |
|---|---|---|
| `http_requests_total` | counter | 无 |
| `http_requests_by_route_total` | counter | `method`、`route`、`status` |
| `failures_total` | counter | `code` |
| `active_requests` | gauge | 无 |
| `http_request_duration_ms_bucket` / `_sum` / `_count` | counter | `le` |
| `model_requests_total`、`model_failures_total` | counter | 无 |
| `model_failures_by_code_total` | counter | `code` |
| `model_request_duration_ms_bucket`、`model_queue_wait_ms_bucket` | counter | `le` |
| `admission_active_turns`、`admission_queued_turns`、`admission_mounted_sessions`、`admission_max_queue_wait_ms` | gauge | 无 |
| `sessions_total`、`session_leases_held`、`session_leases_expired`、`sessions_write_blocked` | gauge | 无 |
| `durable_turns_running`、`durable_turns_completed`、`durable_turns_failed` | gauge | 无 |
| `process_rss_bytes`、`process_heap_used_bytes`、`uptime_ms` | gauge | 无 |

标签值转义反斜线、双引号与换行；每行以换行结束。一次 scrape 看不到自己：当前 scrape 的请求只在下一个快照中出现。

## 失败证据包

`GET /api/browser-native/observability/failure?turnId=...` 要求该 turn 的 principal cookie，其他 principal 与不存在的 `turnId` 都返回 404，匿名返回 401。包内字段：

- `turn`：`turnId`、`sessionId`、`status`、`model`、`turn`、`startedAt`、`settledAt`/`elapsedMs`、`error`、`startSeqs`/`endSeqs`/`nextSeq`。
- `events`：该 turn 最后 12 条事件的精简投影，只有 `seq`、`type`、`step`、`reason`、`errorCode`、`callId`/`tool`、`toolCallId`/`isError`。
- `lease`：`held`、`expiresInMs`、`writeBlocked`、`eventCount`、`durableThroughSeq`。
- `accessDenials`：当前 principal 最近 8 条拒绝访问审计，按 principal digest 过滤。
- `metrics`：同一时刻的完整 JSON 快照。

证据包不包含 prompt、工具参数或工具输出正文；这些内容在 Session 日志中按 seq 定位。

最小定位顺序：`turn.status` 与 `turn.error.code` 给出失败类别；`events` 末尾的 `turn/end.reason` 确认是完成、取消还是错误；`lease.writeBlocked` 与 `held` 排除恢复阻塞与残留租约；`metrics.model.failuresByCode` 判断是模型传输失败还是 turn 自身失败；完整 Session 日志按 `events[].seq` 回看上下文。

## 可判定输出

`tests/observability.test.mjs` 1/1：

```text
✔ structured metrics classify failures and export a minimal evidence bundle for one turn (168.1ms)
{"result":"passed","scope":"observability","failureCodes":{"NOT_FOUND":1,"UNAUTHENTICATED":1},"modelRequests":2,"durableTurns":{"failed":1,"completed":1},"failedElapsedMs":25,"evidenceEvents":4,"evidenceBytes":5651,"prometheusLines":222}
```

| 断言 | 观测 |
|---|---|
| 失败分类 | 401 记为 `UNAUTHENTICATED`，404 记为 `NOT_FOUND`；两者同时出现在 `requests.failuresByCode` 与 Prometheus `failures_total{code=...}` |
| turn 延迟 | 失败 turn 的 `elapsedMs` 为 25 ms；成功 turn 计入 `durable_turns_completed`，失败计入 `durable_turns_failed` |
| 模型请求 | `model.requests` 为 2；空白 completion 是 turn 失败而非模型失败，`model.failures` 为 0 |
| 队列与租约 | 结算后 `queue.activeTurns`/`queuedTurns` 为 0，`leases.sessions` 为 1、`held` 为 0 |
| 导出 | Prometheus 文本 222 行，含 `dsh_browser_native_http_requests_total`、`failures_total{code="NOT_FOUND"}`、`durable_turns_failed 1`、`process_rss_bytes` |
| 证据包 | 失败 turn 证据 `status=failed`、`error.code=DURABLE_EMPTY_RESPONSE`、末条事件为 `turn/end` 且 `reason=error`、`lease.held=false`；JSON 中不含 prompt 文本 |
| 越权 | 其他 principal 取同一 turn 返回 404 `TURN_NOT_FOUND`，未知 `turnId` 404，匿名 401；成功 turn 的证据末条 `reason=completed` |

同批复跑 `durable-host`、`durable-tool-attach`、`resource-limits`、`path-boundary`、`prompt-injection-boundaries` 共 15/15。

## 失败场景清单（仍可能成立）

1. **指标不持久**：所有计数在进程内，重启归零；没有跨实例聚合，多实例部署需外部按进程打标。
2. **metrics 路由未认证**：快照只含计数、路由与租约数量，不含 prompt 或凭据，但同源页面可读取；放在公网主机时需要外部鉴权。
3. **证据包无日志正文**：为控制体积只保留最后 12 条精简事件；更早的模型输入与工具参数需按 seq 读 Session。
4. **访问审计有窗口**：`accessDenials` 来自最近 200 条进程内审计，且按 principal digest 过滤；跨重启或超出窗口的拒绝不可回看。
5. **直方图为累计值**：没有滑动窗口或速率；要算 p99 需外部按 scrape 差分。
6. **排队等待只在模型路由统计**：`model.queueWaitMs` 记录 LLM 路由的准入等待；durable turn 直接调用同一路由，因此也计入，但 worker 侧未单独打点。
7. **无 trace/span**：只有请求与 turn 级计数，没有单请求分段耗时；无法区分解析、存储与写出耗时。
8. **失败码来自 catch 通道**：未进入 catch 的语义失败（如工具 `isError` 结果）只体现在事件与 turn 状态，不计入 `failuresByCode`。
9. **重启后的 running turn**：`durableTurns.running` 只在内存；重启后该 turn 从指标消失，Session 日志可能留下未结算 turn。

## 边界

- 使用 `llmMode: "scripted"`；未调用真实 provider。
- 未改 `packages/`，无需 `build:artifacts`/`build:check`。
- 未接入外部采集器、未做长期趋势或告警阈值验证。
