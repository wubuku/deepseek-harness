---
description: "记录 Browser-Native DSH 跨 Session 与 Workspace 工具恢复验证的实际进度、命令和边界。"
---

# Browser-Native DSH 跨存储工具恢复验证进度

## 当前状态

状态：M0-M4 验证完成；真实 Chrome/LLM smoke、PoC 定向回归、typecheck、preview build、`test:docs`（21/21）和 `doc-sync`（43/43）已通过。pre-push typecheck hook、commit 与 push 仍待执行。当前工作位于 `research` 主 worktree；起始基线与 `origin/research` 同步且干净，本轮未创建隔离 worktree。Chrome 是本批唯一浏览器目标。

本记录只描述当前 checkout 和实际命令结果。Scripted 故障测试是持久化时序证据，不是真实 LLM 证据。Session 与 Workspace 仍是独立存储；不声称跨存储原子事务或普遍 exactly-once。

## 里程碑

| 里程碑 | 状态 | 结果 | 下一步 |
|---|---|---|---|
| M0：既有证据与协议核对 | `complete` | 复核 Workspace commit unknown、receipt append 前终止、Session outbox durable response loss 与 handoff 的既有覆盖；修正 Node 测试夹具的 Workspace 与 Session Path-scoped principal cookie，未放宽 backend 鉴权。 | 完成。 |
| M1：receipt 完整身份匹配 | `passed` | Provider 对账要求 originating `tool/call` 与 Session receipt、Workspace commit receipt 的完整身份字段一致；缺少 call 或任一字段错配均 fail closed。负例覆盖 Session、turn、step、callId、toolName、seq、operationId、workspace、revisions、digest、paths 和 replay 标志。 | 完成。 |
| M2：durable receipt flush 响应丢失 | `passed` | Chrome scripted DSH `write` 后，backend 已将 receipt seq 18 flush 至 durable watermark；随后 Worker 被终止、同一 dataDir backend 重启且 flush response 被丢弃。刷新后 Session watermark 为 21，receipt/call/result 各一份，Workspace revision 与 commit 各为 1，outbox 清空。 | 完成。 |
| M3：真实 LLM 与回归 | `passed` | 真实 `gpt-5.6-sol` Chrome smoke 完成 3 轮、刷新后继续，执行 `read → write → read`、跨轮记忆和刷新后文件读取；59 个 Session events、durable watermark 58、8/8 LLM HTTP 200、同源 LLM 请求、无 page error。首次可见 assistant UI 更新约 103 秒，而首个 Session 文本 chunk 约 6.6 秒；另观测到 compaction capacity warning、若干刷新取消请求和三个 preview 路由的 404，故本次证明闭环可运行，不代表首屏流式体验或 preview 路由无告警。 | 完成。 |
| M4：文档与交付 | `passed` | README、兼容矩阵、drafts 索引和 change ledger 已更新；`pnpm run test:docs` 21/21、`pnpm run doc-sync` 43/43 均通过。 | 执行提交、push 与远端/工作区复核。 |

## 执行记录

| 日期 | 命令或检查 | 结果 | 后续 |
|---|---|---|---|
| 2026-10-28 | `git status --short --branch`; `git worktree list`; `git rev-parse HEAD origin/research` | `research` 与 `origin/research` 同步；初始工作区只有本批计划和进度两个未跟踪文件；只有主 worktree。 | 继续主工作区，不接触其他 WIP。 |
| 2026-10-28 | 阅读 PoC provider、Workspace store、reconciliation、backend、Session outbox、receipt recovery、unknown commit recovery 和 execution handoff 测试 | 确认基础 append/flush response loss 已有覆盖；新增缺口是 Workspace receipt 已 durable、flush 确认丢失并同时重建 Worker/backend。Provider 去重原先只比较 callId、seq 与 workspaceId 等部分字段。 | 将本批聚焦在 durable receipt 重启链和完整 receipt identity。 |
| 2026-10-28 | `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs docs/drafts/browser-native-dsh-poc/tests/session-workspace-reconciliation.test.mjs` | backend 合同通过；reconciliation 2 项失败，均因测试夹具只转发 Workspace cookie，而 Session API 已使用 Path-scoped Session principal cookie。 | 修正 Node 测试夹具，不放宽 backend 身份验证。 |
| 2026-10-28 | `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-execution-handoff.spec.ts` | 2 个文件、24/24 通过。Vite 提示 `vite-tsconfig-paths` 插件现可由原生配置替代；与本批结果无关。 | 实现完整 receipt 匹配。 |
| 2026-10-28 | `node --test docs/drafts/browser-native-dsh-poc/tests/session-workspace-reconciliation.test.mjs` | 修正身份 cookie 夹具并增加字段错配测试后 4/4 通过。 | 创建真实 Worker/Host 故障场景。 |
| 2026-10-28 | `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-receipt-recovery.e2e.mjs` | 首次尝试在 backend listener 重启后由页面发起额外 identity fetch，浏览器连接失败；故障注入本身已使 receipt durable 并重启 backend。此运行标为失败，不计通过。 | 测试探针改为从 backend 使用浏览器 Session cookie 直接读取 Session 权威记录，并从已观测 commit 取 Workspace ID。 |
| 2026-10-28 | `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-receipt-recovery.e2e.mjs` | Chrome scripted 场景通过；backend 成功 flush 到 `durableThroughSeq=18` 后响应丢失，旧 Worker 终止、同 dataDir backend 重启。刷新后 Session seq 连续且 watermark 为 21，tool call/result/receipt 各一份，Workspace commit/revision 分别为 1，receipt outbox 清空，无页面错误。 | 复跑实现后的全部定向合同与恢复测试。 |
| 2026-10-28 | `DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_TURN_TIMEOUT_MS=600000 DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | 真实 `gpt-5.6-sol` smoke 通过：3 轮、一次刷新、`read → write → read`、跨轮记忆与刷新后文件读取；59 个 Session events、`durableThroughSeq=58`、8/8 LLM HTTP 200，LLM 请求仅发往同源 backend，无 page error。运行记录另含首个 Session 文本 chunk 约 6.6 秒、首个可见 assistant 更新约 103 秒；观察到 compaction context-capacity warning、刷新引起的 `ERR_ABORTED` 和 `/open-in-app/apps`、`/api/changes.summary`、`/api/present.host` 的 404。这些告警不使本次闭环失败，但流式 UI 响应性和对应 preview 路由仍需独立核查。未输出或读取任何凭据值。 | 真实模型 smoke 不是 durable receipt fault E2E 的替代证据。 |
| 2026-10-28 | `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/execution-owner-handoff.e2e.mjs` | 第二 Worker 当前合法进入 `read-only` observer 而非旧测试唯一等待的 `lease-conflict`；更新断言后 normal 与 session-response-lost 场景通过，确认未取得写权前无 LLM 请求。第三个 workspace-release-response-lost 场景在同一进程串跑时被 preview notice 覆盖导致打开工作区超时。 | 将第三场景独立执行。 |
| 2026-10-28 | `DSH_POC_BROWSER=chrome DSH_POC_HANDOFF_SCENARIO=workspace-release-response-lost DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/execution-owner-handoff.e2e.mjs` | 独立 Chrome 场景通过：handoff 状态 `workspace-release-unknown`，Session epoch 与 Workspace fencing 均递增；2 个 DSH tool call、2 条 receipt、2 次 Workspace commit，旧 token 请求均 409，无 page error、无跨源请求。 | 交接回归的三种状态均有通过证据；组合运行的 preview notice 干扰保留为测试运行限制。 |
| 2026-10-28 | `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs docs/drafts/browser-native-dsh-poc/tests/session-workspace-reconciliation.test.mjs` | backend 与 reconciliation 合计 52/52 通过。 | 完成。 |
| 2026-10-28 | `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-execution-handoff.spec.ts` | 两个文件 24/24 通过。Vite 输出 `vite-tsconfig-paths` 可由原生 `resolve.tsconfigPaths` 取代的既有提示。 | 完成。 |
| 2026-10-28 | `pnpm run typecheck`; `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`; `node --check` changed `.mjs`; `git diff --check` | typecheck 5/5、preview build 和语法/差异检查通过；build 有既存 native platform、弃用和大 chunk warnings。 | 完成。 |
| 2026-10-28 | `pnpm run test:docs` | doc-quick 21/21 gates 通过，包括 Markdown links/wrap、translation pairing、type equivalence、repository references、README gates 与 doc budgets。 | 完成。 |
| 2026-10-28 | `pnpm run doc-sync` | 43/43 gates 通过，包括 doc-typecheck、documentation build、generated catalogs、subsystem pages、repository references、site checks 与 quick documentation gates。 | 完成。 |
| 2026-10-28 | `pnpm --silent run change-scope --base origin/research` | 确认 HEAD 与 `origin/research` 同为 `f844b58c4119e6a424157e9558dd9cc54778ff45`；变更均为本批 PoC 源码、测试、计划/进度与索引/README/账本。 | 按 pre-push skill 再做 diff/status 复核，随后提交。 |

## 当前结论与限制

- 本批通过一条 Chrome/scripted 路径证明当前 PoC 能在 durable receipt flush 响应丢失且 backend 重启后，使用 Session 与 Workspace 记录清除本地 receipt outbox，而不重复 commit 或 receipt append。
- 测试检查了 backend append request、flush watermark、重启后的 Session readback、Workspace operation receipt、IndexedDB outbox 和 commit 计数；它不证明 Session 与 Workspace 存在原子事务。
- 完整 receipt 对账增加了 `sessionId`、turn、step、callId、toolName、toolCallSeq、operationId、workspaceId、baseRevision、revision、manifestDigest、paths 与 replay 状态检查。
- 真实 LLM smoke 只证明正常文件工具与刷新恢复路径可运行；它不验证真实模型触发 durable receipt fault，也不证明可接受的可见流式响应时间。
- 本次 smoke 虽以 8/8 LLM HTTP 200 和无 page error 结束，仍记录首个可见 assistant 更新约 103 秒、compaction capacity warning 和三个 preview 404；这些观察不属于跨存储恢复通过条件，需在独立 UI/preview 清理中复核。
- Execution-owner handoff 的 normal、Session response lost 与 Workspace release response lost 三个 scripted 状态均通过；第三种状态需单独启动脚本，因为三个场景同进程运行时 preview notice 覆盖了 Workspace chooser。
- `test:docs` 与 `doc-sync` 均通过；本记录不把文档门禁或 preview build 当作真实浏览器运行证据。
- 自然 storage eviction、OS/磁盘崩溃、多实例生产 backend、Safari/WebKit、生产 SaaS 授权和普遍 exactly-once 未验证。
