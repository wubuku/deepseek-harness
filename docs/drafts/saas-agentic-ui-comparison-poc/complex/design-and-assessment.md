# 复杂业务实验的设计与评估

## 参考范围

评估对象是已有丰富 GUI、没有聊天层的 React SaaS，不是一个新聊天产品。故事是客户续约：用户处理工单、切换客户、与 Agent 协同修改报价，在聊天里审核同一个报价组件，最后发送。相同业务对象、API、组件、模型、提示与故障标准约束三条路线；允许框架使用自身原生交互机制。

## 执行与状态

Dedicated Worker 内运行真实 Cordis Host、插件和默认 `ctx.agentLoop`。`worker-tools.ts` 通过 VFS 的工具服务注册页面能力，页面消息经过验证后撤销旧页面工具；没有改动正式 packages 或默认 Loop。工单页提供读取与批量分配，报价页提供读取、报价补丁和发送；只读角色撤销业务修改工具，后端仍独立校验角色。

DSH Session 拥有用户输入、工具调用、模型可见上下文和工具结果。业务 API 拥有报价、审批、工单与 receipt。React 与 CopilotKit 是投影和交互入口，不是另一份模型历史或业务数据库。`useAgentContext` 收集的数据经 `page_read` 的真实 DSH 工具结果进入日志，而不是私下拼入 LLM 请求。工具 JSON schema 仍由 DSH 注册表提供，前端 hook 不接管 DSH 的能力权威。

GUI 与聊天中的 `QuoteEditor` 是同一组件，`submit` 是同一提交函数。报价使用字段补丁与 expectedVersion；人工预算保存后，Agent 仅调整折扣。修改撤销旧版本审批，发送只能接受人工批准的当前版本。每次写入使用稳定 operation id，相同请求返回原 receipt，不同参数复用 id 被拒绝；调用已开始后停止不承诺回滚。

这里的 Agentic UI 是确定性业务组件的选择、参数化呈现与可继续执行的交互，不是让模型生成任意 React 代码。用户切换已有页面后，新一轮模型请求只获得当前页面能力；没有额外实现自动导航工具。CopilotKit 的优势验证集中在原生调度和协作，而不是扩充业务权限。

| 标识 | 本实验映射 |
|---|---|
| AG-UI thread | DSH Session id；业务 workspace 另行标识 mock 数据，不代替 Session 或租户授权 |
| AG-UI run | 一次观察段，多个 run 可以对应同一个 DSH turn |
| DSH turn / step | turn 只由新用户 prompt 开始；step 由默认 Loop 执行模型请求与工具，不由前端续接创建 |
| message / tool call | 历史消息使用 DSH id，工具结果必须匹配原 call id；流式临时消息最终由已落盘消息替换 |
| Session seq | durable cursor 与 transient 去重位置，不能拿 AG-UI run 数代替日志顺序 |
| operation id | Agent 写入使用 Session id 与原 call id；审批增加 decision 后缀；一次 GUI 提交生成独立 id，查询或重试复用同一个 id |

## CopilotKit 的原生续接

```text
一个 DSH turn
  page_read 工具开始，等待页面
    AG-UI 段结束；原 DSH turn 不结束
    CopilotKit RunHandler 调用原生 useFrontendTool handler
    下一 AG-UI 段把相同 call id 的结果交回 Worker waiter
  DSH 继续请求模型
  ask_user_question 通过 DSH 问答服务等待
    AG-UI 段结束
    useHumanInTheLoop 呈现既有报价组件，用户编辑并 respond
    下一段把答案交回同一个 DSH 问答等待者
  DSH 读取新版本、调用发送工具、最终结束 turn
```

协议段不是新用户输入、不是新 DSH turn，也不是 CopilotKit BuiltInAgent 的模型循环。分段适配器仅在第一次用户消息时调用 `session.prompt()`；后续只结算原 pending call。CopilotKit handler 不提前直接结算 waiter，结果由它的原生执行设施生成 tool message，再由下一协议段交回 DSH。最终显示仍重新投影真实 Session。未使用会创建新 call id 的便捷工具执行 API。

`useFrontendTool` 注册随页面卸载；HITL 使用原生 respond，而不是直接调用一个从注册表偷取的函数。停止同时经过 CopilotKit stop 与同一 DSH Session cancel。取消和卸载观察分开：unsubscribe 只移除监听，用户 Stop 才取消执行。等待工具时锁住新消息输入，避免把新 prompt 误判为结果续接。缺少结果的续接拒绝并保留原暂停状态。

刷新不会保留旧页面函数。DSH 的中断恢复事实优先；没有结果的历史调用转成明确的中断展示，不能作为新的待审批动作自动执行。此策略不宣称任意组件卸载再挂载都能恢复执行中的业务交互。

## assistant-ui 如何实现同一业务闭环

assistant-ui PoC 没有仿造 CopilotKit 的三个 hooks，也没有第二套模型工具调度。DSH 注册表仍定义模型可见工具，DSH Worker 与页面桥执行工具；assistant-ui 的 ExternalStoreRuntime 投影 DSH Session，自定义 ToolCall renderer 将 DSH 工具调用显示成状态卡或可交互业务卡。普通页面动作由页面桥注册并调用共享 `executeCommand`，最终结果仍写回原 DSH 工具调用。

`useFrontendTool` 的业务等价路径是“DSH 工具 + 页面桥 handler + ToolCall 卡片”，而非 assistant-ui 内置 frontend-tool API。`billing_review`、`portfolio_review` 和 `ask_user_question` 仍是 DSH 中等待结果的工具；助手卡展示可编辑业务表单，批准或拒绝先调用 SaaS API 生成业务凭据，再用原始 `callId` 调用 `frontendTools.resolve`。DSH waiter 收到答案后，原 DSH turn 才继续。账单卡同时支持 CopilotKit 的 `respond` 与 DSH 的原 call-id 结算，业务表单和审批写入逻辑共用。

`useAgentContext` 没有 assistant-ui 的一对一 hook。页面桥更新当前页面上下文，`page_read` 读取新鲜业务数据并把上下文作为 DSH 工具结果记录；模型可见事实因此仍由 DSH Session 重建，而不是依赖 React 内存状态。此路径提供相同的页面协作结果，但需要应用维护上下文桥接与 DSH 事件投影。

因此，“assistant-ui 可实现等价功能”不代表它提供了等价框架设施：CopilotKit 为工具注册、人工介入和 Agent 上下文提供声明式 hooks；assistant-ui 提供聊天运行时和可定制消息/工具渲染，DSH 与 SaaS 应用承担调度和业务连接。两条路线共用业务 API、组件、权限、版本校验、receipt 和 DSH Session；接入差异主要在框架集成责任，而不是业务闭环能力。对应代码见[共享业务实现](business.tsx)、[聊天层注册与投影](chat.tsx)和[页面工具目录](worker-tools.ts)。

## 三路线的实际区别

| 路线 | 本实验使用机制 | 实际承担的协调 |
|---|---|---|
| DSH 原生 UI | Cordis Client、原生聊天/输入、工具 slot | 不需要新增 AG-UI 投影，但已有 SaaS 与 DSH renderer 是不同 React root，需要显式同步业务 Context，否则聊天编辑后审批仍使用旧版本。 |
| assistant-ui | ExternalStoreRuntime、Message/Composer primitives、工具组件 | 外部 Session 投影接入集中；工具执行与人工等待由 DSH 页面桥协调，业务组件直接使用 SaaS React Context。 |
| CopilotKit | 官方 CopilotChat、原生 frontend handler、HITL respond、Agent context | 获得声明式工具注册、框架执行状态和人工交互设施，但仍需 DSH 分段适配、精确身份与结果结算，以及 Worker 工具目录同步。 |

不能再说“CopilotKit 原生工具和 HITL 只有理论价值”：本实验已有真实闭环。但也不能说它自动解决权限、协同合并、持久化、取消回滚或 exactly-once；这些仍由 DSH 与 SaaS 实现。与第一轮 renderer-only 接入相比，本轮增加了框架原生路径，同时也暴露了更复杂的协议时序与恢复维护成本。

这三项能力对成熟 SaaS 是适用的，尤其适用于“页面本身已经有业务组件，Agent 需要在当前页面读取、修改、展示和等待用户决定”的产品。`useFrontendTool` 可以把页面级 action 暴露给 Agent，`useHumanInTheLoop` 可以把既有表单或确认面板作为暂停点，页面协作能力可以让当前页面、选择项、角色和未提交编辑进入 Agent 可见上下文；它们解决的是 Agent 与既有 React GUI 的连接方式，而不是聊天气泡的样式。它们不能替代 DSH 的执行事实、Session 持久化、授权、版本校验、幂等和业务事务。

本实验没有证明这些能力“没有用”，只没有证明它们在“DSH 唯一 Agent Loop、同一批业务组件、单个复杂流程”的条件下已经降低总接入成本。assistant-ui 也能通过自定义工具卡、外部状态和 DSH waiter 完成同一流程，因此 CopilotKit 的收益必须在多个业务模块重复使用前端 action、HITL 和页面上下文后再衡量；如果产品只需要少量接入，CopilotKit 专属的 AG-UI 分段适配可能先成为成本。如果产品有大量页面协作和统一人工介入模式，CopilotKit 的声明式注册与交互生命周期可能摊薄这项固定成本。

## 相同复杂故事的实测与成本判断

| 评估面 | DSH 原生 UI | assistant-ui | CopilotKit |
|---|---|---|---|
| 已有 React 资产复用 | 聊天 renderer 与 SaaS 是不同 React root；需显式订阅和同步业务 Context。 | 业务组件留在 SaaS React 树中，ToolCall component 可直接复用；Session 投影和命令续接由适配器负责。 | 业务组件也留在 SaaS React 树中；frontend tool、HITL 与 Agent context 提供声明式应用交互入口。 |
| 复杂页面协作 | 可由 DSH tool slot 呈现，但需自行处理跨 root 状态同步、工作区装配和 SaaS 视觉裁剪。 | 能呈现复杂组件；本轮真实模型完成批量审核、版本冲突后的重新读取和提交。 | 本轮真实模型完成同一业务故事，并实际使用 CopilotKit 原生 frontend tool 与 HITL。 |
| DSH 执行一致性 | 最直接使用 DSH Client 与 Session 投影，不需 AG-UI 接线。 | 通过 ExternalStoreRuntime 投影 DSH Session；自定义执行桥仍需守住 call id、取消和恢复。 | DSH 仍是唯一 Loop 和事实来源；AG-UI 分段适配承担额外时序与身份维护。 |
| 当前证据强度 | 新复杂故事在 Chrome scripted 全流程通过；本轮没有为原生 UI 补做等量真实模型复杂故事。 | 与 CopilotKit 相同的新故事在真实 Chrome 与 Playwright WebKit 通过；WebKit 不等于 Safari.app。 | 与 assistant-ui 相同的新故事在真实 Chrome 与 Playwright WebKit 通过；另有真实生命周期证据。 |

两条第三方路线在新的批量续约故事中产生相同结果：每条路线、每种浏览器都记录 2 个用户 turn、5 个有配对结果的 DSH 工具调用、4 次业务写入和 1 次批量提交；模型代理 8 个请求中有 7 个对话模型请求与 DSH step 一一对应，另 1 个是标题请求。批准的方案遇到外部版本变更后，旧 `expectedVersion` 被拒绝，没有产生额外业务写入；重新读取、审核和批准后只提交一次。最终两家客户折扣、版本和 receipt 数一致，网络请求仅到同源 PoC 服务。

## 第三个业务模块：账单争议减免

为验证“固定适配成本是否能被多个业务模块摊薄”，本轮在同一个 DSH Worker、Session、`DshSessionAdapter`、`DshSegmentedAgent` 和 `FrontendBridge` 上新增账单模块，不复制 Agent Loop 或聊天层。流程是 `page_read` → `billing_review` → 用户在聊天中的共享账单编辑器修改金额和原因并批准 → `billing_apply`；三次工具调用属于一个 DSH turn，批准写入和账单提交各产生一份业务 receipt。

assistant-ui 与 CopilotKit 都在真实模型、安装版 Chrome 和 Playwright WebKit 中完成该流程，四份证据均记录 `page_read`、`billing_review`、`billing_apply`，2 次业务写入、1 个 DSH turn、同源网络和最终 `credited` 状态。WebKit 证据不等于 Safari.app 验收；原生 DSH UI 没有扩展到本模块的等量真实模型矩阵。

| 增量责任 | assistant-ui | CopilotKit | 是否复用既有 DSH 适配器 |
|---|---|---|---|
| 页面、业务 API、版本与 receipt | 增加账单领域字段、命令、共享编辑器和页面入口 | 相同 | 是，属于业务接入而非聊天框架专属逻辑 |
| DSH Worker 工具目录 | 增加 `billing_review` / `billing_apply` 及账单页面能力 | 相同 | 是，Worker 工具注册逻辑未复制 |
| 聊天层注册 | 复用已有 ExternalStoreRuntime、ToolCard 和 DSH Session 投影 | 增加一个 `useHumanInTheLoop`、一个 `useFrontendTool` 页面注册和 Agent context 字段 | 是；`DshSessionAdapter`、`DshSegmentedAgent`、`FrontendBridge` 未因账单模块新增 |
| 人工结果续接 | 通过已有 DSH waiter/ToolCard 结果路径 | 通过已有 AG-UI 分段与原 call id 结果路径 | 是，但 CopilotKit 仍承担额外协议时序 |

这轮结果改变了“CopilotKit 没有独立价值”的表述，但没有改变默认选型：CopilotKit 的固定 DSH 分段适配确实可以跨模块复用，且其 frontend tool、HITL 和页面上下文能完成真实业务交互；然而在第三个模块上，它尚未表现出比 assistant-ui 更低的新增业务代码、模型请求、业务写入或测试成本。当前更准确的判断是：assistant-ui 仍是 DSH 约束下的低耦合默认路线，CopilotKit 是已有统一应用交互模式、预计会持续接入许多页面且愿意维护一次分段适配的条件性候选，而不是“最不推荐”的无效方案。

在题设的架构约束下——成熟 React SaaS 已有业务 GUI、DSH 默认 Loop 是唯一执行者、只新增一个聊天/Agentic UI 层——**assistant-ui 是目前总接入成本更低的选择**。它提供聊天 primitives 与可定制 ToolCall component，业务组件留在 SaaS React 树中；业务团队仍需实现 typed command、审批、版本、权限、receipt 和 DSH 工具桥，但不需要再维护 CopilotKit 到 DSH 的 AG-UI 分段运行适配。

这不是说 CopilotKit 没有附加价值。本轮证明它的 frontend tool、HITL 和 Agent context 可真正参与业务闭环；但 assistant-ui 在同一场景也完整完成了交互，且共用同一批业务组件与后端规则。**因此本次没有观测到 CopilotKit 原生设施减少业务代码、模型请求、业务写入或验收步骤；它带来的应用交互设施尚未抵消 DSH 专属分段 adapter 的额外维护面。** CopilotKit 可以作为复杂应用交互能力更齐全的候选，但在这个约束下不应因“功能更多”就默认成本更低或被优先选中。

这个成本结论是本轮三个业务模块、固定依赖和 DSH 唯一 Loop 下的架构判断，不是计时工时或生产维护期的普遍定律。第三个模块证明 CopilotKit 的适配器没有按模块复制，但没有证明其模块级声明式注册足以抵消初始 AG-UI 分段适配、版本升级和恢复维护成本。只有继续接入更多模块，并且相同的 frontend tool、HITL、页面上下文和错误恢复模式能够稳定复用，才可能观测到 CopilotKit 的边际成本优势。若产品只需要少量模块，assistant-ui 仍是更小的默认集成；若产品把统一的应用交互设施作为核心产品能力，则应把 CopilotKit 列为需要规模化验证的候选。

DSH 原生 UI 不能据此宣称胜过或输给上述两条路线的真实复杂总成本：它只通过本轮 Chrome scripted 故事，没有跑同等真实模型矩阵。其 DSH Session/Tool 语义路径最直接，但嵌入既有 React SaaS 仍有独立 renderer root、Context 同步、工作区装配和产品界面裁剪成本。

本轮没有记录实际人时，也未验证生产 Provider、企业认证、多租户授权、设计系统适配或长期维护。因此“assistant-ui 成本更低”指在已跑通的相同复杂故事里，其集成所有权更窄、没有 CopilotKit 专属 AG-UI 分段 adapter；不是一个已经用人时和生产运维数据测出的金额排名。四份真实模型证据见[测试记录](test-results.md#同一批量续约故事的真实模型矩阵)。

## 已验证的工程经验

- 原生工具调度必须先解除 AG-UI run 对 DSH turn 完成的等待，否则 DSH 与框架互等。分段解决调度顺序，不能伪造 DSH 工具成功或新增用户输入。
- 页面 hook 收集的上下文不等于已经进入 DSH 模型历史。此次通过真实 `page_read` 工具结果落盘，刷新后可重建；后续新增模型可见信息也必须有相应 Session 事实。
- 同名工具的历史卡不代表现在仍有业务执行权。精确 call id、存活 waiter、页面/客户/选择检查、服务端角色与版本校验分别承担不同责任。
- DSH 原生 renderer 与 SaaS 是不同 React root，不能只把最初的 Context 值传给工具卡。对照路线通过外部订阅同步，否则人工保存新报价后可能批准旧版本；额外 UI 装配成本不能省略。
- 原生浮动输入区会遮住动态变高的业务表单。本实验只在新入口为其 scrollport 保留 composer 高度，不修改正式 UI；原生工作区界面与默认工作区提示仍未作 SaaS 产品化裁剪。
- 通用 CSS 变量名可能与聊天框架碰撞，出现浅色背景上近白文字。本实验业务色值统一使用 `--orbit-*`；Markdown 列表保持紧凑间距，截图检查真实交互卡而非只看初始页。
- Playwright 全页截图会改变基于视口高度的聊天布局，不能据其瞬时滚动位置推定用户看见的界面。审核证据使用实际 viewport，并验证表单进入聊天可见区；不靠截图代替业务状态断言。
- 原生 Lexical 输入需要等待预览说明和内部初始化；自动化使用逐字符输入与真实发送按钮。API 参数不变的无效更新也不能作为冲突用例，故测试明确执行 8% 到 9% 的真实修改。
- 刷新未完成审批时，DSH 可能已产生真实的中断工具结果。应接受该事实并禁止旧按钮再执行，而不是要求它必须命中自定义 hydration 文案。停止或外网失败后，下一轮仍必须能响应。
- 模型代理的总请求数还包含 DSH 标题服务；标题请求也可能携带同一个 Session id。测试按实际标题输入区分辅助请求，再核对对话模型请求与 DSH step 数，不能把总数多一条误判为第二套 Agent Loop。

以上是本实验的已解决问题与适用范围，不是要求把所有生产化工作都完成后才能使用 PoC。命令、通过范围和残留限制统一见[测试记录](test-results.md)。
