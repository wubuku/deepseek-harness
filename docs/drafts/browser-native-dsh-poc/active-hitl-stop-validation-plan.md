---
description: "验证活动 HITL 接管 Web composer 时，显式 Stop 是否取消当前 DSH turn 并保留准确的 Session 结果。"
---

# Browser-Native DSH 活动 HITL 停止验证计划

## 目标

当前 Web 问答卡接管 composer 后没有可见 Stop；Escape stop shortcut 也拒绝 pending interaction。用户只能回答或等待 timeout，无法明确停止仍在等待 HITL 的 Agent turn。本批接入 DSH `ConversationController.cancel()`，在官方问答 composer 提供明确 Stop，并用真实 Chrome Worker/Host 验证 legacy 与 timed HITL 的取消结果。

Stop 只取消当前 Session 的活动 Agent turn，不回答问题、不伪造工具成功、不把收起问题卡当作取消。按钮只在问答仍有 live waterfall 且所属 Session 正在运行时显示；timed question 已超时并转为可迟答状态后，不显示旧问题的 Stop，以免取消另一个 turn。

真实 LLM smoke 是本批必验项：至少完成真实 Chrome、同源 backend、真实模型的一轮对话并检查 Session turn、LLM HTTP 状态、页面错误、外部网络请求和浏览器中无模型凭据。HITL Stop 的稳定时序由 scripted LLM Chrome E2E 验证；真实普通对话不能代替该交互验收，scripted 通过也不能代替真实模型 smoke。

## 候选范围与选择

| 候选验证点 | 价值 | 本批处理 | 理由 |
|---|---:|---|---|
| 活动 legacy/timed HITL 显式 Stop 与 DSH cancel 闭环 | P0 | 实施 | 当前正式 Web composer 在 Agent 等待用户时没有停止入口，直接阻断用户收束能力。 |
| Stop 后 tool result、turn terminal、问题投影和副作用的一致性 | P0 | 实施 | 取消请求成功不等于工具成功或副作用回滚；必须检查 Session 和 Workspace 最终状态。 |
| Stop 与提交答案、timed timeout 的精确并发竞态 | P1 | 做确定性单测或受控 Chrome 检查；不宣称验证所有调度顺序 | DSH Session/interaction 测试拥有底层结算语义；浏览器侧需证明 UI 不重复取消、不伪造成功，边界交错可由双方确定性测试覆盖。 |
| 超时后的 continued question 与另一个活动 turn 的 Stop 隔离 | P0 | 实施负例断言 | 避免旧问题卡上的停止动作取消无关的新 turn。 |
| 多标签页同时停止或回答同一 HITL | P1 | 保留候选 | 需要界定共享 Session owner、答案准入和另一个页面 UI 的产品策略，不是单页 Stop 的前置条件。 |
| Worker dispose、页面关闭与显式 Stop 的差异 | P1 | 保留候选 | Worker 终止后的 unknown settlement 已有独立验证；本批只覆盖用户主动调用 DSH cancel。 |
| 真实模型选择 `ask_user_question` 并等待答案 | P1 | 不作为 Stop 通过标准 | 模型是否使用 HITL 具有提示词和模型方差；scripted 明确构造待取消状态更适合确定性检验。真实 LLM smoke 仍验证修改后的正式 Web 组合可用。 |
| Session 恢复后取消不可恢复的旧 Promise | P1 | 保留候选 | 刷新恢复与 legacy/timed 的既有验证保持独立，不把取消与恢复混为同一协议。 |
| backend 多实例、自然 eviction、OS crash、Safari | P0 产品风险 | 不纳入 | 需要不同的基础设施或浏览器环境，本批不扩展这些运行时声明。 |

## 实施范围

1. 在 `ui-user-questions` 的 session-scoped slot inject 中提供窄 `cancelTurn()` 回调，组件不接触 Cordis Context 或 Conversation service 对象。
2. 通用问答与 plan review 仅在 Session 正运行、卡片仍持有 waterfall 时显示带 tooltip 的 Stop 按钮；停止失败显示本地化错误。
3. 增加 UI 单测，覆盖运行时按钮、完成态隐藏、取消调用、失败反馈、continued question 不显示，以及 plan review 入口。
4. 扩展 Browser-Native Chrome E2E，分别验证 legacy 与 timed 活动问题取消后 turn 非 completed、问题不再可答、没有后续业务写入；超时后的迟答问题没有 Stop。
5. 更新中英文 package README、PoC README、timed HITL 计划/进度、兼容矩阵、drafts 导读和 `change-ledger.md`。目录外 UI package 修改只限必要的 Stop UI，ledger 记录原因、验证和上游重放方式。

## 验收矩阵

| 场景 | UI 预期 | Session / Workspace 预期 | 禁止结果 |
|---|---|---|---|
| 活动 legacy 问答 | 显示 Stop；点击后按 DSH 状态移除活动 composer | 原 turn 以非 completed 终态结束；原问答无成功答案；无后续 write/Workspace revision | Stop 被当作答案、turn 标记 completed、文件副作用发生 |
| 活动 timed 问答 | live waterfall 期间显示 Stop | DSH cancel 收束当前 turn；不生成迟答 user message 或后续 write | 生成成功 tool result 或由 Stop 触发新 turn |
| timed timeout 后的 continued question | 原问题可回答，但不显示 Stop | 已结束的提问 turn 保持 pending；迟答仍按既有路径工作 | 旧卡上的 Stop 取消后来运行的其他 turn |
| Stop API 失败 | 按钮恢复可用并显示本地化失败提示 | 保留当前 Session 状态；不声明取消成功 | 静默失败、隐藏问题或报告 turn 已停止 |
| 真实 LLM smoke | 真实 Chrome UI 完成一轮普通对话 | 同源代理收到模型请求且 Session turn completed | 只凭 scripted LLM 声称真实模型通过；浏览器访问第三方模型端点或泄露凭据 |

## 执行顺序

1. 修改前确认 `research` 分支、干净工作区和无隔离 worktree；保留当前 checkout 作为可复现基线。
2. 先实现官方 UI inject 与 Stop 控件，再补组件单测和 PoC scripted Chrome 场景。
3. 运行定向 UI、DSH interaction、Browser-Native backend 与 Chrome E2E；有失败先修正实现及测试。
4. 构建 Web preview，运行一次真实 LLM Chrome smoke，随后运行文档门禁和差异审查。
5. 将实际命令、脱敏结果、限制和重放步骤写入进度与 ledger；验证完成后提交本批全部变更并 push `research`。

## 证据限制

真实 LLM smoke 只证明当前真实 provider、Worker、Web UI 和 Session 的普通对话路径，不证明模型会自主选择 HITL，也不证明 HITL Stop 的每种调度竞态。Stop 的业务闭环以真实 Chrome、真实 DSH Host/Worker 和 deterministic scripted tool call 为证据。取消请求不保证撤销取消前已提交的外部副作用。
