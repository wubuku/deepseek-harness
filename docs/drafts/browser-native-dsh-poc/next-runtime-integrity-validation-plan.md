---
description: "评估 Browser-Native DSH 的高价值运行时缺口，并规划写权续租、未知提交恢复、HITL 重连和本地数据库升级保护验证。"
---

# Browser-Native DSH 下一批运行时完整性验证计划

## Summary

已有 PoC 覆盖了 Worker 重建、OPFS/IndexedDB 故障、离线重试、CAS 冲突、Session receipt 和刷新时 lease resume。下一批不再重复这些短路径，而是检查四个仍可能影响真实使用的交叉时序：活动 Worker 长时间等待时的 Workspace 写权、服务端已提交但浏览器未收到确认后的 Agent 工具结果、页面刷新时等待中的人机问答，以及 IndexedDB schema 前向升级时本地恢复数据是否仍可导出。

本批仍以真实 Chrome、Dedicated Worker、DSH Host、同源 PoC backend 和 scripted Agent Loop 为主要证据。真实 LLM 只用于补充浏览器运行链路，不替代确定性故障注入。Safari/WebKit 暂停；不把浏览器存储清除、正常进程重启或 HTTP 故障注入表述为自然 eviction、OS crash 或生产 HA 证据。

## 候选范围与优先级

| 候选 | 价值 | 本批处理 | 判断依据 |
|---|---|---|---|
| 活动 Worker 的 Workspace lease 续租与租约丢失 | P0 | 纳入 | 当前 lease 仅在 commit 前续租；backend 返回 `renewAfterMs`，但客户端没有定时续租。长时间模型/人类等待可超过 lease TTL。 |
| Agent 文件工具的 commit 响应未知与 backend 重启 | P0 | 纳入 | 已有协议级 operation 查询及 Worker crash-window 测试，但未证明真实 DSH `write` 在 backend 已持久化 commit、响应丢失并重启后只结算一次。 |
| `ask_user_question` 等待中的页面刷新、迟到回答和 Session 重连 | P0 | 纳入 | 已有正常问答闭环和一般工具 crash recovery；尚未检查问题卡片重建是否与新 Worker 中的原等待者一致。 |
| IndexedDB 前向版本打开失败与恢复导出 | P1 | 纳入 | store 固定以版本 1 打开；较新 schema 不应被降级覆盖，用户也需要知道旧 PoC 是否能读取或导出其旧记录。 |
| OPFS orphan blob 回收与清理崩溃 | P1 | 暂缓 | 需要先定义 metadata 引用图、GC 标记/扫除协议和并发写保护；直接添加清理逻辑有静默删除 dirty bytes 的风险。 |
| 大文件写入、哈希和同步的峰值内存/主线程响应 | P1 | 后续独立批次 | 当前 VFS、Worker 消息和 SHA-256 路径会复制或整体读取内容；需要可重复的规模基线及 chunked VFS/协议设计，不能混成恢复语义测试。 |
| 自然 storage eviction、跨设备离线与存储配额变化 | P1 | 暂缓 | Playwright 注入不等同自然浏览器 eviction；真实 eviction 需要平台策略、可重建云端基线和本地 dirty 数据的用户恢复实验。 |
| 多实例 backend 并发、跨进程 CAS 与租约 fencing | P1 | 暂缓 | 当前 PoC backend 以单进程内互斥和本地 `dataDir` 为模型；该实验需要定义生产数据库/对象存储原子原语，不能用第二个 Node 进程的表面测试替代。 |
| 更多主机插件与 Node builtin 的逐项兼容 | P2 | 暂缓 | 兼容矩阵已明确要求逐插件行为证据；扩大清单的成本高，优先验证目前已启用工具的端到端恢复语义。 |
| 页面关闭后的后台 Agent | 不纳入 | 明确非目标 | Dedicated Worker 受页面生命周期约束；后台执行需要显式服务端 job/handoff，不能由浏览器租约或 Worker timer 推导。 |

## 验证面

### 1. 活动 Worker lease 续租和失权

- 在真实 Chrome 中启用 `browser-native-workspace-lease=1`，通过短测试 TTL 验证 Worker 按 backend 返回的 `renewAfterMs` 持续续租。
- Worker 在恢复 Workspace manifest 与本地 snapshot 前 claim 写租约；claim 完成后立即启动 heartbeat，避免首次文件工具前租约已失效。较长的同步恢复仍必须在租约有效期内完成，否则应 fail closed。
- `prepare()` 在 claim 后因 manifest、blob 或本地 snapshot 读取失败时必须停止 heartbeat、清除本地 writer token，并拒绝后续 Workspace 操作；未显式 release 的服务端租约到期后应可被另一 writer 接管。
- 让真实 DSH `ask_user_question` 等待超过两个 TTL；在另一标签页请求 claim，必须仍被 backend 拒绝。回答后由同一 Agent turn 执行真实 `write`，检查写权、revision 和 Session receipt。
- 对一次续租注入短暂 503，检查客户端是否在租约到期前重试并恢复；持续失败或 backend 明确返回 ownership lost 时，旧 Worker 不得继续提交或清除本地 dirty/outbox。
- 终止 Worker 或冻结页面后不声称 lease 能后台保持；再次启动必须通过 backend fencing/resume 或新 claim 取得有效 token。

### 2. Agent 写入的未知 commit 结果与 backend 重启

- 由真实 DSH Agent Loop 调用 `write`；backend 先持久化 Workspace manifest 和 operation receipt，再由测试路由丢弃 commit 响应。
- 在 Worker 完成 operation lookup 前终止 Worker，并保留已 durable 的 IndexedDB retry batch 与 OPFS bytes；关闭并以相同 `dataDir` 重启 backend。
- 刷新并重开相同 Session，让新 Worker 使用原 `operationId` 查询或重放 commit；验证 backend 只增加一次 revision、文件 hash/内容一致、Session 只有一个 Workspace receipt，且不重放原 DSH tool call。
- 分别断言 Session 的 `tool/result`、`TOOL_OUTCOME_UNKNOWN`/后续恢复、Workspace operation receipt 和本地 outbox；不得把 HTTP 请求次数等同业务副作用次数。

### 3. 等待中的 HITL 与页面重连

- 真实 DSH `ask_user_question` 显示问题后刷新页面或终止 Worker，再从同一 Session 重连。
- 检查持久化 `tool/call`、工具结果、turn 结束状态、`userQuestions` projection 和重建后的问题卡片；确认 UI 不会把已失效 Promise 描绘成仍由旧 Worker 等待。
- 若 DSH 提供可持久化的 pending-question/inbox 语义，验证刷新后的答案只结算匹配的 call；迟到的旧页面答案不得结算新 Worker 中不匹配的 call，也不得造成重复业务操作。
- 若当前 DSH 行为不支持跨 Worker 恢复 blocking question，不提交伪装成原审批答案的响应；保留 interrupted/unknown 状态，并验证用户可在同一 Session 显式发送新消息继续，而不会重跑旧工具调用。

### 4. IndexedDB 前向版本与本地恢复数据

- 在真实 Chrome 中先建立包含有效 Workspace metadata 的 `dsh-browser-native-workspace-v1` 数据库，再将 schema 版本提升到 2 并保留原记录、增加未知字段/对象仓库。
- 启动当前 PoC，验证 v1 store 不会请求降级、清除数据库或覆盖较新记录；状态需将“较新 schema 不受支持”与随机损坏区分。
- 使用页面本地恢复导出路径检查 v2 数据库是否可被打开并保留原始 v1 Workspace metadata 和可读 OPFS bytes；如无法导出，记录为明确数据恢复缺口并修复 PoC exporter。
- 关闭数据库连接后重开，并检查 version、记录、OPFS 文件 hash 未变化；不尝试自动迁移未知 schema。

## 批次退出条件

- 四个验证面均有可复跑脚本或明确记录为实现缺口；新增行为只改 Browser-Native PoC 适配层，正式 Agent Loop、Session format 和默认 profile 保持不变。
- lease 测试证明活动长等待时实际续租，并证明租约失效后旧 writer 被 fencing；页面冻结/关闭仍明确不提供后台 Agent。
- 初始化失败测试证明 Workspace manifest 返回 503 后旧 Worker 不再续租，租约自然到期后另一请求才能 claim；页面显示启动错误，不把失败状态报告为可用 Workspace。
- 未知 commit 场景证明同一 Agent `write` 在服务端提交、响应丢失、Worker 终止及 backend 重启后不会重复 commit；Session receipt 和 operation receipt 可关联。
- 本计划的 HITL 刷新验收针对默认 Browser profile 的 legacy schema：刷新后 Worker Promise 不可恢复，问题卡不再可回答；用户可显式发起新 turn，旧工具调用不重跑。它不验证 timed schema 的 inbox/continued question，后续证据见[timed HITL 生命周期计划](timed-hitl-lifecycle-validation-plan.md)。
- 前向版本测试证明本地数据库不被降级或静默删除，并验证当前恢复导出路径；未知数据格式不自动迁移。
- 每个 E2E 使用隔离 profile、临时 dataDir 和动态端口；结束时等待 Chrome、页面、backend、测试路由和构建资源退出。
- 更新本计划的进度文件、PoC README、兼容矩阵、`change-ledger.md` 与 `docs/drafts/README.md`；记录 Chrome、命令、结果、已知限制和未运行的检查。

## 实施顺序

1. 先加入 lease heartbeat 的 Worker 单测和真实 Chrome 长等待 E2E，再验证短暂网络失败与 stale fencing。
2. 加入真实 DSH `write` 的 commit-ack 丢失、Worker 终止、backend 同目录重启和 receipt 对账 E2E；仅在暴露协议缺陷时修复适配层。
3. 加入问答等待中的刷新/迟到回答 E2E；若暴露 DSH 当前恢复语义缺口，优先提供诚实的 interrupted 状态而非续造等待者。
4. 加入 IndexedDB v2 fixture 与恢复导出 E2E；若要修改 `apps/web` 页面恢复导出逻辑，先在 `change-ledger.md` 登记其必要性与重放方式。
5. 串行构建 preview，运行四面 E2E、相关单测/backend tests、文档门禁；复查完整差异后提交并推送 `research`。

## 证据边界

本批使用 scripted LLM 验证工具与恢复协议；它不证明模型选择质量。短 TTL 是测试参数，不构成生产租约 SLA。backend 使用同进程锁和本地目录，不代表多实例云服务原子性。Playwright 的 page reload、route abort 和 Worker terminate 不模拟操作系统崩溃或自然存储驱逐。Safari/WebKit 按当前工作要求不运行。
