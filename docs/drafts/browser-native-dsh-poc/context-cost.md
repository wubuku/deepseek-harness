# 上下文成本：工具结果裁剪、system prompt 稳定性与缓存命中

本页给出 Browser-native PoC 的上下文成本默认策略，以及用真实 provider 得到的前后对比。测的是两件事：system prompt 逐轮字节稳定能否让 provider 复用 prompt cache，以及默认工具结果裁剪相对“不裁剪”能省多少 billed input token。

## 测量前提

真实 provider 为 `LongCat-2.5`（`OPENAI_BASE_URL=https://api.longcat.chat/openai`，key 来自 `docs/drafts/.env`）。该网关在流式响应的 `usage.prompt_tokens_details.cached_tokens` 报告缓存命中，但只有在请求前缀逐字节相同时才命中。

测量点是 backend 的 usage ledger。此前 ledger 只记录 `inputTokens`/`outputTokens`，缓存读写量在解析 provider usage 时被丢弃，所以“缓存是否命中”无法从审计数据判断。本次让 ledger 在 `inputTokens`（provider 的完整 prompt 计数，含缓存命中）之外并列记录 `cacheReadTokens`/`cacheWriteTokens`，成本汇总仍按完整 prompt 计费，缓存只作为拆分字段。

`tests/context-cost.e2e.mjs` 分两段：

- 缓存段：单 Session 连续 4 个短 turn，每轮只要求模型回复固定 marker、不调用工具；逐请求对 `messages` 的 `system` 部分取 SHA-256 前缀摘要，并要求第 2 个 turn 起出现缓存读。
- 裁剪段：向 Worker 工作区写入 600 行、约 54k 字符的日志文件，要求模型用一次 `read` 读取全文件；两套场景在同一 8,192 token 窗口、512 headroom、512 压缩输出的 profile 下分别运行，默认裁剪与不可达阈值（1,000,000 字符，等价关闭）对比 billed input。

## 实测结果

缓存段（4 次 turn 请求，system prompt 摘要恒为 `56b6afb1d117e9f7`）：

| 轮次 | billed input | 缓存读 | 说明 |
| --- | --- | --- | --- |
| 1 | 2,350 | 2,304 | 前缀含 system prompt 与工具 schema |
| 2 | 2,398 | 2,304 | 追加 1 条 assistant + 1 条 user |
| 3 | 2,431 | 2,304 | 同上 |
| 4 | 2,477 | 2,304 | 同上 |
| 合计 | 9,656 | 9,216 | 缓存读占比 95.4% |

命中上限是前缀本身的大小：每轮新增的 assistant 文本与下一轮用户消息不被缓存，`cached_tokens` 稳定停在 2,304。第一轮就命中说明该前缀此前已被同 key 请求写过；即使首轮为 0，第 2 轮起也必须出现缓存读，脚本按“后三轮至少两轮命中”断言。

裁剪段（同一大文件、同一提示词、一次性 `read`）：

| 场景 | billed input 合计 | 单请求峰值 | 压缩请求数 | 压缩 billed input | 裁剪事件数 |
| --- | --- | --- | --- | --- | --- |
| 默认裁剪（阈值 8,192 / head 4,096 / tail 1,024） | 5,111 | 2,735 | 0 | 0 | 1 |
| 关闭裁剪（阈值 1,000,000） | 21,601 | 19,225 | 1 | 2,747 | 0 |

默认裁剪把这一轮的 billed input 从 21,601 降到 5,111，省 16,490 token（76.3%），单请求峰值从 19,225 降到 2,735，并且不需要任何压缩请求；关闭裁剪时，超出窗口的 `read` 结果触发一次压缩（2,747 token），压缩后仍在 21,601 的水平上。

## 默认策略

1. 保留 `tool-result-pruner` 默认阈值（`thresholdChars: 8192`、`headChars: 4096`、`tailChars: 1024`）。超过阈值的工具结果先裁剪成 head + marker + tail，原始事件保留在日志中，模型需要完整内容时可再用 `read` 的 `offset`/`limit` 分页取。默认阈值下本例没有触发压缩，成本比“不裁剪 + 压缩”低一个数量级。
2. 保持 system prompt 逐轮字节稳定，并把动态内容（runtime-context 快照、时间采样）放在历史末尾或按需替换，不进请求前缀。本 PoC 的 `SystemPromptProjection` 在渲染结果不变时不提交替换，`RuntimeContextProjection` 在快照相同时不追加，这两点让 4 轮 system 部分摘要保持一致。
3. usage ledger 必须同时记录完整 prompt 计数与缓存读写拆分，否则缓存命中率不可观测，成本策略只能靠猜。
4. 工具结果裁剪是有损的：保留的是首尾而非全文中段。依赖完整日志的任务应改用分页读取，而不是调高阈值。

## 复跑

```sh
DSH_POC_ENV_FILE=docs/drafts/.env node docs/drafts/browser-native-dsh-poc/tests/context-cost.e2e.mjs
```

上一次全绿输出：

```json
{"result":"passed","model":"LongCat-2.5","systemPromptDigests":["56b6afb1d117e9f7"],"cache":{"requests":4,"billedInput":9656,"cacheReadTokens":9216,"cacheReadRatio":0.954,"turns":[{"billedInput":2350,"cacheReadTokens":2304},{"billedInput":2398,"cacheReadTokens":2304},{"billedInput":2431,"cacheReadTokens":2304},{"billedInput":2477,"cacheReadTokens":2304}]},"pruning":{"default-pruner":{"totalBilledInput":5111,"peakRequestInput":2735,"compactionRequests":0,"compactionBilledInput":0,"prunedEvents":1},"pruner-disabled":{"totalBilledInput":21601,"peakRequestInput":19225,"compactionRequests":1,"compactionBilledInput":2747,"prunedEvents":0},"savings":16490,"savingsRatio":0.763}}
```

## 边界

只验证一个 OpenAI-compatible 网关和一个模型；缓存字段名（`prompt_tokens_details.cached_tokens`、`prompt_cache_hit_tokens`）按现有 provider 兼容层读取，其他网关若不返回该字段，脚本会在缓存断言处失败而不是静默跳过。裁剪对比是单 turn 单工具结果，未覆盖多工具、并行 `read` 与长会话多次裁剪的累积效果；压缩阈值来自测试 profile 覆盖，生产窗口由 profile 配置决定。provider 侧的缓存 TTL、跨进程共享与计费折扣不在本测量范围内。
