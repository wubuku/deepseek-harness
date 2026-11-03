---
description: "在真实 LongCat-2.5 上把 profile 窗口降到 8192、headroom 512，第 5 turn 触发真实 compaction，用 provider 上报的 usage 记录 30,951 tokens，并验证摘要保留首轮码字、刷新重建与继续。"
---

# 真实模型 8k 窗口 compaction 质量

## Summary

[real-compaction.e2e.mjs](tests/real-compaction.e2e.mjs) 让 backend 以真实 LongCat-2.5 运行且**不声明** `contextWindow`，profile 声明 `8192` 窗口与 `512` headroom，压力线为 `min(0.8 × 8192, 8192 − 512) = 6553` tokens。每 turn 追加 4,000 字符参考文本并要求模型只回 `OK`；第 **5** turn 触发自动 compaction，产生 1 组 `compaction/start`、`compaction/summary`、`compaction/end`，没有 error end。

首轮只出现一次的访问码字 `ORANGE-FALCON-42` 不在保留尾部内，召回必须依赖摘要本身。第 6 turn 直接提问，模型仅回复该码字（16 字符），说明真实摘要保留了该事实。flush 后 durable JSON 86,084 bytes、63 个事件；刷新后 `compaction/start` 与 `compaction/summary` 各 1 条完整重建，第 7 turn 继续完成。全程 `no context capacity` 与 `headroom tokens` 警告为 0，页面无异常、无跨源请求。

provider 上报的 usage 覆盖 7 次请求（含 1 次摘要请求）：输入 30,064 tokens、输出 887 tokens、合计 30,951 tokens。按公开 API 计价量级，这次运行属于几万 tokens 的低成本档；具体金额取决于 LongCat 当时的单价，测试只记录可复核的 token 数。

## 配置与触发

- `createRuntimeValidationDist` 新增 `contextWindow`、`compactHeadroomTokens`、`compactMaxTokens` 三个可选覆盖；测试传入 `8192`、`512`、`1024`，其余 profile 内容不变。
- backend 真实模式新增 `llmIncludeUsage`；开启时向上游发送 `stream_options: { include_usage: true }`，并把 `prompt_tokens`/`completion_tokens`/`total_tokens` 转成 adapter 的 `usage` chunk。`compaction/summary` 与 `assistant/message` 因此记录 provider 上报的 token 数，而不是字符估算。
- 摘要 cap 必须从 profile 的 `512` 提到 `1024`：512 时 LongCat 的 checkpoint 输出被 `summarization truncated at the token cap` 截断，compaction 以 error end 收束；1024 时摘要 1,548 字符、输出 682 tokens，正常结算。
- 请求超时任取 240 秒，单 turn 等待 300 秒；该 provider 在同样的 4k 字符 prompt 上出现过超过 120 秒的响应，租约与超时不能按 scripted 量级设置。

## 质量结果

| 断言 | 观测 |
|---|---|
| 压力触发 | 8192 窗口、512 headroom、第 5 turn 自动触发 |
| 摘要结算 | 1 start / 1 summary / 1 end，无 error |
| 摘要规模 | 1,548 字符，遮蔽 3,300 tokens |
| 摘要用量 | 输入 4,916 / 输出 682 / 合计 5,598 tokens |
| 关键事实 | 首轮码字 `ORANGE-FALCON-42` 在第 6 turn 被原样召回 |
| 刷新重建 | 63 个事件，compaction start/summary 各 1 条，摘要文本非空 |
| 继续会话 | 第 7 turn `completed` |
| 用量合计 | 7 次请求，输入 30,064 / 输出 887 / 合计 30,951 tokens |
| 失败噪声 | 警告 0、页面错误 0、跨源请求 0 |

## 证据

```json
{"result":"passed","scope":"real-model-compaction","browser":"156.0.8078.80",
 "provider":"longcat","model":"LongCat-2.5","declaredWindow":8192,"headroomTokens":512,
 "pressureTokens":6553,"fillerChars":4000,"turnsToCompaction":5,
 "compaction":{"starts":1,"summaries":1,"ends":1,"provider":"browser-native","model":"browser-native",
 "summaryChars":1548,"shadowedTokenCount":3300,
 "summaryUsage":{"inputTokens":4916,"outputTokens":682,"totalTokens":5598}},
 "recall":{"turn":6,"codeword":"ORANGE-FALCON-42","recalled":true,"answerChars":16},
 "usage":{"source":"provider","requests":7,"compactionRequests":1,
 "inputTokens":30064,"outputTokens":887,"totalTokens":30951},
 "afterReload":{"events":63,"starts":1,"summaries":1},"continuedTurn":7,
 "durableBytes":86084,"llmRequestBodies":8,"durationMs":211118,
 "turnLatencyMedianMs":2422,"externalRequests":0,"pageErrors":[],"warnings":0}
```

- `provider/model` 为 `browser-native`：Session 记录 profile 的逻辑路由，不泄露上游名字；上游真实性由 provider 上报的 usage 与 `llmRequestBodies` 共同证明。
- `llmRequestBodies=8` 高于 usage 的 7 次，差额是会话标题生成请求，不参与上下文压力。

## 判定

**小窗口真实 compaction 可用，但摘要 cap 与超时不能沿用 scripted 量级。** 8192 窗口在第 5 turn 按 80% 压力线触发；真实摘要保留了首轮唯一码字，刷新后事件可重建，压缩后的 Session 可继续。512 token 的摘要 cap 对 LongCat 不足，profile 若面向真实模型应提供更大的 cap 或按模型调整；240 秒超时是慢响应的最低要求，不是性能目标。

## 复跑

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
  node docs/drafts/browser-native-dsh-poc/tests/real-compaction.e2e.mjs
```

可用 `DSH_POC_REAL_COMPACTION_WINDOW`、`_HEADROOM`、`_FILLER_CHARS`、`_MAX_TURNS`、`_SUMMARY_TOKENS`、`_LLM_TIMEOUT_MS` 调整窗口与预算。

## 限制

- 只验证 LongCat-2.5 一次；其他模型的摘要格式、token 计价与响应延迟未覆盖。
- 召回只检查一个码字，未评估长事实表、数值、路径或多次压缩后的摘要链。
- 摘要质量依赖 compaction-basic 的固定提示词；模型不服从时会在召回断言处失败，而不是自动重试。
- usage 只在 provider 支持 `stream_options.include_usage` 时存在；不支持时测试直接失败，不回退到字符估算。
- 费用只给 token 量级，没有账单对账、限流或 429/5xx 注入。
