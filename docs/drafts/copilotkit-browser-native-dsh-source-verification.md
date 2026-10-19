---
description: "基于更新后的 CopilotKit main 源码，核查 Browser-Native DSH 接入聊天 UI、前端工具与 HITL 的可行性、许可提示、执行时序和恢复限制，供后续 PoC 决策与实施参考。"
---

# CopilotKit 与 Browser-Native DSH：源码核查与接入备忘

## Summary

Browser-Native DSH 可以作为 CopilotKit 背后的 Agent，Agent 不必在服务器上执行，AG-UI 也不限定为 HTTP/SSE。核查版本允许 React Provider 直接接受 `AbstractAgent`，不要求同时配置 Copilot Runtime 或 CopilotKit 云，但官方将生产选项 `selfManagedAgents` 归入 Enterprise Intelligence，当前代码对缺少 key 的行为只是告警，不能把产品定位、代码限制和软件许可证混为一谈。真正需要先验证的是工具调用的执行时序、DSH Session 的权威性，以及取消和恢复如何穿过页面与 Worker。本文记录源码事实和接入建议，不是已经完成 CopilotKit 集成或浏览器 E2E 的证明。

2026-10-19 实施证据补充：[基础增量 PoC](copilotkit-browser-native-dsh-poc/README.md)已使用 `@copilotkit/react-core@1.79.1` 的 `/v2` API、`AbstractAgent` 和自有 MessagePort 工具桥，验证一个 mock SaaS 业务闭环及真实模型 Chrome/WebKit E2E；随后[复杂续约实验](saas-agentic-ui-comparison-poc/complex/README.md)又验证了 `useFrontendTool`、`useHumanInTheLoop`、`useAgentContext` 与分段 DSH turn 的协作。基础 PoC 走的是 `useRenderTool` 加 DSH waiter 结算，复杂实验才验证原生前端工具 handler/HITL 的主路径。Provider 的 `agents__unsafe_dev_only` 也不等于受支持的生产接入。本文保留源码核查与时序风险分析的范围；当前路线结论见[三份 PoC 重评](dsh-web-ui-quality-and-agentic-ui-framework-assessment.md#三份-poc-后的路线重评)，实际复杂验收与限制见[复杂实验测试记录](saas-agentic-ui-comparison-poc/complex/test-results.md)。

## Table of Contents

- [核查基线与证据范围](#verification-baseline-and-evidence)
- [结论与需要收窄的判断](#conclusions-and-qualified-claims)
- [推荐的运行位置与职责](#recommended-execution-and-responsibilities)
- [前端工具与续跑的关键时序](#frontend-tools-and-continuation-ordering)
- [Session 与状态的接入规则](#session-and-state-integration-rules)
- [恢复与浏览器生命周期](#recovery-and-browser-lifecycle)
- [许可与生产接入的判断范围](#licensing-and-production-integration)
- [最小验证路线](#minimum-verification-path)
- [源码索引与验证记录](#source-index-and-verification-record)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="verification-baseline-and-evidence"></a>
## 核查基线与证据范围

核查日期为 **2026-10-18，Asia/Shanghai**。外部项目事实以本次 fetch 后固定的 CopilotKit 源码为准，不把在线文档、旧 tag 和 npm 的不同版本拼成同一个实现。

| 项目 | 本次观察 |
|---|---|
| CopilotKit 本地仓库 | `/Users/yangjiefeng/Documents/CopilotKit/CopilotKit` |
| 远端 | `origin`，`https://github.com/CopilotKit/CopilotKit.git` |
| 更新前 | detached HEAD，tag `v1.60.2`；工作区干净，无需 stash |
| 更新方式 | fetch `origin/main`，切换本地 `main`，仅 fast-forward |
| 核查提交 | `7b446f86e823e8af4695e78f7a61e800844a9373` |
| 提交内容 | `fix(web-inspector): show Trajectory evidence on Learning Insights (#7812)` |
| 提交时间 | `2026-10-16T18:14:52-07:00`，即北京时间 2026-10-17 09:14:52 |
| 更新后 | `main`、`origin/main` 和 HEAD 相同，工作区干净 |
| 相关包的源码版本 | `@copilotkit/core`、`react-core`、`react-ui`、`runtime`、`shared` 的 manifest 均为 `1.79.1` |
| 配套 AG-UI SDK | 相关包固定依赖 `@ag-ui/client@1.0.2`；本次另行读取该版本 npm 包的声明和 source map |

上述版本号是源码 manifest 的观察值，不表示本次另外验证了 npm 的最新 release。执行过的更新命令如下；更新没有创建提交、重写分支历史或丢弃本地文件。

```sh
git fetch origin main
git switch main
git merge --ff-only --quiet origin/main
```

证据分三类：CopilotKit 源码及其测试断言的静态阅读；配套 AG-UI SDK 声明与 source map 的阅读；当前 DSH 的 Loop、Session、审批服务及 Browser-Native PoC 的交叉核对。CopilotKit checkout 没有安装 `node_modules`，本轮没有安装整个 monorepo 的依赖，没有运行其测试、构建或真实浏览器。文中引用测试只表示仓库已有对应断言，不表示这些测试在本机通过。DSH 既有 PoC 的验收记录也不等于 CopilotKit 集成的验收记录。

-----

<a id="conclusions-and-qualified-claims"></a>
## 结论与需要收窄的判断

整体方向成立，但“可以适配”与“默认配置已经兼容”必须分开。下表是后续讨论应使用的判断。

| 判断 | 核查结果与准确表述 |
|---|---|
| CopilotKit 必须连接自家云 | 不成立。自托管 Runtime 和前端直接注册 Agent 都有实现；本地 Agent 存在时，Provider 不要求同时提供 `runtimeUrl` 或 public key。见 [C1]、[C2a]、[C2b]。 |
| AG-UI Agent 必须提供 SSE endpoint | 不成立。协议不限定传输；配套 SDK 的 `run(input)` 返回 `Observable<BaseEvent>`，可以由 Worker 消息产生事件。`HttpAgent` 才封装 HTTP。见 [A1]、[A2]。 |
| 前端直接注册 Agent 在生产时会被 key 检查阻断 | 当前源码不支持这个判断。`selfManagedAgents` 的 Enterprise 提示是 `console.warn`，注释也明确写明不强制执行。见 [C1]。 |
| 因根 LICENSE 是 MIT，所有 Intelligence 服务都免费 | 不能这样推导。代码许可证、外部依赖、托管服务与商业支持分别核对；也不能反过来用 Enterprise 文档直接推导 MIT 代码禁止商用。见[许可章节](#licensing-and-production-integration)。 |
| `useComponent` 只是被动展示一个 React 组件 | 不准确。它调用 `useFrontendTool`，注册模型可调用工具，并转发 `followUp`；被动展示已有 DSH 工具应优先评估 `useRenderTool`。见 [C4a]、[C5a]。 |
| CopilotKit 会重新执行每个 DSH 工具 | 过度概括。已有对应真实 tool result 时会跳过 handler；只有未结算调用或特定占位结果等情形才进入执行。见 [C3]、[C10]。 |
| CopilotKit 具有工具后续调用机制，因此一定产生第二个 Agent Loop | 不是必然。它递归调用适配器不等于再次独立调用模型；能否保持只有 DSH Loop，取决于适配器是否将后续调用识别为结果回送和续接。见 [C3]、[C9]。 |
| 只实现 `AbstractAgent.run()` 就覆盖完整聊天体验 | 不成立。恢复、显式 thread 接入、停止、detach 和 Session 切换还有独立生命周期。见 [C7a]、[C7b]、[A2]。 |
| `followUp: false` 可以让 CopilotKit 只渲染 | 不成立。它阻止后续 `runAgent()`，不阻止 handler 执行及 tool message 插入。见 [C3]。 |
| 现有 Browser-Native PoC 已经证明该组合 | 不成立。现有[第三方聊天层 PoC](assistant-ui-browser-native-dsh-poc/README.md)使用 assistant-ui，没有实现本文的 CopilotKit 适配器。 |

因此，没有发现由“Agent 在浏览器中执行”造成的不可解阻塞；同时也没有证据支持把完整工具、HITL 和恢复接入称为现成能力。

-----

<a id="recommended-execution-and-responsibilities"></a>
## 推荐的运行位置与职责

建议让 CopilotKit 消费 DSH 的执行与记录结果，而不是替换 DSH 的插件系统。前端直接注册的 Agent 是呈现与命令适配器，实际模型请求和工具编排继续由 Dedicated Worker 中的 DSH 决定。

```text
React main thread
  CopilotKit chat, components, forms
        |
  DshAgUiAgent: input routing, event projection, interaction bridge
        | MessageChannel / existing DSH Client connection
        v
Dedicated Worker
  DSH Cordis Host
  DSH Agent Loop, tools, approvals, Session
  RemoteLlmAdapter / RemoteSessionPersistence
        | Same-origin HTTP
        v
Application backend
  Identity, Session storage, write ownership
  LLM proxy, credentials, rate limits, business authorization
```

`DshAgUiAgent` 是建议新增的适配器名称，不是当前实现。AG-UI 的事件流应在页面与 Worker 之间由适配器产生，不需要为了模拟远端 Agent，再把 Worker 的事件绕到服务器后经 SSE 返回。现有 LLM proxy 返回的是 DSH `StreamChunk`，不能直接交给 CopilotKit 当成 AG-UI；LLM 数据流与 Agent/UI 事件流是两个不同接口，见 [Browser-Native providers](browser-native-dsh-poc/browser-native-providers.ts)。

| 职责 | 建议唯一负责人 |
|---|---|
| 模型选择、step 推进、工具编排与重试 | DSH Loop 与 Cordis 插件 |
| 权威对话、工具结果、模型可见上下文 | DSH Session |
| 聊天渲染、组件与页面交互 | CopilotKit 和业务 React 组件 |
| AG-UI thread/run/message/tool 身份映射 | DSH/CopilotKit 适配器 |
| Session owner 与持久化确认 | 后端存储和现有 provider，不能委托给 UI 状态 |
| 服务端凭据、租户权限与业务写入授权 | 应用后端 |

直接注册 Agent 会绕过 Copilot Runtime 的服务端中间件，不代表同时绕过我们的 Session/LLM 后端。省去 Runtime 只减少一个 Agent/UI 转发层，不会让浏览器代码成为可信的业务授权者。[C2a]

-----

<a id="frontend-tools-and-continuation-ordering"></a>
## 前端工具与续跑的关键时序

最大的实际风险是两种执行时序如何配合，而不是协议中是否存在 tool event。下面的 CopilotKit 行为来自核查版本的 `RunHandler`，DSH 行为来自当前 [tool-calls.ts](../../packages/core/agent-loop/src/tool-calls.ts)。

### CopilotKit 在 Agent run 返回后处理前端工具

普通 `runAgent()` 路径先 `await agent.runAgent(...)`，然后才调用 `processAgentResult()`。后者寻找未结算工具、执行 handler、插入 tool result；成功且 `followUp !== false` 时再调用一次 `runAgent()`。默认未设置 `followUp` 也会续跑，已有测试覆盖 true、false 和缺省三种情形。[C3] [C9]

```text
CopilotKit Core
  -> await adapter.runAgent()
  -> processAgentResult()
  -> await frontend handler / HITL respond()
  -> insert tool result
  -> call adapter.runAgent() again
```

DSH 的工具插件则可以返回一个等待页面执行结果的 Promise。Loop 记录 `tool/call`，等待 dispatch/finalize，记录 `tool/result`，再进入后续模型 step。如果适配器把一次 AG-UI run 一直保持到 DSH 整个 turn 结束，两个等待条件就可能互锁：

```text
DSH waits for the page tool result before ending its turn
CopilotKit waits for the Agent run to return before executing the page tool
The adapter waits for DSH turn completion before returning the Agent run
```

这是从两边源码时序推导出的集成风险，不是已经复现的产品死锁。`TOOL_CALL_END` 不能代替一次完整 Agent run 的返回，也不能代替真实 `tool/result`。仅发送若干工具事件，不足以启动这条默认 handler 路径。

### 已有的防重复机制有用，但不等于业务 exactly-once

`processAgentResult()` 会检查相同 tool call id 是否已经有真实结果；存在时不执行 handler。它也会识别文本为 `Forwarded to client` 的占位结果，在有 handler 时移除占位并执行。该 sentinel 是当前实现约定，不宜当作 DSH 的真实工具输出或跨项目稳定协议。[C3] [C10]

恢复历史时，普通工具默认保持被动；HITL 和明确声明 `reconnectBehavior: "resume-pending"` 的工具可以重新运行等待中的 handler。同一个实例内还有执行中调用去重，但源码类型说明明确指出，两个标签页或设备仍可能分别执行未结算调用。因此，本地去重和已有结果检查不能替代服务端业务幂等键、写权限和结果查询。[C6]

### 两种可评估路线

| 路线 | 执行方式 | 获得什么 | 仍需解决什么 |
|---|---|---|---|
| A：DSH 执行，CopilotKit 先只呈现 | DSH 插件通过独立页面桥接调用业务能力；CopilotKit 只投影调用与真实结果，使用 `useRenderTool` | 最少改变现有 Loop 和工具语义，适合第一阶段 | 不等于原生 `useFrontendTool`/`useHumanInTheLoop` 已接通；执行中状态、表单和取消还要桥接 |
| B：适配 CopilotKit 的工具续跑 | 工具请求出现后结束当前 AG-UI 调用段；CopilotKit 执行 hook；后续适配器调用把结果交回同一个 DSH 等待者 | 更接近完整复用前端工具、`useComponent` 与 HITL | 静态源码核查阶段尚未验证 run/turn 对应、工具结果回送、取消、UI running 状态和刷新后未知结果；后续复杂实验已在固定版本和受控 adapter 中验证主路径，生产恢复和授权仍未验收 |

路线 B 不应结束 DSH turn、伪造成功工具结果或发起独立模型循环。AG-UI run 段结束不等于 DSH `turn/end`；事件和 pending call 必须满足固定 SDK 版本的验证规则。适配器被再次调用时，应区分用户新输入与已有 tool result，不能把每次调用都变成 `followup()`。

路线 A 也不是“拿到 handler 就直接调用”这么简单：若要复用 CopilotKit 的 handler 注册表，还要接入它的执行状态、signal 和结果通知。公开 `core.runTool()` 不能直接当作已有 DSH 调用的结算 API，因为它会新建 assistant/tool call id、修改 `agent.messages`，而不是沿用原 DSH call id。不能为了复用方法制造第二次逻辑调用。[C3]

### 区分组件工具与被动渲染

`useComponent` 注册模型工具并默认继承前端工具续跑规则，即便没有业务 handler，也可能补入空工具结果并继续。`useRenderTool` 只注册呈现器，不调用 `addTool()`，更适合渲染 DSH 已拥有的工具。当前 v2 的 `useRenderToolCall()` 是渲染既有调用的 hook，不能与注册工具或渲染器的 API 混为一谈。[C3] [C4a] [C5a] [C5b]

React 组件和函数不应传进 Worker。建议仅发送工具 schema、版本、注册标识及 JSON 参数/结果；组件与函数留在主线程。路由卸载、插件卸载和取消都需要让等待者得到明确结算。`useFrontendTool` 会在卸载时移除工具但保留普通历史渲染器，HITL 又有自己的渲染器移除规则，这些生命周期不能用一个无清理的全局函数表替代。[C4b] [C4c]

-----

<a id="session-and-state-integration-rules"></a>
## Session 与状态的接入规则

DSH Session 应保持唯一权威，CopilotKit 的 `messages` 和 `state` 是面向 UI 的投影。仅保证 role/content 看起来一致不足以保证恢复和工具调用正确。

| 接入事项 | 必须遵守的规则 |
|---|---|
| thread 与 Session | 一个绑定必须对应明确的 DSH Session；多个聊天视图不能无意创建多个 writer |
| run、turn、step | 明确映射；采用分段工具续跑时，一个 DSH turn 可以对应多个协议调用段 |
| 输入历史 | 按稳定 ID 识别新增用户消息与新增工具结果，不把每次输入携带的整份 messages 再写入 DSH |
| 流式输出 | 保留 attempt、message、call id 与 Session seq 的关联；重试或中断片段不能混成已提交回复 |
| 历史恢复 | 先建立基线，再合并实时事件；重放只重建投影，不重执行普通副作用 |
| UI 操作 | 编辑、重生成、分支等操作必须映射到 DSH 支持的动作，否则禁用；不能隐式重写追加日志 |
| 工具结果 | 前端执行结果必须交回 DSH 工具执行者并进入 `tool/result`；写进 CopilotKit messages 不等于已经持久化 |
| 应用上下文 | `useAgentContext` 进入模型的内容先经过 schema、范围及敏感信息控制，并按 DSH 规则记录，不能成为不可回放的额外 prompt |
| 授权审批 | 确认 UI 接回答案服务，遵守请求归属、取消、晚到答案处理及日志规则，不能凭聊天消息绕过权限决策 |

Provider 已提供 `messageFilter`，但其说明和实现针对 Runtime proxy；直接传入的普通 `AbstractAgent` 不会自动受该过滤保护。配套 SDK 本身会从当前消息构造 run input，因此仍需在我们的适配器中处理增量身份与去重，不能把 `messages.slice(-1)` 当成完整方案。[C1] [C8a] [C8b] [A2]

现有 [assistant-ui 适配器](assistant-ui-browser-native-dsh-poc/src/dsh-session-adapter.ts)已包含 durable/live 消息投影、pending submission、发送和取消等参考机制，但不能直接照搬输出类型。CopilotKit 的事件归约、工具结果插入和 run 续接是另外的机制。

DSH 的[审批服务](../../packages/interaction/user-approval/README.zh.md)在没有可用 answerer 时 fail closed，并记录 `approval/asked` 和 `approval/decided`。`useHumanInTheLoop` 则是建立在前端工具 handler 上的 Promise/respond 机制；UI 同样显示“确认”不表示两者已经语义等价。[C4c]

-----

<a id="recovery-and-browser-lifecycle"></a>
## 恢复与浏览器生命周期

适配器不能只实现“发送一句话然后流式回答”。当前 CopilotKit Chat 和 Core 对初次连接、历史接入与停止有不同调用路径，可能主动重置本地投影。[C7a] [C7b]

### connect、detach 与 stop 必须分别定义

显式 thread 会进入 `connectAgent()`。Core 在新的恢复场景会先清空消息与 state，再接入历史；配套 SDK 的默认 `connect()` 抛出 `AGUIConnectNotImplementedError`，SDK 将其作为空连接处理。因此，只传 `initialMessages` 或只实现 `run()`，不能保证历史不会变空；应实现合适的 `connect()` 基线投影或另一种经过验证的 hydration 方案。[C7a] [C7b] [A2]

| 动作 | 建议语义与风险 |
|---|---|
| 建立历史连接 | 恢复 DSH Session 与事件游标，不产生新的用户 turn，不重复工具副作用 |
| detach / Observable unsubscribe | 解除当前观察或协议调用段；不应未经区分就销毁 Worker、撤销另一视图的写权或取消仍需续接的 DSH turn |
| 用户 stop | 显式传到 DSH `cancel()`，中断模型请求及页面等待，阻止后续自动续跑 |
| thread 切换 | 旧消息、监听器和 pending interaction 不可串到新 Session；明确旧执行是取消还是继续 |
| 正常卸载 | 释放监听器并尽力完成已有 Session close/flush；不把页面卸载回调当作可靠提交机制 |
| 崩溃或刷新 | 重新建立 owner 和持久化基线；未获确认的副作用进入查询/协调流程，不盲目重发 |

Core 在 run/connect 前会调用 `detachActiveRun()`。配套 SDK 的 Observable teardown 因而不能简单定义为“每次触发都取消整个 DSH Agent”。尤其路线 B 需要让页面中的 AG-UI 观察段结束，而 Worker 中的 DSH 等待者仍然有合法生命周期；真正 stop 则必须取消该等待者。[C3] [C7a] [A2]

普通 frontend tool 的被动恢复和 HITL 的恢复能力有助于重建 UI，但恢复一个 React Promise 不等于恢复了 DSH 的未完成工具；重新显示批准表单也不能证明旧批准仍有效。DSH 中缺少确定结果的中断工具应按[Session repair 语义](../../packages/core/session/src/repair.ts)处理，不能把 UI 恢复当作副作用尚未发生的证据。

### 云端 Agent 仍然有互补价值

Dedicated Worker 的寿命依赖页面；当前[PoC 的 owner、flush 与恢复限制](browser-native-dsh-poc/README.md#当前实现快照)不会因为接入 CopilotKit 而消失。长期后台任务仍适合交给 Cloud DSH：在已持久化 checkpoint 和可协调的工具状态下转移执行权限，暂停或 fencing 旧 writer，再由云端恢复。传递的是 Session、上下文、能力与执行权限，不是活着的 JS 堆、Promise 或 React 函数。

如果未来一个 CopilotKit 页面同时连接 Browser Agent 和 Cloud Agent，应分别标识执行位置、能力和 Session 归属。当前 `useAgent` 对普通注册 Agent 返回已有实例，并非无条件按聊天视图 clone；一个实例的 `threadId` 也会被 Chat 设置。多个并行 Session 应使用明确隔离的实例或 Provider，不应假定多个 Chat 自动隔离。服务器 Runtime 的 per-request clone 是另一条路径，不代表它能复制浏览器 Worker。[C7b] [C7c] [C11]

-----

<a id="licensing-and-production-integration"></a>
## 许可与生产接入的判断范围

本轮只记录可以核实的文件与代码行为，不给具体商业部署作法律意见。需要区分以下四件事。[C1] [C2a] [C12a] [C12b] [C12c] [C12d]

| 事项 | 固定版本观察 | 可以据此得出的结论 |
|---|---|---|
| 根 LICENSE 与相关 React/Core/Runtime manifest | 根 LICENSE 为 MIT，核查的相关 manifest 也声明 MIT | 没有发现这些文件将普通 React/Core 代码整体改成自定义商业许可证；不由此推导所有依赖或外部服务相同 |
| 官方产品文档 | `selfManagedAgents` 是生产配置，列为 Enterprise Intelligence；开发选项明确不推荐生产 | 官方生产支持与商业采用方式需要确认，不宜把开发入口当成稳定支持承诺 |
| Provider 的实际执行 | 两种 Agent map 合并；self-managed 同名优先；无 key 时仅告警，本地 Agent 可满足配置校验 | 当前不是“无 key 就无法运行”的技术限制；也不能从告警文字直接推导 MIT 的商用许可范围 |
| 外部 Intelligence/依赖/服务 | 自托管 Runtime 和云服务是不同路径，shared 还依赖 license-verifier 等包 | 应按实际依赖清单、许可证、服务条款和采购条件审查，不能只读根 LICENSE 或只读营销页面 |

生产选型前应固定要交付的包版本与依赖清单，确认是否使用 Intelligence 服务、其支持条件及用户数据流向，再针对具体部署审查条款。工程上不建议为消除告警而伪造 key、长期依赖 `unsafe_dev_only` 名义或 fork 掉提示后宣称已经解决许可问题。

还有一个直接影响数据流向的配置细节：当前 `chatApiEndpoint` 在没有 `runtimeUrl`、但存在 `publicApiKey` 或 `publicLicenseKey` 时会默认选择 Copilot Cloud 地址，即使同时注册了本地 Agent。给纯浏览器方案补一个 public key 不是只消除告警，可能同时启用云端 Runtime 发现等请求。生产许可配置与“哪些请求允许发往哪里”应一起验证；不能把示例中加 key 后的网络行为仍当成无 Runtime、无云访问。[C1]

自托管 Copilot Runtime 仍是有效的独立方案，但默认拓扑是浏览器请求服务器上的 Agent。若实际 DSH Loop 在用户页面 Worker，Runtime 要驱动它就需要额外的注册、路由、双向连接和断连恢复；它不能天然调用一个浏览器中的 `MessagePort`。这项复杂度不能被“换成自托管 Runtime”一句话省略。[C2b] [C11]

-----

<a id="minimum-verification-path"></a>
## 最小验证路线

建议先验证公开扩展点能否解决关键时序，再决定是否投入完整接入。以下均为待实施验收项，不是本轮已通过的测试。

| 阶段 | 最小实现 | 可观察的通过条件 |
|---|---|---|
| 1：聊天投影 | 本地 AbstractAgent + 真实 DSH Worker；同源真实 LLM proxy；DSH Session 基线与流式输出 | 不运行 Copilot BuiltInAgent；一个用户输入只进入 DSH 一次；页面不发给 CopilotKit 云；刷新恢复同一 Session |
| 2：DSH 工具只呈现 | 一个确定性 Cordis 工具，CopilotKit 仅注册 renderer | 相同 call id 的调用与结果正确配对；工具只执行一次；回放不执行 handler；工具错误不被呈现为业务成功 |
| 3：完整前端工具 | 只选一种续跑方案，加入一个有可验证副作用的页面/API 工具 | handler 能在正确时机启动，不互锁；回送结果在 DSH `tool/result` 中；后续协议调用不是重复 prompt 或新的独立模型循环 |
| 4：HITL | 一个信息收集表单和一个接回 DSH approval 的确认流程 | 取消、拒绝、批准和晚到答案各有明确结算；同名并行调用不串答；刷新不重复批准业务动作 |
| 5：生命周期 | stop、thread 切换、StrictMode、两标签页、Worker 被终止 | detach 与取消分开；没有遗留监听器或双 writer；未知副作用不自动重试；过期 owner 不能继续提交 |

每个逻辑副作用使用稳定的 operation id，重试复用该 id，并支持后端结果查询。工具执行计数、Session seq、模型请求计数、owner 变更和网络目的地址应作为验收观察值，不能只看聊天文本是否流畅。

最值得先做的是阶段 3 的小型时序实验：一个 DSH 插件等待页面工具，一个 `useFrontendTool` 结算它，DSH 在同一 turn 继续并持久化结果。如果公开接口无法实现或恢复语义成本过高，可以保留路线 A 的聊天/渲染组合，而不承诺完整 hooks 接入；此时 assistant-ui 仍是现有可比较的聊天层路线。

-----

<a id="source-index-and-verification-record"></a>
## 源码索引与验证记录

CopilotKit 链接固定到本次提交，避免 `main` 后续变化改变证据；DSH 内部链接指向当前实现的拥有者。函数名是定位依据，行号只是辅助。

| 标记 | 定位与用途 |
|---|---|
| C1 | [CopilotKitProvider.tsx][C1]：本地 Agent 合并、Enterprise 告警、缺省 endpoint、messageFilter 说明。重点为 `mergedAgents`、`hasLocalAgents` 与 `chatApiEndpoint`。 |
| C2 | [Self-managed agents][C2a]、[Copilot Runtime][C2b]：直接接入与服务器接入的产品定位、职责和限制。 |
| C3 | [RunHandler][C3]：`runAgent`、`processAgentResult`、`executeSpecificTool`、`runTool` 的实际时序和身份处理。 |
| C4 | [useComponent][C4a]、[useFrontendTool][C4b]、[useHumanInTheLoop][C4c]：注册、挂载清理、Promise/respond 和取消。 |
| C5 | [useRenderTool][C5a]、[useRenderToolCall][C5b]：渲染器注册与已有调用渲染的区别。 |
| C6 | [FrontendTool types][C6]：`reconnectBehavior`、handler context 及多标签页重复执行限制。 |
| C7 | [Core connectAgent][C7a]、[CopilotChat][C7b]、[useAgent][C7c]：基线清空、连接、detach、threadId 与已有实例。 |
| C8 | [Agent registry][C8a]、[message-filter tests][C8b]：本地/代理 Agent 注册、过滤应用范围及历史重复风险。 |
| C9 | [core-follow-up.test.ts][C9]：缺省/开启/关闭 follow-up 的测试断言。 |
| C10 | [core-frontend-tool-placeholder.test.ts][C10]：已有真实结果跳过执行、占位结果替换等断言。 |
| C11 | [Runtime agent-utils][C11]：服务端选择 Agent 后调用 clone，不能误套到普通本地 useAgent 路径。 |
| C12 | [LICENSE][C12a]、[core manifest][C12b]、[react-core manifest][C12c]、[runtime manifest][C12d]：许可声明、版本与依赖。 |
| A1 | [AG-UI architecture][A1]：协议的 transport-agnostic 定义。 |
| A2 | [@ag-ui/client 1.0.2 元数据][A2]及其 npm tarball：`dist/index.d.ts` 的 `AbstractAgent`，source map 的 `src/agent/agent.ts`，核对 Observable、connect、detach 与输入构造。 |

本轮执行了 `npm pack @ag-ui/client@1.0.2 --pack-destination /tmp --silent`，只下载到 `/tmp/ag-ui-client-1.0.2.tgz`；没有向 CopilotKit 或 DSH 安装依赖、写入 lockfile。包内声明确认 `abstract run(input: RunAgentInput): Observable<BaseEvent>`，source map 确认默认 connect 的未实现处理和输入 messages 构造。主仓库 API 文档也给出[自定义 Observable Agent 示例][C13]，但示例不替代我们的 Worker 集成测试。

本文本身没有修改 DSH 核心或既有两个独立 PoC；增量实验代码位于 `docs/drafts/copilotkit-browser-native-dsh-poc/` 和 `docs/drafts/saas-agentic-ui-comparison-poc/complex/`。本文只维护中文单篇；源码核查和受控实验通过都不表示生产集成已经完成，实际验收范围以对应测试记录为准。

-----

## Further Exploration

本文负责此次固定版本的核查与接入风险，以下文档分别拥有选型背景、现有实现和业务能力设计，不应复制为另一份实施规格。

- [assistant-ui 与 CopilotKit 长期 UI 选型](assistant-ui-copilotkit-browser-native-dsh-assessment.md)：为什么应用交互框架与普通聊天层是不同的采用决策。
- [Browser-Native DSH PoC](browser-native-dsh-poc/README.md)：真实 Worker Loop、Session/LLM backend、当前 owner 与持久化限制。
- [assistant-ui 增量 PoC](assistant-ui-browser-native-dsh-poc/README.md)：现成的第三方聊天层适配参考，不是 CopilotKit 完成证明。
- [复杂续约实验](saas-agentic-ui-comparison-poc/complex/README.md)：CopilotKit 原生 frontend tool/HITL 与 DSH 分段 turn 的实际验收入口。
- [Browser-Native 工具清单与配置裁剪](browser-native-dsh-poc/browser-native-tool-roster-and-configuration-research.md)：按执行环境暴露业务 capability，而不是把 Node 工具原样搬进页面。

## Dev Note

本轮没有决定生产许可方案。复杂实验在不修改正式 DSH 核心的前提下，证明公开 frontend tool/HITL 能在受控 adapter 中工作，但没有消除生产 Agent 注入、业务授权、跨进程幂等和 unknown recovery 的要求，也不是所有业务均可零改动接入的承诺。下一次实施应先读取本文的固定版本、工具时序和恢复要求，再建立隔离 worktree；新增适配器与验证材料优先放在 `docs/drafts`，必要的目录外修改按既有 [change ledger](browser-native-dsh-poc/change-ledger.md)记录原因、测试和 upstream 重放方式。

[C1]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/packages/react-core/src/v2/providers/CopilotKitProvider.tsx
[C2a]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/showcase/shell-docs/src/content/docs/backend/self-managed-agents.mdx
[C2b]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/showcase/shell-docs/src/content/docs/backend/copilot-runtime.mdx
[C3]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/packages/core/src/core/run-handler.ts
[C4a]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/packages/react-core/src/v2/hooks/use-component.tsx
[C4b]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/packages/react-core/src/v2/hooks/use-frontend-tool.tsx
[C4c]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/packages/react-core/src/v2/hooks/use-human-in-the-loop.tsx
[C5a]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/packages/react-core/src/v2/hooks/use-render-tool.tsx
[C5b]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/packages/react-core/src/v2/hooks/use-render-tool-call.tsx
[C6]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/packages/core/src/types.ts
[C7a]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/packages/core/src/core/run-handler.ts#L517
[C7b]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/packages/react-core/src/v2/components/chat/CopilotChat.tsx
[C7c]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/packages/react-core/src/v2/hooks/use-agent.tsx
[C8a]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/packages/core/src/core/agent-registry.ts
[C8b]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/packages/core/src/__tests__/message-filter.test.ts
[C9]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/packages/core/src/__tests__/core-follow-up.test.ts
[C10]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/packages/core/src/__tests__/core-frontend-tool-placeholder.test.ts
[C11]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/packages/runtime/src/v2/runtime/handlers/shared/agent-utils.ts
[C12a]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/LICENSE
[C12b]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/packages/core/package.json
[C12c]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/packages/react-core/package.json
[C12d]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/packages/runtime/package.json
[C13]: https://github.com/CopilotKit/CopilotKit/blob/7b446f86e823e8af4695e78f7a61e800844a9373/showcase/shell-docs/src/content/docs/backend/custom-ag-ui-agent.mdx
[A1]: https://docs.ag-ui.com/concepts/architecture
[A2]: https://registry.npmjs.org/@ag-ui/client/1.0.2
