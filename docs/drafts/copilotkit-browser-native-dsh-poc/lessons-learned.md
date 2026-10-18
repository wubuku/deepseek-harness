---
description: "CopilotKit 与 Browser-Native DSH 集成、Agentic UI 和真实浏览器验收中的可复用经验与陷阱。"
---

# 实施经验与陷阱

## 先确定权威事实归属

CopilotKit 是唯一可见的聊天和应用交互层；DSH Worker 中的真实 Cordis Host、插件、`ctx.agentLoop` 和 Session 负责执行事实。CopilotKit transcript 和 React state 是可重建投影，不是第二份模型历史或第二个 Agent Loop。页面关闭会终止 Dedicated Worker；backend 中仍有 Session 文件并不代表 Agent 在后台继续运行。

业务 GUI 必须仍是业务状态与操作的 owner。PoC 让 DSH 工具读取同一份 mock 工作区，并在聊天卡片中复用项目、标题、优先级和负责人字段；确认后调用同一领域状态函数更新工作区。实际生产集成还必须让业务后端重新鉴权、提交副作用并返回 receipt，不能把浏览器表单或模型输出当成授权决定。

## 前端工具必须结算原 DSH 调用

DSH Worker 发起业务工具调用并等待页面结果时，页面 renderer 只负责展示交互，不等于执行 handler 已经注册。PoC 通过 `client.frontendTools.register()` 建立页面响应端，再用稳定 DSH `toolCallId` 把确认、拒绝或取消回给原 waiter。结果必须形成原 Session 中匹配 call id 的 `tool/result`，让同一个 DSH turn 继续；不要在 CopilotKit run 结束后伪造成功，也不要把业务结果作为新的用户 prompt 提交。

`useRenderTool` 是 UI 呈现点，不自动替代 DSH tool executor。生产页面应把 React 回调留在 Main Thread，通过经过约束的序列化请求与 Worker 通信。副作用的稳定 operation id 必须由业务 API 去重；本 PoC 的 `operationId` 基于 DSH tool call id，但本地 mock 没有服务端幂等账本。

## Worker 启动前核对运行时和工具 schema

浏览器启动错误可能发生在模型请求之前。PoC 所用的 Worker 依赖显式资源管理符号；目标浏览器 realm 未提供 `Symbol.dispose` 或 `Symbol.asyncDispose` 时，DSH bootstrap 会在建 Session 阶段失败，因此兼容处理必须在 Worker 入口更早执行，不能只在页面 realm 安装。工具参数也必须按 DSH provider 要求声明为字段名到 JSON Schema 值的对象；把一个完整 JSON Schema 文档误放进 `parameters` 会导致 preset 校验在任何对话发生前失败。检查应覆盖 Worker realm 和最终加载的 overlay/profile，而不只检查 React 页面。

## Stop 必须进入 DSH 生命周期

锁定的 `@ag-ui/client@1.0.2` 中 `AbstractAgent.abortRun()` 不会自动取消 DSH Session。`DshAgUiAgent` 覆写停止路径，在 CopilotKit detach run 时取消同一 DSH Session turn，并处理用户 prompt 尚未被 DSH 接纳时的竞态。实现和验收必须分清 UI unsubscribe、AG-UI run detach、用户主动 Stop 和 DSH waiter settlement；只检查 Stop 按钮变回可点，不能证明 DSH 工具等待者已结束。

可靠的停止证据是：原工具调用收到取消结果、对应 DSH turn 以 aborted 结束、CopilotKit 回到 idle，随后新消息在同一 Session 正常完成。若任一状态缺失，后续输入可能看似已发送、但实际上被遗留 waiter 或写租约冲突阻塞。

## 用 Session 事件验证时序

DSH Session 是验证模型输入、工具结果和 turn 生命周期的事实来源。当前事件顺序中 `turn/start` 先于该轮 `user/message`；若测试错误地只在用户事件之后查找 `turn/start`，会误报恢复失败。应找到用户事件之前最近的 turn start，并等待同一 turn id 的 `turn/end`，不要只等 UI 文本出现。

每个 DSH tool call 应按 call id 匹配唯一结果；用户 prompt 不应重复写入；刷新后从 DSH Session hydration 恢复 transcript。模拟 SaaS 的 `localStorage` 与 DSH Session 是两份不同数据：前者恢复左侧业务列表，后者恢复模型可见历史。双标签测试还要观察 owner lease；第二标签必须明确显示只读并阻止提交，而非只显示错误但仍接受输入。

统计同源 LLM 代理请求时要把主 Agent Loop 和辅助标题生成分开。`step/start` 对应 Agent Loop 模型请求，DSH 还可能额外记录 `session/title-llm-request`；本 PoC 的代理请求总数应等于两类 Session 事件之和，而不能把标题生成误报为第二个 Agent Loop。

同一个 Session 在同一时间只允许一个有效写入 owner。不能在已有 writer 仍活动时为同一页面另开 write handle，也不能在 Session open 返回无效 lease 时继续挂载聊天控件。刷新恢复要先验证 open/owner 响应，再恢复同一 Session；另一个标签应显示只读状态，旧 owner 释放后由用户刷新重新申请，而不是自动并发接管。

## 真实 UI 需要按几何和语义验收

CopilotKit/Streamdown 实际使用的 Markdown 类名包含 `cpk:prose`；按 `.cpk-prose` 写选择器不会命中。Streamdown 列表项自身带有垂直 padding，因此修复列表间距时应检查实际 DOM class、computed style 和相邻 `li` 的顶边偏移，而不是只调父级 `line-height`。

输入框使用覆盖层时，Agentic UI 操作卡的确认按钮必须与输入栏矩形分离。欢迎建议只对新会话有帮助；对已有对话隐藏建议按钮，避免长线程末尾与 composer 争夺空间。聊天中的业务工具结果应呈现易读的业务摘要，完整结构化结果继续保留在 DSH Session；原样输出大型 JSON 会压过用户消息和表单。

真实模型的排版与工具选择并不确定。验证列表 CSS 时要明确要求模型输出固定数量的列表项，验证业务 action 时要显式指定 DSH 工具及输入值；HITL prompt 还要说明收到用户答案后应如何结束，单独限定问题与选项不保证模型不会再次提问。否则模型选择另一种合法响应会造成测试覆盖不稳定。断言要针对行为、Session 事件和元素几何，而不是固定模型全文。

业务工具完成消息不应把内部参数 JSON 当成用户结果。将调用/结果的原始结构留在 DSH Session，界面仅呈现可读的业务摘要，并单独显示用户编辑后的字段和确认状态；这样既保留审计证据，也不让协议数据挤占业务 UI。

## 自动化验收不要靠固定延时

真实 LLM 的响应时间会随 provider 和网络变化。测试可以给外层等待充分预算，但成功条件必须是明确 UI 状态或 DSH 事件；本 PoC 移除了 HITL 点击前固定 sleep，并按 tool result、turn end、刷新后的 hydration 和响应式布局条件同步。

## `docs/` 下的 npm PoC 要排除生成依赖

PoC 放在 `docs/drafts/` 可避免改动正式 app 和 package，但 `npm ci` 会在该目录生成包含 README、LICENSE 和 TypeScript 示例的 `node_modules`。仓库文档扫描必须在递归 glob 中排除依赖目录；仅有 `.gitignore` 不足以保护不读取 Git 忽略规则的文档工具。需在干净安装后运行 `pnpm run doc-sync`，并保留局部 lockfile 和 `.gitignore`。

真实 Chrome 与 Playwright WebKit 真实模型 E2E 通过只能证明这两个浏览器执行路径；WebKit 不等同 Safari.app 手动验收。报告中必须分别列出实际运行的浏览器、真实模型/脚本模式、截图、Session 事件、page error、请求来源和未执行项。模型 secret 只由 backend 读取 `.env`，不要打印日志或把文件复制到 PoC。

持久化恢复必须用隔离的数据目录和进程实际重启验证；只刷新页面不能证明 backend durable flush。双标签写权则是另一项独立测试，不应以单标签刷新恢复代替。每份测试记录都要把已通过的自动化案例和未做的原生 Safari.app 手动验收分开说明。

## 结论边界

本 PoC 证明 CopilotKit 可以作为新增聊天/Agentic UI 层，通过显式 adapter 将一个 React 业务流程接回 Browser-Native DSH 的同一 Agent Loop 和 Session。它支持将 CopilotKit 优先用于“既有 React GUI，且重点是把业务交互带入聊天”的下一轮真实业务验证；它不证明 CopilotKit 适合所有 SaaS，也没有实现生产 API 授权、幂等、审计、receipt、unknown recovery 或多租户安全。
