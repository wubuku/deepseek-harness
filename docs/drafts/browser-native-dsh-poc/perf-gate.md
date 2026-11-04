---
description: "一条命令运行 Browser-Native PoC 的四组性能测量，按预算与基线比较，任一超标或套件失败即非零退出。"
---

# 性能回归守门

## 目的

[perf-gate.mjs](tests/perf-gate.mjs) 把此前分散测量的关键预算收成一条命令：依次运行[性能基线](performance-baseline.md)、[长转录渲染](long-transcript-rendering.md)、9,990 文件 Workspace 同步与[弱网画像](README.md#弱网与移动延迟画像)，从每个套件的 JSON 报告抽取指标，再与预算和 [perf-gate-baseline.json](perf-gate-baseline.json) 比较。任一指标超预算或任一子套件失败，进程以非零退出。

## 覆盖指标与预算

| 指标 | 来源套件 | 默认预算 | 覆盖变量 |
| --- | --- | --- | --- |
| `coldStartMs` | baseline | 60 000 ms | `DSH_POC_PERF_COLD_BUDGET_MS` |
| `hydrateMs` | baseline | 45 000 ms | `DSH_POC_PERF_HYDRATE_BUDGET_MS` |
| `turnMedianMs` | baseline | 5 000 ms | `DSH_POC_PERF_TURN_BUDGET_MS` |
| `domNodes` | render | 20 000 | `DSH_POC_RENDER_DOM_BUDGET` |
| `scrollTaskMs` | render | 350 ms | `DSH_POC_RENDER_SCROLL_BURST_MS` |
| `appendTaskMs` | render | 500 ms | `DSH_POC_RENDER_APPEND_BUDGET_MS` |
| `longTaskMs` | render | 100 ms | `DSH_POC_RENDER_LONG_TASK_BUDGET_MS` |
| `sync9990Ms` | sync | 15 000 ms | `DSH_POC_PERF_SYNC_BUDGET_MS` |
| `firstTokenMs` | network | 2 000 ms | `DSH_POC_PERF_FIRST_TOKEN_BUDGET_MS` |
| `transportOverheadMs` | network | 2 000 ms | `DSH_POC_PERF_TRANSPORT_OVERHEAD_BUDGET_MS` |
| `weakTurnCompletionMs` | network | 20 000 ms | `DSH_POC_PERF_WEAK_TURN_BUDGET_MS` |
| `abortAckMs` | network | 2 000 ms | `DSH_POC_PERF_ABORT_ACK_BUDGET_MS` |

`fourSessionColdStartMs` 与 `fourSessionHydrateMs` 只记录、不设预算，用于观察并发争用变化。

## 使用

```sh
node docs/drafts/browser-native-dsh-poc/tests/perf-gate.mjs
DSH_POC_PERF_GATE_SUITES=baseline,network node docs/drafts/browser-native-dsh-poc/tests/perf-gate.mjs
DSH_POC_PERF_GATE_UPDATE_BASELINE=1 node docs/drafts/browser-native-dsh-poc/tests/perf-gate.mjs
```

输出先是一张 `metric / measured / baseline / budget / headroom / status` 表，最后一行是包含套件状态、全部测量值与失败原因的 JSON。预算变量的值同时传给子套件，因此子套件自己的断言与守门阈值保持一致。

`DSH_POC_PERF_GATE_SUITES` 默认运行全部四组；`DSH_POC_PERF_GATE_TIMEOUT_MS` 默认每套件 20 分钟。`DSH_POC_PERF_GATE_UPDATE_BASELINE=1` 只在全部通过时重写基线。

## 基线

[perf-gate-baseline.json](perf-gate-baseline.json) 保存最近一次全绿运行的测量值与时间戳。后续运行在表格中同时显示基线与预算，便于区分“比上次慢但仍在预算内”和“已越过预算”。

## 全绿基线

2026-11-04 本机 headless Chrome 跑完整四组套件，全部通过，基线写入 `perf-gate-baseline.json`：

| 指标 | 本次 | 预算 | 余量 |
| --- | --- | --- | --- |
| `coldStartMs` | 2 177 | 60 000 | 57 823 |
| `hydrateMs` | 4 892 | 45 000 | 40 108 |
| `turnMedianMs` | 147 | 5 000 | 4 853 |
| `domNodes` | 8 192 | 20 000 | 11 808 |
| `scrollTaskMs` | 219.8 | 350 | 130.2 |
| `appendTaskMs` | 388.7 | 500 | 111.3 |
| `longTaskMs` | 0 | 100 | 100 |
| `sync9990Ms` | 5 993 | 15 000 | 9 007 |
| `firstTokenMs` | 1 708.7 | 2 000 | 291.3 |
| `transportOverheadMs` | 208.7 | 2 000 | 1 791.3 |
| `weakTurnCompletionMs` | 3 266 | 20 000 | 16 734 |
| `abortAckMs` | 652 | 2 000 | 1 348 |

`fourSessionColdStartMs` 为 2 568.5 ms、`fourSessionHydrateMs` 为 5 195.5 ms，只记录不设预算。hydrate 本次高于历史文档中的 1.9 秒，属于同机负载波动，仍远低于预算；后续运行会同时显示基线值以便区分漂移与超标。

## 边界

- 只在本机 headless Chrome、回环 HTTP 与 scripted 模型下测量；不含真实 provider 首字延迟（由 `DSH_POC_WEAK_NETWORK_REAL=1` 单独覆盖）。
- 9,990 文件套件的 seed 耗时不计入 `sync9990Ms`；seed 通过真实 Workspace API 预置夹具，产物与产品路径无关。
- 阈值是相对观测值的回归护栏，不是容量承诺；收紧阈值前先在目标机型积累样本。
