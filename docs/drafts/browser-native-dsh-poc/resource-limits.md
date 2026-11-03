---
description: "Browser-Native PoC 的资源耗尽防护探测：请求体上限、并发准入、请求/头/keep-alive 超时、连接上限与 durable 模型超时，给出压测数字、阈值和内存上界。"
---

# 资源耗尽防护

## 探测范围

对同源 backend 施加四类压力：超大请求体、并发请求洪泛、慢客户端、超长模型执行。目标是让越界请求快速失败并释放资源，而不是排队或驻留内存。

## 阈值与默认值

| 维度 | 阈值 | 行为 | 配置项 |
|---|---|---|---|
| JSON 请求体 | 8 MiB | 413 `REQUEST_TOO_LARGE`，连接可继续复用 | 常量 `MAX_BODY_BYTES` |
| 附件上传 | 64 MiB | 超过即 413，写入前拒绝 | `attachmentMaxBytes` |
| Workspace blob 分块 | 1 MiB | 分块上限，整 blob 64 MiB | `WORKSPACE_BLOB_CHUNK_BYTES` |
| Workspace 路径 | 512 字符 | 400 `INVALID_PATH` | 常量 |
| Session 单次读取 | 2 048 事件 / 2 MiB | 截断并返回分页游标 | 常量 |
| 并发请求 | 64 | 超出即 503 `SERVER_BUSY`，`retry-after: 1` | `maxConcurrentRequests` |
| 并发连接 | 128 | Node `maxConnections` 拒绝 | `maxConnections` |
| 整个请求 | 30 s | Node `requestTimeout` 销毁连接 | `requestTimeoutMs` |
| 请求头 | 15 s | Node `headersTimeout` 销毁连接 | `headersTimeoutMs` |
| 空闲 keep-alive | 5 s | Node `keepAliveTimeout` | `keepAliveTimeoutMs` |
| 超时检查间隔 | 1 s | `connectionsCheckingInterval` | `connectionsCheckingIntervalMs` |
| 模型 turn（Worker） | 8 并发 + 16 挂载 | 排队 30 s 后 429/超时 | `admission-v2.mjs` |
| 模型 turn（durable） | 120 s | 504 `DURABLE_LLM_TIMEOUT` 并结算为 failed | `durableTurnTimeoutMs` |

`requestTimeoutMs` 覆盖从收到请求到请求体读完的整段时间；`headersTimeoutMs` 必须短于它，否则慢头发送者会先耗尽 request 超时。`maxConcurrentRequests` 在路由前计数，超出的请求不进入解析、身份或存储路径。

## 可判定输出

`tests/resource-limits.test.mjs` 4/4：

```text
✔ rejects a request body above the 8 MiB cap (64.0ms)
✔ sheds requests above the concurrent cap and recovers after the slow clients leave (98.5ms)
✔ closes a slow request body at the request timeout (2017.2ms)
✔ settles a durable turn as failed when the model exceeds its turn timeout (1281.5ms)
ℹ pass 4  fail 0
```

| 场景 | 输入 | 观测 |
|---|---|---|
| 超大 body | 9 MiB JSON | 413；随后 `/health` 200，进程未退出 |
| 并发洪泛 | 上限 2，两个未完成 POST | 第三个请求 503 `SERVER_BUSY`、`retry-after: 1`；销毁慢请求后 `/health` 恢复 200 |
| 慢客户端 | 上限 1.5 s，发送头后只写半个 body | 连接在 2 017 ms 关闭；`/health` 仍 200 |
| 超长模型 | durable 超时 1.2 s，脚本模型延迟 5 s | 1 281 ms 后状态 `failed`、错误码 `DURABLE_LLM_TIMEOUT`，不等待完整 5 s |

慢客户端关闭时间高于 1.5 s 是检查间隔与 `headersTimeout` 叠加的结果；2 017 ms 是实测值，不是承诺边界。

## 内存上界

- JSON 路由按块累积到 8 MiB 后 `Buffer.concat` 并解析，单请求峰值约为正文的 2–3 倍；64 个并发满额请求的理论上界约 1–1.5 GiB，超过并发上限的请求在路由前被拒。
- 附件与 Workspace blob 写入按流式块落盘，内存不随对象大小线性增长；切断上传由 `request.aborted` 检查与 `requestTimeout` 覆盖。
- Session 列表与读取有事件数和字节上限，避免一次把整个日志复制进响应。

这些是代码路径推算的上界，不是对 Node 堆或 RSS 的实测封顶；本轮未采集 `process.memoryUsage()`。

## 修复

`backend-v2.mjs` 此前只设置 body 上限，没有并发准入与慢客户端约束：Node 默认 `requestTimeout=300 s`、`headersTimeout=min(requestTimeout, 60 s)`、`keepAliveTimeout=5 s`、`maxConnections=∞`，且 `connectionsCheckingInterval=30 s` 让 1.5 s 的 request 超时要等 30 s 才检查。现在显式设置五项服务端阈值并传入 1 s 检查间隔；`activeRequests` 在 `response` 的 `close` 事件释放，`shed` 分支立即释放。

`durable-host-v2.mjs` 此前在 `fetch` 返回响应头后就清除定时器，模型先回头再拖住流式 body时永不超时。现在 `AbortController` 覆盖到 `parseCompletion` 结束，body 读取抛错且已 abort 时映射为 `DURABLE_LLM_TIMEOUT`。

## 失败场景清单（仍可能成立）

1. **64 路满额 body 的堆峰值**：并发上限只约束请求数，不约束单请求正文；16 MiB 级堆峰值未实测，低内存部署需要下调 `maxConcurrentRequests`。
2. **单连接多路未覆盖**：Node HTTP/1.1 每连接一个请求；HTTP/2 未启用，因此不存在流级并发上限。
3. **持久化的磁盘耗尽**：Session/附件总量无配额；洪泛可写满 `dataDir`，本地后端没有容量上限或回收策略。
4. **慢响应读者**：`requestTimeout` 约束接收请求，不约束向慢客户端写响应；大附件下载只由 `workspaceDownloadTimeoutMs` 与读者数上限约束。
5. **durable 运行记录只在内存**：backend 重启会丢失 running turn 的状态查询，需恢复流程。
6. **真实模型延迟分布**：脚本延迟只验证超时机制，未测真实 provider 的 p99 与超时比例。
7. **跨进程/多实例**：并发与连接上限是单进程的，`dataDir` 锁只阻止第二个实例启动。

## 边界

- 未跑真实模型 smoke：本轮只改 HTTP 层与超时路径，未改 LLM 请求语义；durable 超时用脚本模型延迟复现。
- 未采集 RSS/堆数据，未做长时间洪泛或内存泄漏测试。
- 未改 `packages/`，无需 `build:artifacts`/`build:check`。
