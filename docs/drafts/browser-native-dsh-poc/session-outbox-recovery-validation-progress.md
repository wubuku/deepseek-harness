---
description: "记录 Browser-Native DSH Session 本地 outbox 与 Worker 重启恢复验证的进度、命令、结果和限制。"
---

# Browser-Native DSH Session Outbox 恢复验证进度

## 当前状态

状态：实现、Chrome 故障 E2E、真实 LLM 冒烟和 preview 构建已通过；文档门禁、提交与推送待完成。

基线：`research` 分支，起始提交与 `origin/research` 同步；起始工作区干净；仅有默认主 worktree。本轮源码核对确认 DSH `session/event` 是同步 post-commit 通知，`session/flush` 是可等待的 durability checkpoint；当前 Browser Session `pendingLive` 位于 Worker 内存。

本进度只记录当前 checkout 与本轮实际运行结果。真实模型凭据只能由同源 backend 从 `docs/drafts/.env` 读取，不查看、不输出、不复制凭据。浏览器范围限于 Chrome；不把 Worker 终止模拟说成 OS 崩溃或自然 eviction。

## 里程碑

| 里程碑 | 状态 | 证据 | 下一步 |
|---|---|---|---|
| M0：持久化契约与恢复入口审查 | `complete` | 已核对 Session append/event/flush、`session-checkpoint-policy`、Browser provider 和 Workspace receipt store | 完成本地 outbox 设计与测试面 |
| M1：有界 IndexedDB outbox | `complete` | 实现连续 seq、epoch/writer fencing、精确去重、每 Session 与全局容量上限、事务失败语义及保留式 v1→v2 migration | 后续评估 quota 与敏感数据保护 |
| M2：远程 writer 接入与恢复对账 | `complete` | 远端 append 前 journal；只有 backend `durableThroughSeq` 覆盖后才清理。新 writer 按 seq 和完整事件内容核对、补齐连续尾部并 flush | Session log 继续作为唯一权威，禁止自动重放 prompt、工具和 HITL |
| M3：Chrome 故障 E2E | `complete` | [Session outbox E2E](tests/session-outbox-recovery.e2e.mjs)覆盖 Worker 终止、丢失 durable flush response、IDB abort、旧 writer fencing、容量拒绝、schema migration 与 Workspace receipt 恢复 | 不外推为 OS crash、自然 eviction 或多实例 backend |
| M4：真实 LLM 与构建回归 | `complete` | Chrome 真实模型完成 `read → write → read`、刷新后的 Session 记忆恢复和 durable Workspace 文件恢复；8 个 LLM 请求均返回 HTTP 200，Session watermark 覆盖 seq 58 | 普通内存 Workspace 对照在刷新后文件缺失；只有 durable Workspace 模式验证文件恢复 |
| M5：文档、门禁、commit、push | `in progress` | README、兼容矩阵、变更账本和 drafts 索引已更新；定向测试与 preview build 通过 | 运行文档门禁、复核 diff、提交并推送 `research` |

## 执行记录

| 日期 | 命令或检查 | 结果 | 下一步 |
|---|---|---|---|
| 2026-10-26 | `git status --short --branch`; `git worktree list`; `git log -1 --oneline` | `research` 与 `origin/research` 同步，工作区干净，仅有默认 worktree | 仅在主 worktree 实施 |
| 2026-10-26 | 阅读 `docs/AGENTS.md`、`docs/defensive-patterns/general.md`、`dsh-doc` 与 `dsh-prose-standard` | 已确认 docs 草稿的中文记录约束、生命周期竞态审查和文档验证要求 | 按本目录现有 PoC 文档实践维护中文计划与进度 |
| 2026-10-26 | 核对 `packages/core/session/src/index.ts`、`packages/session/session-persistence/src/handle.ts`、`packages/session/session-checkpoint-policy/src/index.ts`、Browser provider | `session/event` 同步且不可等待；`session/flush` 等待；模型请求和顶层工具执行前会刷新 Session；当前 Browser 待写事件仅在 Worker 内存 | 先持久化 outbox 再经由既有 flush 检查点允许模型/工具 |
| 2026-10-26 | 核对 `browser-native-workspace-store.ts`、`workspace-session-reconciliation.mjs` 和 Chrome Worker 故障 E2E | Workspace IndexedDB 保存 pending/retry/receipt；以稳定 operation id 恢复；已有 Worker termination 和 response interception 测试模板 | Session outbox 使用单独 IndexedDB 数据库，避免更改 Workspace store 版本 |
| 2026-10-26 | `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-session-transport.spec.ts`; `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 2/2 Vitest 与 43/43 backend contract tests 通过；覆盖切批/载荷限制、丢失 append response、Workspace 持久化、lease 与既有 Session recovery | 验证真实 Browser Worker 的本地 journal 和远端 watermark 对账 |
| 2026-10-26 | `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-outbox-recovery.e2e.mjs` | 通过；append 前 Worker 终止后恢复 8 个连续事件且原 prompt 的 LLM 请求数为 0；durable flush response 丢失后 marker 仅 append 一次、`durableThroughSeq=25`；IDB abort 后 marker 未到 backend 且模型请求数为 0；旧 writer、seq 冲突、空 fence 回收、容量上限与 v1→v2 migration 探针通过；无页面错误或跨源请求 | 回归 Workspace receipt 与 Session transport 行为 |
| 2026-10-26 | `pnpm exec tsc --noEmit -p packages/experimental/webworker-runtime/tsconfig.json`; `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | Worker runtime typecheck 与 preview/VFS image build 通过；输出包含既有 unsupported native platform、tsdown deprecation 和大 chunk 警告 | 在新 preview 产物上复跑恢复 E2E 与真实模型 smoke |
| 2026-10-26 | `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-receipt-recovery.e2e.mjs`; `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-transport-resilience.e2e.mjs` | 两项通过；Workspace commit 与 receipt 各一次，刷新后恢复原 operation receipt；Session 40 events 连续、`durableThroughSeq=39`，提交后丢失 response 正确对账，三次 append 503 阻止失败 prompt 到达 LLM，显式新 turn 可继续 | 通过真实 LLM smoke 确认 Worker/Host 闭环 |
| 2026-10-26 | `DSH_POC_BROWSER=chrome DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | Chrome 真实模型完成 3 个 turn；首轮按 `read → write → read` 记录 tool/result，刷新后第二轮从同一 Session 回忆 token，第三轮对原路径执行 `read`。8 个 LLM 请求尝试中 7 个返回 HTTP 200，刷新取消的活动请求为 `ERR_ABORTED`；Session 共 56 个事件且 `durableThroughSeq=55`，无页面异常或跨源请求。未启用 durable Workspace，因此刷新后文件不存在；本次 smoke 不证明 Workspace 文件恢复 | 运行文档门禁并提交 |
| 2026-10-26 | `DSH_POC_BROWSER=chrome DSH_POC_LLM=real DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ENV_FILE=docs/drafts/.env node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | Chrome 真实模型完成 3 个 turn；首轮执行 `read → write → read`，刷新后 Session 回忆 token 且 durable Workspace 的 DSH `read` 找回原文件。8/8 模型请求 HTTP 200，Workspace commits 两次均 HTTP 200，Session 共 59 个事件且 `durableThroughSeq=58`；无页面异常或跨源请求。该结果不代表生产对象存储或 OS crash | 运行文档门禁并提交 |

## 证据与限制

- 本文件中的 M0 是源码核对，不代表任何新实现或浏览器测试已经通过。
- 当前 Worker Event API 是同步 fire-and-forget；本地 journal 的错误必须由 `session/flush` 屏障观察，并阻止下一次模型请求或顶层工具副作用。
- Session 与 Workspace 使用不同存储，不具备跨存储原子事务；恢复只能按 seq、durable watermark 和稳定 operation receipt 对账。
- 未完成的模型流、工具 Promise、HITL 等待者以及 Dedicated Worker 内存状态不会被 IndexedDB outbox 恢复。
