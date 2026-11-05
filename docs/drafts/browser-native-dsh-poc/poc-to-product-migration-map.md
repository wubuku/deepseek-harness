---
description: "逐模块判定 PoC 代码在产品中可直接复用、需重构还是应丢弃，并给出 PoC 与产品架构的落差与立项建议。"
---

# PoC 到产品迁移映射

## 结论摘要

本目录 73 个 `*.mjs`/`*.ts` 模块按产品用途判定为：可直接复用 7 个（9.6%）、需重构 39 个（53.4%）、应丢弃 27 个（37.0%）。可直接复用集中在浏览器侧纯工具（SHA-256、内容分块、下载校验、审批投影、能力标识与 `Symbol.dispose` 垫片）；需重构集中在服务端 Session 权威、共享与租约、工作区、附件、出口代理、观测与导出；应丢弃集中在 Worker 执行宿主、OPFS 工作区、探针、旧 v1 后端与 PoC 编排脚本。

判定不是按代码质量评分，而是按产品落点：产品已有对应 seam 且 PoC 的职责可以被该 seam 完整吸收的记为需重构；产品没有等价位置、或该职责只服务于“在浏览器里跑完整 harness”的实验路线的记为应丢弃；纯函数且不依赖 PoC 私有类型的记为可直接复用。

## 判定口径

- **可直接复用**：模块只依赖标准库或产品既有包，职责与产品某个包单一对应，迁移主要是移动文件、补类型与导出的机械工作。
- **需重构**：PoC 已验证的行为有价值，但模块绑定了 PoC 私有协议、内存态、文件格式或 Worker 运行时，必须在产品 seam（服务定义/提供者/消费者）上重写，不能整文件搬运。
- **应丢弃**：模块只服务于实验 Worker 执行路线、一次性探针、旧版后端或 PoC 自身的编排/构建；产品路径不保留该职责，相关证据留在文档与测试断言中。

本表按文件族列出，**每一行的判定适用于该行列出的每个文件**；73 个模块各出现且只出现一次，没有未判定的文件。

## 逐模块判定

| 模块 | 当前职责 | 判定 | 产品落点与理由 |
| --- | --- | --- | --- |
| `browser-native-sha256.ts`、`browser-native-content-chunker.ts`、`browser-native-verified-download.ts`、`browser-native-download-journal.ts` | 浏览器侧哈希、Gear 分块、顺序下载校验与下载日志 | 可直接复用 | 只依赖浏览器 API 与同目录工具，可移入 `packages/client/file-upload` 或 `packages/util`；上传/下载的完整性校验与 `packages/attachment` 的附件模型不冲突。 |
| `browser-native-capabilities.ts`、`symbol-dispose.ts` | 浏览器能力标识与 `Symbol.dispose` 垫片 | 可直接复用 | 能力探测对移动端降级仍有价值；垫片可移入 `packages/util`，不携带 PoC 私有状态。 |
| `browser-native-approval-projection.ts` | 把 Session 事件投影为审批结果视图 | 可直接复用 | 只读投影，输入是产品 `SessionEvent` 与审批结果类型，可直接进入 `packages/client/ui-approval` 的展示层。 |
| `backend-v2.mjs` | 单体 HTTP 后端：Session 权威、租约、共享、附件、观测、导出、保留期、LLM/出口代理 | 需重构 | 语义（owner/editor 租约、`expectedNextSeq`、保留期、导出、拒绝审计）必须拆到 `packages/core/session`、`packages/api/session-controller`、`packages/session/session-persistence-jsonl`、`packages/storage`、`packages/telemetry` 等 seam；单文件状态机与路由不可搬运。 |
| `admission-v2.mjs`、`workspace-v2.mjs`、`durable-host-v2.mjs` | 挂载名额/配额准入、工作区实体与成员、durable host 进程与重放 | 需重构 | 分别落到 `packages/guard`、`packages/workspace` + `packages/storage`、`packages/jobs` + `packages/session/session-persistence`；PoC 的文件锁、配额默认值与进程内 authority 表不是产品契约。 |
| `egress-proxy-v2.mjs`、`s3-blob-store.mjs`、`chunk-object-store.mjs` | 出口代理与 allowlist、S3 对象存储、分块对象引用 | 需重构 | 出口策略应落在 `packages/web` 与 `packages/credentials` 的 provider 之后；对象存储应实现 `packages/storage` 的后端接口并复用 `packages/attachment` 与 `packages/spill` 的生命周期。 |
| `cross-store-checkpoint.mjs`、`cross-store-operation-ledger.mjs`、`external-business-service.mjs` | 跨存储检查点、操作幂等账本与外部业务示例服务 | 需重构 | 幂等与检查点的需求真实存在，但产品位置是 `packages/session/session-checkpoint-policy`、存储事务与工作流，而不是 PoC 自建的 JSON 账本与示例 HTTP 服务。 |
| `protocol.mjs`、`session-transport-limits.mjs`、`workspace-session-reconciliation.mjs` | 自定义 HTTP envelope、请求体上限、Session 与工作区对账 | 需重构 | envelope 与上限应由 `packages/api/remote-access`、`packages/api/session-controller` 与 `packages/client/connection` 接管；对账逻辑落到 `packages/workspace` 的实体关系，PoC 协议不得成为产品 wire format。 |
| `principal-export.mjs`、`usage-report.mjs` | 按 principal 导出、成本汇总与报告 | 需重构 | 导出落到 `packages/session-query` 的查询/导出能力；成本落到 `packages/llm` 的 token 计量与 `packages/telemetry`，PoC 的价格表与 JSON 导出格式只能作为字段清单参考。 |
| `observability-journal.mjs`、`observability-v2.mjs`、`observability-alerts.mjs` | 哈希链 JSONL 审计、指标注册与告警 | 需重构 | 诊断与遥测应走 `packages/telemetry/otel`、`packages/session/session-telemetry` 与 `packages/runtime-diagnostics`；哈希链与截断检测可作为诊断旁路保留，不作为计费或产品审计的唯一来源。 |
| `session-shares.mjs` | 只读/编辑器授权持久化 | 需重构 | 角色与租约模型需变成 `packages/api/session-controller` 的协作能力并持久化，share 文件不能成为第二套 Session 权威。 |
| `browser-native-session-adapter.ts`、`browser-native-session-projection.ts`、`browser-native-session-query.ts`、`browser-native-session-read.ts`、`browser-native-session-events.ts`、`browser-native-session-transport.ts`、`browser-native-session-mount.ts`、`browser-native-session-outbox.ts` | 浏览器侧 Session 投影、读取、事件归一、传输、挂载与待持久化 outbox | 需重构 | 输入输出边界仍是 PoC HTTP 与 Worker 内存投影；产品应由 `packages/client/connection` 客户端、`packages/session/session-projection` 与服务端权威接管。outbox 的离线重放语义可作为客户端队列需求输入，但 IndexedDB schema 与 requestId 约定需重定。 |
| `browser-native-workspace.ts`、`browser-native-attachments.ts`、`browser-native-content-upload.ts` | 浏览器工作区读写、附件保存与分块上传 | 需重构 | 工作区与附件应对接 `packages/api/workspace-controller`、`packages/api/workspace-files`、`packages/attachment` 与 `packages/client/file-upload`；分块器可复用，但上传协议、配额与 VFS 类型要替换。 |
| `browser-native-connection.ts`、`browser-native-control.ts`、`browser-native-execution-lifecycle.ts`、`browser-native-execution-handoff.ts`、`browser-native-tool-policy.ts`、`browser-native-trust-label.ts`、`browser-native-providers.ts`、`browser-native-token-budget.ts`、`browser-native-capability-publication.ts` | 在线门控、页面/Worker 控制帧、执行取消结算、所有权检查点、工具策略、来源标签、provider 注册、租户预算与能力发布 | 需重构 | 这些行为在产品中分别属于 `packages/guard`、`packages/preset`、`packages/context`、`packages/llm`、`packages/core/tools` 与 `packages/client/ui-approval`；PoC 的 Worker 控制帧、`budget/exceeded` 事件与工具名策略只能作为规格输入。 |
| `browser-native-worker.ts`、`browser-native-workspace-store.ts`、`browser-native-workspace-recovery.ts`、`browser-native-chunk-editor.ts`、`browser-native-observer-cache.ts`、`browser-native-file-tools.ts`、`browser-native-memory.ts` | Worker 入口、OPFS 工作区存储/恢复、分块编辑、只读缓存、浏览器文件工具与 Session 记忆 | 应丢弃 | 只存在于“完整 harness 在 Worker 内执行”的路线；产品 Host 负责工具执行，工作区由 `packages/fs` 与服务端存储提供，iOS 也没有 OPFS。保留价值仅在上游 `packages/experimental/webworker-runtime` 的 preview 用途。 |
| `browser-native-builtin-member-trace.ts`、`browser-native-cpu-contention.ts`、`browser-native-cpu-contention-probe.ts`、`browser-native-isolation-probe.ts`、`browser-native-multi-agent-probe.ts`、`browser-native-permission-probe.ts`、`browser-native-runtime-probes.ts`、`browser-native-session-continuity-probe.ts`、`browser-native-session-orchestration-probe.ts` | CPU 争用、隔离、权限、多 Agent、运行时与 Session 连续性探针 | 应丢弃 | 一次性证据采集代码，结论已进入本目录文档与回归断言；产品测试基础设施在 `packages/test-support`，不需要这些探针入口。 |
| `backend.mjs`、`session-event-hub.mjs`、`browser-native-handoff.ts`、`browser-native-regex-worker.ts`、`build-profile-overlay.mjs`、`generate-worker-dependency-report.mjs`、`run.mjs`、`run-v2.mjs`、`run-runtime-validation.mjs`、`runtime-validation.mjs`、`vitest.config.ts` | 旧 v1 后端、进程内事件 hub、页面/Worker 执行移交、正则 Worker、profile overlay 构建、依赖报告与 PoC 启动/配置脚本 | 应丢弃 | v1 已被 v2 取代；进程内 hub 与产品 Remote 事件流、订阅重放重复，没有独立复用价值。其余都是 PoC 自身编排；产品启动只允许 `dsh` profile，profile overlay 与依赖报告由 `packages/bundle` 和仓库脚本承担。正则 ReDoS 防护若立项应基于 `node:worker_threads` 重写，而不是搬浏览器 Worker。 |

## PoC 与产品的架构落差

### 组合模型

PoC 以 `backend-v2.mjs` 单文件持有 Session、工作区、附件、共享、观测、导出与代理状态，路由内直接调用函数；产品以 Cordis 插件组合，要求每个贡献通过 `ctx.effect()`/`ctx.on()` 注册，能力按 Service Definition / Provider / Consumer 三角色拆分。差距不是“代码组织”，而是 PoC 没有可替换的 provider 边界：迁移时必须先定义 Session 权威、存储、出口、遥测等服务，再把行为写成 provider，而不是把 300KB 单文件拆成工具函数。

### Session 权威与格式

产品的 Session 权威属于 `packages/core/session`，持久化走 `packages/session/session-persistence-jsonl`，格式由 `packages/session/session-format` 版本化并带迁移链与投影缓存；PoC 的 `FormalSessionStore` 是进程内 Map + 自定义 `session.json`，owner/editor 租约、`expectedNextSeq` 与保留期删除都在同一进程内完成。迁移不能复用 PoC 的日志文件格式：要么把 PoC 的租约语义实现为产品 Session 控制器的写协调，要么把 PoC 降级为产品的客户端，由产品 Session API 提供历史、投影和事件。PoC 的共享文件 `session-shares.json` 与协作审计 `session-collaboration.jsonl` 也应成为产品控制器的持久化附件，而不是与 Session 日志并列的第二套权威。

### 进程与执行位置

产品由 Host 执行工具与 shell，具备 `packages/shell`、`packages/subprocess`、`packages/sandbox`、`packages/terminal`、`packages/ptc-runtime` 与 `packages/fs`；PoC 把完整 harness 放进 `packages/experimental/webworker-runtime` 的 Worker，用 OPFS、自建出口代理和 LLM 代理模拟宿主能力。两条路线在安全模型上不等价：浏览器 Worker 没有 OS 级 sandbox，出口 allowlist 与凭据隔离由 PoC 自建；产品 Host 有进程沙箱、凭据 broker 与审批 guard。若产品要保留浏览器内执行，必须把 `webworker-runtime` 从 experimental 提升并补齐沙箱/凭据边界；若采用服务端 Host 执行、浏览器只做 UI，则本表 R7/R8/R9 的 Worker 代码与探针都应丢弃，移动端也不会依赖 OPFS。

### 存储、附件与事务

产品有 `packages/storage/storage-json|storage-sqlite`（单调 `SCHEMA_VERSION`）、`packages/attachment/attachment-local` 与 `packages/spill`；PoC 用 `session.json`、`chunk-object-store`、`s3-blob-store` 与跨存储账本自行保证幂等。迁移时附件生命周期、分块上传、保留期清理和导出必须走产品存储接口；PoC 的跨存储检查点可作为事务需求，但不能作为产品事务实现，因为产品存储后端可替换，且 SQLite 迁移规则不同。

### 安全、身份与审批

PoC 的 principal 是同源匿名 cookie，授权与拒绝审计由 backend 自管；产品由 `packages/identity`、`packages/credentials`、`packages/guard` 与各工具自己的审批路径负责。PoC 的 editor lease 与工具策略有可迁移语义，但身份必须换成产品 principal/凭据模型；PoC 的“工具名 allow/ask/deny”策略应落到产品 `tools/pre-execute` 与 guard 扩展点，而不是新增第二套策略引擎。

### 观测、成本与审计

产品遥测走 `packages/telemetry/otel`、`packages/session/session-telemetry` 与 `packages/runtime-diagnostics`，成本由 token 计量提供；PoC 的哈希链 JSONL、告警与价格表是自建旁路。迁移时应把“拒绝/协作/追加”审计映射成产品遥测事件，把成本和导出映射到 Session 查询与 token 计量；哈希链只能作为诊断完整性证据保留，不能成为产品计费或合规审计的唯一来源。

### 客户端与移动端

产品客户端由 `packages/client/connection`、`packages/client/file-upload`、`packages/client/ui-session`、`ui-chat`、`ui-workspace` 等包组成，消费 Remote API；PoC 的浏览器模块消费自定义 `/api/browser-native/*` 协议并假设 Worker 与 OPFS 可用。iOS 没有 OPFS，因此“浏览器内完整 harness”不能作为移动端产品路径；可迁移的是 UI 投影、上传校验与审批展示，执行与会话权威应留在 Host。

## 立项输入

### 推荐范围

建议把这次 PoC 立项为“durable 服务端 host 主执行 + 浏览器 Worker 纯浏览器降级/离线”的会话协作产品，而不是“浏览器内运行完整 harness”。PoC 的价值是已验证的语义与回归证据：Session 追加 fencing、owner/editor 租约、`expectedNextSeq` 并发裁定、离线重放、保留期与按 principal 导出、拒绝与协作审计；同一 10 任务真实模型基准两侧均 10/10，durable 23,318 tokens / 12.8 秒，Worker 91,734 tokens / 22.4 秒，且 durable 工具面已与 Worker 对齐。产品化应把这些语义实现到既有 seam，浏览器保留 UI、上传校验与审批投影，并保留 Worker 作为断网或无法连接服务端时的降级执行路径。

### 分期

- **P0 规格固化**：把本表 R2/R3/R4 的行为写成产品 Session 控制器、存储、附件、遥测的验收用例；PoC 的 HTTP 测试保留为对照证据，不进入产品测试套件。
- **P1 直接复用**：先迁移 7 个纯工具模块（SHA-256、分块、下载校验、下载日志、能力标识、`Symbol.dispose`、审批投影），它们的依赖最少，可独立验证。
- **P2 服务端重构**：按 seam 逐个实现 Session 权威与共享、工作区与附件、出口与凭据、观测与导出；每落地一个 seam，用 PoC 的对应合同测试做行为对照。
- **P3 收敛执行面**：durable host 成为默认执行路径后，删除 R8 的探针与一次性编排代码；R7 的 Worker 执行入口保留为降级/离线路径，复用产品 `packages/experimental/webworker-runtime`，但不携带 PoC 的探针、旧 v1 后端与自建编排。

### 风险

- 把 `backend-v2.mjs` 直接改造成产品包会复制第二套 Session 权威，后续无法与产品 JSONL/SQLite 迁移链对齐。
- 把 `session-shares.json`/`session-collaboration.jsonl` 当成产品持久层会绕过产品存储事务与保留期。
- 保留 Worker 降级路径就必须同时保留 OPFS、出口代理和浏览器 LLM 代理，等于在产品内维持两套安全模型；因此它只应是 Chromium 桌面上的降级/离线选项，不能升格为默认执行面，也不覆盖 iOS。
- 只迁移 UI 投影而不迁移上传校验，会丢失 PoC 已验证的“下载后哈希校验再入持久存储”保证。

## 证据与复跑

判定所依据的行为证据来自本目录已提交的合同测试、E2E 与全量门禁：`poc-gate` 全绿基线、`session-editor-collaboration.test.mjs`、`session-sharing.e2e.mjs`、`principal-data.e2e.mjs`、`offline-reconnect.e2e.mjs`、`retention`/`data-erasure` 用例与 `chaos-regression-suite.md`。产品侧落点依据 `docs/architecture.md`、`packages/README.md` 以及 `packages/session`、`packages/api`、`packages/host`、`packages/client`、`packages/storage`、`packages/attachment`、`packages/llm`、`packages/telemetry`、`packages/experimental/webworker-runtime` 的 README。

复跑全部行为证据：

```sh
node docs/drafts/browser-native-dsh-poc/tests/poc-gate.mjs
```

只复跑与迁移判定直接相关的合同与 E2E：

```sh
node docs/drafts/browser-native-dsh-poc/tests/poc-gate.mjs --group contract --filter session-editor-collaboration
node docs/drafts/browser-native-dsh-poc/tests/poc-gate.mjs --group e2e --filter session-sharing
```

边界：本映射是架构与代码归属判定，不是工作量或排期承诺；产品 seam 的最终命名以立项后的 `packages/` 设计为准。判定基于 2026-11-04 的 PoC 与产品 checkout，若 `webworker-runtime` 的实验状态或产品 Session 格式改变，R7/R8 与 R2/R3 的落点需要重评。
