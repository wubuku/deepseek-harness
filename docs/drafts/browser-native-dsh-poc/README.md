---
description: "Browser-native DSH PoC 的 v2 规划和历史协议实验：保留 DSH Web UI、真实 Host/Agent Loop，并通过同源 Session backend 和 LLM proxy 接入浏览器 Worker。"
---

# Browser-native DSH PoC

## Summary

本目录包含多个阶段的研究材料。旧版是协议级独立 loop 实验；当前 v2 已经把现有 DSH Web UI、Cordis 插件组合和真实 `ctx.agentLoop` 放进 Dedicated Worker，并通过同源 backend 提供正式 Session persistence 和 LLM proxy。实施规格见 [browser-native-dsh-plan-v2.md](browser-native-dsh-plan-v2.md)，原始实施进度见 [browser-native-dsh-progress-v2.md](browser-native-dsh-progress-v2.md)。真实运行时验证命令见[运行时验证说明](runtime-validation-manual.md)，已验证结果、失败和未验证边界见[运行时验证报告](runtime-validation-report.md)，上一批验证计划与进度见[下一轮验证计划](next-validation-plan.md)及[进度记录](next-validation-progress.md)。云端 Workspace 增量同步的规划、文件变更矩阵、真实 Chrome/LLM、OS backend 重启与协议并发证据见[云端 Workspace 同步 PoC 规划](cloud-backed-workspace-sync-plan.md)及[实施进度](cloud-backed-workspace-sync-progress.md)；其自动化入口为 `tests/workspace-sync.e2e.mjs` 和 `tests/workspace-durability.test.mjs`。本批次 durable Workspace 的规划和进度见[规划](durable-workspace-plan.md)及[进度](durable-workspace-progress.md)。最新 P0 验证的计划、实际实现和限制见[下一批 P0 计划](next-high-value-validation-plan.md)及[实施进度](next-high-value-validation-progress.md)；随后离线 retry、CAS conflict 和过期 writer lease 的真实 Chrome 验证见[进阶恢复计划](advanced-recovery-validation-plan.md)及[进度记录](advanced-recovery-validation-progress.md)。再后的 OPFS quota 错误恢复、backend 重启租约 fencing 与同源身份存储隔离见[存储隔离计划](storage-isolation-and-restart-validation-plan.md)及[实测进度](storage-isolation-and-restart-validation-progress.md)。文件工具 durable 确认与易失状态隔离见[持久化确认计划](durable-tool-ack-validation-plan.md)、[持久化确认进度](durable-tool-ack-validation-progress.md)、[易失状态隔离计划](volatile-workspace-isolation-plan.md)和[隔离验证进度](volatile-workspace-isolation-progress.md)：本地保存失败会阻止 Agent 后续读写与搜索未确认的 Worker 内存文件，刷新后可在同 Session 显式重试。可写 chunk-backed 编辑原型、64 MiB OPFS 资源证据和当前 DSH `edit` materialize 对照见[验证计划](chunk-backed-edit-validation-plan.md)及[实施进度](chunk-backed-edit-validation-progress.md)。v2 的启动入口是 `run-v2.mjs`；旧 `run.mjs` 只属于历史协议实验。

最新的 [Worker 控制通道连续性验证计划](next-control-channel-conformance-validation-plan.md)及[进度](next-control-channel-conformance-validation-progress.md)记录了 dsh-TUI live/replay 纪律在页面控制通道上的 PoC 落地：`control-ready` 基线、统一 `channelId/seq`、重复去重、跳号与同序冲突 fail-closed，以及刷新后的新通道。[载荷约束验证](next-control-payload-bounds-validation-plan.md)及[进度](next-control-payload-bounds-validation-progress.md)进一步记录 exact-key schema、4 KiB UTF-8 文本与 16 KiB JSON frame 上限、未知/循环数据拒绝和诊断脱敏。控制通道只投影 owner、Workspace、lease 和 pagehide 状态，不取代 DSH Session event log。

[Worker 运行时模块追踪验证计划](worker-runtime-module-trace-validation-plan.md)及[进度](worker-runtime-module-trace-validation-progress.md)把 packer 静态 request graph 与 Chrome Dedicated Worker 的实际请求/加载事件对账。追踪只在 PoC 测试通道显式启用；报告保留脱敏摘要而非原始 trace。scripted 与真实 LLM 路径都通过，但这不是全量动态分析、Node 兼容性证明或所有插件均可运行的结论。

[Node 文件能力验证计划](node-builtin-file-capability-validation-plan.md)及[实施进度](node-builtin-file-capability-validation-progress.md)区分标准 DSH `read` 的 `ctx.fs` 路径与 VFS Node shim：源码确认标准 `read` 使用 `ctx.fs`，Chrome E2E 运行真实 `read → grep → edit → read`，并通过测试通道直接调用 Node shim，核对它读到同一已提交文件；另验证 browser-native grep、durable edit 的不同执行路径及 `node:net.createServer()` 的明确拒绝。Worker 级 trace 只用于成员计数诊断，不能将 turn 内调用归因到某个工具。trace 仅在 PoC test MessagePort 存在时启用，按 builtin/member 聚合且不记录参数；它只覆盖显式插桩的方法，不证明 Node API 完整兼容。

本批[跨存储 checkpoint 与 receipt 对账计划](cross-store-checkpoint-reconciliation-plan.md)及[进度](cross-store-checkpoint-reconciliation-progress.md)新增 operation ledger、稳定 `operationId`、Workspace/Session/业务 receipt 对账和 Chrome Worker/OPFS/IndexedDB 恢复证据。它证明响应丢失时可以查询原 operation 并避免重复 mock 业务副作用；不证明 Session、Workspace 和业务 API 共享原子事务，也不把单进程 JSON ledger 当作生产 HA 存储。真实 LLM 另完成普通文件/Session smoke，但未用于确定性 partial-success 故障注入。

[独立业务 API 幂等验证计划](external-business-idempotency-validation-plan.md)及[进度](external-business-idempotency-validation-progress.md)把业务 effect 移到独立 PoC HTTP 服务和独立 durable JSON store，验证真实 Chrome Worker/OPFS/IndexedDB 在业务响应丢失、业务服务重启、DSH backend ledger 缺口、查询不可用和 payload/principal 冲突时的结算。运行 `node --test docs/drafts/browser-native-dsh-poc/tests/external-business-idempotency.test.mjs` 可执行服务与 backend 合同测试；构建 preview 后运行 `node docs/drafts/browser-native-dsh-poc/tests/external-business-idempotency.e2e.mjs` 可执行 Chrome 验证。该服务只证明“外部 API 自己提供 durable idempotency record 时可查询恢复”；它不是生产数据库、跨主机 HA 或 exactly-once 事务，未知结果仍不得盲目重试。

[Session 挂载与恢复验证计划](session-mount-lifecycle-validation-plan.md)及[进度](session-mount-lifecycle-validation-progress.md)验证页面同时管理多个 Session 投影时的 `active`/`parked`、history-before-live、重复事件、Worker identity 重连、`occupied`/`busy`/`unavailable` 和 dispose 后 `unknown` 语义。真实 Chrome probe 只证明 PoC-local coordinator 在 Dedicated Worker 中执行这些状态规则；真实 LLM 只复跑普通文件与刷新恢复，不证明正式多 Session UI、页面关闭后的后台 Agent 或云端 handoff。

需要进行真实浏览器验收时，使用两个 PoC 共用的[手动验收说明](manual-acceptance.md)；不要把旧版 `run.mjs` 或 `public/worker.js` 当作 v2 的启动入口。

旧实现验证了 Browser-native transport、Session durability、owner fencing、真实后端 LLM streaming、Tool bridge 和 Worker resume，但 Worker 使用目录内的 PoC-local loop adapter；它**没有**宣称现有 DSH `ctx.agentLoop` 已经在浏览器 Worker 中运行。旧版 [implementation-plan.md](implementation-plan.md)、[progress.md](progress.md) 和独立 HTML/loop 文件只用于追溯该协议实验，不能作为 v2 完成证明。

## v2 运行入口

v2 使用现有 `AppWebEntry`、现有 DSH Web UI 和由 Worker 承载的真实 Host。先构建 preview，再从本目录的 launcher 启动同源 Session/LLM backend：

```sh
node docs/drafts/browser-native-dsh-poc/build-profile-overlay.mjs
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

本批次实现只把 `MemoryVfs` 的文件变更异步写入 durable store，没有把 OPFS 伪装成完整 Node 文件系统，也没有改变 Session 与 Workspace 的非原子关系。规划、实际进度、失败记录和经验教训见 [durable-workspace-plan.md](durable-workspace-plan.md) 与 [durable-workspace-progress.md](durable-workspace-progress.md)；目录外 opt-in 接线见 [change-ledger.md](change-ledger.md)。事实核查进一步说明：VFS、结构化 command provider、WASI adapter 和 Shell/VM runtime 是不同层，当前 PoC 只验证前两层。

## 完整性与生命周期验证

[本地写权与代际计划](local-writer-fencing-validation-plan.md)及[实际进度](local-writer-fencing-validation-progress.md)验证多 Worker 的共享 OPFS/IndexedDB 安全：snapshot 具有独立本地 generation，writer 具有一次性实例身份和 epoch，接管后旧实例不能通过 load 恢复权限。远端 lease 模式在取得本地操作锁后重新核对服务端写权；observer 不接管本地 metadata。本地写权不替代 backend lease 或身份授权。

[只读 range backing 计划](observer-range-backing-validation-plan.md)及[实际进度](observer-range-backing-validation-progress.md)验证大 Workspace 的 observer 成本。durable observer 使用实例私有 OPFS，完整 SHA-256 验证后 seedExternal，不修改 writer 的 snapshot/control/pending 或共享 blob；同一 hash 的多个路径共享一个句柄并独立关闭。默认每实例最多 4096 个唯一文件、512 MiB，可通过 createBrowserNativeWorkspaceRuntime 的 observerCacheLimits 调整；超限或 OPFS 失败拒绝启动，不回退为完整 resident 文件。下载仍为 eager hydrate，并非按需远端文件系统；volatile observer 保留整文件驻留，VFS residentBytes 也不代表 Chrome heap/RSS。

[恢复一致性计划](workspace-recovery-consistency-plan.md)及[实际进度](workspace-recovery-consistency-progress.md)验证刷新前后的文件版本语义：hydrate 前核对本地 baseline 和远端 revision；retry 与后续 pending 分层重放，避免复活已删除文件；已提交 retry 经原请求摘要核对后退休，保留 DSH receipt，不覆盖后续远端修改。查询未知或 baseline 冲突时停止启动并保留本地 bytes，页面可下载既有恢复包，当前上限 64 MiB。没有 base manifest，因此没有自动三方合并；停止启动不等于冲突已经解决。Worker 与 backend 必须使用同一 PoC 查询协议，旧响应缺少 requestDigest 时不能确认已提交操作。

私有目录用独立 Web Lock 表示活实例，正常 release 关闭并删除本实例缓存；后继只回收同一 Workspace 已失锁的版本化目录，Worker 强杀的 partial bytes 不进入 writer 恢复。Chrome 验证三个路径对应同一 16 MiB 文件时，VFS 逻辑文件量增加 48 MiB，驻留增量约 58 字节；read、grep、stale 拒绝和共享 metadata 不变均通过。并发实例仍重复消耗磁盘与带宽，尚无 origin 总预算、懒下载或进程内存上限保证。

该研究原型将名为 `dsh-browser-native-workspace-v1` 的 IndexedDB 数据库升级到 schema 2，保留 version 1 的 Workspace snapshot、pending/retry/receipt 和 OPFS 文件，新增 control store；数据库名称不代表当前 schema 版本。首次升级前关闭旧版 PoC 标签页，再用本版刷新；被旧连接阻挡时明确拒绝，不清缓存。升级后旧版页面不得继续写入，也不支持降级写回；请保留数据并使用本版恢复。未知版本或损坏 control 均拒绝自动修复。这是 docs-owned 研究原型的数据变更，不是已发布 DSH Session 格式变更。

[下一批完整性与生命周期计划](next-integrity-and-lifecycle-plan.md)选择四个正式产品前仍有直接风险的验证面：冷 hydrate 分块写入和增量 SHA-256、OPFS orphan blob 的保守回收、页面离开前的本地 durable barrier，以及 Session receipt、Workspace outbox、云端 commit unknown 和 writer fencing 的组合恢复。实际证据和限制见[进度记录](next-integrity-and-lifecycle-progress.md)。

当前实现新增 `DurableWorkspaceStore.cacheBlobFromChunks()` 和 `reconcileBlobs()`；Browser Durable Store 的冷 hydrate 逐块下载并写入 OPFS，已提交文件通过外部 range backing 注入 VFS。回收只在 IndexedDB metadata 可验证时执行，metadata 缺失或版本不可信时保持 `local-corrupt`。durable `pagehide` 由页面向 Worker 请求本地 flush，收到 ack 或 1.5 秒超时后终止 Worker；它不等待云端 commit、Session flush 或模型，也不提供后台 Agent。

真实 Chrome 复跑命令：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
export DSH_POC_BROWSER=chrome
export DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js
node docs/drafts/browser-native-dsh-poc/tests/cold-hydrate-integrity.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/orphan-blob-reconciliation.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/pagehide-local-barrier.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-receipt-recovery.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-unknown-commit-recovery.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/workspace-writer-expiry.e2e.mjs
```

上述命令使用 scripted backend/LLM，不替代真实模型或生产存储验证；I1 的 `residentBytes` 只反映 PoC VFS backing 观测，不是浏览器 heap SLA。

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

## 大文件与分块 Workspace 传输验证

[文件规模与传输验证计划](large-file-scale-validation-plan.md)和[实施进度](large-file-scale-validation-progress.md)记录了本批高价值验证：旧单请求 blob API 的 8 MiB 边界、1 MiB chunk staging/status/finalize、缺块续传、hash/size 校验、backend 重启、刷新 hydrate、OPFS 分块写入，以及 1,000 个小文件的 snapshot coalescing。真实 Chrome E2E 通过 16 MiB、64 MiB 和 1,000 个 256-byte 文件；测试负载由 Worker test port 生成，不是模型生成的大型 tool args。

在 preview 构建后复跑本批模型无关验收：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts \
  docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts
export DSH_POC_BROWSER=chrome
export DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js
node docs/drafts/browser-native-dsh-poc/tests/large-file-scale.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/many-small-files-scale.e2e.mjs
```

`large-file-scale.e2e.mjs` 默认生成 16 MiB 文件，可用 `DSH_POC_LARGE_FILE_BYTES=67108864` 运行 64 MiB 样本。Worker test port 生成样本时，`MemoryVfs` 持有完整 bytes；当前 durable 模式的冷 hydrate 和标准 edit 可用 OPFS 外部 backing，资源证据见[标准工具资源包络进度](opfs-standard-tool-envelope-validation-progress.md)。传输仍是完整文件 blob 分块，PoC backend 使用本地 `dataDir`；这些结果不构成块级 delta、任意大小文件能力、生产对象存储或内存 SLA。

## Composer 通用文件附件

[验证计划](generic-file-attachment-validation-plan.md)和[实施进度](generic-file-attachment-validation-progress.md)记录了正式 DSH composer 的通用文件路径：`FileUploads` 流经 `AttachmentStore.saveFileStream()`，Worker 将附件写入 OPFS、上传至按 Workspace principal 隔离的同源 PoC backend，再以 VFS external backing 提供标准 DSH `read`。Session 只保存正式 `FileBlock` 引用；打开历史 Session 时，Worker 从 OPFS 或 backend 补水。附件对象不进入 Workspace manifest，也不增加 Workspace revision。

Chrome scripted E2E 通过 16 MiB 附件上传、真实 DSH `read`、删除 OPFS 附件缓存、刷新后 backend 补水并在原 Session 再读；backend 收到 256 个流块，最大块为 130,276 bytes。真实 Chrome/LLM E2E 另以小文本附件完成两轮真实 `read`、Session FileBlock 持久化和 OPFS 清理后的补水，Workspace revision 保持不变。验收按 turn/step 与 callId 配对；Session 不承诺 callId 单独构成跨 turn 的全局身份。

[附件提交与恢复验证](attachment-commit-recovery-validation-plan.md)和[实施进度](attachment-commit-recovery-validation-progress.md)记录了 composer 状态与 backend/Session 提交状态不一致时的故障恢复。Chrome scripted E2E 在 OPFS quota 拒绝后禁止发送，随后注入 backend 503、对象已发布但响应体被截断，以及 FileBlock append 已接受但响应丢失；同 hash 重试复用对象，Session readback 避免重复 append，最终只有一条 FileBlock、一条 prompt 和一次标准 `read`。该故障 E2E 使用 scripted LLM；真实 LLM smoke 单独验证正常的两轮附件读取与刷新补水，不代表真实模型路径触发了故障。

[附件取消与发布竞态验证](attachment-cancellation-validation-plan.md)和[实施进度](attachment-cancellation-validation-progress.md)进一步覆盖用户在上传中移除文件。Chrome E2E 在 Worker 的 OPFS `WritableFileStream.write()` 成功后暂停，确认 `upload-*` 临时项存在；点击正式 composer 的 Remove 后，AbortSignal 使 writer abort，临时项清除且 backend 未收到 PUT。另两次取消分别发生在 backend 收到 body 但尚未发布对象时，以及对象已发布但 receipt 尚未返回时。发布前取消清除 `.part` 且没有远端对象；发布后取消不能撤销已发布对象，但 late response 不恢复 FileCard、不产生 Session FileBlock，用户可以继续提交纯文本。该对象是 orphan 风险；由于 FileBlock 没有独立 Workspace namespace，本 PoC 不按时间戳或局部 Session 视图实现 GC。

[附件 Worker 强制终止恢复验证](attachment-worker-crash-recovery-validation-plan.md)和[实施进度](attachment-worker-crash-recovery-validation-progress.md)覆盖与 AbortSignal 不同的 Worker 消失路径。Chrome 156 在 A 标签页持有 OPFS staging 锁和 Workspace writer lease 时由 B 标签页扫描；B 的只读上传被拒绝，活动 `upload-*`/`.crswap` 不被删除，终止 A 后新 Worker 只回收可取得锁的孤儿 staging。backend 收到部分 body 后终止会清理 `.part`，对象已发布而 receipt 返回时终止则保留完整对象；用户重新选择相同内容后通过 hash `reused` 恢复。该路径不自动补交 prompt 或 FileBlock，不实现附件引用账本和远端 GC。

在 preview 构建后复跑本批验收：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
node --test docs/drafts/browser-native-dsh-poc/tests/attachment-backend.test.mjs
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
export DSH_POC_BROWSER=chrome
export DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js
node docs/drafts/browser-native-dsh-poc/tests/browser-native-file-attachment.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/attachment-commit-recovery.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/attachment-cancellation.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/attachment-worker-crash-recovery.e2e.mjs
DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env \
  node docs/drafts/browser-native-dsh-poc/tests/browser-native-file-attachment.e2e.mjs
```

附件大小上限为 PoC 64 MiB，图片附件不支持。后端对象位于本机 `dataDir`，没有对象 GC、生产云存储或生产身份认证；OPFS 是可清除缓存，后台对象与 Session/FileBlock 不构成跨存储事务。当前引用从浏览器 Workspace 身份确定附件命名空间；切换 Workspace 身份后打开旧 Session 会在缺少对象时显式失败。Chrome 定向测试覆盖 OPFS quota 拒绝、backend 503、对象发布后响应截断、Session append 响应丢失，以及 OPFS staging 和 backend 对象发布前/后的 composer remove。自然 eviction、自然网络中断、OS/磁盘崩溃、多设备恢复和大附件真实 LLM 尚未验证；发布后取消留下的对象尚无安全 GC。

## 可写 chunk-backed 编辑验证

[可写分块编辑验证计划](chunk-backed-edit-validation-plan.md)和[实施进度](chunk-backed-edit-validation-progress.md)记录独立的 OPFS copy-on-write 算法原型。之后该实现已接入当前 checkout 的 DSH 标准 `edit`、Worker VFS 外部 backing 与 Workspace mirror；最新 Chrome 资源数据见[标准工具资源包络计划](opfs-standard-tool-envelope-validation-plan.md)和[进度](opfs-standard-tool-envelope-validation-progress.md)。

该接入仍是 PoC，不是已发布的正式文件系统能力。标准 `edit` 通过 1 MiB copy-on-write buffer 读取并发布 external backing，VFS 驻留量在 64 MiB 样本中仅增加 10,589 bytes。资源包络批次记录了完整新 blob 上传；当前 checkout 的[分块复用验证](chunk-reuse-upload-validation-plan.md)进一步复用当前 Workspace 已提交来源文件的相同偏移块。服务端仍组装并保存完整文件，它不是零拷贝或生产 Workspace API。旧进度中的 `residentBytes` 对照值描述接入之前的完整 materialize 路径，不代表当前 checkout。

复跑原型和对照：

```sh
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-chunk-editor.spec.ts
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome DSH_POC_CHUNK_EDIT_BYTES=67108864 \
  node docs/drafts/browser-native-dsh-poc/tests/chunk-backed-edit.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_OPFS_AGENT_FILE_BYTES=16777216 \
  node docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs
```

## External reference 编辑与刷新恢复验证

[计划](reference-backed-edit-validation-plan.md)和[进度](reference-backed-edit-validation-progress.md)验证了上一批 chunk-backed 编辑原型接入 VFS、Workspace 和刷新恢复所需的接口。Worker 在 OPFS 临时文件中执行 copy-on-write，向 `MemoryVfs` 发布只含 hash/bytes 的 `write-reference` mutation；Workspace 从 range backing 计算 hash、写入本地 durable blob、按 1 MiB 分块上传并以 `baseRevision` CAS 提交。工具/Session 只保留 compact metadata，不把大文件 `before`/`after` 文本写入结果。

当前 checkout 的真实 Chrome 证据包括 16 MiB 正常闭环和 4 MiB 的 `copy-prefix`、`copy-suffix`、replacement、truncate、hash、publish 故障矩阵。失败时源文件 hash 不变、没有 Workspace commit，重试沿用同一操作语义并只产生一个 revision；刷新后从 OPFS/IndexedDB hydrate external backing，range read 和 digest 仍通过。该 test action 由 URL-gated Worker test port 驱动，不代表真实模型会自主选择它。

复跑本批模型无关验收：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome DSH_POC_REFERENCE_EDIT_BYTES=16777216 \
  node docs/drafts/browser-native-dsh-poc/tests/reference-backed-edit.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_REFERENCE_EDIT_BYTES=4194304 \
  node docs/drafts/browser-native-dsh-poc/tests/reference-backed-edit.e2e.mjs
```

本批没有把该测试端口注册成标准 Agent 工具。真实 LLM 仅需按既有运行时命令回归普通文件闭环，不能据此宣称模型已验证大型 external-reference tool arguments。

## External reference 接入标准 `edit` 的 Agent Loop 验证

[本批计划](external-edit-agent-loop-validation-plan.md)与[实施进度](external-edit-agent-loop-validation-progress.md)进一步把 external reference 接入真实 DSH `edit` 工具，并覆盖 Workspace commit unknown、backend 重启、Session durable flush、OPFS 句柄恢复和 CAS conflict。真实 Chrome/scripted DSH E2E 已证明：`tool/call` 在 Workspace side effect 前先进入 Session durable 状态；commit 响应丢失时同一 operationId 可查询/重放，Session 只产生一条 receipt、一次 `edit` call，并以 `TOOL_OUTCOME_UNKNOWN` 结算，不重放原工具。第二个页面提交远端版本后，刷新不会静默覆盖：本地 external retry 保留并显示 `conflict`，远端 revision 和内容也保留。

复跑本批模型无关验收：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
export DSH_POC_BROWSER=chrome
export DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js
node docs/drafts/browser-native-dsh-poc/tests/external-edit-unknown-commit.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/external-edit-conflict-retention.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-crash-window.e2e.mjs
```

Chrome 终止 Worker 后可能暂时保留 OPFS sync access handle。Store 会在 hash/size 已验证后有限重试，仍不可重开时使用只读内存 backing；这保证恢复路径不误报损坏，但会牺牲该文件的冷 backing heap 优势。本批仍不证明真实 LLM 自主工具选择、生产多实例 backend、自然 eviction、OS crash 或块级 delta。

## OPFS 外置大文件的 DSH 工具闭环

[早期文件工具验证](opfs-agent-file-tools-validation-plan.md)覆盖 12 MiB scripted 工具序列；[资源包络计划](opfs-standard-tool-envelope-validation-plan.md)和[实测进度](opfs-standard-tool-envelope-validation-progress.md)将标准 DSH 工具扩展到 64 MiB 单文件和 4×16 MiB 工作集。真实 Chrome Worker/Host 通过 12 MiB `read → grep → edit → read`、64 MiB `read → edit → read`、工作集冷 hydrate 后单文件编辑与刷新校验；编辑使用有界 copy-on-write buffer。随后新增的固定偏移分块复用及实际上传成本见[分块复用进度](chunk-reuse-upload-validation-progress.md)。scripted handler 固定工具选择；另有真实模型普通文件 smoke，不据此宣称模型自主处理大文件。

在 preview 构建后运行模型无关的大文件验收：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js DSH_POC_OPFS_ENVELOPE_SCENARIO=12m \
  node docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js DSH_POC_OPFS_ENVELOPE_SCENARIO=64m \
  node docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js DSH_POC_OPFS_ENVELOPE_SCENARIO=workset \
  node docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js DSH_POC_EXTERNAL_EDIT_FILE_BYTES=67108864 \
  node docs/drafts/browser-native-dsh-poc/tests/external-edit-unknown-commit.e2e.mjs
```

复跑本批真实 LLM 普通文件 smoke 时，从 `docs/drafts/.env` 载入 provider，并使用 `DSH_POC_ROSTER=original`：

```sh
DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ROSTER=original \
  DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js \
  node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
```

真实模型结果只覆盖普通大小文件 `read → write → read` 和刷新恢复，不覆盖大文件 scripted 场景、模型自主选择大文件工具或大型 tool arguments。`grep` 仍是有界 JavaScript fallback，不是完整 ripgrep；详细字节数、heap 采样限制、unknown commit 证据和已知 preview warning 见[资源包络进度](opfs-standard-tool-envelope-validation-progress.md)。

## 固定偏移分块复用上传

当前 upload 可从同一 Workspace 当前 manifest 引用的已提交文件复用相同偏移、长度及 SHA-256 的 1 MiB 分块。客户端先计算目标各块 hash；服务端验证来源完整文件 hash，把匹配块复制到 upload staging，只要求客户端上传缺块。复用计划在写入前持久化，同一 upload 不得换计划；重启后从 status 的缺块继续，不重新执行 DSH edit。最终仍校验完整目标 hash，并通过原有 manifest CAS、operationId 和 Session receipt 提交。

在 Chrome 64 MiB 等长 marker 场景中，标准 `edit` 上行 binary body 为一个 1 MiB chunk，复用 63 MiB；禁用复用的负对照会在流量断言失败。固定偏移复用不能保证插入/删除节省流量：文件开头插入一个 byte 可能改变所有后续块。它不提供内容定义分块、byte delta 或块级对象存储；服务端仍持有完整 staging 和完整新 blob，也增加了来源读取和复制。成本、失败、恢复及真实模型 smoke 的实际结果见[验证计划](chunk-reuse-upload-validation-plan.md)及[进度](chunk-reuse-upload-validation-progress.md)。

构建 preview 后复跑正常路径和复用响应丢失恢复：

```sh
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js DSH_POC_OPFS_ENVELOPE_SCENARIO=64m \
  node docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js DSH_POC_EXTERNAL_EDIT_FILE_BYTES=67108864 DSH_POC_EXTERNAL_EDIT_CRASH_STAGE=reuse \
  node docs/drafts/browser-native-dsh-poc/tests/external-edit-unknown-commit.e2e.mjs
```

## 内容定义分块成本对照

[验证计划](content-defined-chunking-validation-plan.md)与[实施进度](content-defined-chunking-validation-progress.md)比较实验性 gear-based CDC 和现有 1 MiB 固定偏移复用。最终 Chrome Dedicated Worker/OPFS 对照覆盖 18 个合成 workload，每个策略重复 3 次；[原始结果](content-defined-chunking-chrome-results.json)包含块长分布、估算上行、descriptor、range read、hash 和 Worker 耗时。

在头部/中部插入和删除的 8 个文本/二进制核心场景中，128 KiB 目标平均值配置估算上行比固定偏移少 86.3%–98.9%；但 16 MiB 文本的实际块长 mean 为 763 KiB，64 MiB 文本中 512 KiB 平均值配置约半数 chunk 达到 1 MiB 上限。16 MiB CDC target 准备约需 0.137–0.200 秒、来源索引约需 0.136–0.226 秒；64 MiB 文本分别约需 0.643–0.684 秒和 0.661–0.668 秒，来源与目标各读取约 128 MiB，页面帧探针最大间隔为 16.8 ms。该算法实验不证明真实上传收益、backend 写放大或生产对象存储成本；实际协议原型见[内容分块上传验证](content-upload-protocol-validation-progress.md)，默认 uploader 仍使用固定偏移协议。

在 preview 构建后复跑算法和 Chrome 成本对照：

```sh
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-content-chunker.spec.ts
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome DSH_POC_RESULT_FILE=docs/drafts/browser-native-dsh-poc/content-defined-chunking-chrome-results.json node docs/drafts/browser-native-dsh-poc/tests/content-defined-chunking.e2e.mjs
```

该 probe 不调用 LLM，也不经过 Workspace upload/backend blob protocol；真实 LLM smoke 独立验证原生 DSH `read → write → read` 和刷新恢复，命令见[实施进度](content-defined-chunking-validation-progress.md)。

## 内容分块上传协议原型

`createBrowserNativeWorkspaceRuntime({ contentDefinedUpload: true })` 显式启用实验性 CDC uploader，prepare 前核对 backend 的 `upload-capabilities`。算法标识 `dsh-gear-v1` 固定 32 KiB minimum、128 KiB average、1 MiB maximum 与 2,048 块上限；同一 operation/hash 的完整布局不可更换。默认运行不启用该选项，缺失能力不静默退回固定分块。Worker 接线使用 durable init 消息的布尔字段；验收脚本在构造 Worker 时发送该选项，普通 preview 不增加新默认行为。

客户端将连续、无重叠的 hash/offset/length 布局交给同源 backend，复用当前 Workspace manifest 授权来源中相同长度/hash 的块，只 PUT 缺块。服务端验证范围、块内容和完整目标 hash，仍组装完整 blob 并经原有 manifest CAS 发布；布局 sidecar 是已校验的上传范围索引，不是块对象权威存储。`algorithm` 标识协商的客户端分块规则，server 不重新计算 gear 边界，也不会仅凭标识信任 bytes。

已有 dirty upload 在固定分块与 CDC 之间切换会遭到 metadata conflict；应使用原选项恢复，不能清除 outbox 或创建新 operation 来掩盖冲突。旧文件缺少已验证 CDC 索引时，复用明确报错；本原型不在后台替旧文件补建索引。当前实现、实测流量、故障恢复与仍待验证事项分别由[规划](content-upload-protocol-validation-plan.md)和[进度](content-upload-protocol-validation-progress.md)记录。

Chrome 9 场景、14 runs 的[实际 HTTP 结果](content-upload-protocol-chrome-results.json)表明：二进制中部插入/删除上行减少约 98%，64 MiB 等长修改减少 79%，文本中部插入/删除反而增加约 1%。backend 仍完整校验来源、复制 staging 和组装 blob，上行减少不等于服务端成本减少。四个响应丢失恢复阶段均通过；该协议测试不调用模型，另有 CDC opt-in 三轮真实 LLM smoke。

在 preview 构建后复跑协议矩阵与真实模型：

```sh
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/content-upload-protocol.e2e.mjs
env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_CONTENT_UPLOAD=1 DSH_POC_ROSTER=original DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
```

## 不可变块对象存储原型

backend 的 `createBrowserNativeV2Server({ workspaceChunkObjects: true })` 显式选择本地不可变块与文件版本描述符；Worker 仍需 `contentDefinedUpload: true` 才走 CDC 引用路径。默认 fixed、已有完整 blob 和当前 manifest 文件身份保持原语义。该 dataDir 一旦初始化块存储，重启必须沿用该选项，缺失时以 `CHUNK_STORE_REQUIRED` 拒绝，不把原文件显示为空。该选项不能与外部 `workspaceBlobStore` 混用。

设计、验收矩阵、实测与未完成项见[规划](chunk-object-storage-validation-plan.md)和[进度](chunk-object-storage-validation-progress.md)。块数据先持久化，文件完整 SHA-256 验证后才发布有序版本，最后仍需原 manifest CAS。pending upload metadata 是 GC root；来源被删除不等于可以删除未完成目标依赖的块。该实验不提供生产对象存储或多实例事务。

[Chrome 脱敏工件](chunk-object-storage-chrome-results.json)包含 9 场景 14 runs、最终四阶段响应丢失恢复、64 MiB 冷缓存与 GC、强制 staging 负对照。写入复用/组装降为 0，但当前每次 range 都验证全文件，64 MiB 冷恢复实际读取 4 GiB；该选项保持默认关闭。真实 LLM 三轮也已单独通过，命令与验收服务见上述进度，不能用成本矩阵代替真实模型验证。

本批使用全新 dataDir；旧完整 blob 的读取和 fixed 写入保留，但已有 CDC staging/布局到块对象的在线迁移不在本批范围。不能为切换模式删除 outbox、替换 operationId 或承诺旧 CDC 来源自动变成可引用的块。

首次从远端恢复文件时，mirror 先验证原本地 snapshot，并在无本地状态时登记干净 metadata，再下载到 OPFS。已有 OPFS bytes 却丢失 metadata 仍拒绝自动覆盖；不能把缓存清除、可重新下载与本地未同步状态损坏混为一类。

### 块对象验证下载流

`createBrowserNativeV2Server({ workspaceChunkObjects: true, workspaceVerifiedDownloads: true })` 显式协商 `fileDownload: { version: 1, kind: 'verified-stream' }`；Worker 的 CDC 模式使用一条 HTTP 流顺序写入 OPFS，完整长度、EOF 和 SHA-256 验证后才发布文件。旧完整 blob 只在精确 `409 FILE_DOWNLOAD_UNSUPPORTED` 时使用原下载路径；其他错误不降级。默认下载上限 4 条、deadline 30 秒，分别通过 `workspaceDownloadMaxReaders` 和 `workspaceDownloadTimeoutMs` 配置。

store 先完整验证一次，返回时再次验证每个 chunk，以活动引用保护下载中的块不被 GC；旧 range 语义不变。[规划](verified-stream-download-validation-plan.md)、[进度和可执行命令](verified-stream-download-validation-progress.md)及[Chrome 工件](verified-stream-download-chrome-results.json)记录 64 MiB 冷恢复从读取 4 GiB 降为 128 MiB、取消/损坏/截断恢复与真实模型 smoke。该模式仍默认关闭，不代表多实例或 OS crash 已验证。

### 下载缓存发布恢复

远端下载在创建 canonical OPFS 文件前，先向独立 IndexedDB journal 提交下载意图。Workspace 本地操作通过 Web Locks 串行化；新 Worker 在打开缓存和解码 pending 前核对意图。完整文件复用，只有已登记且不被 pending/retry 引用的未完成文件可删除后重新下载。没有意图的损坏文件、未知 journal 版本或 metadata 缺失继续拒绝自动修复；本地保存和云端 commit 的语义不变。

保存现有 snapshot 前必须由同一 store 实例成功 load；锁内比较最后成功 load/save 的完整 metadata，发生变化时报 LOCAL_SNAPSHOT_CONFLICT 并保留较新记录。外部 blob 引用在提交前验证大小和完整 hash，编码串行收束后才释放锁。该记录比较不能识别相同记录的 ABA，也不能替代 backend writer fencing；新增完整 hash 校验有线性读取代价，不是无成本优化。

[本批规划](cache-publication-recovery-validation-plan.md)和[进度](cache-publication-recovery-validation-progress.md)分别维护设计判据与实际验证状态。此路径需要 Web Locks、IndexedDB 和 OPFS，不静默退化为仅实例内互斥；它不把 Worker 强制终止恢复外推为 OS crash 或自然 eviction 的保证。

## Browser-native 文件搜索与载荷安全

[本批计划](browser-file-tools-validation-plan.md)和[实施进度](browser-file-tools-validation-progress.md)记录为 Browser Worker 提供 `grep`/`glob` fallback、限制搜索结果和扫描字节、拒绝会放大 Session 载荷的 `edit` 输入，以及取消后的 Worker 可用性。fallback 只搜索 `/dsh/home/workspace`，使用 JavaScript 正则和有限 glob 语义；它不启动主机子进程、不等同 ripgrep、也不提供块级编辑。搜索和编辑都设有文件数、扫描字节、扫描行数、匹配数、结果行长、pattern 和 edit 载荷上限，超限 fail closed；`grep`/`glob` 采用显式栈遍历和分块读取，二进制/非法 UTF-8 文件返回明确错误，provider 的文件工具名称集中登记。内容、include 和 glob 的正则语法编译及匹配在可终止的嵌套 Worker 中执行；这限制了单次阻塞，但不是完整 ReDoS 保证。

在 preview 构建后运行模型无关验收：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools.spec.ts
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js \
  node docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js \
  node docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools-cancel.e2e.mjs
```

`browser-native-file-tools.e2e.mjs` 经过真实 Chrome、Dedicated Worker、真实 DSH Host 和 scripted tool selection 验证搜索边界、非法正则、二进制文件、超长编辑目标和失败后继续；70 KiB 单行 chunk-backed `edit` 已在本次回归中成功并产生一次 Workspace commit。`browser-native-file-tools-cancel.e2e.mjs` 用 Worker test seam 取消慢搜索，再用真实 DSH `grep` turn 验证 Worker/VFS 仍可用。后者不是模型自主取消，也不替代既有 Agent Loop 的 UI stop 验收。真实模型此前验证普通文件闭环；本次另由真实模型自主选择 `grep` 并搜索普通文本，不覆盖恶意 pattern。

## 模型流故障与 Agent Loop 恢复

[模型流故障验证计划](llm-stream-failure-validation-plan.md)和[进度记录](llm-stream-failure-validation-progress.md)覆盖了此前未闭环的四个高风险时序：文本输出一部分后断流、工具参数 JSON 半包、Worker 在模型流中终止后刷新，以及 UI Stop 对 backend/上游请求的取消传播。该批保留 DSH Agent Loop、Session 和 Workspace 为唯一事实来源，不实现第二套恢复 loop。

真实 Chrome E2E `tests/llm-stream-failure.e2e.mjs` 证明：部分文本和工具半包会持久化 `assistant/attempt` 并以 `turn/end:error` 结束；半包工具不会产生 `tool/call`、`tool/result` 或 Workspace commit；Worker 流中止后刷新会将 open turn 修复为 `interrupted`，不重发原模型请求，显式新 turn 可以继续；Stop 结算为 `aborted`，backend 观察到客户端响应关闭。backend 合同测试另外使用本地 fake OpenAI-compatible upstream 证明客户端取消会中止代理的上游 fetch。

复跑本批验证：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
  node docs/drafts/browser-native-dsh-poc/tests/llm-stream-failure.e2e.mjs
```

这里的 scripted fault 是真实 DSH Worker/Host 的确定性故障注入，不是独立聊天 demo，也不等同真实模型自然断流。真实 LLM 普通流的历史证据仍有效，但本批没有把外网供应商重新运行结果写成半包故障证据；自然 eviction、OS crash、Safari、生产多实例 backend 和后台 Agent 仍未验证。

## 文件工具下一批验证

[计划](browser-file-tools-next-validation-plan.md)和[进度](browser-file-tools-next-validation-progress.md)记录了目录显式栈遍历、`glob` 结果上限、pattern/brace 预算、跨 chunk UTF-8 与二进制拒绝。随后发现仅对命中行限制长度仍允许超长无换行内容在 matcher 前累积；[正则隔离验证](browser-file-search-isolation-validation-plan.md)和[进度](browser-file-search-isolation-validation-progress.md)记录当前修正：所有超过 64 KiB 的行在正则匹配前拒绝，包括不匹配行。内容 grep、grep `include` 和 glob 路径匹配在可终止的嵌套 Worker 中执行，每批最多 1 秒、整次搜索最多 30 秒；超时不会返回部分结果。

Chrome scripted E2E 对内容正则、`include` 和 glob 路径正则分别触发超时，并证明同一 Agent turn 随后可继续搜索；单独取消 matcher 后 Worker 也保持可用。真实 LLM 在 Chrome 中自主选择 `grep` 完成普通搜索，但没有生成恶意 pattern。Worker timeout 是 PoC 的单批 CPU 工作量上限，不构成完整 ReDoS 形式化保证或通用 CPU quota；Safari、其他 CSP/打包部署、完整 ripgrep 语义和任意容量搜索仍未验证。分块读取也不等于块级同步或块级编辑。

## 真实文件工具期间的 Stop 与中断恢复

[本批计划](next-worker-tool-cancellation-validation-plan.md)和[进度](next-worker-tool-cancellation-validation-progress.md)验证 UI Stop 是否能取消真实 DSH `grep` 和 chunk-backed `edit`，以及 Worker 在 OPFS copy-on-write 暂存期间终止后的刷新恢复。三条 Chrome E2E 都运行真实 Dedicated Worker、DSH Host/Agent Loop、Session 与 durable Workspace；scripted LLM 只固定工具调用和中断窗口，不替代被测 Worker 或文件工具。

Stop 在 `grep-match` 和 `copy-prefix` 阶段均让原 turn 以 `aborted` 收束；编辑源文件 hash、Workspace revision 和 receipt 保持不变，同一 Session 随后可启动新 turn。Worker 在 edit 的 `copy-prefix` 阶段被终止后，刷新将未结算调用记录为 `TOOL_OUTCOME_UNKNOWN`，不重发模型请求，清理遗留 staging，再允许同 Session 新 turn。8 MiB 文件样本的 Stop-to-terminal 观测值为 134 ms 和 137 ms，三次场景的最大动画帧间隔为 16.8–33.224 ms；这些单机采样不是性能 SLA。

独立真实 LLM Chrome smoke 完成普通文件 `read → write → read`，刷新后同一 Session 恢复记忆与 Workspace 文件；这不表示真实模型参与了 Stop、取消或 Worker 终止场景，具体请求和 Session 计数见[本批进度](next-worker-tool-cancellation-validation-progress.md)。

运行模型无关的 Chrome 验收：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_TOOL_CANCELLATION_SCENARIO=stop-grep node docs/drafts/browser-native-dsh-poc/tests/browser-native-tool-cancellation.e2e.mjs
DSH_POC_TOOL_CANCELLATION_SCENARIO=stop-edit node docs/drafts/browser-native-dsh-poc/tests/browser-native-tool-cancellation.e2e.mjs
DSH_POC_TOOL_CANCELLATION_SCENARIO=crash-edit node docs/drafts/browser-native-dsh-poc/tests/browser-native-tool-cancellation.e2e.mjs
```

此验证不涵盖 OS/磁盘崩溃、自然 eviction 或 Safari/WebKit。真实 LLM 普通文件 smoke 本批因上游不可达而未通过；scripted 场景不能代替该证据。

## Worker 依赖闭包审计

[验证计划](worker-dependency-closure-validation-plan.md)、[实施进度](worker-dependency-closure-validation-progress.md)和[机器生成的 request graph](worker-dependency-closure-report.json)记录当前 checkout 的 `web` Worker image 请求闭包。packer 返回的图包含 Worker assembly seeds 和每个已物化 workspace package 的全部非通配符 runtime exports；这比 Cordis profile 实际启用的插件集合更宽，也不是模块求值或执行轨迹。

报告包含 1,350 个 JavaScript entries 和 4,252 条静态 request records：3,693 条解析到 image 模块、450 条解析到 implemented builtin proxies、26 条解析到 structural stubs、19 条解析到 external replacements；另有 54 条未解析 Node builtin 请求和 10 条未解析 `meta-resolve` 请求。计数单位是 request record，不是唯一 package、API 成员或运行次数。`implemented` 只说明 proxy 源文件所在目录；逐导出 Node 兼容性仍须单独测试。

未解析请求不能当成无害死代码：其中包括 `undici` 的 Node-only builtin 依赖。当前 Browser profile 明确不注册 `web_fetch`，本批没有执行这些请求；如需在 Worker 中提供该能力，应先选择浏览器原语或同源 backend adapter，再验证实际调用路径。完整 importer 列表和每条解析结果见 JSON 报告。

重新生成报告前，先构建 preview，使 runtime proxy 表和 packer 来自当前构建产物：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
node docs/drafts/browser-native-dsh-poc/generate-worker-dependency-report.mjs
```

Chrome scripted E2E 证明受限 Bash pipeline、文件 redirection 和回读通过真实 DSH Worker/Host；unsupported host command 未新增 Workspace 文件或 commit。另有真实 `gpt-5.6-sol` smoke 在 Browser validation roster 完成 DSH `read → write → read`，刷新后同一 Session 再读 durable Workspace 文件成功。两类证据使用不同 LLM 模式；真实模型结果不能证明静态图中每个模块或 Node shim 均可用。

```sh
env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/default-profile-capabilities.e2e.mjs
env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ROSTER=browser DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
```

真实模型密钥只由 backend 从 `docs/drafts/.env` 读取，不属于浏览器配置或日志输出。逐插件/逐 export conformance、全部 54 条 unresolved builtin requests 的运行覆盖、computed imports、Safari 和生产 backend 均未验证。

## 能力预检与默认插件兼容性

[能力预检计划](browser-capability-preflight-plan.md)和[实施进度](browser-capability-preflight-progress.md)记录本批对 Browser-Native profile 的系统性验证：PoC capability manifest 现在集中描述 Worker VFS、结构化文件工具、受限 Shell、同源 Session/LLM backend、问答、todo、工作目录，以及主机子进程、`fs.watch`、原生 addon 和后台进程等明确不支持的能力。Worker 在创建 Workspace 和 Worker Host 前执行 fail-closed 预检；缺少 capability 时，诊断包含具体插件和能力，不留下半启动 Host。

真实 Chrome 默认 profile E2E 验证了受限 Shell 的 `printf | tr`、文件重定向、重定向文件读取和不支持命令的失败结果，并核对 DSH tool/result、Session checkpoint、无跨源请求和无页面异常。真实 `gpt-5.6-sol` 回归验证的是独立 browser validation roster 的普通文件多轮和刷新恢复，不应外推为模型已经选择默认 profile 的每个工具。该 manifest 仍是 docs-owned 静态清单，不是任意 Cordis profile 的动态插件扫描，也不是正式 package capability service。

## 故障边界与 S3 blob 验证

[故障边界计划](mock-and-crash-boundary-validation-plan.md)与[实测进度](mock-and-crash-boundary-validation-progress.md)记录 OPFS/IndexedDB 单侧丢失、Chrome `SIGKILL`、共享 `dataDir` 的双 backend、超大工具参数和 MinIO S3-compatible blob store。Chrome 155 实测表明：本地元数据缺失时孤儿 OPFS bytes 会 fail closed 并可按 hash 导出；Chrome 强杀后匿名身份 cookie 未自动恢复；两个 backend 都接受同一 seq/revision 写入，冷启动只留下其中一个结果。

本轮还修复了工具参数过大导致 Session append 反复超过 8 MiB backend body 上限的问题：Browser LLM adapter 将一次响应累计 tool arguments 限制为 1 MiB，超限时中止流，避免写入或执行不完整调用。真实 Chrome/scripted LLM E2E 接受 768 KiB 文件写入，拒绝 6/9 MiB 参数并确认同 Session 后续 turn 可继续。该 1 MiB 限制是 PoC 的保守硬上限，不是 DSH Session 的正式容量承诺。

PoC backend 可在测试启动时注入 S3 blob adapter；默认 `run-v2.mjs` 仍使用本地文件 blob store。真实 Chrome Worker + MinIO 验证了 2,097,189-byte staging 文件流式上传、Range 下载、503 outage、刷新后补传先前丢失的已上传对象和 backend 重启读回。adapter 流式校验 SHA-256；关闭 AWS SDK 的可选 request checksum 后兼容所测 MinIO 版本。Session、manifest、identity、writer lease 与 operation ledger 仍驻留单机 JSON `dataDir`；结果不证明真实 AWS/GCS/Azure、生产权限模型或多实例安全。

## DSH skill 文件系统集成

[验证计划](worker-skill-filesystem-validation-plan.md)和[进度记录](worker-skill-filesystem-validation-progress.md)覆盖验证专用 profile 中真实 `dsh-skill-filesystem`、`dsh-skill` 和 `dsh-tool-skill` 的 Chrome Worker 闭环。scripted E2E 验证缺失根创建、DSH `read → edit → edit → skill`、frontmatter 目录更新、Session 正文投影、删除撤回、OPFS 保存失败隔离和同 Session 刷新恢复；真实 LLM E2E 验证模型调用 skill、刷新续聊、同源请求及凭据隔离。该能力没有加入默认 Browser profile，外部 VFS 删除依赖异步 Chokidar 通知，页面关闭后 watcher 不运行。

复跑本批验收：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_LLM=scripted DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/worker-skill-filesystem.e2e.mjs
DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_ENV_FILE=docs/drafts/.env node docs/drafts/browser-native-dsh-poc/tests/worker-skill-filesystem.e2e.mjs
```

### Durable metadata 与远端 blob 生命周期

[元数据和 blob 生命周期验证计划](durable-metadata-and-blob-lifecycle-validation-plan.md)及[实施进度](durable-metadata-and-blob-lifecycle-validation-progress.md)记录当前 checkout 对 Workspace metadata 冷加载和显式 GC 的验证。backend 在 listen 前严格校验 version 1 metadata 的字段、UUID、路径树、operation receipt、pending upload hash/timestamp 和 identity 引用；未知字段或损坏记录会拒绝启动。旧 Workspace 缺少 `uploadedAt` 时，pending hash 会永久保留，不按猜测期限删除。

文件与 S3 blob store 都支持列举和删除。GC 通过单 backend 的全局 blob-lifecycle lock 读取所有 Workspace manifest 和 pending upload 引用；无受保护引用的完成 blob 可立即回收，pending hash 在 TTL 内保留。续传与清理都要求 staging schema 和目录身份完整有效；未知、缺失或损坏的 metadata 不可续传，也会保留并由 GC 计数。只有 metadata 可验证且超过期限的分块 staging 才会删除。GC 不改变 manifest revision 或 operation receipt。真实 Chrome + MinIO 验证了 orphan 删除、当前内容保留、503 后恢复、对象丢失后刷新补传和 backend 重启读回。

该 GC 只在一个 backend 进程和一个 WorkspaceStore metadata 视图内有依据；它不是共享 S3 bucket 的多实例协调器。启动校验不扫描每个对象的完整 hash；本地 JSON metadata、生产云对象权限/版本控制、自然 eviction、OS/磁盘崩溃和跨存储事务仍未验证。复跑命令和失败复跑记录见[实施进度](durable-metadata-and-blob-lifecycle-validation-progress.md)。

复跑需要 Docker、固定 MinIO 镜像、Node、已构建 preview 和 Playwright。S3 adapter 的 AWS SDK 依赖固定在目录私有 package 中，不修改根依赖：

```sh
npm ci --prefix docs/drafts/browser-native-dsh-poc
docker image inspect --format '{{.Id}}' minio/minio:RELEASE.2023-03-20T20-16-18Z
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts
export DSH_POC_BROWSER=chrome
export DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js
node docs/drafts/browser-native-dsh-poc/tests/workspace-partial-storage-loss.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/chrome-process-crash-recovery.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/workspace-backend-multi-instance-characterization.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/large-tool-arguments.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/workspace-s3-minio.e2e.mjs
```

Chrome 强杀脚本使用 POSIX `ps` 与 `SIGKILL`，不能在 Windows 运行；它不是 OS/磁盘 crash。单侧存储删除不是自然 eviction；双 backend 结果是当前 PoC 的 unsafe characterization，不是 HA 测试。MinIO outage/对象丢失是本地故障注入，真实云对象存储、Safari 和真实模型生成大型工具参数仍未验证。

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

本轮[恢复边界计划](recovery-boundary-validation-plan.md)与[实测进度](recovery-boundary-validation-progress.md)验证 mutation 到本地 snapshot 之间强制终止 Worker、损坏状态的本地导出和两个真实 preview 标签间的 writer lease 冲突。Chrome 结果确认：durable 前的写入刷新后丢失，但 Session 以 `TOOL_OUTCOME_UNKNOWN` 结算且同 Session 可继续；durable 后的 retry 刷新后只 commit 一次。`local-corrupt` 页面可下载含原始 IndexedDB metadata、可读 OPFS bytes、hash 校验和缺失清单的本地恢复包，不会上传、覆盖或清除数据。租约冲突页显示等待倒计时并提供显式重试；fencing 仍由 backend 决定。恢复包最大导出 64 MiB，已被浏览器清除/驱逐或不可读的 bytes 无法还原；本批未验证 Safari、真实模型、浏览器进程崩溃或生产级 backend。

最新[交互与恢复验证计划](browser-runtime-integrity-validation-plan.md)补齐默认问答和工作目录工具的真实 Worker 闭环、清除 OPFS/IndexedDB 后 backend 不可用时的 fail-closed，以及两个真实标签页间的 Worker 写权交接；同时回归缓存清除后的成功重建和 mutation/snapshot 中断窗口。计划与实测进度分别见[验证计划](browser-runtime-integrity-validation-plan.md)和[进度记录](browser-runtime-integrity-validation-progress.md)，能力状态见[兼容矩阵](operational-compatibility-matrix.md)。E2E 使用 Chrome、真实 Dedicated Worker/DSH Host 和 scripted LLM；503 由 Playwright 路由注入，handoff 使用 10 秒测试 lease。自然 eviction、OS 级浏览器崩溃、Safari/WebKit、多实例 backend、生产 lease SLA 和真实模型工具选择仍未验证。

最新[运行时完整性验证计划](next-runtime-integrity-validation-plan.md)与[进度记录](next-runtime-integrity-validation-progress.md)验证活动 Worker 的 Workspace lease heartbeat、Agent `write` 的未知 commit/backend 重启恢复、默认 legacy HITL 刷新中断，以及 IndexedDB 前向版本下的本地恢复导出。真实 Chrome/scripted E2E 证明活动页面在一次 renew 503 后继续续租并完成同一 Agent turn；Workspace manifest 503 导致初始化失败时 Worker 停止续租，服务端租约到期后可被接管；已提交但响应丢失的文件只增加一个 Workspace revision；默认 Browser profile 的 legacy `ask_user_question` 刷新后结算为 `TOOL_OUTCOME_UNKNOWN` 和 interrupted turn，不保留可回答的旧问题卡或自动续跑，之后用户可在同一 Session 显式开启新 turn。该批没有验证 timed schema；后续 timed HITL E2E 已验证其问题 projection 可在刷新后按原 callId 恢复。刷新都不会恢复原 Worker Promise，新 turn 不是旧审批答案；v2 IndexedDB 不被 v1 客户端降级，已识别的 metadata 与 OPFS bytes 可导出，未知 object store 的记录不会进入恢复包。本批不证明真实 LLM、多实例 backend、自然 eviction、OS crash 或后台 Agent。

在 preview 构建后复跑本批 Chrome E2E：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
export DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js
node docs/drafts/browser-native-dsh-poc/tests/workspace-writer-heartbeat.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/workspace-writer-startup-failure.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-unknown-commit-recovery.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/ask-user-refresh-recovery.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/indexeddb-forward-version-export.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/workspace-writer-lease.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/workspace-writer-reload.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/workspace-writer-expiry.e2e.mjs
```

以上 E2E 使用 scripted backend/LLM、真实 Chrome Worker 和独立临时 data directory；测试 lease 使用缩短 TTL。它们验证的是本 PoC 当前 checkout 的协议与恢复行为，不是生产租约 SLA、HA 或自然浏览器崩溃语义。

在 preview 构建后复跑本批 E2E：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
export DSH_POC_BROWSER=chrome
export DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js
node docs/drafts/browser-native-dsh-poc/tests/default-interaction-tools.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/workspace-cache-backend-unavailable.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/workspace-worker-handoff.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/durable-workspace-cache-reset.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-crash-window.e2e.mjs
```

运行本批真实 Chrome 验收：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
export DSH_POC_BROWSER=chrome
export DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js
node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-crash-window.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/durable-workspace-corruption.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/workspace-writer-expiry.e2e.mjs
```

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

该测试只在 `browser-native-test=workspace-recovery` URL 下启用 PoC 专用 Worker MessagePort seam：在 Worker 共享 VFS 写入文件，第一次 Workspace commit 被注入 503，刷新后检查 IndexedDB retry、OPFS blob、同一 `operationId` 重试、远端 manifest/blob 和页面错误。它是模型无关的故障恢复证据，不是产品 API，也不替代真实 LLM 文件工具验收。损坏 snapshot/blob 的真实 Chrome 入口见 `tests/durable-workspace-corruption.e2e.mjs`；真实 IndexedDB transaction abort 见 `tests/durable-workspace-idb-abort.e2e.mjs`；Worker 终止后恢复入口见 `tests/worker-lifecycle-recovery.e2e.mjs`；真实 DSH 文件工具和同 Session receipt 崩溃恢复的 scripted 入口分别见 `tests/agent-workspace-receipt.e2e.mjs` 与 `tests/agent-workspace-receipt-recovery.e2e.mjs`。这些早期 E2E 未覆盖 quota/eviction 或浏览器进程强制崩溃；较新的 CDP quota override、正常进程重启及其限制见[运行范围验证进度](operational-envelope-validation-progress.md)。

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

## 运行范围与运营上限验证

上游 `dsh-v0.2.1-rc.2` 合并后，本 PoC 在主工作区补做了 Browser preset 工具核对、lazy archive 重试、容量样本、Chrome storage quota override 和持久 profile/backend 正常重启恢复。验证只覆盖当前 checkout；不要从模块加载或 VFS image 文件数推断所有 DSH 插件可用。各模块的真实证据等级见[插件兼容矩阵](operational-compatibility-matrix.md)，命令、九组容量样本、失败记录与未验证范围见[实施进度](operational-envelope-validation-progress.md)，目标与验收边界见[验证计划](operational-envelope-validation-plan.md)。

这批验证同时修复了 PoC 的 Session flush durability、prompt 变量、MessagePort 测试响应和 Workspace identity cookie 持久性。容量结果是单机 Chrome 微型负载基线，不是 SLA；quota 结果来自 Chrome CDP 配额覆写，不是自然 eviction；进程重启测试是正常关闭后重启，不是 OS 级 crash。

复跑下列模型无关的 Chrome 验收前，先构建 preview；Playwright 必须已安装。真实模型命令读取 `docs/drafts/.env`，只有脚本输出完整成功 JSON 才算通过。真实默认 profile 的 `todo_write` 三轮闭环由 `browser-native-v2.e2e.mjs` 验证；`runtime-validation.e2e.mjs` 使用独立 validation roster 验证文件读写，不要混淆两者。

```sh
pnpm run build:artifacts
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
node docs/drafts/browser-native-dsh-poc/tests/default-profile-capabilities.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/lazy-archive-runtime.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/browser-quota-enforcement.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/chrome-process-restart.e2e.mjs
DSH_POC_RESULT_FILE=docs/drafts/browser-native-dsh-poc/operational-capacity-chrome-results.json node docs/drafts/browser-native-dsh-poc/tests/operational-capacity.e2e.mjs
DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_LLM_TIMEOUT_MS=600000 DSH_POC_TURN_TIMEOUT_MS=900000 node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/browser-native-v2.e2e.mjs
```

## 当前实现快照

v2 当前不是独立的 HTML demo。浏览器加载现有 `preview.html`，页面仍由 `AppWebEntry` 和 DSH Web UI 渲染。`apps/web/src/preview.ts` 静态导入并始终实例化本目录的 [`browser-native-worker.ts`](browser-native-worker.ts)；`browser-native=1` 只控制是否追加本目录的 profile overlay，不控制 Worker entry 的选择。Worker 使用现有 `appBoot.boot()`、Cordis composition、Session Controller 和 `ctx.agentLoop`；[`browser-native-providers.ts`](browser-native-providers.ts) 只提供正式 `SessionPersistence` 和 `LlmAdapter` 的远程实现。

Workspace mirror 仍默认使用内存模式；`browser-native-durable=1` 才启用 OPFS/IndexedDB 本地 snapshot 和 retry。`browser-native-workspace-lease=1` 额外启用 Workspace writer lease、fencing token 和 commit operation 查询；lease 是 PoC backend 的单进程协议，不是生产级跨进程锁。

若需要验证第三方聊天层，可以阅读同级的[assistant-ui + Browser-Native DSH 增量 PoC](../assistant-ui-browser-native-dsh-poc/README.md)。该 PoC 复用本目录的 Worker、profile overlay、backend 和 Session protocol，但自行启动 DSH Client 并只挂载 assistant-ui 聊天层；它不改变本目录的现有页面或实现文件。

同源 [`backend-v2.mjs`](backend-v2.mjs) 提供 `/api/browser-native/session/*` 和 `/api/browser-native/llm`。Session 事件以正式 DSH event DTO 写入本地 JSON 文件；`append` 只更新当前 backend 的内存状态，`flush` 或 `close` 才通过临时文件、文件 `fsync`、原子替换和父目录 `fsync` 建立本地 durability receipt。Workspace manifest、身份、lease 和 operation receipt 也存于本地 JSON `dataDir`；默认 blob store 使用本地文件，测试可注入 PoC-only S3 adapter。real LLM provider 的 base URL、model 和 API key 只由 Node backend 从 `--env-file` 读取；页面和 Worker 只看到同源 route。

`session/list` 同时返回 Session Persistence 使用的 `snapshots` 和 Client Session Controller 使用的 `items`；新增 `items` 不替换原有持久化字段。`items` 是 PoC 用于恢复的最小目录投影：`updatedAt` 暂用 header 的 `createdAt`，`agentAvailable` 和 `running` 固定为 `false`，`blank` 由事件数计算，不代表真实活动状态。Session Controller 用该列表判断已保存的 Session 是否可 retain。assistant-ui PoC 和原生 preview 都在页面刷新时重连同一 Session；前者由 `dsh-client.ts` 负责 owner 通知和卸载处理，后者由 [`browser-native-page-control.ts`](../../../apps/web/src/browser-native-page-control.ts) 通过 Worker `MessagePort` 收取 owner token、保存在 tab-scoped `sessionStorage`，并先取得 [`browser-native-recovery.ts`](../../../apps/web/src/browser-native-recovery.ts) 提供的 per-resource Web Lock，再允许恢复凭据进入 Worker。pagehide 会发送 close beacon、终止页面拥有的 Worker并按生命周期释放锁。真实 Chrome 验证 opener 副本被拒及原页面关闭后刷新接管；浏览器不保证在强制关闭或崩溃时完成卸载请求。

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

真实 Chrome 复测记录了三个 `completed` turn、一个持久化 `todo_write`、40 个 Session events 和 `durableThroughSeq=39`。基础 E2E 使用当前 PoC Browser profile；`runtime-validation.e2e.mjs` 仍使用独立 validation overlay 验证 `read → write → read` 文件工具闭环，二者覆盖不同 roster。

2026-10-24 真实 Chrome 复测再次通过默认 Browser profile 三轮对话、恰好一次 `todo_write` 和同 Session token 记忆；Browser-specific durable Workspace E2E 完成 `read → write → read`，8 个同源 LLM 请求和两次 Workspace commit 均为 HTTP 200，刷新后 token 与已提交文件仍可读。两次测试均确认 provider secret 未进入浏览器请求。首次复测发现空 assistant 被标为完成；backend 现在也会拒绝空 `[DONE]`，合同测试和真实重跑记录见[验证报告](runtime-validation-report.md)。

真实模型 Stop/恢复单独运行：

```sh
DSH_POC_ENV_FILE=docs/drafts/.env \
DSH_POC_BROWSER=chrome \
DSH_POC_LLM_TIMEOUT_MS=180000 \
DSH_POC_TURN_TIMEOUT_MS=600000 \
node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-real-lifecycle.e2e.mjs
```

该脚本要求真实模型请求处于进行中时点击 Stop，随后在同一 Session 发送恢复消息；通过条件是最新 `turn/end` 为 `completed`，同一 Session 的 durable JSON 包含恢复 marker，且浏览器没有 page error。若 provider 以空 `finish_reason` 或没有内容的 `[DONE]` 结束，backend 返回 `UPSTREAM_LLM_EMPTY`；测试会在同一 Session 明确重试一次。当前 Chrome 真实模型复测为 `aborted → completed`。该结果不代表取消延迟或稳定性统计。

人工验收步骤、两个 UI 入口、对话脚本、Session 文件核对和常见故障排查见[手动验收说明](manual-acceptance.md)；历史天气问题中工具连续尝试的原因见[工具调用事实核查](agent-loop-tool-attempt-analysis.md)。Browser profile 的配置理由和本批后的实际 roster 见[工具清单与配置裁剪调研](browser-native-tool-roster-and-configuration-research.md)及[兼容矩阵](operational-compatibility-matrix.md)。

## 容量与进程安全验证

[容量与进程安全验证计划](next-capacity-and-process-safety-plan.md)及[进度记录](next-capacity-and-process-safety-progress.md)新增了两个高风险验证面。真实 Chrome 155 的 [OPFS VFS 驻留 E2E](tests/opfs-vfs-residency.e2e.mjs) 写入 8 MiB Workspace 文件、提交后刷新，并在真实 Dedicated Worker 中从 OPFS `FileSystemSyncAccessHandle` 做 64-byte range read。刷新后的 `logicalBytes=42,882,431` 而 `residentBytes=34,493,823`；range read 后仍保持同一量级，追加写才将该文件 materialize 回 VFS 内存，随后再次刷新又回到外部 backing。该结果证明了 opt-in 的外部同步 range backing 和生命周期关闭路径，不证明零拷贝、峰值内存 SLA、完整 OPFS 文件系统或生产容量保证。

当前 hydrate 为确认 content-addressed blob 的完整 SHA-256，会先进行一次临时完整读取；稳定状态下文件节点不持有该 `Uint8Array`。因此本 PoC 已验证“文件驻留位置”和同步 Node-style range read，尚未验证“首次 hydrate 无完整临时副本”；后续若需要更低峰值，应引入可增量更新的 hash 校验实现并单独测量。

同一 `dataDir` 的 [backend 单写者与强杀恢复 E2E](tests/workspace-backend-multi-instance-characterization.e2e.mjs) 启动两个独立 Node PID，第二进程在 `listen()` 前以 `BACKEND_ALREADY_RUNNING` 失败；第一进程写入并提交 Session/Workspace 后被 `SIGKILL`，新进程冷启动读回 1 条 Session event、Workspace revision 1 和文件 hash，使用新的 fencing token 重放原 `operationId` 只返回同一 receipt，不增加 revision。该锁只支持同一主机、同一 `dataDir` 的单 backend writer；它不是跨主机 HA、共享数据库事务、OS/磁盘 crash durability 或生产对象存储协调器。

复跑本批模型无关验收：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
pnpm exec vitest run packages/experimental/webworker-runtime/tests/storage/memory-vfs.spec.ts --coverage=false
pnpm exec tsc --noEmit -p packages/experimental/webworker-runtime/tsconfig.json
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
  node docs/drafts/browser-native-dsh-poc/tests/opfs-vfs-residency.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/workspace-backend-multi-instance-characterization.e2e.mjs
```

这批验证仍不覆盖自然 storage eviction、OS/磁盘崩溃、Safari/WebKit、多设备 merge、跨主机 backend、多实例 metadata store、真实云对象存储或真实 LLM 生成大型文件参数。

## 长 Session、并行工具与失败收束验证

[下一批深度运行时验证计划](next-deep-runtime-validation-plan.md)和[进度记录](next-deep-runtime-validation-progress.md)把四个高价值运行时风险放在同一批次：长 Session 刷新 hydrate、同一 turn 的并行只读工具、`assistant/attempt` append 失败，以及大文件标准写入与 external/chunk backing 的边界。验证仍使用真实 Chrome、Dedicated Worker、真实 DSH Host 和同源 backend；scripted LLM 只固定工具调用和故障时序。

当前 checkout 的 Chrome 证据如下：24 轮 Session 刷新前有 202 个事件，刷新后只新增 `session/end-seed`，LLM 请求计数保持 `25 -> 25`，刷新后同一 Session 可以继续；两个 `read` call 在同一 assistant message 中发出并重叠执行，部分失败仍由同一 turn 完成；第一次 `assistant/attempt` append 注入 503 后，有限重试将 attempt 落盘，turn 以 `error` 收束，刷新不重发失败 prompt，显式新 turn 可以继续。

大文件验证复用本目录已有的 [OPFS residency E2E](tests/opfs-vfs-residency.e2e.mjs) 和 [reference-backed edit E2E](tests/reference-backed-edit.e2e.mjs)：8 MiB 标准写入和 append 证明标准路径会 materialize，刷新后 external range backing 降低驻留；16 MiB/1 MiB chunk copy-on-write 的六个注入失败点均保持源 hash，正常路径刷新后 hash 一致。这不是零拷贝、块级 delta、通用 Node `fs` 或正式 DSH `edit` 的有界内存保证。

复跑本批 Chrome 验证：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
export DSH_POC_BROWSER=chrome
export DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js
DSH_POC_LONG_SESSION_TURNS=24 node docs/drafts/browser-native-dsh-poc/tests/long-session-hydrate.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/parallel-tool-fanout.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/attempt-settlement-failure.e2e.mjs
DSH_POC_OPFS_FILE_BYTES=8388608 node docs/drafts/browser-native-dsh-poc/tests/opfs-vfs-residency.e2e.mjs
DSH_POC_REFERENCE_EDIT_BYTES=16777216 DSH_POC_REFERENCE_EDIT_CHUNK_BYTES=1048576 node docs/drafts/browser-native-dsh-poc/tests/reference-backed-edit.e2e.mjs
```

本批没有验证自然 eviction、OS/磁盘崩溃、多实例 backend、生产对象存储、Safari/WebKit 或真实 LLM 生成大型 tool args。该批的 pending events 仍只在 Worker 内存中；后续 Session outbox 故障恢复见[专门验证](session-outbox-recovery-validation-plan.md)。标准 `write`/`edit` 仍可能完整驻留文件，external/chunk 路径是 PoC-local 原型。

## 长会话可持续性与上下文压缩验证

[长会话可持续性验证计划](next-session-sustainability-validation-plan.md)及[进度记录](next-session-sustainability-validation-progress.md)补齐了 Browser profile 的 compaction 组合、模型 context window 传递、大工具结果裁剪、摘要失败、Session append 重试、真实模型压缩记忆和 64 轮冷 hydrate。Browser profile 现在显式挂载 Web standard preset 的 `compaction-basic`、`command-compact` 和 `tool-result-pruner`；backend 只在显式配置时向 Worker 传递非敏感 `contextWindow`，未配置时不猜测。

当前 Chrome 证据包括：默认 Browser profile 的 scripted `/compact`；自动压力和 context-overflow recovery；摘要部分流失败后的 error end；一次 `compaction/end` append 503 后无重复 summary/replacement；真实 `gpt-5.6-sol` 在 `contextWindow=32768` 下生成 summary，刷新后回忆 sentinel。64 轮 scripted Session 刷新前有 522 个事件、落盘 142,006 bytes，hydrate 响应 284,184 bytes、耗时 1,885 ms，刷新没有重放 LLM 请求。这些数据说明 compaction 改变模型可见内容但不缩小权威 Session event log；它们不是生产 SLA、所有模型摘要质量或分页已经实现的证明。

复跑命令：

```sh
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/default-profile-capabilities.e2e.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/compaction-session-sustainability.e2e.mjs
DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_CONTEXT_WINDOW=32768 \
  node docs/drafts/browser-native-dsh-poc/tests/compaction-real.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_LONG_SESSION_TURNS=64 \
  node docs/drafts/browser-native-dsh-poc/tests/long-session-hydrate.e2e.mjs
```

真实模型测试只验证当前 provider/model、Chrome 和当前摘要提示；不会把真实模型凭据写入浏览器或测试输出。自然 eviction、OS crash、Safari/WebKit、Session 本地 outbox 和跨设备恢复仍未验证。

## Session 远程写入可靠性验证

[Session 传输可靠性计划](session-transport-resilience-validation-plan.md)及[进度记录](session-transport-resilience-validation-progress.md)验证 Browser Worker 的远程 Session append 如何处理 backend 限额、提交后响应丢失、短时连续 503、Workspace receipt 与 durable acknowledgement。provider 和 backend 共用 PoC 协议中的 append 限额：每批最多 1,024 个事件、1 MiB UTF-8 JSON；live event 共享一个 drain，失败批次保留原序，`SEQ_CONFLICT` 后读取相同 seq 范围并逐事件核对。

当前 Chrome E2E 在 DSH `write` 工具已提交 Workspace 后丢弃 Session receipt append 的成功响应；重试通过 seq 对账认领同一 receipt，没有重复 Workspace commit。另注入 3 次连续 503：未持久化的用户输入不会送入模型，DSH 将该 turn 以错误收束；刷新后显式开启的新 turn 可以继续。系统不会宣称原 prompt 自动恢复。真实模型 `gpt-5.6-sol` 的 compaction、刷新和 sentinel 回忆 smoke 通过；单独的真实 `read → write → read` 流程实际完成三次工具调用，但最终回答请求返回空流并以 `UPSTREAM_LLM_EMPTY` 结束，因此不宣称完整真实模型文件 E2E 通过。

复跑本批验证：

```sh
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-session-transport.spec.ts
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-transport-resilience.e2e.mjs
DSH_POC_CONTEXT_WINDOW=32768 DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
  node docs/drafts/browser-native-dsh-poc/tests/compaction-real.e2e.mjs
```

这批验证没有覆盖 durable outbox；后续实现和当前限制见下节。单个超出 1 MiB 的 Session event 仍会明确失败且不截断；append 成功只表示 backend 接收，只有 flush/close 回执覆盖相应 seq 才表示 durable；Session 与 Workspace 不是原子事务。故障 turn 的原 prompt 不会自动重放，用户需要显式重新提交；永久断网、OS crash 和生产 backend 未验证。

## Browser Session outbox 与 Worker 终止恢复

[Session outbox 验证计划](session-outbox-recovery-validation-plan.md)和[进度](session-outbox-recovery-validation-progress.md)记录当前 checkout 的 IndexedDB event journal、Worker 重启后 Session 对账、writer fencing、Workspace receipt 恢复与故障矩阵。Remote Session backend 仍是事件事实来源；IndexedDB 只保存尚未被 backend durability watermark 覆盖的事件副本，不恢复 JS Promise，也不自动重放 prompt、工具或 HITL。

当前 Chrome Worker 会在远端 append 前原子写入本地 outbox，并且只在 backend `flush`/`close` 返回的 `durableThroughSeq` 覆盖事件后清理记录。新 Worker 取得 writer lease 后按 seq 和完整事件内容核对 backend，补齐缺失的连续尾部，再 flush；同 seq 冲突、seq 缺口、stale writer、事务失败和容量超限均 fail closed。数据库从 v1 升至 v2 时保留旧 event rows，并从 Session metadata 重建全局计数。无 pending event 的 writer fence 可在达到 256 条上限时回收；有 pending event 的 fence 不会因容量被清除。

Chrome E2E 已验证 Worker 在 append 前被终止后恢复原事件且不重发原 prompt；backend 已 durable、flush response 被拦截时刷新不会重复 append；Workspace commit 已完成而 Session receipt 尚未远端确认时，刷新后恢复同一 receipt，Workspace commit 仍只有一次。IDB abort 阻止模型请求，v1 schema migration、旧 writer fencing、单 Session 与全局预算也通过 Worker 探针。只有 IndexedDB transaction 已提交的 event rows 可保证恢复；Worker 终止时仍留在内存或未完成 transaction 中的事件可能丢失，但下一次 DSH checkpoint 会在模型请求或顶层工具副作用前等待 journal 和远端 durability。真实 `gpt-5.6-sol` Chrome smoke 在 durable Workspace 模式完成三轮：首轮 `read → write → read`，刷新后从 Session 回忆 token，并由 DSH `read` 找回 Workspace 文件；8/8 模型请求返回 HTTP 200，Workspace commit 两次均获 HTTP 200，Session `durableThroughSeq=58`。相同测试未启用 durable Workspace 时，刷新后文件确实不存在；该对照说明 Session outbox 不会替代 Workspace 持久化。凭据不进入浏览器，模型请求仅到同源 backend。

outbox 上限为每 Session 8,192 events/16 MiB、整个浏览器 profile 32,768 events/64 MiB，最多跟踪 256 个带 pending event 或保留 fence 的 Session；浏览器 quota 可能先于这些限额触发。IndexedDB 仍可被用户清除或浏览器驱逐，因此它不是远端备份；没有验证自然 eviction、OS/磁盘崩溃、Safari/WebKit、生产 backend 或后台 Agent。Session 与 Workspace 仍没有跨存储事务。

复跑本批验证：

```sh
pnpm exec tsc --noEmit -p packages/experimental/webworker-runtime/tsconfig.json
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-session-transport.spec.ts
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-outbox-recovery.e2e.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-receipt-recovery.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_LLM=real DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ENV_FILE=docs/drafts/.env \
  node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
```

## Worker 启动前运行期能力探测

[本批计划](runtime-capability-probe-validation-plan.md)与[进度](runtime-capability-probe-validation-progress.md)验证 Browser-Native preview 在建立通用 Worker Host handshake 前，是否能确认 Session outbox、同源 backend 和用户选择的 durable Workspace。preview 等待 Worker 的 probe 结果后才调用 `connectWorkerHost()`；Worker 收到 init 时也拒绝已请求但未通过的 probe。普通 memory Workspace 不要求 OPFS。

真实 Chrome Worker 会在 outbox 数据库的 metadata store 中执行临时 put/delete readwrite transaction；只有 transaction `complete` 才判定成功。backend probe 检查现有 `/health` 和 `/config` 的 HTTP、协议版本、mode/provider/model 字段。v2 backend 在 SessionStore、WorkspaceStore 和 LLM config 加载后才开始监听，但这两个 route 没有独立存储 health 字段，也不保证后续写入成功。durable 模式在 Worker 中用临时 OPFS 文件执行 SyncAccessHandle 写入、读回、截断和删除。

Chrome 故障 E2E 注入 backend 503/错协议、真实 IDB transaction abort 和 OPFS probe seam 失败；启动被拒时没有 Session 或 LLM 请求，诊断不包含 backend response body。OPFS 成功路径使用真实 Chrome API，失败路径是 probe adapter 故障注入，不代表自然 API 故障。故障解除后脚本化 turn 成功；独立真实 LLM 冒烟完成 3 turn、8/8 模型请求 200、刷新后同 Session 与 durable Workspace 文件恢复。自然 eviction、OS crash、Safari/WebKit、生产 HA 和启动后依赖失效仍未验证。

复跑本批检查：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-runtime-probes.spec.ts
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
node docs/drafts/browser-native-dsh-poc/tests/runtime-capability-probes.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/session-outbox-recovery.e2e.mjs
env DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_REFRESH_CYCLES=1 DSH_POC_TURN_TIMEOUT_MS=600000 node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
```

## 运行期能力发布与撤销

[本批计划](runtime-capability-publication-validation-plan.md)和[验证进度](runtime-capability-publication-validation-progress.md)记录启动探测、DSH `request/header` 与实际 LLM 工具 schema 的一致性，以及本地 Workspace durable 失败后的能力撤销。真实 Chrome E2E 验证 OPFS quota 失败后同批迟到写被 dispatch guard 拒绝、后续 schema 移除 Workspace 工具、刷新后新 Worker 重新探测并恢复工具；本地已 durable、仅云端 commit 返回 503 时，工具保持可用并以原 operationId 重试。普通文件 `read → write → read` 另有真实 LLM smoke；故障顺序由 scripted E2E 控制，不代表真实模型处理 quota 故障。

## Session 与 Workspace 执行写权交接

## Worker 控制通道连续性

[控制通道连续性验证计划](next-control-channel-conformance-validation-plan.md)及[进度记录](next-control-channel-conformance-validation-progress.md)把 dsh-TUI 的基线、连续序列和失序 fail-closed 经验用于页面与 Dedicated Worker 的旁路控制通道。Worker 绑定 `MessagePort` 后先发送 `control-ready`，随后 owner、Workspace、lease 和 pagehide ack 都使用同一 `channelId` 和递增 `seq`。页面只有在协议版本、通道身份、序列连续性和 payload 通过 `BrowserNativeControlReceiver` 检查后才更新状态；notice 使用 exact-key schema，文本字段最多 4 KiB UTF-8，序列化 JSON frame 最多 16 KiB。未知字段/notice、过大字段、循环 extra、同序冲突或跳号会锁定当前 receiver；invalid 事件只带固定 reason code，不广播未经验证的原始 payload。

真实 Chrome E2E 已验证三次刷新建立不同通道，duplicate 不产生 invalid，gap/conflict 分别产生 `CONTROL_SEQUENCE_GAP`/`CONTROL_SEQUENCE_CONFLICT`，无页面或 Worker 错误、无跨源请求。真实 LLM 另以同域 backend 完成普通 `read → write → read` smoke 和刷新恢复；它只证明接线没有破坏 Agent Loop，不证明真实模型生成控制故障。控制通道失效不会自动恢复 Session、模型流、工具调用、HITL 或后台 Agent。

复跑本批检查：

```sh
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-control-channel.spec.ts
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/control-channel-conformance.e2e.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/control-payload-bounds.e2e.mjs
```

## 复制标签页恢复凭据隔离

[验证计划](next-tab-recovery-isolation-validation-plan.md)与[进度](next-tab-recovery-isolation-validation-progress.md)记录了 opener popup 复制 `sessionStorage` 后 Session owner token 与 Workspace lease 可能被两个 Worker 共用的风险。页面在恢复前先为每个 Session/Workspace resource 取得 Web Lock；资源冲突、锁 API 不可用或恢复存储不可写时，页面停止 Worker，不发送 Browser-Native backend 请求。真实 Chrome 分别验证 Workspace-only、Session-only 和完整凭据副本；原页面关闭后，完整副本刷新并恢复同一 Session，模型只收到一次新 prompt，旧 Workspace fencing token 被拒，Workspace 修改只提交一次。Web Locks 使用非阻塞 `ifAvailable`；Chrome 不允许它与 `signal` 同用，因此 adapter 用本地取消状态处理卸载时尚未回调的请求，单测另验证晚到授权立即释放及批量失败只回滚新锁。

这只是同 origin/storage partition 内协作页面的单写者保护，不能替代 backend fencing 或身份授权。无 Web Locks 时当前 Browser-Native Host fail closed。`pagehide.persisted` 仅以合成事件触发验证；pending lock 的晚到 callback 由单测验证，真实页面卸载与原生 callback 的精确调度竞争、BFCache 往返、首次 claim 并发、后台标签冻结、跨设备、多 backend 和生产授权未验证。

复跑本批检查：

```sh
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-recovery.spec.ts
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/tab-recovery-duplication.e2e.mjs
```

[browser-native-recovery.ts](../../../apps/web/src/browser-native-recovery.ts)实现恢复记录校验和 Web Locks 管理；对应页面接线在 [browser-native-page-control.ts](../../../apps/web/src/browser-native-page-control.ts)。

## 生命周期、身份与浏览器计算位置验证

[本批计划](browser-lifecycle-ownership-validation-plan.md)及[验证进度](browser-lifecycle-ownership-validation-progress.md)覆盖无恢复凭据时的 Session/Workspace 同时 claim、真实 Chrome BFCache 尝试、页面冻结、身份 cookie 丢失后的本地 Workspace 导出，以及 1/4/8 个隔离浏览器 context 中的真实 DSH Worker workload。

首次 claim 竞争中，Session 和 Workspace 各只有一个页面取得 `200`，另一个收到 `409`；两边 seq/revision 不变，也没有模型请求或 Workspace commit。Chrome CDP 冻结页面时 Dedicated Worker 仍续租两类 lease，竞争 claim 被拒绝。清除 PoC 身份 cookie 后，本地 metadata 和 OPFS 文件保留，页面 fail closed 并可导出恢复包，不会创建新 principal 或把空 Workspace 标为恢复成功。恢复包最大为 64 MiB；超限时操作失败，不截断也不修改本地数据。

1/4/8 个隔离 context 共完成 13 个 DSH turn、26 次工具调用、13 个唯一 Workspace commit；每 context 一个 Dedicated Worker，全部由同一个 in-process PoC backend 服务。容量数字只用于单机诊断，不是生产 SLA。真实 Chrome back/forward 没有命中 BFCache；Chrome 报告 PoC 的 `no-store` 响应和 JavaScript 网络请求是拒绝原因，因此 BFCache 连续性仍未验证。真实 LLM 普通文件 smoke 在重试后通过，不替代 scripted 并发测试；首次空流失败保留在进度记录中。

复跑本批验证：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts \
  docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-control-channel.spec.ts
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
export DSH_POC_BROWSER=chrome
export DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js
node docs/drafts/browser-native-dsh-poc/tests/first-claim-race.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/real-bfcache-lifecycle.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/page-freeze-lease-fencing.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/identity-cookie-loss.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/browser-worker-placement-capacity.e2e.mjs
DSH_POC_LLM=real DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ENV_FILE=docs/drafts/.env \
  DSH_POC_TURN_TIMEOUT_MS=600000 node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
```

身份 cookie 丢失时的 fail-closed 状态和有界本地恢复导出由 opt-in preview 页面接线，变更原因、验证及 upstream 重放方式见 [change-ledger.md](change-ledger.md) 的 BN-P2-038。

[执行写权交接计划](execution-owner-handoff-validation-plan.md)和[进度记录](execution-owner-handoff-validation-progress.md)验证同一 DSH Session 在两个 Dedicated Worker 之间切换时的顺序与未知结果恢复。协调器先 flush Workspace 云端 revision 和本地 snapshot，再 flush Session outbox 并核对 `durableThroughSeq`，随后转移 Session owner，最后释放旧 Workspace lease；Session 与 Workspace 仍不是跨存储事务。

Chrome scripted E2E 覆盖正常交接、Session handoff 已提交但响应丢失、Workspace release 响应丢失，以及旧 owner 的 Session append、LLM request 和 Workspace renew 被 fencing。真实 LLM E2E 在同一个 Session 完成 `write → read → handoff → read → write → read`，核对 5 个 DSH tool call、2 个 Workspace commit/receipt 和两个 owner epoch/fencing token 的递增。LLM 请求不携带 Workspace principal cookie；handoff checkpoint 在 Worker adapter 中将内部 `ownerEpoch` 映射为现有 API 字段 `epoch`。

handoff 只转移 Session 与 Workspace 写权，不迁移 Worker Host、插件内存、活动模型流或 HITL Promise，也不启动后台 Agent。未知结果不自动重放 prompt 或副作用；页面关闭、OS crash、多 backend 和生产身份授权仍需单独验证。

复跑本批测试：

```sh
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-execution-handoff.spec.ts
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/execution-owner-handoff.e2e.mjs
DSH_POC_LLM_MODE=real DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/execution-owner-handoff.e2e.mjs
```

## Session 适配、能力发布与执行交接验证

[Session 适配与执行交接验证计划](next-session-adapter-and-handoff-validation-plan.md)及[进度记录](next-session-adapter-and-handoff-validation-progress.md)把 dsh-TUI 的四项可迁移纪律落到 Browser-Native PoC：history 完成后才接收 live event、取消/销毁保留 `unknown`、能力必须经过 probe 才发布，以及 Browser Worker 到云端执行者必须显式 handoff 并提升 fencing。它们不把现有 Workspace writer lease 测试改名为 Agent handoff。

当前实现包含四个 PoC-local 适配器：Session cursor 的连续 seq/去重/identity 检查、execution lifecycle 的 `confirmed`/`unknown`/`failed` settlement、capability publication 的 `live + probe + permission` roster，以及 Session backend 的 owner epoch handoff。handoff 是 Session 写权协议，不会启动 Cloud Host 或转移 Workspace lease、插件状态、模型流和 HITL Promise。最新的[handoff 安全与恢复验证](next-handoff-security-and-recovery-plan.md)修复了旧 owner 重放取回新 token、receipt 落盘 bearer 和 rename 后失败错误回滚的问题；handoff 现在要求 pending operation/execution 为空，旧 token replay 只返回不含 owner credential 的 receipt，rename 后 durability unknown 会封锁该 Session 直到 backend 重载。

[handoff 安全点验证](next-session-handoff-safe-point-plan.md)进一步让 backend 在 per-Session queue 内折叠已追加的 DSH event log，拒绝仍有打开 turn/step 或未结算 tool call 的 handoff；损坏的边界和 tool/result 配对以 `HANDOFF_STATE_INVALID` 拒绝。空 checkpoint pending 列表不能覆盖服务端已记录的活动工作。扫描按 `(turn, step, callId)` 配对，允许 DSH 在不同 turn/step 重用 tool-call ID，并保留 compaction 对已结算历史 tool result 的合法 `surfaceOp: replace`。合同测试覆盖终态错误工具、伪空列表、损坏序列、历史 replacement 及 terminal append/handoff 两种锁顺序；Chrome Dedicated Worker E2E 在活动 scripted LLM turn 中观察到 `HANDOFF_BUSY`，并确认原 turn 只发出一次模型请求后完成。

Worker 远端 Session reader 将 DSH `SessionHandle.read()` 的读取剩余日志语义转换为 backend 每页最多 2048 条的连续读取，并校验分页间的事件 seq 与 ownership state。分页单测覆盖多页、backend 短页、空尾部及不连续响应；重建 preview 后的 Chrome Workspace handoff E2E 验证第二个 Worker 能恢复同一 Session 并继续执行。此处仍是 PoC 同源 backend 的分页读，不表示大 Session 已完成流式 hydrate 或内存占用优化。

上一批 Session 适配、能力发布和初次 handoff 证据仍可按[原进度记录](next-session-adapter-and-handoff-validation-progress.md)查看；它证明旧协议曾通过测试，不代表凭据恢复安全。复跑 handoff 安全与恢复验证：

```sh
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-session-adapter.spec.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-execution-lifecycle.spec.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-handoff.spec.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-capabilities.spec.ts
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/default-profile-capabilities.e2e.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-owner-handoff.e2e.mjs
```

这批证据仍不是云端 Durable Worker、生产多实例 backend、跨存储原子事务或页面关闭后的后台 Agent 证明。`session-owner-handoff.e2e.mjs` 使用真实 Chrome Dedicated Worker 调用同源 Session backend，验证活动 turn 中 handoff 被拒、原 turn 只执行一次、提交后响应丢失、旧 token 重试不获凭据、租约过期后新 owner 重新 claim，以及旧 token 写入被拒绝；新 owner 仍是协议测试角色，没有启动真实 Cloud Agent。服务端只能检查已追加到 backend 的事件，无法证明 Worker 内存队列或浏览器本地 outbox 已清空；调用方仍须停止新工作并 flush Session。Safari/WebKit、自然 eviction、OS/磁盘 crash、生产授权和真实 LLM handoff 未执行。

## Session 与 Workspace principal 隔离

[身份隔离计划](principal-scoped-session-isolation-plan.md)和[实施进度](principal-scoped-session-isolation-progress.md)记录当前 checkout 对 PoC principal 授权与同源存储切换的验证。Session durable record、目录 cursor 和各 Session API 按 principal 授权；没有归属的旧 Session 保留但 fail closed。Workspace 与 Session 使用不同 Path-scoped HttpOnly principal cookies，均不发送到 LLM route。

Chrome 155.0.8059.85 在同一 browser context 中执行 A→B→A 身份切换，不清除 OPFS/IndexedDB。A 和 B 使用不同 Workspace ID，在相同路径写入不同内容；B 的 Session catalog、已知 A Session、Workspace manifest 与 DSH 文件读取均不能访问 A 的数据。A、B 各自刷新后都恢复自己的 Session、manifest 与 Worker 文件缓存，Workspace revision/hash 相互独立。当前身份来自 PoC 自动签发 endpoint，不是登录或生产租户授权；不能抵御 XSS、同源恶意代码、身份签发滥用或 Cookie 窃取。

复跑身份隔离与真实模型回归：

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/principal-scoped-session-isolation.e2e.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/execution-owner-handoff.e2e.mjs
DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ENV_FILE=docs/drafts/.env node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
```

真实 LLM smoke 验证 Browser Worker、普通文件工具、Session 和 Workspace refresh recovery，不是 A/B 两身份真实模型测试。多 backend、正式 SaaS identity/authorization、自然 eviction、OS crash、静态存储加密和 Safari/WebKit 未验证。

## 跨存储 checkpoint 与业务副作用对账

[跨存储 checkpoint 与 receipt 对账计划](cross-store-checkpoint-reconciliation-plan.md)及[实施进度](cross-store-checkpoint-reconciliation-progress.md)把 Workspace commit、Session receipt 和业务 API 副作用放入同一 `operationId` ledger 查询，但不把它们伪装成一个事务。backend intent/receipt/query API 校验 principal、完整工具调用身份和 payload digest；重复 operation 返回原记录，改 payload 或改身份被拒；业务 mock endpoint 只在第一次确认时增加 effect count。

Chrome scripted E2E 使用真实 Dedicated Worker、OPFS、IndexedDB、Workspace commit、Session receipt 和同源 mock 业务 endpoint。响应丢失后刷新查询原 operation，最终 Workspace revision 为 `1`、Session seq 为 `0`、业务 effect count 为 `1`、Workspace commit count 为 `1`，决策为 `reconciled`，页面没有错误。Node ledger/reconciliation tests 为 8/8；这证明的是保守的可查询 saga 和去重语义，不是跨存储原子提交。

复跑本批验证：

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/cross-store-operation-ledger.test.mjs \
  docs/drafts/browser-native-dsh-poc/tests/session-workspace-reconciliation.test.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js \
  node docs/drafts/browser-native-dsh-poc/tests/cross-store-reconciliation.e2e.mjs
```

当前 ledger 使用单进程 `dataDir` JSON 和 per-operation queue；多 backend、生产数据库/对象存储、真实租户授权、自然 eviction、OS crash、业务 API 的生产幂等保证和真实 LLM 触发 partial-success 仍未验证。真实模型只完成普通 Browser-Native 文件/Session smoke；未知结果仍需查询原 operation，禁止自动重放未知业务副作用。

## Timed HITL 与 Worker 恢复

[Timed HITL 生命周期验证计划](timed-hitl-lifecycle-validation-plan.md)及[进度记录](timed-hitl-lifecycle-validation-progress.md)使用只在临时验收镜像中启用的 `tool-ask-user mode: timed`，验证 deadline 前同一 turn 作答、timeout 后迟答、刷新后恢复原 callId、答案 durable 后再刷新，以及关闭问题卡后的恢复。默认 Browser profile 仍使用 legacy 问答；本批没有改变正式 DSH package 或默认 profile。

Chrome 证据显示，deadline 前答案写入原工具结果并在同一 turn 继续；迟答保持原工具结果为 pending，并以 `user-question-reply` source 和原 callId 写入 Session，后续业务写只执行一次。Worker 刷新将未完成的工具调用记录为 `TOOL_OUTCOME_UNKNOWN`，timed question projection 仍可重建同一问题；答案已 durable 后刷新不会重复答案或恢复中断模型回复，显式新消息才能继续。脚本化测试只验证执行与持久化时序，不验证真实模型是否选择 timed 问答。

后续[活动 HITL Stop 验证计划](active-hitl-stop-validation-plan.md)和[进度](active-hitl-stop-validation-progress.md)已在官方 `ui-user-questions` composer 加入显式 Stop。真实 Chrome Worker/DSH E2E 分别验证 timed 与默认 legacy 活动问答：点击后 turn 以 `aborted` 收束，不写入成功答案、不生成迟答消息、不执行后续 write，Workspace revision 保持不变。timed 问题 timeout 后已继续、仅保留迟答通道时不显示 Stop，避免旧问题卡取消另一个 turn。Escape shortcut 仍在 `pendingInteraction` 存在时忽略；关联工具行的 Close 仍只隐藏，不取消等待。Stop 不回滚已经提交的副作用。

在 Playwright 环境中复跑：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
export DSH_POC_BROWSER=chrome
export DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js
DSH_POC_TIMED_QUESTION_TIMEOUT=10 DSH_POC_TIMED_HITL_SCENARIO=in-time node docs/drafts/browser-native-dsh-poc/tests/timed-hitl-lifecycle.e2e.mjs
DSH_POC_TIMED_QUESTION_TIMEOUT=10 DSH_POC_TIMED_HITL_SCENARIO=late-answer node docs/drafts/browser-native-dsh-poc/tests/timed-hitl-lifecycle.e2e.mjs
DSH_POC_TIMED_HITL_SCENARIO=refresh-before-answer node docs/drafts/browser-native-dsh-poc/tests/timed-hitl-lifecycle.e2e.mjs
DSH_POC_TIMED_HITL_SCENARIO=refresh-after-answer node docs/drafts/browser-native-dsh-poc/tests/timed-hitl-lifecycle.e2e.mjs
DSH_POC_TIMED_QUESTION_TIMEOUT=30 DSH_POC_TIMED_HITL_SCENARIO=hide-refresh node docs/drafts/browser-native-dsh-poc/tests/timed-hitl-lifecycle.e2e.mjs
DSH_POC_TIMED_QUESTION_TIMEOUT=30 DSH_POC_TIMED_HITL_SCENARIO=stop-timed node docs/drafts/browser-native-dsh-poc/tests/timed-hitl-lifecycle.e2e.mjs
DSH_POC_TIMED_HITL_SCENARIO=stop-legacy node docs/drafts/browser-native-dsh-poc/tests/timed-hitl-lifecycle.e2e.mjs
```

这组测试使用 scripted LLM 固定问题调用，不代表模型会自主选择 HITL；真实 LLM 普通对话另按[运行时验证说明](runtime-validation-manual.md)验证。未覆盖 legacy refresh 迟答、双标签答案竞争、跨设备投递、所有 stop/timeout 调度顺序、OS 级崩溃或生产交互策略。

## 会话目录、观察者与交接幂等验证

[本批计划](next-catalog-observer-bridge-validation-plan.md)及[进度记录](next-catalog-observer-bridge-validation-progress.md)把 `dsh-TUI` 的 Session projection、单写者挂载和有界 dispatch 经验转成四个 Browser-Native 验证面：handoff 响应丢失后的幂等重试与严格 checkpoint、Session catalog 有界分页、只读观察者与单写 owner、跨边界 Session 载荷预算。它们不修改正式 Agent Loop 或 Session format。

当前 checkout 已实现 backend 合同层：同一 `handoffId` 的相同 checkpoint 重试不会再次提升 owner epoch，且 receipt 不含 raw bearer token；只有 rename 前确定失败才恢复旧 owner，rename 后 unknown 会封锁 Session 写入直到 backend 重载。新 handoff 拒绝非空 pending operation/execution；Session list 按稳定 id 游标分页，read 返回 `nextSeq`、`hasMore`、`durableThroughSeq` 和 `ownerEpoch`，append/read 超过预算时显式拒绝。真实 Chrome 双页面验收确认观察者能看到同一 Session 的追加事件但没有写权；这些证据不等于多实例 HA、跨设备同步或生产查询服务。

复跑本批模型无关验收：

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-observers.e2e.mjs
```

分页目录是查询投影，不是新的事实源；只读观察者不持有 owner token；载荷拒绝也不等于已经实现 blob 引用或大工具结果分页。真实 LLM、Safari/WebKit、自然 eviction、OS crash、跨主机 backend 和生产授权不在本批通过范围内。

## 多 Session 共享 Workspace observer 验证

[本批计划](shared-workspace-observer-validation-plan.md)和[实测进度](shared-workspace-observer-validation-progress.md)覆盖同一 Chrome 身份下两个独立 DSH Session 同时使用一个 Workspace：当前 writer 遇到明确的 `WORKSPACE_ALREADY_OWNED` 时，第二个 Worker 从已提交 manifest 启动为只读 observer；它不恢复或改写共享 OPFS/IndexedDB retry 数据，不取得 Workspace lease，也不生成 Workspace receipt。observer 的文件读取只发布 `read`、`grep`、`glob`；每次执行前后通过轻量 revision API 校验远端版本，过期后当前调用 fail closed 并撤销该 Workspace 工具组。用户显式刷新后，页面重新 hydrate 并竞争 writer lease，backend fencing 拒绝旧 token。

真实 Chrome 双标签 E2E 使用 scripted DSH 响应控制 503 retry、schema 外伪造 write、工具执行期间的 owner commit、stale read 和 lease 接管，核对 prompt 去重、唯一 operation、Session receipt 归属和同源网络；另跑真实 LLM 普通 `read → write → read` 与 durable 刷新恢复 smoke。两种证据范围不同，真实模型 smoke 不证明模型自主选择 observer/owner 时序。每个 observer 文件工具增加两次小型 revision 请求，不再下载完整 manifest；跨设备授权、多实例 backend、并发写合并、自然 eviction、OS crash 和 Safari/WebKit 未验证。

## Session projection 与写权观察验证

[本批计划](session-projection-authority-validation-plan.md)及[进度记录](session-projection-authority-validation-progress.md)把 Session projection 的展示读取与写权判定分开。PoC-local `BrowserNativeSessionProjectionStore` 在绑定或切换 Session 时先读取 baseline，只接受当前 Session 的 live update，重复 raw 引用不重复通知；reseed 能区分“值已删除”和“authority 读取失败”，detach 后不会接收迟到更新。该 store 只提供页面 read model，不是 Session 事实源，也不授予 Session append 或 Workspace lease。

真实 Chrome Worker probe 验证 baseline、跨 Session 过滤、A/B 切换、删除、detach/re-attach；同源 authority E2E 验证只读页面可读取事件但 append 返回 `409 SESSION_OWNERSHIP_LOST`，并发 claim 只有一个 `200`、另一个为 `409 SESSION_ALREADY_OWNED`。真实 `gpt-5.6-sol` smoke 另完成 3 turns、`read → write → read`、刷新恢复、59 个 Session events、`durableThroughSeq=58`、8/8 LLM HTTP 200 和两个 Workspace commit HTTP 200。日志仍有既有刷新 `ERR_ABORTED`、PoC route 404 和 compaction warning；不将其描述为零告警运行。

复跑本批模型无关验收：

```sh
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-session-projection.spec.ts
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-projection-authority.e2e.mjs
```

本批没有实现正式多 Session UI，没有证明同一 Worker 内多个真实 Agent Loop、真实模型自主 observer 时序、跨设备授权、生产多实例 HA、自然 eviction、OS/磁盘 crash、Safari/WebKit 或云端 executor handoff。`parked`、detach 和 projection continuity 都不表示页面关闭后 Worker 仍在后台运行。

## Session 与 Workspace receipt 确认丢失恢复

[跨存储恢复计划](cross-store-tool-recovery-validation-plan.md)与[实施进度](cross-store-tool-recovery-validation-progress.md)覆盖真实 DSH `write` 产生的 Workspace operation receipt：backend 已将包含 `tool/result` 和 receipt 的 Session 前缀 flush durable，但响应在到达 Worker 前丢失；随后旧 Worker 被终止、同 dataDir backend 重启，再刷新同一 Session。Chrome scripted E2E 检查 durable watermark、连续 Session seq、单一 tool call/result/receipt、Workspace revision、operationId 和 IndexedDB outbox，并确认刷新不重复 commit、receipt append 或原模型请求。

Provider 仅在 Session receipt 的 DSH call 元组及 Workspace commit 全字段均与本地 outbox receipt 一致时才确认 outbox；缺少对应 `tool/call` 或字段错配会 fail closed。Session 与 Workspace 仍是独立事实源，顺序协调不构成原子事务；本批的 scripted fault 不是真实模型、自然 eviction、OS crash 或生产多实例存储证据。真实 LLM 普通文件 smoke 与文档门禁状态见进度记录。

本批真实 Chrome/LLM smoke 另完成 3 轮、一次刷新、普通文件 `read → write → read`、跨轮记忆和刷新后文件读取；Session 含 59 个事件、durable watermark 为 58，8/8 LLM 请求返回 HTTP 200，且页面无异常。该运行只证明正常模型闭环可用，不证明真实模型能触发注入故障；首个 Session 文本 chunk 约 6.6 秒出现，但首个可见 assistant 更新约 103 秒，另有 compaction capacity warning 和三个 preview API 404，故不构成流式 UX 或 preview API 无告警验收。完整命令、请求取消和已知噪声见[本批进度](cross-store-tool-recovery-validation-progress.md)。

复跑本批验证：

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/session-workspace-reconciliation.test.mjs
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js \
  node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-receipt-recovery.e2e.mjs
```

## Workspace 并发 revision 与长编辑 fencing 验证

[本批计划](workspace-concurrent-revision-validation-plan.md)与[进度记录](workspace-concurrent-revision-validation-progress.md)验证 observer 异步读取与远端 commit 的竞态、revision 查询响应成本，以及 writer lease 在长 OPFS edit 中转移时的旧写者 fencing。真实 Chrome 双页面测试确认 stale read 以错误结算，旧 Workspace 内容不进入 tool result 或后续 LLM 请求；长 edit 在 lease token 从 1 提升至 2 后不能发布到旧 Worker VFS 或生成 receipt，新 owner 可提交 revision 2。

backend 的 `/api/browser-native/workspace/revision` 只返回 Workspace ID 和 revision，并沿用 manifest 的 principal 校验与 `Cache-Control: no-store`。对 1,000 个目录项的 manifest，revision JSON 在合约测试中被断言至少小 100 倍；Chrome E2E 另记录每个 revision 响应的字节数和耗时。该接口与前后 revision 检查只提供工具调用区间内的读取线性化点，不构成跨 Session 原子快照；edit 发布前的 lease 复核也不构成 VFS、Session 与 Workspace 事务。旧 lease 拒绝尚未发布的 edit 时，临时 OPFS staging 会被丢弃；Session 保留完整 tool-call 参数并记录显式失败，不自动重放，用户需刷新并显式重试。当前 Browser profile 禁用 `read_image`，observer 能力也不开放该工具。

复跑本批 Chrome 和定向检查：

```sh
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools.spec.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-chunk-editor.spec.ts
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/shared-workspace-observer.e2e.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/workspace-lease-edit-race.e2e.mjs
```

复跑本批验证：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-capabilities.spec.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-control-channel.spec.ts
node docs/drafts/browser-native-dsh-poc/tests/shared-workspace-observer.e2e.mjs
DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 \
  DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_TURN_TIMEOUT_MS=600000 \
  node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
```

真实 LLM 命令要求本机 `docs/drafts/.env` 已配置；backend 读取凭据，页面与 Worker 不接收模型密钥。

## 多 backend 与共享 Session/Workspace authority 验证

[本批计划](multi-instance-backend-authority-validation-plan.md)及[实施进度](multi-instance-backend-authority-validation-progress.md)验证两个无状态 PoC backend 是否能在 round-robin 路由下共同服务同一浏览器 Session。Session、Workspace、operation ledger 和 LLM owner epoch 校验由一个共享 authority 处理；authority 和任一 backend 重启后，页面仍能从同一 durable JSON store 恢复事实。共享 authority 只允许内部 token 访问，浏览器请求仍必须经过 backend。

真实 Chrome scripted E2E 使用真实 Dedicated Worker、DSH Host、OPFS、IndexedDB 和同源代理，覆盖两个 backend 命中、backend/authority 重启、Workspace commit 已完成但响应丢失、operation 查询恢复和旧 owner fencing。最终记录 `eventCount=35`、`durableThroughSeq=34`、`llmRequestCount=4`、一个 `tool/call`、一个 Workspace operation 和无页面错误。唯一 Workspace operation 没有因 `503` response loss 被重复提交。

真实 Chrome/LLM smoke 覆盖两轮模型流、刷新和双进程重启，记录 `eventCount=28`、`durableThroughSeq=27`、`llmRequestCount=3`、双 backend 命中和无页面错误；本轮模型没有选择工具，因此不能宣称真实模型完成 `write/read` 或真实业务副作用。工具闭环证据来自 scripted LLM，模型工具选择仍需单独验证。

复跑本批验证：

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs \
  docs/drafts/browser-native-dsh-poc/tests/shared-state-authority.test.mjs
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/multi-instance-backend.e2e.mjs
DSH_POC_LLM_MODE=real DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome \
  node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/multi-instance-backend.e2e.mjs
```

本批仍不是生产共享数据库、跨主机 fencing、跨区域复制、Cloud Durable Worker、exactly-once 或 RPO/RTO 证据；代理会缓冲上传请求，authority 仍是单进程 PoC JSON service。自然 eviction、OS/磁盘崩溃、Safari/WebKit、正式多租户授权和真实模型大型工具参数未验证。

### 共享 authority 并发与失联恢复

[并发与恢复计划](shared-authority-concurrency-validation-plan.md)及[实测进度](shared-authority-concurrency-validation-progress.md)补充双 backend 同时竞争 Session create/open/append、Workspace lease/operation/CAS 和外部业务 effect 的证据。Chrome 156 双页面通过 route barrier 同时 claim Session/Workspace；每组恰有一个成功者。authority HTTP 服务停机时，Session read、Workspace manifest 和 LLM owner 授权均 fail closed，两个 backend 本地 store 为空；同一 `dataDir` 重建后，真实 Worker 从 OPFS 与服务端 blob 读回文件，并在原 Session 续聊。该浏览器测试不运行两个并行 Agent Loop，也不强杀 authority OS 进程；真实 LLM 多 backend smoke 未产生工具调用，不能证明模型自主文件操作。

复跑本批：

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs \
  docs/drafts/browser-native-dsh-poc/tests/shared-state-authority.test.mjs \
  docs/drafts/browser-native-dsh-poc/tests/shared-authority-concurrency.test.mjs \
  docs/drafts/browser-native-dsh-poc/tests/external-business-idempotency.test.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/shared-authority-concurrency.e2e.mjs
```

### 并行 Agent Loop 与 Workspace writer fencing

[本批计划](concurrent-agent-execution-validation-plan.md)及[进度](concurrent-agent-execution-validation-progress.md)验证两个真实 DSH Worker/Host 同时驱动独立 Session、通过两个同源 backend 访问共享 authority，并共享一个只允许单写者的 Workspace。Chrome scripted E2E 用 route barrier 同时挂起两个不同 Session 的模型请求，分别由 backend A/B 处理；owner 的真实 DSH `write` 与 observer 的 `read` 成功，observer 的隐藏 `write` 被拒且不产生 commit。

同一 E2E 将旧 owner 的 32 MiB OPFS `edit` 暂停在 `copy-prefix`，转移 lease token `1 → 2` 后让新 owner 改写同一路径。旧 Worker 仍在途时，本地 writer invalidation 在 VFS 发布前拒绝旧 edit；其 Session 保留错误结果但没有 Workspace receipt，最终 manifest 为 revision 3，三个成功 commit 均唯一。两个 backend 的本地 Session/Workspace store 为空。该结果不证明生产多实例 HA 或跨主机 fencing。

真实 Chrome LLM smoke 使用 `gpt-5.6-sol` 完成 3 轮、普通文件 `read → write → read`、跨轮记忆及刷新后同 Session/Workspace 恢复；Session 为 58 events、`durableThroughSeq=57`。Session 记录多个 assistant 文本 chunk，但可见 DOM 只采到一次更新，不能据此确认渐进渲染体验。该 smoke 不证明真实模型自主协调多 Worker 或选择冲突处理。

复跑本批：

```sh
node --check docs/drafts/browser-native-dsh-poc/tests/concurrent-agent-loops.e2e.mjs
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/concurrent-agent-loops.e2e.mjs
env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u no_proxy -u NO_PROXY DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_LLM_TIMEOUT_MS=600000 DSH_POC_TURN_TIMEOUT_MS=900000 node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
```

真实模型凭据只由 Node backend 从本机 `docs/drafts/.env` 读取。Chrome smoke 另观察到 Worker compaction context capacity warning 和 preview API 404；这些诊断没有使该次 smoke 失败，但本批不验证 warning 的根因。自然 eviction、OS/浏览器进程崩溃、Safari/WebKit、生产共享数据库和后台 Agent 未验证。

## 权限预设与审批生命周期

[权限与审批生命周期计划](permission-approval-lifecycle-validation-plan.md)及[进度](permission-approval-lifecycle-validation-progress.md)记录当前 checkout 对正式 `dsh-permission-presets`、`dsh-sandbox-policy` 和 `dsh-user-approval` 在 Browser Worker 中的验证。Worker 通过只读 `permission-state` 测试动作观察当前 Session 的 preset、sandbox mode、approval policy、可用目录和 workspace root；该探针不注册模型工具，也不能改变权限。Chrome scripted E2E 验证 `read-only` 写入被拒、`workspace-write` 写入成功、`ask` 下带 justification 的受保护 Bash 操作产生审批并在拒绝后不产生文件，以及 Full access 的显式风险确认、`never` 策略和无审批卡片。权限快照、实际文件和 Session 事件共同作为证据，Agent 文本不是唯一断言。

本批还完成一次真实 `gpt-5.6-sol` Chrome smoke：3 turns、5 个同源模型请求、Session durable watermark 和 todo 持久化通过。真实模型 smoke 只证明普通 Agent Loop 没有退化，不证明模型自主选择权限或审批路径。`allowed-once`、answerer cancel/timeout/unavailable、Worker 强杀后的专门权限恢复、生产认证和跨设备授权仍未验证。Full access 在此处只表示 Browser Worker 内 DSH 策略，不是宿主机权限、Node 权限或页面关闭后的后台 Agent。

复跑本批：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
pnpm exec tsc -p apps/web/tsconfig.json --noEmit
env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy \
  DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/permission-approval-lifecycle.e2e.mjs
env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy \
  DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_ENV_FILE=docs/drafts/.env \
  DSH_POC_TURN_TIMEOUT_MS=600000 node docs/drafts/browser-native-dsh-poc/tests/browser-native-v2.e2e.mjs
```

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

backend 使用目录内的 JSON 文件作为 PoC durability store。`append` 后事件对当前 backend 可见；成功的 `flush` 通过临时文件、文件和父目录同步以及原子替换写入 durable file；若 rename 已完成但目录同步失败，backend 将结果报告为 `DURABILITY_UNKNOWN` 并封锁该 Session 的写入，重启后再按实际文件恢复。handoff receipt 不保存 raw bearer token；owner token 只在 backend 进程内有效，重启后由新 Worker 重新 `open('write')`。v2 scripted mode 返回确定性的文本 stream，不执行旧版独立协议中的 `browser_echo`；real mode 将受限消息转换为 OpenAI-compatible Chat Completions request，解析上游 SSE，再转换为 DSH `StreamChunk`。历史 `run.mjs`、`public/` 和旧测试中的 `browser_echo` 只属于旧协议实验。

Session 与 Workspace metadata 的本地 JSON store 不是 PostgreSQL、HA 或生产多租户实现；它不提供跨进程 owner lease、跨重启 mutation replay、跨主机复制、备份保证或灾备 RPO/RTO。MinIO E2E 只验证 S3-compatible blob 操作，不把 metadata、Session 或 lease 迁移到对象存储。当前 browser-native E2E 只证明一次 Worker、单个同源 backend、正式 Session provider、真实 `ctx.agentLoop` 和 scripted/real LLM route 的闭环。

本目录没有加入根级 npm script、package manifest、Web profile、Desktop profile 或正式 DSH package。旧版命令和测试不证明 v2 的 DSH Host、正式 Session provider 或真实 `ctx.agentLoop`。若后续证明必须修改目录外代码，先按 [change-ledger.md](change-ledger.md) 登记原因、扩展点、测试和 upstream 重放步骤。

## Dev Note

这是可运行的 PoC，不是正式产品入口。v2 的实现事实、已运行命令和限制必须同步写入 [browser-native-dsh-progress-v2.md](browser-native-dsh-progress-v2.md)；[progress.md](progress.md) 只保留旧版独立 loop 的历史记录。不要把目录内历史 loop adapter 的通过结果写成 DSH 核心 Agent Loop 已完成浏览器化。
