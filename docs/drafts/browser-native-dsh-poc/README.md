---
description: "Browser-native DSH PoC 的 v2 规划和历史协议实验：保留 DSH Web UI、真实 Host/Agent Loop，并通过同源 Session backend 和 LLM proxy 接入浏览器 Worker。"
---

# Browser-native DSH PoC

## Summary

本目录包含多个阶段的研究材料。旧版是协议级独立 loop 实验；当前 v2 已经把现有 DSH Web UI、Cordis 插件组合和真实 `ctx.agentLoop` 放进 Dedicated Worker，并通过同源 backend 提供正式 Session persistence 和 LLM proxy。实施规格见 [browser-native-dsh-plan-v2.md](browser-native-dsh-plan-v2.md)，原始实施进度见 [browser-native-dsh-progress-v2.md](browser-native-dsh-progress-v2.md)。真实运行时验证命令见[运行时验证说明](runtime-validation-manual.md)，已验证结果、失败和未验证边界见[运行时验证报告](runtime-validation-report.md)，上一批验证计划与进度见[下一轮验证计划](next-validation-plan.md)及[进度记录](next-validation-progress.md)。云端 Workspace 增量同步的规划、文件变更矩阵、真实 Chrome/LLM、OS backend 重启与协议并发证据见[云端 Workspace 同步 PoC 规划](cloud-backed-workspace-sync-plan.md)及[实施进度](cloud-backed-workspace-sync-progress.md)；其自动化入口为 `tests/workspace-sync.e2e.mjs` 和 `tests/workspace-durability.test.mjs`。本批次 durable Workspace 的规划和进度见[规划](durable-workspace-plan.md)及[进度](durable-workspace-progress.md)。最新 P0 验证的计划、实际实现和限制见[下一批 P0 计划](next-high-value-validation-plan.md)及[实施进度](next-high-value-validation-progress.md)；随后离线 retry、CAS conflict 和过期 writer lease 的真实 Chrome 验证见[进阶恢复计划](advanced-recovery-validation-plan.md)及[进度记录](advanced-recovery-validation-progress.md)。再后的 OPFS quota 错误恢复、backend 重启租约 fencing 与同源身份存储隔离见[存储隔离计划](storage-isolation-and-restart-validation-plan.md)及[实测进度](storage-isolation-and-restart-validation-progress.md)。文件工具 durable 确认与易失状态隔离见[持久化确认计划](durable-tool-ack-validation-plan.md)、[持久化确认进度](durable-tool-ack-validation-progress.md)、[易失状态隔离计划](volatile-workspace-isolation-plan.md)和[隔离验证进度](volatile-workspace-isolation-progress.md)：本地保存失败会阻止 Agent 后续读写与搜索未确认的 Worker 内存文件，刷新后可在同 Session 显式重试。可写 chunk-backed 编辑原型、64 MiB OPFS 资源证据和当前 DSH `edit` materialize 对照见[验证计划](chunk-backed-edit-validation-plan.md)及[实施进度](chunk-backed-edit-validation-progress.md)。v2 的启动入口是 `run-v2.mjs`；旧 `run.mjs` 只属于历史协议实验。

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

本批次实现只把 `MemoryVfs` 的文件变更异步写入 durable store，没有把 OPFS 伪装成完整 Node 文件系统，也没有改变 Session 与 Workspace 的非原子关系。规划、实际进度、失败记录和经验教训见 [durable-workspace-plan.md](durable-workspace-plan.md) 与 [durable-workspace-progress.md](durable-workspace-progress.md)；目录外 opt-in 接线见 [change-ledger.md](change-ledger.md)。事实核查进一步说明：VFS、结构化 command provider、WASI adapter 和 Shell/VM runtime 是不同层，当前 PoC 只验证前两层。

## 完整性与生命周期验证

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

`large-file-scale.e2e.mjs` 默认生成 16 MiB 文件，可用 `DSH_POC_LARGE_FILE_BYTES=67108864` 运行 64 MiB 样本。分块只限制网络 body 和传输临时缓冲；`MemoryVfs` 仍持有完整 bytes，客户端下载也会组装完整文件，PoC backend 仍使用本地 `dataDir`，因此这些结果不构成块级 delta、任意大小文件能力、生产对象存储或内存 SLA。

## 可写 chunk-backed 编辑验证

[可写分块编辑验证计划](chunk-backed-edit-validation-plan.md)和[实施进度](chunk-backed-edit-validation-progress.md)验证了当前大文件路径的关键缺口：只读 OPFS range backing 已经可以降低冷 hydrate 后的 VFS 驻留，但当前 DSH `edit` 仍会完整 materialize 文件。PoC-local `ChunkBackedFile` 使用固定大小 buffer、跨 chunk UTF-8 定位和 copy-on-write 临时文件；真实 Chrome Worker/OPFS 对 64 MiB 文件完成替换，1 MiB chunk 下最大工作 buffer 为 `1,048,620` bytes，六个写入/校验/发布故障点均保持源文件 hash 不变。

这只是存储层原型，不是正式 DSH 文件工具能力。16 MiB 真实 DSH `read → grep → edit → read` 对照仍观察到 `residentBytes` 从 `34,493,823` 增至 `51,276,228`；本批已把 external reference 接入 experimental `MemoryVfs` mutation sink、Workspace 本地缓存、分块上传、manifest CAS 和 Session 外的 compact receipt，但还没有接入标准 `edit` 工具、正式 Session event schema 或生产 Workspace API。不能把这条测试路径称为块级 delta、零拷贝或正式工具能力。

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

[验证计划](opfs-agent-file-tools-validation-plan.md)与[实施进度](opfs-agent-file-tools-validation-progress.md)记录 DSH `read`、`grep`、`edit` 对冷 hydrate OPFS 外置 12 MiB 文件的 Chrome Worker 验证。scripted LLM 固定工具选择，真实 DSH Host 执行工具；`read → grep → edit → read` 中，Browser-native `grep` fallback 返回唯一 marker，edit 只产生一次 Workspace commit/receipt，模型与 Session 不含整文件 bytes，刷新后同 Session 读到修改值。当前 checkout 新增的 fallback 不依赖不存在的 ripgrep 子进程；它不是完整 ripgrep 语法，也不是任意容量的搜索实现。`edit` 会完整 materialize 文件。该场景使用有界 4 KiB 行；另一次 70 KiB 单行 chunk-backed edit 已通过，但 10 MiB 单行 edit 曾使 Session 请求体超过 PoC backend 上限。

在 preview 构建后运行模型无关的大文件验收：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/path/to/playwright/index.js \
  node docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs
```

本批另以真实 Chrome 和真实 LLM 运行 `runtime-validation.e2e.mjs`，通过普通大小文件的 `read → write → read`、同 Session 刷新恢复与同源凭据隔离。真实模型结果不覆盖 12 MiB scripted 场景，也不证明模型会主动选择本批 Browser-native `grep`/`glob` fallback。结果、实际命令及限制见[进度记录](opfs-agent-file-tools-validation-progress.md)。

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

## 能力预检与默认插件兼容性

[能力预检计划](browser-capability-preflight-plan.md)和[实施进度](browser-capability-preflight-progress.md)记录本批对 Browser-Native profile 的系统性验证：PoC capability manifest 现在集中描述 Worker VFS、结构化文件工具、受限 Shell、同源 Session/LLM backend、问答、todo、工作目录，以及主机子进程、`fs.watch`、原生 addon 和后台进程等明确不支持的能力。Worker 在创建 Workspace 和 Worker Host 前执行 fail-closed 预检；缺少 capability 时，诊断包含具体插件和能力，不留下半启动 Host。

真实 Chrome 默认 profile E2E 验证了受限 Shell 的 `printf | tr`、文件重定向、重定向文件读取和不支持命令的失败结果，并核对 DSH tool/result、Session checkpoint、无跨源请求和无页面异常。真实 `gpt-5.6-sol` 回归验证的是独立 browser validation roster 的普通文件多轮和刷新恢复，不应外推为模型已经选择默认 profile 的每个工具。该 manifest 仍是 docs-owned 静态清单，不是任意 Cordis profile 的动态插件扫描，也不是正式 package capability service。

## 故障边界与 S3 blob 验证

[故障边界计划](mock-and-crash-boundary-validation-plan.md)与[实测进度](mock-and-crash-boundary-validation-progress.md)记录 OPFS/IndexedDB 单侧丢失、Chrome `SIGKILL`、共享 `dataDir` 的双 backend、超大工具参数和 MinIO S3-compatible blob store。Chrome 155 实测表明：本地元数据缺失时孤儿 OPFS bytes 会 fail closed 并可按 hash 导出；Chrome 强杀后匿名身份 cookie 未自动恢复；两个 backend 都接受同一 seq/revision 写入，冷启动只留下其中一个结果。

本轮还修复了工具参数过大导致 Session append 反复超过 8 MiB backend body 上限的问题：Browser LLM adapter 将一次响应累计 tool arguments 限制为 1 MiB，超限时中止流，避免写入或执行不完整调用。真实 Chrome/scripted LLM E2E 接受 768 KiB 文件写入，拒绝 6/9 MiB 参数并确认同 Session 后续 turn 可继续。该 1 MiB 限制是 PoC 的保守硬上限，不是 DSH Session 的正式容量承诺。

PoC backend 可在测试启动时注入 S3 blob adapter；默认 `run-v2.mjs` 仍使用本地文件 blob store。真实 Chrome Worker + MinIO 验证了 2,097,189-byte staging 文件流式上传、Range 下载、503 outage、刷新后补传先前丢失的已上传对象和 backend 重启读回。adapter 流式校验 SHA-256；关闭 AWS SDK 的可选 request checksum 后兼容所测 MinIO 版本。Session、manifest、identity、writer lease 与 operation ledger 仍驻留单机 JSON `dataDir`；结果不证明真实 AWS/GCS/Azure、生产权限模型或多实例安全。

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

最新[运行时完整性验证计划](next-runtime-integrity-validation-plan.md)与[进度记录](next-runtime-integrity-validation-progress.md)补齐活动 Worker 的 Workspace lease heartbeat、Agent `write` 的未知 commit/backend 重启恢复、HITL 等待中的刷新中断，以及 IndexedDB 前向版本下的本地恢复导出。真实 Chrome/scripted E2E 证明活动页面在一次 renew 503 后继续续租并完成同一 Agent turn；Workspace manifest 503 导致初始化失败时 Worker 停止续租，服务端租约到期后可被接管；已提交但响应丢失的文件只增加一个 Workspace revision；刷新中的 `ask_user_question` 被结算为 `TOOL_OUTCOME_UNKNOWN` 和 interrupted turn，不保留可回答的旧问题卡或自动续跑，之后用户可在同一 Session 显式开启新 turn；v2 IndexedDB 不被 v1 客户端降级，已识别的 metadata 与 OPFS bytes 可导出。刷新不会恢复原问答 Promise，新 turn 不是旧审批答案，未知 object store 的记录不会进入恢复包；本批不证明真实 LLM、多实例 backend、自然 eviction、OS crash 或后台 Agent。

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

本批没有证明 Session 分页、永久 append 故障后的用户界面、自然 eviction、OS/磁盘崩溃、多实例 backend、生产对象存储、Safari/WebKit 或真实 LLM 生成大型 tool args。`RemoteSessionHandle` 的 live retry 达到上限后保留 pending events 并报告错误；这不是离线 outbox，也不是跨存储事务。标准 `write`/`edit` 仍可能完整驻留文件，external/chunk 路径是 PoC-local 原型。

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

## Session 适配、能力发布与执行交接验证

[Session 适配与执行交接验证计划](next-session-adapter-and-handoff-validation-plan.md)及[进度记录](next-session-adapter-and-handoff-validation-progress.md)把 dsh-TUI 的四项可迁移纪律落到 Browser-Native PoC：history 完成后才接收 live event、取消/销毁保留 `unknown`、能力必须经过 probe 才发布，以及 Browser Worker 到云端执行者必须显式 handoff 并提升 fencing。它们不把现有 Workspace writer lease 测试改名为 Agent handoff。

当前实现包含四个 PoC-local 适配器：Session cursor 的连续 seq/去重/identity 检查、execution lifecycle 的 `confirmed`/`unknown`/`failed` settlement、capability publication 的 `live + probe + permission` roster，以及 Session backend 的 owner epoch handoff。默认 Browser profile 的 LLM wire 请求现在只序列化 9 个已发布工具；真实 Chrome handoff E2E 在 DSH Worker 完成一次 `write` 后交接 Session，旧 owner append 返回 409，新 owner 可以继续追加，backend 重启后 epoch 继续递增。

复跑本批验证：

```sh
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-session-adapter.spec.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-execution-lifecycle.spec.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-handoff.spec.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-capabilities.spec.ts
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/default-profile-capabilities.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/session-owner-handoff.e2e.mjs
```

这批证据仍不是云端 Durable Worker、生产多实例 backend、跨存储原子事务或页面关闭后的后台 Agent 证明。`session-owner-handoff.e2e.mjs` 的“云端”是 PoC backend 中的新 owner 协议角色；它没有启动真正的云执行进程，也没有复制 Worker 内存状态。Safari/WebKit、自然 eviction、OS crash 和真实 LLM handoff 未执行。

## 会话目录、观察者与交接幂等验证

[本批计划](next-catalog-observer-bridge-validation-plan.md)及[进度记录](next-catalog-observer-bridge-validation-progress.md)把 `dsh-TUI` 的 Session projection、单写者挂载和有界 dispatch 经验转成四个 Browser-Native 验证面：handoff 响应丢失后的幂等重试与严格 checkpoint、Session catalog 有界分页、只读观察者与单写 owner、跨边界 Session 载荷预算。它们不修改正式 Agent Loop 或 Session format。

当前 checkout 已实现 backend 合同层：同一 `handoffId` 的相同 checkpoint 重试不会再次提升 owner epoch，flush 在发布前失败会恢复旧 owner；Session list 按稳定 id 游标分页，read 返回 `nextSeq`、`hasMore`、`durableThroughSeq` 和 `ownerEpoch`，append/read 超过预算时显式拒绝。真实 Chrome 双页面验收还会确认观察者能看到同一 Session 的追加事件但没有写权；这些证据不等于多实例 HA、跨设备同步或生产查询服务。

复跑本批模型无关验收：

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-observers.e2e.mjs
```

分页目录是查询投影，不是新的事实源；只读观察者不持有 owner token；载荷拒绝也不等于已经实现 blob 引用或大工具结果分页。真实 LLM、Safari/WebKit、自然 eviction、OS crash、跨主机 backend 和生产授权不在本批通过范围内。

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

Session 与 Workspace metadata 的本地 JSON store 不是 PostgreSQL、HA 或生产多租户实现；它不提供跨进程 owner lease、跨重启 mutation replay、跨主机复制、备份保证或灾备 RPO/RTO。MinIO E2E 只验证 S3-compatible blob 操作，不把 metadata、Session 或 lease 迁移到对象存储。当前 browser-native E2E 只证明一次 Worker、单个同源 backend、正式 Session provider、真实 `ctx.agentLoop` 和 scripted/real LLM route 的闭环。

本目录没有加入根级 npm script、package manifest、Web profile、Desktop profile 或正式 DSH package。旧版命令和测试不证明 v2 的 DSH Host、正式 Session provider 或真实 `ctx.agentLoop`。若后续证明必须修改目录外代码，先按 [change-ledger.md](change-ledger.md) 登记原因、扩展点、测试和 upstream 重放步骤。

## Dev Note

这是可运行的 PoC，不是正式产品入口。v2 的实现事实、已运行命令和限制必须同步写入 [browser-native-dsh-progress-v2.md](browser-native-dsh-progress-v2.md)；[progress.md](progress.md) 只保留旧版独立 loop 的历史记录。不要把目录内历史 loop adapter 的通过结果写成 DSH 核心 Agent Loop 已完成浏览器化。
