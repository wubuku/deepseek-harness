---
description: "在真实 Anthropic 兼容端点上测量 cache_control 的 cache_creation/cache_read 与成本影响，并给出是否依赖 prompt caching 的结论。"
---

# Provider 侧 Prompt Caching 实测

## 结论

**不依赖显式 `cache_control` 做成本规划。** 在唯一可用的 Anthropic 兼容端点（MiniMax-M3）上，`cache_control` 被接受，但三轮相同前缀请求的 `cache_creation_input_tokens` 始终为 0，`cache_read_input_tokens` 与不加标记时没有可判定差异；命中来自 provider 对**完全相同 prompt** 的自动复用，不是 `cache_control` 触发的。加标记与不加标记的输入成本差在 ±2.3% 内，属于噪声。

因此产品侧口径是：按完整 prompt 计费做预算上限；稳定前缀与稳定工具定义只作为常规命中卫生，不承诺命中率或折扣；把 cache 命中当作 provider 的额外收益，不当成交付依赖。真实 Anthropic 官方端点在本环境没有凭据，**未实测**；不得把本页结论外推到官方 Anthropic。

## 测量方法

入口是 `tests/prompt-caching.e2e.mjs`，分两段：

1. **确定性翻译段**：本地 Anthropic SSE 上游断言 PoC proxy 的三件事——`promptCaching: true` 在 system block 末尾恰好加一个 `cache_control: {type:'ephemeral'}`；默认请求不加；`cache_read_input_tokens`/`cache_creation_input_tokens` 进入 usage chunk 与审计字段。没有这段就无法区分“provider 不生效”和“proxy 没发出去”。
2. **真实端点段**：同一 backend 流式路径，先发 3 次带标记请求、再发 3 次不带标记请求。每种模式使用唯一的随机词前缀（1500 个随机词，约 7k tokens）和相同 user 文本，避免重复样板文本被 provider 自动复用而冒充 `cache_control` 效果。两模式的 prompt token 总量必须相差 ≤5%，否则判定为测量无效并失败。

命中率按 `cache_read / (uncached_input + cache_read + cache_write)` 计算。成本影响用 Anthropic 公开的缓存乘数（cache write 1.25×、cache read 0.1× 基础输入价）做**情景换算**；MiniMax 的实际账单单价未知，不把该乘数当作账单结论。

## 实测结果

MiniMax-M3，2026-11-04，3+3 次流式请求：

| 模式 | prompt tokens（3 次合计） | uncached input | cache read | cache write | 命中率 | 输入成本单位（情景） |
| --- | --- | --- | --- | --- | --- | --- |
| `promptCaching: true` | 20,934 | 6,982 | 13,952 | 0 | 66.6% | 8,377.2 |
| 未加标记 | 20,823 | 6,784 | 14,039 | 0 | 67.4% | 8,187.9 |

逐次行为：

- 第 1 次两种模式都只读回 128–159 tokens（约 2% 前缀），其余按 uncached input 计费；说明没有可用的冷启动 cache write。
- 第 2、3 次两种模式都读回约 6.9k tokens，uncached input 降到 1 或 66；**未加标记也命中**。
- 带标记比不带的输入成本高约 2.3%，原因是第 2、3 次的 uncached 残量 66 vs 1，不是 cache write 费用。

这组数据支持两个判定：provider 侧存在自动 prompt 复用；`cache_control` 没有产生可观测的 cache creation，也没有改变命中结构。`cacheReadRatio` 约 0.67 是因为三轮里只有后两轮命中，不是单次请求的稳定命中率。

## 对产品成本的影响

- 若 provider 按 cache read 折扣计费，两种模式的账单结构相同；显式标记不带来额外折扣。
- 若 provider 不区分 cache read，两种模式的账单就是全量 prompt；现有 PoC usage ledger 的 `inputTokens` 已是完整 prompt，预算与费用报表不需要为 cache 做特殊处理。
- 若未来接入官方 Anthropic，必须先在目标账号上复跑本脚本：官方实现会报告 `cache_creation_input_tokens`，并以 5 分钟 TTL 续写；本页的 MiniMax 数据不能替代该验证。

## 复现

只跑确定性翻译段（无需凭据）：

```sh
node docs/drafts/browser-native-dsh-poc/tests/prompt-caching.e2e.mjs
```

跑真实端点（读取 backend-only 凭据文件）：

```sh
DSH_POC_ENV_FILE=docs/drafts/.env \
  node docs/drafts/browser-native-dsh-poc/tests/prompt-caching.e2e.mjs
```

脚本对真实段输出一行 JSON，包含两种模式的逐次 usage、命中率、成本情景与三条结论（`explicitCacheCreationReported`、`automaticProviderCaching`、`markerChangedCost`）。真实模式请求失败、HTTP 非 200、prompt 总量不一致都会非零退出；“cache-not-effective” 本身是合法测量结果，不以失败退出。

## 边界

- 只测到 MiniMax-M3 的 Anthropic 兼容端点；MiniMax 官方文档中的自动上下文缓存与本页观测一致，但本页数据不证明官方 Anthropic 的行为。
- 每模式 3 次请求、单进程、单账号；未覆盖并发请求、跨账号共享缓存、cache TTL 过期、长会话多断点与不同 `max_tokens`。
- 未测 OpenAI 兼容 provider 的 `prompt_cache_hit_tokens` 路径；PoC 的 OpenAI usage 解析保持不变。
- 成本乘数是 Anthropic 公开值的情景换算，不是 MiniMax 账单；未做发票或账单对账。
