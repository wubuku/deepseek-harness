---
description: "记录 Browser-Native DSH 多 Session 共享 Workspace 的 observer、stale read 和写权接管验证进度。"
---

# Browser-Native DSH 多 Session Workspace 观察验证进度

## 当前状态

状态：本批实施和验证完成，尚待提交与推送。工作区基线为 2026-10-28 的干净 `research` checkout；只有主 worktree，没有隔离 worktree。浏览器目标为 Chrome，Safari/WebKit 暂停。范围和验收标准见[验证计划](shared-workspace-observer-validation-plan.md)。

## 基线事实

| 事实 | 当前 checkout 证据 | 本批含义 |
|---|---|---|
| Session observer 已支持只读 `read`，无 owner 的 append 返回 `409 SESSION_OWNERSHIP_LOST`。 | `tests/session-observers.e2e.mjs` | 只证明同一 Session 的事件观察，不代表多个 Session 可共享 Workspace。 |
| 明确 `WORKSPACE_ALREADY_OWNED` 时第二个 Session 以 observer 启动；其他身份、网络、存储和 ownership 错误仍 fail closed。 | `browser-native-workspace.ts`、`tests/shared-workspace-observer.e2e.mjs` | Chrome 验证独立 Session 可继续聊天并只读访问已提交 manifest。 |
| observer 不读、不恢复、不改写共享 IndexedDB retry snapshot，也不执行 abandoned-edit 清理或 blob reconciliation。 | `browser-native-workspace.ts`、`tests/browser-native-workspace.spec.ts`、`tests/shared-workspace-observer.e2e.mjs` | E2E 在 owner commit 失败形成 retry batch 后，逐字段比较 observer 启动前后的共享 snapshot。 |
| observer 只发布 `read`、`grep`、`glob` Workspace 文件工具；文件调用前检查 manifest revision，stale 后撤销 Workspace 工具。 | `browser-native-capability-publication.ts`、`browser-native-providers.ts`、双 Session Chrome E2E | 已验证一次读取增加一次 revision 请求；过期读取不返回旧内容、不写 commit/receipt，后续 schema 不再含 Workspace 工具。 |
| 最近一次独立真实 LLM smoke 的完整模型响应均为 HTTP 200，但 Playwright 记录 5 个 LLM `ERR_ABORTED` request-failure callbacks。 | `browser-lifecycle-ownership-validation-progress.md` | 作为后续候选，不将其与本批 Workspace ownership 混为一项，也不推断 abort 原因。 |

## 里程碑

| 里程碑 | 状态 | 结果/证据 | 下一步 |
|---|---|---|---|
| M0：候选范围与现状核查 | `complete-with-deviation` | 重新阅读 DSH-TUI 参考备忘、其当前源码基线、Session observer E2E、Workspace lease handoff、capability publication、Workspace hydration 和最近生命周期批次。确认旧 observer 验证只针对 Session，不覆盖共享 Workspace。没有在修改前另跑双标签 Chrome 基线；旧行为由 lease 冲突源码和既有 handoff E2E 核对，双标签 E2E 只验证最终行为。 | 保留该基线范围限制，不把最终 E2E 描述成变更前复现。 |
| M1：只读 observer 启动与能力投影 | `complete` | 双 Session Chrome E2E 确认 Workspace 共享而 Session ID 不同；observer 完成 `read`，模型 schema 仅含只读文件工具；scripted upstream 伪造 schema 外 `write` 后由 Worker capability guard 拒绝；活跃 writer 的 retry snapshot 未被改变。 | 继续验证 revision stale。 |
| M2：revision stale 拒绝 | `complete` | owner 提交 revision 2 后，observer 的下一次工具读取增加一次 manifest 检查并失败 stale；Workspace tool schema 撤销；没有新增 Workspace commit 或跨 Session receipt。 | 继续验证显式刷新和 fencing。 |
| M3：显式刷新与写权接管 | `complete` | 用户点击刷新后 observer 重新 hydrate 并获得 fencing token 2；旧 token renew 返回 `409 WORKSPACE_OWNERSHIP_LOST`；接管后的 Session 单独获得一个 write receipt，最终 revision 为 3。 | 运行真实 LLM smoke 与文档门禁。 |
| M4：真实 LLM、文档与交付 | `complete` | 真实 Chrome/LLM 普通文件 smoke、双标签 scripted E2E、focused tests、backend tests、preview build、定向 Oxlint、typecheck、test:docs、doc-sync 和 diff whitespace 检查均通过；README、兼容矩阵、drafts 索引和 change ledger 已更新。变更范围检查、提交和推送仍待执行。 | 检查远端是否前进，完成 `change-scope`，再提交并推送 `research`。 |

## 实际检查

| 命令或检查 | 结果 |
|---|---|
| `git status --short --branch`、`git worktree list`、`git log -5 --oneline --decorate` | 起始状态为 `research` 与 `origin/research` 一致，工作区干净，只有主 worktree。 |
| DSH-TUI checkout 状态与 HEAD | `dsh-TUI` 为 `main...origin/main`，HEAD `29572774`，与当前参考架构备忘锁定的源码提交一致；参考仓库工作区干净。 |
| 现有多观察者 E2E、Workspace handoff E2E 与相关源码阅读 | 已核对。Session observer 直接读同一个 Session；Workspace handoff 仍是同一 Session 的两个 Worker 顺序交接，不覆盖两个 Session 同时共享 Workspace。 |
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-capabilities.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-control-channel.spec.ts` | 通过，3 个文件、32 项。新增断言确认 observer/stale 状态下 Workspace flush 无请求、无状态覆盖。 |
| `pnpm exec tsx scripts/run-oxlint.ts apps/web/src/browser-native-control-channel.ts apps/web/src/browser-native-page-control.ts apps/web/src/locales/browser-native-workspace.ts docs/drafts/browser-native-dsh-poc/browser-native-capability-publication.ts docs/drafts/browser-native-dsh-poc/browser-native-providers.ts docs/drafts/browser-native-dsh-poc/browser-native-worker.ts docs/drafts/browser-native-dsh-poc/browser-native-workspace.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-capabilities.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-control-channel.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/shared-workspace-observer.e2e.mjs` | 通过，无诊断。全仓 `pnpm run lint` 先前失败于未修改文件 `apps/web/src/browser-native-recovery.ts`、`packages/core/tools/tests/json-schema.spec.ts`；本批变更文件定向 Oxlint 通过。 |
| `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 通过，47/47。 |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过。构建输出包含既有 Darwin ARM64 上不适用的 native package 警告、deprecated bundler option 警告及大 chunk 警告；VFS image 生成成功。 |
| `node docs/drafts/browser-native-dsh-poc/tests/shared-workspace-observer.e2e.mjs` | 最终版本 scripted Chrome E2E 通过。两个 Session 共用 Workspace；owner commit 503 后相同 operation 成功重试；observer 不改 shared retry snapshot，可读已提交文件但看不到 pending 文件；schema 外伪造 `write` 由 Worker capability guard 拒绝且无文件、commit 或 receipt；stale read 被拒且撤销 Workspace 工具；显式刷新后 fencing token 由 1 升至 2，旧 token renew 为 409；revision 最终为 3，Session receipt 数为 `[1,0,0,0,1]`，成功 Workspace commit 恰 3 个且 operationId 唯一。五条用户 prompt 各写入一次，12 次模型请求，无 page error 或跨源请求。 |
| `DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_TURN_TIMEOUT_MS=600000 node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | 真实 `gpt-5.6-sol` smoke 通过：3 turns，第一 turn `read → write → read`，刷新后同 Session 恢复文件，59 个 Session events、`durableThroughSeq=58`、8/8 LLM HTTP 200、2 次 DOM 可见流更新、`pageErrors=0`，LLM 只请求同源 backend。首轮 settle 约 61.6 秒；另记录到刷新/轮次结束相关 `ERR_ABORTED` callbacks 和 compaction 无 context capacity warning，完整模型响应仍为 HTTP 200；这些记录不属于双 Session scripted 验收，也不推断为 provider 故障。密钥未打印。 |
| 浏览器网络与错误响应 | 双 Session E2E 记录零跨源请求；预期故障注入为一次 Workspace commit 503、两次 lease 409；preview 仍有 `/open-in-app/apps`、`/api/changes.summary`、`/api/present.host` 404。页面没有未处理异常。 |
| `pnpm run typecheck`、`pnpm run test:docs`、`pnpm run doc-sync`、`git diff --check` | 类型检查 5/5、快速文档门禁 21/21、完整文档门禁 43/43，均通过；diff whitespace 检查通过。 |

## 限制与待验证项

本批证明的是单同源 PoC backend、同一 Chrome BrowserContext、两个独立 Session 和当前匿名 identity cookie 下的单 writer/多只读观察模式。它不验证跨设备身份、生产授权、多实例 backend、并发 Workspace 写合并、自然 eviction、Chrome/OS crash、真实模型自主选择 observer 操作或 Safari/WebKit。真实 LLM smoke 只覆盖普通文件闭环，不覆盖多 Session 故障时序。每次 observer 文件工具都同步查询 manifest revision，会增加一次同源 backend 请求；延迟和高并发成本未测。UI 状态提示固定在页面上缘，完整产品布局适配仍需验证。
