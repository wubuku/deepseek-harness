---
description: "记录 Browser-Native DSH 真实工具 Stop、编辑中 Worker 终止、Session/Workspace 恢复与真实模型 smoke 的实际证据。"
---

# Browser-Native 工具取消与编辑中断验证进度

## 当前状态

状态：实现、scripted Chrome 验证和独立真实 LLM 普通文件 smoke 完成。Safari/WebKit 暂停，本批只验收真实 Chrome。

基线：`research` 分支起始时与 `origin/research` 一致、工作区干净且只有主 worktree。运行 Chrome 为 155.0.8059.85。设计和验收定义见[本批计划](next-worker-tool-cancellation-validation-plan.md)。

## 里程碑

| 里程碑 | 状态 | 证据 | 下一步 |
|---|---|---|---|
| M0：源码与事件时序 | `complete` | 复用正式 DSH `AbortSignal`、真实工具 call/result、OPFS copy-on-write staging 和刷新后 unknown settlement；测试 seam 只控制 yield 和报告工具阶段 | 无 |
| M1：真实 Stop 取消 `grep` 与 `edit` | `complete` | Chrome scripted E2E 点击官方 Stop；两个 turn 均为 `aborted`，无成功工具结果、额外 Workspace commit 或 receipt；同 Session 后续 `grep` 成功 | 单次 Chrome 时延不是 SLA；真实模型 Stop 不属于该场景 |
| M2：编辑中 Worker 终止与恢复 | `complete` | Chrome 在 8 MiB edit 的 `copy-prefix` 阶段终止真实 Worker；刷新后原 call 仅出现一次并结算 `TOOL_OUTCOME_UNKNOWN`，没有额外 LLM 请求，OPFS staging 被清理 | 不代表 OS/磁盘崩溃或浏览器自然关闭 |
| M3：中断后 Session continuation | `complete` | 三个场景均在同一 Session 执行新 turn；源文件 SHA-256 与 Workspace revision 保持不变，无页面/Worker 错误或跨源请求 | 不恢复旧 Worker Promise；unknown 工具不会重放 |
| M4：真实 LLM 与文档交付 | `complete` | 构建、Web typecheck、Vitest、backend tests、三项 Chrome E2E 和真实模型 smoke 通过；最终 smoke 未设置代理环境变量。文档门禁已复跑通过 | 无；真实模型只验证普通文件工具和刷新恢复，不覆盖模型自主取消或 Worker 故障 |

## 执行记录

| 日期 | 命令或检查 | 结果 | 下一步 |
|---|---|---|---|
| 2026-10-26 | `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools.spec.ts` | 1 个文件、7 项通过 | 增加 Worker 生命周期和 Workspace 回归 |
| 2026-10-26 | `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-execution-lifecycle.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts` | 3 个文件、22 项通过 | 执行真实 Chrome Worker 场景 |
| 2026-10-26 | `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | backend contract tests 47/47 通过 | 执行 preview build |
| 2026-10-26 | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 成功；构建器报告既有平台依赖和大 chunk 警告，没有 build error | 执行三项 scripted Chrome E2E |
| 2026-10-26 | `DSH_POC_TOOL_CANCELLATION_SCENARIO=stop-grep node docs/drafts/browser-native-dsh-poc/tests/browser-native-tool-cancellation.e2e.mjs` | Chrome 155.0.8059.85 通过；8 MiB grep，UI Stop 到观测 turn terminal 为 134 ms，最大帧间隔 16.8 ms，后续 turn 为 2；0 page/worker error、0 跨源请求 | 继续 OPFS edit Stop |
| 2026-10-26 | `DSH_POC_TOOL_CANCELLATION_SCENARIO=stop-edit node docs/drafts/browser-native-dsh-poc/tests/browser-native-tool-cancellation.e2e.mjs` | Chrome 通过；8 MiB edit 在 `copy-prefix` Stop，137 ms 观测 turn terminal，最大帧间隔 33.224 ms；原文件 hash、revision、commit/receipt 语义保持；同 Session 可继续 | 继续 Worker terminate/reload |
| 2026-10-26 | `DSH_POC_TOOL_CANCELLATION_SCENARIO=crash-edit node docs/drafts/browser-native-dsh-poc/tests/browser-native-tool-cancellation.e2e.mjs` | Chrome 通过；`copy-prefix` 终止后刷新结算 `TOOL_OUTCOME_UNKNOWN`，无重放模型请求，staging 清空；后续 turn 为 2，最大帧间隔 16.8 ms | 运行真实 LLM smoke |
| 2026-10-26 | `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/browser-native-file-tools-cancel.e2e.mjs` | 既有 helper cancellation Chrome 回归通过；真实 Worker grep 被取消，同一执行环境的后续 turn 成功，0 page/worker error、0 跨源请求 | 完成真实 LLM 冒烟与交付记录 |
| 2026-10-26 | `env DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_REFRESH_CYCLES=1 DSH_POC_TURN_TIMEOUT_MS=600000 node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | 未通过：单次上游请求超出 backend 默认 60 秒，返回 `UPSTREAM_LLM_TIMEOUT`；该次命令未设置手册要求的 180 秒单请求上限 | 历史失败尝试；后续提高单请求 timeout 后重跑 |
| 2026-10-26 | `env https_proxy=http://127.0.0.1:9981 http_proxy=http://127.0.0.1:9981 all_proxy=socks5://127.0.0.1:9981 DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_REFRESH_CYCLES=1 DSH_POC_LLM_TIMEOUT_MS=180000 DSH_POC_TURN_TIMEOUT_MS=600000 node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs`; `nc -vz -w 2 127.0.0.1 9981` | 未通过：E2E 收到 `UPSTREAM_LLM_UNAVAILABLE`/HTTP 502；本机代理端口 connection refused，未观察到真实模型 turn 完成 | 历史失败尝试；无代理变量的成功重跑见下一条 |
| 2026-10-26 | `env DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_REFRESH_CYCLES=1 DSH_POC_LLM_TIMEOUT_MS=180000 DSH_POC_TURN_TIMEOUT_MS=600000 node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | 通过；未设置代理变量。真实模型 `gpt-5.6-sol` 完成 `read → write → read`，刷新后同一 Session 恢复记忆和 Workspace 文件；58 个 Session events、`durableThroughSeq=57`，7 个模型请求均 HTTP 200 且只访问同源 backend，无页面错误。诊断中的 `visibleDomStreamSamples=1` 不作为流式 UI 帧率证据 | 该 smoke 不验证真实模型选择 Stop、工具取消或 Worker 终止 |
| 2026-10-26 | `pnpm exec tsc -p apps/web/tsconfig.json --noEmit` | 通过 | 完成文档并运行文档门禁 |
| 2026-10-26 | `pnpm run test:docs` | 21/21 通过；此前唯一失败是 progress 中记录 commit hash，被 repository-reference gate 拒绝；删除 hash 后复跑通过 | 执行完整文档门禁 |
| 2026-10-26 | `pnpm run doc-sync` | 43/43 通过，包含 documentation build 与 doc-typecheck；本次文档更正后再次复跑 | 复核提交范围与最终 diff |
| 2026-10-26 | `git diff --check`; `pnpm run change-scope --base origin/research` | whitespace 检查通过；范围报告仅含本批 app 修复和 PoC 文件，未发现其他 worktree 或额外 WIP | 完成当前 checkout 的提交前复核 |

## 已知限制

- 本批三个中断 E2E 使用 scripted LLM 来确定工具选择和中断窗口；独立真实 LLM smoke 通过普通文件读写和刷新恢复，但没有验证真实模型触发取消或 Worker 故障。
- Stop-to-terminal 数值是从页面 click 到测试轮询观察到持久化 `turn/end` 的端到端观测时长，不是精确的 Worker abort latency。三次 Chrome 样本的最大动画帧间隔为 16.8、33.224、16.8 ms；单机单次场景不构成 UI 性能 SLA。
- Chrome Worker termination 在本地 OPFS copy-on-write stage 注入；它不代表 OS/磁盘 crash、真实浏览器进程崩溃、自然 eviction 或 Worker Promise 可恢复。
- 自然 eviction、OS/磁盘崩溃、Safari/WebKit、生产 backend 和后台执行不属于本批证据。
- 性能观察尚未采集；后续结果仅适用于实际记录的 Chrome、设备和文件大小。
