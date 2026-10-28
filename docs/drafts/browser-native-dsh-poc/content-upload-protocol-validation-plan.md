---
description: "规划内容定义分块从 Chrome 字节估算进入真实 Workspace 上传、恢复和授权协议的验证。"
---

# Workspace 内容分块上传协议验证计划

## 目标与依据

上一批证明 CDC 在合成移位编辑中可以减少估算上行，但没有执行上传。本批验证这些收益经过真实 HTTP、持久化 staging、完整 blob 校验和 manifest CAS 后是否仍然成立，以及新协议能否安全恢复。研究依据见[CDC 实测](content-defined-chunking-validation-progress.md)与[DSH-TUI 启发](../dsh-tui-reference-architecture-memo.md)。能力支持必须显式协商；断线恢复保留原 Workspace、operationId、文件 hash 和 Session，不重放业务副作用。

本批在主工作区 `research` 实施，不创建 worktree；仅修改 docs-owned PoC。DSH Agent Loop、Session 格式、默认固定分块协议与模型凭据路径保持原有语义。Chrome 为验收目标，Safari 暂停。

## 候选范围与取舍

| 候选 | 决策价值 | 本批安排 |
|---|---|---|
| CDC 真正进入 Worker/HTTP 上传 | 消除估算与可运行协议之间的证据缺口 | P0 |
| 服务端读取、hash、staging 写入和请求数 | 判断上行减少是否只是把成本转给服务器 | P0 |
| 丢响应、部分上传、Worker/backend 重启续传 | 判断新分块身份是否能支持可靠恢复 | P0 |
| 来源授权、布局验证、完整文件 hash、CAS | 防止跨身份取数据、布局投毒和错误发布 | P0 |
| 显式版本与算法参数协商 | 拒绝旧 backend 或变更的 operation 计划 | P0 |
| immutable chunk manifest 与对象 GC | 可能消除整文件组装，但改变权威存储和读取模型 | 下一独立批次，不冒充本批实现 |
| 跨文件/跨租户全局去重 | 有安全和授权代价，收益尚不足以扩大范围 | 不启用 |
| 结构化文本分块分布优化 | 当前 gear 分布偏大，需要独立语料和算法对照 | 保留当前算法，记录缺点 |
| 低端设备 CPU/峰值内存 | 决定正式产品的资源预算 | 本机成本测量不外推低端设备 |
| 多实例 backend、对象存储 | 验证生产事务原语和共享租约 | 不用单机模拟结果冒充生产验证 |
| Session 大参数、附件引用和恢复分页 | 与 Workspace 上传的事实源不同 | 留待独立主题 |
| Browser/Cloud owner handoff | 页面关闭后继续执行的前提 | 不混入文件上传协议 |

## 四个交付面

1. **服务端协议。** 增加显式 opt-in 的有界内容分块布局与算法版本；布局按稳定 operationId、完整 hash/size 和 Workspace 绑定。复用只能来自调用者当前 manifest 授权的文件；所有新块、复用范围和完整文件均由 backend 校验。保留完整 blob 存储和现有 manifest CAS。
2. **Worker 接入。** 实际 uploader 使用同一确定性 chunker，传完整布局，查询缺块，仅上传缺失内容；默认路径继续固定分块。没有能力协商、旧 backend、不一致布局不得静默降级。恢复依赖现有 OPFS/IndexedDB outbox，不能重新生成业务 operation。
3. **故障和安全矩阵。** 覆盖布局有 gap/overlap/超限、错误 hash、相同 operation 改计划、未完成上传、staging 损坏、来源未授权、来源 GC、stale CAS、fencing、响应丢失和重启。无法恢复的缺失来源或索引必须明确报错，不能伪造成功。
4. **成本与真实运行。** Chrome Worker/OPFS 执行插入、删除、等长修改的实际上传，记录 request bytes、块数、来源读取、staging 复制和最终校验；另跑标准文件工具真实 LLM smoke，验证默认协议和 DSH Session 语义没有退化。

## 测量与验收

| 项目 | 方法与判据 |
|---|---|
| 数据 | 确定性合成文本/二进制，至少 16 MiB 移位编辑与 64 MiB 有界大文件；不读取用户文件 |
| 基线 | 既有固定偏移上传，区分实际 HTTP 上行与此前算法估算 |
| 收益 | 至少两个移位场景实际上传减少 50% 以上；所有最终文件 hash/size 与本地目标一致 |
| 请求和元数据 | 记录完整布局大小、缺块 PUT 数、协议 POST/GET 数，不把 upload bytes 当全部网络流量 |
| 服务端 | 记录来源验证、范围读取、复制及完整组装；上行节约不等于总 I/O 节约 |
| 恢复 | 丢失一个真实已处理响应后 terminate Worker，重启同 dataDir backend，刷新续传；Workspace revision 只提交一次，operationId 不变 |
| 授权 | 跨身份来源被拒绝；stale revision 与旧 writer 不得发布 manifest |
| 回归 | 现有 backend/Workspace 单测、固定分块恢复回归、Chrome 真实 LLM 文件工具及刷新记忆 smoke |
| 文档 | README、目录索引、ledger 与进度只记录实际执行结果；文档与相关类型检查通过 |

## 顺序与停止条件

先冻结协议字段与失败语义，再实施 backend 和客户端，之后执行单测、Chrome 成本/恢复和真实 LLM smoke，最后审查、归档、提交、推送。若收益不足、不能保持授权/幂等/完整性或恢复身份，停止发布 opt-in 能力并记录失败证据，不把通过算法测试视为协议成功。

## 限制

本批依旧是单进程本地 backend；不提供 chunk 对象存储、多实例一致性、自然 eviction 或 OS crash 的证明。内容分块布局不是通用 Shell、完整 Node 文件系统或后台 Agent；Dedicated Worker 仍受页面生命周期约束。算法成本测量与真实 LLM 验证分开报告。

## Dev Note

这是本批实施前的规划；实际结果、命令和限制见[实施进度](content-upload-protocol-validation-progress.md)。
