---
description: "规划 Browser-Native DSH Workspace 元数据完整性、远端 blob 生命周期和安全回收验证。"
---

# Browser-Native DSH 持久化元数据与 blob 生命周期验证计划

## Summary

本批继续围绕 Browser-Native DSH 的文件系统依赖，但不再重复 Worker 刷新、OPFS 缓存清除、CAS、租约和分块传输。新的重点是两个容易在正式产品中造成不可逆损坏的问题：服务端 Workspace 元数据被截断或篡改后是否会安全拒绝启动，以及内容寻址 blob 在多次写入、删除和未完成上传后是否会无限增长或被错误删除。

本批以当前 PoC 的单进程 Workspace backend、文件 blob store 和已经验证过的 S3-compatible adapter 为实验对象。它不把本地 JSON store、MinIO 或测试故障注入写成生产数据库、云对象存储或跨主机高可用证明。

## 候选范围与取舍

| 候选验证点 | 优先级 | 本批决定 | 原因 |
|---|---:|---|---|
| Workspace/identity JSON 截断、未知字段、非法 UUID 和 owner 引用 | P0 | 纳入 | 冷启动是 metadata 进入可写状态的信任入口；忽略坏记录会把不完整 workspace 报告为可用。 |
| Manifest path tree、父目录、entry hash/bytes 与 operation receipt 一致性 | P0 | 纳入 | 不一致索引会让文件操作、CAS 回执和重试读取指向不同状态。 |
| 已引用 blob 的存在性、size 和 hash 冷启动扫描 | P0 | 部分纳入，完整扫描延后 | metadata 校验确保引用格式合法；扫描所有大对象会将每次启动变成完整云存储 I/O，并可能把短暂对象存储 outage 变成服务不可用。当前只在 commit/read 路径验证对象，不宣称启动完成物理完整性核验。 |
| Manifest 引用扫描、跨 Workspace shared hash 与不可达 blob 回收 | P0 | 纳入 | 替换/删除会产生不可达对象；共享内容必须在任一 Workspace 仍引用时保留，否则会破坏另一用户恢复。 |
| Pending upload 时间戳、TTL、unknown commit 和 operation replay | P0 | 纳入 | 提交结果未知时，当前 manifest 与 retry 所需 pending blob 必须可区分；过期不能抹掉已提交状态。 |
| 分块 upload staging 过期、损坏 metadata、缺失 metadata 和中断恢复 | P0 | 纳入 | 清理器不能把时间不明或记录不可解析的 staging 当作安全垃圾；本批验证只按可验证的服务端更新时间删除。 |
| 上传、commit、blob read、GC 在单 backend 内的并发顺序 | P0 | 纳入 | 引用快照与对象删除之间的并发会造成误删；本批用单进程锁串行化并明确性能未测。 |
| 文件 store 与 S3-compatible list/delete 和缺失语义 | P1 | 纳入 | 本地文件 store 测试不能覆盖 PoC 已存在的 S3 adapter；MinIO 可给出可复现的协议对照。 |
| GC 失败部分完成、删除重放和 metadata 持久化失败 | P1 | 部分纳入，完整故障矩阵延后 | 删除允许幂等重放，但部分分页/权限失败和 metadata 写失败的运维恢复需要单独故障注入；本批不把返回错误描述为原子回滚。 |
| S3 bucket versioning、delete marker、Object Lock、生命周期规则和 IAM | P1 | 延后 | 当前 MinIO 无法证明生产账号策略、历史版本回收、保留合规或多个 bucket policy 的行为。 |
| 多实例共享 metadata store、跨主机 GC fencing 和对象 list 一致性 | P1 | 延后 | 本 backend 只提供 dataDir 单写者锁；共享 S3 并不自动提供 metadata 事务或 GC fencing。 |
| Metadata 备份、恢复、索引重建和灾备 RPO/RTO | P1 | 延后 | PoC 的本地 JSON 文件与对象 store 没有备份/恢复协调器；GC 前生产系统必须有可验证的恢复策略。 |
| Operation receipt 保留期限、ledger compaction 与重复请求安全 | P1 | 部分纳入，保留策略延后 | 本批确认 GC 不删除 receipt；如何压缩 receipt 而不破坏长期幂等重试需要单独定义请求有效期。 |
| Session log 与 Workspace commit 的跨存储故障矩阵 | P1 | 延后 | 这是 Agent tool side effect reconciliation 问题，不由 blob GC 单独解决；需单独覆盖 Session flush 与 remote commit 的独立 unknown 状态。 |
| OPFS cache budget、自然 eviction 与远端重建成本 | P1 | 延后 | 需要真实 Chrome quota/eviction 和下载成本测量；本批聚焦 backend authoritative blobs。 |
| Attachments、spill、credentials 与其他默认持久化插件 | P1 | 单独立项 | 它们有不同的敏感级别、owner 和清除规则，不应通过 Workspace GC 扫描或回收。 |
| 多设备 merge、自动冲突副本、tombstone 历史和历史版本 GC | P1 | 延后 | 当前 manifest 是单版本 CAS；没有历史版本 policy 前不能将旧快照内容视为普通 orphan。 |

## 交付面

### 1. 持久化 Workspace 元数据的 fail-closed 加载

为 cold load 增加严格校验：Workspace id、owner、revision、manifest path、entry kind、mode、file hash/bytes、父目录、operation receipt、pending upload hash 和 writer epoch 必须符合当前协议。旧版本缺少可选的 pending upload timestamp 时保守保留上传引用；未知或不一致的字段不应被静默转换为可用状态。

损坏文件必须在 backend 监听端口前拒绝加载，并释放 dataDir lock。测试修复或移走损坏文件后可以重新启动；测试不得把“跳过坏 workspace”当作恢复成功。

### 2. 远端 blob 的引用保留和回收

为 blob store 增加列举和删除能力，并让 WorkspaceStore 在单 backend 的全局 blob-lifecycle lock 与 workspace lock 内执行显式 GC。所有当前 manifest 引用和仍在保留期限内的 pending upload 引用必须保留；没有受保护引用的完成 blob 可立即回收，pending upload 的 TTL 决定其保护期限。有效但过期的分块 staging 可删除；缺失、损坏或无法识别的 staging metadata 必须保留并计数。GC 返回扫描、保留、删除、字节数和过期上传统计，不改变 manifest revision，也不删除 Session 或 operation receipt。

commit 成功后，已经进入当前 manifest 的 hash 不再作为“待提交上传”永久保留。旧版本替换或删除产生的不可达 hash 会在之后的显式 GC 中成为删除候选；同一 operation 的 replay 只返回已保存 receipt，不依赖重新读取旧 blob。

### 3. 断点上传、unknown commit 和重启顺序

测试覆盖完整 blob upload 但尚未 commit、commit 响应丢失、backend 重启、原 operation replay 和 GC 的顺序。续传读取与 staging 清理使用相同的完整 schema 和目录身份校验；坏 staging 不作为可续传状态使用，也不会被清理。GC 不得删除仍可用于安全重试的 pending hash；staging 清理只删除 metadata 可验证且明确超过保留期限的目录。时间戳缺失、metadata 损坏或目录身份无法确认时保留并计数。

### 4. 文件 store 与 S3-compatible store 对照

文件 store 和 S3-compatible store 都实现相同的列举、删除和缺失语义。MinIO 只作为可复现的对象接口对照；它不能证明 AWS、GCS、Azure 的权限、生命周期规则、跨区域一致性或删除保护已经满足生产要求。

## 验收矩阵

| 场景 | 必须观察的结果 |
|---|---|
| 非法 manifest path/hash/bytes/operation | backend 在 listen 前 fail-closed，旧数据不被静默改写 |
| 有效 manifest、旧格式缺少 upload timestamps | 正常加载；未带时间的 pending upload 保守保留 |
| 当前文件、旧文件、未提交 blob 同时存在 | GC 只删除不可达且已过期对象；当前文件和 pending blob 可读 |
| delete/replace 后 GC | manifest revision 不变；旧 hash 删除；当前 hash 保留 |
| commit 响应丢失后 GC 与 operation replay | operation receipt 仍可查询；replay 不增加 revision，且不会因旧 blob 被误删而改变结果 |
| 分块上传未完成后 GC | staging 在保留期内不被删除；过期后只删除 staging，不删除其他 workspace blob |
| S3/MinIO list/delete | 结果与文件 store 一致；缺失、重复删除和服务不可用都显式报告 |

## 非目标与证据边界

本批不实现跨主机锁、SQL/Postgres、跨存储原子事务、自然 storage eviction、OS/磁盘 crash、真实云权限、blob 历史版本恢复、自动多设备 merge 或后台 Agent。GC 是单进程 WorkspaceStore 在现有 writer/dataDir 约束内的能力；生产系统仍需要共享 metadata transaction、租约 fencing、对象保留策略和独立灾备验收。

## 实施顺序

1. 记录干净基线，复跑 backend/Workspace focused tests，并核对当前 Workspace JSON 与 blob store 实际格式。
2. 实现 Workspace cold-load validator 和 pending upload timestamp 的兼容持久化。
3. 为文件与 S3 blob store 增加 list/delete；实现 workspace-lock 内的安全 GC 和统计结果。
4. 增加 backend contract、坏 metadata、未提交上传、替换/删除、unknown replay 和 MinIO 对照测试。
5. 更新 README、兼容矩阵、change ledger、进度和目录索引；运行 focused tests、preview build、Chrome 相关回归和文档门禁。

## Dev Note

本计划是当前 checkout 的 PoC 研究范围，不是正式 Workspace service 规范。任何不能证明引用关系的删除操作都必须保守失败或保留对象。
