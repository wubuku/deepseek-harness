---
description: "规划 Browser-Native DSH 在真实工具执行期间的 Stop、OPFS copy-on-write 中断、Worker 销毁和 Session/Workspace 恢复验证。"
---

# Browser-Native 工具取消与编辑中断验证计划

## 目标

验证真实 DSH Agent Loop 在 Dedicated Worker 执行文件工具时，用户 Stop 能否沿 `AbortSignal` 到达搜索和 OPFS copy-on-write 编辑；确认成功中断与 Worker 意外终止分别按 `aborted` 和 `unknown` 结算，且都不伪造文件成功、Workspace commit 或 Session receipt。

本批承接 DSH-TUI 参考备忘的取消纪律：取消回执要表达已确认、未知或失败；销毁要等待执行与资源释放。这里验证 Browser PoC 当前 DSH Session/Worker 语义，不引入 TUI 的 API，也不把 `Worker.terminate()` 当作协作取消。

## 候选范围

| 验证点 | 价值 | 决定 | 理由 |
|---|---:|---|---|
| 真实 UI Stop 中断 DSH `grep` 工具 | P0 | 纳入 | 当前只有 Worker helper 直接取消和 LLM stream Stop；没有验证用户 Stop 到真实 `tools/execute` 信号的端到端路径。 |
| 真实 UI Stop 中断 OPFS chunk-backed `edit` | P0 | 纳入 | 编辑通过临时文件执行 copy-on-write；必须确认取消发生在 VFS 发布前，源文件不变且无远端提交。 |
| Worker 在编辑暂存阶段意外终止 | P0 | 纳入 | 页面/Worker 故障不能返回伪成功；刷新须将未结算工具标记 unknown，删除孤立临时文件且不重放调用。 |
| 中断后同一 Session 继续工作 | P0 | 纳入 | 证明 `aborted`/`unknown` 的历史可读，新的用户输入能够继续，且旧工具没有第二次执行。 |
| 大型 Worker 工具期间页面交互响应 | P1 | 纳入观察 | 记录 Stop 点击至 turn 收束的耗时及页面帧间隔；这是体验观测值，不设成通用性能 SLA。 |
| Worker Node builtin 与实际插件依赖图 | P1 | 延后 | 兼容矩阵仍缺逐插件 module/builtin 执行证据；适合作为独立运行时兼容批次。 |
| 持久化退化后不刷新即恢复工具 | P1 | 延后 | 当前 publication 在 Worker 生命周期内锁存降级；恢复前必须解决 volatile mutation 的对账和丢弃语义。 |
| 共享 metadata store 下多 backend 并发与 fencing | P1 | 延后 | 当前 backend 不使用生产数据库；需要额外后端实现，不应与 Worker 取消混为一批。 |
| 自然 eviction、Safari/WebKit 与生产云对象存储 | P1 | 延后 | 自然 eviction 不可稳定调度；Safari 已暂停，生产服务也不在当前 PoC 范围。 |
| Cloud Worker 接管浏览器未完成工具 | P2 | 延后 | 需要正式执行者身份、handoff 与副作用接管协议；本批只验证浏览器本地中断。 |

## 验证设计

### 1. 真实工具 Stop

- 以真实 Chrome、Dedicated Worker、DSH Host、同源 Session/LLM backend 和持久 Workspace 运行。
- 用 scripted LLM 固定 `grep` 与 `edit` 工具调用；测试 seam 只用于确定性放慢 chunk yield 和观察编辑阶段，不代替 Agent Loop 或工具执行。
- 通过官方 UI Stop 按钮取消活动工具，读取完整 Session 事件并检查 `turn/end`、原 `callId` 的 `tool/result`、Workspace revision、operation receipt 和源文件 hash。
- 中断后在同一页面/Session 发起新 prompt，确认 Worker 和工具仍可用。

### 2. 编辑中 Worker 终止与恢复

- 在 OPFS 临时 edit 文件已经创建且 copy-on-write 尚未发布到 VFS 时，通过仅供测试的 Worker seam 终止 Worker。
- 重新加载同一 Session，让 backend 与 IndexedDB/OPFS 恢复流程运行。
- 检查原工具只出现一次、未结算调用按 unknown 结算、源文件仍是原内容、没有新 Workspace revision/receipt，且遗留的 PoC edit staging 目录被清理。
- 在恢复后的同一 Session 执行新读写，验证执行者可继续工作；不自动重放旧工具或 prompt。

### 3. 性能和恢复观察

- 记录真实 Chrome 版本、源文件 bytes、chunk size、从 Stop 点击至 turn 终态的时间、页面最大 frame gap 和 Worker 是否继续可用。
- 性能数据只描述所用设备与样本，不形成 Browser/正式产品 SLA。
- 真实 LLM 只做普通文件工具 smoke，不负责触发取消或 Worker 故障。

## 验收矩阵

| 场景 | 必须观察到 | 不代表 |
|---|---|---|
| Stop 发生在 `grep` 活动期 | 同一个 turn 以 `aborted` 收束；无后续模型请求；新 turn 能成功 | 仅凭 helper 收到 abort 就算 DSH 取消通过。 |
| Stop 发生在 edit copy-on-write 期间 | 原 `callId` 不报告成功；源内容/hash 不变；无 Workspace commit/receipt；临时文件被释放 | 已发布 mutation 可以回滚，或 Stop 会撤销之前已提交的其他工具副作用。 |
| Worker 在 edit staging 期间终止 | 页面刷新后原工具按 `TOOL_OUTCOME_UNKNOWN` 结算且不重放；源文件不变；孤立 staging 被清理 | Worker 终止等价于确认取消或所有浏览器进程崩溃都已覆盖。 |
| 中断后继续同一 Session | 新 prompt 只执行一次，读取原文件/写入新文件按正常 durable 路径完成 | Session 与 Workspace 形成原子事务。 |
| 页面与 Stop 响应 | 记录真实 frame gap 和 Stop-to-terminal 延迟，检查无页面错误/跨源请求 | 单次 Chrome 采样构成性能 SLA 或 Safari 证据。 |

## 实施顺序

1. 核对 DSH `turn/cancel`、`ToolDispatchExecution.signal`、Browser 文件工具和 OPFS staging 的时序；为真实 edit 加最小、query-gated 的测试观察/延迟 seam。
2. 先实现 Stop during grep/edit 的真实 Chrome E2E，失败时修复 PoC adapter 或明确记录 DSH 现有语义限制。
3. 加 Worker 终止、Session unknown settlement、孤立 edit staging 清理与同 Session continuation E2E。
4. 跑能力/文件工具单测、backend tests、Web TypeScript、preview build、全部新增 Chrome E2E、既有 lifecycle/file-tool 回归及真实 LLM 普通工具 smoke。
5. 更新 README、兼容矩阵、`docs/drafts/README.md` 和 change ledger；记录真实性能观测、失败和未验证项。

## 非目标

本批不改正式 DSH packages、Agent Loop 或 Session format，不实现后台 Agent、Cloud Worker handoff、生产多实例 backend、自然 storage eviction 或 Safari/WebKit 验收；不把 Worker crash 记作 confirmed cancel，也不把未持久化 mutation 记作成功。
