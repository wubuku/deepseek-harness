---
description: "规划 Browser-Native Workspace 固定偏移复用与内容定义分块的成本、收益及协议准入验证。"
---

# Browser-Native Workspace 内容定义分块验证计划

## 目标

验证内容定义分块（CDC）能否解决固定偏移复用在插入、删除后的边界漂移问题，同时量出浏览器 chunking/hash 成本、块数和服务端 staging 工作量。结果用于决定是否值得改造现有上传协议，不预设 CDC 一定进入 PoC 默认路径。

本批继续在主工作区 `research` 分支实施，不创建隔离 worktree，不修改正式 DSH package、Agent Loop 或 Session 格式。Chrome 是浏览器验收目标，Safari 暂停。实验实现只用于验证；除非成本与安全验收同时通过，不改变当前固定偏移上传协议。

## 候选范围与选择

| 候选 | 产品决策价值 | 本批处理 |
|---|---|---|
| CDC 对插入、删除和等长局部编辑的块复用收益 | 判断当前固定偏移复用是否有实质场景缺口 | P0：选为主问题 |
| 平均块大小对流量、hash 次数、manifest/upload 元数据和请求数的影响 | 判断收益是否以不可接受的块数量换来 | P0：与 CDC 一并测量 |
| Worker 内 chunking/hash CPU 与内存工作集 | 决定客户端计算下沉是否仍满足交互要求 | P0：真实 Chrome Dedicated Worker 测量，不设通用 SLA |
| 服务端扫描、校验、复制和 staging 文件操作 | 判断 CDC 能否适配当前单 blob 后端和未来对象存储 | P0：基于协议源码核算操作数量；不冒充生产后端基准 |
| 多文件跨文件去重 | 可能节约重复资产流量，但会改变授权和租户隔离模型 | P1：本批不启用跨路径复用，单独记录 |
| chunk-level immutable object store、GC 与跨 Workspace 引用 | 可降低重复存储，但需要独立对象生命周期和隔离设计 | P1：不改变当前完整 blob 存储 |
| 可变块协议的 outbox、部分写恢复及版本协商 | 决定新旧 Worker/backend 部署和恢复兼容性 | P1：本批只形成明确准入条件，不发布新协议 |
| 滑动窗口、rsync/VCDIFF patch 和压缩 | 可能降低特殊工作负载流量，也增加 CPU 和攻击面 | 暂缓；先判断 CDC 是否值得进入协议原型 |
| OPFS 本地分块索引和 GC、自然 eviction、OS crash | 影响长期容量和恢复，不由上传分块算法解决 | 保留为独立验证主题 |
| Session 大型 tool args 和附件引用 | 与 Workspace blob 不是同一持久化数据路径 | 不混入本批 |
| 多实例 backend、对象存储及跨设备写权 | 需要真实共享事务/租约原语 | 不用本机 PoC 冒充验证 |

评分按架构决策影响、当前证据缺口、可重复性以及能否形成继续/停止结论排序。当前最直接的问题是固定偏移复用已将等长 64 MiB edit 的上行降至 1 MiB，但其上传成功依赖完整源校验、逐偏移比较和复制 63 MiB staging；本批需要判断移位编辑是否足以证明 CDC 的复杂度值得承担。

## 实验工作负载

工作负载由固定种子生成，不读用户文件、仓库内容、真实 Session 或凭据。至少覆盖：

| 文件内容 | 编辑操作 | 目的 |
|---|---|---|
| 结构化源码/文本记录 | 4 KiB 等长替换，位于头部、中部、尾部 | 对照当前已验证的编辑类型，并观察边界局部影响 |
| 结构化源码/文本记录 | 64 KiB 插入或删除，位于头部、中部、尾部 | 触发固定偏移后续边界漂移 |
| 确定性伪随机二进制 | 64 KiB 插入或删除，位于头部和中部 | 避免只对重复文本模式得出结论 |
| 确定性重复/模板数据 | 局部替换及插入 | 观察重复内容对 chunk 身份和元数据的影响 |

样本大小覆盖 16 MiB 与不超过 PoC 64 MiB 上限的文件。每类核心场景至少重复三次；报告中保留原始样本，不将单机耗时转写成产品 SLA。

## 测量卡

| 项目 | 定义 |
|---|---|
| 用户操作 | 已提交文件经标准文件内容修改后，将新 immutable blob 同步到 Workspace backend |
| 基线 | 当前 1 MiB 固定偏移块；仅当目标块与同一来源偏移的 SHA-256 相同时复用 |
| 候选 | 有明确 min/average/max 参数的确定性 gear-based CDC；CDC 块只按完整 chunk hash 与来源 chunk 匹配 |
| 入口 | 真实 Chrome Dedicated Worker 执行同一 chunker 模块；使用固定生成的 bytes；不经过 DSH Agent Loop 或模型 |
| 时钟 | 分别记录 chunk boundary scan、每块 SHA-256、完整准备阶段；样本构造和浏览器启动不计入算法时钟 |
| 流量 | 目标文件总字节、实际必须上传字节、节省字节、块数、chunk descriptor JSON 字节 |
| 服务端工作量 | 依据当前实现记录来源完整校验、来源扫描/比较、staging 写入次数与组装完整 blob 的语义；没有实现的 CDC server 不提供虚构时延 |
| 内存 | 记录输入/输出 buffer、最大 chunk、descriptor 数量和显式临时 buffer；不以 JS heap 推断 Chrome 进程 RSS |
| 恢复语义 | 本批不修改 upload protocol；沿用现有固定偏移 E2E 作为恢复回归，不把算法 probe 宣称为上传恢复通过 |
| 负对照 | 原始固定偏移算法必须重现插入/删除后的大量 changed bytes；相同输入和 hash 校验对两种分块策略一致 |

算法 probe 至少包含 boundary determinism、最小/最大块约束、完整覆盖无 gap/overlap、首尾编辑、多字节和 0-byte 输入策略、取消检查点及 chunk hash 唯一性测试。哈希碰撞只用于索引筛选，正式实现仍需验证字节或以受信服务端完整内容校验作为提交条件。

## 决策门槛

只有同时满足以下条件，下一批才进入服务端和 Worker 上传协议原型：

1. 在源码/文本与伪随机二进制两类文件中，头部及中部 64 KiB 插入/删除至少三分之二场景比固定偏移少上传 50% 以上；
2. 等长局部替换的上传量不得在任一内容类的中位数上比固定偏移增加超过 2 倍；
3. 至少一种参数配置将 64 MiB 文件的 descriptor 数量限制在 512 以内，descriptor JSON 不超过 256 KiB；
4. 记录 Chrome Worker boundary scan 与 chunk hash 的独立成本，并确认其成本不被遗漏或伪装成网络收益；
5. 明确下一版协议如何固定 chunker/version/参数、授权来源、幂等上传计划、缺块状态、并发 writer fencing、stale CAS、取消和旧版 backend 拒绝行为。

如果收益只出现在移位编辑、descriptor 数量或浏览器准备成本不满足条件，结论为保留固定偏移路径，不实现 CDC 协议。即便达到准入门槛，本批也只授权下一阶段协议原型，不构成产品采用决定。

## 实施顺序

1. 记录当前 `research` HEAD、干净状态、运行时版本和既有固定偏移实测基线。
2. 在 PoC 目录新增确定性 chunker 原型及其单测；不改默认 uploader、backend API 或正式 package。
3. 新增真实 Chrome Dedicated Worker 实验，生成 workload 并对比固定偏移/CDC 的上行估算、chunk 数、hash 次数和 elapsed time。
4. 对照 `browser-native-workspace.ts` 和 `workspace-v2.mjs` 核算服务端完整 blob、授权、staging、重启恢复和 CAS 语义；不得将协议缺失的服务端操作计为已实现。
5. 执行单测、Chrome probe、现有固定偏移恢复回归、真实 LLM 普通文件 smoke、文档检查；记录实际通过、失败、环境限制和明确决策。
6. 更新 PoC README、目录索引和 `change-ledger.md`；审查后提交并推送 `research`。

## 非目标与限制

- 不把 CDC 算法 probe 描述成实际 blob 同步、块级对象存储或 DSH Agent Loop 验证。
- 不实现 VCDIFF、rsync patch、压缩、跨文件全局 dedup、CDC manifest、服务端块对象库或 chunk GC。
- 不改变 Workspace manifest、Session 格式、默认 DSH 文件工具、模型凭据流向或持久化事实来源。
- 本机 Chrome、固定数据和单进程 backend 不证明低端设备性能、生产对象存储、多实例一致性、自然 eviction 或 OS 级崩溃恢复。
- Worker 计算仍受页面生命周期约束；CDC 不提供后台 Agent。

## Dev Note

这是验证计划，不是已批准的协议设计。实测结论和是否达到准入门槛只写入[实施进度](content-defined-chunking-validation-progress.md)。
