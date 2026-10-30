---
description: "记录单个 Browser-Native DSH Worker 中同步 CPU 阻塞、协作式让出、取消响应和 Session durability 验证结果。"
---

# 单 Worker CPU 阻塞与协作式让出验证进度

## 当前状态

状态：本批 scripted Chrome 验证、真实 LLM 普通路径 smoke、代码构建、定向测试和可归因的文档检查完成；提交已推送至 `origin/research`。目标分支为 `research` 主工作区，仅验证 Chrome，没有创建隔离 worktree。工作区保留本批以外的 `.archify/` WIP，未暂存或修改。

## 里程碑

| 里程碑 | 状态 | 证据 | 下一步 |
| --- | --- | --- | --- |
| M0：候选评估与计划 | `complete` | 比较同步 CPU 阻塞、cooperative yield、取消、主线程响应、Session event、Worker terminate blast radius、容量与 worker pool；计划和进度均已建立。 | 完成批次记录。 |
| M1：测试工具与控制 barrier | `complete` | 增加 20–2000 ms 有界 CPU probe；cooperative probe 按 1–50 ms 分片、timer task yield 并检查 `AbortSignal`。工具只在显式 `cpu-contention` validation profile 发布；backend barrier 有实际释放时刻 trace。 | Chrome E2E。 |
| M2：Chrome 同步阻塞 E2E | `complete` | Chrome 156 单 Worker/Host 内真实 DSH Agent Loop 运行 1900 ms 同步 probe；peer backend 响应在 probe 结束前约 1810 ms 释放但 peer Session 尚无 terminal event；取消消息在工具返回后才处理；页面动画帧仍推进。tool/call 与 tool/result 各一条。 | cooperative 对照。 |
| M3：Chrome cooperative-yield E2E | `complete` | 同一 Worker 的 peer Agent 在 205 ms cooperative probe 完成前结束；CPU Agent 在取消发送后约 12 ms 的本次 Chrome 计时中观察到取消，并以 `aborted` 结束；两 Session 输入和工具调用身份分离。 | 真实模型普通路径 smoke。 |
| M4：真实 LLM smoke | `complete` | Chrome + `gpt-5.6-sol` 完成 `read → write → read`、刷新后同 Session 恢复；59 个 Session events、`durableThroughSeq=58`、8/8 模型 HTTP 200、2 次 Workspace commit 200。 | 文档门禁。 |
| M5：文档、提交与推送 | `complete with unrelated repository-reference failure` | README、兼容矩阵、drafts 索引和 change ledger 已更新；`pnpm run build` 9/9、Web TypeScript、Preview build、markdown wrap/link、doc-typecheck、pre-commit hooks 和 pre-push typecheck 均通过。`pnpm run doc-sync` 42/43 通过；唯一失败的 repository-reference gate 扫描到本批外 `.archify/` WIP 内 5 处 commit-hash，未触碰该目录。提交已推送，且 `HEAD` 与 `origin/research` 相同。 | 本批结束并暂停。 |

## 基线与结论

上一批只证明同一 Worker 可并行等待多个 Agent 的异步模型响应；本批确认同步 CPU JavaScript 会阻塞该 Worker 的消息处理和其他 Session 推进，但不会阻塞页面主线程。显式切片并让出 Worker task、同时检查 `AbortSignal`，可使 peer Session 和取消消息在工具运行期间推进。

该结论只适用于按检查点合作的工具。无法让出的同步工具仍不可抢占；若产品需要其硬取消，终止 Dedicated Worker 会影响该 Worker 上所有 Session，并应由 durable Session 与 Workspace 恢复语义处理。

## 执行记录

| 日期 | 命令/操作 | 结果 | 下一步 |
| --- | --- | --- | --- |
| 2026-10-31 | `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-cpu-contention-probe.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-capabilities.spec.ts` | 2 个文件、12/12 通过；覆盖 duration/slice 限制、cooperative cancellation 与默认 profile 不发布测试工具。 | Chrome E2E。 |
| 2026-10-31 | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | Preview 与 VFS image 构建通过；保留仓库既有平台、tsdown 弃用和大 chunk warnings。 | Chrome E2E。 |
| 2026-10-31 | `node docs/drafts/browser-native-dsh-poc/tests/single-worker-cpu-contention.e2e.mjs` | 最终 Chrome 156.0.8078.79 复跑通过；单 Worker 中同步 probe 为 1900 ms，peer backend barrier 在 probe 结束前 1810 ms 释放，peer Session 仍无 terminal event；Stop 在同步工具结束后才由 Worker 处理，页面 animation frame 增加 112。cooperative probe 总时长 205 ms，peer Session 在工具结束前完成，cancel 在约 12 ms 后被观察，animation frame 增加 14。两个工具各有一个 DSH tool/call 和匹配的 tool/result；无页面错误、Worker pageerror 或跨源请求。Agent teardown 另产生 4 条既有 `agent/disposed` listener `.catch` warning，已保留在 E2E 输出，未纳入本批代码修复。 | 真实 LLM smoke。 |
| 2026-10-31 | `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 56/56 通过；覆盖 backend 既有合同及新增 barrier release callback 执行路径。 | 真实 LLM smoke。 |
| 2026-10-31 | `env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ROSTER=browser DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_LLM_TIMEOUT_MS=180000 DSH_POC_CONTEXT_WINDOW=32768 DSH_POC_TURN_TIMEOUT_MS=600000 DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | 最终真实 `gpt-5.6-sol` Chrome smoke 通过，三轮普通文件工作流含刷新后续聊；Session 为 59 events/`durableThroughSeq=58`，8 次 LLM 请求和 2 次 Workspace commit 均为 HTTP 200，模型网络只到同源 backend，文件刷新后可读。无 pageerror；输出另含刷新时 `ERR_ABORTED`、未实现 preview API 的 404 和 validation profile 日志，不据此称为零告警。 | 更新当前批次的文档记录。 |
| 2026-10-31 | `pnpm --filter @deepseek-ai/dsh-web-frontend exec tsc --noEmit -p tsconfig.json`；`pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`；`pnpm run build` | Web TypeScript 通过；Preview build 通过；仓库 build 的 9 个 gate 全部通过。构建输出保留平台选择、tsdown 弃用和大 chunk warnings。 | 运行文档门禁。 |
| 2026-10-31 | `pnpm run verify-md-wrap`；`pnpm run verify-md-links`；`pnpm run doc-typecheck` | 分别检查 2267 个 Markdown 文件、2230 个 Markdown 文件和 100 个代码块；均通过。 | 记录 doc-sync 的单项外部 WIP 失败并提交。 |
| 2026-10-31 | `pnpm run doc-sync` | 42/43 gate 通过。唯一失败 `verify-repository-references` 在本批外未跟踪 `.archify/architecture-dsh-memory-20261031-012757/` 中报告 5 处 commit-hash；其余 markdown、doc-typecheck、文档构建、目录索引、翻译配对和其他文档 gate 通过。本批未修改或暂存 `.archify/`。 | 保留外部 WIP 原状，完成本批提交与推送。 |
| 2026-10-31 | `git commit -m "test(browser): validate same-worker CPU contention"`；`git push origin research`；`git fetch origin research && git rev-parse HEAD origin/research` | 提交 hook 的 staged lint、whitespace 和 vendor manifest guard 通过；pre-push typecheck 5/5 通过；提交已推送，远端与本地 `HEAD` 相同。仅本批 17 个路径进入提交，`.archify/` 保持未跟踪且未改动。 | 本批完成。 |

## 已知限制

- 同步 CPU probe 是固定时长纯计算探针，不是吞吐量、性能 SLA 或真实业务工具基准；Chrome E2E 的模型响应由同源 scripted backend barrier 控制，不调用外部模型。
- cooperative probe 仅证明遵守 slice/yield/AbortSignal 检查点的工具可以让出 Worker；任意同步插件、单次长任务或阻塞式 WASM 调用仍不会被抢占。8 ms slice 不是取消硬上限，实际响应还受 Worker task queue 调度影响。
- 主线程帧推进不代表 Worker 上的其他 Session 能推进；此处分别用页面 animation frame 与 DSH Session terminal event 检查。
- 真实 LLM smoke 只回归一般文件与 Session 刷新路径，不证明真实模型并发多个 Agent 或自主触发 CPU 工具。
- Agent dispose 时观察到既有 `agent/disposed` listener 抛出 `TypeError`（读取 undefined 的 `catch`）；没有在本批修复正式 package。页面关闭、自然 eviction、OS crash、Safari/WebKit、worker pool 与并发容量仍未验证。
