# 复杂业务实验的设计与评估

## 参考范围

评估对象是已有丰富 GUI、没有聊天层的 React SaaS，不是一个新聊天产品。故事是客户续约：用户处理工单、切换客户、与 Agent 协同修改报价，在聊天里审核同一个报价组件，最后发送。相同业务对象、API、组件、模型、提示与故障标准约束三条路线；允许框架使用自身原生交互机制。

## 执行与状态

Dedicated Worker 内运行真实 Cordis Host、插件和默认 `ctx.agentLoop`。`worker-tools.ts` 通过 VFS 的工具服务注册页面能力，页面消息经过验证后撤销旧页面工具；没有改动正式 packages 或默认 Loop。工单页提供读取与批量分配，报价页提供读取、报价补丁和发送；只读角色撤销业务修改工具，后端仍独立校验角色。

DSH Session 拥有用户输入、工具调用、模型可见上下文和工具结果。业务 API 拥有报价、审批、工单与 receipt。React 与 CopilotKit 是投影和交互入口，不是另一份模型历史或业务数据库。`useAgentContext` 收集的数据经 `page_read` 的真实 DSH 工具结果进入日志，而不是私下拼入 LLM 请求。工具 JSON schema 仍由 DSH 注册表提供，前端 hook 不接管 DSH 的能力权威。

GUI 与聊天中的 `QuoteEditor` 是同一组件，`submit` 是同一提交函数。报价使用字段补丁与 expectedVersion；人工预算保存后，Agent 仅调整折扣。修改撤销旧版本审批，发送只能接受人工批准的当前版本。每次写入使用稳定 operation id，相同请求返回原 receipt，不同参数复用 id 被拒绝；调用已开始后停止不承诺回滚。

这里的 Agentic UI 是确定性业务组件的选择、参数化呈现与可继续执行的交互，不是让模型生成任意 React 代码。用户切换已有页面后，新一轮模型请求只获得当前页面能力；没有额外实现自动导航工具。CopilotKit 的优势验证集中在原生调度和协作，而不是扩充业务权限。

| 标识 | 本实验映射 |
|---|---|
| AG-UI thread | DSH Session id；业务 workspace 另行标识 mock 数据，不代替 Session 或租户授权 |
| AG-UI run | 一次观察段，多个 run 可以对应同一个 DSH turn |
| DSH turn / step | turn 只由新用户 prompt 开始；step 由默认 Loop 执行模型请求与工具，不由前端续接创建 |
| message / tool call | 历史消息使用 DSH id，工具结果必须匹配原 call id；流式临时消息最终由已落盘消息替换 |
| Session seq | durable cursor 与 transient 去重位置，不能拿 AG-UI run 数代替日志顺序 |
| operation id | Agent 写入使用 Session id 与原 call id；审批增加 decision 后缀；一次 GUI 提交生成独立 id，查询或重试复用同一个 id |

## CopilotKit 的原生续接

```text
一个 DSH turn
  page_read 工具开始，等待页面
    AG-UI 段结束；原 DSH turn 不结束
    CopilotKit RunHandler 调用原生 useFrontendTool handler
    下一 AG-UI 段把相同 call id 的结果交回 Worker waiter
  DSH 继续请求模型
  ask_user_question 通过 DSH 问答服务等待
    AG-UI 段结束
    useHumanInTheLoop 呈现既有报价组件，用户编辑并 respond
    下一段把答案交回同一个 DSH 问答等待者
  DSH 读取新版本、调用发送工具、最终结束 turn
```

协议段不是新用户输入、不是新 DSH turn，也不是 CopilotKit BuiltInAgent 的模型循环。分段适配器仅在第一次用户消息时调用 `session.prompt()`；后续只结算原 pending call。CopilotKit handler 不提前直接结算 waiter，结果由它的原生执行设施生成 tool message，再由下一协议段交回 DSH。最终显示仍重新投影真实 Session。未使用会创建新 call id 的便捷工具执行 API。

`useFrontendTool` 注册随页面卸载；HITL 使用原生 respond，而不是直接调用一个从注册表偷取的函数。停止同时经过 CopilotKit stop 与同一 DSH Session cancel。取消和卸载观察分开：unsubscribe 只移除监听，用户 Stop 才取消执行。等待工具时锁住新消息输入，避免把新 prompt 误判为结果续接。缺少结果的续接拒绝并保留原暂停状态。

刷新不会保留旧页面函数。DSH 的中断恢复事实优先；没有结果的历史调用转成明确的中断展示，不能作为新的待审批动作自动执行。此策略不宣称任意组件卸载再挂载都能恢复执行中的业务交互。

## 三路线的实际区别

| 路线 | 本实验使用机制 | 实际承担的协调 |
|---|---|---|
| DSH 原生 UI | Cordis Client、原生聊天/输入、工具 slot | 不需要新增 AG-UI 投影，但已有 SaaS 与 DSH renderer 是不同 React root，需要显式同步业务 Context，否则聊天编辑后审批仍使用旧版本。 |
| assistant-ui | ExternalStoreRuntime、Message/Composer primitives、工具组件 | 外部 Session 投影接入集中；工具执行与人工等待由 DSH 页面桥协调，业务组件直接使用 SaaS React Context。 |
| CopilotKit | 官方 CopilotChat、原生 frontend handler、HITL respond、Agent context | 获得声明式工具注册、框架执行状态和人工交互设施，但仍需 DSH 分段适配、精确身份与结果结算，以及 Worker 工具目录同步。 |

不能再说“CopilotKit 原生工具和 HITL 只有理论价值”：本实验已有真实闭环。但也不能说它自动解决权限、协同合并、持久化、取消回滚或 exactly-once；这些仍由 DSH 与 SaaS 实现。与第一轮 renderer-only 接入相比，本轮增加了框架原生路径，同时也暴露了更复杂的协议时序与恢复维护成本。

## 初步路线判断

| 评估面 | DSH 原生 UI | assistant-ui | CopilotKit |
|---|---|---|---|
| 已有 React 资产复用 | 聊天 renderer 与 SaaS 是不同 React root；需显式订阅和同步业务 Context。 | 业务组件留在 SaaS React 树中，ToolCall component 可直接复用；Session 投影和命令续接由适配器负责。 | 业务组件也留在 SaaS React 树中；frontend tool、HITL 与 Agent context 提供声明式应用交互入口。 |
| 复杂页面协作 | 可由 DSH tool slot 呈现，但需自行处理跨 root 状态同步、工作区装配和 SaaS 视觉裁剪。 | 能呈现复杂组件，但跨页面上下文、原工具等待者和人工回答主要由 SaaS/DSH 桥编排。 | 本实验实际跑通页面工具、共享报价组件、版本冲突、拒绝/批准、停止和同一 DSH turn 续接。 |
| DSH 执行一致性 | 最直接使用 DSH Client 与 Session 投影，不需 AG-UI 接线。 | 通过 ExternalStoreRuntime 投影 DSH Session；自定义执行桥仍需守住 call id、取消和恢复。 | DSH 仍是唯一 Loop 和事实来源；AG-UI 分段适配承担额外时序与身份维护。 |
| 当前证据强度 | 新复杂故事在 Chrome scripted 全流程通过；本轮没有为原生 UI 补做等量真实模型复杂故事。 | 新复杂故事在 Chrome 与 Playwright WebKit 的真实模型全流程通过；WebKit 不等于 Safari.app。 | 新复杂故事在 Chrome 与 Playwright WebKit 的真实模型全流程通过；另有 CopilotKit 真实生命周期证据；WebKit 不等于 Safari.app。 |

因此，针对**多页面、已有业务组件深度参与、需要人工与 Agent 交替决策**的成熟 SaaS，当前优先建议继续产品化验证 CopilotKit：其附加价值已从 API 列表变成同一 DSH turn 内的可运行闭环。它不是免集成捷径，DSH 分段桥是实质成本与主要故障面。对于主要需求是新增聊天、复杂互动较少且团队愿意自己编排页面命令的产品，assistant-ui 仍是职责较窄的基线。若 SaaS 必须保持现有 React 应用外壳，DSH 原生 UI 应先解决 renderer root、Context 同步和 workspace chrome 的整合问题，不能仅凭 Session 语义完整就视作嵌入成本最低。

这只是按架构责任和当前 PoC 证据给出的**初步排序**，不是经团队工时、生产包体和维护周期测量的总成本排名。本轮已经让 assistant-ui 与 CopilotKit 运行同一个真实模型复杂故事；DSH 原生 UI 仍只有 scripted 复杂故事证据，因此不能把三者的真实模型结果写成等量比较。真实模型还可能出现空回复或在版本变化后安全停止，测试保留失败证据并要求重试或显式续接，不能把偶然一次通过当作稳定性指标。

## 推荐的适用范围

对有多个页面、就近声明业务能力、多阶段人工介入需求的成熟 SaaS，CopilotKit 值得进入优先产品化验证，而不是被列为最不推荐。它的优势是已有应用交互设施可以在 DSH 执行权不变的情况下真正被使用；不是别人做不出相同表单。轻量聊天接入仍可先以 assistant-ui 作为窄职责基线，不应把高协作场景的结论无条件推广到所有 SaaS。

assistant-ui 仍是聚焦的聊天/工具呈现候选，尤其当产品愿意自己维护业务交互协调，或需要更小的框架职责面。DSH 原生 UI 的 Session 语义完整，但把既有 SaaS Context 带入独立 renderer root 不是零成本，工作区装配和原生产品界面的裁剪也不能忽略。

本轮没有工时对照、生产注入、真实企业认证与设计系统集成证据，因此不宣布总成本冠军。下一步应让真实业务团队接入一个新的模块，分别统计一次性 adapter 成本、每模块新增协调、测试维护和生产依赖；不能只比较 hook 行数。

## 已验证的工程经验

- 原生工具调度必须先解除 AG-UI run 对 DSH turn 完成的等待，否则 DSH 与框架互等。分段解决调度顺序，不能伪造 DSH 工具成功或新增用户输入。
- 页面 hook 收集的上下文不等于已经进入 DSH 模型历史。此次通过真实 `page_read` 工具结果落盘，刷新后可重建；后续新增模型可见信息也必须有相应 Session 事实。
- 同名工具的历史卡不代表现在仍有业务执行权。精确 call id、存活 waiter、页面/客户/选择检查、服务端角色与版本校验分别承担不同责任。
- DSH 原生 renderer 与 SaaS 是不同 React root，不能只把最初的 Context 值传给工具卡。对照路线通过外部订阅同步，否则人工保存新报价后可能批准旧版本；额外 UI 装配成本不能省略。
- 原生浮动输入区会遮住动态变高的业务表单。本实验只在新入口为其 scrollport 保留 composer 高度，不修改正式 UI；原生工作区界面与默认工作区提示仍未作 SaaS 产品化裁剪。
- 通用 CSS 变量名可能与聊天框架碰撞，出现浅色背景上近白文字。本实验业务色值统一使用 `--orbit-*`；Markdown 列表保持紧凑间距，截图检查真实交互卡而非只看初始页。
- Playwright 全页截图会改变基于视口高度的聊天布局，不能据其瞬时滚动位置推定用户看见的界面。审核证据使用实际 viewport，并验证表单进入聊天可见区；不靠截图代替业务状态断言。
- 原生 Lexical 输入需要等待预览说明和内部初始化；自动化使用逐字符输入与真实发送按钮。API 参数不变的无效更新也不能作为冲突用例，故测试明确执行 8% 到 9% 的真实修改。
- 刷新未完成审批时，DSH 可能已产生真实的中断工具结果。应接受该事实并禁止旧按钮再执行，而不是要求它必须命中自定义 hydration 文案。停止或外网失败后，下一轮仍必须能响应。
- 模型代理的总请求数还包含 DSH 标题服务；标题请求也可能携带同一个 Session id。测试按实际标题输入区分辅助请求，再核对对话模型请求与 DSH step 数，不能把总数多一条误判为第二套 Agent Loop。

以上是本实验的已解决问题与适用范围，不是要求把所有生产化工作都完成后才能使用 PoC。命令、通过范围和残留限制统一见[测试记录](test-results.md)。
