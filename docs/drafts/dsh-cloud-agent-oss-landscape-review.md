---
description: "基于 DSH 当前 checkout 和公开仓库证据，核实官方 Web、Remote API、ACP 与第三方云端 Agent 实现的真实边界，区分直接部署、平台包装和 Harness 重实现。"
---

# DeepSeek Harness 是否存在“云端 Agent”的开源实现？

**核验日期：2026-10-05；DSH checkout：0.2.0-rc.2**

## Summary

结论是肯定的，但必须先限定“云端 Agent”的含义：截至 2026 年 10 月 5 日，已经有多个公开仓库把 DeepSeek Harness（DSH）部署或改造为可以通过浏览器使用的远程、多用户 Agent 系统。其中至少三个项目可以从仓库元数据和许可证文件确认采用 MIT 许可证：[`GuoMonth/dsh-multi-tenant`](https://github.com/GuoMonth/dsh-multi-tenant)、[`eskim2001/dshcloud`](https://github.com/eskim2001/dshcloud) 和 [`HuChundong/HamsterHQ`](https://github.com/HuChundong/HamsterHQ)。

这些项目并不代表同一种技术路线：`dsh-multi-tenant` 和 `dshcloud` 主要是在 DSH 之上增加控制面、身份认证、实例编排和持久化环境；HamsterHQ 保留每租户 DSH backend 和 Cordis 扩展方式，但使用独立前端、认证网关和每租户 Sandbox；另一些 Cloudflare 项目则重新实现了 Harness 核心，使用自己的 Worker、Durable Object、工具和前端，不能称为“把官方 DSH 原样搬到云上”。

原始报告有两个方向性正确、但需要收紧的判断：

1. **DSH 官方确实已经具备远端运行所需的 Agent Runtime、Web Host/Client 和内部 Remote API。** 但 `dsh web` 是一个默认回环绑定的单进程 Web surface；`--host 0.0.0.0` 在当前源码中仍被拒绝。通过 SSH 转发、同机反向代理或受控隧道访问，不能自动等同于官方提供了多租户 Cloud Agent 产品。
2. **DSH 官方当前没有一个已经文档化、稳定承诺、面向第三方业务系统的 OpenAI Agents API 式 HTTP/WS 产品接口。** Web `/api` 和 `ctx.remote` 是浏览器 Host/Client 传输层；ACP 是持久 Session 的程序化入口，但当前 shipped profile 使用 JSON-RPC stdio，`authenticate` 不建立用户身份或租户授权。

因此，更准确的最终判断是：

> **DSH 官方提供了可被云平台承载的 Agent Runtime 和浏览器 Remote Host；社区已经出现多个 MIT 许可的多用户云部署项目，但它们仍处于 Alpha、Early Development 或研究型阶段；“官方 Cloud Agent API”和“官方多租户 SaaS”仍不是当前仓库已经交付的产品。**

本文只回答“当前是否已有实现以及它们做到什么程度”，不替代同目录的云 SaaS 设计稿、租户隔离研究或 Remote Durable Workspace 研究。平台侧的 Worker、配额、外部执行器和工作区设计，分别见：

- [基于 DSH 实现云端 SaaS Agent](dsh-cloud-saas-agent-research.md)
- [部署、租户隔离与请求执行参考](dsh-deployment-and-tenancy-deep-dive.md)
- [Remote Durable Workspace 研究](dsh-remote-durable-workspace-pgfs-research.md)
- [三个本地 checkout 的代码解读备忘录](dsh-cloud-projects-local-code-reading-memo.md)

## 1. “云端 Agent”必须拆成四个层级

“把 DSH 放到服务器上”与“提供多租户 Cloud Agent API”之间有很长的距离。本文使用以下分层：

| 层级 | 可验证的含义 | 关键问题 | 当前判断 |
|---|---|---|---|
| L1 | 浏览器访问远端机器上的 DSH Web UI | Host/Client 是否能跨机器工作 | **官方可承载，但默认只回环绑定** |
| L2 | 程序通过 ACP、SDK 或内部 Remote API 驱动持久 Agent | Session 是否可创建、恢复、取消和接收事件 | **官方已有；ACP shipped transport 是 stdio** |
| L3 | 面向第三方业务系统的稳定 HTTP/WS Agent API | 是否有公开版本、认证、租户、配额和兼容承诺 | **官方当前未交付完整的一等产品接口** |
| L4 | 多租户 Cloud Agent Platform | Auth、Tenant、RBAC、Sandbox、Workspace、Quota、运营和恢复 | **官方没有完整产品；社区已有多个早期实现** |

可以把 L1 到 L4 写成四个不同架构：

```text
L1: Browser ──HTTP/WS──> remote dsh web process

L2: controller ──ACP/SDK──> persistent DSH Agent

L3: business API ──HTTP/WS──> versioned Agent service ──> DSH

L4: tenant/auth/control plane ──> worker/sandbox/workspace ──> Agent runtime
```

如果一个项目只提供 L1，就不能据此推断它解决了 Session 接管、租户隔离或资源配额。如果一个项目把 Session 存在数据库里，也不能据此推断工作区文件、运行中的进程或外部工具副作用同样可恢复。

## 2. 核验范围和证据等级

### 2.1 本地 DSH 证据

本报告以当前 checkout 的源代码、package README、配置目录和实际命令输出为准。当前根 `package.json` 和相关包版本是 `0.2.0-rc.2`。我核对了：

- `pnpm dsh web --help`：确认 Web surface 的命令行参数。
- `pnpm dsh --profile acp --help`：确认 ACP 是 profile，而不是另一个独立 public binary。
- `packages/bundle/web-app/src/startup.ts` 及其测试：确认 `--host 0.0.0.0` 的实际拒绝行为。
- `packages/bundle/web-app/README.md`、`packages/client/connection/README.md`：确认 Web Host/Client、Token/Cookie、Host/Origin trust fence 和 `/api` browser transport 的边界。
- `packages/api/session-controller/src/index.ts`：确认内部 `session` Remote namespace 包含 Session 列表、创建、Prompt、取消、跟随和流式方法。
- `packages/acp/acp/src/index.ts`、`packages/acp/acp/README.md` 和 `packages/bundle/acp-app/README.md`：确认 ACP 方法、持久 Session、stdio transport 和无认证实现。
- `packages/session/session-persistence/src/index.ts`：确认 append-only log、`append` 的 best-effort 语义和 `flush` 的 durability barrier。

本地源码属于最高等级证据。README 与源码冲突时，以源码和执行测试为准，并在文档中指出冲突。

### 2.2 外部仓库证据

外部项目按以下证据顺序判断：

1. GitHub repository metadata：仓库存在性、默认分支、更新时间、公开/归档状态和 GitHub 识别到的许可证。
2. 仓库中的 `LICENSE` 或 SPDX 许可证文件：确认“开源”分类，不把 GitHub 的空许可证字段解释成许可。
3. README、架构文档、Docker/Helm/Worker 配置和测试：判断项目到底运行官方 DSH、增加外部平台，还是重写 Harness 核心。
4. 项目自述的成熟度和验证范围：只能作为项目自述，不能升级为独立生产认证。

Star、Fork、贡献者归因数和 README 中的“production-ready”都不是安全、性能或生产采用证据。本文记录的 GitHub metadata、发行记录和 README 都以 **2026-10-05** 的核验为准；这些字段会随仓库变化，不能当成永久事实。贡献者归因数不是仓库总 commit 数，只能作为提交活动的粗略信号。

本次对三个主要项目检查了仓库 metadata、`LICENSE`、README、公开 release/tag、近期提交、Issues、Actions 和贡献者归因；没有在本机完成三者的完整安装、容器启动、双用户验收或生产环境部署。因此下文的“成熟度”是基于公开证据的工程判断，不是运行时认证或第三方口碑评级。未找到足够的独立生产案例、系统性第三方评测或安全审计报告时，本文会明确写成“尚未证实”，而不会把 Star 数或项目自述升级成口碑结论。

## 3. DSH 官方已经提供什么

### 3.1 DSH 是 Agent Runtime，不只是聊天前端

DSH 的核心组合包含 Agent Loop、LLM provider、工具、Session、Sandbox、Workspace、Storage、Web Host/Client、ACP 和 SDK 等插件。应用启动规则由 `dsh` profile launcher 管理，Web、headless、SDK 和 ACP 都是 profile，而不是一组彼此独立的产品二进制。

这意味着 DSH 适合作为云平台里的执行内核：云平台可以负责身份、租户、路由、Worker 生命周期和外部资源；DSH 负责 Agent Loop、工具管线、模型请求、Session 事件和 Host/Client UI。

这并不意味着 DSH 自己已经提供：

- tenant、用户、RBAC 和计费主体；
- 跨 Worker 的 Session ownership 或 fencing；
- 一租户一 Sandbox 的调度器；
- 外部持久化 Workspace 和文件版本服务；
- 通用的 API key 代理、配额和 abuse control；
- 公开稳定的 Cloud Agent HTTP API。

### 3.2 Web surface 是 Host/Client 架构

Web profile 的实际调用链是：

```text
Browser Client
      │  authenticated browser connection
      ▼
Host Web Server
      │  /api + Remote namespace + WebSocket streams
      ▼
Session Controller / Agent / Tools / Workspace / Terminal
```

`packages/api/session-controller` 的 `SessionController` 使用 `namespace: 'session'`，暴露 `list`、`create`、`prompt`、`cancel`、`page`、`follow`、`projections` 等内部 Remote 方法。`packages/api/gateway` 负责 Typert Remote dispatch 和流式传输，`packages/client/connection` 负责浏览器侧的认证、请求桥接和恢复。

因此，下面这句话是正确的：

> DSH 已经有一个可以让浏览器调用 Host 上 Agent 能力的 Remote API 机制。

但下面这句话过度扩大了范围：

> DSH 已经提供了面向业务系统的 Cloud Agent API。

当前 `/api` 的设计目标是 DSH 自己的 Web Client 与 Host 之间的传输。仓库没有把它定义为独立的、版本化的、面向第三方业务调用者的 API 产品，也没有为每个请求提供通用 tenant claim、API key、RBAC、usage quota、跨进程 Session routing 或向后兼容承诺。能观察到一个 HTTP route，不等于已经有一个可直接托管给不受信业务客户的公开 API。

### 3.3 当前 Web 远程部署能力的真实边界

当前 Web 启动参数包括 `--host`、`--port`、`--trusted-host` 和 `--no-open`。但 `packages/bundle/web-app/src/startup.ts` 明确拒绝：

```text
--host 0.0.0.0 is intentionally not supported yet for safety
```

对应测试位于 `packages/bundle/web-app/tests/startup.spec.ts`。因此，当前最稳妥的部署形态是：

```text
Browser
   │
   ▼
SSH port forwarding / same-host reverse proxy / controlled tunnel
   │
   ▼
127.0.0.1:dsh-web
   │
   ▼
DSH Host
```

`--trusted-host` 只是把某些 Host authority 加入浏览器请求的 Host/Origin trust fence；它不是登录系统、租户授权或 API key。浏览器首次使用进程 token 换取按 authority 绑定的签名 cookie，之后 Host API 和 WebSocket 依赖该 browser session。`packages/client/connection/README.md` 还明确说明 shipped cookie 没有 `Secure` 属性，因为默认传输是 loopback HTTP；把这个服务直接暴露到公网需要额外的 TLS、入口认证和部署审查。

`packages/bundle/web-app/README.md` 的 Summary 写着不能绑定全部网络接口，但其 LAN 段落又描述了“绑定全部网络接口”的场景。这是文档与当前实现之间的表述不一致；当前源码和测试拒绝 `0.0.0.0`，所以本报告按源码行为判断，不把 LAN 段落解释成当前已支持的公网监听契约。

SSH 转发或同机代理仍然有价值：它可以让服务器上的 Agent 在远端执行、浏览器在本地使用。但它解决的是 **L1 远程访问**，不是 L4 多租户平台。

### 3.4 Session 持久化不等于每次操作立即 durable

`packages/session/session-persistence/src/index.ts` 给出的共享语义是：Session 使用 append-only event log；`append` 是 best-effort，`flush` 才是 durability barrier。一个更准确的模型是：

```text
in-process append
      │
      ▼
accepted / visible to current process
      │
      └── flush ──> durable in backend
```

因此不能笼统地说“DSH 的每个 Agent 操作都已经持久化”。把 DSH 接到云平台时，必须说明：模型请求前、工具调用前、turn 结束、Session close 和 Worker crash 各自是否已经越过 flush barrier。Session log 也只记录它所拥有的模型可见事件；Workspace 文件、正在运行的 shell、PTY、浏览器进程和外部副作用需要各自的持久化或恢复协议。

### 3.5 ACP 是程序化入口，但不是现成多租户 HTTP API

`@deepseek-ai/dsh-acp` 的定位是 automation-only ACP server。当前 README 和代码确认它支持：

- `session/new`、`session/list`、`session/resume`、`session/close`；
- `session/prompt`、取消、配置选项和语义化更新；
- MCP 连接和持久 Session 恢复；
- 在一个进程中管理多个 Session。

这些能力足以让脚本、测试运行器或另一个 Agent 程序驱动 DSH。它是 L2 的重要证据。

但当前 shipped profile 是：

```text
program ── JSON-RPC stdio ──> dsh --profile acp
```

ACP `Config` 中的 `stream` 是 runtime-only transport override，主要用于测试和嵌入式调用；生产启动路径使用 stdio。`authenticate` 当前立即成功，表示协议方法存在，而不是已经建立了用户身份、租户授权或凭据交换。

因此，ACP 可以被 Cloud Agent 平台包在 HTTP/WS gateway 后面，但“加一层 HTTP 转发”是平台新建的认证和生命周期边界，不是 DSH 当前已经交付的官方 HTTP 多租户产品。

## 4. 原报告的四个结论需要怎样修正

### 4.1 “官方有云端 Agent”必须加限定

如果“云端 Agent”指：

```text
把 DSH 进程放在服务器上，用户通过浏览器使用
```

答案是：**官方运行时可以这样部署，尤其适合 SSH 转发、同机反向代理或受控隧道；当前 Web profile 本身不等于公网 SaaS。**

如果“云端 Agent”指：

```text
官方托管的多租户产品，带登录、租户、资源配额、Sandbox 和公开 API
```

答案是：**当前仓库没有这样的完整官方产品。**

如果“云端 Agent”指：

```text
社区已经有人把 DSH 部署成多用户 Cloud Agent
```

答案是：**有，而且已经不止一个；但成熟度、是否直接运行官方 DSH、工作区持久化和安全模型差异很大。**

### 4.2 “没有 Remote API”是不准确的，“没有公开产品 API”较准确

DSH 有内部 Remote API、WebSocket event stream、Session Controller、Workspace Controller、Terminal Controller 和 Job Controller。真正缺少的是将这些内部能力整理成：

- 面向第三方的版本化 HTTP/WS API；
- 独立的 API authentication 和 tenant authorization；
- API key、OAuth service account、quota、rate limit 和 usage；
- 跨实例 Session routing、ownership、resume 和 fencing；
- 稳定的外部错误码、幂等语义和兼容策略。

原报告中的“官方目前没有完整的一等 API”可以保留，但必须明确“一等 API”指 **外部产品 API**，不能让读者误以为 DSH 内部 Web Remote 层不存在。

### 4.3 ACP 的存在不能证明 HTTP 云服务已经存在

ACP 证明 DSH 可以被程序化驱动，不能证明：

- ACP 已经支持浏览器或 HTTP transport；
- `authenticate` 已经完成多租户身份认证；
- 一个 ACP 进程可以安全承载互不信任租户；
- Session 数据、Workspace、工具和外部副作用已经跨节点可恢复。

把 ACP 包成 HTTP 是一个合理的云平台设计，但它是新平台层的工作。

### 4.4 “开源实现”必须同时看代码关系和许可证

一个仓库有 README、Dockerfile 或在线 Demo，不足以证明它是 OSI 意义上的开源软件。至少要分别回答：

1. 是否存在明确的 LICENSE 文件或 SPDX 可识别的标准许可证？
2. 项目是否运行官方 DSH，还是重新实现了 Harness 核心？
3. 多租户隔离是在控制面做的，还是只靠一个共享进程的命名约定？
4. Session、Workspace 和运行中 Sandbox 是否具有相同的 durability 语义？
5. 项目自己的 README 是否明确写了 early development、单副本、无灾备或不建议生产使用？

本文下面按这些问题分类，不把“能跑起来”升级为“生产成熟”。

## 5. 当前可以确认的第三方项目

### 5.1 直接部署官方 DSH 的平台型实现

| 项目 | 许可证 | 主要路线 | 与官方 DSH 的关系 | 公开关注度与活动信号 | 当前可确认的限制 |
|---|---|---|---|---|---|
| [`GuoMonth/dsh-multi-tenant`](https://github.com/GuoMonth/dsh-multi-tenant) | MIT（[`LICENSE`](https://github.com/GuoMonth/dsh-multi-tenant/blob/main/LICENSE)） | Kubernetes、OIDC、每用户持久环境、Helm/npm 安装器 | 使用原生 DSH UI；平台和 `dsh-isolated-runtime` 在外部编排 | 12 Stars、2 Forks、3 个开放 Issue；主要贡献者归因 408 次；最新 push 为 2026-09-29；连续 Alpha release，最新 `v0.10.0-alpha.1` | README 自述为 Alpha、Linux/amd64、DSH 0.2.0-rc.2、单平台副本；备份、高可用和跨节点灾备不在当前保证内 |
| [`eskim2001/dshcloud`](https://github.com/eskim2001/dshcloud) | MIT（[`LICENSE`](https://github.com/eskim2001/dshcloud/blob/main/LICENSE)） | 控制面、邀请/用户、配额、每 Workspace 容器、持久数据和 Traefik | 实例镜像安装官方 `@deepseek-ai/dsh` npm 包 | 90 Stars、6 Forks、1 个开放 Issue；主要贡献者归因 106 次；最新 push 为 2026-09-20；有 `v0.1.15` release 和公开 Demo | README 明确写 Early development、不是 production-ready；安装器会修改主机、使用 Docker socket，生产安全仍需按其安全文档审查 |
| [`HuChundong/HamsterHQ`](https://github.com/HuChundong/HamsterHQ) | MIT（[`LICENSE`](https://github.com/HuChundong/HamsterHQ/blob/main/LICENSE)） | 独立前端、外部 gateway、每租户 Sandbox、WebSocket tunnel、JWT/数据库和微 VM | DSH 是 npm 依赖；新增能力主要通过 Cordis plugins，官方 DSH backend 留在每租户 Sandbox；不是把官方静态 Web 前端直接暴露出来 | 6 Stars、2 Forks、无开放 Issue；主要贡献者归因 83 次；最新 push 为 2026-09-24；有 CI/Pages workflow，但没有正式 GitHub Release | 一个 gateway replica；只有 Cube 路径尝试通过 egress 隐藏真实模型凭据，Docker simulation 或不可拦截 endpoint 不具备同等保证；Sandbox 会被回收，正在进行的 turn 可能丢失；生产 CubeSandbox 路线与本地模拟不是同一安全级别 |
| [`vocsong/deepseek-harness-portal`](https://github.com/vocsong/deepseek-harness-portal) | **未确认标准许可证** | Portal 登录、Cloudflare Tunnel、每用户一个 DSH 容器 | README 自述为原生 DSH 实例的多租户入口 | 没有足够的公开 Stars/活动证据支持成熟度判断 | GitHub metadata 没有识别到许可证，仓库根目录也没有可确认的 LICENSE；可以称为公开代码项目，不能在本报告中确认其为 OSI 开源软件 |

这四个项目的共同点是：它们把租户认证、入口路由或实例生命周期放在 DSH 之外，至少部分保留官方 DSH Web UI 或官方 DSH npm 包。它们的隔离单位也明显不同：

```text
GuoMonth      user → Kubernetes environment / PVC
dshcloud      user → workspace container / host-managed data
HamsterHQ     tenant → gateway session + sandbox / microVM
portal        user → one container + Cloudflare Tunnel
```

这组项目足以推翻“社区没有 DSH 云端实现”的旧结论，但不足以证明已经存在一个通用、成熟、可互换的 Cloud Agent 标准。

### 5.2 公开关注度和开发活跃度的正确解读

在三个有明确 MIT 许可证的项目中，`dshcloud` 的公开 Star/Fork 数最高，`dsh-multi-tenant` 的发行频率和贡献者归因数最强，HamsterHQ 的公开关注度最低但仍有可观的单维护者工程投入。这个排序只能描述 GitHub 上可见的兴趣和开发信号，不能直接转换成生产可靠性排序：

| 维度 | `dsh-multi-tenant` | `dshcloud` | HamsterHQ |
|---|---:|---:|---:|
| Stars / Forks | 12 / 2 | 90 / 6 | 6 / 2 |
| 开放 Issues | 3 | 1 | 0 |
| 主要贡献者归因数 | 408 | 106 | 83 |
| 最新公开 push | 2026-09-29 | 2026-09-20 | 2026-09-24 |
| Release 信号 | 连续 Alpha release，最新 `v0.10.0-alpha.1` | `v0.1.15`，之后仍有提交但没有更高版本 release | 没有正式 GitHub Release |
| 公开成熟度自述 | Alpha | Early development、not production-ready | 独立项目，具备 Docker simulation 和 CubeSandbox 路线，但未宣称生产成熟 |

这些数字应与其来源一起阅读：仓库 [metadata](https://api.github.com/repos/GuoMonth/dsh-multi-tenant)、[release 列表](https://github.com/GuoMonth/dsh-multi-tenant/releases)、[contributors](https://github.com/GuoMonth/dsh-multi-tenant/graphs/contributors)、[issues](https://github.com/GuoMonth/dsh-multi-tenant/issues)；[`dshcloud` metadata](https://api.github.com/repos/eskim2001/dshcloud)、[release 列表](https://github.com/eskim2001/dshcloud/releases)、[contributors](https://github.com/eskim2001/dshcloud/graphs/contributors)、[issues](https://github.com/eskim2001/dshcloud/issues)；HamsterHQ 的 [metadata](https://api.github.com/repos/HuChundong/HamsterHQ)、[contributors](https://github.com/HuChundong/HamsterHQ/graphs/contributors)、[issues](https://github.com/HuChundong/HamsterHQ/issues) 和 [Actions](https://github.com/HuChundong/HamsterHQ/actions)。这些链接是可变的查询入口，不是固定快照；再次做架构决策时应按具体 release 或 commit 重新核验。

没有足够的独立生产案例、第三方评测或安全审计证据支持“口碑很好”或“已经被广泛采用”。更严谨的表述是：`dshcloud` 获得了最多公开关注，`dsh-multi-tenant` 显示出最强的近期发布活动，HamsterHQ 具有较清晰的隔离架构但社区验证最少。

### 5.3 `GuoMonth/dsh-multi-tenant`：开发最活跃的 Kubernetes 部署样例之一

仓库 README 的可核查事实包括：

- 每个授权用户有一个持久 AI 工作环境；
- 使用 OIDC，用户进入自己的环境后保留文件、会话、工具安装和凭据；
- Kubernetes、Linux/amd64，目标 DSH 版本是 `0.2.0-rc.2`；
- 当前是 Alpha，并且只保证一个 platform replica；
- 每个用户有独立 PVC，平台控制面和 `dsh-isolated-runtime` 负责资源与生命周期；
- 仓库提供 MIT `LICENSE`。

它更像“围绕 DSH 的云部署产品化尝试”，而不是改写 DSH 的 Agent Loop。代码级阅读显示，平台只在私有 SQLite 中保存 `EnvironmentBinding`、allocation key、精确 Namespace/Sandbox/PVC UID 和不确定状态；用户 DSH Session、HOME、工具、凭据和 workspace 位于用户 PVC 的 `dsh`、`home` 和 `workspace` 目录。平台通过固定的 runtime Connector 转发 HTTP/WS，并在撤权时中断已建立的连接；它没有把 Session event log、Kubernetes 状态和运行中 Pod 合并成一个事务。其最重要的证据边界也写在 README：备份、高可用和跨节点灾备不属于当前保证，存储容量也不一定在每一种 StorageClass 上形成硬配额。

因此，它可以被归为：

```text
直接运行官方 DSH + 外部多租户控制面 + 每用户持久环境
```

不能进一步归为“已经解决通用 Cloud Agent durability”。

它的成熟度判断是：**活跃的 Alpha 级内部平台，适合可信组织的技术试点，不适合作为未经审查的公网 SaaS 基础设施。** 它在三个项目中具有最强的版本推进信号，但公开 Fork、Issue 和第三方部署证据仍然很少。

### 5.4 `eskim2001/dshcloud`：产品表面最完整，但明确不是生产版

该仓库的 README 和镜像 Dockerfile 给出了更完整的平台构成：

- Web 控制台负责用户、邀请、Workspace、版本和资源配额；
- 每个 Workspace 有独立容器和持久化数据；
- 实例镜像通过 `npm install --global @deepseek-ai/dsh@<version>` 安装官方 DSH；
- 平台在 Traefik、控制面和实例之间做入口认证、Owner/Origin 校验和路由；
- 仓库提供 MIT `LICENSE`、测试和安全/架构文档。

但该项目自己的 README 明确要求把它当作测试机和早期开发项目：安装器会创建存储池、写入 `/etc/fstab`、占用 `80/443`，运行的容器还涉及 Docker socket。也就是说，它是“已经实现了不少平台组件的开源项目”，不是“已经通过独立生产安全审计的 SaaS”。

代码级阅读进一步确认，它把每个 Workspace 放进独立 DSH 容器，并由宿主数据目录或 Docker volume 承载 `/data/home/workspace`、用户 home、配置和 Session；入口由 Traefik、forward-auth、HMAC gate token 和容器内 Caddy 组成，HTTP/WS 都重新检查 owner 和 access lease。Linux 池化部署使用 XFS project quota，同时限制字节和 inode；没有宿主池时 `diskMb` 不能证明硬磁盘配额。生命周期队列只在单控制面进程内串行化，reconciler 不能提供跨副本 fencing 或统一恢复点。它的关键价值在于把 DSH 作为固定版本的实例镜像运行，而不是尝试在一个共享 Node 进程里用 tenant id 做软隔离；关键风险则是平台权限很高、宿主机改动很重，升级与灾备语义需要严格按其当前文档执行。

仓库 README 还公开了控制台和 Workspace 的在线 Demo，这说明产品表面比另外两个项目更完整，但不等于 Demo 已经证明生产安全、可靠性或数据恢复。它的成熟度判断是：**功能丰富的 Early Development / Alpha 自托管平台，适合 Demo、内部实验和平台原型，不应直接称为生产级 Cloud Agent 平台。**

### 5.5 `HuChundong/HamsterHQ`：隔离架构清晰，但不是原生 UI 的简单包装

HamsterHQ 的 README 对自身定位很明确：它是独立的、非官方的多租户 DSH 云部署，采用独立前端 shell，而不是把官方 Web 静态资源直接作为唯一前端入口；租户 backend 仍然是官方 DSH Web profile。其架构选择包括：

- 每租户一个 DSH backend；
- Sandbox 主动拨号到 gateway，gateway 不需要直接访问 Sandbox 的入站端口；
- gateway 负责租户认证，DSH 继续负责其本地浏览器连接认证；
- DSH 的 `/api` 流量通过插件内的 tunnel 到达 gateway；
- 租户的模型密钥通过生产环境的 egress 替换机制避免直接落入 Sandbox；
- DSH 作为 npm 依赖，新增的隧道、租户、预览、调度和品牌能力主要通过 Cordis plugin 加入。

这是“保持上游 DSH backend、在外部补平台能力、通过 Cordis plugin 加功能”的典型例子，也直接说明一个重要事实：如果 DSH 的 Web/API 认证是进程级的，那么互不信任租户通常需要进程、容器或 microVM 级别的隔离，而不是只新增一个前端 tenant 字段。

代码级阅读把这些限制具体化为：Gateway 的 Postgres 保存账户、token、sandbox registry、tenant secrets、model key 和 audit；DSH Session、workspace、HOME 与浏览器 profile 在租户 volume；tunnel、PTY、浏览器进程和正在执行的 Agent turn不属于同一个恢复域。Cube 路径可以用 JuiceFS/S3-backed volume 保留文件和 Session，但文档明确允许 metadata/object 异步确认，节点丢失可能丢最后时刻的写入；Docker simulation 没有同等的 microVM 隔离和 volume 证明。Gateway 目前是单副本，`gateway_id` 虽然入库但尚未形成路由 fencing；Sandbox 回收时正在进行的工作可能丢失。

它的成熟度判断是：**架构设计较成熟的 Alpha / research-grade 项目，但整体产品和运维成熟度低。** 83 次主要贡献者归因和持续 CI 说明维护者投入过工程工作，但 6 Stars、2 Forks、没有正式 Release、没有可见的第三方部署证据，说明社区验证仍然有限；“没有开放 Issue”不能解释成“没有 Bug”。

### 5.5.1 本地代码阅读后的共同结论

本地 clone 的源码阅读把三个项目从“README 上的云端 DSH”进一步区分成三种不同的控制面设计。详细文件范围、证据等级和未运行声明见[代码解读备忘录](dsh-cloud-projects-local-code-reading-memo.md)；以下结论来自各仓库的源码、配置、制品类型、测试和验收脚本，而不是只来自项目自述。

| 项目 | 代码确认的最小隔离单位 | 控制面持久化 | 用户 DSH 状态 | 最重要的恢复限制 |
|---|---|---|---|---|
| `dshcloud` | Workspace 容器、独立网络、宿主端口和数据目录 | PostgreSQL instance 元数据、状态和资源声明 | 容器 `/data`，包括 workspace、home、配置和 Session | PostgreSQL、`/data`、PTY、浏览器和外部副作用不在同一提交域；队列不是跨副本 fencing |
| `dsh-multi-tenant` | owner 对应的 Namespace、Sandbox、Pod、PVC、ServiceAccount 和 NetworkPolicy | 私有 SQLite binding journal，记录 allocation/UID/revision/未知结果 | 用户 PVC 的 workspace、home 和 dsh 目录 | Chart 固定单平台副本；PVC 不等于备份；平台不提供 Session/Pod/PVC 统一事务 |
| HamsterHQ | 每租户 DSH 进程；Docker 模拟为容器，Cube 路径为独立 Sandbox/microVM | PostgreSQL account、token、sandbox registry、secret、model key 和 audit | 租户 volume 的 workspace、DSH state、HOME 和浏览器 profile | Gateway 单副本；tunnel/PTY/Agent turn 不可恢复；Cube volume 的异步写确认允许节点故障丢末端写入 |

三个项目都证明了“把官方 DSH 放在服务端隔离环境中，让浏览器访问它”是可行的，但没有一个项目证明“浏览器执行 Agent Loop”。它们的 Agent Loop 分别仍然运行在容器、Kubernetes workload 或 Sandbox 内；浏览器只是客户端或展示层。

### 5.6 `vocsong/deepseek-harness-portal`：公开代码，但许可证不能确认

该仓库 README 描述了：一个 Portal 负责登录、管理员/用户 API 和反向代理，Cloudflare Tunnel 把每个用户路由到自己的 DSH 容器，用户的 home/workspace volume 独立保存。它是原报告中“每用户隔离容器”主张的可核验来源之一。

但截至本次核验：

- GitHub repository metadata 的 `license` 字段为空；
- 仓库根目录没有可确认的 `LICENSE` 文件；
- README 虽然公开可读，但没有因此产生标准开源许可。

所以应写成“公开可见的多租户 DSH Portal 实现”或“source-available repository”，而不是在许可证意义上确认成 OSS。它还包含自己的安全审计文档，文档中列出的本地回环绕过、Session 过期、Portal 与内层 DSH 的认证边界等问题，也说明“有隔离容器”不等于安全结论已经闭合。

## 6. Cloudflare 项目：实现 DSH 部署，还是重新实现 Harness？

### 6.1 `dorisgyl/dsh-cloud`

该项目提供 MIT 许可证和一个可部署到 Cloudflare 的 DSH 风格系统。README 自述的当前验证包括：

- Agent tree 在 Worker 中组装；
- turn 在 Durable Object 中运行；
- Session log 持久化到 Durable Object SQLite；
- Cloudflare Access 按用户隔离 Durable Object；
- Shell/文件/Terminal 通过 Cloudflare Container；
- 浏览器使用其 Web UI。

但它也明确声明：这是第三方 port，官方 `dsh-web-frontend`、Typert 和 Node `dsh web` 并没有直接托管；插件需要用它自己的 Cordis 模块方式接入。最关键的限制是 workspace 文件在容器回收后不会自动保留，README 的当前状态表把这一点明确标为未实现。

因此它属于：

```text
Cloudflare 上的 DSH/Harness 重实现或移植
```

它证明了 DSH 的架构思想可以在边缘运行时重建，但不能作为“官方 DSH 已经有 Cloudflare 原生部署”的证据。

### 6.2 `dravengarden/deepseek-harness-cloudflare`

该仓库同样提供 MIT 许可证，但 README 明确说它是 teaching/demo-grade port，不是官方 CLI、Web GUI 或插件市场的 drop-in replacement。它使用官方 Cordis、Durable Objects、Cloudflare Sandbox 和自己的插件组合；默认 identity 是 shared-owner，只有设置 `IDENTITY_MODE=per-user` 才按用户分片。

它的 Session log 在 Durable Object SQLite 中，workspace 可以通过 R2 backup/restore 处理，但容器原生磁盘是临时的。其文档还明确指出：Cloudflare Container sleep/reclaim 后，workspace 需要 backup/restore，不能把 live container 当作永久机器。

它对研究的价值在于给出一个 Workers-native 的 Agent Loop、持久 Session 和 Sandbox 组合；它不应被归类为“把官方 DSH Web profile 无修改迁移到 Cloudflare”。

### 6.3 这两类项目不能和直接部署项目混在一起

| 类型 | 代表 | 是否直接运行官方 DSH | 主要持久化对象 | 主要风险 |
|---|---|---:|---|---|
| 官方 DSH 外部平台包装 | GuoMonth、dshcloud、HamsterHQ | 是，或以官方 npm 包为核心 | Session/volume/平台数据库各自定义 | 上游升级、进程边界、入口认证、Sandbox 恢复 |
| Harness 云端重实现 | dorisgyl、dravengarden | 否，使用自己的组合和运行时 | DO SQLite、备份、对象存储等 | 与 DSH 功能/API 不同，插件和 UI 兼容性不能直接继承 |

两个类别都属于“DSH 生态中的云端 Agent 实现”，但回答“能不能不改代码地运行现有 DSH”时，只有第一类项目可以作为直接候选。

## 7. 原报告中无法独立确认的项目

原稿把 `AgentsDanceAI/deepseek-harness-cloud` 和后续 `AIStore` 描述成最像完整 Cloud Agent SaaS 的项目，并进一步给出 Source-Available / Community License 判断。

截至 2026-10-05，本次核验没有找到足够证据确认这一组主张：

- `AgentsDanceAI` GitHub 组织公开仓库列表中没有 `deepseek-harness-cloud` 或 `AIStore`；
- GitHub repository search 没有返回这两个确切仓库；
- 因此没有可以逐字核验的 README、LICENSE、发布记录或代码树。

这不证明它们永远不存在，可能是仓库改名、转私有、迁移到其他组织或来源不是 GitHub。但在没有可访问的原始仓库和许可证文本之前，不能把它们列为“已确认 OSS”或把自定义许可范围写成事实。

正确的记录方式是：

```text
AgentsDanceAI/deepseek-harness-cloud / AIStore
    当前证据不足，待提供原始仓库 URL 或固定 commit 后复核
```

## 8. 官方与社区能力对照

| 能力 | DSH 官方当前 checkout | 直接部署型社区项目 | Harness 重实现型社区项目 |
|---|---|---|---|
| Agent Loop | 有 | 复用 | 重建或移植 |
| Web UI | 官方 Web Host/Client 有 | 通常复用或通过 tunnel 提供 | 通常自建 |
| 内部 Remote API | 有，面向 Web Client | 通过 gateway/proxy 暴露或转发 | 自定义 API |
| 程序化入口 | ACP stdio、SDK profile | 可被外部 gateway 包装 | 自定义 HTTP/WS/DO 路由 |
| Session event log | 有，flush 是 durability barrier | 由 DSH 或平台补持久化 | 常见为 DO SQLite/数据库 |
| 多租户身份 | 没有通用 tenant 层 | 平台自行提供 | 平台或 Worker 自行提供 |
| 每租户 Sandbox | 没有统一云调度器 | 容器、Kubernetes、microVM 等 | Cloudflare Sandbox 等 |
| Workspace 跨回收持久化 | 依部署而定，不是 Web profile 的统一承诺 | PVC/volume/backup 由平台选择 | 通常需要 backup/restore，容易与 Session 脱节 |
| 配额与计费 | 没有 Cloud SaaS 控制面 | 平台自定义 | 平台自定义或尚未完整实现 |
| 公开稳定 Agent HTTP API | 当前没有完整一等产品接口 | 项目自定义 | 项目自定义 |

## 9. 对“成熟度”的批判性判断

### 9.1 已经证明的内容

当前公开代码已经证明以下方向不是纸上设计：

1. DSH 可以被放入服务器或 Sandbox，并让浏览器通过 Web Host/Client 使用。
2. DSH 的 Session 和 ACP 可以被外部程序驱动，至少在单进程 stdio 形态下成立。
3. 外部平台可以把 DSH 包进每用户容器、Kubernetes environment 或 microVM，并在入口层增加身份认证。
4. Cloudflare Durable Object、SQLite、R2 backup 和 Sandbox 可以承载一个 DSH 风格的远程 Agent Loop。
5. 通过 Cordis plugin 增加 gateway tunnel、tenant account、artifact panel 或 sandbox host，比直接修改 DSH agent-loop 更符合 DSH 的扩展方式。

### 9.2 尚未被这些仓库共同证明的内容

不能因为存在多个仓库，就认为下列能力已经成熟：

- 多副本 gateway 下的 Session/Workspace ownership 和 fencing；
- 多租户之间的完整 egress、文件、凭据和插件隔离；
- Workspace 文件、Session log、运行中进程和外部副作用的统一 checkpoint；
- long-running Agent 在 Worker 缩零、网络断开、容器回收后的准确恢复；
- 原生 DSH Web API 的公开版本兼容性；
- Plugin 安装、任意 Cordis 扩展和不可信租户代码的安全边界；
- 高并发下的配额、公平调度、成本控制和 backpressure；
- 跨区域备份、灾备和数据删除保留策略。

尤其要避免这条错误推理：

```text
Session 可 resume
    ≠ Workspace 一定可恢复
    ≠ 正在运行的 shell 可恢复
    ≠ 外部副作用可安全重试
```

### 9.3 “一用户一容器”不是充分条件

一用户一容器通常是比共享 Node 进程更合理的隔离起点，但安全结论还取决于：

- 容器是否能访问宿主 Docker socket、平台数据库或其他实例网络；
- DSH 内层 browser token 是否被入口正确保护；
- 模型 API key 是否可被 Agent 从环境、文件或进程表读出；
- Workspace volume 是否真的按用户和 Workspace 做了访问控制；
- 入口是否正确绑定 Host/Origin、Path、WebSocket 和 HTTP body；
- Sandbox 回收和重建时哪些数据保留，哪些数据丢失；
- 管理员、GC、备份和 repair 角色是否绕过租户授权但留下审计。

因此，项目 README 中的 “one container per user” 应被当作部署拓扑事实，而不是最终安全结论。

## 10. 如果目标是“基于 DSH 做云端产品”，应该怎样选路线

### 10.1 目标是尽量保持官方 DSH UI 和插件生态

优先研究直接部署型项目：

```text
DSH npm/package or upstream image
        │
        ▼
per-tenant process/container/microVM
        │
        ▼
gateway + identity + route + persistence
```

候选顺序可以是：

1. HamsterHQ：插件、tunnel 和每租户 Sandbox 的分层较清楚，适合研究如何不改上游核心接入云入口。
2. GuoMonth/dsh-multi-tenant：Kubernetes/OIDC/PVC/安装器路径更直接，适合研究企业内部部署和环境生命周期。
3. dshcloud：控制面、Workspace、版本和配额覆盖较多，适合研究单机或自托管平台，但应先处理其 README 中的早期开发和高宿主权限问题。

这些项目不能互相替代，建议固定版本后分别跑双用户、Session resume、容器重建、Workspace 写入、WebSocket 重连和凭据泄漏测试。

### 10.2 目标是边缘运行、低运维和自定义 Web UI

可以研究 Cloudflare 项目，但应接受：

- 需要重建或移植 Harness 组合；
- 官方 DSH 的 package/plugin compatibility 不会自动继承；
- Container sleep 后 Workspace 需要显式 backup/restore；
- Durable Object SQLite 的 Session durability 与文件、PTY、浏览器状态是不同领域；
- 运行时配额、区域和供应商锁定需要单独评估。

### 10.3 目标是给业务系统提供 Agent API

不要直接把 DSH Web `/api` 当成公开 API。应在 DSH 或 ACP 外面增加一层明确的 API facade：

```text
External API
  ├── API key / OAuth / tenant auth
  ├── request idempotency
  ├── session ownership and lease
  ├── quota and rate limit
  ├── event streaming and replay
  ├── workspace attachment
  └── error/version policy
          │
          ▼
DSH Web Remote or ACP stdio worker
```

facade 与 DSH 之间要明确谁拥有：

- Session writer；
- flush barrier；
- active Agent；
- Workspace generation；
- pending approval/question；
- tool side effect；
- crash recovery 和 duplicate request。

否则 API 只是在 HTTP 之上包了一层进程内状态，并没有成为可靠的 Cloud Agent service。

## 11. 建议的最小验证矩阵

对任何声称“DSH 云端、多租户、可恢复”的项目，至少执行以下验收，不要只看首页或登录截图：

| 类别 | 验证动作 | 必须观察的事实 |
|---|---|---|
| 身份 | 用户 A 访问用户 B 的 Session、Workspace、WebSocket 和 terminal id | 所有路径都拒绝，不仅是 UI 隐藏 |
| Session | prompt 后强制杀掉 Worker，再 list/resume | 已越过 flush 的事件可读；未 flush 部分有明确丢失/未知结果语义 |
| Workspace | 写文件后重建容器或 Sandbox | 文件是否恢复，恢复点是否与 Session checkpoint 一致 |
| Agent | 浏览器断开但 Worker 未退出 | Agent 是否继续、取消还是进入可恢复状态 |
| ownership | 两个 gateway/worker 同时操作一个 Session | 只有一个 writer；旧 owner 的请求被拒绝或 fenced |
| API | 重复发送相同 request id | 不产生重复 turn、重复外部副作用或重复文件写入 |
| 凭据 | Agent 运行 `env`、读取配置、访问同机服务 | 模型 key、平台 DB、其他租户 token 不可读取 |
| 网络 | 从租户 Sandbox 扫描其他 Sandbox、控制面和 metadata store | 网络和应用层都 fail closed |
| Web | Host/Origin、WebSocket、静态资源和路径前缀全部通过入口 | 不能只测试 `/` 返回 200 |
| 资源 | 并发创建、长任务、超额 CPU/内存/磁盘 | quota 失败可解释，不能由单租户拖垮平台 |
| 删除 | 删除用户、Workspace、Session 后检查备份、日志、对象和索引 | retention、GC、审计和恢复策略一致 |

没有这些验证时，项目可以称为 demo、alpha 或 self-hosted deployment；不应称为生产级 Cloud Agent Platform。

## 12. 最终结论

### 对原问题的直接回答

**DeepSeek Harness 生态已经存在云端 Agent 的开源实现，而且不止一个。** 可以确认 MIT 许可的直接部署或平台型项目至少包括：

- [`GuoMonth/dsh-multi-tenant`](https://github.com/GuoMonth/dsh-multi-tenant)；
- [`eskim2001/dshcloud`](https://github.com/eskim2001/dshcloud)；
- [`HuChundong/HamsterHQ`](https://github.com/HuChundong/HamsterHQ)；
- [`dorisgyl/dsh-cloud`](https://github.com/dorisgyl/dsh-cloud) 和 [`dravengarden/deepseek-harness-cloudflare`](https://github.com/dravengarden/deepseek-harness-cloudflare) 则属于 MIT 许可的 Cloudflare/Harness 重实现或移植，不应与官方 DSH 直接部署混为一谈。

`vocsong/deepseek-harness-portal` 是公开的多租户 DSH Portal，但当前没有可确认的标准许可证。`AgentsDanceAI/deepseek-harness-cloud` 和 `AIStore` 在本次核验中没有找到足够的原始仓库证据，暂不列入已确认项目。

### 对 DSH 官方能力的直接回答

DSH 官方当前提供：

- 可在远端主机运行的 Agent Runtime；
- Host/Client Web UI 和内部 Remote API；
- 持久 Session persistence；
- ACP stdio 程序化驱动；
- 可通过 Cordis plugin 增加平台集成。

DSH 官方当前没有作为完整产品交付：

- 面向第三方业务的稳定 Cloud Agent HTTP/WS API；
- 通用多租户认证和授权；
- 跨 Worker Session ownership、fencing 和调度；
- 统一的 Workspace/Sandbox/Session checkpoint；
- 官方托管的多租户 Cloud Agent SaaS。

最准确的一句话是：

> **DSH 已经是一个适合被云平台承载的 Agent Runtime；社区已经把它包装成多个早期的多租户 Cloud Agent 部署；但“官方 Remote API”与“官方 Cloud Agent 产品”仍然是两个尚未合并的概念。**

如果只比较这三个直接部署型项目，可以作出更具体但仍然有限的判断：`dshcloud` 的产品表面和公开关注度最高，但 README 明确禁止生产使用；`dsh-multi-tenant` 的近期开发和 release 活动最强，但仍是 Alpha、单平台副本且没有 HA/DR 保证；HamsterHQ 的 runtime isolation、outbound tunnel 和 Cordis plugin 分层最有架构研究价值，但社区关注度最低、没有正式 Release，且本地 Docker 模式与 CubeSandbox 生产模式不能混为一谈。三者都应称为早期 Cloud Agent 部署或平台原型，而不是已经广泛生产验证的成熟 SaaS。

还需要把这项结论与当前的 browser-native DSH 目标区分开来：上述项目主要是“浏览器访问服务端 DSH Agent Runtime”，Agent Loop 仍在服务器、容器、Kubernetes Pod 或 microVM 内执行；它们没有直接证明“Agent Loop 在浏览器中执行、同域代理 LLM、Session 状态由后端持久化”的 browser-native 方案已经被社区完整实现。

## Further Exploration

### 本地 DSH 依据

- [Web app README](../../packages/bundle/web-app/README.md)
- [Web startup parser](../../packages/bundle/web-app/src/startup.ts)
- [Web startup tests](../../packages/bundle/web-app/tests/startup.spec.ts)
- [Client connection README](../../packages/client/connection/README.md)
- [Session Controller](../../packages/api/session-controller/src/index.ts)
- [API gateway README](../api-gateway.md)
- [ACP README](../../packages/acp/acp/README.md)
- [ACP application profile](../../packages/bundle/acp-app/README.md)
- [Session persistence service definition](../../packages/session/session-persistence/src/index.ts)
- [Adding a Remote API](../cookbook/adding-a-remote-api.md)
- [DSH CLI reference](../../apps/cli/reference/README.md)

### 外部项目

- [`GuoMonth/dsh-multi-tenant`](https://github.com/GuoMonth/dsh-multi-tenant) — MIT；Kubernetes/OIDC/每用户环境；Alpha。
- [`eskim2001/dshcloud`](https://github.com/eskim2001/dshcloud) — MIT；控制面、Workspace 容器、配额；README 明确为早期开发。
- [`HuChundong/HamsterHQ`](https://github.com/HuChundong/HamsterHQ) — MIT；gateway/tunnel/每租户 Sandbox；官方 DSH npm 依赖。
- [`vocsong/deepseek-harness-portal`](https://github.com/vocsong/deepseek-harness-portal) — 公开 Portal；许可证未确认。
- [`dorisgyl/dsh-cloud`](https://github.com/dorisgyl/dsh-cloud) — MIT；Cloudflare 上的 Harness/DSH port；Workspace 回收持久化仍有限制。
- [`dravengarden/deepseek-harness-cloudflare`](https://github.com/dravengarden/deepseek-harness-cloudflare) — MIT；Workers-native Harness port；不是官方 CLI/Web GUI 的 drop-in replacement。

## Dev Note

<details>
<summary>研究稿的证据边界与维护方式</summary>

本文是 `docs/drafts/` 下的中文单语研究稿，不是 DSH、任何社区项目或云供应商的产品承诺。外部仓库的 Stars、Forks、默认分支、README 和许可证会变化；再次使用本文做架构决策前，应按记录的原始仓库 URL 和固定 commit 重新核验。项目自述的“已验证”“production-ready”“安全”字样只记录为项目方陈述，不替代独立审计或部署验收。

本稿特别保留了三类容易被混淆的对象：

```text
official DSH deployment
    官方 DSH + 外部云平台

DSH ecosystem implementation
    重新实现或移植 Harness 核心的第三方项目

cloud product claim
    身份、租户、Workspace、Sandbox、API、配额和恢复的完整平台承诺
```

后续如果 DSH 增加 HTTP ACP、公开 Agent API、`0.0.0.0` 安全部署模式或官方多租户服务，应更新本文的第 3、4、8 和 12 节，并重新核验第三方兼容性。若外部项目改名、迁移或公开许可证，更新第 5、6、7 节时应记录新的固定 commit 或发行版本，而不是只改项目名称。

`scripts/translation-pairing.manifest.json` 将本文排除在双语配对之外；该清单改动只服务于文档门禁，不代表 DSH runtime 代码发生变化。

</details>
