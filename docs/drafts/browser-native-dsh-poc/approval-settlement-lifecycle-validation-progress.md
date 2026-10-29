---
description: "记录 Browser-Native DSH 审批授权、FIFO、取消、迟到决定和刷新恢复的实测进度。"
---

# Browser-Native DSH 审批结算生命周期验证进度

## 状态

本批实施与验证已完成。基线为本批起始时的 `research` HEAD，主工作区起始干净，无隔离 worktree；工作均在 `research` 主工作区完成。

本批把 DSH-TUI `ApprovalStore` 的 FIFO、abort、消费 callId 与迟到结果纪律带入 Browser-Native 验证。已有 PoC 的真实 Chrome 证据覆盖正式审批拒绝和刷新 unknown；缺少真实 Allow once、串行审批调用和活动审批取消闭环。当前审批卡没有可见 Stop 控件，取消场景改用专用 Worker test MessagePort 调用公开 Agent `cancel()`；这不验收正式 UI 的 Stop 交互。

## 候选范围与选择

评估候选包含有效授权与副作用、并发 FIFO、Agent abort、无 answerer/unavailable、跨 Session owner、刷新 audit reconciliation、同 callId 重放、policy hydration、自然冻结/强杀，以及真实模型自主触发审批。本批聚焦真实 Allow once、同一模型响应中两项 exclusive 审批工具调用的串行结算、通过 Worker test MessagePort 调用 Agent `cancel()` 和 late-decision 修复；刷新与真实模型作为回归。源码说明 bash 是 exclusive tool，因此不把真实 UI 场景写成两个同时 pending；projection 的 FIFO 仍由 Worker probe/单测覆盖。无 answerer 场景暂不以 mock 返回值冒充，跨 Session owner 与 OS 级故障保留后续验证。

## 已实施

Projection 现在会拒绝 tool/result 后到达的 `approval/decided`，诊断码为 `DECISION_CALL_SETTLED`。projection 单测、Worker probe 和 Chrome E2E 断言已更新；上一轮代码审查发现这个时序缺口后，先在工作区修正并并入本批继续验证。

## 已完成里程碑

- M1 projection late-decision：Vitest 4/4；Chrome Worker probe 重建 `DECISION_CALL_SETTLED` 诊断，拒绝把迟到决定投影为授权。
- M2 真实 Allow once：正式 UI 产生一条 `allowed-once` decision、一个成功 tool/result 和一个文件写入；该 turn 发出两次模型请求。
- M3 同一模型响应中的两项审批调用：两个 exclusive bash 调用串行出现；首项允许且写入一次，次项拒绝且无文件；无同时 pending 的双审批 UI 主张。
- M4 Agent 取消及后续 turn：审批卡出现时，经 URL-gated Worker test MessagePort 调用公开 `Agent.cancel()`；Session 记录 `cancelled`、原 tool/result 失败、无文件副作用，turn 以 `aborted` 结束；后续普通 turn 成功。此结果不表示 UI Stop 控件已实现。
- M5 刷新 unknown 回归：刷新时 `TOOL_OUTCOME_UNKNOWN`/`interrupted`，无额外 LLM 请求、无审批卡和无文件副作用。
- M6 真实模型多轮记忆与 todo tool 烟测：Chrome `gpt-5.6-sol` 完成三轮；41 个 Session events，`durableThroughSeq=40`，5/5 模型 HTTP 200，记忆和单次 todo 写入断言通过。
- `pnpm run test:docs`：最终复跑通过 21/21；`pnpm run doc-sync`：最终复跑通过 43/43。
- `pnpm run lint`：仓库级 lint 失败，报错均在未修改文件；本批三个 TypeScript 文件的定向 oxlint 通过。提交与 push 待执行。

## 实际命令与结果

- `node --check docs/drafts/browser-native-dsh-poc/tests/approval-settlement-lifecycle.e2e.mjs`：通过。
- `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-approval-projection.spec.ts`：1 file、4 tests 通过。
- `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs`：56/56 通过。
- `pnpm exec tsc -p apps/web/tsconfig.json --noEmit --pretty false`：通过。
- `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview`：通过；保留当前平台包、tsdown deprecation 和大 chunk warnings。
- `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/approval-settlement-lifecycle.e2e.mjs`：Chrome 156.0.8078.48 通过。Allow once、串行审批、Agent cancel、后续 turn 均通过；总共 8 个 scripted LLM 请求；page errors、Worker errors 和外部请求均为 0。
- `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/approval-integrity-recovery.e2e.mjs`：通过。刷新前后 LLM 请求均为 5；结果为 `TOOL_OUTCOME_UNKNOWN`/`interrupted`，无审批卡和文件。
- `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy DSH_POC_BROWSER=chrome DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_TURN_TIMEOUT_MS=600000 node docs/drafts/browser-native-dsh-poc/tests/browser-native-v2.e2e.mjs`：真实 `gpt-5.6-sol` 完成三轮，5/5 LLM HTTP 200、41 events、`durableThroughSeq=40`、多轮 token 记忆和单个 todo 写入断言通过。Browser console 有既有 `/open-in-app/apps` 404；未将其描述为零告警。
- 首次 `pnpm run test:docs` 因进度文件包含仓库禁止的 commit hash 失败；改为引用批次起始 `research` HEAD 后最终复跑通过 21/21。
- `pnpm run doc-sync`：最终复跑通过 43/43。
- `pnpm exec oxlint apps/web/src/preview.ts docs/drafts/browser-native-dsh-poc/browser-native-permission-probe.ts docs/drafts/browser-native-dsh-poc/browser-native-worker.ts`：通过。
- `pnpm run lint`：失败于未修改的 `packages/core/tools/tests/json-schema.spec.ts:251`、`apps/web/src/browser-native-recovery.ts:62`、`apps/web/src/browser-native-recovery.ts:252`；另有 `packages/experimental/client-ui-cot-translation/src/index.ts` unused suppression warning。没有扩大范围修复。
- `git diff --cached --check`：staged diff 通过。

## 未验证与限制

本批取消由 test MessagePort 调用 Agent API，不是正式 UI 的 Stop 操作；当前审批卡没有已验证的 Stop 控件。当前也没有移除默认 Web `ui-approval` answerer 的 preview test switch；本批不会把 test-only `unavailable` outcome 写成“无 answerer”。真实缺少 answerer 的 Worker/client 组合、双标签/跨设备 owner、自然 eviction、OS/browser process crash、Safari/WebKit 和页面关闭后后台 Agent 仍未验证。

## Dev Note

本记录只说明当前 checkout 的实验状态。审批允许、拒绝和取消仍由正式 DSH ApprovalService 写入 Session；projection 与 test-only browser worker probe 不授予工具权限。
