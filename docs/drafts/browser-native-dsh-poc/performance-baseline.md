---
description: "给出 Browser-Native PoC 冷启动与 hydrate 的耗时、JavaScript 堆内存基线，以及 1 个与 4 个并发 Session 的缩放比值与可回归阈值。"
---

# 性能基线

## Summary

[performance-baseline.e2e.mjs](tests/performance-baseline.e2e.mjs) 在 Chrome 156.0.8078.79 上测量两种规模：1 个 Session 与 4 个并行 Session。每个 Session 使用独立 `BrowserContext`、独立 principal cookie 与独立 durable OPFS Workspace，因此 4 个 Session 就是 4 个标签页与 4 个 Dedicated Worker，数字同时反映单页成本与并发争用。

冷启动（导航 → composer 可用 → Workspace `synced`）中位数：1 个 Session 为 2.32 秒，4 个并行为 3.08 秒（1.33×）。hydrate（reload 后同样路径，恢复既有 Session 与 Workspace）中位数：1 个 Session 为 1.94 秒，4 个并行为 2.71 秒（1.40×）。每个标签页的 JavaScript 堆在两种规模下基本不变：page 约 42.7 MB，Worker 约 37.2 MB，单页合计约 79.9 MB。测量前对 page 与每个 Worker 执行 `HeapProfiler.collectGarbage`，两次独立运行得到相同的堆数字。

结论：4 个并行 Session 的冷启动与 hydrate 都在预算内，单页内存不随并发 Session 数增长；扩张成本主要体现在浏览器 CPU 争用（冷启动 1.33×、hydrate 1.40×）而不是每页堆增长。产品可以直接用浏览器承载多个 Session，但仍需服务端常驻 host 处理跨关页存活的 turn（见[后台常驻可行性](background-residency-feasibility.md)）。

## 测量方法

| 阶段 | 起点 | 终点 | 说明 |
| --- | --- | --- | --- |
| 冷启动 | `page.goto` 调用 | `window.__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__.state === 'synced'` | 包含 frame 出现、首次工作区选择、Workspace 首次同步与 composer 就绪 |
| hydrate | `page.reload` 调用 | 同上 | 复用同一 durable Workspace 与既有 Session；额外断言持久化的 assistant 消息重新出现在对话流 |
| 首个 turn | 提交 composer | `/session/read` 观察到 `turn/end` | scripted LLM，剔除真实 provider 延迟 |
| page 堆 | CDP `HeapProfiler.collectGarbage` 后 `Performance.getMetrics.JSHeapUsedSize` | — | 每个标签页 |
| Worker 堆 | 对每个 `type: "worker"` target 的嵌套 CDP session：`collectGarbage` 后 `Runtime.getHeapUsage.usedSize` | — | 总堆除以 Worker 数得到每页值 |

每个规模采样 3 次，报告样本、中位数与最大值。并发规模在同一浏览器实例中依次运行，每个样本结束后关闭该批 `BrowserContext`，再开下一批。

## 结果

| 指标 | 1 个 Session | 4 个并行 Session | 比值 |
| --- | --- | --- | --- |
| 冷启动 composer 中位数 | 2320 ms | 3079.5 ms | 1.33× |
| 冷启动 `synced` 中位数 | 2322 ms | 3080.5 ms | 1.33× |
| 冷启动 `synced` 最大值 | 2475 ms | 3458 ms | 1.40× |
| hydrate composer 中位数 | 1936 ms | 2705 ms | 1.40× |
| hydrate `synced` 中位数 | 1936 ms | 2709 ms | 1.40× |
| hydrate `synced` 最大值 | 1938 ms | 3116 ms | 1.61× |
| 首个 scripted turn 中位数 | 146 ms | 213 ms | 1.46× |
| page JavaScript 堆中位数 | 42.70 MB | 42.74 MB | 1.00× |
| Worker 每页 JavaScript 堆中位数 | 37.24 MB | 37.21 MB | 1.00× |
| 单页合计最坏值 | 79.9 MB | 79.9 MB | 1.00× |

hydrate 比冷启动快约 400 ms（1 个 Session），因为跳过首次工作区选择与初始 Workspace 写入；4 个并行时差距缩小到约 370 ms，说明并发下主要成本落在 Worker 启动与页面装配，而不是 OPFS 读取。

## 可回归阈值

harness 在结束时断言中位数与最坏值，低于阈值即通过；阈值本身可用环境变量覆盖，便于在更慢的机器上放宽或在发布前收紧：

| 环境变量 | 默认值 | 断言 |
| --- | --- | --- |
| `DSH_POC_PERF_COLD_BUDGET_MS` | 60000 | 每个规模的冷启动 `synced` 中位数 |
| `DSH_POC_PERF_HYDRATE_BUDGET_MS` | 45000 | 每个规模的 hydrate `synced` 中位数 |
| `DSH_POC_PERF_HEAP_BUDGET_MB` | 512 | 单页 page 堆最大值 + Worker 堆每页中位数 |

另有确定性断言：每个 Session 都报告 `synced` 与数值 revision；hydrate 后持久化的 assistant 消息必须出现在对话流；Worker target 数不少于 Session 数；1 个与 4 个规模的每页 Worker 堆差值小于 10%（`perTabWorkerHeapFlat`）。

## 语义决策

| 问题 | 决定 | 理由 |
| --- | --- | --- |
| 单页成本是否随 Session 数线性增长 | 否 | 每个 Session 独立标签页与 Worker，page 与 Worker 堆在 1 与 4 规模下均为约 42.7 MB 与 37.2 MB。 |
| 并发成本是否可接受 | 是，4 个并行仍在秒级 | 冷启动 3.08 秒、hydrate 2.71 秒，足以支撑多 Session 并行打开。 |
| 是否需要为性能引入服务端常驻 host | 不需要，性能不是理由 | 需要服务端 host 的理由来自关页生命周期与凭据/出口策略，不是耗时或内存。 |
| 默认预算取值 | 冷启动 60 秒、hydrate 45 秒、单页堆 512 MB | 远高于观测值，先作为回归护栏；收紧阈值需先在目标机型上积累样本。 |
| 堆数字的口径 | JavaScript 堆，不是 OS RSS | 直接比较浏览器进程 RSS 会受共享内存、GPU 进程与其它标签页干扰。 |

## 实现

| 位置 | 变更 |
| --- | --- |
| [tests/performance-baseline.e2e.mjs](tests/performance-baseline.e2e.mjs) | 1/4 Session × 3 样本的冷启动、hydrate、首个 turn 与堆测量 harness。 |
| [README.md](README.md) | 新增本节入口。 |
| [operational-compatibility-matrix.md](operational-compatibility-matrix.md) | 新增性能基线行。 |

harness 复用既有 preview 镜像（`roster: 'original'`）、scripted backend 与 `runtime-test-support.mjs`，不修改 Worker、profile、Session 格式或 Agent Loop。

## 证据

```sh
node docs/drafts/browser-native-dsh-poc/tests/performance-baseline.e2e.mjs
# 收紧或放宽阈值：
DSH_POC_PERF_COLD_BUDGET_MS=30000 DSH_POC_PERF_HYDRATE_BUDGET_MS=20000 \
DSH_POC_PERF_HEAP_BUDGET_MB=256 node docs/drafts/browser-native-dsh-poc/tests/performance-baseline.e2e.mjs
```

Chrome 156.0.8078.79 输出（节选）：

```json
{"result":"passed","browser":"156.0.8078.79","scope":"cold-start-and-hydrate-baseline",
 "budgets":{"coldMs":60000,"hydrateMs":45000,"perTabHeapBytes":536870912},
 "scales":[
  {"sessions":1,
   "cold":{"medianComposerMs":2320,"medianSyncedMs":2322,"medianTurnMs":146,"maxSyncedMs":2475,
    "samples":[{"composerMs":2474,"syncedMs":2475,"turnMs":155,"revision":0,"sessionId":"session-…"},
               {"composerMs":2190,"syncedMs":2191,"turnMs":146,"revision":0,"sessionId":"session-…"},
               {"composerMs":2320,"syncedMs":2322,"turnMs":145,"revision":0,"sessionId":"session-…"}]},
   "hydrate":{"medianComposerMs":1936,"medianSyncedMs":1936,"maxSyncedMs":1938,
    "samples":[{"composerMs":1883,"syncedMs":1884,"markerVisible":true},
               {"composerMs":1937,"syncedMs":1938,"markerVisible":true},
               {"composerMs":1936,"syncedMs":1936,"markerVisible":true}]},
   "memory":{"pageHeapMedianBytes":44757716,"workerHeapMedianPerTabBytes":39043584,
    "workerCounts":[1,1,1],"pageHeapSamples":[44758088,44757716,44751432]},
   "worstTabHeapBytes":83810616},
  {"sessions":4,
   "cold":{"medianComposerMs":3079.5,"medianSyncedMs":3080.5,"medianTurnMs":213,"maxSyncedMs":3458,
    "samples":[{"composerMs":3417,"syncedMs":3439,"turnMs":258},
               {"composerMs":3308,"syncedMs":3310,"turnMs":244},
               {"composerMs":3409,"syncedMs":3436,"turnMs":277},
               {"composerMs":3456,"syncedMs":3458,"turnMs":209},
               {"composerMs":2937,"syncedMs":2943,"turnMs":158},
               {"composerMs":2878,"syncedMs":2880,"turnMs":211},
               {"composerMs":3022,"syncedMs":3026,"turnMs":152},
               {"composerMs":2992,"syncedMs":2995,"turnMs":159},
               {"composerMs":2717,"syncedMs":2719,"turnMs":217},
               {"composerMs":3051,"syncedMs":3052,"turnMs":191},
               {"composerMs":3108,"syncedMs":3109,"turnMs":230},
               {"composerMs":3130,"syncedMs":3131,"turnMs":215}]},
   "hydrate":{"medianComposerMs":2705,"medianSyncedMs":2709,"maxSyncedMs":3116},
   "memory":{"pageHeapMedianBytes":44784056,"workerHeapMedianPerTabBytes":39017304,
    "workerCounts":[4,4,4],"workerHeapTotalSamples":[156069216,156039324,156089864]},
   "worstTabHeapBytes":83810616}],
 "verdict":{"coldStartMedianMs":2322,"hydrateMedianMs":1936,"fourSessionColdStartMedianMs":3080.5,
  "fourSessionHydrateMedianMs":2709,"coldStartScalingRatio":1.33,"hydrateScalingRatio":1.40,
  "perTabWorkerHeapBytesAtOneSession":39043584,"perTabWorkerHeapBytesAtFourSessions":39017304,
  "perTabWorkerHeapFlat":true,"perTabHeapBytesAtFourSessions":83810616,
  "allSessionsSynced":true,"hydrateProjectedHistory":true}}
```

- 两次独立运行（含 2 样本与 3 样本配置）在强制 GC 后给出相同的 page 堆与 Worker 堆，说明堆数字可回归；时间数字随机器负载浮动约 10%–20%。
- 4 个并行规模的 `workerCounts` 为 `[4,4,4]`，与 Session 数一致；每页 Worker 堆与 1 个规模相差小于 1%。

## 限制

只在单台 macOS 开发机、headless Chrome、`--enable-precise-memory-info` 下采样，未覆盖 Windows/Linux、Safari/WebKit、Firefox、有头模式、低内存设备、真实网络与真实模型延迟。只测 1 与 4 个 Session，未测 8 个以上、长会话增长、附件与工具结果堆积后的稳态内存，也未长时间运行观察泄漏。计时以 Node `Date.now()` 为单位，含 Playwright 自身开销；堆只统计 page 与 Dedicated Worker 的 JavaScript 堆，不含 OS RSS、GPU 进程、共享内存或 OPFS 占用。
