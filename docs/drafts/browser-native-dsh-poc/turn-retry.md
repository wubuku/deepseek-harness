---
description: "Browser-Native DSH 的失败 turn 重试：页面可见重试、服务端权威 prompt、幂等结算与不重复计费证据。"
---

# 失败 turn 的界面重试与幂等结算

## 结论

失败或中断的 turn 现在可以在预览页直接重试：页面从 Session log 读到最近一个以 `error`/`aborted`/`interrupted` 收束的 turn，显示可见的失败条和 `Retry turn N`；点击后由 backend 从**原始 user/message** 重新取回 prompt，经真实 composer 提交，并在成功后结算一次。双击只产生一条重试意图、一次 composer 提交、一次结算和一个新的模型请求。

| 事实 | 证据 |
| --- | --- |
| 可见状态 | 面板 `data-state` 依次为 `failed` → `submitted`，文案写明 turn 号与终止原因 |
| 重试来源 | 服务端从 Session log 取回权威 prompt，客户端不提交 prompt 内容 |
| 幂等请求 | 双击只发出 1 次 `POST /session/turn-retry`；重复请求返回 `created: false` |
| 幂等结算 | 页面只发出 1 次 `POST /session/turn-retry/settle`；重复结算返回 `settled: false` |
| 不重复计费 | 全程 3 个 turn 请求（boot、失败 turn、一次重试），user/message 恰好 2 条 |

## 实现

`turn-retry-ledger.mjs` 是 durable 意图账本：`retryId = sha256(sessionId + turn + prompt)` 取前 32 位十六进制，同目录一个 JSON 文件；`request` 在串行队列内“读-写-重命名”，并发重复请求只创建一次；`settle` 仅在 `settledAt === null` 时写入，保留首次时间。账本只记录意图与结算，不复制 Session 事件。

三个路由挂在 `/api/browser-native/session/` 下，沿用该路径的 `dsh-browser-native-session-principal` cookie：

- `GET /session/turn-retry?sessionId=`：返回 `{retryable?: {turn, reason}, retries: [...]}`。`retryable` 只取**最后一个** `turn/end`，因此重试成功或出现新 turn 后自动消失。
- `POST /session/turn-retry`：校验 owner；要求请求的 turn 等于当前可重试 turn；从该 turn 之前的最后一个 `user/message` 取回 prompt；viewer 不能重试共享 Session。
- `POST /session/turn-retry/settle`：校验 owner 后结算一次。

页面侧（`browser-native-page-control.ts`）在收到 owner notice 后每 1 秒轮询一次，只有存在 `retryable` 才创建面板，面板为 `output` + `alert` live region。点击后：

1. 请求意图；`created !== true` 时显示 “already retried”，不再提交。
2. 用 `document.execCommand('insertText')` 把权威 prompt 写入 `[data-composer-input]`，等编辑器保留文本且 Send 可用后点击真实 Send。
3. 结算成功后固定显示 `submitted` 8 秒，避免下一次轮询立即覆盖可见状态。

本地 `turnRetryBusy` 标志吞掉双击的第二下；服务端账本负责跨标签与跨页面的同一保证。失败路径显示 “Retry failed; no new turn was submitted”，并恢复按钮。

## 实测输出

```text
{
  "failedTurn": 2,
  "visibleStates": ["failed", "submitted"],
  "retryRequestsFromPage": 1,
  "settleRequestsFromPage": 1,
  "duplicateCreated": false,
  "duplicateSettled": false,
  "modelRequests": 3,
  "userMessages": 2,
  "ledger": [{
    "retryId": "11a6e6115674b60bce1f1c33aa269efd",
    "turn": 2,
    "prompt": "TURN_RETRY_FAIL report the scripted failure",
    "settledAt": 1793830250731
  }]
}
```

`failedTurn` 的 `turn/end` 为 `{"kind":"error","error":{"code":"SCRIPTED_UI_RETRY_FAILURE"}}`；重试 turn 以 `completed` 收束并产出脚本标记。

复跑：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js \
  node docs/drafts/browser-native-dsh-poc/tests/turn-retry.e2e.mjs
node --test docs/drafts/browser-native-dsh-poc/tests/turn-retry-ledger.test.mjs
```

## 限制

- 页面只为最近一个 owner Session 显示重试；多 Session 同页时以最后收到 owner notice 的 Session 为准，不做多面板排队。
- 意图创建后若 composer 提交失败，账本保留未结算记录；再次点击会得到 `created: false` 并显示已请求，需要手动重新输入。PoC 不自动回收孤立意图。
- 重试判定只看最后一个 `turn/end`；更早的失败 turn 不能从界面重试。
- 计费证据是模型请求数（scripted 模式不产生真实 usage）；真实计费需要在真实 provider 下复核 usage audit。
- 本项未修改 LLM 代码，因此没有真实模型冒烟；失败注入由 scripted fault 提供确定性前提。
