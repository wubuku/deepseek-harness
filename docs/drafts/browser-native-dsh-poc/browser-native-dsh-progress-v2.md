---
description: "Browser-native DSH PoC v2 的可恢复实施进度、验证记录和当前阻塞。"
---

# Browser-native DSH PoC v2 进度

## 当前状态

- **阶段**：Phase 1，custom Worker 骨架已写入，正在验证 Vite Worker bundle 和现有 preview acceptance。
- **目标**：在现有 DSH Web UI 和真实 DSH Host/Agent Loop 上实现 browser-native PoC；旧独立 HTML/loop 不是完成结果。
- **当前 worktree**：`/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness-browser-native-poc`。
- **当前分支**：`research-browser-native-poc`。
- **checkpoint**：提交主题为 `docs: checkpoint browser-native llm proxy poc`；不要在维护文档中固定 commit hash，恢复时用 `git log --all --grep='checkpoint browser-native llm proxy poc' --oneline` 定位。
- **主 worktree**：`/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness` 的 `research` 分支保持不变。
- **连续无修改审计计数**：3/3 已完成；后续实现中的文档修改不再属于规划审计循环。

## 已核实的基线

1. `apps/web/src/main.ts` 通过 `AppWebEntry` 启动现有 DSH Web UI。
2. `apps/web/src/preview.ts` 和 `packages/experimental/webworker-runtime` 已能在 Dedicated Worker 中启动完整 Host，并通过 tunnel 提供现有 Web API。
3. `packages/core/agent-loop`、`packages/llm/llm` 和 `packages/session/session-persistence` 已有正式扩展点；v2 不复制 loop，也不定义自定义 Session event。
4. webworker packer 不扫描 `docs/drafts`，因此 docs-owned provider 需要 static module + profile overlay，或经过账本批准的最小 runtime/packer seam。

## 实施顺序

- [ ] v2 规划文档完成并通过连续三轮只读检查。
- [x] custom Worker entry 启动现有 Web UI 和完整 Host。
- [ ] Remote Session backend/provider 通过正式 persistence contract。
- [ ] Remote LLM adapter 通过 scripted backend 触发真实 `ctx.agentLoop`。
- [ ] 真实 provider 通过同源 backend proxy。
- [ ] Worker/backend restart 后恢复已 flush Session。
- [ ] 目录外变更全部登记并验证可删除或可重放。
- [ ] Playwright 浏览器 E2E、docs gates、build smoke 和工作区清理。

## 关键验证记录

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
| 2026-10-03 | 新增 `browser-native-worker.ts` 并将 `apps/web/src/preview.ts` 的 Worker import 指向该文件 | 待验证 | 只替换 preview 的 Worker bundle，保留 `chooseWorkerHostSource`、`connectWorkerHost`、AppWebEntry 和 tunnel；目录外接线已登记为 BN-P1-001 |
| 2026-10-03 | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 失败，尚未验证 custom Worker | Worker runtime 和 packer 子构建通过；Vite 在既有 `apps/web/src/main.ts` import `@deepseek-ai/dsh-client-ui-theme/brand-font.css` 处无法解析。已确认源码存在而 package export 指向的 `lib/styles/brand-font.css` 尚未生成；先构建 UI theme 包再重试 |
| 2026-10-03 | `pnpm --filter @deepseek-ai/dsh-client-ui-theme run bundle` | 通过 | 生成 package export 所需的 `lib/styles/brand-font.css` 和 theme client bundles；产物为忽略的构建输出 |
| 2026-10-03 | 重试 `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 失败，尚未验证 custom Worker | UI theme 产物问题解决后，Vite 在既有 `@deepseek-ai/dsh-client-web` package entry 处失败；继续补齐当前 checkout 的 workspace build artifacts |
| 2026-10-03 | `pnpm --filter @deepseek-ai/dsh-client-web run bundle` | 失败，命令不适用 | `dsh-client-web` 没有 package-local `bundle` script；仓库根级 `build:lib:client` 是声明的 client artifact 构建入口 |
| 2026-10-03 | `pnpm run build:lib:client` | 通过 | 生成当前 checkout 的 client package `lib` artifacts；日志包含既有 workspace platform warnings，无编译失败 |
| 2026-10-03 | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`（补齐 client artifacts 后） | 通过 | Vite 生成 docs-owned Worker bootstrap、既有 Web UI assets 和 preview VFS image；packer unresolved third-party request 列表与上游 baseline 一致，未出现构建失败 |
| 2026-10-03 | `pnpm exec vitest run apps/web/tests/preview-boot.e2e.ts --config vitest.web.config.ts` | 通过 | 1 file、1 test passed；真实 Chromium 通过空 preview 和 seeded preview boot，Host tree/tunnel/UI acceptance 成立 |

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

## 恢复入口

上下文恢复后按以下顺序读取：

1. [`browser-native-dsh-plan-v2.md`](browser-native-dsh-plan-v2.md)。
2. 本文件，确认阶段和最后一个 checkpoint。
3. [`change-ledger.md`](change-ledger.md)，确认目录外改动和删除条件。
4. `git status --short --branch`、`git log -5 --oneline --decorate`。
5. 只运行当前阶段需要的最小验证；不要把旧 PoC 的 `run.mjs` 或旧事件 DTO 当成 v2 的入口。

规划文档写入后，三轮审计的结论由执行者写入本文件。无问题轮次只在对话中报告，不修改本文件，以免把文档写操作误计为无修改轮次。
