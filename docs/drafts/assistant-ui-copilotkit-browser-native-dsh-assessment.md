---
description: "核查 assistant-ui 与 CopilotKit 对比材料，评估 Browser-Native DSH SaaS 长期采用第三方 UI 和应用交互框架的收益、兼容性、生产接入限制及验收标准。"
---

# Browser-Native DSH 的长期 UI 选型：assistant-ui 与 CopilotKit

## Summary

本文在已选择 Browser-Native DSH 的前提下，评估未来是否值得采用 assistant-ui 或 CopilotKit。产品背景是既有 SaaS 已经拥有丰富 Web GUI、业务操作页面和组件，但此前没有 AI assistant 的聊天层；现在需要新增一个聊天入口，让用户用自然语言调用或引导这些既有能力。DSH 当前 Web UI 的主体同样是聊天/会话/Tool/Conversation 呈现层，因此 assistant-ui PoC 让两者可以在同一个 DSH Agent Loop 上直接比较。选择 Worker 内的 DSH Agent Loop，不等于必须永久使用 DSH 当前的聊天层；第三方 UI runtime 也不必成为第二个 Agent Loop。重新结合 PoC 和源码后的判断是：**DSH Web UI 的内部扩展性很强，但对外部 SaaS 不是通用嵌入式聊天 SDK；一般既有 SaaS 应把 assistant-ui 作为新增聊天层的默认候选，CopilotKit 作为深度 React 应用交互的条件候选，DSH 原生 UI 只在 DSH-native 或愿意采用 DSH Client composition 的产品中优先。**引入是否合理，取决于聊天层能否减少持续维护职责，以及能否保留 DSH Session、业务授权和副作用执行的明确归属。

本文比较的是“新增的聊天层”，不是是否保留既有 SaaS GUI：无论采用 DSH 原生 Web UI 还是 assistant-ui，SaaS 原有路由、业务页面、表单、组件和业务 API 都应继续存在。第一版不应同时挂载两套面向用户的聊天层；assistant-ui 路线意味着它替换 DSH Web UI 的聊天呈现职责，而不是在 DSH Web UI 之上再叠加一个聊天窗口。

## Table of Contents

- [长期结论](#长期结论)
- [PoC 后的直接重评](#poc-后的直接重评)
- [材料处理与核查范围](#材料处理与核查范围)
- [原文的事实核查与保留价值](#原文的事实核查与保留价值)
- [Browser-Native DSH 与前端框架的分层](#browser-native-dsh-与前端框架的分层)
- [未来为什么可能值得引入](#未来为什么可能值得引入)
- [与现有 DSH Web UI 的兼容性](#与现有-dsh-web-ui-的兼容性)
- [三条长期架构路线](#三条长期架构路线)
- [决策条件与验证标准](#决策条件与验证标准)
- [对既有研究的补充与修正](#对既有研究的补充与修正)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

## 长期结论

长期选型应按承担的职责，而不是按产品已经开发了多久来决定。“先不引入完整框架”不意味着“以后不该使用成熟依赖”；反过来，产品复杂了也不会自动产生采用其中一个框架的必要性。

| 长期需求 | 判断 | 原因 |
|---|---|---|
| 既有 SaaS 原来没有聊天层，目标是把已有业务交互带进 Agentic UI | **默认采用 assistant-ui 或自有聊天层，DSH 保留 Runtime/Session owner** | 既有 SaaS 不必迁移到 DSH 的 Web boot graph 和插件组合模型；assistant-ui 能提供聊天层能力，但业务 capability 和授权仍需自行建设。 |
| 既有 SaaS 只需要普通聊天、流式回复和少量 Tool card | assistant-ui 可以采用 | 这是 assistant-ui 的强项，但不等于它更适合复杂 Agentic UI。 |
| 产品就是 DSH Web 或 DSH 派生工作台，需要最大化 DSH Session/Tool/Conversation 兼容性 | 优先使用 DSH 原生 Web UI | 原生层直接消费 DSH 语义，现有问答、审批、Tool view 和 Conversation 扩展不需要重新映射。 |
| 多个业务模块需要一致的前端工具、HITL、状态同步和多 Agent 接入方式 | CopilotKit 值得评估，但要把生产接入方式纳入前置决策 | 其应用交互 API 和 AG-UI 集成可能减少跨团队胶水代码；同时与 DSH Tool、交互和续跑机制有更多职责交叉。 |
| 现有 DSH UI 已满足目标体验，业务主要需要少量受控表单和工具卡片 | 没有必须引入任何一个的理由 | 两个框架都不会自动解决业务授权、未知提交结果或浏览器接管；只增加适配层可能是净增成本。 |
| 只希望视觉更精致、主题更统一或布局更合理 | 先评估具体呈现组件，不必采用应用交互中台 | 设计系统、无障碍和布局问题不直接要求引入 AG-UI、第二套 Tool registry 或更多运行时。 |
| 同时需要 CopilotKit 交互层与 assistant-ui 呈现层 | 技术上可以研究，不作为默认目标 | 必须证明组合后的适配成本小于分别采用的收益，且只有一个权威 transcript 和续跑决策者。 |

对当前研究方向的建议是：**在“原来没有聊天层、但已有丰富 SaaS GUI”的前提下，默认采用 assistant-ui 或 SaaS 自有聊天层新增 Agentic UI，DSH 继续拥有 Browser-Native Agent Loop、Tool orchestration 和 Session 事实；只有 DSH-native 产品或愿意采用 DSH Client/Conversation/Slot 的 SaaS，才优先使用 DSH 原生 Web UI。** assistant-ui 不是业务 capability 的替代品；它的价值是承担成熟聊天层的通用产品职责并降低对 DSH Web UI 的绑定。CopilotKit 仍是深度 React 应用交互的条件性候选，不应仅因为聊天层尚未存在就一并引入。

-----

## PoC 后的直接重评

两套 PoC 证明它们不是两套 Agent：两者都使用 Browser-Native DSH Worker、真实 `ctx.agentLoop`、同源 LLM proxy、Session persistence 和相同的工具/多轮机制。差异是聊天层的事实投影、组件模型和接线成本。

| 判断 | DSH 原生 Web UI | assistant-ui External Store |
|---|---|---|
| 接入 DSH 事实 | 直接使用 DSH Client composition、Conversation、Tool view 和交互插件 | 通过 `dsh-client.ts` 与 `dsh-session-adapter.ts` 自建 read model 和命令适配 |
| PoC 证明 | 原生聊天层、工具、Session 和流式闭环 | 外部聊天层不复制 Loop/权威历史即可完成真实多轮、工具、流式、失败恢复和刷新续接 |
| 主要成本 | 学习 DSH 的 Slot、Conversation、Client composition 和插件约束 | 维护 DSH 事件到外部消息模型的映射、owner 生命周期、错误投影和功能缺口 |
| 主要优势 | DSH 语义最完整，原生 Tool/HITL/Session 能力更容易保留 | 更容易嵌入既有 SaaS 路由、React 树和设计系统，隔离 DSH UI 细节 |
| 主要限制 | 对外部 SaaS 的内部耦合较深，不是通用 SaaS 聊天 SDK | 当前只验证聊天层；附件、编辑、分支、复杂 HITL 和业务 action 仍需额外实现 |

因此，PoC 后不能再笼统地说“assistant-ui 更现代”或“DSH UI 一定更好”。在本研究的目标下，结论应当更尖锐：**对一般既有 SaaS，assistant-ui 是新增聊天层的默认候选；对 DSH-native 产品，DSH 原生聊天层是更自然的第一选择；CopilotKit 只在需要深度控制 React 应用状态和组件时进入候选。**三者都不能替代 typed business capability，也不能让模型直接拥有业务授权。

“DSH 语义完整性”不表示 assistant-ui 页面还要保留 DSH Web UI。若选择 assistant-ui，DSH Web UI 可以完全不挂载；当前增量 PoC 通过不实例化 `AppWebEntry`、排除 DSH UI entries 来实现单一可见聊天层。assistant-ui 负责渲染和 composer，DSH Worker/Session 负责执行和事实，这是 UI 与 Runtime 的分工，不是两个 UI 同时工作。

实际组合是三选一：既有 SaaS GUI + DSH 原生聊天层，既有 SaaS GUI + assistant-ui 聊天层，或既有 SaaS GUI + 自有聊天层；三者都接入同一个 DSH Runtime/Session。只有在不同页面或产品 profile 中明确提供不同入口时，才同时保留多个聊天实现。

对于已有丰富 GUI、但原来没有聊天层的 SaaS，推荐把 SaaS GUI 作为产品主体，并默认用 assistant-ui 新增聊天/Agentic UI 层：SaaS 页面和表单负责真实业务交互，assistant-ui 负责聊天呈现与通用交互，DSH Worker 负责 Loop 和 Session，后端负责授权和 receipt。assistant-ui 的外部嵌入优势不能消除 Agentic UI 语义适配成本，但能避免把这项业务工作与 DSH Web UI 的迁移绑定在一起。若产品明确要让 Agent 操作多个 React 表单和前端状态，再把 CopilotKit 作为应用交互层候选；若团队愿意采用 DSH Client/Conversation/Slot，则改选 DSH 原生 UI。

-----

## 材料处理与核查范围

来源材料是用户提供、评估日期为 2026-10-16 的离线对比文档。本文保留其中与 DSH、Agentic UI、前端运行时、框架职责和选型方法有关的内容；没有复制原文特定业务项目、供应商映射、项目排期、主观综合分或未经同口径验证的商业价格判断，也不把原文件或本机绝对路径存入仓库。

核查日期为 2026-10-16。证据包括双方官方文档、npm registry 的发布包元数据与类型声明，以及当前 `research` checkout 的 DSH 源码。下文区分“官方提供的能力”“发布包中的公开 API”“DSH 当前实现”和“建议的适配方案”。

| 发布包 | 本次 registry 查询结果 | 用途 |
|---|---|---|
| `@assistant-ui/react` | `0.15.29`，MIT；React/React DOM peer 为 `^18 || ^19` | 核查原文版本、许可标记及 UI 接口。 |
| `@assistant-ui/core` | 核查 `0.3.29` 发布包 | 检查 External Store callbacks 和工具注册声明。 |
| `@assistant-ui/react-ag-ui` | `0.0.70`；依赖 `@ag-ui/client: ^0.0.59` | 检查 AG-UI 状态、interrupt 和协议依赖。 |
| `@copilotkit/react-core` | `1.79.1`，MIT；React/React DOM peer 包含 React 18 和 19 | 核查 `v2/headless`、Provider 与 hooks。 |
| `@copilotkit/core` | 核查 `1.79.1` 发布包；使用 `@ag-ui/client: 1.0.2` | 检查 Agent 注册和运行接口。 |

这些版本是查询快照，不是推荐安装的兼容组合。尤其是两个 AG-UI adapter 所依赖的客户端版本不同，不能因为都标为 AG-UI 就假定可以共享同一个客户端对象或直接消除版本差异；需要锁定实际组合并验证协议字段和类型适配。

本次没有安装这些框架到 DSH，没有执行二者的集成 PoC、生产压测、无障碍审计或包体积比较。因此，“可以设计出适配方案”不等于“当前仓库已经兼容”，依赖数量和 npm 解包体积也不等于浏览器实际下载量。CopilotKit 的生产提示及续跑行为还检查了发布 JavaScript 实现，不能只由类型声明推导运行时行为。发布包与官方页面入口见 [Further Exploration](#further-exploration)。

-----

## 原文的事实核查与保留价值

原文最有价值的是把聊天体验、应用交互、运行时和后端协议分开比较，并强调组合框架时必须明确状态归属。需要补充的是若干容易被读成排他结论的能力分类；其中的社区采用信号也不能替代工程质量证据。

### 主要核查结果

| 原文命题 | 核查结论 | 对 DSH 研究的修正 |
|---|---|---|
| assistant-ui 的核心是 UI primitives、runtime 和可选 Cloud | 基本成立；官方架构明确分离呈现、状态适配、模型执行与存储 | UI runtime 不是 DSH Agent Loop 的同义词；使用 External Store 不要求迁移 Session 事实。 |
| assistant-ui 的前端工具偏自建/适配，HITL 偏 Cloud 和会话持久化叙事 | 能力描述不完整；官方工具文档有 frontend、human 和 external tool，human tool 通过渲染 UI 提交结果，并不以使用 Cloud 为前提 | 产品重点可以作定位判断，但不能由此推出复杂 Agentic UI 最终必须迁移到 CopilotKit；DSH adapter 仍要接入工具声明、结果和续跑。 |
| assistant-ui 的共享状态只能靠外部 store 自建 | 不完整；其 AG-UI adapter 已有 `useAgUiState`、`useAgUiSetState`，也有 interrupt 响应 API | 使用相应 adapter 时可以复用这些能力；状态更新仍不是业务授权或已提交事实。 |
| CopilotKit 把前端工具、HITL、Agent 状态和应用集成作为重要能力 | 成立；`useFrontendTool`、`useHumanInTheLoop` 和 shared state 有官方文档及发布声明 | 可以参考其接入 API，但不能把 hooks 当成脱离 Agent/provider 的独立 DSH 插件。 |
| CopilotKit 有 headless 接入方式 | 成立；当前发布包有 `@copilotkit/react-core/v2/headless` | headless 不等于无状态机、无 Agent 配置或零集成成本。`v2` 是 API 命名空间，不是 npm 包已经发布到 2.x。 |
| assistant-ui 也支持 AG-UI | 成立；存在公开的 AG-UI runtime 包及 Agent state、interrupt helpers | AG-UI 不是必须采用 CopilotKit UI 的理由；也不是 DSH Session format 的替代品。 |
| 两者开源包标 MIT，并可区分自托管核心与 Cloud | 对核查的包基本成立；但托管服务、Intelligence 和官方支持路径仍需单独核查 | 不能进一步推导所有接入方式均按相同条件投入生产；CopilotKit 的生产 self-managed 路径不能用开发入口替代。 |
| 社区星数、issues、下载量可以提供采用信号 | 只能辅助判断；不同包、第三方下载统计和原始 issue 数不提供同规模质量比较 | 不收录易变计数和主观评分，不把 issues 多或少当作缺陷率。 |
| 两者提供多个端或频道的扩展入口 | 官方入口不等于各端已有相同特性和成熟度 | 当前 DSH 评估只针对浏览器 React，其他端需要独立验收。 |

上述事实分别依据 [assistant-ui Architecture](https://www.assistant-ui.com/docs/architecture)、[工具定义](https://www.assistant-ui.com/docs/tools/defining-tools)、[AG-UI Agent state](https://www.assistant-ui.com/docs/runtimes/ag-ui/agent-state)、[CopilotKit Frontend Tools](https://docs.copilotkit.ai/reference/hooks/useFrontendTool)、[HITL](https://docs.copilotkit.ai/reference/hooks/useHumanInTheLoop) 和 [Self-Managed Agents](https://docs.copilotkit.ai/backend/self-managed-agents)。

### 两项对未来选型特别重要的细节

assistant-ui 当前推荐 toolkit 注册方式，其较旧的 `useAssistantTool` 声明已经标注迁移方向。官方的 `"use generative"` 示例还包含构建插件和服务端工具导出；这不是 DSH 仅接入呈现层时必须一并引入的系统。DSH 已拥有并执行的工具可以先采用外部执行工具的呈现方式，但具体选用哪种公开接口仍需锁版本验证。

其 AG-UI state setter 也是先乐观更新本地状态，再随下一次 run 发送，并不是向正在运行的 Agent 实时写入。不同框架即使都使用“shared state”一词，也不能跳过写回时机和日志记录规则的核查。

CopilotKit 官方 Self-Managed Agents 文档展示通过 `selfManagedAgents` 接入自有 Agent，生产使用被列为 Intelligence Enterprise 能力。发布 Provider 在未提供 public license key 时发出生产许可提醒；这个提示不等同于缺 key 就不能实例化 Agent。发布包也同时存在 `agents__unsafe_dev_only`；底层 Core 的该入口明确用于开发，不能据此把生产直连设计为“无须任何支持或许可条件”。这里记录的是官方产品与支持路径，不对所有 MIT 代码的可使用范围作法律推断，也不意味着自托管开源 CopilotRuntime 本身必须采用该商业路径。

发布 Core 的 `processAgentResult` 可以执行已注册的前端工具，并在需要时启动 follow-up run；公开的 Tool 配置还有 `followUp` 选项。因此，`selfManagedAgents` 不能被理解为自动关闭 CopilotKit 的工具处理或续跑。自定义 `AbstractAgent` 到 Worker 的接线可以作为候选方案，不要求把 Loop 移到服务器，但仍需明确如何把工具响应交给同一个 DSH 执行过程，而不是独立再次运行 Agent。

### 保留的评估方法

保留原文“用同一个业务故事做横向验证”的方法，不保留固定天数承诺。比较应覆盖同一组输入、工具结果、用户确认、历史恢复、设计系统和性能测量，而不是分别展示各框架最漂亮的示例。

比较对象也不应只有框架 A 与框架 B，而应包含“继续使用 DSH 当前 UI”。只有这样，才能判断新增依赖是否真正减少长期维护，而不是把本来已经具备的能力又实现一次。

-----

## Browser-Native DSH 与前端框架的分层

Browser-Native 决定 Agent Loop 的运行位置，不决定 React 组件由谁提供。长期架构需要分别确定执行、事实记录、业务提交和界面状态的拥有者。

```text
SaaS Main Thread
  业务组件、设计系统、页面临时状态
  聊天呈现：DSH UI 或 assistant-ui 或 CopilotKit UI
  DSH view adapter / 必要时的 AG-UI adapter
              ↕ 有版本的命令与事件
Dedicated Worker
  DSH Host + ctx.agentLoop + Tool lifecycle + Session projection
              ↕ 同源受限 API
SaaS Backend
  身份、租户、业务授权、幂等提交、receipt、持久化、LLM secret
```

这是建议的职责分配，不是当前仓库已存在的通用第三方框架 adapter。现有 Browser-Native PoC 已验证 Worker 内的真实 DSH Loop、现有 Web UI 和远程 provider，但还没有验证 assistant-ui/CopilotKit、通用业务 capability 或完整 handoff，见 [PoC 当前实现](browser-native-dsh-poc/README.md#当前实现快照)。

### 允许多个 read model，不允许多个权威提交者

DSH Client model、assistant-ui runtime 或 CopilotKit Agent 对象都可能维护供 UI 读取的状态副本。存在多个 JavaScript store 本身不是错误；关键是它们能否由同一份权威事件恢复，以及用户命令最终由谁执行。

推荐保持以下归属：DSH Session 记录可重建的模型输入与执行事实；业务后端决定授权、资源状态和提交 receipt；第三方 UI runtime 维护 composer、选中线程及必要的派生状态。不能让一个前端 store 在脱离 DSH Session 的情况下成为另一份模型历史，也不能把共享 state 的乐观更新当成业务成功。

“唯一续跑决策者”也不意味着所有按钮都必须只调用 DSH 的 React 组件。外部 UI 可以发送用户意图或工具响应，但一次响应何时结束等待、何时触发下一个模型请求，必须经过同一套 DSH 执行规则。不能在 DSH 已经处理 Tool result 后，再由外部 runtime 独立启动同一轮推理。

### DSH UI 不是不可替换的整体

当前 Web Client 已将 `session-controller`、`ui-session`、`ui-conversation`、`ui-slots` 和 React renderer 分开，见 [Web Client architecture](../subsystems/web-client.md)。但这种内部插件分层不等于现成的、框架无关的 SaaS SDK；换用外部 UI 仍需明确导出 read model、命令、错误和生命周期。

因此，“采用 DSH Runtime”“复用 DSH Client model”“复用 DSH 全部 Web UI”是三个不同的选择。未来可以保留前两者、替换聊天呈现，也可以在 SaaS 外壳中只接入较窄的 DSH facade；没有必要把整套 DSH 工作台 UI 一起嵌入 SaaS。

-----

## 未来为什么可能值得引入

第三方的长期价值不是“比我们多一个聊天框”，而是有机会让维护工作集中在业务能力与 Agent 行为，而不是持续拥有通用聊天交互的全部实现。

### assistant-ui：较窄的聊天体验专业化

当线程、消息、附件、工具卡片、编辑/重生成、滚动、键盘操作和多模态交互成为持续产品需求时，统一的 primitives 与 runtime 接口可能降低前端重复实现成本。External Store 提供把已有会话状态映射到组件的正式路径，并不要求改用它的本地 Loop 或 Cloud 存储。

这使 assistant-ui 成为一个合理的长期候选，而不是只适合 MVP 的过渡品。其价值需要由实际界面质量、维护删除量和故障恢复验证；官方提供无障碍 primitives 或虚拟化指南，不代表 DSH 业务卡片自动通过无障碍与长会话测试。

代价是它不是完全无状态的按钮集合。组件依赖 runtime 语义；Tool UI、附件、线程操作、分支和运行状态都要正确映射。若只为了替换少量气泡，却长期同时维护 DSH Chat model 与外部 message model 的复杂转换，收益可能不足。

### CopilotKit：更广的应用交互标准化

当多个团队需要一致的前端工具注册、用户确认、共享 Agent state、生成式 UI 或多个 Agent backend 的接入方式时，CopilotKit 的应用侧 API 与协议生态可能比每个业务插件各写一套更有价值。这是长期架构收益，不只是快速原型收益。

代价是它更接近 DSH 当前也承担的 Tool orchestration、pending interaction、Agent run 和恢复职责。必须决定哪些应用接入机制由 CopilotKit 管理，哪些 DSH 接口保留为执行与记录依据，而不是两套注册、两套等待和两套自动续跑并存。

仅为了更精美的聊天视觉而引入 CopilotKit 的完整应用交互体系，往往范围过大；为了统一多业务模块的 Agent 接入而引入，则不必然是“小题大做”。同样，assistant-ui 已有相关工具和状态能力，不能仅因业务会操作页面就排除它。

### 前端架构更合理，首先来自可替换的适配职责

无论采用哪一个，都应把业务 capability 描述、业务 state 选择、用户确认、执行授权和 receipt 独立于具体聊天组件。一个表单不应分别为 DSH、assistant-ui 和 CopilotKit 维护三套语义不同的业务提交逻辑。

前端架构改进可以由这种分离获得；框架只是其消费方之一。若反过来让业务组件普遍依赖某个 Agent Provider 的内部消息格式和自动执行规则，框架可能增加耦合，而不是改善架构。

这也符合仓库[优先维护良好依赖的原则](../../.agents/notes/implemented/process/2026-07-26-dependencies-over-hand-rolling.md)：真正替换并减少已拥有的实现、测试和接口是一种简化；新增更强能力可以是合理的产品投资，但不能把纯粹增加依赖称为已经减少了维护。

-----

## 与现有 DSH Web UI 的兼容性

没有发现 React 版本层面的必然冲突，但存在需要设计和验证的状态、生命周期与交互语义差异。这里的“可以兼容”指有明确适配方案，不是当前 checkout 已经集成通过。

| 事项 | 当前证据或差异 | 处理方式 |
|---|---|---|
| React 与渲染环境 | DSH `apps/web`、`ui-renderer` 声明 React 18；两个评估版本的 peer 范围均包含 React 18 | 共享同一个 React/React DOM 实例；检查 lockfile、bundle 和 Provider 的挂载位置，不能只靠 peer 范围宣布通过。 |
| Provider 与 DSH Slot | DSH renderer 拥有 React context 和 Slot 生命周期，外部组件还需要自己的 runtime context | 将外部面板作为明确的子树，或替换对应呈现层；没有理由仅因多一个 Provider 就判定不可兼容。 |
| 数据模型 | DSH 是 Session events → Conversation Context/Node → target snapshot；外部聊天模型以 thread/message/part 或 AG-UI events 为主 | 按稳定 id 和事件关联做投影，保留 Tool call、interaction、错误和业务 Node；不能把整个 Session 简化成 role/content 数组。 |
| 编辑、重生成与分支 | DSH Session 是追加事件；外部 UI 可能提供编辑或删除显示消息的 API | 映射到真实支持的 fork/新输入语义，或禁用对应操作；不得让 UI 修改成为重写历史 Session 的隐式行为。 |
| 前端 Tool/HITL | DSH 已有工具生命周期、问答、审批和 pending interaction；外部框架也能执行工具与提交结果 | 每个 capability 选择一个执行入口与续跑规则，另一方负责呈现或转发；回放只重建 UI，不重新执行 handler。 |
| Run 与 turn | DSH 一个 turn 可以包含多个模型 step；外部框架的 run 和 follow-up 有独立生命周期 | 明确 run id、turn id、Tool call id 与等待响应的映射，不能按同名 API 假定一一对应。 |
| 流式更新与重连 | DSH 有 baseline/generation 更换、分页和 live/durable 合并；外部库有自己的 running、interrupt 与 message 状态 | 建立一次 generation 更换时的整体重建规则，保留稳定身份，不把重放片段再次追加成新消息。 |
| 动态注册与卸载 | DSH plugin、Slot 与外部 hook 各有挂载和清理机制 | 统一 capability 生命周期；React StrictMode、路由切换和插件卸载不能制造重复工具或遗留等待者。 |
| 样式、Portal 与焦点 | 外部 UI 可能有主题、CSS、弹层和快捷键，DSH 已有 tokens、locale 和 modal layer | 明确主题作用域、全局样式、层级、焦点恢复和按键处理顺序；headless 不能免除这些验证。 |
| 模型可见 state | 两者都能提供状态同步，但 DSH 要求模型输入可由日志重建 | 只转发 schema 约束的 observation，先记录需要进入模型的事实；不能在 UI hook 中临时追加未记录的模型上下文。 |
| 生产运行位置 | CopilotKit 默认 Runtime 接入和 self-managed Agent 是不同路径；DSH 的既定 Loop 在 Worker | 选择有明确支持方式的 Worker bridge；不能为方便跑通示例，悄悄改成服务器或云端的另一套 Agent Loop。 |

上述 DSH 事实的代码入口包括 [Tool view props](../../packages/client/ui-tool/src/client/contract/slots.ts)、[Conversation definitions](../../packages/client/ui-conversation/src/client/contract/conversation.ts)、[Session Client](../../packages/api/session-controller/src/client/sessions/session.ts)、[Session manager fork](../../packages/api/session-controller/src/client/sessions/manager.ts) 和[问答交互插件](../../packages/client/ui-user-questions/src/client/index.ts)。这些机制是适配时必须保留的语义，不要求第三方 UI 复制它们的内部实现。

-----

## 三条长期架构路线

三条路线可以分别成立。选择应限定一个可替换的界面或交互职责，不应默认把两个完整框架同时放进每个 DSH 会话。

### 路线一：保留 DSH 原生聊天层，局部扩展

SaaS 把 DSH 原生 Web UI 作为聊天呈现层，沿用 DSH `ui-session`、Conversation 与 Slot 路径，以现有 Tool view 或业务 Node 承载 Agentic UI。既有 SaaS 业务页面仍是产品 GUI，业务 capability 经 typed facade 进入 Worker 与后端。

适合产品愿意采用 DSH Client/Conversation/Slot 体系，或当前 UI 体验已经符合长期聊天目标的情况。它不是落后的方案；但不能因为当前实现存在，就假定持续自有全部聊天交互永远更便宜。

### 路线二：assistant-ui 接管聊天呈现

建议先验证 `useExternalStoreRuntime`，将 DSH 的只读会话投影、running 状态和明确的 commands 适配到 assistant-ui；不先引入新的 AI SDK 模型执行路径、Cloud 历史或 AG-UI 协议。

```text
assistant-ui primitives + ExternalStoreRuntime
  messages / parts / running ← DSH view projection
  onNew / onCancel / tool response → DSH command adapter
                                      ↕
                              Worker 中的 DSH Loop
```

External Store 的 `onNew`、`onCancel`、`onEdit`、`onReload` 等是不同能力入口，不能用一个通用“更新 messages”回调替代。初版 adapter 只暴露真正支持的操作；编辑、分支、附件和工具响应逐项验收，不从框架默认按钮反推 DSH 必须改变的行为。

对于已有 DSH 工具，先复用执行结果与业务组件，而不是重新注册一套独立可执行工具。业务组件可以保持框架无关，由薄的 Tool UI wrapper 适配所需 props。若需要保留 DSH 的特殊 Conversation Node，可作为独立业务区域或明确的自定义 part 呈现，不能静默丢失。

这条路线与 Browser-Native 没有运行位置上的必然冲突，且比新增 Agent/UI 协议的改动范围更窄。长期收益必须体现为某些旧呈现实现可以退出维护，而不是在同一面板中永远保留两个同等复杂的渲染体系。

### 路线三：CopilotKit 管理应用交互，DSH 保留执行与事实

候选设计是把 CopilotKit 连接到一个代表 DSH Worker 的 AG-UI Agent adapter；应用工具、用户响应和状态更新由 adapter 转入 DSH 的 capability 与 Session 规则。自定义 `AbstractAgent` 通过 `MessageChannel` 等方式连接 Worker 是设计候选，不是当前已有实现。

```text
CopilotKit UI / headless application hooks
              ↕
AG-UI Agent adapter + DSH command / event mapping
              ↕
       Worker 中的 DSH Loop
```

正式评估必须同时回答：采用何种受支持的 Agent 注册方式；生产 self-managed 条件是否可接受；谁执行前端 Tool；用户响应何时写入 Session；谁驱动后续模型请求；刷新后如何恢复 pending interaction。发布实现中的工具处理、`followUp` 和恢复重放策略必须列入实现任务，不能假定自有 Agent 会自动绕过它们。

若选择自托管 CopilotRuntime，也不意味着 DSH Loop 必须搬到服务器，但需要解释 Runtime 怎样将一次执行路由到正确的活跃 Worker，以及页面断开时的行为。当前仓库没有验证这条拓扑；普通服务器 Agent quickstart 不能作为它的完成证据。

仅为了复用 AG-UI 事件规范，并不需要把 CopilotKit UI、线程存储和所有工具执行机制一起采用。可以单独评估 AG-UI adapter，再决定由 DSH UI、assistant-ui 或 CopilotKit UI 消费它。

### 同时引入两个框架的限制

CopilotKit headless 与 assistant-ui 呈现层组合在职责上可以成立，但需要额外的状态与命令适配，并处理当前依赖的 AG-UI 版本差异。不能把两套 Provider 嵌套成功当作组合完成。

在同一个交互面板中，若两个框架分别拥有权威线程历史、独立执行同一 Tool call 或各自作续跑决策，该组合应被否决。只有在一方是明确的交互适配层、另一方只是可重建的呈现消费方，并且实际净收益优于单框架方案时，才值得保留。

-----

## 决策条件与验证标准

未来是否采用，不应只由“已经成熟了”“生态很热”或“看起来功能更多”触发，而应由可交付的长期能力与维护成本变化触发。

### 采用之前必须写清的四件事

1. **要获得什么。** 列出具体的用户体验或团队接入能力，不用“更现代”代替需求。例如长历史键盘导航、统一工具卡片交互、多个业务团队的前端能力声明。
2. **要退出维护什么。** 区分确定可替换的实现、仍需 DSH 保留的语义和纯新增能力；不能把未来希望删除的代码算成已实现的收益。
3. **要增加什么。** 估计 adapter、上游升级、协议版本、许可/服务条件、主题适配和产品级回归成本；不要用 npm 依赖个数代替这些成本。
4. **怎样退出。** capability 与命令不要只能由某个 UI Provider 调用；保留让原 UI 或另一个 UI 接管的可验证途径。

### 同一业务故事的验收矩阵

建议比较“现有 DSH UI”“assistant-ui External Store”“CopilotKit 的拟采用生产路径”三种实现，使用相同的受控业务故事：读取业务状态 → 打开既有表单 → 修改并确认 → 后端授权提交 → 回传 receipt → Agent 继续。

| 验证范围 | 至少需要观察到什么 |
|---|---|
| 执行归属 | 模型请求和 Tool orchestration 仍由 Worker 内一个 DSH Loop 驱动；外部框架不启动隐含的第二套 Agent。 |
| 事实归属 | UI 显示的 committed/unknown 和模型后续所见，可由 DSH Session 与业务 receipt 重建。 |
| 工具闭环 | 一次用户响应只完成一次 pending interaction；重放、StrictMode 和组件重新挂载不触发新的业务提交。 |
| 授权与副作用 | 重复点击、授权拒绝、旧 state version、服务端已提交但响应丢失均有明确结果；不能自动重试 unknown。 |
| 恢复 | 页面刷新、Worker 重启、baseline 更换和历史分页后，没有重复消息、重复 Tool result 或遗失的业务 Node。 |
| 会话操作 | 发送、取消、队列、编辑、fork、附件等只展示已实现并验证的能力；跨线程操作不会误投递。 |
| UI/UX | 中文/英文、键盘、读屏、焦点恢复、Portal 层级、触摸与缩放在真实业务组件中验证。 |
| 性能与体积 | 使用相同会话数据和设备，测量首屏、实际压缩 chunk、流式更新、长历史滚动、内存与昂贵业务组件；不作未测的优劣排名。 |
| 生产接入 | 不使用开发专用 Agent 注册入口替代正式方案；核实网络目的地、遥测设置、数据发送范围、许可和支持条件。 |
| 维护与退出 | 记录可删除实现、残余 adapter 和升级回归范围；能切换 UI 而不更改业务授权与提交规则。 |

只有这些结果表明“获得目标体验或开发体验，且总成本可接受”，才应该决定采用。若仅新增了一套消息模型和转换测试，却没有减少任何重复职责或带来需要的能力，应继续使用现有 UI。

-----

## 对既有研究的补充与修正

本文补充的是长期架构选择，不推翻现有 DSH UI 已具备的工程资产，也不把第三方框架视为业务 capability 缺口的自动解决方案。

- [Web UI 质量与框架选型评估](dsh-web-ui-quality-and-agentic-ui-framework-assessment.md)中的“先改造 DSH”限定为当前实施优先级，而非永久保留所有现有呈现代码的决定；长期允许用成熟组件替换明确的 UI 职责。
- assistant-ui 的定位补充 frontend/human tools 与 AG-UI state 能力，避免把它描述成无法承载应用交互的纯聊天皮肤。
- CopilotKit 的候选方案补充 self-managed 生产路径、许可/支持条件及自动续跑控制，不再把公开 hook 列表当作 Browser-Native DSH 已有完整集成。
- 保留“不要重复拥有 Loop、权威历史和业务提交”的结论，但允许外部 UI runtime 与 DSH model 维护可重建的状态副本；这不是必须消灭所有前端 store 的要求。

-----

## Further Exploration

### 项目内研究与代码

- [DSH Web UI 质量与框架选型评估](dsh-web-ui-quality-and-agentic-ui-framework-assessment.md)：当前实现质量与工程证据。
- [Browser-Native Agentic UI 综合报告](dsh-browser-native-agentic-ui-research.md)：业务 capability、Session、授权、receipt 与 handoff。
- [研究目录导读](README.md)：完整阅读路径。
- [Browser-Native PoC](browser-native-dsh-poc/README.md)：已验证范围与恢复限制。
- [Web Client architecture](../subsystems/web-client.md)、[Conversation](../subsystems/conversation.md)、[Slots](../subsystems/slots.md)：DSH 当前分层与内部扩展规则。

### 官方文档

- [assistant-ui Architecture](https://www.assistant-ui.com/docs/architecture)：呈现、runtime、后端和存储职责。
- [External Store Runtime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)：已有状态接入与 callbacks。
- [Defining Tools](https://www.assistant-ui.com/docs/tools/defining-tools)、[Tool UI](https://www.assistant-ui.com/docs/tools/tool-ui)：frontend、human、external tool 和交互呈现。
- [Toolkit migration](https://www.assistant-ui.com/docs/migrations/toolkit-tools)：旧工具 hooks 的迁移方向。
- [AG-UI overview](https://www.assistant-ui.com/docs/runtimes/ag-ui/overview)、[Agent state](https://www.assistant-ui.com/docs/runtimes/ag-ui/agent-state)：状态与协议适配。
- [Thread Virtualization](https://www.assistant-ui.com/docs/guides/virtualization)：长线程呈现的可选集成方式，不是 DSH 性能验证。
- [CopilotKit Headless](https://docs.copilotkit.ai/headless)、[Frontend Tools](https://docs.copilotkit.ai/reference/hooks/useFrontendTool)、[HITL](https://docs.copilotkit.ai/reference/hooks/useHumanInTheLoop)：应用侧接入 API。
- [CopilotKit Shared State](https://docs.copilotkit.ai/shared-state)：Agent 与 UI 的共享状态。
- [CopilotKit Self-Managed Agents](https://docs.copilotkit.ai/backend/self-managed-agents)：生产接入条件与开发入口区别；工具处理和续跑仍需结合发布实现检查。

### 本次检查的发布包

- [assistant-ui React 0.15.29](https://registry.npmjs.org/@assistant-ui/react/0.15.29)、[Core 0.3.29](https://registry.npmjs.org/@assistant-ui/core/0.3.29)、[AG-UI adapter 0.0.70](https://registry.npmjs.org/@assistant-ui/react-ag-ui/0.0.70)：元数据包含版本、peer、依赖及发布 tarball 地址；上述接口声明按这些 tarball 核查。
- [CopilotKit React Core 1.79.1](https://registry.npmjs.org/@copilotkit/react-core/1.79.1)、[Core 1.79.1](https://registry.npmjs.org/@copilotkit/core/1.79.1)：核查 Provider、headless、Agent 注册与运行声明。`selfManagedAgents` 位于 React Provider；底层 Core 的开发入口不能与其混为一谈。

## Dev Note

本文是 2026-10-18 的研究草稿，不是已实施的选型决策或生产兼容性承诺。它完成离线材料提炼、官方事实与发布 API 核查、DSH 源码映射、两套 Browser-Native PoC 的结果对照和候选架构分析；assistant-ui PoC 已通过其记录的真实浏览器与真实模型验收，但没有验证完整业务 capability 闭环。后续若进入实施，应锁定版本、确认生产接入方式，并由同一业务验收矩阵决定保留或退出哪一层 UI 实现。
