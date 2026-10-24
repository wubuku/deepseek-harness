---
description: "规划 Browser-Native DSH 可写 chunk-backed 文件编辑、资源预算和恢复语义验证。"
---

# Browser-Native DSH 可写分块编辑验证计划

## Summary

本批验证 Browser-Native DSH 当前最重要的文件系统缺口：远端文件可以通过 OPFS range backing 低驻留读取，但 `edit` 写入仍会把完整文件 materialize 到 `MemoryVfs`。目标不是把文件传输分块再做一遍，而是验证“在浏览器 Worker 内对大文件做局部文本替换”是否可以使用有界临时文件、分块复制和原子发布，同时保留失败后源文件不变、结果可校验和后续 DSH 工具可继续的语义。

本批先实现 PoC 专用的可写 chunk-backed 编辑原型，并通过真实 Chrome Worker/OPFS 验证；同时保留当前真实 DSH `edit` 路径作为对照。若原型通过，只能证明文件存储层具备继续产品化的技术基础，不能宣称正式 `MemoryVfs`、Workspace mirror 或任意 Node 文件写入已经自动获得块级编辑能力。

## 候选范围

| 候选验证点 | 价值 | 当前缺口 | 决定 |
|---|---|---|---|
| 可写 OPFS chunk-backed 文件的局部替换 | P0 | 当前外置文件只读；`edit` 会完整 materialize | 纳入主交付 |
| 替换长度变化时的尾部搬移和文件截断 | P0 | 没有验证跨块、前移、后移和扩容的正确性 | 纳入主交付 |
| 临时文件、源文件和新内容 hash 的发布顺序 | P0 | 当前 PoC 没有可写临时 blob 的发布实验 | 纳入主交付 |
| 写入中断、校验失败和 Worker 终止后的恢复 | P0 | 现有故障矩阵覆盖 Workspace/metadata，不覆盖局部文件编辑 | 纳入主交付 |
| 当前 DSH `edit` 与分块原型的资源对照 | P0 | 已观察到 materialize，但没有统一 workload 和指标 | 纳入主交付 |
| 大文件真实 LLM 自动生成和自主编辑 | P1 | 上游超时和大 tool args 会混入模型变量 | 只保留普通真实 LLM 回归，不以此证明大文件能力 |
| 可写 backing 接入正式 `MemoryVfs` mutation sink | P0 | 需要新的 range mutation、durable journal 和 Workspace upload contract | 作为原型通过后的下一批，不在本批伪装完成 |
| Workspace commit 的 chunk streaming 与本地工作副本恢复 | P0 | 当前 `WorkspaceChange` 以完整 `content` 为中心 | 设计记录缺口，加入退出结论 |
| 多标签页同时编辑同一大文件 | P1 | 现有 writer lease 已验证，但没有块级 dirty merge 语义 | 延后到可写 backing 接入后 |
| CRDT、VCDIFF、rsync 或完整 Shell runtime | P2 | 与当前文件编辑资源问题不同 | 不纳入 |

## 本批交付面

### 1. 可写 chunk-backed 文件原型

实现一个 PoC-local 的 `ChunkBackedFile`，使用固定大小的 OPFS `FileSystemSyncAccessHandle` 或等价的内存 fake，提供有界 `read`、`write`、`truncate`、分块 hash 和关闭语义。局部替换算法必须支持替换内容比原文短、等长和更长，尾部搬移不能一次性读入完整文件。

原型使用独立临时文件执行 copy-on-write。源文件只读打开；替换失败、hash 不匹配或临时文件关闭失败时，源文件保持原内容，临时文件可被诊断和清理；成功时才发布新的内容 hash。原型不直接改变远端 manifest，避免把未定义的 Workspace mutation 语义误写成已完成。

### 2. 资源预算与现有 DSH 对照

使用相同的 64 MiB 多行文件和小替换，对比可写 chunk-backed 原型与当前真实 DSH `edit`。原型记录 chunk 大小、最大临时工作 bytes、读取/写入次数、源 hash、新 hash 和结果长度；真实 DSH 路径记录 Worker VFS 的 `logicalBytes`、`residentBytes`、Workspace revision、Session/tool receipt 和刷新后结果。

指标只作为当前 Chrome/本机样本，不作为产品 SLA。原型的资源预算应由算法保证为固定数量的 chunk 加替换参数，而不是由一次 heap 读数推断；当前 DSH `edit` 的完整 materialization 必须继续在文档中保留。

### 3. 故障和恢复矩阵

在临时文件写入、尾部搬移、替换块写入、truncate、hash 校验和发布前分别注入一次失败。每个失败点都必须证明源文件 hash 不变、临时文件不会被误当作已发布内容，下一次重试使用新的临时文件并得到唯一正确结果。另测 backend/页面刷新不会影响已发布源文件的可读性。

Worker 被终止只能证明浏览器 Worker 内临时编辑不会破坏已发布源文件；它不能证明 OS 级崩溃后的 OPFS 原子性，也不能替代 Workspace operationId、Session receipt 或云端 commit 恢复测试。

### 4. DSH 集成边界和下一步接口

记录将原型接入真实 DSH 需要的最小变化：VFS 需要表达 range mutation 或外部文件引用，Workspace mirror 需要从持久化 backing 分块计算 hash 和上传，IndexedDB snapshot 需要保存可恢复的工作副本引用，Session tool receipt 需要区分本地发布、云端提交和最终确认。若任一项仍依赖完整 `Uint8Array`，必须列为未解决的产品阻塞，而不是把原型通过写成正式能力。

## 验收矩阵

| 证据 | 通过条件 |
|---|---|
| 单元测试 | 内存 fake 覆盖跨 chunk 读取、UTF-8 marker 定位、缩短/等长/扩长替换、边界位置、空替换、非法范围和取消 |
| 真实 Chrome Worker/OPFS | 64 MiB 文件局部替换成功，结果 hash/bytes 与 Node 计算一致，最大工作 buffer 不超过固定 chunk 预算，页面无错误 |
| 真实 Chrome 故障注入 | 每个注入点源文件保持原 hash，重试成功且临时文件清理或明确列入 orphan；不能出现“成功”但 hash 未确认 |
| DSH 对照 | 真实 DSH `edit` 仍能完成普通文件工具闭环，并显示当前路径会 materialize；Workspace receipt 和 Session event 不重复 |
| 文档证据 | 明确区分原型、当前 DSH 路径、Workspace/Session 未接入项、Chrome 样本和未验证的 OS crash/自然 eviction |

## 实施顺序

1. 在本计划之后新增 PoC-local chunk editor、内存 fake 和单元测试。
2. 在 Worker 测试端口加入受限的 chunk-edit probe，只返回 hash、bytes、计数和故障结果，不把 64 MiB 内容复制到页面或 Session。
3. 运行真实 Chrome/OPFS 正常和故障矩阵，再运行现有 DSH 文件工具回归作为对照。
4. 根据结果更新进度、README、兼容矩阵、`change-ledger.md` 和 `docs/drafts/README.md`；明确原型是否值得接入正式 `MemoryVfs`。
5. 运行 focused tests、preview build、typecheck、文档门禁和 pre-push 检查；将实际结果提交到 `research` 并推送。

## 非目标

本批不修改 DSH Agent Loop、Session event schema、正式 Workspace commit 协议或引入第三方 VFS/Shell runtime；不把局部替换称为 byte-level cloud sync；不验证 Safari/WebKit、自然 storage eviction、OS/断电崩溃、生产对象存储、跨设备合并或真实 LLM 生成大型 tool arguments。
