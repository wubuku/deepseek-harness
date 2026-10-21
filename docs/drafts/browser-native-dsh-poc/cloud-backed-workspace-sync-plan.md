---
description: "规划 Browser-Native DSH 的云端持久化 Workspace PoC，验证 Worker 本地执行、VFS 增量同步、刷新恢复、冲突处理和服务端进程成本。"
---

# Browser-Native DSH 云端 Workspace 同步 PoC 规划

## Summary

下一轮 PoC 验证一个目标：DSH Agent Loop 和工具在浏览器 Dedicated Worker 中执行，服务端继续提供身份校验、LLM 代理、Session 持久化和 Workspace 文件存储，但不为每个用户或 Agent turn 启动 DSH Host 或操作系统子进程。

PoC 将 Worker 中的可变 VFS Workspace 增量提交到云端，并在新 Worker 启动时恢复。它不尝试复制完整 Node 主机，也不把浏览器描述成无服务器环境。首轮只覆盖明确指定的 Workspace 路径和在线同步；Agentic UI 业务流程、后台 Agent、Safari 验收及离线长期工作队列不属于本轮目标。

## Table of Contents

- [目标与假设](#目标与假设)
- [代码考古与最小接缝](#代码考古与最小接缝)
- [PoC 功能与协议](#poc-功能与协议)
- [验证批次](#验证批次)
- [验收标准](#验收标准)
- [限制与决策门槛](#限制与决策门槛)
- [Dev Note](#dev-note)

## 目标与假设

PoC 要回答的不是“浏览器能否运行 DSH”——现有 Chrome 证据已覆盖真实 Worker Host、`ctx.agentLoop`、VFS 工具、Session 记忆和流式输出。下一步要检验：当浏览器执行的 Agent 能访问云端持久 Workspace 时，是否可以保留客户端计算，同时为用户提供刷新后可恢复的文件工作区。

### 需要验证的假设

1. Worker 执行文件工具时，读写数据留在浏览器 VFS；同步 API 只传输文件变更与提交元数据，不把 Agent Loop 或工具执行转移到服务端。
2. 服务端可以作为共享的 API、LLM proxy、Session store 和 Workspace blob/manifest store，为多个浏览器会话服务；一个 Agent turn 不需要创建一个 DSH Host 或系统子进程。
3. 对已确认提交的文件，刷新、Worker 重启和 backend 重启后都能从云端 Workspace 恢复；未确认提交则明确显示为未同步，不冒充持久化成功。
4. 两个写者基于同一 Workspace revision 修改内容时，系统检测冲突，不静默采用最后写入者覆盖。

本 PoC 不要求移除服务端。LLM 服务端调用、鉴权、持久化、配额检查和对象存储访问均可留在服务端；验收只要求这些职责不暗中变成每用户一份的 DSH Agent 运行时。

## 代码考古与最小接缝

Worker runtime 的 `MemoryVfs` 已支持可选 `VfsMutationSink`。sink 收到已提交的 `write`、`mkdir`、`remove` 和 `chmod` 变更；rename 会以来源删除和目标目录/文件内容变更呈现；`Vfs.flush()` 可等待 sink 处理完已记录的修改。没有配置 sink 时，VFS 留在内存中。对应类型与实现位于 `packages/experimental/webworker-runtime/src/storage/types.ts` 和 `packages/experimental/webworker-runtime/src/storage/memory.ts`。

当前 `createWorkerHost()` 在 `packages/experimental/webworker-runtime/src/worker-host.ts` 内部创建 `MemoryVfs`，再载入只读基础镜像和静态 overlay；调用方不能传入 VFS sink，也没有在模块启动前恢复 Workspace 的公开钩子。因此最先要验证的是这一处最小扩展：允许 Worker Host 使用带 sink 的 VFS，并在 Cordis Host 启动前将授权 Workspace revision hydrate 到可变目录。优先使用现有 mutation sink 和 seed/overlay 能力，不重写 VFS、文件工具或 Agent Loop。

mutation sink 的 `record()` 是同步且不等待网络的；远端写入只能在后台排队。当前接口说明 sink 遇到持久化错误时应报告错误并停止镜像，而不是拒绝已经完成的 VFS 写入。因此 adapter 必须另行暴露同步状态、错误和已提交 revision；`flush()` 返回本身不能单独作为云端持久化回执。Agent 文件操作成功、同步失败、超时或服务端结果不明时，UI 不得标成“已保存”。

PoC 只同步明确允许的可变 Workspace 根目录。当前默认 Session 的 `header.cwd` 是 `/dsh/home`，而 `workspace-write` 以 Session cwd 授权；若直接同步或写入 `/dsh/workspace`，真实 DSH 工具会按策略拒绝。PoC 因此使用 `/dsh/home/workspace` 作为专属同步根，并以此目录创建 Session，使授权根与云端 Workspace 完全一致。`/dsh/home` 下其他目录、基础运行时镜像、`config/`、插件、profile、凭据和 Session 日志不得被 Workspace 同步覆盖。DSH Session 与 Workspace manifest 是两个独立持久化对象，本轮不宣称它们具有跨服务原子事务。

## PoC 功能与协议

本轮以一个文件工作流贯穿 Agent Loop、Worker VFS、云端存储和新 Worker 恢复：用户要求 Agent 创建一个小型记录文件、追加一项、搜索确认内容；确认云端保存后刷新页面，再要求 Agent 读取此前提交的内容。所有文件操作必须由 Worker 内正式 DSH 工具完成。

### 数据流

```text
Browser Main Thread
  ├─ existing DSH UI + workspace save status
  └─ Dedicated Worker
       ├─ DSH Cordis Host + ctx.agentLoop
       ├─ MemoryVfs + workspace mutation sink
       ├─ VFS file tools execute locally
       └─ same-origin API tunnel
            ├─ LLM proxy
            ├─ Session persistence
            └─ Workspace manifest + content-addressed blobs
```

1. **Open:** 主线程提供已授权的 `workspaceId`。Worker 启动前从服务端读取 revision manifest，并下载尚未在内容缓存中的 blob。当前 `MemoryVfs` 不跨 Worker/页面重建保留；若没有额外持久化缓存，冷恢复需要重新下载 manifest 引用的文件。本轮重点承诺增量上传与 hash 去重，不预先承诺增量下载。
2. **Execute:** Worker 从 VFS 读写、创建和删除 Workspace 文件。DSH 文件工具不改成远程逐操作代理。
3. **Record:** sink 过滤允许同步的 Workspace 根目录，合并同一路径上尚未提交的变更；文件内容按字节计算 SHA-256。删除以 tombstone 表示。
4. **Commit:** Worker 上传缺失 blob，再用 `baseRevision`、稳定 `operationId` 和变更 manifest 提交新 revision。blob 上传可按内容 hash 幂等重试；相同 `operationId` 的 commit 重试必须返回原提交结果，不能生成重复 revision 或覆盖后续提交。
5. **Recover:** 收到云端提交回执后，Worker 记录已确认 revision。页面刷新或 backend 重启后，新 Worker 读取该 revision 并恢复文件；未确认的变更显示 pending/failed，不算已保存。若 Agent 后续请求会看见 Workspace revision 或同步状态，则将该模型可见输入和 revision 引用写入同一 DSH Session；Session 仍记录对话与工具事实，云端 Workspace manifest 仍保存文件内容。

“增量”在本轮指仅同步发生变化的文件内容与路径元数据，不做文件内部的二进制块级差分。manifest 至少需要 `workspaceId`、单调 revision、文件路径、内容 hash、字节数、必要的 mode、删除标记和提交操作 ID。计划中的同源 endpoint 包括 manifest 读取、按 hash 读取/上传 blob 和基于 `baseRevision` 提交变更；具体路径与 wire DTO 在实现阶段随 endpoint tests 固定。

### 冲突与失败语义

manifest 提交采用 `baseRevision` 比较并交换。若云端 revision 已变化，服务端返回明确冲突；PoC 保留本地 dirty 文件和远端 revision，不自动 last-write-wins，也不自动把 Agent 工具重跑。首轮验收可以显示冲突并要求重新载入或显式重试；自动三方合并不在范围内。

测试必须区分 blob 上传、manifest commit 和成功回执：blob 上传完成但 manifest 未提交时，新 revision 不得引用不完整文件；服务端已提交但响应丢失时，复用原 `operationId` 应取回同一回执；Worker 断网时不能声称变更已云端持久化。若需要跨刷新保留尚未提交的离线改动，另立 IndexedDB/OPFS outbox 批次，不与首轮云端同步闭环混为一谈。

## 验证批次

### 批次 0：扩展点与同步事实

- 为 `VfsMutationSink` 和 Worker Host 生命周期编写最小 contract test，核对基础镜像 seed 不会作为用户变更上传，Workspace 的 write、append、rename、remove、chmod 能形成可重放变更。
- 确认 Host 启动前 hydrate 的时点早于 Cordis 插件读取 Workspace；确认 `Vfs.flush()` 能被 Worker 保存状态流程调用。
- 若必须更改 `packages/experimental/webworker-runtime`，只增加 VFS 注入/启动前 hydrate 所需的最窄 API，登记 `change-ledger.md`，不改 Agent Loop 语义。

### 批次 1：真实云端 Workspace 纵向闭环

- 给现有同源 PoC backend 增加 Workspace manifest、blob upload/download 和 revision commit API；backend 只做校验、存储和回执，不装载 DSH Host、不执行 DSH 工具。
- Worker 从远端 hydrate 一个 fixture，真实 DSH Loop 执行 read/write/read/search；检查 Session 工具事件与 VFS 内容一致。
- 完成 turn 后显示同步状态与 revision 回执；刷新并创建新 Worker，Agent 从云端恢复的文件中读取精确 marker。
- 对内容 hash 相同的文件重复提交时，不重复上传内容；删除、rename、空文件、Unicode 路径和一个二进制 fixture 均有断言。

### 批次 2：故障、幂等和多写者

- 注入 LLM 请求期间网络断开、blob 上传失败、manifest commit 失败、成功提交后丢失响应及页面刷新。
- 用真实 Chrome 双标签连接同一 Workspace：验证成功写者提交后另一标签的旧 `baseRevision` 冲突；不丢弃任一侧未提交数据。
- 用重复 `operationId`、重复 blob hash 和迟到的旧 revision 请求验证幂等、冲突与旧写者拒绝。
- 用两个隔离测试用户验证跨用户读取和写入都被拒绝；模型凭据不进入浏览器请求或 Workspace 文件。

### 批次 3：证明计算位置和成本假设

- 运行 scripted 并发负载，再用真实 Chrome/LLM 完成小规模端到端 smoke；记录浏览器 Worker 数、backend 进程数、backend 子进程数、Agent Loop 计数、LLM 请求数、同步字节数、manifest 大小、冷启动与恢复耗时。
- 用 1 个与多个并发浏览器会话检查 backend 没有随 Session/turn 创建 DSH Host 或操作系统子进程；不要把模型服务端的推理成本算成浏览器本地计算。
- 比较完整 Workspace 大小与变更文件大小，确认同步流量随变更量增长，而不是每轮重新上传整个 Workspace。
- 结果报告记录设备、浏览器、镜像/Workspace/Session 大小和测试重复次数；不从单机 PoC 推断通用 SLA 或生产并发上限。

本轮浏览器回归只用 Chrome。Safari.app 与 Playwright WebKit 保持暂停，已有结果只作历史对照。

## 验收标准

| 维度 | 通过条件 |
|---|---|
| 本地执行 | Worker 事件、真实 DSH tool call/result 和 VFS 变更证明文件操作发生在浏览器；backend 无 Agent Loop/工具执行记录。 |
| 云端持久化 | 已提交的文件经页面刷新、Worker 重建和 backend 重启后逐字节恢复；提交回执对应可读 revision。 |
| 增量同步 | 只上传新增/修改文件及删除元数据；相同内容 hash 不重复上传；运行时镜像与 Session 不混入 Workspace。 |
| 一致性 | 旧 `baseRevision` 冲突明确；重试相同 `operationId` 返回原结果；无静默 last-write-wins。 |
| 故障呈现 | 未确认的变更显示为未同步；超时后能查询或幂等重试；不得用 Agent 最终回复代替存储回执。 |
| 服务端职责 | backend 只执行 API、LLM 代理、鉴权和存储操作；并发测试中不按用户或 turn 创建 DSH Host/子进程。 |
| 安全 | 每个 API 请求按 principal 授权 Workspace；跨用户访问被拒；LLM 凭据只留在 backend。 |

## 限制与决策门槛

本 PoC 只证明一个明确 Worker/profile 与文件工作流。它不证明所有 DSH 插件都适合浏览器，也不提供完整 Node、任意本机磁盘访问、后台 Agent、通用离线同步、三方合并、生产多租户安全、HA、灾备或 exactly-once 外部业务副作用。

若实现必须让每个文件读写同步等待远端网络、必须在服务端为每个用户启动 DSH 进程，或必须改变 Agent Loop 的 Session 事实来源，应暂停并重新评估设计。若现有 mutation sink 不能以最小 Worker Host 扩展表达远端 hydrate、flush 和失败状态，应先记录代码证据，再决定是否增补 package seam；不要在 docs-only adapter 中假造 durability。

只有在端到端闭环和上述失败/冲突用例通过后，才评估更广 Workspace、OPFS 离线 outbox、更多插件 roster 和产品级并发。首轮不引入 Agentic UI 或 SaaS 业务流程，以免模糊客户端执行与云端持久化的验证结论。

## Dev Note

本规划的核心纵向闭环已实施；每批次的实际结果、未完成验收和限制见[实施进度](cloud-backed-workspace-sync-progress.md)。真实 OS backend 重启和小规模协议并发已完成；浏览器页面压力、容量/吞吐基准和生产级身份/对象存储集成仍未完成。
