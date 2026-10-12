---
description: "对共享 ChatGPT 对话中的 Agentic UI 方案逐项做事实核查，结合 DeepSeek Harness 当前 checkout 的代码考古，评估既有 SaaS GUI 在 DSH Chat UI 中复用的拓扑、职责、安全边界与最小落地闭环。"
---

# DSH Agentic UI：共享对话事实核查、代码考古与 SaaS 落地方案

## Summary

本文核查共享对话 `https://chatgpt.com/share/6acb63a5-9554-83ea-a2f5-c5c6da6b7f29` 中关于 Agentic UI、OpenAI Apps SDK、A2UI、MCP Apps、AG-UI、CopilotKit 和 DeepSeek Harness 的断言，并把结论映射到 DSH 当前 `research` checkout 的源码、文档、测试和 Git 历史。

核心判断是：既有 SaaS 可以把 Agent 作为新的任务编排入口，把经过批准的业务 UI 带入 Chat UI，但 DSH 当前提供的是 Tool 执行、事件回放、Tool view 和 Conversation Node 扩展点，不是一套现成的 CRM Agentic UI 协议。

第一阶段应验证一条强绑定闭环：`自然语言 → 业务 Tool → 既有表单 → 原有 SaaS API → 权威结果 → Agent 继续处理`，而不是先建设任意 UI 生成器、DOM 自动点击器或未隔离的多租户 DSH 公网服务。

## Table of Contents

- [研究对象与证据边界](#研究对象与证据边界)
- [共享对话断言逐项核验](#共享对话断言逐项核验)
- [外部生态的职责分层](#外部生态的职责分层)
- [DSH 代码考古](#dsh-代码考古)
- [DSH 当前能力与明确缺口](#dsh-当前能力与明确缺口)
- [推荐集成拓扑](#推荐集成拓扑)
- [能力单元与状态归属](#能力单元与状态归属)
- [最小垂直样板](#最小垂直样板)
- [安全、租户与恢复](#安全租户与恢复)
- [实施路线与验收](#实施路线与验收)
- [结论](#结论)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

## 研究对象与证据边界

### 研究输入

共享页面在浏览器中显示的标题是“调研 Agentic UI 进展”，内容由两段连续对话组成：前半段讨论 Intelligent UI、CRM、CopilotKit、AG-UI、MCP Apps 和 A2UI，后半段把目标收敛为“用 DeepSeek Harness 作为 Agent 底座，把已有 SaaS GUI 带进 Chat UI”。

直接使用 `curl` 读取共享页面时连接被远端重置；随后使用真实无头浏览器加载页面，页面返回 HTTP 200，并从浏览器渲染结果提取正文。抓取过程的临时证据保存在 `/tmp/chatgpt-share.body.txt`、`/tmp/chatgpt-share.html`、`/tmp/chatgpt-share.responses.json` 和 `/tmp/chatgpt-share.png`，这些文件不是本报告的持久证据源。

本报告的外部事实以 2026 年 10 月 11 日可访问的官方页面、规范或项目源码为准；外部项目的版本和页面状态可能继续变化，链接只表示本次核查入口。

本报告的 DSH 事实针对当前本地 `research` checkout，其代码基线日期为 2026 年 10 月 6 日；本地 `upstream/master` 已包含更晚提交，因此本文不把 upstream 的后续变化隐含为当前 checkout 的能力。

### 术语约定

| 术语 | 本文含义 |
|---|---|
| Agent-mediated UI reuse | Agent 根据目标和上下文选择既有业务 UI，在对话内呈现并等待用户操作；它不是任意 HTML/JavaScript 生成。 |
| 能力单元 | 由同一业务所有者共同维护的 Tool、主 UI、输入映射、权限、生命周期、结果引用和恢复语义。 |
| UI surface | 能力单元在宿主中的一次可见实例，可以是消息内卡片、展开面板、侧栏或受信 widget。 |
| Tool | 模型可调用的业务操作或查询；“打开界面”的 Tool 与“提交业务命令”的 Tool 可以不同。 |
| Host | 拥有权威状态、业务 API、Session 和 Agent Runtime 的服务或进程。 |
| Client | 浏览器中的 DSH Web Client 或 SaaS 自己的 Chat UI。 |

### 证据等级

| 标记 | 证据来源 |
|---|---|
| 共享对话原文 | 从共享页面正文逐项抄录并核查的主张，正文用“共享对话称”指代。 |
| 外部事实 | 官方规范、官方开发者文档或被核查项目的官方源码。 |
| DSH 当前实现 | 当前 checkout 的源码、README、架构文档、测试和实际 Git 历史。 |
| 设计判断 | 根据上述证据得出的推荐，不应误读为 DSH 已实现的接口。 |

-----

## 共享对话断言逐项核验

### 总体核验结论

共享对话对目标产品形态的理解是正确的：重点不是让模型临时画一个 CRM，也不是让浏览器 Agent 通过 DOM 代替用户点击，而是让 Agent 成为既有 SaaS 的新入口，并在同一任务记录中选择、预填、呈现和串联既有业务能力。

共享对话对外部生态的方向判断大体正确，但有两处需要明确修正：第一，不能把 OpenAI widget 的交互状态与 CRM 权威数据持久化混为一谈，也不能把“状态不跨聊天保留”写成绝对规则；第二，DSH 的 `tool.call.toolview` 和 `ConversationNodeDefinition` 是扩展点，不是已经完成的 CRM Agentic UI 协议，尤其没有自动提供表单提交、业务事务或 Agent continuation。

### 断言核验表

| 共享对话断言 | 结论 | 核验与修正 | 对 DSH 方案的影响 |
|---|---|---|---|
| Intelligent UI 可以创建可交互小工具，但不是自动创建完整 CRM 后端的平台 | 基本正确 | 这是合理的产品边界判断，但 `Intelligent UI` 不是一个足以定义实现边界的稳定协议名；完整 CRM 仍需要开发者拥有的业务服务、鉴权、数据模型、事务和审计。 | DSH 方案必须把 SaaS 后端视为权威业务系统，不把 Chat UI 当数据库。 |
| 交互状态刷新后可能保留，但不会跨聊天保留 | 过于绝对 | 当前 OpenAI Apps/Plugins 文档已提供 widget-scoped persistence、`ui/update-model-context` 和服务端保存状态的机制；这些能力不等于自动跨租户保存 CRM 数据，但足以否定“一律不能跨聊天”的表述。 | 报告应区分 widget 草稿、Session 事实和 CRM 业务数据三种状态。 |
| Apps SDK + MCP + 自己的后端可以做长期使用的 CRM | 正确 | Apps SDK/MCP 负责 Host 与 Tool/widget 的连接，开发者仍要实现应用逻辑、后端授权和持久化。 | 该模式与“既有 SaaS API 继续负责业务”一致。 |
| CopilotKit Components as Tools 可把既有 React 组件带入聊天 | 正确但不完整 | 官方 `useComponent` 文档支持注册 React 组件和 props；基础组件呈现本身不自动完成提交处理、业务授权、事务或服务端写入。`useFrontendTool` 解决的是前端工具和状态协作，不替代后端权限。 | React SaaS 可把它作为参考；DSH 仍需自己实现 Client slot 和业务 action seam。 |
| 旧页面可用 iframe、Web Component 或微前端嵌入 | 作为集成策略成立 | 它解决的是交付和隔离，不会自动解决 Cookie、跨域、尺寸、路由、全局 Context、弹窗、下载和回调通信。MCP Apps 的 sandbox iframe 也是受控 widget，不是任意页面无改动嵌入的保证。 | 复杂旧模块可先嵌入，但应把嵌入层当过渡或受信 widget，而非第一阶段所有 UI 的默认形态。 |
| A2UI 用声明式结构和宿主 catalog 生成 UI | 正确 | 官方页面当前仍将 v0.9.1 标为 Current/Production，将 v1.0 标为 Candidate；规范包含 `createSurface`、`updateComponents`、`updateDataModel` 和 `deleteSurface` 等消息。共享对话中的版本判断在本次核查时点仍成立。 | A2UI 可以作为受限声明式 catalog 的后续研究方向，但不会把已有 React/Vue 页面自动转换成 A2UI 组件。 |
| AG-UI 是 Agent 与前端的事件协议，不是完整 UI 组件协议 | 正确 | AG-UI 负责运行、Tool call、状态、流式输出、中断和人机协作等事件；它不替代业务组件目录或后端事务语义。 | DSH 若需要跨 Runtime 的事件协议，可借鉴其分层，但不应把它当 CRM renderer。 |
| MCP Apps 是 Tool 关联的交互式 UI | 正确 | 当前 MCP Apps 文档把 Tool 与 `ui://` resource 关联，Host 在沙箱 iframe 中加载 widget，widget 通过受控消息与 Host/Tool 通信；规范已进入稳定扩展文档。 | 适合未来把 SaaS 能力交付到外部 MCP Host，不是 DSH 内部组件复用的必要前提。 |
| `dsh-frontend-tools` 已经很接近目标 | 部分正确 | 官方仓库 `lukaiwuyi/dsh-frontend-tools` 通过 loopback WebSocket 将 Web/Electron/Tauri/Node 应用的前端函数注册为 DSH Tool，并把调用转回原应用；它证明“Agent 调用既有应用能力”可行，但没有证明“既有 GUI 组件直接渲染进 DSH Chat transcript”。 | 它是前端能力桥接参考，不是目标 Agent-mediated UI reuse 的完整实现。 |
| DSH 的 `tool.call.toolview` 可把业务组件显示在工具调用卡片中 | 正确但共享示例不准确 | 当前 slot 按 wire Tool name keyed dispatch，renderer 收到 `preparing`、`start`、`result` 三种 phase 和阶段化 `block`，不是示例中的简化 `{ block }` API。 | 可以从一个自定义 Tool view 开始，但表单提交和 Agent continuation 仍需另行设计。 |
| `ConversationNodeDefinition + conversation.chat.node` 可呈现持续业务节点 | 扩展能力成立 | `ConversationNodeDefinition` 把事件匹配、状态折叠、Location 数据和最终 Node 投影分开；`conversation.chat.node` 再按 kind 选择 renderer。它不自动声明业务事件、不调用 SaaS API，也不替代权限或工作流。 | 复杂、跨轮次、可回放的业务 UI 才应升级为 Chat Node。 |
| DSH 可以直接嵌入任意 SaaS | 不应这样表述 | DSH Web Client 是由 `dsh.client`、`./client` bundle、Host boot graph 和构建产物组成的插件应用；代码库没有“把任意 SaaS 现有 React tree 原封不动装入 DSH”的通用保证。 | 需要选择“DSH Web 为壳”或“SaaS 为壳、DSH Runtime 为后端”两种拓扑之一。 |
| 默认 DSH Web 可直接作为多租户公网 Agent 服务 | 错误且危险 | `SAFETY.md` 明确 DSH 是未经安全审计的 developer preview，可能执行模型生成代码和命令、加载插件并访问被授予的资源；沙箱和审批不等于生产隔离。 | 必须裁剪 Tool profile、绑定可信租户上下文并单独完成隔离和威胁建模。 |

### 核验后的产品命题

正确的产品命题不是“在聊天中生成一个 CRM”，而是“在既有 SaaS 的权威业务能力之上，增加一个由 Agent 编排的任务入口”。

正确的技术命题也不是“把页面塞进气泡”，而是“让一个能力单元同时拥有 Tool 语义、主 UI、输入映射、权限、生命周期、审计和恢复规则，再让 Agent 选择该能力单元”。

-----

## 外部生态的职责分层

### 不是同一类技术

| 方案 | 主要解决的问题 | 不应替代的职责 | 与 DSH 的关系 |
|---|---|---|---|
| CopilotKit Components as Tools | React 组件注册、组件 props、聊天内呈现和前端工具协作 | 业务数据库、后端授权、跨租户隔离、事务和审计 | 可作为 React 组件复用的交互参考；不直接成为 DSH API。 |
| MCP Apps | Tool 关联 widget resource、sandbox iframe、Host/widget 消息通信 | 业务工作流、租户身份和数据库事务 | 适合跨 Host 分发受信业务 widget。 |
| OpenAI Apps/Plugins SDK | 在 ChatGPT Host 中接入 MCP Tool、widget 和 widget-scoped context/state | SaaS 的权威业务数据和产品级权限模型 | 可验证“聊天作为应用 Host”的产品形态，但不是 DSH 的运行时实现。 |
| AG-UI | Agent 与前端之间的流式事件、Tool call、状态和中断 | UI 组件 catalog、业务命令和持久化 | 可借鉴事件分层；DSH Session 仍是自己的回放来源。 |
| A2UI | 通过宿主已实现的 catalog 声明式创建和更新 surface | 既有页面自动迁移、业务授权和事务 | 可作为低副作用、受限 catalog 的候选协议。 |
| dsh-frontend-tools | 让现有应用的前端函数成为 DSH Tool | 直接把既有 GUI 渲染进 DSH transcript | 最接近 DSH 生态的能力桥接样例，但方向是“调用应用能力”。 |

### 对既有 SaaS 的选择原则

如果既有 SaaS 使用 React，并且表单、表格、选择器已经脱离页面路由和全局 Context，优先采用共享组件或共享浏览器安全 package。

如果既有 SaaS 是耦合严重的 React SPA、Vue、Angular 或老旧多页模块，先考虑 Web Component、微前端或 sandbox widget，把大模块作为过渡；不要为了验证 Agentic UI 先重写整个前端。

如果业务是只读摘要、比较、解释或低副作用探索，受限 catalog 或 A2UI 式声明式 surface 可以降低适配成本；如果业务是合同、审批、删除、批量写入或高价值交易，使用能力所有者预先绑定的固定 UI 和明确确认。

无论选择哪种 UI 复用方式，业务写入都应落到既有 SaaS API 或同一业务服务，而不是由 Agent 输出的 JSON、前端隐藏按钮或 DOM 操作决定授权。

-----

## DSH 代码考古

### 历史演进说明了什么

DSH 的相关代码不是一次性为 Agentic UI 设计的，但 Git 历史呈现出一条清晰的演进方向：先把 Tool 输出和呈现意图分开，再把 Tool UI 从会话壳中抽成 keyed plugin，随后建立事件到 Conversation Node 的通用折叠器，最后补足 Tool 的准备、开始和结算生命周期。

2026 年 7 月的 canonical typed tool outputs 变更引入了 `ToolOutputDefinition` 的 schema、model-facing render 和 replayable `presentationMeta`；这使 Tool 的业务结果、模型文本和持久呈现元数据有了不同声明面。

2026 年 8 月的 Tool presentation extraction 将 Tool 调用树和原子 Tool view 迁入 `ui-tool`，明确“业务包只注册 wire Tool 名和原子视图，Runtime 负责 call/result 配对和 root/subcall 拓扑”。

2026 年 8 月 9 日的 conversation node engine 和随后 target-owned snapshot 变更，把事件匹配、状态折叠、View target 和渲染器拆开；这正是后续业务 Chat Node 可以复用的基础，但它仍然是通用投影机制，不是 CRM 业务协议。

2026 年 8 月下旬的 raw-event tool-card 重构让 Tool 卡片从原始 Session 事件和结果元数据派生，而不是把一套独立 UI 状态当成第二个事实源。

2026 年 9 月的 preparing/start/result 生命周期变更又补上了流式准备阶段和派发后的明确状态，适合呈现“等待输入、执行中、成功、失败、停止”等能力单元生命周期。

这条历史路径的结论是：DSH 最适合承载“事件驱动的能力投影”，而不是承载模型任意生成和执行前端代码。

### 当前代码地图

| DSH 机制 | 当前证据 | 能做什么 | 不能从中推导什么 |
|---|---|---|---|
| Tool canonical output | `packages/core/tools/src/index.ts:212`、`:1831` | 用 schema 验证成功值，生成模型内容，并可为顶层结果生成 JSON `presentationMeta`。 | 不会生成 CRM 表单，也不会自动调用 SaaS API。 |
| Tool render intent | `packages/core/tools/src/index.ts:282`、`packages/core/tools/src/presentation.ts:1` | `presentCall`/`presentResult` 提供纯、可回放的 provider-neutral render intent。 | 它是呈现意图，不是业务 UI 执行器或用户提交通道。 |
| Session tool history | `docs/subsystems/session.md:102`、`:121` | `tool/call` 与 `tool/result` 通过 `callId` 配对；结果可携带 JSON `meta`，回放时复现呈现所需数据。 | 不会自动记录浏览器未提交草稿、焦点或任意 React state。 |
| Tool view slot | `packages/client/ui-tool/src/client/contract/slots.ts:14`、`:97` | 按 wire Tool name 注册自定义 renderer，处理 `preparing`、`start`、`result` 三个 phase。 | 不提供通用 `submitToAgent()`；当前 owner props 主要是身份、阶段 block、文件打开和 inspect 回调。 |
| Tool UI mounting | `packages/client/ui-tool/src/client/apply.ts:35` | 把 `tool-call` Chat Node 接到 Tool call tree，再把原子调用分发给 keyed Tool view。 | 不改变 Agent Loop，不自动建立业务 API 或事务。 |
| Chat Node slot | `packages/client/ui-chat/src/client/contract/slots.ts:151`、`:200` | 按 Chat Node kind 注册 renderer，可接收 turn data、disclosure 和 Host callback。 | 不负责定义事件、不负责把表单 action 写入 Session。 |
| Conversation definition | `packages/client/ui-conversation/src/client/contract/conversation.ts:195` | `match`、`start`、`update`、`buildLocationData` 和 `buildViewNode` 把事件折叠为可回放业务 Node。 | 不代表已经有一套 CRM Agentic UI descriptor。 |
| Definition registry | `packages/client/ui-conversation/src/client/conversation/event-registry.ts:4` | 业务插件以 effect-owned registry 注册和撤销 Definition。 | 不替代业务服务授权和工作流执行。 |
| Web Client ownership | `docs/subsystems/web-client.md:9` | Host 拥有权威状态、持久化、mutation ordering 和 access policy；Client 通过 Remote/服务回调呈现。 | 不保证 DSH 可以无改造地成为任意 SaaS 的外壳。 |
| Browser plugin graph | `packages/client/modules/README.md:28` | 通过 `dsh.client`、`./client` bundle 和构建产物加载 Web 插件，缺失 bundle 会在激活时失败。 | 不支持把网络返回的任意 UI 代码当作安全插件动态执行。 |
| Client layering | `packages/client/AGENTS.md:39`、`:149` | 组件只接收 typed props；跨 feature 共享 UI 应放入 `ui-primitives` 或独立浏览器安全包，并通过 Slots 组合。 | 业务插件不能直接 runtime-import 另一个 feature plugin 的内部组件。 |
| User question seam | `docs/subsystems/user-questions.md:5`、`:273` | 已有结构化用户提问、超时、答案回放和 root-agent 约束。 | 它不是任意业务表单 action 的通用协议；CRM 表单需要新的明确 seam 或复用其可表达范围。 |

### 关键边界：Tool view 不是业务执行层

共享对话中的示意组件 `CustomerFormToolView({ block })` 可以表达 UI 方向，但不能作为 DSH 当前 API 的可复制代码。实际 `ToolCallOwnerProps` 通过 slot runtime 提供 `callId`、`toolName`、阶段化 `block`、`openFile`、`inspect`、图片加载器和 disclosure 等能力；业务表单所需的认证上下文、API client、提交回调和 Agent continuation 都必须由新的业务插件显式提供。

同样，`ConversationNodeDefinition` 的 `buildViewNode` 只负责从已记录事件构造 Node；它不会替代 `ToolDefinition.execute`，也不会因为用户点击 React 按钮就自动生成 `tool/call`、业务审计事件或下一轮模型请求。

因此，第一阶段必须把“呈现界面”“提交业务命令”“把权威结果告知 Agent”当成三个不同的工程问题逐一打通，而不是把它们都藏在 renderer 里。

-----

## DSH 当前能力与明确缺口

### 已具备的基础

DSH 已具备足够开始 PoC 的连续链路：模型可以调用 Tool；Tool 可以返回结构化结果和持久化呈现元数据；Session 可以记录和回放 `tool/call`/`tool/result`；Conversation assembler 可以把事件折叠为 Chat Node；`ui-tool` 可以按 Tool 名挂载自定义视图；`ui-chat` 可以按 Node kind 挂载业务 renderer。

DSH 的插件体系也允许在不修改 agent-loop 的前提下共同注册 Host Tool、Session event projection、Conversation Definition 和 Client slot。该方向符合仓库“Plugins, not loop changes”和“Model-visible ⟺ logged”的架构规则。

### 仍然缺少的产品化能力

| 缺口 | 现状 | 必须补的设计 |
|---|---|---|
| 统一能力 descriptor | Tool schema、Tool presenter、Tool view、业务 API 和工作流彼此可关联但没有统一声明 | 定义能力 id、版本、主 UI、输入映射、权限、风险、生命周期、结果引用和恢复规则。 |
| UI action 到 Agent 的通道 | Tool view 当前没有通用业务提交或 continuation API | 定义带 session、surface、action、request id 和权限上下文的 Client→Host command seam，或明确采用 user-question/follow-up 模式。 |
| 业务事件 | DSH 有通用 Session/Conversation 机制，但没有 CRM 事件 | 声明 merge-extensible `customer/*` 事件，定义哪些 action 进入 Session、哪些只留在 Client 草稿。 |
| 权威业务状态 | Web Client 能呈现 Session，但 CRM 数据仍属于 SaaS 后端 | 让 Tool 和 UI 通过同一业务 API 读取和写入，避免把 DSH Session 当 CRM 数据库。 |
| 复杂跨轮次 UI | Chat Node 扩展点存在，但没有业务 Node | 仅为需要跨轮次、跨刷新或独立生命周期的流程增加 Definition 和 renderer。 |
| 旧前端复用 | DSH 不知道 SaaS 的路由、Context、状态管理和组件依赖 | 抽取共享 browser-safe package，或通过 Web Component/microfrontend/widget 适配。 |
| 多租户安全 | DSH 安全文件明确不承诺生产隔离 | 创建受限 profile、可信身份绑定、服务端授权和独立资源隔离，不暴露默认完整工具集。 |
| 浏览器/云端交接 | 当前 Web Client/Worker 运行能力不等于可恢复的业务工作流 | 定义 owner、checkpoint、取消、未知副作用和重新接管规则。 |

-----

## 推荐集成拓扑

### 拓扑 A：DSH Web 作为 Agent 工作区

```text
用户
  ↓
DSH Web Client（Chat、Tool view、Chat Node）
  ↓ Remote / Session / Agent Runtime
crm-agent-ui（DSH Host + Client plugin）
  ↓
既有 SaaS API（身份、权限、事务、数据库、审计）
```

该拓扑最接近共享对话的“在 DSH 已有 Web UI 基础上增加 Agentic UI”。`crm-agent-ui` 可以在 Host 侧注册业务 Tool，在 Client 侧注册 `tool.call.toolview` 或 `conversation.chat.node`，并把 SaaS 的共享组件或 widget 作为 renderer 的依赖。

它的优点是可以直接复用 DSH 的 Session、Agent Loop 和现有 Chat UI；代价是 SaaS 必须维护 DSH Web 的 profile、bundle、client package 和与登录态的集成，不能把“可加载插件”误认为“任意前端可嵌入”。

### 拓扑 B：SaaS 作为产品外壳，DSH 作为 Agent Runtime

```text
用户
  ↓
既有 SaaS Shell（既有路由、组件、登录态、租户上下文、Chat 区域）
  ↓ 受控 Agent/Session/Tool API
DSH Runtime（裁剪后的 profile 或独立服务）
  ↓
既有 SaaS API 和数据库
```

该拓扑保留 SaaS 原有的导航、设计系统、权限上下文和组件树，Chat UI 由 SaaS 自己承载；DSH 的 Tool、Session 和 Agent Runtime 通过服务接口接入。它通常更适合最终产品化，但需要 SaaS 自己承担 Chat transcript、事件订阅、Tool view 生命周期和浏览器恢复的集成成本。

### 选型建议

如果目标是尽快验证 DSH 的 Web UI 扩展机制，先做拓扑 A 的一个受限 profile 和 `crm-agent-ui`；如果目标是长期成为独立 SaaS 产品，应该从一开始保留拓扑 B 作为迁移方向，不要把 DSH 默认 Web profile 当作最终多租户外壳。

两种拓扑都必须遵守同一分工：DSH 负责编排和会话事实，SaaS 后端负责业务事实，Client 负责草稿与呈现，Agent 不拥有越权的租户或用户身份。

-----

## 能力单元与状态归属

### 能力单元的最小声明

建议每个业务能力单元至少拥有以下声明；这是一项新的产品设计，不是 DSH 当前已有的单一接口。

| 声明 | 作用 |
|---|---|
| `id`、版本和兼容范围 | 稳定识别 `customer.create`、`customer.search` 等能力，并支持旧 Session 回放。 |
| Model Tool | Tool name、描述、参数 schema、只读/写入性质和结果字段。 |
| Primary View | 既有 React component、Web Component、iframe/widget 或固定降级卡片。 |
| Input Binding | 哪些字段可由 Agent 预填，哪些字段必须用户确认，如何映射到业务命令。 |
| Authorization | 所需资源、租户、角色、审批等级和服务端重检条件。 |
| Lifecycle | `awaiting-input`、`approved`、`running`、`success`、`failure`、`cancelled`、`unknown` 等状态。 |
| Side Effects | 只读、写入、删除、外部通知、幂等键和不可重试动作。 |
| Output References | 后续能力引用的对象 id、版本、来源事件和权限范围。 |
| Recovery | 取消、重试、超时、未知结果、补偿和人工接管。 |
| Host Fallback | 不支持复杂 widget 时的只读摘要、链接或普通 Tool result。 |
| Presentation Version | renderer 更新后旧 Session 如何降级、迁移或显示历史快照。 |

### Tool、UI 和业务命令必须分开

`customer.open_create_surface` 可以是无副作用的呈现 Tool，参数包含允许预填的初始字段；`customer.create` 才是实际业务命令，负责服务端授权、校验、事务、幂等和审计。呈现表单不等于客户已经创建成功。

表单可以直接调用现有 SaaS API，也可以把用户确认后的结构化输入交给 Agent 再调用 `customer.create`；选择哪种方式取决于业务是否需要 Agent 在多个命令之间继续编排。无论采用哪种方式，最终授权和数据变更都必须由服务端完成。

### 状态所有者

| 状态 | 推荐所有者 | 是否进入 Session |
|---|---|---|
| 输入框草稿、焦点、展开状态 | Client/Host UI | 默认不进入；除非恢复需求明确要求持久化。 |
| 用户已确认的字段 | 业务 action 或 user interaction seam | 会影响模型/Tool 的字段必须形成可重建事件。 |
| 业务对象和事务结果 | SaaS 后端 | 业务数据库是权威来源；Session 只保留引用和对话证据。 |
| Agent 当前步骤和 Tool 结果 | DSH Agent Runtime/Session | 进入 DSH 事件流。 |
| 可回放的业务 Chat Node | Conversation Definition | 从事件和可信后端引用重新派生。 |

模型后续会看到的内容必须能够从 Session 日志重建。用户只在浏览器里填写但尚未提交的草稿可以留在 Client；一旦 Agent 要根据该草稿继续作出决定，就需要把确认后的结构化数据通过受控事件或用户消息送入模型上下文。

-----

## 最小垂直样板

### 推荐样板：`customer.create`

第一阶段只实现一个既有客户创建表单，不同时建设客户列表、详情页、动态 DSL、外部 Host 分发和复杂工作流。

```text
用户：帮我新增 ABC 公司，销售负责人先选张三。
  ↓
Agent 选择 customer.open_create_surface
  ↓
DSH tool.call.toolview 呈现既有 CustomerForm，预填允许的字段
  ↓
用户在表单内修改、校验并点击保存
  ↓
crm-agent-ui 通过既有 SaaS API 提交 customer.create
  ↓
SaaS 后端完成租户/用户授权、业务校验、事务、幂等和审计
  ↓
前端显示权威结果，并通过明确的 DSH interaction seam 送入后续 Agent 处理
  ↓
Agent 继续安排 followup.create，或结束任务
```

### 这个样板实际要验证的接口

1. Host 侧是否能在受限 profile 中注册 `customer.open_create_surface` 和 `customer.create`，并让 Tool schema 表达只读/写入和必要的输入字段。
2. Client 侧是否能在 `tool.call.toolview` 中按真实 phase props 渲染现有 `CustomerForm`，而不是依赖不稳定的工具卡片内部结构。
3. 既有 `CustomerForm` 是否能脱离页面级路由、全局 Context、固定布局和隐式导航，或是否需要抽取独立 browser-safe package。
4. 表单提交后，如何把 `requestId`、`sessionId`、`callId`、业务对象 id 和服务端结果绑定到 DSH 可回放事实；当前 Tool view slot 没有现成的通用业务 action continuation，需要新增或复用明确的 Client/Host seam。
5. API 返回超时或未知结果时，Agent 是否停止自动重试并进入人工查询/对账路径，而不是重复创建客户。
6. 刷新、重连、Session replay 和组件版本变化后，用户能否看到“已提交结果”“未提交草稿丢失”或“旧 renderer 不可用”等明确状态。

### `tool.call.toolview` 与 Chat Node 的选择

先使用 `tool.call.toolview`，当 UI 只依附于一个 Tool call、展示生命周期短、提交结果能由该 call 或后续明确 action 关联时，它的实现面最小。

当 UI 需要跨多个 Agent 轮次保持身份、在事件变化后独立更新、展示审批/执行/回滚状态，或者需要在 Chat transcript 中稳定回放时，再为业务事件注册 `ConversationNodeDefinition` 并增加 `conversation.chat.node` renderer。

不要为了“看起来更像应用”而一开始就创建 Chat Node；Node 会增加事件定义、状态折叠、版本回放、分组和测试责任。

-----

## 安全、租户与恢复

### 不执行模型生成的任意前端代码

Agent 只能选择由业务包注册的 `surfaceId` 或 Tool name，并传入经过 schema 校验的参数；Client 通过固定映射找到组件或 widget。禁止把模型返回的任意 HTML、JavaScript、模块 URL 或 React component name 直接执行。

A2UI catalog、MCP widget 和 Web Component 都只能扩大已批准的呈现词汇，不能扩大业务授权。每个 action 仍要映射到一个明确的业务命令和服务端权限检查。

### 不用 DOM 自动点击作为主架构

浏览器自动化可以作为旧系统的短期兼容手段，但不应替代正式业务 API。DOM 选择器、焦点、弹窗、异步加载和布局变化会让关键写入变成脆弱的页面自动化；自动点击也无法证明后端授权、事务提交和结果确认。

### 多租户最小权限

生产部署不能把默认 DSH Web profile 的 shell、文件系统、任意代码执行、网络访问、第三方插件加载和工作区能力全部暴露给 SaaS 用户。业务 profile 应只装所需 Tool，并对 Tool registry、Host API、Session storage、浏览器模块和外部 widget 分别做 allowlist。

租户 id、用户 id、角色和资源范围必须来自可信服务端 session 或签名上下文；模型参数中出现的 `tenantId`、`userId` 或资源 id 只能作为请求数据，不能作为授权依据。每个业务命令都要由 SaaS 后端重新确定调用者和租户。

### 审计和幂等

每个 UI action 至少应关联 `sessionId`、`callId`、能力版本、surface 实例 id、业务 request id、操作者、租户、服务端结果和审计记录。写入命令必须携带服务端生成或验证的幂等键；前端重复点击、网络重试和 Agent 重试不能产生重复业务对象。

若请求已经到达服务端但响应丢失，结果是“未知”，不是“失败”。Agent 应调用查询/对账能力或要求人工确认，不能因为 UI 仍显示提交按钮就自动再次创建。

### 回放与版本

Session 回放只能重建已提交事件和结果元数据，不能假定 React 内存 state、未提交表单或 PTC 中间绑定值存在。业务 Node 应保存足够的稳定引用和版本；renderer 不兼容旧事件时必须显示降级摘要或不可用原因，而不是把新版本字段静默解释成旧语义。

-----

## 实施路线与验收

### 阶段 0：盘点和边界

选择客户创建、客户搜索、联系人选择器、客户详情和跟进任务中的 3 至 5 个真实组件，记录它们对路由、Context、缓存、导航、权限和 API 的依赖。

同时固定 DSH checkout、profile 和 SaaS 登录态集成方式，明确哪些 DSH Tool 会保留、哪些 shell/filesystem/code 能力会移除；不要以默认 Web profile 的成功启动代替威胁建模。

### 阶段 1：一个 Tool view 闭环

实现 `crm-agent-ui` 的一个 Host Tool、一个 Client `tool.call.toolview`、一个既有 `CustomerForm`、一个真实 SaaS API 调用和一个可验证的 DSH continuation seam。

验收必须包含成功、字段校验失败、无权限、租户不匹配、取消、网络断开、重复提交、服务端超时、未知结果和页面刷新；每种情况都要有用户可见结果和可重建记录。

### 阶段 2：业务 Chat Node

只有当第一阶段证明 UI 需要跨轮次持续显示，才增加 `customer/*` 事件、`ConversationNodeDefinition`、`conversation.chat.node` renderer 和 replay snapshot。将事件到 Node 的规则写在业务包，不改 agent-loop。

### 阶段 3：复杂模块和受限 catalog

对无法拆分的旧模块增加 Web Component、microfrontend 或 MCP-style widget 适配；对只读摘要和轻量组合研究受限 catalog/A2UI。此阶段才评估 iframe 沙箱、跨 Host 交付和 catalog 版本治理。

### 阶段 4：工作流和云端/浏览器交接

将多步审批、批量变更或长期执行建模为明确的 workflow/Flow，定义每一步的 owner、checkpoint、取消、补偿、幂等和未知结果处理，再决定是否把 Agent Loop 或 UI bridge 放入 Dedicated Worker。

### 首阶段不建议建设

- 任意 HTML/JavaScript 生成和执行。
- 通过 DOM 自动点击传统 GUI 作为关键写入路径。
- 从 Tool JSON Schema 自动推导完整生产事务表单。
- 把 DSH 默认完整 profile 直接暴露为未隔离的多租户公网服务。
- 同时引入 A2UI、AG-UI、MCP Apps、CopilotKit 并把协议数量误当作产品闭环。

-----

## 结论

共享对话的核心方向成立：Agent 可以成为既有 SaaS 的另一种交互入口，在 Chat UI 中选择、预填、呈现并串联既有业务界面，同时继续使用原有 API、鉴权、事务、持久化和审计。

事实核查后的重要限定是：OpenAI widget state 不是 CRM 权威数据；CopilotKit Components as Tools 不是完整业务提交系统；A2UI 是受宿主 catalog 约束的声明式 UI，不会自动迁移旧页面；MCP Apps 是 Tool/widget 交付机制；AG-UI 是事件连接层；`dsh-frontend-tools` 是前端能力桥而不是 Chat UI renderer。

DSH 当前 checkout 已经提供实现这条路线的主要插槽：Tool 的纯呈现和 JSON `presentationMeta`、append-only Session、按 Tool 名的 `tool.call.toolview`、按 Node kind 的 `conversation.chat.node`、事件到 Node 的 `ConversationNodeDefinition`，以及可构建的 Web Client plugin graph。

DSH 当前没有提供的部分同样重要：通用业务 UI descriptor、表单 action 到 Agent 的 continuation 协议、CRM 业务事件、租户级安全隔离和任意 SaaS GUI 的自动嵌入。它们需要在 `crm-agent-ui` 或 SaaS 自己的集成层中明确设计和测试。

因此，最稳妥的第一步是：固定一个 DSH 版本和受限 profile，创建一个 `crm-agent-ui` 插件，只做 `customer.create` 的既有表单复用，接通真实 SaaS API、服务端授权、幂等、Session 关联和 Agent continuation；成功后再决定哪些能力升级为 Chat Node，哪些旧模块走 widget，哪些只读场景采用受限 catalog。

-----

## Further Exploration

### 共享对话

- [共享 ChatGPT 对话](https://chatgpt.com/share/6acb63a5-9554-83ea-a2f5-c5c6da6b7f29) — 本报告逐项核查的原始材料。

### 外部协议和框架

- [A2UI](https://a2ui.org/) — 官方概览、版本状态和组件 catalog。
- [A2UI v0.9.1 specification](https://a2ui.org/specification/v0.9.1-a2ui/) — surface、组件、数据绑定和 action 消息。
- [A2UI ecosystem](https://a2ui.org/introduction/agent-ui-ecosystem/) — A2UI、MCP Apps、AG-UI 和 A2A 的互补关系。
- [MCP Apps documentation](https://apps.extensions.modelcontextprotocol.io/) — Tool、`ui://` resource、sandbox widget 和 Host 集成。
- [MCP Apps SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) — MCP interactive UI 扩展提案和消息模型。
- [AG-UI introduction](https://docs.ag-ui.com/introduction) — Agent 与前端的事件协议。
- [AG-UI generative UI specs](https://docs.ag-ui.com/concepts/generative-ui-specs) — AG-UI 与 A2UI/MCP-UI 等 UI 描述机制的分层关系。
- [CopilotKit tool-based generative UI](https://docs.copilotkit.ai/generative-ui/tool-based) — React 组件作为工具的呈现模型。
- [CopilotKit tool rendering](https://docs.copilotkit.ai/generative-ui/tool-rendering) — Tool call 到自定义 UI 的渲染模型。
- [CopilotKit frontend tools](https://docs.copilotkit.ai/reference/hooks/useFrontendTool) — 前端工具和浏览器状态协作。
- [OpenAI Apps/Plugins SDK ChatGPT UI](https://developers.openai.com/plugins/build/chatgpt-ui) — 当前 OpenAI widget/ChatGPT Host 文档入口。
- [OpenAI Apps/Plugins SDK reference](https://developers.openai.com/plugins/reference) — Tool、widget context 和 Host 交互参考。
- [dsh-frontend-tools](https://github.com/lukaiwuyi/dsh-frontend-tools) — DSH loopback WebSocket 前端能力桥。

### DSH 当前代码和文档

- [DSH architecture](../architecture.md) — Cordis 插件、Agent Loop、Session 和应用入口。
- [Web Client architecture](../subsystems/web-client.md) — Host、Remote、Client model、Conversation 和 Slots 的职责。
- [Conversation assembly](../subsystems/conversation.md) — Event-to-Node、View target 和回放模型。
- [Sessions](../subsystems/session.md) — append-only event log、`tool/call`、`tool/result` 和 `meta`。
- [User Interaction](../subsystems/user-questions.md) — 结构化用户输入 seam 和 root-agent 约束。
- [Client Modules](../../packages/client/modules/README.md) — Web plugin manifest、bundle 和构建要求。
- [Client Tool UI](../../packages/client/ui-tool/README.md) — Tool call tree、keyed Tool view 和 lifecycle props。
- [DSH safety notice](../../SAFETY.md) — developer preview、权限和隔离限制。

-----

## Dev Note

本文是基于共享对话、外部官方资料和当前本地 checkout 的研究草稿，不是 DSH 已提交的产品设计或安全认证。能力单元 descriptor、业务 UI action seam、CRM 事件、租户隔离 profile 和 `crm-agent-ui` 都需要单独的设计、代码、测试、Session snapshot 和安全审查。

外部页面中的版本、产品名称和文档路径会继续变化；如果把本文建议推进为实现，应在开发开始时重新核查官方规范和当前目标 checkout，并把实际运行结果写入对应包 README、测试和升级指南。
