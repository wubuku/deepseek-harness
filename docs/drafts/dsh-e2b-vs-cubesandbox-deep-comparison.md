---
description: "基于官方源码、文档和 release 资料，深入比较 E2B Runtime 与 CubeSandbox 在隔离、控制面、快照、持久化、网络、凭据、部署和 DSH 云端 Agent 适配方面的差异。"
---

# E2B 与 CubeSandbox 深度比较

**核验日期：2026-10-05**

## 执行结论

E2B 和 CubeSandbox 都属于“面向 AI Agent 的远程 Sandbox 基础设施”，都为每个 Sandbox 提供 microVM、命令/文件/PTY 能力、网络控制、快照或暂停恢复，以及供 SDK 使用的 HTTP API。

但两者的产品定位不同：

```text
E2B
    更像已经产品化的 Agent Sandbox 平台和完整运行时
    强项是 SDK/API、托管云、BYOC、控制面、观测和生态

CubeSandbox
    更像可自托管、可深度定制的 Sandbox 基础设施
    强项是 KVM microVM、eBPF 网络、L7 凭据注入、Volume 插件和执行层控制
```

对 DSH Cloud Agent 的直接建议是：**不要 fork E2B 或 CubeSandbox 来承载 DSH 的业务控制面。应定义自己的 `CloudExecutor` 接口，把它们作为可替换执行器。若优先验证产品和长时任务，先用 E2B Cloud/BYOC；若优先自托管、租户隔离、模型凭据 egress 和可控 Workspace 存储，重点评估 CubeSandbox。**

这不改变此前对 HamsterHQ 的判断：HamsterHQ 仍然是 DSH runtime、Cordis plugin、Gateway 和 outbound tunnel 的主要架构参考；E2B 与 CubeSandbox 是更底层的 Sandbox executor 候选。

## 1. 官方主体与许可证

### 1.1 E2B 的官方主体

E2B 是产品和品牌名称；E2B 官方服务条款把服务提供方写成 `FOUNDRYLABS, INC.`，一家 Delaware corporation。官方 GitHub 组织是 [`e2b-dev`](https://github.com/e2b-dev)，该组织已经通过 GitHub 的域名验证并指向 `e2b.dev`；`e2b-dev/runtime`、SDK、Dashboard 和相关仓库是 E2B 官方公开代码体系的一部分。

E2B 官方 GitHub 组织声明其公开 stack 采用 Apache-2.0；`runtime` 仓库和主 SDK 仓库也标注 Apache-2.0。因此，讨论“E2B 开源实现”时，准确对象是 `e2b-dev` 下的开源 runtime、SDK、Dashboard 和相关组件，而不是把 `e2b.dev` 托管服务本身当作开源软件。

E2B Cloud、Enterprise 和 BYOC 仍然受 E2B 服务合同、产品计划和使用条款约束。Apache-2.0 允许使用、修改和再分发相应开源代码，但不会授予 E2B Cloud 的托管资源、企业支持、商标、域名、专有运营系统或商业服务权利。E2B 服务条款还明确把开放源代码部分与服务本身区分开来，并限制对服务进行复制、转售或构建竞争性服务；这不能被理解为限制 Apache-2.0 对独立开源代码的授权。

### 1.2 CubeSandbox 的官方主体

CubeSandbox 的官方代码仓库是 [`TencentCloud/CubeSandbox`](https://github.com/TencentCloud/CubeSandbox)，位于 Tencent Cloud 的 GitHub 组织下。仓库 `LICENSE` 和源码 SPDX 标记使用 `Tencent`、`Tencent Inc.` 或 `Copyright (C) 2026 Tencent` 的归属；因此在本报告中把 CubeSandbox 的官方维护主体称为 Tencent/Tencent Cloud，而不是把它当成一个独立社区公司产品。

CubeSandbox 核心仓库采用 Apache-2.0，但许可证文件同时说明发行包包含若干第三方组件，并要求按 `NOTICE` 和各组件原始许可证处理。仓库中基于 Cloud Hypervisor、Kata Containers、virtiofsd、containerd shim 等项目的部分代码保留了上游版权和许可证声明；“CubeSandbox 是 Apache-2.0”不等于其每一个 vendored 或派生组件都可以脱离上游通知单独处理。

### 1.3 对我们项目的实际含义

若只使用相应仓库中明确受 Apache-2.0 授权的代码，两个项目都允许商业使用、修改、分发和构建衍生作品，但需要保留许可证和版权声明、保留 NOTICE 要求、标记修改，并接受无担保和专利终止条款。

需要单独审查的对象包括：

- E2B 或 CubeSandbox 仓库中的第三方依赖、镜像、kernel、guest image 和构建产物；
- E2B Cloud/BYOC/Enterprise 的服务条款和商业合同；
- E2B、CubeSandbox、Tencent Cloud 的商标、品牌、域名、截图、文案和官方镜像；
- 我们是否把代码重新包装为与官方产品混淆的托管服务；
- 分发时是否同时带上完整的 LICENSE、NOTICE 和第三方许可证。

因此，工程上可以把两边的 Apache-2.0 runtime 作为研究或执行器基础，但不能因为“代码开源”就复制 E2B Cloud 的商业服务，也不能默认获得 Tencent/CubeSandbox 的品牌和官方支持授权。正式商用前仍应让法务审查具体仓库版本、第三方清单、镜像和分发方式。

## 2. 比较对象的边界

### 1.1 E2B 不只是一个 SDK

E2B 的开源 `runtime` 仓库包含控制面 API、每节点 Firecracker orchestrator、VM 内的 `envd`、边缘 client proxy、模板构建器和数据存储集成。官方架构把 PostgreSQL、Redis、ClickHouse、对象存储、API、orchestrator、client proxy 和 `envd` 都列为运行时组成部分，而不是把 E2B 简化成一个远程 `exec` API。

E2B Cloud 是托管服务；E2B BYOC 将数据面放入用户自己的 AWS、GCP 或 Azure 账户；E2B Embed 则是 Apache-2.0 的单机部署包，使用真实 Firecracker，但官方明确把它定位为单机/评估形态，而不是生产多机部署方案。

### 1.2 CubeSandbox 也不只是一个 E2B API 兼容层

CubeSandbox 提供 E2B 兼容的 API/SDK 表面，但内部是自己的 CubeAPI、CubeMaster、Cubelet、CubeShim、CubeHypervisor、CubeCoW、CubeVS、CubeEgress 和 CubeProxy 体系。

因此，“E2B-compatible”主要表示：应用可以复用相近的 Sandbox、文件、命令、PTY、Volume 和网络调用方式；它不表示 E2B SDK 可以无条件直连 CubeSandbox，也不表示两个系统的状态、错误、快照或 Volume 语义完全相同。CubeSandbox v0.7.2 还明确移除了旧的 E2B SDK reference，Python SDK 的命令执行改走自己的 `envd` Connect RPC，这进一步说明兼容层仍在演进。

## 3. 总体对比表

| 维度 | E2B | CubeSandbox | 对 DSH Cloud Agent 的含义 |
|---|---|---|---|
| 虚拟化 | Firecracker microVM，每个 Sandbox 独立 kernel | KVM microVM，每个 Sandbox 独立 kernel | 两者都比共享 kernel 容器更适合运行不可信 Agent 工具 |
| 控制面 | API、PostgreSQL、Redis、ClickHouse、client proxy | CubeAPI、CubeMaster、Redis/部署相关数据库、CubeProxy、CubeOps | E2B 的控制面分工更成熟；Cube 的组件更适合自定义但运维责任更大 |
| 数据面 | 每节点 Go orchestrator，Firecracker、NBD、cgroup、网络 namespace | 每节点 Cubelet/CubeShim/CubeHypervisor，CubeCoW、CubeVS、CubeEgress | 都能作为 DSH runtime 的隔离执行器 |
| 快照模型 | 预启动模板、COW rootfs、内存 diff、pause/resume、fork | CubeCoW、snapshot、clone、rollback、pause/resume、S3 跨节点 snapshot | Cube 的显式 rollback/clone 更适合实验分叉；两者都不能替代 Session checkpoint |
| 持久 Volume | 有 Volume API；开源 runtime 当前实现与本地目录/NFS v3 有关，跨 orchestrator 节点共享是公开待改进项 | v0.7.2 提供 E2B-compatible Volume plugin，支持 JuiceFS 等后端 | Workspace 设计必须验证真实后端；不能只看 API 名称 |
| 网络隔离 | 每 Sandbox nftables、SNI/Host 检查的 allow/deny；自定义 proxy 仍有部署差异 | CubeVS eBPF + CubeEgress L7 TPROXY、域名/路径/方法策略 | Cube 对自托管 egress 控制更深；E2B Cloud/BYOC 省运维 |
| 凭据 | E2B Cloud/BYOC 提供 secrets/workload identity 等能力；Embed 明确不含 secrets、volumes、workload identity、BYO proxy | CubeEgress 可在转发时注入 header，真实 key 不进入 Sandbox | 长期租户模型密钥保护要优先验证部署版本和覆盖范围 |
| 部署 | Cloud、BYOC、单机 Embed；完整生产能力与部署选项相关 | 裸机、Kubernetes preview、Terraform/Tencent Cloud、自托管 | E2B 更适合快速落地；Cube 更适合掌控基础设施 |
| 语言/实现 | Go runtime，Firecracker 及多个服务 | Rust API/Hypervisor/SDK 组件、Go orchestration、OpenResty/Lua、eBPF | 两者都不是轻量 Node 插件；外围控制面应与 executor 解耦 |
| 开源许可证 | E2B Runtime Apache-2.0；E2B Cloud/BYOC 是产品服务 | CubeSandbox Apache-2.0 | 可研究、可自托管，但商业服务、支持和功能范围仍需单独评估 |
| 公开成熟度信号 | E2B 自称已运行 1B+ sandboxes；runtime 仓库约 1.7k stars、7,600+ commits | CubeSandbox v0.7.2，约 12.7k stars、1.2k forks，release 自述 56 commits/29 contributors | Star 和自报使用量不能替代安全、故障和租户验收 |

## 4. 隔离模型：Firecracker 与 KVM microVM 的差异没有宣传语那么大

E2B 使用 Firecracker microVM；CubeSandbox 使用 CubeHypervisor/RustVMM 与 KVM microVM。两者都给每个 Sandbox 一个独立 guest kernel，因此都明显不同于“每租户一个 Docker 容器但共享宿主 kernel”。

从 DSH 的威胁模型看，两者都适合作为不可信工具执行边界：Agent 可能执行模型生成的 shell、编译器、浏览器脚本、依赖安装和第三方代码，执行器不应把宿主文件系统、控制面凭据或其他租户进程暴露给它。

但 microVM 不是完整安全结论。两者都仍依赖：

- 宿主机 kernel、KVM 和 hypervisor 的安全性；
- 模板构建器、镜像 registry 和 guest kernel 发布链；
- API、orchestrator、Cubelet/Firecracker 管理权限；
- 网络和 egress 策略是否真正覆盖所有路径；
- Volume、缓存、日志和管理面是否发生跨租户泄漏。

因此，E2B 的 Firecracker 与 CubeSandbox 的 KVM microVM 在“执行隔离”层面是同一类答案，而不是 DSH 云平台安全性的全部答案。

## 5. 控制面：E2B 更像完整平台，Cube 更像可组合基础设施

### 4.1 E2B 的控制面

E2B Runtime 的公开架构将持久实体和运行态拆开：PostgreSQL 保存 teams、templates、builds、snapshots、volumes 等控制面实体；Redis 保存 running sandbox、sandbox 到 node 的路由、缓存、限流和协调状态；ClickHouse 保存事件、指标和部分日志；对象存储保存 template/snapshot artifacts。

这一分层对于 Cloud Agent 很有参考价值：创建 Sandbox、调度节点、路由请求、采集事件和保存模板并不是同一个事务，但系统明确了每个状态的归属。

E2B 还提供 team/API key/OIDC 等认证路径、quota/rate limit、dashboard、metrics、logs、events/webhooks 等平台能力。对于想快速验证 DSH 长任务的团队，这意味着外围平台需要自己补的内容较少。

### 4.2 CubeSandbox 的控制面

CubeSandbox 的公开架构强调 CubeAPI/CubeMaster 的控制面无本地状态，Redis 用于 Sandbox metadata、生命周期事件、CubeProxy 路由表和分布式协调；数据面由每个节点的 Cubelet、CubeShim、CubeHypervisor、CubeCoW、CubeVS、CubeEgress 和 CubeProxy 负责。

这种设计适合自托管集群和组件替换，但也意味着部署者必须认真处理 Redis、控制面数据库、节点注册、路由、版本矩阵、模板和 Volume plugin 的运维。Cube 的 Kubernetes 部署文档还把 MySQL/Redis、CubeAPI、CubeMaster、CubeProxy、CubeOps 和 compute node 分开描述；不能把“部署了 Helm chart”理解为已经获得完整的 Cloud Agent HA 和灾备。

### 4.3 对 DSH 的选择

如果目标是两周内证明“DSH Agent 能在后台运行、浏览器断开后仍可查看状态”，E2B 的 API 和控制面更省工作。

如果目标是长期运营自己的租户平台，控制模型密钥 egress、挂接自定义 Workspace 存储、把执行器放进自己的节点和网络，CubeSandbox 的可组合性更有吸引力，但我们必须承担控制面、节点、存储和安全升级。

## 6. 生命周期与恢复：最容易被误判的差异

### 5.1 两者都把“创建”优化成恢复快照

E2B 的模板是预启动 VM 的内存、磁盘和机器状态；创建 Sandbox 主要是从快照恢复，内存页按需加载，rootfs 使用 COW overlay。CubeSandbox 也使用模板、预快照和 CubeCoW，让 Sandbox 创建从“完整启动一台机器”变成“复制或恢复已准备好的状态”。

这解释了两者都能做到低延迟启动，也解释了为什么它们特别适合 Agent：每个 Cloud Run 可以获得一个有文件、工具、浏览器或服务状态的完整 Linux 执行环境，而不是每次从空容器开始。

### 5.2 E2B 的 pause/resume/fork

E2B 支持 pause/resume、idle auto-pause、按流量自动唤醒，并支持从运行中的 Sandbox fork 出多个 Sandbox。E2B 文档把这些能力暴露给 SDK，开发者可以把一个会话当成可以暂停、恢复或分叉的执行机器。

E2B 的优势是这些能力已经与 API、路由、模板、对象存储和 client proxy 组合在一个成熟运行时中。限制是：恢复 Agent 的“机器状态”仍然不等于恢复 DSH 的“模型事件、tool result、ownership 和外部副作用”。

### 5.3 CubeSandbox 的 snapshot/clone/rollback

CubeSandbox 的 CubeCoW 支持 snapshot、clone 和 rollback，官方把它定位为百毫秒级的高频 checkpoint、实验分叉和状态回滚；v0.7 系列还加入了 S3 后端的跨节点 pause/resume 和 snapshot-based launch。

在执行实验和代码变更方面，Cube 的显式 rollback/clone 语义比单纯的 pause/resume 更适合：

```text
snapshot(before-task)
  → run long task
  → test
  → rollback
  或 clone multiple experiments
```

但这个 rollback 主要描述 VM/rootfs/snapshot state。若 Workspace 是外部 Volume，Volume 的当前内容可能不会随着 VM rollback 回到 snapshot 时刻；若任务已经调用外部 API，外部副作用也不会回滚。

### 5.4 对 DSH Cloud Run 的正确恢复模型

无论选择谁，都要额外保存：

```text
cloudRunId
sessionId
lastDurableSessionSeq
workspaceId
workspaceGeneration
sandboxId
runtimeLease
lastOperationId
recoveryPolicy
```

因此：

```text
E2B/Cube snapshot
    = 执行器 checkpoint

DSH Session flush
    = 模型可见事件 checkpoint

Workspace generation
    = 文件状态 checkpoint

Cloud Run record
    = 业务任务和 ownership checkpoint
```

四者必须在交接和恢复协议中绑定，不能用 Sandbox ID 代替。

## 7. 持久化 Volume：CubeSandbox 在自托管场景更有潜力，但 E2B 的现状必须看清

### 6.1 E2B Volume 的边界

E2B 有独立的 Volume API 和 Volume Content API，Volume 生命周期由控制面管理，文件内容通过单独的 content service 访问。公开的 E2B Runtime 架构文档还说明，当前开源实现的 Volume 内容由本地目录通过 NFS v3 提供，跨不同 orchestrator 节点共享并不是当前实现的强项；相关的可插拔分布式 Volume backend 仍以公开 issue 形式推进。

这带来一个重要区别：E2B Cloud 的托管存储能力不能直接等同于“我们下载 E2B Runtime 后就得到同样的多节点 Workspace 存储”。自托管部署必须按具体版本和后端验证：Volume 位于哪个节点、能否跨节点 attach、NFS cache 和 lock 如何工作、节点故障后是否仍可恢复。

### 6.2 CubeSandbox Volume framework

CubeSandbox v0.6 引入 Volume framework，v0.7.2 增加 JuiceFS Volume plugin。Volume 可以独立于 Sandbox 生命周期，使用插件接入 COS、NFS、JuiceFS 等后端，并通过 E2B-shaped `volumeMounts` 映射挂载。

这对 DSH Workspace 更灵活：我们可以选择一个跨节点后端，把 `/workspace`、DSH Session、HOME、浏览器 profile 和工具缓存放在 Volume 中；也可以按租户选择不同后端或只读/读写挂载。

但是“Volume API 支持持久化”仍然不等于“Workspace 有统一版本”。需要额外回答：

- Volume metadata 和对象数据是否同时备份；
- attach、detach、writeback、fsync 和 crash 的语义是什么；
- 多个 Sandbox 是否能同时读写同一 Volume；
- clone/snapshot 是否复制 Volume 内容，还是只复制挂载引用；
- rollback 是否回滚 Volume；
- Volume 删除和 snapshot 引用如何协调。

### 6.3 JuiceFS over S3 的比较结论

CubeSandbox 的 JuiceFS plugin 让“对象存储 + POSIX-like 文件系统 + 跨节点挂载”成为可选路径，但 JuiceFS metadata database 是文件系统的一部分，不能只备份 S3 对象。HamsterHQ 的本地集成文档也明确记录了这一点。

因此在 DSH 中，S3/Volume 适合做 durable Workspace backend，但不能直接替代 WorkspaceFS 的 generation、GC、quota、lock 和 checkpoint 协议。

### 6.4 这一维度谁更好

```text
托管云 / 快速验证：E2B 更省心
自托管 / 可插拔跨节点 Workspace：CubeSandbox 更有潜力
默认就得到强一致 Workspace：两者都不能直接承诺
```

## 8. 网络、安全和模型凭据

### 7.1 E2B

E2B Runtime 的开源架构包含 per-sandbox nftables egress firewall，并支持基于 SNI/Host 的域名 allow/deny；E2B Cloud/BYOC 的企业资料还描述了 egress 策略、秘密在 egress 解析、workload identity、OTLP 和 signed lifecycle webhooks 等能力。

但 E2B 的能力要按部署形态区分：E2B Cloud/BYOC 的企业功能不等于 E2B Embed 自带功能。官方 E2B Embed 说明明确写出：Embed 不包含 secrets、volumes、workload identity 或 BYO proxy。若我们以 Embed 做本地实验，不能据此证明生产 BYOC 的密钥隔离能力。

### 7.2 CubeSandbox

CubeSandbox 把网络分成两层：CubeVS 用 eBPF 做 L3/L4 隔离、策略、SNAT 和流量路径控制；CubeEgress 使用 OpenResty/Lua、TPROXY 和 TLS interception 做域名、SNI、host、path、method 等 L7 规则。

CubeEgress 的一个关键能力是 header credential injection：真实模型 API key 留在 egress 规则侧，Sandbox 发出逻辑请求，代理在转发时添加真实 Authorization header，并记录审计事件。这样 DSH 进程不必把真实 key 放进环境变量、Session、文件或模型上下文。

这对多租户 Cloud DSH 很有吸引力，但不能忽略前提：目标 endpoint 必须经过可覆盖的 HTTP/HTTPS 路径，Sandbox 必须正确安装并信任代理 CA，allowlist/DNS/策略不能被绕过，管理面和审计日志不能泄漏凭据。

### 7.3 这一维度谁更好

```text
默认产品化安全和合规材料：E2B 更成熟
自托管 L7 策略、凭据注入和审计可编程性：CubeSandbox 更强
真正的租户授权、RBAC、密钥轮换和审计保留：两者都需要外围 Cloud Control Plane
```

## 9. API 和 DSH 集成成本

### 8.1 E2B 的集成方式

E2B 的 SDK 面向 JavaScript/TypeScript、Python 等生态，公开表面包括 Sandbox、commands、files、PTY、端口、模板、Volume、pause/resume、fork 和 metrics/logs。DSH Cloud Control Plane 可以把 E2B 当作标准 executor：创建 Sandbox，启动 DSH，注入 runtime config，接收事件，通过 Sandbox URL 或 tunnel 连接。

E2B 的缺点不是 API 不够，而是 DSH 需要的业务语义不属于 E2B：Session ownership、Session flush、Cloud Run checkpoint、DSH plugin lifecycle、Workspace generation、交接和模型 provider policy 仍需自己实现。

### 8.2 CubeSandbox 的集成方式

CubeSandbox 的 E2B-shaped API 可以降低迁移成本，SDK 也提供 Sandbox、Volume、命令、文件、PTY、snapshot、rollback 和 clone 等能力。但应使用 CubeSandbox 自己的 SDK/协议，不要假设官方 E2B SDK 可以直接连接 CubeAPI。

Cube 的集成工作还包括：CubeAPI/CubeMaster/Cubelet 版本矩阵、模板构建、KVM 节点、CubeProxy、CubeVS、CubeEgress、Volume plugin、S3/Redis/数据库和节点运维。

### 8.3 DSH runtime 的推荐接入方式

无论使用哪个 executor，都不建议让 DSH core 直接依赖 E2B/Cube SDK。推荐保持以下接口：

```typescript
interface CloudExecutor {
  create(request: CreateSandboxRequest): Promise<ExecutorHandle>
  connect(handle: ExecutorHandle): Promise<ExecutorConnection>
  pause(handle: ExecutorHandle): Promise<PauseReceipt>
  resume(handle: ExecutorHandle): Promise<ResumeReceipt>
  snapshot(handle: ExecutorHandle): Promise<SnapshotReceipt>
  rollback(handle: ExecutorHandle, snapshot: SnapshotId): Promise<RollbackReceipt>
  destroy(handle: ExecutorHandle): Promise<DestroyReceipt>
}
```

E2B 和 CubeSandbox 只实现这个 adapter；DSH Cordis plugin、Session checkpoint 和 Browser Native handoff 位于 adapter 之上。

## 10. 部署和运营成本

### 9.1 E2B

使用 E2B Cloud 时，团队不需要运维 Firecracker 节点、模板缓存、client proxy、PostgreSQL、Redis、ClickHouse 和对象存储；代价是依赖供应商、区域和产品计划。

BYOC 把数据面放入用户自己的云账户，但仍是 E2B 运营的部署，不等于完全自托管。E2B Embed 可以单机自托管，但官方明确它是单机产品/评估包，不包含全部企业安全和存储能力。

因此 E2B 的选择实际上有三个层次：

```text
E2B Cloud
    最低运维，最高供应商依赖

E2B BYOC
    数据面在自己的云账户，仍依赖 E2B 运营和商业部署

E2B Embed / Runtime 自运维
    最大控制力，但需要自己处理 Linux/KVM、集群、存储和升级
```

### 9.2 CubeSandbox

CubeSandbox 的优势是 Apache-2.0、自托管和组件可替换；可以运行在裸机、Kubernetes 或 Terraform/Tencent Cloud 路线，并允许自己决定 S3、Volume、网络、节点和控制面。

代价是必须运营一整套基础设施：KVM 节点、CubeAPI/CubeMaster/Cubelet/CubeProxy/CubeOps、Redis/数据库、模板和 kernel/guest artifacts、eBPF/TPROXY、S3/Volume metadata、证书/CA、版本兼容、节点 drain、恢复和安全升级。

这不是 Cube 的缺点，而是它与 E2B Cloud 的产品边界不同。

### 9.3 成熟度信号应如何解读

截至 2026-10-05，E2B Runtime GitHub 页面显示约 1.7k stars、460 forks 和 7,600+ commits；E2B 的 SDK 仓库显示约 14.2k stars、1.1k forks。E2B 官方还自报已启动 1B+ sandboxes、月 SDK 下载量 10M+，但这是供应商自述，不是独立审计数据。

CubeSandbox 的 `v0.7.2` 于 2026-09-24 发布，release 页面写明该版本包含 56 commits、29 contributors，并新增 JuiceFS Volume plugin、跨节点恢复读优化和 idle guest memory reclaim；仓库页面显示约 12.7k stars、1.2k forks。Star 数和 release 活跃度说明公开关注度高，不能直接证明生产安全、性能或长期维护承诺。

更实用的成熟度判断是：E2B 的产品化、托管服务、BYOC、文档和企业安全材料更完整；CubeSandbox 的开源基础设施暴露面和自托管可塑性更强，但部署者需要自己承担更多验证和运维责任。

## 11. 针对 DSH Cloud Agent 的选择矩阵

| 场景 | 推荐 | 原因 |
|---|---|---|
| 两周内验证 DSH 长任务交接 | E2B Cloud 或 BYOC | API、生命周期、路由和运维最省工作 |
| 自己运营多租户 Sandbox 平台 | CubeSandbox 优先评估 | eBPF egress、凭据注入、Volume plugin 和节点控制更直接 |
| 需要客户数据留在客户云账户 | E2B BYOC 或自托管 CubeSandbox | E2B BYOC 更省运维；Cube 控制力更高 |
| 需要严格控制模型 key 不进 DSH | CubeSandbox + CubeEgress，或 E2B 企业 secrets/workload identity | 两者都可行，但 Embed 不足以证明 E2B 企业能力 |
| 需要跨节点可挂载 POSIX-like Workspace | CubeSandbox + 合适 Volume plugin | E2B 开源 runtime 当前 Volume 跨节点能力需谨慎验证 |
| 需要高频 rollback/clone 实验 | CubeSandbox 倾向更强 | CubeCoW 显式强调 snapshot/clone/rollback；E2B 也有 pause/fork |
| 不想运维 KVM 集群 | E2B Cloud | 把 executor 运维交给供应商 |
| 想避免长期供应商绑定 | CubeSandbox 或自运维 E2B Runtime | 两者 runtime 都开放，但 E2B Cloud 的平台服务仍是商业边界 |
| 需要完整 DSH Web UI/插件生态 | 两者都需要 DSH runtime adapter | E2B/Cube 只负责执行机器，不负责 DSH 产品语义 |

## 12. 推荐架构

对我们的项目，推荐采用“统一 Cloud Run 协议，多 executor 后端”：

```text
Browser Native DSH
    │
    │ handoff(session checkpoint, workspace generation)
    ▼
Cloud Agent Control Plane
    │
    ├── E2B adapter       → E2B Cloud / BYOC / Embed
    └── Cube adapter      → CubeSandbox self-hosted cluster
    │
    ▼
DSH Runtime Adapter
    │
    ├── DSH profile
    ├── Cordis plugins
    ├── tunnel / runtime identity
    ├── Session event forwarding
    └── Workspace attach
```

第一阶段可以用 E2B Cloud/BYOC 快速验证：

```text
create Cloud Run
→ create E2B Sandbox
→ start DSH headless/web backend
→ attach Workspace
→ run long task
→ browser disconnect
→ browser reconnect and follow events
```

第二阶段用 CubeSandbox 验证自托管关键能力：

```text
same Cloud Run protocol
→ create Cube Sandbox
→ configure CubeEgress credential policy
→ attach JuiceFS/S3-backed Volume
→ pause/resume or cross-node restore
→ validate Session/Workspace checkpoint pairing
```

如果第一阶段就必须自托管，直接从 CubeSandbox 开始也合理；但不要因为 API 与 E2B 相似，就把 Cube 当成 E2B 的无缝替代品。

## 13. 最终判断

### 谁更成熟

如果“成熟”指托管服务、企业部署、文档、SDK、控制面和运营能力，E2B 更成熟。

如果“成熟”指自托管基础设施的可见性、可改造性、执行层网络安全和可插拔存储方向，CubeSandbox 更有吸引力，但仍需要针对目标部署做更严格的验证。

### 谁更适合 DSH Cloud Agent

没有一个单一答案：

```text
最快得到可用 Cloud Agent：E2B
最适合做自托管执行基础设施：CubeSandbox
最适合长期产品架构：自己的 Cloud Run + Runtime Adapter
```

对 DSH 而言，真正要拥有的是：

- Browser Native 与 Cloud Agent 的 handoff 协议；
- Session 与 Workspace 的 paired checkpoint；
- Cloud Run ownership、lease、fencing 和恢复；
- DSH Cordis runtime adapter；
- 统一事件、审计、配额和权限模型。

E2B 或 CubeSandbox 都只能拥有执行器层。

## 14. 证据与限制

本报告的 E2B 事实主要来自 E2B 官方 `runtime` 仓库 README、`docs/ARCHITECTURE.md`、E2B Enterprise/Embed 官方页面、SDK/API 文档和官方 GitHub release 页面；CubeSandbox 事实主要来自 TencentCloud/CubeSandbox 官方 README、架构文档、OpenAPI、Volume、Security Proxy 文档和 `v0.7.2` release 页面。

E2B 的“1B+ sandboxes”“10M+ monthly SDK downloads”“94 Fortune 100 signed up”等数字属于 E2B 官方自述，不是本报告独立审计结果。CubeSandbox 的 stars、forks、issue、contributors 和 release 内容也只能作为公开活动信号。

本报告没有在本机启动 E2B Runtime 或 CubeSandbox 集群，没有完成真实的跨节点恢复、Volume 故障、eBPF 逃逸、凭据泄漏和 DSH 长任务验收。尤其需要把 E2B Cloud/BYOC/Embed、CubeSandbox 单节点/Kubernetes/S3 Volume/JuiceFS plugin 分开测试，不能用一种部署形态的结果替代另一种。

## Further Exploration

### E2B 官方资料

- [E2B Terms of Service](https://e2b.dev/terms)
- [E2B Security](https://e2b.dev/security)
- [E2B official GitHub organization](https://github.com/e2b-dev)
- [E2B Runtime](https://github.com/e2b-dev/runtime)
- [E2B Runtime architecture](https://github.com/e2b-dev/runtime/blob/main/docs/ARCHITECTURE.md)
- [E2B Runtime releases](https://github.com/e2b-dev/runtime/releases)
- [E2B Enterprise and deployment options](https://e2b.dev/enterprise)
- [E2B Embed](https://e2b.dev/resources/introducing-e2b-embed)
- [E2B Sandbox SDK reference](https://e2b.dev/docs/sdk-reference/js-sdk/v2.6.2/sandbox)
- [E2B Volume API](https://e2b.dev/docs/api-reference/volumes/get-volumes)
- [E2B distributed Volume backend issue](https://github.com/e2b-dev/runtime/issues/3195)

### CubeSandbox 官方资料

- [CubeSandbox repository](https://github.com/TencentCloud/CubeSandbox)
- [CubeSandbox LICENSE](https://github.com/TencentCloud/CubeSandbox/blob/master/LICENSE)
- [CubeSandbox NOTICE](https://github.com/TencentCloud/CubeSandbox/blob/master/NOTICE)
- [Architecture overview](https://github.com/TencentCloud/CubeSandbox/blob/master/docs/architecture/overview.md)
- [OpenAPI](https://github.com/TencentCloud/CubeSandbox/blob/master/openapi.yml)
- [Persistent storage](https://github.com/TencentCloud/CubeSandbox/blob/master/docs/guide/persistent-storage.md)
- [Volume plugin](https://cubesandbox.com/guide/volume-plugin)
- [S3 Volume](https://cubesandbox.com/guide/s3-volume)
- [Security Proxy](https://cubesandbox.com/guide/security-proxy)
- [v0.7.2 release](https://github.com/TencentCloud/CubeSandbox/releases/tag/v0.7.2)

### DSH 相关研究

- [DSH 云端 Agent 架构建议](dsh-cloud-agent-architecture-recommendation.md)
- [CubeSandbox 深度调研](dsh-cubesandbox-deep-research.md)
- [三个本地项目代码解读备忘录](dsh-cloud-projects-local-code-reading-memo.md)
