---
description: "调研 Agent Loop 与前端 Tools 驻留浏览器、通过同域代理调用 LLM 的架构，比较已有 Agent framework 与 Browser Native 先行实践，并结合 DSH 代码基础给出有边界的适用性判断、缺口清单与实施路线。"
---

# DSH 扩展 Browser Native Agent 执行模式：深度调研与架构评估

## Summary

本报告研究的问题不是“DSH 是否应该转型成一个 Browser Native Harness”，而是：在保持 DSH 作为 all-plugin Cordis Agent Harness 总体定位不变的前提下，是否应该把 Browser Native 增加为一种新的 Agent 执行方式。

这里的 Browser Native Agent 指 Agent Loop 驻留浏览器前端（优先运行于 Dedicated Web Worker）、与当前 Web App 相关的 Tools 由浏览器提供、Agent 可以直接获得当前应用的结构化 UI 状态和用户动作、LLM 请求通过同域代理发往模型供应商且密钥不进入浏览器、当前交互式工作流由浏览器 Agent Loop 主持；高风险副作用、秘密凭据和耐久任务仍可由后端执行，但这不改变 Agent Loop 默认驻留浏览器的事实。

调研结论是：该架构可行，而且已有直接先行实践。AG2B 已经实现了与上述拓扑高度等价的轻量级方案，ShadowClaw 和 peerd 分别证明了浏览器 Dedicated Worker Agent Loop、浏览器本地执行和扩展型 Agent Harness 的可行性。因此 DSH 既不是第一个想到这个方向的项目，也不是实现最小 Browser Native Agent 的最低成本方案，更不应被重新定位成“Browser Native Harness”；但把 Browser Native 增加为 DSH 的一种可选执行模式，是与既有架构方向一致的合理扩展。

DSH 的价值不在于重新发明一个轻量级浏览器 Agent，而在于复用已有的 Agent Loop、Tool 生命周期、Session 事件与持久化、审批与取消、UI Tool 投影、Cordis 插件体系，以及 Node、Headless、SDK、Browser 多运行位置。当前 DSH 已具备 Dedicated Worker Host 基础、真实 Agent Loop、完整 Tool 执行流水线、Tool call/result 事件、Session persistence 抽象、UI Tool renderer、Worker/page transport，以及 Session control/follow/reconnect 基础；尚未完成的是 Worker Agent Loop 通过同域代理调用 LLM、浏览器环境中的真实 `LLM → Tool → LLM` 闭环、通用 Typed UI State Bridge、Worker 重启后的浏览器持久化恢复，以及 Browser Loop 到后端 durable worker 的明确 handoff。

因此最终判断是：DSH 很适合扩展 Browser Native 执行模式，但目前只是“架构基础适合”，还不是“功能已经完整实现”。如果只想快速做出一个浏览器内 Agent，AG2B 更直接；如果想让同一套 DSH Agent、Tools、Session 和插件体系在 Browser、Node、Headless 等多个运行位置共享，扩展 DSH 更合理。

## Table of Contents

- [一、问题的原始含义](#一问题的原始含义)
- [二、Browser Native Agent 的严格定义](#二browser-native-agent-的严格定义)
- [三、必须区分的相邻概念](#三必须区分的相邻概念)
- [四、为什么这个架构有吸引力](#四为什么这个架构有吸引力)
- [五、推荐的 Browser Native 拓扑](#五推荐的-browser-native-拓扑)
- [六、Tool 的执行位置应该分层](#六tool-的执行位置应该分层)
- [七、现有框架与项目调研](#七现有框架与项目调研)
- [八、现有实践分类总结](#八现有实践分类总结)
- [九、DSH 当前代码基础审计](#九dsh-当前代码基础审计)
- [十、DSH 的关键缺口](#十dsh-的关键缺口)
- [十一、Session、UI 与 Workflow 设计建议](#十一sessionui-与-workflow-设计建议)
- [十二、Browser Native 与业务 UI 的关系](#十二browser-native-与业务-ui-的关系)
- [十三、DSH 的相对优势](#十三dsh-的相对优势)
- [十四、DSH 不应承担的目标](#十四dsh-不应承担的目标)
- [十五、推荐 DSH 支持的三种 Agent 拓扑](#十五推荐-dsh-支持的三种-agent-拓扑)
- [十六、推荐实施路线](#十六推荐实施路线)
- [十七、Browser Native 模式验收标准](#十七browser-native-模式验收标准)
- [十八、主要风险和反模式](#十八主要风险和反模式)
- [十九、关于这个想法是否独创的诚实评价](#十九关于这个想法是否独创的诚实评价)
- [二十、最终判断](#二十最终判断)
- [调研来源](#调研来源)

-----

## 一、问题的原始含义

最初的问题表面上是：Web Native Agent 是否应该让 Agent Loop 运行在浏览器前端，而不是后端？

但后续讨论明确了，目标不是“后端 Agent + 前端聊天 UI”：

```text
Browser UI
    ↓
Backend Agent Loop
    ↓
Backend Tools
    ↓
LLM
```

也不是“后端 Agent + 前端 Tool callback”：

```text
Backend Agent Loop
    ↓
Browser callback
    ↓
Frontend Tool
    ↓
Tool result
    ↓
Backend Agent Loop
```

更不是“Agent 操作外部网页”：

```text
Agent
    ↓
Playwright / DOM / Screenshot / Accessibility Tree
    ↓
操作其他网站
```

真正考虑的是业务 Web App 自身成为 Agent 的执行环境：

```text
业务 Web App
    ↓
Browser Native Agent Runtime
    ├── Agent Loop
    ├── 前端 Tools
    ├── UI state
    ├── 用户交互
    ├── workflow state
    └── Session projection
          ↓
      同域 LLM Proxy
          ↓
      LLM Provider
```

也就是说，目标是让 Web App 自己成为 Agent 的执行环境、Tool 提供者、UI 状态感知器和交互工作流主持者。

后续讨论中一个重要的概念修正是：DSH 的目标不是成为 Browser Native Harness，而仍然是 all-plugin Cordis Agent Harness。Browser Native 应该被理解为 DSH 的一种新增 Host、runtime target、deployment topology、execution profile 和 Agent Loop placement。理想结构是同一套 DSH Agent、Tool、Session 语义分别运行于 Node Host、Headless Host、Desktop Host、SDK/ACP Host 和 Browser Native Host。这意味着 DSH 不需要放弃 Server/Host Agent、Headless Agent、本地桌面 Agent、ACP 或后端 Durable Agent；Browser Native 是新增能力，不是替代所有既有能力。

## 二、Browser Native Agent 的严格定义

### 条件一：完整 Agent Loop 在浏览器

必须实际发生以下循环：

```text
LLM request
→ LLM returns tool calls
→ browser executes tools
→ tool results appended
→ next LLM request
→ continue until termination
```

如果这个循环由服务器控制，只是 Tool body 在浏览器执行，则不属于严格意义上的 Browser Native Agent Loop。

### 条件二：前端提供业务 Tools

前端 Tools 不只是通用浏览器能力，也可以是业务 Web App 的能力：读取当前选中的业务对象、查询当前 UI filter、打开业务面板、显示审批组件、读取表单草稿、改变当前页面状态、调用同源业务 API、获取用户输入、发起本地预览、触发前端 Store action。

### 条件三：模型通过同域代理调用

模型 API key 不应该进入浏览器 JavaScript、Worker memory、VFS、localStorage、IndexedDB、Session event、Tool result 或 UI payload。浏览器通过 `/api/llm` 调用同域代理，代理负责 provider credential、用户身份、租户身份、模型 allowlist、quota、token budget、provider routing、streaming、cancellation、provider error mapping 和审计字段。

### 条件四：Agent 能获得结构化 UI 状态

Agent 不应主要依赖 DOM 抓取。更合理的路径是：

```text
React/Vue/store/业务组件
        ↓
Typed UI State Adapter
        ↓
Agent-visible UI context/event
        ↓
Browser Agent Loop
```

例如 Agent 应看到：

```json
{
  "surface": "release.select_scope",
  "entity": {
    "type": "release",
    "id": "v1.8"
  },
  "environment": "staging",
  "percentage": 10,
  "dirty": true,
  "canSubmit": true,
  "requiresApproval": true
}
```

而不是让 Agent 自己从 `<div class="release-form">` 这样的 DOM 中推断业务含义。

### 条件五：浏览器主持当前交互工作流

例如用户提出目标、Agent 选择能力单元、前端展示能力单元 UI、用户填写或确认、Tool 执行、结果反馈、Agent 选择下一能力、结束或继续。高风险 Tool 可以由后端最终执行，但当前交互循环仍然由浏览器 Agent 主持。

## 三、必须区分的相邻概念

### Browser Native Agent 与 Browser-use Agent

Browser-use Agent 的典型结构是 Agent 在 Node、Python 或 Cloud 中运行，通过 Playwright、Browserbase 或 CDP 控制一个浏览器，读取 DOM、截图或 Accessibility Tree。它回答的是“Agent 如何操作别人构建的网页”，而本报告讨论的是“Web App 如何主动把自己的业务能力、UI 状态和交互流程提供给自己的 Agent”。两者可以组合，但不是同一问题。

### Browser Native Agent 与前端 Tools

前端 Tools 只说明 Tool implementation 在浏览器，不说明 Agent Loop 在浏览器。LangChain Headless Tools 就是典型例子：LangGraph Server 持有 Agent Loop、history 和 checkpoint，服务端产生 Tool call，浏览器执行前端 Tool 实现并把结果返回以恢复服务端 run。它移动了 Tool 的执行位置，但没有移动 Agent Loop 的所有权。

### Browser Native Agent 与本地模型

WebLLM、Chrome Built-in AI 和 WebGPU 模型解决“模型推理是否可以在浏览器运行”，Browser Native Agent 解决“Agent Loop、Tool orchestration、UI state 和 workflow 在哪里运行”。两者可以组合，但不是同一个维度：

```text
Browser Agent Loop
    ├── Remote LLM via same-origin proxy
    ├── WebLLM
    ├── Chrome Built-in AI
    ├── WebGPU model
    └── User-provided provider
```

### Browser Native Agent 与 Generative UI

A2UI、MCP Apps、AG-UI、CopilotKit 等解决 Agent 如何表达 UI、Tool 如何绑定 UI、UI 如何呈现 Tool result、Agent event 如何传给前端、前端如何执行交互。它们并不自动决定 Agent Loop 在浏览器还是服务器。

## 四、为什么这个架构有吸引力

### 减少服务器上的交互式 Agent 状态

Server-side Agent 往往需要持有 Session 内存、Agent Loop 状态、Tool context、流式连接、用户输入等待状态、并发调度、retry/cancel state、长任务 supervisor 和多租户资源。如果将大量短时交互式 Loop 放入浏览器，服务器可以从“每个活跃用户一个 Agent Runtime”收缩为 LLM Proxy、Domain API、Persistence/sync、High-risk side effects 和 Durable jobs。

它适合前台交互密集、高频 UI 状态变化、大量等待用户输入、每个用户的交互状态相互独立、需要低延迟 UI 编排的场景。但成本不会消失，而是重新分布。服务器仍然需要承担 LLM token 和推理成本、同域代理连接、业务 API、业务数据库、高风险 Tool、durable job、观察性和审计；客户端需要承担 Agent Loop CPU、内存、电池、网络、浏览器兼容性、Worker 生命周期和本地存储。准确说法是：Browser Native 可以减少服务器上的 per-session orchestration 成本，但不能消除模型和业务后端成本。

### 浏览器是有价值的沙箱，但不是业务授权系统

浏览器提供 Worker/Main Thread 隔离、同源策略、Origin、iframe sandbox、CSP、Web API permission、文件选择器、剪贴板权限和一定的 OS 隔离，这使浏览器适合运行低权限、交互密集的 Agent。但浏览器沙箱主要保护“页面与 Worker 到操作系统”的边界，不会自动限制 Agent 使用当前登录用户的业务权限去发邮件、删除数据、修改权限、发起付款或发布版本。

仍然需要防范 XSS、同源恶意脚本、第三方依赖供应链、Prompt Injection、恶意 Tool result、Tool 参数篡改、敏感 UI state 泄漏、浏览器扩展、UI bridge 伪造、任意 URL relay 和 Agent 过度授权。准确说法是：浏览器为 Agent 提供运行时隔离和本地能力授权边界，但不替代业务权限系统。

### Agent 直接观察 UI 状态

Server Agent 常常只能得到用户消息、前端主动提交的数据、Tool result 和手工序列化的 UI state，未必知道当前选中了哪个对象、当前打开哪个面板、表单是否 dirty、当前筛选条件、当前页面是否正在加载、当前组件是否因权限隐藏、用户刚刚执行了什么操作、当前 UI 是否处于错误状态。Browser Agent 可以通过 Typed UI Bridge 直接接收结构化事件并形成反馈回路：

```text
UI state changed
→ structured event
→ Agent chooses next capability
→ Tool/UI action
→ UI state changed
```

但不能把所有 UI state 都送给模型，建议按归属分层：

| 状态 | 默认归属 |
|---|---|
| 普通输入草稿 | Client-local |
| 已确认的业务选择 | Session/Workflow |
| Agent 当前步骤 | Browser Agent Loop |
| 业务执行状态 | Backend Tool/Workflow |
| 可回放 UI | Session projection |
| 长任务最终状态 | Durable backend |

### 更自然地支持 Agentic UI 和工作流

Browser Native 可以把用户动作、UI state event、Agent decision、next UI surface、user input、Tool call、result 和 next Agent step 放进一个浏览器内事件链，从而减少网络往返、UI transient state 序列化、前后端状态竞争、事件排序复杂度和交互等待时的服务器状态。

但 Browser Native 并不意味着 Agent 应任意生成核心业务 UI。更稳妥的原则是：业务能力与 UI 在设计上强绑定，UI 描述与执行在传输上分离。能力单元应共同设计 Tool schema、UI surface、输入校验、当前上下文、用户确认、side-effect risk、result renderer 和 recovery semantics。Agent 的主要价值是选择能力、预填参数、串联能力、解释结果、处理失败、继续或回滚，而不是自由生成核心交易、发布、删除和付款界面的全部语义。

## 五、推荐的 Browser Native 拓扑

```text
┌────────────────────────────────────────────────┐
│ Browser                                        │
│                                                │
│ Main Thread                                    │
│ ┌────────────────────────────────────────────┐ │
│ │ Business Web App                           │ │
│ │ React/Vue/DOM/store                        │ │
│ │ UI state providers                         │ │
│ │ UI action executors                        │ │
│ │ browser-local capabilities                 │ │
│ └───────────────────┬────────────────────────┘ │
│                     │ typed UI/tool bridge      │
│ Dedicated Worker   │                           │
│ ┌───────────────────▼────────────────────────┐ │
│ │ DSH Agent Loop                             │ │
│ │ Tool Registry                              │ │
│ │ Tool Pipeline                              │ │
│ │ Workflow State                             │ │
│ │ Session Projection                         │ │
│ │ Approval / Cancellation                    │ │
│ └───────────────────┬────────────────────────┘ │
│                     │ same-origin /api/llm      │
└─────────────────────┼──────────────────────────┘
                      │
          ┌───────────▼────────────┐
          │ Same-origin LLM Proxy  │
          │                        │
          │ auth                   │
          │ quota                  │
          │ model routing          │
          │ provider credentials   │
          │ streaming              │
          │ cancellation           │
          │ provider errors        │
          └───────────┬────────────┘
                      │
                 LLM Provider

          ┌────────────────────────┐
          │ Business Backend       │
          │ domain APIs            │
          │ authorization          │
          │ transactions           │
          │ durable jobs           │
          │ receipts               │
          │ compensation           │
          └────────────────────────┘
```

在这个拓扑里，Agent Loop 的交互控制权在浏览器，LLM key 只在代理或 Host，前端 Tool 可以操作本地 UI，后端仍负责业务授权，长任务可以从浏览器显式 handoff，DSH 仍然可以提供 Node、Headless 和 Server 模式。

## 六、Tool 的执行位置应该分层

“Tools 在前端提供”应理解为 Tool 的 Agent-facing schema、注册、上下文和调度由浏览器 Agent Runtime 掌管，而不是所有副作用都在浏览器完成。

### Browser-local Tool

适合读取当前 UI 状态、打开或关闭面板、获取当前选项、更新本地草稿、本地预览、文件选择器、剪贴板、UI surface 操作，以及其他不产生高风险副作用的前端动作。

### Browser-owned orchestration + server-backed execution

Agent Loop、Tool schema 和 Tool lifecycle 在浏览器，但实现调用后端 API。适合查询订单、查询项目、读取权限、查询发布状态、获取候选环境、风险计算和业务搜索。

### Server-authorized side-effect Tool

适合发布版本、删除数据、修改权限、创建订单、发起付款、调用秘密凭据、执行事务和不可重复副作用。必须具有服务端重新授权、参数重新校验、idempotency key、approval receipt、execution receipt、unknown outcome，以及必要时的补偿或对账。

### Durable/Background Tool

适合页面关闭后继续、数小时任务、retry/resume、scheduled jobs、多设备、多人协作和合规审计。这类 Tool 应显式 handoff：

```text
Browser Agent
→ checkpoint
→ durable job created
→ browser receives job handle
→ page can disconnect
→ client reconnects/follows
→ durable result enters Session
```

不要假装 Browser Worker 在页面关闭后仍然可靠执行。

## 七、现有框架与项目调研

### AG2B：最直接的同构参考

官方资料：[What is AG2B](https://ag2b.ai/docs/what-is-ag2b)、[Agent Runtime](https://ag2b.ai/docs/runtime)、[The Loop](https://ag2b.ai/docs/runtime/the-loop)、[Quickstart](https://ag2b.ai/docs)、[OpenAI Provider](https://ag2b.ai/docs/providers/openai)、[WebMCP Plugin](https://ag2b.ai/docs/plugins/webmcp)。

AG2B 的 Agent Runtime 明确负责 Provider、Scopes、history、lifecycle hooks、`chat()`、`chatStream()`、`maxIterations` 和 Tool-use loop。官方示例通过 `new OpenAiProvider({ baseURL: '/api/llm' })` 调用同域代理。其实际拓扑是：

```text
Browser Web App
    Agent
      Provider
      Scopes
      History
      Lifecycle
      maxIterations
        ↓
      frontend Tool
        ↓
      Tool result → history
        ↓
      next LLM iteration
        ↓
/api/llm same-origin proxy
```

AG2B 满足本报告的严格定义：Loop 在浏览器、Tools 在前端、Tool result 触发下一轮、Provider 通过同域 proxy、Web App 可以直接接入自己的 Store、DOM 或 action。它是目前已经核实、与目标拓扑最直接等价的实现。它的限制是更像轻量级 Client Agent Runtime，没有 DSH 已有的完整 Node Tool、shell、subprocess、Session durability 和多 Host 体系，页面关闭、离线、权限和浏览器生命周期仍需应用自行处理，Tool handler 运行在客户端也意味着业务安全不能只依赖客户端。

对 DSH 的意义是：不需要再证明 Browser Native Loop 是否可行，AG2B 已经给出了最小参考实现；问题变成如何复用现有 DSH 语义，而不是重新发明最小 Loop。

### ShadowClaw：真正的 Worker Loop，但定位不同

官方资料：[ShadowClaw Repository](https://github.com/xt-ml/shadow-claw)、[Worker Protocol](https://github.com/xt-ml/shadow-claw/blob/95df1b02/docs/architecture/worker-protocol.md)。

ShadowClaw 的 Dedicated Web Worker 明确拥有 LLM Tool-use loop、Tool execution、streaming、WebVM、AbortController、retry、max iteration 和 repeated tool signature detection，其控制流类似 iteration、fetch provider、receive tool calls、executeTool、append tool results、next iteration。因此它确实是完整的 Browser Worker Agent Loop。

但它同时存在浏览器 PWA/Electron runtime、Node CLI Agent Loop、Express control plane、本地 Prompt API/WebGPU 模型、远程 Provider、浏览器工具和本地 WebVM，更偏个人助手、coding agent 和 local workstation harness，而不是业务 Web App 内嵌 Agent 加 app-owned business tools 加同域 LLM proxy。最准确的归类是 Browser Worker Agent Loop 加可选 Node Runtime，而不是纯业务 App 同域代理方案。

### peerd：浏览器扩展型完整 Agent Harness

官方资料：[peerd Repository](https://github.com/NotASithLord/peerd)、[Security](https://github.com/NotASithLord/peerd/blob/main/SECURITY.md)、[Extension Hosts](https://github.com/NotASithLord/peerd/blob/main/docs/EXTENSION-HOSTS.md)。

peerd 使用 Chrome/Firefox Extension、Service Worker、offscreen/trusted document、per-tab Worker、OPFS、WASM/WASI、WebVM、WebMCP 和浏览器 Tab，能够读取和控制多个 Tab、操作登录状态、运行本地脚本、使用 WASM/WASI、保存 Session/Memory/Skills/Goals/Checkpoints、使用 BYOK 并直接连接模型 Provider。

但它默认不是普通 Web App 通过同域 `/api/llm` 访问 Provider，而是 Extension Vault 持有 BYOK credential 并直接调用 Provider。因此 peerd 命中 Browser Agent Loop 和浏览器本地执行，不命中默认同域 LLM proxy，也不是业务 Web App 内嵌型 Agent，更偏高权限跨站浏览器 Agent。它适合作为 DSH Browser Host 和安全隔离的参考，但不是普通 Web App 的直接模板。

### LangChain.js Headless Tools：前端 Tool，服务端 Loop

官方资料：[Headless Tools](https://docs.langchain.com/oss/javascript/langchain/frontend/headless-tools)、[官方源文件](https://raw.githubusercontent.com/langchain-ai/docs/main/src/oss/langchain/frontend/headless-tools.mdx)。

其典型模式是 LangGraph Server 持有 Agent Loop、History 和 Checkpoint，服务端产生 Tool call，浏览器通过客户端实现执行 Tool，结果返回以恢复服务端 run。服务端注册 schema-only Tool，浏览器使用 `.implement(...)` 提供具体实现。前端 Tool 可以访问 IndexedDB、geolocation、clipboard、camera、file picker、UI state 和其他浏览器能力。

它的关键差异是移动了 Tool implementation 的位置，但没有移动 Agent Loop、history、checkpoint 和 run ownership。所以它是 DSH 未来可以支持的中间拓扑“Server Loop + Browser Tools”，但不是完整 Browser Native Loop。

### Vercel AI SDK：标准模式是 Server Loop + Client Tools

官方资料：[Building Agents](https://ai-sdk.dev/docs/agents/building-agents)、[Loop Control](https://ai-sdk.dev/docs/agents/loop-control)、[Chatbot Tool Usage](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage.md)、[DirectChatTransport](https://ai-sdk.dev/docs/reference/ai-sdk-ui/direct-chat-transport)。

Vercel AI SDK 有完整的 `ToolLoopAgent`，支持 `stopWhen`、`prepareStep`、多轮 Tool-use 和 Agent loop control。但标准 Web 流程通常是浏览器 UI 调用 API route，API route 中的 server `streamText` 或 `ToolLoopAgent` 产生 client tool call，浏览器执行 Tool 后通过 `addToolOutput` 和 `sendAutomaticallyWhen` 触发下一轮服务端请求。它属于服务端 Agent Loop 加浏览器 Client Tools。`DirectChatTransport` 可以让 UI 直接连接同进程 Agent，但这并不等于官方把普通浏览器 Worker Agent Loop 作为默认生产拓扑。

### CopilotKit 与 WebMCP

官方资料：[CopilotKit WebMCP](https://www.copilotkit.ai/blog/introducing-webmcp-for-copilotkit)、[WebMCP docs](https://docs.copilotkit.ai/webmcp)、[Chrome WebMCP](https://developer.chrome.google.cn/docs/ai/webmcp?hl=en)。

CopilotKit 已经支持 frontend tools、shared state、HITL、Generative UI、AG-UI、WebMCP，以及 Tool 与 React 组件生命周期绑定。CopilotKit 的 WebMCP 让 Web App 的前端 Tool 可以被外部 Browser Agent 发现和调用。但典型 CopilotKit 架构仍然允许后端 Agent 通过前端 Tool 驱动 React UI，其核心方向是 Agentic UI，而不是强制浏览器驻留的 Agent Loop。

WebMCP 主要解决“外部 Agent 如何调用当前 Web App 的 Tools”，而不是“当前 Web App 自己如何在浏览器运行 Agent Loop”。其官方文档已涵盖 Imperative API、Declarative API、与 MCP 的比较、use cases、tool security、best practices 和 evals。

### OpenAI Agents JS 与 ChatKit

官方资料：[OpenAI Agents JS README](https://github.com/openai/openai-agents-js/blob/main/packages/agents/README.md)、[Runtime notes](https://raw.githubusercontent.com/openai/openai-agents-js/refs/heads/main/.agents/references/public-api-package-and-runtime-boundaries.md)、[ChatKit.js](https://openai.github.io/chatkit-js/)。

准确结论需要保持边界。OpenAI Agents JS 的标准文本、Tool 和 Sandbox Agent 官方支持环境主要列出 Node.js 22+、Deno、Bun 和实验性 Cloudflare，普通浏览器不是标准文本 Agent Loop 的官方支持环境。但不能说它完全没有浏览器能力：代码仓库存在浏览器相关 shim，提供浏览器 Realtime voice agent，RealtimeSession 可以使用浏览器 WebRTC，并通过服务器签发短期 ephemeral token。

必须区分 Browser Realtime voice runtime 和 Browser standard text Agent Loop 加前端 business Tools 加 same-origin text LLM proxy 加 DSH-like Session/workflow；前者不证明后者已经存在。ChatKit 则主要是浏览器 Chat UI 连接 OpenAI-hosted Agent Builder 或 self-hosted backend Agent，client Tool callback 也不等于 browser-resident Agent Loop。最准确的说法是：OpenAI Agents JS 不能简单归类为“不支持浏览器”，但目前公开资料不足以把它列为与 AG2B 等价的通用 Browser Native text Agent Runtime，其浏览器 Realtime voice 能力是专门运行时，不应与标准文本 Tool-use Loop 混同。

### Mastra、Browser Use、Playwright MCP、BrowserGym

[Mastra Browser Support](https://mastra.ai/blog/introducing-browser-support) 主要提供 navigate、click、fill、observe、extract，以及 Stagehand、AgentBrowser、Browserbase 和 Firecrawl Browser，其主方向是 Agent Runtime 通过 Browser provider 操作受控浏览器；CopilotKit integration 更偏 Mastra server 经 AG-UI 驱动 React frontend。即使某些 Demo 可以把部分逻辑前置浏览器，也不能据此把 Mastra 当前默认 Browser Provider 归类为标准 Browser-resident Agent Loop。

[Browser Use product map](https://docs.browser-use.com/cloud/which-product) 主要运行 Cloud Agent、Python Agent、CLI、worker、Lambda 和 BrowserSession，属于后端 Agent 操作浏览器，而不是当前业务 Web App 内部运行 Agent。[Playwright MCP](https://playwright.dev/mcp/introduction) 主要让外部 Agent 使用浏览器自动化工具。[BrowserGym](https://github.com/ServiceNow/BrowserGym) 是 Python/Playwright 研究环境和 benchmark。

### WebLLM 与 Puter.js

[WebLLM](https://github.com/mlc-ai/web-llm) 提供浏览器 WebGPU 推理、OpenAI-compatible API 和 function calling example，但应用仍需自己实现 Tool call 解析、Tool 执行、Tool result message、下一轮模型调用、stop condition、retry、cancellation、Session 和 permission，因此更适合作为 DSH Browser Provider，而不是完整 Agent Runtime。

[Puter AI Chat](https://docs.puter.com/AI/chat/index.md) 和 [function-calling demo](https://docs.puter.com/playground/ai-function-calling/) 支持浏览器侧调用模型和执行函数，但典型用法需要应用自己完成一次 chat、Tool call、应用执行 Tool、手动追加 `role:tool`、再次 chat，不提供完整的 Agent Loop、stop policy、session、retry、Tool governance 和 durable workflow。

## 八、现有实践分类总结

采用严格标准：只有实际把 `LLM → Tool → Tool result → next LLM` 放在 Browser/Client，才算完整 Browser Native Loop。

| 项目 | 完整 Browser Loop | 前端 Tools | 同域 LLM Proxy | 准确定位 |
|---|---:|---:|---:|---|
| AG2B | 是 | 是 | 是 | 业务 Web App 内嵌型 Browser Agent |
| ShadowClaw | 是 | 是 | 非核心要求 | Browser Worker Agent + Node Runtime |
| peerd | 是 | 是 | 否，BYOK 直连 | 浏览器扩展型 Agent Harness |
| LangChain Headless Tools | 否 | 是 | 应用决定 | Server Loop + Browser Tools |
| Vercel AI SDK 标准模式 | 否 | 是 | API route | Server Loop + Client Tools |
| CopilotKit | 通常否 | 是 | 后端决定 | Agentic UI / WebMCP |
| Mastra Browser | 通常否 | 可以 | 后端决定 | Server Agent + Browser Automation |
| OpenAI Agents JS | 未确认通用支持 | 是 | 应用决定 | Server-oriented text Agent；浏览器 Realtime 专用 |
| OpenAI ChatKit | 否 | 可以 | Hosted/Self-hosted backend | Browser UI + Backend Agent |
| WebLLM | 不提供完整 Loop | 需自建 | 无 | Browser LLM Provider |
| Puter.js | 不提供通用 Loop | 可以 | Puter Gateway | Browser AI Gateway |
| Browser Use | 否 | 浏览器自动化 | 不适用 | Backend/Python Browser Agent |
| BrowserGym | 否 | 研究环境 | 不适用 | Browser Agent Benchmark |

## 九、DSH 当前代码基础审计

### Dedicated Worker Host 已经具备较强基础

`packages/experimental/webworker-runtime` 已实现 Dedicated Worker entry、init frame、启动前消息排队、VFS image/overlay、MemoryVfs、WorkerModuleLoader、Node compatibility layer、Cordis plugin tree、`dsh-app-boot`、page/Worker transport、unary/stream seams、abort 和 Remote stream。关键代码位置包括 `packages/experimental/webworker-runtime/src/worker.ts`、`packages/experimental/webworker-runtime/src/worker-host.ts`、`packages/experimental/webworker-runtime/src/transport/tunnel.ts` 和 `packages/experimental/webworker-runtime/src/client/index.ts`。Worker Host 还会通过 `Connection.createSharedFetchHandler('/api')` 提供 Worker-local 的 `/api` 连接。

这说明 DSH 已经可以把较完整的插件树装入 Dedicated Worker，但 Worker-local `/api` 不等于 LLM provider proxy，这一区别非常重要。

### Agent Loop 和 Tool Pipeline 已经是真实实现

`packages/core/agent-loop/src/agent.ts` 已经包含 turn、step、inbox、steer、followup、cancel、LLM prepare、LLM stream、assistant stream settlement、Tool call 和 durable turn/step event。`packages/core/agent-loop/src/tool-calls.ts` 已经包含 exclusive/parallel execution、先记录后 dispatch 的 `tool/call`、cancel drain 和 synthetic skipped tool/result。

`packages/core/tools/src/index.ts` 已经包含完整 Tool pipeline：

```text
tools/pre-execute
→ monotonic guards
→ tools/execute
→ tools/post-execute
→ finalizeContent
→ tools/result
```

并支持 schema、output、signal-aware execute、timeout、retry wrapper、result freezing 和 presentation metadata。因此 DSH 的优势不是“可以写一个简单的 while loop”，而是可以尝试让已有 DSH Agent Loop 和 Tool 生命周期在 Browser Host 中复用。

但 Tool 的可用性依赖底层 Provider 是否 Worker-compatible、Tool 是否需要 Node filesystem、Tool 是否需要 process/subprocess、Tool 是否依赖 shell、Tool 是否依赖 PTC、Tool 是否需要秘密凭据。当前 Worker Runtime 明确存在 PTC Node programs 不可用、Node-only Tools 不能自动运行、某些 provider 在 Worker 中不可用等限制。

### 当前 Web E2E 还没有证明真实模型闭环

`apps/web/tests/preview-boot.e2e.ts` 已覆盖 packed Worker boot、Session list、history、Tool presentation、subagent navigation、settings、credentials 和 history paging。但当前 preview 主要使用 fixture、packed VFS、history artifacts 和 persistence artifacts，README 已明确说明该路径 without a model request。

因此当前测试证明的是 Page 到 Worker Host 再到 Session/UI projection 的路径，没有证明 Page 到 Worker Agent Loop、LLM request、Tool call、Tool result、second LLM request、final response 的路径。

### 当前 `/api` 不是同域 LLM Egress

当前 DeepSeek adapter 会直接向 `connection.baseURL` 发请求，并携带 `x-api-key`。这在浏览器 Worker 中带来四个问题：Provider CORS 可能不允许；API key 如果进入 Worker headers、VFS 或 config 会对浏览器环境和 DevTools 可见；Worker transport 没有自动把 provider request 变成同源 `/api/llm`；当前 Host/Origin trust fence 不是 provider credential authorization，`ownsHost: true` 也不应被理解为可以安全代理任意 URL。

另外，`pi-ai` 在 Worker 中存在结构性 stub，当前不能作为真实 packed Worker 模型调用路径。因此 DSH 当前明确缺少 Worker Agent Loop 到 `/api/llm` 再到 Host/BFF credential resolution 再到 Provider 的链路。

### Session persistence 在 Worker 生命周期内可用，但不跨重启

DSH 的 Session persistence 抽象已经定义 append-only log、single writer、append、`flush()` durability barrier、crash recovery 和 interrupted turn repair。但 Browser Worker 当前使用 MemoryVfs，具备可选的 `VfsMutationSink`，却没有注入 OPFS、IndexedDB 或 Host-owned browser persistence。

因此 Worker 生命周期内 Session JSONL 可运行，而 Worker recreate 或 page reload 之后 Session、credentials、settings 和 workspace writes 不保证存在。必须区分：DSH Session API 提供 durability contract，不等于当前 Browser MemoryVfs 已经实现了跨页面重启的物理持久化。如果第一阶段明确采用 ephemeral profile，这可以接受；如果要求 refresh/resume，则必须增加 OPFS 或 IndexedDB、VFS mutation sink、atomic flush、single-writer、multi-tab fencing、quota/eviction handling、restart recovery 和 storage migration。

### UI transport 与 handoff 基础存在，但 UI state seam 还不完整

当前已有 `__DSH_TRANSPORT__`、Connection RPC、Session control、follow、page、reconnect、generation guards、Tool call/result cards、Conversation Node、`tool.call.toolview` 和 Client UI slots。`packages/client/ui-tool` 的设计已经很适合业务 Tool UI：Tool call tree、root call、PTC child call、keyed Tool view、generic fallback、由 raw event 和 result 派生的 cards，Runtime 负责 pairing 和 topology，业务包注册 wire Tool name 和 atomic view。

但这不等于已经有完整的 App UI state 到 typed event 到 Agent context 到 Agent action 到 UI confirmation 链路，需要增加一个明确的能力 seam。

## 十、DSH 的关键缺口

### P0：同域 LLM Egress

未来应增加专门的 `/api/llm`，但必须避免把它实现成任意 HTTP relay。正确的处理方式是 Browser Worker 调用 `/api/llm`，由 DSH Host/BFF 完成 user/session validation、provider/model allowlist、credential resolution、quota/token/time budget、streaming、abort propagation、provider error mapping 和 secret-free audit，再访问 Provider。

客户端只能提交 logical provider、logical model、Session id、request content、purpose 和 budget context；客户端不能提交 arbitrary provider URL、arbitrary Authorization、arbitrary API key、arbitrary network destination 或 arbitrary upstream headers。

### P0：Typed UI State Bridge

建议定义三类角色。Service Definition 声明 UI surface、state snapshot、action、lifecycle、sensitivity、capability availability、model-visible fields 和 approval requirement。Service Provider 由 Web App 或业务插件实现 React/Vue/store adapter、UI action executor、surface mount/unmount、current entity context、draft state、local action 和 user confirmation。Agent Consumer 由 Worker Agent Loop 使用，请求当前 Agent step 所需的 UI context，将必要状态写入 model-visible Session event，调用 UI action，等待用户输入，将已确认事实提交到 Session，并继续下一轮 Loop。

建议不要把整个 UI state 作为一个无限增长对象，而采用 surface-scoped、capability-scoped、model-visible-by-declaration 的方式。

### P0/P1：Browser Storage 与 Session Recovery

需要明确支持级别。Ephemeral Browser Profile 在页面或 Worker 关闭后状态丢失，适合低风险短任务，不宣传 restart recovery，不保存秘密，不承担企业审计。Browser Persistent Profile 使用 OPFS 或 IndexedDB，支持 refresh/restart，需要处理 quota/eviction 和 multi-tab ownership，但仍不等于不可篡改企业审计。Server-synchronized Profile 由 Browser 主持 Loop，关键 Session event 同步服务器，服务器不主持短交互 Loop，支持跨设备 follow、审计和恢复。Durable Handoff Profile 由 Browser Loop 显式移交后端 durable worker，用于长任务，页面可关闭，客户端以后通过 follow 接收结果。

### P1：多标签页所有权

Browser Native 需要防止两个 Tab 的 Worker 对同一 Session 重复发起同一 Tool call。可以采用 active tab lease、generation/fencing token、Web Locks、BroadcastChannel、SharedWorker、IndexedDB ownership 或 server sequence check。但要注意 Web Locks 和 BroadcastChannel 可以做协调，不是服务器级别的安全边界，也不是跨崩溃的完整 durability guarantee。

### P1：端到端取消

本地 `AbortController` 只能停止本地 fetch 或 stream。完整取消应该是 user cancel 到 Worker Agent cancel 到 Tool signal 到 `/api/llm` abort 到 provider AbortSignal 再到 settled cancelled attempt。取消不能回滚已经产生的副作用；对于已经发送的邮件、已经启动的发布或已经执行的支付，必须单独处理 receipt、unknown outcome、compensation 和 reconciliation。

## 十一、Session、UI 与 Workflow 设计建议

建议进入 Session 的事实包括用户目标、Agent 实际看到的 UI state snapshot、已确认用户选择、Agent step、Tool call、Tool result、approval、server-side receipt、durable job handoff、checkpoint、cancellation settlement 和 unknown side-effect outcome。

不建议默认记录每次按键、hover、无关组件 state、临时展开、纯动画、尚未确认的敏感草稿，以及不会影响模型决策的 transient state。

DSH 已有重要原则是 Model-visible means logged，Browser Native 不能破坏这一原则。正确路径是 UI state provider 到 Agent 选择需要的字段到形成 model-visible UI context 到写入 Session event 再到发送 model request；错误路径是 Agent 随时读取页面内部状态、不记录，然后模型依据不可重建的状态决策。

## 十二、Browser Native 与业务 UI 的关系

此前讨论中的一个重要认识是：UI 描述与渲染层和业务能力层很难完全割裂，因为大多数生产 UI 是与业务能力强绑定的。这个判断成立。一个发布能力的 UI 不只是 schema 到 form，它实际上包含业务对象、当前环境、权限、风险、预览、用户确认、可撤销性、side-effect 级别、失败恢复、结果展示和审计字段。

因此更适合以能力单元为中心：

```text
Capability Unit
    ├── Agent Tool schema
    ├── UI surface
    ├── UI state provider
    ├── action executor
    ├── approval policy
    ├── server-side executor
    ├── Tool result
    ├── result renderer
    └── recovery semantics
```

这并不意味着 UI 与业务能力必须在同一个代码文件中，而是它们应由同一个能力单元共同设计和版本化。Browser Native 会让这种强绑定更明显，因为 Agent 可以直接唤起能力 UI、读取能力 UI、预填能力 UI、接受用户确认并接续下一个能力。

## 十三、DSH 的相对优势

DSH 的优势不是最小 Browser Loop，而是已有能力可以被复用。

### Tool execution pipeline

DSH 已有 `tool/call`、pre-execute、monotonic guards、approval、execute、post-execute、finalizeContent 和 result 的完整链路，比简单的 `handler(args)` 更适合高风险 Tool、审批、取消、超时、retry、Tool audit、结果标准化和 Session projection。

### Session event model

DSH 已有 Tool call 到 Tool result 到 Session event 到 Conversation Node 到 UI projection 的链路，适合构建用户目标、Agent step、UI input、approval、Tool execution、receipt 和 next step 组成的记录，而不是只在 React state 中维护不可恢复的聊天状态。

### 多 Host 语义

DSH 的长期价值是同一个 Agent/Tool/Session 模型可以运行于 Browser、Node、Headless、Desktop、SDK 和 Durable worker。如果为 Browser Native 单独创建第二套语义，反而会削弱 DSH 的价值。

### UI Tool 投影

DSH 的 UI Tool 设计已经明确 Runtime 持有 call/result pairing，UI 从原始事件、结果、失败和持久 metadata 派生，业务 UI 通过 `tool.call.toolview` 注册，存在 generic fallback，root 与 PTC topology 不由业务 card 自己管理。这很适合将业务能力单元映射到 Browser Native Agent 的 UI。

## 十四、DSH 不应承担的目标

DSH 不需要为了支持 Browser Native 而承诺所有 LLM 都在本地运行、所有 Tool 都在浏览器执行、页面关闭后所有任务继续、普通网页可以安全保存所有秘密、浏览器提供不可篡改企业审计、浏览器可以执行任意 shell/subprocess、所有业务 UI 都动态生成、所有工具都能脱离业务后端、Agent 完全不需要用户确认，或 Browser Native 可以取代 Server Durable Agent。这些目标要么不是必要条件，要么会制造不现实的安全和可靠性承诺。

## 十五、推荐 DSH 支持的三种 Agent 拓扑

### 模式 A：Host/Server Loop + Server Tools

Server Agent Loop 调用 Server Tools 和 LLM，Browser 呈现 UI。适合长任务、后台、高权限、审计、多设备和多用户协作。

### 模式 B：Host/Server Loop + Browser Tools

Server Agent Loop 发出 browser Tool request，Browser Tool 执行后返回结果，Server Loop 继续。适合需要浏览器能力但仍希望 server authoritative 的场景，与 LangChain Headless Tools 类似。

### 模式 C：Browser Loop + Browser/Server Hybrid Tools

Browser Agent Loop 调用 Browser-local Tools、同源后端 API 和 server-authorized side-effect Tools，并在需要时 durable handoff。这是本报告讨论的 Browser Native 模式，不是要取代模式 A 和 B，而是作为新增模式。

## 十六、推荐实施路线

### 阶段 1：先做真实 Worker 模型闭环

增加 test-only `/api/llm` mock proxy，验证 Provider 只能由代理访问、Worker/page frame 不含 raw credential、SSE 增量正常、AbortSignal 穿透 Worker 到 proxy 到 provider、Provider error 转换成稳定 LLM error、arbitrary provider URL 被拒绝、arbitrary Authorization 被拒绝、secret 不进入 Session。然后跑 create Session、user prompt、first model response with Tool call、Worker-compatible Tool、tool/result、second model request、final response，验证 Session 中存在 request/header、request/context、turn/step、assistant stream、`tool/call`、`tool/result` 和 final settlement。这是最重要的第一步。

### 阶段 2：选一个业务能力验证 Typed UI Bridge

不要先做通用 Generative UI，而选一个业务流程，例如发布审批：

```text
用户：
检查 v1.8，并对 staging 做 10% 灰度发布。

Agent：
release.inspect

UI：
展示变更、风险和候选环境

Agent：
release.select_scope

UI：
用户选择 staging + 10%

Agent：
release.request_approval

UI：
用户确认

Server-authorized Tool：
release.start_canary

UI：
显示进度、成功、失败、回滚或未知状态

Session：
记录目标、UI facts、Tool call、审批、receipt
```

这个样板可以验证前端 Tool、UI state、用户输入、Agent 继续、approval、backend side effect、Session、Tool UI、error/recovery 和第二轮模型请求。

### 阶段 3：增加 Browser Persistence

确定是否支持 OPFS、是否支持 IndexedDB、哪些目录持久化、credentials 是否允许本地保存、quota 和 eviction 如何处理、multi-tab 如何竞争、VFS mutation sink 如何写入、`flush()` 如何映射到物理存储、Worker recreate 如何恢复、Session format 如何迁移。

### 阶段 4：增加 Server Synchronization

让 Browser Loop 仍然是交互式权威，但同步关键 Session event、Tool receipts、approval、checkpoints 和 durable job handles。服务器可以负责跨设备 follow、远程审计、durable handoff、恢复和对账。

### 阶段 5：增加 Durable Handoff

定义明确的协议：

```text
Browser Agent
→ handoff request
→ server validates
→ durable job created
→ Session records handoff
→ browser receives job id
→ browser can disconnect
→ server completes
→ browser reconnects/follows
```

不要让 handoff 通过“把 Agent Loop 偷偷切到后端”实现，而要将其作为显式运行位置切换。

## 十七、Browser Native 模式验收标准

Agent Loop 方面：Dedicated Worker 中存在真实的 `LLM → Tool → LLM`；不依赖本地 Node Host；Tool call/result 具有 durable event；cancel 和 error 能 settlement；Worker-compatible provider 可用。

LLM Proxy 方面：key 不进入浏览器；client 不能提交 arbitrary provider URL；client 不能提交 arbitrary Authorization；provider/model allowlist；stream；quota；attribution；abort；provider error mapping；secret-free log。

Frontend Tools 方面：Worker 与 Main Thread 使用 typed protocol；Tool 可随 UI surface 注册和注销；Tool lifecycle 与组件 lifecycle 绑定；参数双端验证；Tool risk 明确；高风险副作用服务端重新授权。

UI State 方面：Agent 得到结构化 state；不是主要通过 DOM scrape；model-visible UI state 可由 Session 重建；draft 与 confirmed fact 区分；UI action 可关联到 Agent step 和 Tool call；Tool result 能驱动下一能力。

Persistence 方面：明确 ephemeral 或 persistent；persistent profile 可在 Worker recreate 后恢复；`flush()` 有实际物理语义；multi-tab 不产生双写者；reconnect 不重复或跳过事件；replay 默认不重复执行副作用。

Durable Work 方面：页面关闭不会把任务伪装为成功；长任务显式 handoff；durable result 可回到 Session；unknown side-effect outcome 可表达；Browser 与 Server runtime 的 ownership 明确。

## 十八、主要风险和反模式

### 把浏览器沙箱当作完整安全模型

错误认识是“Agent 在浏览器，所以安全”。正确认识是浏览器限制 OS 访问，但业务授权和副作用仍需后端验证。

### 同域代理逐渐变成隐藏的 Server Agent

如果 Browser 只发 user prompt，而 Backend 持有 Loop、history、Tools 和 workflow，这已经不是 Browser Native。

### 把所有 UI state 发给模型

这会导致隐私风险、token 膨胀、Prompt Injection 面扩大、Session 噪声和难以回放。

### 所有 Tool 都强行放浏览器

涉及 secret、事务、支付、权限、高风险副作用和 durable job 的能力仍然应该由后端最终执行。

### 把 Worker 当作永久进程

页面可能被刷新、关闭、冻结、在移动端挂起或被浏览器回收，Worker 不是 durable daemon。

### Browser 和 Server 各自维护一套 Agent 语义

如果 Browser 模式重新实现 Agent Loop、Tool result、Session、Approval 和 cancellation，DSH 将产生长期双轨维护成本。正确方向是复用 DSH 的核心语义，替换运行位置和宿主能力。

## 十九、关于这个想法是否独创的诚实评价

不能说只有一个人想到过。现在已经有明确先行者：AG2B 是业务 App 内嵌 Browser Agent Loop，ShadowClaw 是 Dedicated Worker Tool-use Loop，peerd 是浏览器扩展 Agent Harness，Chrome WebMCP 让网页暴露结构化 Tools，CopilotKit 处理 Frontend Tools、shared state 和 Generative UI，LangChain 提供 Server Loop + Frontend Tools，Vercel AI SDK 提供 ToolLoopAgent 与 Client Tools，WebLLM 提供浏览器模型推理，Browser Use 和 Playwright MCP 让 Agent 操作浏览器，OpenAI Agents JS 则区分 server-oriented text Agent 与 Browser Realtime voice runtime。

但这个思考仍然具有系统性价值，因为它不是只提出一个孤立特性，而是把以下关系看得很清楚：Agent Loop 为什么要靠近 UI；前端业务 Tool 为什么不只是 callback；Agent 为什么应获得结构化 UI state；同域代理为什么应只负责模型访问而不负责整个 Loop；Browser Native 为什么有利于 Agentic UI；为什么 UI 与业务能力单元应强绑定；为什么高风险副作用和 durable work 仍要由后端负责；为什么同一 Harness 应支持 Browser、Node、Headless 等多种运行位置。

所以最准确的评价是：不是第一个想到 Browser Agent、前端 Tools 或 Agentic UI，而是识别出了一个尚未被大多数主流 Agent Framework 以统一方式解决的系统级组合。这不是“没人做过”的独创，而是对现有 Agent Runtime 部署拓扑的一次有价值的重新组合和工程化判断。

## 二十、最终判断

Browser Native 架构成立，可以带来更低的服务器交互式 Loop 状态成本、更直接的 UI state 感知、更低的 UI 编排延迟、更自然的前端业务 Tool，以及更好的 Agentic UI 和前台工作流体验；但它不能消除 LLM 费用、后端 API、后端授权、持久化、审计、durable jobs 和高风险副作用安全。

已经有先行实践。AG2B 实现浏览器 Agent Loop、frontend Tools、app state 和 same-origin `/api/llm`，是与目标最直接等价的实现。ShadowClaw 提供 Dedicated Worker Loop、browser tools、local storage 和 optional Node runtime，是多运行位置的重要参考。peerd 提供 Browser Extension Agent Loop、tabs、OPFS/WASM/WebVM 和 BYOK，是高权限 Browser Harness 的参考，但不是普通 Web App 模式。

DSH 是否最合理，取决于目标。如果目标是最快做出最小 Browser Native Agent，AG2B 更直接，模型更轻，验证成本更低。如果目标是给 Web App 加 Agentic UI，CopilotKit、Vercel AI SDK 或 LangChain Headless Tools 可能更快。如果目标是浏览器扩展个人 Agent，peerd 更接近。如果目标是 Worker/Electron/本地个人助手，ShadowClaw 更接近。如果目标是让现有 DSH 同时支持 Browser Native、Node、Headless 和 Durable execution，那么扩展 DSH 是非常合理的选择，因为 DSH 已经拥有 Agent Loop、Tool registry、Tool lifecycle、approval、guard、cancellation、Session event、persistence abstraction、UI projection、Worker Host、Cordis composition 和多 runtime 方向，这比另起一个 Browser Agent Runtime 更有机会避免语义分叉。

最终判断是：DSH 不应转型为 Browser Native Harness，Browser Native 应该成为 DSH 的一种可选 Agent 执行模式。AG2B 已经证明“浏览器内 Agent Loop + 前端 Tools + 同域 LLM 代理”的最小拓扑成立。DSH 的机会不是重新发明这个 Loop，而是让现有 DSH Agent、Tool、Session、审批、取消、UI 投影和多运行时体系能够在 Browser Host 中复用，并在需要时与后端授权和 Durable execution 协同。

当前最值得做的验证闭环是：

```text
Dedicated Worker
→ DSH Agent Loop
→ same-origin /api/llm mock proxy
→ Tool call
→ frontend Tool
→ tool/result
→ second LLM request
→ UI projection
→ Session event
→ cancel/reconnect
→ optional durable handoff
```

在这个闭环跑通之前，应说 DSH 的 Browser Native 扩展方向架构上高度合理且已有较强基础；跑通之后，才能说 DSH 已经实际具备 Browser Native Agent 执行能力。

## 调研来源

AG2B：[What is AG2B](https://ag2b.ai/docs/what-is-ag2b)、[Agent Runtime](https://ag2b.ai/docs/runtime)、[The Loop](https://ag2b.ai/docs/runtime/the-loop)、[Quickstart](https://ag2b.ai/docs)、[OpenAI Provider](https://ag2b.ai/docs/providers/openai)、[WebMCP Plugin](https://ag2b.ai/docs/plugins/webmcp)。

ShadowClaw：[Repository](https://github.com/xt-ml/shadow-claw)、[Worker Protocol](https://github.com/xt-ml/shadow-claw/blob/95df1b02/docs/architecture/worker-protocol.md)。

peerd：[Repository](https://github.com/NotASithLord/peerd)、[Security](https://github.com/NotASithLord/peerd/blob/main/SECURITY.md)、[Extension Hosts](https://github.com/NotASithLord/peerd/blob/main/docs/EXTENSION-HOSTS.md)。

WebMCP 与 Agentic UI：[Chrome WebMCP](https://developer.chrome.google.cn/docs/ai/webmcp?hl=en)、[CopilotKit WebMCP](https://www.copilotkit.ai/blog/introducing-webmcp-for-copilotkit)、[CopilotKit WebMCP docs](https://docs.copilotkit.ai/webmcp)。

前端 Tools 与 Loop 拓扑：[LangChain Headless Tools](https://docs.langchain.com/oss/javascript/langchain/frontend/headless-tools)、[LangChain 官方源文件](https://raw.githubusercontent.com/langchain-ai/docs/main/src/oss/langchain/frontend/headless-tools.mdx)、[Vercel AI SDK Building Agents](https://ai-sdk.dev/docs/agents/building-agents)、[Vercel AI SDK Loop Control](https://ai-sdk.dev/docs/agents/loop-control)、[Vercel AI SDK Chatbot Tool Usage](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage.md)、[Vercel AI SDK DirectChatTransport](https://ai-sdk.dev/docs/reference/ai-sdk-ui/direct-chat-transport)。

其他运行时与工具：[OpenAI Agents JS README](https://github.com/openai/openai-agents-js/blob/main/packages/agents/README.md)、[OpenAI Agents JS Runtime notes](https://raw.githubusercontent.com/openai/openai-agents-js/refs/heads/main/.agents/references/public-api-package-and-runtime-boundaries.md)、[ChatKit.js](https://openai.github.io/chatkit-js/)、[Mastra Browser Support](https://mastra.ai/blog/introducing-browser-support)、[Browser Use Product Map](https://docs.browser-use.com/cloud/which-product)、[Playwright MCP](https://playwright.dev/mcp/introduction)、[BrowserGym](https://github.com/ServiceNow/BrowserGym)、[WebLLM](https://github.com/mlc-ai/web-llm)、[Puter AI Chat](https://docs.puter.com/AI/chat/index.md)、[Puter function calling](https://docs.puter.com/playground/ai-function-calling/)、[Chrome Built-in AI](https://developer.chrome.com/docs/ai/built-in)。

DSH 代码与文档：`docs/architecture.md`、`docs/agent-lifecycle.md`、`docs/tool-execution-pipeline.md`、`packages/core/agent-loop/`、`packages/core/tools/`、`packages/session/session-persistence/`、`packages/client/ui-tool/`、`packages/experimental/webworker-runtime/`、`packages/client/connection/`、`packages/api/session-controller/`、`apps/web/tests/preview-boot.e2e.ts`。
