---
description: "基于本地 checkout 深入解读 dshcloud、dsh-multi-tenant 和 HamsterHQ 的代码、部署边界、隔离模型、持久化语义与验证证据。"
---

# DSH 云端项目本地代码解读备忘录

**研究状态：首轮代码解读完成，文档核验进行中；首轮本地盘点日期：2026-10-05**

## 研究目的

这份备忘录用于记录对三个本地 checkout 的代码级解读，不把 README 的产品描述直接当成实现事实。目标是回答：每个项目究竟运行了哪些官方 DSH 组件，哪些能力由外围平台新增，租户隔离和凭据边界在哪里，Session、Workspace、Sandbox 和 Gateway 的持久化语义是否一致，以及它们与当前 browser-native DSH PoC 的关系。

本备忘录是工作记录，不是最终对外报告。完成三个项目的代码、配置和测试交叉阅读后，再把稳定结论整理回 [`dsh-cloud-agent-oss-landscape-review.md`](dsh-cloud-agent-oss-landscape-review.md)。

## 本地证据快照

| 项目 | 本地路径 | 分支 | HEAD | HEAD 日期 | 初步定位 |
|---|---|---|---|---|---|
| `dshcloud` | `~/Documents/eskim2001/dshcloud` | `main` | `14e615e` | 2026-09-20 | 单机自托管控制面、Workspace 容器和宿主机隔离 |
| `dsh-multi-tenant` | `~/Documents/GuoMonth/dsh-multi-tenant` | `main` | `5367975` | 2026-09-29 | Kubernetes/OIDC/每用户环境和 PVC 生命周期平台 |
| `HamsterHQ` | `~/Documents/HuChundong/HamsterHQ` | `main` | `b88bb9f` | 2026-09-24 | 独立 Gateway、每租户 DSH backend、Cordis 插件和 Sandbox |

三个 checkout 在首轮盘点时均为干净工作区，并且各自的 `main` 跟踪 `origin/main`。本地研究不会修改这三个外部 checkout；所有解读、证据摘录和后续修订只写入当前 DSH 仓库的 `docs/drafts/`。

## 证据等级

本地源码和实际测试结果优先于 README；部署文档优先于营销描述；项目自述的成熟度只记录为项目方声明。对没有执行的安装、容器启动、双用户隔离或真实模型验收，不写成“已验证”。

每个项目至少按以下顺序检查：

1. 根 package、workspace、Docker/Compose/Helm 和启动脚本，确定真正的运行拓扑。
2. 身份认证、路由、WebSocket/tunnel 和 DSH 连接建立路径，确定租户边界是否覆盖所有入口。
3. Session、Workspace、volume、数据库和对象存储代码，区分控制面持久化与运行时状态持久化。
4. Sandbox、容器权限、网络规则、模型凭据和宿主机挂载，确定隔离假设和逃逸后果。
5. 测试、验证脚本、CI 和发布文件，确认项目实际证明了什么，以及没有证明什么。

## 首轮共同观察

三个项目都不是“给 DSH 增加一个 tenant 字段”这么简单，而是在 DSH 外部建立了不同程度的控制面和运行环境边界。它们的共同假设是：不可信租户不能共享同一个进程级 DSH Web/API 状态，因此隔离单位至少应接近独立进程，实际通常是容器、Pod 或 microVM。

三个项目的核心差异不在于是否有登录页，而在于它们把以下对象放在哪里：

```text
租户身份
DSH 进程与 Web/API 状态
Session event log
Workspace 文件和用户 home
正在运行的 shell、PTY、浏览器和工具
模型凭据
Gateway/tunnel ownership
```

初步判断是：`dshcloud` 更像单机控制面产品，`dsh-multi-tenant` 更像 Kubernetes 环境分配器，HamsterHQ 更像以 Cordis 插件和 outbound tunnel 连接 DSH runtime 的隔离平台。它们都主要让浏览器访问服务端 Agent Runtime，不是 browser-native Agent Loop。

## 解读顺序

### 第一阶段：`dshcloud`

重点阅读 `docs/ARCHITECTURE.md`、`docs/SECURITY-HARDENING.md`、`docs/PRODUCTION-READINESS.md`、`docker/`、`apps/`、`packages/`、`scripts/install.sh` 和测试。需要确认控制面如何启动 Workspace、Workspace 容器如何访问宿主机数据、Docker socket 和 `CAP_SYS_ADMIN` 的实际作用、Traefik 入口是否覆盖 WebSocket 和 Workspace ownership，以及“持久化数据”到底覆盖哪些状态。

#### 代码级结论

`dshcloud` 的实际拓扑是 React/Vite 管理台、Fastify 控制面、Drizzle/PostgreSQL 元数据、Docker runtime driver、每个 Workspace 一个 DSH 容器，以及 Traefik、forward-auth 和容器内 Caddy 组成的入口链路。它的隔离单位不是租户字段或共享 DSH 进程，而是一个独立容器、独立网络、独立宿主回环端口和独立数据目录。

控制面 `instance` 记录 owner、slug、storage key、镜像、容器 ID、宿主端口、CPU、内存、进程数和磁盘声明、上一个镜像以及生命周期状态，但真正的用户内容不在 PostgreSQL 中。容器的数据目录至少承载 `/data/home/workspace`、用户 home、DSH 配置和 Session 数据，因此 PostgreSQL 控制面备份不能单独恢复一个可用的 DSH Workspace。

实例创建大致遵循“落库、准备 storage、创建并启动容器、更新状态、同步 Traefik 路由”的顺序。启动时如果原容器仍在则先确保 storage 再启动；如果容器消失则重建容器；如果卷或配额注册记录消失，则拒绝静默创建空卷。这一拒绝路径很重要，因为它避免把数据丢失伪装成一次正常的空 Workspace 启动。

镜像升级不是 Session、Workspace 和运行态的一体化事务，而是控制面执行“停止容器、复制 `/data` 到 `.prev`、写入新镜像、重建容器，失败后恢复旧镜像和快照”的补偿式流程。它提供了一次升级前数据副本和旧镜像回退，但不是内容版本树、跨请求 checkpoint 或跨运行态的原子恢复点。

存储配额在 Linux 池化部署中依赖宿主目录和 XFS project quota，并同时限制字节数和 inode 数；没有宿主池时，Docker named volume 中的 `diskMb` 主要是声明或标签，不能证明硬磁盘限额已经生效。因此 macOS 或 Docker Desktop 上的开发启动不能替代 Linux 生产配额验收。

入口授权分成平台入口和容器内入口两层。平台侧根据 Host 解析 Workspace slug，校验 Better Auth session 和 instance owner，对写请求检查 Origin，注入每实例 HMAC gate token，并过滤平台 Cookie。HTTP 和 WebSocket 转发都重新执行 owner、instance、目标端口和 access lease 检查；授权失效时关闭流或 WebSocket。首次访问通过一次性 grant/state 交换 Workspace cookie，避免把平台控制台 session token 直接交给 DSH。

容器内 Caddy 再检查平台注入的 gate token，让 DSH 使用入口 token 换本地 Cookie，并反向代理 DSH。它调整 DSH 的 `SameSite=Strict` Cookie 为 `Lax`，对失效 Cookie 做 401 自愈，并为 SSE 保持非缓冲传输。`owns-host.mjs` 和 `owns-host.yml` 通过启动补丁把 `__DSH_TRANSPORT__.ownsHost` 注入 Web 客户端，使远程域名访问时 DSH 仍把 Host 视为受控 Host，从而保留 settings persistence；这依赖 DSH Web 客户端的内部部署约定，DSH 升级时必须重新验证。

容器 runtime driver 设置只读根文件系统、丢弃全部 Linux capabilities、`no-new-privileges`、受限的 `/tmp` 和 `/run` tmpfs、固定 UID/GID、CPU/内存/PIDs 限制、独立网络和日志滚动，部分部署还用 lxcfs 隐藏宿主信息。但控制面需要 Docker socket，Docker 仍共享宿主内核，Docker Desktop 的 `host.docker.internal` 还会破坏 Linux 上“容器不能访问宿主回环”的假设，所以这套隔离不能被描述为抵御容器运行时或内核逃逸的完整安全边界。

`OperationQueue` 只在单个控制面进程内串行化生命周期操作，不是 PostgreSQL 锁、跨副本 fencing 或 Workspace 写入事务。runtime node 对请求并发和 mutation 单写有限制，reconciler 能发现容器、端口和数据库状态漂移，但不能把 PostgreSQL、`/data`、DSH Session、shell/PTY、浏览器进程和外部副作用恢复成同一个提交域。

综合源码证据，`dshcloud` 应被归类为“功能表面较完整的单机自托管 DSH Workspace 平台原型”：它认真处理了入口授权、实例生命周期、数据卷防静默丢失、镜像升级回滚和容器加固；但它不是共享进程多租户，也没有证明 Session、Workspace 文件、运行中工具和外部副作用拥有统一恢复点。以上结论来自 `apps/server/src/instance/`、`apps/server/src/runtime/docker/`、`apps/server/src/http/`、`docker/instance-image/` 和 `packages/instance-spec/` 的源码阅读；本地尚未安装依赖或实际启动该项目，因此不把运行时行为写成已验证事实。

### 第二阶段：`dsh-multi-tenant`

重点阅读 `packages/`、`charts/`、`integration/`、安装器和 `dsh-isolated-runtime` 的依赖/制品契约。需要确认 OIDC 身份如何映射到环境、环境 UID/PVC/namespace 如何绑定、停止/恢复/删除的状态机、单平台副本限制和跨节点风险，以及原生 DSH UI 是如何被转发到每用户环境的。

#### 代码级结论

这个项目把“平台控制面”和“用户环境 runtime”明确拆成两个仓库的契约。当前 checkout 发布包是 `dsh-multi-tenant@0.10.0-alpha.1`，固定 DSH runtime 为 `0.2.0-rc.2`；本仓库通过 `vendor/dsh-environment-connector-internal-*.tgz` 消费一个窄的、同进程 Connector，而不是暴露公开 runtime wire protocol 或可插拔后端工厂。

平台只保存授权和资源绑定，不保存用户文件或 DSH 对话内容。`EnvironmentBindingStore` 使用私有权限的 SQLite 文件保存每个 `(tenantId, principalId)` 的稳定环境 ID、随机 allocation key、精确的 Namespace/Sandbox/PVC 引用以及 `reserved`、`submitted`、`bound`、`delete-requested` 和 `pending stop/start` 状态。SQLite 开启 `synchronous=FULL`、独占锁和固定 schema 版本；状态文件损坏或写入结果未知时平台会进入拒绝写入路径，而不是自动换 allocation key 重建资源。

控制面在 Kubernetes 中固定为一个 `Deployment` 副本，策略是 `Recreate`；平台自己的状态使用带 `helm.sh/resource-policy: keep` 的 ReadWriteOnce 控制 PVC，用户环境不在安装阶段预创建。平台 Pod 使用 UID/GID 1000、只读 root filesystem、丢弃全部 capabilities、禁止 privilege escalation、默认 seccomp、禁用自动 ServiceAccount token 挂载，并通过独立 ServiceAccount 和 ClusterRoleBinding 调用 runtime 所需的 Kubernetes API。这个部署形态把“单副本”写进 Chart，而不是通过数据库租约或多副本 fencing 解决控制面 HA。

OIDC 成员不是任意注册用户，而是配置文件中的显式 `(issuer, subject) -> {tenantId, principalId}` 映射。登录成功后，平台生成短期的 parent session，再为具体环境生成最长约 30 分钟的 child access session；session token 只存哈希，成员配置更新时先撤销失去授权或 owner 发生变化的 parent session，再中止所有子连接。HTTP 和 WebSocket 准入均在建立连接前验证环境 owner、session owner 和环境表中的精确绑定，并把 session 的 AbortSignal 传入 runtime 连接。

访问转发不是简单的反向代理。`createPlatformIngress` 对 HTTP 和 WebSocket 分别设置连接上限、超时和 AbortSignal；访问期间如果成员被撤权或 child session 失效，signal 会同时关闭正在转发的 HTTP 流和 WebSocket。runtime `connect` 前后还会重新读取 Sandbox、PVC、Pod、Service 和 EndpointSlice；因此“已经拿到过一个访问 token”不等于可以继续访问后来变成 Stopped、Unavailable 或身份不匹配的环境。

环境坐标由 allocation key 的 SHA-256 前缀计算成 Namespace 和 origin，资源通过 `environment.dsh.io/` annotations 记录 allocation key、owner 和 Sandbox UID。runtime 创建时先以 `Suspended` operating mode 创建 Sandbox，再确认 Namespace 身份，写入 Sandbox UID，创建唯一用户 PVC、ServiceAccount 和 NetworkPolicy，最后用 resourceVersion 条件更新 Sandbox 到 `Running`。如果创建或任一后续写入的结果未知，错误类型要求先读取原 allocation 和 UID，禁止直接换 key 或推断“资源不存在所以可以重建”。

运行模板固定使用不可变 image digest、UID 1000、只读 root filesystem、`RuntimeDefault` seccomp、无自动服务账号 token，以及一个挂载到 `/var/lib/dsh/data` 的用户 PVC 和一个 1 GiB 的临时 `/tmp`。DSH 的 `HOME`、`DSH_HOME`、workspace 工作目录和 npm 用户目录都落在 PVC 目录树中，native conversations、用户安装的工具、配置、凭据和工作区文件因此随 PVC 保留。容器暴露 DSH HTTP 端口 8080 和 runtime management 端口 8081；平台通过 runtime 产生的 origin 转发原生 DSH UI、HTTP API、SSE 和 WebSocket。

每个环境的 NetworkPolicy 只允许平台标签的 Pod 访问工作负载 8080，出站允许 kube-dns，并允许访问公共 IPv4 地址但排除 RFC1918、loopback、link-local、CGNAT、组播和保留地址。它提供了“平台可以进入、环境之间默认不能互入、工作负载不能直接访问常见私网地址”的基线，但不是通用 egress proxy、网络审计或对所有云环境元数据服务的完整阻断证明。工作负载内的 DSH 进程仍以 `DSH_PERMISSION_MODE=danger-full-access` 运行；因此环境隔离依赖 Kubernetes、容器镜像、NetworkPolicy 和宿主安全策略的组合，不应被描述为对同一环境内不同 Session 的工具、HOME 或凭据隔离。

停止路径是这个项目最有辨识度的实现。平台先撤销访问，再读取当前 Pod 和 Sandbox revision，记录 writer Pod UID、Pod resourceVersion、Node UID 和 Kubernetes watch revision，随后把 Sandbox 置为 `Suspended`。runtime 只在确认 writer 节点健康、原 Pod 已进入终止状态、Pod 列表为空、Sandbox 已观测当前 generation 的 `Suspended=True` 且没有 Ready EndpointSlice 时才返回 `Stopped`；否则返回 `StopUnverified` 或其他不确定错误，阻止自动启动第二个 writer。连接撤销和停止观察因此是显式的安全顺序，而不是把 Kubernetes API 返回 202 当成“进程已经停止”。

启动要求原绑定的 Sandbox 处于已确认的 `Stopped`，并使用同一个 Sandbox/PVC 身份；删除也要求先停止并确认 writer，随后对原 UID 和 resourceVersion 使用前置条件删除，返回 `dataRetained: true`，保留用户数据 PVC。删除、PVC 回收、Namespace 清理和私有运行资源的最终关系由 runtime 与上游 Sandbox controller 共同决定；项目文档明确提醒“持久存储不等于备份”，因此 PVC 保留不能替代备份、跨节点灾备或误删恢复方案。

测试证据分成三层。`packages/multi-tenant/tests/` 覆盖 binding 持久化、并发首次进入只提交一次、未知 create 不重放、owner 拒绝、OIDC transaction 一次性消费、撤权关闭 HTTP/WS 和未完成 admission 不转发；安装测试覆盖固定镜像 digest、Chart 对象、私有文件权限、单副本/Recreate、控制 PVC 保留和拒绝 fixture。`integration/e2e/` 还提供 kind、Dex、Traefik、Playwright、两用户生命周期、撤权和模型/工具验收脚本及一份 2026-09-29 的联合验证记录，但本次本地代码阅读没有重跑 Kubernetes 集群、真实模型或工具授权，所以这些记录只能作为仓库保存的验证证据，不能写成我在当前环境重新验证过。

综合判断，`dsh-multi-tenant` 是“原生 DSH Web 应用的 Kubernetes 每用户持久环境平台”，不是 browser-native Agent Loop，也不是通用多租户 DSH API。它最值得借鉴的是：把 owner、allocation key、Sandbox UID、PVC UID 和 revision 作为不可互换的资源身份；把未知副作用写成不可自动重试的状态；把撤权传播到已建立的 HTTP/WS 连接；以及把 Stop 的安全含义定义为对现有 writer 的有界证明。它当前的成熟度仍由项目自己标注为 Alpha、Linux/amd64、单平台副本；备份、高可用、跨节点灾备和通用企业目录不在当前保证范围内。

## 代码阅读的交叉核对

三个本地 checkout 均保持原始 `main` 分支和干净工作区；本研究只读取它们，不安装依赖、不改写外部仓库，也没有在本机重跑 Docker、Kubernetes、CubeSandbox 或真实模型验收。仓库中存在的历史 acceptance/evidence 文档被标记为“项目保存的验证记录”，没有被冒充为本次独立运行结果。

交叉核对后的稳定结论是：`dshcloud` 把控制面和每 Workspace 容器放在同一台宿主机生态中；`dsh-multi-tenant` 把平台绑定、原生 DSH workload 和 Kubernetes 资源身份分层；HamsterHQ 把 Gateway、每租户 DSH 进程、outbound tunnel、volume 和 egress policy 分层。三种设计都把 Agent Loop 留在服务端环境中，因此它们可作为 server-side cloud DSH 参考，但不能作为 browser-native Agent Loop 的现成实现。

对当前 DSH browser-native PoC 最可复用的不是某一个项目的完整代码，而是三组边界：`dshcloud` 的入口授权与实例生命周期、`dsh-multi-tenant` 的未知结果和精确资源身份处理、HamsterHQ 的“原生 DSH 能力通过插件和同源 Gateway 扩展”的分层方式。三者都同时提醒：Session durability、Workspace durability、运行中 Agent/process durability 和外部副作用 durability 必须分别定义和验收。

### 第三阶段：`HamsterHQ`

重点阅读 `gateway/`、`sandbox/`、`packages/`、`compose*.yml`、`verify/` 和 `docs/design.md`。需要确认 tunnel 协议、Gateway session ownership、DSH 本地认证和外部租户认证的叠加方式、Docker 与 CubeSandbox 两条运行路径的差异、模型 key 的 egress 替换机制，以及 Gateway 重启或 Sandbox 回收后的恢复范围。

#### 代码级结论

`HamsterHQ` 是一个独立的、非官方的 DSH 部署项目。它不修改或 vendoring DSH harness，而是在镜像构建时从 npm 安装固定版本的 DSH，并通过 `sandbox/cordis.patch.yml` 加入自己的 Cordis plugins。仓库根部的架构约束把这一点写成硬规则，唯一例外是 `web/patch-loopback.mjs`：它在构建阶段修改 DSH Web 客户端判断 settings persistence 的 loopback 条件，并在镜像检查中验证补丁仍匹配。当前 checkout 的提交 `b88bb9f` 来自 2026-09-24，历史上最近一次 DSH 升级提交为 `e8af7f6`，将依赖升级到 `0.1.7-alpha.2`；本地没有安装依赖或启动完整部署。

它的部署拓扑是 nginx 静态前端、Gateway、PostgreSQL、可选 Admin/Scheduler，以及每个登录用户一个 DSH backend sandbox。浏览器只访问同源 nginx；需要会话的 `/login`、`/logout`、`/_auth` 和 `/api` 由 nginx 代理到 Gateway。Gateway 再根据认证用户把 HTTP 和 WebSocket 请求送进该用户的 sandbox。租户不是在一个 DSH 进程中用字段区分，而是一个独立进程、容器或 microVM；这是因为 DSH 的 `/api` surface 和 Session store 都是 process-wide 的。

Gateway 的 PostgreSQL 是控制面和账户状态库，不是 DSH workspace 的内容库。它保存 accounts、refresh tokens、invites、sign-in codes、sandbox secrets、model keys、sandbox registry、settings 和 audit；`sandboxes` 表记录用户、稳定 account ID、sandbox ID、runtime handle、dial-in token、gateway ID、模板版本和最近使用时间。用户对话、DSH session、workspace、HOME、插件配置和浏览器 profile 则位于 sandbox 的持久 volume 或 Docker 容器可写层中。删除账号会依次撤销 session、释放 sandbox、销毁 volume 并删除账户；回收 idle sandbox 只移除机器，不删除 volume。

真实 CubeSandbox 路径为每个用户创建一个 sandbox 和一个独立 volume。JuiceFS volume 以 account ID 命名，挂载到 `/mnt`，在 `/mnt/workspace` 和 `/mnt/dsh` 下保存 workspace 与 DSH 状态，元数据在 Postgres、数据块在 S3-compatible store，并通过 filesystem capacity 和 per-directory quota 限制容量。Docker runtime 是本机模拟路径：它通过 Docker socket 创建一个带 owner label 的容器，设置内存和 PIDs 限制，但默认没有同等的远程机器或持久 volume 语义。因此 Docker Compose 可以验证路由和插件集成，不能证明 CubeSandbox 的 VM 隔离、JuiceFS 持久化或 egress 注入。

Sandbox 生命周期由 `SandboxManager` 管理。首次并发请求使用进程内 `creating` map 合并创建，同时数据库 `sandboxes.username` 主键作为跨 Gateway 竞态的最终裁决；输了的 Gateway 会销毁自己刚建的 sandbox 并采用数据库中的赢家记录。Gateway 启动时 `adopt()` 读取数据库和 runtime 的 owner 列表：数据库中仍存在且 runtime 仍在的 sandbox 被重新载入内存并等待 tunnel 重连；数据库记录存在但 runtime 已消失的记录被删除；runtime 中没有数据库记录的孤儿被回收。这个设计解决了“Gateway 重启就把所有 tenant sandbox 当孤儿删掉”的历史问题，但它不是跨副本租约或 fencing：`gateway_id` 已记录但尚未用于路由，实际部署仍假设一个可确定的 Gateway 实例承载该 tunnel。

sandbox 回收使用三种信号：tunnel 是否有浏览器连接、Cordis plugin 报告的任意 agent 是否仍为 running、以及最近一次 tunnel activity。`dsh-gateway-tunnel` 监听 `agent/status` 和 `agent/disposed`，对多个 agent/subagent 做集合计数，并把 busy 状态发送给 Gateway；它不会用固定 heartbeat，因为 heartbeat 会反过来让 idle sweep 认为 sandbox 一直活跃。浏览器离开但 Agent 仍在运行时不会回收；没有浏览器且没有 Agent 工作时使用较短的 departed TTL；这证明了“避免回收长时间无浏览器的 Agent turn”，不证明 Agent 任务在 sandbox 被杀掉后可以从中间 step 自动恢复。

隧道是 HamsterHQ 最核心的实现。sandbox 内的 `dsh-gateway-tunnel` plugin 在 DSH 的同一 Node 进程中运行，等待本地 `connection`、`typertGateway` 和 `sessionController` 就绪后，通过 WebSocket 向 Gateway outbound dial-in。Gateway 不需要访问 sandbox 的入站端口；它根据 `x-sandbox-id` 和随机 token 做 fail-closed 授权。Gateway 为每个浏览器请求分配 stream ID，HTTP body 以不超过 512 KiB 的 base64 chunks 传递，WebSocket 文本和二进制帧分别转发，并在 tunnel 断开时关闭该 tunnel 的全部 HTTP/WS streams。未知 frame tag 被忽略，格式错误或 handler 异常只关闭产生问题的 tunnel，避免一个租户的协议错误让整个 Gateway 退出。

隧道不会把 Gateway 的浏览器 Cookie 送进 sandbox。它把 Host 改成 DSH loopback authority，删除 Origin 和 `sec-fetch-site`，并只对 DSH authority 使用 DSH Connection service 发出的本地 Cookie；`/computer` 的 noVNC 请求不带 DSH Cookie。这样 Gateway 的外部会话仍是租户认证边界，DSH 自己只看到一个 sandbox-local browser session。`dsh-sandbox-host` plugin 通过额外的 `/files` channel 为浏览器读取 settings document，`dsh-computer`、`dsh-artifact-panel`、`dsh-tenant-account` 和 `dsh-scheduled-tasks` 则分别补充远程计算机、workspace 面板、账户和租户 schedule；这些是对原生 DSH 的插件扩展，不是重新实现 Agent Loop。

Gateway 外部认证使用短期 JWT access token 和可撤销、轮换的 Postgres refresh token。`callerOf` 统一处理认证和 cookie renewal，logout、禁用和删除通过撤销 refresh token 生效；已签发的 access token 在其短生命周期内仍然有效。租户自己的环境变量存于 `sandbox_secrets`，限制变量名、数量和单值长度，并禁止覆盖 `SANDBOX_ID`、`SANDBOX_TOKEN`、`GATEWAY_TUNNEL_URL` 和整个 `MODEL_` 前缀。创建 sandbox 时先放 tenant secrets，再放 sandbox identity，再放 deployment model configuration，防止 tenant 改写 tunnel 或平台模型路由。

模型凭据策略在两个 runtime 上不同。CubeSandbox 路径把真实 `MODEL_API_KEY` 留在 Gateway/CubeEgress 侧，sandbox 内只得到 `injected-by-egress-policy` placeholder；匹配 `MODEL_BASE_URL` 的 L7 egress rule 在离开 sandbox 时注入真实 Authorization header。这样 prompt injection 即使读取环境变量、文件或进程表，也不能直接读出真实 key，但这只在 endpoint 是可拦截的 HTTP/HTTPS、CubeEgress 规则实际生效且网络路径没有绕过时成立。若没有可用注入，代码会把真实 key 传进 sandbox 以保证模型调用可用；Docker simulation 也不能证明 CubeEgress 的密钥不暴露性质。

持久化语义需要拆开看。Gateway 账户、refresh token、sandbox registry 和审计记录在 Postgres 中，Gateway 重启可以重新 adopt 存活 sandbox；sandbox volume 保存 DSH session、workspace 和 browser profile，sandbox 被 reclaim 后可以重新挂载。正在运行的 Agent turn、PTY、WebSocket streams、浏览器进程和未上传的本地缓存不属于同一个持久化提交域。Cube volume 文档还明确写出 JuiceFS 的 metadata/object writes 是异步确认：小文件写入可以更快，但节点丢失时最后时刻的工作可能丢失，所以“持久 volume”不等于强 durability 或可回放的 Agent checkpoint。

故障恢复主要是面向人工的 recovery workflow，而不是自动 Session resume。Cube 中 envd 可以在 DSH backend 崩溃后继续存活，Gateway 会把“机器还活着但 tunnel 不在”的状态显示为 recovery 页面，允许租户查看最后日志、读写 volume 文件、打开 terminal、重新 start backend、rebuild 同一 volume 或 erase 全部数据。Docker 中 entrypoint 等待 DSH 进程，backend 退出通常意味着容器退出，下一次请求会创建新容器。两条路径都没有证明 DSH Agent loop 可以从任意中断的 model/tool step 恢复；恢复的是机器、文件、Session 数据和人工启动入口。

验证目录主要是部署后验收脚本而不是单元测试：浏览器登录、原生 DSH API/WS、设置、侧栏、文件、终端、浏览器/桌面、恢复、隔离、模型 turn 和工具调用分别有脚本，`verify.sh` 支持 Docker 与 Cube 两种 runtime。仓库文档记录了真实验收和若干失败修复，但本次研究没有重新安装 Docker/Cube、构建镜像或运行真实模型，因此只能确认项目提供了这些验证路径，不能把仓库中的历史验证记录当成本次独立复现。

综合源码证据，`HamsterHQ` 应被归类为“以 DSH 原生 UI 和 Cordis 插件为核心、每租户独立 runtime、Gateway outbound tunnel 为通信边界的云部署实现”。它在三个项目中最接近“保留 DSH UI 和插件体系再增加云端控制面”的路线，最值得借鉴的是 tunnel 内置在 DSH composition、浏览器和 Agent activity 分离、Gateway restart adoption、模型密钥 egress 注入以及 Docker/Cube runtime seam；但它仍不是 browser-native Agent Loop，Gateway 的多副本路由、volume 强一致性、跨域 checkpoint 和真实 Cube 隔离都不能从本地 Compose 或静态代码阅读直接推出。

## 待形成的最终比较

最终报告至少要给出以下判断，而不是只列功能：

| 判断问题 | `dshcloud` | `dsh-multi-tenant` | HamsterHQ |
|---|---|---|---|
| 是否直接运行官方 DSH | 是，独立 DSH 容器 | 是，固定 digest 的独立 DSH workload Pod | 是，固定 npm 依赖的独立租户 DSH 进程 |
| Web UI 是原生、转发还是重建 | 原生 DSH UI，经 Traefik、forward-auth 和 Caddy 转发 | 原生 DSH UI，经平台 HTTP/WS ingress 转发 | 原生 DSH shell，经 nginx、Gateway tunnel 和少量 Cordis UI plugins |
| 租户隔离的最小单位 | 每 Workspace 一个容器、网络、宿主端口和数据目录 | 每 owner 一个 Namespace、Sandbox、Pod、PVC、ServiceAccount 和 NetworkPolicy | 每租户一个 DSH 进程，Docker 模拟为容器，Cube 路径为 microVM/sandbox |
| Session durability | 位于 Workspace `/data`，不与控制面元数据同库 | 位于用户 PVC 的 `dsh` 目录，控制面只保存绑定 | 位于租户 volume；Gateway registry 在 Postgres，运行中 turn 不具备统一 checkpoint |
| Workspace durability | 宿主目录或 Docker volume；升级有 `.prev` 快照 | 每用户 PVC；删除保留 data PVC，但不等于备份 | Cube 为 JuiceFS/PVC/S3-backed volume；Docker 为模拟路径，需区分两者 |
| 模型凭据暴露面 | 需结合容器环境和 DSH 配置继续核验 | DSH 凭据与 HOME 同在用户 PVC；平台不代理模型凭据 | Cube 可用 egress 注入隐藏真实 key；Docker/不可拦截 endpoint 不具备同等保证 |
| 多副本和 fencing | 单控制面进程队列；未证明跨副本 fencing | Chart 固定单副本，SQLite/内存 session，不提供平台 HA | DB 主键防部分重复创建；`gateway_id` 尚未用于路由，未形成多副本 fencing |
| 可复用到 browser-native PoC 的部分 | 生命周期、入口授权、WebSocket/SSE 转发、数据丢失防护 | session/环境分离、撤权传播、原生 UI 保留、资源身份和未知结果处理 | 同源前端、认证代理、真实 DSH plugin seams、session/activity 观测和持久化边界 |

## 明确不做的推断

Star、Fork、贡献者归因数、release 数量和 CI 通过不能证明生产可靠性。一个项目拥有独立容器也不能证明 Session、文件、PTY、浏览器状态和外部副作用具有统一恢复点。项目文档声称“persistent”“isolated”或“verified”时，必须继续追到实现和测试的具体对象。

这三个项目也不能直接作为 browser-native DSH 的现成实现：它们的主要 Agent Loop 仍然位于服务器、容器、Pod 或 microVM 中。当前研究的目标是借鉴其控制面、认证、隔离和持久化经验，而不是把它们的部署拓扑误认为浏览器执行模型。

## 进度记录

| 日期 | 范围 | 结果 |
|---|---|---|
| 2026-10-05 | 三个本地 checkout 的 Git 状态、目录、根 package、分支和 tag | 完成首轮盘点；三个仓库均为干净 `main`，未修改外部 checkout |
| 2026-10-05 | `dshcloud` 代码级阅读 | 完成第一轮源码阅读；未安装依赖、未启动容器，运行时结论仍待验证 |
| 2026-10-05 | `dsh-multi-tenant` 代码级阅读 | 完成第一轮源码、Connector 制品、Chart、测试和验证文档阅读；未在本机重跑 Kubernetes/真实模型验收 |
| 2026-10-05 | `HamsterHQ` 代码级阅读 | 完成第一轮源码、Cordis plugins、tunnel、Gateway、runtime、Compose、volume、凭据和验收脚本阅读；未在本机重跑部署 |
| 2026-10-05 | 三项目验证脚本和可运行性核对 | 完成静态核对；确认三个项目提供的验证入口、测试和部署路径，但未在本机安装依赖、启动 Docker/Kubernetes/CubeSandbox 或调用真实模型 |
| 2026-10-05 | 稳定结论回写主研究报告 | 已完成第一轮回写；主报告保留“源码/文档事实、项目自述和本次未复现内容”的证据边界，待文档门禁完成后再收口 |

## 后续维护规则

每完成一个项目的关键边界判断，先更新本文件的对应章节和进度记录，再继续探索下一个项目。若发现此前主研究报告中的第三方项目分类、成熟度、许可证或能力描述需要改变，先在本备忘录中记录证据和影响，再修改主报告。

本文件中的外部仓库路径是本机研究输入，不是 DSH runtime 依赖，也不应被提交为 submodule、vendor 或源码复制。最终主报告只引用公开仓库 URL、release/tag 或可复核的项目文档，不依赖读者访问研究者本机路径。
