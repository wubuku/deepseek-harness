---
description: "核查 Browser-Native DSH 是否可以通过 Cordis/profile/preset 配置裁剪不适用的主机工具，并提出浏览器环境的工具清单与能力设计原则。"
---

# Browser-Native DSH 工具清单与配置裁剪调研

## Summary

本文回答两个相互关联的问题：第一，Browser-Native DSH 是否可以通过配置让 Agent 不再看到不存在的 `bash`、`web_search` 和 `web_fetch`；第二，浏览器中的 Agent 是否应该继续继承常规主机 Agent 的工具清单。

结论是：**可以通过配置避免当前 PoC 中大部分无意义的尝试，但不能只禁用 provider，也不能只在 UI 层补一段提示词。必须在 Agent 第一次模型请求之前，裁剪实际的 model-facing tool roster，并让 system prompt、Tool provider 和执行位置保持一致。**

DSH 已经具备实现这一点所需的组合机制：Cordis profile patch 可以禁用或替换插件行；`@deepseek-ai/dsh-tool-web` 的 `search`/`fetch` 配置可以分别控制两个模型工具是否注册；Web profile 已经用 agent preset 把工具从 Host plane 移到 per-Agent scope。一般而言，独立 Browser preset 比覆写标准 preset 更能隔离产品配置；当前 PoC 为限制实验改动范围而覆写 `preset-standard`，没有改正式 profile 或 Agent Loop。

研究最初进行时，Browser-Native PoC 尚未做这项裁剪；天气问题中的连续尝试来自当时模型可见 roster 与 Worker 能力不一致。当前 checkout 已由 PoC overlay 覆盖 `preset-standard`：保留 Worker 内固定命令表实现的受限 `bash`、文件工具、todo 和问答工具，不挂载 web search/fetch、PowerShell、subagent 或 job。当前实现和验证范围见[运行范围验证进度](operational-envelope-validation-progress.md)及[插件兼容矩阵](operational-compatibility-matrix.md)；这项更新没有改变 DSH 正式默认 profile。

浏览器工具也不应被理解为“把 Node 工具搬进 Worker”。Browser Agent 应获得当前 SaaS 页面和业务 API 的类型化 capability，例如读取当前账户上下文、打开客户、筛选列表、生成草稿、请求审批和提交一个经过服务端授权的业务动作；它不应获得任意 shell、任意 URL 抓取、任意 DOM 点击、任意 JavaScript 执行或任意本机文件路径。

## Table of Contents

- [一、结论先行](#一结论先行)
- [二、问题的精确定义](#二问题的精确定义)
- [三、当前代码考古](#三当前代码考古)
- [四、三种配置层次](#四三种配置层次)
- [五、最初的 overlay 为什么不够](#五最初的-overlay-为什么不够)
- [六、Browser-specific 工具清单](#六browser-specific-工具清单)
- [七、工具设计原则](#七工具设计原则)
- [八、Agent Loop 应如何表现](#八agent-loop-应如何表现)
- [九、推荐落地顺序](#九推荐落地顺序)
- [十、验证矩阵](#十验证矩阵)
- [十一、边界与未决问题](#十一边界与未决问题)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

## 一、结论先行

### 1. “让 Agent 知道 bash 不存在”首先是可见性问题

如果 Browser Worker 没有可用的宿主机 shell，就不应把 `bash` 的 schema 发给模型。模型收到的 `request/header`、system prompt 和实际执行注册表应共同表达同一个事实：当前 Agent 没有 `bash` 能力。

仅仅让 `bash` 继续出现在 schema 中，再在执行时返回 `command not found`，并没有解决问题。它会把“环境不支持”伪装成“这次命令失败”，诱导模型继续寻找另一个命令、改变 shell 语法或反复调用同一工具。

### 2. Provider 不可用不等于模型工具不存在

DSH 的 `tool-web` 设计明确把“工具是否注册”和“选中的 provider 是否可用”分开。工具启用时，即使 provider 缺失、凭据不可用或运行时不支持，工具仍可能对模型可见，并在执行时返回结构化错误。这个设计适合保持稳定的产品工具契约，但不适合直接套在 Browser-Native profile 上。

因此，Browser-Native 要隐藏 `web_search` 或 `web_fetch`，应禁用 `tool-web` 的对应注册，或者不挂载 `tool-web`；仅禁用 `web-search-deepseek`、`web-fetch-http` 或 `web` provider 不足以达到目标。

### 3. 当前 DSH 已有正确的配置落点

当前最合适的落点依次是：

1. **Browser-Native profile overlay**：禁用不属于该执行位置的 Host rows 和 provider rows。
2. **Browser-specific agent preset**：只声明该浏览器 Agent 真正可以使用的 scoped tools、prompt sections 和 UI capability plugins。
3. **`tool-web` 的 `search`/`fetch` 开关**：当 Browser profile 只需要其中一种网络能力时，精确裁剪模型工具。
4. **`ctx.tools.restrict()` 或 `ctx.tools.guard()`**：作为运行时的补充策略，而不是替代 composition 的主方案。

### 4. 不需要先改默认 Agent Loop

DSH 默认 Agent Loop 的语义是：模型选择工具，Loop 执行并记录结果，把结果交回模型，再由模型决定继续、切换工具、解释限制或结束。对于通用 Harness，这个语义是合理的；Browser-Native 的错误来自错误的 capability composition，而不是 Loop 自动生成了固定的 bash 重试次数。

如果工具本来就不属于 Browser environment，应在模型请求前移除它。如果工具属于 Browser environment 但本次调用临时失败，才需要讨论重试预算、失败分类和 `turn-stopping` 策略。

## 二、问题的精确定义

“工具不存在”在工程上至少有四种含义，不能用同一种错误处理：

| 状态 | 例子 | 模型是否应看到工具 | 推荐语义 |
|---|---|---:|---|
| 未实现 | Browser Worker 没有 shell、Node DNS 或本机文件系统 | 否 | 不注册，不进入 schema 和 prompt |
| 未授权 | 当前用户没有删除客户的权限 | 通常是，视产品策略而定 | 工具可见，调用时由服务端重新授权 |
| 暂时不可用 | 后端 search proxy 超时、quota 暂时耗尽 | 是 | 返回结构化、可分类的错误，允许模型判断是否重试 |
| 需要异步接管 | 导出任务需要数分钟 | 是 | 返回 job/receipt，交给 durable worker，而不是保持页面内同步调用 |

当前天气 Session 把第一种状态错误地表现成了第三种状态：`bash`、`web_search` 和 `web_fetch` 对模型可见，但在 Worker 中没有完成任务所需的执行闭环。

## 三、当前代码考古

### 1. Browser-Native overlay 当前只改变运行位置

`docs/drafts/browser-native-dsh-poc/browser-native-profile.cordis.patch.yml` 只做三类事情：禁用本地 JSONL persistence、把默认模型改为 `browser-native`、插入 Browser-Native Session persistence 和 LLM provider。它没有修改工具 roster，也没有声明 Browser-specific agent preset。

因此，这个 overlay 解决了“Agent Loop 和 Session 如何在 Worker 中启动、如何访问同源 backend”的问题，没有解决“Worker 中有哪些工具可以对模型公开”的问题。

### 2. Web profile 已经证明工具应按 Agent preset 组合

`packages/bundle/web-app/cordis.patch.yml` 明确把 `tool-bash`、`tool-fs`、`tool-jobs`、`tool-web` 等 Host rows 禁用，再由 `packages/bundle/web-app/presets/standard.patch.yml` 等 preset 在每个 Agent scope 中重新挂载。这样做是为了让不同 Session 拥有不同 capability set，而不是让所有工具成为进程级全局能力。

这也解释了为什么只在 Browser overlay 中写一条根级 `- id: tool-bash / disabled: true` 可能不够：如果实际 Agent 使用的是 `preset-standard`，标准 preset 的子插件仍可能重新注册一个 scoped `tool-bash`。裁剪必须覆盖当前生效的 preset composition，而不是只覆盖 Host plane 的同名 row。

### 3. Cordis patch 是整块配置替换，不是深合并

`vendor/include/src/index.ts` 的 `applyEntryPatches` 和 `packages/boot/app-boot/src/config-schema/document.ts` 都说明：后续 patch 按 id 替换字段，`config` 是整体替换，不是 deep merge。`packages/bundle/base/README.md` 也把这一点列为限制。

这意味着覆盖现有 `preset-standard` 时，不能只写一个 `plugins` 子项并期待其余配置自动保留；必须重述完整的 preset config，或者新增一个专门的 Browser preset 并把默认选择切过去。后者更容易审查，也更不容易因上游标准 preset 变化而悄悄重新暴露主机工具。

### 4. `tool-web` 已有精确的模型工具开关

`packages/web/tool-web/src/index.ts` 的配置包括：

| 配置 | 默认值 | 效果 |
|---|---:|---|
| `search` | `true` | 是否注册 `web_search` |
| `fetch` | `true` | 是否注册 `web_fetch` |

实现上，`search: false` 只留下 `web_fetch`，`fetch: false` 只留下 `web_search`，两者都为 `false` 时不注册任何一个。这不是静态推测：本轮使用当前 checkout 的临时 TypeScript harness 实际挂载了三种配置，观察到的模型 schema 名称分别是 `['web_fetch']`、`['web_search']` 和 `[]`。

`search.ts` 和 `fetch.ts` 的 system-prompt section 还会检查工具在当前 scope 是否可见；被裁剪的工具不会继续贡献对应的 web guidance。这个行为使“工具 schema”和“工具提示”可以一起收敛，但其他 persona、skill 或 preset 文本仍需单独检查。

### 5. Browser-Native LLM adapter 会把可见 schema 发送给 backend

`docs/drafts/browser-native-dsh-poc/browser-native-providers.ts` 的 `toWireTools()` 只序列化 DSH `GenerateOptions.tools` 中已经存在的工具，并把其名称、描述和参数发送到 `/api/browser-native/llm`。因此，工具 roster 的正确裁剪会直接影响真实模型请求，而不是只影响本地 UI 卡片。

### 6. 现有 Browser-use 包不是 Browser-Native UI capability

`packages/browser-use` 及其 Playwright MCP、Chrome DevTools MCP 和 Stagehand provider 让 DSH 通过 Node/Chromium/MCP 后端操作浏览器，并由 Session 持有浏览器资源。它们适合“Agent 操作另一个浏览器”，不等于“Worker 中的 Agent 通过 Main Thread 操作当前 SaaS React/Vue 应用”。Browser-Native SaaS 仍需要自己的 Main Thread/Worker bridge 和业务 capability registry。

## 四、三种配置层次

### 层次 A：Profile/plugin-level disable

这是最简单的静态裁剪。Browser-Native profile 可以禁用主机 shell、Node/Web provider 和不适用的 host rows，例如 `tool-bash`、`tool-pwsh`、`tool-web`、`web-search-deepseek`、`web-fetch-http` 以及仅为这些工具服务的 `web` row。

这层的作用是防止插件在 Browser Host 中启动或注册。它不能自动移除 preset 子树里同名的 scoped plugin，所以必须结合生效的 agent preset 检查。

### 层次 B：Browser-specific agent preset

这是推荐的主要方案。新增一个只服务 Browser-Native 的 preset，令其 plugins 只包含已经验证的 Browser-safe capability，例如用户询问、待办状态、受控呈现和未来的 typed UI capability；不要在该 preset 中挂载 `tool-bash`、`tool-pwsh`、本机文件工具、Node 网络工具和常规主机专用 job 工具。

然后让 Browser-Native profile 的 `agent-preset-registry.default` 指向这个 preset。这样默认 Agent 从创建开始就拥有正确的 scoped world；Session header、system prompt、LLM wire request 和工具执行注册表可以保持一致。

这种方案仍然是配置组合，不要求修改 Agent Loop。它也比直接重写标准 preset 更安全：标准 preset 可以继续服务常规 Web/desktop/headless 场景，Browser-Native 的能力清单拥有自己的版本和验收矩阵。

### 层次 C：Agent-level restriction 和 execution guard

`ctx.tools.restrict({ allow, deny })` 可以在某个 Agent scope 上过滤 global tools，多个 restriction 取交集，被过滤的 global tool 在 schema 中不可见且执行时按 unknown tool 处理。`ctx.tools.guard()` 可以在执行管线中拒绝调用。

这两个 API 都是有价值的运行时安全网，但有两个边界：当前没有看到 agent-preset YAML 直接声明 `allow`/`deny` 的现成字段；并且 restriction 明确针对 global tools，scoped registrations 不受其过滤。因此它们不能替代“不要在 Browser preset 中挂载不适用的 scoped plugin”。如果未来要提供声明式 allowlist，需要新增一个明确的 preset capability policy plugin，而不是把任意字符串列表塞进现有 Loop。

## 五、最初的 overlay 为什么不够

本节描述天气问题发生时的 PoC overlay；其工具清单已经被后续验证批次更新。当前 checkout 状态以[运行范围验证进度](operational-envelope-validation-progress.md)和[插件兼容矩阵](operational-compatibility-matrix.md)为准。

当时的天气问题调用序列在[工具连续尝试事实核查](agent-loop-tool-attempt-analysis.md)中逐事件记录：`web_search`、`web_fetch` 和 `bash` 都进入模型请求，并分别因 credential、Node DNS 和 Worker shell 能力缺口失败。该 Session 用来说明当时的失配，不代表当前 Browser profile 的工具清单。

这个序列不是 DSH 预设的“失败后固定调用两次 web_fetch、三次 bash”。它是模型根据当时可见的工具 schema、system prompt 和前一步错误结果生成的后续选择；DSH Loop 负责把结果写入 Session、推进下一个 step 并再次调用模型。

当时 overlay 的不足可以表示为：

```text
Browser-Native overlay
  = Browser LLM route + remote Session provider
  ≠ Browser capability roster
```

正确的 composition 应该是：

```text
Browser-Native profile
  = Browser LLM route
  + remote Session provider
  + Browser-specific agent preset
  + Browser-safe UI/API capabilities
  - host shell/filesystem/Node-web tools
```

如果 Browser-Native 暂时没有天气、搜索或抓取 capability，那么用户问“北京今天的天气如何？”时，模型应直接说明当前 Agent 没有实时天气工具，或者向用户询问是否切换到具备该 capability 的后端 Agent；它不应先调用不存在的工具再把 runtime error 当作发现环境的方式。

## 六、Browser-specific 工具清单

### 1. 交互控制类

| 能力 | 典型操作 | 设计要求 |
|---|---|---|
| `ask_user` | 询问缺失信息、选择方案、请求确认 | 通过 Main Thread UI 呈现；高风险动作必须有显式确认 |
| `present` | 展示表格、卡片、diff、表单或进度 | 结果必须可回放，避免把 DOM 作为事实源 |
| `todo` | 展示和更新当前会话任务 | 只承诺 Session 支持的持久化和恢复语义 |
| `job` | 启动、查看、取消长期任务 | 返回稳定 job id 和状态，不把页面驻留当作耐久保证 |

这些能力不一定都应默认开启。工具清单应由产品工作流决定，而不是把 DSH 全部内置工具搬到 Browser。

### 2. UI state 类

Browser Agent 需要的是结构化应用状态，而不是任意 DOM 快照。建议优先提供少量稳定的读取 capability，例如当前 route、当前租户、当前用户、选中实体、当前筛选条件、可见业务数据摘要和可用 action 列表。

UI state 必须标记来源、版本、时间和作用域；模型看到的 state 如果会影响业务判断，应进入可回放的 Session context 或由业务 API 重新读取。不能把 React store 的任意对象直接当作 Session 事实，也不能让模型依赖 CSS selector、组件内部字段名或当前 DOM 层级。

### 3. Domain action 类

应优先暴露业务动词，而不是通用浏览器动作：`open_customer`、`filter_orders`、`draft_reply`、`request_refund_approval`、`create_ticket` 比 `click`、`fill`、`evaluate` 更适合 SaaS Agentic UI。

每个写入 action 都需要参数 schema、授权检查、幂等 key、确认策略、结果 receipt、失败分类和可验证的 postcondition。Browser Worker 可以提出意图或驱动低风险 UI，但后端必须重新授权并产生权威业务结果。

### 4. Backend service 类

如果产品确实需要天气、搜索或外部抓取，Browser-Native 不应直接复用 Node-only provider。应提供显式的同源 backend capability，例如受认证和限流保护的 `get_weather`、受域名 allowlist 限制的 `search_public_sources` 或产品自有知识库检索。

“通用 `web_fetch(url)`”在 Browser SaaS 中通常过于宽泛：它会引入 SSRF、CORS、凭据、内容注入、超时和审计问题。若业务确实需要外部页面读取，应由 backend proxy 负责 URL policy、DNS/网络隔离、内容大小限制和 untrusted-content 标记；模型只看到产品允许的参数和错误语义。

### 5. 不应默认暴露的能力

Browser-Native 默认不应暴露任意 `bash`、`pwsh`、本机文件路径、任意 `fetch`、任意 DOM selector、任意 JavaScript、任意浏览器调试协议或自动携带用户 cookies 的网络请求。需要这些能力时，应把它们拆成有明确执行位置、授权主体和结果契约的专用 capability。

## 七、工具设计原则

### 1. 一个 capability 只能有一个权威执行位置

同一个“创建客户”动作不能既由 Main Thread 本地 store 提交、又由 Browser Worker 直接 POST、又由后台 job 重新提交而没有 receipt。推荐的分工是：Main Thread 管理 UI 和用户手势，Worker 管理 Agent Loop 和工具编排，backend 管理授权与权威副作用，durable worker 负责页面关闭后仍需继续的任务。

### 2. 工具 schema 是能力声明，不是自然语言愿望

schema 应说明参数约束、权限前提、是否会修改状态、成功结果和常见失败。工具 description 不应写成“遇到任何问题都可以再试一次”；错误结果也应区分不支持、未授权、暂时失败、参数错误和未知结果。

### 3. 工具数量和重叠度要受控

Chrome WebMCP 的官方资料把“工具越多、重叠越多，Agent 越难选择正确工具”作为设计风险，并建议用清晰的工具声明、用户交互和 deterministic/probabilistic eval 验证工具选择。这个原则直接适用于 DSH：Browser preset 的工具集合应是任务导向的最小集合，而不是把 Node、Web、MCP、UI 和业务 API 的所有工具并列暴露。

### 4. UI 不是 Session 事实的替代品

MCP Apps 的模式说明了“工具可以关联一个交互式 UI resource，由 Host 在对话中渲染”。这类 UI 对展示表单、图表和多步骤工作流有价值，但它不能替代 DSH 的 Session log、Agent Loop、授权和 durable handoff。DSH 可以把类似能力作为 Tool presentation 或 UI capability adapter，而不是把每个 UI 组件直接变成不受约束的工具。

### 5. 安全策略必须与模型可见性同时设计

隐藏工具可以减少误用，但不能代替服务端授权；可见工具也不能因为“用户已经在页面上看到按钮”就绕过授权。所有高风险 action 都要在 backend 再验证身份、租户、资源版本和幂等条件，并把授权与 settlement 记录为服务端事实。

## 八、Agent Loop 应如何表现

### 1. 不存在的 capability

当 Browser preset 没有 `bash`、`web_search` 和 `web_fetch` 时，正常情况是模型不生成这些 tool call；如果模型仍然生成了未知名称，DSH 应记录 unknown-tool 结果并让模型决定是否结束，但这属于异常 fallback，不应成为发现运行时能力的常规路径。

### 2. 存在但失败的 capability

如果 Browser preset 暴露了 `get_weather`，但 backend 暂时超时，Loop 可以把结构化错误交给模型。模型可以重试一次、询问用户、改用缓存或停止；是否限制重试次数是产品策略，应由明确的 tool policy 或 turn policy 实现，而不是通过错误地暴露不存在的工具来“测试环境”。

### 3. 无法完成的请求

当用户询问 Browser Agent 没有的能力时，最理想的输出不是一串失败工具卡片，而是短而准确的限制说明，并给出可选路径：切换到具备该能力的 Agent、请求用户提供数据、或启动一个后端任务。这个体验依赖正确的 roster、persona 和错误提示三者共同作用。

## 九、推荐落地顺序

### Phase 0：只做配置裁剪

不修改默认 Loop，也不新增 Browser 业务工具，先为 Browser-Native profile 设计一个独立 preset；禁用 shell、Node web 和其他未验证的主机工具；确认有效 Agent scope 的 schema、system prompt 和 LLM wire request 都不再包含这些名称。

### Phase 1：定义 Browser capability manifest

为每一个 Browser deployment 记录执行位置、权限、用户确认、是否可回放、是否需要 backend、失败分类和版本。这个 manifest 可以先作为配置和测试的约定，未来再演进成 typed registry；不要让“当前环境有哪些工具”只存在于 prompt 文本中。

### Phase 2：接入一个只读 UI capability

先实现一个真实业务只读 capability，例如读取当前客户或当前筛选条件。验证 Main Thread/Worker bridge、state snapshot、Session context、刷新恢复和 UI presentation，不要同时引入任意 DOM 操作。

### Phase 3：接入一个受控写入 capability

选择一个可撤销、可审批、可幂等的业务动作，补齐 backend authorization、receipt、postcondition、失败和重复提交测试。Browser Worker 只提交 intent，不能成为最终权限判断者。

### Phase 4：按产品需要提供网络和 durable handoff

若产品需要天气、搜索或抓取，新增 Browser-safe backend capability，而不是恢复 Node-only `web_search`/`web_fetch`。若任务需要页面关闭后继续，显式 handoff 到 durable worker，并在 Session 中记录 ownership transition。

## 十、验证矩阵

| 验证项 | 预期证据 | 失败时说明 |
|---|---|---|
| 有效 preset | 新 Session 的 `request/header` 不含 `bash`、`web_search`、`web_fetch` | 仍有标准 preset 或 Host row 泄漏 |
| prompt 一致性 | system prompt 不再包含 shell/web 使用指导 | 工具被隐藏但 persona/skill 仍误导模型 |
| LLM wire request | `/api/browser-native/llm` 的 `tools` 只包含 Browser roster | adapter 或 scope assembly 仍混入工具 |
| 天气负向测试 | 无 `tool/call`，或只调用明确的 Browser-safe weather capability | 未裁剪工具，或模型被错误提示驱动 |
| 工具失败恢复 | 可用工具失败后按明确 policy 重试或停止 | 把“能力不存在”和“暂时失败”混为一谈 |
| UI capability | 工具调用、Main Thread 结果、Session projection 和 UI card 对齐 | 只验证页面变化，没有可回放事实 |
| 安全 action | 未授权、重复请求、过期版本和用户拒绝均有独立结果 | 依赖浏览器或模型自行保证权限 |
| 浏览器兼容性 | Chrome、Safari 的 Worker、MessageChannel、stream、owner handoff 均有测试 | 只在一种浏览器看到“能显示页面” |

真实模型测试应同时记录模型请求的 tool names、Session 的 `request/header`、`tool/call`/`tool/result` 和最终 `turn/end`；只观察聊天气泡不能证明工具 roster 正确。

## 十一、边界与未决问题

### 1. 纯配置能解决什么

纯配置可以解决 profile/preset 的工具启用、禁用、替换和部分工具参数；可以让模型请求不再收到不适用工具 schema；可以减少 Node-only provider 在 Worker 中被加载或执行的机会。

### 2. 纯配置不能解决什么

纯配置不能凭空产生 Browser UI capability、backend authorization、幂等 receipt、跨页面恢复、跨重启 ownership 或 durable handoff。也不能保证模型永远不输出一个它不该输出的字符串；它只能把正常决策空间和执行注册表收敛到正确集合。

### 3. 后续仍需验证的实现

本研究最初没有修改 `packages/`、`apps/` 或 PoC 运行时代码；后续验证已把工具裁剪加入 PoC overlay，并通过 Chrome scripted roster 检查与真实模型 todo/multi-turn 检查。仍需在真实 Browser profile 下验证完整文件工具序列、问答/HITL，以及逐插件的错误和恢复语义；证据见[运行范围进度](operational-envelope-validation-progress.md)和[兼容矩阵](operational-compatibility-matrix.md)。生产级能力声明仍需要独立 preset、应用 capability 和后端授权设计。

## Further Exploration

- [Browser-Native DSH PoC README](README.md)：当前 v2 启动入口、真实 LLM 验证和运行边界。
- [工具连续尝试事实核查](agent-loop-tool-attempt-analysis.md)：天气 Session 中 `web_search`、`web_fetch` 和 `bash` 的逐事件分析。
- [Browser-Native Agentic UI 综合报告](../dsh-browser-native-agentic-ui-research.md)：Worker、typed UI capability、Session 和 durable handoff 的整体架构。
- [Browser-Native Runtime 研究](../dsh-browser-native-runtime-research.md)：Browser Worker、Cloud Workspace、Native bridge 和执行世界的边界。
- [DSH Tools subsystem](../../../docs/subsystems/tools.md)：`restrict`、`guard`、schema projection 和执行管线。
- [DSH tool-web README](../../../packages/web/tool-web/README.zh.md)：`search`/`fetch` 配置、provider 可用性和错误语义。
- [Chrome WebMCP](https://developer.chrome.com/docs/ai/webmcp)：浏览器页面暴露结构化 Agent tools 的提案和实现资料。
- [WebMCP tool design](https://developer.chrome.com/docs/ai/webmcp/build-tools)：工具边界、用户旅程和工具组合建议。
- [WebMCP best practices](https://developer.chrome.com/docs/ai/webmcp/best-practices)：工具数量、重叠、描述和评估建议。
- [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview)：工具关联交互式 UI resource 的标准扩展。

## Dev Note

本文记录了 Browser-specific roster 的设计依据；研究时提出的 overlay 裁剪建议已在当前 PoC 中实现，工具的实际验证范围和未通过项见[运行范围验证进度](operational-envelope-validation-progress.md)与[插件兼容矩阵](operational-compatibility-matrix.md)。本文讨论的 capability manifest 和生产 backend capability 仍是架构建议，不是当前 PoC 已具备的能力。
