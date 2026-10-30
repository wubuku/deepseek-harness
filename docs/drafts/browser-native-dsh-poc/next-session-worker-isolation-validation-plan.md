---
description: "规划 Browser-Native DSH 多 Session Worker 拓扑的阻塞隔离、强制终止影响范围和资源代价验证。"
---

# 多 Session Worker 隔离验证计划

## 结论

DSH-TUI 在一个宿主进程中挂载多个 Agent；切换查看对象不会停止其他 Agent，宿主退出则结束该进程承载的执行。Browser-Native DSH 已证明一个 Dedicated Worker Host 可同时运行多个真实 Agent，但同一 Worker 的同步 JavaScript 会阻塞其全部 Session，且强制终止该 Worker 会同时销毁所有 Agent。

本批验证共享 Worker 与每个 Session 独立 Worker 两种执行拓扑的隔离收益、Session 持久化状态和 Chrome 资源代价。实验只扩展 PoC validation profile，不实现正式 Worker pool、会话管理 UI 或自动重放策略。

## 候选范围

| 候选 | 价值 | 本批决定 | 依据 |
|---|---:|---|---|
| 单 Worker 内同步工具阻塞其他 Session | P0 | 已有基线，本批拓扑对照复核 | Chrome 156 已观测到 peer 响应和取消消息等待同步工具返回；协作式 yield 可让 peer 继续。 |
| 一个 Worker 被终止时影响哪些 Session | P0 | 纳入 | 一个页面当前只创建一个 Host Worker；DSH-TUI 的宿主生命周期提示，不能把页面里多个 Agent 当成独立故障域。 |
| 每 Session 独立 Worker 能否隔离同步 CPU 工具和 Worker 终止 | P0 | 纳入 | 这是将不可合作工具的强制停止范围缩小到单个 Session 的可行性条件。 |
| 独立 Worker 的浏览器资源成本 | P0 | 纳入，限 1/2/4 个 Host | 已有 1/4/8 个独立 Chrome context 的通用 turn 测量，但未观察同一 BrowserContext 中一 Session 一 Host 的启动与请求账本。结果只作本机诊断。 |
| Worker 终止后的 Session 前缀、未结算 tool call 和重放行为 | P0 | 纳入 | Workspace crash 恢复不能证明 Agent turn 的恢复。必须从 backend Session log 判定已持久化事实，不能由页面内存推断。 |
| 新 Worker 自动恢复未完成 turn 或自动重放 prompt | P0 | 不实现；测试确认无隐式重放 | Worker 的 JavaScript heap、活动 Promise 和工具栈无法恢复。恢复必须由 Session resume 与明确的业务幂等语义完成。 |
| 同 Worker 1/2/4/8 Agent 容量门槛及 admission control | P1 | 后续批次 | 当前只有 3 个异步 barrier Agent 和两个 Agent 的 CPU 对照，尚不足以制定容量或排队策略。 |
| 同一页面由 supervisor 管理多个 Host Worker | P1 | 记录产品化差距 | `connectWorkerHost()` 在每个页面 realm 安装一份 transport；本批使用同一 BrowserContext 的独立页面作为 Worker Host realm，不宣称单页 Worker pool 已存在。 |
| 多 Host 共享 Workspace 写入、公平排队和 Session writer 竞争 | P1 | 不重复 | Workspace lease、Session owner fencing 和跨标签 writer 已有独立验证；本批工具不写 Workspace。 |
| 隐藏标签节流、页面冻结/BFCache、关闭后后台执行 | P1 | 不重复或后续平台验证 | 已有生命周期证据；Dedicated Worker 仍受所属页面生命周期约束，本批不把多 Worker 描述成后台 Agent。 |
| 真实模型并发推理的吞吐量与成本 | P1 | 后续批次 | scripted barrier 用于可重复时序；本批另跑普通真实 LLM smoke，但不将其当作多 Worker 容量证明。 |
| Safari/WebKit、移动设备、自然 eviction、OS crash、任意 WASM 插件强制中断 | P1 | 不纳入 | 当前验收优先 Chrome；这些需要各自的平台或 crash 实验，不能从 scripted Chrome 外推。 |

## 实验设计

### 共享 Worker 与独立 Worker

共享拓扑在一个 Host Worker 内启动两个 Agent：Agent A 进入有界同步 CPU 工具，Agent B 的 scripted LLM 响应在工具运行时释放。实验记录 Agent B 的 `turn/end` 是否只能在工具返回后出现，并在工具执行中终止 Worker，检查两个 Session 的持久化前缀。

独立拓扑在同一 Chrome BrowserContext 的两个同源页面中各启动一个 Host Worker 和一个 Agent。页面共享浏览器身份与 backend，但 Worker、Cordis Host 和 AgentRegistry 相互独立。Agent A 进入相同同步 CPU 工具时释放 Agent B 的模型响应；B 必须在 A 工具结束前完成。随后只终止 A 页面所属 Worker，检查 B 的 Worker、Session 和模型请求仍可完成。

每个页面 realm 只连接一个 Host Worker，因为当前 `connectWorkerHost()` 将 transport 安装在 realm 全局。本实验不创建隐藏 iframe 管理器，不等价于单页可调度的生产 Worker pool；它验证的是独立 Host 故障域是否可行，以及多标签 Host 的实际行为。

### Worker 终止后的 Session 事实

在 A 的 CPU 工具 `started` 通知后终止 Worker，使工具不能写入 Workspace 或执行外部副作用。随后通过同源 backend 读取 A、B 的 Session event log，并对照已送达的模型请求：A 应保留原 prompt 和已记录的 tool call，但不得出现伪造的 tool result、completed turn 或第二次 prompt；B 应保留自己的 prompt、assistant 输出和 completed turn。

本批只验证终止时的已持久化前缀和禁止隐式重放，不把不完整 turn 自动修复为可继续状态。若当前 Session API 无法重新挂载该历史 Session，或其结果为明确错误，记录实际结果和恢复缺口，不通过创建新 Session 冒充恢复成功。

### 资源诊断

依次运行 1、2、4 个页面/Host Worker，每个 Worker 运行一个真实 DSH Agent turn。记录 Worker 数、启动耗时、同源模型请求、Session event 数、浏览器进程 RSS/CPU 与页面长任务。重复至少三轮；输出原始 JSON 和运行环境，不设 SLA，不从 RSS 单次差值推导每个 Worker 的精确 heap。

## 验收矩阵

| 场景 | 预期证据 |
|---|---|
| 单 Worker 两 Session 同步 CPU | 同步工具期间释放的 peer 响应不能在该 Worker 返回事件循环前产生 peer `turn/end`。 |
| 终止共享 Host Worker | 两个 Agent 都停止推进；backend 只保留各自已经追加的 Session events，不产生终态或成功结果伪证。 |
| 两 Host Worker 并行 | A 的同步工具运行时，B 收到响应并写入完成 turn；每个页面恰有一个 Worker、Session IDs 不同、事件不串线。 |
| 终止独立 Host Worker A | A 的活动工具没有结果事件；B 继续并恰有一个 completed turn；A 的 prompt 和 tool call 未重放。 |
| 1/2/4 个 Host 资源诊断 | 每个页面有一个 Worker、每个 Session 恰有一个 prompt 和 terminal event；请求数可按 Session 对账；至少三轮结果留档。 |
| 真实 LLM 回归 | Chrome 通过同源代理完成普通文件工具和刷新后 Session 续聊；不声称真实模型并发。 |
| 安全与清理 | 浏览器只请求 PoC 同源端点；终止实验不包含业务副作用；所有页面、Worker、backend、浏览器和临时数据目录均清理。 |

## 里程碑

1. 核对 Agent resume、Session writer lease、Worker terminate 和已有 lifecycle E2E；建立本批计划与进度，不修改正式 package。
2. 将 validation-only Agent probe 扩展到单 Agent Host，补充输入、创建、取消和 dispose 测试。
3. 实现共享 Worker/多 Agent 与同 BrowserContext 多页面/每页一 Agent 的 Chrome 对照，记录阻塞、终止、Session event 和请求身份。
4. 实现 1/2/4 Host 的重复资源诊断并保存 Chrome 原始 JSON；对结果只作当前机器和 Chrome 版本描述。
5. 运行真实 LLM 普通路径 smoke、PoC 定向测试、Preview build、文档检查和 pre-push 检查；更新 README、兼容矩阵、drafts 索引与 change ledger。
6. 提交并推送本批改动到 `research`。不暂存或修改无关 `.archify/` WIP，不创建隔离 worktree。

## 结论边界

成功只证明当前 PoC 可以在独立页面 realm 中运行多个 Host Worker，并将同步 CPU 阻塞及 Worker 强制终止限制在对应 Worker；不能证明单页 Worker pool、生产并发上限、每 Worker 内存、真实模型并发成本或任意工具的副作用可回滚。

Dedicated Worker 和独立页面仍随各自页面生命周期结束。被终止 Session 若留下未结算 `tool/call`，必须显示为中断或未知状态；Worker termination 不是成功取消，也不是后台 Agent 保证。
