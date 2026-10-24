---
description: "评估 Browser-Native DSH 文件与持久化数据路径的规模风险，并规划大文件、分块传输和恢复验证。"
---

# Browser-Native DSH 文件规模与传输验证计划

## Summary

本计划优先验证 Browser-Native DSH 的文件数据路径能否超出当前小文件演示规模。现有 Chrome 容量样本最大为单文件 512 KiB、总量 1 MiB；Workspace backend 的单次二进制请求上限为 8 MiB；Worker VFS、durable snapshot、哈希和同步路径都可能整体保留或复制文件 bytes。正式产品若要承载 Agent 工作区、构建产物或用户导入文件，这些限制会直接决定文件是否可用、刷新能否恢复以及浏览器峰值内存是否可接受。

本批在 `research` 主工作区实施，不创建隔离 worktree，不修改正式 Agent Loop、Session 格式或通用 VFS package。PoC 将验证并实现可恢复的分块 Workspace 传输，同时如实量出同步内存 VFS 的剩余限制；成功传输不等于获得 OPFS-backed Node 文件系统或任意大小文件能力。

## 候选范围与选择

| 候选验证点 | 价值 | 证据缺口 | 本批选择 |
|---|---|---|---|
| 大文件 VFS、OPFS、哈希和 Workspace 同步的峰值资源与最大可用规模 | P0 | 现有最大单文件 512 KiB；当前上传 API 每个请求最多 8 MiB；同步代码存在整文件读写和复制 | 纳入，作为本批主问题 |
| 分块上传的断点恢复、重放幂等和 backend 重启 | P0 | 当前一个内容寻址 blob 由一次 PUT 上传；失败只可整 blob 重试 | 纳入，验证是否能安全突破单请求限制 |
| 大文件刷新 hydrate 与浏览器本地 OPFS durable 保存 | P0 | 当前下载使用 `arrayBuffer()`，本地恢复也将 blob 完整读入内存；大文件行为未验证 | 纳入，并保留 VFS 最终需要整文件 bytes 的事实 |
| 大量小文件的 manifest、快照和 commit 成本 | P1 | 现有容量样本最多 64 个小文件，commit 数随负载波动且原因未定位 | 纳入一个受限的 1,000 文件工作负载，作为文件数对照 |
| DSH Worker `node:fs` API 与真实持久化插件的语义兼容 | P0 | 有 shim 单测及少量工具 E2E，但缺少按默认持久化插件调用路径的完整矩阵 | 后续独立批次；避免把 API 兼容与传输规模混成一个验收结果 |
| Session、附件、KV、凭据和 spill 等默认持久化插件的 Browser provider 覆盖 | P0 | 兼容矩阵指出部分插件尚未逐项验证；目前 Session/LLM 已有专用远端 provider | 后续独立批次；先明确数据所有权和凭据安全模型 |
| 多实例 backend 的 CAS、writer lease 和 operation ledger 原子性 | P0 | PoC 只证明单进程、本地目录行为 | 后续独立批次；必须选定共享数据库/对象存储原语后才有决定性实验 |
| 跨设备 workspace 冲突、rename/delete/tombstone 与 dirty pull | P1 | 已验证本地 stale revision conflict，未验证两端长时间离线编辑和完整冲突解决 UI | 后续；先完成数据传输与资源模型 |
| 浏览器自然 eviction、移动端后台冻结及跨浏览器 quota 差异 | P1 | 已验证 Chrome 注入 quota、清除本地缓存和正常进程重启；自然 eviction 不可由已有脚本等价模拟 | 分平台研究，不用故障注入冒充自然行为 |
| 租户认证、恶意页面输入、Worker/主线程消息信任与云端授权 | P0 | 当前 PoC cookie 不是产品身份；尚未进行生产安全审计 | 产品化前必须专项验证，不作为本批传输协议的替代 |
| 后台 Agent 与页面退出后的运行接管 | 不适用 | Dedicated Worker 生命周期边界已明确，当前架构没有服务端 Job handoff | 只有产品需求要求离线执行时再启动独立 Cloud Agent 课题 |

评分依据是对正式架构决策的影响、当前证据不确定度、当前 PoC 的可重复性及能否形成明确的继续/停止结论。本批选择文件规模和分块恢复，因为源码中已有明确的 8 MiB 请求限制，而当前实测负载比该限制小一个数量级以上；“提升上传上限”若不同时测量 VFS 与本地持久化内存，会给读者造成问题已解决的假象。

## 代码考古结论

- `MemoryVfs` 是同步文件 API 的当前权威副本；文件节点持有完整 `Uint8Array`，普通 `readFileSync()` 返回其视图，修改路径会替换或重建完整 bytes。
- Workspace mirror 在文件 mutation、待提交 change、durable snapshot 和上传请求中管理完整文件内容；SHA-256 使用整块输入，OPFS 保存和 backend blob endpoint 当前也接受整块内容。
- `backend-v2.mjs` 对 Workspace 二进制 body 设有 8 MiB 上限。现有容量基线的最大单文件仅 512 KiB，不能推导出大文件容量。
- DSH `tool/call`、Session event JSON 和 Workspace blob 是不同的数据路径。通过 VFS test port 创建大文件，只证明 Worker VFS 与 Workspace mirror；不得描述为模型能够生成同样大小的文件内容，也不覆盖 Session append 请求上限。
- 分块上传能够限制单个 HTTP body 与传输临时 buffer，不会消除同步 `MemoryVfs` 对完整文件 bytes 的驻留，也不会自动解决大文件 tool-call 参数进入 Session 的 JSON 日志问题。

## 本批交付面

### 1. 当前规模基线与限制复现

先在实现修改前保存当前 checkout 的基线。使用真实 Chrome、现有 preview、真实 Dedicated Worker/DSH Host、PoC backend 和确定性字节模式，覆盖 1 MiB、4 MiB、8 MiB、16 MiB 单文件，以及 1,000 个小文件的独立场景。记录 VFS mutation、local durable、blob upload、manifest commit、刷新 hydrate 的结果、耗时和存储字节；对旧单请求 API 直接证明大于 8 MiB 的 body 被拒绝。脚本用 Worker 内生成的字节，不把大 payload 经由测试页面 postMessage 复制到 Worker。

浏览器内存读数使用当前 Chrome 可提供的 heap/backing-store 指标，并与 Worker/主进程观测范围分开记录。若本机无法可靠取得某一类峰值指标，记录原始观测能力和缺项，不用 V8 heap 代替进程 RSS，也不把单机数据设为产品 SLA。

### 2. 分块、可恢复的 Workspace blob 上传与下载

增加 PoC 专用 chunk API，块大小固定且有 server-side 最大值。每个上传由 workspace、既有 `operationId` 和完整 content hash 唯一标识；同一块相同 digest 的重复写入幂等，内容不同的重放必须冲突。客户端先查询已接收块，再只补传缺块；最终化阶段按序流式组装、验证完整 SHA-256 和 byte length，之后才登记可供 manifest commit 引用的 immutable blob。

服务端分块临时数据和状态必须落入 PoC `dataDir`，backend 重启后可查询并继续；完成后清理该上传的临时块。manifest 只能引用已完成且通过 hash 验证的 blob。下载按块读取和校验，再交给当前 VFS seed；这降低网络单次 body 和传输副本，不宣称 VFS 最终内存有界。

### 3. 本地 OPFS durable 和失败恢复

将 durable store 的 OPFS blob 写入拆为有界块，保留 IndexedDB metadata transaction 作为引用记录的发布点。任何 OPFS 写入或 IndexedDB 事务失败都不能清除已有 snapshot、宣称文件已 durable 或向远端提交未确认状态。恢复沿用原 `operationId` 和 hash，不创建重复 Workspace revision。对已有 store 保留兼容读取；若需要变更本地 schema，必须提升 PoC store version、拒绝降级，并覆盖前向版本保护。

### 4. 资源压力、故障矩阵和 DSH 文件语义边界

Chrome E2E 验证完整文件 hash/bytes、分块数量和 body 最大值、重复块、错误块、缺块、finalize 重试、指定块响应丢失、上传中 backend 重启、Worker 终止/刷新及完整文件重新 hydrate。同步跑现有真实 DSH `write` 的小型 scripted 闭环，证明 Workspace 文件操作仍经过真实 Agent Loop；大文件由 Worker 内 test port 产生，并明确不是 LLM 生成的 tool args。

将 `/api/browser-native/session/*` 当前 JSON body 上限与模型 tool-call args 的事件持久化关系列为单独限制。若大文件 Agent 调用在 Session 记录阶段先达到限制，本批记录确切失败点并提出附件/内容引用或流式文件工具方案，不把 Workspace chunk API 说成完整解决。

## 验收标准

- 变更前基线能复现现有单 blob API 的 8 MiB 限制，且 1 MiB 基线可完成刷新 hydrate。
- 新协议对 16 MiB 单文件完成真实 Chrome Worker 写入、OPFS durable、分块上传、manifest commit、页面刷新和逐字节 hash 校验；至少一个更大规模样本如机器资源允许也完成，失败样本需保留。
- 关闭并重启 backend 后，未完成 upload 的 status 与已落盘块可恢复；刷新后只上传缺块，finalize 和 manifest commit 不重复生效。
- 同块相同内容重放成功；同块不同内容、块 hash 错误、长度不符、缺块 finalize 和未完成 blob 的 manifest commit 被明确拒绝。
- OPFS/IndexedDB 本地故障不会把 dirty bytes 误报为 durable；本地 snapshot 与 backend manifest 的恢复语义保持现有 fail-closed 约束。
- 1,000 小文件工作负载报告 entry/commit 行为与资源变化；不因完成该样本而宣称产品级目录容量。
- 现有 DSH scripted 小文件工具闭环、durable workspace 恢复测试和 backend contract tests 通过。
- 报告明确 chunking 仍不能避免 MemoryVfs 保存整文件，也不能解决超大 tool-call/Session JSON 事件的传输上限；后续架构结论可落在 streaming VFS / OPFS-backed file API 或 attachment reference，而不是隐瞒剩余限制。
- 更新 progress、README、兼容矩阵、`change-ledger.md` 和 drafts 索引；Safari/WebKit 不运行，真实 LLM 不作为此协议正确性的必要条件。

## 实施顺序

1. 复跑小型 Workspace、backend 和 Chrome 基线；新增或运行旧协议 8 MiB 负向实验，保存变更前观测。
2. 先实现 backend 分块 staging/status/finalize 与单测，覆盖重启加载、幂等、冲突、缺块和 hash 校验。
3. 接入客户端稳定 upload id、缺块续传和分块下载；先跑适配器单测，再用真实 Chrome Worker 上传 16 MiB 并刷新读取。
4. 将本地 OPFS 写入改为有界块，加入中途故障、刷新恢复和既有 IndexedDB 版本保护回归。
5. 加入大文件、1,000 小文件和 chunk-loss/restart 的 Chrome E2E；复跑真实 DSH 小文件工具闭环。
6. 更新文档和索引，运行 focused tests、preview build、typecheck、docs gates；按 pre-push skill 执行相关检查，审查差异后 commit 并 push 到 `research`。

## 限制与非目标

- 不修改正式 `MemoryVfs` API、DSH Agent Loop、Session event type 或正式包依赖。
- 不把分块 Workspace blob 当作任意 OPFS-backed Node 文件系统、块级文件 delta 或 SaaS 生产存储。
- 不将 Worker test port 的文件生成描述为 LLM tool-call 内容生成；两者在 Session payload 和模型上下文成本上不同。
- 不把一次 Chrome 性能测量当作通用容量、内存 SLA、浏览器进程 crash 或自然 storage eviction 结论。
- 不实现多实例 backend、真实跨设备同步或生产租户认证；分块 staging 的 PoC 持久化仍依赖本地目录和单进程并发控制。
