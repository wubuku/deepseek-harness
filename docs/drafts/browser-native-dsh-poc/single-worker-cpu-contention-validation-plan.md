---
description: "规划在单个 Browser-Native DSH Worker 中验证同步 CPU 工具阻塞、协作式让出、跨 Session 延迟与取消响应。"
---

# 单 Worker CPU 阻塞与协作式让出验证计划

## Summary

上一批证明一个 Worker Host 可以同时等待多个 Agent 的异步模型请求，但没有证明多个 Session 能在 CPU 密集工具运行时继续推进。本批比较一个有界同步 CPU 工具与一个分片、定期让出事件循环的工具，观察另一 Session 的模型回包、Worker 控制消息、取消和 Session durable event 延迟。

DSH-TUI 的 Session Mount Runtime 把多个活动 Agent 放在同一进程的 handle registry 中；它没有提供线程或 CPU 调度隔离。Browser-Native Worker 与单个 Node 进程一样，每个 Worker 只有一个 JavaScript 执行线程，因此同步工具可能阻塞该 Worker 上所有 Session。此项验证用于决定正式产品需采用的工具协作要求和 Worker 隔离粒度，不直接实现调度器。

## 候选范围

| 验证点 | 价值 | 决定 | 原因 |
| --- | ---: | --- | --- |
| 一个 Agent 执行同步 CPU 工具时，其他 Session 的模型响应、Session 写入和 Worker 控制消息是否停滞 | P0 | 纳入 | 异步请求并发不能证明单 Worker 的执行公平性；这是上一批结论最重要的限制。 |
| 同步工具执行期间取消该 Agent 是否能中断工具，取消消息延迟多久 | P0 | 纳入 | Worker 消息事件无法在同步代码中分派，决定 Stop 的可预期性和副作用风险。 |
| 分片 CPU 工具在检查 AbortSignal 并让出 event loop 后，另一个 Session 能否完成 | P0 | 纳入 | 验证“工具合作式取消/让出”是否足以支持共享 Worker。 |
| Worker 页面主线程 UI 是否仍可动画和响应 | P1 | 纳入 | Dedicated Worker 隔离应至少保持页面响应；测量不可替代另一 Session 的 Worker 内进展。 |
| 同一 Worker 多 Session 的 Session append/durableThroughSeq 是否受阻塞工具影响 | P1 | 纳入诊断 | Session tool-call/result 的持久化时序决定刷新后是已完成还是 unknown。 |
| 阻塞时强制终止 Worker 对所有挂载 Session 的故障影响 | P1 | 后续批次 | 需要覆盖整组 Session 的 Worker terminate、刷新重建、owner lease 恢复与 unknown settlement，避免本批混入生命周期恢复矩阵。 |
| 同一 Host 承载 1/2/4/8 个异步模型等待 Agent 的 heap/CPU 曲线 | P1 | 后续批次 | 需要稳定环境与可重复 workload，属于容量测量，不替代此处的 event-loop 阻塞语义。 |
| 单 Worker 与每 Session 一个 Worker 的创建耗时、内存与页面生命周期对照 | P1 | 后续批次 | 这是 Worker pool/隔离策略决策，须先知道共享 Worker 中工具任务的真实阻塞范围。 |
| 多 Session HITL 等待与 CPU 工具交叠 | P2 | 暂不纳入 | HITL 等待是异步空闲状态；本批先对比同步阻塞与显式让出。 |
| 多 Session Workspace 并发写权和 CAS 竞争 | P2 | 不重复 | 既有 observer、lease 和 revision 验证已覆盖该存储策略；本批不改变 Workspace 权限。 |
| 页面冻结、隐藏、关闭时多 Session 的统一 teardown | P1 | 不重复 | 已有 Worker 生命周期验证；本批不把页面生命周期结论外推为后台执行。 |

## 实施范围

在 PoC validation profile 中加入两种测试工具：有界同步 CPU 工作，以及分片 CPU 工作。两者只执行固定上限的纯计算，不读写 Workspace 或调用外部 API；第二种工具每个 slice 后让出 Worker task，并检查 DSH tool execution 的 `AbortSignal`。工具 schema 只在显式 `browser-native-test=cpu-contention` profile 发布，默认工具集合保持不变；Worker 事件通过现有测试 MessagePort 返回页面。

一个真实 Worker Host 创建两个 DSH Agent/Session。测试 backend 先将两条确定性模型响应停在 barrier，再释放一个 Session 的 CPU tool call；另一个 Session 的文本响应与取消/状态请求在 CPU 工具运行期间释放或发送。backend 在 barrier 实际释放响应时记录时间；E2E 同时读取 DSH Session event，避免把网络栈完成误当成 Worker 已处理响应。第二个对照在 cooperative 工具运行期间以相同顺序释放响应，再取消 CPU Agent。Chrome E2E 区分页面 animation frame、backend 响应释放和 Worker 内 Agent 进展。

模型请求时序由同源 PoC backend test hook 控制；该并发 E2E 不调用外部模型。另运行真实 Chrome/LLM 普通文件与 Session 恢复 smoke，作为普通执行路径回归，不作为 CPU 并行证据。所有 probe 仅通过显式 `browser-native-test=cpu-contention` URL 启用，不进入默认 profile 或正式用户 UI。

## 验收矩阵

| 场景 | 预期证据 |
| --- | --- |
| 同步 CPU 工具开始后，另一个 Session 的模型响应已由 backend 释放 | 对应 Session 的 Worker 内 terminal/event 处理只能在同步工具结束后继续；记录 release、tool start/end 和 Session durable watermark 的顺序与时间。 |
| 同步 CPU 工具运行中向 Worker 发送 Agent cancel | cancel 请求在工具结束前保持 pending；工具结束后 Worker 才处理取消。测试不得声称同步工具可被 AbortSignal 抢占。 |
| 页面主线程观察 Worker 同步 CPU 负载 | 页面 animation frame 继续发生；该结果只表示 UI 线程未被 Worker 占用。 |
| Cooperative CPU 工具运行时释放另一 Session 的模型响应 | 第二 Session 在 CPU 工具结束前记录 completed `turn/end`；两 Session 的 prompt 与 terminal event 不串线。 |
| Cooperative CPU 工具运行中取消该 Agent | 工具在下一个 yield/checkpoint 观察到 `AbortSignal`；该 Session 以 aborted 结束，另一个 Session 保持其独立终态。 |
| 工具完成与 Session durability | 每个工具 call/result/turn 事件数量与 durable watermark 对账；不把工具开始、内存状态或取消请求误报为 durable。 |
| 测试 teardown | 两个 Agent handle 均 dispose，唯一测试 Worker 关闭；backend、browser 与临时 dataDir 回收，无页面/Worker error 或跨源请求。 |

## 重要限制

CPU workload 使用固定时长上限，仅作为可重复的事件循环阻塞探针，不是性能基准或真实模型生成负载。`performance.now()` 结果只报告本次 Chrome 环境观察值，不定义 SLA。测试不能证明所有现有 DSH 工具都是同步阻塞，也不能仅凭 cooperative fixture 证明第三方插件会定期让出。

本批不实现 Worker pool、工具超时终止、跨 Worker Agent 调度或生产级 admission control。Worker 自身仍是单线程且受页面生命周期约束；同步工具若无法协作，让出唯一的强制中断手段可能是终止整个 Worker，这会影响该 Worker 上所有 Session，需在后续恢复矩阵单独验证。

## 里程碑

1. 在本文件选定范围后，建立进度文档并复核 DSH tool signal、Worker message 与 Session flush 的实际时序。
2. 添加 validation-only CPU 工具、可控模型响应 barrier 和 Worker event 观测；补充单测验证 duration 上限、slice/yield 和取消检查。
3. 运行 Chrome 同步阻塞/协作让出对照 E2E，记录事件顺序、控制消息延迟、Session durable state 与页面帧证据。
4. 运行真实 Chrome/LLM 普通文件和 Session smoke，更新 PoC README、兼容矩阵、drafts 索引与 change ledger。
5. 运行相关构建、focused tests、文档门禁和 pre-push 检查；提交并推送 `research`，保留不相关工作区修改。
