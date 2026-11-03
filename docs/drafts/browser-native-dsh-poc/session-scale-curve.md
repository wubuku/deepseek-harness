---
description: "量化 100/300 turns 长会话的 hydrate、事件回放、浏览器存储与 compaction 阈值，给出浏览器端 compaction 的必要条件。"
---

# 会话规模曲线

## Summary

[session-scale-curve.e2e.mjs](tests/session-scale-curve.e2e.mjs) 在一个真实 Chrome 156.0.8078.79 页面上把同一 Session 从 0 推到 300 turns，每个 turn 执行一次 `read` 工具（1,900 字符结果），每 20 turns 再写一个 32 KB 工作区文件。在 100 与 300 turns 处执行 `flush`、读取 durable Session JSON、`navigator.storage.estimate()`、IndexedDB outbox、Workspace 文件字节与 page/Worker JavaScript 堆，然后 reload 测量 hydrate，并在 hydrate 后继续第 301 turn。

100 turns：1,345 事件、1.55 MB durable JSON、hydrate 2,070 ms、page 堆 77.0 MB、Worker 堆 41.7 MB。300 turns：4,017 事件、4.64 MB durable JSON、hydrate 2,566 ms、page 堆 108.5 MB、Worker 堆 46.2 MB。浏览器侧存储几乎不随 turn 增长：IndexedDB 两次都是 221,184 bytes；origin 总用量 0.38 → 0.71 MB，增量只来自 15 个 32 KB 工作区文件；flush 后 outbox 待确认事件为 0。hydrate 期间没有新增模型请求，事件流新增 `session/end-seed` 后仍能继续第 301 turn。

compaction 方面：未声明 `contextWindow` 时 301 turns 内零次 compaction，每次 Session mount 打出一条 `no context capacity` 警告并继续；声明 `contextWindow=4096` 时第 1 turn 即触发，`8192` 时第 5 turn 触发，16 turns 内 `tool/call` 始终等于 16，compaction 没有重复工具副作用。结论：浏览器端事件日志不需要存储型 compaction；必须在产品 profile 声明 `contextWindow` 与可用 headroom，否则模型上下文会无界增长，300 turns 的 128k 模型会在约第 200 turn 越过硬窗口。

## 测量方法

| 阶段 | 起点 | 终点 | 说明 |
| --- | --- | --- | --- |
| turn | 提交 composer | `/session/read` tail 出现 `turn/end` | 每 turn 一个 scripted `read`，每 20 turns 追加一个 32 KB `write` |
| checkpoint | 上一 turn 结束 | flush 返回 | flush 后统计事件、durable JSON、IndexedDB、storage estimate、Workspace 字节与堆 |
| hydrate | `page.reload` 调用 | `synced` 且最后一条 assistant marker 重新可见 | 记录同步耗时、投影耗时、read 请求/响应字节与新增模型请求数 |
| compaction | 新 Session 首 turn | 第 16 turn 结束 | 每 turn prompt 2,640 字符 + 1,900 字符工具结果；窗口 4096 与 8192 |

事件读取按 2,048 事件分页，直到 `hasMore=false`；page 堆在 `HeapProfiler.collectGarbage` 后取 CDP `JSHeapUsedSize`，Worker 堆对 Dedicated Worker target 取 `Runtime.getHeapUsage.usedSize`。Workspace 字节通过 Workspace test hook 列出 `/dsh/home/workspace/` 并累加 `scale-turn-*.txt`，排除了 harness 与 backend 自身的开销。

## 结果

| 指标 | 100 turns | 300 turns | 每 turn 增量 |
| --- | --- | --- | --- |
| 事件数 | 1,345 | 4,017 | 13.4 |
| durable Session JSON | 1,551,754 bytes | 4,640,349 bytes | 15,443 bytes |
| Workspace 文件 | 5 个 / 160,071 bytes | 15 个 / 480,221 bytes | 每 20 turns 约 32 KB |
| origin storage 用量 | 382,883 bytes | 705,773 bytes | — |
| `fileSystem` 用量 | 161,699 bytes | 484,589 bytes | — |
| `indexedDB` 用量 | 221,184 bytes | 221,184 bytes | 0 |
| outbox 待确认事件 / 字节 | 0 / 0 | 0 / 0 | 0 |
| hydrate `synced` | 2,070 ms | 2,566 ms | — |
| hydrate 投影完成 | 2,071 ms | 2,567 ms | — |
| hydrate read 请求数 | 2 | 6 | — |
| hydrate read 响应字节 | 3,103,628 bytes | 9,282,482 bytes | — |
| hydrate 期间模型请求 | 0 | 0 | 0 |
| page JavaScript 堆 | 80,697,576 bytes | 113,752,784 bytes | 165 KB |
| Worker JavaScript 堆 | 43,719,784 bytes | 48,439,916 bytes | 23 KB |
| turn 延迟中位数 / 最大值 | 313.5 ms / 1,704 ms | — | — |

hydrate 时间对 durable 体量近似线性：`synced ≈ 1.82 s + 0.16 s/MB`。300 turns 的 hydrate 读取 9.28 MB，是 4.64 MB durable JSON 的 2.0 倍；Web 客户端投影与 Worker Agent 重放各完整读一遍事件，100 turns 处同样是 2.0 倍。page 堆增长（165 KB/turn）远大于 Worker 堆增长（23 KB/turn），主要来自转录渲染，是长转录渲染验证的对象。

| compaction 场景 | 首次 compaction turn | `compaction/start` | `summary` / `end` | `tool/call` |
| --- | --- | --- | --- | --- |
| 未声明 `contextWindow`，301 turns | 无 | 0 | 0 / 0 | 301 |
| `contextWindow=4096`，16 turns | 1 | 45 | 30 / 45 | 16 |
| `contextWindow=8192`，16 turns | 5 | 3 | 3 / 3 | 16 |

`4096` 场景每 turn 都触发多轮 compaction（45 次 start / 30 次 summary），`8192` 场景在第 5 turn 首次触发后保持 3 次。两个场景的 `tool/call` 都等于 16，说明 compaction 重放上下文时没有再次执行工具；`tool/result` 出现 2 倍（32 条），来自 prune 后重新物化同一结果，不是第二次执行。未声明窗口的 Session 在每次 mount 都打印 `compaction-basic: ... no context capacity ... continuing the turn`，然后继续累积上下文。

## 阈值与曲线

compaction 的压力阈值来自 `compaction-basic`：`threshold = min(0.8 × contextWindow, contextWindow − reservedCompletion − headroomTokens)`。验证 profile 配置 `headroomTokens: 512`、`retainTokens: 256`、`maxTokens: 512`，`reservedCompletion` 为 0。触发量是模型可见 token，不是 turn 数；DSH 估算器按 4 字符/token 计价。用两个实测锚点反推：重型 turn（2,640 字符 prompt + 1,900 字符工具结果）每 turn 约 1.15k token，初始信封约 2.0k token。

| `contextWindow` | 阈值 | 重型 turn 首次 compaction | 规模 turn 首次 compaction（按 ≈0.5k token/turn 推算） |
| --- | --- | --- | --- |
| 4,096 | 3,276 | 第 1 turn（实测） | 第 4 turn |
| 8,192 | 6,554 | 第 5 turn（实测） | 第 12 turn |
| 16,384 | 13,107 | 第 10 turn | 第 23 turn |
| 32,768 | 26,214 | 第 21 turn | 第 50 turn |
| 65,536 | 52,429 | 第 43 turn | 第 101 turn |
| 131,072 | 104,858 | 第 89 turn | 第 207 turn |

规模 turn 的实测增长是 13.4 事件、15.4 KB durable JSON、约 0.5k 模型可见 token/turn。因此在 128k 模型上，300 turns 的普通工具型 Session 会在约第 200 turn 触及压力阈值；若 profile 未声明 `contextWindow`，则不会主动 compaction，只能等 provider 返回 overflow。浏览器侧存储不是约束：300 turns 只占 0.71 MB origin 存储、IDB 保持 221 KB、OPFS 只在工作区写入时增长。hydrate 也不是 300 turns 的约束：2.57 秒远低于 30 秒预算，page 堆 108.5 MB 远低于 512 MB 预算；按 165 KB/turn 外推，page 堆到 512 MB 约需再 3,000 turns，届时先需要的是转录虚拟化而不是事件日志 compaction。

默认 `headroomTokens` 是 65,536。任何小于约 66k 的声明窗口都会得到非正压力预算，`compaction-basic` 记一条警告后跳过主动 compaction；验证 profile 的 512 覆盖是 4k/8k 窗口能触发的前提。产品 profile 必须同时声明 `contextWindow` 与按窗口比例缩小的 headroom（建议不超过窗口的 1/8），否则「声明了窗口」仍可能不产生任何 compaction。

## 语义决策

| 问题 | 决定 | 理由 |
| --- | --- | --- |
| 是否为浏览器事件日志做存储型 compaction | 不做 | Session 日志由 backend durable JSON 承担；浏览器只有会清空的 outbox 与工作区文件，300 turns 下 IDB 恒为 221 KB、origin 用量 0.71 MB。 |
| 何时必须做浏览器端 compaction | 当模型可见 token 触及 `min(0.8W, W−headroom)` 时 | 存储与 hydrate 在 300 turns 内都不是约束；唯一硬约束是 provider 窗口。 |
| 未声明 `contextWindow` 的行为 | 记为可感知但不阻塞的配置缺陷 | 每次 mount 输出 `no context capacity` 警告并继续 turn；事件与 hydrate 正常，但上下文无界增长。 |
| 小窗口 compaction 的前提 | profile 必须同时配置 headroom | 默认 65,536 headroom 使 4k/8k 窗口没有压力预算；验证 profile 用 512 才有实测触发。 |
| hydrate 是否允许重放模型请求或工具 | 不允许 | 两次 checkpoint 的模型请求数在 reload 前后完全不变，第 301 turn 正常继续。 |
| 大读页的响应预算 | 截断到字节预算并置 `hasMore=true`，不再返回 413 | 长会话页必然超预算；截断保留顺序与续读能力，客户端按 `hasMore` 继续。单个超大事件仍允许单独前进一页。 |
| OPFS 体积的口径 | 只以 Workspace 文件字节计 | Session 事件不写入 OPFS；origin `usageDetails.fileSystem` 与 15 个 32 KB 文件一致。 |

## 实现

| 位置 | 变更 |
| --- | --- |
| [tests/session-scale-curve.e2e.mjs](tests/session-scale-curve.e2e.mjs) | 100/300 turns 曲线、hydrate、存储、堆与 4k/8k compaction 场景。 |
| [backend-v2.mjs](backend-v2.mjs) | 新增 `BROWSER_NATIVE_SESSION_SCALE_TURN_E2E` scripted 场景；`read` 页改为按字节预算截断。 |
| [runtime-validation.mjs](runtime-validation.mjs) | 新增 `browser-validation/scale-input.txt` 固定 fixture。 |
| [tests/backend-v2.test.mjs](tests/backend-v2.test.mjs) | 新增超大读页截断、续读与顺序完整性的合同测试。 |
| [README.md](README.md) | 新增本节入口。 |
| [operational-compatibility-matrix.md](operational-compatibility-matrix.md) | 新增会话规模行。 |

## 证据

```sh
node docs/drafts/browser-native-dsh-poc/tests/session-scale-curve.e2e.mjs
# 收紧阈值：
DSH_POC_SCALE_TURNS=50 DSH_POC_SCALE_HYDRATE_BUDGET_MS=10000 \
DSH_POC_SCALE_HEAP_BUDGET_MB=256 node docs/drafts/browser-native-dsh-poc/tests/session-scale-curve.e2e.mjs
cd docs/drafts/browser-native-dsh-poc && node --test --test-name-pattern="oversized Session read page" tests/backend-v2.test.mjs
```

Chrome 156.0.8078.79 输出（节选）：

```json
{"result":"passed","browser":"156.0.8078.79","scope":"session-scale-hydrate-storage-compaction",
 "scale":{
  "checkpoints":[
   {"turn":100,"eventCount":1345,"durableBytes":1551754,"durableThroughSeq":1344,
    "storage":{"usage":382883,"usageDetails":{"fileSystem":161699,"indexedDB":221184}},
    "outbox":{"eventCount":0,"metadata":{"eventCount":0,"pendingBytes":0}},
    "workspace":{"entries":5,"bytes":160071},
    "pageHeapBytes":80697576,"workerHeapBytes":43719784,
    "hydrate":{"syncedMs":2070,"projectedMs":2071,"readCount":2,
     "readResponseBytes":3103628,"llmCountBefore":206,"llmCountAfter":206}},
   {"turn":300,"eventCount":4017,"durableBytes":4640349,"durableThroughSeq":4016,
    "storage":{"usage":705773,"usageDetails":{"fileSystem":484589,"indexedDB":221184}},
    "outbox":{"eventCount":0,"metadata":{"eventCount":0,"pendingBytes":0}},
    "workspace":{"entries":15,"bytes":480221},
    "pageHeapBytes":113752784,"workerHeapBytes":48439916,
    "hydrate":{"syncedMs":2566,"projectedMs":2567,"readCount":6,
     "readResponseBytes":9282482,"llmCountBefore":616,"llmCountAfter":616}}],
  "turnLatencyMedianMs":313.5,"turnLatencyMaxMs":1704,
  "followupTurn":301,"externalRequests":0,"pageErrors":[]},
 "compaction":[
  {"contextWindow":4096,"firstCompactionTurn":1,"compactionStarts":45,
   "compactionSummaries":30,"compactionEnds":45,"eventCount":445,"toolCalls":16},
  {"contextWindow":8192,"firstCompactionTurn":5,"compactionStarts":3,
   "compactionSummaries":3,"compactionEnds":3,"eventCount":272,"toolCalls":16}]}
```

## 限制

只在单台 macOS 开发机、headless Chrome 156 上采样，未覆盖 Windows/Linux、Firefox/WebKit、有头模式；LLM 为 scripted 确定性响应，token 压力由 DSH 的 4 字符/token 估算器计算，不等于真实 provider 的 usage。compaction 曲线只实测了 4k 与 8k 窗口，16k 以上的首次 turn 是按实测斜率推算；hydrate 与堆数字随机器、扩展、DevTools 与会话内容变化，阈值应按发布机型重采。未覆盖 300 turns 以上的线性外推验证、真实模型 compaction 摘要质量与 compaction 失败后的 provider overflow 恢复。
