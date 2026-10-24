---
description: "评估 Browser-Native DSH 下一批高价值验证方向，并规划 OPFS 文件后端与 backend 单写者恢复实验。"
---

# Browser-Native DSH 容量与进程安全验证计划

## 结论

当前 PoC 最值得攻关的两项基础风险是 Worker VFS 把整个可变文件集保留在 JavaScript heap，以及两个 backend 进程共用一个 JSON `dataDir` 时会接受冲突写入并静默丢失事实。前者限制 Browser-Native DSH 的本地工作集规模，后者使当前持久化服务的部署边界不够安全。

本批验证 opt-in 的 OPFS-backed VFS 文件驻留，以及同一 `dataDir` 的跨进程单写者保护和强制终止后的 operation 恢复。它不把 OPFS 变成完整 Node 文件系统，不提供 backend HA，也不改变普通 preview 或正式 Agent Loop。

## 候选范围与优先级

| 方向 | 优先级 | 本批决定 | 依据与价值 |
|---|---|---|---|
| Worker VFS 长期持有全部文件 bytes，缺少低常驻内存文件后端 | P0 | 选择 | 当前 `MemoryVfs` 的 `FileNode` 直接持有完整 `Uint8Array`；64 MiB 文件 E2E 仍不能说明多个已保存文件的驻留内存。OPFS `FileSystemSyncAccessHandle` 可在 Dedicated Worker 提供同步区间读，值得先验证与 Node-style VFS 的兼容性。 |
| 同一 backend `dataDir` 被两个 Node 进程打开 | P0 | 选择 | 上一批两个进程都接受相同 Session sequence、Workspace base revision 和 fencing token；冷启动只保留一方数据，属于已复现的数据丢失而非抽象 HA 风险。先拒绝第二写者，避免静默损坏。 |
| backend 在 Workspace commit 已落盘、HTTP receipt 未到客户端时被强制结束 | P0 | 选择 | 当前单进程 JSON store 有 operation receipt，但没有真实进程退出、重启、同 operation 重试的一体化证据。该实验验证现有幂等语义是否跨进程重建。 |
| OPFS 与 IndexedDB 的跨存储原子事务、dirty VFS mutation journal-first | P0 | 延后 | 浏览器没有两者之间的原子事务；当前 `VfsMutationSink.record()` 是同步 post-commit observer。需要另行设计写入 API 与确认语义，不能被“冷文件 backing”掩盖。 |
| 真实 SaaS 登录身份恢复匿名 Workspace | P0 | 延后 | 需要宿主 SaaS 的登录、撤销、租户切换和设备恢复合同；在 DSH PoC 中发明 bearer recovery token 会扩大权限面并给出误导性安全结论。 |
| 共享 SQL metadata、跨主机多 backend 与真正 HA | P1 | 延后 | 当前首先需要明确单进程 JSON backend 的安全限制；数据库 schema、事务、部署与故障域应作为独立后端迁移，而不是把 SQLite/WAL 的本机结果等同于云 HA。 |
| 大型 Agent tool args 的无损传输而非 1 MiB 拒绝上限 | P1 | 延后 | 当前 adapter 已在 Session JSON append 前拒绝超限；要支持更大内容需设计模型流、Session 事件和文件 blob 引用的共同语义，单调大 body limit 会重新触发 8 MiB 上限。 |
| Workspace manifest 大规模路径数、tombstone 累积、垃圾回收 | P1 | 延后 | 已有 1,000 小文件和分块传输样本，但未有长期 churn、rename/delete 风暴、GC 并发与恢复证明；需要先确定 manifest 索引和保留期限。 |
| 多设备并发编辑与 path-level merge | P1 | 延后 | 当前 CAS 能检测 stale revision，尚无用户决策、三方 merge 或冲突副本产品策略；不能用 last-write-wins 试验替代。 |
| Worker 关闭、刷新、浏览器身份丢失后的 dirty Workspace 恢复 | P1 | 保留为限制 | Chrome `SIGKILL` 实验显示 OPFS/IDB retry 存在但匿名身份 cookie 未恢复；身份恢复属于认证宿主能力，本批 backend 强杀测试保持浏览器与 cookie 不变。 |
| Browser Storage 自然 eviction、设备断电、OS 文件系统 crash | P1 | 不伪造 | 定向删除、quota 注入和 Chrome `SIGKILL` 已覆盖邻近协议，但 mock 无法等价证明浏览器或 OS 的自然故障语义。 |
| Safari/WebKit、移动浏览器、后台 Agent、全插件兼容 | P1 | 暂缓 | 当前推进优先 Chrome；这些平台/生命周期需要单独环境和支持矩阵，不应稀释本批可复现的高严重度风险。 |
| S3/GCS/Azure 权限、生命周期、多区域灾备 | P2 | 延后 | 本机 MinIO 仅验证 blob API；真实云权限、对象保留、灾备和跨区域一致性属于部署实现验收。 |
| Agent UI、CopilotKit 或 SaaS 业务联动 | P2 | 排除 | 不是 Browser-Native DSH 在浏览器环境运行与文件存储依赖的主要目标。 |

## 实施面

### A. OPFS-backed VFS 文件驻留

在 `MemoryVfs` 保留目录、inode、权限和路径语义，为已校验的完整文件增加可选只读 backing。backing 只提供同步 range read；文件被修改时先回到 VFS 内存，再由现有 durable Workspace 流程持久化并在确认后重新 externalize。默认构造仍是纯内存。

Browser Durable Workspace Store 在 Dedicated Worker 中用 OPFS `FileSystemSyncAccessHandle` 打开已验证的 content-addressed blob。远端 hydrate 和本地 retry 恢复后可 externalize；Worker 停止时关闭持有的 sync handles。读取完整文件仍会按 VFS API 需要分配完整结果，流式消费者可通过现有 descriptor range read 避免整文件复制。

对照相同 Chrome Worker workload 的 VFS logical bytes、resident bytes、range-read bytes、写入/读取结果、OPFS/Workspace hash 与 Worker 重建结果。记录初次下载和修改的峰值限制；只对已 externalize 的文件宣称常驻 heap 下降，不承诺流式 Agent tool args 或零拷贝。

### B. backend `dataDir` 单写者与进程恢复

backend 启动时先原子取得 `dataDir` 所有权，再加载 Session 与 Workspace state；活进程占用时第二实例必须 fail closed，不能监听端口或接受写请求。正常关闭释放锁；进程被强制结束后，重启只在确认锁 owner PID 已不存在且 owner record 完整时回收 stale lock。无法确认 owner 时保留锁并拒绝启动，避免猜测性清理。

用两个独立 Node PID 验证竞争；在 A 持锁时 B 启动失败，Session append 与 Workspace commit 只能由 A 接受。再强制结束 A，在同一 `dataDir` 启动 B，验证旧 Session durable state 和 Workspace revision 可读。另在 Workspace commit 已落盘但响应被丢弃的点结束 A，重启后查询/重试原 `operationId`，断言 revision 只前进一次且 receipt 相同。

这一锁只支持同一主机上的单 backend writer，不提供跨主机锁、HA、共享对象存储事务或 Session/Workspace 跨存储原子提交。stale lock 证明 owner PID 退出，不证明 OS/磁盘 crash durability。

## 顺序与退出条件

1. 记录 `research` 干净基线、复用上一批双 backend 丢写证据，并复现现有大文件 VFS 驻留语义。
2. 先实现 `MemoryVfs` read-only file backing 与 Node 单测，覆盖 range read、seed/stat、rename、hard link、truncate/write materialization、open descriptor 和 release。
3. 接入 Durable Workspace 的 OPFS sync handle，保持默认内存 VFS 行为不变；补 Worker lifecycle 清理与 OPFS 故障 fail-closed 测试。
4. 在真实 Chrome Worker 验证远端 hydrate、修改后提交、刷新重建、OPFS range read、已 externalize bytes 的 resident count，以及 handle 关闭。
5. 实现 backend `dataDir` 原子锁与跨进程拒绝；用独立 Node PID 验证 graceful close、SIGKILL stale recovery、同 operation 重试和 Session sequence 不丢失。
6. 更新 package README、PoC README、兼容矩阵、`docs/drafts/README.md` 和 `change-ledger.md`；执行相关单测、backend tests、Chrome E2E、build、typecheck 与文档门禁。

- 普通 `MemoryVfs` 与非 durable preview 行为不变；OPFS backing 只在独立 opt-in 验证入口启用。
- 外部 backing 的字节校验失败、同步读取失败、OPFS 不可用或 handle 冲突时保留内存副本或 fail closed，绝不静默返回空内容。
- Chrome E2E 证明 64 MiB 单文件 commit 后 `residentBytes` 明显低于 `logicalBytes`，Range read 与改写后的 hash 正确，刷新后可恢复；记录工作集和峰值，不宣称内存 SLA。
- 双 backend 场景下第二进程在监听前被拒绝；强杀后仅一个新进程接管；已提交但响应丢失的同一 operation 重试不增加第二次 revision。
- 若 OPFS 同步文件句柄与 VFS 当前同步语义无法兼容，停止该路径并记录最小 VFS capability 重构方案，不用内存 mirror 结果冒充 OPFS-backed VFS。

## 明确不在本批范围

本批不实施 SQL/Postgres backend、跨主机 HA、SaaS 登录身份恢复、真实 LLM 大型文件生成、tool args streaming、自然 storage eviction、OS/磁盘崩溃、Safari/WebKit、多设备 merge、blob GC 或生产云存储配置。

本批的 OPFS backing 是可丢弃的本地读取优化；backend manifest/blob 仍是已提交 Workspace 的权威副本，IndexedDB/OPFS dirty retry 的写入次序和 Session receipt reconciliation 仍由现有 PoC 流程负责。
