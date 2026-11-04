---
description: "Browser-Native PoC 的 Session/租户 token 预算验证：计量与上游 provider 用量逐 token 对齐，超限时在请求前显式中止并写审计。"
---

# Browser-Native token 预算与计量验证

本记录验证两件事：Session 与租户两级输入/输出 token 计量是否与真实 provider 报告的用量一致；超预算时是否在发送下一次上游请求之前显式中止，而不是发完再报错。验证使用真实模型、真实 Chrome Worker 与真实上游响应，不使用脚本化 usage。

## 实现位置

验证 roster `browser-budget` 在 `runtime-validation.mjs` 里插入 `browser-native-token-budget` 静态模块，profile `config` 为 `tenantId: poc-tenant`、`sessionLimit: 10000`、`tenantLimit: 20000`。插件 [browser-native-token-budget.ts](browser-native-token-budget.ts) 只存在于验证镜像。

插件订阅 `session/event` 并记录见过的 Session，用 Token-meter 的 `tokenUsage` projection 读取每个 Session 的 `uncachedInputTokens`、`cacheReadTokens`、`cacheWriteTokens` 与 `outputTokens`；租户总量是这些 Session 的和。执行点不是事后取消：`browser-native-providers.ts` 里的 LLM adapter 在每次上游 `fetch` 之前调用 `canRequest(sessionId)`，超限时抛 `LlmError(..., 'TOKEN_BUDGET_EXCEEDED')`，Agent Loop 因此把 turn 结束为 `error`，客户端渲染现有错误行。

每次实际阻断会向该 Session 追加一条 `budget/exceeded` 事件，包含 `scope`、`tenantId`、`sessionId`、当前输入/输出 token 与实际限额。每个 `(sessionId, scope)` 只记一次，避免重复告警。

计量对照不依赖 Worker 自己的日志：PoC backend 在转发上游 SSE 时独立解析 provider 原始 usage 字段，按 `requestId`/`sessionId` 记录到 `usageAudit`，并追加到 `<dataDir>/observability/usage.jsonl`；真实模式通过 `GET /api/browser-native/usage-audit?sessionId=...` 暴露，重启后 `GET /api/browser-native/observability/reconciliation` 报告恢复的 usage 条数与上一次 metrics 快照。E2E 用这个记录与插件 meter 对照，而不是用同一份 Session 日志自证。

## 真实模型证据

`tests/token-budget.e2e.mjs` 运行输出：

```json
{
  "tenantId": "poc-tenant",
  "profileLimits": { "sessionLimit": 10000, "tenantLimit": 20000 },
  "meterVsProvider": {
    "sessionA": { "inputTokens": 2346, "outputTokens": 16 },
    "providerA": { "inputTokens": 2346, "outputTokens": 16 },
    "exact": true
  },
  "sessionBlock": {
    "turn": 2,
    "code": "TOKEN_BUDGET_EXCEEDED",
    "message": "token budget exceeded (session): 2362/2361 tokens",
    "providerRequestsAfter": 1
  },
  "tenantBlock": {
    "turn": 3,
    "code": "TOKEN_BUDGET_EXCEEDED",
    "message": "token budget exceeded (tenant poc-tenant): 2362/2361 tokens",
    "providerRequestsAfter": 1
  },
  "audit": { "sessionScope": 1, "tenantScope": 1 },
  "visibleAlert": "token budget exceeded (session) rendered in the turn error"
}
```

启动 turn 的上游用量 2346 输入 + 16 输出与插件 meter 完全一致，租户汇总也相等。随后通过 test port 把 Session 限额降到 2361（低于已用的 2362），下一个 turn 在请求前被拒绝：上游请求数保持 1 条不变，turn 以 `TOKEN_BUDGET_EXCEEDED` 结束，`budget/exceeded` 恰好一条，错误文案出现在客户端。再把 Session 限额放大、租户限额降到 2361，同一 Session 的下一次请求同样在 fetch 前被拒绝，租户 scope 审计恰好一条，页面无异常。

运行命令：

```sh
DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
  node docs/drafts/browser-native-dsh-poc/tests/token-budget.e2e.mjs
```

## 残余缺口

- 阻断粒度是“上游请求之前”，没有按预估输入 token 的预检；单次请求本身仍可能跨过限额，证据中的 2362/2361 就是请求完成后才越界。
- 租户汇总是本 Worker 内已见过 Session 的和；真实模型这次只在一个 Session 内执行了租户阻断，第二次 UI Session 的发送按钮在该流程中不可用，因此“跨 Session 聚合后阻断”的端到端路径未覆盖。插件代码按 Session 集合求和，没有持久化租户账本。
- 租户只由 profile `tenantId` 标识，不是认证身份；Worker 没有租户凭据，跨 Worker 或跨设备不共享计量。
- 没有费用/价格换算，只有 token；provider 的 cache 命中字段若将来出现在原始 usage 中，backend 审计只记录 `prompt_tokens` 总量，插件 meter 按 projection 分桶，二者可能不再逐值相等。
- `usage.jsonl` 只保留最近 1 000 条 provider 调用记录，用于重启对账与证据回看，不参与预算判定；预算仍以 Session 日志的 meter 为准，因此超出 journal 窗口的历史用量无法从该文件累计。
- 标题生成、压缩等后台请求的 usage 若不写入被计量的 Session 日志，租户总量会低估这些调用；本次运行没有触发这些请求，未验证。
- 预算插件只注册在验证 roster，正式产品 profile 未启用；没有客户端预算条、预警阈值（如 80%）或用户可见的用量页。
