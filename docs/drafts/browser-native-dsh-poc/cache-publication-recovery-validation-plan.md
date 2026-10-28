---
description: "验证 Worker 强制终止后 OPFS 下载缓存的安全恢复、跨 Worker 互斥及本地待提交内容保护。"
---

# Workspace 缓存发布恢复计划

## 决策问题与候选

[下载流验证](verified-stream-download-validation-progress.md)消除了重复读取，但异常清理依赖 JavaScript catch/finally。Worker 在创建 canonical OPFS 文件后被强制终止，可能留下空文件；下一次启动把它判为损坏并停止。正式产品需要识别可重新下载的缓存与不可删除的本地待提交内容。DSH-TUI 的启发是明确状态和资源所有权，浏览器恢复必须依靠持久化证据，不能依赖主机进程继续运行。

| 候选 | 价值与当前证据 | 本批安排 |
|---|---|---|
| 下载发布的中断恢复 | 已存在创建文件与 close 之间的崩溃窗口，直接阻断刷新恢复 | P0 |
| 跨 Worker 本地写入互斥 | backend writer lease 不会终止旧 Worker 的下载；必须保护共享 OPFS | P0 |
| cache 与 dirty/retry 数据隔离 | 自动清理若误删唯一的本地副本，会破坏持久化承诺 | P0 |
| 确定性强杀与真实模型闭环 | finally 执行的网络错误不能代证 Worker 终止恢复 | P0 |
| 低内存设备与超大文件编辑 | 产品价值高；本批只保持有界流，不扩展内存矩阵 | 后续 |
| 旧 full-blob/CDC 数据在线迁移 | 需要格式与回滚边界，独立验证 | 后续 |
| 多实例 backend/对象存储 | 需要跨进程提交和 pin，不以浏览器锁替代 | 后续 |
| 长期离线冲突与跨设备合并 | 需要产品冲突策略，CAS 不等于合并 | 后续 |
| Browser/Cloud 执行交接 | 执行者身份和副作用结算仍是独立课题 | 后续 |
| WASI 工具与插件兼容性 | 保留 VFS/命令/WASI/Shell 分层，不引入完整 Linux | 后续 |

## 四个交付面

1. 持久化发布意图：使用独立版本化 IndexedDB journal，先提交意图，再创建此前不存在的 canonical OPFS 文件。记录 Workspace、完整 hash、长度和 attempt 身份；完整校验并 close 后才删除意图。不改变 Session 格式或已有 Workspace snapshot 版本。
2. 跨 Worker 互斥：同 Workspace 本地存储操作使用 Web Locks 串行化；锁在强制终止后由浏览器释放。网络可占用本地锁，但不占 backend 全局锁。没有所需锁能力时显式失败，不静默退化为 instance queue。锁内比较最后成功 load/save 的 metadata，拒绝旧实例覆盖新 snapshot；引用 blob 须在 metadata 提交前验证仍存在且 hash/大小正确；失败释放锁前必须收束全部写入。
3. 启动核对：在打开缓存与解码 pending 之前读取 journal 和 metadata。完整文件复用；有合法意图、无 dirty/retry 引用的残留可删除后重下；没有意图的损坏文件、未知 journal 版本、metadata 丢失和受保护文件均拒绝自动删除。不能把缺少证明解释为“只是缓存”。
4. 实际验证：真实 Chrome Dedicated Worker、OPFS、IndexedDB 在意图提交、文件创建、首块写入、close 后清意图前四个确定性切点强杀；刷新/新 Worker 恢复；竞争下载、dirty/retry 保护和负对照。另跑同源代理真实 LLM read/write/read、记忆和刷新，保留命令及脱敏工件。

## 验收矩阵

| 场景 | 必须观察到的结果 |
|---|---|
| journal 写入失败 | canonical 文件尚未创建，无下载副作用 |
| 四个切点强杀 | 跳过 finally 后新 Worker 可恢复；正确内容 hash 与 manifest 一致 |
| close 已完成但意图未清 | 复用完整文件，不重传已验证内容 |
| 两 Worker 竞争同一缓存 | 至多一个发布者；持锁者终止后等待者继续，不覆盖完整文件 |
| 旧 snapshot 在新 pending 后提交 | 本地 CAS 拒绝旧 save，保留新 pending/receipt；不以远端 revision 代替本地状态 |
| 外部 blob 写入与 metadata 之间发生 GC | save 拒绝缺失引用，不宣称 durable；保留原 metadata |
| 批量编码中一项失败 | 所有在途写入结束前不能释放锁，后继 Worker 不与迟到写入交错 |
| 只剩 journal 的身份恢复 | identity 前仍识别原 Workspace；cookie 缺失或不匹配时拒绝创建新身份 |
| pending/retry 引用残留 | 拒绝删除并保留原 bytes 与 metadata |
| 未登记损坏文件/未知意图 | 明确报错，禁止猜测清理和静默降级 |
| 正常下载错误 | 释放锁；意图与残留能在下一次启动核对 |
| 真实模型 | backend 读取私有 env；Session 与 Workspace 持久化、刷新继续；无重复 prompt 或额外模型循环 |

本批验证 Worker.terminate，不能外推为自然 eviction、OS crash、电源故障或绝对磁盘耐久性。旧版未登记的损坏缓存仍需明确恢复决策。模型凭据只在 backend；本地 journal 不存对话、密钥或文件内容。命令、结果和限制见[进度](cache-publication-recovery-validation-progress.md)。

## Dev Note

本计划先于编码。若完整文件验证、互斥或 dirty 保护无法同时成立，则不启用自动修复，也不以清除整个浏览器存储使测试通过。
