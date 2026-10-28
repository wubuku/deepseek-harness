---
description: "规划多个 Browser-Native DSH Session 共享 Workspace 时的只读观察、过期快照拒绝和写权接管验证。"
---

# Browser-Native DSH 多 Session Workspace 观察验证计划

## Summary

当前 PoC 已验证同一 Session 的只读事件观察，以及同一 Workspace 的单 writer lease；它没有验证同一浏览器身份下的多个独立 DSH Session 是否能安全共享一个 Workspace。现有实现遇到 `WORKSPACE_ALREADY_OWNED` 时会阻止第二个 Worker Host 启动。本批验证并实现一个受限观察模式：第二个 Session 可读取已提交 Workspace 快照，不能修改文件；快照 revision 变化后必须停止读取，用户刷新并重新取得写权后才恢复完整文件工具。

本批延续 `dsh-TUI` 的“多个观察者、一个写入 owner”原则，但不复用其 Channel 协议。DSH Session 继续分别记录每个 Agent 的输入和工具结果，Workspace revision 与 writer fencing 仍由 backend 决定；只读观察者不获得 Workspace lease，也不写入 Workspace receipt。

## 候选范围与取舍

| 候选验证点 | 价值 | 决定 | 理由 |
|---|---:|---|---|
| 两个独立 Session 使用同一浏览器身份和 Workspace | P0 | 纳入 | 多标签/多对话是常见使用方式；当前只测同一 Session observer 或同一 Session Worker handoff。 |
| lease 冲突时继续启动只读 Worker | P0 | 纳入 | 当前第二个 Worker 因 Workspace lease 冲突整体无法使用；需要验证能否保留聊天和已提交文件读取。 |
| 只读模式的模型工具 schema 与执行 guard | P0 | 纳入 | 隐藏 `write`/`edit` 不够；必须同时隐藏可改文件的 `bash` 并拒绝伪造或迟到调用。 |
| observer 的 Workspace revision 变旧 | P0 | 纳入 | 旧 VFS 会给模型提供过期文件；每次 observer 文件工具执行前必须校验远端 revision，并在变更后 fail closed。 |
| observer 刷新后获得 writer lease | P0 | 纳入 | 明确从只读视图到可写 Host 的用户动作和服务端 fencing，避免后台自动抢占写权。 |
| Workspace 共享本地 OPFS/IndexedDB 时的未提交数据隔离 | P0 | 纳入 | 活跃 writer 可能正在保存 dirty snapshot；observer 不能把未提交缓存当成云端事实，也不能执行 GC 改动其数据。 |
| 多 writer 并发编辑与自动合并 | P1 | 暂缓 | backend 当前明确采用单 writer/CAS；协同编辑需要独立的冲突 UI、路径级版本和合并策略。 |
| BroadcastChannel 或推送式 revision 通知 | P1 | 暂缓 | 通知只能作提示，仍需权威 revision 查询；先测每次工具调用的 GET 校验成本和正确性。 |
| 跨设备、不同浏览器 profile 的 Workspace 观察 | P1 | 暂缓 | 当前 PoC identity cookie 与生产账号/租户授权无关，不能据此验证跨设备授权。 |
| 不同 principal 争用同一 Workspace ID | P1 | 不纳入 | PoC backend 的 Workspace 身份映射不是产品授权模型；需先确定正式身份和租户边界。 |
| 多 backend 实例与分布式 lease | P1 | 不纳入 | 需要共享数据库事务/CAS 原语；本批只验证已知的单 backend PoC。 |
| 自然 storage eviction、Chrome 进程强杀和 OS/磁盘崩溃 | P1 | 不纳入 | 本批的核心是并行 Session 读写权限；此前进度已明确这些需要独立故障域和平台实验。 |
| OPFS 外置大文件读取延迟与 Worker heap | P1 | 后续候选 | 已有 16/64 MiB 传输与 range backing 证据，但首次 hash 峰值内存仍未完整量化。 |
| 全部默认插件的 Browser 兼容性 | P1 | 后续候选 | 需要逐插件 workload 和能力证据，不能由共享 Workspace observer 实验推断。 |
| 真实供应商断流与 `ERR_ABORTED` 归因 | P1 | 后续候选 | 最近 smoke 观察到 abort 回调但所有完整模型响应均为 200；需先定义可重复的 provider 级故障分类。 |

## 设计与安全约束

- 仅当初次 writer claim 明确返回 `WORKSPACE_ALREADY_OWNED` 时，Worker 可降级为 observer；身份失败、存储损坏、网络未知、CAS 冲突和已有 writer lease 丢失仍 fail closed。
- Observer 从 backend 当前 manifest 构建 VFS。它不得恢复 IndexedDB 中的 pending/retry changes，不得运行 abandoned-edit 清理或改变本地 snapshot，也不得申请、续租或释放 Workspace writer lease。
- Observer 的 Browser-Native 模型工具只包含 `read`、`grep`、`glob` 和不修改文件的会话工具；`write`、`edit` 与可能修改 VFS 的 `bash` 不得进入 LLM schema，工具 guard 也必须拒绝伪造调用。
- Observer 在每次文件读取工具执行前检查 backend manifest revision。revision 与已加载值不同时，当前调用返回明确 stale 错误、页面状态转为 stale、撤销 Workspace 文件工具；不得继续从旧 VFS 返回结果。
- stale 或 read-only 页面不自动升级写权。用户显式刷新后，Worker 重新读取 manifest 并 claim lease；旧 owner token 必须继续被 backend fencing 拒绝。
- 多个 Session 的 event log 分开。只有实际执行 Workspace mutation 的 Session 可以得到对应 Workspace receipt；observer 的 read/stale 工具调用不得制造 Workspace commit 或 receipt。
- 本功能只约束当前 Browser-Native profile 发布的 DSH 工具；不宣称 `MemoryVfs` 是全局只读文件系统，也不建立生产授权或协同编辑协议。

## 交付面与验收

### M0：现状复现与基线

- 使用两个真实 Chrome 页面、同一 BrowserContext 与同一 identity cookie，各自启动不同 Session。
- 由第一个 Session 取得 Workspace lease；确认第二个 Worker 当前进入 `lease-conflict`，没有模型请求，保留此结果作为变更前基线。
- 记录两个 Session ID、Workspace ID、初始 revision、HTTP 状态、工具 schema 和页面状态；输出不得包含凭据或文件正文。

### M1：只读 observer 启动和能力投影

- 后端 claim 返回 `WORKSPACE_ALREADY_OWNED` 时，第二个 Worker 继续从已提交 manifest 构建只读 snapshot。
- 检查第二个 Session 可发消息并完成 DSH `read`；LLM schema 包含 `read`/`grep`/`glob`，不含 `write`/`edit`/`bash`。
- 让 scripted upstream 在只读 schema 中不含 `write` 时仍返回伪造的 `write` tool call，确认 Worker capability dispatch guard 将其记录为错误结果，且 Workspace revision、OPFS dirty snapshot 和 receipt 不变。
- 预置本地未提交 retry batch，确认 observer 只读云端 manifest，不恢复这批内容，不清理或覆盖其本地记录。

### M2：revision 变化后的 stale fail-closed

- 第一个 Session 提交新文件并提升 Workspace revision；observer 下一次文件读取必须先查 manifest。
- revision 改变时，observer 的这次读取返回结构化 stale 错误，不返回旧 VFS 内容；页面状态显示 stale，后续 LLM schema 不再含 Workspace 文件工具。
- 核对 stale 过程中没有 Workspace commit、没有 Session 间 receipt 串写、没有原 prompt 重放。
- 测量每次 observer 文件工具增加的 revision 检查请求数和本机延迟，作为 PoC 开销，不作为 SLA。

### M3：显式刷新与写权接管

- observer 页面提供明确刷新/重试动作，不在后台自动抢占 writer。
- 原 writer 关闭或释放/租约到期后，用户显式刷新 observer 页面；新 Worker 重新 hydrate 最新 revision 并取得更高 fencing token。
- 新 writer 完成一项文件 mutation；旧 token 的 renew/commit 仍为 409；Workspace revision 只增加一次，receipt 只写入执行该 mutation 的 Session。
- 两个 Session 分别可读回自己的历史；observer 的 Session 不获得原 Session owner token 或 Workspace receipt。

### M4：真实模型冒烟与交付回归

- 使用真实 Chrome 和同源 backend LLM proxy 单独跑普通 `read → write → read`、Session/Workspace 刷新恢复 smoke；不要求真实模型自主选择 observer/owner 流程。
- 使用 scripted Chrome E2E 和两个独立 Session 精确控制 lease、revision、工具 schema、stale 调用和交接时序；scripted 结果不能替代真实 LLM smoke。
- 运行 Workspace/capability focused tests、backend tests、preview build、typecheck、文档门禁和推送前检查。
- 更新 README、兼容矩阵、change ledger、drafts 索引和进度记录；未实测的跨设备、分布式 backend 与自然 eviction 保持未验证。

## 实施顺序

1. 先添加双页面 scripted E2E 的当前行为断言，复现第二个 Worker 被整体阻塞；同时检查工具 registry 和 Workspace hydration 中所有本地写路径。
2. 增加显式 `read-only` Workspace 状态，只对明确 writer-conflict 启用；独立测试 dirty snapshot 隔离和错误不降级。
3. 增加动态只读工具发布、执行 guard 和每次读取前的 revision 检查；先以 focused tests 验证 schema 与 stale 行为。
4. 扩展同一 Chrome E2E 覆盖 stale、刷新接管、旧 fencing、两个 Session 事件与 Workspace receipt 对账。
5. 运行真实 LLM 冒烟、相关 E2E、构建、文档门禁和 `change-scope`；审查所有差异后提交并推送 `research`。

## 限制

Observer 每次读取都请求当前 manifest revision；该策略优先保证 stale read 可见，不代表生产级低延迟或推送订阅。BrowserContext 内共享 OPFS/IndexedDB 时，只读 VFS 从远端已提交 manifest 重建；本批不验证跨设备共享、本地跨标签通知或用户账号切换。Workspace writer lease 仍是整个 Workspace 的单写者限制，不能并发编辑或合并冲突。
