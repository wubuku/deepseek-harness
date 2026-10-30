---
description: "记录 Browser-Native DSH Session 编排、目标停止、模型路由切换和 Worker admission 验证的实施进度与证据边界。"
---

# Browser-Native DSH Session 编排验证进度

## 当前状态

状态：M0-M4 完成，按研究草稿交付。候选范围、选择依据和退出条件见[验证计划](next-session-orchestration-validation-plan.md)。本批直接在 `research` 主工作区实施，不创建隔离 worktree；未跟踪的 `.archify/` WIP 不在本批范围内。

## 里程碑

| 里程碑 | 状态 | 结果 |
| --- | --- | --- |
| M0：候选审查与计划 | `complete` | 已结合 DSH-TUI 的多 Session、park、targeted stop 和 model switch 语义，确定 Browser-Native 可验证范围与非目标。 |
| M1：编排器与 parked execution | `complete` | 新增 validation-only 编排器，使用正式 `ctx.agents.create()`、Agent handle、mount coordinator 和 `installModelSelection()`。park 只改变投影，不取消执行。 |
| M2：真实 Chrome active/parked 与 targeted stop | `complete` | Chrome 156 在一个 Dedicated Worker 中运行三个 Agent；parked Agent 继续执行，目标 Session 单独取消，其他 Agent 完成且事件、prompt 和请求身份隔离。 |
| M3：route switch、失败转移与 admission | `complete` | running turn 拒绝换 route；idle 后故障 route 只请求一次并显式失败，recovery route 可继续；validation-only admission 拒绝第五个 Agent。 |
| M4：真实 LLM smoke、回归、文档与交付 | `complete` | 真实 `gpt-5.6-sol` 同源 smoke 完成 `read → write → read` 与刷新恢复；focused tests、Preview build、TypeScript 和文档检查已执行，交付限制见下文。 |

## 预期证据

| 证据 | 预期 |
| --- | --- |
| 单测 | `BrowserNativeSessionMountCoordinator` 允许 parked owned Session 建立 execution；不可用、无 owner、重复 execution 仍 fail closed；route switch 在 running 状态拒绝。 |
| Chrome Worker | 一个 Dedicated Worker 托管三个真实 DSH Agent；park 不取消；只停止目标 parked Session；其他 Session 继续完成；每个 Session 事件和请求身份隔离。 |
| Route | running turn 不换 route；idle 后故障 route 只请求一次并以 error 收束；recovery route 新 turn 成功并记录 model-selection notice。 |
| Admission | 第五个 Agent 被拒绝，前四个 Agent 仍可完成；没有多余 Worker、Session 或 model request。 |
| 真实 LLM | 同源 backend 代理完成普通 `read → write → read` 和刷新恢复烟测；凭据不出现在浏览器请求、Worker 日志或 Session。 |

## 实施记录

### 2026-10-31：Chrome scripted 编排验收

在 `research` 主工作区运行 `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`，随后运行 `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/browser-native-session-orchestration.e2e.mjs`。Chrome 156.0.8078.79 通过一个 Dedicated Worker 托管三个 Agent，验证并行等待、active/parked 切换、目标取消、route failure/recovery 和四 Agent admission；页面错误、Worker 错误和跨源请求均为零。该测试使用 scripted backend barrier，不调用真实模型。

同时复跑 `node docs/drafts/browser-native-dsh-poc/tests/same-worker-multi-session.e2e.mjs`、`node docs/drafts/browser-native-dsh-poc/tests/session-projection-authority.e2e.mjs`、`node docs/drafts/browser-native-dsh-poc/tests/session-owner-handoff.e2e.mjs` 和 `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs`；既有回归分别通过，backend 为 56/56。PoC TypeScript focused run 为 449/450；唯一失败是既有 `content-upload-client.spec.ts` 的请求序列假设，独立复跑仍稳定失败，未由本批修改引入。

### 2026-10-31：真实 LLM smoke

使用 `gpt-5.6-sol`、同源 backend 代理和 `docs/drafts/.env` 运行 `DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs`。Chrome 完成真实 DSH `read → write → read`、刷新重连和同 Session 续聊；记录 52 个 Session event、`durableThroughSeq=52`，8 个模型请求均为 HTTP 200。浏览器网络和日志未发现模型密钥，也没有跨源请求。

该 smoke 没有验证真实模型自主地同时驱动多个 Agent、真实模型 route switch 或多 Agent 资源容量。输出中仍有预览 UI 404、compaction context-capacity warning 和刷新时旧请求 abort，因此不能写成 console 完全干净或完整多 Agent 真实 LLM E2E。

### 2026-10-31：代码与文档检查

`pnpm exec tsc -b tsconfig.client.json --pretty false` 通过；Preview build 通过；`pnpm run verify-md-wrap`、`pnpm run verify-md-links`、`pnpm run doc-typecheck` 和 `git diff --check` 已执行。`pnpm run test:docs`、`pnpm run doc-sync` 和 push 前检查应在本批文档更新后再执行；本节不预先宣称其结果。

## 已知限制

本批结果只说明当前 Chrome/Worker/PoC backend 拓扑中的语义。scripted barrier 证明并发等待、取消隔离和错误收束，不证明真实模型并发能力；真实 LLM smoke 只证明普通文件工具与刷新接线，不证明模型自主多 Agent 或 route switch。四 Agent 上限是 validation-only admission，不是生产容量。Dedicated Worker 仍受页面生命周期约束，不是后台 Agent；生产多实例 backend、正式 handoff、Safari、自然 eviction 和 OS crash 仍需独立验证。
