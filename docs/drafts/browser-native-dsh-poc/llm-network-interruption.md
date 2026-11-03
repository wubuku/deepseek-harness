---
description: "在真实 Chrome 中切断模型流与浏览器到 backend 的连接，验证错误可见、turn 收束、重连一致以及每次 turn 只产生一次模型请求。"
---

# 模型流断开与重连

## Summary

[llm-network-interruption.e2e.mjs](tests/llm-network-interruption.e2e.mjs) 在真实 Chrome 156.0.8078.79 中做两类中断：上游 SSE 在已产生内容后被切断，以及浏览器与同源 backend 之间的 TCP 连接在流式响应中途整体断开。第一类让 turn 以 `UPSTREAM_LLM_STREAM_FAILED` 收束，保留已流出的 4 个文本字符，没有 `assistant/message` 与自动重试；第二类让 turn 以 `BROWSER_NATIVE_STREAM_INTERRUPTED` 收束，错误正文记录断开前的 9 个 chunk、8 个文本字符与 0 个工具参数字节，并保留请求 id 与文本前缀 `OFFLINE-`，断开 4 条浏览器连接，页面无需刷新即可恢复。两种情况下各自只产生 1 次模型请求，重连后各 1 次续跑请求，Session 最终 4 个 turn、43 个事件，四个 prompt 各出现一次，刷新后 durable 事件前缀逐项不变。

本轮配置的默认 provider 仍返回 HTTP 403 `用户 [4912] 配额不足`，因此上游切断场景继续使用本地 OpenAI-compatible SSE stand-in；浏览器到 backend 的 TCP 断连是真实网络层事件。断流诊断修复另用 `LongCat-2.5` 端点做真实流式冒烟：单轮约束 prompt 以 `completed` 收束、1 次 turn 模型请求、`/llm` 响应 HTTP 200 NDJSON、返回约定 marker，证明正常流式路径未被诊断改动破坏。密钥只从 `docs/drafts/.env` 读入内存，未打印或落盘；本轮页面文本、Session 事件与测试输出中均未出现配置的密钥。

## 场景与判定

| 场景 | 注入点 | 判定 |
| --- | --- | --- |
| 上游流被切断 | 本地 SSE 上游写完 4 个内容字符后销毁响应 | turn `error`、`UPSTREAM_LLM_STREAM_FAILED`、保留文本前缀 `CUT`、无 `assistant/message`、上游 1 次请求、0 个 retry 事件，下一 turn 正常完成 |
| 浏览器网络中断 | 浏览器与 backend 之间的透明 TCP relay 在已流出 8 个字符时销毁全部 4 条连接 | turn `error`、`BROWSER_NATIVE_STREAM_INTERRUPTED`、正文含 chunk/字符/工具参数字节位置与 request id、保留文本前缀 `OFFLINE-`、无需刷新即收束、上游 1 次请求、0 个 retry 事件，下一 turn 正常完成 |
| 重连后一致性 | 两类中断后各发一个续跑 turn | 两个续跑 turn 均 `completed`，assistant 文本分别为 `CUT-CONTINUE-OK` 与 `OFFLINE-CONTINUE-OK` |
| 状态与计费 | 全部 turn 结束后刷新页面 | 43 个 durable 事件、4 个 `turn/end`、四个 prompt 各 1 条 `user/message`；最终刷新前后事件前缀一致；页面错误 0、跨源请求 0 |

“错误可感知”按三层核对：Session 层有 `turn/end` 的 error reason；请求层有 `assistant/attempt` 的 finish error，且上游被切断时保留 `title` 之外的文本前缀；UI 层 composer 恢复可编辑、`Stop generating` 消失，并在正文出现 `Failed`。两种中断都没有悬挂 turn：浏览器断连后不刷新即可读到 terminal，恢复方式记为 `reconnect` 而不是 `reload`。

## 结果

```json
{"result":"passed","browser":"chrome","scope":"stream-severance-and-chrome-network-loss",
 "upstream":"local OpenAI-compatible SSE stub (configured provider returned HTTP 403 quota exhaustion)",
 "severedStream":{"turn":1,
   "reason":{"kind":"error","error":{"message":"upstream LLM stream failed before completion","code":"UPSTREAM_LLM_STREAM_FAILED"}},
   "attemptText":"CUT","upstreamRequests":1,"retryEvents":0,"stubCutAfterCharacters":4},
 "severedContinuation":{"turn":2,"assistantText":"CUT-CONTINUE-OK"},
 "clientOffline":{"turn":3,
   "reason":{"kind":"error","error":{"message":"browser-native LLM stream interrupted after 9 chunk(s) (8 text character(s), 0 tool-argument byte(s))","code":"BROWSER_NATIVE_STREAM_INTERRUPTED","requestId":"0ebc8070-1fde-4698-a77c-6647ada1058f"}},
   "failureCode":"BROWSER_NATIVE_STREAM_INTERRUPTED","attemptText":"OFFLINE-","recovery":"reconnect",
   "upstreamRequests":1,"retryEvents":0,
   "upstreamClientAborts":2,"streamPrefixCharactersBeforeOffline":8,"severedBrowserConnections":4},
 "offlineContinuation":{"turn":4,"assistantText":"OFFLINE-CONTINUE-OK"},
 "durableEventCount":43,"stubRequests":5,"pageErrors":[],"nonLocalRequests":[]}
```

`stubRequests` 为 5，即 4 个用户 turn 加 1 次 `session/title-llm-request`；turn 请求的计数按带工具定义的模型请求统计，标题请求不参与 turn 计数。`upstreamClientAborts` 为 2，分别是上游流被切断与浏览器连接断开各一次，说明 backend 在两种中断下都中止了上游请求。

## 语义决策

| 问题 | 决定 | 原因 |
| --- | --- | --- |
| 上游流被切断后是否自动重试 | 否 | 已流出内容再重试会重复计费并可能拼出一段不属于同一响应的文本；实测 0 个 retry 事件、每次 turn 1 次上游请求。 |
| 浏览器断连后是否重放请求 | 否 | 与上一条同理；重连只允许新 turn 发起新请求。 |
| 错误分类 | 浏览器断连使用强类型 `BROWSER_NATIVE_STREAM_INTERRUPTED` | backend 的 `UPSTREAM_LLM_STREAM_FAILED` 是强类型；浏览器侧 response body 拒绝不再是 `UNKNOWN`/`network error`，而是记录断开时的 chunk、文本字符、工具参数字节位置与请求 id，并保留已收到的文本前缀。 |
| 恢复方式 | 优先原地重连，必要时刷新 | 实测无需刷新即可读到 terminal，`recovery` 为 `reconnect`；仍保留刷新作为兜底路径并在超时时使用。 |
| 上游 stand-in | 本地 OpenAI-compatible SSE | 配置的 provider 返回 403 配额不足；本地 SSE 保持相同 chunk 协议，才能验证切断发生在真实响应流上。 |

## 实现

| 位置 | 变更 |
| --- | --- |
| [tests/llm-network-interruption.e2e.mjs](tests/llm-network-interruption.e2e.mjs) | 本地 SSE 上游、按 chunk 切断、浏览器到 backend 的透明 TCP relay 与整体断连、两类中断、重连续跑、刷新前缀核对；`clientOffline` 断言强类型 code、位置正文、request id 与保留的部分 delta。 |
| [browser-native-providers.ts](browser-native-providers.ts) | `stream()` 记录请求 id 与已交付 chunk/字符/工具参数增量；response body 读取拒绝且非调用方 abort 时抛出 `BROWSER_NATIVE_STREAM_INTERRUPTED`，正文携带断开位置，`cause` 保留原始错误。 |
| [tests/backend-v2.test.mjs](tests/backend-v2.test.mjs) | 新增合同测试：上游先流出 `PART` 再断连时，NDJSON 以 `error` `UPSTREAM_LLM_STREAM_FAILED` 收束且没有 `finish` chunk。 |
| [README.md](README.md) | 新增本节入口。 |
| [operational-compatibility-matrix.md](operational-compatibility-matrix.md) | 新增模型流中断与重连行。 |

本项未修改 `packages/`；为确保 preview 与 Worker 产物一致，仍重跑 `pnpm run build:artifacts` 7/7、`pnpm run build:check` 2/2 并重建 `build:preview`。`backend-v2.test.mjs` 63/63 通过（含此前上游断流合同测试）。

## 断流诊断修复

原实现把浏览器 response body 的读取拒绝原样抛出，`normalizeLlmFailure` 只能归为 `UNKNOWN`，turn 的 error reason 丢失断开位置与请求 id。修复点在 PoC 的 LLM adapter：[browser-native-providers.ts](browser-native-providers.ts) 的 `stream()` 在每次 yield 前累计 chunk、文本字符与工具参数字节，`reader.read()` 拒绝且调用方未 abort 时抛出带类型的 `LlmError`，`cause` 指向原始拒绝，`requestId` 复用该次请求的 opaque id。已交付的 `text-delta` 仍先进入 attempt 的 stream 记录，因此失败 turn 保留前缀。

可判定输出（同一 E2E 重跑）：

- `clientOffline.reason.error.code = BROWSER_NATIVE_STREAM_INTERRUPTED`
- `message = browser-native LLM stream interrupted after 9 chunk(s) (8 text character(s), 0 tool-argument byte(s))`
- `requestId = 0ebc8070-1fde-4698-a77c-6647ada1058f`，与浏览器发出的 `/llm` 请求体中的 request id 一致
- `attemptText = "OFFLINE-"`，部分 delta 未被丢弃
- 上游仍为 1 次请求、0 个 retry 事件，`recovery = reconnect`，续跑 turn `completed`
- 事件总数 43、页面错误 0、跨源请求 0，与修复前一致

真实流式冒烟（`LongCat-2.5`，短约束 prompt）：turn `completed`、1 次 turn 模型请求、`/llm` HTTP 200 NDJSON、返回 marker；未打印凭据。

## 证据

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
node docs/drafts/browser-native-dsh-poc/tests/llm-network-interruption.e2e.mjs
```

真实 provider 探测（不打印 URL 或密钥，仅记录状态）：

```text
POST configured completions endpoint, stream: true, max_tokens: 16
status 403 body: 用户 [4912] 配额不足
```

## 限制

上游不是真实模型，只复现真实流协议、中途断流和 backend 行为；真实 provider 的 token 计量与费用没有被验证，默认 provider 恢复配额后必须重跑。浏览器断连是 TCP 层整体断开，不是 Wi-Fi 切换、移动网络降级、代理超时或 OS 休眠；一次运行只覆盖一个 Session 与 4 个 turn。强类型诊断只覆盖浏览器到 backend 的 response body 断开，不提供自动续流或断点重放；上游 provider 断开仍由 backend 的 `UPSTREAM_LLM_STREAM_FAILED` 负责。真实 LongCat 冒烟只覆盖正常流式路径，未触发真实模型断流。harness 通过 100 ms 轮询读取 terminal，时间粒度不适用于延迟 SLA。没有验证流式 usage、provider 计费回执、多标签并发中断、Safari/WebKit 与生产多实例 backend。
