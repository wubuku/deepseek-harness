---
description: "综合 DSH Agentic UI 与 Browser-Native DSH 研究、PoC、源码考古和外部协议资料，给出在浏览器原生 Agent Loop 中复用既有 SaaS GUI 的架构、协议、权限、恢复和实施路线。"
---

# Browser-Native 环境下实现 Agentic UI：DSH 综合深度调研报告

## Summary

本报告综合两类已有成果：一类是对共享 ChatGPT 对话中 Agentic UI 方案的事实核查与 DSH 代码考古，另一类是 Browser-Native DSH 的运行时研究、实施计划和 v2 PoC。研究问题不是“怎样让模型生成一个页面”，而是：在已有 SaaS 已经拥有传统 GUI、业务 API、身份体系和数据模型的前提下，怎样让 DSH 的 Agent Loop 驻留浏览器，并在 Chat UI 中安全地呈现、读取和操作这些既有业务界面。

结论是：Browser-Native Agentic UI 应被定义为 **浏览器中的 Agent Loop + 类型化 UI capability + 既有业务 API 的受控编排**。Dedicated Worker 只承载 Agent Loop、Tool registry、模型适配和 Session 投影；Main Thread 只承载真实 UI、用户手势、受控状态适配器和 action 执行；服务端继续拥有模型凭据、租户授权、业务副作用、Session 权威持久化以及长期任务的 owner。三者通过版本化、可重连、可审计的 typed protocol 协作。

DSH 当前的 Browser-Native v2 PoC 首先证明了现有 DSH Web UI、Cordis composition、`ctx.agentLoop`、远程 `SessionPersistence` 和同源 LLM proxy 可以在浏览器 Worker 中组成真实运行链路；原始 v2 本身没有证明 Agent 能够读取业务组件状态、调用既有业务 action、完成业务授权，或把 UI action 的结果可靠地投影回模型上下文。后续三路线 mock SaaS 实验已经在受控业务协议上补充验证了这些能力的一个最小闭环，但还没有把它提升为通用生产协议。因此，下一步不是继续扩展通用 Worker，而是把已验证的受限 UI capability seam 在真实 SaaS 写入闭环中固化。

本文推荐的第一条生产路径是：`自然语言 → Browser Worker 中的 DSH Agent Loop → 业务 Tool → Main Thread 注册的既有 surface → 用户确认或受控 action → SaaS 服务端授权的业务 API → receipt/unknown 结果 → Session event → Agent 继续或结束`。这条路径保留既有 SaaS 的业务规则和 UI 投资，也保留 DSH 的 Tool 生命周期、Session 回放、Conversation projection 和 profile 组合能力。既有 SaaS 没有聊天层并不改变运行时原则，但聊天层选择应单独判断：基础同口径实验已证明三条路线都能接入相同 mock 业务闭环；复杂续约实验再以 CopilotKit 为主验证了跨页面上下文、共享业务组件、frontend tool、HITL 和同一 DSH turn 的续接。对已有丰富 React GUI 且 Agentic UI 为核心目标的 SaaS，CopilotKit 是复杂应用交互的下一轮产品化验证首位候选，但不是生产选型定案，也不是总工程量最低的证明。assistant-ui 当前也公开了 Interactables、工具和生成式 UI 能力，但未在 DSH PoC 中完成同等复杂度验证；CopilotKit PoC 已使用 `1.79.1` 的 `/v2` API，生产 Agent 注入、真实业务授权、跨进程幂等和 unknown recovery 仍待验证。若只需要聊天与基础工具呈现，assistant-ui 仍可作为轻量候选；DSH 原生 Web UI 适合 DSH-native 或愿意采用 DSH Client composition 的产品。assistant-ui PoC 证明的是外部聊天层能接入 DSH，不是两套聊天层应当并存。

## Table of Contents

- [研究范围与结论边界](#研究范围与结论边界)
- [先定义问题：什么才是 Browser-Native Agentic UI](#先定义问题什么才是-browser-native-agentic-ui)
- [两类已有研究的合并结果](#两类已有研究的合并结果)
- [外部生态能复用什么](#外部生态能复用什么)
- [DSH 与 PoC 的事实核查](#dsh-与-poc-的事实核查)
- [推荐的三层架构](#推荐的三层架构)
- [Typed UI Capability 设计](#typed-ui-capability-设计)
- [Tool、UI、Session 和业务 API 的关系](#tooluisession-和业务-api-的关系)
- [完整业务时序：客户创建](#完整业务时序客户创建)
- [可靠性、安全和恢复](#可靠性安全和恢复)
- [实施路线与验收矩阵](#实施路线与验收矩阵)
- [最终判断](#最终判断)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

## 研究范围与结论边界

### 研究输入

本报告的第一类输入是 [DSH Agentic UI 事实核查报告](dsh-agentic-ui-research.md)。该报告读取并核查共享对话 `https://chatgpt.com/share/6acb63a5-9554-83ea-a2f5-c5c6da6b7f29`，把共享对话中关于 Intelligent UI、Apps SDK、MCP Apps、A2UI、AG-UI、CopilotKit 和 DSH 的断言，映射到当前 checkout 的源码、文档、测试和历史。

第二类输入是 [Browser-Native Agent Loop 研究](dsh-browser-native-agent-loop-research.md)、[Browser-Native Runtime 研究](dsh-browser-native-runtime-research.md)、[Browser-Native 实施方案](dsh-browser-native-agent-implementation-plan.md) 和 [browser-native-dsh-poc](browser-native-dsh-poc/README.md)。其中 v2 PoC 的运行时接线只在 `apps/web/src/preview.ts` 和 `docs/drafts/browser-native-dsh-poc/` 内形成 opt-in 实验路径。

外部比较资料在 2026 年 10 月 12 日重新访问，优先使用项目官方文档、规范或官方源码。本文只把外部项目用作模式比较，不把其宣传性的定位直接当作 DSH 已有能力。外部页面会变化；报告中的链接是本次核查入口，DSH 当前能力以本地 checkout 和已运行的测试为准。

### 术语约定

| 术语 | 本文含义 |
|---|---|
| Agentic UI | Agent 根据任务和业务上下文选择、预填、呈现或推进用户可操作的 UI surface；它不是任意 HTML/JavaScript 生成器。 |
| Browser-Native Agent | Agent Loop 的迭代、Tool choice、停止判断和下一次模型请求都在浏览器 Dedicated Worker 中发生；后端不是每个回合的隐式 loop owner。 |
| UI surface | 已注册业务界面的一次实例，例如客户表单、客户选择器、发布审批面板或只读详情卡。 |
| UI capability | 一个可由 Agent 观察或调用的、带版本、权限和结果语义的 surface 能力；它不是 React component 名称，也不是 DOM selector。 |
| model-visible state | 会进入后续模型请求的 UI 或业务状态；它必须能从 Session event 或等价权威投影重建。 |
| owner | 当前有权推进 Agent Loop、写入 Session 或执行指定副作用的唯一执行者。 |
| unknown outcome | 请求或副作用可能已经执行，但当前执行者没有获得可确认结果；它不能被当作失败自动重试。 |

### 证据等级

| 标记 | 证据来源 |
|---|---|
| 共享对话核验 | 第一份报告提取的共享页面正文和逐项判断。 |
| DSH 当前实现 | 当前 `research` checkout 的 TypeScript、Cordis profile、Session、Client UI、测试和 Git 历史。 |
| PoC 实际行为 | `browser-native-dsh-poc` 的 v2 backend、Worker、provider、profile overlay、契约测试和 Chromium E2E。 |
| 外部参考 | AG2B、Chrome WebMCP、CopilotKit WebMCP、LangChain Headless Tools、MCP Apps、Vercel AI SDK 等官方资料。 |
| 设计判断 | 基于上述事实提出的方案，不表示当前 DSH 已经实现。 |

-----

## 先定义问题：什么才是 Browser-Native Agentic UI

### 严格验收定义

完整的 Browser-Native Agentic UI 至少要形成下面的闭环：

```text
用户在页面输入目标
  → Dedicated Worker 中的 DSH Agent Loop
  → 同源、受限的 LLM proxy
  → 模型返回业务 Tool call 或 UI observation 请求
  → Worker 调用 browser Tool / UI capability
  → Main Thread 读取注册的 surface 状态或执行受控 action
  → Tool result 返回 Worker
  → Session 追加可回放事件
  → 下一次模型请求包含该结果
  → Agent 继续、等待用户或结束
```

以下拓扑仍然有价值，但不应称作完整 Browser-Native Agent Loop：

```text
Backend Agent Loop
  → browser callback
  → Main Thread frontend Tool
  → backend Agent Loop
```

它是 **Server Agent + Frontend Tool**。关键区别不在于工具代码是否运行在浏览器，而在于每一轮模型请求和停止判断的 owner 在哪里。

### Agentic UI 的真正对象不是组件，而是能力单元

现有 SaaS 的 `CustomerForm`、`ReleaseApprovalPanel` 或 `ContactPicker` 只是渲染实现。Agent 需要的是一个更窄的能力声明：

```text
Capability
  = surface identity/version
  + observable fields
  + allowed actions
  + input/result schemas
  + authorization class
  + approval and gesture policy
  + state/version preconditions
  + Session projection
  + recovery semantics
```

因此，“复用已有 GUI”不等于把现有 React/Vue 树搬进 Worker，也不等于让模型知道 DOM。应当复用业务组件和其已有调用路径，但在 Chat UI 与业务 UI 之间建立一个能力适配层。

### 三个状态不能混为一谈

| 状态 | 示例 | 权威者 | 默认是否进入 Session |
|---|---|---|---|
| Client transient state | 输入焦点、展开/折叠、草稿未提交、鼠标 hover | Main Thread UI | 否 |
| Agent-visible projection | 当前选中客户、筛选条件、表单字段的已确认值、可用 action | UI capability adapter + Session projection | 是，若影响后续模型请求 |
| Business durable state | 客户已创建、审批已生效、任务已排队、服务端 receipt | SaaS backend / business service | 是，通常以业务事件或 receipt 引用进入 Session |

用户在表单里输入但尚未提交的草稿可以只存在 Main Thread；如果 Agent 要根据它继续推理，就必须先把经过限制和脱敏的 observation 记录为 model-visible event。客户是否真的创建成功，不能由 UI 的按钮状态或模型的工具文本决定，只能由既有业务服务的权威响应决定。

-----

## 两类已有研究的合并结果

### 第一类研究给出的产品原则

第一份报告对共享对话的核心方向判断成立：Agent 可以成为既有 SaaS 的新入口，在 Chat UI 中选择、预填、呈现和串联既有业务能力；业务数据、鉴权、事务、审计和持久化仍归原 SaaS 后端所有。它还确认了几个容易混淆的事实：

- Intelligent UI 的交互状态不等于 CRM 权威数据；跨刷新、跨聊天或跨用户的持久化必须由产品自己的存储和服务保证。
- `tool.call.toolview` 是按 Tool 名称注册的呈现扩展点，能呈现 `preparing`、`start`、`result` 阶段，但不是业务表单提交协议。
- `ConversationNodeDefinition` 能把事件折叠成可回放的业务节点，但不会自动生成业务 API、授权、事务或工作流。
- A2UI、MCP Apps、AG-UI、CopilotKit 等分别解决声明式 UI、Tool 关联 widget、Agent/Client 事件和前端 Tool 等问题，不能把它们的名词叠加成一个已经完成的产品架构。

### 第二类研究给出的运行时原则

Browser-Native 研究把问题从“在哪里显示 UI”推进到了“谁拥有 Agent Loop 和执行状态”：

- Agent Loop 进入 Dedicated Worker 后，Main Thread 负责 UI、用户手势和受控浏览器能力，服务端负责凭据、授权、持久化和 durable work。
- Browser Worker 是低信任执行面，不是业务授权系统；同源 Worker 也不是不可信插件的完整安全隔离。
- Session append、flush、owner claim、renew、fencing、reconnect 和 durable handoff 必须分别定义，不能用一个 `persist: true` 或一个布尔 owner 状态代替。
- 只要 UI 状态会影响模型下一次请求，它就必须有可重建的 Session 证据；只把数据塞进内存 store 或 `agent.inject()` 而不记录事件，会破坏回放和恢复。
- Browser Agent 和 Backend Agent 不能同时成为同一 Session 的 active owner；handoff 必须先撤销旧 owner，再授予新 owner。

### 合并后的核心命题

两类研究合并后，目标不是“Browser-Native + 任意 Generative UI”，而是：

> **把既有 SaaS 的业务 UI 当作受注册、受版本和受授权的 capability surface，让浏览器中的 DSH Agent Loop 通过 typed observation/action bridge 使用它，并让所有模型可见事实、业务提交和 owner 转移都落到可回放、可审计的权威记录。**

这个命题同时约束产品和运行时：没有业务 capability，Browser-Native 只是把普通 Chat Agent 搬进 Worker；没有 Worker Loop，Agentic UI 只是 Server Agent 的前端回调；没有 Session/授权/恢复，二者合起来也不能安全承载真实业务写入。

-----

## 外部生态能复用什么

### AG2B：最接近 Browser Loop 的参考

AG2B 官方文档把自己定位为 client-side agentic runtime：Agent 在浏览器运行，服务端可以只是 LLM proxy 或扩展层；它强调读取现有状态管理、调用已有 client function，并把工具 schema 与浏览器实现绑定。其 Loop 文档把一次迭代拆成构建请求、调用 provider、处理 response、执行 Tool、提交 Tool message 和继续/停止。

它对 DSH 的直接启发是：Browser-Native 不应复制一套业务函数，而应把已有 store action、fetch wrapper 和受控浏览器能力包装成 typed Tool；模型每次看到的是当前允许的能力和结构化状态。然而 AG2B 的产品定位不能替代 DSH 的 Session event、租户授权、Tool lifecycle、profile 组合或 durable handoff；它也不能证明任意现有 SaaS 的业务 action 已经可安全暴露给模型。

### Headless Tools：证明 Tool schema 可以和浏览器实现分离

LangChain 的 Headless Tools 文档把 schema-only Tool 注册在 Agent 侧，把实现放在 frontend；模型发出匹配 Tool call 后，前端执行并把结果用于恢复中断的 run。这是 Browser-Native UI bridge 的一个清晰先例：Tool 名称和 JSON Schema 是共享契约，浏览器实现拥有 IndexedDB、geolocation、clipboard 或现有 UI action 的访问权。

DSH 可以复用这一分离原则，但必须补上 DSH 自己的要求：Tool call/result 要进入 canonical Session event；业务写入要通过服务端重新授权；结果丢失要进入 unknown，而不能把客户端恢复机制理解为业务 exactly-once。

### WebMCP：浏览器发现前端 Tool，不等于 Agentic UI 协议

Chrome WebMCP 和 CopilotKit WebMCP 的共同方向是让网站注册带名称、描述、类型化输入和 JavaScript handler 的浏览器 Tool，兼容的浏览器 Agent 可以发现并调用该 Tool。CopilotKit 文档还明确区分 frontend tool 与 backend agent：WebMCP 调用通常留在浏览器，是否触及后端由 handler 自己决定。

这对 DSH 有用之处是证明“既有前端 Tool 可以成为 Agent 能力目录”，也提醒我们要把 catalog 与执行授权分开。WebMCP 解决的是浏览器外部 Agent 发现网站能力的问题；本文目标是 DSH Worker 内的 Agent 使用同一页面的业务 surface。DSH 仍需要自己的 `surfaceId`、state projection、Session event、owner fencing 和业务 API receipt，不能直接把 WebMCP registration 当作完整内部桥接协议。

### MCP Apps：强 widget 隔离和双向消息参考

MCP Apps 文档把 Tool 与 `ui://` resource 关联，Host 可以在对话中预加载并在 sandboxed iframe 中渲染 HTML widget；widget 通过受控的 JSON-RPC/postMessage 方言调用 Tool、发送消息、更新模型上下文并接收数据。它适合复杂数据探索、配置表单、审批、实时监控和多步工作流。

MCP Apps 的隔离和宿主能力模型值得借鉴，尤其是“不把第三方 widget 当成宿主页面代码运行”。但 DSH 复用既有 SaaS 的第一阶段更适合从同一产品内的 typed React/Vue adapter 开始：iframe 或外部 widget 会新增身份传递、尺寸、弹窗、路由、下载、CSP、跨源通信和恢复问题。即使采用 sandbox，业务 action 仍需宿主或后端授权。

### 不应直接移植的部分

- A2UI 式声明式 catalog 适合有限、跨框架的 UI vocabulary；它不能自动把一个既有 CRM 页面转换为可复用的业务 surface。
- AG-UI 式事件协议适合 Agent 与前端的流式事件和中断协作；它不替代 DSH Session format、业务事件或授权。
- Vercel AI SDK 的 `ToolLoopAgent`、OpenAI Agents JS/ChatKit 和其他框架展示了 server/client Tool loop 组合，但 DSH 需要维持自己的 `agent-loop`、Tool lifecycle、Session persistence 和 Cordis composition。
- Playwright MCP、Browser Use、BrowserGym 以浏览器自动化或环境控制为主；它们适合旧系统的短期兼容或测试，不适合作为高价值业务写入的正式能力边界。
- WebLLM、Chrome Built-in AI 等本地模型路线可以减少网络依赖，但不能替代服务端授权、模型政策、Session durability 或业务 API。

-----

## DSH 与 PoC 的事实核查

### DSH 现有能力正好覆盖哪些层

代码考古显示 DSH 已有几个适合承载 Browser-Native Agentic UI 的稳定基座：

| DSH 机制 | 当前能力 | 对本课题的意义 |
|---|---|---|
| `packages/core/agent-loop` | 创建和管理真实 `ReactLoopAgent`、turn/step 边界、Session 接入和有序 teardown。 | Browser Worker 应复用它，而不是新建 `BrowserAgentLoop`。 |
| `packages/core/tools` | Tool schema、canonical output、Tool call/result 生命周期和呈现元数据。 | 业务 capability 可先作为受限 Tool 注册，并复用结果/错误语义。 |
| `packages/session` | append-only event log、contiguous seq、`flush()` durability barrier、单 writer ownership 和 read/reconnect 语义。 | UI observation、action settlement 和 Agent continuation 有统一持久化基础。 |
| `packages/client/ui-tool` | 按 wire Tool name 的 `tool.call.toolview` keyed renderer，处理 preparing/start/result。 | 可以把一个业务 Tool 的 surface 投影到 Chat transcript，但不能自动完成表单 action。 |
| `packages/client/ui-conversation` | `ConversationNodeDefinition` 把 Session event 匹配、聚合、投影为可回放业务 Node。 | 只有需要跨轮次持续存在的业务 surface 才应增加 Chat Node。 |
| `docs/subsystems/web-client.md` 的 data path | Host 权威状态 → Remote/event → Client projection → Slot/React；user command → Host Controller → authoritative update → event projection。 | 现有 DSH 已经倾向“事件驱动投影”，不是前端另建事实源。 |
| `packages/experimental/webworker-runtime` | Worker 内 VFS、模块加载、synthetic HTTP、Cordis Host boot 和 tunnel。 | 可作为 Browser Worker Host 的启动基座，但不是 LLM proxy 或 UI authorization。 |

### PoC v2 已经证明的内容

v2 的 `browser-native-worker.ts` 通过 `createWorkerHost()`、静态模块表和 profile overlay 启动现有 DSH Host。`apps/web/src/preview.ts` 静态导入并始终实例化 docs-owned Worker，只有 profile overlay 受 `browser-native=1` 控制；不带该参数时保留原有 overlay 列表，但不能据此认定 Worker entry 没有改变。

`browser-native-providers.ts` 在 Worker 内提供正式 `SessionPersistence` 和 `LlmAdapter` 的远程实现。它使用同源 `/api/browser-native/session/*` 和 `/api/browser-native/llm`，把正式 DSH `StreamChunk` 映射为 NDJSON wire item，再将远程错误映射为 DSH persistence/LLM 错误。Session live events 通过单独的写队列串行 append；`flush()` 和 `close()` 触发远程持久化。

`backend-v2.mjs` 建立了几个重要的 PoC 语义：

- Session create/open/read/append/flush/close/list/stat 路由使用 `protocolVersion`、`requestId`、session id、owner token 和 contiguous `expectedNextSeq`。
- `append` 只更新内存可见日志；`flush` 使用临时文件、文件 `fsync`、原子 rename 和目录 `fsync` 建立 durability receipt。
- Session 写 owner 由 claim 得到；失去 owner 或序列不连续时拒绝写入。
- `requestId` 是必填的协议关联字段；v2 backend 没有基于它的请求去重或结果重放账本。owner token 只存在于当前 backend 进程内，没有 `renew`、expiry 或 owner epoch；Worker 强制终止后，等待不会自动释放写权。完整恢复要求属于 v2 规划的未来验收条件，不能把旧版实验协议中的 lease/replay 写成 v2 已完成能力。
- LLM route 只接受同源 backend 提供的逻辑入口；真实 provider URL、model 和 API key 由 Node backend 从环境文件读取，不进入 Worker、页面、Session event、响应 body 或日志。
- OpenAI-compatible streaming 被转换为 DSH `StreamChunk` 风格的 NDJSON；请求断开会 abort upstream fetch。

`tests/backend-v2.test.mjs` 覆盖 Session 生命周期、owner fencing、durability、scripted/real-compatible LLM stream、非法请求和 secret redaction；`tests/browser-native-v2.e2e.mjs` 用真实 Chromium 打开现有 DSH preview，提交消息，再从 backend 读取正式 Session event，并检查 `/session/flush`、`/llm`、durable file 和无密钥泄漏。

这些事实足以支持如下判断：**DSH 的真实 Agent Loop 已经可以在 Worker 中工作，Worker 到同源模型 proxy 和正式 Session persistence 的连接也已形成可测试闭环。**

### PoC v2 尚未证明的内容

PoC 的 E2E 主要断言用户消息、assistant message、LLM route、flush 和持久文件；它没有证明下面任何一项：

- Main Thread 注册业务 surface，并把经过筛选的 state 提供给 Worker。
- Agent 读取客户列表、发布范围或审批表单的 typed state，而不是只处理聊天文本。
- Agent 通过 capability action 调用既有 SaaS API，并得到服务端授权后的业务 receipt。
- 一个 UI action 的 `request → approval/gesture → commit/reject/unknown` 状态能完整映射到 Session event。
- 页面刷新、Worker 重启、网络断开或多标签页切换后，未完成 UI action 不会被重复执行。
- Browser Agent 能通过原子 handoff 把长期工作交给 durable backend job。
- 浏览器用户、租户、角色、资源范围和业务授权已经在 PoC backend 中得到验证；当前 v2 backend 是本地研究服务，不是多租户生产 BFF。

因此，把**原始 v2 PoC**直接写成“通用 Agentic UI 已实现”是事实错误。准确表述是：**Browser-Native DSH runtime substrate 已实现；mock SaaS 实验已经验证受限的 Agentic UI capability seam，但通用生产协议尚未实现。**

这里的“通用生产协议尚未实现”指跨业务模块复用所需的业务能力层，不是否定现有的领域级人机交互或 mock 实验。DSH 已有 `ui-user-questions` 和 `ui-approval` 的等待、回答、审批、超时、取消和后续消息路径；mock 实验又把页面 state、受控 action、业务 receipt 和部分 unknown/retry 语义接入了三条路线或 CopilotKit 主验收，但真实 SaaS 授权、跨进程幂等、生产 unknown recovery 和多租户隔离仍未验收。关于 Web UI 质量与第三方框架的独立评估见 [DSH Web UI 实现质量与 Agentic UI 框架选型评估](dsh-web-ui-quality-and-agentic-ui-framework-assessment.md)。

-----

## 推荐的三层架构

### Main Thread：UI 和用户手势的受控拥有者

Main Thread 继续运行现有 SaaS GUI、DSH Web Client、React/Vue stores 和浏览器 API。它新增的不是通用 RPC，而是一个 capability registry：只有业务包注册的 surface 才能被 Worker 观察或调用。

Main Thread 负责：

- 将现有组件的必要字段投影成 schema 约束的 state snapshot。
- 检查 surface/version/entity/field 是否在 registry 中，并做脱敏、大小限制和 digest。
- 执行需要真实用户手势的 UI action，例如打开选择器、聚焦、选择记录或展示确认面板。
- 对业务写入先显示预览或审批，再把 action request 转给 SaaS API adapter；不因为模型选中了一个 action 就视为授权。
- 将 committed/rejected/unknown 的结果和服务端 receipt 返回 Worker。
- 保持草稿、焦点、展开状态等 transient state，除非明确标记为 model-visible。

Main Thread 不应向 Worker 传递 DOM node、React element、Vue instance、function、observable、任意 module URL、`eval` payload、DOM selector、provider key 或通用全局对象句柄。

### Dedicated Worker：DSH Agent Loop 和模型可见状态的投影者

Worker 运行 opt-in Browser Native DSH profile。它复用 `ctx.agentLoop`、`ctx.tools`、`ctx.llm`、Session event 和 existing profile composition；它不直接访问 React store，不读取 DOM，不保存 provider credential。

Worker 负责：

- 把用户 prompt、已确认 UI observation 和 Tool result 组装成下一次模型请求。
- 在 Agent Loop 中选择 Tool、等待 Main Thread action、接收结果并决定继续或结束。
- 把 model-visible state、Tool call、Tool result、approval 和 unknown settlement 写入 Session。
- 对 bridge 连接、owner epoch、deadline、取消和重连做协议级处理。
- 在 browser-owned profile 下推进短时交互任务；在 handoff 后停止 loop，只 follow backend events。

Worker 不是最终业务授权者。即使它保存了 `capability` 名称、角色信息或一个看似有效的 preview digest，服务端也必须重新确认 principal、tenant、resource、current version 和 action policy。

### Backend：模型出口、业务权威和 durable owner

Backend 负责同源 `/api/llm`、认证、租户绑定、provider allowlist、额度和审计；真实 SaaS API 仍是业务数据和副作用的权威。Session service 负责 event append、flush、recovery cursor 和 owner fencing；durable job service 负责长期任务。

Backend 不应把 browser transcript 当成防篡改审计，也不应提供可转发任意 upstream URL 的 generic proxy。LLM route 只能接受逻辑 model/provider、经过大小限制的 messages/tools、Session/owner context 和取消信号；provider URL、Authorization、Cookie、内部错误和 secret 均不应由浏览器控制或回显。

### Durable Worker：明确 handoff 后的第四种执行位置

长期审批、批量导入、部署或等待外部系统回调的任务不能依赖页面持续存在。Browser Worker 在干净 checkpoint、无 active unknown side effect、已 flush 的 model-visible input 和一致 tool catalog 上请求 handoff；服务端在同一个 authoritative transaction 中撤销 Browser owner、签发新的 server owner epoch，再创建或接管 durable job。

handoff 被接受后，Browser Worker 不能继续发 LLM request、执行 Browser Tool、append 或 cancel 旧 epoch 的工作，只能 follow 后端 job/Session events。Handoff 失败应进入显式 recovery state，不能假设自动回到 browser-owned。

### 为什么不把 Agent Loop 放在 Main Thread

Main Thread 适合 UI 生命周期和用户手势，不适合作为 Agent Loop 的唯一运行位置：长时间模型流、复杂 Tool 等待、页面渲染阻塞和 UI 卸载会互相影响。Dedicated Worker 也不是 durable daemon，但它能把 Agent runtime 与 React render 生命周期分开，并使 `MessageChannel` 成为明确的 typed bridge。

### 为什么不把所有 UI 放进 iframe

iframe 是隔离和交付机制，不是 capability model。将既有页面放入 iframe 仍需解决尺寸、登录态、跨源通信、回调、路由和业务 action 结果；同源 iframe 甚至可能带来过宽的访问权。第一阶段应优先做“复用组件 + typed adapter”，只有无法拆分的旧模块才考虑 Web Component、microfrontend 或 sandboxed widget。

-----

## Typed UI Capability 设计

### Registry 的最小声明

建议首版只为一个业务垂直领域建立 capability registry；每个注册项至少包含：

```text
surfaceId
surfaceVersion
surfaceInstanceId
entityRef
stateSchema
observableFields
allowedCapabilities
sensitivity
modelVisibilityPolicy
actionSchemas
approvalPolicy
userGesturePolicy
ownerPolicy
sessionProjection
```

`surfaceId` 是稳定业务标识，不是组件文件名；`surfaceVersion` 用于 state/action 兼容；`surfaceInstanceId` 区分同一页面中多个实例；`entityRef` 只表示业务对象引用，不能替代服务端授权。

### State snapshot

建议采用明确的 JSON snapshot，而不是传递 store 或 DOM：

```json
{
  "surfaceId": "customer.create",
  "surfaceVersion": 1,
  "surfaceInstanceId": "customer-form-17",
  "entityRef": { "type": "customer-draft", "id": "draft-42" },
  "stateVersion": 8,
  "fields": {
    "name": "ABC Inc.",
    "ownerId": "sales-7",
    "followUpDate": "2026-10-19"
  },
  "capabilities": ["customer.create.preview", "customer.create.commit"],
  "sensitivity": "business-data",
  "contentDigest": "sha256:...",
  "modelVisible": true,
  "observedAt": 1792440000000
}
```

只允许 registry 中声明的 field 进入 `fields`；不能把整个 form store、错误对象、隐藏字段或用户凭据一并序列化。`stateVersion` 和 `contentDigest` 用来防止 Agent 基于过时的表单状态提交。

如果 `modelVisible` 为 true，至少需要新增一种业务事件，例如 `browser/ui-state-observed`，并为它声明 `SessionEventMap` payload、projection、persistence catalog、大小限制和 SDK expected output。相同 surface 的 observation 应由 projection 替换旧值，而不是无限追加完整表单。

### Action request

```json
{
  "protocolVersion": 1,
  "bridgeInstanceId": "bridge-9",
  "workerInstanceId": "worker-3",
  "tabInstanceId": "tab-4",
  "sessionId": "session-17",
  "ownerEpoch": 12,
  "requestId": "req-55",
  "actionId": "action-55",
  "capability": "customer.create.commit",
  "arguments": {
    "name": "ABC Inc.",
    "ownerId": "sales-7",
    "followUpDate": "2026-10-19"
  },
  "expectedStateVersion": 8,
  "previewDigest": "sha256:...",
  "idempotencyKey": "customer-create-session-17-action-55",
  "requiresApproval": true,
  "requiresUserGesture": false,
  "deadlineAt": 1792440060000
}
```

Main Thread 先做 registry/schema/state/approval/gesture/deadline 校验；真正提交仍调用既有 SaaS API adapter。服务端再次验证用户、租户、角色、资源、当前版本和幂等键。结果至少区分：

```text
accepted + committed + receipt
accepted + rejected + reason
accepted + unknown + reconciliation reference
cancelled before commit
stale state / owner lost / protocol rejected
```

“按钮已点击”只代表 UI 事件发生；“业务对象已创建”必须有服务端 receipt。执行开始后连接断开时，客户端不能把结果改写为 rejected，也不能自动重复 commit。

### Bridge protocol

建议使用独立 `MessageChannel`，不要把业务 bridge frame 混入现有 Worker tunnel。公共字段包括 `protocolVersion`、`bridgeInstanceId`、`workerInstanceId`、`tabInstanceId`、`sessionId`、`ownerEpoch`、`correlationId/requestId`、方向内递增 `seq`、`kind`、`deadlineAt` 和 payload。

桥接协议要定义 request/response/event/ack、duplicate/gap、generation、resync、大小上限和失败收尾。Worker 重启或页面刷新后，旧 generation 的 frame 必须拒绝；未完成 action 必须结算为 settled、cancelled 或 unknown。重连只恢复 bridge 连续性，不能自动恢复外部副作用。

-----

## Tool、UI、Session 和业务 API 的关系

### 四类 Tool 执行位置

| 类别 | 例子 | 结果权威 | 自动重试 |
|---|---|---|---|
| Browser-local | 读取已注册筛选状态、打开面板、计算本地预览 | Main Thread / Worker | 只在纯函数且可重复时允许 |
| Browser-orchestrated, server-backed | 查询客户、预加载联系人、校验表单字段 | SaaS backend | 按查询语义和 request id 处理 |
| Server-authorized side effect | 创建客户、提交审批、修改发布范围 | SaaS backend | 只在服务端幂等且结果可查询时允许 |
| Durable/background | 批量导入、部署、等待 webhook、长审批 | Durable job owner | 不由 Browser Loop 自动重试副作用 |

一个“展示客户表单”的 Tool 和一个“创建客户”的 Tool 不应被合并。前者可以返回 surface instance 和 observation；后者必须进入审批、幂等、业务授权和 receipt 流程。

### 业务 Tool 的 canonical lifecycle

建议把一条能力调用映射为：

```text
Tool preparing
  → Tool start / UI surface mounted
  → optional ui-state-observed
  → user edits or confirms
  → action.requested
  → approval/asked + approval/decided (when required)
  → business API call
  → committed / rejected / unknown receipt
  → tool/result
  → next LLM request or final assistant message
```

`tool.call.toolview` 可以渲染 preparing/start/result，但 `action.requested`、approval 和 receipt 应由业务包定义，并通过 Session projection 提供给 Chat Node 或 Tool view。不要为了呈现一个短暂表单而创建长期 Conversation Node；只有 surface 要跨轮次、跨分页或跨刷新恢复时，才增加 `ConversationNodeDefinition`。

### Event authority

Browser 不是所有 Session event 的权威生产者。建议把事件按来源分成：

| 事件类别 | 允许 Browser 产生 | 权威来源 |
|---|---:|---|
| 用户 prompt、已确认 UI observation、用户审批手势 | 是，需服务端校验上下文和大小 | Browser/User + Session service |
| Agent tool call、assistant stream | Worker 产生，按 DSH lifecycle 持久化 | Browser Worker / DSH runtime |
| 业务 commit receipt、权限结论、provider usage、owner transition | 否，不能由客户端声称 | SaaS backend / Session service |
| durable job state、最终审计、未知结果对账 | 否 | Backend job/business service |

客户端上传的 `tenantId`、`role`、`approved: true`、`committed: true` 或 `receiptId` 都只能作为不可信请求字段；服务端需要从认证 principal、业务数据库和自己的 transaction 结果重新派生权威值。

### Tool view 与 Conversation Node 的选择

- **Tool view**：适合一个 Tool call 期间的 preparing/start/result 生命周期，改动小，按 Tool name keyed dispatch；优先用于第一个垂直样板。
- **Conversation Node**：适合跨多个 turn 的客户创建向导、发布审批、任务队列或长时间业务上下文；需要新的 Session event、match/update、replay 和 snapshot 测试。
- **普通组件状态**：适合只在当前页面存在的草稿、焦点和展开状态；不要因为组件可见就写入 Session。

-----

## 完整业务时序：客户创建

下面的时序同时验证 Agentic UI 和 Browser-Native Loop，而不是只验证聊天文本。

### 阶段 A：Agent 选择 capability

1. 用户在 Chat UI 输入“帮我创建 ABC Inc.，分配给张三，并安排下周一跟进”。
2. Worker 将 prompt 作为 DSH user message 写入 Session，开始 `turn/start` 和 `step/start`。
3. Worker 请求模型；模型返回 `customer.search` 或 `customer.create.prepare` Tool call，而不是任意组件代码。
4. Worker 将 Tool call 写入 Session，并把 `customer.create` surface descriptor 发给 Main Thread。
5. Main Thread 通过 registry 找到现有 `CustomerForm`，创建 `surfaceInstanceId`，将允许的字段和初始值投影出来。

### 阶段 B：用户在既有 GUI 中确认

6. Main Thread 可以从已有业务 store 和 API cache 填充候选 owner；敏感字段不进入 observation。
7. 用户在 Chat UI 内的既有表单中修改字段或选择张三；如果这些值将影响下一次模型请求，adapter 生成 `browser/ui-state-observed`，带 `stateVersion` 和 digest。
8. 如果只需要用户手势才能打开选择器，Worker 的 action request 进入 `requiresUserGesture` 状态，UI 显式等待用户点击；不能模拟用户手势。
9. Main Thread 将 observation 交给 Worker；Worker 追加事件并在下一次模型请求中只使用已记录的 state。

### 阶段 C：服务端授权和提交

10. 模型请求 `customer.create.commit`，Worker 发送 action request，携带 `expectedStateVersion`、`previewDigest` 和稳定 `idempotencyKey`。
11. Main Thread 显示“创建客户”确认界面；若产品要求用户确认，记录 `approval/asked`，用户点击后记录 `approval/decided`。
12. SaaS API adapter 向服务端发送业务命令；服务端从认证 session 解析用户和租户，重新检查 owner、资源范围、字段规则和当前版本。
13. 服务端成功时返回客户 id、revision、operation id 和 receipt；业务事件成为权威数据，Session 只保存最小可回放引用。若连接在提交后中断，服务端以 operation id 支持查询。
14. Main Thread 将 `committed` receipt 返回 Worker；Worker 追加 `tool/result`、`step/end` 和 `turn/end(completed)`，再请求下一次模型或结束。

### 阶段 D：失败和未知结果

- 字段校验失败：返回结构化 field errors；surface 保留草稿，Worker 可以请求用户修正，不重复提交。
- 无权限或租户不匹配：服务端拒绝；UI 显示明确原因，模型不能通过改写 `tenantId` 绕过。
- stale state：`expectedStateVersion` 或 digest 不匹配；先刷新 surface，再要求重新确认。
- 用户取消：若业务 API 尚未开始，记录 cancelled；若已经开始，查询 operation status，不声称 rollback。
- 连接断开：如果没有 receipt，记录 unknown；恢复时执行 reconciliation query，而不是重新创建客户。
- 模型重复调用：服务端以 idempotency key 返回既有 receipt 或明确冲突，不依靠按钮 disabled 状态去重。

这个样板的真正验收不是“Chat 中出现一个表单”，而是同一条 Session 能重放：用户目标、surface 版本、已确认字段、approval、business receipt、最终助手消息，以及在中断时需要对账的 unknown 状态。

-----

## 可靠性、安全和恢复

### Owner 和多标签页

同一 Session 只能有一个 active Browser Loop owner。每个实例至少需要 `sessionId`、`tabInstanceId`、`workerInstanceId`、`ownerEpoch`、lease token、expiry 和 heartbeat/cursor。Follower 可以读取 Session、显示 owner 状态和请求转移，但不能发送 LLM、执行 Browser Tool、append 或 handoff。

`Web Locks` 和 `BroadcastChannel` 可以减少重复启动，却不能作为安全 fencing。真正的 owner 由服务端或 authoritative persistence 判断；旧 epoch 的 LLM request、action、append、cancel 和 handoff 必须被拒绝。

### 页面刷新、崩溃和重连

`beforeunload`、React cleanup 或 Worker 的正常 close 不能作为可靠保存机制。恢复从最近一次已确认的 durable prefix 开始：

- 已进入 Session 的 model-visible observation 可以重建模型上下文。
- 已开始但无 receipt 的业务 action 进入 unknown，先查询 operation status。
- 已有 durable `tool/result` 但没有 final assistant message 时，可以继续请求 final；不得再次执行同一副作用 Tool。
- bridge reconnect 只恢复 snapshot/delta 协议；旧 worker generation 的迟到消息全部丢弃。
- persistence backend 的 `append` 只表示 accepted/visible，`flush` 才表示 crash durability；浏览器 IndexedDB/OPFS 的物理保证要单独注明。

### LLM proxy 和跨站防护

同源 proxy 的价值不只是解决 CORS。它还必须绑定认证 principal、tenant、Session owner、模型 allowlist、额度、超时、请求体大小和审计；只接受逻辑 provider/model，不接受浏览器指定的任意 upstream URL 或 Authorization header。

`Origin` 校验和非 simple content type 是 CSRF 的共同前置；但 Origin 通过不等于业务授权通过。对于用户自带 key，应设计独立凭据模式，不能把它和平台托管 key 的安全假设混在一起。

### Browser Worker 和插件隔离

Dedicated Worker 隔离的是运行线程和生命周期，不是同源插件的完整信任边界。不能把模型生成的 module URL、脚本或任意 widget 直接送进 Worker；registry、bundle、CSP、capability allowlist 和服务端授权必须共同约束可执行代码。

### 业务副作用和 exactly-once

DSH Session 的连续 seq、flush 和 owner fencing 只能保证 Session 记录的一致性，不能让外部业务 API 获得 exactly-once。业务命令需要稳定 operation id/idempotency key、可查询 receipt 和明确的 unknown outcome。只有“已知未提交”才可安全重试；“可能已提交”必须对账。

### Durable handoff

Handoff 的安全顺序是：

```text
browser-owned
  → checkpoint validated
  → browser lease revoked
  → server owner epoch issued
  → durable job started
  → browser follows
```

服务端必须使 handoff request id 幂等，并在接受前确认没有未 flush 的 model-visible input、active unknown side effect、过时 tool catalog 或不兼容 profile。接受后 Browser Loop 停止；后台 Job 产生的 Session/job events 成为唯一后续事实源。

-----

## 实施路线与验收矩阵

### Phase 0：冻结 capability、事件和授权契约

先不写生产 loop 代码。选择一个真实垂直领域（建议客户创建或发布审批），冻结 surface registry、字段可见性、action schema、approval/gesture policy、event producer/authority 表、LLM/bridge protocol version、Origin/CSRF、principal binding、错误码、unknown 语义和 mock model sequence。

退出条件：每个 action 有唯一 owner；每个 profile 只有一个 active owner；每个 model-visible field 有 Session projection；服务端能拒绝 stale state、错误租户、旧 epoch 和重复 operation。

### Phase 1：Worker 内存闭环

在 fake LLM 下证明：Worker 中的现有 `ctx.agentLoop` 产生 Tool call；Worker 通过 typed bridge 请求 Main Thread；Main Thread 执行无副作用的 surface observation/action；Tool result 回到 Worker；第二次模型请求包含 result；最终 assistant message 完成。

这一阶段不接真实业务写入，不涉及跨刷新恢复。它要证明的是 Agentic UI bridge 的运行语义，而不是业务授权。

### Phase 2：真实业务只读 surface

选择客户查询、客户选择器或发布范围预览。将既有 UI 组件包装成 registry entry，定义 state snapshot、digest、projection 和 replay。测试字段白名单、敏感字段剔除、state version 冲突、页面重连和模型只看到已记录状态。

### Phase 3：一个受控写入闭环

实现 `customer.create.prepare`、`customer.create.commit`、approval、服务端授权、idempotency key、receipt 查询和 unknown recovery。优先让 Tool view 承载一次调用；只有跨轮次状态确有需要时，才增加 `ConversationNodeDefinition`。

### Phase 4：Session persistence、multi-tab 和真实 LLM

增加 server-synchronized persistence、owner claim/renew/fence、真实同源 `/api/llm`、取消传播、stream error settlement、刷新恢复和 Chromium E2E。浏览器本地 IndexedDB/OPFS 可以作为缓存或副本，但不能隐式变成第二权威。

### Phase 5：durable handoff

把批量导入、审批等待和部署任务从 Browser Loop 转交 durable job。验证 handoff 原子 ownership 转移、job 创建失败、旧 epoch 拒绝、浏览器 follow、cancel 前后竞态和 unknown receipt 对账。

### 验收矩阵

| 层级 | 必须证明 | 失败时不能宣称 |
|---|---|---|
| Loop | `LLM → Tool call → Main Thread capability → Tool result → LLM → final` | 不能宣称 Browser-Native Agentic UI |
| UI bridge | registry、schema、stateVersion、digest、generation、resync、unknown settlement | 不能宣称可恢复的 UI action |
| Session | observation、Tool lifecycle、approval、receipt 引用可回放；flush 和 seq 正确 | 不能宣称 durable 或 replay-safe |
| Business API | 服务端 principal/tenant/role/resource 检查，幂等和 receipt/query | 不能宣称生产业务写入安全 |
| Ownership | multi-tab 单 writer，旧 epoch 全部拒绝，handoff 后 Browser 停止 | 不能宣称可交接或无双写 |
| Product | 真实 SaaS 组件在 Chat UI 中工作，失败/取消/刷新有明确 UX | 不能宣称既有 GUI 已被复用 |
| Security | 无 key 泄漏，无任意 URL/脚本执行，无客户端授权伪造，CSRF/Origin 覆盖 | 不能宣称可面向多租户上线 |

建议的 focused commands 以实际实现所在包和测试为准。当前 PoC 可运行的验证包括：

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
DSH_POC_PLAYWRIGHT_MODULE=/path/to/deepseek-harness/node_modules/.pnpm/node_modules/playwright/index.mjs \
DSH_POC_LLM=scripted \
node docs/drafts/browser-native-dsh-poc/tests/browser-native-v2.e2e.mjs
pnpm run test:docs
pnpm run doc-sync
git diff --check
```

最后三条是本次报告的文档验证；PoC 的浏览器测试是否能运行取决于当前 checkout 的 preview build 和 Playwright 模块路径，不能把未运行的命令写成通过。

-----

## 最终判断

### 可以明确做什么

DSH 可以把 Browser-Native 作为一个显式 opt-in execution profile，复用现有 `agent-loop`、Tool pipeline、Session persistence、Tool view、Conversation projection、Cordis composition 和 WebWorker runtime。在此之上，为已有 SaaS GUI 建立 typed UI capability registry 和 Main Thread/Worker bridge，就能让 Agent 在 Chat UI 中选择并复用真实业务 surface。

第一条可控生产路径不是“模型生成 CRM”，而是一个受限垂直闭环：展示和预填既有表单 → 记录已确认 observation → 由用户确认或满足策略后提交 → SaaS backend 授权并执行 → receipt/unknown 进入 Session → Agent 继续。

### 不能从当前成果推导什么

- 当前 PoC 证明的是 Browser-Native DSH runtime substrate，不是通用业务 Agentic UI；这不否定 DSH 已有的问答、审批和后续回答等具体人机交互闭环。
- DSH 的 Tool view、Conversation Node、Worker tunnel 和 Session persistence 不能单独替代 UI capability registry、业务授权或 durable handoff。
- WebMCP、MCP Apps、A2UI、AG-UI 和前端 Tool 框架不是互相可替换的统一协议；应按职责借鉴。
- Browser Worker、IndexedDB、OPFS、Origin 校验或 owner token 任何一个单独都不能成为多租户业务安全边界。
- “执行一次”不能自动等于外部副作用 exactly-once；未知结果和可查询 receipt 是必须的一等状态。

### 最重要的工程决策

1. **复用业务能力，不复制业务系统。** Agent 选择的是 capability，不是任意组件或 DOM。
2. **复用 DSH Loop，不复制 Loop。** Worker 只提供新的执行位置和 adapter。
3. **模型可见即需可回放。** UI observation、approval 和 Tool result 必须有明确的 Session 投影。
4. **浏览器可编排，服务端授权。** Main Thread 可以执行 UI action，但不能授予业务权限。
5. **副作用以 receipt 为准。** committed、rejected、unknown 不能压缩成布尔成功。
6. **一个 Session 一个 active owner。** Handoff 是 ownership transfer，不是继续运行的通知。
7. **先做一个真实闭环。** 先验证客户创建或发布审批，再决定是否引入 Conversation Node、MCP Apps、A2UI 或复杂 microfrontend。

8. **没有聊天层、已有丰富 React GUI 且目标是 Agentic UI 时，选择新增的唯一聊天/应用交互层，而不是再造业务界面。** 基础三路线实验已验证相同 mock SaaS 任务、业务组件和 API 可以在三种聊天层下完成闭环；复杂续约实验又在 CopilotKit 路线验证了跨页面状态、共享业务组件、`useFrontendTool`、`useHumanInTheLoop`、取消、刷新和写权恢复。因而 CopilotKit 是复杂应用交互的下一轮产品化验证首位候选，assistant-ui 是轻量呈现和低耦合接入的候选，DSH 原生 Web UI 更适合 DSH-native 产品。这个判断不是生产定案，也不是三路线复杂真实成本排名：复杂真实模型证据主要覆盖 CopilotKit，早期真实 WebKit 和真实 Chrome 对照结果见复杂实验记录，新增的最终复杂全故事没有对三路线等量重跑。生产 Agent 注入、真实业务 API、授权、跨进程幂等、receipt、未知结果恢复和多租户隔离仍未验证。三条路线都是新增一个聊天/Agentic UI 层，均不取代 SaaS 原有业务页面；DSH 继续拥有 Agent Loop、工具编排和 Session 事实。

因此，Browser-Native 环境下实现 Agentic UI 的最短正确答案是：**把 DSH Agent Loop 放入 Dedicated Worker，把已有 SaaS GUI 暴露为类型化、版本化、受授权的 UI capabilities，把所有模型可见状态和业务结果接入 Session，把高风险副作用和长期任务留给服务端，并用 owner fencing 和 durable handoff 保证不会出现双重执行。**

## Further Exploration

### 本地研究成果

- [DSH Agentic UI 事实核查与代码考古](dsh-agentic-ui-research.md)
- [Browser-Native Agent Loop 研究](dsh-browser-native-agent-loop-research.md)
- [Browser-Native Runtime 研究](dsh-browser-native-runtime-research.md)
- [Browser-Native 可执行实施方案](dsh-browser-native-agent-implementation-plan.md)
- [Browser-Native DSH PoC README](browser-native-dsh-poc/README.md)
- [CopilotKit + Browser-Native DSH PoC README](copilotkit-browser-native-dsh-poc/README.md) — 初版 renderer/桥接路线的真实模型 mock SaaS 闭环及限制。
- [成熟 SaaS 三路线对照实验](saas-agentic-ui-comparison-poc/README.md) — 三种聊天层在同一业务故事中的基础闭环与对照。
- [复杂续约实验](saas-agentic-ui-comparison-poc/complex/README.md) — CopilotKit 原生 frontend tool/HITL、页面协作和生命周期的主验收；真实浏览器矩阵边界见[测试记录](saas-agentic-ui-comparison-poc/complex/test-results.md)。
- [PoC 旧版独立实验协议](browser-native-dsh-poc/protocol.md) — 仅作为历史参考，不描述当前 v2 行为。
- [PoC v2 规划与进度](browser-native-dsh-poc/browser-native-dsh-plan-v2.md)、[browser-native-dsh-progress-v2.md](browser-native-dsh-poc/browser-native-dsh-progress-v2.md)

### 外部参考入口

- [AG2B runtime](https://ag2b.ai/docs/what-is-ag2b)、[The Loop](https://ag2b.ai/docs/runtime/the-loop)
- [Chrome WebMCP](https://developer.chrome.com/docs/ai/webmcp)
- [CopilotKit WebMCP](https://docs.copilotkit.ai/webmcp)
- [LangChain Headless Tools](https://docs.langchain.com/oss/javascript/langchain/frontend/headless-tools)
- [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)
- [Vercel AI SDK Agent Loop Control](https://ai-sdk.dev/docs/agents/loop-control)
- [ShadowClaw](https://github.com/xt-ml/shadow-claw)、[peerd](https://github.com/NotASithLord/peerd)、[WebLLM](https://github.com/mlc-ai/web-llm)

### DSH 代码入口

- `apps/web/src/preview.ts`
- `packages/experimental/webworker-runtime/src/worker-host.ts`
- `packages/core/agent-loop/src/index.ts`
- `packages/core/tools/src/index.ts`
- `packages/client/ui-tool/src/client/contract/slots.ts`
- `packages/client/ui-conversation/src/client/contract/conversation.ts`
- `packages/session/session-persistence/src/index.ts`
- `packages/session/session-persistence/src/handle.ts`

## Dev Note

本报告是 `docs/drafts/` 下的研究草稿，不是已提交的 Browser-Native 产品设计或稳定 API。报告引用的 capability registry、`browser/ui-state-observed`、bridge frame、`/api/llm` 业务授权、durable handoff 和 Browser Native profile 都是后续实施建议；除 [browser-native-dsh-poc](browser-native-dsh-poc/README.md) 明确记录的 v2 实验范围外，不应视为当前 DSH 已实现的功能。报告没有新增 Agent Note，也没有修改 DSH 核心运行时。
