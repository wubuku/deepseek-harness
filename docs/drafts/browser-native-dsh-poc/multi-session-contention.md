---
description: "量化 1/8/16 个并行 Session 的冷启动、turn 延迟、主线程占用与 CPU 争用，给出浏览器端并发上限和排队建议。"
---

# 多 Session 争用上限

## Summary

[multi-session-contention.e2e.mjs](tests/multi-session-contention.e2e.mjs) 在真实 Chrome 156.0.8078.79 上为每个 Session 建立独立 BrowserContext 与 Dedicated Worker，让 1、8、16 个 Session 同时渲染、同时提交一个 scripted turn（每 turn 一次 `read`），并对比「16 个同时执行」与「16 个挂载、同时只执行 8 个」两种准入策略。每次采样重复 3 轮，共 48 个 16 路样本。

单 Session 的 turn 延迟中位数 257 ms、p95 258 ms，冷启动 2.2 s，页面主线程任务时间 107.7 ms，浏览器 CPU 用量 1.15–1.63 个核。8 个并行：turn 中位数 615 ms（2.4 倍）、p95 757 ms（2.9 倍）、冷启动 5.4 s、主线程任务时间 135.5 ms、CPU 4.5–5.1 核。16 个并行：turn 中位数 1,694 ms（6.6 倍）、p95 1,824 ms（7.1 倍）、冷启动 13.8 s、主线程任务时间 182.8 ms（p95 244.8 ms）、CPU 5.3–5.8 核。所有规模下单页 JavaScript 堆稳定在 46.7 MB，256 MB/页预算从未接近。

16 个挂载但只放行 8 个 turn 时，turn 中位数降到 892 ms（相对无上限 1,694 ms 降 47%），p95 1,154 ms（降 37%），但排队带来的波次差异把 CV 从 0.095 抬到 0.199。CPU 用量只从 5.6 核降到 4.6 核，说明瓶颈不是总 CPU，而是每个 Worker/页面的调度与单进程 backend 的串行请求处理。结论：**同时执行的 turn 数上限取 8**；挂载更多 Session 可行，但第 9 个及以后的 turn 应排队。冷启动本身也需要单独限流，16 个页面同时拉取 boot payload 会明显放大冷启动并偶发首次失败。

## 测量方法

| 阶段 | 起点 | 终点 | 说明 |
| --- | --- | --- | --- |
| 冷启动 | `browser.newContext` 后 `page.goto` | `__DSH_BROWSER_NATIVE_WORKSPACE_STATUS__.state === 'synced'` | 每个 Session 独立 context，16 路同时打开；失败时整页重载一次并单独记录失败原因 |
| turn | composer 提交 | `/session/read` tail 出现 `turn/end` | 每 Session 一个 scripted `read`；Node 侧按 100 ms 间隔轮询 Session 尾部 |
| 渲染 | composer 提交 | 最后一条 assistant marker 可见 | 与 turn 分开计时，覆盖 UI 投影与 DOM 更新 |
| CPU | turn 批次开始 | 全部 turn 结束 | 通过 browser 级 CDP `SystemInfo.getProcessInfo` 汇总 `cpuTime`，换算成一个核的百分比 |
| 主线程 | `Performance.enable` 后 | turn 结束 | 每页 `Performance.getMetrics.TaskDuration`，只覆盖 turn 阶段 |
| 堆 | turn 结束 | `HeapProfiler.collectGarbage` 后 | 每页 `JSHeapUsedSize`，GC 之后采样 |

16 路对比使用 `runWithConcurrency` 控制准入：无上限时 16 个 submit 同时发出；有上限时先放行 8 个，其余等前一批 `turn/end` 后再提交。两批都在 16 个页面已经 `synced` 后开始，所以差异只反映 turn 准入，不反映冷启动。

## 结果

| 指标 | 1 Session | 8 并行 | 16 并行 | 16 并行 / 放行 8 |
| --- | --- | --- | --- | --- |
| 冷启动中位数 / 最大值 | 2,225 / 2,511 ms | 5,353 / 7,482 ms | 13,784 / 14,028 ms | 12,426 / 13,720 ms |
| turn 中位数 | 257 ms | 615 ms | 1,694 ms | 892 ms |
| turn p95 | 258 ms | 757 ms | 1,824 ms | 1,154 ms |
| turn 最大值 / 最小值 | 258 / 249 ms | 792 / 532 ms | 1,839 / 1,335 ms | 1,195 / 527 ms |
| turn CV | 0.016 | 0.112 | 0.095 | 0.199 |
| 渲染完成中位数 | 259 ms | 617 ms | 1,716 ms | 909 ms |
| 渲染完成 p95 | 260 ms | 763 ms | 1,831 ms | 1,172 ms |
| 主线程任务时间中位数 | 107.7 ms | 135.5 ms | 182.8 ms | 169.4 ms |
| 主线程任务时间 p95 | 110.8 ms | 173.6 ms | 244.8 ms | 233.3 ms |
| 单页 JavaScript 堆中位数 | 46.66 MB | 46.72 MB | 46.67 MB | 46.70 MB |
| CPU 用量（一个核 = 100%） | 115–163% | 445–507% | 528–580% | 414–516% |
| turn 批次墙钟（3 次采样） | 267 / 258 / 270 ms | 811 / 653 / 642 ms | 1,507 / 1,866 / 1,834 ms | 1,450 / 2,262 / 2,072 ms |
| 首次冷启动失败 | 0 | 0 | 0 | 0 |

延迟随并行度超线性增长：8 路的 turn 中位数是单路的 2.4 倍，16 路是 6.6 倍，而 Session 数只翻倍。CPU 用量在 8 路时已接近 5 个核，16 路只再增加约 17%，基本停在 5.5 个核；同一时刻的 turn 墙钟在 8 路约 0.65–0.81 s，16 路约 1.5–1.87 s，因此每秒完成的 turn 数从约 12 降到约 9。继续增加并行度不会提高吞吐，只会拉长每个 turn。

渲染完成只比 `turn/end` 晚 2–20 ms，说明在 1280×900、短转录下 UI 投影不是额外瓶颈；主线程任务时间随规模从 107.7 ms 涨到 182.8 ms（p95 244.8 ms），增长有限，页堆完全平坦，内存不是并发上限。

## 阈值与建议

| 准入参数 | 建议值 | 依据 |
| --- | --- | --- |
| 同时执行的 turn 数 | 8 | 8 路 turn 中位数 615 ms、p95 757 ms；16 路上升到 1,694 / 1,824 ms，而吞吐没有提高。 |
| 同时挂载的 Session 数 | 不超过 16 | 16 路页堆仍为 46.7 MB/页，本机总堆约 747 MB；挂载本身不是内存问题。 |
| 同时冷启动的页面数 | 4–8 | 冷启动从 2.2 s（1）涨到 5.4 s（8）和 13.8 s（16）；一次早先运行在 16 路时出现 3/48 次 boot payload fetch 失败，整页重载后恢复。 |
| 第 9 个及以后的 turn | 排队，不抢占 | 排队后 turn 中位数 892 ms、p95 1,154 ms，仍低于无上限的 1,694 / 1,824 ms。 |
| 单 Session turn 预算 | 20 s | 实测最大 1,839 ms；20 s 留出约 10 倍余量，超限视为异常而不是常态。 |
| 单页堆预算 | 256 MB | 实测 46.7 MB，256 MB 留出 5 倍余量。 |

公平性方面，独立 Worker 之间没有饿死：16 路无上限时最小 1,335 ms、最大 1,839 ms，CV 0.095，所有 Session 都在同一批内完成。排队后 CV 升到 0.199，因为第一波与第二波的等待时间不同；这是排队本身的可解释差异，不是调度偏斜。若产品要求「所有 Session 的 turn 同时结束」，不应排队；若要求「每个 turn 尽快返回」，应排队并把上限设为 8。

## 语义决策

| 问题 | 决定 | 理由 |
| --- | --- | --- |
| 并发上限按挂载数还是执行数 | 按同时执行的 turn 数 | 挂载 16 个 Session 的页堆仍是 46.7 MB/页；延迟劣化来自同时执行。 |
| 默认准入上限 | 8 | 8 路是最后一个延迟仍低于 1 s 且 CPU 未饱和的档位。 |
| 排队是否降低总吞吐 | 不降低 | 无上限 16 路墙钟 1.5–1.87 s，排队后 1.45–2.26 s，量级相同；排队只重分配等待时间。 |
| 是否限制冷启动并发 | 是，4–8 | 冷启动 1→8→16 路为 2.2→5.4→13.8 s，且 16 路曾出现 boot payload 首次失败。 |
| 失败冷启动的处理 | 整页重载一次并记录原因 | 早先运行在 16 路时 3/48 个页面首次 `boot payload` fetch 失败（503 包装的 `TypeError: Failed to fetch`），重载后成功；不把重试计入正常冷启动时延指标之外。 |
| 内存是否作为并发限制 | 否 | 1–16 路页堆稳定在 46.7 MB，没有随并发增长。 |

## 实现

| 位置 | 变更 |
| --- | --- |
| [tests/multi-session-contention.e2e.mjs](tests/multi-session-contention.e2e.mjs) | 1/8/16 并行 Session、独立 context/Worker、冷启动重试、turn 与渲染分时、公平性与 CPU 统计、16 路无上限对比放行 8。 |
| [README.md](README.md) | 新增本节入口。 |
| [operational-compatibility-matrix.md](operational-compatibility-matrix.md) | 新增多 Session 争用行。 |

本项没有修改 `packages/` 或 `backend-v2.mjs`，因此不需要重建 artifacts 或 `build:check`。

## 证据

```sh
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/multi-session-contention.e2e.mjs
# 收紧预算：
DSH_POC_CONTENTION_SCALES=1,8 DSH_POC_CONTENTION_SAMPLES=2 \
DSH_POC_CONTENTION_TURN_BUDGET_MS=5000 DSH_POC_CONTENTION_HEAP_BUDGET_MB=256 \
node docs/drafts/browser-native-dsh-poc/tests/multi-session-contention.e2e.mjs
```

Chrome 156.0.8078.79 输出（节选）：

```json
{"result":"passed","browser":"156.0.8078.79","scope":"multi-session-contention-and-fairness",
 "scales":[
  {"sessions":1,"coldMs":{"median":2225,"max":2511,"attempts":[1,1,1]},"coldBootFailures":[],
   "turnMs":{"median":257,"p95":258,"max":258,"min":249,"coefficientOfVariation":0.0157},
   "renderedMs":{"median":259,"p95":260},"taskDurationMs":{"median":107.656,"p95":110.832},
   "pageHeapBytes":{"median":46659016,"max":46660544},
   "cpuPercentOfOneCore":[114.96,163.28,116.15],"cpuWallMs":[267,258,270]},
  {"sessions":8,"coldMs":{"median":5353,"max":7482},"coldBootFailures":[],
   "turnMs":{"median":615,"p95":757,"max":792,"min":532,"coefficientOfVariation":0.1119},
   "taskDurationMs":{"median":135.513,"p95":173.597},
   "pageHeapBytes":{"median":46718150,"max":46730712},
   "cpuPercentOfOneCore":[445.52,507.48,476.86],"cpuWallMs":[811,653,642]},
  {"sessions":16,"coldMs":{"median":13784,"max":14028},"coldBootFailures":[],
   "turnMs":{"median":1694,"p95":1824,"max":1839,"min":1335,"coefficientOfVariation":0.0952},
   "taskDurationMs":{"median":182.847,"p95":244.825},
   "pageHeapBytes":{"median":46674318,"max":46777528},
   "cpuPercentOfOneCore":[580.49,527.92,556.47],"cpuWallMs":[1507,1866,1834]}],
 "queueComparison":{"queueWidth":8,"capped":{"sessions":16,
   "turnMs":{"median":892,"p95":1154,"max":1195,"min":527,"coefficientOfVariation":0.1987},
   "cpuPercentOfOneCore":[516.29,414.18,454.73],"cpuWallMs":[1450,2262,2072]}},
 "budgetViolations":[]}
```

## 限制

只在单台 macOS 开发机、headless Chrome 156、单进程 scripted backend 上采样；LLM 响应确定，工具耗时固定，CPU 用量包含浏览器全部进程而不是单一 Worker。turn 延迟用 100 ms 轮询 Session 尾部测量，含最多约 100 ms 的轮询粒度；不是网络或 provider 延迟。16 路冷启动出现过一次 3/48 的首次 boot 失败，正式采样的这一轮为 0/48，因此失败率没有被表征，只记录了「可重载恢复」。未覆盖真实模型、不同工具耗时、有头模式、Windows/Linux、Safari、跨设备、多实例 backend，也未覆盖超过 16 路的规模；并发上限应按发布机型与真实工具耗时重测。
