# 产品可见性：失败分类、准入排队与 Session 租约冲突

本批验证用户能否在 preview 里看见三类此前只存在于协议或日志的状态：turn 的失败码、`ADMISSION_TIMEOUT` 的排队位置、同一 Session 在另一标签页被占用。可感知项保留并补测试；不可感知的 Session 租约冲突增加 `session-conflict` 状态。

## 失败分类

`turn/end` 的 `reason.kind === 'error'` 携带结构化 `{ code, message }`。正式 `packages/client/ui-chat` 的 `TurnErrorNodeView` 把 `code` 渲染为 `<code>` 元素，并显示 `message` 文本。backend 的 provider 错误映射（`UPSTREAM_LLM_AUTH_FAILED`、`RATE_LIMITED`、`UNAVAILABLE`、`TIMEOUT` 等）因此无需额外 UI 即可到达用户。

`tests/product-visibility.e2e.mjs` 用 `scriptedLlmFault` 注入 `UPSTREAM_LLM_AUTH_FAILED`，断言四层一致：`turn/end.reason.error.code`、DOM `<code>` 文本、`turn/end.reason.error.message`、DOM 消息文本。这是 scripted 注入，不是真实 provider 的 401。

## 准入排队位置

`admission-v2.mjs` 在 `ADMISSION_TIMEOUT` 触发时计算 `waiters.indexOf(waiter) + 1`，写入错误消息 `… (queue position N)` 与详情 `{ queuePosition }`，HTTP 状态 503，`retry-after` 为超时预算的四分之一。

preview 的行为分两段：

- 提交后 `user/message` 立即进入 Session，即使用户仍排在别的 turn 后面，自己的 prompt 已可见。
- 超时后 turn 以 `ADMISSION_TIMEOUT` 结束，UI 同时显示 `<code>ADMISSION_TIMEOUT</code>` 与含 `queue position 1` 的消息。

E2E 把 `maxConcurrentTurns` 设为 1、`queueTimeoutMs` 设为 3 秒，用 `barrier-text` 固定 A 页的 turn，再让 C 页提交并等待超时。它断言排队中 prompt 已渲染、终止码、终止消息中的位置、DOM 中的代码与位置文本。

## Session 租约冲突

第二个标签页打开同一 Session 时，`session/open` 返回 `409 SESSION_ALREADY_OWNED`，provider 在约 5 秒重试窗口内重复失败。此前该标签页只落在一个空 Session，没有可见错误。

`browser-native-providers.ts` 在 `SESSION_ALREADY_OWNED` 或 owner 续租报告 `SESSION_OWNERSHIP_LOST` 时发布 workspace 状态 `session-conflict`，消息为 backend 原文。状态条显示英文/中文标题加 ` — <backend message>`，边框为红色；`preview.ts` 把该状态视为可继续运行的启动结果，标签页保持打开。

E2E 在同一个 `BrowserContext` 开 A/B 两页，断言 B 的 `[data-browser-native-workspace-status]` 进入 `data-state="session-conflict"`，文本同时包含 `This Session is open in another tab` 与 `session is already owned by another browser`。

## 验证

```sh
pnpm run build:artifacts
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/product-visibility.e2e.mjs
```

最近一次运行输出：

```json
{"sessionLeaseConflict":"This Session is open in another tab — session is already owned by another browser; close that tab or retry after its write lease expires","failureClassification":{"code":"UPSTREAM_LLM_AUTH_FAILED","message":"visibility probe: upstream rejected the key","rendered":true},"admissionQueue":{"observedWhileQueueing":true,"timeoutCode":"ADMISSION_TIMEOUT","timeoutMessageIncludesPosition":true}}
```

## 缺口

- 排队位置只在超时终止消息里出现一次，排队期间没有实时位置、预计等待或队列徽标；用户无法在等待中知道自己的名次。
- `queuePosition` 是超时瞬间的值；前面的 turn 结算后位置会前移，但消息不会更新。
- 冲突状态没有自动恢复路径：另一个标签页关闭或租约过期后，B 页仍需刷新才会重新打开 Session，E2E 未覆盖该恢复。
- 非租约类 `session/open` 失败仍只发布 `unavailable`，状态条没有专门文案；本轮只补齐 Session 租约冲突。
