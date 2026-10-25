---
description: "记录 Browser-Native DSH Session 适配、取消销毁、能力发布和 Browser-to-Cloud handoff 验证的实施进度、证据与限制。"
---

# Browser-Native DSH Session 适配与执行交接验证进度

## 当前状态

状态：M1–M4 的 PoC-local 验证已完成，文档和回归仍在收尾。目标、候选范围和证据边界见[验证计划](next-session-adapter-and-handoff-validation-plan.md)。本批直接在 `research` 主工作区进行，不创建隔离 worktree；开始时工作区已有 TUI 参考备忘及其目录登记 WIP，本批未覆盖或清理这些修改。

## 里程碑

| 里程碑 | 状态 | 证据 | 下一步 |
|---|---|---|---|
| M0：候选范围与 TUI 启发审查 | `complete` | 已阅读 TUI Session adapter、channel continuity、capability detection/lifecycle/negotiate；确认 Workspace lease 不是 Agent handoff | 开始 M1 |
| M1：Session adapter conformance | `complete` | `browser-native-session-adapter.spec.ts` 3/3 | history-before-live、连续 seq、重复事件去重、gap、数据冲突和执行 identity 变更均 fail closed |
| M2：cancel/dispose settlement | `complete` | `browser-native-execution-lifecycle.spec.ts` 3/3 | `confirmed`/`unknown`/`failed`、重复 cancel/dispose、owner lost 和 late callback 均有确定语义；helper 仍由 PoC adapter 调用方显式接入 |
| M3：capability publication/preflight | `complete` | capability Vitest 与默认 profile Chrome | 只有 `live` 且带 probe 的能力进入 9 项模型 roster；staged、degraded、denied 能力不发布 |
| M4：Browser-to-Cloud handoff | `complete` | backend 26/26；`session-owner-handoff.e2e.mjs` Chrome 通过 | Worker 完成 DSH write 后提交 checkpoint；新 owner epoch 为 2，旧 append 返回 409，新 owner 可继续；backend 重启后 epoch 继续递增 |
| M5：回归、文档和提交 | `in-progress` | typecheck、preview build、聚焦 Vitest、backend 和两项 Chrome E2E 已通过 | 更新 README、索引、change ledger，运行文档门禁并复查全部 diff |

## 已实施的 PoC 适配器

- `browser-native-session-adapter.ts` 以 `BrowserNativeSessionCursor` 固定 history/live 顺序、seq 去重和执行 identity 检查；它是 Worker/page projection 的 conformance helper，不替换正式 `SessionPersistence`。
- `browser-native-execution-lifecycle.ts` 以 `BrowserNativeExecutionLifecycle` 区分取消请求、已确认结果、失败结果、owner 丢失和 dispose 后的 unknown；它不自行取消网络或回滚业务副作用。
- `browser-native-capabilities.ts` 增加 capability lifecycle、probe evidence、permission 和 model-facing publication；`browser-native-providers.ts` 现在在 LLM wire 层只序列化已发布的 Browser-Native roster。
- `backend-v2.mjs` 增加 Session handoff 路由。handoff 先提升 owner epoch/fencing，再持久化 Session checkpoint；旧 token/epoch 的 append、renew 和 LLM 请求被拒绝。`session-owner-handoff.e2e.mjs` 通过 Worker test port 发起 handoff，验证真实 Dedicated Worker 与 backend 的交接路径。

## 证据边界

- 真实 Chrome、Dedicated Worker 和 DSH Host 是 M4 的主要运行时证据；纯内存测试只证明协议状态机。
- scripted backend/LLM 可以验证确定性故障，但不能代表真实模型的工具选择质量。
- 本批不验证自然 storage eviction、OS/磁盘崩溃、生产多实例 backend、真实云 Durable Worker 或页面关闭后的后台 Agent。
- 所有未运行的检查必须在完成时明确列为未执行，不能把规划内容写成通过结果。

## 已运行命令

| 命令 | 结果 |
|---|---|
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-session-adapter.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-execution-lifecycle.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-handoff.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-capabilities.spec.ts` | 4 个文件、13/13 通过。 |
| `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 26/26 通过；包含 handoff 后 backend 重启的 epoch 递增。 |
| `pnpm run typecheck` | 5/5 gate 通过。 |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；保留既有平台和 chunk size warning。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/default-profile-capabilities.e2e.mjs` | 真实 Chrome 通过；模型 roster 9 项，无 page error、无跨源请求。 |
| `node docs/drafts/browser-native-dsh-poc/tests/session-owner-handoff.e2e.mjs` | 真实 Chrome Dedicated Worker handoff 通过；旧 owner append 返回 409，新 owner epoch 为 2。 |
