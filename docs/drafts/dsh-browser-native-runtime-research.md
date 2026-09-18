---
description: "评估 DSH 浏览器原生运行时、云端工作区与可选本机桥接的可行性，区分现有实现、产品化缺口、技术风险和建议实施路径。"
---

# DSH 浏览器原生运行时、云端工作区与本机桥接深度调研

## Summary

将 DeepSeek Harness（DSH）演进为 **Browser-native Agent Runtime + Cloud Workspace + Optional Native Bridge** 架构具有明确的技术基础，但目前还不能将其视为已经实现的产品能力。

仓库中的实验性 WebWorker runtime 已具备在 Dedicated Web Worker 内装载 Cordis Host 插件树的实现，preview 验收代码覆盖启动、Remote 调用、预置 Session 展示及部分状态修改。SSH provider 家族则提供了通过现有 `ctx.fs`、`ctx.subprocess`、`ctx.sandbox` 接口承载远程能力的先例。这两项基础使浏览器原生运行时不必从零建设，也不必另建一套 Agent framework。

主要缺口集中在真实 Agent 执行闭环、浏览器持久化、云端 Session 与 Workspace 服务、多执行者写权、Native Bridge 授权和页面退出后的任务连续性。现有 preview 测试中的工具与子代理历史来自 fixture，不能作为浏览器已经完成 live prompt → model → tool → model 回路的证据。

建议采用 **Browser-first，而非强制 Browser-only** 的产品路线：浏览器承担交互式 Agent 计算，云端保存已提交事实并提供可选的持续执行能力，本机桥接只提供明确授权的操作系统能力。WASM 是补充工具能力的一种手段，不是迁移整个 DSH runtime 的前提。

对“直接在浏览器运行 DSH”的可行性判定如下：

| 运行目标 | 判定 | 说明 |
|---|---|---|
| 在 Dedicated Worker 中运行选定 DSH Host composition | 已有实现基础 | 现有 runtime 已能装载 Host tree 并连接页面 Client |
| 不依赖配套本地 Node Host 运行 Agent Loop | 架构上可行，尚未完成 live-loop 验收 | 需要确定性模型与工具闭环验证 |
| 在真实浏览器中接入真实模型 | 路径可行，尚未端到端验证 | 需要目标 Worker runtime、模型代理、流式与取消测试 |
| 原封不动运行完整 Node 版 DSH | 不可作为目标 | Node native module、系统进程和任意二进制需要替代 provider |
| 仅依赖浏览器实现页面关闭后的持续执行 | 不可行 | 需要具有独立生命周期的云端 worker |
| 在 Main Thread 中运行 Host 与 Agent Loop | 不属于建议架构 | Main Thread 继续承载 Client Cordis、Client model 与 UI |

本文所说的“直接在浏览器运行”指运行时不依赖配套的本地 Node Host，DSH Host 与 Agent Loop 驻留 Dedicated Worker。它不表示无需预构建镜像、无需 Node 兼容层、无需远程模型服务，也不表示可以离线使用全部能力。

## Table of Contents

- [调研范围与证据边界](#调研范围与证据边界)
- [目标架构与责任划分](#目标架构与责任划分)
- [当前代码基础](#当前代码基础)
- [能力差距](#能力差距)
- [关键技术问题](#关键技术问题)
- [架构决策建议](#架构决策建议)
- [建议实施路线](#建议实施路线)
- [风险与未验证项](#风险与未验证项)
- [结论](#结论)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

## 调研范围与证据边界

本文面向负责 DSH 架构、运行时和平台建设的工程师，回答四个问题：

1. DSH 的 Agent runtime 能否驻留浏览器，而不依赖一个配套的本地 Node Host？
2. Cloud Workspace 可以复用哪些现有接口，还需要新增哪些服务？
3. Optional Native Bridge 如何提供本机能力，而不重新成为完整 DSH Host？
4. 哪些验证必须在扩大建设范围之前完成？

全文区分三类内容：

| 类别 | 含义 |
|---|---|
| 当前实现 | 可以在仓库源码、package README 或测试代码中定位的机制 |
| 验证边界 | 现有测试实际覆盖的行为，以及尚未获得运行证据的行为 |
| 建议设计 | 面向目标产品的方案，不代表已经实现或已经确定的技术选型 |

本文依据源码与已有测试内容评估实现基础，未重新执行浏览器 preview、真实模型调用、OPFS 恢复或多标签页并发实验。因此，“存在实现与验收代码”不等于“本次调研已实测通过”，更不等于“已满足生产环境要求”。

Browser-native 描述 Agent 计算的部署位置，不描述模型、Workspace、身份认证和持久化服务的位置。浏览器中的 Agent Loop 仍然调用云端模型代理、Cloud Workspace 与 Cloud Session；“无配套 Node Host”只排除为浏览器会话运行本地或云端 Node 进程作为 Agent 执行者，不等于离线运行或无后端产品。

这是一份架构调研稿，不替代各实现包的行为说明。当前行为以对应源码和 package README 为准；建议设计需要通过后续决策记录、实现和验收转化为产品承诺。

## 目标架构与责任划分

目标架构可以保留四条原则，但需要为每条原则补充准确的适用范围：

- **Cloud = Truth**：云端保存已提交的 Session、Workspace 版本和授权记录。
- **Browser = Compute**：浏览器承载交互式 Agent loop、上下文组装和工具编排。
- **OPFS = Cache**：OPFS 保存可恢复的本地副本；尚未同步的修改必须单独标记，不能当作可随意逐出的缓存。
- **Native Bridge = Capability**：本机桥接提供授权后的文件、进程等能力，不拥有另一套 Agent loop。

“Cloud = Truth”只适用于被声明为云端实体的已提交状态。当前组合中持久化的状态不止 Session 和 Workspace，还包括 settings、credentials、attachments、storage domain、projection 缓存和 Workspace registry。每个持久状态域都必须指定权威位置、浏览器副本和提交确认；Memory、OPFS 与 Client model 不能被笼统视为云端已提交状态：

| 状态域 | 建议权威位置 | 浏览器状态 |
|---|---|---|
| Session event log | Cloud Session store，或明确的 device-local 模式 | 工作副本与未提交队列 |
| Workspace 内容与版本 | Cloud Workspace，或明确的 local-only 模式 | Memory / OPFS 副本 |
| Attachments / Blob | 授权后的云端内容存储 | 按需缓存 |
| Workspace registry 与用户 settings | 用户或租户级云端存储，或显式 device-local | Client mirror |
| Projection / 搜索索引 | 可重建的云端或本地派生状态 | Cache |
| Provider credentials / grants | 服务端秘密存储 | 引用、configured 状态与短期授权；不保存平台密钥 |
| Native Bridge grants | 配对设备或授权服务 | 短期状态与撤销信息 |

建议部署结构如下：

```text
Cloud
  身份认证与租户授权
  Session 持久化、查询与执行所有权
  Workspace 元数据、版本、内容存储与变更订阅
  LLM 代理、云端工具
  可选 Durable Agent Worker
           ▲
           │ 认证后的网络协议
           │ 命令、事件、同步、租约、执行回执
           ▼
Browser
  Main Thread
    Client Cordis / Client models / UI

  Dedicated Worker
    Cordis Host / Agent loop / Tools / Skills
    Session 工作副本 / Workspace view

  Memory
    同步运行时文件视图

  OPFS
    持久副本 / 缓存 / 待同步修改
           ▲
           │ 可选、已配对且受限的能力调用
           ▼
Native Bridge
  授权目录访问 / Shell / Process
  Git / Docker / 本机浏览器等可选能力
```

### Cloud Workspace 不只是远程文件系统

`ctx.fs` 是 Agent 和工具访问文件的接口，但不是完整的 Cloud Workspace 产品模型。

Cloud Workspace 至少需要定义稳定的 Workspace 身份、路径与文件版本、内容存储、访问权限、变更提交、冲突处理、订阅和执行位置绑定。云端服务决定用户可以操作哪个 Workspace，以及提交基于哪个版本；文件 provider 再把这一授权视图提供给工具。

内容寻址 Blob、全局 Workspace revision 和逐文件 version 都是可选机制，不能仅凭“Cloud 是事实源”直接确定。具体选择应由提交原子性、目录规模、分支需求和协作方式决定。

### 一个 Agent 回合只能使用一个一致的执行世界

`ctx.fs` 的 `processPath()` 返回该文件系统执行世界中的路径，`ctx.subprocess` 在自己的执行世界中启动进程，`ctx.sandbox` 约束同一执行世界中的文件效果。三者的组合不是可以独立开关的能力列：

| 执行世界 | Agent loop | `ctx.fs` | `ctx.subprocess` | `ctx.sandbox` | 典型状态 |
|---|---|---|---|---|---|
| Browser Worker | 交互式执行（目标） | MemoryVfs / OPFS-backed view | 受限 command Worker | VFS effect policy | 页面工作副本 |
| Cloud helper | Durable 执行时使用 | 云端 Workspace view | 同一 Cloud helper | 云端 sandbox | 云端事实与执行 |
| Native machine | Bridge 执行时使用 | 本机目录 | 本机 process | OS sandbox | Bridge 物化目录 |

同一个 Agent 回合需要从一组相容的 provider 中选择执行世界；把来自不同世界的 fs、process 和 sandbox 任意拼接，必须先定义路径映射、物化和提交语义。SSH provider 家族已经体现这一约束：fs、subprocess 与 sandbox 必须指向同一远端主机。

### Browser Host 与 Browser Client 是两棵不同的树

主线程中的 Client Cordis 负责 UI、状态投影和用户交互。Dedicated Worker 中的 Host Cordis 负责 Agent、工具、Session 和业务服务。

把 Host 放进浏览器不意味着把业务状态交给 React，也不意味着消除 Host/Client 的责任划分。改变的是部署位置，不是 UI 与执行状态之间的所有权关系。

### Durable 执行是任务连续性能力，不是所有部署的前提

只要求页面打开期间交互执行的产品，可以先不提供云端 Agent worker。

如果产品承诺关闭页面后继续、定时运行或无人值守执行，就必须引入具有独立生命周期的执行者，例如云端 worker。浏览器 Dedicated Worker 本身无法提供这种承诺。

### 本机目录需要明确其与 Cloud Workspace 的关系

“Cloud 是事实源”不能自动覆盖用户机器上的任意目录。Bridge 接入本机文件时，至少有两种不同模式：

- **云端工作区的本机副本**：本机修改需要提交回云端，并遵守版本与冲突规则。
- **独立本机工作区**：本机文件是文件事实源，云端只保存 Session、引用或经用户选择上传的产物。

建议首期选定一种模式。若同时支持，两种模式必须在 Workspace 元数据、UI 和权限策略中明确区分，不能把本机任意修改静默解释为云端已提交状态。

## 当前代码基础

现有基础主要来自 Web Client、实验性 Worker Host 和 SSH provider 三部分。它们证明了可复用的架构机制，但没有共同构成完整的目标产品。

### 浏览器 Client Cordis 已有独立分层

[Web Client architecture](../subsystems/web-client.md) 将当前 Web Client 划分为 Remote transport、Client models、UI adapters、Conversation、Slots 和 React 等层次。

Host 拥有业务状态、修改顺序和持久化；Client model 维护面向 UI 的状态镜像。界面通过注入的 Client service 或 Remote 方法发起命令，而不是直接持有 Host Context。

这套分层可以继续服务 browser-native Host。没有必要因为 Host 改在 Worker 内运行，就重新建设浏览器插件框架或把业务逻辑搬进 UI。

### 实验性 WebWorker runtime 已有完整 Host 装载路径

[webworker-runtime](../../packages/experimental/webworker-runtime/README.md) 在 Dedicated Web Worker 中装载 Harness 插件树。[webworker-packer](../../packages/experimental/webworker-packer/README.md) 提供 VFS 镜像打包和模块转换；[preview.ts](../../apps/web/src/preview.ts) 创建 Worker 并传入镜像及数据 overlay。

Worker 从镜像内启动 Host，页面通过 postMessage 上的 synthetic HTTP tunnel 与其通信。因此，browser-native Host 并非只有概念设计，仓库已有可继续演进的运行时原型。

这里的“完整 Host 树”指选定组合能够在 Worker 中装载，不意味着其中每项 Node 能力都在浏览器里具有等价实现。

当前 Worker runtime 装载的是 packer 生成的版本化 VFS 镜像：模块来自 built publish view 与静态 reachability sweep，必须符合 lowering contract；数据 overlay 只能覆盖 `home/` 与 `workspace/`，不能替换配置、manifest 或 modules。因此，“保持插件 API 不变”不等于“任意插件可以在浏览器运行时安装”。可信代码插件首期应随版本化镜像打包；Skills 与 Workspace 数据可以独立同步。运行时第三方代码安装需要单独设计签名、版本兼容、模块获取、lowering、资源限制和执行隔离。

### Node 兼容层包含真实实现与结构性桩

[模块代理表](../../packages/experimental/webworker-runtime/src/module-proxies.ts) 将 Node 模块和外部包依赖映射到浏览器实现或替代实现。

文件、路径、部分 crypto、stream、HTTP、AsyncLocalStorage 和子进程行为由 VFS、浏览器原语或虚拟进程层承接。DNS、net、vm、SQLite、worker_threads 及部分原生依赖则存在明确限制或结构性桩。

必须区分“模块可以解析、插件可以装载”和“请求路径可以工作”。例如：

- `@vscode/ripgrep` 替代模块提供可解析路径，但对应执行路径不可用。
- `pi-ai` 替代模块允许依赖装载，但请求路径明确失败，不能由此获得完整 provider 生态。
- preview 使用明文 JSONL，不能把 `node:zlib` 的模块映射解释为已有可用的 Zstandard Session 编解码能力。
- PTC Node 程序和任意系统二进制不能因为存在子进程兼容接口而自动运行。

兼容层的精确能力范围应以 runtime README 和对应实现为准，而不是根据模块名判断。

“浏览器可运行”的验收标准也不是源码零 Node import：`agent-loop` 自身直接导入 `node:crypto` 的 `randomUUID`，由兼容层的 crypto 实现承接。正确标准是可达依赖闭包内的每个 Node builtin 和 native 依赖，都由 Worker runtime 提供真实替代实现，或被明确识别为不可用并 fail loud；不存在未解析、未声明或静默走 Node-only 分支的依赖。当前 packer 只把静态闭包中的部分缺失依赖转化为构建失败，部分外部 unresolved request 会留到运行时才暴露，因此 Agent Loop 验收应产出机器生成的可达依赖报告：区分真实实现、结构性 stub、明确不支持项、未解析外部依赖与 native 依赖，并证明被执行路径不经过 stub 或 Node-only 分支。

### MemoryVfs 留有持久化扩展接口

[MemoryVfs](../../packages/experimental/webworker-runtime/src/storage/memory.ts) 提供同步文件系统视图，并支持可选的 `VfsMutationSink` 与 `flush()`。

当前 `VfsMutationSink` 是 post-commit write-behind observer：内存修改先完成，之后才通知 sink；sink 失败不能回滚内存写，接口也没有 pending、failed 或 last-durable 状态。当前 Worker Host 通过 `loadVfsImage` 创建 VFS，尚未暴露 sink 注入入口；mutation 记录也不携带 operation id、base revision 或服务端确认。因此它是本地持久化的扩展点，不是现成的 durable backend，更不能直接当作 Cloud Workspace 同步协议。

已检查的 Worker runtime 源码中没有 OPFS 或 IndexedDB 持久化实现。启动恢复、持久写入顺序、失败传播、存储配额和缓存逐出仍需定义。

### 浏览器 Shell 是受限解释器，不是系统 Shell

[命令表](../../packages/experimental/webworker-runtime/src/shell/programs/index.ts) 定义浏览器环境可以执行的命令。[进程宿主](../../packages/experimental/webworker-runtime/src/shell/process/host.ts) 为 Worker-backed 命令提供独立执行 Worker，使终止 Worker 可以停止非协作命令。

这是有价值的执行与取消机制，但不能等同于 POSIX 进程或 Bash 环境。Git、Node、编译器、容器和任意本机二进制仍需要专门的浏览器实现、WASM 工具链、云端执行者或 Native Bridge。

Host Worker 与 command Worker 的文件语义也不同：Host 内的 `node:fs` 兼容层同步访问 MemoryVfs，而 command Worker 只能通过消息向 Host 请求文件操作，目录遍历每项产生一次往返；并发命令的写入可以交错，终止 command Worker 也不会回滚已提交的 VFS 修改。放入该进程层的 WASM 命令需要适配异步文件访问，或明确要求 cross-origin isolation 与 SharedArrayBuffer，不能默认继承 Host Worker 的同步文件视图。

### Preview 验收不等于 live Agent 回路验收

[preview-boot.e2e.ts](../../apps/web/tests/preview-boot.e2e.ts) 覆盖 Host 启动、空镜像入口、预置 Workspace 与 Session 发现、部分 Remote 修改，以及历史中的工具卡、子代理目录和分页展示。

这些工具与子代理记录来自 fixture，不是测试期间新执行的 Agent 回合。因此，现有覆盖能够支持以下判断：

- Host 与 Client 可以通过 Worker transport 对接。
- VFS 中的 Session 数据可以被发现和投影。
- 部分 Remote 写入路径已有浏览器验收代码。

它不能证明真实 prompt → model → tool → model 回路、并发子代理执行、模型取消或崩溃后的持续执行已经完成。

preview 中的 `credentials/set/describe/unset` 也只验证 Remote 调用与 VFS-backed provider 的写入读取路径。文件型 credentials provider 不隔离同一执行用户下的秘密，它不是平台托管 key 的 browser-native 方案；平台密钥应留在服务端，浏览器只接收引用、configured 状态和必要的短期授权。

### SSH provider 家族提供远程能力实现先例

[SSH provider family](../../packages/ssh/README.md) 通过远程 helper 提供文件、进程与 sandbox 能力：

| Provider | 提供的服务 |
|---|---|
| `dsh-ssh` | `ctx.ssh`，连接和 helper 生命周期 |
| `fs-ssh` | `ctx.fs` |
| `subprocess-ssh` | `ctx.subprocess` |
| `sandbox-ssh` | `ctx.sandbox` |

这说明远程能力可以接入现有服务定义，工具不必为每种部署位置重新定义一套 API。

[fs-ssh](../../packages/ssh/fs-ssh/README.md) 的版本守卫、helper 侧原子修改，以及传输失败后不自动重试结果不明的修改，是设计云端与本机 helper 时值得保留的失败语义。

SSH provider 仍不等于 Cloud Workspace。它没有自动提供多租户 Workspace 身份、跨设备同步、内容版本服务或云端执行所有权。

### 现有 `dsh-workspace` 是目录 registry，不是 Cloud Workspace

当前 [`@deepseek-ai/dsh-workspace`](../../packages/workspace/workspace/README.md) 是 canonical Host directory 的 durable registry：保存项目顺序、标题与 Session membership。它不保存文件内容、文件版本或跨设备副本。

目标 Cloud Workspace 可以复用这一产品概念或迁移其记录，但不能把该 registry 当作云端文件控制面；[`workspace-files`](../../packages/api/workspace-files/README.md) 则是面向 Web Client 的只读文件预览与观察服务，同样不承担 Workspace 控制面职责。

## 能力差距

下表概括目标产品相对于已检查实现的主要缺口。“已有”表示存在源码或测试基础，不表示本次已实测生产可用。

| 能力 | 当前基础 | 主要缺口 |
|---|---|---|
| Browser Host | Worker 内的 Host 装载、模块转换与页面连接器 | 产品入口、版本兼容策略、浏览器支持范围 |
| Live Agent loop | Agent 包随 Host 组合装载 | 确定性模型回路、真实模型回路、取消和异常验收 |
| Session 持久化 | JSONL over MemoryVfs、sink 扩展接口 | 浏览器持久化、远端存储、恢复与确认语义 |
| Session 查询与 UI | Controller、Remote、Client model；exact reads/traces 不依赖打开 SQLite | ranked 全文检索（浏览器组合不打开 SQLite）、云端查询实现、租户授权、跨执行位置协调 |
| 单写者控制 | 单 Worker 内写声明与 flock 替代实现 | 多标签页、跨设备和 Browser/Cloud 写权仲裁 |
| Cloud Workspace | 文件接口与远程 provider 先例 | Workspace 身份、版本、同步、冲突与 ACL |
| 本地副本 | MemoryVfs | OPFS、待同步修改、配额管理与逐出 |
| LLM | llm-deepseek 的可配置 `baseURL` 与 fetch 路径 | 认证代理、流式透传、取消、额度和浏览器 e2e |
| 搜索与执行 | 受限命令表、Worker-backed 命令 | 搜索实现、Git、工具链和外部执行能力 |
| Native Bridge | SSH helper 和逐调用策略先例 | 配对、执行端授权、撤销、结果查询与审计 |
| Durable 执行 | Node headless 的 Session adoption 机制 | 云端调度、写权转移、崩溃恢复和副作用处理 |

## 关键技术问题

关键问题不只是“能否在浏览器执行 JavaScript”，而是执行身份、持久化确认、云端一致性和外部副作用在故障条件下是否仍然成立。

### 1. 异步发起者归属必须单独验收

DSH 的 Agent 服务使用 `AsyncLocalStorage` 追踪发起者范围。[浏览器实现](../../packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/async_hooks.ts) 通过回调包装、转换后的 `await` 上下文恢复及 fallback stack 模拟相关语义。

源码明确记录了限制：未经转换的原生 async frame 无法被完全观察，在重叠执行边界下可能发生错误归属。这个问题可能不导致崩溃，却把行为关联到错误的 Agent。

建议至少覆盖两个并发 root Agent、嵌套 subagent、timer、fetch、Promise callback、取消和异常的交错组合。外部插件的装载策略也需要明确：哪些代码必须经过转换，哪些依赖不在并发正确性的支持范围内。

WASM 不会自动解决 JavaScript 异步上下文归属问题。

### 2. Worker 内同步 `node:fs` 兼容层与按需取数存在真实冲突

公共 `ctx.fs` 本身已是异步 capability seam：`resolve`/`stat`/`readText`/`streamText`/`readBytes`/`listDir`/`writeText`/`editText` 均返回 Promise，可以直接容纳远程或云端 provider。存在同步约束的是 Worker 内的 `node:fs` 兼容层和依赖同步 Node fs 的未转换包。

以内存 VFS 支撑同步 `node:fs` 调用、以 OPFS 提供异步持久副本，是与现有代码相容的候选方案。但当文件内容尚未缓存时，同步 `readFileSync` 无法等待普通网络请求，因此同步兼容层不能直接承担“大 Workspace 按需从云端读取”。

因此需要区分两个文件层：

- **运行时文件层**：模块、配置和启动所需文件，启动前准备到同步 VFS。
- **工作区文件层**：通过可异步完成的 provider 访问，或在执行前明确预取所需范围。

如果部分工具绕过 `ctx.fs`，直接调用同步 Node fs，就需要审计这些依赖，并决定预取、改用异步接口或显式拒绝缓存缺失。不能用隐藏的网络等待掩盖这一约束。

### 3. 内存成功、本地持久化和云端提交是不同状态

目标系统至少存在三种确认：

| 确认状态 | 能承诺什么 |
|---|---|
| 内存修改成功 | 当前运行时可以读取新状态 |
| 本地持久化完成 | 在浏览器存储仍可用的前提下，可以尝试跨刷新恢复 |
| 云端提交完成 | 云端已接受修改，可用于跨设备恢复与版本判断 |

`flush()` 必须明确对应哪一种确认。等待 OPFS 写入不能被描述为云端提交完成；内存 append 成功也不能被描述为 Session 已经 durable。产品化 OPFS 还需要 Host 装配入口，以及可供 UI 与生命周期逻辑读取的 pending、failed 与 last-durable 状态——这些都不在当前 `VfsMutationSink` 接口中。

OPFS 的配额、清理和持久存储策略仍受浏览器管理。尚未同步的编辑或 Session 记录不是可随意逐出的缓存，应与可重新下载的数据区分，并在 UI 中暴露未同步与失败状态。

### 4. 多标签页互斥不能替代跨设备所有权

当前 [flock 替代实现](../../packages/experimental/webworker-runtime/src/node/external_packages/node-addon-system-flock.ts) 依赖单 Worker 内的写者假设。多个标签页或 Browser 与 cloud worker 同时写同一 Session 时，这个假设不成立。

Web Locks 可以作为同源页面仲裁的候选机制，但不能处理另一台设备或云端执行者。云端 Session 服务需要权威的 owner 判断，并在提交时拒绝过期执行者。

一种可行设计是使用带代际编号的 fencing token：每次 owner 转移生成新代际，每次 append 校验代际。单纯依赖客户端“已经停止”或租约超时不足以阻止断网的旧执行者恢复后继续提交。

Session 写权与 Workspace 修改权也需要区分。一个 Session 单写，并不意味着整个 Workspace 只能有一个编辑者；Workspace 可以采用版本冲突控制，而 Session 保持有序单写。

### 5. 写权转移不等于外部副作用恰好执行一次

fencing token 可以保护云端 Session append，但不能自动撤销已经启动的本机命令、文件修改或外部 API 请求。

典型故障是：工具已执行成功，执行回执尚未写入 Session，浏览器就崩溃。新的执行者无法仅凭日志判断是否应重试。

因此，重要工具需要定义稳定的调用标识、执行回执、结果查询，以及适用时的幂等键。对于无法幂等化、无法查询结果的动作，恢复流程应报告“结果未知”，而不是盲目重试。

Workspace commit 与 Session append 属于两个独立权威服务，不能假设二者具有原子事务。有副作用的工具调用应使用稳定 operation id；Workspace 提交返回 commit/revision 与可查询 receipt，Session 再记录该 receipt。若 Workspace 已提交而 Session append 失败，恢复流程应通过 operation id 查询并补记结果，而不是重放修改。无法查询或幂等化的操作必须记录“结果未知”。这与 `fs-ssh` 已有的失败语义一致：传输丢失时修改可能已经提交，provider 不自动重试。

目标应是“可识别、可对账的执行”，不能泛化承诺所有外部动作都 exactly-once。

### 6. 浏览器隔离不等于插件安全隔离

浏览器可以限制代码直接访问宿主操作系统，但同一 Worker 内的插件通常共享该 Worker 的网络、存储和服务访问能力。

Dedicated Worker 是并发与生命周期隔离机制，不天然是对同源不可信代码的完整安全边界。仅把不可信插件放进另一个同源 Worker，也不能保证它失去同源存储或网络权限。

开放不可信代码执行前，需要明确可信代码范围，并评估隔离 origin、受限 compartment、能力消息接口和网络策略。技能文本与可执行插件代码也应区别对待：前者可能通过模型诱导工具调用，后者可以直接执行程序；两者都需要授权控制，但攻击路径不同。

云端同理且更强：Cloud API 每次请求都必须把认证 principal 重新授权到 Session、Workspace、Blob 和执行租约，客户端提供的 id、revision 或 owner token 不能自行授予访问；SessionId、WorkspaceId、Cordis scope、VFS root 或 Web origin 都不是租户隔离边界。承载不互信租户工具执行的 Durable worker 仍需要每租户或每任务的进程、容器、微虚拟机或等价外部隔离。

### 7. 页面退出后的恢复不能依赖成功清理

有序切换时，可以让 Browser 停止新任务、等待安全点、提交状态，再释放 owner，由 cloud worker 接管。

但页面可能被直接回收或崩溃，不能把 `beforeunload`、退出时 `flush()` 或清理回调作为可靠协议。非正常退出需要从最近一次云端确认状态恢复，并通过新的 owner 代际阻止旧执行者继续提交。

[headless runner](../../packages/bundle/headless/README.md) 的 adoption 与 flush 行为可以作为参考，但不是现成的分布式恢复协议。

运行中的 JavaScript 栈、等待审批的 Promise 和本机进程也不会随 Session 日志自动迁移。接管必须定义可恢复点、未完成工具状态，以及不能迁移的能力如何失败或重新授权。

现有 [session checkpoint policy](../../packages/session/session-checkpoint-policy/README.md) 已定义可复用的 durability 语义：模型请求发送前、可能产生外部副作用的顶层工具执行前、以及下一步模型请求派生前建立 durability barrier；checkpoint 失败则 fail closed，被中断的工具恢复为 unknown outcome 而不是自动重试。Browser 与 Cloud Session provider 应保留这些行为，改变的只是存储后端与 owner 协议。

### 8. 模型代理不只是解决 CORS

llm-deepseek 使用可配置的 `baseURL` 和 fetch 请求路径，是浏览器模型接入的直接候选。但仍需在目标 Worker runtime 中验证流式响应、工具参数流、取消和异常行为。

生产代理还需要承担身份认证、租户额度、上游凭据保管、目的地址约束、用量记录和请求限制。平台管理的 provider key 不应写入浏览器镜像、长期浏览器存储或模型可见内容。

取消也有两层含义：浏览器停止消费响应，以及上游真正停止生成。代理应传播取消，但不能未经验证就承诺上游计费或执行立即停止。

如果产品支持用户自带 key，应作为独立的安全与凭据存储模式设计，不能与平台托管 key 混为一谈。

### 9. Native Bridge 必须在本机执行端验证授权

[user-approval](../../packages/interaction/user-approval/src/index.ts) 已提供 `approval/asked` 与 `approval/decided` 审计事件，以及无答复者时 fail closed 的行为。这可以复用为会话内审批记录，但不等于已有 Bridge 授权协议。

Bridge 至少需要验证调用方、Workspace、机器、能力、路径或参数限制、有效期和重放约束。授权应由受信任的配对或签发机制产生，不能因为请求包含“用户已同意”字段就执行。

若采用 localhost 通信，还必须处理 origin 校验、配对密钥、连接安全和浏览器平台限制。localhost 不是可信调用方身份，网页能够连接本机服务也不代表用户已授权。

文件修改应在执行端检查实际路径、符号链接和版本条件。客户端过滤工具 schema 或隐藏按钮不能替代执行端检查。

## 架构决策建议

以下建议以复用现有接口、明确数据所有权和缩小首期验证范围为原则，不代表已经完成选型。

### 优先复用服务定义，而不是按部署位置新造 API

Browser、Cloud 和 Native 实现应优先填充现有 `ctx.fs`、`ctx.subprocess`、`ctx.sandbox`、`ctx.llm` 等接口。

只有在现有接口确实无法表达必要语义时，才扩展服务定义并更新消费者。

现有 [`ctx.workspaceFiles`](../../packages/api/workspace-files/README.md) 是面向 Web Client 的 bounded read、directory listing 与 filesystem observation API，建立在 `ctx.fs` 之上；它不是可替换的文件后端，也不是 Cloud Workspace 控制面。Agent 与工具继续消费 `ctx.fs`。云端 Workspace 身份、版本、授权、提交与订阅如果无法由现有服务表达，应形成独立、明确命名的控制面服务，而不是扩张 `workspaceFiles` Remote API。

Provider 注册某个 Service Definition 时，应满足该服务当前消费者依赖的完整契约：`FileSystem` 的方法集（`resolve`/`stat`/`readText`/`streamText`/`readBytes`/`listDir`/`writeText`/`editText`）是一个整体，仓库也没有通用的 provider 能力协商协议。部署无法提供完整 `ctx.fs` 时，应保持服务缺席，或在出现真实消费者后定义更窄的 capability seam；不要注册依赖临时运行时探测的半实现 provider。

### 分开 Session 存储、查询、传输和执行所有权

这四项职责可以共享基础设施，但应独立定义：

| 职责 | 核心问题 |
|---|---|
| 持久化 | 事件如何写入，何时确认，失败如何表现 |
| 查询 | 如何发现、分页读取和订阅 Session |
| 传输 | 请求、流、取消和重连如何跨进程或网络承载 |
| 所有权 | 谁可以继续执行和提交，如何接管与拒绝旧 owner |

现有 Remote 与 postMessage tunnel 可以复用页面到 Worker 的通信机制，但不会自动成为云端持久化协议。SessionPersistence provider 也不会自行定义网络认证、幂等请求或分布式写权。

Cloud Session 应复用当前 Session event log 与 surface/projection 语义——`turn/start`、`step/start`、`assistant/message`、`tool/call` 与 `tool/result` 的 `callId` 关联、`assistant/attempt`、surface replacement 与恢复语义——而不是为云端另定义一组平行事件。外部 wire protocol 可以采用不同 carrier 与路由，但必须保留事件顺序、序号连续、source attribution 与重连 baseline 语义。

Browser 与 Cloud 执行都必须保持 model-visible ⟺ logged 不变量：进入模型请求的输入，以及模型后续可见的 Assistant 与工具结果，必须能够从 Session event log 重建。瞬时 token delta 可以在 attempt settlement 前保持非持久状态，但已结算的 request context、Assistant message、tool call/result 与 source attribution 不能只存在于 UI delta、Client model 或 Worker 内存中。

### 将 OPFS 作为副本，而不是隐藏的第二事实源

建议显式区分已同步数据、待同步修改和可重建缓存。云端确认状态与本地工作状态可以暂时不同，但必须能够判断差异、恢复同步并处理冲突。

离线写入若进入产品范围，应单独定义离线期间允许的动作。需要云端模型或工具的 Agent 回合不能因为存在 OPFS 就被称为“完整离线执行”。

### WASM 用于工具能力，不用于强制重写 Agent core

当前 Worker runtime 已说明 JavaScript/TypeScript Host 可以借助模块转换与兼容层进入浏览器。因此，没有必要把“将整个 DSH 编译成 WASM”作为基础路线。

WASM 更适合补充搜索、解析、压缩、语言工具等能力。它仍需要文件、网络、资源限制和取消接口；WASM 内存隔离不能代替完整的能力授权设计。

### 首期 Native Bridge 保持单一、受限能力

建议先实现授权目录内的文件访问，验证配对、路径限制、版本守卫、断线回执和撤销，再增加进程执行。

Shell、Docker 和本机浏览器控制具有更大的副作用范围，不宜与最小 Bridge 原型同时开放。Bridge 也不应默认支持任意 RPC 方法或任意命令字符串。

### 不把 Durable 执行绑定为所有功能的前置条件

浏览器交互闭环、持久化和云端 Workspace 可以先形成有明确限制的产品。Durable worker 在任务连续性成为产品承诺时加入。

但 Session 数据模型、工具调用标识和 owner 设计应预留接管语义，避免后续只能通过复制日志或强制解锁实现迁移。

## 建议实施路线

路线图按可观察结果组织，不以“模块装载成功”代替用户行为验收。各阶段可以部分并行，但前一阶段暴露的执行正确性问题不应被更大的云端建设掩盖。

| 阶段 | 交付范围 | 验收条件 |
|---|---|---|
| 1. 浏览器确定性执行闭环 | 在现有 Worker runtime 中接入 scripted 模型适配器与测试工具，并产出可达依赖闭包报告 | 无配套 Node Host 与网络模型；适配器至少执行两次模型调用，完成 prompt → 流式 tool call → 实际工具执行 → tool result → 第二次模型请求 → final response；覆盖模型流取消、工具 dispatch 前与执行中取消、并行工具结果仍按模型顺序提交、异常、并发发起者归属，以及同一 Worker 生命周期内 Session event readback |
| 2. 真实模型接入 | 同域认证代理与目标 provider 适配 | 在真实浏览器中验证增量输出、工具参数、错误、取消和用量；分别确认浏览器停止消费、代理传播取消与上游连接终止，不以传播成功承诺上游生成或计费立即停止；平台 key 不进入浏览器 |
| 3. 浏览器持久化 | OPFS-backed sink、恢复和状态提示 | 刷新后恢复；写入失败可观察；内存、本地持久化和云端确认不混淆 |
| 4. Cloud Session | 远端存储、查询与 owner 协议 | 双写者冲突被拒；旧代际不能继续 append；断线后的结果可查询或明确未知 |
| 5. Cloud Workspace | Workspace 身份、文件版本、内容服务和授权 view | 两客户端基于版本提交；冲突明确；跨租户访问被拒；大目录按需取数 |
| 6. 浏览器工具补齐 | 搜索、diff 及必要的 JS/WASM 工具 | 不再依赖不可执行的 ripgrep 路径；具有时间、内存和结果大小限制 |
| 7. 最小 Native Bridge | 配对、授权目录访问与执行回执 | 未授权、过期、重放和越界调用在本机端被拒；断线不盲目重试修改 |
| 8. Durable 执行 | 云端 worker、接管、崩溃恢复与 supervisor | 有序 handoff 在声明的安全点继续；异常退出从最近云端确认状态恢复并关闭被中断的 turn；旧 owner 被隔离；未完成副作用可对账或明确未知 |
| 9. 扩展能力 | 进程执行、Git、容器、离线合并、多 Worker Agent | 每项独立定义能力、资源上限、失败行为和验收 |

阶段 1 的目标是证明 Agent core 的真实执行，而不是只展示历史：第二次模型请求必须实际包含第一次的工具结果，最终响应来自第二次模型调用。阶段 2 再验证真实 provider，避免把浏览器运行时问题与模型网络问题混在一起。

Cloud Session 和 Cloud Workspace 可以并行设计，但应共享身份和授权原则，而不是共享一个职责不明的“大状态服务”。

阶段 8 不承诺迁移 in-flight 状态：运行中的模型流、工具 Promise、审批等待和本机进程都不会随 Session 日志迁移。“页面关闭后继续”只指页面完成有序 handoff，或云端从最近一次安全点重新调度。

Native Bridge 不是浏览器原生 runtime 的前置条件。首个可用版本应能够在没有本机安装的情况下完成云端工作区中的基础任务。

## 风险与未验证项

各能力的证据边界保留在其所属小节；这里只列跨领域且尚未选型的事项：

- OPFS、Worker 生命周期、存储配额、共享缓冲区和本机连接方式的浏览器兼容性尚未形成产品支持矩阵。
- 多租户隔离模型、对象存储、区域一致性、数据保留、加密、配额与成本尚未选型。
- 运行时第三方代码的分发、签名、lowering 与执行隔离没有方案；首期镜像打包只是受限形态。
- Session 与 Workspace 双服务提交的对账协议（operation id、receipt、恢复查询）需要随 Cloud 服务一并设计。
- runtime、packer、模块转换协议与镜像需要配套的兼容性检查和升级策略；不能默认任意版本互换。
- 浏览器产品化指标尚未测量：初始镜像下载大小、cold boot 与 hydration 时间、首次 Agent 响应延迟、Worker 内存高水位、长 Session 投影内存、OPFS 写入与恢复耗时、command Worker 启动开销，以及浏览器支持矩阵与 cross-origin isolation 依赖。产品化决策应以目标浏览器实测为准，并记录测试镜像、Session 与 Workspace 规模及设备等级，不预先承诺数字。

## 结论

该架构值得继续推进，理由不是“浏览器已经足够强大”，而是 DSH 已经具备两项直接相关的代码基础：**Worker 内的 Host 装载实现，以及通过现有服务接口提供远程能力的 provider 模式。**是否继续投入，建议由三项递进的验收条件决定：

1. **浏览器 live Agent loop 验收。** Worker 中完成 prompt → scripted model 流式 → tool call → tool result → 第二次模型请求 → final response，覆盖取消、`turn`/`step` 边界事件与并发发起者归属，并在同一 Worker 生命周期内可从 Session event 重建模型可见内容。该验收未通过前，不以 Cloud Session、Cloud Workspace 或 UI 建设替代执行闭环验证；Cloud 服务的接口、身份和授权设计可以并行。
2. **持久化与失败状态验收。** 内存成功、本地持久化、云端提交三种状态可区分；checkpoint 失败 fail closed；OPFS 与云端失败在 UI 与恢复流程中可见；副作用结果未知时不自动重试。
3. **云端授权与执行所有权验收。** principal 到 Session/Workspace/Blob/租约的重新授权、旧 owner fencing、双写者拒绝、Browser/Cloud 安全点 handoff 与跨租户拒绝都有验收；不互信执行具备进程级以上隔离。

最终目标不是把 Node 应用的所有能力复制到浏览器，而是让同一套 Agent 与工具服务接口在不同执行位置获得明确、可验证的能力，并使状态提交、权限和故障恢复具有一致语义。

## Further Exploration

- [WebWorker runtime](../../packages/experimental/webworker-runtime/README.md) — Worker Host、Node 兼容层和已知限制。
- [WebWorker packer](../../packages/experimental/webworker-packer/README.md) — VFS 镜像与模块转换。
- [Preview 验收代码](../../apps/web/tests/preview-boot.e2e.ts) — 当前浏览器测试覆盖范围。
- [Web Client architecture](../subsystems/web-client.md) — Host、Remote、Client model 与 UI 的责任划分。
- [SSH provider family](../../packages/ssh/README.md) — 远程文件、进程与 sandbox provider。
- [fs-ssh](../../packages/ssh/fs-ssh/README.md) — 版本守卫、原子修改和结果不明时的失败语义。
- [JSONL Session persistence](../../packages/session/session-persistence-jsonl/README.md) — 单写者与持久化机制。
- [Session checkpoint policy](../../packages/session/session-checkpoint-policy/README.md) — 模型请求、顶层工具与步边界的 durability barrier。
- [Workspace registry](../../packages/workspace/workspace/README.md) — 现有目录 registry 与 Session membership。
- [Workspace files service](../../packages/api/workspace-files/README.md) — Web Client 只读文件预览与观察。
- [Headless runner](../../packages/bundle/headless/README.md) — Session adoption 与执行生命周期。
- [DSH Architecture](../architecture.md) — 插件组合、核心服务和扩展点。

-----

## Dev Note

本文是架构评估与建议稿，不代表目标架构已经立项或完成实现。若采用其中建议，应分别为 Browser runtime 产品化、Cloud Session 所有权、Cloud Workspace 数据模型和 Native Bridge 信任模型建立正式决策记录；已实现行为、配置和限制由对应 package README 与测试维护。
