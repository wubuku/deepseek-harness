---
description: "规划 Browser-Native DSH 在模型流截断、工具调用半包、Worker 终止和客户端取消时的 Agent Loop 恢复验证。"
---

# Browser-Native DSH 模型流故障验证计划

## Summary

当前 PoC 已验证了 Workspace、Session receipt、写租约、OPFS/IndexedDB 故障和文件工具资源边界，但模型流仍是浏览器运行链路中最重要的未闭环风险。模型响应可能在文本已经显示、工具名称或 JSON 参数只收到一部分、页面 Worker 被终止或客户端停止请求时结束。若这些情况没有清晰的持久化与恢复语义，用户会看到既不能继续、又可能重复执行工具的半个 Agent turn。

本批只扩展 Browser-Native PoC 的 backend 故障注入和测试，不修改正式 Agent Loop、Session event format 或默认 profile。真实 Chrome、Dedicated Worker、DSH Host 和同源 backend 是主要证据；scripted LLM 只用于确定性制造流故障，不等同于真实模型能力证据。

## 候选范围与取舍

| 候选验证点 | 价值与风险 | 本批决定 |
|---|---|---|
| 文本流输出一部分后截断 | 用户已看到内容，但 Session 不能把半条内容伪装为完成回复；后续 turn 必须可继续 | 纳入，P0 |
| 工具调用参数 JSON 中途截断 | 最危险的副作用边界；不完整参数绝不能进入工具执行或 Workspace commit | 纳入，P0 |
| Worker 在模型流中被终止并刷新 | 浏览器页面是 DSH 运行时宿主；必须证明 open turn 可被修复且不会重放 prompt/tool | 纳入，P0 |
| Stop/Abort 传播到 backend | 取消不能只停止 UI；后端不能继续写客户端或遗留上游请求 | 纳入，P0 |
| 真实 OpenAI-compatible 上游在已输出内容后断流 | 证明代理的 SSE parser 与真实 fetch/ReadableStream 错误语义 | 纳入，P1，采用本地 fake upstream 合同测试 |
| 真实 LLM 正常流回归 | 防止故障修复破坏正常文本和工具流 | 纳入回归，不作为故障注入证据 |
| Worker 在 tool/result 已提交前终止 | 已由 Workspace crash-window 和 receipt recovery 覆盖，不在本批重复实现 | 暂不扩展，复用既有回归 |
| Worker 在 HITL Promise 等待中终止 | 已由问答刷新恢复覆盖；本批只检查模型流阶段 | 暂不扩展 |
| Session append 在 assistant/attempt 写入时失败 | 属于 Session durability/backend 故障矩阵；本批只确认已有错误链不挂起 | 暂不扩展 |
| 流重试策略、模型自动重试和幂等 prompt | Agent Loop 的 retry policy 语义，需要单独的模型重试设计，不能和断流恢复混淆 | 暂不扩展 |
| 多个并行 tool call 的部分到达 | 需要真实模型协议样本和多调用副作用矩阵；先完成单调用 fail-closed 基线 | 暂不扩展 |
| 大型 tool arguments 的流式分片与传输 | 现有 1 MiB 拒绝和 Workspace blob transport 已有独立验证；本批只测半包安全 | 暂不扩展 |
| 后端上游请求取消、代理超时和连接泄漏 | 采用本地 fake upstream 合同测试，避免把外网模型延迟当作取消证据 | 纳入最小合同测试 |
| Service Worker/后台 Agent | 不属于 Dedicated Worker 运行模型；需要显式服务端 job/handoff | 明确非目标 |
| Safari/WebKit、自然 eviction、OS crash、生产 HA | 当前工作要求优先 Chrome；这些需要独立平台或部署验证 | 保留未验证边界 |

## 验证面

### 1. 部分文本流

- backend 在已经发送 `block-start` 和至少一个 `text-delta` 后发送结构化 `UPSTREAM_LLM_TRUNCATED`，不发送 `block-end` 或成功 `finish`。
- 真实 DSH Agent Loop 必须持久化 `assistant/attempt`，并以 `turn/end` 的 `error` 结束；不能产生成功的 `assistant/message`。
- 页面后续在同一 Session 发起新 turn，确认没有重复用户 prompt，新的模型请求和回复可以正常完成。
- 测试检查已输出的 live 文本不被当作已持久化完整 assistant message；attempt 中保留可重放的已收到 stream。

### 2. 部分工具调用

- backend 发送工具 `block-start`、工具名称和不完整 JSON 参数后截断。
- Session 可以保留失败的 `assistant/attempt`，但不得产生对应的 `tool/call`、`tool/result` 或 Workspace revision。
- 后续新 turn 可继续，且不会重新执行半包工具调用。
- 通过请求计数、Workspace manifest 和 Session event 类型同时证明“未执行”，不能只依赖页面没有显示工具卡。

### 3. Worker/页面终止

- backend 在已发送部分文本后保持响应一段时间；Chrome 测试终止 Dedicated Worker，再刷新同一页面和 Session。
- 恢复路径必须遵守已有 Session repair 语义：未完成的 open turn 不得被报告为成功，不得静默重发原模型请求；如果当前实现只能以 interrupted/error 修复，文档明确记录该语义。
- 刷新后的显式新 turn 应成功，并且旧半流不会产生工具副作用。

### 4. 取消与上游中止

- scripted stream 在响应期间等待，点击 UI Stop 后确认浏览器请求结束、Session turn 以 `aborted` 结算、后端没有继续写入已关闭响应。
- backend 暴露 PoC-only 测试观测，记录响应在未正常结束时关闭；不把 HTTP 请求计数当成上游副作用计数。
- backend contract test 使用本地 OpenAI-compatible fake upstream，客户端中止 `/llm` 后确认代理的 `AbortController` 关闭 fake upstream 请求；确认没有继续等待或遗留连接。

## Agent Loop 事件验收

| 场景 | 允许的持久化结果 | 禁止结果 |
|---|---|---|
| 文本半流后错误 | `assistant/attempt`、`turn/end:error` | `assistant/message` 完成回复、`turn/end:completed` |
| 工具半包后错误 | `assistant/attempt`、`turn/end:error` | `tool/call`、`tool/result`、Workspace commit |
| Worker 流中终止 | 既有恢复机制产生的 interrupted/error/unknown 收束 | 自动重放同一 prompt、重复工具副作用、成功结算 |
| 用户 Stop | `turn/end:aborted`，必要时已有取消消息 | `turn/end:completed`、继续向页面输出 |
| 正常流 | `assistant/message` 与对应 `turn/end:completed` | 额外重复请求、空成功消息 |

## 实施顺序

1. 先写 backend scripted stream fault hook 和 backend contract test，明确半包协议和响应关闭观察。
2. 新增真实 Chrome E2E，依次覆盖文本截断、工具半包、Worker 终止刷新和 Stop。
3. 若 E2E 显示 Agent Loop 或 adapter 在已有语义下挂起，只修 PoC 适配层的请求终止/状态桥接；不在 PoC 中实现第二套 Agent Loop。
4. 复跑正常 scripted/真实 LLM 流、文件工具、Workspace receipt、Worker crash-window 和生命周期回归。
5. 更新进度、README、兼容矩阵、change ledger 和 drafts 索引；执行定向测试、preview build、typecheck、文档门禁后提交推送。

## 证据边界

本批的 scripted fault 是真实 DSH Worker/Host/Session 的故障注入，不是独立聊天 demo，也不证明真实模型会自然产生半包协议。fake upstream 只证明代理的取消传播，不代表任意外部供应商的网络行为。Chrome page reload、Worker terminate 和本地 fake upstream 不等同 OS crash、自然 storage eviction、Safari 或生产 HA。

## Dev Note

模型流失败后的 `assistant/attempt` 和 `turn/end` 语义来自当前 DSH Agent Loop；PoC 只能记录和验证它，不能用页面投影状态覆盖 Session 事实。任何未收到完整工具 `block-end` 的参数都不得执行。
