---
description: "系统评估 PostgreSQL-backed filesystem 如何把依赖本地文件系统的 Agent 迁移为计算临时化、工作区持久化的云端多租户 Agent，并给出 WorkspaceFS 的架构、数据模型、安全边界和 PoC 路线。"
---

# 面向云端 Agent 的 Remote Durable Workspace：PostgreSQL-backed Filesystem 的架构、边界与 PoC 路线

## Summary

本报告研究的对象不是“如何把几个文件保存到 PostgreSQL”，而是如何让原本依赖 `/workspace` 的 Agent 在不重写文件工具的前提下，获得可持久化、可恢复、可共享、可隔离的云端工作区。核心建议是把产品抽象定义为 **Remote Durable Workspace**，把 PostgreSQL-backed filesystem 作为第一种存储实现，而不是把 PostgreSQL 直接当作完整 POSIX 磁盘。TigerFS v0.7、Tarbox、postgresqlfs 和 AgentFS 已经验证了不同的数据库文件系统路径，但它们的兼容性、许可、历史能力和生产成熟度不同，不能相互替代。对 DSH 而言，第一阶段应采用 Node-level mount，让 Shell、Git、LSP 和 `ctx.fs` 共享同一个 execution world；单纯替换 `ctx.fs` provider 只能验证特定 filesystem consumer，不能宣称现有 Agent 无需修改。

## Table of Contents

- [执行摘要与证据边界](#执行摘要与证据边界)
- [真正要解决的问题](#真正要解决的问题)
- [Agent 文件系统兼容目标](#agent-文件系统兼容目标)
- [PostgreSQL 的适用性与代价](#postgresql-的适用性与代价)
- [外部实现与替代路线](#外部实现与替代路线)
- [Remote Durable Workspace 目标架构](#remote-durable-workspace-目标架构)
- [数据模型与事务语义](#数据模型与事务语义)
- [多租户、安全与许可](#多租户安全与许可)
- [性能、一致性与故障恢复](#性能一致性与故障恢复)
- [面向 DSH 的适配判断](#面向-dsh-的适配判断)
- [PoC 与验收路线](#poc-与验收路线)
- [结论与推荐决策](#结论与推荐决策)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

## 执行摘要与证据边界

本节先给出可以直接用于技术评审的结论，再说明哪些内容来自外部项目或官方文档，哪些内容属于本报告的设计判断。

### 结论先行

| 问题 | 结论 |
|---|---|
| PostgreSQL 能否承载 Agent 工作区 | 能，尤其适合大量小文件、强元数据访问、事务更新、版本记录和审计查询；它不是所有大对象和高吞吐数据集的最佳后端 |
| 是否应该改造 Agent 让它调用 Remote File API | 不作为第一路线；优先保留 Agent 的 `/workspace` 认知，在下方提供 filesystem compatibility layer |
| 是否应该把 TigerFS 直接当作最终 SaaS 产品 | 不应该；TigerFS 是重要参考实现，但它的 File-first 能力、TimescaleDB 依赖和并发 undo 限制都需要独立评估 |
| 是否必须使用 TimescaleDB | 不必须；PGFS 核心可以使用原生 PostgreSQL 的事务、MVCC、索引、分区、RLS 和 `BYTEA`/TOAST，TimescaleDB 可作为可选增强 |
| FUSE 是否是租户安全边界 | 不是；FUSE/CSI 是兼容接入层，租户授权和隔离必须在 Storage Service 与数据库安全策略中执行 |
| V1 是否应该追求完整 POSIX | 不应该；应先保证真实 Agent 高频使用的 open/read/write/mkdir/readdir/stat/rename/unlink/fsync 和 atomic replace |
| 第一阶段的接入决策 | 采用 Node-level FUSE mount，把 `/workspace` 挂入与 DSH subprocess 同一 execution world；Remote `ctx.fs` provider 只作为特定工具的补充接口 |
| 最有价值的第一步 | 对真实 Agent 采集 filesystem workload，随后实现单节点 PostgreSQL + FUSE PoC，并用代码编辑、Git、测试和包管理器验证语义 |

### 事实、判断与建议的区分

本文将内容分为三类。**外部事实**来自项目仓库、release notes、官方文档或 PostgreSQL 文档，并在相关章节提供链接；**设计判断**是根据这些事实和 Agent workload 得出的架构结论；**建议目标**是尚未实现、必须通过 PoC 或生产测试验证的目标。GitHub Stars、更新时间和 release 标签只作为调研时点的生态信号，不作为生产成熟度或安全性的证明。

本文的资料核验截止日期为 **2026 年 9 月 22 日**。外部项目的版本、许可证、项目状态和公开指标可能继续变化；本文以链接指向的资料和该核验日期为证据边界。

-----

## 真正要解决的问题

本节把“数据库文件系统”还原成云端 Agent 的部署问题：计算运行时可以销毁，但 Agent 的工作区必须保持可恢复。

### 本地 Agent 的隐含前提

典型 Agent 表面上只拥有 LLM、工具和循环，但它的工具经常通过 `open`、`Path`、Shell、Git、ripgrep、编译器和包管理器间接依赖一个低延迟、可读写、近似 POSIX 的 `/workspace`。这个依赖通常没有出现在 Agent 的业务协议里，因此把 Agent 搬到云端时，文件系统才是最难替换的基础设施。

```text
Agent
  ├── model
  ├── tool loop
  ├── shell / subprocess
  └── /workspace
          │
          ▼
      local filesystem
          │
          ▼
      local disk
```

### 传统云化方案的侵入性

最直接的云化方案是让 Agent 改为调用 `read_file`、`write_file`、`list_dir` 等 Remote File API，再由 API 访问对象存储或数据库。这会把同步、flush、冲突、重试和权限判断暴露给 Agent，进而迫使 Shell、编辑器、Git、LSP 和每一个文件工具分别适配。

```text
Agent
  ↓
Remote File API
  ↓
cache / sync engine
  ↓
object storage or database
```

这种设计把基础设施选择泄漏到了 Agent 层。它还容易产生“模型知道什么时候 push、什么时候 pull”的错误职责划分，增加 prompt、工具协议和恢复逻辑的复杂度。

### 推荐的重新定义

更稳定的抽象是 **Remote Durable Workspace**：Agent 只继续看到 `/workspace`，而计算沙箱、挂载客户端、Storage Service 和数据库共同承担持久化、版本、授权、恢复和共享。

```text
                         SaaS control plane
                                  │
                          workspace_id
                                  │
                  ┌───────────────┴───────────────┐
                  │                               │
             Agent sandbox A                 Agent sandbox B
                  │                               │
              /workspace                     /workspace
                  │                               │
                  └───────────────┬───────────────┘
                                  │
                         WorkspaceFS client
                                  │
                             RPC / mount
                                  │
                         WorkspaceFS service
                                  │
                           PostgreSQL
```

沙箱可以在 Session 结束后被销毁，workspace 可以继续存在；下一次 Session 只需创建新的沙箱并重新挂载相同的 `workspace_id`。这比把“记忆”全部塞进 Agent prompt、Session metadata 或另一个专用 memory store 更接近 Agent 的真实工作方式，因为代码、配置、研究结果、构建产物和任务状态本来就通过文件被消费。

### 这个问题不等于“替代整个 Linux 文件系统”

Agent Runtime 中的路径应按责任拆分。镜像中的 `/bin`、`/etc` 和运行库由镜像提供；`/tmp`、编译缓存和部分依赖可以留在 ephemeral disk；Secrets 应由 Secret Manager 提供；超大数据集和模型权重可以进入对象存储或专用卷；只有需要跨沙箱保存、共享或审计的 workspace 内容进入 WorkspaceFS。

```text
/
├── bin/                 image
├── etc/                 image
├── tmp/                 ephemeral
├── dev/                 container / VM
├── home/agent/cache/    ephemeral or local cache
└── workspace/           Remote Durable Workspace
```

这个边界把问题从“实现一个通用 Linux filesystem”收敛为“实现 Agent 使用的 filesystem compatibility set”，同时允许高吞吐或高风险路径使用更适合的后端。

### DSH 第一阶段接入决策

DSH 的第一阶段不把“远程 `ctx.fs` provider”当作完整 Agent filesystem 方案，而采用 Node-level mount：WorkspaceFS client 或 FUSE adapter 在 Agent sandbox 外部挂载 `/workspace`，再把该路径注入与 DSH subprocess、Shell、ripgrep、Git、LSP 和编译器相同的 execution world。`ctx.fs` 可以继续提供稳定 target identity、受限文本操作和 typed errors，但它不承担低层 file handle、offset write、rename、unlink 或 fsync 的全部语义。

| 方案 | `/workspace` 来源 | `ctx.fs` 作用 | Shell/Git/LSP | 第一阶段决策 |
|---|---|---|---|---|
| Node-level mount | 外部 FUSE/NFS/CSI 挂载点 | 访问同一挂载世界的高层接口 | 直接使用挂载路径 | **采用** |
| Remote subprocess executor | 远端 sandbox 的 filesystem | 远端控制与元数据接口 | 与远端进程共享 namespace | 第二阶段评估 |
| Remote `ctx.fs` provider | provider 自己解析远程路径 | DSH filesystem consumers | 不能自动覆盖普通进程 | 仅作补充 |
| 混合方案 | mount 与 remote API 同时存在 | 需要定义唯一事实来源 | 需要避免两个 namespace | 不作为第一阶段默认 |

在统一 execution world 之前，项目只能宣称“远程 filesystem provider PoC”或“挂载层 PoC”，不能宣称“现有 Agent 无需修改”。只有 Shell、ripgrep、Git、LSP、编译器、文件工具和恢复流程都使用同一个 workspace namespace，并通过兼容性测试后，才可以使用后一个结论。

-----

## Agent 文件系统兼容目标

完整 POSIX 兼容不是一个有用的第一版目标。应先从真实 Agent 的系统调用和工具行为定义兼容集合，再决定哪些语义进入核心。

### 三层兼容集合

| 层级 | 第一版应支持的能力 | 典型使用者 |
|---|---|---|
| L0 | `open`、`read`、`write`、`pread`、`pwrite`、`close`、`create`、`truncate`、`mkdir`、`rmdir`、`readdir`、`stat`、`lstat`、`rename`、`unlink`、`fsync` | Agent 文件工具、Shell、Git、ripgrep、编译流程 |
| L1 | `chmod`、`utimensat`、symbolic link、hard link、`flock`/`fcntl`、rename-over-existing、临时文件和 atomic replace | 编辑器、包管理器、Git index、语言工具链 |
| L2 | `mmap`、xattr、完整 ACL、special files、device node、socket、FIFO、sparse file、ioctl、精确 inotify 语义 | 特定构建系统、数据库、系统级工具和高保真 Linux 工作负载 |

L0 不代表“简单”。对云端 Agent 最关键的语义通常不是连续读吞吐，而是路径查找、目录列举、临时文件、重命名覆盖、并发修改和写入后的可见性。

### V1 操作语义

下表是建议在 PoC 进入实现前冻结的 V1 语义。`visible` 指其他已授权客户端可以观察到新 namespace 或内容；`durable` 指满足本报告 durability policy 的确认，不等于所有灾备拓扑下都保证 RPO 为零。

| 操作 | 前置条件与结果 | 原子性和可见性 | 并发与失败规则 |
|---|---|---|---|
| `open` | 支持 `O_RDONLY`、`O_WRONLY`、`O_RDWR`、`O_CREAT`、`O_EXCL`、`O_TRUNC`、`O_APPEND`；返回绑定 inode 的 handle | handle 绑定 inode，不绑定可变 path；`O_TRUNC` 在成功 open 的同一事务中生效 | 已删除 path 不影响已有 handle；flags 冲突返回对应 errno |
| `read`/`pread` | 从 handle 或显式 offset 读取，EOF 返回 0 | 读取一个已提交 object/version 的内容；不得返回未提交 partial chunk | object 缺失或校验失败返回 I/O error，并记录 repair/audit 事件 |
| `write`/`pwrite` | 支持 offset、部分写和 `O_APPEND`；`write` 返回实际接受的字节数 | 写入可以先进入 handle buffer 或 upload session；未达到 visibility point 前其他客户端不可见，但同一 handle 必须能读回已接受的写入 | 同一 inode 的写入按 handle/transaction 序列化；版本冲突不得静默覆盖 |
| `fsync(file)` | flush 当前 handle 的 pending writes | 返回前必须取得 `durable_acknowledged`；只保证该 handle 已提交的内容 | 超时或断线返回不确定结果，客户端使用 operation id 查询，不直接重复写 |
| `fsync(directory)` | flush 目录 entry 的 rename/create/unlink 变更 | 目录 namespace 的提交和 durability receipt 一起确认 | 目录变更与文件内容分开结算；任一部分失败都保留可查询 operation 状态 |
| `close` | 释放 handle；V1 不把 close 当作隐式 durability barrier | close 可提交 buffered write，也可返回 pending/error；行为必须由 mount policy 固定 | crash 后未 `fsync` 的 buffered write 可以丢失；已 `durable_acknowledged` 的写入在声明的 durability policy 覆盖范围内不能丢失 |
| `mkdir`/`rmdir` | `mkdir` 要求 parent 为目录；`rmdir` 只允许空目录 | dentry 创建/删除是单事务原子操作，提交后可见 | 与子项创建按 parent inode 加锁；非空目录返回 `ENOTEMPTY` |
| `rename` | source 存在；target parent 为目录；禁止把目录移入自身后代 | source dentry、target dentry 和必要 inode 状态一次提交；`rename-over-existing` 替换目标 dentry 原子可见 | 目标目录必须为空或遵循 POSIX 类型规则；冲突返回 `EEXIST`、`ENOTDIR` 或 `EISDIR` |
| `unlink` | 删除 dentry，不删除仍被 handle、snapshot 或 version 引用的 inode | path 立即不可见；live handle 继续读写 inode，最后引用消失后进入 GC | 与 open/delete 并发按 inode 引用和 dentry 锁结算，不得把已打开文件变成悬空 handle |
| `symlink`/`readlink` | V1 只允许 workspace 内可解析的相对目标；绝对或越界目标拒绝 | symlink 本身是 inode；`unlink` 删除 link 而不是目标 | 每次 resolve 都做 containment 和循环限制；循环返回 `ELOOP` |
| `flock`/`fcntl` | lock 绑定 inode、workspace 和 lease owner | lock 状态由 Storage Service 持有，不能只存在于一个 client 进程 | holder crash 后由 lease expiry 释放；跨 gateway 可见，跨 tenant 不可见 |
| `stat`/`readdir` | `readdir` 只返回直接 child；V1 支持分页 cursor | listing 是某个 generation 的快照，不保证跨页期间 namespace 不变 | cursor 过期返回 stale cursor；rename/delete 不得产生重复或越界 entry |

FUSE adapter 将这些语义映射为 POSIX errno；WorkspaceFS service 使用独立的稳定错误码，例如 `WS_NOT_FOUND`、`WS_STALE_VERSION`、`WS_CONFLICT`、`WS_DURABILITY_UNKNOWN` 和 `WS_SYMLINK_ESCAPE`。只有当 DSH contract 增加对应能力后，remote provider 才能把这些结果映射为新的 typed errors；不能把建议错误码伪装成当前 `ctx.fs` 已存在的错误集合。

V1 的负面测试必须至少覆盖：rename-over-existing、unlink-open-file、write + fsync + crash、mkdir/rmdir race、workspace 外绝对 symlink、解析后越界的相对 symlink、symlink loop、flock holder crash、目录列举期间 rename/delete、稳定比较键冲突和跨平台名称差异。

### Agent workload 的验收重点

兼容性测试应覆盖以下真实行为，而不是只测试 `write` 后 `read`：

```text
create project
clone repository
find / grep / rg
edit one file
edit many files
write temporary file
fsync
rename temporary file over target
git status / diff / add / commit / checkout
run tests and compiler
install dependencies
delete and recreate files
kill and restart the runtime
```

编辑器和 Agent 常用的安全写入模式通常是“写临时文件，再 rename 覆盖目标”。如果后端只支持“直接更新目标内容”，它可能在最常见的写入路径上表现为不兼容，即使简单的 `echo > file` 测试全部通过。

### 兼容性不是语义合并

WorkspaceFS 必须保证操作原子、版本可追踪、冲突可检测和失败不静默覆盖，但它不需要理解 Python、TypeScript 或 YAML 的语义。两个 Agent 同时修改同一文件时，文件系统可以返回 CAS conflict、保留双方版本并提供 diff；代码级合并仍由 Git、AST 工具或 Agent 工作流负责。

-----

## PostgreSQL 的适用性与代价

PostgreSQL 的吸引力不在于它可以存放 `BYTEA`，而在于它同时提供文件系统工作区需要的元数据查询、事务、并发控制、权限和审计基础。

### 适合的部分

PostgreSQL 可以在同一事务中更新目录关系、当前文件版本、配额计数和操作日志。行级锁、唯一约束、MVCC 和 advisory lock 可以表达路径创建、rename、版本检查和 workspace 级协调。RLS 可以把租户过滤从应用约定提升为数据库强制策略，前提是运行角色、事务上下文和 owner 绕过规则处理正确。

数据库还可以直接查询“某租户在过去一小时修改的文件”“某 Agent 修改过的版本”“某 workspace 当前逻辑字节数”等信息。这些查询在对象存储中通常需要额外的元数据服务、事件管道和索引系统。

### 不适合直接承担的部分

PostgreSQL 不是专门的海量对象存储系统。大模型权重、视频、数据集、checkpoint 和持续大流量顺序读写会放大 WAL、vacuum、连接、网络和备份成本。即使数据库能保存它们，也不代表数据库是最经济或最易扩展的内容后端。

因此，长期接口应是 WorkspaceFS，而不是把 `BYTEA` 永久写死为唯一存储策略：

```text
WorkspaceFS
  ├── PostgreSQL metadata + inline content
  ├── PostgreSQL metadata + chunk table
  ├── PostgreSQL metadata + object storage
  └── local / NVMe cache
```

Agent 只依赖 `/workspace`；内容路由可以按大小、访问模式、租户策略或 artifact 类型变化。

### TOAST、Large Object 与 chunk table 不是同一件事

PostgreSQL 的 TOAST 会把支持的超大字段透明地压缩或拆到表外，以解决固定页面不能容纳超大 tuple 的问题；它不是面向 Agent 文件句柄的独立对象存储协议。PostgreSQL Large Object 提供流式和局部读写接口，适合某些大对象场景，但它使用独立对象和 OID，仍需解决引用、GC、权限和事务生命周期。

对 WorkspaceFS，更可控的默认模型是“小对象内联，大对象分块”：例如小于某个经过 benchmark 确定的阈值存入 `inline_data`，更大的内容由不可变 object manifest 和 chunk 组成。chunk 大小不应凭经验永久固定，4 MiB 可以作为 PoC 候选值，但必须用 Agent workload、随机读比例、网络 RTT 和数据库缓存命中率测量。

-----

## 外部实现与替代路线

外部项目已经证明“数据库承载 Agent 文件状态”可以落地，但它们解决的问题不同。本节只记录核验到的能力和限制，不把项目自述的“production-ready”直接当作第三方生产证据。

### TigerFS：最接近 Agent workspace 的参考实现

[TigerFS](https://github.com/timescale/tigerfs) 的定位是 PostgreSQL-backed、versioned filesystem，并明确以 Agent 为目标。它同时提供 File-first 和 Data-first 两种方向：前者把文件和目录作为工作区，后者把 PostgreSQL 数据库结构映射为可用 `ls`、`cat`、`grep` 探索的文件树。仓库当前标注 MIT 许可证；本次核验时 GitHub 页面约有 706 个 Stars、24 个 Forks，最新公开 release 为 `v0.7.0`，这些数字只代表调研时点的关注度。来源：TigerFS README、GitHub repository metadata 和 release page；核验日期：2026 年 9 月 22 日；事实类型：项目自述与公开仓库元数据。

TigerFS v0.7 的关键能力包括 operation log、持久 savepoint、undo、按用户过滤、atomic rename、基于 parent pointer 的目录关系、目录 mtime 触发器、dotfile 支持和针对远程数据库的查询优化。它的价值不只是“把文件映射到行”，而是把 filesystem 变成 Agent 可使用的事务工作区、回滚入口和协作记录。来源：TigerFS `v0.7.0` release notes；核验日期：2026 年 9 月 22 日；事实类型：项目 release 自述。

TigerFS 同时暴露了几个必须正视的边界。File-first workspace 的核心格式仍偏向 Markdown、纯文本和 frontmatter，而不是任意 POSIX 二进制文件；官方 history 文档说明 history、log 和 savepoint 使用 TimescaleDB hypertables，不能直接在 vanilla PostgreSQL 上工作；官方文档还记录了多用户交错编辑时 per-user undo 可能一起影响同一文件上的其他交错修改。来源：TigerFS `docs/history.md`；核验日期：2026 年 9 月 22 日；事实类型：项目限制说明。它因此适合作为 Agent workspace 语义的参考实现，不应被直接当作完整 SaaS tenancy、任意二进制存储和强并发 undo 的终点。

### Tarbox：更接近云原生 POSIX storage 的设计参考

[Tarbox](https://github.com/VikingMew/tarbox) 将自己描述为面向 AI Agent 的 PostgreSQL-backed FUSE filesystem，公开 README 列出 POSIX 接口、BLAKE3 content-addressed dedup、分层存储、多租户、REST/gRPC 和 Kubernetes CSI。它当前明确标注为 Alpha；README 同时把核心 filesystem、layered storage 和 CSI driver 称为 production-ready，把 audit integration、WASI adapter、性能优化和 macOS 支持列为开发中。来源：Tarbox README；核验日期：2026 年 9 月 22 日；事实类型：项目自述。这里的“production-ready”是项目自述，不能替代独立可靠性、性能和安全评估。

Tarbox 对本报告最有价值的地方是把 inode、数据块、layer、租户和 CSI 放进一个云原生 storage 设计中，并明确承认 macOS FUSE 支持不完整。来源：Tarbox README 与 CSI 文档；核验日期：2026 年 9 月 22 日；事实类型：项目自述。它适合用来研究 block/COW、PVC/CSI 和服务化部署，但 Alpha 状态意味着其 schema、性能和操作语义不应作为稳定外部协议。

### postgresqlfs：早期的数据库浏览器式 filesystem

[postgresqlfs](https://github.com/petere/postgresqlfs) 是一个较早的 C/FUSE 驱动，把 PostgreSQL 数据库对象暴露为目录和文件，主要用途是用文件工具浏览和编辑数据库。来源：postgresqlfs README；核验日期：2026 年 9 月 22 日；事实类型：项目 README。它说明“数据库对象到 filesystem namespace”的路径很早就可行，但它不是本报告所需的 Remote Durable Workspace：没有以 Agent workspace 为中心的版本、租户、跨沙箱生命周期和云端 gateway 设计。

### AgentFS：SQLite 方向的对照组

[AgentFS](https://github.com/tursodatabase/agentfs) 不是 PostgreSQL 项目，但它是非常重要的对照。它把 filesystem、key-value、timeline 和 Agent 状态放入 SQLite 文件，提供 SDK、CLI、Linux FUSE、macOS NFS、快照和 sandbox 集成。来源：AgentFS README；核验日期：2026 年 9 月 22 日；事实类型：项目 README。它证明 Agent filesystem 的竞争点包括可查询历史、可移动快照和运行时状态，而不只是 POSIX mount；它也提示 PostgreSQL 方案必须解释自己相对单文件 SQLite、远程数据库和浏览器环境的收益。

### 对象存储和分布式文件系统：不是简单的反例

S3 系方案在大对象、跨区域复制、生命周期和成本方面更成熟，但 S3 object semantics 不是 POSIX semantics。[s3fs-fuse 的文档](https://github.com/s3fs-fuse/s3fs-fuse/blob/master/README.md)明确列出随机写和 append 需要重写对象、rename 不是原子操作、非 AWS provider 可能存在最终一致性等限制。来源：s3fs-fuse README；核验日期：2026 年 9 月 22 日；事实类型：项目限制说明。对 Agent workspace 来说，这些限制正好击中临时文件、rename-over-existing、并发写和 read-after-write。

[SeaweedFS](https://github.com/seaweedfs/seaweedfs) 则展示了另一种成熟路线：把 blob、目录元数据、S3、POSIX/WebDAV 等接口分层，metadata store 可以使用多种数据库，内容和元数据不必全部放进 PostgreSQL。来源：SeaweedFS README；核验日期：2026 年 9 月 22 日；事实类型：项目 README。它更适合作为“PostgreSQL metadata + object storage content”未来形态的对照，而不是被简单归类为 S3/FUSE。

### 方案对比

| 方案 | Agent 文件兼容性 | 事务与元数据 | 多租户/审计 | 大对象 | 版本/回滚 | 主要风险 |
|---|---|---|---|---|---|---|
| 本地 ext4/xfs | 高 | 高，但跨实例弱 | 依赖外层 | 高 | 低 | 不能自然跨沙箱持久化和共享 |
| NFS | 高到中 | 依赖服务端 | 依赖外层 | 高 | 低 | 锁、缓存和网络故障语义复杂 |
| S3 + FUSE | 中 | 对象级 | 高，但需外层元数据 | 高 | 对象版本可用 | rename、随机写、目录和一致性语义不自然 |
| PostgreSQL-backed FS | 高到中 | 高 | 可与业务授权统一 | 中 | 高 | 数据库 I/O、连接、vacuum 和大文件成本 |
| PG metadata + object storage | 高到中 | 高 | 高 | 高 | 高 | 双后端一致性、GC 和路由复杂 |
| SQLite AgentFS | 高到中 | 单文件内强 | 单文件范围内 | 中 | 高 | 多租户远程共享和横向扩展需要外层设计 |

没有一种方案在所有 workload 上占优。对本报告的目标，PostgreSQL 的优势是强元数据和事务；对象存储的优势是大对象和容量；本地文件系统的优势是低延迟和广泛兼容。WorkspaceFS 的接口应允许未来组合这些后端。

-----

## Remote Durable Workspace 目标架构

本节把产品抽象、运行时拓扑和安全边界分开。关键原则是：Agent 只获得 filesystem 能力，Storage Service 才拥有数据库访问能力。

### 控制面与数据面

控制面负责认证、用户、租户、Session、workspace 生命周期、配额、调度和 shard 路由。数据面负责路径解析、文件内容、版本、日志、缓存、并发和 GC。Agent 不应获得 PostgreSQL connection string，也不应直接知道数据库、schema 或 tenant table。

```text
                              Internet
                                 │
                                 ▼
                        ┌──────────────────┐
                        │   Control Plane  │
                        │ auth / tenant    │
                        │ user / session   │
                        │ workspace / ACL │
                        └────────┬─────────┘
                                 │
                         workspace_id + claims
                                 │
                                 ▼
                        ┌──────────────────┐
                        │ Agent Scheduler  │
                        └────────┬─────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │ Ephemeral Sandbox│
                        │      /workspace  │
                        └────────┬─────────┘
                                 │
                    FUSE / NFS / mounted volume / direct SDK
                                 │
                                 ▼
                        ┌──────────────────┐
                        │ WorkspaceFS      │
                        │ client / cache   │
                        └────────┬─────────┘
                                 │ gRPC or HTTP/2
                                 ▼
                        ┌──────────────────┐
                        │ Storage Service  │
                        │ AuthZ / SQL      │
                        │ locks / quota    │
                        │ versions / audit │
                        └────────┬─────────┘
                                 │ pooled connections
                                 ▼
                        ┌──────────────────┐
                        │ PostgreSQL       │
                        └──────────────────┘
```

### FUSE、NFS、CSI 和 SDK 的职责

FUSE、macOS NFS、Kubernetes CSI 和直接 SDK 可以共享同一个 metadata/content/authorization core，但它们不是具有相同语义的薄适配器。FUSE 面向 syscall、inode 和 file handle；NFS 有独立的 client cache、lock、delegation 和 reconnect 行为；CSI 主要负责 volume lifecycle 和 mount orchestration；SDK 可以直接暴露显式 operation API。每个适配器都需要自己的 transport、cache 和 conformance suite，路径解析、权限、版本、事务和审计则应由共享 core 负责。

Linux FUSE 文档说明，FUSE 允许用户态进程导出文件系统，也包含 `allow_other` 等影响访问范围的挂载选项；这证明 FUSE 有自己的权限和挂载风险，但不意味着 FUSE 能代替 SaaS 的租户授权。Kubernetes CSI 则是把卷生命周期和挂载交给 Kubernetes storage plugin 的标准接口，适合把 durable workspace 作为 Pod volume 提供。

不可信 Agent 容器不应被默认授予 `/dev/fuse`、`SYS_ADMIN` 或任意 mount 能力。生产形态更适合让 node-level client 或 CSI node service 管理挂载，再把结果注入 Agent 容器；如果运行环境必须在容器内挂载，也必须把 mount 权限、设备访问和 tenant authorization 分开评估。

### Workspace 生命周期与挂载状态

workspace 是控制面拥有的持久对象，sandbox 是可回收的执行对象。创建 Session 时，控制面分配 `workspace_id` 和 `session_id`，Storage Service 为请求建立租户上下文，client 把 workspace 挂载为 `/workspace`；Session 结束时销毁 sandbox，但不删除 workspace。

建议的 workspace 状态机如下：

```text
created
   ↓
available ⇄ attached
   │          │
   │          ├── read-only
   │          └── draining
   │                 ↓
   └──────────── detached
                         ↓
                    soft-deleted
                         ↓
                       purged
```

`available` 表示可以 attach，`attached` 表示至少存在一个有效 mount lease，`read-only` 表示仍可读取但拒绝 mutation，`draining` 拒绝新 handle 并等待已有 handle 结算，`soft-deleted` 仍受 retention、snapshot、fork 和 legal hold 约束，`purged` 才允许删除可达性之外的内容。mount 失败不能把 Session 标记为成功运行；workspace delete 必须先进入 draining，并等待所有 mount lease 结算。

```text
create workspace W
        ↓
start sandbox S1
        ↓
mount W at /workspace
        ↓
agent edits and runs tests
        ↓
destroy S1
        ↓
start sandbox S2
        ↓
mount W at /workspace
        ↓
continue from durable state
```

workspace fork、snapshot 和 rollback 应表现为 metadata/root reference 的操作，而不是先复制全部文件。内容对象不可变后，多个 workspace 可以在租户范围内共享对象并通过 copy-on-write 保存修改。

### Session、workspace 与 mutation writer

Session owner、workspace mount owner、filesystem mutation writer 和 operation actor 是四个独立身份。一个 Session 可以有多个并行 subprocess；一个 workspace 可以被多个 Session attach；一个 operation 必须有自己的 idempotency key 和 actor；rollback、migration、purge 等高层操作还需要 workspace-level authority。

| 层级 | 作用 | 所有权与冲突方式 |
|---|---|---|
| Session lease | 控制 Agent Loop 对 Session log 的单写 | 单 writer；handoff 前必须释放或被 supervisor 终止 |
| Workspace mount lease | 控制 sandbox 与 workspace 的 attach/detach | 支持 shared-read；V1 mutation mount 使用 exclusive lease |
| Operation id | 幂等、审计和重试关联 | 单次 mutation 唯一；重试复用同一 id |
| Inode version | 文件级 CAS | one-wins；版本不匹配返回 conflict |
| Workspace generation | cache invalidation 和高层观察 | 单调递增；不代替文件级 CAS |
| File lock | 兼容 Git/editor 的短期协调 | lease-backed；holder crash 后过期释放 |
| Workspace transaction | 多文件批量修改 | explicit commit/abort；rollback 与新写入互斥 |

第一阶段只允许一个 mutation mount writer，第二阶段才验证 shared-write workspace。shared-write 允许多个 Session 并发修改不同文件，并对同一文件返回 CAS conflict；rollback、workspace delete、root switch 和 migration 必须先取得 exclusive workspace lease。workspace lease 过期时，新 syscall 返回 `WS_LEASE_EXPIRED`，旧 handle 进入 stale 状态，不能继续提交 mutation。

-----

## 数据模型与事务语义

简单的 `path + BYTEA` 表可以证明概念，但不能长期承载 rename、hardlink、版本、快照、并发 undo 和 GC。核心模型应把 inode identity、directory entry、content object 和 operation history 分开。

### 推荐的逻辑模型

```text
tenant
  └── workspace
        ├── inode
        ├── dentry
        ├── file_version
        ├── object
        │     └── object_chunk
        ├── workspace_txn
        ├── operation
        ├── savepoint
        ├── quota
        └── gc_queue
```

### Workspace、inode 与 dentry

`workspace` 是租户内的持久对象，保存 `tenant_id`、根 inode、generation、逻辑字节数和文件计数。`inode` 保存文件或目录的稳定身份、类型、mode、size、mtime、当前 object、版本号和 link count。`dentry` 保存 `(parent_inode_id, name) -> child_inode_id`，因此路径名称和文件身份分离。

这一区分使 `rename` 不需要复制内容或递归改写所有子路径。`/a.txt` 改名为 `/b.txt` 时只改变 dentry；打开的文件句柄、历史记录和 object reference 仍指向同一个 inode。它也为 hard link 和 POSIX 风格的“unlink 后打开句柄继续有效”提供了建模基础。

```sql
CREATE TABLE pgfs.inode (
    inode_id          uuid PRIMARY KEY,
    workspace_id      uuid NOT NULL,
    kind              text NOT NULL CHECK (kind IN ('file', 'directory', 'symlink')),
    mode              integer NOT NULL,
    size              bigint NOT NULL DEFAULT 0,
    nlink             integer NOT NULL DEFAULT 1,
    version           bigint NOT NULL DEFAULT 0,
    mtime             timestamptz NOT NULL DEFAULT now(),
    ctime             timestamptz NOT NULL DEFAULT now(),
    current_object_id uuid,
    symlink_target    text,
    deleted_at        timestamptz
);

CREATE TABLE pgfs.dentry (
    parent_inode_id uuid NOT NULL,
    name            text NOT NULL,
    child_inode_id  uuid NOT NULL,
    PRIMARY KEY (parent_inode_id, name)
);
```

实际 schema 还需要 workspace foreign key、同 workspace 校验、目录环检测、reserved control paths、case sensitivity 和名称字节限制。上面的片段用于说明对象关系，不是可以直接上线的完整 DDL。CSI 只负责 Kubernetes volume lifecycle 和 mount orchestration，不是这里的文件数据传输协议。

必须保持的不变量至少包括：

- 每个 workspace 恰好有一个 root inode；root inode 没有 parent dentry，且不能被 `unlink` 或移动到自己的后代。
- `inode.workspace_id`、parent inode、child inode、version 和 dentry 必须属于同一个 workspace；object 可以按 tenant 共享给多个 workspace，但 object、inode、version 和 dentry 的引用必须属于同一个 tenant。跨 workspace 或跨 tenant 的 foreign key 必须在数据库约束或同事务校验中拒绝。
- `(parent_inode_id, name)` 在同一 workspace 内唯一；V1 使用 UTF-8、大小写敏感、保留原始 code point，不把名称自动归一化，并拒绝 NUL、`/` 和超出名称上限的输入。为避免不同 adapter 对同一名称产生不同解释，创建或改名时还要用固定的 Unicode 兼容比较键和大小写折叠键检查兄弟项冲突；比较键只用于拒绝歧义，不改变存储名称或普通查找的大小写敏感语义。
- directory 只能包含 dentry；regular file 的 `current_object_id` 可以为空但 directory 不得引用 content object；symlink 只能保存目标文本。
- `nlink` 必须与 live dentry 的数量一致；open handle 由独立的引用或租约计数跟踪，并在最后一个 pathname 引用消失后继续阻止 inode 和 object 回收。`deleted_at` 只表示 pathname 引用消失，不表示 object 可以立即回收。
- `current_object_id` 必须指向已验证、未被标记为 corrupt 的 object；object 删除前必须通过 snapshot、version、fork、open handle 和 upload 状态的可达性检查。
- 保留控制路径必须由命名空间策略拒绝或明确隐藏，不能依靠普通 Agent 不去访问它们。

这些是不变量，不是上方 SQL 片段已经完整实现的约束。PoC 必须为每项不变量提供有效 fixture、无效 fixture 和并发 fixture。

### Content object、chunk 与版本

`inode.current_object_id` 指向不可变 content object。object 记录 hash、size、编码或 media metadata，并可带内联数据或 chunk manifest；chunk 以 `(object_id, chunk_index)` 存储有界的 `BYTEA`。`file_version` 保存 inode version 到 object 的映射，而不在每次修改时复制整个文件。

租户内可按 `content_hash` 去重，但第一版不建议跨租户默认去重。跨租户共享 hash 可能暴露“某个内容是否已存在”的侧信道，也会让删除、GC、加密密钥和计费耦合。租户内 dedup 已足够验证存储收益；全局 dedup 应等到威胁模型和密钥设计明确后再做。

建议把 hash 定义为租户范围内的内容寻址键和完整性校验值，而不是授权凭据。上传时验证明文内容的 hash、size 和 chunk manifest；发现同一租户内 hash collision 时必须比较内容并拒绝冲突，不能静默复用 object。object 可以由同一租户的多个 workspace 引用，但每次引用都必须验证 tenant ownership 和 object lifecycle；payload 可以使用 tenant-specific envelope key 加密，hash 计算和加密存储分离，避免把可观察的跨租户 hash 当作存在性证明。

object/chunk 生命周期应显式建模：

```text
uploading
    ↓ verify hash/size/chunks
verified
    ↓ metadata references object
referenced
    ↓ snapshot/fork/history retains object
snapshot-retained
    ↓ no live root and retention expired
unreachable
    ↓ grace period and legal hold checks
deleted
```

这是对象生命周期的主状态，不表示这些状态在所有引用类型上互斥；例如同一个对象可以同时被当前 inode 引用并被 snapshot 或 fork 保留。resumable upload 必须以 `(tenant_id, object_id, chunk_index, request_id)` 幂等；partial upload 有租约和过期回收。对象已经上传但 metadata 未提交时进入 orphan GC，metadata 已删除但 snapshot、fork、version 或 legal hold 仍引用对象时不得回收。租户删除、用户删除、备份保留和 legal hold 的优先级高于普通 GC；计费同时记录 logical bytes、referenced physical bytes、uploading bytes 和 retained bytes。

### Operation、transaction 与 savepoint

`operation` 记录 actor、session、workspace、操作类型、受影响 inode、before/after metadata reference 和时间序列号，不直接把大型文件内容复制进日志。`workspace_txn` 把多个文件操作归并到一次显式事务或一次高级 API 调用。`savepoint` 保存 workspace operation sequence 或 immutable root reference。

`operation history` 与 `security audit` 不是同一个日志。前者服务于 workspace state、undo、snapshot、replay 和内容引用，允许按 retention 做 compaction，但不能删除仍被 snapshot 或恢复协议引用的事实。后者记录授权主体、请求来源、capability decision、request id、结果、错误、管理员动作、GC、repair 和 reconciliation，必须不可变或追加写，且保留期限可以长于 workspace content。两者通过 `operation_id`、`request_id`、`session_id` 和 `correlation_id` 关联；rollback 会追加新的 operation 和 audit，而不是修改或删除旧记录。

普通 FUSE syscall 可以按“一次 mutation 一个数据库事务”处理；高级 workspace API 可以把多个 `mkdir`、`write`、`rename` 和 `chmod` 放进一个事务。两种模式必须区分，因为 POSIX 程序通常不要求跨多个 syscall 的全局原子性，而 Agent 的一次“重构”或“应用 patch”可能需要更高层的 checkpoint。

### Rename、目录环和路径并发

`rename(source, target)` 至少需要锁 source dentry、source inode、target parent 和可能被覆盖的 target，并按稳定顺序获取锁以降低 deadlock。目标名称的唯一约束负责最终防止重复 entry；应用层不能使用“先查再插入”作为并发保证。

目录 rename 还必须检查目标 parent 不在 source subtree 中。V1 可以使用 recursive CTE 做 ancestor 检查；只有在测量显示它成为瓶颈后，才考虑 closure table、materialized path 或 `ltree`。

### CAS undo

直接把 before state 写回去会静默覆盖其他 Agent 的修改。更安全的 undo 是 compare-and-swap：只有当前 inode version 仍等于该 operation 产生的 after version 时，系统才应用 inverse operation；如果版本已经变化，返回 `UNDO_CONFLICT`，保留当前状态和可供人工或 Agent 合并的历史。

```text
Agent A: version 10 → 11
Agent B: version 11 → 12
Agent A undo:
  UPDATE ... WHERE inode_id = ? AND version = 11
  current version is 12
  result: conflict, no overwrite
```

这一语义比“按 user 过滤然后反向执行”更适合多 Agent workspace。它牺牲了部分自动回滚便利，但避免把协作者的修改当成自己的历史。

### Snapshot、fork 与 GC

历史、版本、savepoint 和 fork 会让“文件删除后立即删除 object”变得不安全。GC 应从 live inode、保留版本、snapshot root、pending transaction 和 fork base 计算可达 object，再经过 grace period 删除不可达对象，而不应只依赖脆弱的即时 refcount。

大型 workspace 不应从 operation 0 replay 到当前版本才能 rollback。应定期建立 materialized snapshot，保存 inode、dentry 和 current object reference，再只 replay snapshot 之后的有限 operations。进一步的 Merkle tree 或 Git-like root 可以把 snapshot、fork 和 clone 变成不可变 root pointer。

-----

## 多租户、安全与许可

租户隔离是 SaaS 的基础契约，不应靠每条 SQL 都记得加 `WHERE tenant_id = ...` 来维持。

### 授权上下文

租户身份应从已验证的 JWT、mTLS identity 或内部授权上下文派生，再由 Control Plane 解析用户对 workspace 的访问关系。URL 中的 `tenant_id`、客户端提交的 workspace owner 或 Agent prompt 都不能直接决定数据库租户上下文。

```text
verified identity
        ↓
authorization context
        ├── tenant_id
        ├── user_id
        ├── workspace_id
        ├── session_id
        └── capabilities
        ↓
Storage Service
        ↓
PostgreSQL transaction-local context
```

这可以防止 confused deputy：客户端即使请求了另一个租户的 URL，也不能改变已经由网关和 Storage Service 建立的授权上下文。

### Path containment、symlink 与控制路径

path containment 是 WorkspaceFS 的正式 capability，不是 mount client 的附加约定。每次路径操作都必须按以下顺序执行：

```text
raw path
  ↓ reject NUL, slash-in-name, invalid UTF-8 and overlong components
lexical normalization of "." and ".."
  ↓
canonical lookup
  ↓
symlink policy and bounded resolution
  ↓
workspace containment check
  ↓
capability authorization
  ↓
operation
```

V1 只允许目标最终解析到当前 workspace 内的相对 symlink；绝对 symlink、指向 host path、`/proc`、`/etc`、其他 workspace 或未授权 mount 的目标一律拒绝。`lstat` 返回 link 本身，`resolve` 才跟随 link；rename 和 unlink 作用于 link 本身。symlink 解析使用有界次数，超过限制返回 `ELOOP`，每一跳都重新执行 containment check，不能只在起点做一次检查。

V1 采用 UTF-8、大小写敏感和保留输入 code point 的名称策略，不做隐式 Unicode normalization；创建或改名时使用统一的兼容比较键和大小写折叠键拒绝兄弟项歧义，但已接受的名称仍按原始 code point 和大小写查找。跨平台 adapter 不能把 macOS 的大小写折叠或 normalization 行为带入共享 namespace。`/.workspacefs`、`.control` 等控制路径由 namespace policy 保留，普通 Agent 不能创建、覆盖、遍历或通过 symlink 到达。path canonicalization 必须在 Storage Service 和 mount client 都执行，真正的授权判断只以 Storage Service 的 inode identity 为准，从而避免 client-side TOCTOU。

必须拒绝以下请求：workspace 外绝对 symlink、解析后越界的相对 symlink、symlink loop、把目录 rename 到自己的后代、控制路径 traversal、稳定比较键碰撞和大小写折叠键碰撞。

### PostgreSQL RLS 的正确使用

共享 schema 可以使用 RLS 对 workspace、inode、dentry、object、version、operation、savepoint、quota、workspace transaction、upload 和 GC queue 做数据库级过滤。每次请求应在事务内使用 `SET LOCAL app.tenant_id` 和必要的 workspace claim；连接放回 pool 后不能残留 session-level tenant state。

```sql
ALTER TABLE pgfs.workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE pgfs.workspace FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_tenant_policy
ON pgfs.workspace
USING (
    current_setting('app.tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.tenant_id', true)::uuid
);

BEGIN;
SET LOCAL app.tenant_id = '...';
-- all workspace SQL
COMMIT;
```

Storage Service 应使用参数化的 `set_config('app.tenant_id', $1, true)` 或等价的驱动绑定方式设置上下文；上面的 `SET LOCAL` 只表示事务范围，不表示把请求值拼接进 SQL。workspace claim、user identity 和 capability 也必须使用同样的事务局部方式传递，连接归还连接池前应清理或覆盖所有上下文。

PostgreSQL 官方文档指出，表 owner 通常不受 RLS 限制，因此 Storage Service 不应使用 table owner 作为普通查询角色；schema migration、GC、backup、repair 和管理操作应使用独立的高权限路径，并显式审计。所有业务表都必须有直接 `tenant_id`，或通过不可变 workspace foreign key 证明租户归属；跨表 foreign key 不能跨 tenant。缺少 tenant context 时 policy 必须返回零行或显式拒绝，而不能回退到“所有租户”。

RLS 不能替代应用授权。RLS 只能限制行是否可见或可修改，不能自动表达“用户可以读但不能写某个路径”“Agent 可以创建文件但不能读取 secrets”或“某次 Session 只能使用一个 workspace”等业务规则。Storage Service 必须先做 capability authorization，再依赖数据库做最后的行级隔离。

`SECURITY DEFINER` 函数、admin role、GC role 和 repair role 必须列入 threat model。它们不能成为未审计的 RLS bypass；每次越过普通 tenant policy 的操作都要记录 actor、reason、request id 和受影响对象。

RLS 验收至少包括：missing tenant context、wrong tenant context、stale pooled connection context、table-owner query、`SECURITY DEFINER` bypass、cross-tenant foreign key、GC role access、admin access audit 和错误 workspace id。

### 配额、资源和拒绝服务

配额检查必须与写入在同一事务内完成。不能先读取 usage、在应用中比较 quota、再插入 object，因为并发请求会同时通过。至少应锁定 workspace usage row，检查 logical bytes、physical bytes、file count、object count 和 pending upload，再提交 mutation。

还需要限制目录项数量、单文件逻辑大小、单次 RPC payload、未完成 transaction、并发 open handle、operation log retention 和 chunk upload 时间。租户隔离不仅是“不能读到别人的行”，也包括不能通过巨大目录、连接池、RPC 流和 GC 工作量拖垮共享 shard。

### TimescaleDB 许可边界

TimescaleDB 的官方资料把 Apache 2 Edition 与 Community Edition 分开，并说明仓库 `tsl` 目录及带 `-tsl` 的 shared object 适用 Timescale License；Apache 2 Edition 的 hypertable 基础能力与 Community Edition 的部分高级能力也不相同。来源：TimescaleDB editions 文档、仓库 LICENSE 和 `tsl/README.md`；核验日期：2026 年 9 月 22 日；事实类型：官方许可证与功能说明。

技术设计应把许可事实和法律结论分开：

| 内容 | 技术事实 | 需要法务确认 |
|---|---|---|
| Apache 2 部分 | 适用 Apache 2.0 条款 | notice、修改、分发和依赖声明 |
| TSL 部分 | 适用 Timescale License；高级压缩、Hypercore、连续聚合和部分查询能力属于该范围 | SaaS 提供、托管、分发和客户环境中的部署边界 |
| PGFS core | 可以不依赖 TSL-only feature，直接使用 vanilla PostgreSQL | 是否存在间接依赖、组合分发或服务形态影响 |
| 可选 Timescale backend | 由部署配置选择 Apache 2 Edition 或 Community Edition 能力 | 商业部署、客户交付和托管条款 |

这不是法律意见。工程上选择 vanilla PostgreSQL-first 的原因同时包括可移植性、减少扩展依赖、降低运维耦合和避免让核心正确性依赖可选许可组件；许可判断必须由法务根据具体版本、依赖构成和服务形态确认。

-----

## 性能、一致性与故障恢复

数据库 filesystem 的主要性能风险不是单个大文件的带宽，而是 metadata amplification：一次 `find`、`git status`、`npm install` 或递归 glob 可能产生数千次 stat、lookup、readdir 和小文件访问。

### 缓存分层

建议至少有三层缓存：

| 层 | 内容 | 一致性策略 |
|---|---|---|
| L1 identity | path → inode identity、negative lookup | 短 TTL，写入后立即失效 |
| L2 metadata | inode stat、directory entries、file version | generation 或 invalidation hint，失联后整 workspace 丢弃 |
| L3 content | 热点小文件、object chunk | 以 inode version/object hash 为 key，不缓存未知版本 |

TigerFS 的公开工程指导强调 PostgreSQL 是单一事实来源，内容读取保持 fresh，metadata 使用短 TTL cache；这与 PGFS 的目标一致：不能为了降低 RTT 而让跨 mount 的 `write` 后 `read` 看见旧内容。

### Batch 和 query reduction

`readdir` 应一次读取直接子项及其便宜 metadata，不能为每个 child 再发送独立 stat。路径解析应合并连续 lookup，`git status` 或递归扫描应有批量接口，RPC 应允许批量 stat、批量 dentry 和 streaming read/write。

第一版就应记录以下指标：

```text
filesystem calls
RPC round trips
SQL statements
SQL rows read
connection pool wait
cache hit rate
workspace generation invalidations
```

“一个 syscall 对应一个 SQL”不是可接受的长期目标。更有用的目标是让 `readdir(10k)` 产生 O(1) 到 O(batch) 的数据库往返，并把具体 p95 目标放到真实 Agent benchmark 之后确定。

### 写入缓冲和 durability

client 可以在 open handle 中合并连续 write，直到 `fsync`、close、显式 flush 或超时再提交，但必须使用可观察的提交状态，而不能把“数据库已提交”和“业务上可恢复”当作同一个状态：

```text
buffered
    ↓ upload or prepare
prepared
    ↓ verified content + metadata commit
committed_primary
    ↓ namespace read path observes committed root
visible
    ↓ fsync policy and backend receipts satisfied
durable_acknowledged
    ↓ remount/recovery check
recovered
    ↓ hybrid backend reconciliation complete
reconciled
```

`buffered` 只存在于 client 或 handle buffer，其他客户端不可见；`prepared` 允许 resumable upload 和校验，但不能进入 namespace；`committed_primary` 表示 PostgreSQL primary 已提交事务；`visible` 表示授权读路径可以读到新 root；`durable_acknowledged` 表示 `fsync` 已取得所配置的 PostgreSQL WAL/同步复制策略和 object backend receipt；`recovered` 表示 remount 或 failover 后 workspace root 可恢复；`reconciled` 表示 hybrid metadata/object 状态已完成一致性检查。V1 PostgreSQL-only 可以在同一事务中提交 metadata 和 content，hybrid backend 则必须先取得 verified object，再提交 manifest，否则 object 不得对 namespace 可见。

默认建议是 `write` 在 `committed_primary` 后返回可见性结果，`fsync` 才返回 `durable_acknowledged`。如果 client 在提交后失联，服务端必须保留 operation id 和状态查询接口；客户端收到未知结果时查询原 operation，而不是创建新的 mutation。close 是否隐式 flush、断线后 buffered write 是否允许丢失、`synchronous_commit` 和同步副本策略必须是 mount policy 的显式配置。

`durable_acknowledged` 只表示在声明的 `durability_policy` 覆盖范围内完成了持久化确认，不自动承诺 RPO 为零。V1 必须把 durability receipt 与部署策略绑定：单 primary 的 receipt 受 WAL、备份和故障转移策略约束；配置同步复制时才可以把 receipt 扩展到指定副本确认。产品契约至少记录 `rpo_target`、`rto_target`、`durability_policy` 和 `recovery_workflow`，即使 PoC 只声明“RPO/RTO 由 PostgreSQL primary、WAL、backup 和 remount policy 决定”。

### Cache invalidation

PostgreSQL `NOTIFY` 适合作为 workspace generation 的低成本 invalidation hint，不适合作为事实来源或可靠消息总线。写事务可以递增 generation 并发送 workspace channel；其他 gateway 收到后丢弃本地 metadata cache。gateway 断线重连时必须重新读取 generation 并主动丢弃可能过期的 cache。

### Read-after-write 与副本

文件系统常见的 `write(file); cat(file)` 要求 read-after-write。V1 的普通 read 应走 primary，不能把写入发往 primary、读取发往可能落后的 replica。未来如果加入 read replica，需要把 PostgreSQL commit LSN 或等价的可见性 token 传递给读取路径，确保 replica 已达到所需 replay position。

### RPC 重试和幂等

所有 mutation RPC 都需要客户端 `request_id` 或 operation id。网络可能在数据库 commit 成功后断开，客户端无法区分“未执行”和“已执行但响应丢失”。Storage Service 必须能根据 idempotency key 返回已提交结果，避免重试导致重复 create、双重 rename、重复 quota 计费或重复 operation log。

### 网络上限、连接池和 backpressure

每个 sandbox、workspace、tenant 和 gateway 都必须有并发 RPC、active stream、open handle、数据库连接、pending upload 和事务持有时间上限。streaming read/write 使用有界窗口；client disconnect 需要取消对应 SQL、释放 connection 和标记 upload 状态，不能让慢 client 长时间持有事务。

`readdir(10k)` 不表示必须一次返回 10,000 个完整 entry。V1 可以返回带 generation 和 cursor 的分页结果，每页只提供名称、类型和便宜 metadata；cursor 跨 generation 后返回 stale cursor，并由 client 重新列举。cache stampede、慢 client、单 workspace 热点和 tenant connection quota 都必须在 benchmark 中单独观察。

### 故障注入

必须测试 Agent、client、Storage Service、数据库连接、Pod、节点和网络分别在 mutation 前后崩溃时的结果：

```text
kill before DB commit
kill after DB commit before response
duplicate RPC
timeout during streaming write
gateway loses NOTIFY
PostgreSQL failover
client remounts workspace
```

验收标准不是“每次都成功”，而是 committed write 不丢、未提交 write 不伪装成已提交、重试不重复副作用、租户不可越权、恢复后 filesystem namespace 与 operation log 可以互相解释。

-----

## 面向 DSH 的适配判断

DSH 已经有一个重要的架构前提：filesystem 能力通过 `ctx.fs` provider seam 提供，工具和策略不应依赖具体的本地磁盘实现。这使远程 backend 在架构上可行，但当前 seam 的能力范围不等于完整 POSIX filesystem。

### 现有 `ctx.fs` 能提供什么

仓库的 [filesystem subsystem reference](../subsystems/filesystem.md) 和 [`@deepseek-ai/dsh-fs` README](../../packages/fs/fs/README.md) 定义了稳定 target identity、`stat`/`lstat`、有界文本和 byte 读取、单层目录列表、atomic text write/edit、版本 guard 和 typed errors。文档还明确允许 remote backend 用 workspace URI 或 file id 作为 opaque `targetKey`，不要求 consumer 把它解释为本地绝对路径。

这意味着 WorkspaceFS 可以成为 `ctx.fs` 的一种 provider，只要它能在同一个 execution world 中为 subprocess、Shell、LSP 和 filesystem tools 提供一致的路径坐标。Remote provider 不能只让 `ctx.fs` 看到远端内容而让 Shell 仍然在另一棵本地目录树上运行，否则 Agent 会观察到两个不同的 workspace。

### 当前 seam 不能直接承载完整 POSIX Agent

DSH 当前 `dsh-fs` package 的已发布 contract 以文本文件操作为中心，并明确列出没有 delete、rename、copy 或 watch，binary-safe mutation 也不是当前 contract。模型-facing `dsh-tool-fs` 的 `write` 和 `edit` 同样不能直接替代 Git、Shell 或编辑器需要的完整 filesystem namespace。

因此有三种适配路径：

1. **Provider extension**：扩展 `ctx.fs` 或新增更底层的 WorkspaceFS service，让 Shell/subprocess 使用 remote execution world 的真实路径；适合 DSH 统一抽象，但需要更新所有 consumer、类型、文档和测试。
2. **Node-level mount**：在 Agent sandbox 外部挂载 WorkspaceFS，把 `/workspace` 作为普通路径暴露给 DSH 的 local filesystem/subprocess；适合先做 PoC，但安全和多租户边界必须由外层 runtime 管理。
3. **Remote subprocess executor**：文件和进程都由远端 sandbox provider 执行，`ctx.fs` 只作为同一远端世界的控制接口；架构更完整，但实现面最大。

第一版不应只替换 `ctx.fs` 然后声称“现有 Agent 无需修改”。只有当 Shell、ripgrep、Git、LSP、编译器和文件工具都在相同 workspace namespace 中运行，并且实际覆盖 rename/delete/symlink/lock 等工作负载时，才可以作出这个兼容性结论。

### 与 DSH session durability 的关系

WorkspaceFS 不能替代 Session persistence。Session log 保存对话、工具、模型可见事实和恢复所需事件；workspace 保存 Agent 操作的文件状态。二者可以通过 `workspace_id`、`session_id`、actor identity 和 operation sequence 关联，但不能因为文件已持久化就认为 Session 可以恢复，也不能因为 Session 可恢复就认为 `/workspace` 仍然存在。

正确的云端生命周期至少包含两条独立的 durability path：

```text
Session events  → SessionPersistence
Workspace state → WorkspaceFS
Runtime state   → sandbox / process supervisor
```

Agent 重新接管 Session 时，控制面必须同时确认 Session writer、workspace mount、运行时身份和 capability context；单写者 Session 租约不能自动解决 workspace 的多 Agent filesystem concurrency。

建议建立跨域 checkpoint 记录：

```text
session_seq
workspace_generation
workspace_root
last_operation_id
runtime_identity
capability_version
checkpoint_state
```

在不能使用跨数据库事务时，采用明确的 saga/reconciliation 顺序：

```text
workspace mutation commit
        ↓
workspace durability receipt
        ↓
Session tool/result append
        ↓
Session flush
        ↓
paired checkpoint acknowledged
```

如果 Session 已记录 tool/result 但 workspace operation 不存在，恢复流程必须把该 step 标为 reconcile-needed，而不能假设文件修改成功；如果 workspace operation 已 durable 但 Session event 尚未 append，operation 保留为 orphaned-but-recoverable，并由恢复流程追加可审计的 reconciliation event。Session resume 只有在 checkpoint、workspace root、mount lease 和 capability version 一致时才进入 running，否则进入 `reconcile` 或 `read-only recovery`。

-----

## PoC 与验收路线

PoC 的目标不是证明“数据库能存文件”，而是回答三个可测量的问题：现有 Agent 是否能在不改文件调用方式的情况下运行；filesystem round trip 是否成为主要瓶颈；哪些语义是实际不可缺少的。

### Phase 0：采集真实 workload

入口条件是选定一个自研 Agent、Codex、Claude Code 或 Aider，以及一个普通 Git + Node/Python 项目。用系统调用、文件事件或受控 filesystem wrapper 记录：

```text
open/read/write/pread/pwrite
stat/lstat/readdir
mkdir/rmdir/rename/unlink
symlink/link/flock/fcntl
fsync/truncate
file sizes
concurrency
temporary-file patterns
```

默认只采集 syscall/path class/size/timing/result/并发度，不采集文件内容、环境变量、完整 argv、Git remote、token 或凭据路径。path、命令和参数必须做稳定脱敏；需要内容回放时使用人工构造 fixture，不把真实代码和业务数据复制进 benchmark。采集前记录租户与用户授权、用途、保留期限、删除方式和 trace owner；fixture 必须能在 Linux/macOS/CI 中重放。

Phase 0 的退出条件是：已得到每个候选 Agent 的操作频率和文件大小分布；已识别 rename、fsync、link、lock、watch、mmap 等实际依赖；trace 通过 secret scan；脱敏后 fixture 可以重复执行；所有后续 V1 语义都能映射到至少一个真实 workload。不要先凭想象实现完整 POSIX。

### Phase 1：单机 PostgreSQL + FUSE

入口条件是 Phase 0 已冻结 V1 operation semantics。先不引入 gRPC、CSI、分片、Redis、Kafka、TimescaleDB 或对象存储。实现最小 inode、dentry、object、chunk 和 transaction schema，使用一个 PostgreSQL 实例，在受控 Linux 环境中通过 Node-level FUSE mount 提供 `/workspace`，并让 DSH Shell、Git、LSP 和 `ctx.fs` 访问同一个挂载路径。

V1 filesystem operation 至少包括：

```text
lookup
readdir
open
read
pread
write
pwrite
truncate
close
mkdir
rmdir
stat
lstat
rename
unlink
symlink
readlink
fsync
flock/fcntl
```

故障注入点包括 write 前、数据库 commit 前、commit 后但 response 前、fsync 前和 mount detach 期间。必须观察 operation id、inode version、workspace generation、POSIX errno、Durability state、open handle 状态和 recovery result。通过标准是：所有 L0 语义和已选择的 L1 语义通过正向与负向测试；rename-over-existing、unlink-open-file、fsync crash、mkdir/rmdir race、symlink containment 和 lock holder crash 有确定结果；Git clone、代码编辑、测试、`git diff`、临时文件 rename、递归搜索、删除重建和大目录列举与 ext4 baseline 的行为差异已记录。

Phase 1 不得宣称多节点远程访问、shared-write、CSI、跨 Session checkpoint、完整 POSIX、任意二进制高吞吐或灾备 RPO/RTO 已解决。

### Phase 2：Storage Service 和远程执行世界

入口条件是 Phase 1 已证明单一 execution world 中的 Agent workload 可运行。将 filesystem core 从 FUSE adapter 中分离，添加 gRPC streaming read/write、batch metadata、request id、CAS version、connection pool、workspace generation、lease、backpressure 和基本 metadata cache。此阶段才验证“Agent 运行时和 durable workspace 可以跨机器”。

故障注入点包括 client 在 commit 前断线、commit 后 response 前断线、重复 RPC、stream timeout、gateway restart、连接池耗尽、slow client、漏掉 `NOTIFY` 和 workspace lease expiry。必须观察：

```text
operation id is reused
committed_primary is queryable
durable_acknowledged has explicit receipt
unknown result enters reconciliation
no duplicate mutation
no lost acknowledged write
no stale successful read after required barrier
no path identity corruption
no leaked connection or transaction
```

通过标准是每个 failure point 都能落入已定义的 operation/durability state，重试只复用原 operation，remount 后 namespace、inode identity、generation 和 file handle failure 行为可解释。Phase 2 仍不得宣称多租户隔离或灾备 RPO/RTO 已完成。

### Phase 3：多租户与恢复

入口条件是 Phase 2 已通过跨网络 mutation 和 recovery 测试。加入 Control Plane-issued authorization context、RLS、独立数据库运行角色、quota、operation history、security audit、object GC、workspace state machine 和 session/workspace checkpoint integration。至少验证两个租户在同一个 PostgreSQL shard 上并发创建同名 workspace、同名文件、相同 hash 内容和大目录。

故障和攻击注入包括越权 URL、伪造 tenant claim、missing tenant context、连接池复用、table-owner query、`SECURITY DEFINER` bypass、cross-tenant foreign key、错误 workspace id、GC 与 rollback 并发、删除后历史保留、legal hold、Session event/workspace operation 不配对和跨租户内容侧信道。通过标准是所有表族 fail closed；shared-read/shared-write/exclusive lease 的冲突结果稳定；Session checkpoint 能把 success、reconcile 和 read-only recovery 区分开；operation history 与 security audit 的保留和查询权限不混淆。

### Phase 4：CSI、混合内容后端和水平扩展

入口条件是 Phase 3 已通过多租户、恢复和审计测试。只有在 FUSE + Storage Service 的 Agent workload 通过后，才引入 CSI、节点级挂载、shard routing、read replica、object storage 和跨节点 cache invalidation。CSI 只解决 Kubernetes volume lifecycle 和 mount 接入，不解决 filesystem semantics、租户授权或内容 GC；每个 adapter 都需要独立 conformance suite。

混合后端的正确验证顺序是：小文件仍由 PostgreSQL 提供强一致路径；大文件切到 object storage；metadata transaction 记录 object manifest 和 commit state；上传使用 tenant-specific encryption、hash/size verification、resumable idempotency 和 orphan GC；故障注入验证“数据库已提交但对象上传未完成”“对象已上传但数据库未提交”“对象已引用但跨区域复制未完成”和“GC 与 snapshot/fork 并发”四类问题。通过标准是每类故障都进入明确的 `prepared`、`committed_primary`、`reconciled` 或 repair 状态，并且 RPO/RTO 由部署配置和实测证据支持。

### 建议的测试矩阵

| 类别 | 必测场景 | 关键指标 |
|---|---|---|
| 基本语义 | create/read/write/truncate/mkdir/readdir/stat | 结果、错误码、SQL 次数 |
| 编辑器 | temp write + fsync + rename-over-existing | atomicity、lost update、mtime |
| Git | init/add/commit/status/diff/checkout/stash | hardlink/symlink、锁文件、目录性能 |
| 包管理器 | pnpm/npm/pip/uv/cargo | 并发小文件、rename、缓存路径 |
| Agent | Codex/Claude Code/Aider/自研 Agent | tool success、turn latency、恢复 |
| 并发 | two agents same file、two agents task queue | CAS conflict、deadlock、undo |
| 多租户 | same names、same hashes、malicious claims | cross-tenant visibility、quota |
| 故障 | kill/timeout/retry/failover/remount | idempotency、durability、repair |
| 大对象 | random read、append、streaming write | p95、WAL、physical bytes、GC |

性能目标应在 Phase 0 trace 后制定。可以先把 warm metadata lookup、warm small-file read、cold lookup 和 `readdir(10k)` 作为观察指标，但不应在没有目标 workload 的情况下把任意 p95 数字写成产品承诺。

-----

## 结论与推荐决策

综合外部项目、PostgreSQL 能力和 DSH 当前 filesystem seam，可以作出以下推荐决策。

### 决策一：产品名称应是 WorkspaceFS，而不是 PostgreSQLFS

PostgreSQL 是第一种 backend，不是产品抽象。WorkspaceFS 应定义 filesystem semantics、workspace lifecycle、tenant context、version、snapshot、audit、quota 和 recovery；backend 可以是 PostgreSQL-only、PostgreSQL + object storage、local cache 或未来其他存储。

### 决策二：计算和工作区必须解耦

Agent sandbox 应该是 ephemeral，workspace 应该是 durable。Session persistence、workspace state 和 process lifecycle 是三个不同的 durability domain，控制面必须分别管理它们。

### 决策三：第一阶段采用 Node-level mount

第一阶段使用 Node-level FUSE mount，把 `/workspace` 注入 DSH subprocess、Shell、Git、LSP、编译器和 `ctx.fs` 共用的 execution world。单独实现 remote `ctx.fs` provider 只验证高层 filesystem consumer，不能替代普通进程需要的 file handle、offset write、rename、unlink、fsync 和 lock 语义。

### 决策四：先冻结 V1 filesystem semantics

V1 必须冻结 open flags、file handle、partial write、append、unlink-open-file、rename-over-existing、directory fsync、symlink containment、file lock、directory cursor、POSIX errno 和 DSH typed error 的映射。syscall 清单只能作为入口，不能作为兼容性契约。

### 决策五：durability 与并发所有权必须独立建模

`committed_primary`、`visible`、`durable_acknowledged`、`recovered` 和 `reconciled` 是不同状态；`fsync` 必须返回明确 durability receipt。Session lease、workspace mount lease、operation id、inode CAS、file lock 和 workspace transaction 也必须独立建模。第一阶段只允许一个 mutation mount writer，shared-write 在后续阶段通过明确 conflict 语义验证。

### 决策六：Session 恢复必须使用配对 checkpoint

Session `seq`、workspace generation/root、last operation id、runtime identity 和 capability version 组成跨域 checkpoint。两个 durability domain 不能假设共享数据库事务；恢复流程必须支持 success、reconcile 和 read-only recovery 三种结果。

### 决策七：TigerFS 用作参考实现，不直接 Fork 成最终产品

TigerFS v0.7 最值得借鉴的是 Agent-friendly transactional workspace、parent-pointer directory、operation log、savepoint、undo、identity 和 query reduction。其 File-first 内容范围、TimescaleDB 扩展依赖、可能涉及 TSL-only 功能的许可风险、interleaved undo 限制和与 DSH execution world 不同的 adapter 语义必须被独立替换或隔离。

### 决策八：vanilla PostgreSQL-first

PGFS 核心应在原生 PostgreSQL 上实现 filesystem、version、operation log、snapshot、RLS、quota 和 audit。使用原生分区、索引、MVCC 和 retention 管理增长表；TimescaleDB 作为可选运营或分析增强，而不是 SaaS 核心正确性的强制依赖。

### 决策九：先实现 Agent compatibility set，不追求完整 POSIX

V1 目标应是真实 Agent 的高频语义：L0 全部能力、atomic rename、临时文件、read-after-write、CAS conflict、fsync、Git lock file 和必要的 symlink/hardlink/flock。mmap、xattr、special file、完整 inotify 和设备语义等到 workload 证明需要后再实现。

### 决策十：FUSE/CSI 只是兼容层，Storage Service 才是 SaaS 数据边界

Agent 不直接连接 PostgreSQL。Storage Service 负责授权、RLS context、SQL、连接池、cache、quota、operation history、security audit、idempotency、object lifecycle 和 GC。FUSE、NFS、CSI 和 SDK 共享 metadata/content/authorization core，但各自保留 transport、cache 和 conformance semantics。

### 最终判断

真正值得做的不是“让 PostgreSQL 变成硬盘”，而是把 Agent 原本依赖的本地文件系统接口升级成一个云端、持久、可恢复、可审计、可共享的基础设施对象：

```text
Existing Agent
      │
      ▼
      /workspace
      │
      ▼
WorkspaceFS compatibility layer
      │
      ▼
Remote Durable Workspace
      │
      ├── PostgreSQL metadata and transactional state
      ├── PostgreSQL content for small and medium files
      └── object storage for large artifacts
```

这条路线的价值在于它把 SaaS 化的主要改动放到 infrastructure layer，而不是要求大量已有 Agent 重新学习云存储协议。TigerFS 已经证明这个方向可以围绕 Agent 的实际文件行为建立事务、历史和回滚能力；下一步应以真实 Agent trace 和可运行 PoC 验证兼容性，而不是以 GitHub Stars 或一个成功的 `BYTEA` demo 宣布完成。

-----

## Further Exploration

- [DSH Filesystem subsystem](../subsystems/filesystem.md) — `ctx.fs` 的 target identity、读写、版本 guard 和错误语义。
- [`@deepseek-ai/dsh-fs`](../../packages/fs/fs/README.md) — 当前 filesystem provider seam 的消费者契约和明确限制。
- [TigerFS repository](https://github.com/timescale/tigerfs) — PostgreSQL-backed Agent workspace、File-first/Data-first 和 adapter 结构。
- [TigerFS v0.7 release](https://github.com/timescale/tigerfs/releases/tag/v0.7.0) — operation log、savepoint、undo、parent pointer 和 atomic rename 的公开说明。
- [TigerFS history documentation](https://github.com/timescale/tigerfs/blob/main/docs/history.md) — history、TimescaleDB 依赖和 per-user undo 限制。
- [Tarbox repository](https://github.com/VikingMew/tarbox) — PostgreSQL、FUSE、层、BLAKE3、租户和 CSI 的 Alpha 实现。
- [AgentFS repository](https://github.com/tursodatabase/agentfs) — SQLite 单文件 Agent filesystem、timeline、snapshot 和 SDK 对照。
- [PostgreSQL TOAST](https://www.postgresql.org/docs/current/storage-toast.html) and [Large Objects](https://www.postgresql.org/docs/current/largeobjects.html) — 大字段与流式 Large Object 的不同语义。
- [PostgreSQL Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) — RLS、默认拒绝和 table owner 例外。
- [PostgreSQL Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)、[NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html) 和 [SET](https://www.postgresql.org/docs/current/sql-set.html) — 并发、缓存提示和 transaction-local tenant context。
- [TimescaleDB editions](https://docs.timescale.com/about/latest/timescaledb-editions/)、[TimescaleDB LICENSE](https://github.com/timescale/timescaledb/blob/main/LICENSE) 和 [TSL README](https://github.com/timescale/timescaledb/blob/main/tsl/README.md) — Apache 2 Edition 与 Community/TSL 的许可边界。
- [libfuse mount documentation](https://github.com/libfuse/libfuse/blob/master/doc/mount.fuse3.8) and [Kubernetes storage volumes](https://kubernetes.io/docs/concepts/storage/volumes/) — FUSE 挂载安全和 CSI/PersistentVolume 接入背景。
- [s3fs-fuse README](https://github.com/s3fs-fuse/s3fs-fuse/blob/master/README.md) and [SeaweedFS repository](https://github.com/seaweedfs/seaweedfs) — 对象存储语义限制与 metadata/content 分层的替代路线。

## Dev Note

<details>
<summary>非权威的后续工作范围</summary>

本文是 `docs/drafts/` 中的单语研究草稿，不是 DSH 已实现的产品契约，也不构成 PostgreSQL、TimescaleDB、FUSE、CSI 或第三方项目的法律、性能或安全保证。下一步如果进入实现，应先把 Phase 0 workload trace、WorkspaceFS provider 责任、远程执行世界和 session/workspace 关联写成独立设计记录，再通过 PoC 结果更新本文；不要直接把本文中的示例 DDL、chunk size、缓存 TTL、p95 目标或 POSIX 分层当作已批准实现。

</details>
