---
description: "记录 Browser-Native DSH timed HITL 生命周期验证的基线、Chrome 结果、故障与已知限制。"
---

# Browser-Native DSH timed HITL 生命周期验证进度

## 原批次状态及后续更正

状态：timed HITL 的六个 Chrome 场景已执行；同轮回答、超时迟答、两类 Worker 刷新恢复和关闭面板恢复均通过。活动问答期间 UI 不提供 Stop，Escape shortcut 也被 pending-interaction guard 抑制，这是本批发现的产品限制，不是通过项。

后续更正：上句记录的是原批次验证当时的 UI。官方 composer 已在[活动 HITL Stop 验证](active-hitl-stop-validation-plan.md)中增加显式 Stop；timed 与 legacy 活动问答的 Chrome E2E 均观察到 `turn/end:aborted`，无成功答案、迟答消息、Workspace write 或 revision 增加。Escape shortcut 仍忽略 pending interaction，Close 仍只隐藏问题卡。

基线：`research` 分支与 `origin/research` 一致；开始时工作区干净，只有主 worktree。当前 checkout 是 DSH `v0.2.1-rc.2` 合并后的状态。PoC 默认 Browser profile 使用 legacy `tool-ask-user`；现有 `ask-user-refresh-recovery.e2e.mjs` 只验证 legacy 等待在刷新后以 `TOOL_OUTCOME_UNKNOWN` 和 interrupted turn 收束，不能说明 timed schema 不支持迟答。

源码核对发现 DSH `tool-ask-user` 已支持 `mode: timed`，`userQuestions` projection 会从已记录 schema、tool result/unknown 和 `user-question-reply` 推导 continued/settled 问题；Web UI 也能从 Session projection 重建 continued card。以上是当前源码能力，不是 Browser Worker 组合已通过的证据。

## 里程碑

| 里程碑 | 状态 | 证据 | 下一步 |
|---|---|---|---|
| M0：候选审查与基线 | `complete` | [计划](timed-hitl-lifecycle-validation-plan.md)记录候选范围、现有源码语义和不重复的验收目标 | 临时 timed profile fixture 已加入 validation 镜像构建器；默认 profile 未变 |
| M1：截止前同轮作答 | `complete` | Chrome `in-time`：原 `tool/result` 记录 Yes，原 turn 随后只执行一次 `write` 并完成，Workspace revision 为 1 | 保留为 timed 同轮基线；不外推真实模型选择行为 |
| M2：timeout 与迟答 | `complete` | Chrome `late-answer`：原结果保持 `pending`，迟答以原 callId 的 `user-question-reply` 写入 Session；后续 turn 仅一次 write/Workspace revision，刷新没有重复答案或副作用 | 评估多标签答案竞争与持续运行的 Agent 是否需要独立政策 |
| M3：刷新后重建原问题 | `complete` | Chrome `refresh-before-answer`：原 call 结算为 `TOOL_OUTCOME_UNKNOWN`，原 turn 非 completed；同 callId 的继续问题可作答；没有重放原 prompt/tool，只有显式迟答产生一个模型请求 | 该路径依赖 timed schema；legacy 刷新语义保持 unknown/interrupted |
| M4：迟答 durable 后再刷新 | `complete` | Chrome `refresh-after-answer`：答案落盘后在模型回复屏障处刷新；恢复不重复 answer/ask，未完成回复 turn 保持非 completed；问题不再可编辑，显式新消息可继续 | 不承诺自动恢复中断的模型回复或工具调用 |
| M5：关闭、刷新恢复与 Stop 可用性 | `complete with limitation` | Chrome `hide-refresh`：关闭只隐藏 panel，刷新后同 callId 卡片可恢复并提交。Chrome `stop-unavailable`：问答 composer 占用交互时无 Stop 按钮；Escape shortcut 被 pending-interaction guard 忽略，原问题仍可回答。文档和本地门禁通过 | 正式产品需决定是否允许显式取消 timed/legacy HITL；当前证据不表示 Stop settlement 已通过 |

## 执行记录

| 日期 | 命令或操作 | 结果 | 下一步 |
|---|---|---|---|
| 2026-10-26 | `git status --short --branch`; `git worktree list`; `git log -1 --oneline` | `research` 与 `origin/research` 一致；无隔离 worktree；工作区干净；当前头部为 Browser-Native 安全点验证提交 | 在主工作区实施 |
| 2026-10-26 | 核对 `tool-ask-user/src/timed.ts`、`user-questions/src/index.ts`/`projection.ts`、Web question UI、Browser profile 与 legacy refresh E2E | DSH 源码具有 timed wait、pending/unknown 问题恢复、迟答 `user-question-reply` 和 inbox 去重；Browser PoC 默认仍是 legacy schema，现有 Chrome E2E 未覆盖 timed 路径 | 用临时 validation 镜像显式切换到 timed schema，并实测真实 Worker tunnel |
| 2026-10-26 | `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` | 通过；构建存在既有 warning（详见命令输出），预览 bundle 包含真实 DSH Host 与 Worker profile | 执行分场景 Chrome E2E |
| 2026-10-26 | `DSH_POC_BROWSER=chrome ... DSH_POC_TIMED_QUESTION_TIMEOUT=10 DSH_POC_TIMED_HITL_SCENARIO=in-time node docs/drafts/browser-native-dsh-poc/tests/timed-hitl-lifecycle.e2e.mjs` | 通过；4 个模型请求（含标题请求），单 Session，无页面错误或跨源请求 | 验证 timeout 后迟答 |
| 2026-10-26 | `DSH_POC_BROWSER=chrome ... DSH_POC_TIMED_QUESTION_TIMEOUT=10 DSH_POC_TIMED_HITL_SCENARIO=late-answer node docs/drafts/browser-native-dsh-poc/tests/timed-hitl-lifecycle.e2e.mjs` | 通过；5 个模型请求，单 Session，无页面错误或跨源请求；pending result 未被迟答改写，write 与 Workspace commit 均只有一次 | 验证 Worker refresh |
| 2026-10-26 | `DSH_POC_BROWSER=chrome ... DSH_POC_TIMED_HITL_SCENARIO=refresh-before-answer node docs/drafts/browser-native-dsh-poc/tests/timed-hitl-lifecycle.e2e.mjs` | 修复 wait helper 将隐藏 composer 误当未就绪后通过；同 callId continued question 可回答，没有重放 prompt/tool | 验证 durable late reply refresh |
| 2026-10-26 | `DSH_POC_BROWSER=chrome ... DSH_POC_TIMED_HITL_SCENARIO=refresh-after-answer node docs/drafts/browser-native-dsh-poc/tests/timed-hitl-lifecycle.e2e.mjs` | 通过；答案 durable 后刷新没有重复 answer/tool，未完成回复 turn interrupted，显式 follow-up 可继续 | 验证 hide 与 Stop |
| 2026-10-26 | `DSH_POC_BROWSER=chrome ... DSH_POC_TIMED_QUESTION_TIMEOUT=30 DSH_POC_TIMED_HITL_SCENARIO=hide-refresh node docs/drafts/browser-native-dsh-poc/tests/timed-hitl-lifecycle.e2e.mjs` | 通过；隐藏不结算调用，刷新后同 callId 问题恢复并只产生一条迟答 | 验证活动问题期间的 Stop 实际可用性 |
| 2026-10-26 | `DSH_POC_BROWSER=chrome ... DSH_POC_TIMED_QUESTION_TIMEOUT=30 DSH_POC_TIMED_HITL_SCENARIO=stop node docs/drafts/browser-native-dsh-poc/tests/timed-hitl-lifecycle.e2e.mjs` | 初始尝试显示：Stop 按钮不可见，等待 30 秒后已越过 deadline；随后 Escape 尝试没有取消，工具已 pending。源码显示 stop shortcut 对 `pendingInteraction` 直接拒绝；改成明确验收 unavailable 后通过。 | 复跑最终 `stop-unavailable` 场景并更新产品限制文档 |
| 2026-10-26 | `DSH_POC_BROWSER=chrome ... DSH_POC_TIMED_QUESTION_TIMEOUT=30 DSH_POC_TIMED_HITL_SCENARIO=stop-unavailable node docs/drafts/browser-native-dsh-poc/tests/timed-hitl-lifecycle.e2e.mjs` | 最终版本通过；活动问答无 Stop 按钮，Escape 不取消；原 call 仍由用户回答并成功完成，无页面错误或跨源请求 | 将取消不可用列为当前 DSH Web UI 产品限制 |
| 2026-10-26 | `node --check` 三个 PoC `.mjs` 文件；`node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 语法检查通过；backend contract tests 42/42 通过 | 检查正式问答和 Web UI 适配单测 |
| 2026-10-26 | `pnpm exec vitest run packages/interaction/tool-ask-user/tests/tool-ask-user.spec.ts packages/interaction/user-questions/tests/user-questions.spec.ts packages/client/ui-user-questions/tests/browser-plugin.client.spec.ts packages/client/ui-tool/tests/ask-question-row.client.spec.tsx` | 4 个测试文件、159 项通过；Vite 输出既有 `vite-tsconfig-paths` 提示 | 运行 docs gates |
| 2026-10-26 | `pnpm run test:docs` | 首次运行因新增进度文件引用 commit hash 而失败；删除 hash、改为研究分支基线描述后复跑，21/21 gates 通过 | 运行完整文档同步门禁 |
| 2026-10-26 | `pnpm run doc-sync` | 43/43 gates 通过，包括 doc-typecheck、网站构建、链接、翻译配对、文档预算和 repository references | 最终 diff 与提交范围检查 |

## 证据与限制

- Chrome E2E 使用真实页面、Dedicated Worker、DSH Host、Session backend、Workspace persistence 和 scripted LLM；它们证明当前 checkout 的协议/生命周期，不验证真实模型选择或答案质量。
- 旧 legacy refresh E2E 的“刷新后不显示可回答旧问题”只适用于 legacy schema；本批 timed schema Chrome 验证了同 callId continued question 可恢复并接受迟答。
- 原批次活动问答没有 Stop；后续专项已补足可见 Stop 并验证 DSH turn cancellation。Escape stop shortcut 仍因 `pendingInteraction !== undefined` 忽略按键；用户关闭 keyed panel 仍只是隐藏，不会取消请求。Stop 不撤销此前已经提交的副作用。
- 新增测试使用 scripted LLM 固定 tool call 顺序；不验证真实模型是否选用 timed HITL、是否正确理解 pending 指令或摘要质量。
- Chrome 以外的浏览器、自然 eviction、OS 级 crash、生产多实例 backend 与真实 SaaS 授权均未纳入。
