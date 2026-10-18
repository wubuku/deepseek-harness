---
description: "对外部《SaaS 引入 Agentic UI 深度调研报告》的事实核查、DSH 代码与 PoC 对照、保留结论及修正后的路线判断。"
---

# SaaS 引入 Agentic UI 外部报告：事实核查与整合记录

## Summary

本文审阅 `/Users/yangjiefeng/Downloads/SaaS引入Agentic-UI深度调研报告.md`，并将其中可复用的研究价值整合到 DSH 现有 Agentic UI、Browser-Native DSH、Web UI 选型和 assistant-ui/CopilotKit 研究中。外部报告的核心问题意识是正确的：Agentic UI 的目标不是增加聊天气泡，而是让 SaaS 已有业务能力、组件和操作在 Agent 交互中可发现、可呈现、可确认和可审计。

外部报告不应原样纳入仓库。它把维护方的产品叙事、生态观察、官方能力和设计推断放在同一证据层级，并把 CopilotKit/AG-UI 推成一般既有 SaaS 的默认主框架。核查后应改为：Controlled、Declarative、Open-ended 是有用的工程选择光谱，但不是已经完成的行业标准分层；assistant-ui、CopilotKit、AG-UI、A2UI、MCP Apps 和 LangChain json-render 解决的是不同层次的问题；没有任何一个框架自动提供 DSH Session 事实、业务授权、幂等提交、receipt 或唯一 continuation owner。

结合当前 DSH 代码和两个 Browser-Native PoC，当前结论保持尖锐而明确：对于“已有丰富业务 GUI、原来没有聊天层”的一般 SaaS，必须直接比较三个新增聊天层候选：DSH 原生 Web UI、assistant-ui 和 CopilotKit。当前推荐不是把 CopilotKit 排除，而是区分三种优势：DSH 原生 Web UI 的 DSH 语义完整度最高，CopilotKit 对 Agent 控制 React SaaS 应用的能力匹配度最高，assistant-ui 对既有 SaaS 的运行时耦合最低且已有真实 DSH 接入证据。针对当前 Browser-Native DSH，第一版默认先用 assistant-ui；若核心 KPI 是跨多个 React 业务模块的前端 Tool、HITL 和共享状态，则先做 CopilotKit + DSH adapter PoC；DSH 原生 Web UI 只在 DSH-native 产品或明确接受 DSH Client/Conversation/Slot 组合模型时优先。

本文是外部材料的审阅与整合记录，不是对任一框架的生产兼容性承诺。版本、API、许可和托管支持条件应在实施前按目标版本重新核查。

## Table of Contents

- [审阅范围与证据规则](#审阅范围与证据规则)
- [结论先行](#结论先行)
- [外部报告的事实核查](#外部报告的事实核查)
- [保留的研究价值](#保留的研究价值)
- [对 DSH 选型结论的修正](#对-dsh-选型结论的修正)
- [DSH 落地时必须保留的职责边界](#dsh-落地时必须保留的职责边界)
- [整合后的实施顺序](#整合后的实施顺序)
- [与现有文档的关系](#与现有文档的关系)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

## 审阅范围与证据规则

### 输入材料

审阅对象是外部报告的 349 行 Markdown 文件，调研日期标为 2026-10-18。它引用 assistant-ui、CopilotKit、AG-UI、Google A2UI、LangChain、OpenAI MCP Apps 等公开资料，但未在 DSH checkout 上做 PoC，也没有对生产吞吐、租户隔离、业务授权或真实 SaaS 组件迁移做验证。

项目内事实来自当前 `research` checkout 的源码、文档、PoC README、测试和已有研究报告。两个 PoC 已验证 Browser-Native DSH 的真实模型、Worker、Session 和聊天层接线范围，但没有验证完整的业务 capability、业务写入授权、receipt、复杂 Agentic UI catalog 或生产多租户部署。

### 证据等级

| 标记 | 含义 | 可以支持的结论 |
|---|---|---|
| 官方规范/官方文档 | 项目维护方或规范维护方当前公开的能力描述 | 可以说明 API、协议目标和明确的使用方式；不能单独证明生产质量或适合 DSH。 |
| 官方博客/产品页 | 维护方的发布叙事和方向信号 | 可以说明产品定位和设计意图；不能当作跨项目行业共识。 |
| 项目源码/发布包 | 实际导出、依赖和当前实现 | 可以核对 API 是否存在；仍需验证组合路径和升级稳定性。 |
| DSH 代码/PoC | 当前仓库已实现或已运行的事实 | 可以说明 DSH 当前能力和验证范围；不能外推到未测的业务场景。 |
| 设计判断 | 根据以上材料得出的推荐 | 必须明确标注为建议，不写成框架已经提供的能力。 |

-----

## 结论先行

### 外部报告哪些地方是对的

第一，它把评估轴从“聊天气泡是否好看”改成了“业务组件、工具生命周期、共享状态、HITL、授权和结果回执是否能闭环”。这是对 DSH 研究最有价值的贡献，应保留。

第二，它提出 Controlled、Declarative、Open-ended 三种 UI 控制模式。这个光谱与当前 CopilotKit 和 LangChain 官方材料的描述方向一致，适合指导 SaaS 选择固定业务组件、受限 catalog 和隔离 widget；但它应被称为“工程选择光谱”，不能写成已经统一的行业标准。

第三，它强调“既有业务组件是唯一组件来源”、避免任意 HTML/JSX、写操作必须确认并由服务端授权、不要为 Agent 重写一套平行业务组件。这些判断与 DSH 的 capability seam、Session 可回放、Tool presenter 和业务 API 权威性要求一致。

### 外部报告哪些地方必须修正

第一，不能从 CopilotKit 展示了较多 Generative UI 原语，直接推导它是一般既有 SaaS 的默认主框架。它的 hooks 和协议适配可以减少某些 React 应用交互的自有代码，但仍然需要 DSH adapter、Session 映射、业务授权、恢复和副作用归属设计。

第二，不能把 assistant-ui 描述成只适合纯聊天。当前官方文档已包含 frontend、human、backend、provider tool、Tool UI、`present` 组件词汇表、Data UI、A2UI over AG-UI 等能力。它在 App 级状态和业务 action 上是否足够，取决于集成方式，而不是一个“只能聊天”的产品边界。

第三，不能把 AG-UI、A2UI、MCP Apps 和渲染壳叠成一个产品栈就宣布“协议三角已成主流”。AG-UI 是 Agent 与用户应用之间的事件协议；A2UI 是受宿主 catalog 约束的声明式 UI 格式；MCP Apps 是把 Tool 与 UI resource 关联并在 Host 中加载 widget 的机制；assistant-ui 和 CopilotKit 是可选的 UI/runtime 集成。它们可以组合，但没有证明必须组合。

第四，不能把 `Open-JSON-UI` 写成已有独立的一手 OpenAI 官方标准。当前可核查的公开材料主要来自 AG-UI/CopilotKit 生态文档；未找到可独立核验的 OpenAI 官方规范仓库、版本政策或一致性测试套件。因此本文将其记录为“生态中出现的声明式 JSON UI 概念”，不作为 DSH 的协议依赖或行业标准依据。

-----

## 外部报告的事实核查

### 评估轴和模式光谱

| 外部报告断言 | 核查结果 | 修正后的表述 |
|---|---|---|
| Agentic UI 的重点是把已有 SaaS UI/操作带入 Agent，而不是聊天泡泡 | 事实判断成立 | 这是本研究采用的产品目标；实现仍必须拆分聊天呈现、业务 capability、授权、执行和事实记录。 |
| 业界已经收敛为清晰的三层栈 | 证据不足 | 当前可以观察到协议、声明式 UI 格式、渲染/runtime 和工具机制的分层趋势，但不存在足以代表全行业的统一栈。 |
| Controlled / Declarative / Open-ended 是三种模式 | 作为工程分类成立 | 这是一个有用的控制权光谱；应参考 LangChain/CopilotKit 的当前文档，不应称为共同标准。 |
| Controlled 适合核心交易，Declarative 适合长尾，Open-ended 适合隔离 widget | 设计建议成立 | 这是 DSH 的推荐策略，不是框架自动保证的安全属性；高风险动作仍需服务端授权、确认和可追踪结果。 |

LangChain 当前的前端文档明确把 controlled generative UI 描述为“组件由应用拥有、Agent 选择并传入参数”，把 declarative generative UI 描述为“Agent 生成结构化规格、宿主根据 catalog 渲染”，并把 MCP Apps 归入 open-ended、隔离和更不确定的方向。CopilotKit 的 Generative UI 文档也按 author-controlled 到 agent-invented 的光谱介绍能力。它们共同支持这个分类的实用性，但不支持“行业已经统一”的强结论。

### assistant-ui

| 外部报告断言 | 核查结果 | DSH 采用时的含义 |
|---|---|---|
| assistant-ui 是聊天 UI 原语和 Runtime | 成立 | 它适合承担新增聊天层；External Store Runtime 可以把 DSH 的消息/状态投影接入，不要求迁移 DSH Loop。 |
| assistant-ui 有 Tool UI、frontend/human tools 和 Generative UI | 成立 | 可以承载业务 Tool call、用户确认和受限 catalog，但 capability 的执行权和授权仍由 DSH/SaaS 负责。 |
| `present` 和 `defineGenerativeComponents` 可扩展业务组件词汇表 | 成立，但 API/package 需要锁版本 | 当前官方文档以 `@assistant-ui/generative-ui`、`JSONGenerativeUI`、`defineGenerativeComponents` 和 `present` 为主要材料；实现前必须重新确认目标版本的导出路径。 |
| 默认词汇表约 35 个组件 | 当前不成立 | 官方当前 Generative UI 页面显示默认词汇表为 27 个组件；组件数量是版本事实，不应作为长期选型依据。 |
| assistant-ui 已经自动解决 App 状态、业务 action 和 HITL | 不成立 | 它提供可组合工具和状态适配能力，但 DSH 仍需定义业务 capability、写入授权、确认、receipt、恢复和 Session 事件。 |
| Slack/Teams 转换和 A2UI 消费属于稳定默认能力 | 表述过强 | 官方文档存在相关路径，但它们是具体包和版本的能力，不代表所有 runtime、组件和频道都同等成熟；应按目标版本验收。 |

本次核查还发现 assistant-ui 的文档/API 正在演进：Generative UI 页面当前使用 `@assistant-ui/generative-ui` 的命名，而仓库 PoC 固定的是 `@assistant-ui/react@0.15.29`，并没有验证 Generative UI 业务组件路径。现有 PoC 的证据范围仍然是 External Store Runtime、多轮消息、流式文本、基础工具调用、失败恢复、刷新续接、真实 Chrome/Safari 和真实 LLM；不能把它升级描述为完整业务 Agentic UI 验证。

### CopilotKit

| 外部报告断言 | 核查结果 | DSH 采用时的含义 |
|---|---|---|
| Components as Tools 可以让既有 React 组件进入 Agent | 成立 | `useComponent`/`useFrontendTool`/`useRenderTool` 等模式值得作为 React SaaS 的参考，但组件注册不等于业务提交。 |
| CopilotKit 同时覆盖 Tool rendering、shared state、HITL、A2UI 和 MCP Apps | 官方能力描述基本成立 | 这些能力属于不同集成路径；不能因为文档集中展示就假定一个 DSH adapter 可以零成本覆盖全部路径。 |
| CopilotKit 有“六原语”并因此是默认主框架 | 结论过强 | “六原语”是报告对其文档的归纳，不是足以独立证明默认选型的标准。是否值得引入取决于它能否删除 DSH/SaaS 当前需要维护的代码和测试。 |
| AG-UI 让 CopilotKit 自动拥有 DSH 的 Agent Loop | 错误推断 | AG-UI 是事件协议；它不拥有 DSH Loop、Session log、continuation owner、业务权限或 receipt。 |

CopilotKit 的价值主要在于它把 React 应用交互、前端 Tool、渲染 Tool call 和用户响应组织成较完整的接入路径。对于 DSH，真正的成本在于把这些事件映射到 Worker 内同一个 Loop，并保证页面断开、重复响应、刷新和 unknown side effect 不会产生第二个执行者。因此它是条件性候选，不是默认依赖。

### AG-UI、A2UI、MCP Apps 和 Open-JSON-UI

| 技术 | 核查后的定位 | 不能由此推出的结论 |
|---|---|---|
| AG-UI | 官方 1.0 文档定义 Agent 与用户应用之间的有序类型化事件流，覆盖消息、Tool、状态、进度和中断等协议层语义 | 它不是聊天 UI、业务组件 catalog，也不是 DSH Session format 的替代品。 |
| A2UI | 官方站点当前标记 v0.9.1 为 current、v1.0 为 candidate；其核心是 Agent 发送声明式 surface 操作，Host 只渲染预批准 catalog | 它不会自动把已有 SaaS 页面迁移成 A2UI，也不负责业务授权和事务。 |
| MCP Apps | OpenAI 当前文档描述 Tool 通过 `ui://` resource 关联 widget，Host 在 sandbox iframe 中加载并通过 bridge 通信 | 它适合外部/隔离 widget，不是 DSH 内部复用既有业务 React 组件的必要条件。 |
| Open-JSON-UI | AG-UI/CopilotKit 文档中出现的声明式 JSON UI 概念；目前未核到独立一手 OpenAI 规范和 conformance suite | 不应写成“OpenAI 已发布的开放行业标准”，也不应作为 DSH 必选依赖。 |

AG-UI 1.0 的协议文档明确说它定义事件流、运行输入和交换双方义务，但不规定特定 Agent 框架如何运行，也不规定 UI 收到事件后必须如何渲染。这个限制很重要：采用 AG-UI 只能减少事件互操作工作，不能代替 DSH 对 Session、回放和 continuation 的设计。

### LangChain json-render

LangChain 当前官方文档把 json-render 作为其 declarative generative UI 路径，强调由开发者定义 catalog、Zod props schema 和 renderer，Agent 只生成 catalog 允许的结构化规格。它是值得参考的实现/框架候选，不是与 AG-UI 或 A2UI 等价的开放协议，也不能证明 LangChain 是 DSH 的运行时替代品。

### 版本、下载量和“行业趋势”

外部报告中的“npm 下载密度高”“已经成为主流”“协议三角已成主流叙事”等表述不构成 DSH 选型证据。下载量受包拆分、转发依赖、机器人和时间窗口影响；生态热度不能回答唯一事实源、浏览器 Worker 兼容、Session 恢复、业务授权和升级成本。此类指标应从报告的结论中删除，最多作为后续采购调研的弱信号。

-----

## 保留的研究价值

### 业务 capability seam 比聊天框架更重要

应该把每个 Agent 能力设计成由同一业务所有者维护的单元：Tool descriptor、输入/输出 schema、展示组件、用户确认、后端命令、权限检查、幂等键、receipt、Session 引用和恢复规则。聊天框架只消费或投影这个单元，不能成为业务事实源。

### 四种可复用的实现配方

| 配方 | 适用范围 | DSH 约束 |
|---|---|---|
| Components as Tools | Agent 选择一个预注册业务组件并传入参数 | 组件只能是展示/交互入口；写入必须回到授权业务 API。 |
| Backend Tool + Tool UI | 后端 Tool 继续执行，聊天层按 Tool name 渲染既有业务卡片 | Tool result、错误、取消和重复响应必须映射到 DSH Session。 |
| 受限声明式 catalog | Agent 组合只读卡片、比较、摘要、低副作用表面 | catalog 是 allowlist，不允许任意 HTML/JS；复杂写操作仍采用固定组件。 |
| Agent/App shared state + HITL | Agent 需要改变选中项、草稿或等待用户确认 | 状态更新与业务提交分开；模型可见状态需可重建，提交仍由服务端授权。 |

### 反模式

- 让模型生成任意 HTML、JSX 或 JavaScript。
- 为 Agent 复制一套平行业务组件和提交逻辑。
- 让前端状态、隐藏按钮或 DOM 操作成为权限依据。
- 所有写操作自动执行，或把“用户点击了卡片”误认为“业务已提交”。
- 在同一个面板中同时挂载两套可见聊天层、两份权威 transcript 或两个 continuation owner。
- 把通用 GenUI catalog 当成 SaaS 业务组件库，导致品牌、无障碍、领域校验和回归测试漂移。

-----

## 对 DSH 选型结论的修正

### 三条路线的直接比较

| 路线 | 最强项 | 最大短板 | 当前判断 |
|---|---|---|---|
| DSH 原生 Web UI | DSH Session、Tool、Conversation、Slot、HITL 和回放语义最完整 | 对既有 SaaS 的 Web Client composition、bundle、插件生命周期和 UI 迁移耦合最深 | DSH-native 产品首选；一般 SaaS 只有在愿意采用 DSH 前端体系时选择。 |
| assistant-ui + DSH | 新增聊天层接入成本较低，能隔离 DSH UI，并已有 Browser-Native DSH 真实 PoC | 业务组件 catalog、App 状态桥、复杂 action 和 HITL 语义需要 adapter | 当前一般既有 SaaS 的默认起步方案；先用 Controlled Tool UI 闭环。 |
| CopilotKit + DSH | 对 React SaaS 的 Components as Tools、frontend tools、Tool rendering、HITL 和 shared state 能力匹配度最高 | 与 DSH Loop、Tool lifecycle、Session、continuation 和恢复语义重叠最大；当前仓库没有完成组合 PoC | 深度 React 应用交互的高潜路线；先做专项 adapter PoC，不能直接宣布为默认生产方案。 |

### 既有 SaaS、没有聊天层

推荐新增一个唯一聊天层：对一般既有 SaaS 默认采用 assistant-ui；另一条明确路线是扩展 DSH 原生 Web UI。DSH 继续拥有 Browser-Native Agent Loop、Tool orchestration、Session event log 和续跑事实。assistant-ui 的价值是降低聊天呈现和 Tool UI 的自研成本；它不是业务 capability、授权或 Agent Loop 的替代品。

CopilotKit 不能只作为“以后再说”的附属项：如果 SaaS 是 React，并且目标是让 Agent 跨多个业务模块控制前端状态、组件和用户确认，CopilotKit 在能力匹配度上可能高于 assistant-ui。但这条路线必须先验证 DSH Worker、Session、pending interaction、刷新恢复和唯一 continuation owner；在这些问题验证前，不能把 CopilotKit 说成当前 DSH 的默认生产方案。

这条结论比“CopilotKit 是默认主框架”更适合 DSH 当前证据，因为 assistant-ui PoC 已经实际验证了外部聊天层接入 DSH Worker/Session 的最小路径，而 CopilotKit + DSH 的 Worker adapter、生产 self-managed 路径和业务 action 闭环尚未在本仓库验证。这里不是偏爱某个项目，而是把已验证路径和未验证路径分开。

### DSH-native 产品

如果产品本身就是 DSH Web，或团队明确接受 DSH Client、Conversation、Slot、Tool view 和 Host composition，则优先扩展 DSH 原生 Web UI。这样可以减少 Session event 到外部 message/part 模型的投影，但会把 SaaS 更深地绑定到 DSH 的 Web boot graph、bundle 和插件生命周期。

### CopilotKit 的进入条件

只有当多个业务模块确实需要统一的 React 前端 Tool、HITL、共享状态、Tool rendering 或 AG-UI 互操作，并且评估证明它会删除重复实现时，才引入 CopilotKit。引入时把它限定为 UI/application interaction adapter；不要让它启动第二个 Agent Loop、拥有另一份权威历史或直接绕过 DSH 的 continuation owner。

### A2UI、MCP Apps 和 json-render 的进入条件

A2UI 或 json-render 适合低副作用、长尾、跨端或多样布局的受限 catalog；MCP Apps 适合第三方或跨 Host 的隔离 widget。它们不应作为第一阶段替代既有 SaaS 业务表单、权限模型或 DSH Session。

-----

## DSH 落地时必须保留的职责边界

| 职责 | 唯一 owner | 外部 UI 可以做什么 |
|---|---|---|
| Agent Loop 和模型续跑 | DSH Worker/Host | 发送用户输入、呈现运行状态、提交明确的用户响应。 |
| Session 事实和回放 | DSH Session | 维护可重建的 read model；不能把 UI 临时状态写成未记录的模型输入。 |
| 业务授权与事务 | SaaS 后端/BFF | 提供 schema、显示状态、收集确认；不能以浏览器 handler 作为唯一门禁。 |
| 业务 UI catalog | SaaS 业务组件所有者 | 以 Tool UI、Components as Tools 或受限声明式 renderer 消费。 |
| 用户确认和人工输入 | 明确的 DSH interaction 或业务 capability | 显示待确认的参数、风险和结果；响应必须回到同一个 pending interaction。 |
| receipt、幂等和 unknown recovery | 业务服务与 DSH 执行层 | 展示状态和重试入口；不能在网络不确定时盲目重新提交。 |

这张表是把“框架选型”还原成可验收的系统边界。任何方案都必须回答：同一个业务故事中，谁创建 Tool call、谁显示它、谁等待用户、谁提交业务命令、谁记录 receipt、刷新后谁恢复、重复响应由谁拒绝。

-----

## 整合后的实施顺序

1. 盘点 3–5 个业务 capability，分别标记只读、需确认写入和高风险写入。
2. 从既有设计系统抽取可嵌入业务组件，不登记整页路由，不复制业务提交逻辑。
3. 先用 Controlled 方式完成“查询 → 呈现自家组件 → 用户确认/编辑 → 服务端授权 → receipt → Agent 继续”的闭环。
4. 将 Tool lifecycle、用户响应、错误、取消、刷新恢复和重复响应写入同一验收矩阵。
5. 只有当固定组件无法覆盖长尾需求时，再增加受限 Declarative catalog；只有第三方隔离交付需要时，才评估 Open-ended widget。
6. 用 DSH 原生 UI、assistant-ui 和 CopilotKit 候选实现同一业务故事，比较真正删除的代码、测试和维护职责，而不是比较 demo 的视觉效果。

成功标准不是“模型生成了一个漂亮卡片”，而是用户可以在不离开助手上下文的情况下完成真实业务任务，同时业务 API、权限、审计、Session 回放和错误恢复仍然可验证。

-----

## 与现有文档的关系

- [DSH Agentic UI 事实核查](dsh-agentic-ui-research.md)保留共享对话和外部协议的逐项核验；本文件补充外部 SaaS Agentic UI 报告的二次审阅，不替代它。
- [Browser-Native Agentic UI 综合报告](dsh-browser-native-agentic-ui-research.md)负责 Browser-Native 拓扑、Loop、Session、业务 capability 和安全边界；本文件的框架事实核查应与它的边界一致。
- [DSH Web UI 实现质量与 Agentic UI 框架选型评估](dsh-web-ui-quality-and-agentic-ui-framework-assessment.md)负责 DSH 原生聊天层与 assistant-ui 的 PoC 后比较；本文件解释为什么没有采纳外部报告“CopilotKit 默认主框架”的强结论。
- [Browser-Native DSH 的长期 UI 选型](assistant-ui-copilotkit-browser-native-dsh-assessment.md)负责 assistant-ui/CopilotKit 的长期候选、兼容性、生产接入条件和验收矩阵。
- [研究草稿导读](README.md)是目录入口；本文件是阅读外部 SaaS Agentic UI 材料时的事实核查入口。

-----

## Further Exploration

- [assistant-ui Generative UI](https://www.assistant-ui.com/docs/tools/generative-ui) — `present`、组件 vocabulary 和 `defineGenerativeComponents`。
- [assistant-ui Tool UI](https://www.assistant-ui.com/docs/tools/tool-ui) — backend/frontend/human tool 的呈现路径。
- [CopilotKit Generative UI](https://docs.copilotkit.ai/concepts/generative-ui-overview) — author-controlled 到 agent-invented 的能力光谱。
- [CopilotKit Components as Tools](https://docs.copilotkit.ai/generative-ui/tool-based) — React 组件作为前端 Tool 的路径。
- [AG-UI 1.0 specification](https://docs.ag-ui.com/spec/1.0) — 事件流、运行输入和协议义务。
- [AG-UI generative UI specs](https://docs.ag-ui.com/concepts/generative-ui-specs) — AG-UI 与 A2UI、MCP-UI、Open-JSON-UI 的关系说明。
- [A2UI](https://a2ui.org/) — 当前版本状态、catalog 和 renderer 入口。
- [LangChain declarative generative UI](https://docs.langchain.com/oss/javascript/langchain/frontend/declarative-generative-ui) — json-render、catalog 和 Zod schema。
- [OpenAI MCP Apps UI](https://developers.openai.com/plugins/build/chatgpt-ui) — Tool 关联 UI resource、sandbox iframe 和 bridge。

## Dev Note

本文完成于 2026-10-18，基于外部报告、官方公开文档、当前 DSH checkout 和已有 Browser-Native PoC 资料。外部项目文档和 package API 会继续变化；进入实施前应固定依赖版本，重新检查导出路径、许可/支持条件、Worker 兼容性和真实业务验收结果。本文没有将未验证的 CopilotKit + DSH 组合写成已完成能力，也没有把 assistant-ui PoC 的聊天层验证夸大为完整 Agentic UI 验证。
