---
description: "调研 Agent 将 Web App 业务操作抽象为可唤起的界面能力、在对话中动态呈现并串联工作流的实践、DSH 代码基础、绑定模型与实施建议。"
---

# DSH Agentic UI：把业务操作抽象为 Agent 可唤起的界面能力

## Summary

将 Web App 的业务操作同时建模为 Agent 可调用的 Tool 和用户可操作的 UI，并由 Agent 在对话过程中选择、预填、唤起和串联这些能力单元，是一个具有产品价值和技术基础的方向，但目前不能描述为尚无人实践的空白领域。

Google A2UI、MCP Apps、OpenAI Apps SDK、AG-UI、CopilotKit、Vercel AI SDK、assistant-ui、CrewAI、Adaptive Cards 和 Slack Block Kit 已分别覆盖 Tool 调用、对话内 UI、结构化用户输入、流式状态或工作流编排中的部分能力。

现有方案和 DSH 代码库共同表明，生产级业务 UI 通常不会与业务能力完全解耦。退款表单、发布审批卡片、发票表格和复杂编辑器都包含业务字段、状态、权限、校验、错误处理和副作用语义，UI 与业务能力需要由同一能力所有者共同设计和版本化。

更准确的架构表述是：**能力单元在设计上强绑定，UI 与执行在传输上分离；Agent 主要负责选择和编排已绑定的能力单元，而不是为核心事务现场生成任意 UI。**

DSH 已经具备这条路线的大部分基础：`packages/core/tools` 提供工具注册和执行流水线，`packages/client/ui-tool` 通过按 Tool 名寻址的 slot 渲染调用卡片，`packages/interaction/tool-ask-user` 提供结构化人机交互，Session 日志支撑已提交调用和结果的回放，Cordis 插件和 UI slot 允许业务包共同注册 Tool 与视图。

DSH 的主要缺口不是再增加一个通用表单生成器，而是定义能力单元的共同声明、Agent 对能力单元的选择和参数化、跨单元状态传递、失败恢复和浏览器原生运行时中的持久化语义。

| 判断项 | 当前结论 |
|---|---|
| 方向是否具有 UI/UX 革命性 | 是，但革命点主要是从页面导航转向 Agent 编排的任务表面，不是简单把卡片放进消息泡 |
| 是否已经有人做过 | 已有大量相关实践，但没有一个方案完整覆盖任意存量 Web App、强绑定业务 UI、Agent 编排、审计回放和浏览器原生运行 |
| UI 与 Tool 是否应完全解耦 | 不应。业务能力与其主 UI 通常共同设计；协议和运行时仍需要把执行与渲染分成不同声明面 |
| DSH 是否已有可复用基础 | 有。Tool、Tool presentation、Conversation Node、UI slot、用户问答和 Session 回放已经形成连续链路 |
| DSH 最大产品化缺口 | 能力单元的统一声明与编排语义，以及待提交交互、浏览器本地持久化和跨页面恢复 |
| 推荐首个实现目标 | 一个具有审批和多步状态的垂直业务流程，而不是通用的任意页面生成器 |

## Table of Contents

- [调研范围与问题设定](#调研范围与问题设定)
- [结论速览](#结论速览)
- [机制分解：协议层可分离，能力单元不可随意拆分](#机制分解协议层可分离能力单元不可随意拆分)
- [已有实践](#已有实践)
- [UI 与业务能力的绑定模型](#ui-与业务能力的绑定模型)
- [DSH 当前代码库审计](#dsh-当前代码库审计)
- [安全与工程红线](#安全与工程红线)
- [面向 DSH 的实施路线](#面向-dsh-的实施路线)
- [开放问题](#开放问题)
- [结论](#结论)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

## 调研范围与问题设定

本文面向正在评估 DSH 浏览器原生运行时、Agent-first Web App 和业务 UI 插件化的工程师，回答以下问题：

1. Web App 的业务操作是否可以同时成为 Agent Tool 和对话内 UI 能力？
2. Agent 是否可以在用户对话中选择合适的业务 UI，收集输入并继续工作流？
3. 当前有哪些协议、产品和框架已经实现了这类能力？
4. UI 与业务能力之间应该如何划分所有权、声明面和运行时职责？
5. DSH 当前代码库已经具备什么，缺什么，应该从哪里开始验证？

本文区分四类证据：

| 类别 | 含义 |
|---|---|
| 代码库事实 | 可以在 DSH 源码、package README、架构文档或测试中定位的当前机制 |
| 外部实践 | 由相关项目官方文档、规范或官方博客公开描述的能力 |
| 架构判断 | 根据代码库事实和外部实践得出的设计结论，不表示 DSH 已经实现 |
| 待验证事项 | 尚未通过 DSH 产品级测试、浏览器矩阵或真实业务集成验证的假设 |

“浏览器原生”在本文中沿用此前调研的定义：DSH Host 和 Agent Loop 驻留 Dedicated Worker，不依赖配套的本地 Node Host；它不表示不需要预构建镜像、不需要兼容层、不需要远程模型，也不表示所有 Node 或操作系统能力都能在浏览器内提供。

## 结论速览

### 方向判断

这个方向值得推进，但应把目标从“让模型生成页面”改写为“让 Agent 编排由业务所有者共同定义的界面能力”。

用户首先表达任务目标，Agent 根据当前 Session、权限、业务状态和已有结果选择能力单元；能力单元提供与业务规则绑定的 UI；用户在 UI 中补充或确认输入；Tool 执行真实业务操作；结果和必要的 UI 状态进入事件流并驱动下一步。

消息泡是一个合适的承载位置，因为它可以把解释、输入、审批、执行状态和结果放在同一条任务记录中，但消息泡不是该方向的核心技术定义。

### 主要判断

| 判断 | 结论 | 依据 |
|---|---|---|
| 生产业务 UI 是否应由通用 Tool Schema 自动生成 | 通常不应 | Schema 缺少领域校验、状态、权限、交互顺序和错误恢复语义 |
| Agent 是否应决定哪个业务 UI 出现 | 应该 | Agent 可以根据任务上下文选择已声明的能力单元 |
| Agent 是否应自由生成核心交易 UI | 通常不应 | 高副作用流程需要稳定字段、权限、确认、审计和版本兼容 |
| 是否需要独立 UI 描述协议 | 需要 | 渲染端与执行端处于不同信任域，需要安全、可校验、跨宿主的传输契约 |
| UI 与 Tool 是否由不同所有者独立演化 | 核心业务中通常不应 | UI 字段、状态和动作直接表达业务规则 |
| Agent 的主要新增价值在哪里 | 选择、预填、串联和恢复 | 这些能力可以在不解耦业务 UI 与业务能力的情况下成立 |

## 机制分解：协议层可分离，能力单元不可随意拆分

### 四类机制

从运行时机制看，这个方向至少包含四类职责：

1. **业务能力机制**：Tool 名称、输入和输出、权限、副作用、幂等、取消、错误和审计。
2. **Agent 与前端运行时机制**：流式文本、Tool call、执行状态、暂停、用户动作、恢复、关联 id 和事件顺序。
3. **UI 描述与渲染机制**：组件、布局、数据绑定、动作、宿主 catalog、沙箱和跨端渲染。
4. **工作流机制**：多步调用、条件、并行、审批、长任务、补偿、失败恢复和所有权转移。

这四类机制可以在协议、进程和模块上分开，但这不意味着业务团队应把一个业务能力拆成互不相关的 Tool、UI 和工作流对象。

### 机制分层不等于设计分层

协议分层解决的是接口、信任、部署和替换问题；业务设计解决的是能力语义、用户任务和状态一致性问题。

一个发布审批能力可能同时拥有 `inspect`、环境选择、风险确认、审批、灰度执行和回滚 UI。将这些 UI 和 Tool 分别交给通用表单生成器、通用工具注册表和另一个工作流引擎，会使业务状态规则分散到多个所有者，增加状态漂移和错误组合的风险。

更合适的单位是**能力单元**：能力单元由业务所有者共同维护 Tool 定义、主 UI、输入校验、状态投影、权限要求和结果处理；运行时再将这些声明投影到模型、浏览器渲染器、Session 日志和其他宿主。

### 为什么仍然需要 UI 描述层

UI 描述层存在的主要理由不是让 UI 与业务脱钩，而是处理执行与渲染之间的差异：

- Tool 执行可能位于远程服务、云端 Worker 或 DSH Host，渲染发生在浏览器、桌面客户端、ChatGPT、Slack 或其他宿主。
- 模型输出和外部 Tool 资源都不能直接获得渲染宿主的任意代码执行权限。
- 同一能力可能需要 Web 卡片、Slack Block、移动端组件、语音提示或无 UI 的自动化调用。
- 宿主的组件能力、主题、屏幕尺寸和交互模型不同，但业务状态和权限规则仍应保持一致。

因此，UI 描述层应理解为**能力所有者声明的跨信任域呈现契约**，而不是一个独立于业务能力、可以任意组合所有页面的通用设计层。

## 已有实践

### Google A2UI

[A2UI](https://a2ui.org/) 是 Google 发布的 Agent-to-UI 声明式协议。官方网站将 v0.9.1 标记为当前版本，将 v1.0 标记为 Candidate。

A2UI 通过 `createSurface`、`updateComponents`、`updateDataModel` 和 `deleteSurface` 等消息逐步建立和更新 UI surface，支持组件 catalog、数据绑定、JSON Pointer、用户输入和 action。组件由宿主预先实现，Agent 传输的是声明式数据和结构，不是任意可执行前端代码。

[A2UI 的生态比较文档](https://a2ui.org/introduction/agent-ui-ecosystem/) 将 A2UI 与 MCP Apps、AG-UI、A2A 等定位为互补关系：A2UI 负责 UI 描述，其他协议负责工具、Agent 间通信或 Agent 与用户之间的运行时连接。

A2UI 对本文的关键启示是：动态 UI 可以存在，但生产场景仍依赖宿主批准的 catalog；固定流程通常更适合固定 schema 或预定义 surface，动态 schema 适合开放式、探索性或只读场景。

### MCP Apps 与 OpenAI Apps SDK

[MCP Apps SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) 已进入 Final 状态。它允许 MCP Tool 关联 `ui://` HTML 资源，Host 在沙箱 iframe 中加载 UI，widget 通过 JSON-RPC 消息与 Host 和 Tool 通信。

MCP Apps 的典型交付单位是 Tool 与 widget 的共同实现。Tool 负责业务能力，widget 负责在宿主中显示业务数据、接收用户动作和发起后续调用；二者通过明确的资源标识和消息协议关联，而不是由模型从通用字段自动生成完整生产界面。

OpenAI Apps SDK 采用相近的 Tool 加 widget 模式，主要面向 ChatGPT Host。此次调研中 OpenAI 开发者页面部分请求返回 403，因此关于 OpenAI 页面具体字段的判断依据为官方页面搜索结果、官方示例入口和 MCP 官方迁移资料，本文不将其表述为逐行核验结果。

MCP Apps 对本文的关键启示是：复杂业务 UI 可以作为 Tool 的受信呈现资源提供，但 Host 必须控制沙箱、消息权限、用户同意和资源审计。

### AG-UI

[AG-UI](https://docs.ag-ui.com/introduction) 是面向 Agent 与用户应用的开放事件协议，覆盖 run 和 step 生命周期、文本、Tool call、状态、活动、打断和子 Agent 等事件。

AG-UI 官方明确说明它不是 Generative UI schema，而是连接 Agent 与用户应用的双向运行时；它可以承载 A2UI、MCP-UI、Open-JSON-UI 或应用自定义的 UI 数据。

AG-UI 对本文的关键启示是：UI 描述和 Agent 运行时应避免混为一个协议。无论能力单元的 UI 是固定组件、嵌入式 widget 还是声明式 surface，都需要一个能表达执行状态、用户动作、暂停和恢复的事件连接。

### CopilotKit

CopilotKit 将 React 前端与 Agent 运行时连接起来，支持 Tool rendering、frontend tools、human-in-the-loop、shared state 和 A2UI。

其固定 schema 模式通常由开发者预先定义组件和呈现结构，Tool 提供数据；动态 schema 模式允许 Agent 在预设 catalog 内生成更灵活的 UI。两者都没有消除业务能力和 UI 之间的共同设计关系。

CopilotKit 与 AG-UI 的官方示例展示了对话内图表、可双向编辑的任务画布和暂停等待用户选择时间后继续等模式。它证明了本文设想的交互链路可以落地，但工作流和业务副作用仍由接入的 Agent 后端或 Flow 负责。

### Vercel AI SDK

[Vercel AI SDK 的官方示例](https://github.com/vercel/ai/blob/c3c189c0/content/docs/06-advanced/07-rendering-ui-with-language-models.mdx) 展示了 Tool 返回结构化对象后，客户端依据 Tool result 渲染 React 组件的模式。

这种模式适合开发者已知 Tool 和已知 UI 的应用：模型调用 `getWeather`，Tool 返回结构化天气结果，客户端选择 `WeatherCard`。它并不试图让模型直接发出可执行 React 代码。

Vercel 还提供将 MCP Apps 接入 AI SDK 应用的方案，其中 widget 仍以沙箱资源形式运行。对本文的关键启示是：Tool result 驱动 UI 是成熟的工程路径，但业务组件通常由应用开发者拥有。

### assistant-ui

[assistant-ui 的 Generative UI 文档](https://www.assistant-ui.com/docs/tools/generative-ui) 同时支持已知 Tool UI 和 `present` 工具。`present` 让模型从开发者提供的组件词汇中组合 JSON UI tree，默认组件涵盖卡片、事实、表格、图表、表单和控件。

这类能力适合摘要、比较、解释和轻量探索性界面。对于高副作用的业务操作，仍需要将组件、字段和动作与能力单元绑定，并为确认、错误和权限提供稳定语义。

### CrewAI

[CrewAI 的 Generative UI 文档](https://docs.crewai.com/v1.15.22/en/guides/frontend/generative-ui) 将 Tool-based UI、Agentic UI、A2UI 和 Human-in-the-loop 与 CrewAI Flow 结合。

CrewAI 的优势主要在 Flow、多 Agent、状态和长任务编排，UI 由前端集成和 AG-UI/A2UI 等机制提供。它说明业务工作流是独立的工程问题，不能由 UI 描述协议单独承担。

### Adaptive Cards 与 Slack Block Kit

[Adaptive Cards](https://learn.microsoft.com/en-us/microsoft-copilot-studio/adaptive-cards-overview) 提供跨宿主的 JSON 卡片、输入和动作，适合审批、问答和结果展示，但不定义 Agent Tool discovery、通用 Agent 事件流或工作流状态机。

[Slack Block Kit 的 Agent 体验更新](https://slack.dev/build-richer-agent-experiences-with-block-kit/) 增加了 Card、Alert、Carousel、Data Table、Work Object 和 Code 等面向 Agent 输出的组件方向。它说明成熟消息宿主正在把 Agent 输出从纯文本扩展为可读、可操作的结构化消息，但 Block Kit 仍然是 Slack 宿主的 UI 体系，不是通用 Agent UI 协议。

### 生态结论

当前生态的单项能力已经相当成熟：MCP Apps 适合 Tool 关联受信 widget，A2UI 适合受限声明式 UI，AG-UI 适合 Agent 与前端事件连接，应用 SDK 适合快速实现 Tool result 到 UI 的映射，Flow 引擎适合多步工作流。

尚未形成的完整方案是：面向任意存量 Web App，将业务语义、强绑定 UI、模型选择、用户输入、工作流、权限、审计、Session 回放和浏览器原生执行位置统一起来。

## UI 与业务能力的绑定模型

### 强绑定是业务设计常态

核心业务 UI 通常不是通用字段渲染器的结果，而是业务能力的具体投影：

- 退款表单的字段、顺序、资格条件和确认文案表达退款规则。
- 发票表格的批量操作、状态筛选和权限按钮表达财务流程。
- 发布审批 UI 的环境选择、风险展示、审批节点和回滚入口表达发布状态机。
- 采购表单的预算、供应商、成本中心和审批链表达组织授权关系。

如果将这些 UI 交给通用表单生成器，将业务规则留在 Tool 的服务端实现，将工作流状态留在另一个系统，三个部分就可能出现字段、状态和失败语义不一致。

### 共同设计，分离传输

更准确的关系是：能力所有者共同维护 Tool、主 UI 和工作流；运行时通过不同的声明面和传输通道把它们投影到模型、浏览器、Session 和其他 Host。

DSH 已经使用了这种关系：Tool 定义包含 `presentCall` 和 `presentResult`；工具结果中的 `presentationMeta` 与 `tool/result` 共同持久化；Web Client 根据原始调用、结果和持久化元数据派生卡片；`tool.call.toolview` 通过 Tool 名选择视图。

这不是 UI 与 Tool 的完全解耦，而是**所有权绑定、运行时分离**：Tool 所有者决定它如何被呈现，Client 决定如何在当前宿主中渲染，Session 决定哪些事实必须可回放。

### 分层实际处理的是信任域和变化率

UI 描述层的独立性主要来自三个事实：

1. 执行端和渲染端可能位于不同进程、不同设备或不同组织的 Host 中。
2. 模型输出、外部 Tool 资源和用户输入都必须经过宿主校验，不能直接获得任意代码执行权限。
3. 业务规则和视觉设计的变化率不同，且同一业务能力可能需要 Web、移动端、Slack、语音和自动化等不同呈现。

因此，UI 描述是跨信任域的传输契约和宿主适配面，不是业务能力的替代所有者。

### 绑定强度谱

| 场景 | 绑定强度 | 推荐模式 | 代表实践 |
|---|---|---|---|
| 只读摘要、对比、解释和轻量查询 | 弱 | catalog 组件组合或 Tool result 映射 | assistant-ui `present`、A2UI dynamic |
| 常规事务表单、审批和配置变更 | 强 | Tool 与业务视图共同注册 | DSH `tool.call.toolview`、A2UI fixed、MCP widget |
| 表格、画布、地图和 3D 等领域编辑器 | 很强 | Tool 关联受信嵌入式 widget | MCP Apps iframe |
| 高频、稳定且依赖肌肉记忆的操作 | 不进入 Agent UI | 传统直接操作界面 | 现有 Web 组件 |

选择绑定强度时至少应考虑副作用重量、领域特异控件密度、审计要求、用户操作频率和跨宿主复用范围。

### Agent 的自由度应放在编排上

在核心业务场景中，Agent 的主要价值不需要自由生成 UI：

1. 根据用户目标和当前状态选择哪个能力单元。
2. 从上下文中提取并预填能力单元的参数。
3. 将前一能力单元的结果传递给下一能力单元。
4. 在用户修改、拒绝、暂停或失败后重新选择下一步。
5. 解释当前状态、需要用户补充的字段和即将产生的副作用。

因此，原始设想中的“动态唤出哪个业务功能的 UI”比“模型自由生成任意 UI 树”更适合作为生产主航道。

## DSH 当前代码库审计

### 已具备的能力

| 能力 | 当前证据 | 对本文的意义 |
|---|---|---|
| Tool 注册和执行 | `packages/core/tools/src/index.ts` 提供 ToolDefinition、输入 schema、输出定义和执行上下文 | 能力单元可以以现有 Tool seam 为执行入口 |
| Tool 执行扩展 | `tools/pre-execute`、`tools/execute`、`tools/post-execute` 和 `tools/result` 事件提供审批、包装、结果处理和观察点 | 权限、取消、超时、审计和结果投影可以留在工具执行管线 |
| Tool 自带呈现声明 | `ToolDefinition.presentCall` 和 `presentResult` 位于 `packages/core/tools/src/index.ts` | 工具所有者可以共同声明调用和结果如何被宿主理解 |
| 持久呈现元数据 | Tool result 的 `meta`/`presentationMeta` 随工具结果保存 | UI 可以从已提交事实派生，而不是依赖临时 React 状态 |
| 聊天内 Tool 调用树 | `packages/client/ui-tool/README.md` 定义 root、PTC 子调用和 `tool.call.toolview` keyed slot | Tool UI 已能嵌入 Conversation Node，并支持递归调用树 |
| 业务 UI 插件化 | Client slot 通过 Tool 名注册业务视图，未注册 Tool 使用 generic fallback | 新业务能力可以通过插件增加，不必修改 agent-loop |
| 结构化用户输入 | `packages/interaction/tool-ask-user` 提供 `ask_user_question`，通过 `ctx.userQuestions` 等待回答并返回紧凑 JSON | Agent 可以在工作流中暂停并取得结构化用户决定 |
| 文件交付投影 | `packages/fs/tool-present` 记录 `deliverables/presented` | Tool 结果可以驱动用户可访问的交付物，而不是只返回文本 |
| Session 事件回放 | `tool/call`、`tool/result` 和相关投影让已提交调用、结果和 UI 事实可重建 | 能力单元可以具备可审计、可恢复的历史记录 |
| 浏览器运行时基础 | `packages/experimental/webworker-runtime` 在 Dedicated Worker 中装载预打包插件树和 VFS | Agent Loop 与 UI bridge 有浏览器原生部署基础 |

### 关键架构事实

DSH 的 Web Client 明确不直接消费 Host 层的 `presentCall` 和 `presentResult` 值，而是从原始调用参数、结果内容、错误状态和持久化元数据派生卡片。这使 UI 不会成为独立的第二事实源，也避免 React 组件状态决定 Session 历史。

`ui-conversation` 将 Session event 和客户端临时事件折叠为 Conversation Node；`ui-tool` 再从 `tool-call` 节点派生调用树。这个方向与“能力单元产生事实，Client 派生视图”的模型一致。

`docs/architecture.md` 将模型适配器、Tool registry、Session log 和 agent-loop 都定义为 Cordis 插件，并明确没有需要打补丁的特权内核。这使能力单元可以通过插件共同加入 Tool、事件投影和 UI slot。

### 当前缺口

| 缺口 | 当前边界 | 影响 |
|---|---|---|
| 能力单元没有统一公开声明 | Tool schema、Tool presenter、Client view 和业务工作流存在关联，但没有一个面向 Agent 编排的统一 descriptor | Agent 难以可靠判断某个能力何时可用、需要什么前置状态和会产生什么副作用 |
| 缺少通用受限 UI catalog | 当前主路径是按 Tool 名注册预制 view，而不是 A2UI 式 surface catalog | 不能宣称模型已经可以在 DSH 中现场组合任意业务 UI |
| 问答草稿不持久 | Web 问答 UI 的草稿、当前题目和交互状态属于非持久 slot 状态 | 页面刷新或 Worker 重启后不能自动恢复未提交回答 |
| 部分交互不能由子 Agent 直接发起 | `ask_user_question` 对 delegated caller 失败并返回 `DELEGATED_CALLER` | 需要由拥有用户交互权的父 Agent 接管问题 |
| PTC 中间值不可完整回放 | PTC dispatch 记录调用和结算事实，但任意中间绑定值不进入 Session 历史 | 不能把每个 PTC 中间 UI 状态都当作可恢复工作流状态 |
| Worker 本地持久化未完成 | WebWorker runtime 使用 MemoryVfs，当前没有完整的 OPFS/IndexedDB Session 持久化实现 | 页面或 Worker 退出后的本地恢复仍需要独立设计 |
| Client 首帧等待完整 entry roster | `ui-renderer` 当前没有 Suspense 或按 entry 的懒加载 | 动态增加业务 UI 包时，加载和版本管理仍是产品化问题 |
| 浏览器插件运行时安装未形成方案 | Worker 运行的是预打包、版本化 VFS image，overlay 范围受限于 `home/` 和 `workspace/` | 不能把能力单元默认理解为可从网络任意安装的第三方代码 |

### 审计结论

DSH 已经形成“模型 Tool → durable Tool call/result → Session event fold → Conversation Node → keyed UI view”的链路。它目前更接近**能力单元的事件驱动投影系统**，而不是通用的模型 UI 生成系统。

这是一个有利的起点：核心业务能力优先采用强绑定 Tool + View，不需要重写现有执行和回放机制；受限 catalog 可以作为只读摘要、解释和轻量组合能力增加，而不必取代稳定的业务视图。

## 安全与工程红线

### 模型不能直接获得代码执行权限

模型输出的 UI 描述、Tool 参数和用户输入都必须视为不可信数据。渲染器只接受预批准的组件、属性和 action；业务 Tool 在执行前重新验证租户、身份、权限、业务状态、幂等键和副作用范围。

MCP Apps 的 sandbox iframe、A2UI 的 catalog 和 DSH 的 Tool approval seam 都体现了同一原则：模型可以提出选择，宿主和执行端决定是否允许。

### UI action 必须有明确身份和权限

按钮、选择器和表单提交不应只产生一个前端回调。每个会影响 Agent 或业务状态的 action 都应带有稳定 action id、关联的 Tool call 或能力单元 id、Session 身份、授权上下文和可重放的参数摘要。

UI 只能提示用户确认，不能代替服务端授权。高风险动作需要独立的 approval 语义，不能仅靠隐藏按钮、页面路由或模型提示词限制。

### 模型可见事实必须进入 Session

DSH 的“模型可见 ⟺ 已记录”规则对动态 UI 尤其重要：任何进入后续模型请求的用户输入、UI action、业务选择或 Tool 结果，都需要有可重建的 Session 事件。

未提交的输入草稿、焦点、展开状态和临时动画不必进入 Session；如果 Agent 会依据它们继续执行，就必须在提交点形成明确事件，并区分草稿、确认、执行和结果。

### 不应自动重试未知副作用

网络断线、页面关闭、Worker 终止或云端 handoff 可能使 Tool 的副作用结果处于未知状态。Agent 不应仅因为没有收到结果就自动再次执行；应查询操作状态、要求人工对账或将结果标记为未知。

## 面向 DSH 的实施路线

### 阶段 A：强绑定 Tool UI 垂直样板

选择一个有多步状态和明确审批的业务域，例如发布审批、工单 triage、采购审批或合同审阅，定义 3–5 个能力单元。

每个能力单元共同提供 Tool schema、业务视图、pending/result/error/approval 状态、权限判断和 Session 事件。先复用 `tool.call.toolview`、`ask_user_question` 和现有 Conversation Node，不引入通用 UI 生成器。

验收应包括：用户自然语言请求触发正确能力单元，UI 能从上下文预填字段，用户修改字段后 Tool 使用新值执行，Tool 完成后 Agent 依据真实结果继续下一步，刷新后已提交调用和结果仍可重建。

### 阶段 B：能力单元编排声明

为 Agent 编排增加并行于模型 Tool schema 的能力描述，内容可以包括能力用途、前置状态、只读或写入性质、破坏性、需要的用户确认、输入依赖、输出引用和可继续动作。

该描述不应把 UI 词汇混入模型面向的 Tool schema。模型需要业务语义和操作约束，Client 需要呈现和交互约束；两者由同一个能力包共同维护，但通过不同声明面提供。

验收应包括：Agent 不能在缺少前置状态或权限时选择能力；同一个能力单元可以在不同模型和 Host 上使用；descriptor 版本变化不会让旧 Session 无法解释已提交调用。

### 阶段 C：受限 UI catalog 作为补充机制

为只读摘要、对比、解释和轻量输入增加受限 `UiSurface` 或等价 catalog。catalog 只包含宿主已经实现并批准的组件、属性和 action；Tool 或 Agent 只能引用 catalog，不得传输任意 HTML/JavaScript。

固定业务流程优先使用能力单元自带的固定 view；动态 surface 只作为间隙层，负责把多个已知结果组合成摘要、比较表或下一步选择。

验收应包括：非法组件和属性在渲染前被拒绝；action 与 Tool 或能力单元身份关联；surface 删除、更新和重连有明确事件；动态 UI 不会绕过 Tool approval 和服务端权限检查。

### 阶段 D：工作流和浏览器原生运行

把多步流程建模为可观察的状态机或 Flow，明确每个步骤的 owner、输入、输出、暂停点、取消语义、重试策略、幂等键和补偿动作。UI 是状态投影，不隐式承担跨步骤副作用。

在 Dedicated Worker 中运行 Agent Loop 和 UI bridge，模型请求可以经由同域代理或远程服务，浏览器工具与云端工具通过同一能力声明和执行语义区分提供者。

浏览器原生验收应分别验证浏览器停止消费、代理传播取消、上游连接终止、Tool 副作用未知、Session flush 失败和页面退出后的恢复，不以单次 UI 展示替代执行闭环验证。

### 建议样板：发布审批

用户提出“把 v1.8 发布到灰度，先检查变更和风险”。Agent 选择 `release.inspect`，在消息流中呈现变更摘要和风险表；随后唤出 `release.select_scope` 的环境和比例选择 UI；再调用 `release.request_approval`；用户确认后调用 `release.start_canary`；同一条任务记录继续展示进度、失败、回滚或需要人工处理的状态。

这个样板验证的重点不是卡片是否具有通用性，而是每个 UI action 是否能关联到稳定的能力单元和 Session 事实，Agent 是否能在用户修改选择后正确重新参数化下一步，副作用不明时是否避免重复执行。

## 开放问题

- 能力单元的 Tool、主 UI、工作流和呈现 descriptor 是否应由一个 package 提供，还是由多个插件通过稳定 registry 组合；拆分条件应以角色是否独立演化为准。
- 能力 descriptor 如何同时服务模型选择、权限预检、UI 路由和产品可观测性，而不把 Client 细节泄漏到模型提示词。
- UI action、Tool call、approval、workflow step 和 Session event 之间使用哪些稳定 id，如何支持旧版本 Session 回放。
- Agent 如何在多个候选能力单元语义相近时选择正确单元，是否需要显式前置状态、拒绝条件和示例，而不能只依赖自然语言描述。
- 固定能力视图、动态 catalog surface 和嵌入式 widget 的切换条件如何配置，是否由能力作者声明并由 Host 按能力降级。
- Worker 内 OPFS 或云端 Session 的写入确认如何与 Agent loop 的 checkpoint policy 对齐。
- 浏览器执行和云端持续执行之间如何交接已提交状态，如何隔离旧 owner，如何处理正在进行的模型流、Tool Promise 和审批等待。
- 第三方能力包是否允许在浏览器中加载，如何验证签名、版本、依赖闭包、资源上限和租户隔离。
- 哪些业务操作仍应保留传统页面，因为它们需要高频重复输入、密集比较或对空间布局有强依赖。

## 结论

Agent 在对话中选择业务功能、唤起与该功能强绑定的 UI、收集用户输入并串联后续操作，已经具备可验证的技术路径，也已经由多个生态项目分别实践。

“UI 与业务能力完全解耦后由模型自由生成”不是生产业务 UI 的主航道。更可靠的方向是能力所有者共同维护 Tool、UI、状态、权限和工作流，Agent 在这些能力单元之间进行选择、预填、串联和恢复，Host 负责安全渲染，Session 负责记录可重建事实。

DSH 当前的 Tool presentation、事件源 Session、Conversation Node、按 Tool 名注册的 UI slot、用户问答 seam 和浏览器 Worker runtime 已经支持这一架构的核心部分。下一步不应从通用页面生成器开始，而应从一个强绑定能力单元组成的垂直流程开始，再根据只读组合和跨 Host 需求增加受限 UI catalog 或嵌入式 widget。

这个方向的革命性不在于把现有页面缩小后放进消息泡，而在于把用户目标、业务能力、界面输入、权限、执行状态和工作流恢复统一到同一个 Agent 可编排的任务记录中。

## Further Exploration

- [A2UI](https://a2ui.org/) — Google 的 Agent-to-UI 项目、版本状态和概念说明。
- [A2UI v0.9.1 specification](https://a2ui.org/specification/v0.9.1-a2ui/) — surface、组件、数据绑定和 action 消息。
- [A2UI ecosystem comparison](https://a2ui.org/introduction/agent-ui-ecosystem/) — A2UI、MCP Apps、AG-UI 和 A2A 的定位关系。
- [MCP Apps SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) — Tool 关联 UI resource、sandbox 和 Host 通信。
- [AG-UI overview](https://docs.ag-ui.com/introduction) — Agent 与用户应用的事件协议。
- [AG-UI and Generative UI specs](https://docs.ag-ui.com/concepts/generative-ui-specs) — AG-UI 与 A2UI、MCP-UI、Open-JSON-UI 的关系。
- [CopilotKit A2UI](https://docs.copilotkit.ai/generative-ui/a2ui) — React、fixed schema、dynamic schema 和 A2UI 集成。
- [Vercel AI SDK: rendering UI with language models](https://github.com/vercel/ai/blob/c3c189c0/content/docs/06-advanced/07-rendering-ui-with-language-models.mdx) — Tool result 到 React UI 的实现模式。
- [assistant-ui Generative UI](https://www.assistant-ui.com/docs/tools/generative-ui) — `present` Tool 和组件词汇组合。
- [CrewAI Generative UI](https://docs.crewai.com/v1.15.22/en/guides/frontend/generative-ui) — Agentic UI、Tool-based UI 和 Flow 集成。
- [Adaptive Cards overview](https://learn.microsoft.com/en-us/microsoft-copilot-studio/adaptive-cards-overview) — JSON 卡片、输入和动作。
- [Slack Block Kit agent experiences](https://slack.dev/build-richer-agent-experiences-with-block-kit/) — 消息宿主中的 Agent 结构化 UI。
- [CopilotKit on AgentCore](https://www.copilotkit.ai/blog/generative-ui-on-agentcore-with-copilotkit) — AG-UI、图表、共享状态和 Human-in-the-loop 示例。
- [Vercel AI SDK MCP Apps](https://vercel.com/kb/guide/ai-sdk-mcp-apps) — 将 MCP Apps 接入 AI SDK 应用的 Host 模式。
- [DSH architecture](../architecture.md) — Cordis 插件组合、Agent Loop、Session 和能力扩展点。
- [DSH tools subsystem](../subsystems/tools.md) — Tool schema、执行流水线和 presentation 类型。
- [DSH Web Client architecture](../subsystems/web-client.md) — Client、Host、Session 投影和 UI 责任划分。
- [DSH conversation subsystem](../subsystems/conversation.md) — Conversation Node、事件折叠和回放。
- [DSH WebWorker runtime](../../packages/experimental/webworker-runtime/README.md) — Dedicated Worker、VFS 镜像和浏览器兼容层。
- [DSH client Tool UI](../../packages/client/ui-tool/README.md) — Tool 调用树、keyed slot 和内置卡片。
- [DSH ask-user tool](../../packages/interaction/tool-ask-user/README.md) — 结构化问题、答案和取消语义。

-----

## Dev Note

本文是 Agentic UI 架构调研与建议稿，不代表 DSH 已经完成通用动态 UI、业务能力 marketplace 或浏览器跨刷新持久化。当前实现、配置和限制由对应 package README、架构文档、Session 格式文档和测试维护；若采用本文建议，应分别为能力单元声明、UI catalog、编排事件和 Browser runtime 建立正式决策记录与验收测试。
