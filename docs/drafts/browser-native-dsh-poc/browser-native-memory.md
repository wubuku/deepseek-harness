# Worker 内 Session 记忆：成本、正确性与隔离

[记忆机制研究](../dsh-memory-mechanisms-research.md)的结论是：记忆属于完整 capability seam，由 Service Definition / Provider / Consumer 三个角色组成；consumer 只能在显式工具里产生带来源的 durable context，不能用旁路拼接把内容塞进请求。本批把这条结论落进 Browser-Native Worker：`browser-native-memory.ts` 提供 OPFS 存储 provider，`memory` 工具是唯一的 consumer，每次写入追加 `memory/entry` Session 事件，使模型看到的内容可从 Session 日志重建。

## Provider 与 Consumer

`BrowserNativeMemoryStore` 按 `(workspaceId, sessionId)` 写一个 JSON 文件，路径为 OPFS 的 `dsh-browser-native-memory-v1/<workspaceId>/<sessionId>.json`。文件头记录同一对 id；读取时只要文件头的 workspace 或 session 与目标 scope 不一致，就抛出 `MEMORY_ISOLATION_VIOLATION`，不返回任何条目。

`memory` 工具的动作是 `write` / `recall` / `forget`。工具 schema 只暴露 `action`、`text`、`tags`、`query`、`id`、`limit`，没有 `sessionId` 或 `workspaceId`：scope 由 `exec.agent.session.id` 和 Workspace runtime 在工具内部派生，模型无法选择作用域。`write` 先写 OPFS，成功后才 `session.append('memory/entry', …)`，因此日志不会记录未落盘的条目。

`recall` 只在工具调用时读取本 scope 的文件，按关键词包含打分与创建时间倒序排序，受 `MAX_RECALL_ENTRIES` 与 `MAX_RECALL_CHARS` 预算约束，超出部分计入 `omitted`。没有“每轮自动注入记忆”的路径，召回内容只作为这次工具结果进入请求。

## 隔离证据

`tests/memory-isolation.e2e.mjs` 用 scripted 模型驱动真实 `memory` 工具，页面刷新后继续用原 Session id 读取。三类隔离各有一条断言：

- **跨 Session**：probe 以 `memory-isolated-<uuid>` 直接写第二个 scope。A 读取只含 A 的条目，B 读取只含 B 的条目，两条都不含对方的 marker。
- **文件头篡改**：把 B 的文件头改为 A 的 session id 后读取 B，返回 `MEMORY_ISOLATION_VIOLATION`，即 fail closed。
- **跨 BrowserContext**：第二个 `BrowserContext` 的 Worker 读取同一 `workspaceId`/`sessionId` 得到 0 条，`memory-list` 为空。OPFS 按 origin + storage partition 隔离，另一个上下文没有第一个上下文的文件。

同一测试还断言模型请求里的 `memory` 工具 schema 不含 `sessionId`，工具调用参数也不含它。

## 成本

最近一次 Chrome scripted 运行（同一 Worker 内 8 次写入 + 8 次读取；两次运行的写入中位数为 1.2–1.7 ms，读取 0.5–0.6 ms）：

```json
{"scope":{"kind":"workspace+session+opfs-file","headerTamper":"MEMORY_ISOLATION_VIOLATION"},"persistence":{"eventsAfterReload":1,"bytes":320},"isolation":{"sessionA":{"entries":1,"hasA":true,"hasB":false},"sessionB":{"entries":1,"hasA":false,"hasB":true},"files":["memory-isolated-53048ef3-507e-44d8-b6ec-b64c228e024d.json","session-34a4f255-dc7c-4886-bee3-19886cb04cda.json"],"crossContext":{"entries":0,"files":[]}},"cost":{"writeMs":{"median":1.2,"max":1.3},"readMs":{"median":0.5,"max":0.6},"bytes":1366,"entries":8,"toolTurnMs":{"write":158,"recall":137}}}
```

8 条 48 字符条目合计 1,366 bytes。单次 OPFS 写入中位数 1.2–1.7 ms、读取 0.5–0.6 ms，均不含工具调度与模型往返；脚本模型的 tool turn 为 137–256 ms，其中绝大部分是 turn 与 stream 的固定开销。写入成本随条目数线性增长的部分来自整文件重写的 `writeEntry`。

## 验证

```sh
pnpm run build:artifacts
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/memory-isolation.e2e.mjs
```

测试资产：`createRuntimeValidationDist({ memoryIsolation: true })` 才把 `tool-memory` 注入验证 preset，`runtime-validation.mjs` 把 `browser-native-memory.js` 放进 `home/profiles/web/`，因为 preset 的相对名按 profile 目录解析。Worker 只有在 preview URL 带 `browser-native-test=memory-isolation` 时才启用 `enableMemoryIsolationValidation()`，把这个工具加入发布名单。两者必须同时开启：否则模型请求会因未发布的工具 schema 直接失败，而不是静默跳过。正式 `browser-native-profile.cordis.patch.yml` 不注册它。

## 缺口

- `recall` 的检索是关键词包含加时间倒序，没有向量检索、去重、冲突消解或条目编辑；`forget` 只能按 id 删除。
- 256 条上限与 4,096 字符单条上限是模块常量，不是 profile 配置项，部署无法调整。
- 每个 scope 整文件读写，条目接近上限时写入成本随文件大小增长；没有增量追加或分段文件。
- 只有验证 roster 注册该工具；正式 preview 里模型看不到 `memory`。要在产品 profile 使用，需要同时把它加入发布名单并设计 UI 卡片。
- 测试只覆盖单 Worker 内的两个 scope 和第二 BrowserContext，没有真实的多 Session 并行编排；preview UI 也没有切换 Session 的入口。
- OPFS 配额、存储持久化许可与清理策略未验证；`memory-list` 只用于测试。
