---
description: "Browser-native DSH PoC 的 v2 规划和历史协议实验：保留 DSH Web UI、真实 Host/Agent Loop，并通过同源 Session backend 和 LLM proxy 接入浏览器 Worker。"
---

# Browser-native DSH PoC

## Summary

本目录包含多个阶段的研究材料。旧版是协议级独立 loop 实验；当前 v2 已经把现有 DSH Web UI、Cordis 插件组合和真实 `ctx.agentLoop` 放进 Dedicated Worker，并通过同源 backend 提供正式 Session persistence 和 LLM proxy。实施规格见 [browser-native-dsh-plan-v2.md](browser-native-dsh-plan-v2.md)，原始实施进度见 [browser-native-dsh-progress-v2.md](browser-native-dsh-progress-v2.md)。真实运行时验证命令见[运行时验证说明](runtime-validation-manual.md)，已验证结果、失败和未验证边界见[运行时验证报告](runtime-validation-report.md)，上一批验证计划与进度见[下一轮验证计划](next-validation-plan.md)及[进度记录](next-validation-progress.md)。云端 Workspace 增量同步的规划、文件变更矩阵、真实 Chrome/LLM、OS backend 重启与协议并发证据见[云端 Workspace 同步 PoC 规划](cloud-backed-workspace-sync-plan.md)及[实施进度](cloud-backed-workspace-sync-progress.md)；其自动化入口为 `tests/workspace-sync.e2e.mjs` 和 `tests/workspace-durability.test.mjs`。本批次 durable Workspace 的规划和进度见[规划](durable-workspace-plan.md)及[进度](durable-workspace-progress.md)。最新 P0 验证的计划、实际实现和限制见[下一批 P0 计划](next-high-value-validation-plan.md)及[实施进度](next-high-value-validation-progress.md)；随后离线 retry、CAS conflict 和过期 writer lease 的真实 Chrome 验证见[进阶恢复计划](advanced-recovery-validation-plan.md)及[进度记录](advanced-recovery-validation-progress.md)。再后的 OPFS quota 错误恢复、backend 重启租约 fencing 与同源身份存储隔离见[存储隔离计划](storage-isolation-and-restart-validation-plan.md)及[实测进度](storage-isolation-and-restart-validation-progress.md)。文件工具 durable 确认与易失状态隔离见[持久化确认计划](durable-tool-ack-validation-plan.md)、[持久化确认进度](durable-tool-ack-validation-progress.md)、[易失状态隔离计划](volatile-workspace-isolation-plan.md)和[隔离验证进度](volatile-workspace-isolation-progress.md)：本地保存失败会阻止 Agent 后续读写与搜索未确认的 Worker 内存文件，刷新后可在同 Session 显式重试。v2 的启动入口是 `run-v2.mjs`；旧 `run.mjs` 只属于历史协议实验。

需要进行真实浏览器验收时，使用两个 PoC 共用的[手动验收说明](manual-acceptance.md)；不要把旧版 `run.mjs` 或 `public/worker.js` 当作 v2 的启动入口。

旧实现验证了 Browser-native transport、Session durability、owner fencing、真实后端 LLM streaming、Tool bridge 和 Worker resume，但 Worker 使用目录内的 PoC-local loop adapter；它**没有**宣称现有 DSH `ctx.agentLoop` 已经在浏览器 Worker 中运行。旧版 [implementation-plan.md](implementation-plan.md)、[progress.md](progress.md) 和独立 HTML/loop 文件只用于追溯该协议实验，不能作为 v2 完成证明。

## v2 运行入口

v2 使用现有 `AppWebEntry`、现有 DSH Web UI 和由 Worker 承载的真实 Host。先构建 preview，再从本目录的 launcher 启动同源 Session/LLM backend：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
node docs/drafts/browser-native-dsh-poc/run-v2.mjs \
  --port 4185 \
  --data-dir /tmp/browser-native-dsh-v2 \
  --llm scripted
```

然后打开 launcher 输出的 `preview.html?browser-native=1&preview-fixture=none` 地址。`browser-native=1` 是显式 opt-in；不带该参数的默认 preview 仍使用上游 overlay 列表和 acceptance。

真实 provider 只在 backend 进程读取本机环境文件：

```sh
node docs/drafts/browser-native-dsh-poc/run-v2.mjs \
  --port 4185 \
  --data-dir /tmp/browser-native-dsh-v2-real \
  --llm real \
  --env-file docs/drafts/.env
```

本机真实 provider 配置文件是仓库根目录下的 `docs/drafts/.env`。API key 只存在 Node backend；不会发送给页面、Dedicated Worker、Session event、响应 body 或日志。不要把 `.env` 加入提交。

## Durable Workspace 增量验证

在浏览器内验证 OPFS bytes、IndexedDB snapshot 和 Worker 重建恢复时，使用额外的 `browser-native-durable=1` 参数；不带该参数仍是原有内存 Workspace mirror：

```text
http://127.0.0.1:<port>/preview.html?browser-native=1&browser-native-durable=1&preview-fixture=none
```

本批次实现只把 `MemoryVfs` 的文件变更异步写入 durable store，没有把 OPFS 伪装成完整 Node 文件系统，也没有改变 Session 与 Workspace 的非原子关系。规划、实际进度、失败记录和经验教训见 [durable-workspace-plan.md](durable-workspace-plan.md) 与 [durable-workspace-progress.md](durable-workspace-progress.md)；目录外 opt-in 接线见 [change-ledger.md](change-ledger.md)。

## 缓存重建、Agent edit receipt 与 lease 刷新验证

本批次的[计划](next-round-validation-plan.md)与[进度记录](next-round-validation-progress.md)覆盖三项真实 Chrome 验证：清除 OPFS/IndexedDB 后从 backend 重建已提交 Workspace；真实 DSH Loop 执行 `write → read → edit → write` 并关联 Session receipt；同一标签页刷新后恢复 Workspace writer lease，同时 fencing 旧 token，并注入一次“backend 已完成 resume、响应被丢弃”的故障。三项 E2E 均使用真实 Chrome、真实 Dedicated Worker/DSH Host 和 scripted LLM，不依赖真实模型。

在已安装 Playwright 的环境中运行：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview

export DSH_POC_BROWSER=chrome
export DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js

node docs/drafts/browser-native-dsh-poc/tests/durable-workspace-cache-reset.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-edit-receipt.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/workspace-writer-reload.e2e.mjs
```

若 Playwright 安装位置不同，请把 `DSH_POC_PLAYWRIGHT_MODULE` 改为当前环境中 `playwright` 的入口文件。刷新恢复仅适用于原标签页的 `sessionStorage` 凭据；旧凭据缺少 `resumeId` 时页面会先生成并保存一个稳定 ID。该 ID 使当前 backend 进程可以重放已成功但响应丢失的 resume，而 `requestId` 仍是每次 HTTP 请求各自的诊断标识。backend 必须轮换 writer token 并提升 fencing token。完全清除本地存储后，只能重建已提交到 backend 的文件；本地唯一持有的 dirty bytes、真实 quota/eviction、浏览器进程崩溃和生产级多租户授权不在本批验证范围内。

## 高价值验证批次

本批次围绕 Browser-Native DSH 的运行时正确性，不扩展 SaaS 或聊天 UI。计划和退出条件见[验证计划](high-value-validation-plan.md)，实际证据和限制见[验证进度](high-value-validation-progress.md)。

显式启用 Workspace writer lease 的浏览器入口需要增加 `browser-native-workspace-lease=1`：

```text
http://127.0.0.1:<port>/preview.html?browser-native=1&browser-native-durable=1&browser-native-workspace-lease=1&preview-fixture=none
```

本批次新增的模型无关验收覆盖上传失败、commit 响应丢失后的 operation 查询、真实 Chrome Worker/OPFS/IndexedDB、多页面 writer lease/fencing、Workspace 文件操作矩阵，以及 Session receipt 与 Workspace receipt 的协议级关联。最新 P0 批次覆盖本地 snapshot/blob 损坏的 fail-closed 状态、Worker 终止后的恢复，以及真实 DSH 文件工具到 Workspace receipt 的 scripted Agent Loop 闭环；其中还故意中断 Session receipt append，再杀 Worker、刷新并重开同一 Session，验证本地 outbox 补写且不重复 Workspace commit。证据和未完成项见 [next-high-value-validation-progress.md](next-high-value-validation-progress.md)。`workspace-session-reconciliation.mjs` 仍是协议级状态测试；`browser-native/workspace-receipt` 是本 PoC 独有并标为 `ignorable` 的 Session event，不是正式事件目录或 Session 格式能力。

下一批离线与并发恢复的计划和实际证据见[进阶恢复计划](advanced-recovery-validation-plan.md)及[进度记录](advanced-recovery-validation-progress.md)。Chrome 测试确认离线期间 durable retry 可在刷新后沿用原 `operationId` 提交；CAS 冲突不会覆盖远端，也会保留本地 dirty 文件；旧 writer lease 过期后旧 tab 的 resume、renew 和 commit 都被 fencing。旧标签页在另一个 tab 持有租约时恢复，会被 backend 以 HTTP 503 拒绝启动；这是当前 PoC 的安全失败行为，UI 尚未将其呈现为更友好的只读/等待状态。该批次未测试真实 LLM、Safari、浏览器 quota/eviction、OS 级浏览器崩溃或生产多租户存储。

后续[存储隔离与重启计划](storage-isolation-and-restart-validation-plan.md)及[实测进度](storage-isolation-and-restart-validation-progress.md)新增了 quota 类本地写失败、backend 进程重启后的 lease 恢复和同源身份切换的 Chrome E2E。故障注入确认本地 durable store 保存 OPFS bytes 与 IndexedDB retry 前不会 commit；backend restart 后旧 writer token 无效且 fencing epoch 递增；两个身份在同一浏览器存储分区下的 Workspace 目录和 snapshot 独立，跨身份 manifest/blob 返回 403。此结果不是实际磁盘 quota exhaustion、浏览器 eviction、HA 或生产租户安全审计。

本地 durable 保存 pending 或失败时，存活 Worker 的 `MemoryVfs` 可能仍含有未确认修改，Browser-Native provider 会拒绝 Agent 后续的 `read`、`read_image`、`write`、`edit`、`grep` 和 `glob`。若保存自动恢复，保护会在最新快照 durable 后解除；持续故障时刷新 Worker 可恢复最后确认的状态。真实 Chrome E2E 单独验证 `edit → read/grep/glob/write → reload → same-Session retry`；条件注册的 `read_image` 只验证共用 provider guard，未单独调用。详细计划和进度见[易失文件状态隔离计划](volatile-workspace-isolation-plan.md)与[进度记录](volatile-workspace-isolation-progress.md)。

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/session-workspace-reconciliation.test.mjs
node docs/drafts/browser-native-dsh-poc/tests/durable-workspace-failure-matrix.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/workspace-writer-lease.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/browser-native-file-matrix.e2e.mjs
```

以上浏览器命令需要先运行 `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`，并设置 `DSH_POC_PLAYWRIGHT_MODULE`。故障矩阵和文件矩阵使用 scripted backend；它们证明浏览器存储和协议语义，不替代真实 LLM Agent Loop 验收。

聚焦单测和真实 Chrome storage 探针：

```sh
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts \
  docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts
DSH_POC_BROWSER=chrome \
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
node docs/drafts/browser-native-dsh-poc/tests/browser-storage-boundary.e2e.mjs
```

不依赖 LLM、直接验收真实 Worker/OPFS/IndexedDB 的一次性 commit 失败恢复：

```sh
DSH_POC_BROWSER=chrome \
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
node docs/drafts/browser-native-dsh-poc/tests/durable-workspace-recovery.e2e.mjs
```

该测试只在 `browser-native-test=workspace-recovery` URL 下启用 PoC 专用 Worker MessagePort 接缝：在 Worker 共享 VFS 写入文件，第一次 Workspace commit 被注入 503，刷新后检查 IndexedDB retry、OPFS blob、同一 `operationId` 重试、远端 manifest/blob 和页面错误。它是模型无关的故障恢复证据，不是产品 API，也不替代真实 LLM 文件工具验收。损坏 snapshot/blob 的真实 Chrome 入口见 `tests/durable-workspace-corruption.e2e.mjs`；真实 IndexedDB transaction abort 见 `tests/durable-workspace-idb-abort.e2e.mjs`；Worker 终止后恢复入口见 `tests/worker-lifecycle-recovery.e2e.mjs`；真实 DSH 文件工具和同 Session receipt 崩溃恢复的 scripted 入口分别见 `tests/agent-workspace-receipt.e2e.mjs` 与 `tests/agent-workspace-receipt-recovery.e2e.mjs`。真实 Chrome 尚未覆盖 quota/eviction 或浏览器进程强制崩溃。

真实 Chrome IndexedDB transaction abort 验收：test port 在 OPFS/IndexedDB durable store 的 metadata `put` 后调用 `IDBTransaction.abort()`。预期 Worker 明确返回本地持久化错误，retry batch 最终保留在 IndexedDB；测试阻断随后的 blob 上传，并确认 Workspace manifest 未提交该文件。

```sh
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
node docs/drafts/browser-native-dsh-poc/tests/durable-workspace-idb-abort.e2e.mjs
```

真实 DSH `write` 工具已接入本地 receipt outbox 与同一 Session 的 PoC-only event。Provider 在持久化 `browser-native/workspace-receipt` 时附加 `ignorable: true`，不改正式 Session event catalog 或 format version。下列脚本用 scripted LLM 和真实 Chrome Worker Host：在 receipt append 发往 Session backend 前暂停请求，确认 Workspace commit 和 OPFS/IndexedDB outbox 已落盘后终止 Worker；刷新后让同一 Session 重开并完成 receipt append。验收要求是 Session 仅有一条匹配 receipt、Workspace commit 仅一次、outbox 清空。

```sh
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-receipt-recovery.e2e.mjs
```

真实文件工具验收需要真实模型配置，并把输出写入 Workspace mirror：

```sh
DSH_POC_LLM=real DSH_POC_BROWSER=chrome \
DSH_POC_DURABLE_WORKSPACE=1 \
DSH_POC_ENV_FILE=docs/drafts/.env \
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
```

该命令的真实 provider 可能因上游响应延迟失败；只有看到脚本自身输出成功 JSON，才能把该轮写成真实通过。`persisted=false` 也不表示 OPFS/IndexedDB 不可用，它只表示浏览器尚未授予持久化存储保证。

## 当前实现快照

v2 当前不是独立的 HTML demo。浏览器加载现有 `preview.html`，页面仍由 `AppWebEntry` 和 DSH Web UI 渲染。`apps/web/src/preview.ts` 静态导入并始终实例化本目录的 [`browser-native-worker.ts`](browser-native-worker.ts)；`browser-native=1` 只控制是否追加本目录的 profile overlay，不控制 Worker entry 的选择。Worker 使用现有 `appBoot.boot()`、Cordis composition、Session Controller 和 `ctx.agentLoop`；[`browser-native-providers.ts`](browser-native-providers.ts) 只提供正式 `SessionPersistence` 和 `LlmAdapter` 的远程实现。

Workspace mirror 仍默认使用内存模式；`browser-native-durable=1` 才启用 OPFS/IndexedDB 本地 snapshot 和 retry。`browser-native-workspace-lease=1` 额外启用 Workspace writer lease、fencing token 和 commit operation 查询；lease 是 PoC backend 的单进程协议，不是生产级跨进程锁。

若需要验证第三方聊天层，可以阅读同级的[assistant-ui + Browser-Native DSH 增量 PoC](../assistant-ui-browser-native-dsh-poc/README.md)。该 PoC 复用本目录的 Worker、profile overlay、backend 和 Session protocol，但自行启动 DSH Client 并只挂载 assistant-ui 聊天层；它不改变本目录的现有页面或实现文件。

同源 [`backend-v2.mjs`](backend-v2.mjs) 提供 `/api/browser-native/session/*` 和 `/api/browser-native/llm`。Session 事件以正式 DSH event DTO 写入本地 JSON 文件；`append` 只更新当前 backend 的内存状态，`flush` 或 `close` 才通过临时文件、文件 `fsync`、原子替换和父目录 `fsync` 建立本地 durability receipt。real LLM provider 的 base URL、model 和 API key 只由 Node backend 从 `--env-file` 读取；页面和 Worker 只看到同源 route。

`session/list` 同时返回 Session Persistence 使用的 `snapshots` 和 Client Session Controller 使用的 `items`；新增 `items` 不替换原有持久化字段。`items` 是 PoC 用于恢复的最小目录投影：`updatedAt` 暂用 header 的 `createdAt`，`agentAvailable` 和 `running` 固定为 `false`，`blank` 由事件数计算，不代表真实活动状态。Session Controller 用该列表判断已保存的 Session 是否可 retain。assistant-ui PoC 和原生 preview 都在页面刷新时重连同一 Session；前者由 `dsh-client.ts` 负责 owner 通知和卸载处理，后者由 [`browser-native-page-control.ts`](../../../apps/web/src/browser-native-page-control.ts) 通过 Worker `MessagePort` 收取 owner token、保存在 tab-scoped `sessionStorage`，并在 `pagehide` 发送 close beacon、终止页面拥有的 Worker。真实 Chrome 与 Playwright WebKit 验证同一 Session 刷新后可以继续；浏览器不保证在强制关闭或崩溃时完成卸载请求。

v2 要求非空 `requestId`，但没有基于它的请求去重或结果重放账本。写 owner 是当前 backend 进程内的随机 token，通过 claim、定时 `renew` 和 `close` 维护；默认 lease 为 30 秒，Worker 每 10 秒续租。页面正常卸载时，assistant-ui 和原生 preview 会尝试用 owner 凭据请求 `close`/flush；浏览器崩溃、强制结束 Worker 或进程被终止时，写权会在 lease 到期后释放，backend 重启也会清空内存中的 owner 并恢复已落盘数据。原生 preview 使用 `sessionStorage` 交接同一 tab 的 token；生命周期 E2E 也验证 Worker 被强制终止后，旧 owner lease 到期、重新 claim 和继续对话。assistant-ui 在无法取得写权时禁用发送、保留草稿并提供重新连接入口；这不等于实现了跨进程 owner epoch、请求重放或生产级 HA。刷新、backend restart、lease 到期和 stale owner reclaim 不恢复未落盘操作。这些限制不同于[旧版协议实验](protocol.md)的 replay 规则，也不满足 [v2 规划](browser-native-dsh-plan-v2.md)中的完整恢复目标。

当前实现的目录边界是：backend、Worker、profile overlay、page lifecycle bridge、launcher 和 v2 tests 全部在 `docs/drafts/browser-native-dsh-poc/`；目录外运行时代码接线限于已登记的 [`apps/web/src/preview.ts`](../../../apps/web/src/preview.ts)，用于实例化 docs-owned Worker，并只在 opt-in preview 时装载 browser-native overlay、连接 Worker owner control port、在正常卸载时终止该页面拥有的 Worker。没有修改 `packages/core/agent-loop`、Session format、普通 Web profile、Desktop profile 或 Headless profile。完整的目录外改动、删除条件和 upstream 重放步骤见 [change-ledger.md](change-ledger.md)。

## v2 验证

后端契约测试覆盖 Session create/list/open/read/append/flush/close、owner fencing、崩溃后的 durability、scripted LLM stream、OpenAI-compatible stream、非法请求和 secret redaction：

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
```

`backend-v2.test.mjs` 还覆盖 Workspace writer lease、迟到 writer fencing 和 operation receipt 查询；`session-workspace-reconciliation.test.mjs` 覆盖 Workspace 已提交但 Session receipt append 被写权阻塞时的可观测状态。两者都是协议证据，不等同于生产云存储或跨服务事务。

基础 Browser-Native E2E `tests/browser-native-v2.e2e.mjs` 覆盖三轮真实模型对话、todo 工具和窗口记忆。新增 runtime 验证 `tests/runtime-validation.e2e.mjs` 使用 docs-local 临时 profile overlay，对真实模型请求中的 tool roster、VFS `read`/`write`/`read` 参数与结果、durable Session、刷新后记忆恢复和 VFS 文件易失性作断言；scripted 模式还用动画帧采样检查 assistant DOM 增长。生命周期测试 `tests/runtime-lifecycle.e2e.mjs` 覆盖刷新续聊、真实 UI Stop、失败后继续、第二个 owner 请求被拒、backend 重启读回 durable Session，以及强制 terminate Worker 后 lease 回收和续聊；`tests/runtime-real-lifecycle.e2e.mjs` 在 Chrome 真实模型下验证 Stop 后恢复；`tests/browser-storage-boundary.e2e.mjs` 探测 Storage API 和 OPFS 能力差异。当前执行只继续 Chrome；既有 WebKit/Safari 证据保留为历史对照。运行命令、最新结果和已知限制见[运行时验证说明](runtime-validation-manual.md)与[运行时验证报告](runtime-validation-report.md)。

真实模型长回复的 Chrome 专项测试观察到 84 次递增的 assistant DOM 样本，显示本次真实 Chrome 路径逐步呈现模型输出；该单次观测不代表稳定帧率或性能分布。WebKit/Safari 的长回复表现尚未验证，Safari 测试按当前工作安排暂停。刷新 E2E 只执行一次 `page.reload()`，之后等待当前页面，避免重复导航。

```sh
DSH_POC_PLAYWRIGHT_MODULE=/path/to/deepseek-harness/node_modules/.pnpm/node_modules/playwright/index.mjs \
DSH_POC_LLM=scripted \
node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
```

真实模型验收需要本机 `docs/drafts/.env`；backend 单独读取密钥。`runtime-validation.e2e.mjs` 会先完成 VFS read/write/read，再刷新浏览器，在同一 Session 里验证随机 token 仍在模型上下文、VFS 输出文件已经不存在，最后要求 Agent 依据真实 `read` 错误如实报告。当前执行使用 `DSH_POC_BROWSER=chrome`；既有 WebKit 结果不代表 Safari.app。完整命令和生命周期脚本见[运行时验收说明](runtime-validation-manual.md)。

真实 provider 需要本机 `.env` 和 Node 24 的环境代理支持；脚本只输出模式、模型、Session id、事件数量和路由名，不输出密钥：

```sh
DSH_POC_PLAYWRIGHT_MODULE=/path/to/deepseek-harness/node_modules/.pnpm/node_modules/playwright/index.mjs \
DSH_POC_LLM=real \
DSH_POC_ENV_FILE=docs/drafts/.env \
node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/browser-native-v2.e2e.mjs
```

该 v2 测试通过的是现有 DSH Web UI、Worker Host、正式 Session 事件、`todo_write` 工具和 `ctx.agentLoop` 的三轮真实交互；旧版测试不能替代它。real E2E 是一次真实 provider 闭环，不是可用性、吞吐量、SLA、灾备或生产安全性证明。

真实 Chrome 复测记录了三个 `completed` turn、一个持久化 `todo_write`、40 个 Session events 和 `durableThroughSeq=39`。这条基础 E2E 使用当前 preview 默认工具 roster；Browser-specific 工具清单与 VFS 闭环以 `runtime-validation.e2e.mjs` 的独立 overlay 测试为准。

真实模型 Stop/恢复单独运行：

```sh
DSH_POC_ENV_FILE=docs/drafts/.env \
DSH_POC_BROWSER=chrome \
DSH_POC_LLM_TIMEOUT_MS=180000 \
DSH_POC_TURN_TIMEOUT_MS=600000 \
node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-real-lifecycle.e2e.mjs
```

该脚本要求真实模型请求处于进行中时点击 Stop，随后在同一 Session 发送恢复消息；通过条件是最新 `turn/end` 为 `completed`，同一 Session 的 durable JSON 包含恢复 marker，且浏览器没有 page error。若 provider 返回无文本、无工具调用的空完成，backend 现在将它作为 `UPSTREAM_LLM_EMPTY` 错误记录，测试会在同一 Session 再试一次；空回复不会再伪装成成功。当前 Chrome 真实模型复测为 `aborted → completed`。该结果不代表取消延迟或稳定性统计。

人工验收步骤、两个 UI 入口、对话脚本、Session 文件核对和常见故障排查见[手动验收说明](manual-acceptance.md)；工具失败后为何继续尝试，以及哪些行为来自 LLM、DSH Loop 和 Worker 能力缺口，见[工具连续尝试事实核查](agent-loop-tool-attempt-analysis.md)。如果要理解为什么当前 overlay 仍会把主机工具带进 Browser Agent，以及如何用 profile/preset 配置裁剪，见[工具清单与配置裁剪调研](browser-native-tool-roster-and-configuration-research.md)。

## 历史协议实验：运行

以下命令只运行旧版独立 HTML、PoC-local loop 和自定义事件协议，用于复现历史 transport/backend 实验，不是 v2 的启动或验收步骤。

在仓库根目录执行：

```sh
node docs/drafts/browser-native-dsh-poc/run.mjs --port 4175 --data-dir /tmp/dsh-browser-native-poc
```

上面的命令启动确定性的 scripted model。要启动真实后端 LLM 代理，使用只存在于本机的 `.env` 文件：

```sh
node docs/drafts/browser-native-dsh-poc/run.mjs \
  --port 4175 \
  --data-dir /tmp/dsh-browser-native-poc-real \
  --llm real \
  --env-file docs/drafts/.env
```

`--env-file` 只由 Node backend 读取。API key 不会发送给浏览器、Dedicated Worker、Session event、页面状态或日志；页面只看到 `real` mode、provider 和 model 名称。real mode 的 GPT 默认使用配置文件中的 `OPENAI_NEXT_GPT_MODEL`，并把 `reasoning_effort` 默认设为 `low`；Grok 可以通过对应的环境变量和 model 选择使用。

然后打开 `http://127.0.0.1:4175/`，点击 `Start Worker`。预期流程是：

```text
opening-session
→ model-request-1
→ browser tool: browser_echo
→ model-request-2
→ completed
```

点击 `Close Worker` 验证 graceful close；它会先 flush 并释放 owner。点击 `Terminate Worker` 则模拟没有执行 `close` 的 Worker crash；等待约 15 秒让 owner lease 过期后，再点击 `Resume Session`。页面应从 backend 读取已 flush 的 Session events，并显示 `resumed-from-flushed-session`。强制 terminate 不能当作 graceful shutdown；这个自动 lease 过期流程只适用于旧版，不适用于 v2。

## 历史协议实验：测试

后端 contract tests 不需要安装新增依赖：

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/backend.test.mjs
```

浏览器测试需要仓库现有 Playwright 依赖；当前独立 worktree 不复制 `node_modules`。运行时可从拥有依赖的仓库 checkout 提供模块路径：

```sh
DSH_POC_PLAYWRIGHT_MODULE=/path/to/deepseek-harness/node_modules/.pnpm/node_modules/playwright/index.mjs \
  node docs/drafts/browser-native-dsh-poc/tests/browser.e2e.mjs
```

真实 provider 的浏览器端到端测试必须显式提供本机 `.env` 和 Playwright：

```sh
DSH_POC_ENV_FILE=docs/drafts/.env \
DSH_POC_PLAYWRIGHT_MODULE=/path/to/deepseek-harness/node_modules/.pnpm/playwright@<version>/node_modules/playwright/index.mjs \
  node --test --test-timeout=360000 docs/drafts/browser-native-dsh-poc/tests/browser.real.e2e.mjs
```

该测试使用真实 Chromium、真实 backend、真实上游模型请求和真实 Session 持久化；它不 mock LLM response。测试输出只报告 mode、provider、model、event types 和 durable sequence，不打印凭据或完整 prompt。

## Scope

backend 使用目录内的 JSON 文件作为 PoC durability store。`append` 后事件对当前 backend 可见；`flush` 通过临时文件、文件和父目录同步以及原子替换写入 durable file；backend 重启只读取已 flush 事件。owner token 只在 backend 进程内有效，重启后由新 Worker 重新 `open('write')`。v2 scripted mode 返回确定性的文本 stream，不执行旧版独立协议中的 `browser_echo`；real mode 将受限消息转换为 OpenAI-compatible Chat Completions request，解析上游 SSE，再转换为 DSH `StreamChunk`。历史 `run.mjs`、`public/` 和旧测试中的 `browser_echo` 只属于旧协议实验。

这个本地 JSON store 不是 PostgreSQL、S3、HA 或生产多租户实现；它不提供跨进程 owner lease、跨重启 mutation replay、跨主机复制、备份保证或灾备 RPO/RTO。当前 browser-native E2E 只证明一次 Worker、同源 backend、正式 Session provider、真实 `ctx.agentLoop` 和 scripted/real LLM route 的闭环。

本目录没有加入根级 npm script、package manifest、Web profile、Desktop profile 或正式 DSH package。旧版命令和测试不证明 v2 的 DSH Host、正式 Session provider 或真实 `ctx.agentLoop`。若后续证明必须修改目录外代码，先按 [change-ledger.md](change-ledger.md) 登记原因、扩展点、测试和 upstream 重放步骤。

## Dev Note

这是可运行的 PoC，不是正式产品入口。v2 的实现事实、已运行命令和限制必须同步写入 [browser-native-dsh-progress-v2.md](browser-native-dsh-progress-v2.md)；[progress.md](progress.md) 只保留旧版独立 loop 的历史记录。不要把目录内历史 loop adapter 的通过结果写成 DSH 核心 Agent Loop 已完成浏览器化。
