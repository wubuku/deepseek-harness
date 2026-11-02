---
description: "盘点 Browser-Native DSH PoC 的已验证结论、未验证缺口与已知坑，并记录下一批高价值验证点的选取与淘汰理由。"
---

# Browser-Native DSH 下一批验证：证据盘点与选取

## Summary

本文件先对现有 PoC 证据做只读盘点，区分“已被真实 Chrome/Worker 证据支撑的结论”“只有设想或尚未验证的缺口”“已经踩到并记录的坑”，再给出 21 个候选验证点、选取结果与淘汰理由。选取标准是：卡正式产品脖子的技术难点、结论不确定性高、验证成本可控、彼此不重叠。本批执行 A（后台标签自然节流下的 lease 与活动 turn）、B（open tool cut 上的 fork 结算）、C（Worker 内进程内 subagent 委托）三项；A/C 若被证伪或受限，如实记录，不以 scripted 结果冒充产品结论。

## 证据盘点

### 已验证（有真实 Chrome Worker 证据）

| 结论 | 证据 |
| --- | --- |
| 真实 DSH Host 与 `ctx.agentLoop` 在 Dedicated Worker 中运行，模型凭据只留在同源 backend | [README.md](README.md#L9)、[兼容矩阵](operational-compatibility-matrix.md#L27) |
| Session transport、outbox、receipt 恢复与 writer fencing 可承受响应丢失、IDB abort 与 Worker 终止 | [矩阵 Session persistence 行](operational-compatibility-matrix.md#L41) |
| 一个 Worker 可同时运行三个真实 Agent Loop；取消、prompt 与 Session event 按 Session 隔离 | [矩阵 Session 编排行](operational-compatibility-matrix.md#L44)、[README.md](README.md#L47) |
| `next-turn` 排队只消费一次、`cancel({ keepInbox: true })` 保留 queued message、`resume()` 从 request header 恢复 route | [连续性进度](next-session-continuity-validation-progress.md#L9) |
| closed turn 与运行中 text open-tail 的 `buildForkSeed` fork 都不重发继承 prompt | [连续性进度](next-session-continuity-validation-progress.md#L18)、[README.md](README.md#L27) |
| 同 Worker 的同步 CPU 工具阻塞 peer Session；独立 Worker 拓扑下 peer 可继续 | [矩阵 Worker 隔离行](operational-compatibility-matrix.md#L47) |
| 审批授权、串行多调用、Stop 取消结算、Worker 强杀后 `TOOL_OUTCOME_UNKNOWN` 结算均有 Chrome 证据 | [矩阵审批行](operational-compatibility-matrix.md#L29)、[矩阵工具取消行](operational-compatibility-matrix.md#L37) |
| Workspace lease 冲突、observer 只读、edit/lease 竞态与过期 writer fencing 已闭环 | [矩阵共享 Workspace 行](operational-compatibility-matrix.md#L58)、[lease/edit 行](operational-compatibility-matrix.md#L60) |
| pagehide 本地屏障在离开页面时先 flush 本地 snapshot/blob | [矩阵 pagehide 行](operational-compatibility-matrix.md#L62) |
| 附件上传、补水、取消与 Worker 强杀恢复闭环 | [矩阵附件行](operational-compatibility-matrix.md#L40) |
| 真实模型 `gpt-5.6-sol` 在 Chrome 中完成 `read → write → read` 与刷新续聊 | [矩阵 Session persistence 行](operational-compatibility-matrix.md#L41) |

### 未验证（缺口）

| 缺口 | 证据 |
| --- | --- |
| open tool cut 上的 fork 是否合成 `TOOL_OUTCOME_UNKNOWN` 且不重放 | [README.md](README.md#L27)、[连续性进度](next-session-continuity-validation-progress.md#L19) |
| 后台标签自然节流（非 CDP freeze）下 Dedicated Worker 的 lease 续租与在途 turn | [README.md](README.md#L862)、[矩阵生命周期行](operational-compatibility-matrix.md#L34) |
| 页面关闭后的后台 Agent；`parked` 不等于后台运行 | [矩阵 pagehide 行](operational-compatibility-matrix.md#L62)、[矩阵 mount 行](operational-compatibility-matrix.md#L42) |
| 单页 Worker supervisor/pool；当前页面 realm 只连一个 Host Worker | [矩阵 Worker 隔离行](operational-compatibility-matrix.md#L47) |
| BFCache back/forward 连续性（`no-store` 与 JS 网络请求导致未命中） | [README.md](README.md#L881)、[矩阵生命周期行](operational-compatibility-matrix.md#L34) |
| Safari/WebKit 行为（按计划暂停） | [README.md](README.md#L673) |
| Worker 内进程内 subagent 委托（package 可能拉入 Node-only 依赖） | [README.md](README.md#L47)、[兼容矩阵](operational-compatibility-matrix.md) |
| HITL 跨标签/跨设备投递 | [矩阵控制通道行](operational-compatibility-matrix.md#L32) |
| `web_search`/`web_fetch`（profile 明确不提供） | [矩阵](operational-compatibility-matrix.md#L18)、[README.md](README.md#L9) |
| 真实模型自主多 Agent、route 选择、fork、权限选择 | [README.md](README.md#L47)、[连续性计划](next-session-continuity-validation-plan.md#L22) |
| 生产多实例 backend、跨主机 HA、exactly-once | [README.md](README.md#L1112)、[矩阵多实例行](operational-compatibility-matrix.md#L51) |
| 自然 eviction、OS/磁盘/浏览器进程崩溃 | [README.md](README.md#L525)、[README.md](README.md#L823) |
| 首次 hydrate 的完整临时副本（内容 hash 需要整读） | [README.md](README.md#L716) |
| 54 条 unresolved builtin 请求的运行覆盖 | [README.md](README.md#L450) |
| Windows 强杀脚本不可用（依赖 POSIX `ps`/`SIGKILL`） | [README.md](README.md#L503) |

### 已知坑（已记录，不应重复踩）

| 坑 | 证据 |
| --- | --- |
| DSH Session/Workspace/业务 API 没有跨存储原子事务；未知结果只能查询原 operation，禁止自动重放 | [README.md](README.md#L484)、[README.md](README.md#L978) |
| 恢复包上限 64 MiB，超限拒绝且不截断 | [矩阵生命周期行](operational-compatibility-matrix.md#L34) |
| Session 单 Session 8,192 events/16 MiB、profile 32,768 events/64 MiB 预算 | [矩阵 Session persistence 行](operational-compatibility-matrix.md#L41) |
| `pagehide.persisted` 只以合成事件验证；真实页面卸载与晚到 callback 的调度竞争未测 | [README.md](README.md#L862) |
| Playwright 默认参数会关闭后台节流，本地验证后台标签必须显式移除这些 flag | [tests/session-worker-isolation.e2e.mjs](tests/session-worker-isolation.e2e.mjs) |
| 能力探测失败只回滚已发布 schema，不回滚已进入 VFS 的 mutation | [矩阵能力发布行](operational-compatibility-matrix.md#L27) |
| PoC principal 不是身份认证，不抵御同源恶意脚本 | [矩阵 principal 行](operational-compatibility-matrix.md#L48) |

## 候选池（21 项）

| # | 候选 | 验证的风险 | 失败的产品影响 | 成本 | 可验证信号 |
| --- | --- | --- | --- | --- | --- |
| 1 | open tool cut 的 fork 结算 | 分支继承错误副作用 | 分支会话重放未知工具，产生重复写 | 小 | child seed 含 `TOOL_OUTCOME_UNKNOWN`，工具执行计数 1，child 无继承 prompt 请求 |
| 2 | 后台标签自然节流下的 lease/turn | 隐藏页面丢失写权 | 后台任务静默中断或丢事件 | 中 | 续租间隔、append 结果、turn 终态 |
| 3 | Worker 内进程内 subagent | 委托能力在浏览器不可用 | 多 Agent 产品能力缺失 | 中 | child Session 建立、完成通知、取消与深度 |
| 4 | 单页 Worker supervisor/pool | 一个 Worker 阻塞全部 Session | 需重启页面才能恢复 | 大 | 需先实现产品级 supervisor，本批不做 |
| 5 | web_search/web_fetch | profile 无该能力 | 产品承诺无法兑现 | 大 | 需要新 backend capability seam |
| 6 | Safari/WebKit | 浏览器矩阵缺口 | 无法宣称跨浏览器 | 大 | 明确暂停 |
| 7 | HITL 跨标签投递 | 审批在错误标签弹出 | 用户无法批准 | 中 | 跨页审批事件唯一性 |
| 8 | BFCache 往返 | 后退后 Worker 重建 | 历史页不可用 | 中 | 设计上 `no-store`，收益低 |
| 9 | 页面关闭后后台执行 | `parked` 被误读为后台 | 产品宣称不实 | 大 | 需要 Durable Worker，属云端阶段 |
| 10 | 真实模型自主 fork/route | 模型行为不等于技术门 | 影响体验不影响正确性 | 中 | 属模型评测，非技术验证 |
| 11 | 自然 eviction/OS crash | 恢复假设 | 数据丢失无告警 | 大 | 需真实故障注入环境 |
| 12 | 首次 hydrate 峰值副本 | 大文件内存峰值 | 大文件 OOM | 中 | 需新增增量 hash 实现 |
| 13 | 54 条 unresolved builtin 运行覆盖 | 打包遗漏 | 插件静默失败 | 大 | 需逐条 conformance |
| 14 | Windows 强杀路径 | 平台矩阵 | 恢复脚本不可用 | 中 | 需 Windows 环境 |
| 15 | 多实例 backend/HA | 跨主机 fencing | 无法多实例部署 | 大 | 需共享存储环境 |
| 16 | 跨设备 Session 恢复 | 设备切换 | 移动端续聊失败 | 大 | 需第二设备与认证 |
| 17 | observer 并发写合并 | 多 writer 冲突 | 丢更新 | 中 | 需 merge 策略设计 |
| 18 | 附件安全 GC | 孤儿对象 | 存储泄漏 | 小 | 需引用扫描器 |
| 19 | 大文件真实模型 tool args | 参数体积 | 大文件不可用 | 中 | 模型侧限制，非确定性 |
| 20 | 跨标签 writer 接管 UI | 用户无法接管 | 体验缺陷 | 小 | 已有 lease 冲突页 |
| 21 | fork 的 Workspace snapshot/branch | 分支与文件不一致 | 分支读到父分支文件 | 中 | 需要 Workspace 分支语义设计 |

## 本批选取

选取 A、B、C。理由：三者都直接卡“Browser-Native 是否还是同一个 DSH Agent Loop、能否安全分支与委托”的产品门槛，结论不确定性高，成本可控，且互不重叠；A 解决页面生命周期这一浏览器独有风险，B 补齐唯一已知的 fork 语义缺口，C 决定多 Agent 产品能力能否在 Worker 内成立。

### A：后台标签自然节流下的 lease 与在途 turn

假设：页面不可见时 Dedicated Worker 的定时器仍按 lease/3 续租；Chrome 进入 intensive throttling 后仍能维持 lease 与 turn。
最小实验：headed Chrome（移除 `--disable-background-timer-throttling` 等默认参数），`ownerLeaseMs` 收缩到便于观测的量级，两个同源标签，第二个标签持有焦点，跨过 Chrome 的 5 分钟 intensive throttling 窗口后检查续租间隔、Workspace append 与 turn 终态。
判定：续租间隔始终小于 lease 且 append 无 fencing 失败 → 成立；出现续租间隔超过 lease 或 fencing 拒绝 → 不成立，并记录对“后台标签算后台 Agent”的产品结论的影响。
失败即停分支：若 throttle 未触发（Chrome 版本策略变化），只记录“本环境未复现”，不把结果写成通过。

### B：open tool cut 上的 fork 结算

假设：`buildForkSeed` 在 cut 于在途 tool call 时，为 step 合成 `TOOL_OUTCOME_UNKNOWN` 的 `tool/result`，以 `forked` 关闭 step/turn；父 Agent 继续只执行一次该工具。
最小实验：新增 validation-only 长时工具，scripted LLM 先发该工具调用，Session 出现 `tool/call` 后立即 fork，随后放行工具。
判定：child seed 中出现 `error.code === TOOL_OUTCOME_UNKNOWN` 且 `sourceEventSeqs` 指向该 call；child 不触发继承 prompt 的模型请求；工具执行计数为 1；parent 正常完成一次。
失败即停分支：若 child 出现重复执行或缺少合成结果，记为产品级缺陷并给出最小复现。

### C：Worker 内进程内 subagent 委托

假设：`packages/subagent/*` 能在 Dedicated Worker 模块图中加载，`ctx.agents` 与工具可见性支撑子 Agent 创建与完成。
最小实验：在 continuity roster 上追加 subagent 包与最小配置，脚本化模型触发 `subagent` 工具调用。
判定：child Session 建立、完成通知回传、深度与取消受控 → 成立；任一环节需要 Node-only 依赖 → 记录为不可行并给出具体缺失模块。
失败即停分支：包加载失败即停止，不伪造替代实现。

## 淘汰理由（摘要）

单页 supervisor/pool（#4）、后台执行（#9）、多实例 HA（#15）、跨设备（#16）需要产品级实现或第二运行环境，超出 PoC 可判定范围；web_search/fetch（#5）需要新 capability seam；Safari/WebKit（#6）已按计划暂停；BFCache（#8）当前响应为 `no-store`，收益与成本不匹配；真实模型自主 fork/route（#10）属模型评测；其余（#11-#14、#17-#21）依赖故障环境、平台矩阵或尚未设计的语义，本轮不纳入。

## 自主决策记录

- 选择 headed Chrome 并显式移除 Playwright 的后台节流抑制参数，因为 headless 下不存在真实可见性变化，结论无意义。
- A 的 lease 值通过既有测试钩子 `ownerLeaseMs` 收缩，而不是改默认常量，避免把验证便利写成产品默认。
- B 新增 validation-only 工具而不是复用 `browser_cpu_*` probe，因为 CPU probe 的语义是 CPU 占用，复用它会把“在途工具”与“CPU 阻塞”混为一谈。
- C 只尝试现有包与最小配置；若加载失败即记录可行性结论，不做 shim 替代。
