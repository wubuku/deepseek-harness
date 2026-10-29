---
description: "记录 Browser-Native DSH 多 Session 挂载与恢复验证的实施、真实 Chrome 证据、回归结果和限制。"
---

# Browser-Native DSH Session 挂载与恢复验证进度

## 当前状态

状态：本批已完成实现、定向单测、真实 Chrome Dedicated Worker probe、已有生命周期回归和一次真实 LLM smoke。本批在 `research` 主 worktree 进行，没有创建隔离 worktree；Safari/WebKit 按当前安排暂停。

## 里程碑

| 里程碑 | 状态 | 证据 | 下一步 |
| --- | --- | --- | --- |
| M0：候选范围与状态定义 | `complete` | 计划、验收矩阵和非目标已记录 | 进入实现 |
| M1：事件与 owner 状态机 | `complete` | `browser-native-session-mount.spec.ts`；3 个文件共 11/11 通过 | 保留 coordinator 为 PoC-local 适配器 |
| M2：Worker test seam | `complete` | `browser-native-worker.ts` 与 `preview.ts` 的 URL-gated `session-mount-probe` | 进入真实 Worker 验收 |
| M3：真实 Chrome Dedicated Worker | `complete` | `session-mount-lifecycle.e2e.mjs`：多 Session、park/resume、去重、身份重连、owner 状态和 terminate 后 unknown 均通过 | 保留 scripted probe 的证据边界 |
| M4：回归、真实 LLM、文档与交付 | `complete` | 真实 `gpt-5.6-sol` Chrome smoke、TypeScript、preview build、文档门禁和交付检查均完成 | commit、push 后暂停 |

## 事实边界

- 当前 DSH Worker 已有远程 Session persistence、owner epoch、Session cursor、outbox 和 handoff 能力，但尚无正式多 Session 页面 mount UI。
- 本批新增的 coordinator 是 `docs/drafts/browser-native-dsh-poc` 内的验证适配器，不是正式 DSH Session API，也不替代 DSH Agent Loop。
- 真实 Chrome 通过只证明 Worker bundle 执行了状态矩阵；必须单独记录真实 LLM smoke，不能用 scripted probe 冒充模型能力。
- 页面关闭后的 execution 只能标记为 `unknown` 或由显式新 owner 查询恢复，不能声称 Dedicated Worker 继续作为后台 Agent 运行。

## 实施结果

`BrowserNativeSessionMountCoordinator` 为每个 Session 保留独立 cursor、Worker identity、owner、可用性和 execution 状态。切换 active 只把旧 Session 变为 `parked`，不取消其 `running` 或 `waiting` execution；history 未完成、seq gap、同序冲突和旧 identity 都拒绝继续投影。Worker replacement 通过新 identity 重新 hydrate；页面或 Worker dispose 将未结算 execution 标为 `unknown`，晚到结果只计数而不改变结算。

Worker test port 在真实 Chrome Dedicated Worker 中挂载三个 Session，验证 parked turn 继续、history-before-live、重复回放、`occupied`/`busy`/`unavailable` fail-closed、新 Worker identity 和旧 identity 拒绝，以及 active/waiting execution dispose 后的 unknown settlement。该 probe 不执行真实模型工具调用，也不把 coordinator 当作正式多 Session UI。

真实 LLM smoke 使用 `gpt-5.6-sol` 完成普通 `read → write → read`，刷新后恢复同一 Session/Workspace；观测到 59 个 Session events、`durableThroughSeq=58`，8/8 个 LLM HTTP 请求为 200。该 smoke 证明本批接线没有破坏已有 DSH loop、Session durability、Workspace 恢复和同源凭据边界，不证明真实模型能自主管理多个 Session。

## 命令与结果

| 命令或检查 | 结果 |
| --- | --- |
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-session-adapter.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-session-mount.spec.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-session-read.spec.ts` | 3 个文件，11/11 通过 |
| `pnpm exec tsc -p apps/web/tsconfig.json --noEmit` | 通过 |
| `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；保留既有 native platform、tsdown 和 chunk size 警告 |
| `node --check docs/drafts/browser-native-dsh-poc/tests/session-mount-lifecycle.e2e.mjs` | 通过 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-mount-lifecycle.e2e.mjs` | 通过；3 个 Session，parked execution 继续，重复事件去重，owner 状态拒绝，Worker identity 重连，dispose 后 unknown，`pageErrors=0`、`workerErrors=0`、`externalRequests=0` |
| `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy DSH_POC_LLM=real DSH_POC_BROWSER=chrome DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_DURABLE_WORKSPACE=1 DSH_POC_REFRESH_CYCLES=1 DSH_POC_LLM_TIMEOUT_MS=180000 DSH_POC_TURN_TIMEOUT_MS=600000 node docs/drafts/browser-native-dsh-poc/tests/runtime-validation.e2e.mjs` | 通过；真实模型、59 个 Session events、`durableThroughSeq=58`、8/8 LLM HTTP 200；日志仍有既有 preview API 404 和 compaction warning，不宣称 console 完全干净 |

## 未覆盖范围

本批不覆盖生产多实例 backend、跨设备/跨浏览器授权、自然 storage eviction、OS/磁盘崩溃、Safari/WebKit、真正的 Browser-to-Cloud executor handoff 和正式多 Session UI 的视觉验收。`parked` 只表示页面投影不在前台，不表示页面关闭后 Worker 或 Agent 在后台继续运行；dispose 后的 `unknown` 也不是副作用已成功或已回滚的证明。
