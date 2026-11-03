---
description: "验证预热 Host Worker 能否缩短 Browser-Native PoC 的 2.3 秒冷启动，给出阶段拆解、实测收益、内存与复杂度代价，以及 boot payload 预取被拒的原因。"
---

# 冷启动预热

## Summary

[冷启动预热](tests/cold-start-prewarm.e2e.mjs)对比两种启动：基线按现有顺序在 workspace source 解析后创建 Worker；预热在 `bootStart` 立即创建 Worker 并跑运行时 probe，再把已 probe 的 Worker 接到 `connectWorkerHost`。两种模式使用同一 scripted backend、同一 profile、每个样本新建 durable Workspace。

结论是预热几乎没有收益。基线 `synced` 中位数 2,230 ms，预热 2,176 ms，只差 54 ms（约 2.4%，落在 10%–20% 的运行间噪声内）；在 1.5 秒模拟选择停顿下，基线 3,692 ms、预热 3,805 ms，预热反而慢 113 ms。预热只把选择之后的路径缩短约 14 ms，因为 `chooseWorkerHostSource` 在 0.1–0.7 ms 就返回，Worker 创建本来就在关键路径第 2 毫秒。

真正的 2.3 秒不在可预热区间。阶段标记显示：`bootStart` → `sourceChosen` 约 0.2 ms，→ `workerProbed` 约 105 ms，→ `hostConnected` 约 545–560 ms，→ 合成器就绪与 Workspace `synced` 约 2,230 ms。也就是说约 1.67 秒发生在 `connectWorkerHost` 之后，是客户端树装配与 Workspace 同步，预热 Worker 无法触及。

boot payload 预取同样被拒。preview 静态资源由 `serveStatic` 统一返回 `cache-control: no-store`（[backend-v2.mjs](backend-v2.mjs)），且 9.8 MB 的 `vfs-image.tar.gz` 由 Worker 通过自己的 tunnel 读取；页面侧 `fetch` 无法填充可复用的 HTTP 缓存，只会重复一次 I/O。

## 阶段拆解

| 阶段 | 基线（中位数） | 预热（中位数） | 说明 |
| --- | --- | --- | --- |
| `bootStart` → `sourceChosen` | 0.2 ms | 0.5 ms | `preview-fixture=none` 时 `choosePreviewSource` 立即返回，没有 overlay 待选 |
| `sourceChosen` → `workerProbed` | 105 ms | 105 ms | Worker 构造 + 运行时 probe（OPFS、outbox、health/config） |
| `workerProbed` → `hostConnected` | 约 440 ms | 约 440 ms | tunnel init、9.8 MB image 读取、boot payload 与注入表 |
| `hostConnected` → `synced` | 约 1,670 ms | 约 1,670 ms | 客户端树装配、composer 就绪与 Workspace 同步 |
| `synced` 总计 | 2,230 ms | 2,176 ms | 差 54 ms，属噪声 |

`workerSpawned` 在基线中是 `sourceChosen` 之后的第一个同步标记，在预热中提前到 `bootStart` 后约 2 ms；两者到 `workerProbed` 的距离都是约 105 ms，说明预热只是把同一段 probe 提前，并没有与任何页面侧工作重叠。

## 判定

- 预热 Worker 不是有效杠杆：可选窗口只有约 13 毫秒（`sourceChosen` 0.2 ms 到基线开始构造 Worker），而 Worker 构造与 probe 约 105 ms，重叠后仍无法缩短 `hostConnected`。
- 1.5 秒“用户选择时间”不会扩大窗口：workspace 选择对话框出现在客户端树装载之后，此时 `synced` 已经发生，停顿只增加端到端时间，不产生可重叠区间。
- 预取 boot payload 无效：静态资源 `no-store`，Worker 走 tunnel 自有读取路径，页面预取不会命中任何共享缓存。
- 真正的优化目标在 `hostConnected` 之后：约 1.67 秒用于客户端树装配与 Workspace 同步，需要的是减少注入表体积、并行化 bundle 装载或加速 Workspace 恢复，而不是预热。
- 默认不启用预热。`browser-native-prewarm=1` 只作为可复现实验开关保留在 PoC preview 中；产品路径不做此改动。

## 代价

| 代价 | 实测 | 说明 |
| --- | --- | --- |
| 内存 | 无可测增量 | 预热与基线在同一时刻都已持有约 41.4 MB page 堆与 38.0 MB Worker 堆；Worker 仅提前约 11 ms 存在 |
| 关键路径 | 无收益 | probe 仍在 `hostConnected` 前完成，只是换到更早的位置 |
| 复杂度 | 多一个实验开关与一层 spawn/prepare 拆分 | 若不启用开关，行为与原先一致；`pagehide` 与取消路径仍走同一 `worker?.terminate()` |
| 失效语义 | 不变 | probe 失败仍在 `connectWorkerHost` 之前抛出，启动门保持 fail closed |

## 实现

| 位置 | 变更 |
| --- | --- |
| [apps/web/src/preview.ts](../../../apps/web/src/preview.ts) | 拆出 `spawnBrowserNativeWorker` 与 `prepareBrowserNativeWorker`；新增 `browser-native-boot-timings=1` 阶段标记与 `browser-native-prewarm=1` 实验开关。 |
| [tests/cold-start-prewarm.e2e.mjs](tests/cold-start-prewarm.e2e.mjs) | 基线/预热 × 0 ms/1500 ms 选择停顿 × 3 样本，测量 `synced`、阶段拆解、选择期堆与回归断言。 |
| [README.md](README.md) | 新增本节入口。 |
| [operational-compatibility-matrix.md](operational-compatibility-matrix.md) | 新增预热行。 |

preview 变更只影响 PoC 的 preview 入口；未触及 `packages/`、profile、Session 格式或 Agent Loop。

## 证据

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
node docs/drafts/browser-native-dsh-poc/tests/cold-start-prewarm.e2e.mjs
```

Chrome 156.0.8078.80 输出（节选）：

```json
{"result":"passed","scope":"cold-start-prewarm","samplesPerCell":3,
 "cells":[
  {"delayMs":0,"mode":"baseline","medianComposerMs":2229,"medianSyncedMs":2230,
   "medianPostSelectionMs":559.4,"medianProbeMs":105.0,"medianOverlapMs":105.1},
  {"delayMs":0,"mode":"prewarm","medianComposerMs":2176,"medianSyncedMs":2176,
   "medianPostSelectionMs":545.5,"medianProbeMs":105.5,"medianOverlapMs":105.0},
  {"delayMs":1500,"mode":"baseline","medianComposerMs":3691,"medianSyncedMs":3692,
   "medianPostSelectionMs":544.8,"medianProbeMs":107.1,"maxMidSelectionHeapBytes":79464284},
  {"delayMs":1500,"mode":"prewarm","medianComposerMs":3804,"medianSyncedMs":3805,
   "medianPostSelectionMs":532.5,"medianProbeMs":102.2,"maxMidSelectionHeapBytes":79472752}],
 "verdicts":[
  {"delayMs":0,"baselineSyncedMs":2230,"prewarmSyncedMs":2176,"gainMs":54,
   "baselinePostSelectionMs":559.4,"prewarmPostSelectionMs":545.5},
  {"delayMs":1500,"baselineSyncedMs":3692,"prewarmSyncedMs":3805,"gainMs":-113,
   "baselinePostSelectionMs":544.8,"prewarmPostSelectionMs":532.5}]}
```

harness 断言：每个样本 `bootStart`/`sourceChosen`/`hostConnected` 标记齐全；基线中 `workerSpawned` 必须晚于 `sourceChosen`，预热中必须早于；每个单元的 `synced` 中位数必须低于 `DSH_POC_PERF_COLD_BUDGET_MS`（默认 60 秒）；预热不得比基线慢超过 150 ms；预热的选择后路径必须短于基线。

## 限制

- 只在单台 macOS、headless Chrome 156、scripted backend 上采样，未覆盖真实模型、网络延迟、Windows/Linux、Safari 与低端设备。
- “1.5 秒选择停顿”是模拟值，不是真人分布；由于对话框出现在 `synced` 之后，该模拟只影响端到端时间，不影响预热窗口。
- 阶段标记覆盖到 `hostConnected`，`connectWorkerHost` 内部的 image 读取与注入表细分未插桩；1.67 秒的客户端装配与 Workspace 同步也没有子阶段。
- 未测把 probe 与 `connectWorkerHost` 并行是否安全；那会破坏“probe 失败必须在 boot 前 fail closed”的顺序保证，因此没有实现。
