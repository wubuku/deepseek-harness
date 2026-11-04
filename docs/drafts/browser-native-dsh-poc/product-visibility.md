# 产品可见性：失败分类、准入排队与 Session 租约冲突

本批验证用户能否在 preview 里看见三类此前只存在于协议或日志的状态：turn 的失败码、`ADMISSION_TIMEOUT` 的排队位置、同一 Session 在另一标签页被占用。可感知项保留并补测试；不可感知的 Session 租约冲突增加 `session-conflict` 状态。

## 失败分类

`turn/end` 的 `reason.kind === 'error'` 携带结构化 `{ code, message }`。正式 `packages/client/ui-chat` 的 `TurnErrorNodeView` 用既有 `Tag` 组件（danger 色调）渲染 `code`，容器带 `data-turn-error-code`，并显示 `message` 文本。backend 的 provider 错误映射（`UPSTREAM_LLM_AUTH_FAILED`、`RATE_LIMITED`、`UNAVAILABLE`、`TIMEOUT` 等）因此无需额外 UI 即可到达用户。

`tests/product-visibility.e2e.mjs` 用 `scriptedLlmFault` 注入 `UPSTREAM_LLM_AUTH_FAILED`，断言四层一致：`turn/end.reason.error.code`、`[data-turn-error-code]` 文本、`turn/end.reason.error.message`、DOM 消息文本。这是 scripted 注入，不是真实 provider 的 401。

## 准入排队位置

`admission-v2.mjs` 在 `ADMISSION_TIMEOUT` 触发时计算 `waiters.indexOf(waiter) + 1`，写入错误消息 `… (queue position N)` 与详情 `{ queuePosition }`，HTTP 状态 503，`retry-after` 为超时预算的四分之一。

preview 的行为分两段：

- 提交后 `user/message` 立即进入 Session，即使用户仍排在别的 turn 后面，自己的 prompt 已可见。
- 等待 admission 时，Worker 每 400 ms 轮询同源 admission 快照，在 `output[data-browser-native-queue-status]`（`aria-live="polite"`）上显示本地化位次；前项被准入后位次会前移，准入或取消后隐藏。
- 超时后 turn 以 `ADMISSION_TIMEOUT` 结束，UI 同时以 `Tag` 渲染代码并显示含 `queue position 1` 的消息。

E2E 把 `maxConcurrentTurns` 设为 1、`queueTimeoutMs` 设为 3 秒，用 `barrier-text` 固定 A 页的 turn，再让 C 页提交并等待超时。它断言排队中 prompt 已渲染、终止码、终止消息中的位置、组件化代码与位置文本。实时位次及位次前移的独立断言见[16 Session 仪表盘](session-dashboard-16.md)。

## Session 租约冲突

第二个标签页打开同一 Session 时，`session/open` 返回 `409 SESSION_ALREADY_OWNED`，provider 在约 5 秒重试窗口内重复失败。此前该标签页只落在一个空 Session，没有可见错误。

`browser-native-providers.ts` 在 `SESSION_ALREADY_OWNED` 或 owner 续租报告 `SESSION_OWNERSHIP_LOST` 时发布 workspace 状态 `session-conflict`，消息为 backend 原文。状态条显示英文/中文标题加 ` — <backend message>`，边框为红色；`preview.ts` 把该状态视为可继续运行的启动结果，标签页保持打开。

E2E 在同一个 `BrowserContext` 开 A/B 两页，断言 B 的 `[data-browser-native-workspace-status]` 进入 `data-state="session-conflict"`，文本同时包含 `This Session is open in another tab` 与 `session is already owned by another browser`。状态条提供一个 `button[data-browser-native-session-retry]`（本地化文案，点击后重载页面）；关闭 A 页后 B 页点击该按钮即可重新打开 Session，E2E 断言状态回到 `synced`，并把尝试次数写入输出。

## Session 导出

页面拥有 Session 写租约后，右下角出现 `button[data-browser-native-session-export]`（本地化文案，会话数据就绪前隐藏）。点击后页面 `POST /api/browser-native/session/export`，把 `dsh-session-bundle` 存为 `dsh-session-<id>.json`，并在 `[data-browser-native-session-export-result]`（`role="status"`）显示下载结果；失败不会改动任何会话数据。E2E 用 `page.waitForEvent('download')` 读取下载文件，断言 `format === 'dsh-session-bundle'`、`formatVersion === 1`、文件名为 `dsh-session-<sessionId>.json`，并等待 `data-export-state="downloaded"`。导入仍只有 HTTP 入口。

## 验证

```sh
pnpm run build:artifacts
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/product-visibility.e2e.mjs
```

最近一次运行输出：

```json
{"sessionLeaseConflict":"This Session is open in another tab — session is already owned by another browser; close that tab or retry after its write lease expires\nRetry opening this Session","sessionRecovery":{"attempts":1,"finalState":"synced"},"sessionExport":{"format":"dsh-session-bundle","formatVersion":1,"suggestedFilename":"dsh-session-session-56f0c79f-922b-4778-aace-4dc39b105c84.json"},"failureClassification":{"code":"UPSTREAM_LLM_AUTH_FAILED","message":"visibility probe: upstream rejected the key","rendered":true},"admissionQueue":{"observedWhileQueueing":true,"timeoutCode":"ADMISSION_TIMEOUT","timeoutMessageIncludesPosition":true}}
```

## 缺口

- 排队位置是 400 ms 轮询的最终一致视图，不显示预计等待时间；轮询频率是 PoC 常量，不是服务端推送。
- 队列超时消息里的 `queuePosition` 是超时瞬间的值；实时横幅会在前项结算后前移，但终止消息本身不会重写。
- 冲突恢复是用户触发的整页重载，不是保留内存状态的原地重试；E2E 最多允许 3 次重试以覆盖另一个标签页释放租约的延迟。
- 导出按钮只导出本页最近取得写租约的 Session；多 Session 标签页没有选择列表。导入仍只有 HTTP 入口，没有页面入口。
- 非租约类 `session/open` 失败仍只发布 `unavailable`，状态条没有专门文案；本轮只补齐 Session 租约冲突。
