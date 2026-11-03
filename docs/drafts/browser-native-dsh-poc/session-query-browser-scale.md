---
description: "Browser-Native PoC 的会话检索规模验证：120+ Session 下列表与 cwd 过滤的时延和正确性，以及 Worker 内全文检索为何退化为线性扫描。"
---

# Browser-Native 会话检索与规模上限验证

本记录验证浏览器 Worker 内的会话检索能力：在 120 个已持久化 Session 的规模下，`session-query` 的列表、精确过滤与全文检索的时延与命中是否正确；同时给出当前部署下可接受的上限和必须依赖服务端的部分。

## 运行位置与配置

Web profile 本身已挂载 `@deepseek-ai/dsh-session-query` 的 SQLite 引擎；`dsh-web-app` 的 `cordis.patch.yml` 将 `openAt` 设为 `never`，即部署默认关闭内容索引。验证 roster `browser-session-query` 在验证镜像里做了两件事：

- 追加 `session-query-sqlite` 覆盖层，`path: ':memory:'`、`openAt: 'first-search'`，用于尝试打开真实索引。
- 插入 validation-only [browser-native-session-query.ts](browser-native-session-query.ts) 探针插件，通过 `ctx.inject(['sessionQuery'])` 绑定已挂载的服务并测量其公开方法。

探针不实现检索逻辑，只调用 `listSessions()`、`filterSessions([{kind:'cwd'}])`、`searchSessions()` 与 `searchEvents()`，并记录耗时与命中。

## 规模数据与正确性

`tests/session-query-scale.e2e.mjs` 用 scripted 模式预置 120 个 Session（60 个 `cwd=/dsh/home/query-alpha`，60 个 `cwd=/dsh/home/query-beta`，每个 3 条 `user/message`），其中 alpha 的第二条含 `NEEDLE_ALPHA` 标记、beta 的第三条含 `NEEDLE_BETA`。每个 Session 创建后立即 `close` 释放准入挂载槽，避免 16 挂载上限阻断种子数据。运行输出：

```json
{
  "scope": "browser-session-query-scale",
  "sessions": 121,
  "correctness": {
    "cwdFilter": { "expected": 60, "actual": 60, "exact": true },
    "textSearch": {
      "expected": 60,
      "actual": 60,
      "unique": 60,
      "snippetSample": "[{\"type\":\"text\",\"text\":\"NEEDLE_ALPHA payload 118\"}]}}",
      "backend": "linear-fallback",
      "shippedIndexError": "session-search SQLite index failed to open: web-preview: node:sqlite.DatabaseSync is not available in the worker host"
    },
    "withinSession": { "sessionId": "query-session-000", "hits": 1, "ms": 1.9 }
  },
  "timings": { "listMs": 3.2, "filterMs": 2.6, "searchMs": 255.8, "withinSessionMs": 1.9 },
  "acceptableLimits": { "listMs": 2000, "filterMs": 2000, "searchMs": 20000, "withinSessionMs": 2000 }
}
```

121 是 120 个种子 Session 加 1 个 preview 自身 Session。cwd 过滤与全文检索分别恰好命中 60 个目标 Session，无重复、无遗漏；单 Session 内检索命中 1 条。

## 全文检索的部署限制

验证镜像把 `openAt` 改为 `first-search` 后，首次检索仍失败：`node:sqlite.DatabaseSync is not available in the worker host`。也就是说浏览器 Worker 无法打开随包发布的 SQLite 索引，`searchSessions()` 在当前执行位置没有可用 provider。探针在这一步退化为线性扫描：逐 Session `readSession()` 后在事件序列化文本中做大小写不敏感字面匹配，得到上表的 `linear-fallback` 结果与 255.8 ms 时延。

由此得出可接受上限与结论：

- 列表与 cwd 精确过滤在 120 Session 规模下均为个位数毫秒，本轮上限取 2 秒，余量充足，可留在 Worker。
- 本语料（121 Session × 3 条短事件）的线性全文扫描 255.8 ms，本轮上限取 20 秒；该成本随事件总量线性增长，1000 Session 或长转录下不可直接外推。
- SQLite 全文索引在 Worker 内不可用，若产品要求带排名/高亮/大语料检索，必须有服务端检索依赖；Worker 只适合列表、精确过滤和小语料线性回退。

## 顺带修复：持久化列表只取第一页

种子达到 51 个 Session 时语料只看到 51（50 条首屏 + 1 个 preview Session），说明 [browser-native-providers.ts](browser-native-providers.ts) 的 `list()` 只请求了一次后端 `list`。后端 `list` 默认每页 50 条并返回 `hasMore`/`nextCursor`；现在 `list()` 循环翻页直到 `hasMore` 为 false，120 Session 才能完整进入语料。没有这个修复，100+ 规模的所有检索结论都不成立。

## 残余缺口

- 探针的线性回退只扫描前 500 个 Session，且只返回每 Session 的第一条命中；没有排名、分页游标或高亮语义。
- 没有测 1000+ Session、长转录（数万事件）或并发检索；该成本模型仍是线性的。
- `filterSessions` 只验证了 `cwd` 单一过滤键；时间、标题、状态等过滤未覆盖。
- 所有种子 Session 属于同一个浏览器 principal；跨 principal 隔离依赖既有 Session principal 校验，本轮未重复验证。
- `openAt: 'first-search'` 只出现在验证镜像；正式 Web 部署仍是 `never`，因此正式产品不会在 Worker 内部建索引。
