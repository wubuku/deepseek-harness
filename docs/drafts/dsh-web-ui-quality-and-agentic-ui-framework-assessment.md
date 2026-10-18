---
description: "DSH 当前 Web UI 的实现质量、Agentic UI 适配能力和第三方框架选型评估，基于源码、测试、Browser-Native PoC 与官方生态资料。"
---

# DSH Web UI 实现质量与 Agentic UI 框架选型评估

## Summary

本文比较 DSH 原生 Web UI、assistant-ui 和 CopilotKit 三条新增聊天/Agentic UI 路线。产品前提是 SaaS 已有成熟业务 GUI，但原来没有聊天层；目标是把既有业务交互带入 Agent 界面，而不是只增加消息气泡。

**对于题设的成熟 React SaaS，以 assistant-ui + Browser-Native DSH 作为复用既有 React 业务组件的优先评估基线；需要更多应用交互设施时，CopilotKit 是强候选。**新增同口径实验已让三条路线完成相同业务闭环，因此撤销“只有 CopilotKit 做过业务 demo，所以自动首选”的论据。它没有测出生产总成本或证明 assistant-ui 全面胜出；DSH 原生 UI 更适合愿意采用其 Client/工作区装配体系的产品。理由和能力验证范围见[路线重评](#三份-poc-后的路线重评)。

CopilotKit 使用 `1.79.1` 的 `/v2` API；业务闭环通过 `useRenderTool` 与自写页面桥实现，不证明其原生前端工具调度已验收。新实验已补入精确调用身份、持久化 mock API 和业务幂等回归，但生产 Agent 注入、真实认证/授权、跨进程幂等与未知提交恢复仍未解决，详见[实际收益与自有代码](#copilotkit-实际省了什么仍需自写什么)及[同口径测试记录](saas-agentic-ui-comparison-poc/test-results.md)。

这里的“已有 SaaS GUI”与“聊天层”是两件不同的事：前者是已经存在的业务页面、表单、组件、路由和业务操作；后者是现在才新增的 Agent 入口。本文比较的是新增的这一层，不建议为了加入 Agent 而替换整个 SaaS GUI，也不建议第一版同时挂载多套面向用户的聊天层。无论选 DSH 原生 Web UI、assistant-ui 还是 CopilotKit，都应保留 SaaS 的业务页面和 DSH Worker、Agent Loop、Session 与后端职责。

## Table of Contents

- [结论先行](#结论先行)
- [前提澄清：已有业务 GUI 不等于聊天层](#前提澄清已有业务-gui-不等于聊天层)
- [结论修订：DSH 原生 UI 不是所有 SaaS 的默认答案](#结论修订dsh-原生-ui-不是所有-saas-的默认答案)
- [评估方法与证据边界](#评估方法与证据边界)
- [三份 PoC 后的路线重评](#三份-poc-后的路线重评)
- [CopilotKit 实际省了什么，仍需自写什么](#copilotkit-实际省了什么仍需自写什么)
- [当前官方能力与 PoC 版本边界](#当前官方能力与-poc-版本边界)
- [同口径业务验收与改选条件](#同口径业务验收与改选条件)
- [DSH Web UI 的扩展性：强在哪里，弱在哪里](#dsh-web-ui-的扩展性强在哪里弱在哪里)
- [当前 Web UI 的实现质量](#当前-web-ui-的实现质量)
- [Agentic UI 的适配程度](#agentic-ui-的适配程度)
- [第三方框架的职责比较](#第三方框架的职责比较)
- [按产品场景选择集成位置](#按产品场景选择集成位置)
- [推荐的改造路线](#推荐的改造路线)
- [对既有报告的修订](#对既有报告的修订)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

## 三份 PoC 后的路线重评

2026-10-19 增加的[三路线同口径 SaaS 实验](saas-agentic-ui-comparison-poc/README.md)改变了此前比较的证据基础：原生 DSH UI、assistant-ui 和 CopilotKit 已能在相同 DSH Loop 上复用相同任务、工单与账单组件/API，而不只是 CopilotKit 有业务 demo。**如果目标是把既有 React 业务组件放入新增助手，并保留 DSH 执行与 Session，assistant-ui 现在更适合作为轻量接入的优先评估基线；CopilotKit 是需要其额外应用交互设施时的强候选，不能再凭“唯一做过 SaaS 闭环”直接胜出。**这不是生产定案，也不要求同时挂载多个聊天层；具体判断及未覆盖能力见[实验设计与评估](saas-agentic-ui-comparison-poc/design-and-assessment.md)。

下面表格描述原三份独立 PoC 的范围，不能当作新同口径实验的能力排名。原三份 PoC 的任务不等价，只有原 CopilotKit 目录加入过 SaaS 操作；这解释了此前为什么优先继续 CopilotKit，却不证明框架本身更能复用业务组件。新实验和[测试记录](saas-agentic-ui-comparison-poc/test-results.md)提供共同业务 API、表单、十轮输入、取消、权限拒绝、短期记忆与刷新对照。

| PoC | 可见聊天层与 DSH 所有权 | 实际验证的 UI 闭环 | 没有验证的关键点 |
|---|---|---|---|
| [Browser-Native DSH PoC](browser-native-dsh-poc/README.md) | DSH 原生 Web UI；真实 DSH Worker/Host、`ctx.agentLoop` 和 Session | DSH 自身聊天、工具事件、模型流式与 Session 持久化/恢复 | 没有既有 SaaS 工作台、业务表单或 SaaS action 接入；证明的是 Runtime 基线，不是成熟 SaaS 的聊天嵌入成本 |
| [assistant-ui 增量 PoC](assistant-ui-browser-native-dsh-poc/README.md) | assistant-ui 是唯一聊天层；DSH Worker 和 Session 仍是执行/事实所有者 | External Store 消费 DSH 历史与流式事件，提交用户输入，呈现工具交互并验证同一 Session 的恢复 | 没有把 SaaS 页面数据、现成业务表单或业务 action 带入聊天；证明外部聊天层可接入 DSH，不证明 assistant-ui 的新 Interactables/生成式 UI 已接入 DSH |
| [CopilotKit 增量 PoC](copilotkit-browser-native-dsh-poc/README.md) | CopilotKit 是唯一聊天与应用交互层；DSH Worker/Loop/Session 保持权威 | 一个 mock 工作台状态进入 Agent 上下文；聊天表单允许改字段并确认/取消；结果回到原 DSH tool call/result，列表同步变化 | 仅一个本地 mock action；不含生产 SaaS API、身份授权、后端幂等账本、receipt、unknown recovery 或多租户验证；已用 `1.79.1` 的 `/v2` API，但通过开发期 Agent 注入和自有页面工具桥接 |

原三份 PoC 曾支持优先深化 CopilotKit，理由是它先完成过业务闭环，而不是“CopilotKit 一定更强”。新同口径实验中三条路线都已完成业务状态读取、聊天内编辑/确认和原 DSH turn/result 闭环，因此“唯一实际验证过”不再成立。生产框架仍应按新增交互设施的收益、已有 adapter 的维护成本和复杂业务组件适配判断。

assistant-ui 不能被描述成“只适合普通聊天”。新实验通过固定版本的 ToolCall component 复用同一业务表单、原始 tool-call 身份和业务 API；这并不等于额外验证了 Interactables 等所有能力。DSH 原生 UI 对 DSH-native 产品仍是直接的语义集成路线；对不愿迁移至 DSH Client composition 的成熟 SaaS，则需要证明其嵌入与主题成本低于外部聊天层 adapter。

此前最不推荐 CopilotKit 的主要依据是潜在的双 Loop、工具续跑死锁和额外消息权威。这些风险仍应测试，但现有实现已证明可以保留同一 DSH Loop/Session，用页面工具桥在原 DSH turn 结束前结算等待者。因此，“机制有重叠”不再足以否定这条路线。反过来，“CopilotKit 跑通了”也不能证明它比 assistant-ui 更省代码：前两份 PoC 没有实现相同的业务场景，无法给出公平的成本排名。

## CopilotKit 实际省了什么，仍需自写什么

代码层面的证据比框架定位更窄。页面直接从 `@copilotkit/react-core/v2` 导入官方聊天、Provider 和工具 renderer；它没有运行 CopilotKit BuiltInAgent。不过，工作项操作和问答不是交给 CopilotKit 的原生工具调度器自动执行：

| 职责 | 当前实际承担者 | 对选型的含义 |
|---|---|---|
| 聊天、流式消息、输入/停止控件、工具 renderer 挂载 | [main.tsx](copilotkit-browser-native-dsh-poc/src/main.tsx) 中的 CopilotKit 官方组件与 `useRenderTool` | 框架有可复用的交互容器价值，但排版、业务表单和产品主题仍由应用实现 |
| 模型执行、工具声明、工具结果和历史 | DSH Worker、插件和 Session；[DshAgUiAgent](copilotkit-browser-native-dsh-poc/src/dsh-agui-agent.ts) 做 AG-UI 投影 | 没有第二个模型循环；消息转换、hydration 和停止协调仍需自有 adapter |
| 页面读取、创建工作项、问答等待与结算 | [Worker 工具插件](copilotkit-browser-native-dsh-poc/src/copilotkit-browser-native-tools.ts)、[页面桥](copilotkit-browser-native-dsh-poc/src/dsh-client.ts) 与 React 表单回调 | 当前闭环靠自写 MessagePort/waiter 桥接，不能宣称原生 `useFrontendTool`/`useHumanInTheLoop` 全流程已验收 |
| 已有业务组件复用 | 新写的 mock 工作台与操作卡复用字段和 `WorkItemSummary` | 证明可实现这一交互形态；没有证明真实成熟 SaaS 的复杂表单可低成本迁移 |

`useFrontendTool` 仅注册了 `browser_native_ui_probe`；留存的真实模型 E2E 没有调用该 probe。业务工具用 `client.frontendTools.register()` 执行，`ask_user_question` 经 DSH 问答服务的事件 listener 回到页面，使用 `useRenderTool` 展示后直接结算 DSH waiter。当前没有采用分段 AG-UI run，也没有证实“CopilotKit 原生 handler 执行结果自动回到同一个 DSH turn”的路径；不能把这条未验收路径写成框架收益。

因此，上调 CopilotKit 的依据是目标匹配和现成可深化的业务闭环，不是“已经证明它的工具编排更好”或“自动把 SaaS 页面变成 Agentic UI”。若产品最终仅使用聊天和被动工具 renderer，而所有应用交互、等待、状态注入都继续自写，则 CopilotKit 的额外复杂度未必值得；assistant-ui 的 custom Tool UI 加同一 DSH bridge 完全应当参加对照，而不是被预先排除。

原独立 CopilotKit PoC 仍有这些生产风险：Provider 使用 `agents__unsafe_dev_only`，结果回送有 `resolveLatest`/`rejectLatest` fallback，业务提交先更新浏览器 mock。新对照实验没有沿用按工具名结算的 fallback，补入精确调用桥、服务端 mock API、幂等账本、receipt 与相关单测；它不回写替换原独立 PoC。Provider 注入方式和业务提交/Session 结果之间的自动对账仍未生产化，不能把局部改进描述成所有代码和并发路径均已解决。

### 当前官方能力与 PoC 版本边界

官方文档持续演进，不能把线上新能力当成固定版本 PoC 已有的能力。assistant-ui 的 [Interactables](https://www.assistant-ui.com/docs/api-reference/tools/interactables) 标为实验性，另有 [Tool UI](https://www.assistant-ui.com/docs/tools/tool-ui) 和 [Generative UI](https://www.assistant-ui.com/docs/tools/generative-ui)；本地 PoC 固定 `@assistant-ui/react@0.15.29`，没有接入它们的业务状态闭环。CopilotKit PoC 的 lockfile 固定 `@copilotkit/react-core@1.79.1` 和 `@ag-ui/client@1.0.2`，且源码明确使用 `@copilotkit/react-core/v2`。npm 包版本 `1.79.1` 不等于采用 v1 API；“尚未升级到 v2”是错误判断。

下一步的技术准入条件不是重做一个笼统的“v2 迁移”，而是确定受支持的生产 Agent 注入方式和许可/支持条件；评估是否需要、以及能否安全复用原生前端工具调度；对精确调用身份、停止、晚到结果、刷新和 pending interaction 补齐单测及故障测试。如果只能靠第二个 Loop 或第二份权威历史才能获得某项框架功能，就放弃该接法。以同一真实组件、API 和故障矩阵比较 assistant-ui，若它用更少自有桥接实现相同体验，就应改选；无需为了维持此前推荐而保留 CopilotKit。

原三份独立 PoC 没有业务后端；新同口径实验新增了持久化 mock API、模拟角色、版本控制和 operation receipt。它仍没有真实身份/租户授权、生产事务、跨进程幂等与未知提交自动恢复。进入产品实现前，应在真实高价值业务流程上继续验证这些事项，不能把 mock 服务端已经通过的测试等同于生产认证已解决。

### 同口径业务验收与改选条件

共同业务 adapter、组件和输入的 mock 对照已有[实现](saas-agentic-ui-comparison-poc/README.md)。下一阶段应将同一故事接入真实 SaaS，而不是重新制造三个不同 demo 或仅增加工具数量。下表仍是生产准入问题，不意味着这些生产条件已由 mock 验收覆盖。

| 验收问题 | 通过标准 |
|---|---|
| 真正复用了什么资产 | 接入已有表单/校验、领域 API 和页面缓存刷新；不能新写第二个简化表单再宣称完成复杂组件迁移 |
| 自然语言是否可用 | 不指定工具名也能走对业务流程；多轮修改保留用户最终值，另记录模型选错工具和过度尝试，而不是只验强制工具提示 |
| 副作用是否可核对 | 权限拒绝不写入；重复确认不重复提交；响应丢失能凭 operation id 查询结果；Agent 的完成声明对应真实服务端 receipt |
| 生命周期是否严格 | 原 call id 精确结算；停止/卸载/旧答案/并发同名工具不误结算；刷新可区分完成历史、失效交互和不可恢复 waiter |
| 框架是否真的减少工作 | 比较自有消息/工具/恢复代码与测试、依赖升级和主题适配成本，不把共享 DSH runtime 或业务组件代码算成某框架独有负担 |

若 CopilotKit 的受支持生产接入不符合预算或部署要求，或仍需自写大多数应用交互而 assistant-ui 能以更少适配提供同等体验，就改选 assistant-ui。如果产品愿意采用完整 DSH Client composition，且真实组件验证显示它显著减少语义转换，也可改选 DSH 原生 UI。对于非 React SaaS，本仓库三份 React PoC 不足以给出同样排序，应先验证组件跨框架集成成本。

-----

## 前提澄清：已有业务 GUI 不等于聊天层

本报告讨论的 SaaS 已经拥有业务 GUI，但没有 AI assistant 的聊天入口。新增 Agent 时，原有业务页面仍然保留；新增的 CopilotKit、assistant-ui 或 DSH Web UI 承载 Agent 对话和业务交互，负责发送自然语言输入、展示 Agent 状态、呈现受控业务组件，并把用户确认或 action 传回既有业务能力。

三条主路线都保留业务 GUI、设计系统、登录态和业务 API，比较的是新增哪一个聊天/Agentic UI 层：扩展 DSH 原生 Web UI，或以 adapter 接入 assistant-ui，或以 adapter 接入 CopilotKit。不能将其中任何一条写成“替换整个 SaaS GUI”，也不能假设 SaaS 已有聊天层。

“成熟 SaaS 作为产品外壳”只表示既有 SaaS 继续拥有路由、组件树和业务上下文，不表示它已经拥有可直接复用的聊天层。如果团队不想从零实现聊天呈现，就应在三个框架候选中选一个，而不是把“自有 Chat UI”当成已经存在的资产。

-----

## 结论先行

本文给出的是限定产品背景下的选择，而不是“自研一定优于第三方”的一般判断。关键问题是既有 SaaS GUI、Agent Loop、Session 事实、业务副作用和聊天呈现分别由谁拥有。

| 场景 | 推荐 | 原因 |
|---|---|---|
| 产品就是 DSH Web 或 DSH 派生工作台 | 优先扩展 DSH 原生聊天层 | DSH Web UI 与 Session、Conversation、Tool view、Slots、问答和审批共享内部语义，避免重新建立消息和 Tool 投影。 |
| 既有 React SaaS 已有丰富业务 GUI，原来没有聊天层，重点是让 Agentic UI 复用既有交互 | **以 assistant-ui + DSH adapter 为轻量评估基线，CopilotKit 为强候选** | 相同业务组件/API 的闭环三者都能做；当前 CopilotKit 使用 renderer 加共同页面桥，尚未显示原生应用交互调度的独特收益。 |
| 既有 React SaaS 更看重独立主题、轻量呈现和低运行时耦合 | 优先评估 assistant-ui | 已通过同口径任务、工单、账单与恢复测试；仍需核算完整 adapter 和产品组件维护成本，不能只比本轮新增代码行数。 |
| 团队愿意把 DSH Client/Conversation/Slot 作为产品前端基础 | 可扩展 DSH 原生 Web UI | 减少 DSH 消息和工具语义转换，代价是接纳其 boot graph、bundle、插件和 Slot 模型；须在真实 SaaS 组件上衡量成本。 |
| 需要跨 Host 分发可交互 widget | 评估 MCP Apps 或受限 A2UI catalog | 这类方案解决 widget 隔离、动态 UI 描述或跨宿主互操作，不是 DSH Web UI 的默认替代品。 |

**针对题设的明确答案：以 assistant-ui + DSH adapter 作为复用既有 React 业务组件的优先评估基线；若明确需要 CopilotKit 额外应用交互设施，并能在 DSH 唯一执行者约束下证明收益，再选择 CopilotKit；产品本身就是 DSH Web 时优先扩展原生 UI。**不要把相同业务闭环的可实现性当成某个框架独有优势，也不要将 mock 对照当成生产集成已完成。

这个结论不意味着 assistant-ui 自动实现了 Agentic UI，也不意味着 DSH 原生 Web UI 或 CopilotKit 能力不足。三者解决的是不同的集成成本：DSH 原生层直接理解 DSH 的 Session、Tool、Conversation 和插件语义，但要求外部 SaaS 接受 DSH 的 Web Client composition；assistant-ui 通过 External Store 或其他 adapter 消费 DSH 投影，减少聊天层自研和 DSH UI 绑定，但仍必须定义 parts、业务 capability、授权、用户确认、跨轮次状态、receipt 和恢复语义；CopilotKit 更直接覆盖 React 应用交互，但与 DSH Tool/continuation/状态机制的重叠最大。对于“把已有 GUI 带进 Agent 对话”的核心目标，最难的部分不是聊天气泡，而是 capability seam；CopilotKit PoC 已经验证了一种桥接方式，但业务授权与权威提交仍属于 SaaS 后端。

## 结论修订：DSH 原生 UI 不是所有 SaaS 的默认答案

在给定背景下，必须把“DSH 的内部扩展性”和“外部 SaaS 的接入成本”分开评价：

| 目标 | 更优选择 | 原因 |
|---|---|---|
| 先做普通聊天 | assistant-ui | 聊天 primitives、composer 和消息呈现接入较轻。 |
| 把 SaaS 的真实表单、状态和业务操作带入对话 | **assistant-ui 作为轻量接入基线，CopilotKit 按额外交互设施收益评估** | 三路线已通过相同 mock 组件/API 闭环；这排除了“只有 CopilotKit 能做”的论据，却没有测量真实 SaaS 总实施成本。 |
| 让 UI action 在刷新、重连和回放后保持正确 | **DSH 作为事实 owner，聊天层作为可替换 read model** | 原生 UI 少一层投影；assistant-ui 多一层 adapter，但只要 DSH Session 是权威来源，两者都可以正确恢复。 |
| 最大限度降低对 DSH Web UI 的耦合 | **assistant-ui** | 它可以完全替换可见聊天层；代价是维护 DSH 事件到 message/part/runtime 的映射。 |
| 最大限度复用 DSH 既有 Conversation/Tool 语义 | **DSH 原生 Web UI** | 但这份收益只在 SaaS 接受 DSH Client/Conversation/Slot 组合模型时成立。 |
| 第一条既有 SaaS 业务闭环的迁移风险 | **目前不能只凭嵌入形态定输赢** | CopilotKit 有基于 `1.79.1` 的 `/v2` API 的 mock 闭环证据，但生产 Agent 注入和业务桥接仍有限制；assistant-ui 有可用的 Agentic UI 功能但 DSH PoC 未接入业务 UI。必须用当前版本和同一真实业务流程比适配代码、故障与维护成本。 |

所以，**对于题设的成熟 React SaaS，如果今天必须指定下一条验证路线，先做 CopilotKit + DSH adapter 的真实业务试点；不要把它直接宣布为生产选型，也不要因为 assistant-ui PoC 没有业务操作就断言 assistant-ui 做不到。**assistant-ui 的 Interactables、Tool UI 和生成式 UI 尚未在 DSH 上被同口径验证；CopilotKit 已使用 `/v2` API，未验证的是原生前端工具调度和受支持的生产注入路径。DSH-native 产品仍优先采用 DSH 原生 Web UI，DSH 继续保留 Loop 与 Session 事实。

DSH 原生 UI 只有在以下条件成立时才值得成为主路线：产品本身就是 DSH Web，或团队愿意把 DSH Client/Conversation/Slot 作为前端基础，并接受由 DSH boot graph、bundle 和插件模型约束业务 UI。assistant-ui 只有在团队愿意拥有 DSH 到外部 UI 的语义 adapter，并且独立视觉、低 DSH 耦合或聊天能力复用的收益大于 adapter 成本时才应采用。当前 PoC 证明 adapter 是可行的，也证明它仍是明确的工程职责；它没有证明 DSH 原生 UI 对外部 SaaS 更便宜。

这里的“DSH 语义兼容”不表示 assistant-ui 页面还要保留一份 DSH Web UI，而是表示原生 DSH UI 不需要通过外部消息模型重新映射 DSH 的 Session、Tool、Conversation 和交互状态。若选择 assistant-ui，DSH Web UI 可以完全不挂载；当前增量 PoC 正是通过不实例化 `AppWebEntry`、排除会自动恢复 DSH UI 导航的 entries 来做到这一点。此时只有一个可见聊天层，assistant-ui 是 UI owner，DSH Worker/Session 是执行与事实 owner。

因此实际是以下三条主路线和一条另行自研路线，而不是多个聊天 UI 分工合作：

```text
方案 A：既有 SaaS GUI + DSH 原生聊天层 → DSH Runtime/Session
方案 B：既有 SaaS GUI + assistant-ui 聊天层 → adapter → DSH Runtime/Session
方案 C：既有 SaaS GUI + CopilotKit 聊天/应用交互层 → DSH adapter → DSH Runtime/Session
方案 D：既有 SaaS GUI + 另行自研聊天层 → adapter → DSH Runtime/Session（需要独立证明维护收益）
```

只有在产品确实需要两个不同入口时，才可以让方案 A 和方案 B 分别存在于不同页面或不同产品 profile；不应在同一个助手面板中同时挂载两套聊天呈现层。

这里的“选择聊天层”不是永久保留全部 DSH 呈现实现的决定。长期可以让成熟框架接管明确的聊天职责；只要它消费 DSH 的权威事实，就不等于新增 Agent Loop。进一步核查和长期选型见 [Browser-Native DSH 的长期 UI 选型：assistant-ui 与 CopilotKit](assistant-ui-copilotkit-browser-native-dsh-assessment.md)。

## DSH Web UI 的扩展性：强在哪里，弱在哪里

DSH Web UI 的扩展性在 DSH 内部是强的：Host、Remote、Client model、UI adapter、Conversation、Slot 和 renderer 已经分层；插件可以通过 `dsh.client`、Slot declaration、Tool view 和 Conversation Node 加入能力，而不必修改 Agent Loop。这个设计适合 DSH 自己的 Web 工作台和愿意采用 DSH Client composition 的产品。

它对外部 SaaS 的扩展性则不是“拿来即嵌”的强。外部产品需要接入 DSH Host 生成的 boot graph、插件 bundle/module graph、Slot 注册、DSH Session/Conversation event model 和 DSH 的生命周期；已有 React/Vue 组件、路由、设计系统、登录态和业务 store 仍要经过 adapter 才能进入这些扩展点。DSH Web UI 没有被证明是一个可以直接渲染 `<DshChat />`、自动接管任意 SaaS 组件的通用 SDK。

因此当前评价应分成四层：DSH 内部插件扩展强；DSH 自己的工作台扩展强；外部 React SaaS 接入中等偏弱；非 React SaaS 接入弱。这个判断不是否定 DSH Web UI，而是防止把“内部架构可组合”误读成“外部产品迁移成本低”。

-----

## 评估方法与证据边界

原有 Web UI 源码评估基线是 2026-10-18 的 `research` 分支；本次于 2026-10-19 补查 CopilotKit worktree 的实际导入、lockfile、页面工具桥、测试脚本和留存 Session。三份 PoC 的框架能力比较以实际代码和验收范围为准，外部能力以官方文档为准。已验证的单写 lease 不等于多租户授权或副作用幂等，后两者及 handoff 仍是产品化目标。

重点检查了 Web Client 的 Host/Client/Conversation/Slot 分层、Tool view 的 owner props、问答和审批的 continuation、Session stream 恢复、错误边界、长会话渲染和浏览器 E2E。

2026-10-16 前轮研究阶段运行的聚焦源码测试覆盖 10 个文件、177 项测试，结果全部通过。测试覆盖 Tool view keyed dispatch、preparing/start/result 生命周期、Slot live registration、renderer lifecycle、问答插件、Session history、notifier 和 Modal layer。这里保存此前的验证记录；本次重评没有重新运行这组源码或 GUI 测试。

前轮研究还使用已有构建产物运行了两个 keyless replay 的 Chromium 场景：`connection-recovery.e2e.ts` 的 2 项测试，以及 `question-composer.e2e.ts` 的 6 项测试，结果全部通过。断线场景验证页面不导航、根节点仍挂载、Session baseline 重建和未发送草稿保留；问答场景验证提交、刷新后的只读记录和晚到回答。源码测试与已有 GUI 构建产物的运行证据不能等同于本次从当前源码重新完整构建后的验证。

本次没有重跑模型或浏览器 E2E，而是复核既有测试记录和脚本，并重新统计留存的 CopilotKit Chrome/WebKit Session：两者各有 145 个事件、12 个 turn、19 个 step、1 次标题请求，8 个工具调用均恰好匹配一个结果。浏览器无页面错误、无 Cloud 请求等观察值沿用[测试记录](copilotkit-browser-native-dsh-poc/test-record.md)，不是从 Session 文件推导。Playwright WebKit 不等同 Safari.app 本体；backend 重启验收使用 scripted LLM。现有证据证明一个 mock 业务闭环，未证明生产 API、灾备、安全或三条路线的同口径成本。原生 DSH PoC 未测量外部 SaaS 组件迁移，assistant-ui PoC 未实现相同业务交互，不能据此反推二者更便宜或更昂贵。

-----

## 前两份 PoC 的直接比较

截至 2026-10-17 的两份 PoC 对照只覆盖 DSH 原生 Web UI 与 assistant-ui：文本输入都进入 Browser-Native DSH Worker、原有 `ctx.agentLoop`、LLM proxy 和 Session persistence；差异在 Client 启动、事件投影和呈现。它们没有 SaaS 业务页面，因此不能用于裁决哪种框架更适合把成熟 SaaS 交互带进聊天。CopilotKit 的后续证据和三份 PoC 的统一比较见[路线重评](#三份-poc-后的路线重评)。

| 维度 | DSH 原生 Web UI | assistant-ui 增量 PoC | 对既有 SaaS 的含义 |
|---|---|---|---|
| DSH 语义兼容 | 直接使用 DSH `AppWebEntry`、Client composition、Conversation、Tool view 和交互插件 | 通过 `useExternalStoreRuntime` 和 `dsh-session-adapter.ts` 映射 DSH 事件 | 原生层更少转换错误；assistant-ui 需要持续维护映射契约 |
| 已验证的运行闭环 | 真实 DSH UI、Worker Host、Session、工具和流式回复 | 真实 DSH Worker、Session、工具、流式回复、失败恢复和刷新续接 | 两者都能作为聊天层接入同一个 Agent；不能把 UI 差异误判成 Loop 差异 |
| 新增接线成本 | 主要是复用现有 DSH 页面和正式 profile | 需要独立 client 启动、owner 释放/续接、事件投影、工具 part 和错误面 | assistant-ui 的“可嵌入”以 adapter 成本为代价；PoC 不是零成本替换 |
| 聊天层功能范围 | 原生 DSH 的 Session/Conversation/Tool 语义和现有 UI 插件直接可用 | 当前 PoC 只实现 text-only 输入、基础 Tool card、流式行、历史和恢复；附件、编辑、分支、复杂 HITL 和多 Session 未实现 | assistant-ui 的框架能力不能自动等于 DSH 能力已经接通 |
| 视觉和产品耦合 | 更接近 DSH 的设计、状态和插件模型，深度定制需要理解 DSH extension model | 更容易使用既有 SaaS 的 React/CSS/布局，但业务组件仍需额外桥接 | 既有 SaaS 若已有设计系统，assistant-ui 的局部嵌入通常更自然 |
| 调试和恢复 | UI 直接沿用 DSH 的事实投影，问题更容易定位到 DSH owner | 需要同时排查 DSH Session、adapter read model 和 assistant-ui runtime | assistant-ui 生产化必须把 Session 事件作为诊断依据，不能只看 messages |

### 实测改变了什么判断

第一，assistant-ui 方案“技术上可行”已经不是推测。它在不创建第二个 Agent Loop 或第二份权威历史的前提下，已经通过真实 DSH Worker、真实模型、工具调用、多轮窗口记忆、流式文本、受控失败恢复和刷新续接的验收记录。它适合作为一个明确边界的聊天呈现层。

第二，assistant-ui 方案“工程上更省事”没有被证明，反而被 PoC 限定了。它需要自行处理 DSH Client 的启动、默认 UI entry 的裁剪、Session retain、写 owner、pagehide close、错误恢复和 DSH 事件到 `ThreadMessageLike` 的投影；当前 `src/dsh-client.ts` 与 `src/dsh-session-adapter.ts` 是适配层的直接证据。assistant-ui 减少的是聊天组件和交互 primitives 的自有实现，不是 DSH 集成的全部成本。

第三，DSH 原生 Web UI 的优势也不是“它天然就是 Agentic UI”。它的优势是已经拥有 DSH 特有的消息、Tool、Conversation、问答、审批、Session 恢复和插件扩展语义；如果目标产品就是 DSH Web 或 DSH 派生工作台，复用这些语义通常比另建外部消息模型更稳。它仍然需要新增 typed business capability，不能直接操作既有 SaaS 的数据库或业务 API。

### 针对已有 SaaS 的判断

对于已经有丰富业务 GUI 的 SaaS，最合理的比较单位不是“把整个 DSH Web UI 搬进 SaaS”与“把 assistant-ui 搬进 SaaS”，而是选择一个聊天呈现层，并把两者都放在既有 SaaS GUI 旁边：

```text
既有 SaaS GUI：业务页面、表单、状态和用户手势
       ↕ typed capability adapter
聊天层：DSH 原生 Web UI、assistant-ui 或 CopilotKit
       ↕ DSH Session / command projection
Browser-Native DSH Worker：Agent Loop、Tool orchestration、Session
       ↕ same-origin backend
SaaS backend：身份、租户授权、业务提交和 receipt
```

在这个背景下，如果验收目标只是自然语言输入、流式回复和基础 Tool UI，assistant-ui 仍是轻量候选；若目标是把 SaaS 原有业务交互自然地带入对话，当前 CopilotKit PoC 与目标更贴合，但其证据仅为固定版本 `/v2` API 加自写工具桥上的本地 mock 操作，尚待生产注入、严格调用身份和真实业务 API 验证。assistant-ui 的新互动组件能力也值得用同一业务流程验证。DSH 原生 Web UI 具有更直接的 DSH Conversation/Tool/Slot 语义，但要求 SaaS 接受 DSH Client composition；三者都需要业务 capability、授权、receipt 和恢复设计。本报告不把“已有聊天层”作为前提。

无论选择哪一个聊天层，Agentic UI 的业务价值都来自复用既有 SaaS 的业务组件：模型读取受限 observation，Agent 请求 typed intent，用户在原有表单或确认面板中修改/确认，SaaS backend 授权并提交，receipt 和结果再回到 Session。聊天层只负责让这条链路可理解、可操作和可恢复。

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

这使 DSH 可以直接执行垂直业务流程，不需要引入第二个 Agent Loop。成熟 React SaaS 的候选判断见[路线重评](#三份-poc-后的路线重评)和[同口径实验](saas-agentic-ui-comparison-poc/README.md)；DSH-native 产品可直接复用原生 Web UI。若完全不引入第三方，也可以另行自研聊天层，但那是新增工程路线，不是 SaaS 原来已有的资产。真实试点应接入可授权的业务 API，例如打开客户创建表单、预填字段、用户确认、服务端创建并回传 receipt。

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
| assistant-ui | `ExternalStoreRuntime` 允许已有 store 提供 messages 和 callbacks；也有 frontend/human/external tools，以及 AG-UI state 和 interrupt helpers。 | 同口径实验已验证聊天内复用共同业务表单/API；DSH 对接仍需维护事件投影、Session lifecycle、Tool parts 和唯一 continuation owner，实验没有验证全部扩展 API。 | 题设成熟 React SaaS 的轻量接入基线，不限于普通聊天；不能替代业务 capability、认证授权或 Agent Loop。 |
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

### 场景 A：DSH 原生 Web UI 作为聊天层

保留 `ui-session`、`ui-conversation`、`ui-tool`、`ui-chat`、`ui-slots` 和现有交互插件，把 DSH 原生 Web UI 作为既有 SaaS 旁边的聊天呈现层，再增加业务 plugin。业务 plugin 提供 Host Tool、业务 API adapter、Session projection、Tool view 或 Conversation Node，并通过一个窄的 capability facade 把 SaaS 业务组件所需的 state/action 接入。

该场景适合产品本身就是 DSH Web 或团队愿意采用 DSH Client/Conversation/Slot 体系的情况。CopilotKit、AI SDK UI 或 assistant-ui 不应再成为第二个 Chat runtime；它们可以贡献局部交互思想、schema helper 或纯展示组件，但 DSH 仍是会话、Tool 和 continuation 的唯一 owner。

如果长期选择由 assistant-ui 接管聊天呈现，可以替换对应的聊天 UI 实现，而不只是永久局部叠加。前提是它通过 DSH 的投影与命令接入，并且替换收益足以覆盖适配、迁移和产品级验证成本。

### 场景 B：成熟 SaaS 作为产品 GUI 与产品外壳

保留 SaaS 的路由、组件树、设计系统、登录态、租户上下文和业务 store。将 DSH 作为 Agent Runtime，通过 Remote/API、Session event stream 或 typed adapter 接入 SaaS 的助手面板；不要为了获得聊天层而迁移整个 DSH Web UI。

如果目标主要是普通聊天、流式回复和少量 Tool card，assistant-ui 的 `ExternalStoreRuntime` 可以减少自建聊天外壳的成本；若核心需求是把 React SaaS 业务组件、表单和用户确认带入聊天，当前 CopilotKit + DSH adapter PoC 是更直接的验证路径。两条路线都必须把 DSH Session 作为历史事实源，而不是让外部 UI runtime 重新拥有 Agent history。

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

### 阶段 5：按产品边界选择聊天层和协议

对已有丰富 React GUI、Agentic UI 为核心目标的既有 SaaS，优先在真实业务 API 上深化 CopilotKit + DSH adapter；对普通聊天和少量 Tool card，assistant-ui 是较轻的候选；对 DSH-native 产品，再优先复用 DSH 原生 Web UI。选择标准不是 API 是否漂亮，而是它是否减少目标场景的自有代码和测试，同时不建立第二个事实源或第二个 continuation owner。

-----

## 对既有报告的修订

本专题把前一轮回答落档，并同步修正既有研究对当前实现范围的表述。

第一，前一轮报告把“没有聊天层的既有 SaaS”直接归入 DSH 原生 Web UI 优先，这个结论过度外推。基于 DSH 原生与 assistant-ui 两套 PoC 的 2026-10-17 修订，曾把 assistant-ui 作为一般 SaaS 聊天层默认候选；这是当时证据集下的结论。

第二，`dsh-agentic-ui-research.md` 原先把“Tool view 没有通用业务提交或 continuation API”写在缺口表中，这个判断仍然成立，但需要补充已有的领域级例外。`ui-user-questions`、`ui-approval` 和对应的 interaction package 已经提供具体的等待、回答、审批、超时、取消和后续消息路径；修订后把“缺少通道”限定为“缺少通用业务 action seam”。

第三，Browser-Native PoC v2 的 `backend-v2.mjs` 要区分“要求 requestId”与“实现 idempotency ledger”，也要区分“当前 backend instance 的 in-memory owner token”与“跨重启的 lease/epoch/接管协议”。v2 当前代码有 owner claim、assertion、close release、contiguous sequence 和 flush durability；没有基于 requestId 的请求去重或结果重放账本，也没有 renew、expiry 或 owner epoch。既有实施方案中的这些项目仍是未来验收标准，不应被写成 v2 已完成能力。

第四，[protocol.md](browser-native-dsh-poc/protocol.md)描述的是旧版独立 HTML/loop 实验，不是 v2 的协议 owner；索引和文档范围说明已据此修正。preview 的 opt-in 参数只控制 profile overlay，docs-owned Worker entry 在所有 preview 中都会实例化，不能把它描述成 query 参数才启用的 Worker 替换。

第四，PoC v2 的 Chromium E2E 证明真实 DSH Web UI、Worker Host、`ctx.agentLoop`、同源 LLM route、正式 Session event 和 flush durability 的一次闭环；assistant-ui 增量 PoC 证明外部聊天层可以在不复制 Loop 和权威历史的情况下接入同一闭环。这些事实仍然成立。

第五，原 CopilotKit PoC 首先增加了 mock SaaS 表单证据，随后[同口径实验](saas-agentic-ui-comparison-poc/README.md)让三路线接入相同业务组件/API。当前选型不再以“谁先做过业务 demo”判断；框架能力、版本和实际验收范围见[路线重评](#三份-poc-后的路线重评)。

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

本文主体保留 2026-10-17 的源码与前两份 PoC 评估；2026-10-19 先根据第三份 PoC 重评，再补入三路线同口径 SaaS 实验及真实模型/浏览器验收。最新判断以[路线重评](#三份-poc-后的路线重评)与[实验测试记录](saas-agentic-ui-comparison-poc/test-results.md)为准；旧独立 PoC 的限制不应套用到新实验，也不能因新实验通过就宣称旧代码已修复。本文是研究草稿，不是 DSH 已发布的架构承诺；稳定接口落地后应将相应说明迁移到所属 package README、subsystem 或 Agent Note。
