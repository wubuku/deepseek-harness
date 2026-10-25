---
description: "规划 Browser-Native DSH timed HITL 的同轮回答、超时后迟答、Worker 重建和取消生命周期验证。"
---

# Browser-Native DSH timed HITL 生命周期验证计划

## Summary

Browser-Native PoC 目前用 DSH 默认 legacy `ask_user_question` 验证同步问答，并在刷新时将失去的等待结算为 `TOOL_OUTCOME_UNKNOWN`。DSH 当前实现还支持 timed question：前台等待可超时，Agent 可继续独立工作，Session projection 仍保留原问题，迟到回答通过 `user-question-reply` 消息进入同一 Agent Session。现有 PoC 没有启用 timed schema，也没有在真实 Chrome Worker/Host 中验证这些跨生命周期语义。

本批在临时 Browser profile 中启用 DSH 已有 timed 工具和官方 Web 问答 UI，不改变默认 profile 或正式 DSH packages。验证用户在截止前回答、截止后 Agent 继续并接受迟答、刷新重建后沿用原 callId 回答，以及隐藏问题面板与停止 Agent 的不同结果。主要证据是当前 checkout 中真实 Chrome、Dedicated Worker、DSH Host、Session backend 和 scripted LLM；它验证执行与持久化时序，不代表真实模型选择或回答质量。

## 候选范围与取舍

| 候选 | 价值 | 本批 | 判断依据 |
|---|---:|---|---|
| 截止前作答后，原 tool call、答案和同一 turn 是否闭环 | P0 | 纳入 | 确认 timed schema、Worker Remote、Web 问答 UI 和原调用者在未过期路径协作。 |
| 超时后 Agent 继续，迟答以 `user-question-reply` 进入新 turn | P0 | 纳入 | 验证 DSH 已有的 late-answer inbox 是否在 Browser Worker 中真正可用，且不伪造旧 tool result。 |
| 刷新中断 foreground wait 后，Session projection 是否恢复同一问题 | P0 | 纳入 | 通用恢复已把 legacy 问答标为 unknown；timed schema 应能把原 call 投影为 continued 并由新 Worker 接受迟答。 |
| 迟答已 durable、Worker 随后重建时，是否重复提交或重复调用 | P0 | 纳入 | 验证 Session user message、inbox 和 question projection 之间的恢复次序及重复副作用防护。 |
| 关闭问题面板与主动停止 Agent 的语义是否不同 | P0 | 纳入 | 关闭 keyed card 应只隐藏面板；检查当前 UI 是否能在活动问答期间停止 turn，并以源码和 Chrome 结果准确记录其语义。 |
| 截止时刻的 answer/timeout 竞态与双击提交 | P1 | 保留为候选 | 精确时序主要由 DSH 包内确定性测试覆盖；先用 Chrome 验证可复现的先到/后到路径，避免依赖真实计时器竞争宣称正确。 |
| 两个 Session 同时展示相同 callId 的问答隔离 | P1 | 延后 | UI 以 Session + callId 建卡；需要多会话页面工作流，非本批恢复语义的前置条件。 |
| 多标签页共同回答同一 continued question | P1 | 延后 | 需要显式定义一条已排队答案的 owner、页面恢复和竞争 UI；本批先验证一个 Session writer 下的原生 answer 队列合同。 |
| Worker dispose 后无人接手的 timed wait 到期 | P1 | 部分纳入 | 通过刷新/stop 验证销毁收束；长时间无人接手 timer 的上限和挂起页面行为不作为本批 SLA。 |
| 真实 LLM 是否选择 timed 问答、如何解释 pending | P2 | 不纳入 | 本批目标是 Worker/Session/UI 恢复协议；确定性 scripted 工具调用比模型行为更适合检验事件顺序。 |
| 多实例 backend、生产授权、跨设备 answer delivery | P0 产品风险 | 不纳入 | 当前 PoC backend 是单进程模型，没有生产用户、租户或共享数据库授权合同。 |

## 设计边界

- 默认 `browser-native-profile.cordis.patch.yml` 保持 legacy 问答；仅临时测试镜像将 `tool-ask-user` 设置为 `mode: timed` 并配置短测试 timeout。
- 复用现有 `@deepseek-ai/dsh-user-questions`、`@deepseek-ai/dsh-client-ui-user-questions`、Session projection、inbox 和 Browser Worker Remote tunnel；不复制 question state，不新增第二套 message history。
- 问题身份始终是 Session 中原始 `tool/call` 的 callId；刷新后不得生成新的 ask call 来替代它。
- 截止前回答应以原工具的 `tool/result` 结算，并在原 turn 中继续。超时结果保持 pending；迟答必须成为 source 为 `user-question-reply` 的 `user/message`，由 Agent 后续 turn 消费，不得重写或补造旧工具结果。
- `TOOL_OUTCOME_UNKNOWN` 表示 Worker 丢失时 foreground Promise 未完成；只有 timed tool schema 的 Session projection 可以让该问题继续可回答。legacy 问答仍按既有中断语义处理。
- 关闭带 callId 的卡片只撤下 composer 面板，问题仍有效；主动停止 Agent 是 turn cancellation，必须有明确终态且不可留下可回答的过期卡片。
- E2E 使用动态 loopback 端口、独立临时 `dataDir` 和隔离 Chrome context；所有页面、Worker、浏览器和 backend 在 `finally` 中关闭并等待结束。

## 交付面

### M1：Timed profile fixture 与同轮作答

- 扩展临时 runtime validation 镜像构建器，以结构化 YAML 修改 profile 中 `tool-ask-user` 的 `mode` 和测试 timeout；拒绝缺失或重复的插件项，不改默认 profile 文件。
- 增加 scripted marker，发出稳定 callId、单个可选答案和后续 `working_directory` / `write` 工具序列。
- Chrome E2E 验证官方问答卡显示、用户在 deadline 前提交、答案只产生一个原 `tool/result`，之后工具在同一 turn 中执行一次，Session receipt 和 Workspace revision 一致。

### M2：超时后独立继续与迟答

- scripted 模型在 timed tool 返回 pending 后先结束原 turn，不执行受答案控制的业务写入。
- 等待 Session 记录 pending tool result 和原 turn terminal，再从继续可见的问题卡提交答案。
- 验证答案作为 `user-question-reply` source 的用户消息记录在同一 Session；原 tool result 仍是 pending；后续独立 turn 只执行一次获准的业务写入；刷新不重复 ask call 或写入。
- 关闭并重开问题卡时不得重置 deadline、移除投影问题或调用 answer RPC。

### M3：刷新期间的 Worker/Session 恢复

- 在真实 DSH `tool/call` 已持久化、timed wait 仍 open 时刷新页面，确保刷新先于测试 deadline。
- 验证新 Worker 的 Session repair 将旧工具结算为 `TOOL_OUTCOME_UNKNOWN`、旧 turn 非 completed，且 timed question projection 将同一 callId 保留为 continued。
- 通过恢复后的官方 UI 提交答案；检查 `user-question-reply`、新 turn 与工具调用数，确认不重跑原 prompt/tool，也不把迟答伪装成旧工具结果。

### M4：迟答提交与 Worker 重建竞态

- 通过受控 scripted 模型延迟，让晚答 user message durable 后、Agent 产生最终文本前刷新 Worker。
- 验证历史中只有一个对应 `user-question-reply` 和一个原 ask call；question projection 已 settled 而不是 active；页面重建不重新显示可编辑卡片、不重复提交答案。
- 确认未完成的回复 turn 按 DSH recovery 语义收束，随后显式新用户消息能继续同一 Session。该结果不承诺自动重跑模型或原业务操作。

### M5：面板关闭、停止可用性与文档

- 对 open timed wait 关闭卡片并刷新，检查 Worker 重建后官方 UI 从 Session projection 恢复同一 callId，提交答案后只产生一条迟答消息。
- 检查活动 timed question 期间是否呈现 Stop 按钮，并通过官方 Escape stop shortcut 验证是否能取消该 turn。若 UI 抑制取消，记录精确源码条件、Session 结果和产品限制，不将它描述为已验证的 Stop settlement。
- 更新 PoC README、兼容矩阵、本计划和进度、`docs/drafts/README.md`；更正既有文档中把 timed late-answer 说成未实现的表述，说明旧证据仅覆盖 legacy schema。

## 验收矩阵

| 场景 | Session 预期 | UI 预期 | 禁止结果 |
|---|---|---|---|
| deadline 前回答 | 原 `tool/result` 含答案，原 turn 完成 | 原问题卡提交后关闭 | 第二个 ask call、额外 user turn、重复副作用 |
| timeout 后迟答 | 原 result 保持 pending；迟答是带原 callId 的 `user-question-reply` | Agent 可继续后问题仍可回答 | 改写旧 result、把迟答记作普通无来源消息、超时前副作用 |
| Worker 刷新后迟答 | 原 call 为 unknown；同 callId 的 user reply 结算 projection | 新 Worker 重建可编辑问题卡 | 原 prompt/tool 自动重跑、丢卡或错误展示 legacy 卡 |
| late reply durable 后刷新 | 只有一条 user reply；问题 settled | 显示已回答记录，不可再次编辑 | 重复 answer、重新打开 active question、伪造模型完成 |
| 关闭卡片并刷新 | 刷新前无结算；重建后同 callId 的迟答进入 Session 一次 | 面板关闭不取消；刷新后问题可恢复并提交 | 隐藏即取消、创建新 ask call 或丢失问题 |
| 活动问答期间 Stop | 当前 UI 不暴露 Stop；Escape shortcut 因 pending interaction 被忽略，原 call 仍可回答 | 明确记录停止不可用，不伪称 turn 已中断 | 将 UI detach 或快捷键按下说成取消成功 |

## 候选后续与明确限制

本批不测试浏览器后台运行、真实多标签竞争、生产多实例 Session backend、Safari/WebKit、真实 LLM 选择质量或模型上游延迟。Worker 刷新只模拟页面生命周期重建；它不等价于操作系统崩溃。若 M3/M4 暴露 DSH Remote/Session 恢复缺口，只在 Browser PoC 适配层修复；若需要修改正式 `user-questions`、Agent Loop 或 Session format，先停止该路径并记录最小 upstream 需求，不在 PoC 中暗改核心语义。

## 实施顺序

1. 核对 `askTimed()`、`userQuestions` projection/inbox、UI `publishContinuedQuestions()`、Browser Worker Remote tunnel 与已有 legacy refresh 证据。
2. 结构化启用 timed tool 的测试镜像，先完成截止前同轮作答 E2E。
3. 扩展 scripted backend 并完成 timeout/late-answer、refresh/continued-question、late-reply-before-restart 三项真实 Chrome E2E。
4. 完成 close/refresh 恢复与 Stop 可用性 Chrome E2E；若停止被 UI 生命周期抑制，将其作为产品级限制和后续决策项。
5. 运行 DSH interaction package 定向测试、PoC backend/profile 测试、preview build、Chrome E2E 和文档门禁；记录所有未执行项，不把 scripted 证据描述为真实模型证据。

## Further Exploration

- [DSH-TUI 参考架构启发](../dsh-tui-reference-architecture-memo.md)：live/replay 一致性、显式取消结果和执行者生命周期。
- [Browser-Native PoC](README.md)：运行时职责、当前验证入口和已知限制。
- [DSH 用户问答服务](../../../packages/interaction/user-questions/README.md)：timed question、continued reply 和 Session projection 的正式包语义。
