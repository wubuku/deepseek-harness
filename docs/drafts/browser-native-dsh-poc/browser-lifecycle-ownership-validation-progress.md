---
description: "记录 Browser-Native DSH claim 竞争、真实 Chrome 生命周期、身份连续性及并发负载验证的实际进度。"
---

# Browser-Native DSH 生命周期与写权连续性验证进度

## 当前状态

状态：本批实施与验证完成；真实 BFCache 往返、Chrome 进程强杀、自然 eviction 和 OS/磁盘崩溃未验证。工作位于 `research` 主 worktree，没有使用隔离 worktree。详细范围和证据边界见[验证计划](browser-lifecycle-ownership-validation-plan.md)。

## 基线

| 项目 | 当前值或证据 |
|---|---|
| 分支与工作区 | `research` 与 `origin/research` 一致；初始状态干净。 |
| 运行环境 | Node `v24.6.0`、pnpm `11.28.5`；Playwright 可从 `/Users/yangjiefeng/node_modules/playwright/index.mjs` 导入。 |
| 真实模型配置 | `docs/drafts/.env` 存在；不得输出或复制其中凭据。 |
| 浏览器目标 | Chrome `156.0.8078.48`；Safari/WebKit 暂停。 |
| 当前相关限制 | Chrome 页面冻结期间 Dedicated Worker 仍续租；BFCache 未命中，Chrome 报告 `no-store` 与 JavaScript 网络请求阻止缓存。身份 cookie 清除时保留的本地 Workspace 可导出，但不能恢复远端 Session；本批没有强杀 Chrome 进程。 |

## 里程碑

| 里程碑 | 状态 | 结果/证据 | 后续 |
|---|---|---|---|
| M0：范围、基线与证据门槛 | `complete` | 核对 backend `ownerLeaseMs`、Workspace `workspaceWriterLeaseMs`、页面 Web Locks 与 sessionStorage 恢复凭据。Worker 的 Session 与 Workspace claim 是两个独立 API；preview 没有按 URL 指定既有 Session 的公开入口，因此首次 claim 实验使用真实 Chrome 页面直接调用同源 API，并明确不代表 UI 自动恢复流程。 | M1 首次 claim 竞争 |
| M1：首次 claim 竞争 | `passed` | 两个无凭据页面同时 claim；Session 与 Workspace 各返回一个 `200`、一个 `409`。Session `seq`、Workspace revision 不变，claim 阶段没有模型请求或 Workspace commit。 | 不外推多实例 backend。 |
| M2：真实 BFCache 往返 | `not-verified` | Chrome back/forward 导航没有命中 BFCache；`notRestoredReasons` 报告 HTML `no-store` 与 JavaScript 网络请求。 | 保留真实限制，不通过移除安全响应头伪造成功。 |
| M3：页面冻结与 Worker 租约续期 | `passed` | CDP 冻结页面期间 Dedicated Worker 成功续租 Session owner 与 Workspace lease 各 4 次；竞争 claim 为 `409`，epoch、fencing、seq 和 revision 不变。 | 不等同于自然后台冻结或 OS 进程终止。 |
| M4：身份 cookie 丢失 | `passed` | 清除两枚身份 cookie 后页面进入 `identity-missing`，保留的 OPFS/IndexedDB 数据可导出；没有新 principal、LLM 请求或 Workspace commit。 | 不恢复远端 Session 或认证身份。 |
| M5：并发计算位置测量 | `passed` | 1/4/8 contexts 完成 13 个真实 DSH Worker turns、26 次工具调用和 13 个唯一 Workspace commit；每 context 一个 Dedicated Worker，均由同一 backend PID 服务。 | 单机诊断数据，不是部署容量 SLA。 |
| M6：回归、真实 LLM、文档与交付 | `complete-with-known-lint-errors` | Preview build、typecheck、定向 Vitest、backend tests、Chrome E2E、scripted/real LLM smoke、`test:docs` 和 `doc-sync` 通过。本批改动文件的定向 lint 通过；全仓 lint 仍被两个未改文件阻断。真实 BFCache 与进程/存储系统故障仍按未验证记录。 | 提交并推送本批变更。 |

## 变更记录

| 文件或范围 | 状态 | 原因 |
|---|---|---|
| 本目录新增计划与进度 | 已创建 | 在编码前固定候选取舍、测试顺序、证据门槛与非目标。 |
| PoC E2E、backend tests 与必要 helper | 已实施并验证 | 覆盖首次 claim、页面冻结续租、身份 cookie 丢失、BFCache 诊断和 1/4/8 Worker 容量。 |
| `apps/web` 启动/状态投影 | 已实施并验证 | `preview.ts` 将 `identity-missing` 与 `identity-mismatch` 作为 fail-closed 启动状态；页面显示本地化状态并允许导出保留的 Workspace 数据。理由、验证和重放步骤见 [change-ledger.md](change-ledger.md) 的 BN-P2-038。 |
| 正式 `packages/`、根依赖与默认 profile | 不在范围 | 本批不改变正式 Agent Loop、Session 格式或依赖拓扑。 |

## 容量结果

Chrome `156.0.8078.48`、macOS 单机、scripted DSH 工具序列下的诊断结果如下，不是生产 SLA 或容量上限。

| 隔离 context 数 | 启动耗时 | Chrome 进程数 / renderer | Chrome 汇总 RSS | 页面 heap 与 long task |
|---|---:|---:|---:|---|
| 1 | 3.57 秒 | 7 / 3 | 2,006,240 KiB | 94.5 MB；long task 合计 761 ms。 |
| 4 | 5.22–5.29 秒 | 13 / 9 | 5,023,632 KiB | 每页 86.1–128.8 MB；long task 合计 1.75–1.85 秒。 |
| 8 | 8.31–8.44 秒 | 21 / 17 | 7,356,096 KiB | 每页 86.2–112.5 MB；long task 合计 1.84–3.14 秒。 |

turn 期间 Chrome CPU 增量约为 0.36、1.68、4.32 秒；每个 context 只有一个 Dedicated Worker。13 个 Session 共用同一 in-process PoC backend PID，39 次 Agent Loop 模型请求之外还有 13 次 Session title 请求。backend 与 harness 共用一个 Node PID，因此 RSS 不是独立 backend 成本。每页的 `/open-in-app/apps`、`/api/changes.summary`、`/api/present.host` 预览 404 响应体保持打开；脚本不等待这些错误响应体，并将路径和状态列入脱敏结果。

## 执行记录

| 命令 | 结果 |
|---|---|
| `git status --short --branch`、`git worktree list`、`git log -5 --oneline --decorate` | `research` 与 `origin/research` 同步，工作区干净，只有主 worktree。 |
| `node --version`、`pnpm --version` | Node `v24.6.0`；pnpm `11.28.5`。 |
| Playwright 与真实模型配置可用性检查 | Playwright module 可导入；`docs/drafts/.env` 存在。没有读取或输出凭据。 |
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-control-channel.spec.ts` | 25/25 tests 通过。 |
| `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 47/47 tests 通过。 |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；输出既有 unsupported native platform、tsdown deprecation 与 chunk-size 警告。 |
| `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/first-claim-race.e2e.mjs` | 通过；Session/Workspace claim 各为一个 `200`、一个 `409`，没有状态或副作用增量。 |
| `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/page-freeze-lease-fencing.e2e.mjs` | 通过；页面冻结时 Session 与 Workspace 分别续租 4 次，竞争 claim 均 `409`。 |
| `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/identity-cookie-loss.e2e.mjs` | 通过；保留的本地 Workspace 可导出，没有创建新 principal、模型请求或 Workspace commit。 |
| `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/real-bfcache-lifecycle.e2e.mjs` | `not-verified`；back/forward 未命中 BFCache，Chrome 返回 HTML `no-store` 与 JavaScript 网络请求拒绝原因。 |
| `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js DSH_POC_CAPACITY_LEVELS=1 node docs/drafts/browser-native-dsh-poc/tests/browser-worker-placement-capacity.e2e.mjs` | 通过；1 context：2 次工具调用、1 commit、3 次 Agent Loop 请求、1 次 title 请求及 1 个 turn end。 |
| `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/browser-worker-placement-capacity.e2e.mjs` | 通过；1/4/8 并发全部完成，总计 13 turns、26 tool calls、13 个唯一 commit operation ID。 |
| `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/browser-worker-placement-capacity.e2e.mjs`（最终复跑） | 通过；修正后的容量报告再次完成 1/4/8、13 turns、26 次工具调用和 13 个唯一 Workspace operation ID；browser/Worker 指标由运行时采集。 |
| `node --check docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | 通过；真实模型密钥及 bearer 类 URL 查询值在成功和失败诊断 JSON 输出前脱敏。 |
| `DSH_POC_LLM=scripted DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | 通过；Chrome scripted 流式 smoke 完成，Session 18 events，9 次可见 DOM 流更新；worker 日志中的 preview URL token 显示为 `[redacted]`。 |
| `DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_TURN_TIMEOUT_MS=600000 node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | 首次运行在一次成功 `read` 后遇到 `UPSTREAM_LLM_EMPTY`，3 个请求均 HTTP 200，不计通过；重试通过，真实 `gpt-5.6-sol` 完成 3 turns、文件 `read → write → read`、刷新后 Session 记忆与 Workspace 文件恢复。8/8 模型请求 HTTP 200、Session 59 events、`durableThroughSeq=58`；LLM 请求只到同源 backend，没有页面错误。 |
| `DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_TURN_TIMEOUT_MS=600000 DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs`（脱敏改动后最终复跑） | 通过；真实 `gpt-5.6-sol` 完成 3 turns，第一 turn 恰为 `read → write → read`，刷新后恢复 Session 记忆和 Workspace 文件；Session 59 events、`durableThroughSeq=58`，8/8 LLM 响应 HTTP 200，仅访问同源 backend，页面错误为 0。Playwright 另记录若干 LLM 请求 `ERR_ABORTED`，见运行输出；本次不将这些条目解释为成功响应或静默忽略。 |

容量脚本的首次诊断暴露了三个 harness 缺陷：预览 404 响应体保持打开导致无界等待，规模总数断言写死完整 1/4/8 负载，以及未安装 Worker 计数探针却读取全局数组。脚本现限制等待时间、单独记录未计量的错误响应体、按请求 `purpose` 区分 Agent Loop 与 Session title，并用 `Worker` 构造探针采集 context 内 Worker 数。

| 最终复验命令 | 结果 |
|---|---|
| `DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_TURN_TIMEOUT_MS=600000 DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs`（最终页面代码后复跑） | 再次通过；3 turns、第一 turn 恰为 `read → write → read`、刷新后 Session/Workspace 恢复、59 events、`durableThroughSeq=58` 和 8/8 HTTP 200；页面错误为 0，preview URL token 显示为 `[redacted]`。Playwright 仍记录首轮和刷新后若干 `ERR_ABORTED` 回调，已保留为诊断观察。 |
| `pnpm run typecheck` | 通过；5/5 host/client compiler 与 aggregate gates。 |
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-control-channel.spec.ts` | 通过；2 files、25/25 tests。 |
| `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 通过；47/47 tests。 |
| `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/identity-cookie-loss.e2e.mjs` | 通过；旧 OPFS 文件和 metadata 保留，页面进入 `identity-missing`，没有创建新 principal、LLM 请求或 commit，恢复包包含 1 个 Workspace；界面显示 64 MiB 导出上限。 |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；包含既有 unsupported native platform、tsdown deprecation 与大 chunk 警告。 |
| `pnpm exec tsx scripts/run-oxlint.ts apps/web/src/browser-native-control-channel.ts apps/web/src/browser-native-page-control.ts apps/web/src/preview.ts` | 通过；本批改动的 Web TypeScript 文件定向 lint 无错误。 |
| `pnpm run lint` | 失败；仅剩未改的 `apps/web/src/browser-native-recovery.ts` 两项和 `packages/core/tools/tests/json-schema.spec.ts` 一项错误，另有未改文件中的 unused-disable warning。本批触及文件的告警已清除。 |
| `pnpm run test:docs` | 通过；21/21 gates。 |
| `pnpm run doc-sync` | 通过；43/43 gates。 |
| `pnpm run change-scope --base origin/research` | 通过；`origin/research` 与当前 `HEAD` 相同，所有未暂存和未跟踪路径均列于本批范围。 |
| `git diff --check` | 通过；无空白错误。 |
| 2026-10-28 最终复验：`pnpm run typecheck`、定向 Vitest、backend tests、preview build、`pnpm run test:docs`、`pnpm run doc-sync` | 全部通过；依次为 5/5 typecheck gates、25/25 tests、47/47 tests、preview build、21/21 与 43/43 文档 gates。构建仅有既有平台、deprecation 和 chunk-size 警告。 |
| 2026-10-28 最终 Chrome 身份恢复 E2E：`DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/identity-cookie-loss.e2e.mjs` | 通过；Chrome `156.0.8078.48` 保留 1 个 OPFS 文件和本地 metadata，状态为 `identity-missing`，未创建新 principal、模型请求或 Workspace commit；导出包含 1 个 Workspace。 |
| 2026-10-28 最终真实 LLM E2E：`DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_TURN_TIMEOUT_MS=600000 DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | 通过；真实 `gpt-5.6-sol` 完成 3 turns，第一 turn 执行 `read → write → read`，刷新后 Session/Workspace 恢复；59 Session events、`durableThroughSeq=58`、8/8 LLM HTTP 200、DOM 有 2 次可见流更新、页面错误为 0，LLM 只请求同源 backend。另观察到 5 个 LLM `ERR_ABORTED` 请求失败回调，原因未确认，未将其解释为成功响应。 |

## 已知限制

BFCache 没有通过；当前 PoC 的静态资源和 API 使用 `Cache-Control: no-store`，Chrome 记录的拒绝原因还包括存在 JavaScript 网络请求。CDP freeze 中 Dedicated Worker 仍续租，不代表自然标签冻结、discard 或 OS 进程终止。身份 E2E 只模拟 cookie 被清除，不能恢复远端 Session；恢复包总大小限制为 64 MiB，界面会事先提示，但本批只实测小型恢复包，未触发超限拒绝分支。本批未强杀 Chrome，也未触发自然 eviction。容量结果是单机 scripted 诊断，backend 与 harness 共用 Node PID；不外推独立 backend 进程、生产 SLA、多实例协调、对象存储、OS/磁盘崩溃、真实模型容量或 Safari/WebKit。
