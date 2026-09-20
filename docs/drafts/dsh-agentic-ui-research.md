---
description: "调研 Agent 将 Web App 业务操作抽象为可唤起的界面能力、在对话中动态呈现并串联工作流的实践、DSH 代码基础、绑定模型、目标能力单元模型与实施建议。"
---

# DSH Agentic UI：把业务操作抽象为 Agent 可唤起的界面能力

## Summary

将 Web App 的业务操作同时建模为 Agent 可调用的 Tool 和用户可操作的 UI，并由 Agent 在对话过程中选择、预填、唤起和串联这些能力单元，是一个具有产品价值和技术基础的方向；本文的判断基于调研时点可访问的公开资料，不把它表述为尚无人实践的空白领域，也不表述为永久成立的市场结论。

本次调研覆盖的公开方案（A2UI、MCP Apps、OpenAI Apps SDK、AG-UI、CopilotKit、Vercel AI SDK、assistant-ui、CrewAI、Adaptive Cards、Slack Block Kit）已分别覆盖 Tool 调用、对话内 UI、结构化用户输入、流式状态或工作流编排中的部分能力；在本次调研覆盖的公开方案中，尚未发现同时面向任意存量 Web App、并统一处理业务语义、强绑定 UI、模型选择、用户输入、工作流、权限、审计、Session 回放和浏览器原生执行位置的完整方案。

本文的正式架构原则是：**能力单元在设计上强绑定，UI 与执行在传输上分离；Agent 的主要价值是选择、预填、串联和恢复已绑定的能力单元，而不是为核心事务现场生成任意 UI。**

DSH 已经具备这条路线的大部分基础：工具注册与执行流水线、按 Tool 名寻址的调用卡片、结构化人机问答、事件源 Session 投影，以及浏览器 Dedicated Worker 运行基础；主要缺口是能力单元的统一声明与编排语义、受限 catalog 的安全边界、待提交交互与浏览器本地持久化。

| 判断项 | 当前结论 |
|---|---|
| 方向是否具有 UI/UX 革命性 | 是，但革命点主要是从页面导航转向 Agent 编排的任务表面，不是简单把卡片放进消息泡 |
| 是否已经有人做过 | 调研时点已有大量相关实践；本次调研覆盖的公开方案中，没有一个完整覆盖任意存量 Web App、强绑定业务 UI、Agent 编排、审计回放和浏览器原生运行的组合 |
| UI 与 Tool 是否应完全解耦 | 不应。业务能力与其主 UI 通常共同设计；协议和运行时仍需要把执行与渲染分成不同声明面 |
| DSH 是否已有可复用基础 | 有。Tool、Tool 呈现、Conversation Node、UI slot、结构化问答和 Session 投影已经形成连续链路 |
| DSH 最大产品化缺口 | 能力单元的统一声明与编排语义，以及待提交交互、浏览器本地持久化和跨页面恢复 |
| 推荐首个实现目标 | 一个具有审批和多步状态的垂直业务流程，而不是通用的任意页面生成器 |

原始设想中的“动态唤出哪个业务功能的 UI”比“模型自由生成任意 UI 树”更适合作为生产主航道；实施上不应从通用页面生成器开始，而应从一个强绑定能力单元组成的垂直流程开始。

## Table of Contents

- [调研范围与问题设定](#调研范围与问题设定)
- [核心架构判断：UI 与业务能力的绑定模型](#核心架构判断ui-与业务能力的绑定模型)
- [外部生态调研](#外部生态调研)
- [DSH 当前代码审计](#dsh-当前代码审计)
- [目标能力单元模型](#目标能力单元模型)
- [安全与可靠性](#安全与可靠性)
- [实施路线](#实施路线)
- [开放问题](#开放问题)
- [结论](#结论)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

## 调研范围与问题设定

本文面向正在评估 DSH 浏览器原生运行时、Agent 主导的 Web App 和业务 UI 插件化的工程师，回答以下问题：

1. Web App 的业务操作是否可以同时成为 Agent Tool 和对话内 UI 能力？
2. Agent 是否可以在用户对话中选择合适的业务 UI，收集输入并继续工作流？
3. 调研时点有哪些协议、产品和框架已经实现这类能力？
4. UI 与业务能力之间应该如何划分所有权、声明面和运行时职责？
5. DSH 当前代码库已经具备什么，缺什么，应该从哪里开始验证？

本文使用四类标记区分陈述性质；未标注的段落默认为设计判断：

| 标记 | 含义 | 在文中的标注方式 |
|---|---|---|
| 当前实现 | 可以由 DSH 源码、package README、测试或已提交 Session 结构直接确认 | DSH 审计表格逐行标注证据性质；关键事实段落显式标注 |
| 外部事实 | 由外部项目调研时点的官方规范、文档或官方博客确认 | 生态调研章节整体标注，并带时点限定 |
| 设计判断 | 根据当前实现和外部事实得出的架构结论 | 默认类别，标题标注“设计判断” |
| 建议目标 | 尚未实现、需要新增协议或验证的设计 | 实施路线与目标模型章节标题标注“建议目标” |

本文的外部实践判断基于本次调研时点可访问的官方规范、官方文档和官方博客；协议状态、产品能力和生态集成可能继续变化。本文不把“未发现完整方案”表述为“市场上不存在完整方案”；部分参考链接保留版本号或固定 commit，用于锚定调研证据。

本文的术语约定：

| 术语 | 约定 |
|---|---|
| Tool | 模型可调用的业务操作；中文正文统一大写首字母，代码字段保持原样 |
| UI surface | 一个能力单元在宿主中的一次界面实例，可以是消息内卡片、消息内展开面板、侧栏或受信 widget |
| 能力单元 | 业务所有者共同维护的 Tool、主 UI、状态、权限与恢复语义的组合单位；最小声明见[目标能力单元模型](#目标能力单元模型) |
| 能力 descriptor | 能力单元对外发布的声明数据；模型面与呈现面分开提供 |
| Host / Client / renderer | Host 指运行 Agent Loop 与服务 seam 的进程；Client 指浏览器端应用；renderer 指 Client 中实际渲染 UI 的部分 |
| 呈现 | presentation 的中文对应；`presentCall`、`presentResult`、`presentationMeta` 等代码名保留原样 |
| 工作流与 Flow | “工作流”指多步业务流程的统称；Flow 指具体的工作流运行时或状态机形态 |

“浏览器原生”沿用此前调研的定义：DSH Host 和 Agent Loop 驻留 Dedicated Worker，不依赖配套的本地 Node Host；它不表示不需要预构建镜像、不需要兼容层、不需要远程模型，也不表示所有 Node 或操作系统能力都能在浏览器内提供。

## 核心架构判断：UI 与业务能力的绑定模型

### 强绑定是业务设计常态（设计判断）

核心业务 UI 通常不是通用字段渲染器的结果，而是业务能力的具体投影：

- 退款表单的字段、顺序、资格条件和确认文案表达退款规则。
- 发票表格的批量操作、状态筛选和权限按钮表达财务流程。
- 发布审批 UI 的环境选择、风险展示、审批节点和回滚入口表达发布状态机。
- 采购表单的预算、供应商、成本中心和审批链表达组织授权关系。

如果将这些 UI 交给通用表单生成器，将业务规则留在 Tool 的服务端实现，将工作流状态留在另一个系统，三个部分就可能出现字段、状态和失败语义不一致。

### 共同设计，分离传输（架构原则）

更准确的关系是：能力所有者共同维护 Tool、主 UI 和工作流；运行时通过不同的声明面和传输通道把它们投影到模型、Client、Session 和其他 Host。

当前实现已经体现了这个模式的一部分：`ToolDefinition` 可以声明 Host-local 的纯函数 `presentCall` 和 `presentResult`，但内置 Web Client 不消费这些返回值；Client 通过 `tool.call.toolview` 按 wire Tool 名选择 renderer，并从原始调用参数、结果内容、失败状态和持久化的 `output.presentationMeta` 派生卡片。`presentationMeta` 作为 Tool result 的持久化展示数据进入 Session；它不等于完整的 UI 状态，并且当前实现只在顶层工具执行路径投影该元数据，PTC 子调用不适用同一投影。

因此这不是 UI 与 Tool 的完全解耦，而是**所有权绑定、运行时分离**：Tool 所有者决定它如何被呈现，Client 决定如何在当前宿主中渲染，Session 决定哪些事实必须可重建。

### 分层处理的是信任域和变化率（设计判断）

UI 描述层的独立性主要来自三个事实：

1. 执行端和渲染端可能位于不同进程、不同设备或不同组织的 Host 中。
2. 模型输出、外部 Tool 资源和用户输入都必须经过宿主校验，不能直接获得任意代码执行权限。
3. 业务规则和视觉设计的变化率不同，且同一业务能力可能需要 Web、移动端、Slack、语音和自动化等不同呈现。

因此，UI 描述是跨信任域的传输契约和宿主适配面，不是业务能力的替代所有者。

### 绑定强度谱（设计判断）

| 场景 | 绑定强度 | 推荐模式 | 代表实践 |
|---|---|---|---|
| 只读摘要、对比、解释和轻量查询 | 弱 | catalog 组件组合或 Tool result 映射 | assistant-ui `present`、A2UI dynamic |
| 常规事务表单、审批和配置变更 | 强 | Tool 与业务视图共同注册 | DSH `tool.call.toolview`、A2UI fixed、MCP widget |
| 表格、画布、地图和 3D 等领域编辑器 | 很强 | Tool 关联受信嵌入式 widget | MCP Apps iframe |
| 高频、稳定且依赖肌肉记忆的操作 | 不进入 Agent UI | 传统直接操作界面 | 现有 Web 组件 |

选择绑定强度时至少应考虑副作用重量、领域特异控件密度、审计要求、用户操作频率和跨宿主复用范围。

### 消息泡不是唯一容器（设计判断）

消息泡适合承载短生命周期、与当前 Agent 步骤直接相关的输入、确认、摘要和状态。

复杂表格、画布、地图、时间轴或需要持续编辑的对象不应被强制压缩进消息泡：消息流的纵向结构不利于密集比较，普通卡片也无法承载复杂编辑器。能力单元可以在消息中提供入口和上下文，再由 Host 展开为同一任务记录下的 inline surface、侧栏面板或受信 widget；任务完成后，用户仍可以通过该入口回到业务对象。

关键要求不是所有 UI 使用同一容器，而是用户动作、Tool call、工作流步骤和 Session 事实保持关联。“渲染在当前页面”指交互不发生页面跳转、事实回到同一任务记录，而不是一切 UI 都塞进单个消息泡。

### Agent 的自由度应放在编排上（设计判断）

在核心业务场景中，Agent 的主要价值不需要自由生成 UI：

1. 根据用户目标和当前状态选择哪个能力单元。
2. 从上下文中提取并预填能力单元的参数。
3. 将前一能力单元的结果传递给下一能力单元。
4. 在用户修改、拒绝、暂停或失败后重新选择下一步。
5. 解释当前状态、需要用户补充的字段和即将产生的副作用。

这五件事都不需要解耦业务 UI 与业务能力；原始设想中的“动态唤出”正是指这个自由度。

### “自动生成 UI”不是同一个反面对象（设计判断）

“不应从通用页面生成器开始”针对的只是一类做法。本文区分四种形态，避免把所有动态 UI 一并否定：

1. **从 Tool JSON Schema 自动生成生产事务表单**：不作为核心业务主路径；领域校验、状态、权限和恢复语义无法从 Schema 推出。
2. **从受限 catalog 组合只读或低副作用 UI**：可以采用，作为摘要、比较、解释的间隙层。
3. **Tool 关联业务自有 widget（受信嵌入式）**：适合复杂强绑定 UI，如 MCP Apps 模式。
4. **模型输出任意 HTML/JavaScript 并在宿主执行**：禁止。

## 外部生态调研

本节内容均为外部事实，能力与状态以调研时点为准；正文已在关键处标注时点与证据边界。

### Google A2UI

[A2UI](https://a2ui.org/) 是 Google 发布的 Agent-to-UI 声明式协议。本次调研访问官方网站时，v0.9.1 标记为 Current/Production，v1.0 标记为 Candidate；这是调研时点的外部资料状态，不构成 DSH 的依赖或版本承诺。

A2UI 通过 `createSurface`、`updateComponents`、`updateDataModel` 和 `deleteSurface` 等消息逐步建立和更新 UI surface，支持组件 catalog、数据绑定、JSON Pointer、用户输入和 action。组件由宿主预先实现，Agent 传输的是声明式数据和结构，不是任意可执行前端代码。

[A2UI 的生态比较文档](https://a2ui.org/introduction/agent-ui-ecosystem/) 将 A2UI 与 MCP Apps、AG-UI、A2A 等定位为互补关系：A2UI 负责 UI 描述，其他协议负责工具、Agent 间通信或 Agent 与用户之间的运行时连接。

本文把“catalog 内由 Agent 组合组件结构”的模式统称为 dynamic UI：固定业务流程优先采用由能力所有者预先确定的组件结构与字段约束，dynamic UI 适合开放式、探索性、摘要或低副作用场景。A2UI 对本文的关键启示是：动态 UI 可以存在，但生产场景仍依赖宿主批准的 catalog。

### MCP Apps 与 OpenAI Apps SDK

[MCP Apps SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) 调研时已进入 Final 状态。它允许 MCP Tool 关联 `ui://` HTML 资源，Host 在沙箱 iframe 中加载 UI，widget 通过 JSON-RPC 消息与 Host 和 Tool 通信。

MCP Apps 的典型交付单位是 Tool 与 widget 的共同实现。Tool 负责业务能力，widget 负责在宿主中显示业务数据、接收用户动作和发起后续调用；二者通过明确的资源标识和消息协议关联，而不是由模型从通用字段自动生成完整生产界面。

OpenAI Apps SDK 采用相近的 Tool 加 widget 模式，主要面向 ChatGPT Host。此次调研中 OpenAI 开发者页面部分请求返回 403，因此关于 OpenAI 页面具体字段的判断依据为官方页面搜索结果、官方示例入口和 MCP 官方迁移资料，本文不将其表述为逐行核验结果。

MCP Apps 对本文的关键启示是：复杂业务 UI 可以作为 Tool 的受信呈现资源提供，但 Host 必须控制沙箱、消息权限、用户同意和资源审计。

### AG-UI

[AG-UI](https://docs.ag-ui.com/introduction) 是面向 Agent 与用户应用的开放事件协议，覆盖 run 和 step 生命周期、文本、Tool call、状态、活动、打断和子 Agent 等事件。

AG-UI 官方明确说明它不是 Generative UI schema，而是连接 Agent 与用户应用的双向运行时；它可以承载 A2UI、MCP-UI、Open-JSON-UI 或应用自定义的 UI 数据。

AG-UI 对本文的关键启示是：UI 描述和 Agent 运行时应避免混为一个协议。无论能力单元的 UI 是固定组件、嵌入式 widget 还是声明式 surface，都需要一个能表达执行状态、用户动作、暂停和恢复的事件连接。

### CopilotKit

CopilotKit 将 React 前端与 Agent 运行时连接起来，支持 Tool rendering、frontend tools、human-in-the-loop、shared state 和 A2UI。

其固定 schema 模式通常由开发者预先定义组件和呈现结构，Tool 提供数据；dynamic 模式允许 Agent 在预设 catalog 内生成更灵活的 UI。两者都没有消除业务能力和 UI 之间的共同设计关系。

CopilotKit 与 AG-UI 的官方示例展示了对话内图表、可双向编辑的任务画布和暂停等待用户选择时间后继续等模式。它证明了本文设想的交互链路可以落地，但工作流和业务副作用仍由接入的 Agent 后端或 Flow 负责。

### Vercel AI SDK

[Vercel AI SDK 的官方示例](https://github.com/vercel/ai/blob/c3c189c0/content/docs/06-advanced/07-rendering-ui-with-language-models.mdx)（链接固定到调研时的文档版本）展示了 Tool 返回结构化对象后，客户端依据 Tool result 渲染 React 组件的模式。

这种模式适合开发者已知 Tool 和已知 UI 的应用：模型调用 `getWeather`，Tool 返回结构化天气结果，客户端选择 `WeatherCard`。它并不试图让模型直接发出可执行 React 代码。

Vercel 还提供将 MCP Apps 接入 AI SDK 应用的方案，其中 widget 仍以沙箱资源形式运行。对本文的关键启示是：Tool result 驱动 UI 是成熟的工程路径，但业务组件通常由应用开发者拥有。

### assistant-ui

[assistant-ui 的 Generative UI 文档](https://www.assistant-ui.com/docs/tools/generative-ui) 同时支持已知 Tool UI 和 `present` 工具。`present` 让模型从开发者提供的组件词汇中组合 JSON UI tree，默认组件涵盖卡片、事实、表格、图表、表单和控件。

这类能力适合摘要、比较、解释和轻量探索性界面。对于高副作用的业务操作，仍需要将组件、字段和动作与能力单元绑定，并为确认、错误和权限提供稳定语义。

### CrewAI

[CrewAI 的 Generative UI 文档](https://docs.crewai.com/v1.15.22/en/guides/frontend/generative-ui)（版本号链接用于固定调研证据）将 Tool-based UI、Agentic UI、A2UI 和 Human-in-the-loop 与 CrewAI Flow 结合。

CrewAI 的优势主要在 Flow、多 Agent、状态和长任务编排，UI 由前端集成和 AG-UI/A2UI 等机制提供。它说明业务工作流是独立的工程问题，不能由 UI 描述协议单独承担。

### Adaptive Cards 与 Slack Block Kit

[Adaptive Cards](https://learn.microsoft.com/en-us/microsoft-copilot-studio/adaptive-cards-overview) 提供跨宿主的 JSON 卡片、输入和动作，适合审批、问答和结果展示，但不定义 Agent Tool discovery、通用 Agent 事件流或工作流状态机。

[Slack Block Kit 的 Agent 体验更新](https://slack.dev/build-richer-agent-experiences-with-block-kit/) 增加了 Card、Alert、Carousel、Data Table、Work Object 和 Code 等面向 Agent 输出的组件方向。它说明成熟消息宿主正在把 Agent 输出从纯文本扩展为可读、可操作的结构化消息，但 Block Kit 仍然是 Slack 宿主的 UI 体系，不是通用 Agent UI 协议。

### 能力矩阵（本次调研的定性比较）

下表是本次调研依据各项目官方文档作出的定性比较，不是官方功能认证；“强/弱/部分”描述该方案对某层职责的覆盖程度。

| 方案 | Tool 调用 | Agent 事件流 | UI 描述 | 与业务 UI 绑定 | 工作流 | 适用 Host |
|---|---|---|---|---|---|---|
| A2UI | 间接（依赖外部工具协议） | 否 | 声明式组件 catalog | fixed 模式强，dynamic 模式弱 | 否 | 多端 renderer |
| MCP Apps | 强（MCP Tool） | 部分（由宿主实现） | 沙箱 widget 资源 | 强（Tool 与 widget 共同交付） | 否 | MCP 宿主 |
| AG-UI | 承载调用事件 | 强 | 不提供 | 不负责 | 否 | 前端应用 |
| CopilotKit | 强 | 强 | React 集成与 A2UI | 可强可弱 | 依赖后端 Flow | React |
| Vercel AI SDK | 强 | 框架内部 | Tool result 到 React | 通常强 | 不负责 | Web 应用 |
| assistant-ui | Tool UI | 框架内部 | `present` 组件词汇 | 可强可弱 | 不负责 | React |
| Adaptive Cards | 不负责 | 不负责 | JSON 卡片 | 由宿主与机器人决定 | 不负责 | 企业宿主 |
| Slack Block Kit | 不负责 | 不负责 | Block 组件 | Slack 专属 | 不负责 | Slack |

### 生态结论

当前生态的单项能力在调研时点已相当成熟：MCP Apps 适合 Tool 关联受信 widget，A2UI 适合受限声明式 UI，AG-UI 适合 Agent 与前端事件连接，应用 SDK 适合快速实现 Tool result 到 UI 的映射，Flow 引擎适合多步工作流。

在本次调研覆盖的公开方案中，尚未发现一个同时面向任意存量 Web App、统一处理业务语义、强绑定 UI、模型选择、用户输入、工作流、权限、审计、Session 回放和浏览器原生执行位置的完整方案；本结论限于调研时点与已覆盖资料。

## DSH 当前代码审计

### 已具备的能力（当前实现）

| 能力 | 当前证据 | 证据性质 | 对本文的意义 |
|---|---|---|---|
| Tool 注册和执行 | `packages/core/tools` 的 `ToolDefinition`、输入 schema、输出定义与执行上下文 | 当前源码与测试 | 能力单元可以以现有 Tool 执行入口为基础 |
| Tool 执行扩展 | `tools/pre-execute`、`tools/execute`、`tools/post-execute`、`tools/result` 事件 | 当前源码与事件目录 | 审批、包装、结果处理和观察点留在工具执行管线 |
| Tool 自带呈现声明 | `ToolDefinition.presentCall`、`presentResult` | 当前源码；Host-local 纯函数 | 工具所有者可声明呈现意图；Web Client 不直接消费这些值 |
| 持久呈现元数据 | `output.presentationMeta` 随 Tool result 持久化 | 当前源码；仅顶层执行路径投影 | 呈现数据可随已提交事实重建；不等于完整 UI 状态 |
| 聊天内 Tool 调用树 | `tool.call.toolview` keyed slot、root 与 PTC 子调用、generic fallback | 当前 Client 实现与 README | 已实现按 Tool 名注册的调用树卡片；不等于通用动态 UI |
| 业务 UI 插件化 | 业务包只注册 wire Tool 名与原子视图 | 当前 Client 实现与 README | 新业务能力通过插件加入，不改 agent-loop |
| 结构化用户输入 | `tool-ask-user` 提供 `ask_user_question`，`ui-user-questions` 提供 Web composer takeover，经 `ctx.userQuestions` seam 协作 | 当前工具与 Client 协同实现 | Agent 可暂停并获得结构化答案；待提交草稿是页面级非持久状态；子 Agent 调用被拒（`DELEGATED_CALLER`） |
| 文件交付投影 | `packages/fs/tool-present` 记录 `deliverables/presented` | 当前源码 | Tool 结果可驱动用户可访问交付物 |
| Session 事件回放 | `tool/call`、`tool/result` 与持久化展示元数据 | 当前事件目录与投影实现 | 已提交调用、结算结果和部分 Tool 卡片可重建；未提交草稿、临时 UI 状态与 PTC 中间值不在完整回放范围 |
| 浏览器运行时基础 | Dedicated Worker 装载预打包插件树与内存 VFS | experimental 包；preview 验收不含真实模型请求 | Worker Host、模块加载与页面隧道可启动；不构成真实模型与工具闭环的完成证据 |

### 关键架构事实（当前实现）

Web Client 不消费 Host 层 `presentCall` 和 `presentResult` 的返回值，而是从原始调用参数、结果内容、失败状态和持久化元数据派生卡片。UI 因此不是独立的第二事实源，React 组件状态也不决定 Session 历史。

`ui-conversation` 将 Session event 和客户端临时事件折叠为 Conversation Node；`ui-tool` 再从 `tool-call` 节点派生调用树。业务包只注册 wire Tool 名与原子视图；调用/结果配对、生命周期和 root/subcall 拓扑由 Runtime 权威维护。

`docs/architecture.md` 将模型适配器、Tool registry、Session log 和 agent-loop 都定义为 Cordis 插件，并明确没有需要打补丁的特权内核。这使能力单元可以通过插件共同加入 Tool、事件投影和 UI slot。

仓库规则要求进入模型请求的内容必须能从 Session 日志重建。对动态 UI 的含义是：任何会影响后续模型请求的用户输入、UI action、业务选择或 Tool 结果都需要对应的 Session 事件；草稿、焦点、展开状态不必进入，Agent 若要依据它们继续执行，就必须在提交点形成明确事件。同时注意 Session 是 append-only 事件日志，持久性由 flush barrier 决定，不是自动落盘。

### 当前缺口（当前实现的边界）

| 缺口 | 当前边界 | 影响 |
|---|---|---|
| 能力单元没有统一公开声明 | Tool schema、Tool presenter、Client view 和业务工作流存在关联，但没有一个面向 Agent 编排的统一 descriptor | Agent 难以可靠判断某个能力何时可用、需要什么前置状态和会产生什么副作用 |
| 缺少通用受限 UI catalog | 当前主路径是按 Tool 名注册预制 view，而不是 A2UI 式 surface catalog | 不能宣称模型已经可以在 DSH 中现场组合任意业务 UI |
| 问答草稿不持久 | 问答 UI 的草稿、当前题目和交互状态保存在页面级非持久 slot store | 整页刷新后不能自动恢复未提交回答；Session 内导航可以保留 |
| 部分交互不能由子 Agent 直接发起 | `ask_user_question` 拒绝非根调用者并返回 `DELEGATED_CALLER` | 需要由拥有用户交互权的父 Agent 接管问题 |
| PTC 中间值不可完整回放 | PTC dispatch 记录调用和结算事实，但任意中间绑定值不进入 Session 历史 | 不能把每个 PTC 中间 UI 状态都当作可恢复工作流状态 |
| Worker 本地持久化未完成 | WebWorker runtime 使用内存 VFS，Session 日志在 Worker 生命周期内落在内存明文路径 | 页面或 Worker 退出后的本地恢复仍需要独立设计 |
| Client 首帧等待完整 entry roster | renderer 没有 Suspense 或按 entry 的懒加载 | 动态增加业务 UI 包时，加载和版本管理仍是产品化问题 |
| 浏览器插件运行时安装未形成方案 | Worker 运行的是预打包、版本化 VFS image，overlay 只能替换 `home/` 与 `workspace/` 下的文件 | 不能把能力单元默认理解为可从网络任意安装的第三方代码 |

### 审计结论（设计判断）

DSH 已经形成“模型 Tool → durable Tool call/result → Session event fold → Conversation Node → keyed UI view”的链路。它目前更接近**能力单元的事件驱动投影系统**，而不是通用的模型 UI 生成系统。

这是一个有利的起点：核心业务能力优先采用强绑定 Tool + View，不需要重写现有执行和回放机制；受限 catalog 可以作为只读摘要、解释和轻量组合能力增加，而不必取代稳定的业务视图。

## 目标能力单元模型

本节全部为建议目标，不是当前已实现的 DSH 结构。

### 目标交互流程

用户表达任务目标，Agent 根据当前 Session、权限、业务状态和已有结果选择能力单元；能力单元提供与业务规则绑定的 UI；用户在 UI 中补充或确认输入；Tool 执行真实业务操作；结果和必要的 UI 状态进入事件流，驱动下一步选择或结束流程。每一步的用户动作都与已提交的 Session 事实关联，未提交的草稿停留在 Client。

### 能力单元的最小声明

| 声明部分 | 作用 |
|---|---|
| `id` 与版本 | 稳定标识能力及其兼容版本 |
| Model Tool | 模型可调用的名称、输入、输出和描述 |
| Primary View | 能力的主交互 UI 或受信 widget，以及宿主内的呈现位置（消息内卡片、展开面板、侧栏） |
| Lifecycle | idle、pending、awaiting-input、approved、running、success、failure、cancelled 等状态 |
| Preconditions | 前置业务状态、所需资源和可见条件 |
| Authorization | 用户、租户、角色和独立审批要求 |
| Side Effects | 只读、写入、破坏性动作、外部副作用和幂等要求 |
| Input Binding | UI 字段如何映射到 Tool 输入，哪些字段可从上下文预填 |
| Output References | 输出如何被后续能力单元引用 |
| Recovery | 取消、重试、补偿、未知结果和人工介入规则 |
| Host Fallback | 当前宿主不支持主 UI 时的降级呈现 |
| Presentation Version | UI 变化与旧 Session 回放的兼容策略 |

例如，`release.select_scope` 不只是一个 JSON Schema。它还需要声明可选择的环境、灰度比例的业务限制、当前用户是否有修改权限、提交后是否需要审批、输出如何传给 `release.request_approval`，以及浏览器刷新后哪些选择已提交、哪些仍是草稿。

### Tool、UI、工作流与 Session 的关系

能力单元由业务所有者共同维护上述声明；运行时把不同声明面投影给模型（Tool schema 与业务语义）、Client（呈现与交互约束）、Session（可重建事实）和工作流（步骤与补偿）。模型面不混入呈现词汇，呈现面不承担业务授权，两个声明面由同一个能力包维护。

### 能力单元之间的数据流

能力单元之间的连接不应只依赖模型重新描述上一 Tool 的自然语言结果。需要传递给下一步的业务对象、版本、权限范围和结构化字段，应通过带有稳定引用的 Session 或工作流状态传递；引用至少包含来源能力 id、对象 id 与版本，使下一步 Tool 能在服务端重新验证。模型可见文本负责解释和选择，不作为数据完整性的来源。

### 状态归属

| 状态 | 推荐所有者 |
|---|---|
| UI 草稿 | Client/Host；非持久，或显式草稿事件 |
| 已确认的用户选择 | Session 或工作流状态 |
| 业务执行状态 | 后端 Tool/工作流服务 |
| Agent 当前步骤 | Agent Loop / 工作流 |
| 可回放卡片 | Session 事件投影 |

不能用一个 React surface state 同时承担草稿、审批、业务提交和恢复状态；只有已确认并会影响后续模型或 Tool 的状态才进入对应的 Session 或工作流事实。

## 安全与可靠性

### 模型不能直接获得代码执行权限

模型输出的 UI 描述、Tool 参数和用户输入都必须视为不可信数据。renderer 只接受预批准的组件、属性和 action；业务 Tool 在执行前重新验证租户、身份、权限、业务状态、幂等键和副作用范围。

MCP Apps 的 sandbox iframe、A2UI 的 catalog 和 DSH 的 Tool approval seam 都体现了同一原则：模型可以提出选择，宿主和执行端决定是否允许。

### 受限 catalog 不拥有业务副作用

受限 UI catalog 只负责声明式呈现和收集输入，不直接执行业务副作用。每个会改变业务状态的 action 必须解析为已注册能力单元的 Tool call，重新经过权限、审批、业务状态、幂等和结果记录流程。catalog 适合摘要、比较、解释和轻量选择，不应成为事务写入或高风险操作的旁路。

### UI action 必须有明确身份和权限

按钮、选择器和表单提交不应只产生一个前端回调。每个会影响 Agent 或业务状态的 action 都应带有稳定 action id、关联的 Tool call 或能力单元 id、Session 身份、授权上下文和可重建的参数摘要。

UI 只能提示用户确认，不能代替服务端授权。高风险动作需要独立的 approval 语义，不能仅靠隐藏按钮、页面路由或模型提示词限制。

### 权限分层

能力发现权限、对象读取权限、字段展示权限、提交权限和批准权限不是同一项权限。UI 可以在没有提交权限时展示只读结果；Agent 可以知道某个能力存在，但不能因此获得执行授权；最终 Tool 服务端必须按照当前请求主体和业务状态重新验证。

### 不可信内容与注入

能力单元的业务数据、Tool result、网页内容和用户自定义文本不能自动获得系统提示或 Tool policy 的优先级。后续模型请求应区分系统规则、能力 descriptor、Tool result、用户输入和外部数据的来源；UI 显示层可以渲染不可信内容，但不能因为内容中出现指令文本就改变权限、审批或 Tool 选择约束。

### 进入模型请求的内容必须能从日志重建

DSH 的规则是：进入模型请求的内容必须能从 Session 日志重建，新的模型可见输入需要对应的 Session 事件。任何进入后续模型请求的用户输入、UI action、业务选择或 Tool 结果都必须满足这条规则。

未提交的输入草稿、焦点、展开状态和临时动画不必进入 Session；如果 Agent 会依据它们继续执行，就必须在提交点形成明确事件，并区分草稿、确认、执行和结果。

### 不应自动重试未知副作用

网络断线、页面关闭、Worker 终止或云端 handoff 可能使 Tool 的副作用结果处于未知状态。Agent 不应仅因为没有收到结果就自动再次执行；应查询操作状态、要求人工对账或将结果标记为未知。

## 实施路线

本节的阶段 A–D 与样板均为建议目标，不是当前已实现的 DSH 结构。

### 阶段 A：强绑定 Tool UI 垂直样板

选择一个有多步状态和明确审批的业务域，例如发布审批、工单 triage、采购审批或合同审阅，定义 3–5 个能力单元。

每个能力单元共同提供 Tool schema、业务视图、pending/result/error/approval 状态、权限判断和 Session 事件。先复用 `tool.call.toolview`、`ask_user_question` 和现有 Conversation Node，不引入通用 UI 生成器。

验收分两层：第一层使用确定性模型或 scripted Agent，验证能力单元选择结果、Tool 参数、UI action、Session event、Tool result、失败和恢复都能按预期发生；第二层接入真实模型，验证自然语言到能力单元选择的准确性、误选行为、参数预填和拒绝路径。两层都要求刷新后已提交调用和结果仍可重建。

### 阶段 B：能力单元编排声明

为 Agent 编排增加并行于模型 Tool schema 的能力 descriptor，内容可以包括能力用途、前置状态、只读或写入性质、破坏性、需要的用户确认、输入依赖、输出引用和可继续动作。

descriptor 应区分四种可用性：不可发现、可发现但不可执行、可执行但需要补充输入、可执行但需要独立审批。在能力已知不可用时，应由 Agent 或 Host 先呈现原因和可行替代路径，而不是依赖 Tool 调用失败后再显示错误。

该描述不应把 UI 词汇混入模型面向的 Tool schema。模型需要业务语义和操作约束，Client 需要呈现和交互约束；两者由同一个能力包共同维护，但通过不同声明面提供。

验收应包括：Agent 不能在缺少前置状态或权限时选择能力；同一个能力单元可以在不同模型和 Host 上使用；descriptor 版本变化不会让旧 Session 无法解释已提交调用。

### 阶段 C：受限 UI catalog 作为补充机制

为只读摘要、对比、解释和轻量输入增加受限 `UiSurface` 或等价 catalog。catalog 只包含宿主已经实现并批准的组件、属性和 action；Tool 或 Agent 只能引用 catalog，不得传输任意 HTML/JavaScript。

catalog 只负责呈现和收集输入，不执行业务副作用；每个改变业务状态的 action 都解析为已注册能力单元的 Tool call，重新经过权限、审批、幂等和结果记录。

`UiSurface` 必须明确持久化策略：把完整 surface 描述写入 Session，或只写入能力 id、版本、数据引用和已提交 action、由当前 renderer 重新派生。两种模式都需要定义 catalog 版本不兼容、surface 重连和旧 Session 回放失败时的降级显示。

验收应包括：非法组件和属性在渲染前被拒绝；action 与 Tool 或能力单元身份关联；surface 删除、更新和重连有明确事件；动态 UI 不会绕过 Tool approval 和服务端权限检查。

### 阶段 D：工作流和浏览器原生运行

把多步流程建模为可观察的状态机或 Flow（工作流的一种具体运行时形态；不引入 Flow 时也可以由 Agent Loop 直接串联），明确每个步骤的 owner、输入、输出、暂停点、取消语义、重试策略、幂等键和补偿动作。UI 是状态投影，不隐式承担跨步骤副作用。

在 Dedicated Worker 中运行 Agent Loop 和 UI bridge，模型请求可以经由同域代理或远程服务，浏览器工具与云端工具通过同一能力声明和执行语义区分提供者。

浏览器原生验收应分别验证浏览器停止消费、代理传播取消、上游连接终止、Tool 副作用未知、Session flush 失败和页面退出后的恢复，不以单次 UI 展示替代执行闭环验证。

### 建议样板：发布审批

用户提出“把 v1.8 发布到灰度，先检查变更和风险”。Agent 选择 `release.inspect`，在消息流中呈现变更摘要和风险表；随后唤出 `release.select_scope` 的环境和比例选择 surface；再调用 `release.request_approval`；用户确认后调用 `release.start_canary`；同一条任务记录继续展示进度、失败、回滚或需要人工处理的状态。

这个样板验证的重点不是卡片是否具有通用性，而是每个 UI action 是否能关联到稳定的能力单元和 Session 事实，Agent 是否能在用户修改选择后正确重新参数化下一步，副作用不明时是否避免重复执行。

## 开放问题

- 能力单元的 Tool、主 UI、工作流和呈现 descriptor 是否应由一个 package 提供，还是由多个插件通过稳定 registry 组合；拆分条件应以角色是否独立演化为准。
- 能力 descriptor 如何同时服务模型选择、权限预检、UI 路由和产品可观测性，而不把 Client 细节泄漏到模型提示词。
- UI action、Tool call、approval、workflow step 和 Session event 之间使用哪些稳定 id，如何支持旧版本 Session 回放。
- 能力 descriptor 的四种可用性（不可发现、可发现但不可执行、需补充输入、需独立审批）分别由哪个组件判定和呈现。
- `UiSurface` 的持久化策略选择：完整 surface 描述入库，还是只入库能力引用与已提交 action；catalog 版本不兼容时的降级由谁承担。
- Agent 如何在多个候选能力单元语义相近时选择正确单元，是否需要显式前置状态、拒绝条件和示例，而不能只依赖自然语言描述。
- Worker 内 OPFS 或云端 Session 的写入确认如何与 Agent loop 的 checkpoint policy 对齐。
- 浏览器执行和云端持续执行之间如何交接已提交状态，如何隔离旧 owner，如何处理正在进行的模型流、Tool Promise 和审批等待。
- 第三方能力包是否允许在浏览器中加载，如何验证签名、版本、依赖闭包、资源上限和租户隔离。
- 哪些业务操作仍应保留传统页面，因为它们需要高频重复输入、密集比较或对空间布局有强依赖。

## 结论

Agent 在对话中选择业务功能、唤起与该功能强绑定的 UI、收集用户输入并串联后续操作，在调研时点已经具备可验证的技术路径，也已由多个生态项目分别实践。

“UI 与业务能力完全解耦后由模型自由生成”不是生产业务 UI 的主航道。更可靠的方向是本文的架构原则：能力单元在设计上强绑定，UI 与执行在传输上分离；能力所有者共同维护 Tool、UI、状态、权限和工作流，Agent 在这些能力单元之间进行选择、预填、串联和恢复，Host 负责安全渲染，Session 负责记录可重建事实。

DSH 当前的 Tool 呈现、事件源 Session、Conversation Node、按 Tool 名注册的 UI slot、结构化问答 seam 和浏览器 Worker runtime 已经支持这一架构的核心部分。下一步不应从通用页面生成器开始，而应从一个强绑定能力单元组成的垂直流程开始，再根据只读组合和跨 Host 需求增加受限 UI catalog 或受信嵌入式 widget。

这个方向的革命性不在于把现有页面缩小后放进消息泡，而在于把用户目标、业务能力、界面输入、权限、执行状态和工作流恢复统一到同一个 Agent 可编排的任务记录中。

## Further Exploration

### 协议和规范

- [A2UI](https://a2ui.org/) — Google 的 Agent-to-UI 项目、版本状态和概念说明。
- [A2UI v0.9.1 specification](https://a2ui.org/specification/v0.9.1-a2ui/) — surface、组件、数据绑定和 action 消息。
- [A2UI ecosystem comparison](https://a2ui.org/introduction/agent-ui-ecosystem/) — A2UI、MCP Apps、AG-UI 和 A2A 的定位关系。
- [MCP Apps SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) — Tool 关联 UI resource、sandbox 和 Host 通信。
- [AG-UI overview](https://docs.ag-ui.com/introduction) — Agent 与用户应用的事件协议。
- [AG-UI and Generative UI specs](https://docs.ag-ui.com/concepts/generative-ui-specs) — AG-UI 与 A2UI、MCP-UI、Open-JSON-UI 的关系。

### 应用框架

- [CopilotKit A2UI](https://docs.copilotkit.ai/generative-ui/a2ui) — React、fixed schema、dynamic schema 和 A2UI 集成。
- [CopilotKit on AgentCore](https://www.copilotkit.ai/blog/generative-ui-on-agentcore-with-copilotkit) — AG-UI、图表、共享状态和 Human-in-the-loop 示例。
- [Vercel AI SDK: rendering UI with language models](https://github.com/vercel/ai/blob/c3c189c0/content/docs/06-advanced/07-rendering-ui-with-language-models.mdx) — Tool result 到 React UI 的实现模式；链接固定到调研时的文档版本。
- [Vercel AI SDK MCP Apps](https://vercel.com/kb/guide/ai-sdk-mcp-apps) — 将 MCP Apps 接入 AI SDK 应用的 Host 模式。
- [assistant-ui Generative UI](https://www.assistant-ui.com/docs/tools/generative-ui) — `present` Tool 和组件词汇组合。
- [CrewAI Generative UI](https://docs.crewai.com/v1.15.22/en/guides/frontend/generative-ui) — Agentic UI、Tool-based UI 和 Flow 集成；版本号链接用于固定调研证据。
- [OpenAI Apps SDK reference](https://developers.openai.com/apps-sdk/reference) — OpenAI Apps SDK 的 Tool 与 widget 资料；调研时部分页面返回 403，未逐行核验。
- [OpenAI Apps SDK: build ChatGPT UI](https://developers.openai.com/apps-sdk/build/chatgpt-ui) — ChatGPT 宿主中的组件构建资料；证据边界同上。

### 宿主 UI 体系

- [Adaptive Cards overview](https://learn.microsoft.com/en-us/microsoft-copilot-studio/adaptive-cards-overview) — JSON 卡片、输入和动作。
- [Slack Block Kit agent experiences](https://slack.dev/build-richer-agent-experiences-with-block-kit/) — 消息宿主中的 Agent 结构化 UI。

### DSH 代码与架构

- [DSH architecture](../architecture.md) — Cordis 插件组合、Agent Loop、Session 和能力扩展点。
- [DSH tools subsystem](../subsystems/tools.md) — Tool schema、执行流水线和 presentation 类型。
- [DSH tools package](../../packages/core/tools/README.md) — presentCall/presentResult 与 Client 派生卡片的 transport 拆分。
- [DSH Web Client architecture](../subsystems/web-client.md) — Client、Host、Session 投影和 UI 责任划分。
- [DSH conversation subsystem](../subsystems/conversation.md) — Conversation Node、事件折叠和回放。
- [DSH user-questions subsystem](../subsystems/user-questions.md) — 提问 seam 与应答方 waterfall。
- [DSH WebWorker runtime](../../packages/experimental/webworker-runtime/README.md) — Dedicated Worker、VFS 镜像和浏览器兼容层。
- [DSH client Tool UI](../../packages/client/ui-tool/README.md) — Tool 调用树、keyed slot 和内置卡片。
- [DSH client question UI](../../packages/client/ui-user-questions/README.md) — composer takeover、plan-review 卡片和草稿持久边界。
- [DSH ask-user tool](../../packages/interaction/tool-ask-user/README.md) — 结构化问题、答案和取消语义。

-----

## Dev Note

本文是 Agentic UI 架构调研与建议稿。其中“目标能力单元模型”“实施路线”和“安全与可靠性”中的部分条目为建议目标，不代表 DSH 已经实现通用动态 UI、能力 descriptor、受限 catalog、业务能力 marketplace 或浏览器跨刷新持久化；外部生态结论限于调研时点与已覆盖资料。当前实现、配置和限制由对应 package README、架构文档、Session 格式文档和测试维护；若采用本文建议，应分别为能力单元声明、UI catalog、编排事件和 Browser runtime 建立正式决策记录与验收测试。
