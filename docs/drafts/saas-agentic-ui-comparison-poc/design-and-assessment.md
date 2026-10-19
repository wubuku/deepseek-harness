# 设计与评估口径

## 控制变量

三种入口不是三个独立聊天 demo。它们使用同一 `dsh-client.ts`、`browser-native-worker.ts`、`saas-tools.ts`、页面桥、业务表单和同源 API；UI 参数只选择保留原生 UI 插件还是挂载第三方聊天层。所有模型调用走 DSH LLM adapter；CopilotKit 的 AG-UI 事件和 assistant-ui 外部状态都是 Session 投影，不保存第二份模型历史。

本实验通过 overlay 重述完整 `preset-standard.config`，只保留 SaaS persona，额外注册四个业务工具与 DSH 问答工具。它没有加载 bash、文件和 web 工具；测试逐一检查 `request/header` 的工具列表。完整 config 替换必须保留 preset 的 `id`，不能把 Cordis patch 当成深合并。工具提示明确要求读当前数据、尊重最终编辑值、拒绝后不自动重试；这些说明对三条路线完全相同。

## 三种接线

| 路线 | 复用的真实呈现层 | 新接线 | 成本与观察 |
|---|---|---|---|
| DSH 原生 | Cordis Client、原生 Conversation/composer/chat、工具 slot | `uiWorkspace.openSession`、`uiRenderer.mount`、按 wire tool name 注册 `tool.call.toolview` | 不需要新增历史投影；但要理解工作区、Session retain、slot 声明与呈现策略，不能把根 slot 当普通 React 容器。 |
| assistant-ui | `ExternalStoreRuntime`、Thread/Message/Composer primitives | 复用已有 DSH Session adapter；ToolCall component 用精确 `toolCallId` 挂共同表单 | 业务 UI 挂接直接，聊天布局自有；Markdown、错误态与 composer 样式仍由产品组装。并非只能显示气泡。 |
| CopilotKit | 官方 `/v2` Provider 与 CopilotChat | 复用 DSH AG-UI adapter；`useRenderTool` 以原 `toolCallId` 挂共同表单 | 官方聊天组件省去较多布局组装；但业务执行依然依赖共同页面桥，未证明原生前端工具调度额外省下多少代码。 |

原生路线使用真实原生 UI，未用自写聊天框冒充。为使任务、工单和审批卡始终可直接操作，显式选择 `ui-chat.transcriptView=verbose`，避免把业务表单作为折叠的执行细节。原生工作区选择和预览版提示仍在，属于尚需产品化裁剪的 DSH-specific chrome。不能把这些改造隐藏后再称原生方案“零适配”。

## 调用和业务写入

工具执行仍在 Worker 的 DSH tool pipeline，工具以 `exec.agent.id` 和 `exec.callId` 发 MessagePort 请求。页面桥只允许精确调用身份结算，去掉旧 CopilotKit PoC 的 `resolveLatest` fallback；完成调用重放已有结果，取消和卸载撤销等待者，晚到回答不能结算另一个调用。

业务表单确认先调用同源 API。API 校验 mock 角色、字段和记录版本，在单进程串行事务中以稳定 operation id 查账本，写入 `saas.json` 后返回 receipt；相同 id/相同参数返回原 receipt，不同参数冲突。页面再将原 receipt 交回同一 DSH 工具，原 turn 继续。`requestId` 只负责 Session/代理协议关联，不当成业务幂等依据。

用户取消表单返回 `{ok:false,cancelled:true}` 而不写业务系统；Stop 走同一 DSH Session 的取消方法。刷新历史只渲染，不调用业务 API 重放副作用。等待中刷新不会把 React 函数或旧 waiter 带进新 Worker；后台业务 receipt 与 DSH 日志之间的自动对账尚未实现。

## 如何判读比较

1. 先问三条路线能否完成相同任务、编辑、确认、取消、记忆、停止和恢复，不以某个框架先写了更多 demo 功能作为胜出依据。
2. API receipt、DSH `tool/call` 与 `tool/result`、模型请求数及浏览器状态共同构成证据；模型口头说“已完成”不是业务成功凭据。
3. 自然语言输入不强制工具名；模型可能选择不同次数的数据读取，或者在只读角色直接拒绝。这是模型行为，不直接归因为聊天框架优劣。Scripted 对照才固定工具序列。
4. 复用原两份 adapter 是既有投资，不应把新增文件行数直接当成路线总成本；原生没有新增 adapter 也不表示 UI 能作为普通 React SDK 零配置嵌入。
5. 同包加载三种依赖是实验控制手段，不能据此比较生产包大小、性能或许可支持。当前固定版本不代表未来版本能力上限。

## 推荐判断的变化

[后续复杂实验](complex/design-and-assessment.md)改用 CopilotKit 原生前端工具与 HITL，直接检验本轮尚未覆盖的附加价值。本节保留第一轮 renderer-only 实验的适用范围，不把未验证项沿用为新实验的否定结论。

本轮同口径实验三条路线均通过，因而不能再用“只有 CopilotKit 能接 SaaS 业务”作为选型论据：同一业务表单和 API 可以接入原生工具 slot、assistant-ui ToolCall component 和 CopilotKit renderer。真正难的共性是执行身份、取消、API 权限/版本、幂等、Session 与业务凭据的一致性；不是增加气泡。

对于题设成熟 React SaaS，**assistant-ui 应作为轻量新增聊天层的优先评估基线，CopilotKit 是需要更完整应用交互设施时的强候选，DSH 原生 UI 适合愿意接受其 Client/工作区装配体系的产品**。这不是宣称 assistant-ui 已在所有维度胜出：本轮只使用 CopilotKit renderer，没有同口径检验原生 frontend tool、shared state、A2UI 等额外能力，因此也不能由此判定这些能力无价值。产品已有复杂 UI 若能直接复用业务组件，两种第三方方案都不需要模型生成任意新组件。

复杂续约实验进一步证明，CopilotKit 原生 frontend tool、HITL 与页面协作可以接入同一 DSH 执行回路；因此对跨页面、共享组件、多阶段审批这类高协作场景，**CopilotKit 已从“强候选”上升为优先产品化验证路线**。这修正的是复杂场景下的优先顺序，不推翻 assistant-ui 作为较轻聊天层基线，也没有证明 CopilotKit 总工程量更低。DSH 原生 UI 的主要风险仍是把已有 SaaS React 状态接入独立 renderer/workspace，而非其 Session 语义不足。

该判断必须与[测试记录](test-results.md)一起读：未通过或未执行项目不能被这段架构判断覆盖。生产定案仍需要接入一个真实高价值流程，验证实际认证、复杂组件上下文、设计系统隔离、生产 Agent 注入、并发恢复与性能。
