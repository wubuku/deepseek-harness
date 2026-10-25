---
description: "记录活动 HITL Stop 验证的实现状态、命令、结果与未验证项。"
---

# Browser-Native DSH 活动 HITL 停止验证进度

## 当前状态

状态：实施和运行验证完成，文档门禁与提交待完成。活动 legacy/timed HITL 的显式 Stop、超时后 continued question 的 Stop 隔离、Session/Workspace 终态和真实 LLM Chrome smoke 均已执行。

基线：2026-10-26，当前分支 `research` 与 `origin/research` 一致；开始时工作区干净，只有主 worktree。原有 Chrome scripted timed HITL 矩阵通过，但活动问答无 Stop；`stop-shortcut.ts` 会忽略任何 pending interaction。

## 里程碑

| 里程碑 | 状态 | 证据 | 下一步 |
|---|---|---|---|
| M0：候选评估与基线 | `complete` | [实施计划](active-hitl-stop-validation-plan.md)记录候选面、取舍、边界与验收矩阵 | 实现 session-scoped cancel 注入和 UI |
| M1：官方 composer Stop | `complete` | Session-scoped cancel callback；通用问答与 plan review 控件；组件测试 63/63 通过 | 构建 preview 并跑真实 Chrome DSH cancel E2E |
| M2：真实 Chrome DSH cancel 闭环 | `complete` | timed 与 legacy 活动问答 turn 均 `aborted`；无成功回答、迟答消息、write 或 Workspace revision；continued question 无 Stop | 更新 package 文档、兼容矩阵和旧限制记录 |
| M3：真实 LLM Chrome smoke | `complete` | Chrome + 同源 backend + `gpt-5.6-sol` 完成三轮；5 次模型 HTTP 请求均为 200；跨轮记忆正确；恰有一次 todo 写入；Session 41 个事件、`durableThroughSeq=40`；浏览器无模型凭据和跨源请求 | 不将普通模型对话外推成模型自主选择 HITL |
| M4：文档与交付 | `in progress` | package 双语文档、PoC 导读、兼容矩阵、原 timed HITL 记录已更新；仍需完成账本、翻译配对和文档门禁 | 检查完整 diff，通过文档门禁后提交并 push `research` |

## 执行记录

| 日期 | 命令或操作 | 结果 | 下一步 |
|---|---|---|---|
| 2026-10-26 | `git status --short --branch`; `git worktree list` | `research` 与 `origin/research` 一致；工作区干净，仅主 worktree | 实施 UI 与 E2E |
| 2026-10-26 | 阅读 `packages/client/AGENTS.md`、Client UI/Slots/Conversation 文档、`ui-user-questions` composer 与 `ui-conversation` cancel API | 确认必须通过 session-scoped `ConversationController.cancel()`；隐藏卡片不是取消；停止失败需保留状态并显示错误 | 按计划添加窄 callback，不把 service 对象传入 React |
| 2026-10-26 | `pnpm exec vitest run packages/client/ui-user-questions/tests/user-questions-composer.client.spec.tsx packages/client/ui-user-questions/tests/plan-review-panel.client.spec.tsx` | 2 个文件、63 项通过；覆盖活跃 Stop、失败反馈、timed continued 负例和 plan review | 浏览器验收 DSH turn 取消与无业务副作用 |
| 2026-10-26 | `node --check docs/drafts/browser-native-dsh-poc/tests/timed-hitl-lifecycle.e2e.mjs`; `node --check docs/drafts/browser-native-dsh-poc/backend-v2.mjs`; `git diff --check` | 全部通过 | Web preview build |
| 2026-10-26 | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 首次构建通过，但 PoC preview 读取到旧 `ui-user-questions/lib/`，新 Stop 控件未打入 VFS；第一轮 timed Chrome 脚本因此找不到按钮，不能判为 cancellation 行为失败 | 先 bundle UI package，再重建 preview |
| 2026-10-26 | `pnpm --filter @deepseek-ai/dsh-client-ui-user-questions run bundle`; `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | package bundle 与 preview build 均通过；构建保留既有 unsupported-platform 和 chunk-size warnings | 跑 timed/legacy Stop E2E |
| 2026-10-26 | `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js DSH_POC_TIMED_QUESTION_TIMEOUT=30 DSH_POC_TIMED_HITL_SCENARIO=stop-timed node docs/drafts/browser-native-dsh-poc/tests/timed-hitl-lifecycle.e2e.mjs` | 通过；真实 Chrome Worker/DSH timed 活动问答 Stop 产生 aborted turn；无成功答案、user-question-reply、write、Workspace revision 或外部请求 | 验证默认 legacy schema |
| 2026-10-26 | `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js DSH_POC_TIMED_HITL_SCENARIO=stop-legacy node docs/drafts/browser-native-dsh-poc/tests/timed-hitl-lifecycle.e2e.mjs` | 通过；真实 Chrome Worker/DSH legacy 活动问答 Stop 产生 aborted turn；无成功答案、user-question-reply、write、Workspace revision 或外部请求 | 运行真实 LLM Chrome smoke |
| 2026-10-26 | `DSH_POC_BROWSER=chrome DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env DSH_POC_PORT=4196 DSH_POC_LLM_TIMEOUT_MS=600000 DSH_POC_TURN_TIMEOUT_MS=900000 node --use-env-proxy docs/drafts/browser-native-dsh-poc/tests/browser-native-v2.e2e.mjs` | 真实 Chrome 与同源 backend 通过 `gpt-5.6-sol` 完成三轮；5 次模型请求均 HTTP 200；跨轮记忆正确；todo 只写入一次；Session 有 41 个事件、`durableThroughSeq=40`。没有页面异常或跨源请求；仅有已知且不阻断流程的 `/open-in-app/apps` 404。命令未输出密钥。代理端口未监听，但本轮模型 API 域名直连成功 | 完成变更账本、双语配对和文档门禁 |
| 2026-10-26 | `pnpm exec vitest run packages/client/ui-user-questions/tests/user-questions-composer.client.spec.tsx packages/client/ui-user-questions/tests/plan-review-panel.client.spec.tsx` | 2 个文件、63 项通过；覆盖 composer Stop、取消失败反馈、continued question 不显示 Stop 和 plan-review Stop | 文档门禁和最终差异复核 |

## 未验证与限制

- 普通真实 LLM 对话已通过，但没有验证模型是否自主选择 HITL 或 Stop；这是有意限制，HITL Stop 时序由确定性 scripted tool call 验收。
- Stop 不回滚已提交的工具/API 副作用；Session 终态和工具结果由 DSH cancel/recovery 语义决定，实施后以持久化事件实测。
- Safari、真实模型自主选择 HITL、多标签答案/停止竞争、生产 backend HA、自然 eviction 和 OS 级 crash 不属于本批验收。
