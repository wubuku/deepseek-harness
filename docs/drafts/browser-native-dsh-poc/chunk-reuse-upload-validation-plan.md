---
description: "规划标准 DSH edit 的固定偏移分块复用、完整性、恢复与实际网络成本验证。"
---

# Browser-Native Workspace 分块复用上传验证计划

## 目标

上一批已证明 OPFS 外置文件可以经标准 DSH `edit` 使用有界 copy-on-write buffer，但修改 64 MiB 文件的一个等长 marker 仍上传完整 64 MiB。本批验证客户端能否只发送变化的 1 MiB 分块，同时保持完整文件 SHA-256、manifest CAS、稳定 operationId 和 Session receipt 语义。DSH-TUI 的可迁移原则是能力须以实际执行证据发布、恢复不得重放业务副作用；本批按这两项原则区分传输优化与文件提交事实。

## 候选评估

| 候选 | 价值与风险 | 本批决定 |
|---|---|---|
| 已提交文件的相同分块复用 | 消除小修改的整文件上行成本，直接影响浏览器计算下沉的可用性 | P0，纳入 |
| 非顺序分块、缺块、响应丢失与 backend 重启 | 优化不可破坏已有幂等续传或误报文件已提交 | P0，纳入 |
| 复用来源授权、损坏与最终 hash | 不能通过猜 hash 跨 Workspace 探测数据，不能信任客户端摘要 | P0，纳入 |
| 标准工具与真实模型闭环 | 独立上传 API 成功不等于真实 DSH edit 可用 | P0，纳入 |
| 插入/删除后的内容定义分块、rsync/VCDIFF | 可进一步减少移位场景流量，但需全新索引和算法取舍 | P1，仅测固定偏移局限，不实现 |
| OPFS/outbox 长期容量与垃圾回收 | 影响长期使用，已有单独 GC 验证仍不足以证明无限离线容量 | P1，后续独立压力批次 |
| 目录 rename/delete 与 tombstone 跨设备历史 | 决定多设备合并产品语义，不应混入传输优化 | P1，后续单独设计 |
| 低内存设备、完整 edit I/O 与 UI 延迟 | 有助于产品预算；已有 CDP 样本不能代表所有设备 | P1，复用现有指标，不新增 SLA |
| 多实例 backend 与生产对象存储 | 需要事务和对象生命周期实现，不能用本机 backend 冒充 | P1，后续独立交付 |
| 插件准入、WASI 与 Shell | 是不同能力层，不能为传输优化扩大主机兼容声明 | 不纳入 |

## 交付与验收

### M1：受授权的固定偏移复用

增加 PoC upload reuse 请求：目标仍由 workspaceId、operationId、完整文件 hash 和 byte length 标识；客户端逐块计算目标 hash，提交同一 Workspace 当前 manifest 引用的 baseHash。服务端按相同偏移读来源、检查长度和分块 hash，将匹配 bytes 写入该 upload 的 staging。复用计划在写入前持久化，同一上传不得换计划；旧无计划上传仍可使用。来源不属于该 Workspace 当前 manifest 时拒绝，不能使用全局 blob 是否存在代替授权。

最终仍组装完整文件并校验整体 SHA-256，再允许 manifest CAS commit。复用成功、upload complete 和 Workspace commit 是三个不同状态；客户端不据前两者生成 tool 成功 receipt。服务端仍储存完整文件 blob，不引入 chunk manifest、对象级多重 CAS 或新 Agent Loop。

### M2：完整性与重启续传

覆盖非顺序写入和部分复用留下的空洞、重复 reuse、换计划、错误 chunk hash、来源缺失/损坏、损坏 staging 的重新上传、上传完成前后 backend 重启，以及最终文件 hash 不匹配。检查失败不增加 Workspace revision。复用后的 staging bytes 自包含，不依赖旧 blob 永久保留；显式 GC 后和 backend 重启后仍可完成目标上传。

### M3：标准 edit 的真实 Chrome 成本

复用现有 Chrome/Worker/OPFS/DSH Host 夹具，验证 64 MiB 等长 marker 编辑只上传一个 1 MiB 分块，最终 blob/hash、刷新恢复、单条 edit call 和 receipt 均保持正确。保留禁用复用的对照开关，证明断言能发现整文件上传。再测边界跨块修改和非等长修改：后者可能使后续所有固定块改变，应诚实记录退化。

### M4：真实 LLM、文档与交付

真实模型经同源 proxy 完成普通文件读写、多轮和刷新冒烟；不以 scripted 容量测试冒充模型自主大文件操作。运行 backend、Workspace 单测、preview build、Chrome 大文件与 unknown-commit 回归、相关类型检查和文档检查。更新 README、目录登记和 change ledger；在主 `research` 提交全部修改并推送，不清理共享缓存。

## 测量与限制

分别记录目标文件 bytes、客户端上行 chunk body bytes、复用分块数、客户端新增 hash 读取量及服务端来源读取/复制成本。固定偏移复用不是 byte delta、内容定义分块或块级存储；仍需客户端完整目标分块 hash、服务端 staging 及完整组装，且不能减少所有插入/删除流量。本机 PoC backend、Chrome 结果不证明生产多实例、自然 eviction、OS crash 或内存 SLA；Dedicated Worker 仍受页面生命周期约束。

## 执行记录

实际命令、失败、经验和未完成项由[实施进度](chunk-reuse-upload-validation-progress.md)记录。
