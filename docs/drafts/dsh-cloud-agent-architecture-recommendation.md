---
description: "DSH Browser Native Agent 与长时运行 Cloud Agent 的互补架构建议，以及对 HamsterHQ、dsh-multi-tenant 和 dshcloud 的采用决策。"
---

# DSH 云端 Agent 与 Browser Native Agent 的互补架构建议

**研究状态：后续架构讨论基线；建议日期：2026-10-05**

## 结论

如果只能选择一个项目作为主要架构参考，推荐选择 [`HuChundong/HamsterHQ`](https://github.com/HuChundong/HamsterHQ)；但不建议直接把它整体 fork 成长期产品基线。

更稳妥的采用策略是：以 HamsterHQ 的 DSH runtime、Cordis plugin、Gateway 和 outbound tunnel 分层为主架构参考，以 [`GuoMonth/dsh-multi-tenant`](https://github.com/GuoMonth/dsh-multi-tenant) 的资源生命周期、allocation key、精确资源 UID、CAS 和撤权传播为控制面参考，再从 [`eskim2001/dshcloud`](https://github.com/eskim2001/dshcloud) 借鉴 Workspace 管理、入口认证、配额和升级回滚体验。

长期实现应保持 DSH 为上游依赖，通过独立的 Cloud Agent Control Plane 和少量 Cordis 插件增加云端能力，而不是永久维护一个大幅偏离上游的 DSH fork。

## 为什么 HamsterHQ 最接近目标

我们的目标不是单纯把 DSH 放进容器，而是让 Browser Native DSH 和服务端长时运行 Agent 成为同一个产品的两种执行模式。

HamsterHQ 最值得参考的地方在于：它保留每租户 DSH backend 和官方插件组合，把认证、Gateway、Sandbox 生命周期、tunnel、模型密钥策略和租户状态放到外部平台；因此 DSH 的 Web UI、Agent Loop 和 Cordis 扩展仍然是可复用的运行时，而不是被外围平台完全重写。

它的 outbound tunnel 也更符合云端场景。Sandbox 主动连接 Gateway，Gateway 不需要直接访问每个 Sandbox 的入站端口；浏览器请求和 Sandbox 自身的 runtime 请求可以在 Gateway 处统一进行身份、租户和流量控制。

这条路线适合作为 Browser Native Agent 的后台执行补充：浏览器端负责交互式 Agent Loop，云端 DSH 负责长任务、重型工具、浏览器自动化、定时任务、Webhook 触发和浏览器断线后的继续执行。

## 为什么不直接 fork 三个项目之一

三个项目都处于早期阶段，且都把自己的部署假设写进了控制面或 runtime 代码。直接 fork 会把 Docker socket、单副本、特定 Kubernetes 资源、特定 CubeSandbox SDK 版本、特定数据库和特定 UI 路由一起带入产品，之后每次同步上游 DSH 都会扩大冲突面。

尤其是三个项目都没有完整解决以下跨域问题：Session event log、Workspace 文件、正在运行的 PTY、浏览器进程、Agent turn、外部副作用和控制面状态如何形成一个可恢复 checkpoint。

因此应当先建立自己的稳定协议和数据模型，再把社区项目中可验证的机制吸收进来。

## 三个项目各自应该借鉴什么

| 项目 | 主要借鉴对象 | 不应直接继承的假设 |
|---|---|---|
| `HamsterHQ` | DSH 作为 npm 依赖、Cordis plugin、Gateway、outbound tunnel、每租户 runtime、Sandbox adoption | 单 Gateway、当前恢复模型、Docker simulation 与 CubeSandbox 安全等级等价、缺少统一 Agent checkpoint |
| `dsh-multi-tenant` | OIDC 映射、allocation key、资源 UID 绑定、revision/CAS、未知结果状态、撤权和 Stop 后确认 | 单平台副本、私有 SQLite 作为控制面状态、PVC 等于备份、Kubernetes 资源等于完整 Agent durability |
| `dshcloud` | Workspace/实例管理、入口认证、Origin 校验、配额、镜像升级回滚和产品界面 | Docker socket、宿主机目录、单机队列和本地端口作为云平台一致性基础 |

三个项目的详细代码证据见 [`dsh-cloud-projects-local-code-reading-memo.md`](dsh-cloud-projects-local-code-reading-memo.md)，总体 OSS 生态判断见 [`dsh-cloud-agent-oss-landscape-review.md`](dsh-cloud-agent-oss-landscape-review.md)。

## 两种 Agent 模式

Browser Native Agent 和 Cloud Agent 不应被设计成两个互相竞争的产品。

```text
Browser Native Agent
    ├── Agent Loop 在浏览器执行
    ├── 同域调用 LLM proxy
    ├── 后端持久化 Session 状态
    ├── 低延迟的人机协作
    └── 适合短任务、敏感上下文和即时反馈

Cloud Agent
    ├── Agent Loop 在受控 Sandbox 中执行
    ├── 浏览器断开后继续运行
    ├── 适合长任务、后台任务和定时任务
    ├── 可以使用重型工具链、浏览器和编译环境
    └── 通过事件、结果和可恢复句柄回到浏览器
```

Browser Native Agent 不能覆盖的场景包括：运行数小时的编译或迁移、需要持续网络连接的浏览器自动化、Webhook 或定时触发、用户关闭浏览器后仍需继续的任务、需要稳定运行环境的多 Agent 协作，以及不适合在用户设备上执行的敏感或重型工具。

Cloud Agent 也不应替代所有浏览器交互。交互式确认、实时编辑、低延迟对话和不希望离开本地设备的上下文仍然适合 Browser Native Agent。

## 推荐的交接模型

浏览器端不应把一大段 prompt 字符串直接复制给云端。交接应该以一个有明确身份的 Cloud Run 为中心，并引用已经持久化的 Session 和 Workspace 状态。

```text
Browser Native Agent
        │
        │ create cloud run
        ▼
Cloud Agent Control Plane
        ├── session checkpoint
        ├── workspace generation / snapshot
        ├── task specification
        ├── capability grants
        ├── credential policy
        ├── runtime requirements
        └── idempotency key
        │
        ▼
DSH Runtime in CubeSandbox or another executor
        │
        ├── status/events
        ├── artifacts
        ├── workspace generation
        └── resume/follow-up handle
        │
        ▼
Browser Native Agent
```

最低限需要定义以下对象：`cloudRunId`、`sessionId`、`workspaceId`、`workspaceGeneration`、`lastDurableSessionSeq`、`runtimeId`、`capabilityVersion`、`idempotencyKey` 和 `correlationId`。

交接的关键不是“把上下文发过去”，而是明确哪个 Session event、哪个 Workspace generation 和哪个 capability policy 构成云端执行的起点。

## 建议的系统边界

```text
Browser UI / Browser Agent Loop
              │ same-origin HTTPS
              ▼
Cloud Agent Control Plane
  Auth · Tenant · Cloud Run · Session checkpoint
  Workspace reference · quota · audit · event stream
              │ runtime adapter
              ▼
Executor Adapter
  DSH profile · Cordis plugins · tunnel · lease · fencing
              │
              ▼
Sandbox Runtime
  CubeSandbox microVM / Kubernetes Sandbox / local executor
              │
              ▼
DSH Agent Runtime
  Agent Loop · tools · LLM provider · terminal · browser · workspace
```

Control Plane 负责“谁可以运行什么、运行到哪里、运行状态是什么、怎样恢复和审计”；DSH 负责 Agent Loop、工具调用、模型请求、Session 事件和 Host/Client 能力；Executor 负责隔离、资源和进程生命周期；Workspace 负责跨 runtime 的文件状态。

这些职责不能通过一个“统一数据库”自动获得一致性。必须为 Session、Workspace、Sandbox 和 Cloud Run 分别定义 durability receipt、generation 和恢复规则。

## 推荐实施顺序

### 第一阶段：先定义 Cloud Run 协议

定义创建、启动、暂停、取消、交接、跟随、取回结果和恢复的 API；为每个请求定义幂等键、状态序列、事件序列和未知结果。

这一阶段不依赖 CubeSandbox，可以用本地 DSH headless profile 或 Docker executor 验证控制面协议。

### 第二阶段：实现 DSH runtime adapter

参考 HamsterHQ 的 Cordis plugin 和 tunnel，但只保留必要能力：runtime registration、health、agent status、Session event forwarding、workspace identity、lease renewal 和 graceful shutdown。

插件不应重新实现 Agent Loop，也不应把云端控制面状态偷偷写进 DSH Session event log；跨域 checkpoint 必须显式记录。

### 第三阶段：接入隔离执行器

优先把 Executor Adapter 设计成可替换接口，再接入 CubeSandbox。CubeSandbox 适合提供 microVM 隔离、暂停/恢复、快照、克隆和 egress credential injection，但它不负责 Cloud Run、Session ownership 或租户产品语义。

### 第四阶段：实现 Browser Native handoff

浏览器端创建 Cloud Run，提交 Session checkpoint 和 Workspace generation，订阅事件，在云端执行期间继续显示状态，并允许用户追加指令、取消任务或接管结果。

只有在交接和恢复协议稳定后，才把“自动交接”作为模型可见能力加入 Browser Native Agent。

## 当前明确不做的事情

- 不把 HamsterHQ、`dsh-multi-tenant` 或 `dshcloud` 直接当成生产基线。
- 不把 CubeSandbox 的 pause/resume 等同于 DSH Session resume。
- 不把 PVC、S3 Volume 或 Sandbox snapshot 等同于统一 Agent checkpoint。
- 不把 Browser Native Agent 的 prompt 文本复制当成交接协议。
- 不为兼容某个社区项目而长期 fork DSH core。
- 不在没有运行时验收、故障注入和租户隔离测试前宣称生产级 Cloud Agent。

## 最终建议

如果组织流程要求先 fork 一个项目，优先选择 HamsterHQ 作为实验性架构参考；但 fork 后应尽快拆出自己的 Control Plane、Runtime Adapter 和 Executor Adapter，并把 HamsterHQ 的具体实现逐步替换掉。

真正的产品基线应当是：上游 DSH 加上稳定的 Cloud Run 协议、Cordis runtime adapter、可替换的 Sandbox executor、持久 Workspace 引用和 Browser Native handoff，而不是某个社区仓库的当前目录结构。
