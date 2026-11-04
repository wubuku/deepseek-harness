---
description: "Browser-Native v2 LLM proxy 对 OpenAI-compatible 与 Anthropic-compatible 两类真实端点的请求翻译、流式输出、工具调用、错误映射和取消验证，并记录未覆盖的协议差异。"
---

# 双 provider 真实兼容

## Summary

同一份 PoC `/api/browser-native/llm` wire 请求现在可以打到两类真实端点：OpenAI-compatible Chat Completions（本机 LongCat-2.5）和 Anthropic-compatible Messages（本机 MiniMax）。真实冒烟在同一 backend 代码路径上完成流式文本、工具调用、usage 上报和取消；确定性合同测试另用本地 fake upstream 覆盖 HTTP 错误分类、流内错误、空响应、断流和取消时的上游关闭。

real 模式通过 `DSH_POC_LLM_PROVIDER=openai|anthropic` 或服务端选项 `llmProviderKind` 选择协议族；模型、base URL、path、凭据和 `max_tokens` 默认值仍只存在于 backend 环境，不进入浏览器协议。Anthropic 分支默认 `max_tokens` 为 4096，可用 `DSH_POC_LLM_MAX_TOKENS` 调整。

## 复跑方式

```sh
node docs/drafts/browser-native-dsh-poc/tests/provider-compatibility.e2e.mjs
DSH_POC_ENV_FILE=docs/drafts/.env node docs/drafts/browser-native-dsh-poc/tests/provider-compatibility.e2e.mjs
```

第一条只跑确定性 fake upstream；第二条追加 LongCat 与 MiniMax 真实调用。脚本以 JSON 行输出每次场景的结果，凭据不打印。

## 实测结果

真实冒烟单轮结果：

| provider | 文本 | 工具调用 | usage | 取消 |
|---|---|---|---|---|
| LongCat-2.5（OpenAI-compatible） | `REAL-longcat-TEXT-OK`，1,582 ms | `echo(REAL-longcat-TOOL-OK)`，1,600 ms | 30 输入 / 37 输出 / 67 合计 | 908 ms |
| MiniMax（Anthropic-compatible） | `REAL-minimax-TEXT-OK`，1,209 ms | `echo(REAL-minimax-TOOL-OK)`，924 ms | 64 输入 / 8 输出 / 72 合计 | 518 ms |

确定性合同测试结果：两类 provider 的文本与工具断言通过；usage 分别为 28 和 34 tokens；客户端取消在约 22 ms 内关闭上游流；OpenAI 500 映射为 `UPSTREAM_LLM_FAILED`，Anthropic 401 映射为 `UPSTREAM_LLM_AUTH_FAILED`、429 映射为 `UPSTREAM_LLM_RATE_LIMITED` 且保留 `retryAfterMs: 2000`，流内 `overloaded_error` 映射为 `UPSTREAM_LLM_UNAVAILABLE`，空响应和缺失 `message_stop` 分别映射为 `UPSTREAM_LLM_EMPTY` 与 `UPSTREAM_LLM_TRUNCATED`。

这些是单机单次采样，不是吞吐量、SLA 或供应商可用性结论。

## 协议差异与翻译

| 主题 | OpenAI-compatible | Anthropic-compatible |
|---|---|---|
| 请求体 | `messages` 原样透传，`tools[].function.parameters` | `system`/`developer` 合并为顶层 `system`；`messages` 只保留 user/assistant，连续同角色合并 |
| 工具 schema | `{ type: 'function', function: { name, description, parameters } }` | `{ name, description, input_schema }` |
| 历史工具调用 | assistant `tool_calls[].function.arguments` 是 JSON 字符串 | assistant `content[].tool_use.input` 是对象；不可解析的历史参数退化为 `{}` |
| 工具结果 | role `tool` + `tool_call_id` | 同一 user message 内的 `tool_result` block；连续结果与后续用户文本合并 |
| 文本流 | `choices[].delta.content` | `content_block_delta` 的 `text_delta` |
| reasoning | `delta.reasoning_content` 映射为 `reasoning` block | `content_block` 的 `thinking` + `thinking_delta` 映射为 `reasoning` block |
| 工具流 | `delta.tool_calls[].function.arguments` 增量 | `tool_use` block 的 `input_json_delta.partial_json` 增量 |
| 结束 | `finish_reason` 或 `[DONE]` | `message_delta.stop_reason` + `message_stop` |
| usage | 需要 `stream_options.include_usage` | `message_start`/`message_delta` 自带；本机 MiniMax 只在 `message_delta` 给出正数 |
| 取消 | 客户端断开时 abort 上游 `fetch` | 同一机制；不发送独立 cancel 请求 |

缺省 `temperature` 只在 wire 提供 number 时透传；`reasoning_effort` 只发送给 OpenAI-compatible。Anthropic `max_tokens` 是必填项，翻译层使用请求值或 backend 默认值。

## 错误映射

| 上游情形 | backend error code | HTTP 响应 |
|---|---|---|
| 401/403 | `UPSTREAM_LLM_AUTH_FAILED` | 502 |
| 429 | `UPSTREAM_LLM_RATE_LIMITED` | 503，带 `retryAfterMs` |
| 503/529 | `UPSTREAM_LLM_UNAVAILABLE` | 503，带 `retryAfterMs` |
| 408/504 | `UPSTREAM_LLM_TIMEOUT` | 504 |
| 其他非 2xx | `UPSTREAM_LLM_FAILED` | 502 |
| 流内 `authentication_error`/`permission_error` | `UPSTREAM_LLM_AUTH_FAILED` | 已在 200 NDJSON 内 |
| 流内 `rate_limit_error` | `UPSTREAM_LLM_RATE_LIMITED` | 已在 200 NDJSON 内 |
| 流内 `overloaded_error` | `UPSTREAM_LLM_UNAVAILABLE` | 已在 200 NDJSON 内 |
| 流内 `api_error` | `UPSTREAM_LLM_STREAM_FAILED` | 已在 200 NDJSON 内 |
| 空响应 / 缺终止事件 | `UPSTREAM_LLM_EMPTY` / `UPSTREAM_LLM_TRUNCATED` | 已在 200 NDJSON 内 |

HTTP error body 在可得时保留 `details.providerStatus` 与 `details.providerErrorType`；不读取或回显上游完整错误文本。

## 多 provider 回退与重试

fallback 通过 `DSH_POC_LLM_FALLBACK_PROVIDER`、`DSH_POC_LLM_FALLBACK_MODEL`、`DSH_POC_LLM_FALLBACK_BASE_URL`、`DSH_POC_LLM_FALLBACK_PATH`、`DSH_POC_LLM_FALLBACK_API_KEY` 配置，服务端选项 `llmFallback` 可逐字段覆盖（测试使用）。只配置一部分是启动错误，不会静默退化成单 provider。`/api/browser-native/config` 在配置后返回 `fallbackProvider`、`fallbackModel` 与 `fallbackProviderKind`，不返回 URL 或凭据。

回退判据只有“可用性故障且客户端尚未收到任何流项”：5xx、408/504、连接失败、超时，以及 200 但一条事件都没发出就断流。成功终止后才写 200 响应头，因此失败尝试不会留下部分 body。凭证错误（401/403）、限流（429）、空响应和请求错误不触发回退，按原错误码返回，避免把配置错误掩盖成可用性事件。

一旦任一文本或工具调用 chunk 发给客户端就不再回退：否则第二个 provider 会重复可见文本，并且同一工具可能被执行两次。这种情形把 `UPSTREAM_LLM_STREAM_FAILED`/`UPSTREAM_LLM_TIMEOUT` 作为终止事件写入同一 NDJSON 流。

计费与事件账：每个 `/llm` 请求最多记录一条 usage audit，由实际产生响应的那次尝试上报，附带 `provider`、`attempt`（1 或 2）以及回退时的 `fallbackUsed: true`；失败尝试的 token 数被丢弃。`usage-report` 的合计与 audit 一致。回退在浏览器 wire 上不可见：Worker 只看到一条 200 NDJSON 流。

确定性验证 [`tests/llm-provider-fallback.test.mjs`](tests/llm-provider-fallback.test.mjs) 用两个本地 OpenAI-compatible upstream 覆盖 7 个场景：

| 主 provider 情形 | 结果 |
|---|---|
| HTTP 500 | 回退；文本只出现一次；audit 1 条，`provider=fallback-provider`、`attempt=2`、20/50 tokens，usage-report 合计相同 |
| 连接重置（未到达响应头） | 回退，audit 1 条 |
| 超时且无输出 | 回退，audit 1 条 |
| 200 但零事件即结束 | 回退，audit 1 条 |
| 200 后已发出文本再断流 | 不回退（fallback 请求数 0），文本 `PARTIAL` 只出现一次，终止事件 `UPSTREAM_LLM_STREAM_FAILED` |
| 200 后已发出工具调用再断流 | 不回退（fallback 请求数 0），`block-start` 1 次、`tool-call-delta` 1 次、无 `block-end`，工具不会重复执行 |
| HTTP 401 | 不回退（fallback 请求数 0），返回 `UPSTREAM_LLM_AUTH_FAILED`，audit 0 条 |

真实冒烟仍覆盖重构后的单 provider 路径：`DSH_POC_ENV_FILE=docs/drafts/.env node docs/drafts/browser-native-dsh-poc/tests/provider-compatibility.e2e.mjs` 通过 LongCat 与 MiniMax 的文本、工具调用、usage 与取消场景。双真实 provider 的 failover 未触发真实 5xx，是下一节的缺口。

## 缺口

- Worker 侧 adapter 把 backend error code 原样作为 `LlmError.code`，而 DSH `llm-retry` 默认可重试集合使用 `RATE_LIMIT`/`SERVER`/`TIMEOUT` 等分类。当前 `UPSTREAM_LLM_RATE_LIMITED` 等前缀码不会自动重试；需要后续在 Worker 映射到正式分类，本轮只报告分类与 `retryAfterMs`。
- Anthropic `thinking` 的 `signature_delta` 没有可持久化的 DSH block 字段，因此本 PoC 不把历史 reasoning 回传给 provider；多轮 thinking replay 与 interleaved thinking 未验证。Prompt caching 已在 MiniMax Anthropic 兼容端点实测，结论是不依赖显式 `cache_control`，见[Provider 侧 Prompt Caching 实测](prompt-caching.md)。
- 附件、图片和文件 block 没有翻译到 Anthropic `image`/`document` block；当前 wire DTO 只支持文本。
- `tool_result` 的 `is_error` 在 OpenAI wire 中丢失，翻译层无法区分失败结果；工具失败以文本附加说明。
- 未覆盖 Anthropic beta headers、`stop_sequences`、`top_p`/`top_k`、`metadata`、限流注入和真实错误状态的自然触发。
- 双真实 provider 的回退只验证了本地 fake upstream；真实供应商 5xx/超时下的计费以供应商账单为准，backend 只能保证自己只记一次。
- 回退只发生在客户端收到任何流项之前；真实网络下 provider 可能在 200 头之后立即断开，此时不会重试，用户会看到一次失败的 turn。
- 真实取消只验证客户端断开后 backend 停止消费并 abort 上游，不证明供应商已停止推理或停止计费；确定性测试验证的是本地 fake upstream 的流关闭。
