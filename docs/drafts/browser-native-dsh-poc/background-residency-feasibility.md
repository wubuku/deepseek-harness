---
description: "探测 Service Worker 与 Background Sync 能否在标签关闭后维持或接管 Browser-Native DSH Agent 循环，并据此判定产品是否需要服务端常驻 host。"
---

# 后台常驻可行性

## Summary

[background-residency-probe.e2e.mjs](tests/background-residency-probe.e2e.mjs) 在 Chrome 156.0.8078.79 中注册独立 Service Worker，探测它能否承载现有 DSH Host 与 Agent 循环。结论是不可承载，也无可保证的后台推进：Service Worker 没有 DOM、没有 `Worker` 构造器、OPFS 上没有 `createSyncAccessHandle`，浏览器可随时 `stopAllWorkers` 且不会在重开后恢复中断作业。

可做的部分成立：短小的异步作业在标签关闭后可以继续，本次三次运行都在零 window client 下完成四步作业；Background Sync 受支持，离线注册、关页、恢复在线后以 `clients=0` 启动并完成事件。但同一 harness 的早期运行出现过作业在关页后冻结、直到新页面打开才继续，因此后台推进是可能而非保证。

产品结论：需要跨标签关闭存活的 Agent turn 仍要求服务端常驻 host；Service Worker 最多承担短的、幂等的后台任务和 Background Sync 唤醒。

## 能力探测

| 能力 | 结果 | 对 Agent 循环的影响 |
| --- | --- | --- |
| `self.document` | 不存在 | 现有 Host/runtime 与页面投影无法实例化 |
| `self.Worker` | 不是构造器 | 不能把 Agent 循环下沉到 Dedicated Worker |
| `FileSystemSyncAccessHandle` | 未定义 | 现有 Workspace VFS 的同步写路径不可用 |
| OPFS 异步写 | 成功（`sw-opfs\n`） | 只能走异步 OPFS，需要另一套存储实现 |
| Web Locks | 可用 | 可以表达跨上下文互斥，但不提供生命周期保证 |
| `crossOriginIsolated` | false | 本探测页面未启用 COOP/COEP，隔离能力见后续批次 |

## 语义决策

| 问题 | 决定 | 理由 |
| --- | --- | --- |
| Service Worker 能否承载现有 DSH Agent 循环 | 否 | 缺少 DOM 与 `Worker` 构造器，且 Workspace 同步写路径依赖 sync access handle；重写等价运行时不在本批范围。 |
| 标签关闭后 Agent turn 是否继续 | 不能依赖 | 短作业可能完成，也可能冻结直到客户端重开；Agent turn 通常持续更久，无法给出完成保证。 |
| 浏览器主动停止 Worker 后是否恢复 | 否 | `ServiceWorker.stopAllWorkers` 后作业停在 2/12 步，重开页面步数不增长；内存态作业没有持久检查点。 |
| Background Sync 的角色 | 只用于短小、幂等、可重放的唤醒事件 | 事件在零客户端下可完成，但它是一次性投递，不持有 Agent 所有权或会话状态。 |
| 产品是否需要服务端常驻 host | 需要 | 关页后仍须推进或收敛的 turn 必须由服务端持有；浏览器只作为前端与短任务执行面。 |
| 关闭标签与刷新/崩溃的差异 | 关页即终止推进；刷新与 Worker 崩溃可在重新挂载时结算 | 刷新和崩溃有同页或新页的重新挂载路径，见[刷新与崩溃结论](reload-crash-recovery-validation.md)。 |

## 实现

| 位置 | 变更 |
| --- | --- |
| [background-residency-probe.e2e.mjs](tests/background-residency-probe.e2e.mjs) | 独立 harness 页面 + Service Worker：能力探测、三次关页短作业、CDP 停止全部 Worker、离线注册 Background Sync 后关页并恢复在线。 |
| [README.md](README.md) | 新增本节入口与结论。 |
| [operational-compatibility-matrix.md](operational-compatibility-matrix.md) | 新增后台常驻能力行。 |

harness 页面与 Service Worker 写入临时 dist 副本，不修改 preview 的默认 profile，也不改动正式 Agent Loop、Session 格式或服务端代码。

## 证据

```sh
node docs/drafts/browser-native-dsh-poc/tests/background-residency-probe.e2e.mjs
```

Chrome 156.0.8078.79 输出：

```json
{"result":"passed","browser":"156.0.8078.79","scope":"service-worker-background-residency",
 "serviceWorker":{"scope":"http://127.0.0.1:59783/","state":"activated"},
 "capabilities":{"hasDocument":false,"hasWorkerConstructor":false,
  "hasSyncAccessHandleConstructor":false,"syncAccessHandleOnFileHandle":"undefined",
  "opfsAsyncText":"sw-opfs\n","hasWebLocks":true,"crossOriginIsolated":false},
 "backgroundSyncSupported":true,
 "tabCloseRuns":{"runs":3,"completed":3,"completedWhileClosed":3,"frozenUntilReopen":0,
  "detail":[{"id":"short-after-close-0","steps":4,"completedWhileClosed":true,
   "stepsStrictlyBeforeReopen":4,"completedAtMsAfterClose":2160,
   "reopenedAtMsAfterClose":10108,"firstStepMsAfterClose":597},
   {"id":"short-after-close-1","steps":4,"completedWhileClosed":true,
   "stepsStrictlyBeforeReopen":4,"completedAtMsAfterClose":2025,
   "reopenedAtMsAfterClose":10117,"firstStepMsAfterClose":514},
   {"id":"short-after-close-2","steps":4,"completedWhileClosed":true,
   "stepsStrictlyBeforeReopen":4,"completedAtMsAfterClose":2065,
   "reopenedAtMsAfterClose":10138,"firstStepMsAfterClose":510}]},
 "browserStop":{"stepsBeforeStop":2,"expectedSteps":12,"completed":false,"resumedAfterReopen":false},
 "backgroundSyncAfterTabClose":{"tag":"dsh-residency-sync-…","registered":{"tag":"…","supported":true},
  "startDelayMsAfterClose":100,"clientsAtStart":0,"completed":true,"steps":3},
 "verdict":{"canHostDshAgentLoopInServiceWorker":false,
  "blockers":["no DOM or Dedicated Worker constructor, so the existing host/runtime cannot be instantiated",
   "OPFS sync access handles are unavailable, so the current Workspace VFS write path cannot run",
   "an in-memory Service Worker job completes after a tab close only in some runs; in other runs it is frozen until a client reopens, so background progress is not guaranteed",
   "the browser can stop all Workers at will and does not resume unfinished jobs on reopen",
   "Background Sync only delivers discrete events and provides no durable Agent loop ownership"],
  "recommendation":"A browser-native product still needs a server-resident host for Agent work that must outlive the tab; a Service Worker can at most run short, idempotent background jobs and wake on Background Sync."}}
```

- 能力探测：`hasDocument=false`、`hasWorkerConstructor=false`、`syncAccessHandleOnFileHandle="undefined"`，OPFS 异步写成功，Web Locks 存在。
- 三次关页：作业都在零 window client 下完成，`completedAtMsAfterClose` 为 2.0–2.2 秒，`stepsStrictlyBeforeReopen` 均为 4。
- 同一 harness 的早期运行记录到相反结果：关页后 12 秒内没有任何 `job-step`，第一步出现在新页面打开后 3 ms，说明后台推进会冻结；因此本结论只声明“可能完成”，不声明“保证完成”。
- 主动停止：`ServiceWorker.stopAllWorkers` 后只有 2/12 步，`job-done` 缺失；重开页面步数不增长。
- Background Sync：离线注册后关闭标签并恢复在线，事件在关页后 100 ms 以 `clients=0` 启动，3 步全部完成。

## 限制

harness 作业只有数秒，不能代表分钟级的 Agent turn、模型流或长时间工具；`stopAllWorkers` 是 CDP 主动注入，不是自然空闲回收；Background Sync 依赖 Chrome 的网络状态通知，离线用 Playwright 网络模拟而非物理断网。未覆盖：周期性 Background Sync、`waitUntil` 边界、SW 在 30 秒空闲后的自然终止、持久化作业检查点、真实模型下的 Agent turn、Safari/WebKit、以及启用 CSP/COOP/COEP 后的 Service Worker 行为（隔离与安全见后续批次）。
