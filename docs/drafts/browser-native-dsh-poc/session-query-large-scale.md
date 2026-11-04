---
description: "Browser-Native PoC 的跨 Session 全文检索大语料验证：240 Session、28,800 事件的正确性与时延曲线，并给出浏览器线性回退的可接受上限。"
---

# Browser-Native 跨 Session 检索：240 Session 与 28,800 事件

本记录把上一轮的 120 Session、3 条短事件语料扩展到 240 Session × 120 事件（28,800 条事件），验证浏览器内的全局全文检索在“200+ Session、事件总量较大”时是否仍然正确，并给出可接受的交互与批量上限。

## 运行配置

`tests/session-query-large-scale.e2e.mjs` 使用 `browser-session-query` roster，探针与上一轮相同：[browser-native-session-query.ts](browser-native-session-query.ts) 只调用已挂载的 `sessionQuery` 服务并向页面回报耗时与命中。验证镜像仍把 `openAt` 设为 `first-search`，因此每次检索都会先尝试 SQLite 索引并失败：

```text
session-search SQLite index failed to open: web-preview: node:sqlite.DatabaseSync is not available in the worker host
```

失败后探针退化为线性扫描：逐 Session `readSession()`，在事件序列化文本上做大小写不敏感字面匹配，每个 Session 只取第一条命中。语料分两阶段建立，使语料翻倍的代价可以直接测量：

- 阶段 A：120 个 alpha Session（`cwd=/dsh/home/query-large-alpha`），每个 120 条 `user/message`，第 60 条含 `NEEDLE_OMEGA`。其中最新的 Session 在第 30 与第 90 条各有一个 needle，用于验证“只报第一条命中”；另在第 61 条写入只出现一次的 `RARE_OMEGA`。
- 阶段 B：再建 120 个 beta Session（`cwd=/dsh/home/query-large-beta`），每个 120 条不含 needle 的普通消息。总语料 240 个种子 Session + 1 个 preview Session = 241，共 28,800 条种子事件。
- 每个 Session 创建后立即 `close`，释放后端挂载槽，避免 16 个并发挂载上限阻断种子。

## 正确性

```json
{
  "needle": { "expected": 120, "actual": 120, "uniqueHits": 100, "firstHitSeq": 30 },
  "rare": { "expected": 1, "actual": 1, "sessionId": "query-large-session-119", "seq": 61 },
  "everywhere": { "expected": 240, "actual": 240 },
  "absent": { "expected": 0, "actual": 0 },
  "repeatedSearch": "identical",
  "cwdFilter": { "expected": 120, "actual": 120 },
  "withinSession": { "sessionId": "query-large-session-000", "hits": 1, "ms": 6.5 },
  "backend": "linear-fallback"
}
```

- 召回完整：只在 120 个 alpha Session 出现的 `NEEDLE_OMEGA` 恰好命中 120 个 Session；语料翻倍后不增加也不遗漏。
- 无误报：只出现在最新 Session 第 61 条的 `RARE_OMEGA` 只命中 1 个 Session，且序号正确；完全不存在的标记命中 0。
- 首条语义稳定：同一 Session 有两条 needle 时返回第 30 条而不是第 90 条；每个命中 Session 的序号与写入位置一致。
- 每 Session 一条：返回的命中 Session 不重复，全部属于种子集合；`matched` 计数与上限无关，命中列表按探针上限 100 截断，所以完整性以 `matched` 判定。
- 全事件命中：`routine` 出现在每条事件中，240 个 Session 全部命中，且每个 Session 报第 0 条。
- 过滤与范围内检索：`cwd` 精确过滤返回恰好 120 个 beta Session；单 Session 内检索在 120 条事件里命中 1 条，6.5 ms。
- 重复查询返回相同的 Session 与序号集合，说明线性回退没有依赖遍历顺序的随机性。

## 时延曲线

```json
{
  "phaseA": { "sessions": 121, "events": 14400, "searchMs": 1090.4 },
  "phaseB": { "sessions": 241, "events": 28800, "searchMs": 2038.5 },
  "timings": { "listMs": 4.6, "filterMs": 4.8, "withinSessionMs": 6.5, "marginalMsPerThousandEvents": 65.8 }
}
```

语料从 14,400 条事件翻倍到 28,800 条，检索从 1.09 s 增到 2.04 s，边际成本约 66 ms / 1,000 条事件；列表 4.6 ms、`cwd` 过滤 4.8 ms 基本不随事件量增长。成本主体是逐 Session 读取并重放事件，而不是匹配本身，因此 Session 数与大转录长度都会线性叠加。

由此给出可接受上限：

- 交互式检索（边输入边出结果）目标 ≤ 300 ms，对应约 4,000 条事件或约 35 个 120 条事件的长 Session；当前回退不满足，需要服务端索引。
- 显式提交、带 loading 的检索可接受上限 ≤ 3 s，对应约 40,000 条事件（约 350 个同等长 Session）。本轮 28,800 条事件实测 2.04 s，在 3 s 内，属于“可接受但不可交互”。
- 超过约 40,000 条事件或 350 个长 Session 后，浏览器线性回退不再是可接受路径，必须切到服务端全文索引（增量写入、排名与高亮），Worker 只保留列表、精确过滤与小语料回退。
- PoC 断言保留 10 s 机器容差（`searchMs`），用于吸收 CI 与开发机差异；产品结论以上面的 3 s 上限为准。

## 边界

- 探针把语料截断在前 500 个 Session，且每 Session 只返回第一条命中；没有排名、分页游标与高亮语义，命中上限 100。
- 所有种子属于同一个浏览器 principal；跨 principal 可见性仍由既有 Session principal 校验承担，本轮未重复验证。
- 未测 1,000+ Session 或数万条事件并发检索；边际成本已经给出线性模型，可直接外推但需要服务端索引才能改变量级。
- 本轮的 SQLite 索引不可用是执行位置限制（Worker 无 `node:sqlite.DatabaseSync`），不是配置错误；正式 Web 部署仍把 `openAt` 保持为 `never`。

复跑：

```sh
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-query-large-scale.e2e.mjs
```

语料规模可用 `DSH_POC_QUERY_SESSIONS` 与 `DSH_POC_QUERY_EVENTS` 覆盖，用于定位拐点。
