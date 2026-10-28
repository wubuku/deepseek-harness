---
description: "验证不可变块对象与文件版本能否消除 CDC 同步中的 staging 复制和整文件组装，并保持恢复、授权与 GC 语义。"
---

# Workspace 不可变块对象存储验证计划

## 决策问题

[上一批实际上传](content-upload-protocol-validation-progress.md)证明二进制 CDC 可降低上行，但 backend 仍完整读取来源、复制复用 bytes、反复校验 staging 并组装完整文件。Browser-Native 的目的包括减少服务器资源；只减少网络而增加磁盘成本不足以支撑正式产品。本批验证：保持 Worker、DSH Session、manifest CAS 和完整文件 SHA-256 的前提下，backend 能否直接引用不可变块生成文件版本，避免复用 bytes 再写一遍和整文件组装。

DSH-TUI 的启发在于能力先协商、状态须连续、恢复保留身份，而不是照搬宿主文件路径。本批不迁移 JS 堆，不改变 Agent Loop，不将块上传完成说成业务提交成功。仍在主工作区 `research`，不建隔离 worktree，Chrome 验收并包含真实 LLM smoke。

## 候选范围

| 候选 | 高价值原因 | 安排 |
|---|---|---|
| 不可变块与文件版本描述符 | 直接验证已测出的服务端写放大能否消除 | P0 |
| range/read 与全文件完整性 | 存储优化不能改变 Agent 看到的文件 bytes | P0 |
| pending 引用、共享块与 GC | 错误回收会让已确认上传在恢复后丢失 | P0 |
| complete/commit 响应丢失与重启 | 验证持久化顺序和原 operation 恢复 | P0 |
| 实际写入、hash 读取、对象数量与协议对照 | 不能用网络节省率替代服务器收益 | P0 |
| 旧文件 CDC 索引迁移 | 与存储格式过渡相关，但可明确保留 fallback | P1；只验证旧完整 blob 可读 |
| 结构化文本 chunker 替换 | 上批出现负收益，应独立语料和版本实验 | 后续，不更改 gear 算法迎合结果 |
| 多实例事务、S3 生命周期 | 需要额外生产原语；单进程不能证明 | 后续 |
| OPFS 配额、低端设备与离线长周期 | 影响客户端容量，已有不同失败语义 | 后续独立资源预算批次 |
| 跨设备 rename/delete 合并 | 需要产品冲突策略，不能混入存储优化 | 后续 |
| Browser/Cloud handoff、Session 大参数 | 是执行权和事实流问题 | 后续 |

## 四个交付面

1. **版本化存储。** 显式 backend 选项启用不可变 SHA-256 块和有序文件描述符。完整文件 hash/size 仍是 Workspace 文件身份；descriptor 必须连续覆盖文件，先确认块，再验证完整文件，最后原子发布版本。完整 blob 路径保留用于默认 fixed 和已有文件，不静默转换旧持久化格式。
2. **同步与读取。** CDC PUT 直接持久化块；reuse 只从当前 Workspace 授权文件的已验证布局引用同 length/hash 块，不提供全局块查询 API。status 校验 durable 块，complete 不写整文件 staging；range/read 保留字节与完整性语义，commit 仍验证文件 hash 和 CAS/fencing。
3. **引用生命周期与故障。** GC 在已有单进程 blob lifecycle 锁内读取文件版本和未过期 upload roots；pending operation 引用的块不能因来源文件删除而丢失。未知或损坏 metadata 阻止块 sweep，不能猜测不可达。覆盖缺块、损坏、重复块、重启、未发布/已发布文件版本和多个 Workspace 共享块。
4. **真实成本与交付。** 对同一确定性 16/64 MiB 输入比较完整 blob 和块对象模式，记录实际 PUT、协议 I/O、存储 bytes/对象数、校验读取与耗时；四阶段响应丢失后 Worker/backend 重启续传；另跑同源真实 LLM 文件闭环和刷新恢复。

## 验收矩阵

| 项目 | 判据 |
|---|---|
| 完整性 | 描述符、chunk hash/length、完整文件 hash/size 全部校验；错误不发布文件版本或 manifest |
| 写放大 | CDC 目标修改的复用 staging 写入为 0，assembled write 为 0；实际块数据新增写入只来自缺块，不用逻辑计数掩盖磁盘副本 |
| 读成本 | 保留全文件校验，不宣称零读或 O(修改大小)；计数与磁盘对象核对 |
| 范围读取 | 跨块、短尾、重复块、空文件、非法范围、损坏都得到确定结果 |
| pending GC | 来源删除与 GC 后，同一 operation 的已确认块仍可 complete；未上传的块仍 missing |
| 共享块 GC | 删除一个文件/Workspace 不删除其他有效版本或 pending 引用；最后一个 root 删除后才回收 |
| 恢复 | reuse/PUT/complete/commit 响应丢失，重启后 operationId/layout/hash 不变，revision 只增加一次 |
| 安全 | 未授权来源/读取不可通过猜测 chunk hash 绕过；固定协议、旧 blob、CAS/fencing 不退化 |
| 真实模型 | Chrome 中原 DSH Loop 经 backend 真实 LLM read/write/read、多轮和刷新可用；不以 scripted 代替 |

## 测量规则与停止条件

两个模式使用不同全新 dataDir；恢复仅重用各自 origin/dataDir。计数覆盖实际 chunk 数据写入和范围/校验读取，另统计落盘文件与总 bytes；metadata 开销单独列出，不把“组装写入 0”说成总写入 0。耗时不设未经校准的 CI SLA，CPU/模型/网络分别报告。保留现有算法和输入中的文本负结果，不默认启用本模式。

若不能证明 pending root 安全、完整性或无重复业务执行，则不发布可选模式；若写入收益被对象数/读取成本抵消，记录该结论，不为实验成功放宽持久化语义。本批不证明多实例、生产对象存储、自然 eviction、OS crash 或后台 Agent。

## Dev Note

本计划先于编码；实际版本、命令、失败和结果由[实施进度](chunk-object-storage-validation-progress.md)记录。
