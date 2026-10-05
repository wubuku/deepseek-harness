---
description: "调研 CubeSandbox 的 microVM 隔离、生命周期、快照、跨节点恢复、Volume、S3、egress 凭据注入，以及它在 DSH 云端 Agent 架构中的适用边界。"
---

# CubeSandbox 深度调研：它是什么，以及是否适合作为 DSH 云端 Agent 的执行底座

**核验日期：2026-10-05**

## 执行结论

CubeSandbox 是 Tencent Cloud 开源的、面向 AI Agent 代码执行的 Sandbox 基础设施，不是一个完整的 Agent 产品，也不是一个托管型 Cloud Agent SaaS。

它的核心价值是：为每个 Sandbox 提供独立 Linux kernel 的 KVM microVM 隔离，并围绕这个执行单元提供创建、运行、暂停、恢复、快照、克隆、回滚、销毁、文件、命令、PTY、Volume 和网络策略能力。

截至 2026-10-05，公开 release 已到 `v0.7.2`；仓库采用 Apache License 2.0。`v0.7` 系列的重要方向是 S3 后端支持的跨节点暂停/恢复和基于快照创建，以及将控制面和运维能力拆分到 CubeOps；这些能力仍需要结合具体版本、后端和节点兼容性验证，不能仅凭 release 标题当成无条件生产保证。

对 DSH 云端 Agent 的判断是：**CubeSandbox 很适合做 Cloud Agent 的隔离执行器，尤其适合长任务、浏览器自动化、重型工具和需要暂停/恢复的后台任务；但它不能替代 DSH Session、Cloud Run Control Plane、租户认证、Workspace 协议或 Agent checkpoint。**

推荐的组合是：Browser Native DSH 负责交互式前端 Agent Loop，Cloud Agent Control Plane 负责任务、身份、Session checkpoint 和事件，CubeSandbox 负责服务端 DSH runtime 的隔离与生命周期。

## 1. CubeSandbox 是什么

可以把它放在以下架构位置：

```text
Cloud Agent Control Plane
        │ create / pause / resume / events
        ▼
CubeSandbox
        │
        ▼
KVM MicroVM
  dedicated Linux kernel
  DSH runtime
  shell / browser / compiler / tools
```

它不是：

- DSH Agent Loop；
- DSH Session event log；
- 多租户身份、RBAC、计费或配额系统；
- 一个直接提供用户 Web UI 的 Cloud Agent 产品；
- 一个自动保证 Session、Workspace、PTY 和外部副作用一致恢复的数据库；
- 一个把 S3 当作普通文件系统并自动提供 POSIX 一致性的对象存储网关。

它更准确的定位是：**为不可信或资源密集型 Agent workload 提供隔离、可编排、可快照的远程执行机器。**

## 2. 核心架构

### 2.1 虚拟化层

CubeSandbox 为每个 Sandbox 分配一个 KVM microVM，并在 guest 中运行独立 Linux kernel。公开架构资料把 CubeHypervisor、CubeShim 和 Cubelet 作为关键组成：CubeHypervisor 管理 microVM，CubeShim 通过 containerd Shim v2 接入容器运行时抽象，Cubelet 管理节点上的 Sandbox 实例生命周期。

这和 Docker 容器的安全模型不同：Docker 通常与宿主机共享 Linux kernel，而 CubeSandbox 的 guest 有自己的 kernel，因而可以把“容器内恶意代码影响宿主 kernel”的风险面降低到 microVM/KVM、宿主管理面和硬件虚拟化边界。

这不是“绝对安全”。KVM、宿主 kernel、Cube 组件、模板构建链、网络策略、管理 API、镜像 registry 和 Volume driver 仍然是安全边界的一部分；是否满足某种威胁模型必须通过具体部署和攻击面审计确认。

### 2.2 节点与控制面

在 v0.7 方向中，CubeSandbox 将节点管理和运维能力拆分到 CubeOps，同时保留 CubeMaster/Cubelet 等执行管理组件。单节点或自托管部署仍需要准备 KVM、节点网络、镜像 registry、模板、S3 或其他存储后端，以及相匹配的 control-plane/compute-node 版本。

它可以部署在裸机、Kubernetes 或 Tencent Cloud 的 Terraform 路线，但这些部署方式不是同一个故障模型。Kubernetes 能够编排 Cube 组件，不会自动把 guest filesystem、S3 Volume、Session event log 和 Agent 外部副作用变成一个 Kubernetes transaction。

### 2.3 SDK 和 API 兼容性

CubeSandbox 提供与 E2B 相似的 SDK/API 表面，例如 Sandbox 创建、文件、命令、PTY、Volume 和网络配置；这主要是客户端使用体验和类型表面的兼容，不应理解为 CubeSandbox 与 E2B 服务器端 wire protocol 完全相同。

HamsterHQ 的本地 `gateway/src/platform-cube.js` 已经把这个边界写得很清楚：它使用 CubeSandbox 自己的 SDK，而不是把官方 E2B SDK 的请求直接发送给 CubeSandbox。应用层可以复用相似的调用模型，但仍应锁定 CubeSandbox SDK 和 API 版本。

## 3. Sandbox 生命周期

### 3.1 基本状态

典型生命周期可以抽象为：

```text
create
  → boot / run
  → pause
  → resume
  → snapshot / clone / rollback
  → kill / destroy
```

CubeSandbox 的 snapshot 可以保存运行中的 VM memory 和 filesystem 状态；rollback 在同一个 Sandbox 内恢复状态；clone 从一个状态派生出多个独立 Sandbox。它的语义比“重新启动一个容器并挂载一个目录”更接近可暂停的远程执行机器。

### 3.2 Auto-pause 与 Auto-resume

对于 Agent 平台，自动暂停的意义是：长时间没有请求时释放运行资源，下一次连接或请求时恢复 Sandbox，而不是销毁整个执行环境。

这对长任务很有吸引力，但必须与 DSH Session 语义分开：

```text
Cube pause/resume
    恢复 VM memory、root filesystem 和可重新挂载的 Volume

DSH Session resume
    恢复模型可见事件、Agent step、tool result 和 turn ownership
```

前者不能自动证明后者成立。一个 Agent turn 如果在 model request、tool side effect、PTY 命令或外部 API 调用中被暂停，恢复后是否能够安全重试，必须由 DSH/Cloud Run 协议定义。

### 3.3 长时间后台任务的适用性

CubeSandbox 特别适合以下 Cloud Agent workload：

- 数小时的编译、测试、数据处理和代码迁移；
- 需要浏览器、桌面或 CDP 的自动化任务；
- 需要保存进程、临时文件、缓存和工具安装状态的任务；
- 需要在用户离开浏览器后继续运行的后台任务；
- 需要从同一个快照派生多个实验分支的任务。

但 Cloud Agent Control Plane 仍需保存 `cloudRunId`、Sandbox ID、最后事件序号、Workspace generation、租约、取消状态和恢复策略。CubeSandbox 只提供执行资源，不能替代这些业务记录。

## 4. 快照、克隆、回滚与跨节点恢复

### 4.1 CubeCoW

CubeCoW 是 CubeSandbox 的 Copy-on-Write snapshot engine，目标是用增量 dirty-page 和写时复制机制提供较低延迟的 snapshot、clone 和 rollback。

这使 Cloud Agent 可以在高风险操作前建立执行级 checkpoint：

```text
snapshot(before-refactor)
  → run agent task
  → test
  → rollback 或 clone experiment
```

但这个 checkpoint 不是完整的 Agent checkpoint。它不自动包含 Cloud Run 数据库事务、Session append/flush 状态、外部 API 已提交的副作用、用户审批记录或控制面 ownership。

### 4.2 S3 后端的跨节点能力

v0.7 系列引入了以 S3 作为共享 snapshot backend 的跨节点 pause/resume 和 snapshot-based launch。暂停时需要把 snapshot package 发布到共享对象存储，目标节点再获取它；跨节点迁移的是 snapshot/pause package，不是把正在运行的 VM disk 直接搬走。

跨节点恢复的前提包括：目标节点兼容相同的 runtime/kernel/guest image 版本，目标节点可以访问对应 S3，snapshot 的 remote 状态已经 ready，模板和组件版本仍然兼容，并且所有外部 Volume driver 都能在目标节点 attach。

因此“使用 S3”不等于“自动跨节点高可用”。它只是为跨节点恢复提供了必要的共享状态存储。

### 4.3 Snapshot 与外部 Volume 的关系

CubeSandbox 的 VM snapshot backend 与插件 Volume backend 是两个独立概念：

```text
VM snapshot backend
    保存 VM memory/rootfs/snapshot package

Plugin Volume backend
    保存挂载到 Sandbox 的外部数据
```

从 snapshot 恢复时，系统可以恢复 VM/rootfs 状态，再按照保存的 Volume ID 和挂载信息重新 attach 当前 Volume。Volume 本身的数据不会因为 VM rollback 自动回到 snapshot 创建时的内容。

这对 DSH 很关键：如果 Workspace 位于外部 Volume，Cube 的 VM rollback 可能回滚了进程和 rootfs，却保留 Workspace 当前文件。要实现“Agent 任务和 Workspace 一起回滚”，必须额外对 Workspace 做版本化或快照，并在 Cloud Run checkpoint 中绑定二者。

## 5. Volume 与 S3 持久化

### 5.1 Cube Volume framework

CubeSandbox 提供类似 E2B 的 Volume framework，允许通过插件接入不同存储后端。Volume 的生命周期可以独立于 Sandbox：创建 Volume、挂载到 Sandbox、销毁 Sandbox、下一次重新挂载时数据仍然存在。

这使它适合保存：

- DSH Session 目录；
- `/workspace`；
- 用户 HOME；
- 浏览器 profile；
- 已安装工具和依赖缓存；
- 需要跨 Sandbox 生命周期保留的构建产物。

但 Volume 的一致性和 durability 由后端驱动决定，不由 CubeSandbox 的 Volume API 名称自动保证。

### 5.2 S3 Volume 的真实语义

官方 S3 Volume 文档强调，S3 Volume 的数据可以跨 Sandbox 生命周期保留，也可以在兼容节点上重新挂载；但它与 VM snapshot package 分离，Volume data 不会随着 VM snapshot rollback 自动回滚。

S3 对象存储本身不是 POSIX filesystem。实际实现通常需要 filesystem/client layer、元数据存储、缓存、写回策略、文件锁和一致性语义。需要分别验证：

- 多客户端是否允许同时读写；
- rename 是否原子；
- `fsync` 返回时对象和元数据是否已持久化；
- 断电或节点丢失时 writeback 缓存是否丢失；
- Volume 删除、snapshot 引用和 orphan object 如何回收；
- 跨节点挂载时缓存和锁是否仍然有效。

### 5.3 HamsterHQ 的 JuiceFS over S3 路线

HamsterHQ 没有把 S3 直接当作 DSH Workspace，而是提供 `integrations/cube-volume-juicefs/` 作为 Cube Volume plugin：JuiceFS 的对象数据位于 S3-compatible storage，JuiceFS metadata 位于数据库，CubeMaster 和 Cubelet 通过 plugin hook 创建、挂载、卸载和销毁 Volume。

这条路线的关键风险已经在 HamsterHQ 本地文档中明确写出：JuiceFS metadata database 是文件系统的组成部分，不是可随意丢失的缓存；对象存储完好但 metadata database 损坏或丢失时，租户文件仍然不可用。也就是说，S3 + JuiceFS 需要同时备份对象数据和 metadata database。

HamsterHQ 的本地集成文档还记录了 `synchronous_commit = off` 的性能取舍，以及 writeback/cache 对 close 和 WAL fsync 的影响。这是 HamsterHQ 这个集成的部署选择，不能直接当成 CubeSandbox 全局默认语义。

### 5.4 Volume 与 DSH Workspace 的建议

第一版 Cloud DSH 不应把 Cube Volume 的“持久存在”直接宣传成“Workspace 已经可恢复”。应当显式记录：

```text
workspaceId
volumeId
volumeBackend
workspaceGeneration
lastDurableOperationId
volumeConsistencyMode
snapshotReference
```

如果需要可靠交接和回滚，Workspace 应有自己的 generation/snapshot 协议；Cube Volume 只是执行器挂载方式。

## 6. 网络隔离与凭据注入

### 6.1 CubeVS

CubeVS 使用 eBPF datapath 处理 Sandbox 网络隔离、域名或地址策略、SNAT、会话跟踪和跨 Sandbox 访问控制。官方架构资料强调，默认策略会拒绝私有或 link-local 范围，并通过每个 Sandbox 的 allow/deny policy 控制出站能力。

它的价值在于：网络策略不只是应用层 Gateway 的一层判断，而是进入 Sandbox 网络路径；但最终安全性仍取决于节点配置、策略下发、管理 API 权限和是否存在可绕过的 host capability。

### 6.2 CubeEgress

CubeEgress 是用户态的 L7 egress proxy，基于 OpenResty/Lua 和 TPROXY 对 HTTP/HTTPS 流量执行更细的域名、SNI、host、path 和 method 策略。

它支持把真实模型 API key 作为规则侧的注入凭据，在转发时添加 `Authorization` 等 header，使 Sandbox 内的 DSH 进程、环境变量、文件和模型上下文看不到原始密钥；同时记录 allow、deny、inject 和 TLS handshake 等审计事件。

这对多租户 DSH 很有价值：模型 key 可以留在平台或 egress 层，Sandbox 只拿到一个逻辑 endpoint 或 placeholder 配置。

但它不是无条件安全保证：需要正确配置目标域名、TLS 透明代理、Sandbox 内的信任 CA、DNS/网络策略和审计日志；无法被 CubeEgress 覆盖的 endpoint、错误的 allowlist、可访问的宿主管理面或被授予过宽权限的 runtime 仍然可能泄漏凭据。

## 7. HamsterHQ 如何使用 CubeSandbox

本节来自 HamsterHQ 本地 checkout 的静态代码和文档阅读，未在本机启动 CubeSandbox 集群，也未独立复现其生产隔离或跨节点恢复。

### 7.1 每租户一个 Cube Sandbox

HamsterHQ 的 Gateway 通过 `@cubesandbox/sdk` 创建、连接、列举和销毁 Cube Sandbox，并用 metadata 标记 owner。Gateway 保存自己的 sandbox identity、token、runtime handle 和版本信息；Cube Sandbox ID 与 Gateway 自己的租户 sandbox ID 不是同一个概念。

租户 Sandbox 主动通过 tunnel 连接 Gateway。Gateway 根据 token、sandbox ID 和租户映射接受连接，浏览器流量再通过 tunnel 复用到 Sandbox 内的 DSH backend。

### 7.2 Volume 挂载

`compose.cube.yml` 为 Cube 路线设置 `SANDBOX_VOLUME_DRIVER=juicefs`、`SANDBOX_VOLUMES=on` 和 `/mnt` 挂载路径；Gateway 在创建 Sandbox 时为租户准备 Volume mount。DSH workspace、HOME、browser profile 和 Session 目录写入持久 Volume，沙箱回收后可以重新挂载。

Cube 路线还支持 desktop 与 lightweight sandbox template：desktop 模板包含 Plasma、TigerVNC、noVNC 和有头 Chrome，轻量模板主要面向无头 CDP。模板只冻结与租户无关的系统栈，DSH、tunnel、reporter、workspace 和迁移不应冻结进模板快照。

### 7.3 Recovery 边界

Gateway 重启后可以通过 Cube API 重新列举并 adopt 存活 Sandbox，但这不等于恢复了正在运行的 DSH Agent turn。Sandbox 被回收或 tunnel 断开后，恢复路径主要依赖重新连接、重新启动 backend、读取文件/日志/terminal 或重建 Sandbox；统一的 Session checkpoint 和 Agent resume 仍需要 Cloud Agent Control Plane 提供。

## 8. 对 DSH 云端 Agent 的适用性判断

| 能力 | CubeSandbox 能提供 | 仍需 DSH/Cloud Agent 平台提供 |
|---|---|---|
| 隔离执行 | KVM microVM、独立 guest kernel、节点级网络和 egress 控制 | 租户身份、授权、审计和平台管理面 |
| 长时任务 | Sandbox 保持、暂停、恢复、PTY、文件和进程状态 | Cloud Run 状态、任务重试、取消和 ownership |
| Workspace | Volume attach、跨 Sandbox 生命周期保留 | 文件版本、generation、备份、配额和恢复点 |
| 快照实验 | VM snapshot、clone、rollback、S3 snapshot package | Session event、外部副作用、Workspace snapshot 的一致绑定 |
| 模型凭据 | CubeEgress header injection 和访问审计 | Provider 配置、租户配额、密钥轮换和授权策略 |
| 浏览器自动化 | desktop microVM、Chrome、noVNC/CDP 模板 | 浏览器会话授权、录制、结果交付和人工接管 |
| 多租户 | microVM 和 per-sandbox network/egress boundary | OIDC、RBAC、billing、quota、control-plane HA 和 fencing |

结论是：CubeSandbox 是执行层，不是 Cloud Agent 的全部。

## 9. 与 Browser Native DSH 的交接设计

推荐的组合架构如下：

```text
Browser Native DSH
  Agent Loop + same-origin LLM proxy + local interaction
                │
                │ handoff(session checkpoint, workspace generation)
                ▼
Cloud Agent Control Plane
  Cloud Run + auth + events + ownership + audit
                │
                ▼
CubeSandbox Executor
  DSH backend + Cordis plugins + tunnel + Volume + egress
```

交接至少需要绑定：

- Browser Session 的最后一个 durable sequence；
- Workspace 的 generation 或 snapshot reference；
- 云端任务规格和允许使用的工具；
- runtime requirements，例如 desktop、CDP、CPU、memory 和 timeout；
- 模型 provider 和 credential policy；
- Cloud Run 的幂等键、owner 和取消令牌；
- 云端事件回传的 sequence 和 resume token。

CubeSandbox snapshot 可以作为执行资源的 checkpoint，但不能单独作为产品级交接记录。浏览器端需要能看到 Cloud Run 的状态，即使 Cube Sandbox 暂停、迁移、重建或短暂失联。

## 10. 主要风险和必须验证的事项

### 10.1 基础设施前提

- 主机是否支持 KVM，节点是否有稳定的 CubeMaster/Cubelet/CubeOps 版本组合；
- guest image、kernel、template 和 SDK 版本是否匹配；
- registry、S3、Volume metadata database 和 egress CA 是否有独立备份；
- 跨节点目标是否能访问同一 S3 和同名 Volume driver；
- Kubernetes 部署是否只是组件编排，还是已经验证了实际 Sandbox 逃逸和节点故障场景。

### 10.2 数据和恢复

- VM snapshot 恢复后，Session event 与 Workspace generation 是否仍然匹配；
- Volume rollback 是否需要单独执行，是否会保留 snapshot 之后的文件；
- JuiceFS metadata database 丢失时是否 fail closed，是否有恢复演练；
- S3 对象已上传但 metadata 未提交，或 metadata 已提交但对象未完成时如何处理；
- paused Sandbox、Volume、snapshot 和 Cloud Run 删除的保留关系是什么；
- Agent 在外部 API 已产生副作用后被 pause/kill，恢复时是否禁止自动重试。

### 10.3 安全和租户边界

- Sandbox 是否能访问 Cube API、CubeProxy、其他 Sandbox、宿主 metadata 和控制面数据库；
- CubeEgress 的 allowlist、TLS CA 和 credential injection 是否能被用户代码绕过；
- 模型 key 是否出现在环境变量、进程参数、DSH Session、日志、browser devtools 或错误消息中；
- Gateway restart、sandbox adoption 和 token rotation 是否能阻止旧 Sandbox 冒充新 owner；
- Docker simulation 是否被错误地当成 CubeSandbox microVM 的安全证据。

### 10.4 必须建立的验收矩阵

```text
create / kill / recreate
pause / resume on same node
pause / resume on another node
snapshot / rollback / clone
VM snapshot with external Volume
Volume attach after sandbox deletion
metadata database loss and recovery
S3 object loss and reconciliation
gateway restart and sandbox adoption
old tunnel token after owner revocation
model credential leak attempts
cross-tenant network and filesystem access
browser handoff during an active Agent turn
browser disconnect and Cloud Run continuation
duplicate create/start/resume requests
node loss during tool execution
```

没有完成这些验收时，应该把 CubeSandbox 集成称为“已接入执行器”或“实验性 runtime”，而不是“已经具备生产级可恢复 Cloud Agent”。

## 11. 采用建议

### 推荐采用场景

在具备 KVM 裸机或可控节点、需要强隔离执行、需要运行长时间任务、需要浏览器/桌面工具、需要暂停/恢复或需要把真实模型 key 留在 egress 层时，CubeSandbox 是值得优先评估的执行器。

### 不宜直接采用的场景

在本地 macOS 开发、只想快速验证 Browser Native Agent、没有可运维 KVM 节点、没有 S3/Volume metadata 备份能力，或只需要一个短生命周期的单用户工具时，CubeSandbox 的运维成本可能超过收益，Docker 或本地 executor 更适合 PoC。

### 对本项目的推荐

不要把 CubeSandbox 放在产品数据模型的中心。推荐保留以下层次：

```text
DSH Cloud Control Plane
  owns tenant, cloud run, checkpoint, audit and event contract

DSH Runtime Adapter
  owns DSH profile, Cordis plugins, tunnel and runtime identity

CubeSandbox Adapter
  owns create, pause, resume, snapshot, volume and network translation

CubeSandbox
  owns isolated execution machine and node lifecycle
```

这样未来可以把 CubeSandbox 替换为 Kubernetes Sandbox、Firecracker、云厂商 microVM 或本地 Docker，而不改变 Browser Native handoff 和 Cloud Run 协议。

## 12. 参考资料与证据边界

### 官方资料

- [CubeSandbox GitHub repository](https://github.com/TencentCloud/CubeSandbox)
- [Architecture overview](https://github.com/TencentCloud/CubeSandbox/blob/master/docs/architecture/overview.md)
- [Introduction](https://cubesandbox.com/guide/introduction.html)
- [Snapshot, Rollback and Clone](https://cubesandbox.com/guide/snapshot-rollback-clone)
- [Cross-Node Snapshots](https://cubesandbox.com/guide/cross-node-snapshot)
- [S3 Volumes](https://cubesandbox.com/guide/s3-volume)
- [Volume Plugin Development](https://cubesandbox.com/guide/volume-plugin)
- [Security Proxy](https://cubesandbox.com/guide/security-proxy)
- [v0.7.0 release article](https://cubesandbox.com/blog/posts/2026-08-28-cubesandbox-v0.7.0-release)
- [v0.7.2 release](https://github.com/TencentCloud/CubeSandbox/releases/tag/v0.7.2)

### 本地 HamsterHQ 证据

本调研还核对了本地 HamsterHQ checkout 的 `docs/cubesandbox.zh.md`、`docs/sandbox-pitfalls.zh.md`、`compose.cube.yml`、`gateway/src/platform-cube.js`、`gateway/src/volumes.js`、`gateway/src/sandboxes.js`、`integrations/cube-volume-juicefs/` 和 `verify/verify-cube.mjs`。这些文件的稳定结论已经整理到 [`dsh-cloud-projects-local-code-reading-memo.md`](dsh-cloud-projects-local-code-reading-memo.md)。本机没有启动 CubeSandbox 集群，也没有把 HamsterHQ 的历史验收记录当成本次独立运行证据。

### 证据限制

CubeSandbox 官方文档和 release notes 说明的是项目能力和设计目标；它们不替代我们对目标部署版本、节点配置、Volume driver、S3、TLS egress、跨节点恢复和租户攻击面的实测。尤其不能把“microVM 隔离”“跨节点 snapshot preview”“credential injection”直接升级为对任意部署环境的生产安全承诺。
