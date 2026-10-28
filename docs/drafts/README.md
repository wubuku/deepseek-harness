---
description: "DSH 研究草稿的目录级导读：按 Agentic UI、Browser-Native、Cloud/Durable Agent 和工程运营分组，说明研究结论、证据层级、推荐阅读路径与 PoC 入口。"
---

# DSH 研究草稿导读

## Summary

最新可运行入口：[成熟 React SaaS 三路线同口径实验](saas-agentic-ui-comparison-poc/README.md)及其[复杂续约实验](saas-agentic-ui-comparison-poc/complex/README.md)。前者在同一 Browser-Native DSH Loop 上，分别用原生 DSH UI、assistant-ui、CopilotKit 接入相同业务组件和 mock API；后者让 assistant-ui 与 CopilotKit 在真实 Chrome、Playwright WebKit 上完成同一跨客户批量续约流程，并核对工具结果、业务 receipt 与版本冲突。先读基础[验收说明](saas-agentic-ui-comparison-poc/manual-acceptance.md)和[测试记录](saas-agentic-ui-comparison-poc/test-results.md)，复杂操作按其[手动验收](saas-agentic-ui-comparison-poc/complex/manual-acceptance.md)；选型判断以[Web UI 评估](dsh-web-ui-quality-and-agentic-ui-framework-assessment.md#三份-poc-后的路线重评)为准。

`docs/drafts/` 保存 DSH 当前阶段的跨包研究、架构判断、实施方案、PoC 和工程备忘。本文是这个目录的入口，不替代各专题文档，也不是 DSH 已发布运行时行为的权威说明。

如果只想理解最近关于 Agentic UI 和 Browser-Native DSH 的大图景，先读本文的[研究总览](#研究总览)，再读[综合报告](dsh-browser-native-agentic-ui-research.md)、[Web UI 与框架选型评估](dsh-web-ui-quality-and-agentic-ui-framework-assessment.md)和[外部 SaaS Agentic UI 报告审阅](saas-agentic-ui-report-review.md)，然后查看[browser-native-dsh-poc](browser-native-dsh-poc/README.md)、[assistant-ui 增量 PoC](assistant-ui-browser-native-dsh-poc/README.md)和[CopilotKit 增量 PoC](copilotkit-browser-native-dsh-poc/README.md)。

当前最重要的事实边界是：Browser-Native v2 PoC 已验证真实 DSH Agent Loop 在 Dedicated Worker、同源 LLM proxy 和远程 Session persistence 上运行；基础同口径实验又让 DSH 原生 UI、assistant-ui 和 CopilotKit 在相同 mock SaaS 任务、工单、账单组件/API 上完成业务闭环。复杂续约实验第一阶段以 CopilotKit 为主验收路线，验证了跨页面上下文、共享业务组件、原生 frontend tool/HITL、取消、刷新和写权恢复；随后 assistant-ui 也在同一个复杂真实模型故事的 Chrome 与 Playwright WebKit 入口跑通。DSH 原生入口保留 scripted 复杂故事证据，未完成等量真实模型复杂矩阵。它们仍是 mock 业务和受控 PoC，不证明生产 SaaS API、权限、事务、receipt 或多租户安全。研究中的 SaaS 前提是“已有丰富业务 GUI，但没有聊天层”：三条路线都是新增唯一聊天/Agentic UI 层，不取代原有业务页面，也不应并行挂载多套可见聊天层。

当前判断按场景分层：assistant-ui 与 CopilotKit 都完成同一复杂真实模型故事；在 DSH 默认 Loop 必须是唯一执行者的设定下，assistant-ui 目前需要维护的适配责任更窄、总接入成本更低。CopilotKit 的前端工具和 HITL 确有真实应用交互价值，但需要 DSH 专属 AG-UI 分段适配，本轮未显示它减少业务实现或测试步骤；若大量复用其应用交互能力，可再做盈亏平衡验证。DSH 原生 UI 适合愿意采用 DSH Client/Conversation/Slot 体系的产品，但没有完成等量真实模型复杂矩阵。完整证据见[统一选型评估](dsh-web-ui-quality-and-agentic-ui-framework-assessment.md#三份-poc-后的路线重评)和[复杂实验评估](saas-agentic-ui-comparison-poc/complex/design-and-assessment.md)。

Browser-Native 的交互恢复证据区分默认 legacy HITL 与临时 timed HITL：timed schema 在 Chrome 中可于刷新后按原 callId 恢复并接收迟答；后续官方 composer 已加入显式 Stop，并用 Chrome Worker/DSH 验证 legacy 与 timed 活动等待均以 `aborted` 收束且没有后续写入。Escape stop shortcut 仍忽略 pending interaction，关闭 keyed 问题卡仍只隐藏、不取消。详见[timed HITL 生命周期验证](browser-native-dsh-poc/timed-hitl-lifecycle-validation-plan.md)、[活动 HITL Stop 计划](browser-native-dsh-poc/active-hitl-stop-validation-plan.md)和[进度](browser-native-dsh-poc/active-hitl-stop-validation-progress.md)。

## Table of Contents

- [如何使用这个目录](#如何使用这个目录)
- [研究总览](#研究总览)
- [推荐阅读路径](#推荐阅读路径)
- [Agentic UI 与 Browser-Native](#agentic-ui-与-browser-native)
- [Web UI 质量与框架选型](#web-ui-质量与框架选型)
- [外部 SaaS Agentic UI 报告审阅](#外部-saas-agentic-ui-报告审阅)
- [Cloud Agent、Durability 与隔离](#cloud-agentdurability-与隔离)
- [工程实现与运营](#工程实现与运营)
- [Browser-Native PoC 目录地图](#browser-native-poc-目录地图)
- [PoC 手动验收与经验](#poc-手动验收与经验)
- [证据层级与状态标记](#证据层级与状态标记)
- [当前统一结论](#当前统一结论)
- [维护规则](#维护规则)
- [Dev Note](#dev-note)

-----

## 如何使用这个目录

### 五分钟了解大图景

1. 阅读本文的[研究总览](#研究总览)和[当前统一结论](#当前统一结论)。
2. 阅读[Browser-Native 环境下实现 Agentic UI：DSH 综合深度调研报告](dsh-browser-native-agentic-ui-research.md)的 Summary、[PoC 事实核查](dsh-browser-native-agentic-ui-research.md#dsh-与-poc-的事实核查)和[最终判断](dsh-browser-native-agentic-ui-research.md#最终判断)。
3. 阅读 [DSH Web UI 实现质量与 Agentic UI 框架选型评估](dsh-web-ui-quality-and-agentic-ui-framework-assessment.md)的[结论先行](dsh-web-ui-quality-and-agentic-ui-framework-assessment.md#结论先行)、[三份 PoC 后的路线重评](dsh-web-ui-quality-and-agentic-ui-framework-assessment.md#三份-poc-后的路线重评)和[按产品场景选择集成位置](dsh-web-ui-quality-and-agentic-ui-framework-assessment.md#按产品场景选择集成位置)。
4. 阅读[外部 SaaS Agentic UI 报告审阅](saas-agentic-ui-report-review.md)，区分可保留的工程方法、已核实的官方能力和不应继续传播的行业化表述。
5. 阅读 [Browser-native DSH PoC README](browser-native-dsh-poc/README.md) 的当前实现快照和验证章节。
6. 如果要验证“assistant-ui 接管聊天、DSH 保留执行和 Session 事实”，运行 [assistant-ui + Browser-Native DSH 增量 PoC](assistant-ui-browser-native-dsh-poc/README.md)。
7. 阅读 [Browser-Native 工具清单与配置裁剪调研](browser-native-dsh-poc/browser-native-tool-roster-and-configuration-research.md)，理解为什么当前 PoC 会继承不适用的主机工具，以及 Browser-specific preset 的配置落点。
8. 需要理解复杂 SaaS 场景时，继续读[复杂续约实验设计](saas-agentic-ui-comparison-poc/complex/design-and-assessment.md)和[复杂实验测试记录](saas-agentic-ui-comparison-poc/complex/test-results.md)；前者拥有架构判断，后者拥有实际通过与未执行边界。
9. 需要亲自验收时，按 [Browser-Native DSH PoC 手动验收说明](browser-native-dsh-poc/manual-acceptance.md)启动基础入口；复杂场景按[复杂实验手动验收](saas-agentic-ui-comparison-poc/complex/manual-acceptance.md)启动，并按文档标注区分三路线基础对照和 CopilotKit 主验收。

### 三十分钟形成技术判断

按下面顺序阅读：

1. [DSH Agentic UI 事实核查](dsh-agentic-ui-research.md)：理解既有 SaaS GUI、DSH Tool view、Conversation Node 和业务 API 的关系。
2. [DSH Web UI 实现质量与 Agentic UI 框架选型评估](dsh-web-ui-quality-and-agentic-ui-framework-assessment.md)：理解当前 UI 的工程质量、具体交互闭环、通用能力缺口和第三方方案的职责边界。
3. [Browser-Native Agent Loop 研究](dsh-browser-native-agent-loop-research.md)：理解 Agent Loop 驻留位置、浏览器 Tool、同源 LLM proxy 和相关生态。
4. [Browser-Native Runtime 研究](dsh-browser-native-runtime-research.md)：理解 Worker、Cloud Workspace、本机桥接、持久化和 owner handoff 的运行时限制。
5. [dsh-TUI 参考架构启发备忘](dsh-tui-reference-architecture-memo.md)：区分可迁移的 Session adapter、能力发布、回放和恢复纪律，以及不能迁移的 TTY/Node 主机假设。
6. [Browser-Native 实施方案](dsh-browser-native-agent-implementation-plan.md)：查看协议、包归属、测试矩阵、迁移和上线限制。
7. [Browser-Native PoC v2 规划与进度](browser-native-dsh-poc/browser-native-dsh-plan-v2.md)和[进度记录](browser-native-dsh-poc/browser-native-dsh-progress-v2.md)：区分设计提案与实际验证。
8. [assistant-ui + Browser-Native DSH 增量 PoC](assistant-ui-browser-native-dsh-poc/README.md)：验证第三方聊天层不另建 Agent Loop，如何通过 DSH Session Controller 接入真实 Worker Host。
9. [Browser-Native Durable Workspace 规划与进度](browser-native-dsh-poc/durable-workspace-plan.md)及[实施记录](browser-native-dsh-poc/durable-workspace-progress.md)：验证 OPFS/IndexedDB 本地 bytes、pending/retry 恢复和真实 DSH 文件工具在 Worker 重建后的行为；其中模型无关的 503 刷新恢复入口是 [durable-workspace-recovery.e2e.mjs](browser-native-dsh-poc/tests/durable-workspace-recovery.e2e.mjs)。
10. [Browser-Native 高价值验证计划](browser-native-dsh-poc/high-value-validation-plan.md)及[进度](browser-native-dsh-poc/high-value-validation-progress.md)：验证上传失败、commit unknown、Workspace writer lease/fencing、文件操作矩阵和 Session/Workspace receipt 协调；明确哪些仍未接入 Agent Loop。
11. [Browser-Native 下一批 P0 验证计划](browser-native-dsh-poc/next-high-value-validation-plan.md)及[实施进度](browser-native-dsh-poc/next-high-value-validation-progress.md)：Chrome 已验证本地 snapshot/blob 损坏时 fail closed、真实 IndexedDB abort 的错误与 retry 保留、真实 DSH `write` 工具产生 PoC-only Session receipt，以及 receipt append 中断后杀 Worker、刷新并重开同一 Session 的恢复；quota/eviction、浏览器进程崩溃和带 Workspace lease 的完整页面生命周期仍未验证。
12. [Browser-Native 下一批验证计划](browser-native-dsh-poc/next-round-validation-plan.md)及[进度](browser-native-dsh-poc/next-round-validation-progress.md)：三项真实 Chrome/Worker 验证均通过 scripted LLM，包括已提交 Workspace 缓存清除后重建、Agent `write → read → edit → write` 的 Session receipt 对账，以及同标签页刷新后含“resume 已成功但响应丢失”注入的 writer lease 恢复与旧 token fencing；真实模型、quota/eviction 和 OS 级浏览器进程崩溃未验证。
13. [Browser-Native 恢复边界验证计划](browser-native-dsh-poc/recovery-boundary-validation-plan.md)及[实测进度](browser-native-dsh-poc/recovery-boundary-validation-progress.md)：真实 Chrome 验证 DSH `write` 在本地 durable 前/后的 Worker 强制终止及 `TOOL_OUTCOME_UNKNOWN` 恢复、本地损坏数据导出、双标签 writer lease 倒计时重试与 fencing；Safari、真实模型和 OS 级浏览器崩溃未验证。
14. [Browser-Native 交互与恢复验证计划](browser-native-dsh-poc/browser-runtime-integrity-validation-plan.md)及[实测进度](browser-native-dsh-poc/browser-runtime-integrity-validation-progress.md)：Chrome/scripted LLM 验证默认问答与工作目录工具、清除浏览器缓存后 backend 503 时 fail-closed、真实 Worker 写权交接，并回归缓存重建和 mutation/snapshot crash window；自然 eviction、OS crash、Safari、多实例 backend 和真实模型工具选择未验证。
15. [Browser-Native 完整性与生命周期验证计划](browser-native-dsh-poc/next-integrity-and-lifecycle-plan.md)及[进度](browser-native-dsh-poc/next-integrity-and-lifecycle-progress.md)：真实 Chrome 验证冷 hydrate 分块 hash、OPFS orphan 保守回收、durable pagehide 本地屏障，以及 Session receipt、Workspace commit unknown 与 writer fencing 的组合恢复；不把结果外推为块级 delta、后台 Agent 或跨存储原子事务。
16. [OPFS 外置大文件的 DSH 工具闭环计划](browser-native-dsh-poc/opfs-agent-file-tools-validation-plan.md)及[进度](browser-native-dsh-poc/opfs-agent-file-tools-validation-progress.md)：真实 Chrome Worker/DSH Host 在 12 MiB 冷 hydrate 文件上验证 scripted `read → grep → edit → read` 和刷新恢复；后续 64 MiB copy-on-write edit 的当前资源证据见第 34 项，不沿用早期 materialize 路径的容量结论。Browser-native `grep`/`glob` 不等同 ripgrep。
17. [Browser-native 文件工具与载荷安全计划](browser-native-dsh-poc/browser-file-tools-validation-plan.md)及[进度](browser-native-dsh-poc/browser-file-tools-validation-progress.md)：验证 Worker 内置 `grep`/`glob`、搜索和编辑载荷上限、失败后继续以及取消 helper 后的 Worker 可用性；真实模型自主选工具仍未由本批证明。
18. [Browser-Native 能力预检与插件兼容性计划](browser-native-dsh-poc/browser-capability-preflight-plan.md)及[进度](browser-native-dsh-poc/browser-capability-preflight-progress.md)：集中声明 Worker profile 的能力，验证 boot 前 fail-closed 预检、默认 profile 的受限 Shell 语义和真实 LLM 独立 roster 回归；不把静态清单或模块加载外推为全部插件兼容。
19. [Workspace 持久化 metadata 与 blob 生命周期验证计划](browser-native-dsh-poc/durable-metadata-and-blob-lifecycle-validation-plan.md)及[进度](browser-native-dsh-poc/durable-metadata-and-blob-lifecycle-validation-progress.md)：验证 backend 冷启动对损坏 metadata 的 fail-closed、文件/MinIO blob GC 对跨 Workspace 引用和 pending upload 的保留，以及未知 staging metadata 的保守保留；不推断多实例对象存储安全或生产云行为。
20. [Browser-Native 深度运行时验证计划](browser-native-dsh-poc/next-deep-runtime-validation-plan.md)及[进度](browser-native-dsh-poc/next-deep-runtime-validation-progress.md)：验证长 Session 刷新 hydrate、同 turn 并行只读工具、`assistant/attempt` append 失败收束和大文件 materialize/external backing 边界；Safari、自然 eviction、OS crash、多实例 backend 和真实 LLM 大型 tool args 仍未验证。
21. [Browser-Native 会话目录与观察交接验证计划](browser-native-dsh-poc/next-catalog-observer-bridge-validation-plan.md)及[进度](browser-native-dsh-poc/next-catalog-observer-bridge-validation-progress.md)：验证初始 handoff receipt、Session catalog 分页、多观察者单写者和跨边界载荷预算；其中 handoff 安全结论已由第 22 项的后续复核取代，不外推为分布式 HA 或云端 Durable Worker。
22. [Browser-Native handoff 安全与恢复验证计划](browser-native-dsh-poc/next-handoff-security-and-recovery-plan.md)及[进度](browser-native-dsh-poc/next-handoff-security-and-recovery-progress.md)：修复并验证旧 owner 重放取回新 bearer、旧 receipt 凭据迁移、未结算工作拒绝、rename 后 unknown durability、响应丢失与并发 fencing；handoff 仍只转移 PoC Session 写权，不启动 Cloud Agent。
23. [Browser-Native handoff 安全点验证计划](browser-native-dsh-poc/next-session-handoff-safe-point-plan.md)及[进度](browser-native-dsh-poc/next-session-handoff-safe-point-progress.md)：由服务端从 DSH Session event log 判定 turn、step 与工具是否已结算；覆盖 caller 伪报 pending 列表、append/handoff 竞态和真实 Chrome Worker 活跃 turn，不宣称 Workspace/Session 双 lease 原子转移。
24. [Browser-Native timed HITL 生命周期验证计划](browser-native-dsh-poc/timed-hitl-lifecycle-validation-plan.md)及[进度](browser-native-dsh-poc/timed-hitl-lifecycle-validation-progress.md)：Chrome/Worker 验证同轮回答、超时迟答、刷新后原 callId 恢复和 durable answer 去重；活动问答 Stop 的后续验证见专门计划。
25. [Browser-Native 活动 HITL Stop 验证](browser-native-dsh-poc/active-hitl-stop-validation-plan.md)及[进度](browser-native-dsh-poc/active-hitl-stop-validation-progress.md)：官方问答 composer 的显式 Stop、legacy/timed DSH cancellation、continued question 负例和真实 LLM smoke。
26. [Browser-Native Session 传输可靠性验证](browser-native-dsh-poc/session-transport-resilience-validation-plan.md)及[进度](browser-native-dsh-poc/session-transport-resilience-validation-progress.md)：验证 append 限额切批、已提交响应丢失后的 seq 对账、连续 503 后恢复、Workspace receipt 单次结算与真实 LLM 冒烟；不宣称 pending outbox、Worker 终止恢复或 Session/Workspace 原子事务。
27. [Browser-Native Worker 启动前运行期能力探测](browser-native-dsh-poc/runtime-capability-probe-validation-plan.md)及[进度](browser-native-dsh-poc/runtime-capability-probe-validation-progress.md)：Chrome 验证 IndexedDB outbox、同源 backend 和可选 OPFS 的实际可用性；必要探测失败时不创建 Host、不发送 Session/LLM 请求，恢复后继续 scripted turn，并另行记录真实 LLM smoke。
28. [Browser-Native 运行期能力发布与撤销](browser-native-dsh-poc/runtime-capability-publication-validation-plan.md)及[进度](browser-native-dsh-poc/runtime-capability-publication-validation-progress.md)：验证 DSH Session request header 与模型 schema 一致、本地 Workspace durability 失败后撤销工具并拒绝迟到调用、云端 commit pending 与本地失败的区分，以及刷新后由新 Worker 恢复工具；quota 故障时序使用 scripted Chrome E2E，另有真实 LLM 普通读写烟测。
29. [Browser-Native Worker 控制通道连续性验证](browser-native-dsh-poc/next-control-channel-conformance-validation-plan.md)及[进度](browser-native-dsh-poc/next-control-channel-conformance-validation-progress.md)：验证页面与 Worker 控制帧的 `control-ready` 基线、连续 `channelId/seq`、重复去重、跳号/同序冲突 fail-closed 和刷新后的新通道；真实 LLM 只做普通文件 smoke，不把控制通道当作 Session event log。
30. [Browser-Native 控制通道载荷约束验证](browser-native-dsh-poc/next-control-payload-bounds-validation-plan.md)及[进度](browser-native-dsh-poc/next-control-payload-bounds-validation-progress.md)：验证 exact-key schema、4 KiB UTF-8 文本与 16 KiB JSON frame 上限、未知/循环数据拒绝、诊断脱敏及坏帧后的新 Worker 状态恢复；真实 LLM 只验证普通 DSH 文件闭环未受影响。
31. [Browser-Native 复制标签页恢复隔离验证](browser-native-dsh-poc/next-tab-recovery-isolation-validation-plan.md)及[进度](browser-native-dsh-poc/next-tab-recovery-isolation-validation-progress.md)：Chrome 复现并阻断 opener 复制 Workspace-only、Session-only 和完整恢复凭据；验证无 Web Locks fail-closed、刷新接管、旧 fencing 拒绝及同 Session 单次续聊。BFCache 只测合成 `pagehide.persisted`，不替代真实往返；真实 LLM smoke 单独验证普通文件恢复。
32. [Browser-Native Workspace 并发 revision 与长编辑 fencing](browser-native-dsh-poc/workspace-concurrent-revision-validation-plan.md)及[进度](browser-native-dsh-poc/workspace-concurrent-revision-validation-progress.md)：验证 observer read 与 owner commit 竞态、1,000-entry manifest 下轻量 revision API 的响应规模，以及 32 MiB OPFS edit 期间 writer lease 转移；Chrome scripted 竞态与真实 LLM 普通文件 smoke 分开记录，不外推为跨存储事务、多 backend HA 或生产对象存储。

33. [Browser-Native DSH 跨存储工具恢复验证](browser-native-dsh-poc/cross-store-tool-recovery-validation-plan.md)及[实施进度](browser-native-dsh-poc/cross-store-tool-recovery-validation-progress.md)：Chrome scripted DSH `write` 验证 receipt Session flush 已 durable、响应丢失后终止 Worker 并重启同 dataDir backend；刷新后不重放 prompt、工具或 commit，receipt outbox 对账完成。真实 LLM 普通文件闭环已单独完成；OS/自然存储故障、跨存储事务和流式 UI 响应性仍未验证。
34. [OPFS 标准工具资源包络验证](browser-native-dsh-poc/opfs-standard-tool-envelope-validation-plan.md)及[实施进度](browser-native-dsh-poc/opfs-standard-tool-envelope-validation-progress.md)：Chrome 验证 12/64 MiB 标准文件工具、4×16 MiB 冷工作集、Worker heap 采样与 64 MiB commit unknown 恢复；真实 LLM 普通文件 smoke 单独通过。该批记录完整变化文件上传；当前固定偏移复用的成本和限制见[分块复用计划](browser-native-dsh-poc/chunk-reuse-upload-validation-plan.md)及[进度](browser-native-dsh-poc/chunk-reuse-upload-validation-progress.md)。采样和算法计数不代表进程内存上限或全部 I/O。
35. [Browser-Native Workspace 内容定义分块验证](browser-native-dsh-poc/content-defined-chunking-validation-plan.md)及[实测进度](browser-native-dsh-poc/content-defined-chunking-validation-progress.md)：18 个 Chrome Dedicated Worker/OPFS workload 比较 gear-based CDC 与固定偏移上行估算、块长分布、读取和 hash 成本；8/8 核心移位场景达到准入门槛。合成原始结果见[Chrome 数据](browser-native-dsh-poc/content-defined-chunking-chrome-results.json)，实际上传与恢复另见[协议验证](browser-native-dsh-poc/content-upload-protocol-validation-progress.md)。
36. [Browser-Native 内容分块上传协议规划](browser-native-dsh-poc/content-upload-protocol-validation-plan.md)及[实施进度](browser-native-dsh-poc/content-upload-protocol-validation-progress.md)：显式 CDC 协商、实际缺块 HTTP 上传、来源授权、完整文件验证、同 operation 重启续传与服务端 I/O 成本；保留默认固定分块和完整 blob 权威。
37. [Browser-Native 不可变块对象存储规划](browser-native-dsh-poc/chunk-object-storage-validation-plan.md)及[实施进度](browser-native-dsh-poc/chunk-object-storage-validation-progress.md)：验证复用块引用、文件版本、pending GC、重启恢复与实际磁盘成本；完整文件 hash 和 manifest CAS 仍独立于块上传。

### 需要实现或审查代码时

优先阅读[实施方案](dsh-browser-native-agent-implementation-plan.md)，再读 [PoC 当前实现与限制](browser-native-dsh-poc/README.md)、[PoC v2 规划](browser-native-dsh-poc/browser-native-dsh-plan-v2.md)和对应的实现、测试文件。研究报告解释为什么这样设计；v2 规划定义目标，代码和测试确定实际字段、行为和验证范围。[旧版实验协议](browser-native-dsh-poc/protocol.md)只用于追溯独立实验，不能作为 v2 的当前协议说明。

### 研究 Cloud Agent 或 Durable Workspace 时

从[Cloud Agent 架构建议](dsh-cloud-agent-architecture-recommendation.md)开始，按需要进入[Cloud Agent OSS 全景](dsh-cloud-agent-oss-landscape-review.md)、[Cloud 项目本地代码阅读备忘](dsh-cloud-projects-local-code-reading-memo.md)、[部署与租户隔离](dsh-deployment-and-tenancy-deep-dive.md)和[Remote Durable Workspace](dsh-remote-durable-workspace-pgfs-research.md)。E2B/CubeSandbox 的对比文档用于具体基础设施选型，不是 Browser-Native Agentic UI 的前置阅读。

Browser-Native DSH 的云端 Workspace 增量同步实验从 [PoC 规划](browser-native-dsh-poc/cloud-backed-workspace-sync-plan.md)进入；[实施进度](browser-native-dsh-poc/cloud-backed-workspace-sync-progress.md)只记录已执行验证，不替代规划中的验收标准。浏览器本地 durable store 另见 [durable Workspace 规划](browser-native-dsh-poc/durable-workspace-plan.md)、[进度与经验教训](browser-native-dsh-poc/durable-workspace-progress.md)和 [变更账本](browser-native-dsh-poc/change-ledger.md)。

-----

## 研究总览

### 三条研究轴

当前研究围绕三个相互连接、但不能互相替代的轴展开：

| 研究轴 | 回答的问题 | 主要成果 |
|---|---|---|
| Interaction plane：Agentic UI | 用户在 Chat UI 中看到什么、操作什么，怎样复用已有 SaaS GUI，以及当前 Web UI 是否适合作为实现基础 | `dsh-agentic-ui-research.md`、`dsh-browser-native-agentic-ui-research.md`、`dsh-web-ui-quality-and-agentic-ui-framework-assessment.md` |
| Execution plane：Browser-Native | Agent Loop 在哪里运行，怎样访问浏览器状态和前端 Tool | `dsh-browser-native-agent-loop-research.md`、`dsh-browser-native-runtime-research.md`、`dsh-browser-native-vfs-cloud-sync-research.md`、PoC v2 |
| Durability plane：Cloud/Durable Agent | 页面退出、机器故障或长任务发生后，谁继续执行以及状态如何恢复 | Cloud Agent 系列、Remote Durable Workspace、实施方案中的 handoff 章节 |
| Coordination plane：Agent 协作 | 多个 agent 如何互相通信、共享任务状态，跨进程与跨厂商时用什么协议 | `dsh-agent-collaboration-research.md` |

三条轴合并后的目标拓扑是：

```text
Main Thread
  existing SaaS UI + typed capability registry + user gesture
        ↕ MessageChannel
Dedicated Worker
  DSH Agent Loop + Tool registry + Session projection
        ↕ same-origin HTTPS
Backend
  LLM proxy + identity/tenant authorization + business API + Session authority
        ↕ explicit handoff
Durable Worker / Job
  long-running or background execution
```

### 一句话结论

Browser-Native Agentic UI 不是“模型生成任意 HTML”，而是“浏览器中的 DSH Agent Loop 通过类型化、版本化、受授权的 UI capability 复用既有 SaaS GUI；Main Thread 负责界面和用户手势，服务端负责业务授权、权威副作用和长期任务，Session 负责模型可见事实的回放与恢复”。

### 研究成果之间的依赖关系

```text
Agentic UI 事实核查
  → Web UI 质量与框架选型评估
  → Browser-Native Agent Loop 研究
  → Browser-Native Runtime 研究
  → Browser-Native 实施方案
  → Browser-Native DSH PoC v2
  → 综合 Agentic UI 方案
```

这不是严格的提交或实现顺序，而是读者理解问题的推荐顺序。综合报告把产品命题、运行时边界和 PoC 事实合并；PoC 仍然是“已实现/已验证”最重要的证据入口。

-----

## 推荐阅读路径

### 路径 A：产品和交互设计

适合回答“为什么要把已有 SaaS GUI 带进 Chat UI、这和 Generative UI 有什么区别”。

1. [DSH Agentic UI 事实核查](dsh-agentic-ui-research.md)
2. [综合 Agentic UI 报告](dsh-browser-native-agentic-ui-research.md)
3. [综合报告中的 Typed UI Capability 设计](dsh-browser-native-agentic-ui-research.md#typed-ui-capability-设计)
4. [综合报告中的客户创建时序](dsh-browser-native-agentic-ui-research.md#完整业务时序客户创建)

### 路径 A.1：Web UI 和框架选型

适合回答“当前 DSH Web UI 的实现质量如何、应该改造还是引入第三方框架”。

1. [DSH Web UI 实现质量与 Agentic UI 框架选型评估](dsh-web-ui-quality-and-agentic-ui-framework-assessment.md)
2. [assistant-ui 与 CopilotKit：Browser-Native DSH 的长期 UI 选型](assistant-ui-copilotkit-browser-native-dsh-assessment.md)：核查框架能力，并判断未来是否值得替换聊天或应用交互职责。
3. [CopilotKit Browser-Native DSH PoC](copilotkit-browser-native-dsh-poc/README.md)：实测聊天内 SaaS 工作项操作和 DSH tool/session 闭环。
4. [成熟 SaaS 三路线同口径实验](saas-agentic-ui-comparison-poc/README.md)：同一业务组件/API 下的基础路线对照。
5. [复杂续约实验](saas-agentic-ui-comparison-poc/complex/README.md)：assistant-ui 与 CopilotKit 同口径验证批量业务交互；DSH 原生 UI 保留 scripted 对照，真实模型矩阵不等量。
6. [Web Client architecture](../subsystems/web-client.md)
7. [Web Client Slots](../subsystems/slots.md)

### 路径 B：运行时和协议实现

适合回答“怎样把 Agent Loop 放进 Worker、怎样调用模型、怎样持久化和恢复”。

1. [Browser-Native Agent Loop 研究](dsh-browser-native-agent-loop-research.md)
2. [Browser-Native Runtime 研究](dsh-browser-native-runtime-research.md)
3. [Browser-Native 实施方案](dsh-browser-native-agent-implementation-plan.md)
4. [Browser-Native VFS 与云端增量同步调研](dsh-browser-native-vfs-cloud-sync-research.md)：默认插件持久化分类、Session append-only 边界、Workspace manifest/blob/chunk、outbox、冲突与 Session/Workspace reconciliation。
5. [PoC v2 当前实现与限制](browser-native-dsh-poc/README.md#当前实现快照)
6. [PoC v2 进度](browser-native-dsh-poc/browser-native-dsh-progress-v2.md)
7. [Durable Workspace 规划](browser-native-dsh-poc/durable-workspace-plan.md)与[进度/经验教训](browser-native-dsh-poc/durable-workspace-progress.md)：区分 OPFS/IndexedDB 本地恢复能力、云端 commit 和尚未消除的 post-commit 崩溃窗口。
8. [进阶恢复验证计划](browser-native-dsh-poc/advanced-recovery-validation-plan.md)与[进度/经验教训](browser-native-dsh-poc/advanced-recovery-validation-progress.md)：真实 Chrome 验证离线 retry、CAS 冲突保留和 writer lease 过期接管。
9. [存储隔离与重启验证计划](browser-native-dsh-poc/storage-isolation-and-restart-validation-plan.md)与[进度](browser-native-dsh-poc/storage-isolation-and-restart-validation-progress.md)：Chrome 验证 quota 类写失败、backend 重启租约 fencing 和同源多身份 Workspace 隔离。
10. [文件工具持久化确认计划](browser-native-dsh-poc/durable-tool-ack-validation-plan.md)与[进度/经验教训](browser-native-dsh-poc/durable-tool-ack-validation-progress.md)：真实 DSH `write` 在 IndexedDB 保存失败时写入 Session 错误；同 Session 显式重试验证本地 durable 状态、Workspace commit 和 Session receipt 对齐。
11. [易失文件状态隔离计划](browser-native-dsh-poc/volatile-workspace-isolation-plan.md)与[进度/经验教训](browser-native-dsh-poc/volatile-workspace-isolation-progress.md)：真实 Chrome 验证 IndexedDB 持久化失败后 Agent 不能读取、搜索或继续修改仅存在 Worker 内存的文件；刷新恢复 durable 基线，再由同 Session 新调用显式重试。
12. [运行时完整性验证计划](browser-native-dsh-poc/next-runtime-integrity-validation-plan.md)与[进度](browser-native-dsh-poc/next-runtime-integrity-validation-progress.md)：Chrome/scripted E2E 验证活动 Worker lease heartbeat 和续租故障恢复、Workspace 初始化失败停止续租、Agent 写入未知 commit 与 backend 重启、HITL 等待期间刷新后的诚实中断及同 Session 新 turn 续聊，以及 IndexedDB 前向版本 fail-closed 和恢复导出；原问答 Promise 不跨刷新恢复。

13. [文件规模与分块传输验证计划](browser-native-dsh-poc/large-file-scale-validation-plan.md)与[进度](browser-native-dsh-poc/large-file-scale-validation-progress.md)：验证 1 MiB Workspace chunk staging、缺块续传、hash/size 校验、backend 重启、OPFS 分块写入、16/64 MiB Chrome 文件和 1,000 小文件；明确仍有完整 `MemoryVfs` bytes、完整下载组装、独立 Session JSON 上限和 PoC 本地 backend 限制。
14. [故障边界与存储后端验证计划](browser-native-dsh-poc/mock-and-crash-boundary-validation-plan.md)与[实测进度](browser-native-dsh-poc/mock-and-crash-boundary-validation-progress.md)：真实 Chrome 验证 OPFS/IndexedDB 单侧丢失、Chrome `SIGKILL` 后身份缺口、双 backend 共用 `dataDir` 的数据覆盖、大型 tool args 安全拒绝，以及 MinIO blob 上传、Range 读取、outage、对象丢失恢复和 backend 重启；自然 eviction、OS/磁盘 crash、真实模型大参数和生产云存储未验证。
15. [容量与进程安全验证计划](browser-native-dsh-poc/next-capacity-and-process-safety-plan.md)与[进度](browser-native-dsh-poc/next-capacity-and-process-safety-progress.md)：真实 Chrome 已验证 OPFS sync-handle range backing 让已提交 Workspace 文件在刷新后不驻留 VFS heap，并验证 `dataDir` 单写者、第二实例 fail-closed、`SIGKILL` 后冷启动恢复和 operation replay；不将本机单写者锁说成 HA，也明确 hydrate 的临时完整校验读取。
16. [文件工具下一批验证计划](browser-native-dsh-poc/browser-file-tools-next-validation-plan.md)与[进度](browser-native-dsh-poc/browser-file-tools-next-validation-progress.md)：验证 Worker 内结构化 `grep`/`glob` 的遍历、分块 UTF-8、结果预算、二进制拒绝、取消和失败后继续；明确不引入完整 Shell/WASI runtime，也不把文件级分块读取写成块级同步。
19. [Browser-Native 文件搜索隔离计划](browser-native-dsh-poc/browser-file-search-isolation-validation-plan.md)及[进度](browser-native-dsh-poc/browser-file-search-isolation-validation-progress.md)：真实 Chrome DSH turn 验证内容 regex、grep `include` 与 glob matcher 的可终止 Worker、单批超时、超长行拒绝、取消及失败后继续；真实 LLM 只覆盖普通 grep，不证明恶意输入下的模型行为。
20. [Browser-Native 模型流故障验证计划](browser-native-dsh-poc/llm-stream-failure-validation-plan.md)及[进度](browser-native-dsh-poc/llm-stream-failure-validation-progress.md)：真实 Chrome/DSH Worker 验证文本和工具流半包、Worker 流中止刷新、Stop/上游取消与 Session/Workspace fail-closed 语义；fake upstream 只验证代理取消传播，真实供应商自然断流仍未验证。

### 路径 C：直接复现 PoC

适合需要运行、修改或审查现有实验代码的开发者。

1. [PoC README](browser-native-dsh-poc/README.md)：入口、运行命令和当前边界。
2. [v2 规划](browser-native-dsh-poc/browser-native-dsh-plan-v2.md)：为什么选择现有 preview、Worker profile 和 provider injection。
3. [v2 当前实现快照](browser-native-dsh-poc/README.md#当前实现快照)：正式 Session DTO、owner token、30 秒 lease/续租和持久化语义，以及尚未实现的请求幂等账本、跨进程 owner epoch 和完整恢复目标。
4. [v2 backend](browser-native-dsh-poc/backend-v2.mjs)、[Worker](browser-native-dsh-poc/browser-native-worker.ts)和[providers](browser-native-dsh-poc/browser-native-providers.ts)：实现入口。
5. [backend contract tests](browser-native-dsh-poc/tests/backend-v2.test.mjs)和[browser E2E](browser-native-dsh-poc/tests/browser-native-v2.e2e.mjs)：行为证据。
6. [手动验收说明](browser-native-dsh-poc/manual-acceptance.md)：真实浏览器、工具调用、多轮记忆、流式输出、刷新续接和故障排查。
7. [工具连续尝试事实核查](browser-native-dsh-poc/agent-loop-tool-attempt-analysis.md)：用真实 Session 解释工具可见性、模型决策、默认 Agent Loop 和 Browser-Native 能力缺口之间的关系。
8. [工具清单与配置裁剪调研](browser-native-dsh-poc/browser-native-tool-roster-and-configuration-research.md)：核查 profile、agent preset、`tool-web` 开关和 Browser-specific capability 的设计边界。
9. [运行时验证报告](browser-native-dsh-poc/runtime-validation-report.md)与[下一轮验证进度](browser-native-dsh-poc/next-validation-progress.md)：区分 Chrome 最新复测、历史 WebKit/Safari 结果和未验证的生产边界。
10. [进阶恢复 E2E 测试](browser-native-dsh-poc/advanced-recovery-validation-progress.md)：包含可复制命令、fencing/冲突证据、已知限制和旧标签页安全拒绝表现。
11. [存储隔离与重启 E2E](browser-native-dsh-poc/storage-isolation-and-restart-validation-progress.md)：查看 quota fault 注入与 durable retry、单 backend 重启后的 lease epoch，以及共享 origin 存储中的身份隔离结果。
12. [Agent 文件工具 durable ack E2E](browser-native-dsh-poc/tests/agent-workspace-durable-ack.e2e.mjs)：复现并验证本地保存失败不再成为成功工具结果，随后同会话重试只提交一次。
13. [Agent 易失文件状态隔离 E2E](browser-native-dsh-poc/tests/agent-workspace-volatile-failure.e2e.mjs)：验证失败的 `edit`、被阻止的 `read`/`grep`/`glob`/`write`、Worker 刷新恢复与同 Session 显式重试。
14. [Agent Workspace 崩溃窗口 E2E](browser-native-dsh-poc/tests/agent-workspace-crash-window.e2e.mjs)：真实 DSH `write` 在 OPFS/IndexedDB 保存前后终止 Worker，核对 Session recovery、远端 commit、禁止重放和同 Session 续聊。
15. [本地 corruption 恢复包 Chrome E2E](browser-native-dsh-poc/tests/durable-workspace-corruption.e2e.mjs)：验证损坏 metadata、缺失 blob、hash mismatch 的本地导出保留与远端不变。
16. [双标签 writer lease Chrome E2E](browser-native-dsh-poc/tests/workspace-writer-expiry.e2e.mjs)：验证冲突提示、倒计时重试、释放后接管和旧 fencing token 拒绝。
17. [运行时完整性验证 E2E](browser-native-dsh-poc/next-runtime-integrity-validation-progress.md)：包含五项新 Chrome E2E 与 lease 回归的实际命令、结果和限制。
18. [故障边界验证 E2E](browser-native-dsh-poc/mock-and-crash-boundary-validation-progress.md)：记录五类新验证的 Chrome/Node/MinIO 版本、命令、失败观察、恢复结果和明确限制。
19. [可写分块编辑验证](browser-native-dsh-poc/chunk-backed-edit-validation-progress.md)：记录 64 MiB OPFS copy-on-write 原型、六个故障点、资源预算和当前 DSH `edit` 的 materialize 对照。
20. [External reference 编辑验证](browser-native-dsh-poc/reference-backed-edit-validation-progress.md)：记录 external reference 接入 `MemoryVfs` mutation、Workspace range cache/upload、manifest CAS、compact receipt、真实 Chrome 刷新恢复和失败重试；明确不是正式 `edit` 或块级 delta。
21. [External reference Agent Loop 验证](browser-native-dsh-poc/external-edit-agent-loop-validation-progress.md)：验证标准 DSH `edit` 的 Session durable 屏障、Workspace commit unknown/backend 重启恢复、OPFS 句柄恢复 fallback，以及并发 CAS conflict 下 local/remote 版本均不被静默覆盖。

### 路径 D：Cloud Agent 和长期执行

适合回答“浏览器不在线时谁继续工作、Cloud Workspace 怎样和 Agent 工具保持一致”。

1. [Cloud Agent 架构建议](dsh-cloud-agent-architecture-recommendation.md)
2. [Cloud SaaS Agent 研究](dsh-cloud-saas-agent-research.md)
3. [部署与租户隔离深度调研](dsh-deployment-and-tenancy-deep-dive.md)
4. [Remote Durable Workspace](dsh-remote-durable-workspace-pgfs-research.md)
5. [E2B 与 CubeSandbox 深度对比](dsh-e2b-vs-cubesandbox-deep-comparison.md)
6. [CubeSandbox 深度调研](dsh-cubesandbox-deep-research.md)

### 路径 E：多 agent 协作与跨进程协议

适合回答“两个独立运行的 agent 如何互相通信、共享任务状态，跨机器时用什么协议”。

1. [DSH Agent 协作深度调研](dsh-agent-collaboration-research.md)：区分委派与 peer 协作，核实 Agent Teams 的单进程边界与 Session 单写者约束，并提出尚未实现的 broker + peer 插件方案与 ACP／A2A 选型。

-----

## Agentic UI 与 Browser-Native

| 文档 | 角色 | 读者应带走的结论 |
|---|---|---|
| [dsh-agentic-ui-research.md](dsh-agentic-ui-research.md) | 产品命题、外部事实核查、DSH 代码考古 | Agent 应复用既有 SaaS 能力和 UI，而不是生成第二套业务系统；当前 DSH 有 Tool、Session、Tool view 和 Conversation Node 扩展点，但没有现成 CRM Agentic UI 协议。 |
| [dsh-browser-native-agent-loop-research.md](dsh-browser-native-agent-loop-research.md) | Browser-Native 定义、生态比较、DSH 缺口 | 完整 Browser-Native Agent 要让 Loop 驻留 Dedicated Worker；同源 LLM proxy、结构化 UI state、前端 Tool 和 owner 语义都必须明确。 |
| [dsh-browser-native-runtime-research.md](dsh-browser-native-runtime-research.md) | Worker、Cloud Workspace、本机桥接、持久化和恢复 | Worker 不是 durable daemon，浏览器隔离不是业务授权；执行世界、存储、owner 和 handoff 必须分别建模。 |
| [dsh-browser-native-agent-implementation-plan.md](dsh-browser-native-agent-implementation-plan.md) | 工程实施方案 | 复用 DSH Loop 和 Session；用独立 `/api/llm`、Main/Worker typed bridge、profile 分类、owner fencing 和 durable handoff 逐阶段落地。 |
| [dsh-browser-native-agentic-ui-research.md](dsh-browser-native-agentic-ui-research.md) | 两类研究的综合报告 | 三份 PoC 后的推荐架构；区分已跑通的 mock 业务 UI、未验收的原生前端工具调度和生产业务安全。 |
| [dsh-web-ui-quality-and-agentic-ui-framework-assessment.md](dsh-web-ui-quality-and-agentic-ui-framework-assessment.md) | 三条聊天/Agentic UI 路线与同口径业务实验 | 相同业务闭环三者都能做；assistant-ui 是轻量接入评估基线，CopilotKit 是额外应用交互设施候选，DSH Web UI 适合接受其装配体系的产品。 |
| [assistant-ui-copilotkit-browser-native-dsh-assessment.md](assistant-ui-copilotkit-browser-native-dsh-assessment.md) | 第三方框架事实核查与长期演进 | 不把 assistant-ui 限定为普通聊天，也不把 v1 CopilotKit PoC 外推到 v2；同一真实业务流程决定最终选择。 |
| [copilotkit-browser-native-dsh-poc/README.md](copilotkit-browser-native-dsh-poc/README.md) | CopilotKit + Browser-Native DSH 可运行 PoC | 验证既有 SaaS mock 工作台数据进入 Agent 对话、聊天内编辑/确认业务操作并结算回原 DSH turn；真实业务 API 仍未接入。 |
| [saas-agentic-ui-report-review.md](saas-agentic-ui-report-review.md) | 外部 SaaS Agentic UI 报告的事实核查与整合 | 保留 Agentic UI 评估轴、Controlled/Declarative/Open-ended 光谱和业务 capability 配方；修正 CopilotKit 默认化、Open-JSON-UI 官方化和行业已收敛等过度表述。 |
| [browser-native-dsh-poc/agent-loop-tool-attempt-analysis.md](browser-native-dsh-poc/agent-loop-tool-attempt-analysis.md) | Browser-Native 工具尝试事实核查 | 工具连续调用由 LLM 根据可见工具、系统提示和前一步结果生成；DSH Loop 负责执行、记录和推进，不内置本次天气问题的固定 bash 重试次数。 |
| [browser-native-dsh-poc/browser-native-tool-roster-and-configuration-research.md](browser-native-dsh-poc/browser-native-tool-roster-and-configuration-research.md) | Browser-Native 工具清单与配置裁剪 | 可以通过 profile/preset 配置移除不适用工具；当前 PoC 仍缺少 Browser-specific preset，Browser 工具应按 UI、业务 API、授权和 durable job 重新设计。 |

-----

## Web UI 质量与框架选型

专题结论见[路线重评](dsh-web-ui-quality-and-agentic-ui-framework-assessment.md#三份-poc-后的路线重评)：原生 UI 内部扩展性不等于外部 SaaS 低迁移成本；相同业务流程已经在三条路线通过 mock 对照。选择应比较组件接线、交互设施与维护成本，而不是沿用旧 PoC 的不等价功能排名。

这不是永久采用某一框架的决定。真实产品仍须验证自身复杂组件、认证态、API 和设计系统；同口径实验不替代生产试点。CopilotKit 已使用固定版本 `/v2` API，但原生前端工具调度与生产注入支持仍未验收，不能把 renderer 的闭环外推成全部框架能力已验证。

## 外部 SaaS Agentic UI 报告审阅

[外部 SaaS Agentic UI 报告审阅](saas-agentic-ui-report-review.md)记录对 `/Users/yangjiefeng/Downloads/SaaS引入Agentic-UI深度调研报告.md` 的事实核查。它保留“Agentic UI 不等于聊天气泡”、Controlled/Declarative/Open-ended 光谱、业务 capability 配方和治理反模式，同时修正 CopilotKit 默认化、Open-JSON-UI 官方化、A2UI 版本和“行业已经收敛”等过度表述。

-----

## Cloud Agent、Durability 与隔离

| 文档 | 角色 | 适合什么时候读 |
|---|---|---|
| [dsh-cloud-saas-agent-research.md](dsh-cloud-saas-agent-research.md) | Cloud SaaS Agent 的架构与产品问题 | 需要理解云端 Agent 的执行、会话、工作区、租户和运营面。 |
| [dsh-cloud-agent-oss-landscape-review.md](dsh-cloud-agent-oss-landscape-review.md) | 开源 Cloud Agent 项目全景 | 需要比较开源项目的运行时、隔离、持久化和可借鉴边界。 |
| [dsh-cloud-agent-architecture-recommendation.md](dsh-cloud-agent-architecture-recommendation.md) | 面向 DSH 的 Cloud Agent 架构建议 | 需要从全景研究收敛到 DSH 的架构选择。 |
| [dsh-cloud-projects-local-code-reading-memo.md](dsh-cloud-projects-local-code-reading-memo.md) | 外部 Cloud 项目源码阅读备忘 | 需要核对具体项目源码，而不是只看项目介绍。 |
| [dsh-deployment-and-tenancy-deep-dive.md](dsh-deployment-and-tenancy-deep-dive.md) | 部署、租户、网络和资源隔离 | 需要评估多租户上线和安全边界。 |
| [dsh-remote-durable-workspace-pgfs-research.md](dsh-remote-durable-workspace-pgfs-research.md) | Remote Durable Workspace / PostgreSQL-backed filesystem | 需要让 Shell、Git、LSP 和 `ctx.fs` 共享一个可持久化工作区。 |
| [dsh-e2b-vs-cubesandbox-deep-comparison.md](dsh-e2b-vs-cubesandbox-deep-comparison.md) | E2B 与 CubeSandbox 选型对比 | 需要选择具体 sandbox 基础设施。 |
| [dsh-cubesandbox-deep-research.md](dsh-cubesandbox-deep-research.md) | CubeSandbox 单项深度调研 | 需要进一步研究 CubeSandbox 的存储、网络和自托管能力。 |

Cloud/Durable 研究回答的是 Browser-Native 的“后半程”：浏览器适合主持当前交互，但长期任务、业务副作用和跨设备恢复需要服务端或 Durable Worker 接管。它们不是 Agentic UI 的替代实现，而是 Browser-Native UI 要想生产化时必须接上的持久化和 ownership 层。

-----

## 工程实现与运营

| 文档 | 角色 | 适合什么时候读 |
|---|---|---|
| [dsh-developer-reading-guide.md](dsh-developer-reading-guide.md) | DSH 代码库阅读路线和架构定位 | 新开发者需要从架构、包边界和入口开始阅读代码时。 |
| [dsh-herdr-agent-management-research.md](dsh-herdr-agent-management-research.md) | DSH Agent 与 Herdr 状态观察、reporter 和恢复 | 需要把 Agent 状态接入外部终端管理或 watchdog 时。 |
| [dsh-agent-collaboration-research.md](dsh-agent-collaboration-research.md) | DSH agent 之间的协作形态、跨进程边界与协议选型 | 需要让多个 agent 互相通信、共享任务状态，或评估 ACP／A2A 时。 |
| [dsh-research-branch-push-memo.md](dsh-research-branch-push-memo.md) | 研究分支提交、推送和文档登记流程 | 需要把新的研究草稿安全存档到当前研究分支时。 |

这些文档不是 Browser-Native Agentic UI 的产品设计，但提供了实现研究所需的代码阅读、外部状态观察和研究分支维护入口。

-----

## Browser-Native PoC 目录地图

### 当前 v2 的事实入口

| 文件 | 事实所有权 |
|---|---|
| [README.md](browser-native-dsh-poc/README.md) | 运行入口、v2 当前快照、验证命令、目录边界和历史版本说明。 |
| [browser-native-dsh-plan-v2.md](browser-native-dsh-poc/browser-native-dsh-plan-v2.md) | v2 设计目标、接入决策、profile、backend 协议要求和验收定义；不代表条目均已实现。 |
| [browser-native-dsh-progress-v2.md](browser-native-dsh-poc/browser-native-dsh-progress-v2.md) | 当前人工验收、测试结果、已修复缺口和未完成范围。 |
| [manual-acceptance.md](browser-native-dsh-poc/manual-acceptance.md) | 两个 PoC 共用的启动命令、手动验收脚本、Session 证据和故障排查。 |
| [change-ledger.md](browser-native-dsh-poc/change-ledger.md) | PoC 目录外接线、upstream 重放和删除条件。 |
| [runtime-validation-report.md](browser-native-dsh-poc/runtime-validation-report.md) | Chrome 最新复测与历史 WebKit/Safari 部分证据；记录真实模型、VFS、Session、刷新和 Worker 生命周期的验证矩阵及限制。 |
| [runtime-validation-manual.md](browser-native-dsh-poc/runtime-validation-manual.md) | 可复制的 scripted/real E2E、Chrome 长回复流式观测、浏览器存储探测、生命周期测试和人工验收步骤；后续浏览器复测仅用 Chrome。 |
| [tests/browser-storage-boundary.e2e.mjs](browser-native-dsh-poc/tests/browser-storage-boundary.e2e.mjs) | 已有 Chrome/WebKit 的 Storage API 与 OPFS 能力探测结果，不替代 DSH Session durability；本轮不复跑 WebKit。 |
| [next-validation-plan.md](browser-native-dsh-poc/next-validation-plan.md) / [进度](browser-native-dsh-poc/next-validation-progress.md) | 已完成批次的 Chrome 运行时验证计划与进度；Safari 测试按当前安排暂停。 |
| [cloud-backed-workspace-sync-plan.md](browser-native-dsh-poc/cloud-backed-workspace-sync-plan.md) | 云端 Workspace 同步 PoC 的目标、协议、验收标准和仍未完成的浏览器压力/生产化工作。 |
| [cloud-backed-workspace-sync-progress.md](browser-native-dsh-poc/cloud-backed-workspace-sync-progress.md) | 已执行的 Workspace 同步证据：真实 Chrome/LLM 四轮闭环、文件变更矩阵、OS backend 重启、8 客户端协议并发、失败观察和限制。 |
| [durable-workspace-plan.md](browser-native-dsh-poc/durable-workspace-plan.md) / [durable-workspace-progress.md](browser-native-dsh-poc/durable-workspace-progress.md) | 浏览器本地 OPFS/IndexedDB durable Workspace 规划、实现进度、503 刷新恢复证据和未完成故障矩阵。 |
| [shared-workspace-observer-validation-plan.md](browser-native-dsh-poc/shared-workspace-observer-validation-plan.md) / [进度](browser-native-dsh-poc/shared-workspace-observer-validation-progress.md) | 两个独立 Session 共享单 writer Workspace 的只读 observer、stale revision 拒绝、共享 retry snapshot 隔离、显式刷新接管和 fencing 证据；真实 LLM 普通文件 smoke 与 scripted 并发验收分开记录。 |
| [workspace-concurrent-revision-validation-plan.md](browser-native-dsh-poc/workspace-concurrent-revision-validation-plan.md) / [进度](browser-native-dsh-poc/workspace-concurrent-revision-validation-progress.md) | Observer 工具前后 revision 校验、revision-only 响应规模、工具执行期间 owner commit 的真实 Chrome 竞态，以及 32 MiB OPFS edit 期间 lease 转移后的旧 writer fencing。 |
| [operational-envelope-validation-plan.md](browser-native-dsh-poc/operational-envelope-validation-plan.md) / [进度](browser-native-dsh-poc/operational-envelope-validation-progress.md) | 上游 release merge 后的四个验证交付面：默认 Browser 工具清单、lazy archive 和插件兼容矩阵、Chrome 多负载容量基线、quota 与正常进程重启恢复；Safari、自然 eviction 和 OS crash 仍未验证。 |
| [mock-and-crash-boundary-validation-plan.md](browser-native-dsh-poc/mock-and-crash-boundary-validation-plan.md) / [进度](browser-native-dsh-poc/mock-and-crash-boundary-validation-progress.md) | 局部浏览器存储丢失、Chrome `SIGKILL`、多 backend 竞争、大型工具参数和 MinIO blob 验证；记录身份恢复与共享 `dataDir` 限制，不把故障注入外推为自然 eviction、OS crash 或生产对象存储。 |
| [browser-lifecycle-ownership-validation-plan.md](browser-native-dsh-poc/browser-lifecycle-ownership-validation-plan.md) / [进度](browser-native-dsh-poc/browser-lifecycle-ownership-validation-progress.md) | 首次 Session/Workspace claim 竞争、冻结页面时 Worker 续租、身份 cookie 丢失导出、Chrome BFCache 诊断及 1/4/8 Worker 容量；真实 BFCache 未命中，容量数据为单机诊断。 |
| [operational-compatibility-matrix.md](browser-native-dsh-poc/operational-compatibility-matrix.md) | 当前 checkout 中真实 Chrome Worker 已执行、由同源 backend 提供、明确排除和逐插件尚未验证的能力；不把模块加载视为插件兼容。 |
| [timed-hitl-lifecycle-validation-plan.md](browser-native-dsh-poc/timed-hitl-lifecycle-validation-plan.md) / [进度](browser-native-dsh-poc/timed-hitl-lifecycle-validation-progress.md) | 临时 timed schema 的截止前答案、迟答、刷新恢复、迟答去重和关闭恢复；显式 Stop 由活动 HITL 专项验证。 |
| [active-hitl-stop-validation-plan.md](browser-native-dsh-poc/active-hitl-stop-validation-plan.md) / [进度](browser-native-dsh-poc/active-hitl-stop-validation-progress.md) | 官方问答 composer 注入 Session-scoped cancel；Chrome scripted E2E 覆盖 legacy/timed 活动问答、continued 负例、Session aborted 与无 Workspace 副作用；真实 LLM smoke 单独记录。 |
| [browser-runtime-integrity-validation-plan.md](browser-native-dsh-poc/browser-runtime-integrity-validation-plan.md) / [进度](browser-native-dsh-poc/browser-runtime-integrity-validation-progress.md) | 默认交互工具闭环、本地缓存清除后的 backend outage fail-closed、双标签 Worker 写权交接及既有恢复路径回归；脚本使用 scripted LLM，真实模型和生产级故障仍未验证。 |
| [next-integrity-and-lifecycle-plan.md](browser-native-dsh-poc/next-integrity-and-lifecycle-plan.md) / [进度](browser-native-dsh-poc/next-integrity-and-lifecycle-progress.md) | 冷 hydrate 分块与增量 hash、OPFS orphan 回收、pagehide 本地 durable barrier、Session/Workspace/lease 组合恢复；包含真实 Chrome 命令和未覆盖边界。 |
| [tests/default-interaction-tools.e2e.mjs](browser-native-dsh-poc/tests/default-interaction-tools.e2e.mjs) | Chrome 中验证用户问答、工作目录切换和相对路径文件写入进入同一 DSH turn 与 Workspace。 |
| [tests/timed-hitl-lifecycle.e2e.mjs](browser-native-dsh-poc/tests/timed-hitl-lifecycle.e2e.mjs) | Chrome 中验证 timed HITL 的同轮/迟答、两类刷新恢复、隐藏面板恢复，以及 timed/legacy 活动 Stop 和 continued-question 隔离。 |
| [tests/workspace-cache-backend-unavailable.e2e.mjs](browser-native-dsh-poc/tests/workspace-cache-backend-unavailable.e2e.mjs) | 清除 OPFS/IndexedDB 后注入 manifest 503，验证页面与 Worker 不把空 Workspace 标成已同步。 |
| [tests/workspace-worker-handoff.e2e.mjs](browser-native-dsh-poc/tests/workspace-worker-handoff.e2e.mjs) | 两个真实 preview Worker 交接 Workspace lease，验证 fencing token 递增、旧 token 被拒和同 Session 文件工具续接。 |
| [tests/shared-workspace-observer.e2e.mjs](browser-native-dsh-poc/tests/shared-workspace-observer.e2e.mjs) | Chrome 双标签启动不同 Session，共享 Workspace 的只读 observer、dirty retry 隔离、stale read、显式 refresh、旧 fencing 拒绝和 Session receipt 对账。 |
| [tests/workspace-lease-edit-race.e2e.mjs](browser-native-dsh-poc/tests/workspace-lease-edit-race.e2e.mjs) | Chrome 双 Worker 在 OPFS 长 edit 中转移 Workspace writer lease，核对旧 edit 不发布、新 owner receipt/revision 与最终远端内容。 |
| [tests/first-claim-race.e2e.mjs](browser-native-dsh-poc/tests/first-claim-race.e2e.mjs)、[tests/page-freeze-lease-fencing.e2e.mjs](browser-native-dsh-poc/tests/page-freeze-lease-fencing.e2e.mjs)、[tests/identity-cookie-loss.e2e.mjs](browser-native-dsh-poc/tests/identity-cookie-loss.e2e.mjs)、[tests/real-bfcache-lifecycle.e2e.mjs](browser-native-dsh-poc/tests/real-bfcache-lifecycle.e2e.mjs)、[tests/browser-worker-placement-capacity.e2e.mjs](browser-native-dsh-poc/tests/browser-worker-placement-capacity.e2e.mjs) | Chrome 生命周期与写权 E2E：首次 claim 单胜者、冻结页面期间 Worker 续租、身份丢失 fail-closed 与恢复导出、真实 BFCache 拒绝原因和 1/4/8 Worker scripted 容量。 |
| [tests/cold-hydrate-integrity.e2e.mjs](browser-native-dsh-poc/tests/cold-hydrate-integrity.e2e.mjs) | 真实 Chrome 验证远端 Workspace 文件冷启动按 1 MiB chunk 写入 OPFS、range backing、hash 错误 fail-closed 和低 VFS 驻留。 |
| [tests/orphan-blob-reconciliation.e2e.mjs](browser-native-dsh-poc/tests/orphan-blob-reconciliation.e2e.mjs) | 真实 Chrome 验证 metadata transaction abort 后只回收无引用 OPFS blob，metadata 缺失时保留并报告 corruption。 |
| [tests/pagehide-local-barrier.e2e.mjs](browser-native-dsh-poc/tests/pagehide-local-barrier.e2e.mjs) | 真实 Chrome 验证 durable pagehide 的 Worker 本地 flush、ack/终止和 BFCache 保留语义。 |
| [opfs-agent-file-tools-validation-plan.md](browser-native-dsh-poc/opfs-agent-file-tools-validation-plan.md) / [进度](browser-native-dsh-poc/opfs-agent-file-tools-validation-progress.md) | 冷 hydrate 的 OPFS 外置大文件经 DSH `read`/`grep`/`edit`、Workspace receipt 和刷新后同 Session 读取；明确 scripted 大文件场景、真实模型普通文件证据及 grep/超长行限制。 |
| [tests/opfs-agent-file-tools.e2e.mjs](browser-native-dsh-poc/tests/opfs-agent-file-tools.e2e.mjs) | 真实 Chrome Worker 的 12/64 MiB 单文件与 4×16 MiB 工作集验收；标准工具、有限载荷、单次 edit commit、Worker heap 采样和刷新恢复。 |
| [opfs-standard-tool-envelope-validation-plan.md](browser-native-dsh-poc/opfs-standard-tool-envelope-validation-plan.md) / [进度](browser-native-dsh-poc/opfs-standard-tool-envelope-validation-progress.md) | 标准工具资源包络、完整新 blob 上传代价、64 MiB unknown commit 恢复和独立真实模型烟测；明确测量范围与产品化限制。 |
| [chunk-reuse-upload-validation-plan.md](browser-native-dsh-poc/chunk-reuse-upload-validation-plan.md) / [进度](browser-native-dsh-poc/chunk-reuse-upload-validation-progress.md) | 同 Workspace 已提交来源的固定偏移分块复用、非顺序缺块、上传恢复和真实 Chrome 标准 edit 流量；区分上行节省与服务端完整文件成本。 |
| [content-defined-chunking-validation-plan.md](browser-native-dsh-poc/content-defined-chunking-validation-plan.md) / [进度](browser-native-dsh-poc/content-defined-chunking-validation-progress.md) | 实验性 gear CDC 与 1 MiB 固定偏移策略的 Chrome Worker/OPFS 对照；记录合成内容上的估算上行、实际块长分布、CPU/read 成本、协议准入结论与限制。 |
| [tests/content-defined-chunking.e2e.mjs](browser-native-dsh-poc/tests/content-defined-chunking.e2e.mjs) / [content-defined-chunking-chrome-results.json](browser-native-dsh-poc/content-defined-chunking-chrome-results.json) | 在临时 OPFS 文件运行的 18 项算法对照和原始结果；不执行上传、Session 或 LLM 请求。 |
| [content-upload-protocol-validation-plan.md](browser-native-dsh-poc/content-upload-protocol-validation-plan.md) / [进度](browser-native-dsh-poc/content-upload-protocol-validation-progress.md) | 内容分块从算法估算进入 Worker/HTTP 上传协议的规划、实现和实际验收；不等同块级对象存储。 |
| [operational-capacity-chrome-results.json](browser-native-dsh-poc/operational-capacity-chrome-results.json) | Chrome 155.0.8059.85、macOS 的九组单机容量原始样本；是可复跑基线，不是 SLA 或生产容量上限。 |
| [browser-file-tools-next-validation-plan.md](browser-native-dsh-poc/browser-file-tools-next-validation-plan.md) / [进度](browser-native-dsh-poc/browser-file-tools-next-validation-progress.md) | 文件工具资源边界与文本语义的本批计划、实现证据、真实 Chrome/LLM 范围和未验证的 Shell/WASI 边界。 |
| [browser-file-search-isolation-validation-plan.md](browser-native-dsh-poc/browser-file-search-isolation-validation-plan.md) / [进度](browser-native-dsh-poc/browser-file-search-isolation-validation-progress.md) | 模型可控内容/include/glob regex 的可终止 Worker、行与搜索预算、Chrome tool-loop 恢复证据及部署限制。 |
| [next-worker-tool-cancellation-validation-plan.md](browser-native-dsh-poc/next-worker-tool-cancellation-validation-plan.md) / [进度](browser-native-dsh-poc/next-worker-tool-cancellation-validation-progress.md) | 真实 DSH `grep`/OPFS copy-on-write `edit` 期间的 UI Stop、Worker 中断、Session unknown settlement 与同 Session 恢复；真实 LLM 普通文件 smoke 通过，但不覆盖模型自主取消或 Worker 故障。 |
| [tests/browser-native-tool-cancellation.e2e.mjs](browser-native-dsh-poc/tests/browser-native-tool-cancellation.e2e.mjs) | Chrome 验证文件工具执行中的 Stop、OPFS edit staging Worker 终止、刷新后 unknown 结算和同 Session continuation。 |
| [llm-stream-failure-validation-plan.md](browser-native-dsh-poc/llm-stream-failure-validation-plan.md) / [进度](browser-native-dsh-poc/llm-stream-failure-validation-progress.md) | 模型流半包、工具调用 fail-closed、Worker 流中止刷新、Stop 与 fake upstream 取消传播；明确 `assistant/attempt`、`turn/end` 和未覆盖的真实供应商/OS 边界。 |
| [chunk-backed-edit-validation-plan.md](browser-native-dsh-poc/chunk-backed-edit-validation-plan.md) / [进度](browser-native-dsh-poc/chunk-backed-edit-validation-progress.md) | 可写 chunk-backed 文件编辑原型、64 MiB OPFS bounded-memory 证据、故障注入和当前 DSH `edit` materialize 对照；明确尚未接入正式 VFS/Workspace。 |
| [reference-backed-edit-validation-plan.md](browser-native-dsh-poc/reference-backed-edit-validation-plan.md) / [进度](browser-native-dsh-poc/reference-backed-edit-validation-progress.md) | External reference mutation、range-based durable cache/upload、manifest CAS、compact edit receipt、刷新恢复和失败重试；明确 test action、experimental 类型和正式 `edit`/Session 能力仍未接入。 |
| [durable-metadata-and-blob-lifecycle-validation-plan.md](browser-native-dsh-poc/durable-metadata-and-blob-lifecycle-validation-plan.md) / [进度](browser-native-dsh-poc/durable-metadata-and-blob-lifecycle-validation-progress.md) | Workspace metadata 冷加载 fail-closed、全 Workspace manifest/pending 引用扫描、文件与 MinIO orphan GC、过期/损坏 staging 处置和 unknown-commit 回归；不证明跨主机 GC 或生产对象存储。 |
| [next-deep-runtime-validation-plan.md](browser-native-dsh-poc/next-deep-runtime-validation-plan.md) / [进度](browser-native-dsh-poc/next-deep-runtime-validation-progress.md) | 长 Session 冷 hydrate、同 turn 并行只读工具、`assistant/attempt` append 503 后重试与错误收束，以及标准大文件写入和 external/chunk backing 的真实 Chrome 证据；不证明 compaction、离线 outbox 或生产 HA。 |
| [next-session-sustainability-validation-plan.md](browser-native-dsh-poc/next-session-sustainability-validation-plan.md) / [进度](browser-native-dsh-poc/next-session-sustainability-validation-progress.md) | Browser profile compaction 组合、显式模型 context window、大工具结果裁剪、摘要/append 故障恢复、真实 LLM sentinel 回忆和 64 轮冷 hydrate；不证明分页、生产 SLA、自然 eviction 或 Safari。 |
| [session-transport-resilience-validation-plan.md](browser-native-dsh-poc/session-transport-resilience-validation-plan.md) / [进度](browser-native-dsh-poc/session-transport-resilience-validation-progress.md) | Browser Session append 限额切批、提交后响应丢失 seq reconciliation、连续 503 后恢复、Workspace receipt 去重和真实 LLM smoke；明确没有浏览器 durable Session outbox 或 Worker 终止恢复。 |
| [session-outbox-recovery-validation-plan.md](browser-native-dsh-poc/session-outbox-recovery-validation-plan.md) / [进度](browser-native-dsh-poc/session-outbox-recovery-validation-progress.md) | IndexedDB journal、Worker 终止后的 Session watermark 对账、writer fencing、容量与 schema migration、Workspace receipt 协调；真实模型证明 Session 恢复，不证明普通内存 Workspace 文件刷新恢复。 |
| [runtime-capability-probe-validation-plan.md](browser-native-dsh-poc/runtime-capability-probe-validation-plan.md) / [进度](browser-native-dsh-poc/runtime-capability-probe-validation-progress.md) | Worker Host 启动前检查 outbox IndexedDB transaction、同源 backend readiness 和 durable Workspace 的 Worker OPFS 能力；Chrome 故障矩阵与真实模型恢复证据，不代表自然 eviction、启动后依赖持续可用或生产 HA。 |
| [tests/runtime-capability-probes.e2e.mjs](browser-native-dsh-poc/tests/runtime-capability-probes.e2e.mjs) | Chrome 检查 backend 503/协议错误、IndexedDB abort、OPFS probe seam 故障、memory 模式跳过 OPFS、无敏感响应泄露及恢复后单轮执行。 |
| [next-control-channel-conformance-validation-plan.md](browser-native-dsh-poc/next-control-channel-conformance-validation-plan.md) / [进度](browser-native-dsh-poc/next-control-channel-conformance-validation-progress.md) | 页面与 Worker 控制帧的基线、连续 `channelId/seq`、重复去重、跳号/同序冲突 fail-closed 和刷新新通道；不替代 Session event log。 |
| [tests/control-channel-conformance.e2e.mjs](browser-native-dsh-poc/tests/control-channel-conformance.e2e.mjs) | 真实 Chrome 验证控制通道正常投影、故障帧注入、刷新恢复、页面/Worker 错误和跨源请求边界。 |
| [next-control-payload-bounds-validation-plan.md](browser-native-dsh-poc/next-control-payload-bounds-validation-plan.md) / [进度](browser-native-dsh-poc/next-control-payload-bounds-validation-progress.md) | 精确字段集、文本与 JSON frame byte 上限、unknown/cycle fail-closed、安全诊断和刷新恢复；不替代 Session/工具结果的独立载荷预算。 |
| [tests/control-payload-bounds.e2e.mjs](browser-native-dsh-poc/tests/control-payload-bounds.e2e.mjs) | 真实 Chrome Worker/MessagePort 验证最大文本接受、超限/未知/循环坏帧拒绝、页面状态不变、诊断无原始数据和刷新后恢复。 |
| [execution-owner-handoff-validation-plan.md](browser-native-dsh-poc/execution-owner-handoff-validation-plan.md) / [进度](browser-native-dsh-poc/execution-owner-handoff-validation-progress.md) | Session 与 Workspace 双写权有序交接、响应未知后的恢复、旧 owner fencing；Chrome scripted 故障矩阵和真实 LLM 同 Session 双 Worker 文件续接。 |
| [tests/execution-owner-handoff.e2e.mjs](browser-native-dsh-poc/tests/execution-owner-handoff.e2e.mjs) | Chrome 验证正常双 Worker handoff、Session handoff response loss、Workspace release response loss、旧 token fencing 和身份 cookie 不发送给 LLM route。 |
| [principal-scoped-session-isolation-plan.md](browser-native-dsh-poc/principal-scoped-session-isolation-plan.md) / [进度](browser-native-dsh-poc/principal-scoped-session-isolation-progress.md) | PoC principal 授权、Session durable owner、同源身份切换时 OPFS/IndexedDB 隔离；Chrome A→B→A 刷新恢复、handoff 回归与真实 LLM smoke，明确不是生产认证或多租户安全证明。 |
| [tests/principal-scoped-session-isolation.e2e.mjs](browser-native-dsh-poc/tests/principal-scoped-session-isolation.e2e.mjs) | 同一 Chrome context 在保留 OPFS/IndexedDB 时切换两个 PoC principal，验证 Session/Workspace 交叉拒绝及双方各自刷新恢复。 |

### v2 实现和测试入口

| 文件 | 用途 |
|---|---|
| [browser-native-worker.ts](browser-native-dsh-poc/browser-native-worker.ts) | 在 Dedicated Worker 中启动真实 DSH Host。 |
| [browser-native-page-control.ts](../../apps/web/src/browser-native-page-control.ts) | preview 主线程保存 Worker Session owner token、刷新续租，并在 pagehide 请求关闭 Session。 |
| [browser-native-control-channel.ts](../../apps/web/src/browser-native-control-channel.ts) | 定义页面/Worker 控制帧、`control-ready` 基线、连续序列验证和重复去重。 |
| [browser-native-recovery.ts](../../apps/web/src/browser-native-recovery.ts) | 校验 tab-scoped Session/Workspace 恢复记录，并通过 Web Locks 协调同源页面的 writer 恢复。 |
| [browser-native-providers.ts](browser-native-dsh-poc/browser-native-providers.ts) | Worker 侧远程 `SessionPersistence` 和 `LlmAdapter` provider。 |
| [backend-v2.mjs](browser-native-dsh-poc/backend-v2.mjs) | 当前 v2 的实际 Session/LLM 字段、durability、进程内 owner token 校验和 30 秒 lease 过期；没有请求去重账本或跨进程 owner epoch。 |
| [run-v2.mjs](browser-native-dsh-poc/run-v2.mjs) | 构建产物上的 v2 launcher。 |
| [tests/backend-v2.test.mjs](browser-native-dsh-poc/tests/backend-v2.test.mjs) | backend contract tests。 |
| [tests/browser-native-v2.e2e.mjs](browser-native-dsh-poc/tests/browser-native-v2.e2e.mjs) | 真实 DSH Web UI + Chromium + backend 的组合 E2E。 |
| [tests/runtime-validation.e2e.mjs](browser-native-dsh-poc/tests/runtime-validation.e2e.mjs) | Browser-specific roster、真实 LLM VFS 闭环、Session 记忆、刷新易失性、流式 DOM 与凭据流向检查。 |
| [tests/durable-workspace-recovery.e2e.mjs](browser-native-dsh-poc/tests/durable-workspace-recovery.e2e.mjs) | 模型无关的真实 Chrome Worker/OPFS/IndexedDB 503 故障恢复和刷新重试。 |
| [tests/runtime-lifecycle.e2e.mjs](browser-native-dsh-poc/tests/runtime-lifecycle.e2e.mjs) | scripted Chrome 生命周期复测；历史 WebKit 结果仅作对照，覆盖刷新、Stop、失败恢复、backend 重启、lease 冲突和 Worker terminate。 |
| [tests/runtime-real-lifecycle.e2e.mjs](browser-native-dsh-poc/tests/runtime-real-lifecycle.e2e.mjs) | 真实模型 Chrome Stop、`aborted → completed` 恢复、durable Session 和密钥流向检查；历史 WebKit 结果不在本轮复测。 |
| [tests/session-outbox-recovery.e2e.mjs](browser-native-dsh-poc/tests/session-outbox-recovery.e2e.mjs) | Chrome Worker 终止、append/flush response 窗口、IDB abort、writer fencing、容量迁移及 Workspace receipt 恢复。 |
| [tests/browser-native-recovery.spec.ts](browser-native-dsh-poc/tests/browser-native-recovery.spec.ts) | 恢复记录校验、Web Lock 冲突、部分获取回滚和不支持 API 的单测。 |
| [tests/tab-recovery-duplication.e2e.mjs](browser-native-dsh-poc/tests/tab-recovery-duplication.e2e.mjs) | 真实 Chrome opener popup 复制 Session/Workspace 凭据、无 Web Locks fail-closed、刷新接管、旧 fencing 拒绝和同 Session 续聊。 |
| [tests/runtime-streaming.e2e.mjs](browser-native-dsh-poc/tests/runtime-streaming.e2e.mjs) | 真实 Chrome 长回复的逐步 DOM、输入草稿、Stop、滚动和主线程 long-task 观测。 |

### assistant-ui 增量 PoC 入口

| 文件 | 用途 |
|---|---|
| [assistant-ui-browser-native-dsh-poc/README.md](assistant-ui-browser-native-dsh-poc/README.md) | 运行方式、职责分界、事实归属、验证范围和明确限制。 |
| [assistant-ui-browser-native-dsh-poc/src/dsh-client.ts](assistant-ui-browser-native-dsh-poc/src/dsh-client.ts) | 在不挂载原生 DSH UI 的情况下启动 Worker、正式 Client composition 和 Session retain。 |
| [assistant-ui-browser-native-dsh-poc/src/dsh-session-adapter.ts](assistant-ui-browser-native-dsh-poc/src/dsh-session-adapter.ts) | 将 DSH Session event source 适配为 assistant-ui External Store，并将输入回调到 `Session.prompt()`。 |
| [assistant-ui-browser-native-dsh-poc/tests/browser-native-assistant-ui.e2e.mjs](assistant-ui-browser-native-dsh-poc/tests/browser-native-assistant-ui.e2e.mjs) | assistant-ui 页面、真实 DSH Worker、backend Session durability 和刷新恢复的组合验证。 |
| [assistant-ui-browser-native-dsh-poc/tests/browser-native-assistant-ui.safari.e2e.mjs](assistant-ui-browser-native-dsh-poc/tests/browser-native-assistant-ui.safari.e2e.mjs) | Safari.app WebDriver、真实 LLM、工具调用、失败恢复、流式 DOM 轨迹和刷新续接验证。 |

### CopilotKit 增量 PoC 入口

| 文件 | 用途 |
|---|---|
| [copilotkit-browser-native-dsh-poc/README.md](copilotkit-browser-native-dsh-poc/README.md) | 唯一可见 CopilotKit 聊天层、运行命令、手动验收步骤和当前生产限制。 |
| [copilotkit-browser-native-dsh-poc/design.md](copilotkit-browser-native-dsh-poc/design.md) | SaaS 业务 UI、页面工具、DSH Session 与模型凭据的数据归属。 |
| [copilotkit-browser-native-dsh-poc/lessons-learned.md](copilotkit-browser-native-dsh-poc/lessons-learned.md) | CopilotKit/DSH 时序、停止、工具身份、消息排版和真实浏览器测试陷阱。 |
| [copilotkit-browser-native-dsh-poc/progress.md](copilotkit-browser-native-dsh-poc/progress.md) | 当前实现阶段、验证状态和未覆盖范围。 |
| [copilotkit-browser-native-dsh-poc/test-record.md](copilotkit-browser-native-dsh-poc/test-record.md) | scripted/真实模型 E2E、Chrome/WebKit、backend restart 和安全检查证据。 |
| [copilotkit-browser-native-dsh-poc/src/dsh-agui-agent.ts](copilotkit-browser-native-dsh-poc/src/dsh-agui-agent.ts) | DSH Session 到 AG-UI 的 adapter；不创建第二个模型循环。 |
| [copilotkit-browser-native-dsh-poc/src/main.tsx](copilotkit-browser-native-dsh-poc/src/main.tsx) | SaaS 工作台、CopilotKit chat 和可编辑业务操作卡片。 |
| [copilotkit-browser-native-dsh-poc/tests/copilotkit-browser-native.e2e.mjs](copilotkit-browser-native-dsh-poc/tests/copilotkit-browser-native.e2e.mjs) | 真实模型的多轮、Agentic UI、HITL、停止、恢复、排版、安全和双标签验收。 |

### 成熟 SaaS 对照与复杂实验入口

| 文件 | 用途 |
|---|---|
| [saas-agentic-ui-comparison-poc/README.md](saas-agentic-ui-comparison-poc/README.md) | 三条路线共用业务组件、mock API、Browser-Native DSH Loop 的基础对照入口。 |
| [saas-agentic-ui-comparison-poc/test-results.md](saas-agentic-ui-comparison-poc/test-results.md) | 基础三路线的 scripted/真实模型、Chrome/WebKit 和持久化证据。 |
| [saas-agentic-ui-comparison-poc/complex/README.md](saas-agentic-ui-comparison-poc/complex/README.md) | 复杂续约实验的安装、启动、限制和主验收范围。 |
| [saas-agentic-ui-comparison-poc/complex/design-and-assessment.md](saas-agentic-ui-comparison-poc/complex/design-and-assessment.md) | 跨页面上下文、共享组件、frontend tool、HITL 和分段 DSH turn 的设计判断。 |
| [saas-agentic-ui-comparison-poc/complex/test-results.md](saas-agentic-ui-comparison-poc/complex/test-results.md) | 复杂实验实际命令、浏览器证据、回归、失败修正和未验证范围。 |

### 历史实验和阅读注意事项

旧版 [implementation-plan.md](browser-native-dsh-poc/implementation-plan.md)、[progress.md](browser-native-dsh-poc/progress.md)、[protocol.md](browser-native-dsh-poc/protocol.md)、[protocol.mjs](browser-native-dsh-poc/protocol.mjs)、`public/` 和对应测试用于追溯独立协议实验。旧协议中的 renew、15 秒 lease 和 request-id replay 不适用于 v2；判断当前实现时以 v2 源码和测试为准，以 README 与进度记录辅助定位；v2 规划仍包含未实现的目标。

-----

## PoC 手动验收与经验

Browser-Native DSH、assistant-ui 和 CopilotKit 三套基础 PoC 共用同一个 DSH Agent Loop 思路，但验证范围不同。基础三路线的业务对照入口见[成熟 SaaS 三路线实验](saas-agentic-ui-comparison-poc/README.md)；CopilotKit 复杂路线的手动验收见[复杂续约实验手册](saas-agentic-ui-comparison-poc/complex/manual-acceptance.md)。旧 CopilotKit 增量 PoC 的实现陷阱和回归证据仍见[实施经验与陷阱](copilotkit-browser-native-dsh-poc/lessons-learned.md)与[验收测试记录](copilotkit-browser-native-dsh-poc/test-record.md)。

验收时应先区分三种事实：页面是否显示了 live read model，Session 是否记录了正式事件，turn 是否以完成或明确错误结束。基础对照只有在相同 v2 profile、backend、业务组件和任务矩阵下才可比较呈现层差异；复杂实验以 CopilotKit 的原生前端工具/HITL 作为主验收结论，同时保留另外两条的早期真实 WebKit、真实 Chrome 对照和最终 scripted 结果。不要把这些早期对照或 scripted 结果写成三路线已经完成等量最终真实复杂矩阵。

-----

## 证据层级与状态标记

### 证据优先级

阅读任一研究文档时，按下面顺序判断“这件事是否已经实现”：

1. 当前 checkout 的源代码和实际测试结果。
2. PoC README、progress 和 change ledger 中注明版本的验证记录；旧协议文档只说明旧实验。
3. DSH package README、subsystem 文档和架构文档。
4. 实施方案中的明确规格和验收标准。
5. 研究报告中的设计判断、外部项目文档和生态比较。

研究报告可以提出目标，但不能覆盖代码和测试对当前行为的事实约束。实施方案可以规定未来的 Definition of Done，但不能替代已经通过的 E2E。

### 三种状态

| 状态 | 含义 | 常见文档位置 |
|---|---|---|
| 已验证 | 当前代码或测试已经观察到的行为。 | PoC README、progress、实现和 tests。 |
| 设计中 | 具体协议、包边界或验收方案，尚未作为普通 DSH 能力发布。 | implementation plan、综合报告的建议章节。 |
| 历史/参考 | 旧实验、外部项目或被替代的方案，只用于理解演进。 | PoC 旧文件、生态调研和历史记录。 |

对外描述当前成果时，推荐使用：“Browser-Native DSH runtime substrate、三路线共同 mock 业务闭环，以及 CopilotKit 主验收路线和 assistant-ui 对照路线的复杂 Agentic UI 故事已通过 PoC 验证；mock API 已覆盖角色/版本检查、幂等 receipt 与持久化重启，但生产 typed business capability、授权、跨进程幂等、未知结果恢复及多租户安全仍需真实 SaaS API 验收。”

-----

## 当前统一结论

- Agentic UI 的正确目标是复用既有 SaaS 的业务能力和 GUI，而不是让模型生成任意 HTML、JavaScript 或第二套 CRM。
- Browser-Native 的严格含义是 Agent Loop 驻留 Dedicated Worker，并通过同源、受限的 LLM proxy 请求模型；Backend callback 不能被误写成 Browser-Native Loop。
- Main Thread 负责真实 UI、结构化 state adapter、用户手势和受控 action；Worker 负责 DSH Loop、Tool orchestration 和 Session projection；Backend 负责身份、租户、业务授权、权威副作用和 durable job。
- DSH 当前已有 Agent Loop、Tool lifecycle、Session persistence、Tool view、Conversation Node 和 Worker runtime 基座；它们需要通过新的 typed UI capability seam 组合，而不是复制一个 Browser Agent Loop。
- v2 PoC 已验证真实 DSH Worker Host、`ctx.agentLoop`、远程 Session persistence、同源 LLM proxy、flush durability 和当前 backend instance 内的 owner fencing。三路线基础实验在相同 mock SaaS 组件/API 上验证了业务 UI state read、受控 action 和结果回到原 DSH turn 的最小闭环；复杂实验又让 assistant-ui 与 CopilotKit 在同一跨客户批量续约真实模型故事上通过 Chrome 与 Playwright WebKit，验证 frontend tool、HITL、版本冲突、取消、刷新和写权恢复。它们尚未验证真实业务 API 授权、生产幂等/receipt、多租户安全或 Browser-Native handoff。DSH 已有问答和审批等具体 UI continuation，复杂 CopilotKit E2E 也验证了这些工具的审批、拒绝、取消和停止恢复。
- assistant-ui 增量 PoC 已验证聊天层可以通过 `ExternalStoreRuntime` 消费 DSH Session 投影并把文本 prompt 送入同一个 DSH Agent Loop；它没有把 assistant-ui history、AG-UI state 或 frontend tool callback 提升为 DSH 的权威事实。
- CopilotKit 增量 PoC 和复杂实验已在真实 Chrome 与 Playwright WebKit/真实 LLM 下验证页面业务交互闭环：DSH tool call 触发 CopilotKit 表单或前端工具，用户编辑、确认或回答，模拟 SaaS 数据更新，最终结果按原 DSH 调用身份写入 Session，原 Agent Loop 继续生成回复。CopilotKit 只作为聊天和应用交互层，未并行挂载 DSH 原生聊天，也未引入第二个 Agent Loop。
- DSH Web UI 的内部扩展性强于外部嵌入性：它适合 DSH-native 工作台和愿意采用 DSH Client composition 的产品；一般既有 SaaS 不应因为 DSH 有 Slot/Conversation/Tool 扩展点，就默认迁移到 DSH Web boot graph。
- 对题设成熟 React SaaS，基础业务闭环三者均可实现；在 DSH Loop 必须是唯一执行者的前提下，复杂 Agentic UI 也先评估 assistant-ui，CopilotKit 作为需要高复用应用交互设施时的条件性升级路线，DSH-native 产品再优先考虑 DSH 原生 UI。复杂真实模型证据已覆盖 CopilotKit 与 assistant-ui，但 DSH 原生入口尚未完成等量真实模型复杂矩阵，三者都未生产定案。
- 模型可见的 UI state 必须能从 Session event/projection 重建；业务提交必须以 SaaS backend 的 receipt 为准；连接丢失时必须区分 rejected、committed 和 unknown。
- 浏览器适合主持当前交互，不适合成为 provider secret、业务授权、长期运行或多租户隔离的最终权威；长期任务需要显式 handoff，且 handoff 后只能有一个 active owner。
- 最小下一步应是一个真实垂直闭环，例如 `customer.create` 或 release approval：既有 surface + typed state + user approval + SaaS API + idempotency/receipt + Session replay。

### 研究成果的意义

两类研究结合后，DSH 获得的不是一个孤立的浏览器 Demo，而是一种可渐进落地的执行模式：既有 SaaS 保留业务规则和 UI 投资，DSH 提供 Agent Loop、Tool 生命周期、Session 回放和插件组合，Browser Native 提供当前页面中的低延迟交互，Backend/Durable Worker 提供授权、持久化和长期任务连续性。

这使 Chat UI 成为既有 SaaS 的自然语言任务编排层，而不是替代既有 GUI 的第二个产品；也使 Browser-Native 不必把 DSH 重定位为 Browser Harness，而可以成为 DSH 的一个显式、可审计、可恢复的执行 profile。

-----

## 维护规则

- 新增研究草稿时，先判断它属于哪条研究轴，再在本文对应表格和阅读路径中加入入口。
- 新增 `docs/drafts/*.md` 时，把文件登记到 `scripts/translation-pairing.manifest.json` 的 `excluded` 清单；本目录是中文研究草稿集合，不自动要求英文 counterpart。
- 新增 PoC 文件时，先更新 [PoC README](browser-native-dsh-poc/README.md) 的目录边界和验证入口；当前 v2 字段与行为引用 backend/providers 和对应测试，未来要求放在 v2 规划中；[protocol.md](browser-native-dsh-poc/protocol.md)只保留旧版独立实验协议。
- 研究文档中的“已验证”和“建议”必须显式区分；运行时行为以源码和测试为准，设计目标以实施方案为准。
- `docs/drafts/` 当前不在 VitePress 网站的公开页面清单中；不要把这里的研究草稿误当作已发布用户文档。需要正式发布时，应先迁移到合适的 `docs/` owner，并按双语和网站 manifest 规则处理。
- 不在本文复制专题文档的完整协议、代码或历史；本文只维护目录关系、阅读顺序、证据边界和跨主题综述。

## Dev Note

本文是 `docs/drafts/` 的目录级 scratch 入口，不是稳定架构决策、包 README 或发布文档。它只索引当前研究成果并总结跨文档关系；具体事实仍由链接到的专题文档、源码、测试和 PoC 协议各自拥有。
