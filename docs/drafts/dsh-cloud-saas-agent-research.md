---
description: "系统评估以 DSH 作为云端 SaaS Agent 执行内核的可行性：给出 Control Plane、租户 Worker、Session ownership、Workspace 与 External Executor 的分层设计，以及缩零、失败恢复、资源配额、实施阶段和验收标准。"
---

# 基于 DSH 实现云端 SaaS Agent：系统化深度报告

## Summary

本文研究的对象是通过 Web UI 使用、在云端运行、按租户隔离数据的 Agent 服务，其隔离手段不是每个任务一台虚拟机，而是进程、文件系统根目录和操作系统 sandbox。核心结论是：DSH 适合作为这类系统的 Agent Execution Plane，负责 Agent Loop、工具管线、Session 事件日志、模型适配器、Agent Preset 和 Host/Client 连接；SaaS 平台必须自己提供身份认证、租户授权、Worker 调度、Session 所有权、Workspace 服务、配额、计费和外部执行隔离。DSH 不是开箱即用的多租户平台，其 Dynamic Cordis 扩展也不是不可信代码的安全边界。

推荐的默认部署是“一个租户一个 DSH Worker 进程，进程内承载该租户的多个 Session”，高风险工具交给独立 External Executor。这个模型提供租户级的路由、故障和资源管理单元，不自动构成互不信任租户的安全边界，也不提供 Session 级操作系统隔离。若多个 Worker 只是同一 OS 用户下的普通 Node 进程，文件、网络、凭据和 native 权限仍可能共享。是否需要“一个租户多个 Worker”由资源瓶颈、故障域和信任级别决定，而不是由 Session 数量决定。第一阶段不应按 Session 拆进程；当同一租户出现不同信任级别、长任务与交互任务互相影响、或单进程达到内存与事件循环上限时，再引入同租户多 Worker，并用 lease、generation 和 fencing token 约束 Session 所有权。

不活跃租户和没有运行中任务的 Worker 可以缩零，前提是 Session 与 Workspace 的权威状态已经外部持久化、Worker 已到达安全停止点或明确进入崩溃恢复流程、未确认的外部副作用被记录为未知结果、并且新 Worker 能从外部存储恢复 Session。浏览器断线、Agent 仍在运行、Worker 仍存活、Session 已持久化是四个互相独立的状态；WebSocket 连接不能作为 Session 生命周期的判据。

本文与同目录的 [部署、租户隔离与请求执行参考](dsh-deployment-and-tenancy-deep-dive.md) 和 [Remote Durable Workspace 研究](dsh-remote-durable-workspace-pgfs-research.md) 分工如下：本文负责云端 SaaS Agent 的整体分层、Worker 进程模型、缩零与恢复的工程路线；前者拥有 DSH 当前部署与租户边界的运行时事实；后者拥有远程持久化工作区的存储实现选型。本文不重复它们的事实，只在需要处引用。

## Table of Contents

- [目标与证据边界](#目标与证据边界)
- [DSH 在系统中的定位](#dsh-在系统中的定位)
- [DSH 的适用优势](#dsh-的适用优势)
- [DSH 的主要限制](#dsh-的主要限制)
- [推荐的整体架构](#推荐的整体架构)
- [租户与 Worker 进程模型](#租户与-worker-进程模型)
- [Worker 缩零](#worker-缩零)
- [Session ownership 与 fencing](#session-ownership-与-fencing)
- [Workspace 设计](#workspace-设计)
- [工具与 sandbox 分层](#工具与-sandbox-分层)
- [Web UI 与云端连接](#web-ui-与云端连接)
- [资源配额](#资源配额)
- [失败恢复](#失败恢复)
- [观测与运营](#观测与运营)
- [部署方案比较](#部署方案比较)
- [实施阶段](#实施阶段)
- [MVP 验收标准](#mvp-验收标准)
- [结论](#结论)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

## 目标与证据边界

目标系统需要同时解决四个问题：Agent 如何运行；Session 与 Workspace 如何持久化；租户之间如何隔离；Worker 如何启动、迁移、恢复和缩零。DSH 主要覆盖第一个问题，并为第二个问题提供事件日志基础；第三和第四个问题需要平台侧和执行环境补齐。

本文依据当前 checkout 的架构文档、package README 和已有实现核对能力与限制，未执行端到端部署、未运行多租户压测、未验证 scale-to-zero 或跨进程 Session 接管。文中出现的进程数、配额、时限和阶段划分是设计建议，不是 DSH 当前的产品承诺。涉及平台侧的新组件（Gateway、Worker Manager、External Executor、Cloud Workspace）时，本文只定义职责与交互，它们都不存在于当前仓库。

隔离强度的判断依赖威胁模型。本文在[工具与 sandbox 分层](#工具与-sandbox-分层)中给出“只隔离文件系统”可接受的条件；不满足这些条件时，进程加文件根目录不足以构成租户安全边界。

## DSH 在系统中的定位

DSH 可以承担的部分：

```text
Agent Loop
Prompt 与 context 组装
LLM provider
Tool registry 与工具生命周期
工具审批
Agent Preset
Session event log 与投影
Subagent
流式输出
Host 与 Client 状态同步
```

DSH 不应独自承担的部分：

```text
用户身份认证
租户授权与计费
Worker 调度与路由
跨节点 Session ownership
云端 Workspace ACL
Blob 生命周期
网络出口策略
密钥管理
高风险代码执行
跨租户安全隔离
```

因此职责边界应当划为三层：SaaS Control Plane 负责身份、租户、配额、路由、调度、审计与计费；DSH Execution Plane 负责 Agent Loop、工具、Session、模型、Preset 与流式输出；External Executor 负责 Shell、任意代码、浏览器自动化、native binary 与高风险副作用。Control Plane 通过服务接口驱动 DSH Worker，而不是重新实现一个 Agent Loop。

## DSH 的适用优势

### Agent Loop 与能力实现解耦

Agent Loop 通过 `ctx.llm`、`ctx.sessions`、`ctx.tools`、`ctx.fs`、`ctx.sandbox`、`ctx.subprocess`、`ctx.agents` 等服务工作，不直接绑定本地目录、数据库或某个模型实现。云端可以把这些能力逐个替换为云端实现：`ctx.llm` 指向模型代理，`ctx.sessions` 指向云端 Session store，`ctx.fs` 指向云端 Workspace provider，`ctx.subprocess` 指向 External Executor 客户端。但替换 `ctx.fs` 只影响使用该服务的 DSH consumer，不会自动改变普通子进程看到的文件系统。只有所有文件消费者和执行进程都位于同一个远程 namespace，或由显式、可审计的同步协议连接起来，才能宣称现有 Agent 无需修改。能力接缝的全景见 [capability-seams](../capability-seams.md) 与 [architecture](../architecture.md)。

### DSH 文件能力与统一执行世界

当前 DSH 的文件服务与执行路径不是同一个抽象，云端接入必须逐项处理：

| Consumer | 当前 DSH 路径 | 对 Cloud Workspace 的要求 |
|---|---|---|
| 模型文件工具 | `ctx.fs`，提供 resolve、stat、读取、目录列举、文本写入和编辑 | 可由远程 provider 接入，但当前 contract 没有 delete、rename、copy、watch 和 binary-safe mutation |
| `glob` 与 `grep` | `ctx.subprocess.spawn()` 启动随包提供的 ripgrep | ripgrep 必须在与 Workspace 相同的执行世界中运行，且 search workdir 必须与 `ctx.fs` 的读取根一致 |
| Shell、PTY、LSP、编译器和包管理器 | subprocess 或其他 executor 直接使用执行环境的文件系统 | 必须共享 Canonical Workspace，或使用带 revision、operation id 和 receipt 的显式投影协议 |
| Skills 与资源加载 | 部分实现直接读取宿主文件系统 | 必须逐个审计并迁移到远程 provider，不能假设替换 `ctx.fs` 已覆盖 |
| Session persistence | `ctx.sessionPersistence` | 与 Workspace 是独立的 durability domain，需要在恢复协议中配对 |

因此，第一阶段应明确选择一个完整执行世界：Node-level mount 让 Agent、ripgrep、Shell、LSP 和编译器共同使用 `/workspace`；或者由 Remote Executor 在远端启动全部进程，并让 DSH Worker 只通过显式 API 驱动它们。单独新增远程 `ctx.fs` provider 只能覆盖 DSH 文件工具，不能覆盖普通进程。

### Agent Preset 适合产品能力分级

不同 SaaS 档位可以表达为不同的 Agent Preset：只读检索、编码、研究、自动化、企业私有工具。这比为每个档位复制 Agent Loop 更可维护。需要区分两个轴：Profile 决定部署哪个应用组合，Agent Preset 决定某个 Agent 拥有哪些工具与 Prompt（见 [agent-preset](../../packages/preset/agent-preset/README.md)）。产品档位通常落在 Preset 上，部署形态（是否有浏览器客户端、是否走 JSON-RPC）落在 Profile 上。

### Session event log 适合审计与恢复

Session 是类型化的 append-only 事件日志，模型可见历史主要来自 `system/message`、`user/message`、`assistant/message`、`tool/result` 四类 surface 事件，而 `turn/*`、`step/*`、`request/header`、`request/context`、`assistant/attempt`、`tool/call` 记录执行事实但不直接进入模型输入。当前语义见 [session 子系统](../subsystems/session.md)、[persistence-catalog](../persistence-catalog.md) 与 [session README](../../packages/core/session/README.md)。这套结构对 SaaS 的价值在于：断线重连有事件序号可依，模型实际看到的内容可查，一次执行可审计，平台可以据此恢复 Session 并对中断的 Turn 补齐关闭记录。

边界必须同时说清：Session 能重建模型历史和部分执行事实，不能重放整个外部世界。它不恢复文件系统真实状态、已发送的 HTTP 请求、外部 API 副作用、已启动的进程、审批系统中的状态和工具的 execution-local value。`model-visible ⟺ logged` 只有单向成立：进入模型请求的内容必须可从日志重建，反向不成立。

### Host 与 Client 分离适合 Web 形态

DSH 已区分 Host（权威状态、Agent、Session、工具、持久化）、Remote 与 Gateway、Client model、UI slots 四层，适合构建“浏览器 Client 加云端 Host”。但当前 Web surface 的 launch token 与 cookie 属于进程访问控制，不等于租户身份与授权（见 [connection](../../packages/client/connection/README.md) 与 [webserver](../../packages/host/webserver/README.md)）。SaaS 仍需自行实现用户身份、租户解析、Session 与 Workspace 授权、Worker 路由、限流、计费、审计、重连和事件游标。分层细节见 [api-gateway](../api-gateway.md) 与 [web-client](../subsystems/web-client.md)。

## DSH 的主要限制

### 不是现成的多租户安全边界

Cordis scope、Agent Preset realm、Session id 和 Workspace root 可以组织服务与资源可见性，但不能隔离 Node heap、module cache、环境变量、native process、OS 权限、网络出口、共享凭据和 Host-level registry。因此“一个 Node 进程内用 scope 区分多个不互信租户”不构成安全多租户；“一个租户一个普通 Node 进程”也主要是路由、故障和资源边界。互不信任租户的安全边界仍需要容器、microVM、独立 OS 身份、远程执行器或等价的文件、网络、凭据和资源策略。普通进程模型只适用于租户互信、插件代码由平台控制、不允许任意用户代码、且主要目标是防止配置与状态串扰的场景。

### 隔离文件系统不等于完整沙箱

每个租户一个 workspace root 仍然留下这些问题：Shell 能否访问 root 之外的路径；工具能否读到其他租户的密钥；网络能否访问任意内网地址；子进程是否继承宿主机权限；临时文件是否对其他任务可见；能否创建无限进程或耗尽内存；能否访问 Unix socket；浏览器自动化能否触达控制面。路径隔离只解决一部分文件访问问题。

### Dynamic Cordis 不应面向不可信租户

Dynamic Cordis Package 可以在运行时定义并运行 Host 与 Browser 扩展，但当前实现是进程内存、Session 拥有、重启即消失，Host half 运行在 `node:vm` 中，同步 timeout 不约束异步工作，并且明确不是安全边界（见 [cordis-host-runner](../../packages/extensions/cordis-host-runner/README.md)）。首期不应允许用户提交任意 JavaScript、npm 插件或 native addon 到共享 Worker。可开放的是平台审核的插件、签名的 WASM、声明式工具定义、受限 HTTP connector 和平台维护的 Preset。

## 推荐的整体架构

```text
                         ┌──────────────────────┐
                         │      Browser UI      │
                         │ Session / Workspace  │
                         └──────────┬───────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────┐
                    │ SaaS API Gateway / Control   │
                    │ Auth / ACL / Quota / Routing │
                    └───────┬──────────┬───────────┘
                            │          │
                            ▼          ▼
                   ┌────────────┐  ┌──────────────┐
                   │ Session    │  │ Workspace    │
                   │ Store      │  │ Service      │
                   └────────────┘  └──────────────┘
                            │          │
                            └────┬─────┘
                                 ▼
                    ┌──────────────────────────────┐
                    │ Tenant Worker Manager        │
                    │ lease / generation / routing │
                    └──────────────┬───────────────┘
                                   │
                 ┌─────────────────┼─────────────────┐
                 ▼                 ▼                 ▼
        ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
        │Tenant Worker A │ │Tenant Worker B │ │Tenant Worker C │
        │DSH Host        │ │DSH Host        │ │DSH Host        │
        │Sessions A1,A2  │ │Sessions B1,B2  │ │batch sessions  │
        └───────┬────────┘ └───────┬────────┘ └───────┬────────┘
                │                  │                  │
                └──────────────────┼──────────────────┘
                                   ▼
                    ┌──────────────────────────────┐
                    │ External Executor            │
                    │ Shell / Code / Browser / OS  │
                    │ sandbox / network policy     │
                    └──────────────────────────────┘
```

Control Plane 负责认证、租户解析、Session 与 Workspace 授权、Worker 分配、lease、资源配额、模型与工具策略、密钥管理、审计、计费、调度、Webhook 以及向 External Executor 提交任务。它不复制 Agent Loop。

DSH Worker 负责启动 Cordis composition、加载 Agent Loop、打开 Session、处理 Turn、调用模型、运行受信任工具、发送流式事件、写入 Session event、维护 Session 内 Agent 状态，并向 External Executor 提交高风险任务。Worker 不直接暴露到公网，所有浏览器请求先经 Gateway。

External Executor 负责 Shell、Python、用户代码、浏览器自动化、native binary、LSP、高权限文件操作、长时进程和受限网络任务，向 Worker 返回 execution id、接受与启动状态、输出分片、退出状态、产物、资源用量以及未知或中断状态。这样 Agent Loop 与高风险执行环境解耦，Executor 可以用独立进程、独立 Unix user、独立 workspace root、cgroup 限额、文件访问限制、平台 sandbox、网络出口策略和临时凭据实现，而不必是虚拟机。

执行世界规则必须先于适配器实现确定：Agent 的模型文件工具、搜索、Shell、LSP、编译器和包管理器要么直接访问同一个 Canonical Workspace，要么只能访问一个带版本和 receipt 的明确投影。Worker Scratch 只能保存缓存和可丢弃状态，不能成为第二个权威文件树；Artifacts 是单独的命名空间，必须有独立 ACL、保留和下载策略。

## 租户与 Worker 进程模型

### 第一阶段：一租户一 Worker，多 Session

```text
Tenant A
  └── Worker A
      ├── Session A1
      ├── Session A2
      └── Session A3

Tenant B
  └── Worker B
      ├── Session B1
      └── Session B2
```

优点是租户间有独立的 Worker 路由、故障和资源管理单元；Worker 内多个 Session 共享模型 provider 与基础设施；连接路由与 Session affinity 简单；可以按租户统计内存、CPU、并发与费用；故障影响范围限制在一个租户内；不需要一开始就实现同租户多 Worker 的 ownership。这个模型本身不是互不信任租户的安全隔离；若租户可以提交任意代码或访问敏感凭据，Worker 必须运行在容器、microVM 或等价执行边界内。适合平台控制工具、中等并发、同租户用户互信、不运行任意用户代码、高风险执行已外部化的场景。

### 多 Session 不等于需要多进程

如果多个 Session 主要是在等待模型响应、做轻量工具调用、共用可信 provider，一个 Worker 通常够用。拆分应由指标决定：Worker RSS、event-loop lag、GC 时间、活跃 Turn 数、工具队列等待时间、单租户模型并发、Session 排队延迟、Worker 崩溃频率、单 Session 资源消耗，以及长任务对交互任务的影响。不要因为“一个租户有多个 Session”就自动拆进程。

### 一个租户需要多 Worker 的情况

不同信任级别：只读查询、文件编辑、Shell、用户代码不应全部进入同一个 Host 进程。不同故障域：可能导致内存泄漏、事件循环阻塞、未捕获异常、插件状态损坏或 native addon 崩溃的 Session 应与其他关键 Session 分离。交互与批处理：拆成交互 Worker、批处理 Worker 和定时任务 Worker，避免长任务占用交互请求的进程资源。不同资源特征：代码索引、LSP、浏览器自动化、文档解析的 CPU 与内存曲线差异大，适合分池。独立发布：企业租户需要专用 provider、私有 connector、特定工具版本、独立网络出口或大型 LSP 时，独立 Worker 可以单独升级与重启。

## Worker 缩零

推荐把 Worker 设计成可回收的执行缓存：Worker 内存是可丢弃的上下文与缓存，外部存储是 Session、Workspace、Job 和授权的权威状态。如果 Session 与 Workspace 仍只存在 Worker 内存，缩零就不是释放缓存，而是丢失业务状态。

建议的生命周期状态：

```text
STARTING
  → READY
  → ACTIVE
  → IDLE
  → DRAINING
  → STOPPED
  → RECOVERING
  → QUARANTINED
```

STARTING 创建进程、加载 Profile、初始化 provider、建立 Control Plane 连接并注册 generation。READY 表示没有运行中任务且可接受请求。ACTIVE 表示存在模型请求、工具调用、待处理 inbox、审批或等待中的 Executor 任务。IDLE 表示没有活跃 Turn 与待处理任务，可以进入 drain。DRAINING 停止接受新任务、等待安全点、flush Session、保存 pending state、释放 owner lease、关闭连接与资源。STOPPED 表示进程已退出且状态在外部存储。RECOVERING 表示旧 Worker 崩溃后新 Worker 取得所有权、恢复 Session、补中断记录并处理未知结果。QUARANTINED 表示 Worker 违反资源限制、出现异常行为或跨租户访问尝试，需要诊断。

缩零的必要条件：

```text
没有运行中的模型请求
没有正在执行的工具
没有等待中的审批
没有未释放的 subprocess 或 PTY
没有必须由当前进程继续持有的 Executor 任务
Session 已完成必要的 flush
pending work 已写入外部队列
owner lease 已释放
```

列表中的“等待中的审批”不能只检查 Session event。`userQuestions.ask()` 和审批请求的等待 Promise 绑定当前进程；只有 pending interaction、调用者归属和答案已经转移到外部持久服务，Worker 才能安全终止。平台还必须确认没有需要当前进程继续持有的 PTY、subprocess 或 Executor 任务，并在终止前关闭或 fencing Session writer。停止流程是：拒绝新任务、停止调度、等待安全点、flush Session、持久化 pending inbox 与 job 状态、释放 owner lease、关闭流、终止进程。

不能把 `kill` 当作普通缩零。模型流、Shell、外部 API、文件写入、浏览器自动化和审批都无法在进程被杀后继续。恢复时不能假设原来的 Promise 会在新进程继续、模型流会从原位置接续、工具调用可以安全重试、或文件写入没有发生。正确做法是标记旧 Worker 失效、由新 Worker 取得新 generation、恢复最后一个安全 Session 状态、把未确认的工具结果标为未知，再由策略决定查询、人工确认或重新执行。当前 DSH 没有内置这套跨进程接管流程，它属于平台侧需要实现的部分。

## Session ownership 与 fencing

一个 Session 在同一时间只能有一个 active owner。即使未来一个租户有多个 Worker，也不应让两个 Worker 同时写入同一个 Session：

```text
错误：
Worker 1 ─┐
          ├── Session A
Worker 2 ─┘

正确：
Worker 1 ─── owns Session A
Worker 2 ─── owns Session B
```

迁移必须经过 drain：

```text
Worker 1
  drain Session A
  → flush
  → release lease
  → generation + 1

Worker 2
  acquire Session A
  → restore
  → continue from safe point
```

只使用分布式锁不够：旧 Worker 可能在网络分区后仍认为自己拥有 Session。owner 记录至少包含 `session_id`、`tenant_id`、`worker_id`、`generation` 和 `lease_expiry`；每次 append 或修改都带 generation，持久层检查请求 generation 是否等于当前 owner generation，过期则拒绝写入。这能阻止旧进程恢复网络后继续写入。当前 [session-persistence](../../packages/session/session-persistence/README.md) 的抽象 contract 只保证每个 backend instance 内单写者；随包 JSONL backend 另外使用 POSIX `flock(2)` 或 Windows named semaphore 排除共享根目录下的其他进程，进程崩溃会释放锁，但存活而卡住的进程会无限持有锁，且 NFSv3 上 advisory locking 不可靠。云端 backend 仍需要显式 lease、续期、generation 和 fencing，不能把 JSONL 的物理锁当成跨节点协议。

云端 persistence 还需要在现有 `append`、`read`、`flush`、`resume` 之外补充 owner 获取、lease 续期、fencing、append 授权、租户授权、stream cursor 和 reconnect baseline。三个状态必须分开：`append accepted` 表示 Session store 接受事件，`flush durable` 表示事件达到声明的持久化边界，`external side effect confirmed` 表示文件、HTTP、进程或第三方系统的效果已经确认。把三者合并成单一的“成功”会导致崩溃恢复后对副作用状态判断错误。

## Workspace 设计

云端 Workspace 至少需要 tenant id、workspace id、revision、文件与 blob、metadata、ACL、mount policy、mutation receipt 和 retention policy。建议分为四类：Canonical Workspace 保存唯一的云端权威内容与版本；Worker Scratch 是当前 Worker 的临时缓存和可丢弃状态；Executor Workspace 要么是 Canonical Workspace 的挂载，要么是带 source revision、target revision 和 receipt 的明确版本投影；Artifacts 保存工具输出、构建产物、日志与附件，并属于独立命名空间。禁止没有 operation id、源版本、目标版本和 receipt 的静默双向同步。

Agent 看到的文件、Shell 实际操作的文件、sandbox 限制的文件必须属于同一个执行世界，或者存在明确的同步协议。`ctx.fs` 读云端 Workspace、Shell 写宿主机目录、sandbox 限制第三个路径空间这种组合即使偶尔能跑通，也会让恢复和安全审计无法进行。远程持久化工作区的存储选型、POSIX 兼容边界和挂载方式由 [Remote Durable Workspace 研究](dsh-remote-durable-workspace-pgfs-research.md) 拥有；本文只固定它对上层的要求。

文件修改应记录 expected revision、变更内容、operation id、结果 revision 和 receipt，用于处理并发 Session、Worker 重试、浏览器重连、工具重复提交、Worker 崩溃、文件冲突和审计，而不是依赖当前进程的本地目录状态。

路径布局可以按 `/tenant/<tenant-id>/workspace/<workspace-id>` 组织，但路径拼接本身不是安全机制。还需要 canonical path 校验、symlink 策略、mount 约束、临时目录隔离、artifact ACL、保留策略、对象存储 ACL，以及 External Executor 侧的 tenant 与 workspace 二次校验。

### Workspace writer 与并发层级

Session owner 不等于 Workspace writer。建议把并发控制拆成以下层级：

| 层级 | 作用 | 建议语义 |
|---|---|---|
| Session lease | 防止两个 Worker 同时推进同一个 Agent Loop | 单 writer，使用 generation 与 fencing |
| Workspace mount lease | 管理 attach、detach、freeze 和删除 | 可配置 shared 或 exclusive，不替代文件并发控制 |
| Operation id | 识别一次 mutation 和重试 | 同一 operation id 重试必须返回同一结果或明确的冲突 |
| Inode/file revision | 处理同一文件的并发修改 | 使用 one-wins 的 CAS，旧 revision 返回 typed conflict |
| Workspace generation | 使目录缓存、fork 和 rollback 失效 | 单调递增，提交、恢复和 rollback 都产生新 generation |
| File lock | 兼容 Git、编辑器和显式锁 | 由 Storage Service 持有，可跨 gateway，崩溃后按 lease 释放 |
| Transaction | 组合多个 namespace 或 content 修改 | 明确 commit/abort；不能把一组独立 RPC 假装成原子事务 |

多个 Session 可以合法地同时修改同一个 Workspace，但这不意味着它们可以无冲突地修改同一个文件。Workspace delete、rollback、fork、mount handoff 和 file lock 都必须检查 active mount、open handle、generation 与新写入；Session handoff 只转移 Agent Loop 所有权，不会自动转移 Workspace 的所有写者。

### V1 文件操作语义

V1 必须冻结可观察语义，而不能只列出 syscall 名称。建议采用以下最小集合；不支持的操作必须返回稳定的 `ENOTSUP` 等 typed error，不得静默落到本地临时目录。

| 操作 | V1 语义 |
|---|---|
| `open` | 支持 `O_RDONLY`、`O_WRONLY`、`O_RDWR`、`O_CREAT`、`O_EXCL`、`O_TRUNC`、`O_APPEND`；句柄绑定稳定 inode identity，未声明的 flag 在产生副作用前拒绝 |
| `read`/`write` | 句柄保留 inode 引用；普通写支持显式 offset，`O_APPEND` 在 Storage Service 的 mutation lock 内选择 EOF；返回值表示已接受的字节数，重试使用 operation id |
| `unlink` | 删除目录项，不立即删除仍被 open handle 引用的 inode；open handle 继续按 inode 读写，最后一个引用释放后才进入版本保留和 GC |
| `rename` | 同一 Workspace 内原子改变目录项；覆盖目标时遵守文件与目录类型规则；禁止移动目录到自己的后代；跨 Workspace rename 必须显式使用 copy/import |
| `mkdir`/`rmdir` | `mkdir` 对同一父目录和名称原子生效；`rmdir` 只允许空目录，并在同一事务中检查并发子项创建 |
| `fsync`/`close` | `fsync(file)` 等待内容、inode 和目录项达到声明的 durability receipt；`fsync(directory)` 等待 namespace 修改；`close` 释放句柄但不单独承诺 durable，调用方需要 `fsync` 才能获得该承诺 |
| `readdir` | 使用带目录 generation 的分页 cursor；并发 rename/delete 使 cursor 失效并返回 stale cursor，调用方重新列举，不承诺跨 mutation 的无重复快照 |
| symlink | 只允许解析后仍位于同一 Workspace 的相对链接；`lstat` 不跟随，`resolve` 最多跟随 40 次；绝对链接、越界链接和循环分别返回 containment 或 `ELOOP` 错误 |
| `flock`/`fcntl` | 若 V1 提供锁，锁必须由 Storage Service 持有并带 lease、owner generation 和崩溃释放语义；否则显式返回 `ENOTSUP`，不能只在单个 FUSE client 内加锁 |
| 错误映射 | Storage Service 维护稳定错误码到 POSIX `errno` 与 DSH typed error 的映射；调用方不得依赖错误文本判断 `not found`、`stale revision`、`permission denied` 或 `unknown outcome` |

上述语义还需要负面测试：`rename-over-existing`、`unlink-open-file`、`write + fsync + crash`、`mkdir/rmdir` race、目录列举期间的 rename、symlink loop、越界 symlink、旧 cursor、旧 generation 和锁持有者崩溃。

### Workspace durability

Workspace 的“可见”与“可恢复”必须分开定义。建议使用以下状态：

```text
buffered
  → prepared
  → content-verified
  → namespace-committed
  → durable-acknowledged
  → reconciled
```

`buffered` 只存在于 client 或 Worker 内存；`prepared` 表示服务端已经记录可重试的 operation id 和临时内容；`content-verified` 表示所有 chunk 或对象已经校验；`namespace-committed` 表示 metadata、content reference 和目录项已在主数据库事务中提交并对 primary 可见；`durable-acknowledged` 表示数据库 WAL、对象存储和复制策略达到该部署声明的 receipt；`reconciled` 表示故障恢复后 metadata、content 和 Session checkpoint 已重新关联。PostgreSQL-only backend 可以在同步提交策略满足要求时合并最后两个阶段，但不能默认把 transaction commit 当成跨故障域的业务恢复保证。

`fsync` 成功必须返回可记录的 Workspace receipt。client 在 commit 后超时必须用相同 operation id 查询结果，而不是盲目重复写入；对象已上传但 metadata 未提交的记录进入 orphan GC；metadata 已提交但对象不可读的情况进入 quarantine/reconciliation，不能对 Agent 返回一个看似成功的文件。部署还要声明 `RPO` 与 `RTO`：前者由 primary、WAL、备份和对象复制策略共同决定，后者由 remount、owner recovery 和 reconciliation 流程决定。

对象生命周期应独立于目录项删除：`uploading → verified → referenced → retained → unreachable → grace-period → deleted`。内容 hash 可以同时承担完整性校验和寻址，但 dedup 范围必须明确为 tenant 内或显式共享范围，并在命中已有 hash 时复核对象大小与内容，不能把 hash 当作无条件的身份断言。对象和 chunk 应采用 envelope encryption；租户删除、用户删除、snapshot/fork 引用、备份保留和 legal hold 必须在 GC 前统一判定。上传中断、对象已上传但 metadata 未提交、metadata 已删除但 snapshot 仍引用等状态都必须进入可重试的 reconciliation 或延迟 GC 队列。

### Workspace 生命周期

Workspace 的控制面状态应与文件内容状态分开。建议使用 `created → available → attached → read-only → draining → detached → soft-deleted → purged` 状态；`attached` 允许一个或多个已授权 mount，`read-only` 拒绝新的 mutation，`draining` 拒绝新 attach 并等待现有 lease 结束，`soft-deleted` 保留恢复和审计所需的版本，`purged` 才允许删除内容对象。删除、rollback、fork 和 mount handoff 都必须带 source generation，并使旧 handle、目录 cursor 和缓存失效。

Fork 固定父 Workspace 的 source generation，子 Workspace 初始共享不可变内容并在首次修改时 copy-on-write；rollback 不删除历史，而是创建新的 current generation。旧 Session 在 rollback 或 freeze 后不能继续写，除非重新取得匹配的新 owner generation。Workspace 的 attach、detach、delete、fork 和 rollback 失败时，控制面必须保留可查询的状态和 receipt，不能只依赖 Worker 是否仍存活。

### 路径 containment 与数据库隔离

每个路径操作都应按以下顺序执行：规范化输入路径；解析 `.`、`..` 和允许的 symlink；确认结果仍在当前 Workspace；检查 tenant、workspace、mount 和 capability；最后执行 namespace 或 content mutation。Storage Service 和 FUSE/SDK client 都可以做早期拒绝，但只有 Storage Service 的检查具有授权效力。绝对 symlink、跨 Workspace symlink、symlink loop、Unicode-equivalent name、大小写冲突、控制目录访问和把目录移动到自身后代都必须有拒绝测试。

如果采用 shared-schema PostgreSQL，RLS 必须覆盖 `workspace`、`inode`、`dentry`、`object`、`object_chunk`、`file_version`、`operation`、`savepoint`、`quota`、`gc_queue` 和所有含 tenant-owned content 的表。Storage Service 不能以 table owner 角色运行；migration、GC、repair、备份和管理员查询使用独立角色并单独审计。每个连接事务开始时通过参数化 `set_config` 设置 tenant context，context 缺失、格式错误、连接池残留或 `SECURITY DEFINER` 绕过都必须 fail closed。RLS 只是最后一道行隔离，不替代 capability authorization、路径 containment、对象加密和管理员审计。

### 适配器不是同一套文件语义

FUSE、NFS、CSI 和 SDK 可以共享 metadata、content、authorization 和 revision core，但不能共用一套未经修改的 transport/cache 语义。FUSE 适配器负责 inode、file handle、`errno` 和 syscall；NFS 还要定义 client cache、reconnect、delegation 和 lock 行为；CSI 主要负责卷的创建、挂载、卸载和节点编排，不承诺完整 filesystem API；SDK 可以直接暴露带 revision 和 receipt 的显式操作。每个适配器都需要独立 conformance suite，尤其测试断线、重连、缓存失效、锁和取消。

## 工具与 sandbox 分层

适合留在 DSH Worker 内运行的工具：受控模型调用、Web search、受限 HTTP fetch、Session 查询、Workspace 元数据、只读知识库查询、平台提供的轻量转换、受控审批和非敏感状态操作。前提是工具代码可信、没有任意 Shell、没有任意 native addon、没有跨租户缓存、网络请求经过出口策略、并有超时与输出大小限制。

需要 External Executor 的工具：Shell、Python、任意用户代码、npm 插件、Docker、浏览器自动化、native binary、LSP、长时间终端、任意内网访问、大型代码编译和高 CPU 或高内存处理。Executor 可以不是虚拟机，但至少应考虑独立 OS process、独立 Unix user、独立 workspace root、cgroup 的 CPU 与内存与 pid 限额、文件访问限制、平台 sandbox、网络出口策略、临时凭据、执行时间限制和输出大小限制。

只做轻量文件系统隔离可以接受的条件是：工具代码可信、租户用户互信、不开放任意代码、不开放任意 Shell、没有高权限 native 能力、网络请求受限、平台只需防止普通误操作。公共 SaaS 若允许用户自由提交代码或安装插件，这组条件通常不成立。文件系统之外的既有实现参考 [sandbox](../../packages/sandbox/sandbox/README.md) 与 [fs](../../packages/fs/fs/README.md)。

## Web UI 与云端连接

浏览器不直接连接租户 Worker 的内部端口，而是经 SaaS Gateway 与 Session Router 到达 Worker。Gateway 负责用户认证、租户解析、Session 与 Workspace 授权、连接限流、stream 路由、重连、cursor 与 baseline、事件过滤和审计。

浏览器连接可以携带不透明的 `session_id`、`last_seen_seq` 和 `connection_id`。浏览器提供的 `tenant_id` 即使存在也只是未受信任的选择器，不能建立租户授权；tenant identity 必须来自已认证的 Gateway context，内部 Worker 请求只能接收服务端派生并已授权的 tenant claim。服务端重新授权后：Worker 仍活跃则从 last seen seq 继续发送；Worker 已缩零则唤醒新 Worker、从持久 Session store 生成 baseline 并从新的 seq 继续。不要把 WebSocket 是否存活当作 Session 是否存活的判据。

浏览器断线不等于 Agent 失败。需要区分“浏览器断线、Agent 仍在运行、Worker 仍存活、Session 已持久化”与“Worker 崩溃、外部工具结果未知、Session 需要恢复”这两组状态，它们对应不同的用户提示与恢复动作。

## 资源配额

一个租户一个 Worker 之后仍需租户内配额，否则单个 Session 可以影响同租户其他 Session。

租户级：最大活跃 Session、最大并发 Turn、最大模型请求、最大工具并发、最大 Workspace 大小、最大附件大小、最大总 token、最大费用、最大 Worker RSS、最大 Worker CPU、最大队列长度。

Session 级：最大 inbox 长度、最大 Turn 时间、最大 Step 数、最大模型 token、最大工具执行时间、最大工具输出、最大并发工具、最大文件变更量、最大子 Agent 数。

Worker 级：event-loop lag、RSS 高水位、GC 时间、文件句柄、subprocess 数量、网络连接数、stream 数、单租户累计 CPU 时间。

Storage Service 还必须限制单个 Sandbox 的并发 RPC、单个 Workspace 的连接数、stream 的窗口大小、目录分页大小、事务最长持有时间和单租户的数据库连接上限。慢 client 断开后，server 应取消未完成的 SQL 或释放其 lease；`readdir(10k)` 必须采用批量或分页协议，不能按 entry 产生一次数据库往返；缓存失效和 cache stampede 需要指标与限流。否则单个远程文件操作的固定网络成本可能成为 Agent 的主要延迟来源。

当 Worker 达到高水位时，停止接受新 Session、把新请求路由到第二个 Worker、等待当前 Session 安全迁移，再重启或缩小旧 Worker。

## 失败恢复

Worker 正常退出：停止接受新任务、等待安全点、flush Session、持久化 pending work、释放 Session lease、关闭流、退出。

Worker 崩溃：heartbeat 超时后标记旧 generation 失效并禁止其 append，由新 Worker 获取 Session lease、恢复事件日志、为中断 Turn 添加关闭记录、恢复待处理 inbox，并对未知工具结果执行查询或标记为未知。这个流程是平台侧协议，不是当前 DSH 已实现的跨进程接管能力。

模型请求中断时不能假设响应完整：保存已结算的 assistant attempt、标记 interrupted、由用户重试或策略生成新的 Step，不把未结算的流片段当作完整 assistant message。

工具已启动而 Worker 崩溃时，既不能判定工具一定没执行，也不能判定它一定成功。需要记录 `tool outcome unknown`，然后查询 External Executor、查询第三方 API、检查 Workspace receipt、请求人工确认，或明确告诉模型结果不确定。这条不确定结果语义与 [session-checkpoint-policy](../../packages/session/session-checkpoint-policy/README.md) 的 checkpoint 策略一致：模型请求前、顶层副作用工具前和步边界前的 flush 决定恢复时能看到什么，而恢复不自动重试结果未知的调用。

### Session 与 Workspace 的配对 checkpoint

Session persistence 和 Workspace storage 是两个独立的 durability domain，不能用“同时 flush”暗示跨数据库原子提交。平台应保存配对 checkpoint，至少包含 `sessionSeq`、`workspaceGeneration`、`workspaceRoot`、`lastOperationId`、`executorReceipt`、`ownerGeneration` 和 `checkpointState`。推荐顺序是：Workspace mutation 完成并取得 durable receipt，Session append tool/result，再执行 Session flush，最后提交 paired checkpoint；任一步失败都进入 `reconcile`，而不是自动重放未知副作用。Session 已记录 tool/result 但 Workspace 尚未 durable，或 Workspace 已 durable 但 Session 尚未 append，都必须由 receipt 和 generation 判断，不得靠时间顺序猜测。

## 观测与运营

Operation history 与 security audit 必须分开。Operation history 用于 Workspace 当前状态、undo、snapshot、replay 和 GC reachability，可以按 retention policy 压缩或归档；security audit 记录认证主体、tenant、授权决策、请求来源、correlation id、结果、管理员操作和 repair/GC 行为，不能因为 Workspace rollback 或内容删除而被改写。两者通过不可变的 operation id、request id、session id 和 workspace revision 关联，但查询权限和保留期限可以不同。

三类标识是基础：tenant id、session id、worker id 或 worker generation。工具层再加 turn id、step id、tool call id、execution id 和 workspace revision。日志与指标应能回答：哪个租户触发请求、哪个 Session 正在运行、哪个 Worker 持有它、当前 generation 是什么、模型请求与工具执行各耗时多少、工具实际在哪个 Executor 运行、Workspace 修改是否确认、Session 是否 flush、Worker 是否缩零、恢复后是否出现未知结果。

建议指标：active tenants、active workers、worker RSS、worker CPU、event-loop lag、active sessions、active turns、model latency、tool latency、executor queue latency、Session append latency、Session flush latency、recovery count、unknown tool outcome count、Worker cold-start latency、scale-to-zero rate、per-tenant token 与 cost、per-tenant workspace size、per-tenant executor usage。

## 部署方案比较

| 方案 | 优点 | 缺点 | 适用场景 |
|---|---|---|---|
| 所有租户共享一个 DSH 进程 | 成本最低、路由简单 | 安全与故障域弱 | 可信内部环境 |
| 一个租户一个 DSH 进程 | 路由、故障和资源单元清晰、实现适中 | 不是互不信任租户的安全边界；活跃租户多时内存成本高 | 可信工具或外层已有安全隔离的 SaaS 第一版 |
| 一个租户多个 DSH 进程 | 可按负载与故障域扩展 | 需要 Session ownership 与调度 | 中大型租户 |
| 一个 Session 一个进程 | 隔离强、故障影响小 | 进程数量与冷启动成本高 | 高风险或独立任务 |
| DSH Worker 加 External Executor | Agent 与高风险执行分离 | 架构复杂度增加 | 通用推荐方案 |
| 每任务虚拟机或 microVM | 安全边界强 | 成本与启动时间高 | 强隔离与不可信代码 |

默认选择是第一阶段“一个租户一个 DSH Worker 加多 Session 加 External Executor”，规模增长后演进为“一个租户多个 Worker 加 Session affinity 加资源与信任分池”。

## 实施阶段

阶段 0 先完成威胁模型：租户内用户是否互信、租户能否提交代码、能否安装插件、是否开放 Shell、是否允许公网与内网访问、是否保存用户凭据、Workspace 是否含敏感代码、需要什么级别的合规与审计。真实 Agent trace 默认只采集 syscall、路径、大小、时序和错误，不采集文件内容；路径中的 token、环境变量、Git remote、证书名和用户输入需要脱敏，trace 需要授权、保留期限和可复现回放规则。没有这些答案就无法判断普通进程隔离是否足够。

阶段 1 用可信工具和单 Worker 打通主链路：Gateway、一个租户一个 DSH Worker、多 Session、Cloud Session Store、Cloud Workspace、平台控制工具和 Web UI。验证重点是 Session 的 append、flush 与 resume，Worker 崩溃恢复，浏览器重连，Session owner，租户授权，Workspace 版本和缩零。

阶段 2 引入 External Executor，把 Shell、代码和高风险工具移出 Worker，验证 idempotency、execution receipt、timeout、cancellation、unknown outcome、产物上传、Workspace mutation 和网络出口。

阶段 3 在单 Worker 达到瓶颈后增加 Worker Manager、Session routing、lease、fencing、generation、drain、recovery 和 per-worker 资源策略。

阶段 4 按信任等级与资源类型分池：只读池、文件编辑池、交互池、批处理池和高风险 Executor 池，不同池使用不同 Profile、Preset 与外部执行策略。

阶段 5 才考虑受控动态扩展。只有基础授权、Worker recovery、Executor 隔离、插件签名和资源审计稳定之后，才开放 Dynamic Cordis Package 或用户自定义 Agent 组合。

各阶段必须有可观察的退出条件。阶段 1 至少注入 append 前、flush 前、flush 后和 Worker 终止四类故障，验证旧 generation 被拒绝、已确认的 Session prefix 不丢失、浏览器重连拿到连续 seq，且 Agent、ripgrep、Shell 和 Executor 使用同一个 Workspace revision。阶段 2 需要在 executor accepted、started、completed、timeout 和 response lost 后重试同一 operation id，验证不会产生重复副作用；不能确认的调用必须进入 `unknown`。阶段 3 需要注入网络分区和双 Worker 竞争，验证只有当前 generation 能 append 或修改 Workspace，旧 lease 的请求得到稳定拒绝。阶段 4 需要验证完整表族的租户授权、连接池上下文清理、GC 与 rollback 的交互，并记录 RPO、RTO 和冷启动时间。任何阶段都不能把未测试的能力写成已具备的产品保证。

## MVP 验收标准

Agent 执行：一个 Session 可以完成多 Step Turn；工具调用与结果顺序稳定；并行工具结果按模型顺序提交；模型流可以传到浏览器；浏览器断线后可以重连。

Session：事件可以 append 并 flush；flush 后可以从另一 Worker 读取；同一 Session 同时只有一个 owner；旧 generation 不能继续写；Worker 崩溃后可以恢复；未知工具结果不会被静默重试。

Workspace：每个 Workspace 有租户授权；修改带 revision；重复提交有 idempotency 保护；Agent 文件工具、搜索、Shell、LSP、编译器和 Executor 看到同一个 Workspace revision，或每次投影都能提供 source/target revision 与 receipt；跨租户路径访问被拒绝；`open`、`rename`、`unlink`、`fsync`、symlink、锁、临时文件和错误映射行为明确。

Worker：空闲 Worker 可以 drain；退出不丢 Session；新请求可以唤醒 Worker；heartbeat 超时可以触发 recovery；单租户达到资源上限时不影响平台其他租户；单个 Session 失败不会让整个租户 Worker 无限重启。

安全：浏览器不能直接访问 Worker；每个请求重新验证用户、租户、Session 与 Workspace，且浏览器提供的 tenant id 不具备授权效力；Worker 不持有不必要的跨租户凭据；External Executor 有 CPU、内存、进程、时间与网络限制；symlink、path containment、RLS 和连接池上下文 fail closed；RLS 覆盖完整的 tenant-owned 表族并使用非 owner Storage Service 角色；日志不泄露模型密钥与用户凭据；无法通过 Dynamic Cordis 或普通 `node:vm` 绕过隔离。

## 结论

DSH 适合作为云端 SaaS Agent 的 Agent Execution Plane，不适合作为完整的 SaaS 平台。它的优势是 Agent Loop 可组合、能力接缝清晰、工具管线可扩展、Session log 可审计与恢复、Profile 与 Preset 可做能力分级、Host 与 Client 适合 Web 形态。它的不足是没有现成的多租户授权、没有分布式 Session ownership、没有 Cloud Workspace、没有通用高风险代码 sandbox、没有 Worker 调度与缩零，并且 Dynamic Cordis 不是不可信代码的安全边界。

推荐的初始架构是一个租户一个 DSH Worker 进程、多 Session、一个 Session 同时只有一个 owner、Session 与 Workspace 外部持久化、空闲可缩零、Shell 与任意代码与 native 工具交给 External Executor。这里的“一租户一 Worker”是路由、故障和资源管理选择，不是租户安全隔离承诺；互不信任租户必须再加容器、microVM 或等价执行边界。扩展顺序是先按租户拆进程而不是按 Session 拆，再按资源与信任级别分池，最后在必要时引入更强的 OS、container 或 microVM 边界。

最终可以这样划分职责：Tenant 是授权、配额、数据与计费边界；Session 是 Agent 对话与执行历史边界；Worker 是可回收的 Agent 执行所有者；Workspace 是可版本化的文件数据边界；Executor 是高风险副作用执行边界；SaaS Control Plane 是身份、调度、路由、授权与恢复的协调者。DSH 当前提供事件日志、checkpoint 所需的扩展点和进程内行为，但不提供跨 Worker ownership、pending interaction 移交、统一执行世界、Workspace writer fencing 或 Session/Workspace 配对恢复协议。

## Further Exploration

- [Architecture](../architecture.md) — Profile 组合、应用启动、Agent Loop 与能力 provider 的总体地图。
- [部署、租户隔离与请求执行参考](dsh-deployment-and-tenancy-deep-dive.md) — 当前 Web 进程、Host 服务、Session 归属、隔离边界和部署选择的运行时事实。
- [Remote Durable Workspace 研究](dsh-remote-durable-workspace-pgfs-research.md) — 远程持久化工作区的存储实现、数据模型与 PoC 路线。
- [Session 子系统](../subsystems/session.md) 与 [Session persistence](../../packages/session/session-persistence/README.md) — 事件日志、投影、flush 边界和单写者假设。
- [Session checkpoint policy](../../packages/session/session-checkpoint-policy/README.md) — 模型请求前、工具前与步边界前的持久化点，以及中断后的未知结果语义。
- [Agent Loop](../../packages/core/agent-loop/README.md) — Turn 与 Step 生命周期、取消、持久化与并行工具调度。
- [Sandbox](../../packages/sandbox/sandbox/README.md) 与 [fs](../../packages/fs/fs/README.md) — 同一执行世界的限制、平台 runner 与文件能力接缝。
- [Cordis host runner](../../packages/extensions/cordis-host-runner/README.md) — 动态扩展的进程内范围、`node:vm` 限制和信任级别。
- [Browser connection](../../packages/client/connection/README.md) 与 [webserver](../../packages/host/webserver/README.md) — launch token、cookie、Host/Origin 检查与远程暴露限制。
- [API gateway](../api-gateway.md) 与 [Web client 子系统](../subsystems/web-client.md) — Host、Remote、Client model 与 UI 的分层。

-----

## Dev Note

<details>
<summary>非权威的设计建议范围</summary>

本文是 `docs/drafts/` 中的单语研究草稿，不是 DSH 已实现的产品契约，也不构成性能、安全或合规保证。文中 Control Plane、Worker Manager、External Executor、Cloud Workspace、lease 与 fencing 均不存在于当前仓库，属于平台侧设计建议；进程数、配额、时限和阶段划分需要按实际威胁模型与压测结果调整。

`scripts/translation-pairing.manifest.json` 将本文排除在双语配对之外，网站也不发布它。下一步如果进入实现，应由独立 Agent Note 定义 tenant 资源归属、Worker activity 与 drain、Session owner 与 generation、pending interaction 移交和 Executor 任务协议，并在实现时更新拥有这些行为的 package README、持久化类型确认、两个 SDK 的投影与快照。

</details>
