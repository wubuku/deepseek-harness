---
description: "DSH 当前 Web UI 的实现质量、Agentic UI 适配能力和第三方框架选型评估，基于源码、测试、Browser-Native PoC 与官方生态资料。"
---

# DSH Web UI 实现质量与 Agentic UI 框架选型评估

## Summary

本文评估 DSH 当前 Web UI 是否适合作为 Agentic UI 的工程基础，并回答是否需要引入第三方前端框架。结论是 DSH 的状态、事件、投影、插件和恢复基础值得保留，但通用业务能力声明、业务 action、授权、receipt 和未知结果恢复仍需要建设。DSH 已经实现了问答和审批等具体的人机交互闭环，因此不能把现状描述成“UI 完全不能回到 Agent”；准确说法是“已有具体闭环，尚无通用业务 action 协议”。如果 DSH Web 是产品工作台，优先在现有 UI 上扩展；如果已有 SaaS 是产品外壳，则保留 SaaS UI，按需把 DSH 作为 Agent Runtime 接入。

## Table of Contents

- [结论先行](#结论先行)
- [评估方法与证据边界](#评估方法与证据边界)
- [当前 Web UI 的实现质量](#当前-web-ui-的实现质量)
- [Agentic UI 的适配程度](#agentic-ui-的适配程度)
- [第三方框架的职责比较](#第三方框架的职责比较)
- [按产品场景选择集成位置](#按产品场景选择集成位置)
- [推荐的改造路线](#推荐的改造路线)
- [对既有报告的修订](#对既有报告的修订)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

## 结论先行

本文给出的是条件化选择，而不是“自研一定优于第三方”的一般判断。关键问题是 Agent Loop、Session 事实、业务副作用和 UI 渲染分别由谁拥有。

| 场景 | 推荐 | 原因 |
|---|---|---|
| DSH Web 是主要产品工作台 | 扩展 DSH 当前 Web UI | DSH 已有 Session、Conversation、Tool view、Slots、问答和审批的组合基础，替换整套 UI 会重复实现最难的状态与恢复问题。 |
| 已有 SaaS 是主要产品外壳 | 保留 SaaS UI，接入 DSH Runtime | 既有路由、设计系统、登录态、租户上下文和业务组件不应为了使用 DSH 而迁移。 |
| 需要快速搭建独立聊天外壳 | 可评估 assistant-ui、CopilotKit 或 AI SDK UI | 这些方案可以减少聊天呈现和前端工具接入成本，但必须由适配层保证 DSH 是唯一的 Agent/Session 事实拥有者。 |
| 需要跨 Host 分发可交互 widget | 评估 MCP Apps 或受限 A2UI catalog | 这类方案解决 widget 隔离、动态 UI 描述或跨宿主互操作，不是 DSH Web UI 的默认替代品。 |

**最短正确答案：先改造 DSH，不先引入第三方完整框架；只在明确需要时引入局部库、适配器或协议。**

这个结论不意味着 DSH Web UI 已经是通用 Agentic UI 平台。它意味着当前最有价值的新增工作是补齐业务能力层，而不是再复制一套聊天运行时。

这里的“先改造”是当前实施优先级，不是永久保留全部 DSH 呈现实现的决定。长期可以让成熟框架接管明确的聊天或应用交互职责；新增 UI runtime 只要消费 DSH 的权威事实，也不等于新增 Agent Loop。进一步核查和长期选型见 [Browser-Native DSH 的长期 UI 选型：assistant-ui 与 CopilotKit](assistant-ui-copilotkit-browser-native-dsh-assessment.md)。

-----

## 评估方法与证据边界

源码评估基线是 2026-10-16 的 `research` 分支，依据包括当前源码、测试、Web Client 架构文档、既有 Agentic UI 报告和 Browser-Native PoC，外部框架只引用其官方文档。代码事实以源码和测试为准；实施方案中的 lease、handoff、幂等和多租户条款仍属于设计目标，不能替代已经通过的测试。

重点检查了 Web Client 的 Host/Client/Conversation/Slot 分层、Tool view 的 owner props、问答和审批的 continuation、Session stream 恢复、错误边界、长会话渲染和浏览器 E2E。

2026-10-16 前轮研究阶段运行的聚焦源码测试覆盖 10 个文件、177 项测试，结果全部通过。测试覆盖 Tool view keyed dispatch、preparing/start/result 生命周期、Slot live registration、renderer lifecycle、问答插件、Session history、notifier 和 Modal layer。这里保存此前的验证记录；本次文档落档没有重新运行这些源码或 GUI 测试。

前轮研究还使用已有构建产物运行了两个 keyless replay 的 Chromium 场景：`connection-recovery.e2e.ts` 的 2 项测试，以及 `question-composer.e2e.ts` 的 6 项测试，结果全部通过。断线场景验证页面不导航、根节点仍挂载、Session baseline 重建和未发送草稿保留；问答场景验证提交、刷新后的只读记录和晚到回答。源码测试与已有 GUI 构建产物的运行证据不能等同于本次从当前源码重新完整构建后的验证。

前轮研究和本次落档均未运行全仓覆盖率、完整构建、真实模型请求、完整 Browser-Native 业务 action 闭环或多租户安全审计。因此本文不宣称 DSH Web UI 已通过生产级性能、无障碍、灾备或安全认证。

-----

## 当前 Web UI 的实现质量

### 状态归属清晰，是最重要的工程资产

Web Client 的数据路径是 Host 权威状态 → Remote transport → Client model → UI adapter → Conversation 或 presentation → Slots → React；用户动作沿 callback、Remote 或 Host Controller 返回权威服务，再由 stream 或 event projection 回到 Client。该分层写在 [Web Client architecture](../subsystems/web-client.md) 中，并由 `packages/api/session-controller/src/client/sessions/session.ts`、`packages/client/ui-session` 和 `packages/client/ui-conversation` 共同实现。

这套分层为 Agentic UI 提供了三个必要的状态类别：Session 事实、业务系统事实和 UI 临时状态。模型可见内容必须进入可回放的 Session；SaaS 数据仍由业务后端拥有；草稿、焦点、展开状态和面板尺寸默认只属于浏览器 UI。没有这个区分，Agentic UI 很容易把“模型看见的表单草稿”误当成“业务已经提交”。

### 扩展点已经覆盖工具卡片和会话节点

`tool.call.toolview` 是按 wire Tool name 派发的 keyed slot，owner props 区分 `preparing`、`start` 和 `result` 三个阶段，详见 `packages/client/ui-tool/src/client/contract/slots.ts:77`。它适合把一次 Tool 调用投影成卡片、表单预览、结果摘要或可展开详情。

`ConversationNodeDefinition` 是独立的事件到状态折叠器，可以从 Session event 建立稳定的业务 Context，并生成目标视图，详见 `packages/client/ui-conversation/src/client/contract/conversation.ts:195`。它适合跨事件、跨轮次或刷新后仍需重建的业务节点，不应被当成一般业务数据库或副作用执行器。

Slot registry 还具有声明、作用域、优先级、冲突和 disposal 语义。`packages/client/ui-tool/tests/toolview-slot.client.spec.tsx:237` 到 `:263` 验证了 keyed view 的动态接管、卸载回退和重复 key 失败；`packages/client/ui-slots/src/index.ts:1124` 明确规定了 load-time validation 和生命周期清理。

### 具体人机交互闭环已经存在

不能把 DSH 描述成“只有展示 Tool 结果，无法把用户操作送回 Agent”。`ui-user-questions` 和 `ui-approval` 已经通过 scoped Remote Event waterfall、Session pending interaction、Remote answer 和 Session projection 实现具体闭环。

问答插件会把继续中的问题投影到 composer，回答通过 `ctx.remote.userQuestions.answer()` 提交，并在 Agent 侧验证每个问题被准确回答一次，再生成带 `user-question-reply` 来源的用户消息。该路径见 `packages/client/ui-user-questions/src/client/index.ts:286` 和 `packages/interaction/user-questions/src/index.ts:165`。

这个事实改变的是表述，不改变缺口：DSH 已有问答、审批、取消、超时和晚到回答的领域级解决方案，但还没有一个适用于任意 `customer.create`、`release.publish` 或 `invoice.approve` 的通用业务 action descriptor、状态机、授权和 receipt 协议。

### 事件恢复和渲染调度达到较好的工程水准

Session Client 对 stream generation、baseline replacement、序列窗口和 stale pass 有明确处理，断线时不会简单地把旧对象继续拼接到新 generation。`packages/api/session-controller/src/client/sessions/session.ts:451` 和 `:615` 展示了 generation guard；`docs/subsystems/web-client.md:77` 规定了各数据域的恢复语义。

Notifier 将用户受控输入的同步反馈、结构性变化的 microtask batching 和可见流式块的 frame batching 分开，见 `packages/api/session-controller/src/client/sessions/notifier.ts:30`。这类时序细节对 Agentic UI 的输入响应和流式 Tool 卡片很重要。

共享 Modal primitive 处理顶层 Escape、Tab 循环、initial focus 和 return focus，见 `packages/client/ui-primitives/src/useModalLayer.ts:46`。这为审批、确认和高风险 action 提供了可复用的交互基础。

### 实现复杂度是实际成本，不是抽象数量越多越好

DSH 的 UI extension model 由 Cordis injection、动态 module graph、typed Slots、derived props、store declaration、React binding 和 Conversation registry 组成。`packages/client/ui-renderer/src/client/scoped-slots.tsx` 约 1,300 行，`packages/client/ui-slots/src/index.ts` 约 1,700 行，说明这不是一个只需要注册 React component 的轻量扩展接口。

这套复杂度对 DSH 自己的插件化工作台是合理投资，因为它处理了注册冲突、动态卸载、作用域绑定、外部 observable 和跨 Session 渲染。对外部 SaaS 团队则可能成为接入门槛，尤其是他们只想把一个既有业务组件暴露成一个 Agent capability 时。

因此，改造 DSH 的关键不是继续把更多内部机制暴露给业务开发者，而是提供一个窄的业务接入层，让业务开发者只声明 capability、state、action、权限和 receipt，底层由 DSH plugin 适配。

### 故障隔离优于故障可理解性

Renderer 对单个 slot entry 和 factory occurrence 有 Error Boundary，可以避免一个第三方或实验性组件拖垮整个 React tree，见 `packages/client/ui-renderer/src/client/scoped-slots.tsx:394`。缺点是失败时可能只渲染 `data-slot-error` 或 `data-factory-error` 空占位，调用者未必知道是“渲染失败”“动作未提交”还是“结果未知”。

Agentic UI 必须补充面向用户的可恢复错误面：渲染错误、授权拒绝、过期 state、重复 action、业务提交失败和提交结果未知不能共享一个 generic failure。否则 UI 保护了进程，却没有保护用户的决策。

### 长会话支持已有优化，但不能夸大为完整虚拟化

DSH 有 turn rail 的 virtualizer、流式增量合并和长历史性能场景；最近的性能提交也减少了长会话渲染和 running whale 动画开销。与此同时，`ChatNodeList` 仍会对当前已加载的 entries 做 map 渲染，见 `packages/client/ui-chat/src/client/chat/ChatView.tsx:66`。因此，当前证据支持“有长会话优化”，不支持“任意复杂 Agentic UI 都已解决长列表性能”。

业务卡片需要额外评估冻结 settled rows、展开大表单、图表和 iframe 的挂载成本、流式更新频率以及跨组件状态订阅。第三方聊天框架通常也不能自动解决这些业务组件级问题。

### 测试质量较高，但覆盖率豁免代表仍有明确债务

测试分为 Client unit/component、真实 composition 和 Chromium E2E 多层，`apps/web/tests/README.md` 说明了真实 Web composition、fixture、replay 和浏览器行为的验证方式。该体系对 Agentic UI 很有价值，因为 capability seam 需要同时验证 UI、Session、Host command 和恢复。

但 `vitest.config.ts:298` 仍列出了 Client modules、Connection、部分 UI assembly 和其他 GUI 路径的覆盖率豁免。覆盖率豁免不是实现错误，却意味着“有测试基础”不能被简化成“所有关键装配路径都被覆盖”。新业务 capability 应优先加入真实 composition 和 browser scenario，而不是只增加纯组件快照。

### 质量结论

| 维度 | 评价 | 依据与限制 |
|---|---|---|
| 架构分层 | 强 | Host、Client model、Conversation、Slots 和 React 的职责清晰。 |
| 可扩展性 | 强，但学习成本高 | Tool view、Conversation Node 和 Slot registry 能承载插件；内部约束较多。 |
| 状态一致性与恢复 | 强 | baseline、generation、Session projection 和 reconnect 有实测证据。 |
| 具体人机交互 | 中上 | 问答、审批、超时和晚到回答已有闭环；通用业务 action 尚未抽象。 |
| 长会话性能 | 中上，需按业务卡片继续验证 | 有 virtualizer 和性能场景，但 Chat node list 仍按当前窗口渲染。 |
| 故障可恢复体验 | 中 | 技术隔离较好，slot 失败和 unknown business outcome 的用户面仍需建设。 |
| 外部 SaaS 接入成本 | 中下 | 需要理解 DSH plugin/slot/model 体系；应增加窄适配层。 |
| 生产级多租户业务安全 | 未由当前 Web UI 证明 | DSH Web 认证不等于 SaaS 业务授权；必须由 SaaS backend 决定 principal、tenant 和 resource scope。 |

-----

## Agentic UI 的适配程度

### DSH 已经覆盖的链路

一个 Agentic UI Tool 至少需要模型调用、结构化结果、可见呈现、事件记录和后续输入。DSH 当前已有 Tool schema、canonical output、Tool call/result 生命周期、Session persistence、Tool view、Conversation projection、问答/审批和 Agent continuation 的若干具体实现。

这使 DSH 可以直接开始一个垂直 PoC，而不需要先引入新的 Agent Loop 或聊天框架。优先选择一个已有业务 API 能完成授权和查询的闭环，例如“打开客户创建表单、预填字段、用户确认、服务端创建、回传 receipt”。

### 当前真正缺的是通用业务 capability 层

现有 Tool view 的 common props 主要是 `callId`、`toolName`、阶段 block、`openFile`、图片加载和 inspect 回调，见 `packages/client/ui-tool/src/client/contract/slots.ts:77`。它没有通用的 `submitToAgent`、`invokeBusinessAction`、`expectedStateVersion`、`idempotencyKey` 或 `receipt` 通道。

这不是缺少一个 React callback 的问题，而是缺少以下共同语义：

1. capability 的稳定 id、版本、输入 schema、可见 state schema 和风险等级。
2. UI action 的 allowlist、Session 归属、surface instance、state version、用户 gesture 和 approval 状态。
3. Host 或 SaaS backend 的授权、幂等 key、业务 receipt 和查询接口。
4. `prepared`、`awaiting-confirmation`、`committed`、`rejected`、`unknown` 等状态能否写入 Session，以及如何由 replay 重建。
5. 页面刷新、Worker 重启、网络断开和多标签竞争时，哪个 owner 可以继续执行。

因此，“当前 Tool view 不能自动完成业务 action”是正确的；“DSH 没有 UI 到 Agent 的任何通道”是不正确的。

### Tool view 与 Conversation Node 的选择

只在一次 Tool 调用期间显示输入、进度和结果时，先使用 `tool.call.toolview`。这条路径拥有 Tool lifecycle、call identity 和 generic fallback，改动小，适合第一条垂直闭环。

当业务状态需要跨多个事件、跨轮次、刷新后恢复，或需要独立的 timeline location 时，再使用 `ConversationNodeDefinition`。Node 负责可回放投影，不负责业务 API 授权、数据库事务或 UI 任意副作用。

用户问答和审批属于已有的“等待人类输入后继续”模式。复杂业务表单可以先映射成该模式的专用 interaction provider，但只有在第二个真实业务用例证明重复结构稳定后，才应提炼为通用 capability registry。

### Browser-Native 不改变主选型

Browser-Native PoC 证明的是运行位置和连接方式：现有 DSH Web UI 可以由 Worker Host 支撑，Worker 里可以启动真实 `ctx.agentLoop`，并通过同源 backend 访问 LLM proxy 与 Session persistence。它没有证明业务 surface、业务 action、服务端授权、幂等 receipt 或 Browser-to-Durable handoff 已经完成。

推荐拓扑仍然是：Main Thread 承载既有 SaaS UI、typed state adapter 和用户 gesture；Dedicated Worker 承载 DSH Agent Loop、Tools 和 Session projection；Backend 承载凭据、身份、租户授权、业务 API 和长期任务。

第三方前端框架不能替代这三层的所有权设计。在本文推荐的集成方式中，应把第三方的职责限定为 presentation 或 adapter；它不会自动解决 unknown side effect、owner fencing 和业务授权。

-----

## 第三方框架的职责比较

外部生态不是一个可以整体替换 DSH 的单一类别。下面把“聊天 UI”“前端 Tool/HITL”“Agent/UI 事件协议”“声明式 UI”“沙箱 widget”分开比较。外部资料均为官方文档，检索日期为 2026-10-16。

| 方案 | 官方资料所解决的问题 | 与 DSH 的关系 | 建议 |
|---|---|---|---|
| CopilotKit | `useFrontendTool` 注册浏览器侧 Tool，`useHumanInTheLoop` 通过 `respond` 等待用户输入；另有 headless 与 self-managed Agent 接入方式。 | 需映射 DSH Tool lifecycle、Session、取消、恢复和唯一 continuation owner；生产 self-managed 的许可/支持条件与自动续跑控制需要单独确认。 | 不为少量卡片整体引入；长期需要跨业务模块统一 Agent 接入时，可评估其应用交互层。 |
| assistant-ui | `ExternalStoreRuntime` 允许已有 store 提供 messages 和 callbacks；也有 frontend/human/external tools，以及 AG-UI state 和 interrupt helpers。 | 适合把 DSH Session/事件投影适配成外部聊天 UI；并非只能展示、不能承载应用交互，但 DSH 对接不是自动完成的。 | 已有 SaaS 外壳或长期需要专业聊天交互时，优先验证较窄的 external-store 适配。 |
| Vercel AI SDK UI | `onToolCall` 处理客户端 Tool，`addToolOutput` 回传结果，`sendAutomaticallyWhen` 可在 Tool output 齐备后自动继续提交。 | 与 DSH Agent Loop 存在“谁驱动下一轮”的重叠；双 loop 或双 transcript 会产生重复 continuation。 | 仅在 DSH 作为后端 Agent 服务且明确由一方拥有续跑时使用。 |
| AG-UI | 定义 Agent 与前端之间的事件、流式状态和交互协议，强调跨 Agent framework 与 frontend 的互操作。 | 是 transport/interoperability 适配层，不替代 DSH Session format、Tool persistence、业务事件和授权。 | 有跨框架互操作需求时增加 adapter；不因协议存在而替换 DSH 内部模型。 |
| A2UI | 用受控的组件 catalog 和声明式消息描述动态 UI，减少模型或 Agent 直接生成任意 UI 代码的需要。 | 可参考 typed catalog 和安全 allowlist；不能自动把现有 CRM 页面转换成业务 capability。 | 动态 UI vocabulary 很广时评估；第一条 DSH 业务闭环优先使用真实组件 adapter。 |
| MCP Apps | MCP server 返回可在 Host 中渲染的交互 HTML 应用，官方文档强调与对话并置和宿主安全模型。 | 适合跨 Host 分发独立 widget；会增加 sandbox、消息桥、尺寸、弹窗、CSP、身份和恢复集成。 | 只有需要第三方 widget 或跨宿主分发时采用；不是 DSH Web 的默认外壳。 |

### 第三方方案的共同边界

上述方案可以减少 UI boilerplate、提供更好的开发体验或解决互操作，但都不能替业务系统决定用户、租户、角色、资源范围和数据库事务。模型参数、组件 props、DOM selector 或前端按钮状态都不能成为授权依据。

它们也不能自动把“请求发出但响应丢失”归类为成功或失败。高价值业务动作仍需业务后端的 operation id、幂等策略、可查询 receipt 和明确的 `unknown` 恢复路径。

### 最危险的集成方式

最危险的不是同时使用两个 UI 库，而是同时拥有两套 Agent continuation、两份消息事实或两个业务副作用 owner。例如 DSH Tool result 已触发 Agent 继续，而 AI SDK UI 又依据 `sendAutomaticallyWhen` 再提交一次；或者第三方 UI 维护自己的 message history，而 DSH Session 维护另一份“真实历史”。

集成时必须明确：哪一方拥有 Agent Loop、哪一方拥有 Session event、哪一方拥有业务 action、哪一方只负责渲染和发起用户意图。适配层可以转换消息和事件，但不应隐式复制事实。

这不禁止外部 UI runtime 与 DSH Client model 各自维护可重建的 read model；需要避免的是两份独立权威历史或重复执行者，而不是所有前端状态副本。

-----

## 按产品场景选择集成位置

### 场景 A：DSH Web 作为 Agent 工作台

保留 `ui-session`、`ui-conversation`、`ui-tool`、`ui-chat`、`ui-slots` 和现有交互插件，在其上增加一个业务 plugin。业务 plugin 提供 Host Tool、业务 API adapter、Session projection、Tool view 或 Conversation Node，并通过一个窄的 capability facade 把业务组件所需的 state/action 接入。

该场景下，CopilotKit、AI SDK UI 或 assistant-ui 不应先成为第二个 Chat runtime。它们可以贡献局部交互思想、schema helper 或纯展示组件，但 DSH 仍是会话、Tool 和 continuation 的唯一 owner。

如果长期选择由第三方接管聊天呈现，可以替换对应的 UI 实现，而不只是永久局部叠加。前提是它通过 DSH 的投影与命令接入，并且替换收益足以覆盖适配、迁移和产品级验证成本。

### 场景 B：成熟 SaaS 作为产品外壳

保留 SaaS 的路由、组件树、设计系统、登录态、租户上下文和业务 store。将 DSH 作为 Agent Runtime，通过 Remote/API、Session event stream 或 AG-UI 类 adapter 接入 SaaS 的助手面板。

此时使用 assistant-ui 的 `ExternalStoreRuntime` 或 CopilotKit 的前端 Tool/HITL API 可能有价值，因为它们可以减少 SaaS 团队自己构建聊天外壳的成本。但 adapter 必须把 DSH Session 投影成外部 UI 的 read model，而不是让外部 runtime 重新拥有 Agent history。

### 场景 C：跨宿主分发业务 widget

如果同一个业务能力需要在多个 Agent Host 中以独立 widget 运行，MCP Apps 的 sandboxed HTML widget 或 A2UI 的受限 catalog 值得评估。此时需要提前解决宿主的身份传递、capability allowlist、消息版本、尺寸/弹窗、资源加载、CSP 和恢复语义。

这类方案与 DSH 并不冲突：DSH 可以继续负责 Agent Loop、Tool 和 Session，第三方协议只承载 widget 或跨宿主事件。不要把“支持 MCP Apps”写成“业务授权已经完成”。

-----

## 推荐的改造路线

### 阶段 1：定义一个窄 capability facade

不要把 Cordis `ctx`、React component、observable、DOM node、function 或任意 module URL 传给 Agent。为一个真实业务定义 `capabilityId`、version、state schema、action schema、风险等级、需要的 user gesture 和权限上下文。

先区分 observation、draft、intent、commit 和 receipt。Observation 可以是 Agent 可见的只读状态；draft 是用户尚未提交的浏览器状态；intent 是用户或 Agent 请求执行的动作；receipt 是业务后端确认的结果。

### 阶段 2：复用 Tool view 完成一个闭环

选择 `customer.create.prepare` 或同等规模的能力。Tool view 负责呈现实际业务组件、读取 schema 约束的 observation、显示用户修改和确认状态；提交通过注入的 callback 进入 Host/SaaS API adapter，不由 React renderer 直接操作数据库。

动作至少携带 Session id、surface instance、action version、expected state version 和稳定 idempotency key。服务端重新确定 principal、tenant、role 和 resource scope，并返回可查询 receipt。

### 阶段 3：把模型可见事实接入 Session

只有会影响后续模型请求的 state 才进入 Session event/projection。草稿、焦点和纯视觉展开状态不应无条件写入 Session。`prepared`、`awaiting-confirmation`、`committed`、`rejected` 和 `unknown` 的模型可见部分必须可由回放重建。

### 阶段 4：用真实故障验证，而不是只测成功路径

至少测试重复点击、请求超时、响应丢失、页面刷新、Worker 重启、Session reconnect、旧 state version、两个 tab 竞争、业务授权拒绝和后端已提交但前端未收到响应。`unknown` 不能自动降级成失败后重试，也不能自动展示成功。

### 阶段 5：再决定是否引入第三方协议或 UI runtime

当第二个真实业务用例出现共同的消息、前端 Tool、HITL 或 widget 需求时，再选择局部依赖。选择标准不是 API 是否漂亮，而是它是否删除 DSH 当前明确拥有的代码和测试，同时不建立第二个事实源。

-----

## 对既有报告的修订

本专题把前一轮回答落档，并同步修正既有研究对当前实现范围的表述。

第一，`dsh-agentic-ui-research.md` 原先把“Tool view 没有通用业务提交或 continuation API”写在缺口表中，这个判断仍然成立，但需要补充已有的领域级例外。`ui-user-questions`、`ui-approval` 和对应的 interaction package 已经提供具体的等待、回答、审批、超时、取消和后续消息路径；修订后把“缺少通道”限定为“缺少通用业务 action seam”。

第二，Browser-Native PoC v2 的 `backend-v2.mjs` 要区分“要求 requestId”与“实现 idempotency ledger”，也要区分“当前 backend instance 的 in-memory owner token”与“跨重启的 lease/epoch/接管协议”。v2 当前代码有 owner claim、assertion、close release、contiguous sequence 和 flush durability；没有基于 requestId 的请求去重或结果重放账本，也没有 renew、expiry 或 owner epoch。既有实施方案中的这些项目仍是未来验收标准，不应被写成 v2 已完成能力。

第三，[protocol.md](browser-native-dsh-poc/protocol.md)描述的是旧版独立 HTML/loop 实验，不是 v2 的协议 owner；索引和文档范围说明已据此修正。preview 的 opt-in 参数只控制 profile overlay，docs-owned Worker entry 在所有 preview 中都会实例化，不能把它描述成 query 参数才启用的 Worker 替换。

第四，PoC v2 的 Chromium E2E 证明真实 DSH Web UI、Worker Host、`ctx.agentLoop`、同源 LLM route、正式 Session event 和 flush durability 的一次闭环。它没有证明业务 UI action、SaaS 授权、receipt、unknown recovery、完整 handoff 或生产多租户安全。综合报告的“当前成果”应按这个范围阅读。

-----

## Further Exploration

- [DSH Agentic UI 事实核查](dsh-agentic-ui-research.md) — 共享对话、Tool view、Conversation Node 和 SaaS 复用的基础事实。
- [assistant-ui 与 CopilotKit 的核查及长期选型](assistant-ui-copilotkit-browser-native-dsh-assessment.md) — Browser-Native SaaS 的长期收益、兼容性和生产接入条件。
- [Browser-Native Agentic UI 综合报告](dsh-browser-native-agentic-ui-research.md) — Worker、Session、typed capability、handoff 和完整业务时序。
- [Browser-native DSH PoC README](browser-native-dsh-poc/README.md) — v2 运行入口、实现边界和验证限制。
- [Web Client architecture](../subsystems/web-client.md) — 当前 Web Client 的状态路径和包边界。
- [Web Client Slots](../subsystems/slots.md) — Slot 注册、props、store 和注入规则。
- [Conversation subsystem](../subsystems/conversation.md) — Event-to-Node、Context、Location 和 replay 语义。
- [CopilotKit `useFrontendTool`](https://docs.copilotkit.ai/reference/hooks/useFrontendTool) — 浏览器侧 Tool 和可选 render。
- [CopilotKit `useHumanInTheLoop`](https://docs.copilotkit.ai/reference/hooks/useHumanInTheLoop) — 等待用户响应的交互 Tool。
- [assistant-ui `ExternalStoreRuntime`](https://www.assistant-ui.com/docs/runtimes/custom/external-store) — 外部消息 store 适配。
- [AI SDK Chatbot Tool Usage](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage) — 客户端 Tool output 与自动续轮。
- [AG-UI Overview](https://docs.ag-ui.com/introduction) — Agent 与前端的互操作协议。
- [A2UI](https://a2ui.org/) — 受限组件 catalog 的声明式 UI。
- [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) — Host 内交互 HTML widget 与安全模型。

## Dev Note

本文记录 2026-10-16 对当前 checkout 的代码考古、聚焦测试和官方生态资料核查。它是 `docs/drafts/` 研究草稿，不是 DSH 已发布的架构承诺；若业务 capability facade、Browser-Native handoff 或第三方 adapter 落地，应将相应的稳定 contract 迁移到所属 package README、subsystem 或 Agent Note。
