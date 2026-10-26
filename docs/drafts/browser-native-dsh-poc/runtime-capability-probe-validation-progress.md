---
description: "记录 Browser-Native 运行期能力探测批次的实施状态、真实 Chrome/LLM 证据和未验证边界。"
---

# Browser-Native 运行期能力探测验证进度

## 当前状态

状态：运行期探针、Worker 启动门、Chrome 故障矩阵、真实 LLM 冒烟和文档门禁已完成；本批 commit 与 push 待完成。

基线：`research` 分支与 `origin/research` 同步；Session outbox 批次已提交推送；工作区干净且只有主 worktree。Safari/WebKit 暂停，本批只运行 Chrome。

## 里程碑

| 里程碑 | 状态 | 证据 | 下一步 |
|---|---|---|---|
| M0：候选审查与 readiness 契约 | `complete` | 已核对实际 v2 health/config 字段与 backend 初始化顺序；[验证计划](runtime-capability-probe-validation-plan.md)不再假定 endpoint 提供独立 Session/Workspace readiness 字段 | 实现 IndexedDB、backend 与可选 OPFS probes |
| M1：实际运行期探针 | `complete` | Outbox canary 在真实 Worker IndexedDB 中完成 put/delete transaction；同源 health/config 校验；durable 模式真实 OPFS SyncAccessHandle write/read/truncate/delete；Vitest 4/4 | 复核 Host handshake 的调用顺序与失败回报 |
| M2：Worker Host 启动门 | `complete` | preview 在 `connectWorkerHost()` 前等待 Worker probe；Worker 对已请求但未通过的 probe 拒绝 Host init；Web TS 检查和 preview/VFS build 通过 | 以真实 Chrome 验证故障与恢复，不把构建结果当运行证据 |
| M3：真实 Chrome 故障矩阵 | `complete` | Chrome 155 覆盖 backend 503/错协议、IDB transaction abort、durable OPFS probe seam 失败、memory 模式跳过 OPFS；所有失败路径没有 Session/LLM 请求，恢复后 scripted turn 成功 | 执行真实 LLM durable Workspace smoke 与 outbox 回归 |
| M4：真实 LLM 与文档交付 | `complete` | Chrome 真实 LLM 3 turn、8/8 模型请求 200，`read → write → read`，刷新后 Session/文件恢复，`durableThroughSeq=58`；`test:docs` 21/21、`doc-sync` 43/43 | 最终 diff review 后提交并推送 |

## 执行记录

| 日期 | 命令或检查 | 结果 | 下一步 |
|---|---|---|---|
| 2026-10-26 | `git status --short --branch`; `git worktree list`; `git rev-parse HEAD origin/research` | `research` 与远端同步，工作区干净；只有默认主 worktree | 在主 worktree 按计划实现 |
| 2026-10-26 | 阅读 `dsh-tui-reference-architecture-memo.md`、Browser capability preflight、Session outbox、Worker init 与 backend v2 health/config 实现 | 静态 capability manifest 将历史 Chrome probe ID 写成 `live` evidence；Worker init 目前只跑静态 preflight，随后创建 Workspace/Host；backend 在 SessionStore、WorkspaceStore 与 LLM config 加载后才监听，health/config 不含凭据 | 由 preview 在 Host handshake 前等待 Worker 运行期 probe；把 health/config 当作启动和协议可达检查，不外推为运行中存储保证 |
| 2026-10-26 | `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-runtime-probes.spec.ts` | 4/4 通过，覆盖 backend 字段/版本、敏感 body 不回显、outbox 失败汇总和 OPFS 可选条件 | 继续跑 browser E2E |
| 2026-10-26 | `pnpm exec tsc --noEmit -p apps/web/tsconfig.json`; `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 类型检查和 Vite/Worker/VFS image build 通过；构建保留现有 unsupported native-platform、tsdown deprecation 和大 chunk warnings | 在 Chrome 启动真实 preview |
| 2026-10-26 | `node docs/drafts/browser-native-dsh-poc/tests/runtime-capability-probes.e2e.mjs` | Chrome 155：backend 503/协议错误、真实 IndexedDB abort 和 durable OPFS probe seam 故障均阻止启动；memory Workspace 跳过 OPFS；失败前 0 Session/LLM 请求，恢复后 1 scripted turn，0 外部请求 | 跑现有 backend 与 Session outbox 回归 |
| 2026-10-26 | `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs`; `node docs/drafts/browser-native-dsh-poc/tests/session-outbox-recovery.e2e.mjs` | backend contract 43/43；Chrome outbox Worker termination、durable response loss、IDB abort、schema migration、fencing 与容量测试通过；中断 prompt 未被重放 | 运行真实 provider smoke |
| 2026-10-26 | `env DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_REFRESH_CYCLES=1 DSH_POC_TURN_TIMEOUT_MS=600000 node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | Chrome 155 / `gpt-5.6-sol`：3 turn，8/8 模型请求 HTTP 200；首轮 `read → write → read`，刷新后同 Session 记忆与 Workspace 文件恢复；两次 Workspace commit HTTP 200，`durableThroughSeq=58`，模型凭据检查和同源请求检查通过 | 更新 README、兼容矩阵、索引、change ledger，运行文档门禁 |
| 2026-10-26 | `node docs/drafts/browser-native-dsh-poc/tests/runtime-capability-probes.e2e.mjs` | Chrome 155 复跑通过；backend 503/协议错误、真实 IndexedDB abort、durable OPFS 故障都 fail closed；失败诊断不含 `PROBE_SECRET_MUST_NOT_LEAK`，恢复后 scripted turn 仅有一次模型请求，外部请求为 0 | 运行最终 focused tests 与文档门禁 |
| 2026-10-26 | `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-runtime-probes.spec.ts`; `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | probe 单测 4/4、backend contract tests 43/43 通过 | 完成文档门禁和差异审查 |
| 2026-10-26 | `pnpm run test:docs`; `pnpm run doc-sync`; `pnpm run change-scope --base origin/research`; `git diff --check` | test:docs 21/21、doc-sync 43/43；change-scope 仅列出本批 preview 和 Browser-Native PoC 文件；diff check 通过 | commit/push 本批后开始下一批评估 |

## 证据边界

- 本文件只记录当前 checkout 的验证。计划条目不代表实现或 E2E 已通过。
- backend probe 校验现有 health/config 的 HTTP、协议与非敏感字段；route 可用不证明真实 LLM upstream 可用，也不保证 Session/Workspace 后续写入成功。
- IndexedDB canary 只证明 probe 时一次 transaction 成功；未验证自然 eviction、OS/磁盘 crash 或用户清除后的数据保留。
- OPFS 成功 probe 在 Chrome Worker 内实际使用 SyncAccessHandle；OPFS 失败 E2E 在 probe seam 注入，不能外推为自然浏览器 API 故障矩阵。memory Workspace 跳过 OPFS。
- 任何 probe failure 都不得被降级为“工具已发布但稍后再试”；必须保持 fail-closed 或明确标记为 degraded。
