---
description: "Browser-native DSH PoC 的 v2 规划和历史协议实验：保留 DSH Web UI、真实 Host/Agent Loop，并通过同源 Session backend 和 LLM proxy 接入浏览器 Worker。"
---

# Browser-native DSH PoC

## Summary

本目录包含两个阶段的研究材料。旧版是协议级独立 loop 实验；当前 v2 已经把现有 DSH Web UI、Cordis 插件组合和真实 `ctx.agentLoop` 放进 Dedicated Worker，并通过同源 backend 提供正式 Session persistence 和 LLM proxy。实施规格见 [browser-native-dsh-plan-v2.md](browser-native-dsh-plan-v2.md)，原始实施进度见 [browser-native-dsh-progress-v2.md](browser-native-dsh-progress-v2.md)。真实运行时验证命令见[运行时验证说明](runtime-validation-manual.md)，已验证结果、失败和未验证边界见[运行时验证报告](runtime-validation-report.md)，下一批价值与风险规划见[下一轮验证计划](next-validation-plan.md)及[进度记录](next-validation-progress.md)。v2 的启动入口是 `run-v2.mjs`；旧 `run.mjs` 只属于历史协议实验。

需要进行真实浏览器验收时，使用两个 PoC 共用的[手动验收说明](manual-acceptance.md)；不要把旧版 `run.mjs` 或 `public/worker.js` 当作 v2 的启动入口。

旧实现验证了 Browser-native transport、Session durability、owner fencing、真实后端 LLM streaming、Tool bridge 和 Worker resume，但 Worker 使用目录内的 PoC-local loop adapter；它**没有**宣称现有 DSH `ctx.agentLoop` 已经在浏览器 Worker 中运行。旧版 [implementation-plan.md](implementation-plan.md)、[progress.md](progress.md) 和独立 HTML/loop 文件只用于追溯该协议实验，不能作为 v2 完成证明。

## v2 运行入口

v2 使用现有 `AppWebEntry`、现有 DSH Web UI 和由 Worker 承载的真实 Host。先构建 preview，再从本目录的 launcher 启动同源 Session/LLM backend：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
node docs/drafts/browser-native-dsh-poc/run-v2.mjs \
  --port 4185 \
  --data-dir /tmp/browser-native-dsh-v2 \
  --llm scripted
```

然后打开 launcher 输出的 `preview.html?browser-native=1&preview-fixture=none` 地址。`browser-native=1` 是显式 opt-in；不带该参数的默认 preview 仍使用上游 overlay 列表和 acceptance。

真实 provider 只在 backend 进程读取本机环境文件：

```sh
node docs/drafts/browser-native-dsh-poc/run-v2.mjs \
  --port 4185 \
  --data-dir /tmp/browser-native-dsh-v2-real \
  --llm real \
  --env-file docs/drafts/.env
```

本机真实 provider 配置文件是仓库根目录下的 `docs/drafts/.env`。API key 只存在 Node backend；不会发送给页面、Dedicated Worker、Session event、响应 body 或日志。不要把 `.env` 加入提交。

## 当前实现快照

v2 当前不是独立的 HTML demo。浏览器加载现有 `preview.html`，页面仍由 `AppWebEntry` 和 DSH Web UI 渲染。`apps/web/src/preview.ts` 静态导入并始终实例化本目录的 [`browser-native-worker.ts`](browser-native-worker.ts)；`browser-native=1` 只控制是否追加本目录的 profile overlay，不控制 Worker entry 的选择。Worker 使用现有 `appBoot.boot()`、Cordis composition、Session Controller 和 `ctx.agentLoop`；[`browser-native-providers.ts`](browser-native-providers.ts) 只提供正式 `SessionPersistence` 和 `LlmAdapter` 的远程实现。

若需要验证第三方聊天层，可以阅读同级的[assistant-ui + Browser-Native DSH 增量 PoC](../assistant-ui-browser-native-dsh-poc/README.md)。该 PoC 复用本目录的 Worker、profile overlay、backend 和 Session protocol，但自行启动 DSH Client 并只挂载 assistant-ui 聊天层；它不改变本目录的现有页面或实现文件。

同源 [`backend-v2.mjs`](backend-v2.mjs) 提供 `/api/browser-native/session/*` 和 `/api/browser-native/llm`。Session 事件以正式 DSH event DTO 写入本地 JSON 文件；`append` 只更新当前 backend 的内存状态，`flush` 或 `close` 才通过临时文件、文件 `fsync`、原子替换和父目录 `fsync` 建立本地 durability receipt。real LLM provider 的 base URL、model 和 API key 只由 Node backend 从 `--env-file` 读取；页面和 Worker 只看到同源 route。

`session/list` 同时返回 Session Persistence 使用的 `snapshots` 和 Client Session Controller 使用的 `items`；新增 `items` 不替换原有持久化字段。`items` 是 PoC 用于恢复的最小目录投影：`updatedAt` 暂用 header 的 `createdAt`，`agentAvailable` 和 `running` 固定为 `false`，`blank` 由事件数计算，不代表真实活动状态。Session Controller 用该列表判断已保存的 Session 是否可 retain。assistant-ui PoC 和原生 preview 都在页面刷新时重连同一 Session；前者由 `dsh-client.ts` 负责 owner 通知和卸载处理，后者由 [`browser-native-page-control.ts`](../../../apps/web/src/browser-native-page-control.ts) 通过 Worker `MessagePort` 收取 owner token、保存在 tab-scoped `sessionStorage`，并在 `pagehide` 发送 close beacon、终止页面拥有的 Worker。真实 Chrome 与 Playwright WebKit 验证同一 Session 刷新后可以继续；浏览器不保证在强制关闭或崩溃时完成卸载请求。

v2 要求非空 `requestId`，但没有基于它的请求去重或结果重放账本。写 owner 是当前 backend 进程内的随机 token，通过 claim、定时 `renew` 和 `close` 维护；默认 lease 为 30 秒，Worker 每 10 秒续租。页面正常卸载时，assistant-ui 和原生 preview 会尝试用 owner 凭据请求 `close`/flush；浏览器崩溃、强制结束 Worker 或进程被终止时，写权会在 lease 到期后释放，backend 重启也会清空内存中的 owner 并恢复已落盘数据。原生 preview 使用 `sessionStorage` 交接同一 tab 的 token；生命周期 E2E 也验证 Worker 被强制终止后，旧 owner lease 到期、重新 claim 和继续对话。assistant-ui 在无法取得写权时禁用发送、保留草稿并提供重新连接入口；这不等于实现了跨进程 owner epoch、请求重放或生产级 HA。刷新、backend restart、lease 到期和 stale owner reclaim 不恢复未落盘操作。这些限制不同于[旧版协议实验](protocol.md)的 replay 规则，也不满足 [v2 规划](browser-native-dsh-plan-v2.md)中的完整恢复目标。

当前实现的目录边界是：backend、Worker、profile overlay、page lifecycle bridge、launcher 和 v2 tests 全部在 `docs/drafts/browser-native-dsh-poc/`；目录外运行时代码接线限于已登记的 [`apps/web/src/preview.ts`](../../../apps/web/src/preview.ts)，用于实例化 docs-owned Worker，并只在 opt-in preview 时装载 browser-native overlay、连接 Worker owner control port、在正常卸载时终止该页面拥有的 Worker。没有修改 `packages/core/agent-loop`、Session format、普通 Web profile、Desktop profile 或 Headless profile。完整的目录外改动、删除条件和 upstream 重放步骤见 [change-ledger.md](change-ledger.md)。

## v2 验证

后端契约测试覆盖 Session create/list/open/read/append/flush/close、owner fencing、崩溃后的 durability、scripted LLM stream、OpenAI-compatible stream、非法请求和 secret redaction：

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
```

基础 Browser-Native E2E `tests/browser-native-v2.e2e.mjs` 覆盖三轮真实模型对话、todo 工具和窗口记忆。新增 runtime 验证 `tests/runtime-validation.e2e.mjs` 使用 docs-local 临时 profile overlay，对真实模型请求中的 tool roster、VFS `read`/`write`/`read` 参数与结果、durable Session、刷新后记忆恢复和 VFS 文件易失性作断言；scripted 模式还用动画帧采样检查 assistant DOM 增长。生命周期测试 `tests/runtime-lifecycle.e2e.mjs` 覆盖刷新续聊、真实 UI Stop、失败后继续、第二个 owner 请求被拒、backend 重启读回 durable Session，以及强制 terminate Worker 后 lease 回收和续聊；`tests/runtime-real-lifecycle.e2e.mjs` 在 Chrome 真实模型下验证 Stop 后恢复；`tests/browser-storage-boundary.e2e.mjs` 探测 Storage API 和 OPFS 能力差异。当前执行只继续 Chrome；既有 WebKit/Safari 证据保留为历史对照。运行命令、最新结果和已知限制见[运行时验证说明](runtime-validation-manual.md)与[运行时验证报告](runtime-validation-report.md)。

真实模型长回复的 Chrome 专项测试观察到 84 次递增的 assistant DOM 样本，显示本次真实 Chrome 路径逐步呈现模型输出；该单次观测不代表稳定帧率或性能分布。WebKit/Safari 的长回复表现尚未验证，Safari 测试按当前工作安排暂停。刷新 E2E 只执行一次 `page.reload()`，之后等待当前页面，避免重复导航。

```sh
DSH_POC_PLAYWRIGHT_MODULE=/path/to/deepseek-harness/node_modules/.pnpm/node_modules/playwright/index.mjs \
DSH_POC_LLM=scripted \
node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs
```

真实模型验收需要本机 `docs/drafts/.env`；backend 单独读取密钥。`runtime-validation.e2e.mjs` 会先完成 VFS read/write/read，再刷新浏览器，在同一 Session 里验证随机 token 仍在模型上下文、VFS 输出文件已经不存在，最后要求 Agent 依据真实 `read` 错误如实报告。当前执行使用 `DSH_POC_BROWSER=chrome`；既有 WebKit 结果不代表 Safari.app。完整命令和生命周期脚本见[运行时验收说明](runtime-validation-manual.md)。

真实 provider 需要本机 `.env` 和 Node 24 的环境代理支持；脚本只输出模式、模型、Session id、事件数量和路由名，不输出密钥：

```sh
DSH_POC_PLAYWRIGHT_MODULE=/path/to/deepseek-harness/node_modules/.pnpm/node_modules/playwright/index.mjs \
DSH_POC_LLM=real \
DSH_POC_ENV_FILE=docs/drafts/.env \
node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/browser-native-v2.e2e.mjs
```

该 v2 测试通过的是现有 DSH Web UI、Worker Host、正式 Session 事件、`todo_write` 工具和 `ctx.agentLoop` 的三轮真实交互；旧版测试不能替代它。real E2E 是一次真实 provider 闭环，不是可用性、吞吐量、SLA、灾备或生产安全性证明。

真实 Chrome 复测记录了三个 `completed` turn、一个持久化 `todo_write`、40 个 Session events 和 `durableThroughSeq=39`。这条基础 E2E 使用当前 preview 默认工具 roster；Browser-specific 工具清单与 VFS 闭环以 `runtime-validation.e2e.mjs` 的独立 overlay 测试为准。

真实模型 Stop/恢复单独运行：

```sh
DSH_POC_ENV_FILE=docs/drafts/.env \
DSH_POC_BROWSER=chrome \
DSH_POC_LLM_TIMEOUT_MS=180000 \
DSH_POC_TURN_TIMEOUT_MS=600000 \
node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-real-lifecycle.e2e.mjs
```

该脚本要求真实模型请求处于进行中时点击 Stop，随后在同一 Session 发送恢复消息；通过条件是最新 `turn/end` 为 `completed`，同一 Session 的 durable JSON 包含恢复 marker，且浏览器没有 page error。若 provider 返回无文本、无工具调用的空完成，backend 现在将它作为 `UPSTREAM_LLM_EMPTY` 错误记录，测试会在同一 Session 再试一次；空回复不会再伪装成成功。当前 Chrome 真实模型复测为 `aborted → completed`。该结果不代表取消延迟或稳定性统计。

人工验收步骤、两个 UI 入口、对话脚本、Session 文件核对和常见故障排查见[手动验收说明](manual-acceptance.md)；工具失败后为何继续尝试，以及哪些行为来自 LLM、DSH Loop 和 Worker 能力缺口，见[工具连续尝试事实核查](agent-loop-tool-attempt-analysis.md)。如果要理解为什么当前 overlay 仍会把主机工具带进 Browser Agent，以及如何用 profile/preset 配置裁剪，见[工具清单与配置裁剪调研](browser-native-tool-roster-and-configuration-research.md)。

## 历史协议实验：运行

以下命令只运行旧版独立 HTML、PoC-local loop 和自定义事件协议，用于复现历史 transport/backend 实验，不是 v2 的启动或验收步骤。

在仓库根目录执行：

```sh
node docs/drafts/browser-native-dsh-poc/run.mjs --port 4175 --data-dir /tmp/dsh-browser-native-poc
```

上面的命令启动确定性的 scripted model。要启动真实后端 LLM 代理，使用只存在于本机的 `.env` 文件：

```sh
node docs/drafts/browser-native-dsh-poc/run.mjs \
  --port 4175 \
  --data-dir /tmp/dsh-browser-native-poc-real \
  --llm real \
  --env-file docs/drafts/.env
```

`--env-file` 只由 Node backend 读取。API key 不会发送给浏览器、Dedicated Worker、Session event、页面状态或日志；页面只看到 `real` mode、provider 和 model 名称。real mode 的 GPT 默认使用配置文件中的 `OPENAI_NEXT_GPT_MODEL`，并把 `reasoning_effort` 默认设为 `low`；Grok 可以通过对应的环境变量和 model 选择使用。

然后打开 `http://127.0.0.1:4175/`，点击 `Start Worker`。预期流程是：

```text
opening-session
→ model-request-1
→ browser tool: browser_echo
→ model-request-2
→ completed
```

点击 `Close Worker` 验证 graceful close；它会先 flush 并释放 owner。点击 `Terminate Worker` 则模拟没有执行 `close` 的 Worker crash；等待约 15 秒让 owner lease 过期后，再点击 `Resume Session`。页面应从 backend 读取已 flush 的 Session events，并显示 `resumed-from-flushed-session`。强制 terminate 不能当作 graceful shutdown；这个自动 lease 过期流程只适用于旧版，不适用于 v2。

## 历史协议实验：测试

后端 contract tests 不需要安装新增依赖：

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/backend.test.mjs
```

浏览器测试需要仓库现有 Playwright 依赖；当前独立 worktree 不复制 `node_modules`。运行时可从拥有依赖的仓库 checkout 提供模块路径：

```sh
DSH_POC_PLAYWRIGHT_MODULE=/path/to/deepseek-harness/node_modules/.pnpm/node_modules/playwright/index.mjs \
  node docs/drafts/browser-native-dsh-poc/tests/browser.e2e.mjs
```

真实 provider 的浏览器端到端测试必须显式提供本机 `.env` 和 Playwright：

```sh
DSH_POC_ENV_FILE=docs/drafts/.env \
DSH_POC_PLAYWRIGHT_MODULE=/path/to/deepseek-harness/node_modules/.pnpm/playwright@<version>/node_modules/playwright/index.mjs \
  node --test --test-timeout=360000 docs/drafts/browser-native-dsh-poc/tests/browser.real.e2e.mjs
```

该测试使用真实 Chromium、真实 backend、真实上游模型请求和真实 Session 持久化；它不 mock LLM response。测试输出只报告 mode、provider、model、event types 和 durable sequence，不打印凭据或完整 prompt。

## Scope

backend 使用目录内的 JSON 文件作为 PoC durability store。`append` 后事件对当前 backend 可见；`flush` 通过临时文件、文件和父目录同步以及原子替换写入 durable file；backend 重启只读取已 flush 事件。owner token 只在 backend 进程内有效，重启后由新 Worker 重新 `open('write')`。v2 scripted mode 返回确定性的文本 stream，不执行旧版独立协议中的 `browser_echo`；real mode 将受限消息转换为 OpenAI-compatible Chat Completions request，解析上游 SSE，再转换为 DSH `StreamChunk`。历史 `run.mjs`、`public/` 和旧测试中的 `browser_echo` 只属于旧协议实验。

这个本地 JSON store 不是 PostgreSQL、S3、HA 或生产多租户实现；它不提供跨进程 owner lease、跨重启 mutation replay、跨主机复制、备份保证或灾备 RPO/RTO。当前 browser-native E2E 只证明一次 Worker、同源 backend、正式 Session provider、真实 `ctx.agentLoop` 和 scripted/real LLM route 的闭环。

本目录没有加入根级 npm script、package manifest、Web profile、Desktop profile 或正式 DSH package。旧版命令和测试不证明 v2 的 DSH Host、正式 Session provider 或真实 `ctx.agentLoop`。若后续证明必须修改目录外代码，先按 [change-ledger.md](change-ledger.md) 登记原因、扩展点、测试和 upstream 重放步骤。

## Dev Note

这是可运行的 PoC，不是正式产品入口。v2 的实现事实、已运行命令和限制必须同步写入 [browser-native-dsh-progress-v2.md](browser-native-dsh-progress-v2.md)；[progress.md](progress.md) 只保留旧版独立 loop 的历史记录。不要把目录内历史 loop adapter 的通过结果写成 DSH 核心 Agent Loop 已完成浏览器化。
