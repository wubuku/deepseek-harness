---
description: "Browser-Native PoC 在 16 个持久化 Session 下的仪表盘渲染与交互成本，以及 idle/Completed/排队/失败态的实际呈现方式。"
---

# 16 Session 下的仪表盘 UI 验证

本记录验证会话侧边栏（仪表盘）在 16 个已持久化 Session 下的可读性与交互成本：首屏列表、折叠展开、打开、切换、后台 turn 进行中切换，以及失败后的列表可用性；同时记录排队与状态标签实际如何呈现。

## 运行位置与配置

`tests/session-dashboard-16.e2e.mjs` 通过后端 `session/create` + `append` + `close` 预置 `dashboard-session-00..15`，每个 Session 一条 `user/message`（文本 `DASHBOARD_SESSION_NN`），创建后立即 `close` 释放 16 挂载槽。随后 reload 真实 preview（真实 Dedicated Worker、DSH Host、Session 持久化），在 17 行（16 种子 + preview 自身 Session）规模下测量 DOM 交互。

scripted 后端固定四类请求：`DASHBOARD_HOLD` 用 `barrier-text` 占住唯一 admission 槽；`DASHBOARD_QUEUE_HEAD` 与直连的 `DASHBOARD_QUEUE_TAIL` 用 `delayed-text` 占槽 3 秒；`DASHBOARD_FAIL` 返回 `DASHBOARD_INJECTED_FAILURE`。admission 为 `maxConcurrentTurns: 1`、`queueTimeoutMs: 25_000`。直连请求不带 Session，只用于在队列里占据本 prompt 之前的位置，避免第二个 preview tab 自身启动时的模型请求干扰队列。

## 时延证据

运行输出：

```json
{
  "scope": "browser-session-dashboard-16",
  "sessions": 16,
  "rows": 17,
  "timings": { "reloadMs": 4851, "listMs": 2, "expandMs": 94, "openMs": 65, "switchMs": 79, "switchDuringTurnMs": 72, "postFailureMs": 49 },
  "acceptableLimits": { "reloadMs": 8000, "listMs": 1500, "expandMs": 1500, "openMs": 3000, "switchMs": 1000, "switchDuringTurnMs": 2000, "postFailureMs": 1500 },
  "states": {
    "failureVisible": true,
    "failureRenderedBy": "Tag",
    "listInteractiveAfterFailure": true,
    "idleRowsWithoutStatus": true,
    "backgroundCompletionStatus": "CompletedDASHBOARD_SESSION_15now",
    "queueNotice": {
      "second": "Waiting for a model slot · position 2 of 2 · 1/1 active",
      "advanced": "Waiting for a model slot · position 1 of 1 · 1/1 active",
      "positionChange": "2 -> 1"
    },
    "queueStateInList": "not surfaced in the dashboard; queued prompts render in the active composer"
  }
}
```

- `reloadMs` 是整页 reload 到 preview 可交互，约 4.9 秒，由 Worker 冷启动主导（与[冷启动拆解](cold-start-prewarm.md)的量级一致），不是列表渲染成本；上限取 8 秒。
- `listMs` 是在 preview 可交互后到首屏 5 行出现的增量，本次为 2 ms：17 行列表已在可交互前完成，未形成额外阻塞。
- 折叠展开 94 ms、打开 65 ms、切换 79 ms、后台 turn 运行中切换 72 ms、失败后切换 49 ms，均在对应上限内，无需修改列表 UI 代码。

## 状态与交互的实际情况

- **默认折叠**：17 行只渲染 5 行，并显示 `Show N more sessions` 按钮；脚本逐批点击直到按钮消失，展开后 17 行全部存在。这是既有的折叠设计，不是渲染缺陷。
- **标题**：种子 Session 在列表加载时没有 `session/title` 投影，显示本地化的 `Untitled`；`list` 快照只含 header/revision/eventCount，不返回事件，所以标题不会在加载时从首条消息推导。真实 turn 之后该行标题会变成首条 `user/message` 文本（本次为 `DASHBOARD_SESSION_15`）。测试用 `data-row-key="session:<id>"` 定位行，不依赖标题文本。
- **idle 行无状态文案**：`sessionStatuses` 对 idle 只渲染空的首列占位（`showStatus` 仅在非 idle 时输出 `StateDot` 与 visually-hidden 文案）。种子行文本只有 `Untitled` 与时间。
- **后台 turn 完成后出现 `Completed`**：`dashboard-session-15` 的 turn 在查看另一个 Session 时完成，其行文本出现 `Completed`，随后打开该行即清除。
- **排队显示实时位置**：Worker 的 LLM 适配器在请求等待 admission 槽时每 400 ms 轮询同源 `/api/browser-native/admission`，按 `requestId` 匹配自己的队列项，并把位置变化发布到页面；页面用 `output[data-browser-native-queue-status]`（`role="status"`、`aria-live="polite"`、`aria-atomic="true"`）显示。本次断言了 `position 2 of 2` 在队列前项被准入后变为 `position 1 of 1`，即位次变化可见；同一断言还校验实时区域的三个属性。准入或被取消后该状态隐藏。排队的超时错误仍保留 `ADMISSION_TIMEOUT` 与 `queue position N` 文案。
- **失败态组件化**：`DASHBOARD_INJECTED_FAILURE` 通过既有 `Tag` 组件（danger 色调）渲染在 `[data-turn-error-code]` 容器内，附 `scripted dashboard failure` 文案；测试断言该错误码不再出现在裸 `<code>` 元素里。失败后列表仍有 17 行，点击其他行可在 49 ms 内切换。`pageerror` 为 0。

## 可接受上限

16 Session、折叠后 5 行首屏的仪表盘满足以下上限：reload ≤ 8 s、首屏增量 ≤ 1.5 s、展开 ≤ 1.5 s、打开 ≤ 3 s、切换 ≤ 1 s、后台 turn 中切换 ≤ 2 s、失败后切换 ≤ 1.5 s。以上为单机 Chrome 采样，不是产品 SLA。

## 残余缺口

- 排队位置是 400 ms 轮询的最终一致视图，不是推送；跨标签页的队列位置会在一个轮询周期内更新，且不显示预计等待时间。
- idle 行没有状态文案，`Completed` 仅在未查看时出现；没有覆盖 `Running`、`Waiting approval`、错误态在 16 行下的样式冲突。
- 只测 16 个 Session（后端挂载上限）与 17 行列表；未测 100+ 行折叠/滚动、分组工作区树或搜索态叠加。
- 只测单个 Chrome 桌面视口与 `en-US`；移动端窄宽度、Safari/WebKit、长标题截断未覆盖。
- `reloadMs` 包含 Worker 启动与 OPFS 恢复，受机器负载影响；本记录不把它当作列表性能指标。
