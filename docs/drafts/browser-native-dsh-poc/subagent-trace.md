---
description: "Browser-Native DSH 的跨 subagent 追踪：trace id 定义、父子 Session 链路还原、审计与成本归属，以及 scripted 与真实模型证据。"
---

# 跨 subagent 追踪

## 结论

一次委托的完整链路现在可以从任一参与 Session 还原：trace id 就是委托树的根 Session id，子 Session 头里的 `parentSession`/`origin`/`delegationDepth` 让 backend 在重启后重算出同一个 trace，不需要额外计数器。`GET /api/browser-native/session/trace?sessionId=` 返回该树全部成员、父子调用关系、每个 Session 的工具策略审计计数与用量/成本行；真实模型记录的 usage 同时带上 `traceId`，因此日志账本与报表按同一 id 合并。

| 事实 | 证据 |
| --- | --- |
| trace id | 根 Session id；父 Session 自身报告的 `traceId` 等于自己的 id |
| 父子链路 | 子行 `parentSession`、`parentCallId`、`parentTurn` 指向父 Session 的 `subagent` 工具调用 |
| 审计归属 | 父行 `audit.toolPolicy.deny: 1`（越界写入被拒），子行全 0 |
| 成本归属 | 每行带 `usage`（`requests`/`inputTokens`/`outputTokens`/`totalTokens`/`costUsd`），顶层 `totals` 为逐行求和；未配置定价时 `costUsd: null` |
| 真实模型日志 | 真实 provider 的 1 条 usage 记录携带 `traceId === sessionId`，与报表行一致 |
| 访问拒绝相关性 | 只有成员 Session 的 `accessDenials` 进入报告 |

## 实现

`subagent-trace.mjs` 只读已持久化的 Session、usage 与访问审计，不写任何状态：

- `traceIdFor(store, session)` 沿 `header.parentSession` 上溯到根；父 Session 未知时停在当前节点，环检测返回环内排序后的第一个 id，避免把损坏的祖先链当成新 trace。
- `buildTraceReport` 过滤同 principal、未过期、且 `traceIdFor` 相同的 Session，按 `header.createdAt` 排序；成员的角色、来源与深度直接取 Session 头。
- 父调用通过扫描父 Session 的 `tool/call{name:'subagent'}` 及对应 `tool/result` 文本中的 `started subagent <childId>` 定位，turn 号取该调用前最近的 `turn/start`。因此即使调用发生在多轮对话中，链路也能指回准确的轮次。
- 每行 `turns` 与 `lastTurnReason` 来自 `turn/end`；`usage` 由 `buildUsageReport` 按 Session 生成，缺失时补零；`totals` 逐行求和，`costUsd` 仅在配置 `usagePricing` 时给数值。

`backend-v2.mjs` 在 real LLM 的 usage 回调中附加 `traceId = traceIdFor(store, store.get(body.sessionId))`。未知 Session id 只跳过 trace 归属，仍按 principal 记账；记录同时进入内存审计与 hash-chained `observability/usage.jsonl`，日志行因此可以直接按 `traceId` 聚合成一次委托。

## 实测输出

scripted 双 Session（父 Session 先触发一次被拒写入，再委托一次）：

```text
{
  "result": "passed",
  "traceId": "session-c0432c6c…",
  "parentSessionId": "session-c0432c6c…",
  "childSessionId": "6c835799-e466-40fa-b49b-0cd1e9279b2d",
  "parentCallId": "trace-subagent-call",
  "parentTurn": 1,
  "sessions": [
    { "sessionId": "session-c0432c6c…", "parentSession": null, "depth": 0, "audit": { "allow": 1, "ask": 0, "deny": 1 } },
    { "sessionId": "6c835799…", "parentSession": "session-c0432c6c…", "depth": 1, "audit": { "allow": 0, "ask": 0, "deny": 0 } }
  ],
  "totals": { "sessions": 2, "turns": 2, "requests": 0, "inputTokens": 0, "outputTokens": 0, "totalTokens": 0, "costUsd": null }
}
```

真实 provider 冒烟（`LongCat-2.5`，未配置定价）：

```text
{
  "result": "passed",
  "scope": "real-model-trace-usage-attribution",
  "traceId": "session-67706c32…",
  "sessionId": "session-67706c32…",
  "model": "LongCat-2.5",
  "usageRows": { "requests": 1, "inputTokens": 2349, "outputTokens": 30, "totalTokens": 2379, "costUsd": null },
  "usageRecords": 1,
  "journalTraceIds": ["session-67706c32…"]
}
```

复跑：

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/subagent-trace.test.mjs
DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js \
  node docs/drafts/browser-native-dsh-poc/tests/subagent-trace.e2e.mjs
DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
  node docs/drafts/browser-native-dsh-poc/tests/subagent-trace-real.e2e.mjs
```

## 限制

- trace 只按 Session 头重建；已过期或跨 principal 的祖先会让子 Session 退化为自己的根，报告不会扩大可见范围。
- 父调用识别依赖 `subagent` 工具结果文本 `started subagent <childId>`；改写该工具结果的措辞需要同步更新匹配。
- 共享 viewer 可读到的 trace 仍受 Session 访问控制；报告只收录调用者 principal 拥有的成员。
- 真实冒烟只覆盖根 Session 的 usage 归属；父子双 Session 的真实成本归属由 scripted E2E 的链路断言加单测里的定价用例覆盖，未做两次真实模型并行委托。
- `browser-subagent` roster 在真实 provider 下会先报 `tool schema "subagent" is not currently published`，本次真实冒烟改用 `browser` roster 验证 usage trace 归属；该 roster 与真实 provider 的时序问题未在本项修复。
