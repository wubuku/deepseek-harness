---
description: "面向准备阅读或修改 DeepSeek Harness 的开发者：核验一切皆插件等架构判断的准确边界，区分 Profile、Bundle、Agent Preset 与动态 Cordis 包，给出源码阅读路线、Cordis 与 Session 机制要点、常见误读纠正和外部中文资料评估。"
---

# DSH 开发者导读：从插件系统读到 Agent Runtime

## Summary

本文面向准备深入阅读或修改 DeepSeek Harness（DSH）源码的开发者，回答三个问题：`一切皆插件`到底指什么；源码应按什么顺序阅读才能建立正确模型；现有中文资料中哪些判断可靠、哪些需要收窄。

核心判断：DSH 没有把模型适配器、工具注册表、Session、Agent Loop 硬编码进一个单体内核，它们都是 Cordis 插件，通过 Service、typed event 和 effect 连接，并由配置组合装配。但 Cordis、Loader、CLI、启动审计和产品 API spine 仍是固定的运行时基础设施；`可替换`受 Service Definition、provider 数量约束、作用域和 reload 策略限制，不是任意时刻的透明热替换。

阅读主线建议按五层推进：Cordis Runtime、组合层（Profile/Bundle/Patch/Agent Preset）、Host 能力面、Agent 执行面（Turn/Step/工具管线/Session log）、Client 与传输面。最重要的概念区分是 Profile（部署组合）、Bundle（配置分发包）、Agent Preset（每会话能力组合）与 Dynamic Cordis Package（进程内临时扩展）——四者的生命周期、权限和回滚语义各不相同。

本文同时纠正高频误读：Session 是内存中的 append-only 事件日志，不是自动落盘的数据库；`model-visible ⟺ logged`只有单向成立；effect 提供生命周期内的注册注销，不提供外部副作用的事务回滚；多 Session 共存不等于多租户安全隔离。外部资料核验结论与推荐阅读顺序见对应章节。

## Table of Contents

- [阅读目的与证据边界](#阅读目的与证据边界)
- [外部资料核验](#外部资料核验)
- [四种组合概念](#四种组合概念)
- [五层心智模型](#五层心智模型)
- [推荐源码阅读路线](#推荐源码阅读路线)
- [Cordis 机制精读要点](#cordis-机制精读要点)
- [Agent Loop 与工具管线](#agent-loop-与工具管线)
- [Session 与持久化](#session-与持久化)
- [Host、Agent 与 Client 平面](#hostagent-与-client-平面)
- [动态插件与自修改边界](#动态插件与自修改边界)
- [常见误读与纠正](#常见误读与纠正)
- [Browser-native 视角](#browser-native-视角)
- [最终阅读清单](#最终阅读清单)
- [Dev Note](#dev-note)

-----

## 阅读目的与证据边界

本文依据当前 checkout 的源码、package README、生成文档和测试代码核对架构判断，并对照官方产品页、若干中文第三方分析和 Cordis 论文摘要。未重新执行 `dsh --dump-config`、live reload、动态包运行或浏览器 preview；引用的行为结论来自已检查的实现与测试，不代表本文完成过端到端实测。

第三方文章的发布时间和分析对象并不一致：多数文章锁定开源初期的仓库快照。它们适合作为源码导览和历史对照，不适合作为当前行为的规范。涉及具体包数量、配置行数、事件名和 profile 清单时，应以当前 checkout 的 [architecture](../architecture.md)、[Cordis primer](../cordis-primer.md)、[persistence catalog](../persistence-catalog.md) 和对应源码为准。

本文是阅读导引稿，不替代任何 package README 或 subsystem 文档；链接指向的文档拥有各自事实的唯一归属。

## 外部资料核验

### 官方资料

[官方产品页](https://www.deepseek.com/harness/)明确陈述设计主张：模型、工具、技能、会话、沙箱、存储、循环、调度、UI 等能力均由插件组合；Cordis 内核只负责插件加载、卸载与依赖关系；不同运行模式由配置组合形成；会话日志用于还原运行轨迹。[architecture](../architecture.md)进一步写明：model adapter、tool registry、session log 和 agent loop 都是可从配置替换的插件，不存在需要打补丁的特权核心。

这一主张按`产品能力层`理解是准确的。当前代码仍有固定的运行时机制：Cordis 的 Context、Fiber、Registry、Events、Logger（[vendor/cordis](../../vendor/README.md)）、Loader 与 Include 配置树、`dsh` CLI 与 [app-boot](../../packages/boot/app-boot/README.md)、profile/manifest 解析、进程生命周期和必需插件审计。[packages/core](../../packages/core/README.md)本身也不是传统单体核心：它是产品 API spine，`agent` 拥有公共合约，`agent-loop` 是默认实现，扩展插件依赖合约而非实现。

因此更精确的表述是：DSH 没有一个承载全部 Agent 产品功能、只能通过修改源码扩展的单体内核；但它仍有负责插件生命周期、配置装配、启动和进程管理的固定运行时基础设施。

### 第三方文章

已核验可访问性并抽查内容的文章：

- [Yiipu：Deepseek Harness 仓库分析报告](https://yiipu.github.io/posts/deepseek-harness-analysis/)——选题覆盖无特权内核、Session 事件日志、Capability Seam 和 Patch 组合，适合作为第一篇全局导览；文中数字与实现细节需回当前 checkout 验证（该页 HTML 在本环境无法完整转换，未逐段核验正文）。
- [张忠琳：系统级架构分析](https://deepseek.csdn.net/6a84dcfe10ee7a33f29c98f0.html)——覆盖 Cordis、Profile/Bundle、能力接缝、Turn/Step、工具管线、启动流程与 HMR，适合建立系统地图；文中的包数量等数字属于写作时快照。
- [程序员 z7：Cordis 插件系统解析](https://deepseek.csdn.net/6a8400e910ee7a33f29c6881.html)——对 Plugin、Context、Service、Fiber、`inject`、事件分发和 effect 的入门解释清楚；`换 provider 不用重启`一类表述需按下文各替换机制的限制收窄。
- [小生凡一：图解架构](https://deepseek.csdn.net/6a7f254310ee7a33f29b0548.html)——启动层次与一次 Turn 的图示有价值，特别是`配置顺序决定装什么、依赖图决定何时能运行`；阅读时需自行区分 Profile、Preset 与 Host/Client 平面。
- [Locsic：架构设计分析](https://locsic.com/zh/thinking/deepseek-harness-architecture-analysis/)——提出 DSH 在构建 Agent 运行时层而非单一 Agent 产品，属于作者判断而非官方定位；其多租户、自进化推论必须与源码事实分开。
- [Cordis 论文导读（DSH 中文社区）](https://dshx.dev/blog/2026-08-19-cordis-paper-guide/)——把 `ctx.effect()` 对应 revertible effects、`inject` 对应 reactive coeffects，并给出论文分章读法；结论应回论文原文核对。
- [Han (Andrew) Zheng：一切皆插件深度剖析](https://securaize.substack.com/p/deepseek-harness)——主题与主线正确，但本环境无法稳定抓取该页正文，本文未将其具体断言列为已核验事实。

### Cordis 论文

[A Programming Paradigm for Spatiotemporal Composability](https://arxiv.org/abs/2608.25512)（arXiv:2608.25512）提出时间可组合性（移除组件时副作用可完全回滚）与空间可组合性（依赖声明与响应式重排），将 revertible effects 与 reactive coeffects 统一进单一 context 类型，并给出动态组合演算与 Cordis 实现（effect 跟踪、coeffect 解析、配置协调、HMR）。论文解释了 effect/inject/Fiber 为何是基础设施级机制；但论文证明的是运行时性质，不等于 DSH 对外部副作用、租户隔离或分布式恢复做出了同等级产品承诺。

## 四种组合概念

理解 DSH 组合性的第一步是区分四个常被混用的概念：

| 概念 | 解决的问题 | 当前示例 |
|---|---|---|
| Profile | 一次应用以什么部署组合启动 | `web`、`headless`、`sdk`、`sdk-minimal`、`acp` |
| Bundle | 分发一组 Cordis 配置行及其代码 | `dsh-base`、`dsh-web-app`、`dsh-headless` 等 |
| Agent Preset | 一个 Session/Agent 的工具、Prompt 与 Skill 组合 | `standard`、`ptc`、`minimal`、`cordis` |
| Dynamic Cordis Package | 运行时临时定义、运行和更新的扩展包 | `cordis_define`/`cordis_run`/`cordis_stop` |

Profile 定义见 [app-boot](../../packages/boot/app-boot/README.md)：`web` 是 `dsh-base` 加 `dsh-web-app` 且 patch live reload；`headless`、`sdk`、`acp` 在 base 之上但仅启动时应用 patch；`sdk-minimal` 是独立完整树，不叠加 base。层的应用顺序是 bundle patches、profile `cordis.patch.yml`、Harness home patch、`--patch` overlays；实际启动还会附加 launcher 派生的 patch（如 telemetry），完整顺序见 [profile-boot](../../apps/cli/src/profile-boot.ts) 与 [architecture](../architecture.md)。

Bundle 是分发格式而非编译产物：package manifest 声明 `dsh.bundle` 的包才是 bundle layer。`dsh plugin` 把安装委托给 pnpm，只有声明为 bundle 的依赖进入 profile 层，普通依赖不会自动变成组合层。

Agent Preset 见 [agent-presets](../../packages/preset/agent-presets/README.md)：preset 是每会话组合，`standard` 是完整编码 Agent，`ptc` 以 PTC 呈现替代普通 workflow 工具，`minimal` 是固定 Prompt 加单一持久 Shell，`cordis` 附加运行时检查与动态组合工具。preset 以 standing mount 按代共享，会话按 scope 加入；切换 preset 的公开操作只允许在空 Session 上进行，Turn 开始后会收到 `agent-preset/locked`。

Dynamic Cordis Package 是第四种机制：进程内、会话拥有、版本化的临时扩展，详见[动态插件与自修改边界](#动态插件与自修改边界)。

## 五层心智模型

建议把 DSH 看成五层，而不是`Cordis 加一堆插件`：

```text
A. Cordis Runtime
   Context / Fiber / Service / Event / Effect / Loader

B. Composition
   Profile / Bundle / Patch / Agent Preset

C. Host Capability Plane
   ctx.llm / ctx.tools / ctx.fs / ctx.sandbox
   ctx.sessions / ctx.agents / ctx.subprocess

D. Agent Execution Plane
   Inbox / Turn / Step / Model request / Tool pipeline / Session log

E. Client and Transport Plane
   Remote / Gateway / Client models / Slots / React / Browser modules
```

五层回答不同问题：Cordis Runtime 回答插件如何激活、依赖与卸载；Composition 回答本次运行装了哪些能力；Host 能力面回答 Agent 通过什么服务访问模型、文件、Session 和工具；Agent 执行面回答一次输入如何变成多个模型与工具步骤；Client 面回答 Host 状态如何跨传输投影到 UI。它们不是线性调用栈，而是五个正交观察角度。

## 推荐源码阅读路线

### 第 1 步：官方架构与术语

先读 [architecture](../architecture.md)、[cordis-primer](../cordis-primer.md)、[glossary](../glossary.md)、[packages/core README](../../packages/core/README.md) 和 [packages README](../../packages/README.md)。此阶段只需掌握 Context、Service、Plugin、`inject`、Fiber、Event、effect、Profile、Bundle、Preset；不要先通读 `vendor/cordis`。

### 第 2 步：观察一次 Profile 组合

在已安装环境运行 `dsh --profile web --dump-config`，对照 [profile.ts](../../packages/boot/app-boot/src/profile.ts)、[profile-boot.ts](../../apps/cli/src/profile-boot.ts)、[base bundle](../../packages/bundle/base/README.md) 和 [web-app bundle](../../packages/bundle/web-app/README.md)，回答：哪些 rows 来自 `dsh-base`，哪些由 Web surface 加入，哪些被 profile/home/CLI patch 覆盖。

此处需注意 patch 语义：patch 按 id 定位 Include 树条目，可覆盖 `disabled`、`inject`、`intercept`、`isolate`、`group`、`config` 等字段；被覆盖的 `config` 整体替换、不做 deep merge。patch 不跨 include 边界生效。Loader 更新是增量且非事务的：有效 patch 可能产生部分卸载与部分重载（见 [vendor/loader entry](../../vendor/loader/src/config/entry.ts) 与 [vendor/include](../../vendor/include/src/index.ts)），不提供整树回滚。

### 第 3 步：Cordis 最小机制

按 [cordis-primer](../cordis-primer.md) → [context.ts](../../vendor/cordis/src/context.ts) → [fiber.ts](../../vendor/cordis/src/fiber.ts) → [service.ts](../../vendor/cordis/src/service.ts) → [events.ts](../../vendor/cordis/src/events.ts) 的顺序读。要点见下节。

### 第 4 步：沿一个 Capability Seam 读到底

推荐 `ctx.shell` 或 `ctx.llm`。Shell 路径：[Service Definition](../../packages/shell/shell/src/index.ts) → [Provider](../../packages/shell/bash-local/src/index.ts) → [Consumer](../../packages/shell/tool-bash/src/index.ts)。LLM 路径：[Service Definition](../../packages/llm/llm/src/index.ts) → `llm-deepseek` provider → [agent-loop](../../packages/core/agent-loop/README.md)。观察 Provider 与 Consumer 如何只依赖 Definition、不互相绑定实现；同时记住 provider 数量约束由具体 Service Definition 决定（Shell executor 同一 Context 单实现，subagent provider 按名共存），角色也可由同一 package 组合承担。全景见 [capability-seams](../capability-seams.md)。

### 第 5 步：Agent Loop

读 [agent-loop README](../../packages/core/agent-loop/README.md)、[agent.ts](../../packages/core/agent-loop/src/agent.ts)、[tool-calls.ts](../../packages/core/agent-loop/src/tool-calls.ts)、[agent-lifecycle](../agent-lifecycle.md) 和 [tool-execution-pipeline](../tool-execution-pipeline.md)。要点见下文 Agent Loop 一节。

### 第 6 步：Session 与持久化

读 [session README](../../packages/core/session/README.md)、[session.md](../subsystems/session.md)、[persistence.md](../subsystems/persistence.md)、[persistence-catalog](../persistence-catalog.md) 和 [session-persistence](../../packages/session/session-persistence/README.md)。要点见下文 Session 一节。

### 第 7 步：Host 与 Client

读 [web-client.md](../subsystems/web-client.md)、[api-gateway](../api-gateway.md)、[client modules](../../packages/client/modules/README.md) 和 [slots](../subsystems/slots.md)。

### 第 8 步：Preset 与动态扩展

读 [agent-presets README](../../packages/preset/agent-presets/README.md)、四个 [preset 文件](../../packages/preset/agent-presets/presets/standard/agent.cordis.yml)（同目录含 `ptc`/`minimal`/`cordis`）以及 [extensions 组](../../packages/extensions/README.md)下四个包的 README。

## Cordis 机制精读要点

### Context 与 Service

Context 是服务仓库：插件通过 `ctx.tools`、`ctx.llm`、`ctx.sessions`、`ctx.fs`、`ctx.sandbox` 等稳定键获取能力，而不是 import 具体实现。服务注册随 Fiber 生命周期自动注销。可选服务用 `ctx.get(name)` 读取，`ctx.<name>` 保留给声明的注入——两者对拓扑的敏感度不同（见 packages/AGENTS.md 引用的 postmortem）。

### inject

`inject` 是持续的依赖声明而非一次性检查：插件在所需服务出现前等待，加载顺序由服务依赖推导，与书写顺序无关。

### Event 的五种分发方式

事件分发方式有 `emit`、`parallel`、`serial`、`bail`、`waterfall` 五种，dispatch mode 是事件公共契约的一部分（见 [cordis-primer](../cordis-primer.md)）。`waterfall` 是围绕式中间件：listener 收到 `(...args, next)`，调用 `next()` 委托后续 listener，不调用则有意短路。`必须调用 next()`应理解为：只观察或包装的 listener 必须委托；拥有拒绝或替换决定权的 policy listener 可以不调用。Agent 相关事件经 scope 过滤分发，不是单一全局链。

### effect 与可逆性

`ctx.effect()` 与 `ctx.on()` 把注册绑定到 Fiber：卸载时按登记执行 disposer，setup 失败时清理已登记资源，嵌套 disposer 逆序执行。这是`注册的可逆`，不是`外部副作用的回滚`：已写入的文件、已发送的请求、已提交的 Session、已启动的进程都不会被自动逆转；root fiber 的 disposer 并发执行，中途 dispose 可能按设计丢弃未发出的余量。Loader 配置更新同样是非事务的部分更新。工程口诀：effect 管生命周期内的注册与资源，不管业务世界的后果。

## Agent Loop 与工具管线

一次执行的骨架：

```text
inbox claim
  → turn/start
  → prompt/context assembly
  → agent/pre-step（可拒绝）
  → step/start
  → request/header + request/context
  → llm/stream（waterfall 包住 adapter）
  → assistant/message 或 assistant/attempt
  → tool/call
  → tools/pre-execute
  → approval + monotonic guards
  → tools/execute → tool body
  → tools/post-execute → finalizeContent → tools/result observer
  → tool/result
  → 下一个 step 或 turn/end
```

Turn 与 Step 的准确定义见 [glossary](../glossary.md)：Turn 是一次被接纳输入的处理周期，直到模型与工具停止或终止策略介入；Step 是一次模型请求及其工具执行；一个 Turn 可含零个或多个 Step。pre-step 拒绝、空输入、取消或早期失败会产生没有 Step 的 Turn；provider retry 留在同一 Step 内，产生 `assistant/attempt` 结算而非新 Step。

工具调度由 [tool-calls.ts](../../packages/core/agent-loop/src/tool-calls.ts) 负责：先记录模型原始 `tool/call`（保留原始 JSON 参数与 `callId`），再按 exclusive/parallel-safe 分组；并行调用进入有界并发池（`maxParallelToolCalls`），dispatch 可重叠但结果与上下文按模型顺序提交；dispatch 前取消映射为 `ABORTED_BEFORE_DISPATCH`，已启动调用的取消在排空后映射为取消结果。管线顺序由 [tools](../subsystems/tools.md) 的 registry 固定：pre-execute waterfall → 审批解析 → 单调守卫（只能拒绝，不能重新放行）→ execute waterfall 包住 body → post-execute → 定义级 `finalizeContent` → 同步 result observer；所有失败归一为冻结的 `isError` 结果。

一个关键边界：`ctx.tools.execute()` 执行 registry 管线，但核心 `tool/call`/`tool/result` Session 事件由 agent-loop 的调度器追加，直接调用工具运行时不会自动产生会话日志；PTC 嵌套 dispatch 有自己的 `tool/ptc-dispatch*` 记录。

## Session 与持久化

### 事件日志模型

Session 是内存中的类型化 append-only 事件日志（[session](../subsystems/session.md)）：`append()` 校验、冻结 payload、分配连续序号并在提交后发出 `session/event` 实时通知；replay/fork/resume 的种子构造不重新发通知。持久化是独立可选层：只有挂载 persistence backend 并通过句柄 append/flush，事件才落盘；`append` 的确认是`已接受`，`flush` 才是崩溃持久化边界（[session-persistence](../../packages/session/session-persistence/README.md)）。`session/event`、`session/flush` 是实时 Cordis 事件，不是持久事件名。

### model-visible ⟺ logged 的单向性

进入模型请求的输入必须可从日志重建；反向不成立。只有四类 surface 事件产生模型消息：`system/message`、`user/message`、`assistant/message`、`tool/result`。`turn/*`、`step/*`、`request/header`、`request/context`、`assistant/attempt`、`tool/call` 以及审批、压缩、计划等插件事件都是 log-only。`deriveMessages()` 是模型历史投影：replace 操作在投影中遮蔽旧节点但原始事件保留；审计与完整轨迹应读原始日志。当前持久事件清单以 [persistence-catalog](../persistence-catalog.md) 和 [known-event-types](../../packages/core/session/src/known-event-types.ts) 为准。

流与事件名的版本边界：当前 assistant 流嵌入 `assistant/message` 或 `assistant/attempt` 的结算记录，实时流经 `agent/assistant-stream` 传递；顶层 `assistant/chunk` 只存在于历史格式文档（见 [session-format-status](../session-format-status.md) 与 [persistence-changes](../persistence-changes/README.md)），不要用它描述当前协议。

### Replay、Fork、Resume 是三件不同的事

Replay 是从既有事件重建投影与模型历史，不重新执行模型、工具、HTTP、文件写入或本机进程。Fork 是在合法边界复制事件种子并建立新 lineage：低层 `SessionStore.fork`、Host session-controller 的 fork 与 subagent fork 的边界规则不同，不能笼统说`都截断到最近完成 Turn`。Resume 需要挂载持久化、取得独占写句柄、为中断 Turn 追加修复性关闭事件（合成工具未知结果、补 `step/end`、`turn/end {interrupted}`）后恢复等待新输入；它不重放旧工作。持久化的待处理输入经 `agent/inbox/spliced` 投影恢复，实时 inbox 通知不重放。

副作用边界：Session 可靠记录模型可见消息、工具调用与模型可见结果、请求头上下文、边界与来源，但不记录文件系统真实状态、进程状态、外部服务状态、审批外部通道、定时器或工具的 execution-local `value`。恢复时对无法确认结果的调用记录未知结果而不是自动重试；[session-checkpoint-policy](../../packages/session/session-checkpoint-policy/README.md) 把这一语义固化为模型请求前、顶层工具前、步边界前的 durability barrier。

## Host、Agent 与 Client 平面

Host 平面拥有进程级共享服务与权威状态：`ctx.tools`、`ctx.llm`、`ctx.sessions`、`ctx.fs`、`ctx.sandbox`、persistence、审批栈、subagent registry、Workspace/Session controller；负责权威状态、持久化、修改顺序、访问策略与流生产（[web-client](../subsystems/web-client.md)）。

Agent Preset 平面提供每个 Agent 的 scoped 贡献：工具、persona、prompt sections、skills、压缩、PTC 呈现、委派工具。preset 文件的注释明确划分归属：注册表、沙箱与审批栈、持久化、模型路由留在 Host；preset 内需要 realm 的 service 必须放在 `isolate` 组，否则会向进程全局 realm 泄漏并在挂载时被拒绝。

Client 平面经 `remotes → gateway → connection → webserver` 分层（[api-gateway](../api-gateway.md)）：Client model 镜像 Host 状态，UI 经 typed slots 组合，浏览器按 client module graph 懒加载。Host/Client 是所有权与编译面分离，不总是两个进程：Web 是 Node Host 加浏览器 Client，Desktop 是 Node Host 加 Electron renderer（`dsh-app://` 与帧管道，无监听端口），headless/sdk/acp 是 Host/stdio 组合、不需要浏览器。TypeScript 侧以 `tsconfig.host.json` 与 `tsconfig.client.json` 两个聚合体避免 Context 声明合并冲突（[development](../development.md)）。

## 动态插件与自修改边界

动态扩展的真实能力集：`cordis_define` 记录定义，`cordis_run` 运行（带浏览器半边的包等待页面批准），`cordis_stop`/`cordis_undefine` 停止或遗忘，版本更新是切换不可变包版本。边界同样明确（[cordis-host-runner](../../packages/extensions/cordis-host-runner/README.md)、[tool-cordis](../../packages/extensions/tool-cordis/README.md)、[cordis-client-runner](../../packages/extensions/cordis-client-runner/README.md)、[ui-cordis](../../packages/extensions/ui-cordis/README.md)）：

- 定义只存于进程内存，DSH 重启即消失；
- 定义属于创建它的 Session，其他会话视为不存在；
- Host 半边在 `node:vm` 中运行，`vmTimeoutMs` 只约束同步执行，异步可超时；
- 该 sandbox 隔离全局但不是安全边界，服务可达真实运行时；
- 不安装 npm 依赖、不修改 `cordis.yml`、不编辑仓库文件；
- 浏览器半边是受限纯 JavaScript，经守卫的 slots 与服务注册 UI；
- Web bundle 装载 runner 与 UI 基础设施，但模型可见的 `tool-cordis` 是 opt-in：由 `cordis` preset 或显式 overlay（如 [示例配置](../../apps/cli/config/examples/cordis/cordis.yml)）加入，默认 Web 会话不具备该能力。

持久化 preset 创作是复制式：系统 preset 只读，创建副本后在用户目录编辑。因此准确表述是：DSH 支持受信任 Agent 在运行时定义和装载受限临时扩展；不支持不可信 Agent 安全地重写核心并永久部署。`cordis` preset 自身把模型写入的代码标记为等同 Shell 访问的信任级别。

## 常见误读与纠正

| 常见说法 | 纠正后的准确表述 |
|---|---|
| 一切都是插件 | 主要产品能力以 Cordis 插件组合；Cordis、Loader、CLI 和启动基础设施是固定运行时 |
| 没有特权核心 | 没有只能改源码扩展的单体产品内核；不是没有任何核心基础设施 |
| 每个组件都可替换 | 遵守 Service Definition 的能力可替换；受 provider 数量约束、作用域、reload 策略和生命周期限制 |
| Patch 替换整行 | patch 可覆盖多个字段；被覆盖的 `config` 整体替换、不 deep merge |
| 所有注册都可逆 | 注册有 Fiber 作用域的注销；磁盘、网络、Session、进程等外部效果不会自动逆转 |
| 所有事件都是 waterfall | dispatch mode 是事件契约；waterfall 只是其中一种，且 scope 过滤 |
| Session 是持久事实源 | Session 是内存 append-only 日志；落盘由 persistence 与 flush 决定 |
| 日志就是完整回放 | 可重建模型历史与记录事实；不能重放外部副作用和运行时状态 |
| 每个日志事件都进入模型 | 仅四类 surface 事件产生消息；大量边界、审计与请求事件是 log-only |
| Replay 会重新运行 Agent | replay 是投影重建，不重新调用模型与工具 |
| Scope 是租户隔离 | scope 隔离服务可见性与组合；不隔离堆、模块缓存、环境变量、OS 权限和共享存储 |
| Web 默认支持模型动态装插件 | 动态 UI 基础设施默认存在；模型可见工具 `tool-cordis` 是 opt-in |
| DSH 已支持自进化 | 有受信任、进程内、会话拥有的受限动态扩展；不是安全自修改生产系统 |

## Browser-native 视角

对`把 Agent Loop 放进浏览器`这一方向，源码给出的判断与 [browser-native 调研](dsh-browser-native-runtime-research.md)一致：架构上可行——Agent Loop 通过 `ctx.agents`/`ctx.llm`/`ctx.sessions`/`ctx.tools` 服务工作，`ctx.fs` 是异步能力接缝，[webworker-runtime](../../packages/experimental/webworker-runtime/README.md) 已有 Dedicated Worker Host 装载路径；但完整 Node 版 DSH 不能原封不动搬进浏览器，需要按依赖闭包、AsyncLocalStorage 归属、持久化、执行世界一致性和页面生命周期逐项验证。第一验收应是 scripted 模型适配器下至少两次模型调用、第二次请求确实包含第一次工具结果的确定性闭环，而不是 Worker 启动或 fixture 展示。

## 最终阅读清单

### 必读一手资料

1. [官方产品页](https://www.deepseek.com/harness/)——设计主张与运行模式概述。
2. [architecture](../architecture.md)——组合、服务、事件与扩展点的权威地图。
3. [cordis-primer](../cordis-primer.md)——Context、Service、`inject`、事件分发与 effect 的入门规范。
4. [capability-seams](../capability-seams.md)——生成的能力接缝全景（Definition/Provider/Consumer 归属）。
5. [agent-loop README](../../packages/core/agent-loop/README.md) 与 [agent-lifecycle](../agent-lifecycle.md)——Turn/Step 与执行生命周期。
6. [session README](../../packages/core/session/README.md) 与 [persistence-catalog](../persistence-catalog.md)——事件模型与当前事件清单。
7. [app-boot README](../../packages/boot/app-boot/README.md)——profile 装配、层序与 reload 策略。

### 第三方导览（按用途）

- 全局地图：[Yiipu 仓库分析](https://yiipu.github.io/posts/deepseek-harness-analysis/)
- 系统分层与数据流：[张忠琳系统级分析](https://deepseek.csdn.net/6a84dcfe10ee7a33f29c98f0.html)
- Cordis 入门：[程序员 z7 的机制解析](https://deepseek.csdn.net/6a8400e910ee7a33f29c6881.html)
- 视觉模型：[小生凡一图解](https://deepseek.csdn.net/6a7f254310ee7a33f29b0548.html)
- 架构判断（作者观点）：[Locsic 分析](https://locsic.com/zh/thinking/deepseek-harness-architecture-analysis/)
- 理论动机：[Cordis 论文导读](https://dshx.dev/blog/2026-08-19-cordis-paper-guide/) 与 [arXiv 论文](https://arxiv.org/abs/2608.25512)
- 源码精读补充（未逐段核验）：[Han (Andrew) Zheng 分析](https://securaize.substack.com/p/deepseek-harness)

阅读任何第三方文章时保持这组区分：产品能力与 Cordis 基础设施、Profile 与 Agent Preset、Bundle 与任意插件、Session 日志与全部运行时状态、replay 与副作用重放、effect 注销与事务回滚、scope 与租户安全、理论可组合性与当前产品承诺。

## Dev Note

本文是导引与核验稿：外部文章结论已按可访问性分级标注，未逐段核验的正文不作为事实依据；第三方链接的可用性随时间变化。若将其中判断升级为正式文档，应把每个事实落回对应 package README、subsystem 文档或源码，并拆分到各自的唯一归属。本文为单语草稿，已在翻译配对清单中排除。
