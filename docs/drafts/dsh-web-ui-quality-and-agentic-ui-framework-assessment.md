---
description: "DSH 当前 Web UI 的实现质量、Agentic UI 适配能力和第三方框架选型评估，基于源码、测试、Browser-Native PoC 与官方生态资料。"
---

# DSH Web UI 实现质量与 Agentic UI 框架选型评估

## Summary

本文评估 DSH 当前 Web UI、assistant-ui 和 CopilotKit 三条路线是否适合作为 Agentic UI 的工程基础。产品前提是：SaaS 已经有成熟 Web GUI、业务操作界面和组件，但原来没有聊天层；AI assistant 的目标不是只增加聊天泡泡，而是让用户用自然语言调用这些既有能力，并把原有业务交互自然地带入 Agentic UI。三条路线都是新增聊天/Agentic UI 层的候选，不是复用 SaaS 原来已有的聊天层。PoC、代码考古和外部报告复核后的修正结论是：**DSH 原生 Web UI 的 DSH 语义完整度最高，CopilotKit 对“Agent 控制 React SaaS 应用”的能力匹配度最高，assistant-ui 对既有 SaaS 的接入耦合最低且当前已有真实 DSH PoC 证据。针对当前 Browser-Native DSH，一般既有 SaaS 第一版仍默认采用 assistant-ui；CopilotKit 只有在深度控制多个 React 业务模块时才进入优先验证；DSH 原生 Web UI 只在 DSH-native 或明确愿意采用 DSH Client/Conversation/Slot 组合模型的产品中优先。**三条路线都不能自动解决业务 capability、授权、receipt 或 continuation owner。外部报告审阅见[事实核查与整合记录](saas-agentic-ui-report-review.md)。

这里的“已有 SaaS GUI”与“聊天层”是两件不同的事：前者是已经存在的业务页面、表单、组件、路由和业务操作；后者是现在才新增的 Agent 入口。本文比较的是新增的这一层，不建议为了加入 Agent 而替换整个 SaaS GUI，也不建议第一版同时挂载 DSH Web UI 和 assistant-ui 两套面向用户的聊天层。选择 DSH 原生 Web UI，表示把它作为 SaaS 中新增的唯一聊天/Agentic UI surface；选择 assistant-ui，表示由它承担同一职责，同时保留 DSH Worker、Agent Loop、Session 和业务后端，但不再额外挂载 DSH Web UI。

## Table of Contents

- [结论先行](#结论先行)
- [前提澄清：已有业务 GUI 不等于聊天层](#前提澄清已有业务-gui-不等于聊天层)
- [结论修订：DSH 原生 UI 不是所有 SaaS 的默认答案](#结论修订dsh-原生-ui-不是所有-saas-的默认答案)
- [评估方法与证据边界](#评估方法与证据边界)
- [PoC 后两个聊天层的直接比较](#poc-后两个聊天层的直接比较)
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

## 前提澄清：已有业务 GUI 不等于聊天层

本报告讨论的 SaaS 已经拥有业务 GUI，但没有 AI assistant 的聊天入口。新增 Agent 时，原有业务页面仍然是业务操作的主要承载物；新增的 DSH Web UI 或 assistant-ui 只是一个新的聊天/Agentic UI surface，负责理解自然语言、展示 Agent 状态、呈现受控的业务 surface，并把用户确认或 action 传回既有业务能力。

因此，本文的两条路线不是“重写 SaaS GUI”与“保留 SaaS GUI”的对比，而是新增聊天层的二选一：路线 A 把 DSH 原生 Web UI 嵌入或接入现有 SaaS；路线 B 把 assistant-ui 嵌入或接入现有 SaaS。两条路线都继续复用原有业务 GUI、设计系统、登录态和业务 API；差别是聊天层是否直接采用 DSH 的 Conversation/Tool/Slot 语义，还是由 assistant-ui 通过 adapter 消费 DSH 投影。

“成熟 SaaS 作为产品外壳”只表示既有 SaaS 继续拥有路由、组件树和业务上下文，不表示它已经拥有可直接复用的聊天层。如果 SaaS 团队不想自行从零实现聊天呈现，就必须在 DSH 原生 Web UI 与 assistant-ui 之间明确选择一个新增聊天层，而不是把“自有 Chat UI”当成已存在的第三种方案。

-----

## 结论先行

本文给出的是限定产品背景下的选择，而不是“自研一定优于第三方”的一般判断。关键问题是既有 SaaS GUI、Agent Loop、Session 事实、业务副作用和聊天呈现分别由谁拥有。

| 场景 | 推荐 | 原因 |
|---|---|---|
| 产品就是 DSH Web 或 DSH 派生工作台 | 优先扩展 DSH 原生聊天层 | DSH Web UI 与 Session、Conversation、Tool view、Slots、问答和审批共享内部语义，避免重新建立消息和 Tool 投影。 |
| 既有 SaaS 是产品外壳，原来没有聊天层，重点是新增聊天/Agentic UI | **默认新增 assistant-ui 聊天层，DSH 只做 Runtime/Session owner** | 既有 SaaS 不需要迁移到 DSH 的 boot graph、bundle、Slot 和 Client composition；assistant-ui 能直接承担新增聊天层，但业务 capability、授权和恢复仍需 adapter。另一条路线是新增 DSH 原生 Web UI。 |
| 既有 SaaS 只需要聊天、流式回复和少量 Tool card | 可以采用 assistant-ui | assistant-ui 的嵌入体验更轻，但这不是本文关注的完整 Agentic UI 目标。 |
| 团队明确要求聊天层独立于 DSH UI，且愿意承担业务交互 adapter | 采用 assistant-ui | PoC 证明它不需要保留 DSH UI；它把聊天层接入成本集中在可测试的 adapter，而不是把整个 SaaS 前端绑定到 DSH UI composition。 |
| 产品就是 DSH Web 或团队愿意采用 DSH Client/Conversation/Slot 体系 | 采用 DSH 原生 Web UI 作为聊天/Agentic UI 层 | 可以减少 DSH 事件到外部消息模型的转换，但会把 SaaS 更深地绑定到 DSH 的 boot graph、bundle、插件和 Slot 模型。 |
| 既有 React SaaS 要让 Agent 深度控制表单、前端状态和组件交互 | 条件性评估 CopilotKit | 它的前端 Tool、HITL 和 shared state 方向更贴近应用交互；但与 DSH 的 Tool/continuation 语义重叠更大，不能直接作为第二个 Agent Loop。 |
| 既有 React SaaS 要把多个业务模块统一暴露为 Agent 可调用的组件/前端 Tool | **CopilotKit 的能力匹配度最高，但必须先做 DSH adapter PoC** | 它直接覆盖 Components as Tools、frontend tools、Tool rendering、HITL 和 shared state；当前仓库尚未验证它与 DSH Worker/Session 的完整组合。 |
| 既有 SaaS 希望把业务表单和页面变成 Agentic UI | 先选择能承载复杂交互的层，再建设 capability | 关键工作是 typed capability、状态版本、授权、用户确认、receipt 和 unknown recovery；assistant-ui 的聊天 primitives 不能自动提供这些语义。 |
| 需要跨 Host 分发可交互 widget | 评估 MCP Apps 或受限 A2UI catalog | 这类方案解决 widget 隔离、动态 UI 描述或跨宿主互操作，不是 DSH Web UI 的默认替代品。 |

**针对“已有丰富 SaaS GUI、原来没有聊天层、重点是 Agentic UI”的明确答案：三条路线必须直接比较。当前推荐顺序是：第一版用 assistant-ui 接入 DSH；如果核心 KPI 是跨多个 React 业务模块的 Agent 控制，再优先做 CopilotKit + DSH adapter PoC；如果产品本身就是 DSH Web，才优先扩展 DSH 原生 Web UI。**不要因为 DSH 的内部插件扩展性强，就把既有 SaaS 迁移成 DSH Web Client。

这个结论不意味着 assistant-ui 自动实现了 Agentic UI，也不意味着 DSH 原生 Web UI 或 CopilotKit 能力不足。三者解决的是不同的集成成本：DSH 原生层直接理解 DSH 的 Session、Tool、Conversation 和插件语义，但要求外部 SaaS 接受 DSH 的 Web Client composition；assistant-ui 通过 External Store 或其他 adapter 消费 DSH 投影，减少聊天层自研和 DSH UI 绑定，但仍必须定义 parts、业务 capability、授权、用户确认、跨轮次状态、receipt 和恢复语义；CopilotKit 更直接覆盖 React 应用交互，但与 DSH Tool/continuation/状态机制的重叠最大。对于“把已有 GUI 带进 Agent 对话”的核心目标，最难的部分不是聊天气泡，而是 capability seam；选择 assistant-ui 的当前价值是已有 DSH 接入证据和较低的运行时耦合，选择 CopilotKit 的潜在价值是减少跨业务模块的应用交互胶水。

## 结论修订：DSH 原生 UI 不是所有 SaaS 的默认答案

在给定背景下，必须把“DSH 的内部扩展性”和“外部 SaaS 的接入成本”分开评价：

| 目标 | 更优选择 | 原因 |
|---|---|---|
| 先做普通聊天 | assistant-ui | 聊天 primitives、composer 和消息呈现接入较轻。 |
| 把 SaaS 的真实表单、状态和业务操作带入对话 | **取决于 capability seam，不由聊天框架单独决定** | DSH 原生 UI 和 assistant-ui 都需要 typed state/action、业务授权、receipt 和恢复；任何框架都不能自动把旧页面变成业务 capability。 |
| 让 UI action 在刷新、重连和回放后保持正确 | **DSH 作为事实 owner，聊天层作为可替换 read model** | 原生 UI 少一层投影；assistant-ui 多一层 adapter，但只要 DSH Session 是权威来源，两者都可以正确恢复。 |
| 最大限度降低对 DSH Web UI 的耦合 | **assistant-ui** | 它可以完全替换可见聊天层；代价是维护 DSH 事件到 message/part/runtime 的映射。 |
| 最大限度复用 DSH 既有 Conversation/Tool 语义 | **DSH 原生 Web UI** | 但这份收益只在 SaaS 接受 DSH Client/Conversation/Slot 组合模型时成立。 |
| 第一条既有 SaaS 业务闭环的迁移风险 | **assistant-ui 通常更低** | 它不要求把 SaaS 路由、设计系统和业务组件迁入 DSH boot graph；业务 capability 适配仍是必需工作。 |

所以，**对于一般既有 SaaS，当前应选择 assistant-ui 作为新增 Agentic UI 的第一承载层，并让 DSH 保留执行与事实；对于 DSH-native 产品，才选择 DSH 原生 Web UI。**这不是因为 assistant-ui 自动提供了业务 Agentic UI，而是因为它把新增聊天层的产品职责与既有 SaaS GUI 解耦，同时不要求引入第二个 Agent Loop。

DSH 原生 UI 只有在以下条件成立时才值得成为主路线：产品本身就是 DSH Web，或团队愿意把 DSH Client/Conversation/Slot 作为前端基础，并接受由 DSH boot graph、bundle 和插件模型约束业务 UI。assistant-ui 只有在团队愿意拥有 DSH 到外部 UI 的语义 adapter，并且独立视觉、低 DSH 耦合或聊天能力复用的收益大于 adapter 成本时才应采用。当前 PoC 证明 adapter 是可行的，也证明它仍是明确的工程职责；它没有证明 DSH 原生 UI 对外部 SaaS 更便宜。

这里的“DSH 语义兼容”不表示 assistant-ui 页面还要保留一份 DSH Web UI，而是表示原生 DSH UI 不需要通过外部消息模型重新映射 DSH 的 Session、Tool、Conversation 和交互状态。若选择 assistant-ui，DSH Web UI 可以完全不挂载；当前增量 PoC 正是通过不实例化 `AppWebEntry`、排除会自动恢复 DSH UI 导航的 entries 来做到这一点。此时只有一个可见聊天层，assistant-ui 是 UI owner，DSH Worker/Session 是执行与事实 owner。

因此实际是以下三种互斥选择，而不是两个聊天 UI 分工合作：

```text
方案 A：既有 SaaS GUI + DSH 原生聊天层 → DSH Runtime/Session
方案 B：既有 SaaS GUI + assistant-ui 聊天层 → adapter → DSH Runtime/Session
方案 C：既有 SaaS GUI + 另行自研聊天层 → adapter → DSH Runtime/Session（不属于当前默认路线）
```

只有在产品确实需要两个不同入口时，才可以让方案 A 和方案 B 分别存在于不同页面或不同产品 profile；不应在同一个助手面板中同时挂载两套聊天呈现层。

这里的“选择聊天层”不是永久保留全部 DSH 呈现实现的决定。长期可以让成熟框架接管明确的聊天职责；只要它消费 DSH 的权威事实，就不等于新增 Agent Loop。进一步核查和长期选型见 [Browser-Native DSH 的长期 UI 选型：assistant-ui 与 CopilotKit](assistant-ui-copilotkit-browser-native-dsh-assessment.md)。

## DSH Web UI 的扩展性：强在哪里，弱在哪里

DSH Web UI 的扩展性在 DSH 内部是强的：Host、Remote、Client model、UI adapter、Conversation、Slot 和 renderer 已经分层；插件可以通过 `dsh.client`、Slot declaration、Tool view 和 Conversation Node 加入能力，而不必修改 Agent Loop。这个设计适合 DSH 自己的 Web 工作台和愿意采用 DSH Client composition 的产品。

它对外部 SaaS 的扩展性则不是“拿来即嵌”的强。外部产品需要接入 DSH Host 生成的 boot graph、插件 bundle/module graph、Slot 注册、DSH Session/Conversation event model 和 DSH 的生命周期；已有 React/Vue 组件、路由、设计系统、登录态和业务 store 仍要经过 adapter 才能进入这些扩展点。DSH Web UI 没有被证明是一个可以直接渲染 `<DshChat />`、自动接管任意 SaaS 组件的通用 SDK。

因此当前评价应分成四层：DSH 内部插件扩展强；DSH 自己的工作台扩展强；外部 React SaaS 接入中等偏弱；非 React SaaS 接入弱。这个判断不是否定 DSH Web UI，而是防止把“内部架构可组合”误读成“外部产品迁移成本低”。

-----

## 评估方法与证据边界

源码评估基线是 2026-10-18 的 `research` 分支，依据包括当前源码、测试、Web Client 架构文档、既有 Agentic UI 报告和两套 Browser-Native PoC，外部框架只引用其官方文档。代码事实以源码和测试为准；实施方案中的 lease、handoff、幂等和多租户条款仍属于设计目标，不能替代已经通过的测试。

重点检查了 Web Client 的 Host/Client/Conversation/Slot 分层、Tool view 的 owner props、问答和审批的 continuation、Session stream 恢复、错误边界、长会话渲染和浏览器 E2E。

2026-10-16 前轮研究阶段运行的聚焦源码测试覆盖 10 个文件、177 项测试，结果全部通过。测试覆盖 Tool view keyed dispatch、preparing/start/result 生命周期、Slot live registration、renderer lifecycle、问答插件、Session history、notifier 和 Modal layer。这里保存此前的验证记录；本次重评没有重新运行这组源码或 GUI 测试。

前轮研究还使用已有构建产物运行了两个 keyless replay 的 Chromium 场景：`connection-recovery.e2e.ts` 的 2 项测试，以及 `question-composer.e2e.ts` 的 6 项测试，结果全部通过。断线场景验证页面不导航、根节点仍挂载、Session baseline 重建和未发送草稿保留；问答场景验证提交、刷新后的只读记录和晚到回答。源码测试与已有 GUI 构建产物的运行证据不能等同于本次从当前源码重新完整构建后的验证。

本次重评沿用 PoC 已记录的 `assistant-ui` adapter 单测、scripted E2E、owner 竞争 E2E，以及原生 DSH v2 backend 和 Chromium E2E 结果；此前真实 Chrome/Safari 验收覆盖真实 LLM、多轮记忆、`todo_write`、失败恢复、流式文本、刷新续接和 durable Session。上述证据仍未覆盖完整 Browser-Native 业务 action 闭环或多租户安全审计，因此本文不宣称任一 UI 已通过生产级性能、灾备或安全认证。尤其需要注意：原生 DSH PoC 没有测量“外部 SaaS GUI 接入 DSH 原生 Web UI”的迁移成本，不能以 assistant-ui adapter 的代码量反推 DSH 原生 UI 对一般 SaaS 一定更便宜。

-----

## PoC 后两个聊天层的直接比较

两套 PoC 的关键事实是相同的：文本输入都进入同一个 Browser-Native DSH Worker、同一个 `ctx.agentLoop`、同一个 LLM proxy 和同一个 Session persistence；差异发生在页面如何启动 Client、如何把 Session 事件投影成消息，以及如何呈现 Tool 和错误。因此，assistant-ui PoC 不是另一种 Agent Loop，也不是对 DSH 执行机制的替代实验。

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
聊天层：DSH 原生 Web UI 或 assistant-ui
       ↕ DSH Session / command projection
Browser-Native DSH Worker：Agent Loop、Tool orchestration、Session
       ↕ same-origin backend
SaaS backend：身份、租户授权、业务提交和 receipt
```

在这个背景下，如果验收目标只是自然语言输入、流式回复和基础 Tool card，assistant-ui 的嵌入优势可以成立；如果验收目标是把 SaaS 原有业务交互自然地带入对话，真正的风险中心是 capability、授权、receipt 和恢复，而不是聊天层本身。DSH 原生 Web UI 拥有更接近该问题的 Conversation/Tool/Slot 扩展点，但也要求外部 SaaS 接入 DSH 的 Client composition；assistant-ui 则增加一层事件和命令 adapter，但不要求迁移 SaaS 的前端装配。对于一般既有 SaaS，后者通常是更合适的起步边界；对于 DSH-native 产品，前者才是更低风险的第一承载层。本报告不把“已有聊天层”作为当前前提。

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

这使 DSH 可以直接开始一个垂直 PoC，而不需要先引入新的 Agent Loop；它不决定聊天层必须采用 DSH 原生 UI。一般既有 SaaS 可以用 assistant-ui 呈现这个闭环，DSH 继续负责 Loop、Tool lifecycle 和 Session；DSH-native 产品则可以直接复用 DSH Web UI。若完全不引入第三方，也可以另行自研聊天层，但那是新增的第三条工程路线，不是 SaaS 原来已经拥有的资产。优先选择一个已有业务 API 能完成授权和查询的闭环，例如“打开客户创建表单、预填字段、用户确认、服务端创建、回传 receipt”。

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
| assistant-ui | `ExternalStoreRuntime` 允许已有 store 提供 messages 和 callbacks；也有 frontend/human/external tools，以及 AG-UI state 和 interrupt helpers。 | assistant-ui PoC 已验证它可以作为 DSH 的外部聊天呈现层；但 DSH 对接不是自动完成的，仍需维护事件投影、Session lifecycle、Tool parts 和唯一 continuation owner。 | 仅在目标是普通聊天、或团队明确接受 Agentic UI adapter 成本并需要独立 UI runtime 时采用；不要把它当作业务 capability 或 Agent Loop。 |
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

此时使用 assistant-ui 的 `ExternalStoreRuntime` 可能有价值，因为它可以减少 SaaS 团队自己构建聊天外壳的成本；如果 SaaS 已有聊天组件，则直接复用该组件。adapter 必须把 DSH Session 投影成聊天层的 read model，而不是让外部 runtime 重新拥有 Agent history。

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

对一般既有 SaaS，先把 assistant-ui 作为新增聊天 surface 的默认候选；对 DSH-native 产品，再优先复用 DSH 原生 Web UI。只有当多个业务模块需要统一的前端 Tool、HITL、共享状态或跨 Agent 接入时，才进一步评估 CopilotKit 或 AG-UI。选择标准不是 API 是否漂亮，而是它是否删除 DSH 当前明确拥有的代码和测试，同时不建立第二个事实源或第二个 continuation owner。

-----

## 对既有报告的修订

本专题把前一轮回答落档，并同步修正既有研究对当前实现范围的表述。

第一，前一轮报告把“没有聊天层的既有 SaaS”直接归入 DSH 原生 Web UI 优先，这个结论过度外推。本次修订把它改为：第一版应在 DSH 原生 Web UI 与 assistant-ui 之间选择一个新增聊天层；一般既有 SaaS 默认选择 assistant-ui，DSH 只保留 Runtime/Session/事实所有权。

第二，`dsh-agentic-ui-research.md` 原先把“Tool view 没有通用业务提交或 continuation API”写在缺口表中，这个判断仍然成立，但需要补充已有的领域级例外。`ui-user-questions`、`ui-approval` 和对应的 interaction package 已经提供具体的等待、回答、审批、超时、取消和后续消息路径；修订后把“缺少通道”限定为“缺少通用业务 action seam”。

第三，Browser-Native PoC v2 的 `backend-v2.mjs` 要区分“要求 requestId”与“实现 idempotency ledger”，也要区分“当前 backend instance 的 in-memory owner token”与“跨重启的 lease/epoch/接管协议”。v2 当前代码有 owner claim、assertion、close release、contiguous sequence 和 flush durability；没有基于 requestId 的请求去重或结果重放账本，也没有 renew、expiry 或 owner epoch。既有实施方案中的这些项目仍是未来验收标准，不应被写成 v2 已完成能力。

第四，[protocol.md](browser-native-dsh-poc/protocol.md)描述的是旧版独立 HTML/loop 实验，不是 v2 的协议 owner；索引和文档范围说明已据此修正。preview 的 opt-in 参数只控制 profile overlay，docs-owned Worker entry 在所有 preview 中都会实例化，不能把它描述成 query 参数才启用的 Worker 替换。

第四，PoC v2 的 Chromium E2E 证明真实 DSH Web UI、Worker Host、`ctx.agentLoop`、同源 LLM route、正式 Session event 和 flush durability 的一次闭环；assistant-ui 增量 PoC 进一步证明外部聊天层可以在不复制 Loop 和权威历史的情况下接入同一闭环。两套 PoC 都没有证明业务 UI action、SaaS 授权、receipt、unknown recovery、完整 handoff 或生产多租户安全。综合报告的“当前成果”应按这个范围阅读。

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

本文记录 2026-10-17 对当前 checkout 的代码考古、两套 PoC 聚焦测试和官方生态资料核查。它是 `docs/drafts/` 研究草稿，不是 DSH 已发布的架构承诺；若业务 capability facade、Browser-Native handoff 或第三方 adapter 落地，应将相应的稳定 contract 迁移到所属 package README、subsystem 或 Agent Note。
