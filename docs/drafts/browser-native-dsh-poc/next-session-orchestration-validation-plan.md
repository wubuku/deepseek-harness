---
description: "规划 Browser-Native DSH 多 Session 前后台投影、目标停止、模型路由切换和 Worker admission 的联合验证。"
---

# Browser-Native DSH Session 编排验证计划

## Summary

DSH-TUI 证明了一个宿主进程可以同时托管多个 Agent，切换查看对象不会停止其他 Session，停止操作只影响目标 Session，模型切换在运行中的 turn 不能生效且下一轮才使用新路由。Browser-Native DSH 不能把 Dedicated Worker 说成宿主进程，也不能把页面关闭后的执行说成后台 Agent；本批验证这些交互语义在浏览器 Worker 的真实 DSH Agent Loop 中能保留到什么程度。

本批只在 `docs/drafts/browser-native-dsh-poc` 的 validation profile 中实施。DSH Session event log 仍是事实来源，Worker 内的 DSH Host 仍是唯一 Agent Loop；页面只驱动测试控制端口和投影适配器。scripted LLM 用于确定性地保持多个真实 turn 在途，真实 LLM 只做正常回归烟测和一次 route 选择记录，不把 scripted 选择能力写成模型推理证据。

-----

## 候选范围与取舍

| 候选验证点 | 价值 | 本批决定 | 需要回答的问题 |
| --- | ---: | --- | --- |
| 一个 Worker 中多个 Agent 的 active/parked 投影 | P0 | 纳入 | parked 只改变显示目标，是否仍保持真实 DSH turn 运行和独立 Session 事件？ |
| 只停止一个后台 Session | P0 | 纳入 | targeted stop 是否只取消目标模型请求，其他 Session 是否完成且没有跨 Session 事件？ |
| 运行中的模型 route 切换 | P0 | 纳入 | route 变更是否在活动 turn 中拒绝，而不是把一个 request 拆成两条路由？ |
| 终止旧 route 后下一 turn 显式切换 | P0 | 纳入 | 失败是否明确收束；下一轮是否只使用新 route，是否记录可重建的 model-selection notice？ |
| Session 数量上限与 admission | P1 | 纳入 | 页面在超过 validation 上限时是否拒绝创建，而不是无界创建 Worker/Agent？ |
| 同 Worker CPU 工具公平性 | P1 | 复用既有证据 | 既有 blocking/cooperative CPU E2E 已证明同步阻塞和 cooperative yield 的差异，本批只检查编排控制不会绕过该边界。 |
| 单页多 Worker pool | P1 | 不纳入 | 需要独立的 Worker supervisor、资源预算和 UI 生命周期，不用本批的 Agent registry 代替。 |
| 页面 hidden/freeze/pagehide 后继续运行 | P0 边界 | 只记录 | Worker 受页面生命周期约束；本批不实现云端 executor，也不宣称页面关闭后继续。 |
| 真实模型并发容量和 SLA | P1 | 不纳入 | scripted barrier 可测语义，不能代替真实供应商延迟、配额和容量测试。 |
| 多实例 backend / 跨设备 Session handoff | P1 | 不纳入 | 当前 PoC backend 的单进程队列不能证明生产多实例一致性。 |

## 实施设计

### M0：统一 Session 编排控制器

新增 PoC-local `BrowserNativeSessionOrchestrationProbe`，经正式 `ctx.agents.create()` 创建多个真实 DSH Agent，并为每个 Agent 绑定 `BrowserNativeSessionMountCoordinator` 和 `installModelSelection()`。编排器只保存 mount、Agent handle、执行 id 和可变 model selection；它不写第二份 Session 事实。

`BrowserNativeSessionMountCoordinator.beginExecution()` 必须允许拥有写权且状态为 `available` 的 parked Session 开始执行。active/parked 是页面投影状态，不是 Agent Loop admission 状态；如果只允许 active 才能开始执行，就无法表达 DSH-TUI 的后台 Session 语义。

### M1：真实 active/parked 与 targeted stop

测试在一个 Dedicated Worker 中启动三个 Agent，等待三个模型请求都到达 backend barrier，然后把其中两个 Session 依次 park/activate。检查 parked Session 的真实 `Agent.status` 仍为 `running`，其 Session 仍只收到自己的事件。停止其中一个 parked Session，检查只有目标请求关闭并以 `aborted` 收束；另两个 Session 继续完成，且各自只产生一次 model request、一次 terminal turn 和自己的 assistant marker。

### M2：route 切换和失败转移

编排器暴露 validation-only `switch-route` 和 `followup` 控制。活动 Agent 为 `running` 时，route 切换必须拒绝；Agent idle 后切到一个故障 route，下一轮只发送一次该 route 的 request，明确记录 error，不静默复制原 prompt。随后显式切到 recovery route 并发送新 turn，确认 request 使用新 route，Session 中有 `model-selection` notice，失败 prompt、恢复 prompt 和 terminal event 均可从 log 重建。

### M3：admission 与资源边界

validation profile 将编排器的并发 Agent 数上限固定为 4，超过上限的创建请求 fail closed，并保证已创建 Agent 在部分失败时全部 dispose。测试还记录实际 Dedicated Worker 数、Agent 数、Session 数、model request 数和每个 Session 的 terminal reason；不把一个 Worker 中的 Agent 数量换算为生产容量或浏览器通用上限。

### M4：回归和真实 LLM 烟测

复跑既有 stream failure、same-worker multi-session、CPU contention、session mount、handoff 和 Workspace 恢复回归。每次代码改动后至少运行一次真实 `gpt-5.6-sol` Chrome 普通 `read → write → read` 烟测；本批另记录一次真实模型正常 route request 的 provider/model 字段，但不要求真实模型自主触发多 Session 或 route switch。所有真实模型凭据仍只由同源 backend 从 `docs/drafts/.env` 读取。

-----

## 验收矩阵

| 场景 | 通过条件 | 禁止结论 |
| --- | --- | --- |
| A、B、C 在一个 Worker 中运行，A 被 park，B 被 activate | A 的真实 Agent 仍 running，B 成为 active，Session 事件不串流 | 页面已经具备正式多 Session UI |
| 停止 parked A | A 的 LLM response 关闭并以 `aborted` 结束；B/C 完成；A 无重复 tool 或 model request | 所有副作用都已回滚 |
| running turn 中切换 route | 控制请求拒绝，原 request 仍使用原 route 且只出现一次 | 可在任意时刻热切换 provider |
| idle 后切到故障 route | 下一 turn 一次请求、明确 error、无隐式重试或重复 prompt | provider 永久不可用时自动恢复 |
| 切到 recovery route 后新 turn | request 使用新 route，model-selection notice 和新 terminal event 进入 Session | route 选择可由页面内存恢复而无需 Session event |
| 第五个 Agent admission | 请求拒绝，前四个 Agent 不受影响，部分失败不泄漏 handle | 4 是所有 Chrome/设备的容量 SLA |
| pagehide/Worker terminate | 未结算执行变为 `unknown`，刷新后不重放旧 request | 页面关闭后仍有后台 Agent |

## 证据边界

真实 Chrome 证明当前 checkout 的 Dedicated Worker、DSH Host、AgentRegistry、Session persistence 和 PoC 编排器在测试过的 Chrome 版本中遵守上述语义。scripted barriers 证明并发、取消和错误收束，不证明真实模型延迟、工具选择或生产容量。route switch 只验证 DSH 已有 `installModelSelection()` 在 Browser adapter 中的接入，不证明所有 provider 的 catalog、权限、配额和 fallback 策略。Worker 仍受页面生命周期约束；后台显示不等于云端执行。

## 实施顺序

1. 先写编排器单测和 `beginExecution()` parked 语义测试。
2. 增加 URL-gated Worker test port、validation profile 和真实 Chrome E2E，覆盖 active/parked、targeted stop、route switch、failure/recovery 和 admission。
3. 运行既有 Worker/Session/Workspace 回归，并在每次实现修改后运行真实 LLM smoke。
4. 更新 PoC README、兼容矩阵、drafts 索引、进度记录和 change ledger，记录真实执行命令、Chrome 版本和未验证边界。
5. 运行定向测试、preview build、typecheck、文档门禁和 pre-push 检查，再提交并推送 `research`。

## 明确不在本批范围

本批不修改正式 Agent Loop、Session format、默认产品 profile 或根依赖，不创建页面级 Worker pool，不实现云端 handoff，不验证 Safari、自然 eviction、OS crash、生产多实例 backend 或真实模型并发容量。`parked` 只表示当前页面投影不在前台；页面关闭后的状态只能是已结算或 `unknown`。

## Dev Note

如果真实 Chrome 暴露 DSH Agent 选项、route notice 或 Session event 的实际顺序与本计划不同，应以当前源码和持久化事件为准修正测试与文档，不通过页面 projection 伪造成功状态。
