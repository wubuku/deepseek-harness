---
description: "Browser-native DSH PoC v2 的可恢复实施进度、验证记录和当前阻塞。"
---

# Browser-native DSH PoC v2 进度

## 当前状态

- **阶段**：已完成 v2 PoC；preview build、默认 preview acceptance、scripted/real 浏览器 E2E、文档门禁和 typecheck 已通过。当前保留一个可供人工验收的 real-mode server 实例。
- **目标**：在现有 DSH Web UI 和真实 DSH Host/Agent Loop 上实现 browser-native PoC；旧独立 HTML/loop 不是完成结果。
- **当前 worktree**：`/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness-browser-native-poc`。
- **当前分支**：`research-browser-native-poc`。
- **checkpoint**：实现已提交并推送到 `origin/research-browser-native-poc`；维护文档不固定 commit hash，恢复时用 `git log --all --grep='browser-native' --oneline` 定位最近的实现提交。后续文档 review 产生的新提交应继续保持本文件、README 和 change ledger 一致。
- **主 worktree**：`/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness` 的 `research` 分支保持不变。
- **连续无修改审计计数**：3/3 已完成；后续实现中的文档修改不再属于规划审计循环。

## 当前人工验收实例

- **启动日期**：2026-10-03。
- **模式**：`real`，backend 选择 `gpt-5.6-sol`；API key 只从主 worktree 的本机 `.env` 读取，不写入本目录、进程输出或浏览器。
- **命令**：

  ```sh
  export https_proxy=http://127.0.0.1:9981 http_proxy=http://127.0.0.1:9981 all_proxy=socks5://127.0.0.1:9981
  node docs/drafts/browser-native-dsh-poc/run-v2.mjs \
    --port 4185 \
    --data-dir /tmp/browser-native-dsh-v2-acceptance \
    --llm real \
    --env-file /Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/.env
  ```
- **访问地址**：`http://127.0.0.1:4185/preview.html?browser-native=1&preview-fixture=none`。
- **健康检查**：`GET /api/browser-native/health` 返回 protocol v1、`real` mode 和 `gpt-5.6-sol`；preview HTML 返回 HTTP 200。
- **本地代理注意事项**：验收浏览器/HTTP 请求访问 loopback 时应把 `127.0.0.1,localhost` 加入 `NO_PROXY`/`no_proxy`；上游 real LLM 请求仍使用 Node 24 的环境代理支持。
- **停止方式**：在启动该实例的终端发送 `Ctrl-C`；`/tmp/browser-native-dsh-v2-acceptance` 是可删除的本地测试数据目录，不属于仓库。

该实例只用于人工验收；它不改变 v2 的验证结论，也不把一次 real provider 请求提升为生产可用性或 SLA 证明。

## 已核实的基线

1. `apps/web/src/main.ts` 通过 `AppWebEntry` 启动现有 DSH Web UI。
2. `apps/web/src/preview.ts` 和 `packages/experimental/webworker-runtime` 已能在 Dedicated Worker 中启动完整 Host，并通过 tunnel 提供现有 Web API。
3. `packages/core/agent-loop`、`packages/llm/llm` 和 `packages/session/session-persistence` 已有正式扩展点；v2 不复制 loop，也不定义自定义 Session event。
4. webworker packer 不扫描 `docs/drafts`，因此 docs-owned provider 需要 static module + profile overlay，或经过账本批准的最小 runtime/packer seam。

## 实施顺序

- [x] v2 规划文档完成并通过连续三轮只读检查。
- [x] custom Worker entry 启动现有 Web UI 和完整 Host。
- [x] Remote Session backend/provider 通过正式 persistence contract。
- [x] Remote LLM adapter 通过 scripted backend 触发真实 `ctx.agentLoop`。
- [x] 真实 provider 通过同源 backend proxy。
- [x] Worker/backend restart 后恢复已 flush Session。
- [x] 目录外变更全部登记并验证可删除或可重放。
- [x] Playwright 浏览器 E2E、docs gates、build smoke 和工作区清理。

## 关键验证记录

下表保留实施过程中的诊断记录；其中“待验证”和“待修复”描述记录当时的状态，不代表当前收口状态。当前状态以表后的最终验证记录、[README.md](README.md) 和本文件的“收口状态”为准。

| 时间 | 命令/动作 | 结果 | 备注 |
| --- | --- | --- | --- |
| 2026-10-03 | 检查隔离 worktree 和 checkpoint | 通过 | worktree 干净，领先 `origin/research-browser-native-poc` 一个 checkpoint commit |
| 2026-10-03 | 阅读 `apps/web/src/main.ts`、`preview.ts`、WebWorker runtime、packer、LLM 和 Session persistence 源码 | 通过 | 已确认 v2 应复用 existing UI/Host，不再使用独立 HTML/loop |
| 2026-10-03 | 三轮严格规划审计 | 通过 | 发现并修复 attribution header、flush durability 顺序和进度标题问题；之后连续三轮无修改 |
| 2026-10-03 | `pnpm run test:docs` | 通过 | doc-quick 21 passed、0 failed、0 skipped |
| 2026-10-03 | `pnpm run verify-repository-references` | 通过 | maintained files 无禁止 commit identifier 或组织 URL |
| 2026-10-03 | `pnpm run doc-typecheck` | 通过 | 83 个代码块编译；76 个显式忽略；其余 catalog/type-equivalence 通过 |
| 2026-10-03 | `pnpm run doc-sync` | 通过 | 43 passed、0 failed、0 skipped |
| 2026-10-03 | `git diff --check` | 通过 | 规划文档无 whitespace 错误 |
| 2026-10-03 | `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 通过 | 6/6；覆盖 Session CRUD、sequence conflict、owner fencing、close durability、backend restart、scripted stream、OpenAI-compatible stream、invalid request 和 secret redaction |
| 2026-10-03 | `DSH_POC_LLM=scripted node docs/drafts/browser-native-dsh-poc/tests/browser-native-v2.e2e.mjs` | 通过 | 真实 Chromium 加载现有 DSH Web UI，Session 17 个事件 durable，浏览器 API 路由为 session list/create/append/flush 和 llm |
| 2026-10-03 | `DSH_POC_LLM=real node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/browser-native-v2.e2e.mjs` | 通过 | 使用本机 `.env` 和真实 HTTP 代理；真实模型 `gpt-5.6-sol`，最后一次严格断言运行 Session 17 个事件 durable；测试未输出或向浏览器暴露 API key |
| 2026-10-03 | `pnpm run test:docs`; `pnpm run verify-repository-references`; `pnpm run doc-sync`; `pnpm run doc-typecheck` | 通过 | doc-quick 21/21，doc-sync 43/43，repository references 通过，83 个代码块编译；完整 client typecheck 仍需单独运行 |
| 2026-10-03 | `pnpm run typecheck` | 通过 | host build、desktop bundle 和 client contracts typecheck 全部通过；构建过程只有既有跨平台 native package warnings |
| 2026-10-03 | 新增 `browser-native-worker.ts` 并将 `apps/web/src/preview.ts` 的 Worker import 指向该文件 | 通过 | 只替换 preview 的 Worker bundle，保留 `chooseWorkerHostSource`、`connectWorkerHost`、AppWebEntry 和 tunnel；目录外接线已登记为 BN-P1-001 |
| 2026-10-03 | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 失败，尚未验证 custom Worker | Worker runtime 和 packer 子构建通过；Vite 在既有 `apps/web/src/main.ts` import `@deepseek-ai/dsh-client-ui-theme/brand-font.css` 处无法解析。已确认源码存在而 package export 指向的 `lib/styles/brand-font.css` 尚未生成；先构建 UI theme 包再重试 |
| 2026-10-03 | `pnpm --filter @deepseek-ai/dsh-client-ui-theme run bundle` | 通过 | 生成 package export 所需的 `lib/styles/brand-font.css` 和 theme client bundles；产物为忽略的构建输出 |
| 2026-10-03 | 重试 `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 失败，尚未验证 custom Worker | UI theme 产物问题解决后，Vite 在既有 `@deepseek-ai/dsh-client-web` package entry 处失败；继续补齐当前 checkout 的 workspace build artifacts |
| 2026-10-03 | `pnpm --filter @deepseek-ai/dsh-client-web run bundle` | 失败，命令不适用 | `dsh-client-web` 没有 package-local `bundle` script；仓库根级 `build:lib:client` 是声明的 client artifact 构建入口 |
| 2026-10-03 | `pnpm run build:lib:client` | 通过 | 生成当前 checkout 的 client package `lib` artifacts；日志包含既有 workspace platform warnings，无编译失败 |
| 2026-10-03 | 重试 `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`（补齐 client artifacts 后） | 通过 | Vite 生成 docs-owned Worker bootstrap、preview VFS image 和 fixture overlay |
| 2026-10-03 | `pnpm exec vitest run apps/web/tests/preview-boot.e2e.ts --config vitest.web.config.ts` | 通过 | 真实 Chromium 启动 custom Worker；观察到 Worker Host tree active、tunnel 和现有 DSH Web UI 可交互 |
| 2026-10-03 | Phase 1 收口 | 通过 | 将 BN-P1-001 标记为 implemented；当前进入正式 SessionPersistence provider 实现，不把旧独立 PoC 当作 v2 入口 |
| 2026-10-03 | Phase 2 接入决策核对 | 通过 | `worker-host.ts` 会从 `home/profiles/preview/cordis.patch.yml` 读取 profile patch；PoC 通过 home VFS overlay 替换 JSONL row，并由 static module factory 在 active Worker loader 中取得正式 `SessionPersistence`/`LlmAdapter` class，避免重复 runtime identity |
| 2026-10-03 | Phase 2 首版实现 | 待验证 | 新增 `browser-native-providers.ts`、`backend-v2.mjs`、profile patch 和 VFS overlay；Worker static modules 注册正式 SessionPersistence/LLM provider，preview 追加 profile overlay；下一步运行构建和 provider contract tests |
| 2026-10-03 | preview acceptance 首次运行 | 失败 | provider rows 以静态包名出现时，Worker plugin inventory 对 `require.resolve.paths()` 的 `null` 返回值报错并禁用 provider，随后 `connection` 未激活；未修改通用 loader，改为 VFS-local relative plugin entries 转发 static modules |
| 2026-10-03 | 第二轮浏览器启动诊断 | 已定位并修复待验证 | Worker home overlay 的实际路径是 `/dsh/home/cordis.patch.yml`，不是 profile 子目录；同时 `llm-browser-native` 需要 `inject: [llm]`。overlay 已改为 `home/cordis.patch.yml` 并重新打包，下一步重跑 preview acceptance |
| 2026-10-03 | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`（补齐 client artifacts 后） | 通过 | Vite 生成 docs-owned Worker bootstrap、既有 Web UI assets 和 preview VFS image；packer unresolved third-party request 列表与上游 baseline 一致，未出现构建失败 |
| 2026-10-03 | `pnpm exec vitest run apps/web/tests/preview-boot.e2e.ts --config vitest.web.config.ts` | 通过 | 1 file、1 test passed；真实 Chromium 通过空 preview 和 seeded preview boot，Host tree/tunnel/UI acceptance 成立 |
| 2026-10-03 | 默认 preview overlay 回归分析 | 已定位并修复 | Phase 2 首版无条件追加 browser-native profile overlay，导致空 preview 的既有 `data overlays=0` acceptance 失败；已改为仅在 `?browser-native=1` 时追加 overlay，并登记 BN-P2-002；默认 acceptance 已重新通过，下一步验证 opt-in browser-native 入口 |
| 2026-10-03 | v2 backend 启动入口核对 | 发现缺口 | `backend-v2.mjs` 只有导出 API，没有用户可直接执行的 launcher；之前残留的临时 Node 进程占用 4185 且 health 无响应。下一步新增 docs-owned `run-v2.mjs`，统一参数、env-file、distRoot、信号关闭和启动输出 |
| 2026-10-03 | Session 持久化 live-write 路径诊断 | 已定位，待修复 | 真实 Chromium 已完成 `session/create` 和 LLM 请求，但 backend 没有收到事件追加/flush；对照正式 JSONL provider 后确认 remote provider 未安装 `session/event`、`session/flush`、`session/disposed` listeners。下一步按正式 live-write contract 补齐事件路由、flush barrier、close drain 和 service-wide flush |
| 2026-10-03 | live-write 修复和恢复验证 | 通过 | 新 bundle 已通过真实 Chromium 完成 Agent Loop；network trace 包含 create/append/flush，backend 写入正式 Session event 文件；重启 backend 后 `session/list` 读回同一 Session，刷新 Worker 后 Web UI 恢复该会话。下一步修正 scripted prompt 选择并接入本机 HTTP proxy 后测试 real provider |
| 2026-10-03 | scripted 消息选择、LLM owner fencing 和 HTTP proxy | 待验证 | backend 不再把 runtime-context 当作 scripted 用户问题；LLM 请求携带可选 `sessionId`/owner token，backend 对有 Session 身份的请求执行 owner 校验；real mode 使用 `HTTPS_PROXY`/`https_proxy` 等 HTTP(S) proxy 变量并拒绝未实现的 SOCKS-only 路径。下一步重建并运行 scripted/real 浏览器测试 |
| 2026-10-03 | real mode proxy 依赖修正 | 已定位，待修复 | 隔离 worktree 无法解析裸 `undici`，因此不把 `ProxyAgent` 作为 docs-owned runtime 依赖；改用 Node 24 的 `--use-env-proxy`，launcher 在 real mode 自动 re-exec，并把大小写代理变量映射到 Node 识别的名称 |

## 最近修复的问题

### Attribution header 必须由 backend 注入

- **发现时间**：2026-10-03。
- **范围**：`packages/llm/llm/src/index.ts`、`packages/llm/llm/src/attribution.ts`、现有 provider adapter，以及 v2 计划的 Remote LLM proxy。
- **问题**：正式 `LlmAdapter` 约定每个 provider HTTP request 都必须带 `attributionHeaders()`。浏览器 Worker 不能可靠设置 `User-Agent`，原计划只描述了 Worker 到 same-origin backend 再到 upstream 的路径，没有规定真实 upstream 请求如何履行这项约定。
- **处理**：在 v2 计划的 `RemoteLlmAdapter` 和 Provider security 章节明确由 backend upstream adapter 调用当前 DSH attribution helper 或版本受控 bridge；要求同名 header 不可被覆盖，禁止把 session、prompt、用户标识和 secret 放进 attribution，并要求 upstream mock contract test 逐请求断言公开 header。
- **结果**：该问题已修复；连续无修改审计计数重置为 0，必须重新完成三轮只读审计。

### Flush receipt 的本地 durability 顺序必须明确

- **发现时间**：2026-10-03。
- **范围**：v2 计划的 Session backend storage 和失败恢复章节。
- **问题**：原文把临时文件替换和 `close` 作为 crash durability barrier，但没有要求临时文件与父目录 `fsync`，也没有区分进程重启恢复和介质、备份或跨主机灾备保证。
- **处理**：补充 POSIX 的写入、文件 `fsync`、原子 `rename`、父目录 `fsync` 顺序；补充 Windows 的可验证范围；把 `flush` receipt 限定为本地提交顺序完成，并定义已 flush prefix 的进程崩溃 RPO、实际测量的 RTO 和不提供的灾备保证。
- **结果**：该问题已修复；连续无修改审计计数重置为 0，必须重新完成三轮只读审计。

## 审计记录

### 规划审计：发现并修复文档门禁问题

- **范围**：repository references、Markdown links/wrap、doc-sync、规划中的源码路径、profile/provider 关系和 TypeScript 代码块。
- **发现**：进度文件固定写入了 checkpoint commit hash；规划中的 LLM DTO 轮廓使用 `ts` fence 但没有导入 `RequestMessage`、`ToolSchema`、`ToolHistory` 和 `ReasoningEffortId`。
- **处理**：改为提交主题加 `git log --grep` 查找；将 DTO 轮廓改为 `text` fence，避免把说明性字段列表误当成独立类型源。
- **结果**：repository references 和文档类型检查的已知问题已修复；审计计数重置为 0，必须重新完成三轮连续无修改检查。

### 规划审计：发现并修复 Worker 装载问题

- **范围**：`worker-host.ts` 的 `bootPatches()`、`WorkerModuleLoader` static module 语义、base profile 的 persistence row 和 v2 装载方案。
- **发现**：原计划把 `session-persistence-jsonl` 视为可直接替换的 row，但 Worker runtime 会无条件给这个 id 注入 `compression: none`；原计划还允许 static provider 直接静态导入 DSH runtime 包，可能在 Vite bundle 和 Worker VFS 中形成两份 Cordis/Service class identity。
- **处理**：改为停用 JSONL row、使用独立 remote provider row；要求 static provider 通过 `requireActiveModuleLoader()` 和 Worker loader 获取运行时 DSH 值，并缓存 module namespace；增加重复 require、单 provider、compression 不泄漏和 class identity 组合测试要求。
- **结果**：规划缺口已修复；审计计数仍为 0，文档门禁和三轮连续无修改审计必须重新开始。

### 规划审计：发现并修复 README 入口歧义

- **范围**：README 的 Summary、Run、Tests、Scope 与 v2 规划的目标入口和历史 PoC 定位。
- **发现**：README 虽然把旧实现称为历史实验，但仍把旧 `run.mjs`、独立 HTML 和旧浏览器测试放在无前缀的运行说明下，可能被误读为 v2 的启动和验收方式。
- **处理**：增加 v2 未完成前的明确状态说明，将旧命令和测试改为“历史协议实验”章节，并明确它们不能证明现有 DSH Web UI、正式 Session provider 或真实 `ctx.agentLoop`。
- **结果**：README 与 v2 完成定义一致；审计计数重置为 0，必须重新完成三轮连续无修改检查。

### 规划审计：发现并修复基线命令缺口

- **范围**：v2 计划的 Phase 0/1 基线复现、preview 入口、`apps/web/package.json` scripts 和现有 preview acceptance。
- **发现**：计划链接了 `preview-boot.e2e.ts`，但没有给出当前 checkout 构建和提供 preview 的实际命令，恢复实施的人仍需自行推断 package filter 和输出路径。
- **处理**：在基线表后补充 `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`、`serve:preview`、默认地址和命令 owner，并要求实施前先执行现有 acceptance。
- **结果**：Phase 0/1 的基线复现步骤自包含；审计计数重置为 0，必须重新完成三轮连续无修改检查。

### 规划审计：发现并修复真实 provider 配置缺口

- **范围**：LLM proxy real-provider 配置、用户提供的 `.env` 变量、backend allow-list 和 secret redaction 要求。
- **发现**：计划只要求读取 env-file/环境变量，没有记录 real-provider 所需的配置键名；中断后实施者仍需回看会话上下文才能接入 OpenAI Next GPT/Grok。
- **处理**：补充 `OPENAI_NEXT_GPT_BASE_URL`、`OPENAI_NEXT_GPT_COMPLETIONS_PATH`、`OPENAI_NEXT_GPT_MODEL`、`OPENAI_NEXT_GPT_API_KEY` 和 `OPENAI_NEXT_GROK_API_KEY` 的用途，明确只传入本机配置、后端 allow-list 和禁止提交值。
- **结果**：real-provider 接入上下文自包含；审计计数重置为 0，必须重新完成三轮连续无修改检查。

### 实现验证：v2 backend 和真实 Web UI 已完成端到端闭环

- **范围**：docs-owned `backend-v2.mjs`、Worker-side Session/Llm providers、opt-in preview overlay、backend contract tests 和 browser-native v2 Playwright E2E。
- **结果**：scripted 和 real 两种模式均通过真实 Chromium；页面使用现有 DSH Web UI 和真实 Host/Agent Loop，backend 保存正式 Session header/events，LLM API key 只留在 Node backend。浏览器脚本用 Session event 轮询等待 live-write queue 排空，避免把 UI 已显示误判为持久化已完成。

## 恢复入口

上下文恢复后按以下顺序读取：

1. [`browser-native-dsh-plan-v2.md`](browser-native-dsh-plan-v2.md)。
2. 本文件，确认阶段和最后一个 checkpoint。
3. [`change-ledger.md`](change-ledger.md)，确认目录外改动和删除条件。
4. `git status --short --branch`、`git log -5 --oneline --decorate`。
5. 只运行当前阶段需要的最小验证；不要把旧 PoC 的 `run.mjs` 或旧事件 DTO 当成 v2 的入口。

## 收口状态

v2 实现已经完成并有 pushed checkpoint；本次文档 review 只修订 `docs/drafts/browser-native-dsh-poc/` 内的描述，不新增 DSH 核心代码。目录外运行时接线仍只由 [change-ledger.md](change-ledger.md) 中的 BN-P1-001、BN-P2-001 和 BN-P2-002 负责；任何后续目录外修改都必须先登记再实施。

规划文档写入后，三轮审计的结论由执行者写入本文件。无问题轮次只在对话中报告，不修改本文件，以免把文档写操作误计为无修改轮次。
