---
description: "供部署与平台工程师查阅 DeepSeek Harness 在只读工作区、无模型可见文件能力、多租户 Web 和请求级执行中的当前依赖与隔离限制。"
---

# DeepSeek Harness 部署、租户隔离与请求执行参考

## Summary

本参考帮助部署与平台工程师判断 DSH 能否在只读工作区运行、哪些 Host 路径仍需可写，以及何时必须为租户提供独立进程或外部隔离。它说明当前 Web 进程、Session persistence 和 `dsh-headless` 的生命周期与安全限制。读者可以据此区分只读工作区、无模型可见文件能力和无持久磁盘三种目标，并确认当前 headless runner 没有整轮步数或墙钟预算。

## Table of Contents

- [术语与结论](#术语与结论)
- [Web 进程、Host 服务与 Session](#web-进程host-服务与-session)
- [文件系统与运行时依赖](#文件系统与运行时依赖)
- [租户隔离边界](#租户隔离边界)
- [headless 执行与整轮预算](#headless-执行与整轮预算)
- [部署选择](#部署选择)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

## 术语与结论

以下术语描述不同的部署目标，不能互换：

- **只读工作区**：Agent 可以读取和搜索工作区，但 DSH 文件沙箱拒绝受其控制的修改；Host 状态仍可写入另一个位置。
- **无模型可见文件能力**：Agent 不获得文件、Shell 和其他本地进程工具；Host 仍可能用文件系统加载代码、配置并保存状态。
- **无持久磁盘**：Session、storage 和 attachments 使用内存或远程 provider；Node、插件和 profile 仍从部署环境的文件系统加载。
- **每租户 worker**：一个 DSH 进程只服务一个租户，但可承载该租户的多个 Session；它不等于每个 HTTP 请求启动一个进程。

| 部署目标 | 当前可行路径 | 主要限制 |
|---|---|---|
| 标准编码能力，工作区只读 | 只读挂载工作区；保留读取、搜索、工作区指令和 Skills；为 Harness home 与临时目录提供独立可写位置 | `read-only` 只限制受 DSH 沙箱控制的修改，不隐藏可读路径 |
| Agent 不接触本地文件或进程 | 使用自定义 profile 和 preset，不挂载文件、Shell、搜索及其依赖 | 不再提供文件编辑、搜索、Shell、工作区指令和磁盘 Skills |
| 不持久写入本地磁盘 | 为 Session persistence、storage、attachments 和其他 Host 状态提供内存或远程实现 | 当前没有随包提供的内存 SessionPersistence；内存 storage 不能替代它 |
| 可信租户共享一个进程 | 在同一 Host 树或不同 Cordis 树中承载多个 Session，并显式分配资源根目录 | 仍共享 Node 堆、模块缓存、环境变量和操作系统权限 |
| 互不信任的租户 | 在认证网关之后使用每租户容器、微虚拟机或远程执行器 | Cordis scope、Session id 和 DSH 本地沙箱不是恶意租户安全边界 |
| 一次请求执行一个任务 | 使用 headless 的一次执行语义，或由服务层驱动 Agent | 当前没有整轮步数或墙钟预算；可靠上限需要取消和进程监督 |

## Web 进程、Host 服务与 Session

DSH 只支持通过命名 profile 启动 Node 应用。profile 按顺序组合 bundle patch、profile patch、`$DSH_HOME/cordis.patch.yml`、命令行 `--patch` overlay 和遥测开关层；`web`、`headless`、`sdk`、`sdk-minimal` 与 `acp` 是不同应用组合，详见 [DSH Architecture](../architecture.md)。

### 一个 Web 进程承载多个 Session

一次 `web` profile 启动创建一棵长期存活的 Cordis Host 树。Web Session Controller 把 Agent registry、attachments、file uploads、Session persistence/query/projections 和 workspace registry 组合到这棵树中；新增 workspace 或 Session 不会自动创建新的 Web Host 进程，详见 [Session Controller](../../packages/api/session-controller/src/index.ts)。

Host 服务通常在 profile 启动时装载并由同一棵树共享，包括 filesystem provider、Session persistence、storage、settings、credentials、attachments、spill store、subagent registry、HTTP server 和 API Gateway。一个 Node 进程还共享堆、模块缓存、`process.env` 和操作系统权限。

标准 Agent preset 属于 Agent 可见的组合。preset roster 为每个 preset id 的每个 composition 文件 generation 建立一个 single-flight standing mount；同一 generation 的 Agent 共享工具和提示注册。文件变化后，未来 Agent 使用新 generation，已经加入的 Agent 继续使用旧 generation。Session log、inbox、Agent 状态以及插件按 Session 或 Agent 建立的可变状态仍各自归属，详见 [agent-presets](../../packages/preset/agent-presets/src/index.ts) 和 [standard preset](../../packages/preset/agent-presets/presets/standard/agent.cordis.yml)。

Cordis scope 控制注册可见性，不隔离进程资源。当前 Web Session Controller 优先复用 live Agent；它没有按 HTTP 请求释放 Agent 的通用路径，Agent 会一直存在到拥有其生命周期的组件或整棵树将其 dispose。

### 工作区归属与 Session 持久化

`session.header.cwd` 是 Session 的不可变工作目录。有 Agent 时，`tool-fs` 按 Session cwd 解析相对路径。无 Agent 时，读取使用 filesystem provider 的默认目录；在启用 confining filesystem 时，`write` 和 `edit` 使用当前 sandbox policy 的 `workspaceRoot`，详见 [tool-fs cwd resolution](../../packages/fs/tool-fs/src/session-cwd.ts)。这些规则使同一进程中的 Session 可以指向不同工作区，但不阻止绝对路径访问。

Session log 保存可重放的会话事实。安装 Session persistence 时，Agent 创建或恢复会取得写句柄；没有 persistence 时，Session 仍可在当前进程内运行，但进程退出后不能恢复。跨进程 resume 本身只需要 SessionPersistence；按 id 发现或观察 cold Session 的入口（例如当前 Web 和 `dsh-headless --session-id`）还需要 session query。Agent 到达 `idle` 不等于数据已经通过持久化屏障；要求 durability 的调用方仍需 flush Session，详见 [agent-loop persistence integration](../../packages/core/agent-loop/README.md#persistence-integration)。

JSONL backend 对每个 Session 实施单写者租约。已存在 Session 在 write-open 时加锁，新 Session 在第一次产生持久写入之前惰性加锁；第二个 writer 会失败，而不是并发追加。应用层不应依赖 JSONL 的物理目录命名，详见 [JSONL persistence limitations](../../packages/session/session-persistence-jsonl/README.md#known-limitations-and-deferred-work)。

在 POSIX 上，租约是 `session.lock` 上的非阻塞 `flock(2)`；Windows 使用由该路径派生的具名内核信号量。进程死亡会释放内核对象，仍存活但卡住的 writer 会继续持有租约；该租约没有超时。

POSIX 的锁绑定 inode，绝不能删除仍由 live writer 使用的 `session.lock`。删除会破坏互斥：旧 writer 继续持有已 unlink 的 inode，而新 writer 可以创建并锁住新 inode。正常 release 只关闭 descriptor，不删除 lock file。

-----

## 文件系统与运行时依赖

标准编码体验依赖工作区文件能力，但 Agent loop、模型适配器和 Session 事件模型不绑定某一种 filesystem provider。部署必须分别处理 Agent 可见能力和 Host 自身状态。

### 标准 preset 的 Agent 能力

标准 preset 组合文件读写、文件搜索、Shell、filesystem Skills、工作区指令和 `present` 等编码能力。`tool-fs` 需要 `ctx.fs`；`skill-filesystem` 直接读取宿主文件系统而不注入 `ctx.fs`，`agent-instructions` 读取工作区指令；`present` 需要 filesystem 和 Session projection 服务。完整条目以 [standard preset](../../packages/preset/agent-presets/presets/standard/agent.cordis.yml) 为准。

`tool-fs-search` 是一个重要例外：它不注入 `ctx.fs`，而是通过 `ctx.subprocess.spawn()` 调用 npm 依赖携带的 `@vscode/ripgrep`。因此它不要求系统安装 `rg`，也不经过 Shell，但仍需要本地 subprocess 能力和可访问的工作目录，详见 [filesystem search tools](../../packages/fs/tool-fs-search/src/index.ts)。

自定义 preset 可以移除这些条目而保留 Agent loop 与模型调用，但它不再是完整的标准编码体验。删除 provider 后，Loader 必须重新解析完整 composition；仍注入已删除 service 的 consumer 会保持未满足或使相应能力不可用。

### Host 的可写状态

base 和 Web 组合使用多种 Host 状态实现，例如 JSONL Session persistence、JSON storage、local attachments、credentials、settings、projection cache 和 spill。它们不都通过 `ctx.fs` 写入，因此把 `sandbox-policy` 设为 `read-only` 不会把 Host 状态变成只读或内存状态。

普通 profile boot 也需要可写的 Harness home。CLI 会准备 profile 根 `cordis.yml`；profile 初始化和模块 fallback 可能在 `$DSH_HOME/profiles` 下创建 manifest、patch、workspace 文件以及链接或代理，详见 [profile boot](../../apps/cli/src/profile-boot.ts) 和 [profile layout](../../packages/boot/app-boot/src/profile.ts)。

运行镜像至少需要满足根 `package.json` 的 Node engine（`^22.19.0 || >=24.0.0`）、构建后的 `dsh`、所选 profile 的插件依赖以及 Loader 可解析的 manifest。模型请求还需要网络和可解析的模型凭据。Web 工具、遥测、PTY、Shell 和本地沙箱只在启用对应能力时增加依赖。

Shell 工具在 POSIX 组合中调用 `bash -c`，在 Windows 组合中调用 PowerShell；文件搜索使用随包提供的 ripgrep。Linux local sandbox 在当前 runner chain 中选择 bubblewrap 或 Landlock，macOS 使用 Seatbelt，Windows 使用 restricted token 与 ACL；请求的限制模式无法提供时，本地 sandbox fail closed。可用 runner 仍可能报告 partial enforcement，完整平台条件由 [sandbox README](../../packages/sandbox/sandbox/README.md) 所有。

### 只读工作区

只读部署可以保留文件读取、搜索、工作区指令和磁盘 Skills，并把工作区作为只读挂载。`sandbox-policy: read-only` 使受 DSH 文件沙箱控制的 mutation 被拒绝，但 [fs-sandbox](../../packages/fs/fs-sandbox/src/index.ts) 让读取直接通过底层 provider；它不是读取隔离或路径隐藏机制。

Harness home、临时目录以及启用的 Host provider 仍需可写位置。部署可以把这些位置放入持久卷或 tmpfs；tmpfs 避免持久落盘，但仍是文件系统，并且进程退出后会丢失其中的状态。

若需要跨进程恢复 Session，应保留 JSONL persistence 或提供另一个 SessionPersistence provider。`storage-sqlite` 的 `path: ':memory:'` 只替换由 `storage-domain` 路由到 `sqlite` 的 domain storage，不能保存 Session log，详见 [storage-sqlite README](../../packages/storage/storage-sqlite/README.md)。

### 无模型可见文件能力

这类部署需要从自定义 profile 和 preset 中移除所有模型可见的文件与进程能力，包括直接访问宿主文件系统的 `skill-filesystem`、注入 `fs` 的 `tool-fs` 与 `present`、基于 subprocess 的文件搜索、工作区指令和 Shell。配置行 id 与 package 名并不总相同，因此应以当前 [base composition](../../packages/bundle/base/cordis.patch.yml) 和 [standard preset](../../packages/preset/agent-presets/presets/standard/agent.cordis.yml) 为准，而不是维护一份复制的完整清单。

移除 Agent 工具不会自动移除 Host 对磁盘的使用。完整 Web GUI 仍需要为 Session persistence/query、workspace storage、attachments 和 uploads 提供相容实现；不能通过删除几个文件工具就获得无持久磁盘的 Web，详见 [Session Controller](../../packages/api/session-controller/src/index.ts)。

当前仓库没有随包提供的内存 SessionPersistence provider。若移除 JSONL persistence，进程内 Agent 仍可工作，但 `dsh-headless --session-id`、跨进程接管和进程退出后的历史恢复不可用。需要无本地持久磁盘且可恢复的部署必须增加远程或数据库 SessionPersistence provider。

## 租户隔离边界

DSH 支持同一进程中的多个 Session 和工作区，但当前浏览器认证、Host provider 与本地 sandbox 不构成互不信任租户之间的完整隔离。

### 浏览器认证不是租户授权

Web 进程生成 launch token，并只在根 URL 交换中用它签发浏览器 cookie。签名 secret 由 credentials provider 保存；复用同一 Harness home 和 credential record 时，未过期 cookie 可在进程重启后继续验证。cookie 绑定 authority，Host/Origin 检查防御 DNS rebinding 和跨站浏览器请求，详见 [client connection authentication](../../packages/client/connection/README.md)。

该机制不表达用户、组织、tenant claim 或 Session 所有权。随包 Web server 使用 loopback HTTP，不提供远程部署所需的 TLS、OIDC 或 mTLS。远程服务必须在外部网关和每个资源操作处验证身份、tenant 归属及 Session 所有权；客户端提供的 opaque `sessionId` 不能替代授权。

### 文件与进程隔离

DSH 本地 sandbox 是 same-world confinement。它限制受支持执行器的文件效果，但不能消除同一进程或同一操作系统用户可见的只读文件、环境变量、凭据、网络和 native 权限。互不信任租户需要容器、微虚拟机或远程 executor，并由外层限制挂载、身份、临时目录、凭据、网络和进程资源，详见 [sandbox README](../../packages/sandbox/sandbox/README.md)。

用户 preset、extensions、MCP 与 Shell 能力都应按可执行代码处理。为不同租户创建不同 Cordis scope，甚至在一个 Node 进程中创建多棵 Cordis 树，仍会共享进程堆、模块缓存、环境和操作系统权限；这种部署只适用于相互信任的租户。

### 进程与 Session 的接管

独立进程提供堆、故障和生命周期隔离，但同一操作系统用户下的普通进程不自动提供文件、网络或凭据隔离。需要安全隔离时，部署单位应是容器、微虚拟机或远程执行器，而不只是 Node 子进程。

缩容或迁移 worker 时，旧进程必须关闭 Session write handle，或者由 supervisor 真正终止，另一个进程才能取得同一 Session 的写租约。租约冲突只能作为 busy 状态处理或进入有界排队；删除 lock file 或让两个 writer 同时追加都不安全。

Agent 的 `idle` 状态只表示没有活动 driver 或 maintenance task，不概括 jobs、terminals、uploads 或等待用户的进程内交互。任何 scale-to-zero 控制器都必须在进程外定义并观察完整活动集合；DSH 当前没有提供一个统一的“租户可回收”状态。

-----

## headless 执行与整轮预算

`dsh-headless` 提供一次执行一个任务的 runner，但不是带整轮预算、可持久挂起交互和后台任务接管的 HTTP 执行服务。

### 一次执行的当前语义

一次 headless 调用创建新 Agent，或只在目标 id 已持久化且 cwd、preset 与 lineage 均相容、并无当前进程内的 live owner 时恢复；未知 Session id 或缺少恢复所需 service 时失败。runner 先等待 Agent idle，再记录执行区间、提交一个任务、再次等待 idle、flush Session，并报告该区间的助手输出与 `turn/end` reason，详见 [dsh-headless README](../../packages/bundle/headless/README.md) 和 [headless runner](../../packages/bundle/headless/src/index.ts)。

`Agent.whenIdle()` 等待整个 Agent 达到静止状态，不标识某条消息的专属完成。扩展点或 inbox 输入可以在原工作结束前加入后续工作，因此调用方需要按事件区间归属一次执行，而不能把一个 `whenIdle()` Promise 当作消息句柄。

### 当前没有整轮预算

headless 配置只有 `task`、`sessionId` 和 `json`，没有 `maxSteps`、`maxIterations` 或 `maxWallClockMs`。runner 在 `whenIdle()` 外也没有总 deadline。Agent loop 明确没有内建 turn budget；工具调用或 steering 可以让当前 turn 继续，详见 [agent-loop limitations](../../packages/core/agent-loop/README.md#known-limitations-and-deferred-work)。

局部限制不能替代整轮预算。模型 route 可以为单个 step 设置或物化输出 token 上限，但核心 loop 不保证每个 adapter 都有该上限。工具定义可以声明可选 `timeoutMs`，只有启用 `tool-call-timeout-policy` 时才执行该协作式 deadline，且工具必须转发并响应 `exec.signal`。Shell 和 subprocess provider 也有各自 timeout；这些限制分别约束一次模型请求、工具调用或子进程，而不限制整个 ReAct turn。

Agent 提供 `cancel()`、`whenIdle()` 和生命周期扩展点。`agent/pre-step` 可以在下一 step 前返回 `{ kind: 'reject' }`，当前 loop 会把它持久化为 `turn/end { kind: 'blocked' }`；取消当前活动则使用已有的 `aborted` reason。仅通过 TypeScript declaration merging 增加 `budget` reason 不会改变 loop 的 reason 传播，详见 [agent loop implementation](../../packages/core/agent-loop/src/agent.ts) 和 [Session turn-end reasons](../../packages/core/session/src/types.ts)。

对请求级服务而言，step 计数可以在 `agent/pre-step` 拒绝下一 step，墙钟 deadline 可以调用 `agent.cancel()`；但这两种方式都是协作式的，不能强制终止忽略 AbortSignal 的工具、native code 或子进程。可靠墙钟上限还需要进程 supervisor 在 grace period 后终止执行单元。这个控制器和对外状态映射不是当前 headless runner 的内建功能。

### 交互与后台工作不会自动跨进程挂起

`userQuestions.ask()` 等待当前进程中的 answerer waterfall。审批会把 asked/decided 结果写入 Session 作为审计事实，但等待答案的 Promise 仍属于当前进程。进程退出后，Session log 本身不能恢复未完成的提问或审批，详见 [user questions](../../packages/interaction/user-questions/src/index.ts) 和 [user approval](../../packages/interaction/user-approval/src/index.ts)。

短生命周期 HTTP runner 如果需要在请求之间恢复交互，就必须另行持久化 pending interaction、调用者归属和答案，并在重新取得 Session 写租约后恢复执行。它还必须禁用不能在请求结束前完成的后台能力，或把其所有权转交给长期存活的 worker；DSH 当前没有通用的请求挂起与后台任务移交协议。

## 部署选择

以下选择是由当前限制得出的部署建议，不是 DSH 已发布的多租户控制面 API。

### 默认：认证网关与每租户 worker

远程多租户部署宜让外部网关负责 TLS、身份认证、授权、限流、请求取消和租户路由，并为每个租户分配可回收的 DSH worker。一个 worker 可以复用 profile、插件注册和模型路由来服务同一租户的多个 Session；只有互不信任租户才需要进一步把 worker 放入独立容器、微虚拟机或远程执行环境。

该形态把 HTTP 请求、Agent 执行、Session durability 和 worker 生命周期分开。worker 可以在请求之间保留 Host 树，也可以在所有业务活动结束且 Session 已 flush、write handle 已关闭后缩容到零。活动判定、按请求释放 Agent 和 drain 状态机都属于需要新增的部署控制面，不是当前 DSH Web 提供的功能。

### 每请求进程的适用范围

每请求启动进程可以回收整个 Node 堆，并为执行设置清晰的 supervisor 截止时间，但普通进程本身仍不是租户安全隔离。它还会重复 profile boot、插件加载和 Session 恢复，并把流式响应、信号处理、子进程清理和写租约交接放到每个请求的关键路径。

仓库的 Session-open benchmark 用于检测恢复性能回归，不构成任意生产部署的延迟承诺，详见 [session-open benchmark](../../benchmarks/session-open/session-open.bench.ts)。采用每请求进程前，应在目标镜像、真实 profile、代表性 Session 历史和目标存储上测量端到端启动与恢复成本。

### 选择顺序

1. 先确定租户是否互信，并选择普通进程或容器、微虚拟机、远程 executor 作为隔离单位。
2. 再决定工作区是可写、只读，还是不向 Agent 暴露文件与进程能力。
3. 为 Session persistence、storage、attachments、credentials、Harness home 和临时目录分别选择持久、临时或远程实现。
4. 最后决定常驻 Host、每租户可回收 worker 或每请求进程，并由外部控制面实现 activity tracking、drain 和 hard deadline。

-----

## Further Exploration

- [DSH Architecture](../architecture.md) — profile 组合、应用启动、Agent loop 和能力 provider 的总体地图。
- [Standard preset](../../packages/preset/agent-presets/presets/standard/agent.cordis.yml) — 标准 Agent 当前挂载的工具与提示组合。
- [JSONL Session persistence](../../packages/session/session-persistence-jsonl/README.md) — Session durability、物理存储限制和跨进程单写者租约。
- [Sandbox](../../packages/sandbox/sandbox/README.md) — same-world confinement、平台 runner 与外部隔离责任。
- [Browser connection](../../packages/client/connection/README.md) — Web launch token、cookie、Host/Origin 检查和远程暴露限制。
- [Headless runner](../../packages/bundle/headless/README.md) — 一次执行、Session 恢复和机器可读输出。
- [Agent loop](../../packages/core/agent-loop/README.md) — turn/step 生命周期、取消、持久化与当前预算限制。

-----

## Dev Note

<details>
<summary>非权威的后续设计范围</summary>

本文保留在 `docs/drafts/`，是单语 scratch reference；`scripts/translation-pairing.manifest.json` 将它排除在双语配对之外，网站也不发布它。若要实现多租户控制面，应由独立 Agent Note 定义 tenant 资源归属、worker activity/drain、请求 budget、pending interaction 和后台任务移交，并在实现时更新拥有这些行为的 package README、持久化类型确认、两个 SDK 的投影与快照。

</details>
