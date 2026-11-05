---
description: "Browser-Native PoC 的 Session/租户 token 预算验证：计量与上游 provider 用量逐 token 对齐，超限时在请求前显式中止并写审计。"
---

# Browser-Native token 预算与计量验证

本记录验证两件事：Session 与租户两级输入/输出 token 计量是否与真实 provider 报告的用量一致；超预算时是否在发送下一次上游请求之前显式中止，而不是发完再报错。验证使用真实模型、真实 Chrome Worker 与真实上游响应，不使用脚本化 usage。

## 实现位置

验证 roster `browser-budget` 在 `runtime-validation.mjs` 里插入 `browser-native-token-budget` 静态模块，profile `config` 为 `tenantId: poc-tenant`、`sessionLimit: 10000`、`tenantLimit: 20000`。插件 [browser-native-token-budget.ts](browser-native-token-budget.ts) 只存在于验证镜像。

插件订阅 `session/event` 并记录见过的 Session，用 Token-meter 的 `tokenUsage` projection 读取每个 Session 的 `uncachedInputTokens`、`cacheReadTokens`、`cacheWriteTokens` 与 `outputTokens`；租户总量是这些 Session 的和。执行点不是事后取消：`browser-native-providers.ts` 里的 LLM adapter 在每次上游 `fetch` 之前调用 `canRequest(sessionId)`，超限时抛 `LlmError(..., 'TOKEN_BUDGET_EXCEEDED')`，Agent Loop 因此把 turn 结束为 `error`，客户端渲染现有错误行。插件同时注册 `ctx.tools.guard`：任何工具执行前都复核同一 meter，超限时返回 `token budget exceeded (...)` 并拒绝调用。该 guard 是工具执行层就地拦截，LLM 前置检查被跳过时仍然生效。

每次实际阻断会向该 Session 追加一条 `budget/exceeded` 事件，包含 `scope`、`tenantId`、`sessionId`、当前输入/输出 token 与实际限额。同一 meter 状态下重复拒绝只记一次；拒绝之间用量继续增长时按新的 meter 状态再记一次。

计量对照不依赖 Worker 自己的日志：PoC backend 在转发上游 SSE 时独立解析 provider 原始 usage 字段，按 `requestId`/`sessionId` 记录到 `usageAudit`，并追加到 `<dataDir>/observability/usage.jsonl`（每行是带 `prev`/`hash` 链的信封，见[完整性校验](observability.md#完整性校验)）；真实模式通过 `GET /api/browser-native/usage-audit?sessionId=...` 暴露，重启后 `GET /api/browser-native/observability/reconciliation` 报告恢复的 usage 条数与上一次 metrics 快照。E2E 用这个记录与插件 meter 对照，而不是用同一份 Session 日志自证。

## 真实模型证据

`tests/token-budget.e2e.mjs` 运行输出：

```json
{
  "tenantId": "poc-tenant",
  "profileLimits": { "sessionLimit": 10000, "tenantLimit": 20000 },
  "meterVsProvider": {
    "sessionA": { "inputTokens": 2346, "outputTokens": 23 },
    "providerA": { "inputTokens": 2346, "outputTokens": 23 },
    "exact": true
  },
  "sessionBlock": {
    "turn": 2,
    "code": "TOKEN_BUDGET_EXCEEDED",
    "message": "token budget exceeded (session): 2369/2368 tokens",
    "providerRequestsAfter": 1
  },
  "tenantBlock": {
    "turn": 3,
    "code": "TOKEN_BUDGET_EXCEEDED",
    "message": "token budget exceeded (tenant poc-tenant): 2369/2368 tokens",
    "providerRequestsAfter": 1
  },
  "audit": { "sessionScope": 1, "tenantScope": 1 },
  "toolGuard": {
    "preflightSkipped": true,
    "turn": 4,
    "denied": true,
    "reason": [{ "type": "text", "text": "Error: token budget exceeded (session): 4923/2368 tokens" }],
    "fileCreated": false
  },
  "visibleAlert": "token budget exceeded (session) rendered in the turn error"
}
```

启动 turn 的上游用量 2346 输入 + 23 输出与插件 meter 完全一致，租户汇总也相等。随后通过 test port 把 Session 限额降到 2368（低于已用的 2369），下一个 turn 在请求前被拒绝：上游请求数保持 1 条不变，turn 以 `TOKEN_BUDGET_EXCEEDED` 结束，`budget/exceeded` 恰好一条，错误文案出现在客户端。再把 Session 限额放大、租户限额降到 2368，同一 Session 的下一次请求同样在 fetch 前被拒绝，租户 scope 审计恰好一条，页面无异常。最后把 Session 限额降到 2368 并关闭 LLM 前置检查（模拟该层被绕过），模型仍然请求 `write`；Worker 的工具 guard 拒绝执行，工具结果是 `token budget exceeded (session): 4923/2368 tokens`，目标文件不存在，后端全程没有预算拒绝逻辑。

运行命令：

```sh
DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
  node docs/drafts/browser-native-dsh-poc/tests/token-budget.e2e.mjs
```

## 客户端预算展示与发送前阻断

`GET /api/browser-native/session/budget?sessionId=` 只对 Session owner 返回该 principal 的用量快照：`session` 是同一 Session 下所有 provider 记录的 token 与费用，`tenant` 是该 principal 名下所有 provider 记录的汇总，`remaining` 是 Session/租户限额减去已用量。数字全部来自 backend 已记录的 provider `usage`，不按字符估算；费用只在配置了 per-million 价格时出现。

页面在 owner notice 后每 2 秒轮询该端点，显示 `Session 已用/限额 · 费用`、`Tenant 已用/限额 · 剩余 · 费用` 与 `Warning at 80%`。达到 80% 显示预警文案；达到任一限额时显示 `Sending is disabled`，将 composer 的发送按钮置为 disabled，并在 document capture 阶段拦截发送按钮点击与输入框 Enter（含按钮属性被重新渲染或移除的情况），同时给出“复制管理员说明”和“导出诊断包”两个入口。管理员说明包含 Session、已用量、限额与 tenant 汇总；诊断包复用既有 support bundle。

配置入口是 hosted 启动脚本的环境变量 `DSH_POC_SESSION_TOKEN_BUDGET`、`DSH_POC_TENANT_TOKEN_BUDGET`、`DSH_POC_TENANT_ID` 与 `DSH_POC_BUDGET_WARN_RATIO`（默认 0.8）；两个 token 限额必须同时设置，都未设置时页面不显示预算条。`usagePricing` 与租户报表共用同一组价格。这是唯一来源：backend 归一化后把限额放进 `GET /api/browser-native/config` 的 `budget` 字段，Worker 预算插件不再读取 profile 限额，而是在 runtime probe 阶段取得同一份值。`budget-config.mjs` 之外不再有第二份限额配置。

真实模型证据（`tests/budget-guidance.e2e.mjs`，roster `browser`，无 Worker 预算插件）：

```json
{
  "alignment": {
    "sessionTokens": 2372,
    "inputTokens": 2348,
    "outputTokens": 24,
    "costUsd": 0.002995,
    "tenantRemaining": 117628,
    "state": "ok"
  },
  "preBlock": {
    "state": "exceeded",
    "blockedScope": "session",
    "sendDisabled": true,
    "enterBlocked": true,
    "forcedClickBlocked": true,
    "providerRequestsUnchanged": true,
    "adminPath": true,
    "diagnostics": "dsh-support-bundle-session-4a985488-583e-4b5d-b275-f11126a5bda9.json"
  }
}
```

第一个场景限额 60 000/120 000，真实 provider 完成一轮后页面显示值与 `/usage-audit` 的 Session 汇总逐值相等，费用按 `$1.25/M` 输入与 `$2.5/M` 输出计算一致，发送按钮可用。第二个场景把限额设为 1/2，启动 turn 完成后页面进入 `exceeded`，发送按钮 disabled；Enter 与强制解除 disabled 后的点击都没有新增 `user/message`，turn 请求数没有增加，管理员说明复制成功且诊断包可下载。

运行命令：

```sh
DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
  node docs/drafts/browser-native-dsh-poc/tests/budget-guidance.e2e.mjs
```

## 预算限额单一来源

`budget-config.mjs` 是环境变量的唯一读取入口：两个 token 限额缺失一半、非正整数或 `warnRatio` 越界都直接抛错，不做部分放行。backend 把它归一化成 `budgetLimits` 并只在 `/config` 发布一次；`browser-budget` roster 只挂载插件、不写任何限额。runtime probe 读取 `/config` 后缓存 `budget`，插件 `apply` 同步采用该值；挂载插件的镜像由 `createRuntimeValidationDist` 写出 `browser-native-budget-profile.json`（内容只有 `{"budget":"required"}`），probe 在镜像声明需求但 backend 未发布限额时返回 `BUDGET_LIMITS_UNCONFIGURED`，页面显示 `browser-native startup blocked: BUDGET_LIMITS_UNCONFIGURED` 并终止 Worker，不进入任何模型请求。

证据（`tests/budget-config-single-source.e2e.mjs`，scripted backend，同一镜像启动两次）：

```json
{
  "browser": "156.0.8078.80",
  "adoptions": [
    { "sessionTokens": 12000, "tenantTokens": 24000 },
    { "sessionTokens": 15000, "tenantTokens": 30000 }
  ],
  "refusals": ["BUDGET_LIMITS_UNCONFIGURED"]
}
```

第一组只改环境记录一处，`/config` 与 Worker `budget-state` 同时为 12 000/24 000；第二组在同一镜像上只改这一处为 15 000/30 000，两侧同步变化，证明镜像里没有烘焙限额。第三组不传 `budgetLimits`，启动在 probe 阶段被拒且无 `/llm` 请求。

运行命令：

```sh
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/budget-config-single-source.e2e.mjs
```

## 残余缺口

- 阻断粒度是“上游请求之前”与“工具执行之前”，没有按预估输入 token 的预检；单次请求本身仍可能跨过限额，证据中的 2369/2368 就是请求完成后才越界。工具 guard 在超限后拒绝所有工具调用，直到限额上调或打开新 turn。
- 租户汇总是本 Worker 内已见过 Session 的和；真实模型这次只在一个 Session 内执行了租户阻断，第二次 UI Session 的发送按钮在该流程中不可用，因此“跨 Session 聚合后阻断”的端到端路径未覆盖。插件代码按 Session 集合求和，没有持久化租户账本。
- 租户只由 profile `tenantId` 标识，不是认证身份；Worker 没有租户凭据，跨 Worker 或跨设备不共享计量。
- 预算判定没有费用换算，只有 token；客户端展示的费用来自 backend 的 `usagePricing`。provider 的 cache 命中字段若将来出现在原始 usage 中，backend 审计只记录 `prompt_tokens` 总量，插件 meter 按 projection 分桶，二者可能不再逐值相等。
- `usage.jsonl` 只保留最近 1 000 条 provider 调用记录，用于重启对账与证据回看，不参与预算判定；预算仍以 Session 日志的 meter 为准，因此超出 journal 窗口的历史用量无法从该文件累计。
- 标题生成、压缩等后台请求的 usage 若不写入被计量的 Session 日志，租户总量会低估这些调用；本次运行没有触发这些请求，未验证。
- 限额已收敛到 backend 一处，但“该镜像是否挂载预算插件”仍由镜像内的 `browser-native-budget-profile.json` 声明；手工拼装镜像漏写该文件时，probe 不会要求限额，插件 `apply` 因缺少下发值抛错又会被 Cordis 包含，结果是 Worker 少一层 guard（页面是否显示预算条仍取决于 backend 配置）。页面只按 backend 账本展示，不读取 Worker meter；插件未挂载时（本次 E2E 的 roster `browser`）页面阻断是唯一防线，服务端仍没有独立于 UI 的租户预算拒绝逻辑。
- 页面按 principal cookie 聚合租户用量，不是认证租户；cookie 重置或换设备后历史用量不再计入。backend 只保留最近 1 000 条 provider 记录，超过窗口的历史用量同样不计入展示与阻断。
- 预算条只在 owner Session 上出现；共享只读用户没有预算入口。轮询间隔 2 秒，极端情况下两次快速发送可能落在刷新间隙，仍由 Worker/服务端预算判定兜底。
