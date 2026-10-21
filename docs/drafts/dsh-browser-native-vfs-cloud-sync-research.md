---
description: "调研 Browser-Native DSH 的虚拟文件系统、默认插件持久化分类、Session 日志 append-only 边界、云端 Workspace 增量同步、冲突恢复与生产化路线。"
---

# Browser-Native DSH 虚拟文件系统与云端增量同步深度调研

## Summary

本报告回答一个问题：**在浏览器 Dedicated Worker 中运行 DSH 时，如何用一个本地虚拟文件系统支撑 Agent 的文件读写，并把允许延迟的修改增量同步到云端，而不是每次重传整个 Workspace。**它综合当前仓库的 Browser-Native Workspace PoC、DSH 默认插件的持久化分类、浏览器存储 API、内容寻址存储、delta 传输、CRDT/local-first 方案和文件同步服务的成熟实践，给出可分阶段落地的架构。

核心结论是：

1. **不能把整个 DSH Home 或“默认插件的所有文件”都作为一个可同步 VFS。**Session 事件、附件、projection cache、凭据、settings/profile、runtime image、plugin assets 和 Agent workspace 的权威、生命周期、安全边界与写入形态完全不同。浏览器产品应先同步一个显式授权的 workspace root，例如当前 PoC 的 `/dsh/home/workspace`。
2. **DSH Session 事实层天然适合 append-only。**`SessionEvent` 是逻辑上的只追加日志；默认 JSONL 后端的正常提交路径也是 append + fsync。但该后端仍需要目录创建、临时文件、link/rename、unlink、目录 fsync、锁文件、失败回滚 truncate 和 torn-tail truncate，不能把它描述成只依赖 append API 的存储。
3. **当前 Browser-Native Workspace PoC 已经完成“文件级增量”闭环。**它使用 SHA-256 内容寻址 blob、manifest revision、`baseRevision` CAS、幂等 `operationId`、启动前 hydrate 和 stale-writer conflict；同内容 hash 不重复上传。当前 checkout 的无密钥单元/契约测试复跑通过。
4. **当前 PoC 的“增量”不是块级 delta。**修改大文件中的一个字节仍会产生新的整文件 blob。它尚未实现 OPFS/IndexedDB 离线 outbox、content-defined chunking、VCDIFF/rsync-like byte delta、三方合并或生产对象存储。
5. **生产级成熟方案是“本地 durable outbox + immutable chunk/blob + versioned manifest + CAS commit + pull/notification”。**当前 `VfsMutationSink` 只是 post-commit observer，不能满足 journal-first durability；生产接口必须新增 write-intent、事务、联合提交或由 durable store 反向驱动 VFS。小文件可以用整文件 blob；大文件用 content-defined chunking；rsync/VCDIFF 更适合作为传输优化，不适合作为云端权威模型。
6. **允 eventual consistency 的前提是把状态说清楚。**本地写入成功、本地 durable、上传中、云端已提交、冲突和服务端结果 unknown 必须是不同状态；不能把 Agent 的最终文字或 `Vfs.flush()` 当成云端持久化回执。
7. **Session log 与 Workspace manifest 是两个存储对象，不能假设跨存储原子事务。**需要用 `operationId`、workspace revision 和 Session tool receipt 做恢复时的 reconcile；reconcile 只能追加后续事实，不能重写已提交 Session 事件。

本报告是研究文档，不改变任何运行时行为。它引用当前 `research` 分支的 Browser-Native Workspace PoC 作为实现证据；这些结论绑定当前 checkout，不代表已发布的生产能力。

## Table of Contents

- [证据等级与验证边界](#证据等级与验证边界)
- [一、问题的精确范围](#一问题的精确范围)
- [二、DSH 默认插件的持久化分类](#二dsh-默认插件的持久化分类)
- [三、Session 状态的 append-only 事实与物理例外](#三session-状态的-append-only-事实与物理例外)
- [四、现有 Browser-Native DSH 与 Workspace PoC 考古](#四现有-browser-native-dsh-与-workspace-poc-考古)
- [五、当前 PoC 的能力与边界](#五当前-poc-的能力与边界)
- [六、浏览器本地持久化选择](#六浏览器本地持久化选择)
- [七、生产级同步架构](#七生产级同步架构)
- [八、增量传输的四个层级](#八增量传输的四个层级)
- [九、Operation Journal 与 Outbox](#九operation-journal-与-outbox)
- [十、云端数据模型与 API](#十云端数据模型与-api)
- [十一、冲突模型与一致性策略](#十一冲突模型与一致性策略)
- [十二、目录、rename、delete、chmod 与符号链接](#十二目录rename-delete-chmod-与符号链接)
- [十三、Session 与 Workspace 的跨存储 reconciliation](#十三session-与-workspace-的跨存储-reconciliation)
- [十四、安全、配额与运维](#十四安全配额与运维)
- [十五、为什么不直接采用 CRDT](#十五为什么不直接采用-crdt)
- [十六、成熟方案对照](#十六成熟方案对照)
- [十七、分阶段实施路线](#十七分阶段实施路线)
- [十八、验收矩阵](#十八验收矩阵)
- [十九、反模式与明确不建议的做法](#十九反模式与明确不建议的做法)
- [二十、结论](#二十结论)
- [证据索引](#证据索引)
- [Dev Note](#dev-note)

---

## 证据等级与验证边界

本报告使用以下等级。这里的“印证”不自动表示已执行运行时测试。

| 等级 | 含义 | 已做 | 不代表 |
|---|---|---|---|
| L1 本地源码印证 | 当前 checkout 的实现直接支持结论 | 阅读 VFS、Worker Host、FS seam、JSONL、storage、attachment、credentials、base composition 等源码 | 没有重跑全部产品测试 |
| L2 本地执行验证 | 本报告实际运行无密钥测试并观察结果 | 复跑 Workspace adapter 11 项、PoC backend 14 项、MemoryVfs/tar 24 项 | 没有复跑真实 Chrome/LLM E2E |
| L3 PoC 进度记录 | PoC 进度文档记录过实际验收 | 引用其真实 Chrome/LLM、双标签和 backend 实例重建结果 | 本报告没有独立复跑该 E2E |
| L4 外部官方/权威核查 | 打开并读取官方规范、厂商文档、论文或项目文档 | 核查 WHATWG/MDN、W3C IndexedDB、Git、rsync/VCDIFF、FastCDC、S3、Dropbox、Automerge/Yjs | 未调用外部服务或基准测试 |
| L5 架构推断 | 基于已印证机制提出生产化设计 | 与 DSH 现有边界推理 | 未实现、未测试、未证明性能或可靠性 |

本地证据绑定当前 checkout，外部网页核查日期为 2026-10-21。

---

<a id="一问题的精确范围"></a>
## 一、问题的精确范围

### 要解决的问题

目标不是“把 Node 和浏览器文件系统做成完全一样”，而是：

1. DSH Agent Loop 和文件工具在浏览器 Dedicated Worker 中本地执行；
2. Agent 对一个受限 Workspace root 的读写发生在本地 VFS；
3. 修改异步、增量地同步到云端；
4. 页面刷新、Worker 重建或后端实例重建后能恢复；
5. 云端和另一个写者并发修改时能显式检测冲突；
6. Agent 和用户始终知道哪些内容只是本地 accepted，哪些已有云端 durable receipt。

### 允许的 eventual consistency

“允许延迟和一定时间内不一致”可以体现在：

- 本地写入立即对当前 Agent 可读；
- 后台稍后上传；
- 其他客户端在 commit 后才看到新 revision；
- UI 在同步期间显示 dirty/syncing。

但它不能意味着：

- 云端 commit 前宣称“已保存到云端”；
- 两个写者基于不同 revision 静默覆盖；
- 网络超时后盲目重发新 operation；
- Agent 基于明显 stale 的远端状态无限期工作而没有提示或 lease；
- Session tool result 与 Workspace 存储结果混淆。

### 非目标

本方案不尝试：

- 复制完整 Node 主机或任意本机磁盘；
- 在浏览器中运行 Bash/LSP/subprocess 的全部语义；
- 同步 credentials、settings、plugin tree、runtime image 或 Session log 为一个 Workspace；
- 提供通用离线 Git 客户端；
- 自动合并任意源码或二进制冲突；
- 证明生产多租户安全、HA、灾备或 SLA。

---

<a id="二dsh-默认插件的持久化分类"></a>
## 二、DSH 默认插件的持久化分类

### 分类原则

一个数据项是否进入同步 VFS，取决于四个问题：

1. **权威在哪里**：Session、Workspace、配置服务、对象存储，还是本地 cache；
2. **生命周期属于谁**：一次 turn、一个 Session、一个 workspace、一个 profile，还是一个用户；
3. **写入形态是什么**：append、immutable object、atomic replace、随机写，还是只读镜像；
4. **安全边界是什么**：模型可写、用户可写、浏览器可见，还是只在服务端。

把不同答案的数据放进同一棵可写树，会破坏权限、持久化和恢复语义。

### 默认 base 组合的持久化分类

下表只列出与 Workspace 同步决策直接相关的持久化和运行时状态面，不是默认 base 组合所有插件状态的完整清单。进程内状态、Session event 状态、外部 telemetry 和独立 durable store 不应混入同一个可写文件树。

| 数据 | 当前默认实现 | 写入形态 | 是否纳入 Workspace 同步 | 原因 |
|---|---|---|---|---|
| Session event log | `session-persistence-jsonl`，root 为 `$DSH_HOME/sessions` | 逻辑 append；正常路径 append + fsync；有物理例外 | 否 | Session 事实与 Workspace 事实生命周期不同，需要远程 Session persistence |
| 附件图片/文件 | `attachment-local`，`$DSH_HOME/attachments/v1` | immutable content-addressed object | 否 | 附件是内容对象，不是 Agent 可编辑工作区 |
| Session projection cache | `storage-json` + `session-projection-cache` | JSON record atomic replace | 否 | 是可重建 cache，Session log 是权威 |
| Domain KV / workspace registry | `storage-json` | whole-unit 或 per-record atomic replace | 否 | Host 侧状态，不应由 Agent VFS 写入 |
| Credentials | `credentials-local`，`.credentials.yaml` | YAML atomic replace | 否；不应进入浏览器 | 机密必须在服务端/受控 Host，不下发模型或页面 |
| Settings/profile/plugin composition | profile 文件与配置树 | 可变配置树 | 否 | 配置由服务端/插件管理器拥有 |
| Session query SQLite | 默认 `:memory:` 且 `openAt: never` | 打开时才是 SQLite 页式写 | 否 | 可选索引，不是权威；默认不落盘 |
| Spill 文件 | `spill-local` | 新文件 write-once，清理可删除 | 否 | 是临时大输出，不是权威 workspace |
| Runtime image / overlay | Worker packed image + overlays | 只读 seed | 否 | 由构建与部署版本拥有 |
| Goal / Plan / Todo 等模型可见状态 | `goal`、`plan-mode`、`tool-todo` 等 | Session event 追加，投影回放 | 否 | 状态权威是 Session log，不是独立文件 |
| 用户审批与权限交互 | `user-approval`、sandbox escalation、authorization flow | 请求/结果进入 Session audit 或 credentials 服务 | 否 | 权限决策有独立安全边界，不能当普通 KV 或 Agent 可写文件 |
| 后台 job registry | `jobs-local` | 进程内 in-memory 记录与 output ring | 否 | 生命周期属于 harness 进程；跨重启需要新的 durable job backend |
| subprocess/shell 运行时状态 | `subprocess-local`、bash/job 运行时 | 进程句柄、Job 生命周期、输出流等 ephemeral state | 否 | 只能恢复为新的进程事实；已有输出和工具结果经 Session/spill 记录 |
| Session telemetry | `session-telemetry-otel` | 经用户反馈授权后向 OTLP collector 导出 Session 记录 | 否 | 有独立隐私、脱敏和外流边界，不是 Workspace 文件同步 |
| Agent workspace | `ctx.fs` / tool-fs | 文件工具原子写/编辑；shell 可任意写 | 是，但只应同步显式 root | 这是本报告的目标数据面 |

### 当前 PoC 的范围选择是必要的

当前 PoC 只同步 `/dsh/home/workspace`。这个选择不是实现细节，而是安全边界：

- Session 默认 cwd 是 `/dsh/home`；
- `workspace-write` 以 Session cwd 授权；
- 直接使用 `/dsh/workspace` 会导致真实 DSH 工具按策略拒绝；
- 把 `/dsh/home` 全部同步会把配置、凭据、Session、插件和 runtime 数据暴露给 Workspace 存储与同步引擎；
- 云端 Workspace manifest 与 Session log 保持独立，避免假装跨存储原子事务。

因此生产方案也应以“一个或多个显式授权的 Workspace root”为单位，而不是以整个虚拟根为单位。

---

<a id="三session-状态的-append-only-事实与物理例外"></a>
## 三、Session 状态的 append-only 事实与物理例外

### 逻辑层：Session 是 append-only event log

DSH 的 Session 真源不是可变快照，而是只追加的 `SessionEvent` 流。模型历史、状态投影、title、subagent catalog、goal、todo 等都从事件流回放或折叠。已提交事件不被重写。

这使 Session 与 Workspace VFS 的职责可以拆开：

- Session 记录模型可见事实和工具调用；
- Workspace 存储文件 bytes 和目录 manifest；
- 两者用 operation receipt 关联，而不是互相内嵌。

### JSONL 后端的正常物理路径

`session-persistence-jsonl` 的普通 append 路径：

1. 以 `'a'` 打开当前 session artifact；
2. 写入一个 event batch；
3. `fsync`；
4. 关闭句柄。

`compression: 'none'` 时追加 JSONL 行；`compression: 'zstd'` 时追加独立的带校验和 Zstandard frame。它是“批次 frame 追加”，不是维护一个需要随机改写的全局压缩流。

### 物理层仍不是纯 append-only 文件系统

当前 JSONL 后端还需要：

| 操作 | 场景 | 目的 |
|---|---|---|
| mkdir / directory fsync | 首次物化 | 持久创建 root/project/session 目录 |
| exclusive temp file + fsync | 首次物化 | 先完整写入 header 和第一批事件 |
| POSIX `link` / Windows write-through rename | 首次发布 | 避免覆盖已存在日志 |
| unlink/rm | 清理 temp | 发布后清理冗余名字 |
| `session.lock` + flock/semaphore | 写打开 | 单 Session 跨进程单写者 |
| truncate | append 写入/同步失败回滚 | 回到上一个已提交字节长度 |
| truncate | torn tail 恢复 | 丢弃崩溃留下的不完整物理尾部 |
| 新 generation 发布 | 历史格式迁移 | 旧 generation 不变，写入后继 |

`flock`/semaphore 只描述 Node Host 的跨进程语义。当前 Browser Worker runtime 用单进程替换模块把 `tryLockExclusive()` 立即置为成功；这依赖“该 Worker 内的 in-process write claim 已经排除所有写者”的前提，不提供浏览器多标签页、多 Worker 或跨设备的内核锁语义。当前 cloud-backed PoC 的 Session backend 另有进程内 write-owner claim、renew、close 和过期 reclaim，用于 fencing Session API 写者；它不是内核 `flock`，也不是 Workspace commit lease。生产 Browser-Native 仍必须分别定义 Session 写权、Workspace writer lease 和浏览器本地 coordinator，不能把任一机制外推成全局锁。

因此：

- **Session 事实模型适合 append-only 存储**；
- **当前 JSONL 物理实现依赖 mutable filesystem 语义**；
- **如果底层只有 append-only object store，需要另一个 Session backend 或 adapter**，例如 length/checksum frame、tombstone/recovery marker、object key lease 和不可变 generation，而不是直接套用当前文件协议。

### 其他默认持久化也不是 append-only

- `storage-json`：每次 KV 写入通过 temp + fsync + atomic rename 替换 JSON 文档；
- projection cache：per-session checkpoint 完整 record 替换；
- credentials：YAML atomic replace；
- settings/profile：配置树可变；
- SQLite：启用落盘时是页式随机写；
- `fs-local` write/edit：目标文件内容通过 staging file 原子替换；
- shell：任意进程文件 I/O。

这解释了为什么“Session 可 append”不能外推成“默认插件都可以只靠 append 同步”。

---

<a id="四现有-browser-native-dsh-与-workspace-poc-考古"></a>
## 四、现有 Browser-Native DSH 与 Workspace PoC 考古

### Worker VFS

`packages/experimental/webworker-runtime` 提供 `MemoryVfs`：

- 支持 Node-compatible 文件接口子集；
- 维护普通 file/dir、mode、mtime/ctime、稳定 `ino`；
- 支持 promises face、sync descriptors、open/read/write/truncate/chmod；
- 支持基础 tar image 与只读 data overlay；
- 支持可选 `VfsMutationSink`。

`VfsMutation` 当前包含：

```ts
/** Post-commit mutation emitted by MemoryVfs to its durable observer. */
type VfsMutation =
  | {
    readonly kind: 'write'
    readonly path: string
    readonly bytes: Uint8Array
    readonly mode: number
    readonly entryChanged: boolean
    readonly appendedFrom?: number
  }
  | { readonly kind: 'mkdir'; readonly path: string; readonly mode: number }
  | { readonly kind: 'remove'; readonly path: string }
  | { readonly kind: 'chmod'; readonly path: string; readonly mode: number }
```

`write` mutation 携带完整 post-write bytes、mode、entryChanged 和可选 append offset；rename 被表示为 source removal 加 destination complete write/mkdir，保证 sink 能独立 materialize 目标。

`VfsMutationSink.record()` 是同步的，不延迟已完成的内存 VFS mutation；`flush()` 只等待之前 recorded 的 mutation 被 sink 处理。接口约定 sink 遇到持久化错误应报告并停止镜像，而不是拒绝已经提交的内存写入。

#### 当前 `VfsMutationSink` 不是 journal-first durable journal

`MemoryVfs.publish()` 在 VFS 状态变化之后调用 sink。当前接口最多能形成：

```text
VFS mutation committed in memory
  → synchronous sink.record() attempt
  → later sink.flush()
```

它不能形成：

```text
journal durable
  → VFS mutation
  → local accepted
```

原因是 `record()` 是 post-commit observer：observer 抛错不能回滚已成功的内存 mutation，`flush()` 也只等待已经 recorded 的变更。若浏览器在内存 mutation 与 `record()`、`record()` 与持久化完成之间终止，当前 PoC 不能保证恢复该 mutation。生产实现至少需要以下一种新能力：

1. VFS 写入前持久化 write intent；
2. VFS transaction API，允许 journal 与 VFS 状态共同提交或回滚；
3. journal 是权威存储，VFS 由 journal/durable store 回放驱动，而不是由 post-commit sink 镜像；
4. 文件工具层先写 intent，再调用 VFS，并把两段状态纳入恢复状态机。

### Worker Host 启动顺序

当前 `WorkerHostOptions` 已增加：

- `vfs`：注入外部 `MemoryVfs`；
- `prepareVfs`：在 base image、overlay 和空目录 seed 之后、module loader 与 Cordis boot 之前恢复可变状态。

这个顺序很关键：远端 Workspace 必须在任何 DSH 插件读取文件之前 hydrate 完成。恢复数据使用 `seed`，不应进入 mutation sink，避免把远端镜像当成用户修改再次上传。

### DSH FileSystem seam

`ctx.fs` 是可替换文件系统能力，抽象了：

- resolve/processPath/fileUrl/contains；
- stat/lstat/list/watch；
- read/readBytes；
- writeText/editText；
- sandboxMode 与逐调用策略；
- host path 与 execution world path 的映射。

`fs-local` 的写入和编辑不是原地随机 patch，而是：

1. 在目标旁创建私有 staging directory；
2. 写入 staging file；
3. fsync；
4. rename 或 no-replace link；
5. 清理 staging directory；
6. 按目标串行化。

当前 Workspace mirror 过滤了这种 staging directory，避免 debounce 把 DSH 原子写过程的临时文件提交成一个额外 revision。

### 当前 Workspace mirror

当前 PoC 的 `BrowserNativeWorkspaceMirror`：

- 只接受 `/dsh/home/workspace` 下的 mutation；
- 启动前从 `/api/browser-native/workspace` 获取 identity 和 manifest；
- 校验路径、mode、hash、字节数和 manifest；
- 下载 blob 并用 SHA-256 验证；
- 用 `vfs.seed` / `seedDirectory` 恢复远端状态；
- mutation 进入 100ms debounce 队列；
- write mutation 携带完整新文件 bytes；
- 计算 SHA-256；
- 已知 hash 不重复上传；
- 上传缺失 blob 后提交 manifest；
- commit 成功后更新 revision；
- `WORKSPACE_CONFLICT` 进入 blocked/conflict；
- `flushAndRequireDurable()` 在仍有 pending/retry 或失败时拒绝。

### 当前 backend store

PoC backend 的 `WorkspaceStore`：

- 匿名 HttpOnly cookie 建立 principal；
- 每个 principal 分配 workspace identity；
- manifest 使用单调 revision；
- file blob 以 SHA-256 内容寻址存储；
- commit 校验 protocol、operationId、baseRevision、path、mode、hash、bytes；
- 相同 `operationId` 且相同 digest 幂等重放；
- 相同 `operationId` 搭配不同 changes 返回 `OPERATION_ID_REUSED`；
- stale `baseRevision` 返回 `WORKSPACE_CONFLICT`；
- commit 前验证 blob 存在、大小和 hash；
- 同 workspace commit 串行化；
- workspace state 原子写入本地 PoC dataDir。

---

<a id="五当前-poc-的能力与边界"></a>
## 五、当前 PoC 的能力与边界

### 已在当前 checkout 复跑通过的无密钥验证

本报告实际执行：

| 命令 | 结果 |
|---|---|
| `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts` | 1 个文件、11 项测试通过 |
| `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 14 项测试通过 |
| `pnpm exec vitest run packages/experimental/webworker-runtime/tests/storage/memory-vfs.spec.ts packages/experimental/webworker-runtime/tests/storage/tar.spec.ts` | 2 个文件、24 项测试通过 |

这些测试覆盖了 hydrate、hash 去重、operation ID 重试、CAS conflict、dirty 本地保留、DSH atomic-write staging 过滤、Workspace 持久化、幂等、identity 隔离、无效路径、未验证 blob、并发 commit 串行化、backend 应用实例恢复、empty/binary/Unicode/rename/remove/chmod entries，以及 Session backend 的写 owner fencing、lease reclaim 和 durable restart。它们仍不覆盖独立 operation status 查询、Workspace writer lease、浏览器本地 coordinator、OPFS/IndexedDB outbox 或生产对象存储。

### PoC 进度文档记录的真实 E2E

PoC 进度文档记录，2026-10-21 使用真实 Chrome 与真实 LLM 完成四轮同一 Session：

- 11 个 LLM 请求 HTTP 200；
- 6 个真实 DSH 文件工具调用；
- revision 1 写入/读取 14 字节文件；
- backend Workspace 应用实例重建；
- 页面刷新后新 Worker 从云端恢复；
- 同一 Session 后续读取恢复文件；
- 第二标签提交 revision 2；
- 第一标签旧 revision 写入返回 conflict；
- 冲突文件仍保留为本地 dirty，云端未收录；
- HttpOnly cookie、模型密钥不进浏览器、无非源请求、无 backend child-process 调用、无 page error。

本报告没有复跑真实 LLM E2E，因此将上述事实列为 L3：当前工作区进度记录，不是本报告独立执行的验证。

### “增量”的准确含义

当前 PoC 的增量层级是：

- 不重传整个 Workspace；
- 只上传变更文件和删除/目录 metadata；
- 相同内容 hash 的文件不重复上传 blob。

它不是：

- **块级增量**：修改 1GB 文件中间 1 字节仍上传 1GB 新 blob；
- **字节 delta**：不产生 VCDIFF/rsync patch；
- **离线 outbox**：未提交的内存 VFS 变更不跨页面关闭保存；
- **自动合并**：conflict 后 blocked，不做三方合并；
- **生产云存储**：backend 写本地 PoC `dataDir`。

这是可接受的第一阶段，因为 coding workspace 中许多文件很小，文件级 CAS 已能证明协议与冲突模型。但它不足以承载大文件、低带宽、长时间离线和多端协作。

---

<a id="六浏览器本地持久化选择"></a>
## 六、浏览器本地持久化选择

### OPFS：保存 VFS bytes 和大 chunk cache

OPFS 是 File System API 的 origin-private 存储 endpoint，不展示给用户文件系统。WHATWG File System Living Standard 定义了该模型；MDN 说明 Dedicated Worker 中可通过 `FileSystemSyncAccessHandle` 使用同步读写方法，避免阻塞主线程。

适合保存：

- 当前 workspace 文件 bytes；
- 未上传 blob；
- chunk cache；
- 大文件重建缓冲；
- 本地 working copy。

限制：

- 浏览器支持矩阵仍需逐版本验收；
- quota 受 Storage API 管理；
- 临时存储可能受 eviction 影响；
- `navigator.storage.persist()` 是持久化请求/授权机制，不是应用级事务保证；
- 同步 access handle 的使用应留在 Worker；
- 仍需要应用自己的 journal 和校验，不能把“写入 OPFS”等同于“可恢复的云端 commit”。

### IndexedDB：保存 metadata、manifest 和 outbox

IndexedDB 适合：

- workspace identity；
- local head revision；
- manifest cache；
- path/index；
- chunk hash 到本地位置的映射；
- operation journal；
- upload/commit 状态；
- conflict record；
- server cursor/notification state。

W3C IndexedDB 3 将 transaction 定义为原子且持久的数据访问/变更集合，但 `durability` 是提交时向用户代理表达的偏好提示。`strict` 允许用户代理在验证未完成变更已写入持久存储介质后才认为 transaction committed；规范同时说明这是提示，浏览器会权衡性能与电量。IndexedDB transaction 因此提供事务性提交和失败回滚语义，不提供跨浏览器、跨设备、跨故障模型的云端持久化承诺。生产实现应明确 transaction scope 和 durability hint，并用应用级 checksum、恢复扫描、operation receipt 和云端重建补足浏览器差异。

### 推荐的本地分工

| 本地数据 | 存放 |
|---|---|
| 文件/chunk bytes | OPFS |
| manifest/head revision | IndexedDB |
| path index 与 chunk map | IndexedDB |
| pending operations | IndexedDB |
| operation payload 大 bytes | OPFS，IndexedDB 只存引用 |
| conflict copy | OPFS + IndexedDB metadata |
| runtime image | packed image/HTTP cache，不进可写 outbox |

不要把所有状态都塞进 IndexedDB value：大 Uint8Array 会放大事务、内存和 quota 压力；也不要只用 OPFS 建目录树而没有 metadata journal，因为同步引擎需要 revision、operation 和状态机。

---

<a id="七生产级同步架构"></a>
## 七、生产级同步架构

### 目标拓扑

```text
Browser Dedicated Worker
  DSH Agent Loop + fs tools
        ↓
  Memory VFS / local working copy
        ↓
  durable local sync engine
    OPFS bytes + IndexedDB journal
        ↓
  upload missing chunks / commit manifest
        ↓
Cloud Workspace Service
  identity + authorization
  chunk/blob store
  manifest commits
  revision CAS
  notifications/cursors
```

### 分层职责

| 层 | 职责 | 不负责 |
|---|---|---|
| VFS | Node-compatible 读写、目录、mode、mtime、mutation stream | 网络上传和云端权威 |
| Local durable cache | 本地 bytes、chunk、manifest、dirty state | 决定远端冲突 |
| Outbox | 持久 operation、重试、幂等 ID、unknown result | 静默自动合并 |
| Sync engine | chunk、上传、CAS commit、pull、GC | Agent Loop 语义 |
| Cloud service | 认证、授权、revision、blob 验证、审计、配额 | 执行 DSH 工具 |
| Session service | append-only Session event 和模型可见事实 | 存文件 bytes |
| Reconciler | 把 Session tool receipt 与 Workspace operation/revision 关联 | 伪造跨存储原子性 |

### 关键不变式

1. **生产接口必须让本地 mutation 进入 durable journal 后才报告“可恢复的 local accepted”**。当前 `MemoryVfs` 只暴露 post-commit sink，不能自然得到该不变式；如果只在内存中 accepted，刷新即丢。
2. **重试复用同一 `operationId` 与同一 resulting manifest digest**。超时不能生成新 operation。
3. **commit 前 service 必须能验证所有 referenced chunks/blobs**。
4. **云端 revision 只能由 CAS commit 前进**。
5. **manifest 引用的 immutable content 必须可验证 hash 和 size**。
6. **tombstone 和 rename 有目录语义，不允许丢失并发创建**。
7. **`Vfs.flush()` 最多代表本地 sink drain；云端 durable 必须由 service receipt 定义**。

---

<a id="八增量传输的四个层级"></a>
## 八、增量传输的四个层级

### Level 1：Manifest/path-level delta

只提交变化路径，不重传整个 tree。

当前 PoC 已达到该层级。对大量小文件，这已经显著减少流量，并足以建立 manifest/CAS/冲突模型。

### Level 2：File-level content-addressed blob

每个新文件版本整体作为一个 immutable blob：

```text
path -> FileVersion
FileVersion -> hash + size + mode
```

相同 hash 只上传一次。Git 是该模式的成熟先例：blob、tree、commit 构成内容寻址文件系统，相同内容产生相同对象。当前 PoC 已在 Workspace blob 层采用 SHA-256 内容寻址。

适用：

- 源码文件；
- 配置文件；
- 小文本；
- 变更频繁但文件较小的 coding workspace。

局限：

- 大文件局部修改仍上传完整新版本；
- 相同 path 的新 hash 无法表达局部变更；
- 需要后端 GC 管理不可达 blob。

### Level 3：Chunk-level content addressing

把大文件表示为 chunk list：

```ts
/** One immutable chunk referenced by a file version. */
interface ChunkRef {
  readonly hash: string
  readonly offset: number
  readonly rawBytes: number
  readonly storedBytes?: number
}

/** One immutable file version assembled from chunks. */
interface ChunkedFileVersion {
  readonly fileHash: string
  readonly size: number
  readonly chunks: readonly ChunkRef[]
}
```

新版本分块后，与旧版本 chunk hash 比较，只上传缺失 chunk：

```text
old: A B C D E
new: A B X D E
upload: X
```

**固定长度分块**实现简单，但在文件前部插入一个字节后，后续边界全部移动，几乎全部 chunk 都变成新内容。

**Content-defined chunking** 根据内容滚动哈希确定边界。插入或删除少量数据后，远处 chunk 边界保持稳定，dedupe 效果更好。FastCDC 论文将其用于高性能 deduplication，并用 Gear hash、跳过 sub-minimum cut point 和规范化 chunk size 分布改善速度与去重率。restic 等备份系统也采用内容寻址和 dedup design。

推荐：

- 小文件：整文件 blob；
- 超过阈值的大文件：CDC chunking；
- chunk 设置 min/avg/max，并保存算法版本；
- hash 使用 SHA-256；
- 压缩、加密和 chunking 顺序必须显式版本化。

### Level 4：Byte delta / VCDIFF / rsync-like patch

rsync 的 delta-transfer 用 rolling checksum 识别发送方与接收方共同数据块，只传差异；VCDIFF 是标准化的通用 differencing/compression format。

这类技术适合：

- 远端已知旧版本；
- 带宽昂贵；
- 文件很大且变化局部；
- chunking dedupe 仍不足。

但不建议作为云端权威模型：

- delta 依赖精确 base version；
- base 缺失时必须回退整文件；
- delta 链增加重建和 GC 复杂度；
- 服务端验证与服务端端 CAS manifest 不如 immutable chunk 简单；
- 断点重试不如内容寻址 chunk 自然。

推荐定位：

```text
权威模型：immutable chunk/blob + versioned manifest
传输优化：可选 VCDIFF/rsync-like delta
```

---

<a id="九operation-journal-与-outbox"></a>
## 九、Operation Journal 与 Outbox

### 为什么必须有 outbox

如果 VFS mutation 只留在内存，刷新页面或 Worker 被浏览器终止时，本地已 accepted 的写入会消失。允许延迟同步不等于允许本地 accepted 状态不可恢复。

Outbox 是本地事实，不是网络队列的内存引用。它至少要能回答：

- 哪个 operation 已本地应用；
- 基于哪个 workspace revision；
- 涉及哪些 path；
- 新内容在哪里；
- 是否已上传；
- 是否已 commit；
- 是否 unknown；
- 是否 conflict；
- 是否可安全重试。

### 建议结构

```ts
/** Minimal receipt fields needed by the local outbox design. */
interface WorkspaceCommitReceipt {
  readonly workspaceId: string
  readonly operationId: string
  readonly revision: number
  readonly manifestHash: string
}

/** Path-level change summary retained by the local operation journal. */
interface WorkspaceChangeRecord {
  readonly path: string
}

/** Durable local operation waiting for or describing a cloud commit. */
interface WorkspaceOperationRecord {
  readonly operationId: string
  readonly workspaceId: string
  readonly baseRevision: number
  readonly parentOperationId?: string
  readonly sessionId?: string
  readonly actor: 'user' | 'agent'
  readonly changes: readonly WorkspaceChangeRecord[]
  readonly localAcceptedAt: number
  readonly state: WorkspaceOperationState
  readonly lastServerReceipt?: WorkspaceCommitReceipt
}

/** Lifecycle of one local operation. */
type WorkspaceOperationState =
  | 'journal-writing'
  | 'local-applied'
  | 'uploading'
  | 'commit-pending'
  | 'committed'
  | 'conflict'
  | 'unknown'
  | 'aborted-local'
```

`journal-writing` 到 `local-applied` 的生产实现可以选择两种顺序：

1. **先写 journal 占位，再应用 VFS**：崩溃后可扫描未完成 operation，回滚或修复；
2. **先应用内存，再同步记录 post-commit observer**：实现简单，但存在 VFS 已提交而 journal 未记录的崩溃窗口；必须承认该窗口内只是 memory accepted，不承诺刷新恢复。

生产方案建议第一种，至少对模型工具写入和用户显式保存使用。

当前 `VfsMutationSink` 只能实现第二种顺序。它看到 mutation 时，内存 VFS 已经提交；`record()` 同步调用也不能把 IndexedDB transaction 本身变成同步 durable commit。如果生产要求“local accepted 后可恢复”，必须增加前一节的 write-intent/transaction/replay 能力，或在工具层把 durable intent 和 VFS mutation 拆成显式两阶段并处理中间态。

### 状态机

```text
journal-writing
  → local-applied
  → uploading
  → commit-pending
  → committed

commit-pending --timeout/refresh--> unknown
unknown --authoritative lookup--> committed | not-committed | indeterminate
not-committed --same operation retry--> commit-pending

server CAS reject --> conflict
conflict --> user/agent explicit resolution
```

关键规则：

- `unknown` 不能映射为失败或成功；
- 查询必须携带原 `operationId`；
- 查询结果必须区分权威未提交、暂时不可见和 receipt 已过期/不可判定；
- 只有服务端权威存储确认“从未提交”时，才能自动用原 `operationId` 重试；
- 不能用新 `operationId` 重试同一本地 operation；
- 重试必须复用原 resulting manifest digest，包括所有 path、hash、mode 和 precondition；
- `conflict` 后本地文件不能被删除；
- `unknown` 或“权威未提交”状态下可以幂等重传 blob/chunk，目标 key 是 hash；
- commit 才改变 server head revision。

Operation lookup 应是生产 API 的一等结果，而不是把 HTTP 404 直接当成可重试。以下语义是本报告的生产设计要求（L5），当前 PoC 未实现独立查询接口：

| Lookup 结果 | 含义 | 自动重试 |
|---|---|---|
| `committed` | 权威 commit log 找到该 `operationId`，返回原 receipt | 否；采用 receipt 并推进 head |
| `authoritatively-not-committed` | 权威 commit log 在保留窗口内确认从未提交 | 是；原 `operationId`、原 digest、原 blob 引用 |
| `not-visible-yet` | 查询路径读到的是副本/缓存，无法排除延迟可见 | 否；稍后重查或读权威路径 |
| `receipt-expired` / `indeterminate` | receipt 已被 GC、服务端分区不可判或保留期外 | 否；要求人工/产品级 reconciliation |

服务端 receipt 保留期必须长于客户端最大离线重试窗口；receipt GC 前应保证 commit 历史和审计仍可回答“该 operation 是否曾提交”。如果查询服务不能线性一致地区分“未提交”和“不可见”，它必须返回 indeterminate，不能返回可自动重试的 not-found。

### batching 与 coalescing

当前 PoC 用 100ms debounce 聚合 VFS mutations。生产 outbox 可以继续合并同一 path 的连续写入：

```text
write a v1
write a v2
write a v3
→ 最终只上传 v3
```

前提：

- 本地 journal 仍能恢复已合并前的用户可见状态；
- 不需要保留每次中间版本；
- 没有外部读者依赖 v1/v2；
- commit 的 resulting manifest 是确定的。

对 rename/delete 与并发远端变化，不要盲目 coalesce 语义不同的 operation；至少保留路径和旧 hash preconditions。

---

<a id="十云端数据模型与-api"></a>
## 十、云端数据模型与 API

### 数据模型

```ts
/** Server-side workspace head. */
interface WorkspaceHead {
  readonly workspaceId: string
  readonly revision: number
  readonly manifestHash: string
  readonly updatedAt: number
}

/** Immutable commit applied to one workspace. */
interface WorkspaceCommit {
  readonly revision: number
  readonly parentRevision: number
  readonly manifestHash: string
  readonly operationId: string
  readonly sessionId?: string
  readonly actor: string
  readonly createdAt: number
}

/** Immutable file version referenced by a manifest. */
interface WorkspaceFileEntry {
  readonly path: string
  readonly kind: 'file'
  readonly mode: number
  readonly hash: string
  readonly bytes: number
  readonly chunked?: ChunkedFileVersion
}

/** Immutable directory entry referenced by a manifest. */
interface WorkspaceDirectoryEntry {
  readonly path: string
  readonly kind: 'directory'
  readonly mode: number
}

/** Snapshot entry in one immutable tree manifest. */
type WorkspaceManifestEntry = WorkspaceFileEntry | WorkspaceDirectoryEntry

/** Durable deletion fact in a commit history; a snapshot manifest need not inline it. */
interface WorkspaceRemoveChange {
  readonly path: string
  readonly priorHash?: string
  readonly priorKind: 'file' | 'directory'
  readonly subtree?: boolean
}

/** Durable move fact with source and destination preconditions. */
interface WorkspaceMoveChange {
  readonly fromPath: string
  readonly toPath: string
  readonly expectedFromHash?: string
  readonly priorToPathState: 'absent' | 'file' | 'directory'
}

/** Production change model. A change is journal/commit data, not necessarily an inline manifest entry. */
type WorkspaceChange =
  | WorkspaceFileEntry
  | WorkspaceDirectoryEntry
  | WorkspaceRemoveChange
  | WorkspaceMoveChange

/** Immutable tree snapshot. */
type WorkspaceManifest = Readonly<{
  readonly manifestHash: string
  readonly entries: readonly WorkspaceManifestEntry[]
}>
```

当前 PoC 的 manifest 已区分 `file` 和 `directory`，但 change 仍用 `path + deleted/kind/hash` 表示，没有 durable tombstone、move precondition 或祖先 manifest 语义。以下 `WorkspaceRemoveChange`、`WorkspaceMoveChange` 和 operation status API 是生产设计，不是当前 checkout 已实现接口。

### 生产 Workspace Service 的建议 API 与能力矩阵

```text
GET  /workspaces/:id/head
GET  /workspaces/:id/manifest?revision=N
GET  /workspaces/:id/commits?sinceRevision=N
GET  /chunks/:hash
PUT  /chunks/:hash
POST /workspaces/:id/commit
GET  /workspaces/:id/operations/:operationId
WebSocket/SSE /workspaces/:id/events
```

能力矩阵：

| 能力 | 生产设计 | 当前 PoC |
|---|---|---|
| identity/authorization | 真实登录、租户授权、workspace ACL | 匿名 HttpOnly cookie 和 per-principal workspace |
| head/manifest | 独立 head 与历史 manifest 读取 | `manifest` 返回当前 revision、entries 和 digest |
| blob upload/download | 可续传、租户隔离、hash/size 验证 | `PUT/GET blob/:hash`，SHA-256/size 验证 |
| CAS commit | 权威事务数据库、revision CAS、幂等 receipt | 本地 dataDir、workspace revision CAS、幂等 operation |
| operation status | 权威查询 `committed/not-committed/indeterminate` | 未实现；只能重放原 commit 请求 |
| change notification | WebSocket/SSE 或 cursor pull | 未实现 |
| commit history/audit | 保留 commit、receipt、actor/session | 仅内存 operation map 随 workspace state 持久化，无生产审计模型 |
| resumable upload | 分块上传和断点恢复 | 未实现 |

commit 请求携带：

- protocol version；
- workspaceId；
- `operationId`；
- `baseRevision`；
- changes；
- 每条 file change 的 hash/bytes/chunk list/mode；
- actor/session 关联。

服务端必须：

1. 认证并授权 workspace；
2. 串行化同一 workspace commit；
3. 若 operationId 已存在，比较 digest 并返回原 receipt；
4. 若 baseRevision 不等于 head，返回 conflict 与 current head/manifest；
5. 验证每个 chunk/blob 存在、大小和 hash；
6. 验证路径和目录约束；
7. 构造新 manifest；
8. 原子持久化 commit；
9. 返回 revision、manifestHash、operationId 和 changed paths。

### 条件写与对象存储

服务端 manifest 可以放在 PostgreSQL 等事务数据库中，chunk/blob 放对象存储。即使对象层支持条件写，也应由 Workspace service 持有权威 revision，而不是让多个客户端直接 CAS 一组对象。

Amazon S3 的条件请求说明 `If-Match`/`If-None-Match` 可用于防止不知情覆盖，这是成熟机制；但它只解决单个对象的 precondition，不自动提供 tree commit、path 冲突、operation 幂等和租户授权。

### Pull 模型

客户端应支持：

1. WebSocket/SSE 通知 head revision 变化；
2. 断线后用 cursor/revision 主动 pull；
3. 下载新 manifest 与缺失 chunk；
4. 校验 hash；
5. 只替换未被本地 dirty operation 覆盖的路径；
6. 对 dirty overlap 标记 conflict；
7. 更新本地 head 与 notification cursor。

Dropbox 文件 API 用 folder cursor 和 `list_folder/continue` 表达增量变化，是成熟的 change cursor 模式。Workspace service 可以采用类似 `sinceRevision`，但不需要复制 Dropbox 的全部文件语义。

---

<a id="十一冲突模型与一致性策略"></a>
## 十一、冲突模型与一致性策略

### 第一阶段：workspace-level writer lease

对 DSH Agent workspace，最稳妥的第一阶段是：

- 同一 workspace 同一时间只有一个 writer session；
- 其他客户端只读或显示 stale；
- lease 有心跳和到期；
- 旧 lease reclaim 需要 fencing token；
- Agent turn 开始前刷新 head；
- turn 中保持 lease；
- turn 结束或文件工具 checkpoint 时提交。

这避免了多主文件同步的复杂合并问题，适合当前 Agent 使用场景。

### 浏览器内的本地 coordinator

Workspace 服务端 lease 只解决跨客户端的提交权威，不自动解决同一浏览器中两个标签页各自持有 `MemoryVfs`、outbox 和旧 head 的问题。当前 PoC 的双标签 E2E 证明 revision CAS 能阻止旧 revision 静默覆盖，但没有实现 Workspace 本地 coordinator；conflict 后如何合并 dirty 文件、谁 pull 新 manifest、谁重试 outbox，仍由产品层处理。Session backend owner lease 也不能替代这个 coordinator。

生产方案应为每个 workspace 明确一个 origin-local coordinator。以下是本报告的架构设计（L5），当前未实现，也未在多标签压力或 leader 切换场景中验证：

1. 用 Web Locks、BroadcastChannel、SharedWorker 或等价机制选择一个 active worker；
2. active worker 持有本地 VFS 写权和 outbox dispatch 权，其他标签显示只读副本或创建显式 detached workspace；
3. 本地 writer epoch 与服务端 lease/fencing token 绑定，commit 请求携带 token，过期 owner 的迟到提交被服务端拒绝；
4. coordinator 负责 pull、刷新本地 head、处理通知和排队重试，避免多个 worker 对同一 local base 生成不同 operation；
5. outbox 记录必须按 `operationId` 去重，leader 切换时通过 durable journal 接管 pending operation；
6. 若无法取得 coordinator 或服务端 lease，UI 不得把本地可编辑状态表述为已同步。

当前 checkout 没有该 coordinator、Workspace 本地 durable outbox、Workspace 本地 writer epoch 或 Workspace Service writer lease。这些是生产多标签支持的前置条件，不是 revision CAS 或 Session owner lease 的自动产物。

### 第二阶段：path-level CAS

允许多个客户端并发修改不同文件：

```text
A writes src/a.ts @ base 10
B writes src/b.ts @ base 10
→ 两个 commit 都可线性化
```

同 path 并发修改则冲突：

```text
A writes src/a.ts expected hash H1
B writes src/a.ts expected hash H1
→ 第二个 commit 拒绝或进入 merge 流程
```

必须同时校验父目录和 delete/rename，否则会出现：

- A rename `a/` 到 `b/`；
- B 在 `a/new.txt` 创建；
- 简单 tree CAS 丢失 B 的创建。

### 第三阶段：显式三方合并

自动合并只应在满足以下条件时提供：

- 共同祖先 manifest 可用；
- 双方都是文本；
- 编码与换行明确；
- 合并无 conflict marker；
- 二进制、lockfile、generated file 不自动合并；
- 结果交给用户或 Agent 审查；
- 合并产生新 operation，基于当前 head。

默认保守策略是 conflict copy：

```text
src/a.ts
src/a.ts.conflict.<actor>.<revision>.<short-hash>
```

### stale read 与 freshness

允 eventual consistency 时，还必须定义读策略：

1. **local-first**：读本地 VFS，适合当前正在编辑的 Agent；
2. **refresh-at-turn-start**：每个 Agent turn 开始前拉取 head；
3. **writer lease**：lease 内假设没有其他 writer；
4. **critical read remote-check**：关键读前检查 revision；
5. **commit CAS**：最终兜底，不允许 stale base 静默覆盖。

生产建议：单 Agent 场景使用 1+2+3+5；多 Agent 场景必须增加通知和 conflict UX。

---

<a id="十二目录rename-delete-chmod-与符号链接"></a>
## 十二、目录、rename、delete、chmod 与符号链接

### Delete：必须使用 tombstone

只从 manifest 删除路径不够。离线客户端可能同时创建同一路径。commit 需要记录：

```ts
/** Tombstone for a removed path or subtree. */
interface WorkspaceTombstone {
  readonly path: string
  readonly priorHash?: string
  readonly deletedFromRevision: number
  readonly subtree?: boolean
}
```

并发 resurrect 分为：

- 允许 resurrect：显式记录新创建，不等同旧文件恢复；
- 拒绝：要求用户确认；
- 自动保留两份：生成 conflict copy。

### Rename：不能简单等价于 delete+create

成熟模型应记录 move 并校验 source：

```ts
/** Move precondition and result. */
interface WorkspaceMove {
  readonly fromPath: string
  readonly toPath: string
  readonly expectedFromHash?: string
  readonly priorToPathState?: 'absent' | 'file' | 'directory'
}
```

如果 source 在本地 base 后被远端修改，或 target 被并发创建，必须冲突。对目录 move 还要原子移动 subtree entries。

当前 `MemoryVfs` mutation sink 将 rename 展开为 source entry removal，以及 destination 的完整 `write`/`mkdir` mutation。该表示允许 sink 在不读取 VFS 旧状态的情况下 materialize destination；它不会移除 destination 的既有内容，destination 已存在时的替换语义由 VFS rename 规则先处理。生产 manifest 协议可以选择保留 move 语义，或明确所有 rename 都按 delete+create 提交并接受元数据损失；同步器不能把上述 source removal 误实现为删除 destination。

### chmod / mtime

浏览器 VFS 不应承诺完整 POSIX 权限语义。建议：

- mode 作为 0..0o777 metadata 保存；
- 不支持 chown；
- 不承诺 uid/gid；
- mtime 可以本地显示，但云端权威时间以 commit 为准；
- 执行位保留，但浏览器不代表真的可执行。

### Symlink

第一阶段明确不支持 symlink。原因：

- 浏览器 VFS 和云端 path 授权容易产生逃逸；
- 同步后链接目标可能不存在或指向 workspace 外；
- Git symlink 与平台差异复杂；
- 当前 `MemoryVfs` stats 虽有 symlink 类型，但 workspace 协议不应隐式扩大能力。

若未来支持，必须是 workspace 内部的显式 entry，并由服务端验证 containment。

---

<a id="十三session-与-workspace-的跨存储-reconciliation"></a>
## 十三、Session 与 Workspace 的跨存储 reconciliation

### 两个事实源

Session log 记录：

- 用户 prompt；
- assistant 输出；
- tool call 参数；
- tool result；
- operationId/receipt 引用；
- 模型请求与工具时序。

Workspace store 记录：

- manifest；
- blob/chunk；
- revision；
- operation receipt；
- actor/session 关联。

不能假设“Session flush 成功”和“Workspace commit 成功”在同一个数据库事务中发生。

### 四种交叉结果

| Session | Workspace | 用户看到 | 恢复动作 |
|---|---|---|---|
| committed | committed | 已保存文件与对话事实 | 正常恢复 |
| committed | pending/unknown | 对话说工具已执行，但云端文件未确认 | 查询 operation；显示 pending/unknown |
| flush failed | committed | 文件已保存，但对话事实缺失 | 保留 Workspace receipt，追加 reconciliation event 或提示用户恢复；不能重写原 Session 事件 |
| unknown | unknown | 两边结果不明 | 分别按幂等 ID 查询，不能重放副作用 |

### Tool receipt

文件工具结果应携带：

```ts
/** Receipt linking a DSH tool call to a Workspace commit. */
interface WorkspaceToolReceipt {
  readonly toolCallId: string
  readonly workspaceId: string
  readonly operationId: string
  readonly baseRevision: number
  readonly committedRevision?: number
  readonly manifestHash?: string
  readonly status: 'local-accepted' | 'cloud-pending' | 'cloud-committed' | 'conflict' | 'unknown'
}
```

恢复时：

1. 从 Session event 找 workspace tool receipt；
2. 用 operationId 查询 Workspace service；
3. 将 unknown 分为 committed/authoritatively-not-committed/indeterminate；
4. 对 committed 更新本地 head；
5. 对 authoritative not-committed 保留本地 dirty outbox 并按原 `operationId` 重试；
6. 对 conflict 保留本地文件并呈现选择；
7. 对 indeterminate 持续查询或进入产品级 reconciliation；
8. 后续模型输入必须描述真实状态，不能沿用“已保存”的旧叙述。

Reconciliation 事件可以记录“Workspace operation 已提交、原 Session flush 失败、恢复时已查询到该 receipt”，并为 UI/模型投影提供补偿状态。它不能改写已提交的 tool result、伪造当时的原子提交，也不能把 Workspace receipt 直接写回历史事件。若需要标注旧 tool result 的后续云状态，只能通过追加事件建立关联。

### flush 语义

`Vfs.flush()` 不能被定义成云端持久化。建议：

- `Vfs.flush()`：等待本地 sink/journal drain；
- `flushWorkspace()`：等待上传和 commit 或抛出 pending/error；
- `flushAndRequireDurable()`：只有拿到 server receipt 才成功；
- UI 状态使用 `local accepted` 与 `cloud committed` 分开表述。

---

<a id="十四安全配额与运维"></a>
## 十四、安全、配额与运维

### 授权与租户

每个请求必须携带 principal，并由服务端验证：

- workspace 归属；
- 读/写 capability；
- 路径 containment；
- session/workspace 关联；
- quota；
- writer lease；
- operation id ownership。

当前 PoC 的匿名 HttpOnly cookie 只适合 PoC。生产需要真实登录、租户隔离、CSRF/Origin 策略、审计和密钥管理。

### 浏览器存储 eviction

浏览器 Storage API 管理 IndexedDB、Cache 和 File System/OPFS 等配额。默认 best-effort storage 可能在压力下 eviction；`navigator.storage.persist()` 可为关键数据请求持久存储，持久 origin 会跳过该 eviction 机制，但最终仍受浏览器授权和 quota 限制。`persist()` 是可选优化，不能作为产品数据安全承诺；生产必须假设本地 OPFS/IndexedDB 可能被清空，并用 manifest/blob checksum、operation receipt 和云端重建恢复。

应用必须：

- 显示 quota estimate；
- 请求 persist；
- 处理拒绝或不可用；
- 提供“本地缓存损坏/被清除后从云端重建”路径；
- 不要把本地 cache 视为唯一权威。

### 服务端存储与 GC

Immutable chunk/blob 带来 GC 问题：

1. commit 引用新 chunk；
2. 旧 manifest 不再引用部分 chunk；
3. 活跃 reader 可能仍基于旧 revision；
4. 删除过早会导致 pull 失败；
5. 删除过晚增加成本。

建议：

- 保留最近 N 个 revision 或时间窗口；
- 以 manifest reachability 为准；
- GC 与新 commit 串行或使用两阶段 mark/sweep；
- 对象存储 delete marker 与数据库事务要对账；
- 所有下载都校验 hash 和 size；
- 保留审计记录。

### 上传与网络

- chunk PUT 按 hash 幂等；
- 支持 resumable upload 或 multipart；
- 并发上传有上限；
- 按重试策略退避；
- 大 payload 不进 JSON；
- 浏览器请求与 backend 之间使用同源认证；
- 观察 `usage/quota`、上传 bytes、commit latency、冲突率、GC 成本。

### 恶意内容与隔离

Workspace service 存储用户/Agent bytes，不解释执行。仍需：

- 路径规范化；
- 大小和 entry 上限；
- 内容类型不作为执行依据；
- 病毒/恶意扫描按产品需求单独设计；
- 不把 workspace 文件挂到服务端任意进程；
- 浏览器端不执行未经过原有 DSH 工具授权的程序。

---

<a id="十五为什么不直接采用-crdt"></a>
## 十五、为什么不直接采用 CRDT

Automerge 和 Yjs 等 CRDT 在 local-first 协同文档领域成熟。Automerge 文档说明其可在多设备无中心服务时自动合并并发修改，并面向 local-first 应用；Yjs 支持增量 binary update，并可用 IndexedDB provider 支持离线编辑。

但通用文件系统同步不适合直接使用 CRDT 作为基础模型：

| 问题 | CRDT 的行为 | 文件系统需要的判断 |
|---|---|---|
| 文件 bytes | 二进制 payload 合并通常没有语义 | 需要 base revision、chunk/delta 或 conflict |
| 目录树 | 自动合并集合可能保留双方 | rename/delete/create 需要路径唯一性和父目录约束 |
| rename | 同名路径操作可能产生多winner | 需要确定 path 或生成 conflict copy |
| 源码 | 字符级自动合并可能破坏语法 | 需要 AST/text merge、测试和人工审查 |
| 二进制 | 无法语义合并 | 需要 conflict copy |
| 权限 | CRDT 不理解 OS 授权 | 需要服务端 policy |

CRDT 适合的子问题：

- 聊天/协同文本编辑器；
- 结构化应用状态；
- presence；
- 不需要精确文件系统路径语义的数据。

如果要用于 Workspace，可以作为特定文件类型的应用层扩展，而不是替代 manifest/CAS 权威。

---

<a id="十六成熟方案对照"></a>
## 十六、成熟方案对照

| 方案/家族 | 可借鉴点 | 不应直接照搬 |
|---|---|---|
| Git | blob/tree/commit 内容寻址；不可变对象；parent DAG | Git 的 branch/merge UX 与文件系统实时同步不同 |
| Git pack | 相似对象 delta compression；按路径启发式分组 | pack 是传输/存储优化，不是权威 tree model |
| rsync | rolling checksum；只传差异；整文件校验 | 主要面向两方同步，不提供多租户 manifest 权威 |
| VCDIFF | 标准 delta 格式 | 依赖 base；不适合作为唯一对象表示 |
| restic/backup dedupe | SHA-256 内容寻址；CDC dedupe | backup 语义与交互 workspace 不同 |
| Dropbox/Drive 类 sync | cursor、增量 change list、conflict copy | 不透明实现；产品语义不同 |
| Automerge/Yjs | local-first CRDT、增量 update、离线 | 不适合任意文件树与二进制 |
| S3 conditional writes | If-Match/If-None-Match 防不知情覆盖 | 不解决 tree commit 与授权 |
| OPFS/IndexedDB | 本地 bytes 与结构化事务 | 应用仍需 outbox、receipt 和 eviction 策略 |

---

<a id="十七分阶段实施路线"></a>
## 十七、分阶段实施路线

### 阶段 0：固定当前 PoC 的语义

- 保留 workspace root 隔离；
- 保留 server revision CAS；
- 保留幂等 operationId；
- 保留本地 conflict 文件；
- 明确文件级 blob 是当前增量层级；
- 把真实 Chrome/LLM E2E 和 backend 应用实例重建结果纳入可重复 CI/验收路径。

### 阶段 1：本地 durable outbox

- 新增 write-intent/transaction/replay 能力，不能假设当前 post-commit `VfsMutationSink` 已提供 journal-first durability；
- 把 operation intent/journal 持久到 IndexedDB；
- bytes 持久到 OPFS；
- 刷新/Worker 重建后恢复 dirty operations；
- 重试复用 operationId；
- UI 区分 local accepted 与 cloud committed；
- 本地 cache 损坏时可从云端重建。

### 阶段 2：生产 Workspace service

- 真实登录与租户授权；
- manifest commit 放入事务数据库；
- blob/chunk 放对象存储；
- 服务端 hash/size 验证；
- 审计、配额、并发上限；
- operation status 查询；
- status 查询区分 committed/authoritatively-not-committed/indeterminate；
- cursor/notification；
- 对象 GC。

### 阶段 3：大文件 chunking

- 设定整文件/chunked 阈值；
- 实现固定或 CDC chunker；
- FileVersion 引用 chunk list；
- 只上传缺失 chunk；
- 支持断点上传；
- 保存 chunker 版本与参数。

### 阶段 4：多端与冲突

- workspace writer lease；
- 浏览器内 workspace coordinator 和本地 writer epoch；
- coordinator 切换时接管 pending outbox；
- turn-start refresh；
- SSE/WebSocket head notification；
- pull manifests since revision；
- path-level CAS；
- tombstone/rename preconditions；
- conflict copy 和显式三方合并。

### 阶段 5：Session/Workspace reconciliation 产品化

- WorkspaceToolReceipt 进入 Session 事实；
- 恢复时查询 operation；
- unknown 处理；
- UI 呈现 pending/conflict；
- 后续模型输入携带真实文件状态；
- 清理已 resolved operation 的 UI 状态但不丢审计。

---

<a id="十八验收矩阵"></a>
## 十八、验收矩阵

### 本地持久化

- 刷新页面后未提交 dirty 文件仍可恢复；
- Worker terminate 后恢复；
- VFS mutation 与 journal record 之间崩溃时状态可判定或可恢复；
- OPFS/IndexedDB quota 不足时明确失败；
- 本地 cache 删除后能从云端 head 重建；
- 本地 metadata 与 bytes hash 不一致时拒绝并重建。

### 增量传输

- 新增小文件只上传该 blob；
- 相同内容不重复上传；
- 修改 chunked 大文件只上传变化 chunk；
- 文件前部插入后 CDC 保留远处 chunk；
- 删除只提交 tombstone/metadata；
- rename 不重传内容 blob；
- 断点上传可恢复。

### Commit 与幂等

- stale baseRevision 返回 conflict；
- 重复 operationId + same digest 返回原 receipt；
- 重复 operationId + different digest 拒绝；
- status 查询区分 committed、authoritatively-not-committed、not-visible-yet、receipt-expired；
- 只有 authoritative not-committed 自动用原 operation 重试；
- blob 未上传不能 commit；
- 并发 commit 线性化；
- 服务端重启后 head/receipt/manifest 可恢复。

### 一致性与冲突

- 双标签旧 revision 写入不覆盖新 head；
- 双标签通过本地 coordinator 取得单一写者；
- coordinator 崩溃后 pending operation 可被新 leader 接管；
- conflict 后本地 dirty 不丢；
- 远端 pull 不覆盖本地 dirty path；
- rename/delete/并发创建检测；
- writer lease 到期与 fencing 正确；
- 旧 lease 迟到提交被拒绝。

### Session reconciliation

- Session tool call 能找到 operationId；
- commit 超时后查询原 operation；
- authoritative not-committed 时保留本地 pending 并用原 operation 重试；
- indeterminate 不自动重试 commit；
- committed 时更新 head；
- conflict 时进入显式解决；
- reconciliation 只追加事件，不改写历史 Session 事实；
- 模型不会把 pending 说成已云端保存。

### 安全与配额

- 跨用户/跨租户 blob 引用被拒绝；
- 路径 traversal 被拒绝；
- 每个 workspace entry/bytes/quota 有上限；
- 所有下载验证 hash/size；
- 服务端审计 commit；
- 浏览器不可见模型密钥。

---

<a id="十九反模式与明确不建议的做法"></a>
## 十九、反模式与明确不建议的做法

| 做法 | 问题 |
|---|---|
| 同步整个 `$DSH_HOME` | 混合 Session、凭据、配置、runtime 与 workspace 权限 |
| 把 backend 当 NFS，每次工具读写都走网络 | 失去本地执行价值，放大延迟和故障 |
| 每次全 workspace scan + full upload | 流量和延迟随仓库规模增长 |
| 只用 dirty path，没有 hash/manifest | 无法检测并发冲突 |
| last-write-wins 覆盖同 path | 静默丢失 Agent/用户工作 |
| 网络超时后生成新 operationId | 破坏幂等，可能重复提交 |
| 把 operation 查询的 404 当作权威未提交 | 延迟可见或 receipt GC 会诱发重复副作用 |
| 把 `Vfs.flush()` 当云端回执 | 本地 sink drain 不是 server commit |
| 把 Session 事件当文件存储 | 模型历史膨胀，文件 bytes 与对话事实耦合 |
| 把 Workspace commit 嵌入 Session event 作为唯一存储 | 云端文件恢复需要拉完整 Session，权限和生命周期耦合 |
| 假设 Session 与 Workspace 跨存储原子提交 | 两个 service 可能一面成功一面失败 |
| 用 Workspace receipt 改写历史 Session 事件 | 已提交 Session 事实只能追加，不能伪造原子提交 |
| 把 Browser Worker 的 flock stub 当跨标签锁 | 该替换只覆盖单进程 in-process claim 假设 |
| 用 CRDT 合并任意文件树 | 二进制、路径、rename、源码语义无法自动收敛 |
| 只依赖 localStorage/sessionStorage | 容量、类型和持久性不适合 workspace |
| 不处理 OPFS eviction/quota | 刷新或压力下本地 pending 丢失 |
| 服务端接受未验证 hash 的 blob 引用 | 可引用他人对象或损坏内容 |
| 立即 GC 旧 blob | 旧 revision reader pull 失败 |
| 自动执行/解释 workspace 文件 | 存储服务获得代码执行面 |

---

<a id="二十结论"></a>
## 二十、结论

Browser-Native DSH 的 Workspace 不应追求“浏览器里有一个通用远程磁盘”，而应实现一个**受限、可审计、可恢复的本地-first Agent workspace**：

1. 只同步显式授权的 workspace root；
2. Agent 文件工具在 Worker 本地读写 VFS；
3. 本地 mutation 进入 durable outbox；
4. 云端以 immutable blob/chunk 和 versioned manifest 为权威；
5. commit 用 revision CAS 和幂等 operationId；
6. pull 用 revision cursor/notification；
7. 小文件整文件 blob，大文件 content-defined chunking；
8. 冲突显式化，第一阶段优先 writer lease；
9. Session 与 Workspace 用 receipt/reconciler 关联；
10. UI 和模型输入严格区分 local accepted 与 cloud committed。

当前 PoC 已经验证了这条路线的最小核心：Worker 本地执行、云端 manifest/blob、revision CAS、幂等 operation、刷新恢复和 stale-writer conflict。下一步不是引入泛化 CRDT 或远程磁盘，而是补上 durable local outbox 与 chunk-level增量，这两项分别解决“延迟同步不丢本地工作”和“大文件不重传整文件”的关键生产缺口。

---

<a id="证据索引"></a>
## 证据索引

### 本地源码与文档

| 事实 | 等级 | 来源 |
|---|---|---|
| Worker `MemoryVfs`、mutation、seed/overlay、Node fs bridge | L1 | [types.ts](../../packages/experimental/webworker-runtime/src/storage/types.ts)、[memory.ts](../../packages/experimental/webworker-runtime/src/storage/memory.ts)、[fs.ts](../../packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/fs.ts) |
| Worker Host 支持注入 VFS 并在 boot 前 `prepareVfs` | L1 | [worker-host.ts](../../packages/experimental/webworker-runtime/src/worker-host.ts) |
| DSH FileSystem seam 与原子写 | L1 | [fs/src/index.ts](../../packages/fs/fs/src/index.ts)、[fs-local/src/fsio.ts](../../packages/fs/fs-local/src/fsio.ts) |
| 默认 base 中 Session、attachment、storage、SQLite、projection cache 与 fs-sandbox 的组合 | L1 | [base cordis.patch.yml](../../packages/bundle/base/cordis.patch.yml) |
| Session JSONL append/物化/回滚/torn tail | L1 | [session-persistence-jsonl/src/index.ts](../../packages/session/session-persistence-jsonl/src/index.ts) |
| Node Session kernel lock 与 Browser Worker 单进程替换 | L1 | [lease.ts](../../packages/session/session-persistence-jsonl/src/lease.ts)、[node-addon-system-flock.ts](../../packages/experimental/webworker-runtime/src/node/external_packages/node-addon-system-flock.ts) |
| storage-json 原子替换 | L1 | [storage-json/src](../../packages/storage/storage-json/src/index.ts) |
| credentials YAML 原子替换 | L1 | [credentials-local/src/index.ts](../../packages/credentials/credentials-local/src/index.ts) |
| jobs-local 进程内 in-memory registry | L1 | [jobs-local README](../../packages/jobs/jobs-local/README.md) |
| Session telemetry 的反馈授权与外部 OTLP 边界 | L1 | [session-telemetry-otel README](../../packages/session/session-telemetry-otel/README.md) |
| Goal/Plan/Todo/审批状态由 Session event 承载 | L1 | [goal README](../../packages/goal/goal/README.md)、[plan-mode README](../../packages/plan/plan-mode/README.md)、[tool-todo README](../../packages/todo/tool-todo/README.md)、[user-approval README](../../packages/interaction/user-approval/README.md) |
| subprocess/shell/job 的进程生命周期边界 | L1 | [subprocess-local README](../../packages/subprocess/subprocess-local/README.md)、[tool-bash README](../../packages/shell/tool-bash/README.md) |
| 当前 Workspace mirror 文件级 blob、CAS、状态机 | L1 | [browser-native-workspace.ts](browser-native-dsh-poc/browser-native-workspace.ts) |
| 当前 backend WorkspaceStore 幂等/CAS/blob 验证 | L1 | [workspace-v2.mjs](browser-native-dsh-poc/workspace-v2.mjs) |
| cloud-backed PoC Session backend 的写 owner claim/renew/reclaim | L1 | [browser-native README](browser-native-dsh-poc/README.md)、[backend-v2.mjs](browser-native-dsh-poc/backend-v2.mjs) |
| 当前 PoC 规划与限制 | L1/L5 | [cloud-backed-workspace-sync-plan.md](browser-native-dsh-poc/cloud-backed-workspace-sync-plan.md) |
| 当前 PoC 真实 Chrome/LLM 记录 | L3 | [cloud-backed-workspace-sync-progress.md](browser-native-dsh-poc/cloud-backed-workspace-sync-progress.md) |
| 本报告复跑无密钥测试 | L2 | 见第五节命令 |

### 外部来源

外部页面统一在 2026-10-21 复核。Living standard 和厂商文档会变化；下表的日期/commit 是本报告的版本锚点。Git、rsync、S3、Dropbox、restic、Automerge 和 Yjs 只用于命名成熟机制，不表示 DSH 已接入这些系统。

| 事实 | 等级 | 版本/检索锚点 | 来源 |
|---|---|---|---|
| OPFS 是 origin-private File System 存储 endpoint | L4 | Living Standard，2026-10-19，commit `d76d3455d5afe2f85754ed24ffdbf99fe30032d4` | [WHATWG File System Standard](https://fs.spec.whatwg.org/) |
| OPFS Worker 中有同步 access handle | L4 | MDN 页面修改时间分别为 2025-07-14 与 2025-04-09 | [MDN OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)、[MDN FileSystemSyncAccessHandle](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle) |
| IndexedDB transaction 语义与 durability hint | L4 | W3C Working Draft，2025-08-13 | [W3C IndexedDB 3](https://www.w3.org/TR/IndexedDB-3/) |
| 浏览器 storage quota、eviction 与 persist | L4 | MDN 页面修改时间分别为 2026-01-05 与 2026-10-12 | [MDN Storage quotas](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)、[MDN StorageManager.persist](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist) |
| Git blob/tree/commit 内容寻址 | L4 | 当前线上版次，2026-10-21 | [Git Objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects) |
| Git pack delta compression | L4 | 当前线上版次，2026-10-21 | [git-pack-objects](https://git-scm.com/docs/git-pack-objects) |
| VCDIFF 标准 delta format | L4 | RFC 3284，2002-06 | [RFC 3284](https://www.rfc-editor.org/rfc/rfc3284.html) |
| rsync delta-transfer 与 whole-file checksum | L4 | master 分支当前页面，2026-10-21 | [rsync manual](https://github.com/RsyncProject/rsync/blob/master/rsync.1.md) |
| FastCDC content-defined chunking | L4 | USENIX ATC '16 论文 | [FastCDC paper](https://www.usenix.org/system/files/conference/atc16/atc16-paper-xia.pdf) |
| restic SHA-256/dedup design | L4 | master 分支当前页面，2026-10-21 | [restic design](https://github.com/restic/restic/blob/master/doc/design.rst) |
| S3 conditional requests | L4 | 当前线上文档，2026-10-21 | [Amazon S3 conditional requests](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-requests.html) |
| Dropbox cursor/continue 增量变化 | L4 | 当前线上文档，2026-10-21 | [Dropbox detecting changes](https://docs.dropboxapi.com/dropbox-api/docs/detecting-changes) |
| Automerge local-first CRDT | L4 | 当前线上文档，2026-10-21 | [Automerge docs](https://automerge.org/docs/hello/) |
| Yjs incremental updates/offline | L4 | 当前线上文档，2026-10-21 | [Yjs offline support](https://docs.yjs.dev/getting-started/allowing-offline-editing) |

---

<a id="dev-note"></a>
## Dev Note

本节是维护者的工作上下文，明确不具权威性。

- **当前 PoC 状态**：相关实现和进度文档属于 `research` 分支的研究材料。本报告引用它们作为当前 checkout 证据，不代表发布状态。
- **尚未验证的关键项**：OPFS/IndexedDB outbox、CDC chunking、生产对象存储、浏览器压力与容量上限、吞吐/耗时分布、Safari/WebKit、真实租户授权、跨存储 reconcile。
- **优先级判断**：durable local outbox 优先于 byte delta；chunk-level dedupe 优先于 VCDIFF；writer lease 优先于自动三方合并；生产身份/授权优先于多写者优化。
- **开放问题**：chunk 大小阈值、是否保留目录 mtime、是否允许 workspace 内 symlink、conflict copy 的产品文案、Session tool result 是否默认阻塞等待 cloud receipt。
