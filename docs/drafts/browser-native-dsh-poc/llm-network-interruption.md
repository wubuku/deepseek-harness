---
description: "在真实 Chrome 中切断模型流与浏览器到 backend 的连接，验证错误可见、turn 收束、重连一致以及每次 turn 只产生一次模型请求。"
---

# 模型流断开与重连

## Summary

[llm-network-interruption.e2e.mjs](tests/llm-network-interruption.e2e.mjs) 在真实 Chrome 156.0.8078.79 中做两类中断：上游 SSE 在已产生内容后被切断，以及浏览器与同源 backend 之间的 TCP 连接在流式响应中途整体断开。第一类让 turn 以 `UPSTREAM_LLM_STREAM_FAILED` 收束，保留已流出的 4 个文本字符，没有 `assistant/message` 与自动重试；第二类让 turn 以 `network error` 收束，断开 4 条浏览器连接，页面无需刷新即可恢复。两种情况下各自只产生 1 次模型请求，重连后各 1 次续跑请求，Session 最终 4 个 turn、43 个事件，四个 prompt 各出现一次，刷新后 durable 事件前缀逐项不变。

本轮无法使用配置的真实 provider：直接探测配置的 completions 端点返回 HTTP 403，正文为 `用户 [4912] 配额不足`。因此上游使用本地 OpenAI-compatible SSE 服务，按真实 chunk 协议逐字流出并在中途断开；浏览器到 backend 的 TCP 断连是真实网络层事件。backend 仍按现有实现向上游发送 `Authorization`，但本地 stand-in 不使用也不记录该值；本轮页面文本、Session 事件与测试输出中均未出现配置的密钥。真实 provider 恢复配额后应重跑同一 harness 替换上游。

## 场景与判定

| 场景 | 注入点 | 判定 |
| --- | --- | --- |
| 上游流被切断 | 本地 SSE 上游写完 4 个内容字符后销毁响应 | turn `error`、`UPSTREAM_LLM_STREAM_FAILED`、保留文本前缀 `CUT`、无 `assistant/message`、上游 1 次请求、0 个 retry 事件，下一 turn 正常完成 |
| 浏览器网络中断 | 浏览器与 backend 之间的透明 TCP relay 在已流出 8 个字符时销毁全部 4 条连接 | turn `error`、`network error`、无需刷新即收束、上游 1 次请求、0 个 retry 事件，下一 turn 正常完成 |
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
   "reason":{"kind":"error","error":{"message":"network error","code":"UNKNOWN"}},
   "recovery":"reconnect","upstreamRequests":1,"retryEvents":0,
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
| 错误分类 | 保持现状，记录 `UNKNOWN` | backend 的 `UPSTREAM_LLM_STREAM_FAILED` 是强类型；浏览器 fetch 拒绝在 PoC adapter 中被归为 `UNKNOWN`/`network error`。修复该分类属于 LLM 路径改动，而本轮真实 provider 配额不足、无法做要求的真实冒烟，故不改代码只记录诊断缺口。 |
| 恢复方式 | 优先原地重连，必要时刷新 | 实测无需刷新即可读到 terminal，`recovery` 为 `reconnect`；仍保留刷新作为兜底路径并在超时时使用。 |
| 上游 stand-in | 本地 OpenAI-compatible SSE | 配置的 provider 返回 403 配额不足；本地 SSE 保持相同 chunk 协议，才能验证切断发生在真实响应流上。 |

## 实现

| 位置 | 变更 |
| --- | --- |
| [tests/llm-network-interruption.e2e.mjs](tests/llm-network-interruption.e2e.mjs) | 本地 SSE 上游、按 chunk 切断、浏览器到 backend 的透明 TCP relay 与整体断连、两类中断、重连续跑、刷新前缀核对。 |
| [tests/backend-v2.test.mjs](tests/backend-v2.test.mjs) | 新增合同测试：上游先流出 `PART` 再断连时，NDJSON 以 `error` `UPSTREAM_LLM_STREAM_FAILED` 收束且没有 `finish` chunk。 |
| [README.md](README.md) | 新增本节入口。 |
| [operational-compatibility-matrix.md](operational-compatibility-matrix.md) | 新增模型流中断与重连行。 |

本项未修改 `packages/`，未修改 `backend-v2.mjs`，因此不需要 `build:check`；新增合同测试后 `backend-v2.test.mjs` 58/58 通过。

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

上游不是真实模型，只复现真实流协议、中途断流和 backend 行为；真实 provider 的 token 计量与费用没有被验证，恢复配额后必须重跑。浏览器断连是 TCP 层整体断开，不是 Wi-Fi 切换、移动网络降级、代理超时或 OS 休眠；一次运行只覆盖一个 Session 与 4 个 turn。错误分类在浏览器 fetch 拒绝路径上仍是 `UNKNOWN`，没有把网络类错误与其它错误区分开。harness 通过 100 ms 轮询读取 terminal，时间粒度不适用于延迟 SLA。没有验证流式 usage、provider 计费回执、多标签并发中断、Safari/WebKit 与生产多实例 backend。
