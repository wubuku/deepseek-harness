---
description: "长转录渲染成本与主线程占用：50/150/300 turns 的滚动、DOM 与 12k 字符流式追加曲线和虚拟化触发阈值。"
---

# 长转录渲染成本与主线程占用

## Summary

[long-transcript-rendering.e2e.mjs](tests/long-transcript-rendering.e2e.mjs) 在真实 Chrome 156.0.8078.79、1440×1000 视口下用真实 composer 跑 300 个 scripted turn，在 50/150/300 turns 三个检查点测量 DOM 规模、一次 20 步全文滚动的 `TaskDuration`/`ScriptDuration`/`LayoutDuration`、`PerformanceObserver` 长任务，以及一条 12,000 字符助理消息分两段流式追加的成本。UI 没有虚拟化：300 turns 时 1,200 个 flow item、300 个 assistant step、15,830 个 DOM 节点、73,485 可见字符全部在文档里。

可判定结论：**滚动在 300 turns 内仍可接受**（20 步总主线程 423.5 ms、约 21 ms/步，没有超过 50 ms 的长任务，最大帧间隔 76.4 ms）；**流式追加是最先恶化的路径**（150 turns 时主线程 391 ms、0 个长任务；300 turns 时 909.6 ms、8 个长任务共 476 ms、最长 80 ms，单帧间隔 695 ms）。因此把**必须引入转录虚拟化的触发线定在 300 turns / 约 16,000 DOM 节点 / 约 75,000 可见字符**：再翻一倍时按 150→300 的 2.3 倍增长，长任务会越过 100 ms 的单任务预算。

本批按该触发线做了一次最小修复：把流式追加的尾部落地从 commit 内的同步测量改为由 `ResizeObserver` 在 layout 之后落地，同一 harness 下 300 turns 追加的长任务从 8 个/476 ms 降到 1 个/73 ms、单帧 695.4 → 629.1 ms，详见[流式追加性能修复](#流式追加性能修复)。虚拟化本身仍未实现。

## 测量方法

- 滚动：找到 `overflow-y: auto|scroll` 且溢出最大的元素作为转录滚动容器，先从底部滚到顶部再滚回底部；每步等待两个 `requestAnimationFrame`，用 CDP `Performance.getMetrics` 的累计值计算整段差值（秒转毫秒）。
- 长任务：页面内 `PerformanceObserver({ entryTypes: ['longtask'] })`，每个检查点前清空，读 count/totalMs/longestMs。
- DOM 规模：`document.getElementsByTagName('*').length`、`[data-chat-flow-kind]`、`assistant-step` 数量与 `body.innerText` 长度。
- 流式追加：`sendTurn` 的 `captureStream` 逐帧记录 assistant-step 文本变化；120 ms 延迟后写入后半段，模拟两段流式到达。
- 预算：长任务 ≤ 100 ms、20 步滚动 ≤ 800 ms、DOM ≤ 60,000 节点；超预算先写 JSON 再断言。

## 滚动与 DOM 曲线

| turns | DOM 节点 | flow items | assistant steps | 可见字符 | 20 步滚动主线程 | Script | Layout | 长任务（>50 ms） | 最大帧间隔 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 50 | 3,080 | 200 | 50 | 12,581 | 124.7 ms | 21.9 ms | 1.1 ms | 0 | 38.8 ms |
| 150 | 8,180 | 600 | 150 | 36,885 | 195.0 ms | 28.1 ms | 1.6 ms | 0 | 52.6 ms |
| 300 | 15,830 | 1,200 | 300 | 73,485 | 423.5 ms | 74.6 ms | 2.6 ms | 0 | 76.4 ms |

每 150 turns 大约翻倍 DOM（3.1k → 8.2k → 15.8k），滚动主线程成本约 2.2 倍增长，但仍低于 50 ms/步且没有长任务。滚动不是当前瓶颈：布局成本始终在 3 ms 以内，增量主要是脚本（事件处理与响应式更新）。

## 流式追加成本

| 检查点 | 追加字符 | 主线程总耗时 | Script | Layout | 新增 DOM | 长任务数 | 长任务总时长 | 最长长任务 | 最大帧间隔 | turn 总时长 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 150 turns | 12,000 | 391.0 ms | 66.7 ms | 9.6 ms | 47 | 0 | 0 ms | 0 ms | 310.7 ms | 411 ms |
| 300 turns | 12,000 | 909.6 ms | 131.4 ms | 17.4 ms | 43 | 8 | 476 ms | 80 ms | 695.4 ms | 736 ms |

同一条消息的追加成本随历史规模恶化：主线程 391 → 910 ms（2.3×），并首次出现 8 个长任务；追加后再次滚动是 179.8 ms、最大帧 73.6 ms，没有回到长任务。用户在 300 turns 时追加这段流式文本会感到明显停顿（单帧 695 ms），但仍低于 100 ms 的单任务预算。

## 可接受上限与触发线

- **可接受**：≤ 150 turns（≤ 8,200 DOM 节点、≤ 37,000 可见字符）的会话，滚动与 12k 字符流式追加都没有长任务；这是当前 UI 的“无感”区间。
- **可用但降级**：150–300 turns。滚动仍无长任务，但长消息流式追加已产生 80 ms 长任务与 0.7 s 单帧；应避免在该区间播放超长流式文本。
- **必须虚拟化**：≥ 300 turns、或 DOM ≥ 16,000、或可见字符 ≥ 75,000、或任意单条消息流式追加出现 > 100 ms 长任务。理由是按 150→300 的 2.3 倍增长，600 turns 时的长任务会越过 100 ms 的单任务预算；触发线放在 300 turns 留出约一倍余量。
- **建议的浏览器端策略**：先做“已结算 turn 折叠/分页”（保留最近 N 个 turn 的完整转录，更早的折叠为摘要行），再考虑窗口化虚拟列表；虚拟化需要保留 `data-chat-flow-kind` 语义与滚动锚点，否则会破坏现有测试与工具卡片定位。

## 流式追加性能修复

修复前的追加路径在 React layout effect 里同步测量：`processContent` 对每次内容增长调用 `ChatViewport.scrollToBottom()`，后者在 DOM 变更之后读取 `clientHeight`/`scrollHeight` 才能知道尾部，这次读取强制一次全文档布局。300 turns、15.8k 节点时单次强制布局约 15–40 ms；一次 12,000 字符追加共有 12 次这样的读取（对应 tracing 里 16 次 `Layout`、约 200 ms）。`scrollToBottom` 自身还重复测量：`metrics()`、`reclaimBelow()` 内部的 `readScroll()`、落地前的 `scrollMetrics()` 各一次。

两处改动都在 `packages/client/ui-chat`：

- `use-chat-viewport.ts` 的 `scrollToBottom` 改为先 `reclaimBelow()`、再测量一次。`reclaimBelow()` 可能写回底部空间，落地必须在它之后测量；它之前那次 `metrics()` 只用于更新 `observation`，现由落地结果统一写入。
- `use-chat-scroll.ts` 的 `processContent`：`running` 不变且 `lastKey` 变化的流式增长、且已跟随尾部时，commit 不再同步落地，改由已有的 `ResizeObserver` 在当帧 layout 之后落地。观察者在 layout 之后回调，几何已是最新，读取不再触发第二次布局；同一帧内的多次 commit 也只产生一次尺寸变化，等于把追加落地合并成每帧一次。`Viewport.observesLayout` 为假的环境（无 `ResizeObserver`）保留同步落地；`running`、就绪状态与历史 prepend 不满足该条件，仍走原来的同步落地。

对照测量交替构建修复前后版本（源文件 `git stash` → `build:artifacts` → `build:preview`），同一 300 turns 转录各跑多次，用 CDP tracing 与 Profiler 聚合：

| 指标（300 turns，12,000 字符两段追加） | 修复前（4 次） | 修复后（3 次） |
| --- | --- | --- |
| turn 总时长（中位数） | 538 ms | 454 ms |
| 主线程 `TaskDuration`（中位数） | 865 ms | 741 ms |
| `Layout` 次数 / 总时长（中位数） | 16 / 198.5 ms | 13 / 155.2 ms |
| `UpdateLayoutTree` 次数 / 总时长（中位数） | 27 / 198.5 ms | 25 / 160.3 ms |
| 长任务数（> 50 ms） | 4–5（单次 3–7） | 1（单次 1–2） |
| 长任务总时长（中位数） | 261 ms | 96 ms |
| 单帧最大间隔（中位数） | 487 ms | 450 ms |

同一修复在[长转录渲染](tests/long-transcript-rendering.e2e.mjs)的原 harness 下复测 300 turns：追加主线程 909.6 → 787.4 ms，长任务 8 个/476 ms/最长 80 ms → 1 个/73 ms，单帧 695.4 → 629.1 ms，turn 736 → 637 ms；滚动检查点与页面错误仍为 0。

没有采用另外两种候选：

- **阈值虚拟化（`content-visibility: auto` + `contain-intrinsic-size`）**：在 150 turns 的追加里反而更慢（主线程 759 ms、`UpdateLayoutTree` 470 次），追加期间可见性切换本身触发大量样式重算；`contain: layout paint` 在 300 turns 只把长任务降到 4 个/240 ms，单次约 41 ms 的全文档布局仍在。
- **rAF 合并追加**：测试里的两段追加相隔 120 ms，不落在同一帧；真正可合并的是同一帧内的多次 commit 落地，交给 `ResizeObserver` 即可，不需要额外的事件循环。

剩余瓶颈是列上的昂贵选择器（`ChatView.module.css` 的 `:nth-last-child(2 of :not(...):has(...))`）：每次 DOM 变更仍触发全列样式重算，`UpdateLayoutTree` 仍有 25 次、约 160 ms。要把单次布局从约 15 ms 降到 1 ms 量级，仍需“已结算 turn 折叠/窗口化”，触发线见上一节。

复跑：

```sh
pnpm run build:artifacts && pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome DSH_POC_RENDER_TURNS=300 node docs/drafts/browser-native-dsh-poc/tests/long-transcript-rendering.e2e.mjs
```

表格里的 tracing/Profiler 采样用一次性脚本完成，未提交；可比指标（主线程、长任务、单帧）来自上面这条命令。

## 测试基础设施修正

初版 harness 在 turn 255 前后超时：`submitPrompt` 从 `offset: 0` 轮询整段 Session，而 backend 的读页有字节预算（见[会话规模曲线](session-scale-curve.md)），历史超过一页后最新 `turn/end` 不在返回页里，轮询永远看不到终态。这正是点 1 引入的读页预算在测试侧的暴露，不是 UI 缺陷。修正为 `readTail`：先读 `offset: 0` 取 `nextSeq`，再读最后 64 个事件，并用事件 `seq` 而不是数组下标判断用户消息与终态；修正后 300 turns 正常完成，[模型流断开与重连](llm-network-interruption.md) 的 harness 也复跑通过。

## 证据

```json
{"result":"passed","browser":"chrome","checkpoints":[150,300],"viewport":{"width":1440,"height":1000},
 "budgets":{"longTaskMs":100,"domNodes":60000,"scrollBurstMs":800,"scrollSteps":20},
 "turns":{"completed":300,"medianMs":686,"maxMs":1392},
 "measurements":[{"label":"150-turns","dom":{"nodes":8180,"flowItems":600,"assistantSteps":150,"textLength":36885},
   "scroll":{"taskMs":195.0,"scriptMs":28.1,"longTasks":{"count":0,"longestMs":0},"maxFrameMs":52.6}},
  {"label":"300-turns","dom":{"nodes":15830,"flowItems":1200,"assistantSteps":300,"textLength":73485},
   "scroll":{"taskMs":423.5,"scriptMs":74.6,"longTasks":{"count":0,"longestMs":0},"maxFrameMs":76.4}}],
 "longAppend":{"appendedCharacters":12000,"deltaNodes":43,"taskMs":909.6,"scriptMs":131.4,"layoutMs":17.4,
   "longTasks":{"count":8,"totalMs":476,"longestMs":80},"maxFrameMs":695.4,"turnMs":736},
 "afterLongScroll":{"scroll":{"taskMs":179.8,"longTasks":{"count":0,"longestMs":0},"maxFrameMs":73.6}},
 "pageErrors":[],"nonLocalRequests":[],"failures":[]}
```

复跑：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js \
  node docs/drafts/browser-native-dsh-poc/tests/long-transcript-rendering.e2e.mjs
```

检查点与预算可用 `DSH_POC_RENDER_TURNS`、`DSH_POC_RENDER_SCROLL_STEPS`、`DSH_POC_RENDER_LONG_TASK_BUDGET_MS`、`DSH_POC_RENDER_DOM_BUDGET`、`DSH_POC_RENDER_SCROLL_BURST_MS`、`DSH_POC_RENDER_LONG_STREAM_CHARS` 覆盖。

## 限制

- 模型响应由 scripted 后端生成，turn 间隔中位数 686 ms 包含测试轮询节奏，不代表真实模型的流式速率或 token 分布。
- 流式追加只有两段（前缀 + 120 ms 后的后缀），不是真实 token 级高频 delta；真实 provider 的小 chunk 高频追加可能更容易触发更多小任务。
- 只测桌面 1440×1000 视口，没有移动端、缩放、系统字体回退或辅助功能树的影响。
- 没有测量滚动锚点、搜索跳转、折叠状态或工具卡片展开的额外成本，也没有做真实 `requestAnimationFrame` 掉帧统计。
- 300 turns 结束后才做长追加；没有测更长历史（600/1000 turns），虚拟化触发线是外推而非实测。
