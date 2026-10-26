---
description: "Browser-native DSH PoC 的目录外改动账本和重要目录内兼容性变更记录，保留必要性、验证和 upstream 重放或删除条件。"
---

# Browser-native DSH PoC 变更账本

## Summary

本文件是 `docs/drafts/browser-native-dsh-poc/` 的变更登记 owner。目录外接线必须登记；会影响协议兼容或恢复行为的目录内修改也在本文登记，便于后续复查。

任何修改 `docs/drafts` 之外文件的实施者，都必须在提交该修改前增加一条记录，写明当前 DSH 版本、文件、必要性、被检查过的扩展点、测试、上游同步步骤和删除条件。没有登记的目录外修改视为 PoC 未完成，而不是“实现细节”。

当前 PoC 的 backend、Worker、profile overlay、launcher 和测试均位于本目录；`apps/web/src/preview.ts` 与 `apps/web/src/browser-native-page-control.ts` 提供 preview 接线及页面生命周期 bridge，另有 `packages/core/tools` 跨浏览器 schema 兼容修复和中文 scratch 文档登记。上述目录外改动均有记录；当前没有 DSH Agent Loop、Session format、普通 Web profile、Desktop profile 或 Headless profile 的未登记修改。

### BN-P2-033：Session IndexedDB outbox 与 Worker 终止恢复

```text
changeId: BN-P2-033
upstreamBaseline: research checkout at DSH v0.2.1-rc.2; 2026-10-26
file: docs/drafts/browser-native-dsh-poc/browser-native-session-outbox.ts; docs/drafts/browser-native-dsh-poc/browser-native-providers.ts; docs/drafts/browser-native-dsh-poc/browser-native-worker.ts; docs/drafts/browser-native-dsh-poc/tests/session-outbox-recovery.e2e.mjs; docs/drafts/browser-native-dsh-poc/session-outbox-recovery-validation-plan.md; docs/drafts/browser-native-dsh-poc/session-outbox-recovery-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/browser-native-dsh-poc/operational-compatibility-matrix.md; docs/drafts/browser-native-dsh-poc/change-ledger.md; docs/drafts/README.md
reason: Remote Session `append` receipt and durable watermark are separate states, while DSH `session/event` is synchronous post-commit notification. Before this change, pending Browser Session events lived only in Worker memory and could not be reconciled after Worker termination.
existingExtensionPointsChecked: reuse DSH `session/event` and awaited `session/flush` checkpoints, Remote Session seq/owner lease, Workspace operation receipts, the Worker Host's VFS injection and boot preparation, and the existing Chrome Worker test port. No formal Agent Loop, Session format, standard Web profile, root dependency or package API changed.
whyDraftOnlyWasInsufficient: provider unit tests cannot demonstrate IndexedDB transaction durability, Worker termination timing or the real page-to-Worker resume path. The Chrome E2E must distinguish local journal, backend append visibility, backend durable watermark and Workspace operation receipt, and must verify that recovery does not replay the original prompt or side effect.
behaviorChange: a bounded PoC-local IndexedDB database journals contiguous Session events before remote append. It tracks `(sessionId, seq)`, owner epoch and random worker ID; exact same-event retries are idempotent and different payloads at an existing seq fail closed. Acknowledged rows are deleted only through backend `durableThroughSeq`. A new writer claims a local fence, checks overlap against the backend log, uploads only a missing contiguous suffix, flushes and then acknowledges. Per-Session/profile event and byte budgets, a 256-session fence cap, v1→v2 metadata migration, stale-writer checks and IDB failure propagation prevent unchecked growth or false durable success. Recovery does not restore JavaScript promises or rerun prompts, tools, model streams or HITL. The Session/Workspace receipt recovery only resumes the existing operation receipt.
directoryOutChangeReason: none; code, tests and documentation stay under docs/drafts.
consumersUpdated: Browser Session persistence provider, Worker test control, Chrome failure E2E, PoC README, compatibility matrix, draft index and this ledger.
tests: Session transport Vitest 2/2; backend contract tests 43/43; Chrome `session-outbox-recovery.e2e.mjs`, `agent-workspace-receipt-recovery.e2e.mjs` and `session-transport-resilience.e2e.mjs` passed. Worker runtime typecheck and Web preview/VFS image build passed with existing unsupported native-platform, tsdown deprecation and large chunk warnings. Real Chrome `runtime-validation.e2e.mjs` with `DSH_POC_DURABLE_WORKSPACE=1` completed 3 turns, `read → write → read`, refresh-time Session recall and Workspace file read; 8/8 model requests and 2/2 Workspace commits returned HTTP 200, with Session `durableThroughSeq=58`, no page errors or non-local requests. The non-durable Workspace comparison correctly found the file missing after refresh. Natural eviction, OS/disk crash, Safari/WebKit, production object storage and multi-instance backend are not validated.
syncReplaySteps: after upstream sync, check whether the formal Session persistence service offers an awaited durable local append or recoverable journal hook, writer fencing, an authoritative durable watermark and a way to reconcile unknown append outcomes. If equivalent support exists, move the Browser E2E to that service and remove duplicate PoC logic. Otherwise keep the adapter local to the PoC. Re-run Session transport Vitest, backend contract tests, outbox and Workspace receipt Chrome E2E, runtime typecheck, preview build, real Chrome LLM smoke with durable Workspace, and documentation gates. Do not interpret a Worker termination test as OS-crash or eviction evidence.
deleteCondition: the formal Session/Workspace runtime provides equivalent journal-before-side-effect and recoverable durability semantics, with the same unknown-outcome and Worker-termination cases covered against the formal interfaces; or the Browser-Native PoC is removed.
status: implemented-as-draft
```

### BN-P2-032：活动 HITL 的显式 Stop

```text
changeId: BN-P2-032
upstreamBaseline: research checkout at DSH v0.2.1-rc.2; 2026-10-26
file: packages/client/ui-user-questions/src/client/PlanReviewPanel.module.css; packages/client/ui-user-questions/src/client/PlanReviewPanel.tsx; packages/client/ui-user-questions/src/client/QuestionComposer.tsx; packages/client/ui-user-questions/src/client/contract/slots.ts; packages/client/ui-user-questions/src/client/index.ts; packages/client/ui-user-questions/src/client/locales.ts; packages/client/ui-user-questions/tests/plan-review-panel.client.spec.tsx; packages/client/ui-user-questions/tests/user-questions-composer.client.spec.tsx; packages/client/ui-user-questions/README.md; packages/client/ui-user-questions/README.zh.md; docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/timed-hitl-lifecycle.e2e.mjs; docs/drafts/browser-native-dsh-poc/active-hitl-stop-validation-plan.md; docs/drafts/browser-native-dsh-poc/active-hitl-stop-validation-progress.md; docs/drafts/browser-native-dsh-poc/timed-hitl-lifecycle-validation-progress.md; docs/drafts/browser-native-dsh-poc/operational-compatibility-matrix.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/browser-native-dsh-poc/change-ledger.md; docs/drafts/README.md
reason: 当 `ui-user-questions` 接管聊天输入时，用户只能提交答案或等待 HITL timeout；关闭卡片只是隐藏，Escape stop shortcut 会因 pending interaction 被忽略。PoC overlay 无法为官方 composer 增加一个真实调用当前 DSH Session cancel 的控件，因此需要在该 UI package 提供窄的 session-scoped callback 和可见 Stop。
existingExtensionPointsChecked: 复用 `conversation.composer` slot 的 Session scope inject、框架提供的 `useSession`/`useQuestionCard`，以及当前 Session scope 中的 `conversation.cancel()`；组件只接收 `cancelTurn()`，不接触 Cordis Context 或整个 Conversation service。未修改 Agent Loop、Session event format、默认 profile、其他聊天 UI 或 Stop shortcut 的 pending-interaction 规则。
whyDraftOnlyWasInsufficient: UI 单测只能证明按钮及 callback；确定性 Chrome Worker/Host E2E 才能验证取消由原 DSH turn 结算、活动问题不生成成功答案、后续 tool side effect 不发生且 Workspace revision 不变。真实 LLM 普通对话另行确认更新后的 Web UI/provider 组合仍可运行，但不证明模型会选择 HITL。
behaviorChange: 官方通用问答与 plan-review composer 仅在 Session 正运行且问题仍持有 live waterfall 时显示 Stop。点击后调用该 Session 的 `conversation.cancel()`；停止失败保留问题卡并显示本地化反馈。continued question 不提供 Stop，避免旧问题控制另一 turn；关闭问题卡仍只隐藏，Stop 不撤销已提交副作用。backend scripted fixture 增加 legacy Stop marker，使默认 schema 的 Chrome cancellation 路径可确定复现。
directoryOutChangeReason: `packages/client/ui-user-questions` 是正式 Web UI 的问题 composer owner；PoC 目录外无法通过 preview overlay 将取消动作安全接到当前 Session 的 `ConversationController`，也不应复制一份平行问题 UI。改动是该通用 composer 的局部用户能力，不改变 Agent Loop 或后台执行模式。
consumersUpdated: 通用问题与 plan-review composer、英文/中文 package README、两个 composer 测试、Browser-Native timed HITL backend fixture 与 Chrome E2E、验证计划/进度、兼容矩阵、PoC README、drafts 索引和本账本。
tests: composer/plan-review Vitest 63/63；`ui-user-questions` TypeScript 检查、backend contract tests 42/42、Web preview build 均通过。真实 Chrome Worker/DSH timed 与 legacy Stop E2E 均以 `aborted` 收束且无答案、迟答消息、write 或 Workspace revision 增量；timeout 后 continued question 负例不显示 Stop。真实 Chrome + 同源 backend + `gpt-5.6-sol` smoke 完成三轮、5 次模型 HTTP 200、跨轮记忆、单次 todo 写入和 41 个 Session events；无页面异常、凭据泄露或跨源请求。详细命令和观察值见 `active-hitl-stop-validation-progress.md`。Safari、多标签页答案/Stop 竞争、模型自主选择 HITL、多实例 backend、自然 eviction 与 OS crash 未验证。
syncReplaySteps: 上游同步后确认 `conversation.composer` 仍按 Session scope 注入，`ConversationController.cancel()` 仍取消当前 Session turn，且 `useSession(state => state.running)` 与 question-card 的 live waterfall/continued 状态仍有相同语义。若 UI Host 已提供正式的 Session-scoped stop callback，改用该 API 并删除重复读取；否则按相同窄 callback 重放 UI、locale、组件测试和双语 README。重建 `ui-user-questions` bundle 与 Web preview；运行两个 composer Vitest、package typecheck、timed/legacy/continued Chrome E2E、真实 LLM Chrome smoke 和文档门禁。不要把 scripted HITL 路径写成模型自主选择证据。
deleteCondition: 正式 UI framework 提供可取消当前 Session turn 的 composer action，且问题 composer 的真实 Chrome 测试迁移到该接口后通过；或 Browser-Native PoC 与此产品 Stop 控件均移除。
status: implemented-as-draft
```

### BN-P2-031：Session handoff 从 DSH event log 派生安全点

```text
changeId: BN-P2-031
upstreamBaseline: research checkout at DSH v0.2.1-rc.2; 2026-10-25
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/browser-native-providers.ts; docs/drafts/browser-native-dsh-poc/browser-native-session-read.ts; docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs; docs/drafts/browser-native-dsh-poc/tests/browser-native-session-read.spec.ts; docs/drafts/browser-native-dsh-poc/tests/session-owner-handoff.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/workspace-worker-handoff.e2e.mjs; docs/drafts/browser-native-dsh-poc/next-session-handoff-safe-point-plan.md; docs/drafts/browser-native-dsh-poc/next-session-handoff-safe-point-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/browser-native-dsh-poc/operational-compatibility-matrix.md; docs/drafts/browser-native-dsh-poc/change-ledger.md; docs/drafts/README.md
reason: handoff backend 只检查 checkpoint cursor 和客户端 pending ID；调用方可在 Session 已记录活动 turn、step 或 tool call 时伪报空列表并提升 owner epoch。
existingExtensionPointsChecked: 复用 FormalSessionStore 的 per-Session exclusive queue、Session event log、owner epoch/token、handoff receipt、真实 Chrome Dedicated Worker 和已有 handoff test port；未修改正式 Agent Loop、Session format、默认 profile、Workspace lease 或根依赖。
whyDraftOnlyWasInsufficient: DSH `turn/start`、`step/start`、assistant tool-call、`tool/call` 和 `tool/result` 的配对顺序必须由真实 Session 事实判定；Node 单测不能证明真实 Worker 活动期间 handoff 被拒且原 turn 不重复。Chrome 测试还确认 Agent Loop 的 `turn/start` 先于对应 `user/message`，测试不能假设相反顺序。
behaviorChange: 新 handoff 在同一 per-Session queue 内扫描已追加 event log，打开的 turn/step 或未结算 tool call 返回 `HANDOFF_BUSY`；turn/step 边界、assistant tool request 与 tool/result 配对损坏返回 `HANDOFF_STATE_INVALID`。tool-call ID 按 `(turn, step, callId)` 配对，允许不同 turn/step 重用 ID；已结算历史 tool result 的 compaction replacement 必须引用其当前结果 seq 和完整 replacement range。拒绝发生在 owner epoch/token、receipt 和 flush 变更之前。重复 receipt replay 不重复运行安全点迁移。合同测试覆盖伪空 pending、已结算 error tool result、malformed events、重复 call ID、历史 compaction replacement 和 append/handoff 两种串行锁顺序。远端 Session reader 将剩余日志拆成最多 2048 条一页并校验跨页 seq/ownership state；单测覆盖多页和短页，Chrome Worker handoff E2E 验证恢复同一 Session 后可继续执行。真实 Chrome E2E 在 delayed scripted LLM 的活动 turn 请求 handoff，确认拒绝后原 turn 完成一次、模型请求只发出一次，再执行既有 response-drop/reclaim 流程。
directoryOutChangeReason: 无；所有实现、测试和文档都在 docs/drafts。
consumersUpdated: PoC Session backend 与远端 Session reader、backend contract tests、Session page aggregation tests、真实 Chrome Session/Workspace handoff E2E、handoff 验证计划/进度、兼容矩阵、PoC README、docs/drafts 导读和本账本。
tests: `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` 42/42；handoff coordinator 与 Session pagination Vitest 7/7；真实 Chrome `session-owner-handoff.e2e.mjs` 通过，活动 turn handoff 返回 `HANDOFF_BUSY`、模型请求计数 1、turn 正常完成，之后 response-loss/reclaim 提升 owner epoch 1→3 且旧 append 返回 409；`workspace-worker-handoff.e2e.mjs` 在重建 preview 后通过，第二 Worker 恢复同一 Session、Workspace revision 到 2，旧 lease renew/commit 均返回 409。preview 构建通过，含已记录的 unsupported-platform 与 chunk-size 警告；typecheck 和文档 gates 的命令/结果记录在本批进度文件。未验证尚未上传的 Worker event/outbox、真实 LLM handoff、多实例 backend、生产授权、Workspace/Session 原子转移、Safari、自然 eviction 或 OS crash。
syncReplaySteps: 上游同步后核对正式 Session writer 是否仍通过相同 queue 串行 append 与 ownership handoff，以及 event log 是否保留 turn/step/tool-result 身份。若 DSH event schema 或 ToolCallRecovery 配对规则变化，迁移 scanner 和 malformed/terminal fixtures；保留旧 cursor race、caller 伪报和 Chrome active-turn 用例。运行 backend tests、handoff Vitest、session-owner-handoff 与 Workspace worker-handoff Chrome E2E、preview build、typecheck 和 docs gates。不要将此单 backend 检查写成对未上传客户端 mutation、跨实例 fencing 或 Cloud Worker 的证明。
deleteCondition: 正式 Session handoff API 在服务端以权威 event log/持久化执行状态拒绝未结算 turn/step/tool，具备跨实例 fencing，且等价故障矩阵已迁移到正式接口；或 Browser-Native Session handoff PoC 被移除。
status: implemented-as-draft
```

### BN-P2-022：Browser-Native capability manifest、boot 预检与受限 Shell 语义

```text
changeId: BN-P2-022
upstreamBaseline: research checkout after BN-P2-021; 2026-10-24
file: docs/drafts/browser-native-dsh-poc/browser-native-capabilities.ts; docs/drafts/browser-native-dsh-poc/browser-native-worker.ts; docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/browser-native-capabilities.spec.ts; docs/drafts/browser-native-dsh-poc/tests/default-profile-capabilities.e2e.mjs; docs/drafts/browser-native-dsh-poc/browser-capability-preflight-plan.md; docs/drafts/browser-native-dsh-poc/browser-capability-preflight-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/browser-native-dsh-poc/operational-compatibility-matrix.md; docs/drafts/README.md; docs/drafts/browser-native-dsh-poc/change-ledger.md
reason: 模块可加载、工具出现在模型 schema 和插件实际可执行是三个不同事实；此前 PoC 只有文件工具名称表，没有在 Worker Host boot 前识别主机子进程、watch、原生 addon 或后台进程等缺失能力，也没有把受限 Shell 的实际语义写入回归证据。
existingExtensionPointsChecked: 复用 Worker `createWorkerHost()` 初始化入口、现有 Browser profile overlay、Worker VFS、固定 Shell command table、DSH tools/execute waterfall、Session persistence 和已有真实 Chrome E2E；未修改正式 Agent Loop、Session format、正式 package capability seam 或默认 Web profile。
whyDraftOnlyWasInsufficient: 只有文档清单无法阻止 profile 在首次工具调用时才暴露不支持依赖；只有静态单测不能证明真实 Worker、DSH Host、tool/result 和 Session checkpoint 一起通过；只运行 `printf` 不能证明管道、重定向和不支持命令不会回退到宿主机。
behaviorChange: 新增 PoC capability manifest、插件/工具 required capability 表和 boot 前 fail-closed 预检。预检失败包含插件 ID、能力 ID和可用适配器，并在创建 Workspace/Host 前拒绝启动。真实 Chrome scripted 回归新增 `printf | tr`、输出重定向、`cat` 和不存在主机命令；默认 Worker 仍只提供固定命令表。真实 LLM 仅复跑独立 browser validation roster，不改变其 profile。
directoryOutChangeReason: 无；所有实现、测试和文档位于 docs/drafts。
consumersUpdated: Browser-Native Worker、capability helper、backend scripted handler、默认 profile Chrome E2E、PoC README、兼容矩阵、docs/drafts 导读和本账本。
tests: capability Vitest 与既有文件/Workspace Vitest 合计 21/21；backend-v2 17/17；根级 typecheck 5/5；preview build 通过。真实 Chrome 默认 profile E2E 通过受限 Shell 管道、重定向、读回和不支持命令失败，0 page error、0 跨源请求。真实 Chrome + `gpt-5.6-sol` runtime-validation E2E 通过，8 个 LLM HTTP 200、57 个 Session events、普通文件 `read → write → read`、刷新恢复和可观察流式响应通过。未验证任意 profile 动态扫描、所有插件运行路径、WASI、自然 eviction、OS crash、生产对象存储、多实例 HA、Safari、完整 ReDoS 和正式 capability service。
syncReplaySteps: 上游同步后检查 Worker Host 是否已提供 profile capability preflight；若已有等价接口，迁移本批测试并删除重复静态清单。否则保留 docs-owned manifest，仅在 Browser-Native opt-in Worker 中执行；重新运行 capability/file/backend tests、preview build、默认 profile Chrome E2E、真实 LLM runtime-validation 和文档门禁。
deleteCondition: 正式 runtime 提供可审计的 profile/plugin capability preflight，且本批测试迁移到正式 Service Definition/Provider/Consumer；或 Browser-Native PoC 被移除。
status: implemented-as-draft
```

### BN-P2-023：可写 chunk-backed 文件编辑与资源/恢复边界

```text
changeId: BN-P2-023
upstreamBaseline: research checkout after BN-P2-022; 2026-10-24
file: docs/drafts/browser-native-dsh-poc/browser-native-chunk-editor.ts; docs/drafts/browser-native-dsh-poc/browser-native-worker.ts; docs/drafts/browser-native-dsh-poc/tests/browser-native-chunk-editor.spec.ts; docs/drafts/browser-native-dsh-poc/tests/chunk-backed-edit.e2e.mjs; docs/drafts/browser-native-dsh-poc/chunk-backed-edit-validation-plan.md; docs/drafts/browser-native-dsh-poc/chunk-backed-edit-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/browser-native-dsh-poc/operational-compatibility-matrix.md; docs/drafts/README.md; docs/drafts/browser-native-dsh-poc/change-ledger.md
reason: 已验证 Workspace blob 分块传输和冷 hydrate 的只读 OPFS range backing，但当前真实 DSH edit 会把外置大文件完整 materialize；正式产品前必须验证浏览器存储层是否能以有界 buffer 执行局部替换，并证明写入失败不会破坏已发布源文件。
existingExtensionPointsChecked: 复用现有 Worker URL-gated Workspace test MessagePort、OPFS FileSystemSyncAccessHandle、PoC SHA-256、真实 DSH `read`/`grep`/`edit` E2E 和同源 backend；未修改正式 Agent Loop、Session format、MemoryVfs、Workspace mirror、默认 profile 或根级依赖。
whyDraftOnlyWasInsufficient: 只读 range backing 和分块上传不能证明替换长度变化时的尾部搬移、临时文件发布和失败恢复；单元 fake 也不能证明真实 Dedicated Worker 中 OPFS sync handle 的资源和生命周期行为。
behaviorChange: 新增 PoC-local `ChunkBackedFile`、跨 chunk UTF-8 marker 定位、copy-on-write 替换、增量 hash、取消和故障注入；Worker 测试端口新增 `chunk-edit-probe`，只在 Worker/OPFS 内生成和编辑大文件，页面只接收摘要。真实 DSH edit 路径不变，作为 materialize 对照。
directoryOutChangeReason: 无；所有实现、测试和文档位于 `docs/drafts/`。
consumersUpdated: Worker test port、chunk editor unit/E2E、PoC README、兼容矩阵、docs/drafts 导读和本账本。
tests: chunk editor Vitest 7/7；preview build、webworker runtime typecheck、Node syntax check 和 diff check 通过。收尾修复验证了 hash helper 拒绝短读、Worker probe 的 256 KiB UTF-8 输入上限以及 marker-fit 失败时的 OPFS handle/临时目录清理。真实 Chrome 155 64 MiB/1 MiB probe 成功，`maxWorkingBytes=1,048,620`，六个故障点均保持源 hash；16 MiB scripted DSH `read → grep → edit → read` 对照通过并观察到 `residentBytes` 从 34,493,823 增至 51,276,228；真实 Chrome + `gpt-5.6-sol` 普通文件 runtime-validation 通过，59 个 Session events、两次 Workspace commit、刷新和流式输出通过。未验证 Safari、自然 eviction、OS crash、正式 VFS/Workspace 接入、零拷贝、RSS SLA、真实模型大型 tool args 和生产对象存储。
syncReplaySteps: 上游同步后检查 MemoryVfs 是否已有 range mutation 或外部可写 backing；若有等价能力，迁移单测和 Chrome probe 到正式接口并保留 source-hash/failure assertions。若没有，先定义新的 mutation、工作副本引用和 Workspace 分块 upload contract，再接入正式工具；不得在现有完整 `VfsMutation.bytes` 上通过 `readFileSync()` 伪装成有界编辑。
deleteCondition: 正式 Browser-Native VFS、Workspace mirror 和 Session receipt 提供等价的可写外部文件、崩溃恢复和 Chrome/生产存储验证，且本批测试迁移；或 Browser-Native Workspace PoC 被移除。
status: implemented-as-draft
```

### BN-P2-024：external reference 编辑接入 VFS、Workspace 和刷新恢复

```text
changeId: BN-P2-024
upstreamBaseline: research checkout after BN-P2-023; 2026-10-25
file: packages/experimental/webworker-runtime/src/storage/types.ts; packages/experimental/webworker-runtime/src/storage/memory.ts; packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/fs-watch.ts; packages/experimental/webworker-runtime/src/index.ts; packages/experimental/webworker-runtime/tests/storage/memory-vfs.spec.ts; docs/drafts/browser-native-dsh-poc/browser-native-workspace.ts; docs/drafts/browser-native-dsh-poc/browser-native-workspace-store.ts; docs/drafts/browser-native-dsh-poc/browser-native-worker.ts; docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts; docs/drafts/browser-native-dsh-poc/tests/reference-backed-edit.e2e.mjs; docs/drafts/browser-native-dsh-poc/reference-backed-edit-validation-plan.md; docs/drafts/browser-native-dsh-poc/reference-backed-edit-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/browser-native-dsh-poc/operational-compatibility-matrix.md; docs/drafts/README.md; packages/experimental/webworker-runtime/README.md; packages/experimental/webworker-runtime/README.zh.md
reason: 上一批只验证了 OPFS range backing 和 chunk-backed copy-on-write 原型；没有证明 external file reference 能经过 VFS mutation、Workspace durable cache、分块上传、manifest CAS 和刷新 hydrate。若重新 materialize 完整文件，浏览器内存和 Session/tool result 仍会成为大文件瓶颈。
existingExtensionPointsChecked: 复用 MemoryVfs 的 VfsFileBacking、VfsMutationSink、Worker Host 的注入和 boot 前 prepareVfs、Browser Workspace mirror 的 snapshot/outbox/CAS、现有 URL-gated Worker test port 和同源 backend；未修改正式 Agent Loop、Session event schema、标准 edit 工具、默认 profile 或根级依赖。
whyDraftOnlyWasInsufficient: VFS 单测不能证明真实 OPFS SyncAccessHandle、IndexedDB metadata、Dedicated Worker 刷新和同源 CAS 一起工作；独立 chunk editor 也不能证明 mutation 和 Workspace commit 不重新读取完整文件。
behaviorChange: experimental runtime 增加 `VfsFileReference`、`write-reference` mutation、bounded range read 和 external replacement；PoC Workspace 能从 range reader 写 durable blob、按固定 chunk 上传并恢复 external backing。Worker 新增 `reference-edit-probe`，返回 compact hash/bytes/替换摘要/operationId/receipt，不注册为标准 DSH 工具或正式 Session event。
directoryOutChangeReason: packages/experimental/webworker-runtime 是 PoC 所依赖的实际 VFS owner；不修改该包就无法让同一个 Host VFS 观察 external reference mutation。README 中同步说明该 experimental API 的限制和非正式协议地位。
consumersUpdated: MemoryVfs storage tests、Browser Workspace tests、真实 Chrome reference-backed edit E2E、PoC README、兼容矩阵、docs/drafts 导读和中英文 runtime README。
tests: webworker-runtime typecheck 通过；VFS/Workspace Vitest 12/12 通过；preview build、Node syntax check 和真实 Chrome 4 MiB 故障矩阵、16 MiB 正常闭环通过。正常样本覆盖 17 个 1 MiB 上传块、manifest CAS、compact result、刷新 hydrate、range digest 和无 page errors；失败样本保持源 hash、不产生失败 revision，随后成功只产生一次 revision。真实 Chrome + `gpt-5.6-sol` 普通文件真实 LLM 回归通过，8 个 LLM HTTP 200、59 个 Session events、两个 Workspace commit HTTP 200、刷新和流式输出通过；一次使用未监听本地代理的尝试得到 502，清除代理后直连通过。未验证自然 eviction、OS/磁盘 crash、Safari、生产对象存储、多实例 backend 和真实模型大型 external-reference args。
syncReplaySteps: 上游同步后检查 MemoryVfs 是否已有正式 external backing/range mutation；若有等价接口，迁移本批测试并删除重复 PoC 类型。若没有，先重新核对 VfsFileReference、replacement 的 descriptor 语义和 Session/Workspace receipt 设计，再重跑 runtime typecheck、VFS/Workspace tests、preview build、4/16 MiB Chrome E2E 和文档门禁。不得把本批 test action 升级为标准 edit 或把固定 chunk 上传写成 byte-level delta。
deleteCondition: 正式 Browser-Native VFS、Workspace provider 和 Session receipt 提供等价的 external reference、range persistence、CAS recovery 和 Chrome E2E，且测试已迁移；或 Browser-Native Workspace PoC 被移除。
status: implemented-as-draft
```

### BN-P2-025：external reference 接入标准 `edit` 的恢复与冲突验证

```text
changeId: BN-P2-025
upstreamBaseline: research checkout after BN-P2-024; 2026-10-25
file: docs/drafts/browser-native-dsh-poc/browser-native-providers.ts; docs/drafts/browser-native-dsh-poc/browser-native-workspace-store.ts; docs/drafts/browser-native-dsh-poc/tests/external-edit-unknown-commit.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/external-edit-conflict-retention.e2e.mjs; docs/drafts/browser-native-dsh-poc/external-edit-agent-loop-validation-plan.md; docs/drafts/browser-native-dsh-poc/external-edit-agent-loop-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/README.md; docs/drafts/browser-native-dsh-poc/change-ledger.md
reason: P2-024 证明了 external reference 可以经过 VFS、Workspace 和刷新 hydrate，但没有证明真实 DSH `edit` 的 Session `tool/call` 在 Workspace side effect 前已 durable，也没有证明 commit 响应丢失、backend 重启和并发 CAS 冲突下不会丢 receipt、重复副作用或静默覆盖。
existingExtensionPointsChecked: 复用 DSH `session/event`、Session handle `flush()`、`tools/execute`、Workspace outbox/CAS、OPFS `FileSystemSyncAccessHandle`、真实 Chrome Worker 和同源 backend；未修改正式 Agent Loop、Session event catalog、默认 Web profile 或根级依赖。
whyDraftOnlyWasInsufficient: 只观察 Workspace revision 不能证明模型可见 Session 事实已落盘；只做协议级 CAS 不能证明标准 Agent `edit` 会保留 external reference；只做正常刷新不能覆盖 Worker terminate 后的 OPFS 句柄竞争和 unknown commit。
behaviorChange: 写入型 Browser-native Agent tool 在执行 Workspace side effect 前 flush 当前 Session writer，建立 durable `tool/call` 屏障。Browser Durable Store 对 Chrome Worker terminate 后暂时不可重开的 OPFS sync handle 做有限重试；仍不可重开但 File hash/size 已验证时，以只读内存 backing 恢复，避免把可验证数据误报为 local corruption。新增真实 Chrome E2E 覆盖 external edit unknown commit/backend restart 和 external edit CAS conflict/local retry retention。
directoryOutChangeReason: none
consumersUpdated: Browser provider、Browser Durable Store、external edit recovery/conflict E2E、PoC README、docs/drafts 索引和本账本。
tests: preview build 通过；`external-edit-unknown-commit.e2e.mjs` 真实 Chrome 通过，Session tool call 在 Workspace commit 前已 durable，commit response 丢失后同 operationId 重放、revision 只增加一次、单 receipt、单 edit call、unknown result；`external-edit-conflict-retention.e2e.mjs` 真实 Chrome 通过，remote revision 2 与 concurrent content 保留，本地 external retry 和内容保留并进入 conflict；`agent-workspace-crash-window.e2e.mjs` 四场景回归通过。未验证真实 LLM 自主选择、自然 eviction、OS/磁盘 crash、Safari、生产多实例 backend 或块级 delta。
syncReplaySteps: 上游同步后检查 Session tool execution 是否已有 durable side-effect barrier，若有则迁移 E2E 并删除 PoC provider 屏障；检查 Worker/VFS 是否有正式 async range backing 或 access-handle lifecycle hook，若有则迁移 OPFS fallback。重跑 webworker/runtime focused tests、Workspace/backend tests、preview build、三项 Chrome E2E 和文档门禁；不得把内存 fallback 写成零拷贝或把本地 CAS 写成分布式 HA。
deleteCondition: 正式 Browser-Native VFS、Workspace 和 Session reconciliation 提供等价的 durable tool-call、unknown settlement、external reference conflict 和句柄恢复语义，且 E2E 已迁移；或 Browser-Native Workspace PoC 被移除。
status: implemented-as-draft
```

### BN-P2-026：Workspace 持久化 metadata fail-closed 与 blob 生命周期回收

```text
changeId: BN-P2-026
upstreamBaseline: research checkout after BN-P2-025; 2026-10-25
file: docs/drafts/browser-native-dsh-poc/workspace-v2.mjs; docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/s3-blob-store.mjs; docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs; docs/drafts/browser-native-dsh-poc/tests/workspace-s3-minio.e2e.mjs; docs/drafts/browser-native-dsh-poc/durable-metadata-and-blob-lifecycle-validation-plan.md; docs/drafts/browser-native-dsh-poc/durable-metadata-and-blob-lifecycle-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/browser-native-dsh-poc/operational-compatibility-matrix.md; docs/drafts/README.md; docs/drafts/browser-native-dsh-poc/change-ledger.md
reason: Workspace cold load previously projected partially valid metadata and skipped invalid records; blob storage had no reference-aware list/delete lifecycle, pending upload retention, or orphan cleanup evidence. These gaps could misreport corrupt state as available, retain unreachable objects indefinitely, or delete retry data without a verified reference rule.
existingExtensionPointsChecked: 复用 docs-owned WorkspaceStore、现有 content-addressed blob store、manifest CAS、operation receipt、单进程 dataDir lock、MinIO S3 adapter 和 backend contract/Chrome E2E；未修改正式 Session format、Agent Loop、Browser profile、workspace packages 或根级依赖。
whyDraftOnlyWasInsufficient: Node unit checks alone cannot show Chrome Worker + OPFS retry against MinIO list/delete and backend restart; the existing MinIO E2E did not run Workspace reference-aware GC. A plan alone also could not establish whether malformed metadata or unknown staging directories were preserved.
behaviorChange: Workspace/identity cold load now validates exact versioned fields, UUIDs, path parents, entry hashes/bytes, operation receipts, pending hashes/timestamps and owner references before listen. Expired upload cleanup runs only after metadata load. Blob stores expose list/delete; WorkspaceStore GC serializes blob lifecycle operations within one backend process, retains every loaded manifest and non-expired pending hash, and deletes unreferenced completed blobs. Pending hashes receive timestamps; legacy hashes without timestamps remain retained. Upload resume and cleanup apply the same exact staging metadata schema; invalid metadata cannot resume, and staging is deleted only when its directory identity and complete metadata are valid and expired. Missing/corrupt/unknown staging is retained and counted. GC does not mutate manifest revision or operation receipts. The MinIO E2E waits for an authenticated S3 bucket operation, not only the container's HTTP health endpoint, before starting or restarting the backend.
directoryOutChangeReason: 无；实现、测试和文档均位于 docs/drafts。
consumersUpdated: WorkspaceStore cold loader and collector, file/S3 blob stores, backend test hook, backend contract tests, MinIO browser E2E, PoC README, compatibility matrix, docs/drafts index, validation plan/progress and this ledger.
tests: `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` 21/21；Browser-Native Workspace 与 durable Workspace Vitest 24/24；webworker-runtime typecheck 和 preview build 通过。MinIO E2E 曾在 HTTP health endpoint 已 ready、但认证 S3 bucket operation 尚不可用时失败；改为探测真实签名的 S3 初始化后，Chrome 155 + MinIO 连续两次通过 2,097,189-byte object、1 MiB Range、orphan GC delete、current blob retention、503 outage/recovery、missing-object refresh reupload、revision 3 和 backend restart readback；browser did not connect to MinIO and reported no page errors. Chrome unknown-commit recovery first hit `Execution context was destroyed` while terminating the Worker after the injected commit; three later runs passed with one DSH write call, one receipt, one revision, `TOOL_OUTCOME_UNKNOWN`, no page errors, and no cross-origin requests. 文档门禁与提交前检查运行结果见本批进度记录。Natural eviction, OS/disk crash, multi-host GC, production cloud object storage/IAM/versioning, and real LLM large tool args were not tested.
syncReplaySteps: 上游同步后先对照 Workspace JSON schema、operation receipt、upload state 和对象存储 API；若已有正式 metadata validator 或 GC，迁移坏数据、跨 Workspace 引用、pending TTL、未知 staging 保留和 MinIO/生产 adapter 测试，不保留重复实现。若没有，逐项重放 validator、server-side pending timestamps、file/S3 list-delete、单进程 GC lock 和对应 tests；保持未知状态 fail-closed，并重新运行 backend tests、Workspace Vitest、preview build、MinIO Chrome E2E、unknown-commit Chrome E2E 与 docs gates。多实例对象存储上线前必须增加共享 metadata transaction 或等价 fencing。
deleteCondition: 正式 Workspace backend 提供带版本迁移的严格 metadata loader、跨实例安全 blob GC、可恢复的 pending upload journal 和生产对象存储生命周期验证，且本批验收迁移到正式接口；或 Browser-Native Workspace PoC 被移除。
status: implemented-as-draft
```

### 2026-10-21：durable Workspace opt-in 接线

- **文件**：`apps/web/src/preview.ts`、`docs/drafts/browser-native-dsh-poc/browser-native-worker.ts`。
- **必要性**：真实 Worker 的 VFS 只能在 Host 创建前选择 durable store；仅修改 draft 内的 mirror 无法让浏览器入口在不改变默认行为的情况下启用 OPFS/IndexedDB。
- **范围**：仅识别 `preview.html?browser-native=1&browser-native-durable=1`，在 Worker Host 初始化前发送一次 opt-in 消息；默认 URL 不发送消息，继续使用原有内存模式。
- **验证**：后续运行 Browser-Native Workspace 单测、Web 类型检查和真实 Chrome durable storage E2E；未完成前不宣称浏览器端闭环已通过。
- **上游重放**：若 durable Workspace 进入正式运行时，将此消息改为正式配置字段并迁移到受支持的 preview 配置入口；若 PoC 废弃，删除本段两处 opt-in 接线即可，不影响默认 Browser-Native 启动。

## PoC 内部兼容性变更

### BN-P2-020：在 OPFS 外置大文件上验证 DSH 文件工具闭环

```text
changeId: BN-P2-020
upstreamBaseline: research checkout after BN-P2-019; 2026-10-24
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/browser-native-worker.ts; docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs; docs/drafts/browser-native-dsh-poc/opfs-agent-file-tools-validation-plan.md; docs/drafts/browser-native-dsh-poc/opfs-agent-file-tools-validation-progress.md; docs/drafts/browser-native-dsh-poc/operational-compatibility-matrix.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/README.md; docs/drafts/browser-native-dsh-poc/change-ledger.md
reason: 已分别验证 OPFS range backing、大文件 Workspace 传输和 DSH 文件工具，但没有证明真实 DSH 工具能在 cold hydrate 后的 OPFS 外置文件上读写并经刷新恢复。
existingExtensionPointsChecked: 复用 Worker Host 的 VFS backing、现有 URL-gated Workspace test MessagePort、同源 Workspace backend、真实 DSH `ctx.agentLoop` 及正式 `read`/`grep`/`edit` 工具；未改正式 DSH package、Agent Loop、Session format、Browser profile 或默认启动行为。
whyDraftOnlyWasInsufficient: VFS range 单测不能证明真实 DSH 工具经 Cordis Host 执行；普通文件工具 E2E 不能证明 OPFS external backing、edit materialize、atomic-write staging、Session payload 和 Workspace receipt 的组合行为。
behaviorChange: Worker 测试端口支持生成带有有界 UTF-8 行和 marker 的大文件，并在 marker 缺少 `lineBytes` 时于 VFS 写入前拒绝请求；PoC backend scripted handler 可固定 `read → grep → edit → read` 选择。真实 Chrome E2E 覆盖 12 MiB cold hydrate 文件、工具结果和 receipt 身份、一次 edit commit、manifest/hash、请求载荷以及刷新后同 Session read。运行时产品工具没有新增能力；Browser Worker `grep` 仍因 ripgrep 子进程不可执行而返回可见错误。另观察到 10 MiB 单行文件 edit 会使 Session 请求体超过 backend 上限，该问题未修复。
directoryOutChangeReason: 无；所有代码、测试和研究记录均位于 `docs/drafts/`。
consumersUpdated: OPFS 文件工具 E2E、验证计划/进度、兼容矩阵、PoC README 与 docs/drafts 索引。
tests: preview build 通过；backend tests 17/17、Workspace/Durable Workspace Vitest 23/23、MemoryVfs/diff Vitest 34/34；真实 Chrome E2E 拒绝缺少 `lineBytes` 的 marker 生成请求，随后通过大文件 `read → grep(error) → edit → read`、唯一 edit receipt、一次 Workspace revision、刷新后读取新值且无页面/Worker/跨源错误。另以真实 `gpt-5.6-sol` 和 Chrome 通过普通文件 `read → write → read`、刷新后的同 Session read 与 durable Workspace；8 个 LLM HTTP 200、59 个 Session events 全部 durable、两个 Workspace commit HTTP 200。真实模型没有运行 12 MiB scripted 故事。文档门禁和 pre-push 检查以本次提交记录为准。
syncReplaySteps: 上游同步后检查 MemoryVfs 外部 backing、DSH `read`/`edit` 的流式访问和结果限制，以及 Browser Worker 的 grep 实现。若正式工具接口变化，将 12 MiB Chrome 用例迁移到相同正式 API，并保留刷新后同 Session 读取、单次 receipt、staging 排除和 payload 上限断言；不要把 scripted 选择报告为真实模型行为，也不要把普通文件真实模型 E2E 外推为大文件模型能力。
deleteCondition: 正式 Browser Workspace 与 DSH 文件工具拥有等价的外部文件 backing、受限搜索和可恢复大文件编辑能力，且相应 E2E 已迁移；或 Browser-Native Workspace PoC 被移除。
status: implemented-as-draft
```

### BN-P2-007：增加模型无关的 durable Workspace 故障恢复测试接缝

```text
changeId: BN-P2-007
upstreamBaseline: dsh-v0.2.0-rc.2 / Browser-Native DSH PoC on 2026-10-21
file: apps/web/src/preview.ts; docs/drafts/browser-native-dsh-poc/browser-native-worker.ts; docs/drafts/browser-native-dsh-poc/tests/durable-workspace-recovery.e2e.mjs
reason: 真实模型上游超时使一次性 Workspace commit 503 故障恢复无法单独归因；需要在真实 Chrome Worker 中直接驱动共享 VFS，并在刷新后检查 OPFS/IndexedDB retry 和云端 commit。
existingExtensionPointsChecked: preview.ts 已是 Browser-Native Worker 的 opt-in 入口；browser-native-worker.ts 在 Host boot 前创建 Workspace runtime；Workspace mirror 已提供 flushLocalWorkspace() 和 flushWorkspace()，可作为测试接缝而不复制 Agent Loop。
whyDraftOnlyWasInsufficient: Node 单测不能证明 Dedicated Worker、OPFS、IndexedDB、页面刷新和浏览器 cookie/session 共同工作；真实 LLM E2E 又会把上游模型超时混入 Workspace 故障结论。
behaviorChange: 只有 URL 同时包含 browser-native=1 和 browser-native-test=workspace-recovery 时，preview 才建立 PoC 专用 MessagePort。该接缝可在 Worker 共享 VFS 写入/读取并等待本地或云端 Workspace flush；默认 preview 和普通 browser-native URL 不暴露该入口。
consumersUpdated: durable-workspace-recovery.e2e.mjs、README.md、durable-workspace-progress.md 和 docs/drafts/README.md。
tests: 真实 Chrome 通过：第一次 workspace/commit 返回 503，刷新后从 IndexedDB retry 和 OPFS blob 恢复，以相同 operationId 成功提交 revision 1；commitAttempts=2；无 page error；无跨 origin 请求。preview build 通过。
syncReplaySteps: 若 durable Workspace 进入正式运行时，删除本测试接缝并改用正式受控测试接口或宿主级故障注入；保留同样的断言：本地 snapshot/blob 存在、operationId 不变、恢复后 manifest/blob 与提交内容一致。若 PoC 废弃，删除 preview/Worker 接缝和该 E2E。
deleteCondition: durable Workspace 具备正式的可观测故障注入或端到端测试 seam，且不再需要在生产构建中携带该 URL-gated MessagePort；或 durable Workspace PoC 被删除。
status: implemented
```

### BN-P2-030：Session handoff 凭据隔离、unknown durability 与恢复

```text
changeId: BN-P2-030
upstreamBaseline: clean research checkout after BN-P2-029; 2026-10-25
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/browser-native-handoff.ts; docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs; docs/drafts/browser-native-dsh-poc/tests/browser-native-handoff.spec.ts; docs/drafts/browser-native-dsh-poc/tests/session-owner-handoff.e2e.mjs; docs/drafts/browser-native-dsh-poc/next-handoff-security-and-recovery-plan.md; docs/drafts/browser-native-dsh-poc/next-handoff-security-and-recovery-progress.md; docs/drafts/browser-native-dsh-poc/next-session-adapter-and-handoff-validation-progress.md; docs/drafts/browser-native-dsh-poc/next-catalog-observer-bridge-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/browser-native-dsh-poc/operational-compatibility-matrix.md; docs/drafts/browser-native-dsh-poc/change-ledger.md; docs/drafts/README.md
reason: 旧 handoff receipt 持久化 previous/next bearer token；旧 owner 用相同 handoffId 重放可重新取得新 token。checkpoint 还接受未结算 operation/execution ID，而 PoC 没有迁移它们的协议。rename 后目录 sync 失败也被错误当作确定未提交并回滚内存 owner，可能让内存与已替换文件分叉。
existingExtensionPointsChecked: 复用 PoC FormalSessionStore per-Session exclusive queue、owner epoch/token、现有 Session JSON flush、Browser Worker test MessagePort 和 Chrome Dedicated Worker handoff E2E；未修改 DSH Agent Loop、Session format、默认 profile、Workspace owner lease 或正式 package。
whyDraftOnlyWasInsufficient: 原 backend 30/30 与旧 Chrome handoff E2E 虽通过，但测试断言本身允许重放新 token，也没有在 rename 后故障、响应提交后丢失、pending work、迁移失败或并发 owner 竞争场景观察凭据和 durable state。
behaviorChange: receipt 只保留 previous owner token 的 SHA-256 digest 与不含 bearer 的 checkpoint/epoch 回执；首次 handoff 响应是唯一返回新 bearer 的请求，旧 token 等价重放只能返回 owner=null 和 credentialStatus=not-replayed。backend 启动时同步 scrub legacy receipt 中的 previous/next bearer；migration flush 失败则不开始服务。新 handoff 拒绝非空 pendingOperationIds/pendingExecutionIds。flush 将 rename 前失败作为 DURABILITY_FAILED；rename 成功后出现故障则报告 DURABILITY_UNKNOWN 并阻止 Session claim/write，直到 backend 重启重载实际持久化状态。测试 hook 可在 handoff commit 后丢弃响应；重试不发放 token，租约到期后新 claim 取得更高 epoch。Coordinator 与 backend 共用 pending-work safety rule。
directoryOutChangeReason: none; 所有代码、测试和文档位于 docs/drafts。
consumersUpdated: Session backend、纯 TS handoff coordinator、Node backend tests、Chrome handoff E2E、PoC README、兼容矩阵、前序 handoff 进度、docs/drafts 导读和本账本。
tests: backend contract 35/35；handoff coordinator Vitest 4/4；Google Chrome 155.0.8059.85 的真实 Worker response-loss/reclaim E2E 通过，owner epoch 1→2→3、旧 append 409、重放不返回 credential；Chrome default-profile capability 和双页面 observer regressions 通过；typecheck 5/5；preview build 通过并有既有 native platform/chunk-size warnings；test:docs 21/21；doc-sync 43/43；git diff --check 通过。真实 LLM handoff、Safari/WebKit、OS/磁盘 crash、生产授权、多实例 backend 和 Cloud Agent 未运行。
syncReplaySteps: 上游同步后先检查正式 Session writer 是否提供一次性交付 bearer、可迁移且不含 raw secret 的 durable receipt、unknown flush outcome 和 recovery gate。若正式接口具备这些机制，把 backend contract 与真实 Worker E2E 迁移到正式 service，再删除重复 PoC 逻辑。若没有，则保留 PoC fail-closed 行为和负例测试。重放后运行 backend tests、handoff Vitest、session-owner-handoff、default-profile-capabilities、session-observers、preview build、typecheck 和 docs gates；不把此单实例协议外推为生产授权或 Cloud Agent handoff。
deleteCondition: 正式 Session service 提供受授权的一次性交接、可查询的安全 receipt、pending execution settle/transfer、跨实例 fencing 和可恢复 durability unknown，且相同故障矩阵已迁移到正式接口；或 Browser-Native Session handoff PoC 被删除。
status: implemented-as-draft
```

### BN-P2-029：Session 目录、观察者与 handoff 幂等验证

```text
changeId: BN-P2-029
upstreamBaseline: research checkout after BN-P2-018; 2026-10-25
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs; docs/drafts/browser-native-dsh-poc/tests/session-observers.e2e.mjs; docs/drafts/browser-native-dsh-poc/next-catalog-observer-bridge-validation-plan.md; docs/drafts/browser-native-dsh-poc/next-catalog-observer-bridge-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/README.md; docs/drafts/browser-native-dsh-poc/change-ledger.md
reason: dsh-TUI 的 Session projection 与 mount ownership 经验指出，Browser-Native 还需要证明查询目录不会冒充事实、只读观察者不会获得写权，以及 handoff 响应丢失和 checkpoint 不一致不会重复交接或静默越过安全点。
existingExtensionPointsChecked: 复用 PoC FormalSessionStore 的 per-Session exclusive queue、owner token/epoch、Session seq、BrowserNativeSessionCursor 和现有真实 Chrome Worker handoff E2E；未修改 Agent Loop、正式 Session format、默认 Web profile 或 Workspace CAS。
whyDraftOnlyWasInsufficient: 单独的 owner fencing 测试不能证明同一 handoffId 的重试、flush 失败回滚、稳定 catalog cursor、双页面只读观察和跨边界载荷拒绝共同成立；仅有静态设计也不能证明浏览器页面实际通过同源 Session API 观察同一事实源。
behaviorChange: Session handoff 记录 handoffId、规范化 checkpoint 和可重放 receipt；同一幂等键的等价重试返回原 owner，不重复提升 epoch，checkpoint/owner 不匹配显式失败，durability failure 在可识别失败前恢复旧 owner。Session list 增加有界 limit/stable cursor；Session read 返回 ownerEpoch、durableThroughSeq、hasMore；append/read 受事件数和 JSON 字节预算约束，超限显式拒绝。新增双 Chrome 页面 observer E2E，观察者可以读取追加事件但不能 append。
consumersUpdated: backend Session route/store、backend contract tests、Chrome observer E2E、PoC README、验证计划/进度、docs/drafts 导读和本记录。
tests: `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` 30/30；`DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-observers.e2e.mjs` 真实 Chrome 双页面通过，观察者看到 nextSeq=2 且无 owner token 的 append 返回 409 SESSION_OWNERSHIP_LOST。未把 scripted 或直接 API 测试写成真实 LLM 证据；多实例 HA、自然 eviction、OS crash、跨主机 backend 和生产授权仍未验证。
syncReplaySteps: 上游同步后先检查 Session query API、owner handoff 和 persistence writer 是否已提供原生幂等 receipt、分页 cursor 和只读 observer contract；若无，保留 backend-v2 的 PoC-local 限制与负例测试。重放后运行 backend contract、Chrome observer、已有 handoff E2E、preview build、typecheck 和文档门禁；若正式接口存在，则把 E2E 迁移到正式接口后删除重复路由逻辑。
deleteCondition: 正式 Session service 提供等价的 handoff receipt 查询/幂等、分页目录、只读 observer cursor 和载荷预算，并且迁移后的测试仍通过；或 Browser-Native PoC 被移除。
status: implemented-as-draft
```

### BN-P2-028：Browser-Native Session compaction 与长会话可持续性

```text
changeId: BN-P2-028
upstreamBaseline: clean research checkout at batch start; 2026-10-25
file: docs/drafts/browser-native-dsh-poc/browser-native-profile.cordis.patch.yml; docs/drafts/browser-native-dsh-poc/browser-native-capabilities.ts; docs/drafts/browser-native-dsh-poc/browser-native-providers.ts; docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/runtime-validation.cordis.patch.yml; docs/drafts/browser-native-dsh-poc/runtime-validation.mjs; docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs; docs/drafts/browser-native-dsh-poc/tests/browser-native-capabilities.spec.ts; docs/drafts/browser-native-dsh-poc/tests/default-profile-capabilities.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/compaction-session-sustainability.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/compaction-real.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/long-session-hydrate.e2e.mjs; docs/drafts/browser-native-dsh-poc/next-session-sustainability-validation-plan.md; docs/drafts/browser-native-dsh-poc/next-session-sustainability-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/browser-native-dsh-poc/operational-compatibility-matrix.md; docs/drafts/README.md; docs/drafts/browser-native-dsh-poc/change-ledger.md
reason: Browser profile 覆盖 Web standard preset 时遗漏 compaction group；Browser LLM adapter 固定报告 128000 context window；此前长 Session 只有 24 轮事件计数，没有验证模型可见裁剪、summary 故障收束、真实模型压缩记忆或 64 轮 hydrate 成本。
existingExtensionPointsChecked: 复用 DSH `compaction-basic`、`command-compact`、`tool-result-pruner`、token meter、Session remote writer、现有 Browser LLM proxy、Worker Host 和测试 overlay；未修改正式 compaction、Agent Loop、Session format 或根级依赖。
whyDraftOnlyWasInsufficient: 仅检查 bundle 或 Node package composition 不能证明真实 Cordis Host 装载 compaction；单元测试不能证明 Dedicated Worker、同源 Session append、真实 Chrome refresh 和模型代理在压缩故障时序下共同工作；scripted 故障用于稳定收束，真实 provider 单独验证当前模型的 summary 和记忆。
behaviorChange: Browser profile 显式挂载 compaction group；backend config 只在显式设置时返回正整数 `contextWindow`，不再猜测 128000；LLM auxiliary purpose 只接受 `compaction` 和 `session-title`。新增默认 `/compact`、压力/overflow、摘要失败、`compaction/end` append 503、真实 LLM sentinel 和 64 轮 hydrate 验收。
directoryOutChangeReason: none; 所有代码、测试和文档仍在 docs/drafts。
consumersUpdated: Browser profile/capability manifest、Browser LLM adapter、v2 backend、runtime validation overlay、默认 profile 回归、压缩故障 E2E、真实压缩 E2E、长 Session 诊断、PoC README、兼容矩阵、drafts 索引、验证计划/进度和本账本。
tests: 默认 profile Chrome 回归通过；scripted compaction Chrome 三场景通过，压力场景 1 次 prune/2 个 summary，摘要失败无成功 summary 且有 error end，append 503 后无重复事件；真实 Chrome `gpt-5.6-sol` 在 `contextWindow=32768` 下生成 1 个 summary 和 1 个 end，刷新不重放请求并回忆唯一 sentinel；64 轮 Session 522 个事件，落盘 142006 bytes，hydrate 响应 284184 bytes，耗时 1885 ms，刷新后 LLM 请求数不变。未把这些结果外推为所有模型、生产 SLA、分页、自然 eviction、OS crash、Safari 或多实例 HA。
syncReplaySteps: 上游同步后核对 compaction group 的标准 preset 组合、LLM model context metadata、`command-compact` 入口、Session compaction event relationship 和 remote writer flush；若正式 Browser profile 已提供等价能力，迁移测试并删除重复 PoC 接线。否则保留显式 contextWindow、真实 Chrome 压缩/恢复和 64 轮诊断，运行 backend、capability、preview、Chrome 与文档门禁。
deleteCondition: 正式 Browser-Native profile 提供等价 compaction 组合、真实模型 context metadata、故障收束和长 Session recovery 测试，且本批 E2E 已迁移；或 Browser-Native PoC 被移除。
status: implemented
```

### BN-P2-027：长期 Session、并行只读工具和远程 attempt 失败收束

```text
changeId: BN-P2-027
upstreamBaseline: research checkout after BN-P2-026; 2026-10-25
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/browser-native-providers.ts; docs/drafts/browser-native-dsh-poc/tests/long-session-hydrate.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/parallel-tool-fanout.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/attempt-settlement-failure.e2e.mjs; docs/drafts/browser-native-dsh-poc/next-deep-runtime-validation-plan.md; docs/drafts/browser-native-dsh-poc/next-deep-runtime-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/README.md; docs/drafts/browser-native-dsh-poc/change-ledger.md
reason: 现有 PoC 尚未用同一批证据证明长 Session 刷新 hydrate、同一 turn 的只读工具并行结算，以及远端 Session append 暂时失败时 attempt 和 turn 是否仍能可靠收束；大文件边界需要把已有 external range 和 copy-on-write 证据纳入同一运行时结论。
existingExtensionPointsChecked: 复用真实 `ctx.agentLoop`、Session `session/event` fire-and-forget observer、远程 `SessionPersistence`、Worker Host、同源 backend testHooks、既有 OPFS residency 和 reference-backed edit test port；未修改正式 Agent Loop、Session format、默认 Web profile 或正式 Workspace package。
whyDraftOnlyWasInsufficient: Node 协议测试不能证明真实 Dedicated Worker 中的多轮 hydrate、DSH scheduler、工具结果身份和页面刷新时序；只看已有 storage 原型也不能说明标准写入会 materialize，或 copy-on-write 失败不会破坏源文件。
behaviorChange: scripted backend 增加同一 assistant message 的两个只读 `read` call、部分失败后的最终回复和一次性 Session append 503 注入。Remote Session handle 对 live event append 做有限退避重试，并在 `SEQ_CONFLICT` 后按事件内容对账，避免已提交但响应丢失时重复写入。新增三个 Chrome E2E；M4 复用既有 residency/reference-edit E2E，不重复创建测试协议。
directoryOutChangeReason: none; 所有实现、测试和文档都在 docs/drafts。
consumersUpdated: Browser-native backend/provider、四项深度运行时 E2E、PoC README、docs/drafts 索引、验证计划/进度和本账本。
tests: `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` 通过 23/23；真实 Chrome 长 Session 24 轮通过，刷新前 202 个事件、LLM 请求计数 25 到 25；并行工具通过，两个 read call 重叠且部分失败 turn 完成；attempt append 503 通过，失败 turn 为 error、刷新不重发、显式新 turn 完成；8 MiB OPFS residency 和 16 MiB/1 MiB reference-backed edit 通过，六个 copy-on-write 故障点保持源 hash。首次 attempt E2E 超时是断言错误：测试把 turn/start 误当成 user/message 的后继事件，已修正并重新通过。Safari、自然 eviction、OS/磁盘 crash、多实例 backend、生产对象存储、永久 append 故障和真实 LLM 大型 tool args 未验证。
syncReplaySteps: 上游同步后先核对 Session event observer、Session append conflict/error 类型和 Agent Loop 的 turn start 顺序；若已有正式 live persistence retry 或 event receipt，迁移本批 E2E 并删除重复 PoC 逻辑。否则保留有限重试、事件对账和 fail-closed 记录，运行 backend tests、Browser-Native Vitest、preview build、四项 Chrome E2E 和文档门禁。
deleteCondition: 正式 Browser-Native Session provider 提供等价的可验证 live event retry/settlement、hydrate 和并行工具测试，且本批 E2E 已迁移；或 Browser-Native PoC 被移除。
status: implemented-as-draft
```

### BN-P2-020：Browser-native 文件搜索、编辑载荷与取消验证

```text
changeId: BN-P2-020
upstreamBaseline: research checkout after BN-P2-014; 2026-10-24
file: docs/drafts/browser-native-dsh-poc/browser-native-file-tools.ts; docs/drafts/browser-native-dsh-poc/browser-native-providers.ts; docs/drafts/browser-native-dsh-poc/browser-native-worker.ts; docs/drafts/browser-native-dsh-poc/browser-native-workspace.ts; docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools.spec.ts; docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools-cancel.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs; docs/drafts/browser-native-dsh-poc/browser-file-tools-validation-plan.md; docs/drafts/browser-native-dsh-poc/browser-file-tools-validation-progress.md; docs/drafts/browser-native-dsh-poc/opfs-agent-file-tools-validation-plan.md; docs/drafts/browser-native-dsh-poc/opfs-agent-file-tools-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/browser-native-dsh-poc/operational-compatibility-matrix.md; docs/drafts/README.md
reason: 默认 Browser profile 的 grep/glob 仍把主机 ripgrep 子进程能力带入 Worker；大文件 edit 还可能把超长行或大替换放大为不可持久化的 Session 载荷；长搜索的取消和后续 Worker 可用性缺少真实 Chrome 证据。
existingExtensionPointsChecked: 复用 MemoryVfs、Worker Host boot 前 VFS、现有 `tools/execute` waterfall、DSH 工具 registry 的 canonical result/post-execute 流程和 preview 的 URL-gated Worker test port；未修改正式 Agent Loop、Session format、正式 filesystem package 或根级依赖。
whyDraftOnlyWasInsufficient: Node helper test 不能证明真实 Dedicated Worker、DSH Host、OPFS-backed VFS 和同源 backend 共同工作；只验证 helper 也不能证明 fallback 返回值经过 DSH registry 的 schema、presentation、Session result 和 Workspace receipt。
behaviorChange: Browser-native provider 在显式 Workspace runtime 中为 `grep`/`glob` 提供受限 JavaScript fallback，限制工作目录、文件数、扫描字节、匹配数、单行结果和搜索 yield；`edit` 在写入前拒绝过大的参数、文件或目标行。Worker test seam 可注入搜索 yield 延迟并取消 helper；正常 DSH dispatch 仍由 registry 根据 caller signal 结算 canonical aborted result。PoC 只实现 fallback，不宣称完整 ripgrep 或块级编辑。
directoryOutChangeReason: none; all implementation, tests and documentation remain under docs/drafts.
consumersUpdated: Browser-Native PoC README、插件兼容矩阵、OPFS 文件工具计划/进度、docs/drafts 导读和本账本。
tests: `browser-native-file-tools.spec.ts` 4/4；`backend-v2.test.mjs` 17/17；Browser-Native Workspace/Durable Workspace Vitest 23/23；preview build 通过。真实 Chrome 的 `browser-native-file-tools.e2e.mjs`、`browser-native-file-tools-cancel.e2e.mjs` 和 `opfs-agent-file-tools.e2e.mjs` 均通过，分别验证搜索/编辑边界、取消后续 turn 和 12 MiB OPFS-backed `read → grep → edit → read`；均无 page error、Worker error 或跨源请求。scripted tool selection 不作为真实 LLM 自主选择证据。
syncReplaySteps: 同步 upstream 后检查正式 `tools/execute`、Browser Workspace provider 和 `MemoryVfs` 是否提供等价的浏览器搜索能力；若没有，保留本目录 helper 与 browser-only provider 接线，重跑 helper、backend、preview 和 Chrome E2E。若正式工具提供结构化、可取消且有相同上限的 Worker provider，则迁移测试到正式接口并删除重复 fallback。
deleteCondition: 正式 Browser-native 文件搜索和编辑能力提供等价的路径限制、载荷上限、取消语义和 tool/result 验收，且本批测试迁移后仍通过；或 Browser-Native Workspace PoC 被移除。
status: implemented
```

### BN-P2-021：Browser Worker 文件工具资源边界与二进制语义

```text
changeId: BN-P2-021
upstreamBaseline: research checkout after BN-P2-014; 2026-10-24
file: docs/drafts/browser-native-dsh-poc/browser-native-file-tools.ts; docs/drafts/browser-native-dsh-poc/browser-native-capabilities.ts; docs/drafts/browser-native-dsh-poc/browser-native-providers.ts; docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools.spec.ts; docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools.e2e.mjs; docs/drafts/browser-native-dsh-poc/browser-file-tools-next-validation-plan.md; docs/drafts/browser-native-dsh-poc/browser-file-tools-next-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/browser-native-dsh-poc/operational-compatibility-matrix.md; docs/drafts/README.md; docs/drafts/dsh-browser-native-vfs-cli-fact-check.md
reason: 现有 Browser 文件工具先收集完整路径数组并将整个文件 materialize 到 Worker heap；结果上限、跨 chunk 文本语义、二进制误读和 provider 工具名称重复登记仍缺少验证。生态事实核查还需要明确当前 PoC 没有引入第三方 Shell/WASI runtime。
existingExtensionPointsChecked: 复用 MemoryVfs 的同步 range read、Worker VFS 注入的同一 VFS、已有 Browser 文件工具 provider、Workspace durable mirror 和真实 Chrome Worker E2E；未修改正式 Agent Loop、Session schema、默认 Web profile 或第三方 runtime 依赖。
whyDraftOnlyWasInsufficient: 单测和原有 scripted E2E 不能证明 12 MiB OPFS 外置文件的搜索读取路径、取消后的 Worker 可用性、二进制错误是否进入真实 DSH tool/result，或真实模型普通文件回归仍可通过。
behaviorChange: grep 使用显式栈遍历和 64 KiB range read，glob 增加独立 5,000 路径结果上限；搜索 pattern/include glob 限制为 4 KiB，brace expansion 限制为 128 个分支，反向引用和检测到的嵌套量词 fail closed；非法 UTF-8/NUL 文件拒绝搜索，编辑同类文件拒绝作为文本编辑。浏览器文件工具名称集中登记。错误保持结构化，不返回部分结果冒充完整结果。
consumersUpdated: browser-native-providers.ts、backend scripted E2E、Browser-Native README、兼容矩阵、事实核查注解、docs/drafts 导读和本记录。
tests: helper Vitest 6/6；preview build 通过；真实 Chrome 文件边界、取消后续 turn、12 MiB OPFS 外置文件 read/grep/edit/read 与刷新恢复均通过；真实 Chrome + `gpt-5.6-sol` 普通文件 read/write/read、刷新后 read 和流式响应回归通过，记录 8 个 HTTP 200 与 57 个 Session events。真实模型未证明其会自主选择大文件 fallback；自然 eviction、OS crash、生产对象存储、多实例 backend、完整 ReDoS 证明、完整 Shell/WASI 和 Safari 未验证。
syncReplaySteps: 上游同步后核对 MemoryVfs.openFileSync().read、Worker VFS 注入和 Browser provider 的文件工具条件；若上游已有正式 bounded search/capability registry，迁移测试并删除重复 PoC 接线，否则保留本批 resource/error tests。运行 helper Vitest、backend contract、Workspace tests、preview build、Chrome E2E、文档门禁和 typecheck；若引入 WASI/Shell，另建 adapter 计划与兼容矩阵，不把本批结果升级为 runtime 兼容证据。
deleteCondition: 正式 Browser file capability 提供等价的遍历、分块读取、取消、结果预算和二进制错误语义，且 E2E 已迁移；或 Browser-Native 文件工具 fallback 被移除。
status: implemented-as-draft
```

### BN-P2-019：拒绝空 SSE `[DONE]` 并复验真实 LLM 闭环

```text
changeId: BN-P2-019
upstreamBaseline: research checkout after BN-P2-018; 2026-10-24
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/browser-native-dsh-poc/runtime-validation-manual.md; docs/drafts/browser-native-dsh-poc/runtime-validation-report.md; docs/drafts/browser-native-dsh-poc/change-ledger.md
reason: 真实 Chrome E2E 首次复验记录 HTTP 200、空 assistant 与 `completed` turn；代理的 `[DONE]` 快速路径会跳过空内容检查，使上游空流可能被呈现为成功。
existingExtensionPointsChecked: 修复局限于 Browser-Native PoC 的 OpenAI-compatible SSE parser；继续使用现有 `LlmAdapter` error stream 和 `UPSTREAM_LLM_EMPTY` 错误，不修改 DSH Agent Loop、Session format、工具协议或正式 provider。
whyDraftOnlyWasInsufficient: Node contract test 可确定性重现无内容 `[DONE]`；只有真实 Chrome、真实 Dedicated Worker/DSH Host、同源 backend 和真实模型 E2E 能检查实际 Agent Loop、工具、Session、刷新和 Workspace commit 是否仍闭环。
behaviorChange: 上游 `finish_reason` 或 `[DONE]` 到达时统一结算流；没有文本或工具调用时返回 `UPSTREAM_LLM_EMPTY`，已有内容但缺少 finish event 时补发对应 block-end 与 finish chunk。
directoryOutChangeReason: 无；backend、contract test 与运行报告均属于 Browser-Native PoC 目录。
consumersUpdated: OpenAI-compatible SSE proxy、backend contract test、PoC README、运行时验收手册和真实运行报告。
tests: `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` 17 项通过，含空 `finish_reason`、空 `[DONE]` 和带文本 `[DONE]`。真实 Chrome 默认 Browser profile E2E 通过三轮、恰好一次 `todo_write`、同 Session 记忆、5 个 LLM HTTP 200 和凭据不出浏览器请求。真实 Chrome Browser-specific durable Workspace E2E 通过 `read → write → read`、刷新记忆/文件恢复、59 个 Session events、`durableThroughSeq=58`、8 个 LLM HTTP 200、两次 Workspace commit HTTP 200 和凭据不出浏览器请求。首次真实响应 SSE 未留档；空 `[DONE]` 路径由源码检查与合同注入复现，不宣称已直接抓到首次上游终止帧。
syncReplaySteps: 上游更新后运行 backend contract test，确认空 `[DONE]` 返回 `UPSTREAM_LLM_EMPTY` 且带内容的 `[DONE]` 会终止文本或工具调用；再用本机 `docs/drafts/.env` 执行默认 profile 与 Browser-specific durable Workspace Chrome E2E。API key 只由 Node backend 读取，不复制到日志或浏览器。
deleteCondition: PoC backend 被移除，或其 OpenAI-compatible stream parser 已迁移到正式 provider 并由正式测试覆盖空终止、内容终止和真实浏览器 Agent Loop。
status: implemented
```

### BN-P2-018：冷 hydrate 完整性、OPFS orphan 回收与 pagehide 本地屏障

```text
changeId: BN-P2-018
upstreamBaseline: research checkout after BN-P2-014; 2026-10-24
file: apps/web/src/preview.ts; apps/web/src/browser-native-page-control.ts; docs/drafts/browser-native-dsh-poc/browser-native-control.ts; docs/drafts/browser-native-dsh-poc/browser-native-worker.ts; docs/drafts/browser-native-dsh-poc/browser-native-sha256.ts; docs/drafts/browser-native-dsh-poc/browser-native-workspace-store.ts; docs/drafts/browser-native-dsh-poc/browser-native-workspace.ts; docs/drafts/browser-native-dsh-poc/tests/browser-native-sha256.spec.ts; docs/drafts/browser-native-dsh-poc/tests/cold-hydrate-integrity.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/orphan-blob-reconciliation.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/pagehide-local-barrier.e2e.mjs; docs/drafts/browser-native-dsh-poc/next-integrity-and-lifecycle-plan.md; docs/drafts/browser-native-dsh-poc/next-integrity-and-lifecycle-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/browser-native-dsh-poc/operational-compatibility-matrix.md; docs/drafts/README.md
reason: Browser Durable Workspace 的冷 hydrate、OPFS orphan 生命周期和页面离开前的本地持久化屏障仍缺少真实浏览器证据；Session receipt、Workspace outbox、commit unknown 和 writer fencing 也只分别验证，缺少同一恢复矩阵的证据整理。
existingExtensionPointsChecked: 复用 MemoryVfs 的 VfsFileBacking、Workspace durable store、IndexedDB snapshot、OPFS blob、现有 Worker test MessagePort、page control MessagePort、Workspace operationId/CAS/lease 和 Session receipt recovery。未修改 Agent Loop、Session format、默认 profile 或正式 Workspace package。
whyDraftOnlyWasInsufficient: 单测不能证明 OPFS SyncAccessHandle、真实 Dedicated Worker、IndexedDB transaction abort、页面 pagehide/BFCache 和同源 backend 的联合时序；真实 LLM 会把存储故障与上游模型延迟混在一起，因此 I1-I4 使用 scripted backend/LLM，保留真实 DSH Host/Worker。
behaviorChange: Durable store 增加增量 SHA-256、按 chunk 写入 OPFS 的 `cacheBlobFromChunks()` 和保守 `reconcileBlobs()`；metadata 不可信时不回收。durable pagehide 向 Worker 请求本地 flush，ack 或 1.5 秒超时后终止 Worker；BFCache 不终止。仅 URL-gated test port 增加 `close-vfs`，用于在浏览器中释放 SyncAccessHandle 后注入本地 blob 丢失。
directoryOutChangeReason: apps/web/src/preview.ts 必须停止在 durable pagehide 中提前终止 Worker；apps/web/src/browser-native-page-control.ts 必须持有页面生命周期 listener、发送 barrier 请求并处理 ack；这两个文件无法由 docs/drafts 内部独立接线。packages/experimental/webworker-runtime 未修改源码，仅复用既有 backing capability。
consumersUpdated: Browser-Native Worker/control、preview page control、Workspace store/mirror、三项新增 Chrome E2E、I4 既有 receipt/unknown/lease E2E、PoC README、兼容矩阵、docs/drafts 索引和本账本。
tests: `browser-native-sha256.spec.ts`、Workspace 三组 Vitest 共 25 项通过；webworker-runtime 与 apps/web TypeScript 检查通过；preview build 通过。Chrome 真实 Worker/OPFS/IndexedDB E2E：冷 hydrate 3,145,765 字节文件分 5 块、最大响应 1 MiB、篡改块进入 error；metadata abort 形成的 orphan 被删除而 manifest blob 保留，metadata 缺失为 local-corrupt 且不清理；pagehide barrier 保留本地 snapshot，BFCache 保留 Worker。复跑 receipt recovery、unknown commit/backend restart 和 writer expiry 均通过，分别观察到 receipt 一条、manifest revision 一次和旧 fencing token 全部拒绝。
syncReplaySteps: upstream 更新后先检查 MemoryVfs backing、Workspace durable store 和 page lifecycle hook 是否已有等价能力；若有，迁移 E2E 到正式接口并删除重复 PoC seam。否则按 `browser-native-sha256.ts`、store/mirror、Worker ack、page control、E2E 顺序重放；重新运行 focused tests、preview build、六项 Chrome E2E 和 docs gates。不得把 chunk hydrate 宣称为 chunk-level delta、把 pagehide barrier 宣称为后台 Agent，或把 I4 三格分别通过宣称为跨存储事务。
deleteCondition: 正式 Browser-Native Workspace 提供等价的分块校验/持久化、保守 blob GC 和页面生命周期 barrier，并由正式测试覆盖相同时序；或 Browser-Native Workspace PoC 被移除。
status: implemented
```

### BN-P2-017：OPFS 外部 VFS backing 与 backend `dataDir` 单写者恢复

```text
changeId: BN-P2-017
upstreamBaseline: research checkout after BN-P2-014; 2026-10-24
file: packages/experimental/webworker-runtime/src/storage/types.ts; packages/experimental/webworker-runtime/src/storage/memory.ts; packages/experimental/webworker-runtime/src/worker-host.ts; packages/experimental/webworker-runtime/src/index.ts; packages/experimental/webworker-runtime/tests/storage/memory-vfs.spec.ts; apps/web/src/preview.ts; docs/drafts/browser-native-dsh-poc/browser-native-worker.ts; docs/drafts/browser-native-dsh-poc/browser-native-workspace-store.ts; docs/drafts/browser-native-dsh-poc/browser-native-workspace.ts; docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/opfs-vfs-residency.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/workspace-backend-multi-instance-characterization.e2e.mjs; docs/drafts/browser-native-dsh-poc/next-capacity-and-process-safety-plan.md; docs/drafts/browser-native-dsh-poc/next-capacity-and-process-safety-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/browser-native-dsh-poc/operational-compatibility-matrix.md; docs/drafts/README.md
reason: 上一批证明 Worker MemoryVfs 会让已保存文件长期驻留 JavaScript heap，且两个 backend 进程共用一个 dataDir 会接受冲突写入并丢失事实；需要验证浏览器内文件驻留和本机 backend 的安全部署边界。
existingExtensionPointsChecked: 复用 MemoryVfs 的 seed/VFS descriptor、Worker Host 的外部 VFS 与 prepareVfs、Durable Workspace Store 的 OPFS blob cache、Workspace manifest/operation receipt 和已有 URL-gated Worker test MessagePort；未修改 Agent Loop、Session format、默认 profile 或正式 Workspace package。
whyDraftOnlyWasInsufficient: VFS 单测不能证明真实 OPFS sync handle 在 Dedicated Worker 中可用，单进程 backend 测试也不能证明跨 PID 锁竞争、SIGKILL stale lock 回收和冷启动 operation replay。
behaviorChange: `MemoryVfs` 增加可选只读 `VfsFileBacking`，clean file 的同步 descriptor 可做外部 range read，写入时 materialize；`usage()` 报告 logical bytes 与 resident JS bytes；Worker test port 增加 usage/range probe。Browser Durable Workspace Store 在验证并缓存 blob 后用 OPFS `FileSystemSyncAccessHandle` externalize 远端文件，Worker Host 启动失败或停止时关闭 backing。backend 在打开 dataDir 时原子取得 `.browser-native-backend.lock`，活 owner 存在时第二实例 fail-closed，owner PID 退出后才回收 stale lock。
directoryOutChangeReason: `packages/experimental/webworker-runtime` 是共享 experimental package，MemoryVfs/Worker Host 的 capability 必须从 package source 暴露给 PoC；`apps/web/src/preview.ts` 需要同步扩展 PoC-only test port 的 request/response 类型。两处变化仅增加通用 backing capability 和测试观测，不启用默认 OPFS 或改变普通 preview。
consumersUpdated: `VfsFileBacking` exports、MemoryVfs unit tests、Browser-Native Worker/Workspace store、backend multi-instance E2E、PoC README、兼容矩阵、进度、docs/drafts 索引。
tests: `pnpm exec vitest run packages/experimental/webworker-runtime/tests/storage/memory-vfs.spec.ts --coverage=false` 22/22；Browser-Native Workspace Vitest 23/23；`node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` 17/17；preview build、定向 TypeScript 检查和 Node syntax checks 通过。Chrome 155 的 `opfs-vfs-residency.e2e.mjs` 通过 8 MiB hydrate、64-byte range read、写入 materialize、刷新恢复；`workspace-backend-multi-instance-characterization.e2e.mjs` 通过第二 backend 启动拒绝、第一 backend SIGKILL、Session/Workspace cold recovery 和同 operation replay。
syncReplaySteps: 同步 upstream 后先检查 webworker-runtime 是否已有 durable file backing、usage telemetry 或 Worker disposal hook；若有等价 capability，迁移 PoC 到上游接口并删除重复类型。否则按 package source、Worker/preview test seam、Workspace store、backend lock 顺序重放；重新运行 MemoryVfs/Workspace/backend tests、preview build 和两项 Chrome E2E。若正式 backend 迁移到共享 metadata store，应删除本地 dataDir lock，而不是将它当作 HA 实现保留。
deleteCondition: 正式 Browser-Native VFS 提供可验证的 external range backing 和生命周期释放，且 backend 使用共享 metadata store/分布式单写者语义；或者 Browser-Native Workspace PoC 被移除。
status: implemented
```

### BN-P2-016：浏览器存储丢失、工具参数上限与 S3 blob 故障验证

```text
changeId: BN-P2-016
upstreamBaseline: research checkout after dsh-v0.2.1-rc.2 merge; 2026-10-24
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/browser-native-providers.ts; docs/drafts/browser-native-dsh-poc/browser-native-workspace-store.ts; docs/drafts/browser-native-dsh-poc/workspace-v2.mjs; docs/drafts/browser-native-dsh-poc/s3-blob-store.mjs; docs/drafts/browser-native-dsh-poc/package.json; docs/drafts/browser-native-dsh-poc/package-lock.json; docs/drafts/browser-native-dsh-poc/tests/chrome-process-crash-recovery.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/fixtures/workspace-backend-instance.mjs; docs/drafts/browser-native-dsh-poc/tests/large-tool-arguments.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/workspace-backend-multi-instance-characterization.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/workspace-partial-storage-loss.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/workspace-s3-minio.e2e.mjs; docs/drafts/browser-native-dsh-poc/mock-and-crash-boundary-validation-plan.md; docs/drafts/browser-native-dsh-poc/mock-and-crash-boundary-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/browser-native-dsh-poc/operational-compatibility-matrix.md; docs/drafts/README.md; docs/drafts/browser-native-dsh-poc/change-ledger.md
reason: 已有测试只覆盖清缓存、正常 Chrome restart、单 backend 与 Workspace 大文件分块；没有证明 OPFS/IndexedDB 单侧丢失、浏览器进程强杀后的身份恢复、共享 dataDir 多进程竞争、超大 DSH tool-call 参数拒绝或对象 blob 存储故障恢复。
existingExtensionPointsChecked: 复用 PoC durable store、Browser LLM adapter、WorkspaceStore 的 blob 操作、同源 Workspace API、现有 Worker test MessagePort 和临时 backend dataDir。未修改 Agent Loop、正式 Session format、正式 packages、根依赖或普通 profile。
whyDraftOnlyWasInsufficient: Node 协议测试不能证明 OPFS/IndexedDB、Dedicated Worker、真实 Chrome profile、Session append 和对象存储共同工作的恢复时序；scripted LLM 与本机 MinIO 使这些边界可重复注入，不把自然 eviction、生产云服务或真实模型行为混入结论。
behaviorChange: Durable Workspace 检测到没有 IndexedDB metadata 但仍有 OPFS blob 时 fail closed 并允许按 hash 导出孤儿 bytes。Browser LLM adapter 在一次响应累计 tool-call 参数超过 1 MiB 时取消响应流并返回 TOOL_ARGUMENT_TOO_LARGE，防止大参数进入 Session append 或工具派发。WorkspaceStore 增加 PoC-only blob-store 注入，默认仍使用本地文件；分块 staging 文件流式上传到 S3-compatible store，远端对象以流式 SHA-256 校验，并支持完整及 Range 读取。为兼容所测 MinIO 版本，SDK 可选 request checksum 设为 WHEN_REQUIRED，内容完整性仍由应用层 hash 验证。startBlobUpload 遇到已登记但对象缺失的 hash 时清除过期 uploadedHashes 标记，使刷新后的本地 retry 可重新上传。目录内独立 package 固定 AWS SDK，不改变根依赖。
directoryOutChangeReason: none
consumersUpdated: 新增局部存储丢失、Chrome SIGKILL、双 backend characterization、大工具参数和 MinIO E2E；更新故障计划/进度、PoC README、兼容矩阵、docs/drafts 索引和本账本。
tests: `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` 通过；`node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` 17/17；Browser-Native Workspace Vitest 11/11。Chrome 155 的局部存储 E2E 证明 OPFS 缺失报告 local-corrupt，IndexedDB metadata 缺失时孤儿 bytes 不被误报 synced 且可导出；Chrome SIGKILL 7 个唯一 profile PID 后 OPFS/IndexedDB retry 保留但身份 cookie 未恢复，测试桩注入旧 cookie 后仅提交一次；两个 Node backend 都接受相同 Session seq 和 Workspace baseRevision，第三实例冷启动只保留 backend B 的写入。大型参数 E2E 通过 768 KiB 写入，拒绝 6/9 MiB 参数，无工具副作用，同 Session 后续 turn 成功；最大实测 append body 3,147,323 bytes。MinIO E2E 使用 image sha256:fb4e814a3183f5f7b193377fccda08504f3d9284466d6f5a41c84cfd031637f7，验证 2,097,189-byte 上传、1 MiB Range read、outage 503、对象删除后刷新重传、最终 manifest revision 3 及 backend 重启读回；无 page error，浏览器只请求同源 API。
syncReplaySteps: 上游同步后先检查 Worker/VFS 是否已有受支持的持久化和远程 blob provider，再核对 Session JSON body limit 与模型流取消语义。PoC-only 的 1 MiB 上限不能直接推广为产品限制；正式设计应评估事件分块或内容引用。若采用对象存储，单独评估对象存在校验、写入并发、权限、生命周期和 backend 多实例事务，不复制 MinIO-only 设置到正式 packages。保留对应 Chrome E2E 作为迁移验收；重跑 preview build、backend-v2 tests、Workspace Vitest、五个 E2E 和 docs gates。
deleteCondition: Browser-Native Workspace PoC 被移除，或正式 runtime 提供受支持的工具参数持久化限制、云 blob provider、缺失对象重传和多实例协调；迁移后的 E2E 使用正式接口通过后，删除重复 PoC adapter 与测试依赖。
status: implemented
```

### BN-P2-011：quota 错误恢复、backend 重启 fencing 与身份存储隔离

```text
changeId: BN-P2-011
upstreamBaseline: research checkout after BN-P2-010; 2026-10-22
file: docs/drafts/browser-native-dsh-poc/browser-native-worker.ts; docs/drafts/browser-native-dsh-poc/browser-native-workspace-store.ts; docs/drafts/browser-native-dsh-poc/browser-native-workspace.ts; docs/drafts/browser-native-dsh-poc/tests/durable-workspace-quota-recovery.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/workspace-backend-restart-lease.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/workspace-browser-storage-isolation.e2e.mjs; docs/drafts/browser-native-dsh-poc/storage-isolation-and-restart-validation-plan.md; docs/drafts/browser-native-dsh-poc/storage-isolation-and-restart-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/README.md
reason: 前几批验证了 IndexedDB abort、离线 retry、CAS 冲突和 lease expiry，但尚未覆盖 OPFS 持久化遇到 quota 类失败、同一 dataDir 的 backend 重启，以及同源不同身份的浏览器本地数据隔离。
existingExtensionPointsChecked: 复用 durable Workspace Store 的 OPFS/IndexedDB 写入、Worker Host 的 PoC test MessagePort、既有 backend dataDir、Workspace lease 与身份授权路径；新增 fault hook 仅从 Worker 测试端口触发，未修改正式 package、Agent Loop、Session format 或默认启动入口。
whyDraftOnlyWasInsufficient: Node backend tests 无法验证真实 Chrome Dedicated Worker、OPFS、IndexedDB 和页面刷新间的持久化次序；源码检查也无法说明 backend 重启后旧 lease 的实际拒绝结果，或共享 origin 下切换身份时浏览器存储是否串用。
behaviorChange: Worker 测试端口新增一次性 `quota-next-opfs-write` 故障注入；真实 Chrome E2E 验证首次持久化写入失败时不提交，恢复后以同一待处理状态持久化并只 commit 一次。另两项 E2E 验证复用 dataDir 重启 backend 后旧 fencing token 被拒且刷新获取更高 token，以及同源身份切换时 Workspace ID、IndexedDB snapshot、OPFS namespace 与 backend ACL 隔离。故障注入仅模拟 `QuotaExceededError` 传播，不模拟真实磁盘耗尽或浏览器 eviction。
consumersUpdated: Browser-Native Workspace Worker/store、三项真实 Chrome E2E、验证计划与进度、PoC README、docs/drafts 索引及本记录。
tests: `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` 通过；三项 `DSH_POC_BROWSER=chrome` E2E 在当前源码下再次通过。quota fault 首次写失败、恢复后 OPFS/IndexedDB durable 再 commit，revision 为 1 且仅 commit 一次；backend restart 后旧 renew 为 409，刷新后 fencing token 从 1 升至 2，文件/revision 保留且没有重复 commit；两个身份的交叉 manifest/blob 请求均为 403，刷新后只恢复各自内容。运行时无页面错误或跨源请求。backend contract tests 15/15、Workspace Vitest 11/11、durable Workspace Vitest 8/8、三个 E2E 脚本 `node --check` 与 `git diff --check` 通过。`pnpm run doc-sync` 首轮 42/43：唯一失败的 repository references 指向进度文档中的基线提交哈希；移除哈希后 `pnpm run verify-repository-references` 通过，其余 doc-sync gates 已通过；未在该纯文本修正后重跑完整 doc-sync。
syncReplaySteps: upstream 更新后检查 BrowserDurableWorkspaceStore 是否已有受控 fault-injection seam；若未有，只重放 PoC Worker test MessagePort 与一次性 OPFS 错误注入，不向正式运行入口暴露。保留三项真实 Chrome E2E，先运行 preview build，再运行对应 E2E、backend-v2 tests 和 Browser-Native Workspace Vitest；如上游已提供等价 durable store/lease/身份隔离接口，则改用上游接口并删除重复 PoC 接线。
deleteCondition: Browser-Native Workspace PoC 被移除，或正式实现提供等价 OPFS durable error recovery、backend restart lease fencing 和身份隔离行为，且迁移后的三项浏览器 E2E 仍通过。
status: implemented
```

### BN-P2-012：Agent 文件工具 durable ack 与同 Session 重试

```text
changeId: BN-P2-012
upstreamBaseline: research checkout after BN-P2-011; 2026-10-22
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/browser-native-providers.ts; docs/drafts/browser-native-dsh-poc/tests/agent-workspace-durable-ack.e2e.mjs; docs/drafts/browser-native-dsh-poc/durable-tool-ack-validation-plan.md; docs/drafts/browser-native-dsh-poc/durable-tool-ack-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/README.md
reason: 真实 DSH `write` 遇到 IndexedDB snapshot abort 时，provider 只记录 `flushWorkspace()` warning 并返回原成功结果；这使 Session 可能把未确认本地持久化的写操作记录为成功。
existingExtensionPointsChecked: 复用 `BrowserNativeWorkspaceRuntime.flushLocalWorkspace()`、现有 `tools/execute` waterfall、已有 IndexedDB abort Worker test action、scripted backend 和 Session/Workspace receipt 路径；未修改正式 MemoryVfs、Agent Loop、Session format 或默认 profile。
whyDraftOnlyWasInsufficient: Provider 源码显示了 catch-and-continue 路径，但只有真实 Chrome Worker、DSH tool dispatch、IndexedDB 和 Session event 的组合测试才能确认错误是否变成 `isError: true`，并检查 durable snapshot 是否先于云端 commit。
behaviorChange: `write`/`edit` 成功返回后，provider 先等待 `flushLocalWorkspace()`；如果本地持久化未确认，则抛出明确说明文件可能仍只存在于 volatile Worker memory 的错误，由 DSH tool dispatch 记录为失败结果，且不开始远端 commit。仅在本地持久化成功后才调用 `flushWorkspace()`；远端同步失败仍作为待同步 Workspace 状态处理，不伪装成本地存储失败。
consumersUpdated: Browser-Native provider、scripted backend、真实 Chrome E2E、验证计划/进度、PoC README、docs/drafts 索引及本记录。
tests: 基线 E2E 真实复现 IDB abort 后 Session `tool/result.message.isError=false`；修复后同一路径结果为 `true`，错误明确说明 local persistence 未确认，远端 revision 保持 0 且无 receipt。用户在同一 Session 显式重试后，commit 请求到达时已从 IndexedDB 读到匹配 operationId/retry batch，并从 OPFS 读到对应内容；Workspace revision 为 1、receipt 关联重试 call，刷新后文件恢复且 commit 仍仅一次。`agent-workspace-edit-receipt.e2e.mjs`、`agent-workspace-receipt-recovery.e2e.mjs`、`durable-workspace-idb-abort.e2e.mjs` 均通过；backend tests 15/15，Workspace/durable Vitest 19/19，preview build、E2E `node --check`、`git diff --check` 通过。`pnpm run doc-sync` 43/43 通过。此验证使用 scripted LLM 与注入式 IndexedDB abort。
syncReplaySteps: upstream 更新后检查 `tools/execute` 文件工具 middleware 是否仍在 Session 成功结果前等待本地 durable snapshot。若上游已有等价保证，迁移 E2E 并删除重复 provider 检查；否则只重放 `flushLocalWorkspace()` 前置等待与错误传播，不把远端 Workspace commit 失败改写为本地文件工具失败。先运行 preview build，再运行本 E2E、receipt recovery、IDB abort、backend tests 和 Browser-Native Workspace Vitest。
deleteCondition: 正式 Browser Workspace tool adapter 在记录成功 `tool/result` 前提供本地 durable acknowledgement，且本 E2E 迁移到正式 adapter 后覆盖本地失败、同 Session 重试和无重复 commit；或 Browser-Native Workspace PoC 被移除。
status: implemented
```

### BN-P2-013：隔离本地持久化失败后的易失 Agent 文件状态

```text
changeId: BN-P2-013
upstreamBaseline: research checkout after BN-P2-012; 2026-10-22
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/browser-native-providers.ts; docs/drafts/browser-native-dsh-poc/browser-native-worker.ts; docs/drafts/browser-native-dsh-poc/browser-native-workspace.ts; docs/drafts/browser-native-dsh-poc/tests/agent-workspace-volatile-failure.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/agent-workspace-durable-ack.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts; docs/drafts/browser-native-dsh-poc/durable-tool-ack-validation-plan.md; docs/drafts/browser-native-dsh-poc/durable-tool-ack-validation-progress.md; docs/drafts/browser-native-dsh-poc/volatile-workspace-isolation-plan.md; docs/drafts/browser-native-dsh-poc/volatile-workspace-isolation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/README.md
reason: IndexedDB abort 后 DSH 文件工具结果已正确报错，但 VFS mutation 先于异步 durable snapshot；存活 Worker 的 MemoryVfs 仍可能暴露未确认内容给后续 read/search 或接受更多写入。
existingExtensionPointsChecked: 复用 PoC Browser-Native provider 的 tools/execute middleware、Workspace mirror 的本地持久化错误状态、Worker 测试 MessagePort 和真实 DSH Agent Loop；不修改正式 Agent Loop、Session schema、标准文件工具或普通 Web profile。
whyDraftOnlyWasInsufficient: 单测无法验证真实 tool/result 顺序、同 turn 多个文件工具、Session 恢复与 Worker 刷新的交互；一次 read 单工具检查也不能发现 grep/search 或后续 write 绕过。
behaviorChange: Browser-Native provider 在本地 Workspace snapshot 保存 pending 或失败时拒绝 Agent 的 read、read_image、write、edit、grep 和 glob；若最新 snapshot 保存成功则解除保护。测试 Worker 接缝可注入有限次数的 IndexedDB transaction abort；E2E 验证 edit 报错、后续 read/grep/glob/write 被拒、刷新恢复已提交基线、同 Session 新 edit call 成功提交一次。
consumersUpdated: durable-workspace.spec.ts、backend-v2.mjs、agent-workspace-volatile-failure.e2e.mjs、易失文件隔离计划/进度、PoC README、docs/drafts 索引。
tests: 真实 Chrome 的 `agent-workspace-volatile-failure.e2e.mjs` 通过：失败 edit 后内存测试口读到 after，Agent 后续 read/grep/glob/write 全部为 isError；刷新后 VFS 和远端仍为 before；Session 保留错误事件；新 edit call 关联唯一 receipt，manifest revision 从 1 增至 2，仅新增一次 commit。`agent-workspace-durable-ack.e2e.mjs` 与 `agent-workspace-edit-receipt.e2e.mjs` 也通过。Preview build、Workspace Vitest 21/21、backend tests 15/15、`test:docs` 21/21、`doc-sync` 43/43 与 `git diff --check` 通过。页面无 pageerror 或非同源请求。scripted LLM；未单独验证条件注册的 read_image、真实模型、Safari/WebKit、quota exhaustion、eviction 或浏览器进程崩溃。
syncReplaySteps: 若转为正式 Workspace 能力，将本地 durable-failure latch 放到 Workspace provider 的正式服务状态中，并在任何能读、搜索或修改 Workspace VFS 的 Agent 工具前检查；保留“失败后内存仍可变”故障、全部文件工具拒绝、刷新恢复和显式新 call retry 的 E2E。不要在正式 Browser runtime 迁移前修改全局 DSH 文件工具或 Agent Loop。
deleteCondition: 正式 Workspace capability 已对所有 Workspace 读/写/搜索操作提供等价的 durable failure fencing，并迁移本 E2E 到正式 provider；或 Browser-Native durable Workspace PoC 被移除。
status: implemented-as-draft
```

### BN-P0-001：本地损坏诊断与 Agent Workspace receipt 崩溃恢复

```text
changeId: BN-P0-001
upstreamBaseline: dsh-v0.2.0-rc.2 / research checkout on 2026-10-22
file: apps/web/src/browser-native-page-control.ts; apps/web/src/locales/browser-native-workspace.ts; apps/web/src/preview.ts; docs/drafts/browser-native-dsh-poc/browser-native-session-events.ts; docs/drafts/browser-native-dsh-poc/browser-native-providers.ts; docs/drafts/browser-native-dsh-poc/browser-native-workspace.ts; docs/drafts/browser-native-dsh-poc/browser-native-workspace-store.ts; docs/drafts/browser-native-dsh-poc/browser-native-worker.ts; docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/*
reason: 本地 snapshot/blob 损坏必须 fail closed；Workspace 已提交但 Session receipt 尚未到达 backend 时，Worker 终止必须能通过本地 outbox 补写同一 Session 的 receipt，且不能重放 Workspace 副作用。
existingExtensionPointsChecked: MemoryVfs 的 VfsMutationSink、Worker Host 的 VFS/prepareVfs 注入、Session append/flush 生命周期和 tools/execute waterfall；实现限于 PoC provider、runtime 与 preview 状态，不修改正式 Agent Loop、Session event catalog 或 SESSION_FORMAT_VERSION。
whyDraftOnlyWasInsufficient: Node 单测无法证明真实 OPFS/IndexedDB、Dedicated Worker、Session backend 与刷新后的同源身份共同满足跨存储恢复顺序；真实 LLM 会将协议错误与 provider 波动混淆。
behaviorChange: durable Workspace 对 snapshot/blob 损坏报告 local-corrupt；PoC provider 将真实 DSH write/edit 工具调用身份附加到本地 Workspace batch，将 commit receipt 存入 OPFS/IndexedDB outbox，再追加同一 Session 的 browser-native/workspace-receipt event。该事件仅在持久化时标记 ignorable=true。首次 Session receipt append 被中断并终止 Worker 后，刷新重开同一 Session 可补写且去重；默认 preview 行为不变。
consumersUpdated: next-high-value-validation-plan.md、next-high-value-validation-progress.md、README.md、docs/drafts/README.md、durable-workspace.spec.ts、durable-workspace-idb-abort.e2e.mjs、agent-workspace-receipt.e2e.mjs、agent-workspace-receipt-recovery.e2e.mjs。
tests: pnpm run build 与 preview build 通过；Vitest 19/19、backend/reconciliation Node tests 18/18；真实 Chrome corruption、真实 IndexedDB transaction abort、Worker retry、Agent receipt 和 commit-before-Session-receipt crash recovery E2E 均通过。测试使用 scripted LLM；未运行 Safari/WebKit、真实 LLM、quota/eviction 或浏览器进程崩溃。
syncReplaySteps: 迁移到正式 DSH 前，先为 Workspace receipt 定义受支持的 Session event schema 与 unknown-reader 兼容策略；将本地 outbox 和 page status 纳入正式 Workspace 服务；复用崩溃恢复 E2E 的顺序断言。若不产品化，删除本段所列 PoC provider/runtime、UI状态和测试，不改正式 Session format。
deleteCondition: 正式 Workspace capability 提供 receipt、outbox recovery 和 Session reconciliation 的支持接口，且对应集成测试不再依赖本 PoC；或 Browser-Native Workspace PoC 被删除。
status: implemented-as-draft
```

### BN-P0-002：恢复本地 corruption、工具崩溃窗口和 writer lease 冲突

```text
changeId: BN-P0-002
upstreamBaseline: research checkout after BN-P0-001; 2026-10-23
file: apps/web/src/browser-native-page-control.ts; apps/web/src/locales/browser-native-workspace.ts; apps/web/src/preview.ts; docs/drafts/browser-native-dsh-poc/browser-native-control.ts; docs/drafts/browser-native-dsh-poc/browser-native-worker.ts; docs/drafts/browser-native-dsh-poc/browser-native-workspace.ts; docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/agent-workspace-crash-window.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/durable-workspace-corruption.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/workspace-writer-expiry.e2e.mjs; docs/drafts/browser-native-dsh-poc/recovery-boundary-validation-plan.md; docs/drafts/browser-native-dsh-poc/recovery-boundary-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/README.md
reason: 已有 E2E 证明 snapshot/blob 损坏时 fail closed，却没有保留可用本地 bytes 的用户导出；writer lease backend fencing 已通过，但冲突标签看到裸 boot 503；还未把真实 DSH 文件工具的 VFS mutation 与 OPFS/IndexedDB durable 保存之间的 Worker crash 作为单独故障点验收。
existingExtensionPointsChecked: 复用 Workspace mirror 的 async local save、Worker test MessagePort、DSH Session `TOOL_OUTCOME_UNKNOWN` recovery、backend writer lease/CAS 和 preview page-control status channel；未改正式 MemoryVfs、Agent Loop、Session format、普通 Web profile 或 Workspace backend API。
whyDraftOnlyWasInsufficient: VFS 单测不能证明实际 DSH tool/result 与 Session recovery 顺序；仅检查 IndexedDB 不能证明 OPFS bytes 能导出且导出不改变远端；协议 claim 测试不能证明第二个真实 preview 如何呈现 lease 冲突。
behaviorChange: PoC Worker test seam 可在 VFS mutation 的本地 save 前或 metadata 写入后挂起，真实 Worker terminate/reload E2E 验证 before-save 文件丢失但 Session 明确记录 `TOOL_OUTCOME_UNKNOWN`、不自动重放且同 Session 可续聊；after-save pending retry 在刷新后只 commit 一次。`local-corrupt` 页面添加用户主动下载的 JSON 恢复包，包含原始 metadata、OPFS blobs 的 base64 和 SHA-256 校验、损坏/缺失/不可读清单；导出不上传、不清除、不修改本地或远端数据，原始 bytes 总量上限 64 MiB。Workspace lease 409 的 `retryAfterMs` 从 backend error details 解析并显示本地化倒计时重试；fencing 仍由 backend 决定。
consumersUpdated: Browser-Native Worker/mirror、preview page-control/locales、三项真实 Chrome E2E、验证计划/进度、PoC README、docs/drafts 索引及本记录。
tests: Preview build 通过。`agent-workspace-crash-window.e2e.mjs` 两个 crash point 通过：before-save 后 remote revision 0、无 commit；after-save 后 revision 1、唯一 commit；两者 Session recovery result 为 `TOOL_OUTCOME_UNKNOWN`，原 write call 不重放，同 Session turn 2 成功，0 page errors/跨源请求。`durable-workspace-corruption.e2e.mjs` 通过 invalid snapshot、missing blob、hash mismatch 三项下载；导出 hash/bytes/缺失清单正确、IndexedDB 保持原内容、remote revision 0、0 page errors/跨源请求。`workspace-writer-expiry.e2e.mjs` 通过：冲突 claim 返回 409 并显示倒计时，首标签续租期间显式重试再次被拒，释放后第二标签获得 fencing token 2，旧 resume/renew/commit/release 均返回 409，无 page errors/跨源请求。三项使用真实 Chrome Worker/DSH Host 与 scripted LLM；未用真实模型。
syncReplaySteps: 上游同步时先核对 Session recovery 是否仍为 started call 缺 result 时生成 `TOOL_OUTCOME_UNKNOWN`；保留 before/after durable 两个 crash point 与禁止重复 LLM/tool/commit 断言。若正式页面已有导出/download API，将 64 MiB 限制和 hash 清单迁移到该 API；否则只迁移 opt-in preview helper，禁止生产默认 UI 暴露测试端口。租约冲突应读取 backend 的正式 retry hint 并保留每次重新 claim 的 fencing 检查。运行 preview build、三项 Chrome E2E、Web typecheck、相关 Workspace/backend tests 和 docs gates。
deleteCondition: Browser-Native Workspace PoC 被移除；或正式 Browser Workspace 提供同等可审计本地恢复导出、真实 Session/Workspace crash recovery 和可恢复 lease-conflict UX，且三类 E2E 已迁移到正式接口。
status: implemented-as-draft
```

### BN-V2-002：backend close 释放 keep-alive 连接

```text
changeId: BN-V2-002
upstreamBaseline: docs-owned v2 backend on 2026-10-20 / backend-v2.mjs
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs
reason: Playwright/Node fetch 在真实模型回合结束后会留下 HTTP keep-alive sockets；server.close() 等待这些 idle connections，使 E2E 已打印完整成功证据后仍不退出。
existingExtensionPointsChecked: backend 是本 PoC 独立 Node server，现有 close() 是唯一 teardown 入口；没有共享 DSH Host 或公开 package API 的生命周期要求。
whyDraftOnlyWasInsufficient: 退出等待发生在 docs-owned backend 的 server handle，不是浏览器 Worker teardown；测试 runner 无法从外部安全关闭其私有 sockets。
behaviorChange: close() 先调用 Node HTTP server.closeAllConnections()，再等待 server.close() 完成；仅影响显式关闭此 PoC backend 的时刻。
consumersUpdated: runtime-validation.e2e.mjs、runtime-lifecycle.e2e.mjs 和人工停止 backend 继续通过同一 close() 入口释放连接。
tests: 2026-10-21 backend/Symbol tests 9 passed；scripted Chrome/WebKit runtime 和 lifecycle E2E 通过；真实 Chrome/WebKit runtime E2E 均以退出码 0 输出完整 Session 与安全摘要。
syncReplaySteps: 从上游同步 backend 或 Node 运行时基线后，确认 closeAllConnections() 可用且 close() 不需保留响应连接；运行 backend-v2.test.mjs、runtime-validation.e2e.mjs 和 runtime-lifecycle.e2e.mjs。
deleteCondition: PoC backend 不再由该模块管理 HTTP server，或 teardown 改用具备等价 idle/active connection disposal 语义的生命周期 API。
status: implemented
```

### BN-P2-005：为 Worker Host 提供可持久化 VFS 和启动前恢复 seam

```text
changeId: BN-P2-005
upstreamBaseline: dsh-v0.2.0-rc.2 / packages/experimental/webworker-runtime/src/worker-host.ts
file: packages/experimental/webworker-runtime/src/worker-host.ts; packages/experimental/webworker-runtime/src/index.ts; packages/experimental/webworker-runtime/README.md; packages/experimental/webworker-runtime/README.zh.md; packages/experimental/webworker-runtime/tests/*; apps/web/src/browser-native-page-control.ts; apps/web/src/locales/browser-native-workspace.ts; docs/drafts/browser-native-dsh-poc/*
reason: Browser-Native Workspace 同步需要在同一个 Worker VFS 中装载只读 runtime image、恢复云端授权 Workspace，并观察后续 VFS 写入；现有 Worker Host 内部创建 VFS，调用方无法连接 mutation sink 或在 Cordis boot 前 hydrate。
existingExtensionPointsChecked: `MemoryVfs` 已接受 `VfsMutationSink`；`loadVfsImage()` 和 `loadVfsOverlay()` 可向传入的 VFS 静默 seed。Worker Host 组合点是 image/overlay mount 与 `WorkerModuleLoader` 建立之间。
whyDraftOnlyWasInsufficient: Workspace 持久化 adapter 位于 PoC 内，但 VFS 创建与启动时序由 runtime 包独占；在 PoC Worker 中旁路创建另一个 VFS 会使 Host 插件、Node fs proxy 和同步队列观察不同的文件系统。
behaviorChange: 新增可选的调用方 VFS 注入和异步启动前准备回调；默认不传时保留现有 Worker Host 行为。回调在镜像、overlay 和空目录 seed 后、模块加载及 Cordis boot 前运行；失败中止 Host 启动。Browser-Native 页面通过本地化的状态提示显示 Workspace 加载、dirty、同步、错误、冲突和已确认 revision。
consumersUpdated: Browser-Native Workspace PoC 注入带同步 sink 的 `MemoryVfs`，从 backend 恢复授权文件，再让同一 VFS 服务 Host 与插件；页面控制端接收并呈现同步状态。
tests: `pnpm exec vitest run packages/experimental/webworker-runtime/tests/storage/tar.spec.ts packages/experimental/webworker-runtime/tests/storage/memory-vfs.spec.ts`; PoC workspace adapter specs; backend contract tests; runtime package typecheck/build; Chrome scripted/real Workspace E2E。
syncReplaySteps: 上游更新后重新核对 WorkerHostOptions、VFS mount 顺序、MemoryVfs mutation 与 seed 语义；若 runtime 已提供等价 VFS factory/hydrate hook，改用上游 API 并删除重复 seam；否则重放最小可选扩展，运行 webworker-runtime storage/host 测试、typecheck/build 与 Browser-Native Chrome E2E。
deleteCondition: Worker Host 已提供正式且等价的 VFS 注入和 boot 前 hydrate seam，且 PoC 与 package 测试不再依赖该改动。
status: implemented
```

### BN-V2-003：拒绝无内容的上游模型完成

```text
changeId: BN-V2-003
upstreamBaseline: docs-owned v2 backend before 2026-10-21 / backend-v2.mjs
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs; docs/drafts/browser-native-dsh-poc/tests/runtime-real-lifecycle.e2e.mjs
reason: OpenAI-compatible provider 可以在没有文本和工具调用的情况下返回 `finish_reason=stop`；旧 proxy 将其包装成空文本块，Session 因而记录成功完成，但用户没有收到回复。
existingExtensionPointsChecked: 行为位于 docs-owned LLM proxy 的上游 SSE 转换；DSH LLM adapter 会消费 proxy 的终止流事件，不需要改 Agent Loop 或 Session event 类型。
whyDraftOnlyWasInsufficient: 错误发生在真实 provider 响应转换处，UI 无法可靠区分有效空答复与 provider 空完成。
behaviorChange: 收到无文本、无工具调用的上游完成信号时，proxy 发出 `UPSTREAM_LLM_EMPTY` 错误，不再生成空 assistant completion。
consumersUpdated: backend contract test 覆盖该响应映射；真实 Chrome Stop/恢复脚本在该错误出现时只允许一次显式用户重试。真实 provider 后续复测没有再次自然触发此分支。
tests: `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs`; `node --test docs/drafts/browser-native-dsh-poc/tests/runtime-real-lifecycle.e2e.mjs` with real Chrome and the configured model backend.
syncReplaySteps: 更新 backend 后保留无 delta 但含 finish 的 SSE fixture，运行 backend contract tests；在真实 Chrome 运行 Stop/恢复 E2E，确认空 completion 以错误结束且用户重试能创建新的 DSH turn。
deleteCondition: 上游 provider adapter 或正式 LLM proxy 明确拒绝无内容的成功完成，并有同等 contract test 覆盖。
status: implemented
```

### BN-V2-004：返回系统分配的动态监听端口

```text
changeId: BN-V2-004
upstreamBaseline: docs-owned v2 backend before 2026-10-21 / backend-v2.mjs
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
reason: E2E 为隔离并行运行使用 `port: 0`；原 server 返回字面端口 `0`，而不是操作系统实际绑定的 loopback 端口，导致测试无法向 backend 发请求。
existingExtensionPointsChecked: 该值只由 PoC backend 的 `listen()` 向启动器返回；Node HTTP server 的 `address()` 是实际监听地址的来源。
whyDraftOnlyWasInsufficient: 端口分配发生在 backend 持有的 server socket 上，调用方无法从其外部获知实际分配端口。
behaviorChange: `listen()` 在 server 启动后从 `server.address().port` 返回实际端口；显式指定非零端口时仍返回实际监听 origin。
consumersUpdated: backend runtime E2E 和验证启动器可使用动态端口，不共享固定端口。
tests: `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs`，其中新增 `port: 0` 启动、返回端口和健康路由请求断言。
syncReplaySteps: 同步 backend 时检查监听回调是否返回真实绑定地址；运行 backend contract tests 中的动态端口用例及 runtime validation E2E。
deleteCondition: PoC backend 不再支持动态端口测试，或新的 server adapter 返回并验证等价的实际监听 origin。
status: implemented
```

### BN-V2-001：Session list 同时提供 Persistence snapshot 与 Controller items

```text
changeId: BN-V2-001
upstreamBaseline: docs-owned v2 backend before Session Controller list integration / backend-v2.mjs
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs; docs/drafts/browser-native-dsh-poc/README.md
reason: Browser-Native backend 的 session/list 原先只返回 Session Persistence 所需的 snapshots；正式 Client Session Controller 的 session.list consumer 读取 items，缺少该字段时无法从列表恢复已存在的 Session。
existingExtensionPointsChecked: 已核对 Worker-side SessionPersistence provider 对 snapshots 的读取、Client Session Controller 的 SessionListValue 消费以及正式 session/list Remote 类型；扩展保持在 PoC backend，不改变正式 wire type 或 Session format。
whyDraftOnlyWasInsufficient: 两个正式 DSH consumers 共用同一 PoC route，但分别需要 persistence snapshots 和 controller summaries；只保留任一字段都会破坏另一个 consumer。
behaviorChange: 仅在 docs-owned backend response 中新增 `items`，保留原有 `snapshots` 及其字段；items 提供 Controller 列表所需的 sessionId、updatedAt、running、blank、cwd 和 agentAvailable 值，其中 updatedAt 暂映射 header.createdAt，running 和 agentAvailable 固定为 false。
consumersUpdated: SessionPersistence 继续读取 snapshots；Session Controller 使用 items 建立可 retain 的 Session list；assistant-ui PoC 通过该列表恢复已记录的 Session id。
tests: `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs`；assistant-ui PoC Chromium E2E 验证刷新后只复用原 Session 并显示其持久化历史。
syncReplaySteps: 从 upstream 更新后重新核对 SessionPersistence 的 list response 和 Client Session Controller 的 SessionListValue；若两者仍复用该 route，保留两个字段并运行 backend-v2 tests 与 assistant-ui browser E2E；若 backend 改为正式 DSH route，删除此 docs-owned projection 并验证两个 consumer。
deleteCondition: SessionPersistence 和 Session Controller 不再共用本地 PoC session/list route，且替代 route 的兼容性测试通过。
status: implemented
```

### BN-P2-015：Worker 内生成文件规模测试负载与分块 Workspace 传输

```text
changeId: BN-P2-015
upstreamBaseline: dsh-v0.2.1-rc.2 / research checkout on 2026-10-24
file: apps/web/src/preview.ts; docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/browser-native-worker.ts; docs/drafts/browser-native-dsh-poc/browser-native-workspace-store.ts; docs/drafts/browser-native-dsh-poc/browser-native-workspace.ts; docs/drafts/browser-native-dsh-poc/workspace-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs; docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts; docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts; docs/drafts/browser-native-dsh-poc/tests/large-file-scale.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/many-small-files-scale.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/workspace-blob-protocol-mock.ts; docs/drafts/browser-native-dsh-poc/large-file-scale-validation-plan.md; docs/drafts/browser-native-dsh-poc/large-file-scale-validation-progress.md
reason: 当前 Workspace blob API 以单个 HTTP body 上传，8 MiB 以上请求被拒；大文件 Chrome E2E 还需要从真实 Worker 内部生成 VFS bytes，避免通过页面消息复制大对象。千文件 workload 还暴露出每次 mutation 排队完整 snapshot 的写放大。
existingExtensionPointsChecked: preview.ts 已有仅由 `browser-native=1&browser-native-test=workspace-recovery` 开启的 MessagePort；Worker test handler 可直接访问同一 Workspace runtime.vfs。Workspace backend 的 `dataDir`、manifest CAS 和 operation receipt 可承载 PoC staging；durable store 已有 OPFS blob 与 IndexedDB metadata 发布点。不需要新增生产文件 API 或修改 MemoryVfs、Agent Loop、Session format。
whyDraftOnlyWasInsufficient: 纯 Node VFS 单测无法涵盖真实 Chrome Dedicated Worker、OPFS、IndexedDB、backend 重启和页面刷新；一次性 blob API 也无法验证缺块续传、幂等块重放或 finalize 的完整 hash/size 校验。
behaviorChange: PoC test MessagePort 增加受限的 `write-pattern` 操作，文件由 Worker 内部生成；Workspace 增加 1 MiB chunk 的 upload start/status/put/complete 和 download chunk 路径。上传以 `operationId + blob hash` 标识，块 hash、最终 file hash 和 byte length 均校验；相同块重放幂等，损坏 staging 可重新补传。durable OPFS blob 按 1 MiB 写入；本地 snapshot 调度合并突发 mutation，只保存最新快照。默认 preview 和普通 browser-native 页面不暴露测试操作。
consumersUpdated: preview.ts、browser-native-worker.ts、Workspace backend/client/store、相关单测和 mock、两项真实 Chrome scale E2E、large-file-scale-validation-plan.md/progress.md、PoC README、docs/drafts 导读和本账本。
tests: backend contract tests 17/17；Workspace/durable Workspace focused Vitest 23/23；preview build 和新增 E2E `node --check` 通过。真实 Chrome 155 通过 16 MiB、64 MiB 和 1,000 个 256-byte 文件：覆盖 staging 损坏后补传、已写入块但响应丢失后的不重复上传、backend 重启、刷新 hydrate、bytes/hash、单次 commit 和无 pageerror。Chrome 负载由 Worker test port 生成；真实 LLM、Safari/WebKit、自然 eviction、OS crash、多实例 backend 和大型 tool args 未验证。
syncReplaySteps: 上游同步后确认 preview MessagePort 测试 seam、Workspace manifest/operation API 和 durable store 发布顺序仍一致；保留 URL opt-in、Worker 内分配和输入上限，禁止把该 seam 接入普通 Web 或公开 API。运行 preview build、backend-v2 tests、Workspace Vitest、large-file-scale.e2e.mjs 和 many-small-files-scale.e2e.mjs；若正式 runtime 提供等价的可注入 VFS fixture 或分块对象存储接口，则迁移 E2E 并删除重复 PoC 接线。
deleteCondition: 正式 Browser Workspace 有等价的 Worker 内文件 fixture/受控测试 API，且 E2E 已迁移到该 API；或 Browser-Native Workspace PoC 被删除。
status: implemented
```

## 当前登记

### BN-P1-001：preview 使用 docs-owned browser-native Worker entry

```text
changeId: BN-P1-001
upstreamBaseline: dsh-v0.2.0-rc.2 / apps/web/src/preview.ts; packages/experimental/webworker-runtime/src/worker.ts
file: apps/web/src/preview.ts
reason: 现有 preview 只加载上游固定 Worker bundle，无法把 docs-owned Remote Session/LLM provider 注入同一个 Worker Host；需要一个可替换的实验 Worker entry，同时保留现有 preview page、tunnel 和 AppWebEntry。
existingExtensionPointsChecked: 已核对 `createWorkerHost`、`WorkerHostOptions.staticModules`、`requireActiveModuleLoader`、preview 的 `?worker` import 和 `connectWorkerHost`；provider 仍通过后续 static module/profile overlay 接入，不修改 agent-loop、Session format 或普通 Web entry。
whyDraftOnlyWasInsufficient: Vite 入口必须位于当前应用的构建图中，单独把 Worker 文件放在 docs 目录不会自动替换 `preview.ts` 的 `?worker` import。
behaviorChange: 只改变 preview 实验入口使用的 Worker bundle；普通 `index.html`、`AppWebEntry`、Desktop 和默认 `dsh web` 启动保持不变。
consumersUpdated: `apps/web/src/preview.ts` 继续调用上游 `chooseWorkerHostSource` 和 `connectWorkerHost`；新增 Worker 复用相同的 init frame、image、overlay 和 request tunnel，并追加 browser-native profile overlay。
tests: `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`; 现有 `apps/web/tests/preview-boot.e2e.ts`; browser-native provider/backend contract tests; docs-owned Worker 的 TypeScript build path; `git diff --check`。
syncReplaySteps: 从 upstream 更新时重新对比 `apps/web/src/preview.ts` 和 `webworker-runtime/src/worker.ts` 的初始化顺序；优先把新增 static module seam 接回上游 Worker entry，若上游支持可配置 Worker factory 则删除本地复制的 entry，只保留 docs provider。
deleteCondition: v2 PoC 移除或上游 preview 提供等价的 Worker injection hook；删除该 import 后普通 preview boot acceptance 仍通过。
status: implemented
```

### BN-P1-002：Browser-Native preview 卸载时终止所属 Worker

```text
changeId: BN-P1-002
upstreamBaseline: dsh-v0.2.0-rc.2 / apps/web/src/preview.ts; packages/experimental/webworker-runtime/src/client/index.ts
file: apps/web/src/preview.ts
reason: Browser-Native preview 需要明确终止由页面拥有的 Worker，并将 teardown 期间特定的 boot-payload failure 与活动页面启动失败区分；此前报告的刷新 503 最终定位为 E2E 每轮执行两次导航造成，修复测试后连续刷新未复现。
existingExtensionPointsChecked: 已核对 `connectWorkerHost()` 的 boot payload handshake、`AppWebEntry.run()` 对 `__DSH_BOOT_READY__` 的等待、WorkerTunnel 和 Browser-Native `pagehide` owner close beacon；处理仅绑定 `?browser-native=1`，未改通用 Worker transport 或普通 Web/desktop 启动。
whyDraftOnlyWasInsufficient: `apps/web/src/preview.ts` 是 Vite preview 的 Worker 创建入口；只在 docs-owned page helper 中添加 listener 无法在 Worker 创建前捕获顶层 bootstrap rejection，也无法终止由 preview 页面创建的 Worker。
behaviorChange: Browser-Native preview 在非 BFCache 的 `pagehide` 时标记页面卸载并 terminate 页面拥有的 Worker；若该页面等待 boot payload 时因 teardown 收到匹配的 boot failure，则只结束正在卸载的 bootstrap。其他错误和活动页面中的相同错误仍会抛出。默认 preview 与 `browser-native=0` 路径保持原启动失败行为。
consumersUpdated: `apps/web/src/browser-native-page-control.ts` 的 page-control beacon 仍在正常 unload 时请求 Session close/flush；runtime-validation helper 在 `page.reload()` 后只等待已加载页面，不再再次 `page.goto()`；lifecycle E2E 复用同一等待逻辑。
tests: `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`; backend/Symbol tests 9 passed; scripted Chrome/WebKit runtime/lifecycle E2E; WebKit scripted five-refresh run; real Chrome/WebKit runtime E2E with two refreshes each; `git diff --check`。
syncReplaySteps: upstream 更新后重查 preview bootstrap、boot readiness rejection 和 Worker ownership；若上游提供页面销毁钩子，则迁移 terminate 行为到该钩子；保留仅 opt-in 的卸载处理，并运行默认 preview boot acceptance、Browser-Native scripted lifecycle 和真实 Chrome/WebKit refresh E2E。
deleteCondition: Worker connector 自行提供等价的 page teardown cancellation/cleanup，且移除此 opt-in 行为后 Chrome、WebKit 和目标 Safari.app 刷新没有未处理 boot error，也不遗留旧 Worker 请求。
status: implemented
```

### BN-P1-003：将 preview 页面 bridge 纳入 Web TypeScript 项目

```text
changeId: BN-P1-003
upstreamBaseline: dsh-v0.2.0-rc.2 / apps/web/tsconfig.json; apps/web/src/preview.ts
file: apps/web/src/browser-native-page-control.ts; apps/web/src/preview.ts; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/README.md
reason: `apps/web/src/preview.ts` 从 `docs/drafts` 直接导入 TypeScript 时，推送钩子执行的 `tsc -b tsconfig.client.json` 报告 TS6059 和 TS6307，因为草稿文件不在 Web 项目的 `rootDir` 和文件列表内。
existingExtensionPointsChecked: 已核对 Web 项目的 `rootDir`/include 配置、preview 的 Worker 注入入口和既有 pagehide owner-close 实现；没有扩大 TS 项目范围，也没有把 PoC Worker、backend、profile 或测试移入正式应用目录。
whyDraftOnlyWasInsufficient: preview 必须同步执行 owner-token MessagePort、刷新续接和 unload close beacon；其静态导入必须属于 `apps/web` TypeScript project 才能通过推送钩子的项目类型检查。
behaviorChange: 页面 bridge 代码位置从 docs-local 草稿移动到 `apps/web/src`，运行逻辑不变；PoC 配置、Worker、backend、测试和说明仍在 `docs/drafts/browser-native-dsh-poc`。
consumersUpdated: `preview.ts` 导入项目内 bridge；PoC README 链接到该源码；此账本记录目录外改动与 upstream 重放步骤。
tests: 2026-10-21 移动后 `pnpm run typecheck` 和 `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` 通过；`pnpm exec tsx scripts/run-oxlint.ts apps/web/src/preview.ts apps/web/src/browser-native-page-control.ts` 通过；Chrome scripted `runtime-lifecycle.e2e.mjs` 与 `runtime-validation.e2e.mjs` 在移动后通过。首次 typecheck 在移动前以 TS6059/TS6307 失败；移动后全仓类型检查确认错误消失。真实 Chrome Browser-specific E2E 在 bridge 移动前通过，详细记录见运行时验证报告。
syncReplaySteps: 更新 Web 项目时先检查 apps/web TS project root/include；如果 preview lifecycle bridge 仍由 `preview.ts` 导入，保留 bridge 在 `apps/web/src`，PoC 其余源码留在 docs；若上游提供正式 preview lifecycle hook，则迁移到该 hook 并删除本地 bridge。
deleteCondition: preview 使用正式生命周期 API 管理 Worker/Session owner，且移除本文件后 Web typecheck、刷新续接、pagehide close 和双标签 lease E2E 均通过。
status: implemented
```

### 目录外改动审计结论

当前 Browser-Native PoC 的运行时代码目录外接线位于 `apps/web/src/preview.ts`；它静态导入 docs-owned Worker，opt-in 页面装载 Browser-Native overlay、连接 owner control channel，并在正常 pagehide 时结束页面拥有的 Worker。其他已登记的目录外改动分别位于 core tool schema converter 和翻译 manifest。未来从 upstream tag 或 main 重放时，按各 changeId 检查上游是否已有等价 Worker、schema 或文档登记扩展点；移除可替代 patch 后运行默认 preview acceptance、package tests 和 Browser-Native Chrome/WebKit E2E。

### BN-P2-001：browser-native preview profile 与远程 provider

```text
changeId: BN-P2-001
upstreamBaseline: dsh-v0.2.0-rc.2 / packages/experimental/webworker-runtime/src/worker-host.ts; packages/bundle/base/cordis.patch.yml; packages/bundle/web-app/cordis.patch.yml
file: apps/web/src/preview.ts
reason: 现有 Web profile 默认激活本地 JSONL SessionPersistence 和本地 LLM provider；browser-native PoC 需要在同一个 Worker Host 中改用正式远程 SessionPersistence/LlmAdapter，而不能在页面复制 Agent Loop 或自定义 UI。
existingExtensionPointsChecked: 已核对 Worker Host 的 `/dsh/home/cordis.patch.yml` home patch、`SessionPersistence`、`LlmAdapter`、`WorkerHostOptions.staticModules`、`AppWebEntry` 和 `connectWorkerHost`；未修改 agent-loop、Session event format、普通 Web entry 或 Desktop profile。
whyDraftOnlyWasInsufficient: profile patch 必须作为 VFS home overlay 随 Worker init frame 装载，static module provider 必须进入 Vite Worker bundle；仅在 docs 中放置 YAML/TS 文件不会被 Worker Host 读取。
behaviorChange: 仅 preview 实验入口追加 browser-native profile overlay；普通 `index.html`、默认 `dsh web`、Desktop 和 Headless profile 不改变。preview 仍由现有 `AppWebEntry` 渲染完整 DSH Web UI。
consumersUpdated: `browser-native-worker.ts` 合并 Node builtins 与 docs-owned static providers；`preview.ts` 追加 `browser-native-profile-overlay.tar.gz`；`home/cordis.patch.yml` 停用 JSONL row、通过 VFS-local relative plugin entry 注册 remote Session/LLM rows（LLM row 注入 `llm`），并覆盖 `agent-default-model`。
tests: `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`; `pnpm exec vitest run apps/web/tests/preview-boot.e2e.ts --config vitest.web.config.ts`; backend/provider contract tests; scripted and real Playwright E2E; secret-redaction assertions。
syncReplaySteps: 从 upstream 更新时先对比 `preview.ts` 和 `worker.ts` 的 init/overlay 顺序；若上游提供 Worker profile/static-module injection hook，优先迁移到该 hook并删除本地复制；重新生成或校验 home overlay，再运行 preview boot 和 browser-native E2E。
deleteCondition: 上游 Web preview 能通过正式 injection hook加载等价 provider/profile，且删除本条接线后 browser-native E2E仍通过；否则保留并继续以 docs目录外最小接线维护。
status: implemented
```

### BN-P2-002：browser-native preview 使用显式 opt-in overlay

```text
changeId: BN-P2-002
upstreamBaseline: dsh-v0.2.0-rc.2 / apps/web/src/preview.ts
file: apps/web/src/preview.ts
reason: 无条件追加 browser-native profile overlay 会改变现有 preview acceptance 的默认 Worker 数据源契约；PoC 需要 provider overlay，但普通 Preview 必须继续使用上游 overlay 列表。
existingExtensionPointsChecked: 已核对 preview.html 的 query 入口、`chooseWorkerHostSource`、`connectWorkerHost` 和现有 `preview-boot.e2e.ts`；没有为普通 Web、Desktop 或 Agent Loop 增加 browser-specific 分支。
whyDraftOnlyWasInsufficient: Vite preview entry 必须读取浏览器 URL 才能选择 overlay；只在 docs 目录写入 profile 不会阻止默认 preview 加载它。
behaviorChange: 只有 URL 包含 `browser-native=1` 的 preview 才追加 browser-native profile overlay；默认 preview 保持原有 overlay 列表，但仍使用 BN-P1-001 引入的 docs-owned Worker entry。
consumersUpdated: browser-native PoC 启动说明使用 `preview.html?browser-native=1&preview-fixture=none`；默认 `preview.html?preview-fixture=none` acceptance 继续断言 `data overlays=0`。
tests: `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`; `pnpm exec vitest run apps/web/tests/preview-boot.e2e.ts --config vitest.web.config.ts`; browser-native Playwright E2E 使用 opt-in URL。
syncReplaySteps: 从 upstream 更新时重新核对 preview query 解析和 overlay 顺序；若上游提供显式 profile/Worker injection 参数，迁移 PoC 到该参数并删除本地 query 分支；否则保留此最小接线并运行默认 preview 与 opt-in browser-native tests。
deleteCondition: browser-native PoC 改用上游正式 Worker/profile injection hook，且删除 query 分支后默认 preview 与 browser-native E2E 均通过。
status: implemented
```

### BN-DOC-001：browser-native PoC v2 重新规划

```text
changeId: BN-DOC-001
upstreamBaseline: dsh-v0.2.0-rc.2 / apps/web/src/preview.ts, packages/experimental/webworker-runtime
file: docs/drafts/browser-native-dsh-poc/browser-native-dsh-plan-v2.md; docs/drafts/browser-native-dsh-poc/browser-native-dsh-progress-v2.md; docs/drafts/browser-native-dsh-poc/README.md
reason: 旧 PoC 使用独立 HTML、PoC-local loop 和自定义事件，不能证明现有 DSH Web UI、Cordis 插件组合和真实 ctx.agentLoop 在浏览器 Worker 中运行。
existingExtensionPointsChecked: 已核对 AppWebEntry、preview Worker tunnel、appBoot.boot、WorkerHostOptions.staticModules、webworker packer、LlmAdapter 和 SessionPersistence；v2 首选通过 custom Worker entry、static modules 和 profile overlay 接入。
whyDraftOnlyWasInsufficient: 旧实现代码不能仅靠文档声明变成真实 DSH runtime，因此先新增自包含 v2 规格和恢复进度记录，再按规格重做实现。
behaviorChange: docs-owned v2 PoC 已经实现，但普通 Web、Desktop、Headless profile 和 DSH 核心运行时仍没有被修改；preview 始终加载实验 Worker entry，browser-native profile overlay 需要显式 opt-in。
consumersUpdated: 本 README 指向 v2 规划和进度；旧协议文档继续作为历史实验记录。
tests: 规划文档写入后运行 docs gates、Markdown link/budget 检查和 git diff --check；实现后运行 `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs`、scripted/real browser-native Playwright E2E、preview build 和默认 preview acceptance。
syncReplaySteps: 从 upstream 更新时先保存本账本和 v2 tests，重新核对 preview/runtime/packer/LLM/Session 入口，再按 v2 规划重放最小 docs 外接线；若 upstream 提供正式 Worker plugin injection 或 remote persistence hook，则改用该入口并删除本地 seam。
deleteCondition: v2 实现已使用上游正式 hook，或 v2 PoC 被移除；删除 browser-native 专用目录外接线后普通 preview 和 Web tests 仍通过。
status: implemented
```

### BN-P2-003：增加 browser-native Session owner lease 与刷新续接

```text
changeId: BN-P2-003
upstreamBaseline: docs-owned v2 backend before owner renewal / backend-v2.mjs; browser-native-providers.ts; browser-native-worker.ts
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/browser-native-providers.ts; docs/drafts/browser-native-dsh-poc/browser-native-worker.ts; docs/drafts/browser-native-dsh-poc/run-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs; docs/drafts/assistant-ui-browser-native-dsh-poc/src/dsh-client.ts; docs/drafts/assistant-ui-browser-native-dsh-poc/tests/browser-native-ownership.e2e.mjs
reason: 页面崩溃、Worker 强制结束或刷新时，旧 owner 会阻塞同一 Session 的后续写入并产生 `already owned` 或 `missing write lease`；Browser-Native PoC 需要有限时写租约、续租和同一标签页的刷新续接。
existingExtensionPointsChecked: 已核对 Session Controller 的 open/retain/release 生命周期、Worker Host 的 disposer、backend session operation route、pagehide/sendBeacon 和 assistant-ui 页面内的 MessageChannel；实现保持在 docs-owned backend/Worker/client adapter，不改变 Session format 或正式 owner API。
whyDraftOnlyWasInsufficient: owner fencing 位于 backend route 和 Worker provider 的共同生命周期中，只修改页面提示无法回收 stale owner；只增加页面重试也无法避免跨标签页并发写入。
behaviorChange: v2 backend 默认提供 30 秒 owner lease，Worker 约每 10 秒 renew；正常卸载发送 close/flush；assistant-ui 在当前标签页 sessionStorage 保存 Session id 和 owner token，并在刷新后通过独立控制通道尝试续接；其他标签页仍收到 ownership conflict，过期 owner 会被 backend reclaim。
consumersUpdated: browser-native Worker/provider、assistant-ui client、owner error UI 和对应契约/E2E 测试共同使用 lease/renew/close 语义。
tests: `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs`; `pnpm --dir docs/drafts/assistant-ui-browser-native-dsh-poc run test:e2e:ownership`; real Chrome/Safari assistant-ui E2E；real Chrome browser-native v2 E2E。
syncReplaySteps: 从 upstream 更新后重新核对 Session Controller retain/release、Worker teardown 和 backend session route；若上游提供正式 owner lease/handoff capability，迁移 adapter 到该 capability 并删除 docs-owned renewal；重新运行 backend contract、ownership、Chrome 和 Safari real E2E。
deleteCondition: 上游提供等价的过期回收、续租、关闭释放和刷新续接语义，且 assistant-ui 与原生 Web UI 的 ownership E2E 不再依赖本目录实现。
status: implemented
```

### BN-P2-004：修复 Safari/WebKit 原生 JSON Schema 构造器识别

```text
changeId: BN-P2-004
upstreamBaseline: dsh-v0.2.0-rc.2 / packages/core/tools/src/json-schema.ts
file: packages/core/tools/src/json-schema.ts; packages/core/tools/tests/json-schema.spec.ts; packages/core/tools/README.md; packages/core/tools/README.zh.md
reason: Safari/WebKit 对 `Function.prototype.toString()` 的原生 `Object`/`Array` 构造器格式与 Chromium 不同，工具参数 schema 被误判为不支持并阻止 Session 创建；修复必须让真实浏览器加载 DSH tool preset。
existingExtensionPointsChecked: 已核对 raw JSON Schema validator、parameter schema conversion 和 tool preset loading；只替换 intrinsic constructor 的检测方式，保留 schema subset、wire fields 和错误语义。
whyDraftOnlyWasInsufficient: schema conversion 在 DSH core package 内执行，PoC 页面或 backend 无法可靠绕过 tool preset 的同源校验；浏览器端错误会在 Agent Loop 启动前发生。
behaviorChange: `Object`/`Array` intrinsic constructor detection 以当前运行时原生函数的实际源码表示作比较，不依赖 Chromium 的固定字符串；非原生或跨 realm 的 constructor 仍被拒绝。
consumersUpdated: tool schema converter、WebKit formatting regression test、工具 package README 与 assistant-ui/browser-native real E2E 共同覆盖该兼容行为。
tests: `pnpm exec vitest run packages/core/tools/tests/json-schema.spec.ts`; assistant-ui real Chrome/Safari E2E；browser-native v2 real Chrome E2E。
syncReplaySteps: 从 upstream 更新后重新核对 `hasIntrinsicConstructor` 的安全条件和当前浏览器矩阵；保留跨 realm/不同 native formatting 测试，运行 tools tests、typecheck/build 和 browser real E2E。
deleteCondition: 上游 schema validator 接受 Safari/WebKit 原生 constructor formatting，且移除本修复及回归测试后所有工具 preset 和真实浏览器 E2E 仍通过。
status: implemented
```

### BN-DOC-000：将 PoC 草稿目录登记为中文 scratch 文档

```text
changeId: BN-DOC-000
upstreamBaseline: dsh-v0.2.0-rc.2 / scripts/translation-pairing.manifest.json
file: scripts/translation-pairing.manifest.json
reason: 本目录是中文单语的实施草稿，必须与现有 docs/drafts 研究文档保持相同的翻译门禁范围。
existingExtensionPointsChecked: 已检查 translation-pairing manifest、docs/i18n/README.md 和现有 docs/drafts 排除项；Markdown frontmatter 没有单文件 scratch 标记。
whyDraftOnlyWasInsufficient: 翻译门禁按仓库路径发现 Markdown，若不登记目录，任何新草稿都会被要求提交完整英文 counterpart 和 i18n record。
behaviorChange: 仅改变文档翻译门禁的范围；不改变 DSH runtime、package、profile 或生成物。
consumersUpdated: 无运行时 consumer；translation-pairing gate 读取该 manifest。
tests: pnpm run test:docs; pnpm run doc-sync; git diff --check
syncReplaySteps: 从 upstream 更新时保留该目录级排除；若该目录转为正式双语文档，先补齐每个文档的 .zh.md 和 .i18n.yaml，再删除本排除项。
deleteCondition: 本目录内所有文档都进入双语文档 corpus，且 translation-pairing gate 在移除排除项后通过。
status: implemented
```

### BN-P2-006：durable Workspace 的 OPFS/IndexedDB opt-in

```text
changeId: BN-P2-006
upstreamBaseline: dsh-v0.2.0-rc.2 / packages/experimental/webworker-runtime/src/storage, apps/web/src/preview.ts
file: docs/drafts/browser-native-dsh-poc/browser-native-workspace-store.ts; docs/drafts/browser-native-dsh-poc/browser-native-workspace.ts; docs/drafts/browser-native-dsh-poc/browser-native-worker.ts; apps/web/src/preview.ts; docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts; docs/drafts/browser-native-dsh-poc/tests/browser-storage-boundary.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
reason: Browser-Native DSH 的 MemoryVfs 变更需要在 Worker 重建后可恢复；本批次先验证 OPFS bytes + IndexedDB snapshot/outbox，不重写正式 VFS 或 Session format。
existingExtensionPointsChecked: 已核对 MemoryVfs 的 post-commit VfsMutationSink、Worker Host 的 vfs/prepareVfs 注入、preview Worker 创建顺序和已有 Workspace manifest/CAS backend。
whyDraftOnlyWasInsufficient: durable store 必须在 Worker Host boot 前注入 VFS，并需要真实 Chrome 的 OPFS/IndexedDB；只增加文档或独立 storage demo 不能证明 DSH 文件工具写入已经进入恢复路径。
behaviorChange: 默认 Browser-Native preview 不变；显式 `browser-native-durable=1` 时，Worker 使用 OPFS blob + IndexedDB snapshot，启动时回放本地 pending/retry，真实 Workspace 文件工具可以在刷新后恢复。
consumersUpdated: durable plan/progress、PoC README、Worker/preview opt-in、Memory store 单测、Chrome storage E2E 和真实 runtime validation 共同记录该能力及其 post-commit 崩溃窗口。
tests: `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts`; preview build; Chrome storage boundary; one real Chrome + real LLM durable file-tool run passed; commit-503 fault injection was observed but its follow-up LLM probe was unstable.
syncReplaySteps: 从 upstream 更新后重新核对 MemoryVfs sink、Worker Host vfs/prepareVfs 和 preview Worker 创建顺序；优先迁移到正式配置 hook，再运行 durable unit tests、preview build 和 Chrome E2E；若 upstream 提供 journal-first VFS 或 durable Workspace seam，删除本地 adapter 中重复代码。
deleteCondition: 上游提供等价的 pre-boot durable VFS injection、OPFS/IndexedDB persistence and recovery tests，且删除本目录 adapter/opt-in 后默认 preview 与 Browser-Native durable acceptance 仍通过。
status: implemented-as-draft
```

## 登记模板

复制下面的模板创建新的 `changeId`。不要用提交 hash 代替 `upstreamBaseline`；仓库的上游版本、tag 或被核对的公开文件路径才是未来重放所需的事实。

```text
changeId: BN-P0-000
upstreamBaseline: 0.2.0-rc.2 / packages/<group>/<package>/src/<file>.ts
file: packages/<group>/<package>/src/<file>.ts
reason: <required>
existingExtensionPointsChecked: <required>
whyDraftOnlyWasInsufficient: <required>
behaviorChange: <required>
consumersUpdated: <required>
tests: <required>
syncReplaySteps: <required>
deleteCondition: <required>
status: proposed
```

## 登记规则

优先级必须按以下顺序尝试：本目录内的 adapter、fixture、独立 backend、exact route、PoC image、test composition，然后才是独立 experimental package，最后才是通用核心 extension point。

禁止为 PoC 在核心 Agent Loop、Session format、普通 `web` profile、Desktop profile 或 Connection trust fence 中加入 browser-specific 条件分支。若通用 extension point 确实必要，必须证明 Node、Desktop、Headless 和普通 Web 的旧行为不变。

`syncReplaySteps` 必须能指导未来从 upstream main 或 tag 更新当前分支：先保存本账本和测试，再应用上游版本，按文件顺序重放最小 patch，运行 ledger 中列出的 tests，最后检查 upstream 是否已经提供等价能力并决定保留、缩小或删除本地改动。

`deleteCondition` 必须是可观察条件，例如某个公开 hook 已经存在且 PoC 测试改用该 hook 后通过；不能写成“以后重构”或“等稳定”。

## Dev Note

本账本本身属于 PoC 草稿，不是 release note，也不是永久架构决策。若某项改动最终进入正式 DSH，应在完成上游化后把决定转移到对应 package README、architecture 文档或 Agent Note，并在本账本保留一条指向新 owner 的简短记录。
## 2026-10-21：Durable Workspace PoC 规划

- **范围**：新增 `durable-workspace-plan.md` 和 `durable-workspace-progress.md`，并在本 PoC README 增加入口。
- **原因**：在实现 OPFS/IndexedDB 本地 durable outbox 前固定目标、故障窗口、验收条件和不应被误读的限制；不修改既有 Workspace 同步协议。
- **验证**：规划阶段尚未运行新增代码测试；实现命令和结果写入 `durable-workspace-progress.md`。
- **回放方式**：后续如需拆分或同步到 upstream，只需保留本 PoC 目录新增文件及 README 的两条局部索引，不要求修改正式 packages。

### BN-P2-008：Workspace 故障矩阵、writer lease 与文件能力验证

```text
changeId: BN-P2-008
upstreamBaseline: committed Browser-Native DSH PoC baseline on 2026-10-21
file: apps/web/src/preview.ts; docs/drafts/browser-native-dsh-poc/browser-native-worker.ts; docs/drafts/browser-native-dsh-poc/browser-native-workspace.ts; docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/workspace-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/*; docs/drafts/browser-native-dsh-poc/workspace-session-reconciliation.mjs
reason: 下一批高价值验证需要在真实 Chrome Worker 中证明上传失败、commit unknown、Workspace 多 writer 和文件操作矩阵；现有 durable PoC 没有 writer lease 或 operation receipt 查询，也没有可驱动 rename/append/stat/atomic staging 的 Worker 测试接缝。
existingExtensionPointsChecked: Worker Host 的 prepareVfs、MemoryVfs 的 VfsMutationSink、Workspace manifest/blob/commit CAS、已有 Session owner lease 和 preview 的 URL-gated test MessagePort；未修改 Agent Loop、Session format 或正式 Workspace package。
whyDraftOnlyWasInsufficient: Node contract test 不能证明 OPFS/IndexedDB、Dedicated Worker、同源 cookie 和两个浏览器页面共同工作；仅用真实 LLM 会把存储故障与 provider 延迟混在一起。
behaviorChange: 显式 URL 参数 browser-native-workspace-lease=1 让 Worker 在 Host boot 前 claim Workspace writer lease；commit 可携带 writerToken/fencingToken；backend 提供 lease claim/renew/release 和 operation receipt query。browser-native-test=workspace-recovery 下新增模型无关的 lease-info/release-lease、append/mkdir/rename/remove/stat/list/chmod/write-binary 接缝；默认 browser-native 和默认 durable 入口不启用 Workspace lease。backend contract 测试默认使用随机端口，以允许独立测试进程并发运行。
consumersUpdated: README.md、high-value-validation-plan.md、high-value-validation-progress.md、docs/drafts/README.md 和本记录。
tests: backend-v2.test.mjs 15 passed，两个独立进程并发运行仍各为 15 passed；browser-native-workspace.spec.ts 与 durable-workspace.spec.ts 15 passed；session-workspace-reconciliation.test.mjs 3 passed；真实 Chrome durable-workspace-failure-matrix.e2e.mjs 通过 upload 503、commit response abort、operation query、无 page error/跨源请求；workspace-writer-lease.e2e.mjs 通过双页面 claim 冲突、release/reclaim 和 stale renew fencing；browser-native-file-matrix.e2e.mjs 通过 VFS 文件操作和 staging 过滤。
syncReplaySteps: 若 Workspace lease 进入正式运行时，把 URL-gated 参数迁移到正式浏览器 Workspace 配置，把 lease/fencing/operation 查询纳入正式授权和存储服务；把 Worker test MessagePort 替换为受控测试 API，并让正式 Workspace receipt 通过 DSH 扩展点进入 Session event。若 PoC 废弃，删除上述 backend/Worker/preview 接线和新增测试，不影响默认 Browser-Native 启动。
deleteCondition: 正式 Browser Workspace service 提供跨进程 fencing、operation 查询和可验证 receipt，且 Agent Loop 已有明确的 Workspace/Session reconciliation seam；或本批次 PoC 被删除。
status: implemented
```

### BN-P2-009：缓存清除重建、Agent edit receipt 与 lease 刷新恢复

```text
changeId: BN-P2-009
upstreamBaseline: research checkout after BN-P2-008; 2026-10-22
file: apps/web/src/browser-native-page-control.ts; docs/drafts/browser-native-dsh-poc/browser-native-control.ts; docs/drafts/browser-native-dsh-poc/browser-native-worker.ts; docs/drafts/browser-native-dsh-poc/browser-native-workspace.ts; docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/workspace-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs; docs/drafts/browser-native-dsh-poc/tests/durable-workspace-cache-reset.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/agent-workspace-edit-receipt.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/workspace-writer-reload.e2e.mjs; docs/drafts/browser-native-dsh-poc/next-round-validation-plan.md; docs/drafts/browser-native-dsh-poc/next-round-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/README.md
reason: 验证已提交 Workspace 缓存丢失后的重建、DSH write/read/edit/write 操作与 Session receipt 的一一对应，以及同标签页刷新后的 writer lease 安全恢复；已有故障矩阵未覆盖这些恢复和真实 Agent edit 路径。
existingExtensionPointsChecked: 复用 MemoryVfs mutation sink、Worker Host boot 前 VFS 准备、现有 Workspace manifest/blob/commit API、PoC writer lease 和 preview 的显式 browser-native opt-in；未修改 Agent Loop、正式 Session event catalog、Session format 或 Workspace API。
whyDraftOnlyWasInsufficient: 存储协议单测不能覆盖 OPFS/IndexedDB 清除后的 Worker hydrate、真实 DSH file tool 到 Session receipt 的关联，或刷新页面后由新 Worker 接管写权的时序；模型无关 scripted LLM 可把这些状态验证与上游模型可用性隔离。
behaviorChange: backend 增加同 Workspace lease 的 resume 操作，校验旧 writerToken/fencingToken 后原子轮换 token 并递增 fencingToken；稳定 resumeId 对当前 backend 进程内已成功但响应丢失的 resume 提供幂等重放，requestId 仍是逐请求诊断标识。page controller 通过当前标签页 sessionStorage 将恢复凭据交给新 Worker；旧凭据缺少 resumeId 时会先持久化新 ID；Worker 在 Workspace hydrate 前恢复 lease，释放后清除凭据。workspace lease 仍是显式 opt-in。新增三项模型无关的真实 Chrome E2E，分别覆盖远端已提交文件的本地缓存重建、DSH write/read/edit/write Session receipt 及刷新后 lease resume/fencing；lease E2E 在真实 Chrome 中完成 backend 响应丢失注入，确认重放不重复增加 fencing epoch。
directoryOutChangeReason: apps/web/src/browser-native-page-control.ts 必须在主线程保存并跨页面刷新恢复 tab-scoped 凭据；Dedicated Worker 无法读取 window.sessionStorage。修改仅服务于显式启用 browser-native-workspace-lease 的 PoC 入口，不改变默认 Web/Preview/桌面行为。
consumersUpdated: Browser-Native Workspace Worker、页面控制器、backend lease handler、backend contract tests、三项真实 Chrome E2E、PoC README、验证计划/进度和 docs/drafts 索引。
tests: DSH_POC_BROWSER=chrome 下运行 durable-workspace-cache-reset.e2e.mjs、agent-workspace-edit-receipt.e2e.mjs、workspace-writer-reload.e2e.mjs 均通过真实 Chrome；缓存重建后 revision/commit 保持 1，Agent 三次 mutation receipt 对应 revision 1–3 且刷新后无副作用重放，lease E2E 先模拟旧凭据无 resumeId，再丢弃第一次已执行的 resume 响应，以相同 resumeId 重试并只提升一次 fencing epoch，随后拒绝 stale renew/commit 与第二标签页 claim。backend-v2.test.mjs 验证 resumeId 重放返回同一 lease。测试均无 page error 或非同源请求。真实 LLM、quota/eviction、OS 级浏览器进程崩溃和生产授权未验证。
syncReplaySteps: 从 upstream 更新时先检查 browser-native-page-control.ts 是否已有正式的 Worker/page refresh credential hook；若无，保留该文件中仅供 preview PoC 使用的最小 sessionStorage 接线。随后重放 backend lease resume/token rotation，再重放 browser-native-control.ts、browser-native-worker.ts 与 browser-native-workspace.ts 的凭据传递和 hydrate 顺序；最后保留三项 E2E 和 backend lease test，执行这些测试及 preview build。若上游提供 Workspace lease handoff/fencing API，则迁移 PoC 并删除重复实现。
deleteCondition: 上游提供等价的 tab-scoped Worker lease resume 与 backend fencing 能力，并且三项 E2E 改用该正式接口后仍通过；或 Browser-Native Workspace PoC 被移除。
status: implemented
```

### BN-P2-010：离线 retry、CAS 冲突保留与 writer lease 过期接管

```text
changeId: BN-P2-010
upstreamBaseline: research checkout after BN-P2-009; 2026-10-22
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/workspace-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/durable-workspace-offline-recovery.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/durable-workspace-conflict-retention.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/workspace-writer-expiry.e2e.mjs; docs/drafts/browser-native-dsh-poc/advanced-recovery-validation-plan.md; docs/drafts/browser-native-dsh-poc/advanced-recovery-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/README.md
reason: 现有检查覆盖单次 503、刷新恢复、基础 CAS 与 lease 刷新，但没有在真实 Chrome 中把离线 retry 与刷新、并发远端提交与本地 dirty 保留、租约超时接管与旧 tab fencing 放在连续故障路径中验证。
existingExtensionPointsChecked: 复用 PoC Workspace retry batch、manifest revision CAS、lease claim/resume/release 与 fencing token；以 backend testHooks 注入短租约，不修改正式 Workspace API、Agent Loop、Session schema 或默认 profile。
whyDraftOnlyWasInsufficient: 后端单测不能覆盖真实 Chrome Worker、OPFS/IndexedDB 和页面刷新之间的恢复时序；协议 E2E 也不能代替检查本地 dirty 文件与远端已提交版本是否同时保留。
behaviorChange: `WorkspaceStore` 接受可选 `writerLeaseMs` 测试参数，默认仍为 30 秒，backend 仅从 `testHooks.workspaceWriterLeaseMs` 读取它。新增三条 scripted、模型无关的真实 Chrome E2E，分别验证离线写入和同 operationId 恢复提交、CAS conflict 保留本地与远端内容、过期 lease 接管和 fencing 旧 resume/renew/commit。
consumersUpdated: PoC backend/WorkspaceStore、三条真实 Chrome E2E、进阶恢复计划/进度、PoC README 和 docs/drafts 导读。
tests: 三条 E2E 均在真实 Chrome 通过；离线 retry 在 4 次失败请求后刷新并仅提交一次，CAS 远端 revision 为 1 且本地内容保留，lease fencing token 从 1 到 2 到 3，stale resume/renew/commit 均返回 409。`node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` 为 15/15，Browser-Native Workspace Vitest 为 11/11。无跨源请求；真实 LLM、Safari/WebKit、quota/eviction、OS 级浏览器崩溃、backend 多实例 lease 与生产授权未验证。租约持有期间旧 tab boot 的预期 HTTP 503 仍作为页面错误显示，已记录为后续 UX 验证点。
syncReplaySteps: 同步上游后确认 Workspace lease 默认仍为 30 秒，测试时长只可由 PoC testHooks 注入；保留 operationId/CAS/fencing 断言并运行三条 Chrome E2E、backend-v2 tests、browser-native-workspace.spec.ts 与 preview build。若上游提供正式 Workspace lease/CAS API，则迁移测试到该 API，不复制生产逻辑到 PoC。
deleteCondition: Browser-Native Workspace PoC 被移除，或正式 Workspace 实现与对应故障验收合并并且这些 PoC 专用 E2E 不再提供额外恢复证据。
status: implemented
```

### BN-P2-014：运行时完整性、前向版本恢复与活动写租约续期

```text
changeId: BN-P2-014
upstreamBaseline: research checkout after BN-P2-013; 2026-10-24
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/browser-native-workspace.ts; docs/drafts/browser-native-dsh-poc/browser-native-workspace-store.ts; docs/drafts/browser-native-dsh-poc/browser-native-providers.ts; docs/drafts/browser-native-dsh-poc/browser-native-worker.ts; docs/drafts/browser-native-dsh-poc/tests/workspace-writer-heartbeat.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/workspace-writer-startup-failure.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/agent-workspace-unknown-commit-recovery.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/ask-user-refresh-recovery.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/indexeddb-forward-version-export.e2e.mjs; apps/web/src/browser-native-page-control.ts; apps/web/src/locales/browser-native-workspace.ts; apps/web/src/preview.ts; docs/drafts/browser-native-dsh-poc/next-runtime-integrity-validation-plan.md; docs/drafts/browser-native-dsh-poc/next-runtime-integrity-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/browser-native-dsh-poc/operational-compatibility-matrix.md; docs/drafts/README.md; docs/drafts/browser-native-dsh-poc/change-ledger.md
reason: 现有 PoC 未验证活动 Worker 长时间等待时的 Workspace lease 续期、DSH 文件写工具遇到已提交但响应丢失并重启 backend 后的恢复、等待中的 ask-user 刷新语义，或较新 IndexedDB schema 对旧客户端和数据导出的影响。
existingExtensionPointsChecked: 复用 PoC Workspace lease claim/renew/fencing、operationId 查询、Session tool recovery、OPFS/IndexedDB durable store、页面本地恢复导出按钮和已存在的 preview workspace status。未修改 Agent Loop、正式 Session format、默认 Web profile 或正式 package API。
whyDraftOnlyWasInsufficient: Node 协议测试不能证明浏览器 timer、Dedicated Worker、真实 DSH tool dispatch、OPFS/IndexedDB 和同源 backend 在这些失败时序下共同工作；真实模型会将 provider 延迟混入恢复断言，因此本批使用 scripted LLM 与确定性故障注入。
behaviorChange: Workspace writer 在首次 Workspace 文件工具前取得租约，backend 返回的 renewAfterMs 驱动 Worker heartbeat；短暂续租异常在服务端租约到期前重试，明确 ownership loss 后旧 writer fail closed。Workspace prepare 在已 claim lease 后失败时停止 heartbeat、清除本地 writer credentials，并使迟到的 renew 响应不能复活 lease；服务端 lease 到期前其他 writer 仍会被拒绝。IndexedDB 不再请求固定版本打开，检测到高于支持版本时拒绝写入并展示独立状态；恢复导出记录 database version 和 object store 名称，并导出已识别 metadata 与可读 Workspace OPFS bytes。页面刷新不会重建 ask_user_question 的 pending Promise，DSH 将其记录为 TOOL_OUTCOME_UNKNOWN 和 interrupted turn，不自动重跑；同一 Session 的新用户消息可开启独立 turn，测试 backend 以专用 scripted marker 返回确定回复，不模拟旧问答恢复。
directoryOutChangeReason: apps/web 页面控制器负责通过现有下载入口导出前向版本数据库信息和 OPFS 内容；locale 文件为新增 local-newer-version 状态提供双语文案；preview bootstrap 必须将该明确的 fail-closed 状态作为 Workspace 无法启动的受控结果。修改只影响显式 Browser-Native preview，不改变普通 Web 页面。
consumersUpdated: 新增五项模型无关的真实 Chrome E2E；更新 Browser-Native Workspace 兼容矩阵、PoC README、docs/drafts 导读、实施进度和本账本。
tests: Chrome 155 `workspace-writer-heartbeat.e2e.mjs`、`workspace-writer-startup-failure.e2e.mjs`、`agent-workspace-unknown-commit-recovery.e2e.mjs`、`ask-user-refresh-recovery.e2e.mjs`、`indexeddb-forward-version-export.e2e.mjs` 均通过；本次还复跑 `workspace-writer-expiry.e2e.mjs`，此前 `workspace-writer-lease.e2e.mjs` 和 `workspace-writer-reload.e2e.mjs` 已通过。Heartbeat 在一次 renew 503 后跨两个 TTL 恢复；startup-failure 注入 manifest 503 后未观察到 renew，1.5 秒服务端 lease 于 1.57 秒后允许接管；未知 commit backend 重启后只产生一个 revision/receipt，HITL 刷新不重跑 LLM，IndexedDB v2 数据保持不变。Browser-Native Workspace Vitest、backend-v2 tests、preview build、typecheck 和 docs gates 的本轮命令与计数见进度记录。heartbeat 日志已去除 writer token。启动失败 E2E 首次因测试错误地在浏览器 page context 使用 Node assert 而失败；随后移除对失败 Worker MessagePort 的诊断依赖，改从 backend lease API 观测并通过。
syncReplaySteps: 同步 upstream 后先检查 Workspace runtime 是否已有活动 writer heartbeat、prepare 失败后的 lease 清理、较新 IndexedDB 版本保护及 Worker resume/lease 状态服务；逐项比对本批测试。若没有等价功能，只重放 PoC Workspace runtime/store 和显式 preview 页面状态；保留 Chrome 故障 E2E 及 lease 回归。先构建 preview，再运行这些 E2E、Browser-Native Workspace Vitest、backend-v2 tests 与文档门禁。若 upstream 已有正式实现，迁移 E2E 至正式接口并删除重复 PoC 接线。
deleteCondition: Browser-Native Workspace 正式实现提供活动租约续期和 fencing、未知 commit 查询恢复、前向 IndexedDB 保护与本地导出，且迁移后的浏览器 E2E 覆盖同一时序；或 Browser-Native Workspace PoC 被移除。
status: implemented
```

### BN-P2-017：隔离 Browser Worker 文件搜索的模型可控正则

```text
changeId: BN-P2-017
upstreamBaseline: research checkout before this batch; 2026-10-25
file: docs/drafts/browser-native-dsh-poc/browser-native-file-tools.ts; docs/drafts/browser-native-dsh-poc/browser-native-regex-worker.ts; docs/drafts/browser-native-dsh-poc/browser-native-worker.ts; docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools.spec.ts; docs/drafts/browser-native-dsh-poc/tests/browser-native-grep-isolation.e2e.mjs; docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools.e2e.mjs; docs/drafts/browser-native-dsh-poc/browser-file-search-isolation-validation-plan.md; docs/drafts/browser-native-dsh-poc/browser-file-search-isolation-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/browser-native-dsh-poc/operational-compatibility-matrix.md; docs/drafts/browser-native-dsh-poc/change-ledger.md; docs/drafts/README.md
reason: Content grep, grep include, and glob path matching ran synchronous JavaScript RegExp inside the Agent Worker. AbortSignal could not interrupt one catastrophic backtracking call, so it could block Agent messages and cancellation.
existingExtensionPointsChecked: Reused the Browser-native file tool adapter, DSH tool result path, VFS range reads, Worker test MessagePort, and existing Preview build. No Agent Loop, Session event format, production package, or default Web profile changes.
whyDraftOnlyWasInsufficient: Unit tests cannot establish nested Worker termination, Vite bundling, Chrome cancellation, DSH tool settlement, and same-turn recovery together. The Chrome E2E exercises these through the actual Worker Host and scripted tool sequence; a separate real LLM run covers ordinary grep selection only.
behaviorChange: Grep content, include, and glob path patterns execute in a disposable nested module Worker. Each matcher batch is limited to 32 values, 256 KiB and 1 second; one search is limited to 30 seconds, 250,000 lines, 32 MiB and 10,000 files. Lines above 64 KiB fail before matching, including nonmatching lines. Matcher timeout, cancellation, startup failure, and invalid response fail closed without partial results. A timed-out matcher is terminated; the Agent Worker can complete later tool calls.
directoryOutChangeReason: None. All code, tests, and research records remain under docs/drafts; docs/drafts/README.md adds the topic to the existing index.
consumersUpdated: Browser-native file tool adapter, Worker test seam, scripted backend scenario, Vitest coverage, Chrome DSH E2E, PoC README, operational compatibility matrix, drafts index, progress record, and this ledger.
tests: Browser file-tools Vitest 7/7; preview build passed with existing warnings; typecheck 5/5; scripted Chrome E2E timed out long-line, grep-content, glob, and include cases then completed safe grep/glob in the same turn; Chrome real-LLM E2E selected grep for an ordinary marker; existing file-tools, cancellation, and 12 MiB OPFS E2E passed. No extra Workspace commits, page/Worker errors, or cross-origin requests were observed. Safari/WebKit, alternative CSP deployment, production workload, formal ReDoS guarantees, natural eviction, OS crash, and ripgrep compatibility remain unverified.
syncReplaySteps: After upstream sync, check whether the Browser Worker runtime provides a supported nested-worker policy, cancellation API, or bounded regex implementation. Keep fail-closed behavior if matcher startup is unavailable; rerun the focused Vitest, preview build, typecheck, scripted/real-LLM Chrome isolation E2E, and existing file-tool/OPFS regressions. Do not replace the DSH tool result with a parallel model loop or claim ripgrep compatibility.
deleteCondition: A supported Browser-native search provider supplies equivalent bounded and cancellable matching with the same DSH tool result semantics, or the Browser-Native file tool fallback is removed.
status: implemented
```

### BN-P2-018：模型流半包、Worker 中止与上游取消恢复验证

```text
changeId: BN-P2-018
upstreamBaseline: clean research checkout at batch start; 2026-10-25
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs; docs/drafts/browser-native-dsh-poc/tests/llm-stream-failure.e2e.mjs; docs/drafts/browser-native-dsh-poc/llm-stream-failure-validation-plan.md; docs/drafts/browser-native-dsh-poc/llm-stream-failure-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/browser-native-dsh-poc/operational-compatibility-matrix.md; docs/drafts/README.md; docs/drafts/browser-native-dsh-poc/change-ledger.md
reason: Browser-Native PoC 已覆盖 Workspace 与文件工具故障，但未验证模型只输出部分文本、工具参数 JSON 半包、Worker 在模型流中终止或 UI Stop 后请求取消的 Session 和副作用边界；这些时序可能造成半条回复、重复工具调用或遗留上游请求。
existingExtensionPointsChecked: 复用 DSH Agent Loop 已有 `AssistantStreamAttempt`、Browser LLM adapter 的 NDJSON error path、Session `assistant/attempt`/`turn/end` 语义、现有 Worker crash recovery 和同源 backend；未修改正式 Agent Loop、Session format、默认 profile 或 Workspace 协议。
whyDraftOnlyWasInsufficient: 仅读 Agent Loop 源码不能证明真实 Dedicated Worker、DSH Host、Session backend 和 UI Stop 的联合时序；仅用普通真实 LLM 也不能稳定制造半包。新增 scripted fault 仍通过真实 DSH dispatch，另用本地 fake OpenAI-compatible upstream 验证代理的 AbortController 传播。
behaviorChange: backend 增加 PoC-only scripted partial-text、partial-tool-call、delayed-text fault，以及未正常结束响应的关闭观测。部分流仍由现有 adapter/runtime 规范化为错误 finish，Agent Loop 持久化 `assistant/attempt` 并以 `turn/end:error` 收束；未收到完整工具 block-end 时不产生 `tool/call`。取消沿用现有 abort/interrupt 语义，不新增第二套 loop 或重试原 prompt。
directoryOutChangeReason: none; 所有代码、测试和文档均在 docs/drafts/browser-native-dsh-poc 或 docs/drafts。
consumersUpdated: Browser-Native backend scripted/real stream contract、Chrome DSH E2E、PoC README、插件兼容矩阵、docs/drafts 导读、验证计划/进度和本账本。
tests: `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` 23/23；preview build 通过；Chrome `llm-stream-failure.e2e.mjs` 通过，观察到 partial text turn 1、partial tool turn 3、Worker stream turn 5 修复为 interrupted、Stop turn 7、8 个 LLM requests、2 次未正常结束响应关闭、无页面错误和跨源请求。一次初始 E2E 断言误把 compact stream record 当作 raw chunk，修正为读取 `text-chunks`；一次 turn 标识误从 `user/message` 读取，修正为 `turn/start`，均不涉及产品语义失败。真实 LLM 普通流沿用既有证据，本批未重复外网模型；Safari、自然 eviction、OS crash、真实供应商自然断流、生产 HA 和后台 Agent 未验证。
syncReplaySteps: 上游同步后核对 `AssistantStreamAttempt` 的 compact record、LLM runtime 的异常规范化、Browser adapter 的 reader cancel 和 Session repair；若正式接口变化，迁移本 E2E 的事件断言。运行 backend contract、preview build、Chrome E2E 和既有正常流/文件工具/Workspace recovery 回归。不得把 scripted fault 或 fake upstream 结果写成真实模型能力或生产网络保证。
deleteCondition: 正式 Browser-Native LLM adapter 和 Agent Loop 提供等价的半包 fail-closed、取消传播、Session attempt settlement 和 Worker repair 测试，且本批 E2E 已迁移；或 Browser-Native PoC 被移除。
status: implemented
```

### BN-P2-019：timed HITL、迟答恢复与活动问题取消可用性

```text
changeId: BN-P2-019
upstreamBaseline: clean research checkout at batch start; 2026-10-26
file: docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/runtime-validation.mjs; docs/drafts/browser-native-dsh-poc/tests/timed-hitl-lifecycle.e2e.mjs; docs/drafts/browser-native-dsh-poc/timed-hitl-lifecycle-validation-plan.md; docs/drafts/browser-native-dsh-poc/timed-hitl-lifecycle-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/browser-native-dsh-poc/operational-compatibility-matrix.md; docs/drafts/browser-native-dsh-poc/next-runtime-integrity-validation-progress.md; docs/drafts/browser-native-dsh-poc/change-ledger.md; docs/drafts/README.md
reason: Browser PoC only exercised the default legacy ask_user_question path. DSH source also supports timed questions, continued-question projection and user-question-reply, but their behavior with a Dedicated Worker, browser Session persistence, refresh and the shipped question UI had not been tested together. The legacy-only progress wording also incorrectly implied late-answer recovery was absent for all schemas.
existingExtensionPointsChecked: Reused tool-ask-user timed mode, userQuestions projection/inbox, the official Web question UI, existing Browser Worker/Session provider and temporary runtime validation image. No formal DSH package, default Browser profile, Agent Loop, Session format, Web app runtime or root dependency was changed.
whyDraftOnlyWasInsufficient: Package tests cannot verify the actual Web question composer, same-origin Session event order, Worker reconstruction, model request count and Workspace side effect in Chrome. The E2E uses scripted model output only to control tool sequence and response-loss timing while exercising real DSH Host and Agent Loop.
behaviorChange: A temporary profile image can enable timed ask_user_question with a bounded test timeout. The PoC scripted backend covers deadline-before-answer, timeout/late-answer, Worker refresh before answer, durable late reply followed by refresh, close-and-refresh, and Stop availability. Late answers retain the original pending tool result and enter the same Session as user-question-reply under the original callId. Default Browser profile remains legacy.
directoryOutChangeReason: Only docs/drafts/README.md is outside the PoC directory; it adds the new plan/progress and E2E to the existing research index. No apps, formal packages, profiles or root dependency files changed.
consumersUpdated: Temporary validation image builder, PoC scripted backend, Chrome E2E, lifecycle plan/progress, compatibility matrix, PoC README, prior legacy refresh progress and drafts index.
tests: Preview build passed. Six real Chrome scenarios passed: in-time answer (10s timeout), late answer after timeout (10s), refresh before answer, refresh after durable answer, hide then refresh (30s), and stop-unavailable (30s). They observed original-call settlement/late reply identity, no duplicate ask or Workspace write, no repeated answer after refresh, no page errors and no cross-origin requests. Stop-unavailable is an explicit limitation result: current question composer exposes no Stop button and the Escape handler ignores keypresses while pendingInteraction is active; the question remains answerable. Initial failures exposed test assumptions: the refresh helper waited for a composer intentionally hidden by an active question, and the first Stop probe waited for a control the UI suppresses. The test now waits for Workspace readiness and records unavailable cancellation rather than claiming Stop success. `node --check` passed for the three PoC `.mjs` files; backend contract tests passed 42/42; focused user-question/UI tests passed 159/159; `pnpm run test:docs` passed 21/21; `pnpm run doc-sync` passed 43/43. Real LLM, multi-tab answer race, legacy late answers, cross-device delivery, OS crash, Safari and production authorization remain unverified.
syncReplaySteps: After upstream sync, check tool-ask-user timed schema and timeout semantics, userQuestions projection/inbox dedupe, question card rehydration, pendingInteraction ownership and Escape stop guard. Rebuild preview and run all six timed Chrome scenarios, legacy ask-user refresh E2E, focused user-questions/tool-ask-user/client-ui-user-questions tests, backend-v2 tests and docs gates. Keep Stop-unavailable as an explicit expected result unless the UI adds a supported cancellation path; do not reinterpret close as cancellation.
deleteCondition: Default Browser profile changes to timed mode and equivalent behavior is covered by maintained product-level tests, or the Browser-Native PoC and its timed interaction fixture are removed.
status: implemented
```

### BN-P2-020：Session 远程写入限额、未知结果对账与恢复

```text
changeId: BN-P2-020
upstreamBaseline: clean research checkout at batch start; 2026-10-26
file: docs/drafts/browser-native-dsh-poc/session-transport-limits.mjs; docs/drafts/browser-native-dsh-poc/session-transport-limits.d.mts; docs/drafts/browser-native-dsh-poc/browser-native-session-transport.ts; docs/drafts/browser-native-dsh-poc/browser-native-providers.ts; docs/drafts/browser-native-dsh-poc/backend-v2.mjs; docs/drafts/browser-native-dsh-poc/tests/browser-native-session-transport.spec.ts; docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs; docs/drafts/browser-native-dsh-poc/tests/session-transport-resilience.e2e.mjs; docs/drafts/browser-native-dsh-poc/session-transport-resilience-validation-plan.md; docs/drafts/browser-native-dsh-poc/session-transport-resilience-validation-progress.md; docs/drafts/browser-native-dsh-poc/README.md; docs/drafts/browser-native-dsh-poc/operational-compatibility-matrix.md; docs/drafts/browser-native-dsh-poc/change-ledger.md; docs/drafts/README.md
reason: The Browser Session writer sent all pending live events in one request and could enqueue a separate drain task for every event. The backend already imposed a maximum of 1,024 events and 1 MiB JSON per append, so a large pending prefix could remain permanently unappendable. Existing seq-conflict reconciliation was not exercised when the backend committed an append but the response disappeared. The Session provider's durability receipt also was not checked against the local writer cursor.
existingExtensionPointsChecked: Reused the existing DSH SessionHandle, `session/event` and `session/flush` lifecycle, backend expectedNextSeq CAS, exact readback reconciliation, Session owner lease, Workspace operation receipt and the existing same-origin fault hooks. Formal Session packages, Session format, Agent Loop and Workspace commit semantics were not modified.
whyDraftOnlyWasInsufficient: Source review could not verify the real Dedicated Worker fetch behavior after response loss, provider replay comparison, durability acknowledgement, Workspace receipt deduplication or multiple 503 responses during a real DSH turn. Focused unit tests only establish batch framing; the new Chrome test exercises the real Host and Agent Loop.
behaviorChange: PoC backend and Browser provider share append event/byte limits. The provider splits ordered Session events into bounded UTF-8 JSON batches, coalesces live writes behind one drain, retains failed batches and reconciles `SEQ_CONFLICT` by exact seq-range readback. `flush()` and `close()` reject missing or insufficient durableThroughSeq acknowledgements. Backend tests can drop an append response after the in-memory append is accepted. Close responses include durable status and the durable event watermark.
directoryOutChangeReason: Only `docs/drafts/README.md` is outside the PoC directory; it registers this validation plan and progress. No formal package, app, root dependency or existing other PoC was modified.
consumersUpdated: Browser Session provider, PoC backend limits and fault hook, focused batch tests, backend contract test, real Chrome Worker Session/Workspace E2E, PoC README, compatibility matrix, drafts index, validation plan/progress and this ledger.
tests: Session transport Vitest 2/2 passed; backend contract tests 43/43 passed; preview build passed; Chrome Worker E2E passed with 40 sequential events, durableThroughSeq 39, 22 append requests, one Workspace commit, one Workspace receipt, one dropped committed receipt response, three injected 503 append failures, max append 7 events/13,566 bytes and no page errors/cross-origin requests. After the preview rebuild, the real Chrome compaction LLM E2E passed summary, refresh and sentinel recall (22 events; three LLM requests after recall). `pnpm run doc-sync` passed all 43 gates. A separate strict real-model file scenario executed read/write/read but the final model request returned HTTP 200 with no text/tool call and DSH recorded UPSTREAM_LLM_EMPTY; it is not a full E2E pass. Longer append outages can fail DSH flush/checkpoint before the remote writer exhausts its retry budget; automatic continuation after that failure, retry-exhaustion UX, total queue cap, local durable Session outbox, Worker termination recovery, OS crash, Safari, production backend and Session/Workspace atomicity remain unverified.
syncReplaySteps: After upstream sync, compare backend append limits with the shared `.mjs` protocol constants; inspect SessionHandle append/flush contracts, owner fencing and expectedNextSeq behavior; verify Session responses still return exact nextSeq/durableThroughSeq values. Run transport Vitest, backend contract tests, Chrome session-transport E2E, real compaction smoke, preview build and documentation gates. If formal Session append limits or response fields change, update the shared contract and assertions together. Do not add a retry id or call append acknowledgement durable without a server-backed idempotency record/flush receipt.
deleteCondition: A product Browser Session provider replaces this PoC adapter and provides bounded append batches, single-flight ordered retries, unknown-outcome reconciliation and verified durable acknowledgements with maintained product tests; or the Browser-Native PoC is removed.
status: implemented
```
