---
description: "规划在单个 Browser-Native DSH Worker Host 内并行运行多个真实 Agent 与 Session 的验证。"
---

# Browser-Native 单 Worker 多 Session 并行验证计划

## Summary

本批验证一个 Dedicated Worker 中的真实 DSH Host 是否可通过同一 `ctx.agents` 同时驱动多个独立 Session，并在同一 Worker 的异步模型请求同时在途时保持 Session 事件、取消和 owner 状态隔离。验证依据来自当前 DSH-TUI 的多 Agent roster 与挂载生命周期；它借鉴单宿主管理多个活动会话的模式，不移植 TUI Channel、Node 进程或本地文件语义。

## 候选范围

| 验证点 | 价值 | 决定 | 原因 |
| --- | ---: | --- | --- |
| 单个 Host Worker 内创建多个真实 DSH Agent/Session 并同时请求模型 | P0 | 纳入 | 直接检验 DSH-TUI 多会话宿主模式能否映射到 Browser Worker。 |
| 一个 Session 取消时，其他同 Worker Session 继续运行 | P0 | 纳入 | 同一 JS 执行环境内的取消串扰会破坏多 Session 可用性。 |
| Session event、模型请求和 owner 身份隔离 | P0 | 纳入 | 多个 Loop 共用 Host 服务时，必须证明每条 transcript 仍只记录自己的输入和结果。 |
| 一个 Worker 内 1/2/4 个真实 Loop 的 heap/CPU 扩展曲线 | P1 | 本批不纳入 | 当前目标先确定同 Worker 并行语义；容量 SLA 需要单独控制浏览器版本、机器和 workload。 |
| 单页创建多个 Host Worker 的比较 | P1 | 本批不纳入 | 当前 `connectWorkerHost()` 使用页面级单例 transport；多 Host 需要独立设计通信与资源 owner。 |
| CPU 密集型工具对同 Worker Loop 的阻塞、公平性和排队 | P1 | 记录缺口 | 模型网络等待的并发不代表同步 CPU 工具的公平调度。 |
| 多 Session 同时写共享 Workspace 的授权与冲突 | P1 | 不重复 | 已有 observer/writer 与 Workspace fencing 验证；本批不扩展其 authority 语义。 |
| 页面冻结、关闭及浏览器资源回收 | P1 | 不重复 | 已有生命周期与 unknown settlement 记录；本批只复用其结论。 |

## 实施范围

在 Browser-Native PoC 专用 validation profile 中加入测试插件，经正式 `ctx.agents.create()` 建立三个不同 Session，并从每个 Agent 提交唯一 prompt。Chrome E2E 使用同源 PoC backend 的确定性响应 hook 同时挂起三条真实 DSH Agent Loop 的模型请求；它不调用外部模型。随后取消一个 Agent，观察该 Session 的取消终态和请求中断，再释放另外两个响应并确认其各自完成。`apps/web/src/preview.ts` 只把显式 `browser-native-test=multi-agent` 加入现有 PoC test port allowlist 和请求类型；默认页面行为不变。

测试通过 Worker test MessagePort 驱动，不增加正式 profile、正式 DSH package API 或用户界面。脚本统计实际 Worker 数、Session 创建/模型请求数量、Session event 与 terminal reason；不输出 owner token、凭据或 prompt 以外的敏感数据。

## 验收矩阵

| 场景 | 预期结果 |
| --- | --- |
| 同一 Worker Host 创建三个 Agent | 三个不同 Session ID 均成功创建，registry 同时保留三个 Agent。 |
| 三条模型请求到达 barrier | 三个请求同时在途，均含自己的 Session 身份；页面只创建一个 DSH Host Dedicated Worker。 |
| 取消 Session A | A 的模型请求被关闭，A 以用户取消原因结束；B/C 仍保持 running，未被取消。 |
| 释放 B/C 的模型响应 | B/C 各自完成一次 turn，assistant marker 仅出现在对应 Session。 |
| 读取三条 Session 日志 | 每条日志恰有一个对应 user prompt 和一个 terminal turn；没有其他 Session 的 prompt、assistant 文本或工具事实。 |
| 释放测试 Agent handle | 三个 Agent 均从当前 Worker registry 清除，Session owner 正常关闭。 |
| 真实模型回归 | 另运行既有 Chrome 真实 LLM smoke，确认普通 DSH 文件工具与刷新恢复仍可用；该 smoke 不作为多 Loop 推理能力证据。 |

## 里程碑

1. 核对 DSH `AgentRegistry`、AgentLoop、Session persistence 和取消 API，记录与 DSH-TUI 宿主模式的相同点和差异。
2. 增加限于 validation profile 的多 Agent probe，验证输入范围、重复 Session ID、部分创建失败和 teardown。
3. 运行单元测试与真实 Chrome Worker E2E，记录请求 barrier、取消与 Session event 证据。
4. 运行一次真实 LLM Chrome smoke，并执行受影响的 TypeScript、preview build 和文档检查。
5. 更新 PoC README、兼容矩阵、drafts 索引和 change ledger；只提交本批文件，保留无关工作区 WIP。

## 证据边界

通过只证明当前 PoC profile 在测试过的 Chrome 版本中，一个 Worker Host 可以承载三个真实 DSH Agent Loop，并允许异步模型请求并发等待、按 Agent 取消和分别持久化 Session。它不证明更高并发容量、CPU 密集工具公平性、内存 SLA、多个 Host Worker 的页面级调度、生产 backend 或模型自主协调能力。Dedicated Worker 仍受页面生命周期约束。
