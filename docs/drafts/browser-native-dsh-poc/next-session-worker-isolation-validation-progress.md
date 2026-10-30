---
description: "记录 Browser-Native DSH 多 Session Worker 拓扑实验的执行证据、失败和适用限制。"
---

# 多 Session Worker 隔离验证进度

## 当前状态

状态：M0-M6 完成。目标、候选范围和退出条件见[验证计划](next-session-worker-isolation-validation-plan.md)。本批在 `research` 主工作区进行，没有隔离 worktree；`.archify/` 是本批外 WIP，未读取、修改、暂存或提交该目录。

## 基线

| 项目 | 证据 |
|---|---|
| DSH-TUI 启发 | Session Mount Runtime 允许一个 TUI 进程挂载多个活动 Agent；park 只切换投影，进程退出会停止它拥有的执行；跨进程占用检查和实际写锁分开。 |
| 当前 Browser Worker | `apps/web/src/preview.ts` 每页面 realm 创建一个 `dsh-host` Worker；`connectWorkerHost()` 将 transport 安装在 realm 全局。 |
| 同 Worker Agent | `same-worker-multi-session-validation-progress.md` 记录 Chrome 156 中一个 Worker 承载三个真实 Agent，异步模型请求可并行等待、单 Agent 取消隔离。 |
| CPU 阻塞 | `single-worker-cpu-contention-validation-progress.md` 记录同步 CPU 工具阻塞同 Worker 的 peer Session 和 cancel 消息；主线程仍可动画；合作式 yield 可让 peer 推进。 |
| Worker 资源 | `browser-worker-placement-capacity.e2e.mjs` 记录 1/4/8 个独立 context/Worker 的 scripted 文件 turn 与 Chrome 进程指标；它不是同一 BrowserContext 的单 Session/Host 专项测量。 |
| 生命周期覆盖 | `worker-lifecycle-recovery.e2e.mjs` 与 Chrome process crash E2E 覆盖 Workspace retry 恢复；尚未证明活动 Agent turn 被 Worker 终止后的 Session 恢复。 |
| 工作区基线 | `git status --short --branch` 显示 `research...origin/research`，唯一未跟踪路径为 `.archify/`；`git worktree list` 只有主 worktree。 |

## 里程碑

| 里程碑 | 状态 | 命令/证据 | 结果与下一步 |
|---|---|---|---|
| M0：候选盘点与源码核对 | `complete` | 阅读 TUI Session Mount Runtime 与 Agent View projection；核对 PoC 同 Worker、CPU contention、Worker placement、Workspace crash 测试和 `connectWorkerHost()` | 选定 Worker topology 阻塞隔离、强制终止影响范围、Session durable prefix 与 1/2/4 Host 资源诊断。 |
| M1：验证计划与进度 | `complete` | 新增[验证计划](next-session-worker-isolation-validation-plan.md)与本进度记录 | 仅扩展 validation profile；明确每页面 realm 一个 Worker 的证据限制，不实现正式 Worker pool。 |
| M2：单 Agent validation probe | `complete` | `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-multi-agent-probe.spec.ts` | 5/5 通过；覆盖单 Agent Host、并行多 Agent、取消、重复身份、创建失败 rollback 和 1–8 Agent 限制。Worker request validator 与 probe limit 同步。 |
| M3：拓扑阻塞/终止对照 | `complete` | Chrome 156.0.8078.79，`tests/session-worker-isolation.e2e.mjs` | 共享 Worker 终止后两个 Session 都保留 prompt、CPU Session 有 1 个未结算 tool call、两者都无 terminal event。独立 topology 在同 BrowserContext 两个页面各运行一个 Host Worker；peer 在 CPU tool 仍运行时完成，终止 CPU Worker 只留下该 Session 未结算 tool call，peer 有唯一 completed turn。无重复 prompt、工具结果伪造、页面/Worker error 或跨源请求。 |
| M4：1/2/4 Worker 资源诊断 | `complete` | `session-worker-isolation-chrome-results.json` | 同源 scripted turn 的 1、2、4 Worker 各运行三轮；21 个容量 turn 均按 Session 对账。Chrome 进程 RSS 中位数约 1.56/1.93/2.04 GiB，启动时间和 RSS 分布波动明显；不作为每 Worker heap、生产容量或 SLA。 |
| M5：真实 LLM smoke 与回归 | `complete` | `runtime-validation.e2e.mjs`，Chrome 156.0.8078.79，`gpt-5.6-sol` | durable Workspace 下普通 `read → write → read`、刷新后同 Session 续聊通过；59 events、`durableThroughSeq=58`、8/8 同源模型 HTTP 200、2/2 Workspace commit HTTP 200。该 smoke 不验证真实模型多 Agent 并发或 Worker 拓扑容量。 |
| M6：定向构建、文档与交付 | `complete with unrelated repository-reference failure` | Probe Vitest 5/5、E2E 语法、Web TypeScript、Preview build、完整 build 9/9、Markdown wrap/link 和 doc-typecheck 通过。`test:docs` 为 20/21、`doc-sync` 为 42/43；两者唯一失败均为 repository-reference gate 扫描到本批外 `.archify/` 中 5 个提交号，未改动该目录。README、兼容矩阵、drafts 索引和 change ledger 已更新；仅本批文件提交并推送到 `origin/research`。 | 本批结束并暂停。 |

## 执行记录

| 日期 | 命令/操作 | 结果 | 下一步 |
|---|---|---|---|
| 2026-10-31 | 阅读 DSH-TUI Session Mount Runtime、`agent-view-projection.ts`、DSH AgentRegistry、Browser Worker placement/CPU contention 与 lifecycle E2E | TUI 的同进程多会话不是 CPU 隔离；Browser 页面当前每 realm 只创建一个 Host Worker，transport 安装在 realm 全局。明确本批比较共享 Host 与一页面 realm 一 Host，不冒称单页 Worker pool。 | 编写计划和进度。 |
| 2026-10-31 | `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-multi-agent-probe.spec.ts` | 5/5 通过。 | 构建并运行 Chrome。 |
| 2026-10-31 | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | Preview、Worker bundle 和 VFS image 构建通过；保留平台选择、tsdown 弃用和大 chunk warnings。 | Chrome 拓扑实验。 |
| 2026-10-31 | `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js DSH_POC_RESULT_FILE=docs/drafts/browser-native-dsh-poc/session-worker-isolation-chrome-results.json node docs/drafts/browser-native-dsh-poc/tests/session-worker-isolation.e2e.mjs` | Chrome 156.0.8078.79 通过。共享 Worker terminate 留下两个未终结 Session；独立 Worker terminate 只影响 CPU Session，peer turn 完成。1/2/4 Host 各三轮，21 个容量 turn；无 pageerror、Worker error 或跨源请求。原始资源样本写入 JSON。 | 真实模型普通路径 smoke。 |
| 2026-10-31 | 同上 E2E 首次调试运行 | 未到达被测拓扑：Worker message validator 仍拒绝单 Agent probe 输入，测试端因无响应挂起。发现后终止该次 Chrome/Node 测试进程；没有把失败算作拓扑结果。修复 validator 并增加 test MessagePort 30 秒超时后复跑通过。 | 记录发现与防止静默等待的修复。 |
| 2026-10-31 | `env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ROSTER=browser DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_LLM_TIMEOUT_MS=180000 DSH_POC_CONTEXT_WINDOW=32768 DSH_POC_TURN_TIMEOUT_MS=600000 DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | 真实 `gpt-5.6-sol` smoke 通过：3 轮文件工具与刷新后 Session 记忆，59 events、`durableThroughSeq=58`、8 次 LLM HTTP 200、2 次 Workspace commit HTTP 200；模型请求 origin 仅同源。记录了刷新导致的 `ERR_ABORTED` 和 PoC 未实现 endpoint 404，不描述成零告警。 | 更新 PoC 文档。 |
| 2026-10-31 | `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-multi-agent-probe.spec.ts`；`node --check docs/drafts/browser-native-dsh-poc/tests/session-worker-isolation.e2e.mjs`；`pnpm --filter @deepseek-ai/dsh-web-frontend exec tsc --noEmit -p tsconfig.json` | Probe tests 5/5 通过；E2E JavaScript 语法检查通过；Web TypeScript 检查通过。pnpm 输出当前 macOS ARM64 不需要的 darwin-x64/Linux native packages 平台 warning。 | 文档门禁与预推送检查。 |
| 2026-10-31 | `pnpm run verify-repository-references` | 当前工作区只报告 `.archify/architecture-dsh-memory-20261031-012757/` 中 5 处提交号；本批及关联文档中的完整提交号已去除。该路径为本批外未跟踪 WIP，按用户指示保留原状。 | 运行最终 `test:docs` 和 `doc-sync`，提交本批路径。 |
| 2026-10-31 | `pnpm run test:docs` | 20/21 gate 通过；markdown wrap/link、translation pairing、type equivalence、doc budgets 和其余快速文档检查均通过。唯一失败是 repository-reference gate 扫描 `.archify/` 的 5 处提交号。 | 执行完整 doc-sync。 |
| 2026-10-31 | `pnpm run doc-sync` | 42/43 gate 通过；Markdown、doc-typecheck、文档构建和其他目录/参考检查通过。唯一失败是同一 repository-reference gate 对 `.archify/` 的 5 处报告；未读取或修改该目录。 | 记录限制，继续交付本批路径。 |
| 2026-10-31 | `pnpm run verify-md-wrap`；`pnpm run verify-md-links` | 最新文档编辑后分别检查 2,269 和 2,232 个文件；段落换行及本地链接/锚点均通过。 | 执行最终 diff 检查、提交并推送。 |
| 2026-10-31 | `pnpm run build` | 9/9 build gates 通过；Host、Desktop、Client、Web 编译和 bundle 检查均通过。 | 执行最终 diff 检查、提交并推送。 |

## 未验证范围

本批未证明单页 Worker pool、Worker termination 后恢复未完成 turn、真实模型并发、Browser Storage 自然 eviction、OS crash、跨浏览器容量或产品级 admission control。Chrome RSS 包含页面、Worker、Chrome 公共进程和系统负载；启动耗时及 RSS 跨样本波动明显，只能说明独立 Worker 的总成本不可忽略，不能支持线性成本模型或并发门槛。被终止 Session 保留已持久化前缀，未完成 turn 没有自动终态；本批没有重新 resume 该 Session，也没有宣称未结算 tool call 可在浏览器端恢复执行。
