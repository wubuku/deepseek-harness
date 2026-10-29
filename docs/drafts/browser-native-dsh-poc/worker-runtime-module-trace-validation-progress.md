---
description: "记录 Browser-Native Worker 运行时模块追踪、静态请求图对账及 Chrome 验收进度。"
---

# Browser-Native Worker 运行时模块追踪验证进度

## 当前状态

状态：M0–M4 已完成；功能实现已提交到 `research`，类型修复和最终文档记录待提交，之后推送。批次开始时 `research` 工作区干净；本批在主 worktree 实施，没有隔离 worktree。目标和验收标准见[验证计划](worker-runtime-module-trace-validation-plan.md)。

本批只验证 Chrome；Safari/WebKit 暂停。真实模型凭据由 backend 从 `docs/drafts/.env` 读取，不复制、不打印，也不进入 Worker trace。

## 里程碑

| 里程碑 | 状态 | 证据 | 下一步 |
|---|---|---|---|
| M0：观察入口与字段设计 | `complete` | 核对 packer 静态请求 schema、`WorkerModuleLoader` resolver/load/cache、Worker Host options 和 PoC test MessagePort。 | 为请求与加载事件实现单一 loader 追踪源。 |
| M1：opt-in 有界追踪 | `complete` | `WorkerModuleLoader` 记录 request/load、resolver 类型、importer、目标、失败代码和缓存命中；无配置时不保存记录。容量、溢出、动态延迟 require importer、内部 ESM import、失败和关闭语义单测通过。 | 仅在 PoC test MessagePort 存在时由 Worker Host 启用，限制为 50,000 条。 |
| M2：静态图与 Chrome 对账 | `complete` | Chrome 156.0.8078.48 scripted default-profile Worker 执行 DSH shell 工具并取回 trace：5,237 events、2,703 requests、2,534 loads、`droppedEvents=0`。与 4,252 条 packer 静态请求边匹配 2,243 条；240 条 unmatched 分为 201 条 home overlay、7 条 Worker bootstrap、32 条镜像内运行时请求。另有 2 条静态 unresolved 边在运行时由 Worker static `process` 模块解决。 | 匹配数不是覆盖率或可用率；32 条镜像内运行时边需与 64 条静态 unresolved external 分开解释。 |
| M3：真实 LLM smoke | `complete` | Chrome 真实 `gpt-5.6-sol` 完成文件工具 `read → write → read`，刷新后恢复同一 Session 与 Workspace；8 个模型请求均 HTTP 200。Worker trace 为 5,226 events、`droppedEvents=0`；测试检查 Workspace 路径和凭据未出现在 trace 中，浏览器只访问同源 backend。 | 该结果只证明本次执行路径；日志另有既有 PoC 404 和 compaction capacity warning。 |
| M4：文档和交付 | `complete` | 已更新 PoC 计划/进度、兼容矩阵、README、目录索引、runtime package 中英 README、pairing record 和 change ledger；`pnpm run test:docs` 21/21、`pnpm run doc-sync` 43/43，定向 oxlint 通过。提交前增量类型检查发现 `apps/web/src/preview.ts` 导入 runtime package 根类型导致 TS6059/TS6307；改用本地测试响应 envelope 后 `pnpm run typecheck` 五项全过，preview 重建和真实 Chrome LLM smoke 均通过。 | 提交并推送 `research`，核验远端一致和工作区干净。 |

## 命令与结果

`git status --short --branch`：批次开始时位于 `research`，工作区干净；没有隔离 worktree。

`git worktree list`：只有主工作区 `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness`。

`node --test docs/drafts/browser-native-dsh-poc/tests/worker-module-trace-report.test.mjs`：2/2 通过；`pnpm exec vitest run packages/experimental/webworker-runtime/tests/module-system/module-loader-trace.spec.ts packages/experimental/webworker-runtime/tests/node/require-builtin.spec.ts`：18/18 通过；`pnpm exec tsc -b packages/experimental/webworker-runtime/tsconfig.json`：通过。

`pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`：通过，Worker image 为 1,350 个 JavaScript entries、3,608 个文件、64 条 unresolved third-party requests；构建保留现有 native platform 与 chunk-size 警告。

`pnpm exec tsx scripts/run-oxlint.ts apps/web/src/preview.ts packages/experimental/webworker-runtime/src/index.ts packages/experimental/webworker-runtime/src/module-system/module-loader.ts packages/experimental/webworker-runtime/src/worker-host.ts packages/experimental/webworker-runtime/tests/module-system/module-loader-trace.spec.ts docs/drafts/browser-native-dsh-poc/tests/default-profile-capabilities.e2e.mjs docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs docs/drafts/browser-native-dsh-poc/tests/worker-module-trace-report.mjs docs/drafts/browser-native-dsh-poc/tests/worker-module-trace-report.test.mjs`：通过。`pnpm run test:docs`：21/21；`pnpm run doc-sync`：43/43。首次快检因进度文档记录短 commit hash 被 repository-reference gate 拒绝；改为分支状态描述后通过。

Chrome scripted 命令：`env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js DSH_POC_MODULE_TRACE_REPORT=docs/drafts/browser-native-dsh-poc/worker-runtime-module-trace-report.json node docs/drafts/browser-native-dsh-poc/tests/default-profile-capabilities.e2e.mjs`：通过。shell 正向/负向路径、Session tool call/result checkpoint 和压缩均通过；页面无错误或跨源请求。

真实 LLM 命令：`env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_MODULE_TRACE=1 DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ROSTER=browser DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_LLM_TIMEOUT_MS=180000 DSH_POC_CONTEXT_WINDOW=32768 DSH_POC_TURN_TIMEOUT_MS=600000 DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs`：通过。真实 `gpt-5.6-sol` 完成 DSH 文件工具 `read → write → read`、刷新后的 Session/Workspace 恢复、同源代理和凭据隔离检查；8 个模型请求 HTTP 200，trace 5,226 events 且无溢出。日志另有既有 PoC 404 与 compaction capacity warning，不是零告警运行。

提交前的真实 Chrome smoke 首次收到两个 HTTP 200，但第一个模型步骤以 `UPSTREAM_LLM_EMPTY` 结束（无文本或工具调用）；该次未记作通过。未改代码重跑同一命令后通过：真实 `gpt-5.6-sol` 完成 `read → write → read` 和刷新恢复，Session 59 个事件、`durableThroughSeq=58`、Workspace 两次 commit 成功，8 个模型请求 HTTP 200，trace 5,226 events 且无溢出。页面无异常；保留既有同源 PoC 404 和 compaction capacity warning。

修复后 `pnpm run typecheck`：5/5 通过；`pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`：通过，1,350 个 JavaScript entries、3,608 个文件、64 条 unresolved third-party requests；保留既有平台、tsdown 和 chunk-size 警告。

packer 静态请求图共有 4,252 条边。Scripted Worker 有 2,483 个唯一运行时 request edges，其中 2,243 条匹配静态图；240 条未匹配边分为 `home/` profile overlay 201 条、Worker bootstrap 7 条、镜像内 computed/runtime-only 32 条。另有两条静态 unresolved `process` 请求由 Worker Host 自动安装的 static alias 解析。脱敏 JSON artifact 只保存计数和有限示例，不保存原始 trace。

## 风险与待验证

- 追踪只覆盖两条 Chrome 执行路径；静态边未被触发不表示模块不可达，运行时 resolution/load 也不证明 Node 导出成员行为兼容。
- 当前容量限制事件数而非字段字节数；该接口只用于可信测试诊断，不应接收不受信任的模块标识或持久化原始 trace。
- 模块路径和 specifier 本身会出现在 Worker 内的原始 trace；持久化报告只保存摘要。真实模型检查确认本次 trace 没有 Workspace 用户路径或 provider secret。
- Safari/WebKit、其他 profile、所有 unresolved import、全部 Node API、自然 eviction、OS crash 和生产 backend 未验证。

## 下一步

核对最终 diff 后提交并推送 `research`；不把静态闭包或有限 Chrome trace 描述为通用兼容性保证。
