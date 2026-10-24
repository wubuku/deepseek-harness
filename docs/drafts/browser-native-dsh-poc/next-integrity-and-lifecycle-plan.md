---
description: "规划 Browser-Native DSH 下一批高价值验证：冷启动文件流、OPFS 缓存回收、页面离开持久化屏障和跨状态恢复。"
---

# Browser-Native DSH 下一批完整性与生命周期验证计划

## 结论

当前 PoC 已证明 OPFS 可以承载已提交文件、IndexedDB 可以保留待重试状态、Workspace CAS 和 writer fencing 可以阻止部分并发损坏。但正式产品仍有四个直接影响可用性和数据安全的空白：冷启动缺少本地 blob 时仍可能把完整文件装入 JavaScript heap；异步保存失败会留下未登记的 OPFS blob；页面离开时没有向 Worker 请求本地持久化屏障；多种状态同时发生时，测试还没有证明本地 outbox、远端 manifest、Session receipt 和 lease 的恢复顺序。

本批以真实 Chrome、Dedicated Worker、OPFS、IndexedDB、同源 PoC backend 和 scripted DSH Loop 为主，优先验证 Browser-Native 运行时的文件系统依赖和生命周期语义。真实 LLM、Safari、自然 eviction 和 OS 级崩溃继续作为独立证据，不被 scripted 结果替代。

## 候选范围

| 候选验证面 | 价值 | 当前证据 | 本批决定 |
|---|---:|---|---|
| OPFS 冷启动 hydrate 的临时内存峰值 | P0 | 当前 `openBlob()` 用完整 `File.arrayBuffer()` 校验 hash；已验证稳定状态可 externalize，但没有证明首次加载不复制大文件 | 选择；改为分块读取和增量 SHA-256，并用真实 Chrome 冷缓存恢复验证 |
| metadata 写入失败后的 OPFS orphan blob | P0 | `save()` 先写 blob，再提交 IndexedDB metadata；事务失败会留下未被 metadata 引用的文件 | 选择；加入保守引用扫描和可观测回收，不在 metadata 缺失时静默清理 |
| `pagehide`/导航前的本地 durable barrier | P0 | 当前页面离开直接终止 Worker；刷新后的已落盘状态可恢复，但没有离开前屏障 | 选择；请求 Worker flush local snapshot，确认或超时后终止，不承诺后台 Agent |
| Session receipt、Workspace outbox、lease 同时恢复 | P0 | 各类 receipt、unknown、lease 和 retry 已分别验证，组合时序证据分散 | 选择；新增模型无关组合 E2E，证明不会重复副作用或伪造 receipt |
| OPFS/IndexedDB 跨存储原子事务 | P0 | 已知浏览器不提供跨存储原子提交 | 延后；先验证恢复合同，不伪造事务 |
| 大文件 VFS 写入的 heap 驻留 | P0 | `MemoryVfs` 写入仍 materialize 完整 bytes | 延后；需要独立的可写 chunk-backed VFS 设计，不能由只读 backing 结果外推 |
| Agent tool args 的 blob 引用传输 | P0 | 超过 PoC 1 MiB 上限会拒绝；Session/tool args 仍是 JSON | 延后；需要正式事件类型、模型流和工具参数共同设计 |
| Workspace manifest 长期 churn 与 tombstone GC | P1 | 单次 1,000 文件和 rename/delete 已测，未测长期版本保留和服务端 GC | 延后；先确定本地 orphan 与远端 blob 生命周期的所有权 |
| 多设备 stale manifest 的用户决策 | P1 | CAS 冲突保留本地 dirty，尚无 pull/merge/冲突副本产品动作 | 延后；需先定义 SaaS 的冲突交互和权限合同 |
| 浏览器自然 eviction 后的身份与重建 | P1 | 定向删除、quota 错误和 cookie 缺口已测，不能模拟自然 eviction 的选择性 | 保留为限制；不把删除注入写成平台等价证据 |
| Worker 被 suspend、冻结或移动端回收 | P1 | 有刷新、Worker terminate 和 lease expiry 证据，没有移动平台环境 | 延后；需要目标浏览器设备矩阵 |
| Web Locks/BroadcastChannel 多标签协调 | P1 | 当前 writer lease 由 backend fencing；未验证浏览器本地协调是否值得加入 | 延后；不能用本地锁替代服务端授权 |
| backend 共享 metadata store 与多实例 HA | P1 | 本机 `dataDir` 单写者已 fail-closed，跨主机仍不支持 | 延后；这是 backend 部署迁移，不是 Browser Worker 文件语义 |
| OPFS 孤儿文件、metadata 和恢复包的隐私边界 | P1 | corruption 导出已保留敏感数据提示 | 纳入本批回收报告；不新增自动上传或自动清除 |
| 真实 LLM 生成大文件工具参数 | P2 | scripted 工具参数上限已测，上游模型有超时噪声 | 延后；协议先稳定，再安排有界真实模型探针 |

## 选定交付面

### I1：冷启动分块 hydrate 与增量完整性校验

为 Browser Durable Workspace Store 增加分块 blob 写入和增量 SHA-256 校验。远端缺少本地缓存时，Workspace mirror 逐块下载到 OPFS，不先组装完整 `Uint8Array`；已写入 OPFS 的文件通过同步 range backing 注入 VFS。hash、文件大小和 chunk 顺序不匹配必须失败并保留可诊断状态。内存实现继续使用原有完整字节路径，不能把测试 fake 当作浏览器证据。

验收要求：真实 Chrome 冷缓存 8 MiB 以上文件时，网络每次只返回限定大小 chunk；刷新后 VFS `residentBytes` 不因 hydrate 增加完整文件大小；range read 内容正确；损坏 chunk 或最终 hash mismatch 不进入 `synced`。

### I2：OPFS orphan blob 引用扫描与保守回收

为 durable store 增加按 workspace 执行的 blob reconciliation。保留远端 manifest 引用和当前 IndexedDB snapshot 的 pending/retry 引用，只删除明确不再被这两类记录引用的 content-addressed 文件，并返回删除数量和字节数。若 IndexedDB metadata 缺失、版本过新或无法验证，不执行回收，继续 `local-corrupt` 和导出路径。回收不得改变远端 manifest、Session 或 outbox。

验收要求：注入 metadata transaction abort 形成 orphan blob；刷新后 orphan 被删除，仍被远端 manifest 引用的 blob 可 range read，仍被 pending/retry 引用的 blob 不被删除；metadata 缺失时所有 orphan 保留且页面仍 fail closed。

### I3：页面离开前的本地持久化屏障

在非 BFCache `pagehide` 中向 Browser Worker 发送一次 PoC-only lifecycle frame。Worker 等待 `flushLocalWorkspace()`，尽力释放 Workspace writer lease，并返回成功或失败 ack；页面收到 ack 或到达短超时后才终止 Worker。该屏障只确认本地 snapshot/blob，不等待模型、Session remote flush 或 Workspace cloud commit，不提供页面关闭后的后台 Agent。

验收要求：在一次 cloud commit 被阻断时触发 pagehide，Worker 返回本地 flush ack，刷新后原 `operationId` 和 outbox 仍可恢复并只提交一次；本地保存失败时返回失败 ack，不能显示已保存；BFCache `pagehide.persisted=true` 不触发终止。

### I4：Session/Workspace/lease 组合恢复矩阵

使用同一 scripted DSH `write` turn 组合以下状态：本地 snapshot 已确认但云端 commit 未知、云端 commit 已确认但 Session receipt append 未确认、writer lease 在恢复前已被另一标签接管。每种状态都从真实 Chrome Worker 重建，并分别读取 Session event、Workspace operation receipt、manifest revision、local outbox 和 fencing token。恢复只能查询/重放稳定 `operationId`，不能再次调用模型或重复业务副作用。

验收要求：每个组合有明确的 `completed`、`pending`、`unknown`、`conflict` 或 `lease-conflict` 状态；receipt 至多一条；manifest revision 至多前进一次；旧 fencing token 永远不能提交；同 Session 可以继续新 turn，且不自动重放未结算 tool call。

## 实施顺序

1. 先记录干净 `research` 基线，新增本计划和进度文件；复用已有 corruption、receipt、lease 和 OPFS residency 测试作为回归。
2. 实现 I1 的增量 SHA-256 和 OPFS chunk writer，先补单测，再接入冷缓存 hydrate 和损坏 chunk fault hook。
3. 实现 I2 的引用扫描与回收；将 metadata 缺失、版本过新和引用不完整作为禁止回收条件。
4. 实现 I3 的 Worker lifecycle ack 和页面超时终止；补充非 BFCache 与 BFCache 两条真实 Chrome 路径。
5. 编写 I4 组合恢复 E2E，保留 scripted LLM，记录每个状态的 Session、Workspace、outbox 和 lease 证据。
6. 更新 PoC README、兼容矩阵、目录索引、变更账本和本进度；运行 focused tests、preview build、Chrome E2E 和文档门禁。

## 明确不在本批范围

本批不实现跨 OPFS/IndexedDB 原子事务、可写 chunk-backed MemoryVfs、CRDT、后台 Agent、自然 eviction、OS/断电崩溃、Safari/WebKit、跨主机 HA、真实云对象存储、多设备自动 merge 或真实 LLM 大参数工具流。任何未实际运行的浏览器、模型和故障环境都必须在进度中标记为未验证。

## 退出条件

- I1 的冷缓存分块 hydrate、hash/size/chunk 错误和 range backing 有真实 Chrome 证据；不再把完整临时读取写成当前事实。
- I2 能删除已确认无引用的 orphan blob，并在 metadata 不可信时保守停止；远端和 pending 数据不被误删。
- I3 的 pagehide ack、超时和 BFCache 语义有真实 Chrome 证据；文档明确不提供后台 Agent。
- I4 每种组合恢复状态都有独立证据，未重复 Session/tool/model/Workspace 副作用。
- README、兼容矩阵、进度、change ledger 和 `docs/drafts/README.md` 反映实际状态；所有未覆盖平台和生产边界仍明确列出。
