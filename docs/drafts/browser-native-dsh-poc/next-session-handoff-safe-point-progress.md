---
description: "记录 Browser-Native DSH handoff 安全点验证的基线、实施、Chrome 证据、失败与未覆盖边界。"
---

# Browser-Native DSH handoff 安全点验证进度

## 当前状态

状态：M0-M4 完成。本批在 `research` 主 worktree 进行；使用现有主 worktree，没有创建隔离 worktree。候选范围、风险依据和退出标准见[验证计划](next-session-handoff-safe-point-plan.md)。

## 里程碑

| 里程碑 | 状态 | 证据 | 下一步 |
| --- | --- | --- | --- |
| M0：事件语义与基线 | `complete` | 核对 `SessionEventMap`、`ToolCallRecovery`、browser-native Session persistence 与 backend handoff；handoff Vitest 4/4、backend tests 35/35 通过 | 实现服务端 event-log 状态折叠，并补回归用例 |
| M1：服务端安全点派生 | `complete` | backend 在 per-Session queue 内扫描 turn/step/tool lifecycle；拒绝活动工作和损坏配对；兼容已结算 tool result 的历史 compaction replacement | 扩充 DSH event 合同回归及 append/handoff 竞态 |
| M2：合同与并发矩阵 | `complete` | backend contract 42/42；含空 pending 伪报、活动 turn/step、未结算 tool request/call、孤立 result/replacement、error result、历史 compaction replacement、跨 turn 重复 call ID、extension event 与两种串行锁顺序 | 运行真实 Chrome Worker handoff E2E |
| M3：真实 Chrome 活跃 turn | `complete` | Google Chrome 真实 Dedicated Worker/DSH Host 观察活动 turn；空 pending handoff 返回 `HANDOFF_BUSY`；原 turn 完成、模型请求计数为 1；后续 response-drop/reclaim/stale append 仍通过 | 更新 README、兼容矩阵、变更账本并运行回归/gates |
| M4：分页兼容、文档、回归和交付 | `complete` | handoff E2E 暴露 `SessionHandle.read()` 默认读取剩余日志与 backend 2048 条单页限制不兼容；远端 reader 现分页聚合并核对 seq/ownership state。重建 preview 后 Session 与 Workspace Chrome E2E 通过；backend 42/42、Vitest 7/7、typecheck、doc quick 21/21、doc-sync 43/43 通过 | 已具备提交与推送条件 |

## 事实基线

- DSH 在 `turn/start` 与匹配的 `turn/end` 之间拥有活动 turn；`step/start`、`step/end` 描述 turn 内模型请求和工具步骤。
- `assistant/message` 可以包含尚未 dispatch 的 tool-call block；正式 `ToolCallRecovery` 使用 block id、`tool/call` 的 callId 和 `tool/result.message.source.callId` 结算工具。
- 当前 `backend-v2.mjs` handoff 校验 `checkpoint.nextSessionSeq`、epoch 与客户端 pending ID 数组，但没有从 `session.events` 派生 turn/step/tool settlement。
- Session backend 对每个 Session 使用进程内 exclusive queue；同一 backend 内 append/handoff 可以确定串行，不能据此推断多实例一致性。
- 既有 handoff 是 PoC Session 写权切换；Workspace lease、Page Worker 生命周期和 Cloud Agent 仍是独立机制。

## 命令与结果

| 命令 | 结果 |
| --- | --- |
| `node --version` | `v24.6.0` |
| `pnpm --version` | `11.28.5` |
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-handoff.spec.ts` | 通过；1 个文件、4 项测试。 |
| `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 初次基线通过 35 项；加入 event-log scanner 与合同矩阵后通过 42 项。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-owner-handoff.e2e.mjs` | 真实 Chrome 通过；活动 turn handoff 返回 `HANDOFF_BUSY`，模型请求计数为 1，turn 正常完成；随后旧 handoff response-loss、tokenless replay、lease reclaim、epoch fencing 和 stale append 409 通过。 |
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-session-read.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-handoff.spec.ts` | 通过；2 个文件、7 项测试，含 4201 条事件多页读取、backend 短页续读、空尾部与损坏分页拒绝。 |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；Worker runtime、packer、Vite preview 和 VFS image 均构建成功。出现不支持平台包告警及 Vite chunk size 告警，不影响构建。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-owner-handoff.e2e.mjs` | 真实 Chrome 通过；活动 turn handoff 返回 `HANDOFF_BUSY`，模型请求计数为 1，turn 正常完成；随后旧 handoff response-loss、tokenless replay、lease reclaim、epoch fencing 和 stale append 409 通过。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/workspace-worker-handoff.e2e.mjs` | 首次使用旧 preview bundle 时，第二 Worker history hydrate 因 `length > 2048` 失败；重建 preview 并纳入分页适配器后通过。第二 Worker 恢复同一 Session、完成第二次 DSH 文件工具 turn，Workspace revision 到 2；旧 lease renew 与 commit 均为 409，页面错误和外部请求均为 0。 |
| `pnpm exec tsc --ignoreConfig --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --types vitest/globals docs/drafts/browser-native-dsh-poc/browser-native-session-read.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-session-read.spec.ts` | 通过；初次未加 `--ignoreConfig` 的命令由 TypeScript 以 TS5112 拒绝，补参数后通过。 |
| `pnpm run typecheck` | 通过；5 个 Host/Client compiler、Typert 与 aggregate-check gate 全部通过。 |
| `pnpm run test:docs` | 第一次发现变更账本含禁止的短 commit hash；移除 hash 后重跑通过，21/21 gate。 |
| `pnpm run doc-sync` | 通过；43/43 gate。 |

## 当前证据边界

- backend queue 能串行化已到达 backend 的 Session append 与 handoff；服务端事件折叠只能判断已追加到该 Session 的事件，不能观察 Worker 中尚未 flush/上传的本地事件，也不能单独证明本地工具 Promise 已 quiescent。
- Browser Native 的 handoff 调用方仍需先停止新工作并 flush Session 写入；本批验证服务端拒绝“event log 已表明仍在运行”的 handoff，不把它说成对恶意 bearer 持有者或尚未上传事件的完整 fencing。
- 真实 Chrome 活跃 turn 测试将等待 backend read 观察到目标 `turn/start` 后再提交空 pending checkpoint，避免把请求时序误当成服务端状态证据。
- Session 远端 reader 将 DSH `read(offset, length?)` 映射为最多 2048 条一页的后端请求，按 seq 连续聚合到调用方请求长度或日志尾部；backend 的单页 byte limit 仍可能拒绝包含单个超大事件的 page，聚合读取也仍会在 Worker 中持有返回的完整数组。
- DSH Agent Loop 会先追加 `turn/start`，之后才追加对应的 `user/message`；真实 E2E 不可按 user event 找 turn 起点。Compaction 可追加以旧 `tool/result` seq 为源的 `surfaceOp: replace`，scanner 仅在已验证来源和 replacement range 指向该 call 最近的已结算结果时接受。tool-call ID 允许在不同 turn/step 重用，scanner 以 `(turn, step, callId)` 配对。
- scripted LLM 的 delayed stream 只提供可控的真实 Worker 活跃期，不是真实模型能力或延迟 SLA 证据。本批不重跑真实 LLM，因为该问题在 backend 已追加的 DSH event 状态上可独立、确定地验证。

## 未覆盖范围

本批不验证多实例 backend、生产账户/租户授权、Session 与 Workspace 的跨存储原子性、Cloud Durable Worker、Safari/WebKit、自然 eviction 或 OS/磁盘崩溃。真实 Chrome scripted LLM 只用于确定性地保持一个 DSH turn 活跃，不替代真实 LLM 能力验证。

初次 Chrome 探针曾按 `user/message` 定位 turn，超时后观测到该 turn 已完整结束；改为从 backend 最新未闭合 `turn/start` 识别当前 turn 后通过。该失败来自测试对 Session 事件顺序的错误假设，不是产品断言失败。
