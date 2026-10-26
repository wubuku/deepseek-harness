---
description: "记录 Browser-Native DSH Session 远程写入可靠性验证的实施进度、实际命令、证据与限制。"
---

# Browser-Native DSH Session 传输可靠性验证进度

## 当前状态

状态：实现与 scripted Chrome 验收完成；真实 LLM 冒烟通过，但严格文件流程 E2E 未完整通过。

基线：`research` 分支起始时与 `origin/research` 同步；工作区干净，只有主 worktree。源码检查确认 Browser provider 的 live events 由 `pendingLive` 保存，按单个全量数组发送；backend 限制单次 append 为 1,024 个事件和 1 MiB JSON events。backend 已能在 append 前注入 503，但尚无 append 成功后丢弃 response 的故障钩子。

本进度只记录当前 checkout 的事实和实际执行结果。真实 LLM 测试只能由同源 backend 读取 `docs/drafts/.env`；凭据不进入浏览器、日志或本文件。Safari/WebKit 不在本批测试范围。

本批将 backend append 限额移入 PoC 共享协议常量；Browser writer 以单个 live drain 合并事件，并按 1,024 个事件/1 MiB UTF-8 JSON 切批。append 遇到 `SEQ_CONFLICT` 时读取原 seq 并逐事件核对；flush/close 必须确认 durable prefix 覆盖 writer 的 next seq。正式 Session package 未修改。

## 里程碑

| 里程碑 | 状态 | 证据 | 下一步 |
|---|---|---|---|
| M0：候选审查与验收计划 | `complete` | [计划](session-transport-resilience-validation-plan.md)；源码核查 Browser provider、正式 JSONL live writer 和 backend 限额 | 记录所有检查结果与限制 |
| M1：单飞排空、切批和 durable acknowledgement | `complete` | transport 单测覆盖 1,024-event 切批、UTF-8 字节预算和单事件超限拒绝；真实 Worker E2E 检查所有 append body 与 durable seq | 保持 shared limits 与 backend 行为同源 |
| M2：未知 append 与持续 503 Chrome E2E | `complete` | Chrome E2E 丢弃已提交 receipt append 的 response，并验证连续 503 使未持久化输入的 turn fail closed、模型未收到该 prompt；刷新后显式新 turn 可继续 | 不外推 retry budget exhaustion 后继续原 turn、永久断网或 Worker 终止恢复 |
| M3：Workspace receipt 联合恢复 | `complete` | 同一 Chrome E2E 中 Workspace 只提交一次、Session receipt 只出现一次，刷新后同 Session 继续 | 不宣称 Session/Workspace 原子事务 |
| M4：真实 LLM 冒烟 | `partial` | 本轮复跑真实 Chrome compaction/刷新/sentinel 回忆通过；严格 `read → write → read` 真实模型 E2E 执行完三个工具，但最终模型响应为空流而失败 | 保留上游空响应作为单独失败证据；不将 scripted 结果说成真实模型文件流程通过 |
| M5：文档、门禁、commit 与 push | `in-progress` | preview build、Chrome 故障 E2E、真实 LLM compaction smoke 和 `doc-sync` 已通过；提交与远端核验待完成 | 提交并推送后核对远端和干净状态 |

## 执行记录

| 日期 | 命令或检查 | 结果 | 下一步 |
|---|---|---|---|
| 2026-10-26 | `git status --short --branch`; `git worktree list --porcelain` | `research` 与 `origin/research` 一致；工作区干净；没有隔离 worktree | 仅在主 worktree 实施 |
| 2026-10-26 | 核对 `browser-native-providers.ts`、`backend-v2.mjs`、`session-persistence-jsonl/src/storage.ts` 与 Session live-write contract | Browser provider 当前每个 live event 都可能向串行链加入 drain；全量 pending event 一次 append；正式 JSONL provider 失败时保留事件并暂停自动 timer；PoC backend 有 append 前 503 hook，无提交后响应丢失 hook | 将单飞、限额切批、未知结果对账设为本批核心交付 |
| 2026-10-26 | 文档指令核对 | 已阅读 `docs/AGENTS.md`、`dsh-doc`、`dsh-prose-standard` 和 `docs/defensive-patterns/README.md`；该目录没有更深层 `AGENTS.md` | 按中文 PoC 草稿惯例维护本计划和进度 |
| 2026-10-26 | `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-session-transport.spec.ts` | 2/2 通过；覆盖 event count、UTF-8 JSON bytes、顺序和 oversized event fail-closed。首次运行因 spec 引入 `SessionSeq` runtime import 触发模块解析错误；改为仅类型导入并在测试构造已知安全 seq 后通过 | 保留纯 batching helper 测试，不加载 DSH runtime |
| 2026-10-26 | `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 43/43 通过；新增测试确认 backend 可在接受 append 后丢弃 response，随后 read 可见单个事件而 durableThroughSeq 仍为 -1 | 用 Chrome Worker 验证 adapter 的 seq 对账和 durability barrier |
| 2026-10-26 | `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-transport-resilience.e2e.mjs` | 通过；receipt response 丢失后精确对账且不重复 Workspace commit；3 次 append 503 后失败 turn 未记录 user/message、未发出对应 LLM 请求，刷新后同 Session 的显式新 turn 成功；40 个事件 seq 连续且 `durableThroughSeq=39`，无页面错误或跨源请求。首次 E2E 误要求 scripted generic reply 复述 prompt marker，改为核对终态和 assistant message | 明确 fail-closed 输入语义和原 prompt 不自动重放的限制 |
| 2026-10-26 | `DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | 未通过完整断言：真实模型完成 `read → write → read` 且工具结果进入 Session；最终回答请求 HTTP 200 但没有 text/tool call，backend 按 `UPSTREAM_LLM_EMPTY` 收束 turn。测试输出中另观察到本机应用 `/open-in-app/apps` 404；未将其与 Session writer 失败关联 | 以单独真实 LLM smoke 检查 Writer 改动是否可用，并保留这次失败为限制 |
| 2026-10-26 | `DSH_POC_CONTEXT_WINDOW=32768 DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/compaction-real.e2e.mjs` | 通过；真实 `gpt-5.6-sol` 完成摘要、刷新和 sentinel 回忆；22 个事件，刷新前 2 次、回忆后 3 次 LLM 请求，无 page error 或外部请求 | 作为本批真实 LLM/Session 持久化冒烟证据；不替代完整真实模型文件流程 |
| 2026-10-26 | `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-session-transport.spec.ts` | 复跑通过，1 个文件、2 个测试；覆盖事件数/UTF-8 JSON 字节切批和单事件超限拒绝 | 继续复跑 backend 与 Chrome E2E |
| 2026-10-26 | `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 复跑通过，43/43；包含提交 Session append 后丢弃 HTTP response 的 backend 故障钩子测试 | 继续复跑真实 Chrome Worker E2E |
| 2026-10-26 | `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-transport-resilience.e2e.mjs` | 复跑通过；40 个连续事件、`durableThroughSeq=39`、22 次 append、最大批次 7 events/13,566 bytes；提交后响应丢失 1 次、503 3 次、Workspace commit/receipt 各 1 次；失败 prompt 未到达 LLM，页面无错误或跨源请求 | 保留 fail-closed 与显式新 turn 语义；执行文档门禁和推送前检查 |
| 2026-10-26 | `DSH_POC_CONTEXT_WINDOW=32768 DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/compaction-real.e2e.mjs` | 修改后复跑通过；真实 `gpt-5.6-sol` 完成 compaction、刷新恢复及 sentinel 回忆，22 个 compact 后事件，刷新前 2 次、回忆后 3 次 LLM 请求，无页面错误或外部请求 | 仅作为真实 LLM 冒烟；严格文件流程仍记录为空流失败，不能标为完整真实模型 E2E |
| 2026-10-26 | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | preview 构建通过；Worker runtime、Web UI 和 VFS image 均生成。构建输出包含本机平台 native package warning 和既有大 chunk warning，未阻止构建 | 在新构建产物上复跑 scripted 与真实 Chrome 路径 |
| 2026-10-26 | `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-transport-resilience.e2e.mjs` | preview build 后复跑通过；40 个连续事件、`durableThroughSeq=39`、22 次 append、最大批次 7 events/13,566 bytes；receipt response 丢失 1 次、503 3 次、Workspace commit/receipt 各 1 次；失败 prompt 未到达 LLM，无页面错误或跨源请求 | 进入文档门禁与发布核验 |
| 2026-10-26 | `DSH_POC_CONTEXT_WINDOW=32768 DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/compaction-real.e2e.mjs` | preview build 后复跑通过；真实 `gpt-5.6-sol` 生成 summary、刷新后恢复并回忆 sentinel，22 个 compact 后事件，3 次 LLM 请求，无页面错误或外部请求 | 仅作为真实模型 smoke；真实文件流程的空最终响应仍是未通过项 |
| 2026-10-26 | `pnpm run test:docs` | 首次失败：repository references gate 拒绝进度页中的裸 commit hash；已改为描述起始分支同步状态 | 修正后运行完整 `doc-sync` |
| 2026-10-26 | `pnpm run doc-sync` | 43/43 gates 通过，包含 doc-typecheck、文档构建、Markdown links/wrap、translation pairing 和 repository references | 提交前检查变更范围与工作区 |

## 当前证据与限制

- 已有的 `assistant/attempt` append 503 测试覆盖 backend 拒绝 append 后重试，不覆盖“事件已被 backend 接收、成功响应丢失”的未知结果。
- backend 可见 event log 与 `durableThroughSeq` 是不同状态；M1 会检查 flush 回执覆盖范围，不用 append 接收代替 durable acknowledgement。
- 计划中的 1,024-event 与 1-MiB 限额来自当前 PoC backend 源码，不是正式 Session event format 的保证。
- 连续 503 的 Chrome E2E 验证 fail-closed：用户输入尚未持久化时不发起模型请求，失败 turn 不冒充成功；刷新后用户可显式开启新 turn。原 prompt 不保证自动重放，Worker 终止后的 pending event 也没有 durable outbox。
- pending queue 只保留活动 Worker 内存中的 event references；单次 HTTP serialization 有 1 MiB 上限，但整个 Session backlog 没有独立 durable outbox 或总字节预算。
- 真实模型 compaction/刷新/sentinel smoke 通过；完整真实模型文件流程在三次工具执行后遇到空最终响应。该失败不能归类为 Session transport 回归，也不能宣称真实模型文件闭环 E2E 通过。
