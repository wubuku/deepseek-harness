---
description: "同源 backend 作为跨标签页权威，限制同时执行 8 个 turn（FIFO 排队）与同时挂载 16 个 Session，并在真实 Chrome 中验证公平性、无饥饿、队列可见性与 16 路延迟。"
---

# 准入控制：并发 turn 上限、挂载租约与排队

## 结论

多个标签页独立 Worker 时，“同时执行几个 turn、同时挂载几个 Session”此前只靠调用方自觉。本批把这条约束落到同源 backend，作为跨标签页唯一权威：

- 同时执行的模型 turn 上限为 8（`maxConcurrentTurns`，可配置），第 9 个及以后的 turn 按 FIFO 排队，不拒绝、不丢请求；排队超过 `queueTimeoutMs`（默认 30 秒）才以 `503 ADMISSION_TIMEOUT` 结束。
- 同时挂载的 Session 上限为 16（`maxMountedSessions`，可配置），第 17 个 `session/create` 或 `open('write')` 立即以 `429 SESSION_MOUNT_LIMIT` 拒绝，附带 `retryAfterMs`。
- 挂载租约与 Session owner lease 同步续期，页面关闭或 lease 过期后由 30 秒 TTL 回收，不需要显式注销。
- `GET /api/browser-native/admission` 暴露当前 active/queued/mounts、等待队列（位置、序号、Session、目的、等待时长）与累计计数器，供任意标签页观察跨标签页状态。

真实 Chrome 156 下 16 个独立 `BrowserContext`/Worker 同时提交的结果：准入从未超过 8 个并发 turn，队列按到达顺序公平放行，0 饥饿、0 取消；第 17 个挂载被拒。16 路 turn 中位数 875–1,272 ms（两次运行），对照上一批无上限的 1,694 ms，回到客户端只放行 8 个时的 892 ms 区间附近，但没有达到 8 路本身的 615 ms——后端准入卡的是模型请求，不是页面的渲染与提交工作。

## 实现

`admission-v2.mjs` 是唯一新增模块，`backend-v2.mjs` 在每个 turn 路径与 Session 操作上调用它。

### turn：FIFO 队列而不是拒绝

`acquireTurn(meta, signal)` 在有空位时立即授予，否则把请求放进 FIFO 队列并返回一个 promise。授予后返回 `{ waitedMs, release() }`，`release()` 幂等并在同一个 tick 排空后续等待者：

| 情形 | 结果 |
| --- | --- |
| 有空位 | 立即执行，`waitedMs` 为 0 |
| 无空位且 30 秒内放行 | 排队执行，`waitedMs` 记录真实等待 |
| 超过 `queueTimeoutMs` | `503 ADMISSION_TIMEOUT`，`retryAfterMs` 指示重试 |
| 客户端关闭连接 | 等待者从队列移除，`ADMISSION_ABORTED`，服务端不执行 |
| 有请求结束 | 下一个等待者获得空位，位置与序号保持连续 |

`/llm` 的每次请求（turn、session-title、compaction）都要经过同一队列；排队期间监听 `response.close`，连接断开即出队，避免已关闭的标签页继续占用名额。

### mount：租约计数而不是永久注册

`mountSession(sessionId)` 先清理过期挂载，再检查 `maxMountedSessions`，达到上限直接抛出 `SESSION_MOUNT_LIMIT`。`renewMount()` 随 Session owner `renew` 一起刷新 `lastSeenAt`；`releaseMount()` 在 `session/close` 释放。挂载是租约而非会话生命周期的一部分，因此 Worker 崩溃不需要补偿事务。

### 可配置项

backend 默认值与 CLI 参数：

| 配置 | 默认 | CLI |
| --- | --- | --- |
| `maxConcurrentTurns` | 8 | `--max-concurrent-turns` |
| `maxMountedSessions` | 16 | `--max-mounted-sessions` |
| `queueTimeoutMs` | 30,000 | 测试注入 |
| `mountLeaseMs` | 与 `--owner-lease-ms` 一致（30,000） | 随 owner lease |

`options.admission === false` 关闭整个准入层，`/admission` 返回 404；合同测试锁定这一行为，避免测试或单机开发被静默限流。

## 合同测试

`tests/backend-v2.test.mjs` 新增三组合同测试（本文件合计 **63/63** 通过）：

1. 12 个 Session 同时提交 turn，用 `barrier-text` 固定 8 个在途：断言 `activeTurns=8`、`queuedTurns=4`、队列位置 `[1,2,3,4]`、`mounts.active=12`；释放后 12 个请求全部完成，`admitted=12`、`completed=12`、`maxActiveTurns=8`、`timedOut=0`，并且 `recentAdmitted` 中队列请求的相对顺序与入队顺序一致。
2. 创建 16 个 Session 后第 17 个返回 `SESSION_MOUNT_LIMIT`（429，`retryAfterMs>0`）；关闭一个后重新创建成功，挂载计数仍为 16。
3. `admission: false` 时 `/admission` 为 404。

## 浏览器 E2E

`tests/admission-control.e2e.mjs` 分两阶段，避免把“观测队列”与“测量延迟”混在一起：

- **阶段 A（队列可见性与公平性）**：每个 Worker 的 admitted turn 由 `barrier-text` 握住不放，测试轮询 `/admission` 直到 `activeTurns=8` 且排队 turn 数 ≥ 8，记录队列快照后统一释放。这样队列深度是确定性事实，不依赖采样运气。
- **阶段 B（延迟复测）**：只保留固定 200 ms 的模型延迟，16 个 Session 同时提交第二个 turn，测量从发送到 terminal 的耗时。

实测（Chrome 156，headless，单台 macOS 开发机）：

| 运行 | 挂载租约 | 阶段 A 饱和耗时 | 队列快照 | 阶段 B 中位数 | p95 | 最小/最大 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 120 s | 1,624 ms | 8 active、21 queued（13 turn + 8 title） | 1,272 ms | 1,278 ms | 670/1,278 ms |
| 2 | 120 s | 842 ms | 8 active、22 queued（14 turn + 8 title） | 875 ms | 906 ms | 657/906 ms |
| 3 | 30 s（默认） | 1,148 ms | 8 active、18 queued（8 turn + 10 title） | 994 ms | 1,011 ms | 809/1,011 ms |
| 4 | 30 s（默认） | 1,077 ms | 8 active、21 queued（8 turn + 13 title） | 907 ms | 947 ms | 649/947 ms |

前两次运行显式把挂载租约设为 120 s，用于排查“16 页顺序启动超过 TTL”的猜测；后续证实猜测不成立，提交的 harness 改用 backend 默认 30 s——16 个挂载仍全部存活，因为 owner `renew` 会同步续租。turn 队列与延迟不受该差异影响。

四次运行都满足：

- `counters.maxActiveTurns = 8`，从未出现第 9 个并发 turn；
- 队列位置连续（1..N），序号严格递增，排队 turn 属于不同 Session；
- 释放后全部 16 个 turn 完成，`timedOut=0`、`aborted=0`、`maxQueueWaitMs` 为 213–425 ms，远低于 30 秒超时；
- `recentAdmitted` 中先前出现在队列里的请求，其放行顺序与入队顺序一致；
- 每个 Session 的事件流都出现 `assistant/message`，没有 Session 因排队丢 turn；
- 第 17 个 `BrowserContext` 的 `session/create` 返回 429 `SESSION_MOUNT_LIMIT`，此时 `mounts.active` 仍为 16。

### 与上一批的延迟对比

| 16 路策略 | turn 中位数 | p95 |
| --- | --- | --- |
| 无并发上限（上一批） | 1,694 ms | 1,824 ms |
| 客户端只放行 8 个 turn（上一批） | 892 ms | 1,154 ms |
| backend 准入（本批，四次） | 875–1,272 ms（默认租约两次为 907/994） | 906–1,278 ms（默认租约两次为 947/1,011） |

结论分两句：

1. 后端准入消除了“16 个模型请求同时打到 provider”的越界，p95 从 1,824 ms 降到 906–1,278 ms，且有了明确的排队上限与可见性。
2. 它不能把 16 路恢复到 8 路本身的 615 ms。16 个页面仍在同时提交、渲染和持有 Worker，CPU 争用发生在请求到达 backend 之前；后端只能延后模型请求，不能回收页面侧工作。

因此下一层若要严格达到 8 路延迟，需要的是 Worker/页面级 turn gate（提交前就排队），后端准入继续作为跨标签页的兜底权威。本批不做，因为客户端 gate 已在上一批验证过，且会改变产品交互（提交后等待队列位次）。

## 决策

| 议题 | 决定 | 理由 |
| --- | --- | --- |
| 超限行为 | turn 排队，mount 拒绝 | turn 是用户已提交的工作，拒绝会丢失输入；挂载是页面启动状态，可重试 |
| 权威位置 | backend | 跨标签页共享；Worker 不可信且可被关闭 |
| 公平性 | 全局 FIFO | 无优先级需求；`session-title` 与 turn 共用名额，防止旁路 |
| 饥饿保护 | 30 秒超时 + 503，不静默丢弃 | 明确失败优于无限等待；`retryAfterMs` 可被客户端尊重 |
| 挂载回收 | 租约 + owner renew 续期 | 与既有 owner lease 同一时钟，崩溃无需补偿 |
| 默认上限 | 8 / 16 | 沿用上一批测量结论，且暴露为配置项 |

## 限制

- 只验证 scripted turn；真实模型下排队期间的 provider 超时、流式取消与重试语义未验证。
- `session-title` 请求也占名额，因此“8 个 turn”在标题并发的瞬间可能包含标题请求；E2E 用 `purpose` 过滤 turn 队列并单独断言。
- 阶段 A 的饱和耗时（842–1,624 ms）包含测试轮询节奏，不是队列延迟指标；真实等待由 `maxQueueWaitMs` 记录。
- 队列只在 backend 内存中；backend 重启后等待中的请求全部失败，客户端需重试。
- 同一台机器、headless Chrome、单 backend；不代表多主机、真实网络延迟或 Safari/WebKit。

## 证据

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/admission-control.e2e.mjs
```

E2E 报告为单行 JSON，包含 `mounts`、`queue.heldQueue`、`queue.peakActiveTurns`、`latency`、`mountLimit` 与 `pageErrors`；区间百分位按线性插值计算。
