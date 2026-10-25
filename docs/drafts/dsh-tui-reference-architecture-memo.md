---
description: "记录 dsh-TUI 参考项目对 Browser-Native DSH 与云端 DSH 的可迁移架构经验、不可迁移的主机假设和后续验证建议。"
---

# dsh-TUI 对 Browser-Native 与云端 DSH 的架构启发备忘

## Summary

参考项目 `dsh-TUI` 不是 Browser-Native DSH 或云端 DSH 的直接实现模板。它的核心价值在于：在不修改 DSH 核心的前提下，把后端、会话、能力、生命周期和终端呈现拆成可验证的适配层；这些原则可以迁移到 Worker Host、Cloud Session 和 Durable Worker。

最值得迁移的不是 TTY、Node 进程或本地路径，而是五项纪律：Session 事件是事实源、live 与 replay 使用同一事件映射、能力必须经过探测和发布门槛、跨边界状态必须有版本连续性、执行者恢复必须沿用原会话身份并明确取消结果。

本备忘基于参考仓库提交 `29572774890a4a89ae1fa562dd15a1ae21bb3593` 的源码和文档阅读。它记录的是参考项目的源码证据与架构推断，不改变当前 Browser-Native PoC 的已验证范围，也不把参考项目的 TUI 行为写成 DSH 公共 API。

## Table of Contents

- [证据范围](#证据范围)
- [参考项目真正解决的问题](#参考项目真正解决的问题)
- [对 Browser-Native DSH 的直接启发](#对-browser-native-dsh-的直接启发)
- [对云端 DSH 的直接启发](#对云端-dsh-的直接启发)
- [不能照搬的部分](#不能照搬的部分)
- [与当前 PoC 的差距](#与当前-poc-的差距)
- [建议的高价值验证](#建议的高价值验证)
- [结论](#结论)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

## 证据范围

参考项目明确把自己定位为 DSH 的消费方和终端宿主。`src/agent/`、`src/channel/` 是后端中立层，`src/dsh-adapter/` 是 DSH 适配层，`src/backends/claude/` 和 `src/backends/codex/` 是独立后端；`ADAPTER.md` 要求厂商包和宿主模块留在适配目录内。

参考项目的当前实现证据主要来自以下机制：`src/agent/session.ts` 的 `AgentSession` 生命周期，`src/agent/events.ts` 的统一事件词汇，`src/agent/refs.ts` 的后端限定 Session 引用，`src/adapter/channel/provider.ts` 与 `consumer.ts` 的 Channel 协议包络，`src/adapter/channel/session-projection.ts` 的事件回放，`src/adapter/upstream/detection.ts` 与 `src/adapter/kernel/lifecycle.ts` 的能力探测和发布门槛，以及 Codex/Claude Session 实现中的重连、挂起请求和销毁处理。

以下结论分为三类：源码直接显示的机制；对 Worker/Cloud 具有相同问题的可迁移原则；只适用于 TTY、Node 或本地进程的实现细节。第三类不能作为 Browser-Native 能力证据。

## 参考项目真正解决的问题

### 适配器不是 UI 的私有分支

`dsh-TUI` 没有把 DSH Agent、Session 或工具事实复制到 React/Ink 组件中。Channel 核心消费后端中立的 `AgentSession` 和 `AgentEvent`，DSH、Claude、Codex 各自负责把原生会话翻译成同一事件词汇。

这说明“接入另一个执行环境”最小的稳定单元不是一个聊天组件，而是一个 Session adapter：它需要提供历史、实时事件、输入、取消和销毁，并声明实际能力。UI 只投影这些事件，不拥有第二份 transcript。

### live 与 replay 是同一份语义

`AgentEvent` 的注释明确要求 live 和 replay 使用同一词汇。Codex 的 `items.ts` 与回放路径共用映射；DSH Session projection 只接受明确列出的事件类型，未知且未标记 `ignorable` 的事件会失败，而不是按前缀猜测或静默跳过。

这不是终端显示优化，而是恢复正确性的前提。一个只在 live 路径可见的工具结果或 UI 状态，刷新后就无法证明模型看到了什么，也无法区分“执行过但响应丢失”和“从未执行”。

### 能力声明、探测和发布是三个阶段

参考项目的 `Detection` 区分 `supported`、`unsupported` 和 `degraded`，并记录 service、method、version、contract、probe 等证据。Kernel lifecycle 还区分 `declared`、`staged`、`live`、`unsupported` 和 `degraded`；只有获得 probe 证据的 staged capability 才能晋升为 live，degraded 不能作为完整能力发布。

协议协商与权限授权也分开：`negotiate()` 先判断协议支持，再判断权限是否获准。插件可以被识别为兼容但仍等待授权，支持某个 definition 不等于允许执行其副作用。

### 跨边界状态具有连续性和拒绝语义

Channel Provider 采用 `open`、`subscribe`、`invoke`、`close` 的明确生命周期。Provider/Consumer 都校验版本、Channel 身份和单调递增版本；Consumer 默认对回退、重复和跳号 fail closed。Provider 对未知方法返回 `FEATURE_UNAVAILABLE`，不把未知能力当成成功 no-op；回放输入和输出还受 JSON 深度、大小和对象类型限制。

这套机制的价值在于把“页面看到了一个快照”与“页面收到连续且可解释的状态流”区分开。它不要求 Browser 复用 TUI 的 wire protocol，但要求 Browser bridge 具有同等的序列、版本、大小和未知消息语义。

### Session 身份和后端身份不能混为一个裸字符串

`AgentSessionRef` 将 `backendId` 和 backend 自己的 `sessionId` 组合起来，因为同一个裸 ID 只在一个后端目录内唯一。恢复、目录、最近会话和后端切换都不自动跨后端 fallback；选择的后端不可用时显式失败。

这为 Cloud Session 提供了直接启发：Session 引用至少要绑定租户、用户、Workspace、执行 profile 和执行者类型，不能只依赖一个 UUID。Browser Worker、Cloud Durable Worker 和可能的 Native Bridge 不能因共享一个 Session UUID 就默认拥有相同的写权。

### 取消和销毁必须报告不确定性

`AgentSession.cancel()` 返回 `CancelReceipt`，并区分 `confirmed`、`unknown` 和 `failed`；非 `confirmed` 的 `stillQueued` 不能被解释为空队列。`dispose()` 需要撤回挂起审批和问答、停止当前执行、解除订阅和释放后端资源，并保持幂等。

Codex Session 在恢复时先固定历史编号，再放行提前到达的 live 事件；连接断开和恢复也沿用同一 thread。Claude Session 在进程消失时显式关闭未完成回合、撤回挂起交互并发布 disposed，而不是让 UI 保留一个看似仍可回答的等待状态。

### 后端自己的数据不能猜宿主路径

`BackendHost.dataDir` 是可选的 backend 专属目录。缺少它时后端退回内存，不得自行拼接宿主目录；Session catalog 的快照只用于首屏，后端自己的存储仍是权威。这个规则把 transcript、backend 偏好、凭据引用和 UI 缓存分开，避免一个路径公式承载多个生命周期。

## 对 Browser-Native DSH 的直接启发

### 把 Worker 视为一种 Session backend，而不是页面的隐藏实现

当前 PoC 已在 Worker 中运行真实 DSH Host 和 Agent Loop，但参考项目提示应把 Worker 入口收敛成显式的 Session adapter。它至少应具备以下可观察行为：先返回可重建的历史，再订阅从明确序列位置开始的 live 事件；输入使用稳定的 client message id；取消返回 confirmed/unknown/failed；刷新或 terminate 时对挂起 tool、审批和问答给出 interrupted 或 unknown，而不是伪造答案。

Main Thread 只保留 UI、用户手势和受验证的数据。Worker 不是 transcript 真源，页面消息数组也不是 transcript 真源；两者都应从 DSH Session event/projection 重新建立。

### 将当前静态 capability manifest 演进为可审计的发布状态

当前 `browser-native-capabilities.ts` 已区分 `provided`、`adapted`、`unsupported` 和 `unverified`，并在 boot 前执行 profile preflight。这已经比“模块能 import 就视为可用”更安全，但仍然把能力状态、运行时证据和发布决策压在一张静态表里。

正式产品应至少记录三类结果：声明了什么；运行时探测到什么；哪些具体子能力已经通过 probe 可以对模型发布。比如受限 Shell 可以发布固定命令表，但不能因此发布 `host-subprocess`；`dynamic-module-loading` 可以被加载但仍不能发布任意插件；OPFS 可用也不等于 durable outbox 可用。

能力支持和权限授权也应分开。工具 schema 只应包含已经通过 Browser profile preflight、运行时 probe 和权限判定的工具；缺失能力应得到具体诊断，不应让模型先看到工具再在执行时反复试错。

### 为 postMessage bridge 增加 Channel 级的连续性思想

当前 PoC 已有 protocol version、Session seq、requestId、owner token、Workspace revision 和 fencing token。参考项目进一步提示：UI 状态桥不能只验证单个 frame 的字段，还要验证同一 channel/worker instance 的版本是否连续、重连基线是否明确、重复 frame 是否幂等、未知 required frame 是否 fail closed。

这尤其适用于 Agentic UI：一个页面卡片不能把“工具调用已开始”“工具已成功”“业务 receipt 已提交”混成同一状态。每类状态应有自己的序号和来源，重连后按 Session/Workspace 权威状态重新投影。

### 不要在恢复时自动换执行权威

参考项目不把一个不可用的后端静默替换为另一个后端。Browser-Native 也不应在 Worker 失去写权、Session backend 暂时不可用或 Cloud Durable Worker 已接管时，静默创建新 Worker、重放原 prompt 或把页面内存状态当成成功事实。

恢复流程应先读取 Session 和 Workspace 的权威状态，再决定是继续原 Worker、重新 claim、转交 Durable Worker、显示 unknown，还是要求用户发起新 turn。恢复凭据是租约恢复材料，不是用户身份认证；服务端仍必须验证用户、租户、Workspace 和执行 profile。

## 对云端 DSH 的直接启发

### Cloud Worker 可以复用同一 AgentSession 语义

Cloud Durable Worker 不应为后台执行再造一套 transcript 和 tool lifecycle。它可以实现与 Browser Worker 相同的 `history`、`subscribe`、`submit`、`cancel`、`dispose` 和 capability snapshot，再由不同 transport 承载。

这不意味着 Browser 和 Cloud 共享同一个 owner。它们应通过显式 handoff 或 claim 转移执行权，使用新代际或 fencing token；原 owner 的迟到 append、tool result 和 renew 必须被拒绝。Session event log 仍是共享事实源，执行者只负责生产事件和处理未完成回合。

### 把持久化、查询、传输和执行所有权分开

参考项目的 `SessionCatalog`、`AgentSession`、backend transport 和 host launcher 是不同职责。Cloud DSH 也应分别定义：Session event append/flush、Session list/preview/page、Worker stream/reconnect，以及 active owner/lease/fencing。

Session catalog 可以缓存首屏摘要，但不能成为 transcript authority。查询失败时应显示 incomplete 或重试，不应把缓存列表当作最新事实；分页和 preview 也不能触发打开完整 Session 或抢占执行权。

### 用后端身份和执行来源保护恢复与审计

Cloud Session 的事件和 receipt 应记录执行来源，例如 Browser Worker、Cloud Durable Worker、Native Bridge 或系统任务，以及对应的 owner epoch、request id、operation id 和 Workspace revision。这样恢复时可以回答“谁提交了这个副作用”和“原 owner 的响应是否只是丢失”。

同一 Session 可以有多个观察者，但同一可变执行链在同一时刻只能有一个 active writer。只读订阅和写权 claim 必须是两个 API，不应通过订阅连接本身暗中获得执行权。

### 把 Durable handoff 定义为安全点，而不是迁移 JS 堆

TUI 文档明确说明进程内后台会话随 TUI 退出而停止。这个限制反向证明了云端 Durable Worker 的必要性：页面关闭后继续执行不能依赖 Browser Worker，也不能迁移 Worker 中的 Promise、审批面板或未结算模型流。

Handoff 应在已记录的安全点发生：已提交的 Session event、已确认的 Workspace operation 和可查询的副作用 receipt。未完成的模型流、工具 Promise 和 HITL 等待必须结算为可恢复的 interrupted/unknown 状态，或由新的 owner 按协议继续，而不是复制内存状态。

## 不能照搬的部分

### TUI 的单进程决定不能否定 Browser Worker

`dsh-TUI` 的独立宿主设计拒绝父进程、子进程和 Worker IPC，因为终端 Channel 有多个端口，镜像和交接成本高，而且 TUI 已经与 DSH 共享进程生命周期。Browser 的 Main Thread 不能承担 DSH Host 和 Agent Loop 的同步计算与插件副作用，因此 Browser-Native 必须保留 Worker；可迁移的是“端口要显式、交接要可验证”，不是“永远不要隔离”。

### TTY、Node 和本地路径不是 Browser capability

终端 raw mode、ANSI/Ink/Yoga、Node child process、`dataDir`、本地 SQLite/JSONL、环境变量凭据和宿主信号处理都属于 TUI 主机。它们不能被 Worker 的 Node shim、OPFS 或同源 HTTP 伪装成完整等价物。

Browser profile 应继续使用受限 VFS、结构化文件工具、同源 LLM proxy、Cloud Session/Workspace 和显式 capability preflight；需要真实 Shell、Native addon 或长期执行时，必须转为 Native Bridge 或 Cloud Worker 能力。

### TUI Channel 协议不能未经验证直接成为 Web wire protocol

TUI Channel 的完整快照和版本连续性适合终端宿主的 Channel 消费者，但 Browser bridge 还必须处理页面刷新、Worker 重建、跨 origin 认证、Service Worker/HTTP reconnect、二进制传输和浏览器存储故障。应复用 fail-closed、版本和幂等原则，不能未经测试直接复用协议字段或宣称两者兼容。

### TUI 的本地权限模型不能替代 SaaS 授权

TUI 的 approval、sandbox 和 permission preset 面向用户信任的本机工作区。SaaS 还必须在服务端检查租户、用户、资源、字段和业务状态；隐藏工具、UI 卡片或 Browser capability manifest 都不能替代服务端授权与业务 API 的幂等检查。

## 与当前 PoC 的差距

当前 PoC 已经覆盖参考项目最重要的若干原则：真实 DSH Session 是事实源；Worker/页面只交换 typed 数据；Session seq、requestId、owner token、Workspace revision 和 fencing token 分开；真实 DSH Loop 的 live tool 结果和刷新恢复可以回放；Browser capability preflight 会在 Host boot 前拒绝明显不兼容的 profile。

参考项目暴露出的主要增量不是再加一个 UI，而是建立跨执行者的 conformance 验收。当前 PoC 仍需要明确验证或产品化的方向包括：Worker Session adapter 的 history-before-live 和重连连续性；`cancel()` 的 confirmed/unknown/failed 投影；dispose 对挂起 HITL 的统一结算；能力从声明到 probe 到模型 schema 的可追溯证据；Session catalog 的分页/缓存不冒充事实；Browser Worker 到 Durable Worker 的 owner handoff。

当前 capability manifest 仍是 docs-owned 静态输入，`provided/adapted` 也不等于每个具体插件已经通过运行时 probe。当前 Browser bridge 的 Workspace/Session 控制消息与 DSH Session event 也不是同一个协议；它们应继续保持独立，并分别记录 revision、fencing、durability 和来源。

## 建议的高价值验证

| 验证点 | 需要证明的事实 | 失败时的产品结论 |
| --- | --- | --- |
| Worker Session conformance | history 先于 live；断线重连不丢事件、不重放 prompt；重复 frame 可去重；unknown event fail closed | Browser Worker 只能作为受限实验入口，不能承诺刷新/重连后继续同一回合 |
| Cancel/dispose matrix | 正在运行、等待工具、等待问答、等待审批和网络 unknown 时，取消与销毁都能给出明确 outcome | UI 必须停止宣称“已取消”或“等待用户”，改为 interrupted/unknown |
| Capability publication | 声明、service/method 探测、实际 probe、权限授权和模型 schema 的结果一一对应 | 工具不能进入模型上下文，或只能降级为只读/不可用 |
| Session catalog semantics | 首屏缓存、分页、preview、查询失败和跨设备更新不抢写权、不伪造完整列表 | Cloud UI 只能显示 stale/incomplete，而不能误导为最新会话 |
| Browser-to-Cloud handoff | 安全点记录、owner epoch 转移、旧 Worker fencing、未完成回合结算和同一 Session 回放 | 页面关闭只能中断任务，不能宣称后台继续 |
| Multi-observer/single-writer | 两个 Browser Worker、一个 Cloud Worker 和只读页面同时存在时，只有一个可提交副作用 | SaaS 需要明确只读副本、claim 失败和接管提示 |
| Bounded bridge payload | 大工具结果、深 JSON、未知字段、二进制和版本跳跃均有界且可诊断 | 需要分页、blob 引用或拒绝调用，不能把完整数据塞进 Session/消息 frame |

其中第一项和第二项最值得优先实施，因为它们直接验证 Browser-Native DSH 是否仍然是同一个 DSH Agent Loop，而不是“Worker 里看起来能聊天的另一个 loop”。第五项是云端 DSH 的关键分水岭，应在真正实现 Durable Worker 前固定事件、receipt 和 owner 语义。

## 结论

`dsh-TUI` 对 Browser-Native DSH 的最大启发是“后端中立 Session adapter + 明确能力发布 + 事实源投影 + 保守恢复”，而不是它的终端宿主代码。对云端 DSH 的最大启发是“同一 Session 语义可以有多个执行后端，但每个后端必须有命名空间、能力清单、独立生命周期和明确的 owner 转移”。

因此推荐的演进方向是：保留 DSH Agent Loop、Session event 和插件语义；为 Browser Worker、Cloud Durable Worker 和可选 Native Bridge 分别实现受限 adapter；用统一的 `history/subscribe/submit/cancel/dispose` 语义和事件投影测试它们；把 UI、Session 持久化、查询、传输和执行所有权保持为独立层。不要把 TUI 的本地进程假设、宿主路径或权限模型直接带入浏览器或 SaaS 云端。

## Further Exploration

- [Browser-Native 运行时调研](dsh-browser-native-runtime-research.md)：当前 Worker、Cloud Workspace、OPFS 和 Native Bridge 的责任划分。
- [Browser-Native 实施方案](dsh-browser-native-agent-implementation-plan.md)：当前 Worker/Session/Workspace 协议、owner fencing 和验收矩阵。
- [Browser-Native PoC README](browser-native-dsh-poc/README.md)：当前 checkout 的实现、真实 Chrome 证据和未验证边界。
- [云端 Agent 架构建议](dsh-cloud-agent-architecture-recommendation.md)：Browser Agent、Cloud Agent 和 Durable Worker 的交接模型。

## Dev Note

本备忘只引用参考项目源码和当前仓库已有 Browser-Native 文档，不把 `dsh-TUI` 的终端回归、Codex/Claude 真实后端验证或本地数据目录能力计入 Browser-Native PoC 证据。参考项目后续变化需要重新读取对应提交，不能把本备忘视为外部仓库的持续同步镜像。
