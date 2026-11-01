---
description: "对照 DeepSeek Harness 团队的 Super-agent 设计文章与公开 dsh-superagent 原型，核验实现范围、可靠性和安全限制，并评估其对 DSH 的参考价值。"
---

# DeepSeek Super-agent 原型与设计文章研究报告

## Summary

公开的 `dsh-superagent` 是面向单个 GitHub 仓库、可选接入 Feishu 的研究型编码 Agent。它把事件准入、授权、任务状态、独立 worker Session、外部消息投递和恢复组织成一套应用层系统；这比“给单个 Agent 加一个聊天连接器”更完整，但它不等于公众号文章描述的内部 Super-agent 实现。文章中的 Chain of Recall、Speculative Execution、云端无状态 Loop、端侧 BYOM daemon 和进度型 Watchdog，不能从这个公开原型中推定为已实现。

对 DSH 最有价值的参考是它把“事件是否值得处理”“谁授权任务”“任务由哪个独立执行上下文完成”“状态如何重启恢复”“何时需要打扰人”分别建模。原型的本地 SQLite、单进程锁、危险权限 preset 和单仓库部署假设则只适合研究或受信任环境，不能直接当作多租户 Cloud Agent 的生产架构。

## Table of Contents

- [研究范围与证据等级](#研究范围与证据等级)
- [原型解决的问题](#原型解决的问题)
- [原型架构与执行过程](#原型架构与执行过程)
- [公众号文章与公开原型的差异](#公众号文章与公开原型的差异)
- [对 DSH 的参考价值](#对-dsh-的参考价值)
- [采用建议与验证路线](#采用建议与验证路线)
- [局限与未验证事项](#局限与未验证事项)
- [来源](#来源)
- [Dev Note](#dev-note)

-----

## 研究范围与证据等级

研究对象是 `dsh-superagent-prototype` checkout 中的 `dsh-superagent` 0.1.0 bundle，以及 DeepSeek Harness 团队于 2026-10-31 发布的文章《Super-agent 设计探索：迈向更自主的 Agent 系统》。原型 README 明确说明：公开版本经过发布适配，与内部版本和文章描述的实现不完全相同，文章中的部分设计只是未来方向；该项目仅供研究参考，不是正式产品，也未声明生产就绪。

原型仓库没有收录文章全文。为减少微信页面不可访问或删除带来的引用风险，文章可见正文和 15 张配图已整理在[本地引用副本](reference-materials/super-agent-design-exploration.md)；该副本记录了原文链接、账号、署名、页面日期和整理说明。转录为可检索的 Markdown，图片以 WebP 保存；有格式或内容差异时以原文页面为准。

本文区分三类陈述：原型实现事实依据其源码与项目文档；文章设计与实验依据文章原文；与 DSH 当前架构的映射属于分析判断，不表示相关能力已成为 DSH 产品功能。本文对原型做了源码和文档阅读，没有运行其 `pnpm check`、真实 GitHub/Feishu 集成或文章实验，也没有执行 DSH 产品测试。

## 原型解决的问题

原型聚焦一个团队如何把编码工作交给持续运行的 Agent：Agent 接收 GitHub issue、评论、Pull Request 和可选 Feishu 消息；识别明确请求或符合团队规则的主动候选；为获准任务建立 Ticket；在该 Ticket 的独立 DSH Session 和工作目录中执行；再将确认、问题或结果发回原始对话。管理面板呈现需要人工判断的候选、任务、来源状态和配置。

项目把目标概括为尽量少花费人的注意力，同时让 Agent 提供更多价值。相应设计倾向于只处理明确授权的请求或书面规则允许的主动工作；对未经确认的主动候选先观察；进展期间保持安静，只在需要人工决策或结果可用时发消息；遇到不确定的外部副作用要检查当前状态，不盲目重复操作。它是一个面向单仓库研发协作的应用，不是个人日程、邮件、浏览器等通用环境的 Super-agent 平台。

## 原型架构与执行过程

原型的核心是应用层领域模型，而非某个特定的 Prompt。源码在 `src/core/` 中定义同步事务内的 Engine 和领域逻辑；`src/app/runtime.ts` 负责组装存储、策略、评估器、执行器、来源和后台效果；GitHub、Feishu 和客户端面板分别处于外围适配层。

```mermaid
flowchart LR
  S[GitHub / Feishu Source] --> T[Trigger / Thread]
  T --> F[订阅 Ticket 上下文扇出]
  T --> E[Eval: 准入与评估]
  E -->|accept + Mandate| K[Ticket]
  E -->|ignore / observe / unavailable| R[Decision 记录]
  K --> A[Assignment]
  A --> W[Ticket 专属 DSH Session 与目录]
  W --> O[Reply Outbox]
  O --> C[来源 Channel]
  K --> P[面板与持久化状态]
```

几个关键概念各自承担不同责任：

| 概念 | 在系统中的职责 | 不能据此推导的能力 |
|---|---|---|
| `Source` / `Trigger` | 接入外部消息并保留来源标识、作者、线程及来源元数据；来源适配器负责事件读取和过滤。 | 所有接入事件都自动成为模型输入或任务。 |
| `Thread` / `Eval` | 按来源线程组织事件；同一线程的待评估 Trigger 可合并处理，避免每条闲聊都启动独立评估。 | 全组织事件有一个全局、无限上下文。 |
| `Policy` / `Mandate` | 用确定性规则判断主体、来源、请求强度和主动规则；获准 Ticket 保存授权依据，并可在策略变化时重验。 | DSH 工具权限、操作系统权限或租户安全隔离。 |
| `Ticket` / `Assignment` | 将任务生命周期与执行尝试分开；Ticket 持有订阅、输入、状态和授权，Assignment 记录一次执行。 | 一个 Ticket 就是分布式任务队列或跨节点租约。 |
| Worker Session / directory | 每个 Ticket 使用专属 DSH Session 和工作目录，避免并行任务共享同一段工作对话或工作树。 | 独立 Session 等同进程、容器或操作系统隔离。 |
| `Channel` / Outbox | 用原始对话地址投递确认、提问和结果，并用持久回执与效果队列处理外部发送。 | 数据库事务与 GitHub/Feishu 的远端副作用形成原子事务。 |

**接入与准入。** `src/core/intake.ts` 和 `src/core/evals.ts` 将来源消息转成 Trigger，并按 Thread 归集评估。明确 @ 机器人或允许的请求可直接进入授权判断；推断出的主动候选依赖启用的 admission 规则。默认 `observe` 模式会记录“若启用自动接单，本来会接受”的评估结果，但不因此启动 worker；自动接纳需要管理员选择 `auto` 并配置匹配规则。模型评估负责解释证据和意图，不能单独创设授权。

**路由与上下文。** Thread 上新事件可以扇出给已经订阅该 Thread 的 Ticket worker；发给正在处理相关 Ticket 的人的后续消息可由 worker 接手。Ticket 也能跟随额外 Thread 获取上下文，或拒绝无关 Thread。上下文订阅和任务 Mandate 是不同关系：订阅让信息可见，不自动授权新的工作。未被 Ticket 接手的消息进入 Eval，而不是让所有 worker 读取所有会话。

**隔离与执行。** 接受后，Engine 在一次领域事务中创建带 Mandate 的 Ticket、初始 Assignment 和必要订阅，然后由 `src/executor/dsh.ts` 在 DSH Session 中运行。Ticket ID 决定 worker Session ID；每个 Ticket 绑定自己的工作目录。新消息作为 Input 交付给该 Session，并分别记录已投递、已读等状态。一次失败重试会产生新的 Assignment，但继续受原 Ticket 的 Mandate 约束。

**持久化与效果。** `src/app/store.ts` 使用本地 SQLite 保存领域状态；`src/app/effects.ts` 通过持久效果表调度带退避的后台工作；`src/app/outbox.ts` 在记录消息回执时排入发送效果，避免发送成功但本地未记账时简单重发。Runtime 使用本地锁防止同一状态目录的多个实例同时运行。它提供的是单机重启恢复纪律，不是多副本 HA、跨数据库事务或通用 exactly-once 投递。

**恢复与人工关注。** Host 重启时，执行器检查未完成 Assignment；中断在执行中间的任务会带恢复提示继续，已报告等待、完成、阻塞或失败且期间没有新输入的任务可保留原 Session。恢复提示要求先检查工作树、Git 历史和 GitHub 状态，避免重复已经完成的外部操作。健康状态、失败交付、待处理问题和面板为运营者提供可见性；这些机制不等同于文章所说的外部 Watchdog 根据“任务是否取得进展”重启 Loop 或重分配资源。

## 公众号文章与公开原型的差异

文章把 Super-agent 归纳为连续、高效、主动、持久四个特征，并提出一套可能适用于个人助手和研发 Agent 的通用架构。公开原型证明团队发布了一个围绕该方向的可运行研究项目，但 README 明确限制了两者之间的等同关系。下表按文章所述设计逐项核对公开原型：

| 文章设计或主张 | 公开原型中可核实的对应物 | 判断与边界 |
|---|---|---|
| Router 与 Worker 双层架构 | 常驻主 Session 负责团队交互、候选评估及任务协调；Ticket worker 在独立 Session/目录中执行获准工作。 | 有相近的职责划分；原型围绕 GitHub/Feishu 和 Ticket 生命周期，不是通用消息 Router。 |
| 事件过滤与 Thread 路由 | Source 过滤、Trigger 去重、Thread 上批量 Eval、已订阅 Ticket 上下文扇出。 | 这是原型已实现的重要部分，且有显式领域状态和策略规则。 |
| Chain of Recall | 持久化 Thread、Ticket、Mandate、输入及会话引用，主 Session 可以检查已记录任务或把信息作为 Input 交给 worker。 | 未发现文章所述的多跳、Inline/Spill 一体化链式召回机制；有可查询的持久事实不代表已经实现该检索策略。 |
| Speculative Execution | `observe` 可记录主动评估结论，管理面板可展示待人工判断的候选。 | 观察模式不启动编码 worker，因此不是“先做一份可能有用的工作，再决定是否提交”的投机执行。 |
| 多信道全双工交互 | GitHub 与可选 Feishu 共用 Ticket 状态；原始来源 Channel 接收回复；Ticket worker 可继续处理后续消息。 | 有跨渠道任务连续性，但不代表任意 IM、邮件、日程和代码平台都已支持，也不证明交互可在所有执行步骤中实时插入。 |
| 计算、状态和执行环境分离 | 领域状态、Session、工作目录和外部效果有不同职责；但部署文档描述的是本地运行时和状态目录。 | 组件职责有所分离，尚非文章建议的云端无状态 Loop + 独立端侧 daemon + 跨设备凭据/执行协议。 |
| Watchdog | 进程健康、效果重试、Assignment 恢复和人工重试路径。 | 未找到外部、独立的进度观察进程；健康检查不判断模型是否推进任务，也不自行接管卡死任务。 |
| 合成负载性能实验 | 文章报告双层架构等方案的初步对照结果。 | 原型仓库未包含可复现该文章实验的同口径实验项目；文章自己说明编码工具只消耗时间、每种方案运行 5 次。 |

文章端到端实验使用群聊与 GitHub CI 消息流，每轮约 300 条消息、约 20 条工作请求，每种方案运行 5 次；编码执行由纯耗时工具模拟，而不是实际代码修改或评审。文章报告 Super-agent 的任务完成时间 p50/p95 为 12.4/15.7 分钟；中性提示的单 Session 方案没有一次调用 Subagent，p95 为 29.5 分钟。图表说明消息间隔和工作时长按 1/4 缩放，而模型调用耗时使用真实值。单独的 Router 压测把 Trigger 速率从每分钟约 1 条提高到约 40 条，平均 batch 从 1.0 增至 2.8，单次请求耗时从 2.5 秒增至 3.9 秒，分摊到单个决定的推理时间从 6.4 秒降至 1.6 秒。这些数字说明文章报告的合成负载调度结果，不能外推为生产任务吞吐、代码质量、真实并发能力或成本结论；公开原型仓库也没有找到可复现这些实验的同口径项目。

## 对 DSH 的参考价值

DSH 已提供 Agent Loop、Session event log、工具生命周期、Preset、Subagent、Jobs、Schedule 和插件扩展点；它也有独立的 Cloud Agent、租户隔离、durable workspace 和 Agent 协作研究。因而该原型更适合作为“应用如何使用 DSH 组成事件驱动任务系统”的案例，而不是要求 DSH 核心直接增加一个 Super-agent Loop。可参阅[云端 Agent 架构建议](dsh-cloud-agent-architecture-recommendation.md)、[云端 SaaS Agent 研究](dsh-cloud-saas-agent-research.md)、[部署与租户隔离参考](dsh-deployment-and-tenancy-deep-dive.md)、[Agent 管理与 Watchdog 研究](dsh-herdr-agent-management-research.md)及[Agent 协作研究](dsh-agent-collaboration-research.md)。

| 研究面向 | 原型提供的具体参考 | 对 DSH 的判断 |
|---|---|---|
| 应用领域状态 | Ticket、Mandate、Assignment、Thread、Decision 记录任务身份、授权理由和执行进度。 | 可由 DSH 外围业务插件或 Control Plane 持有；Session log 适合记录模型交互事实，不能替代业务任务账本。 |
| 事件到工作流 | 先做来源级过滤和确定性策略，再让模型辅助评估；把 Thread 事件批处理，并只送达订阅相关的 worker。 | 可与 DSH 的事件和工具扩展机制组合；事件过滤、路由和授权属于应用策略，不能只靠系统提示词。 |
| Agent 上下文组织 | 主 Session 协调，Ticket 专属 Session 执行；线程订阅只提供相关上下文，工作权由 Mandate 表示。 | 与 DSH Session/Agent 组合相容，但身份、生命周期、持久化和并行额度须由宿主应用定义。 |
| 持久效果 | 域状态事务内排入外部效果，发送端以 Outbox 记回执并重试。 | 可用于提醒和消息等副作用；远程系统拒绝、已提交、结果未知必须分别表示，不能把重试误当幂等保证。 |
| 可观察性 | 面板聚焦等待人工决策的候选、Ticket、失败交付和来源健康。 | 有助于把 Agent 状态呈现为可操作队列；还需区分“Agent idle”“需要人”“执行失败”和“已完成”。 |
| 执行安全 | 原型假定单团队可信仓库和本地 Agent 运行环境。 | 不能作为 DSH 多租户隔离方案；Session ID、Preset 和应用授权不等于 OS sandbox 或凭据隔离。 |

最重要的概念区分是**授权与执行权限分层**。Mandate 回答“这个外部请求是否允许形成一项工作，以及允许在什么理由下继续”；DSH Permission Preset 和工具审批回答“Agent 能调用哪些能力，以及具体调用是否需要审批”。两者相互补充，任何一个都不能代替另一个。特别是自动处理外部事件时，事件发送者、仓库/组织规则、任务 Mandate、工具调用授权和操作系统权限要分别审查。

## 采用建议与验证路线

若要基于 DSH 探索相似产品，建议借用应用原则而非照搬部署形态：

1. **先选窄场景和来源。** 以一个仓库或一个明确工作流开始，定义哪些事件会进入系统、何种身份可发起工作、主动触发规则由谁维护，并先以观察模式记录候选。
2. **先定义持久领域记录。** 明确任务 ID、授权依据、来源事件 ID、执行尝试、待投递输入、外部副作用 receipt、停止与撤权语义。模型上下文和 Session 历史可以引用任务记录，不应成为唯一权威状态。
3. **为并行任务定义资源与上下文归属。** 决定何时为任务新建 Session/工作目录、如何限制同时运行数、跟进消息如何路由，以及停止任务时如何禁止迟到输入和继续写入。
4. **把外部副作用和恢复作为一等流程。** 为 GitHub 评论、Pull Request、CI 操作等定义幂等键、receipt、未知结果查询和人工接管；恢复前先核对远端状态，再允许重试。
5. **单独建立安全部署方案。** 公开原型部署文档指出其 preset 使用 `danger-full-access`，CLI wrapper 不提供进程隔离，进程以启动用户权限运行。多租户、用户提交的不可信仓库、凭据托管和任意代码执行必须另做威胁建模、sandbox 和网络出口限制。
6. **按 DSH 已有研究定义验收。** 分别验证模型可见事实能否从 Session 重建，任务状态能否独立恢复，工具/消息副作用能否按 receipt 去重，进程崩溃和远端超时是否可区分，以及无授权事件是否确实不能启动执行。

这些步骤是后续设计建议，不是本文已实现的 DSH 改造计划。现有 Cloud Agent 报告已经把 Control Plane、DSH Execution Plane、Executor、Workspace、Session ownership 和 handoff 列为不同职责；Super-agent 原型报告补充的是事件驱动任务、授权理由和人工注意力管理的具体应用例子。

## 局限与未验证事项

本次没有运行原型单元测试、类型检查、构建或真实来源接入，因此源码阅读能支持结构与机制判断，不能证明当前代码所有路径均正常工作。文章实验没有由公开仓库复现，亦未提供足以独立重建每次运行的事件、参数和原始结果；其性能数据应作为团队披露的初步证据，而非独立验证的基准。

原型面向一个团队和一个代码仓库，采用本地 SQLite 和进程锁；文档未建立跨节点调度、HA、租户级 OS 隔离、外部凭据隔离、跨仓库事务或任意 Agent 互操作的产品承诺。Feishu/GitHub Source 的可用性依赖相应帐号、网络、CLI 或 webhook 配置。未来评估生产适用性时，应针对部署环境实际运行权限和外部系统副作用做故障注入，而不是从“任务授权记录完整”推断系统安全。

## 来源

- [DeepSeek Harness 团队：《Super-agent 设计探索：迈向更自主的 Agent 系统》](reference-materials/super-agent-design-exploration.md)，公众号页面日期 2026-10-31；[原始页面](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)。
- 原型仓库：`dsh-superagent-prototype`，重点阅读 `README.md`、`docs/000-philosophy.md`、`docs/001-domain.md`、`docs/002-authorization.md`、`docs/003-execution.md`、`docs/006-deployment.md` 和 `docs/007-architecture.md`。
- 主要实现入口：`src/core/engine.ts`、`src/core/intake.ts`、`src/core/evals.ts`、`src/core/tickets.ts`、`src/core/assignments.ts`、`src/policy.ts`、`src/app/runtime.ts`、`src/app/store.ts`、`src/app/effects.ts`、`src/app/outbox.ts` 和 `src/executor/dsh.ts`。
- DSH 对照材料：[云端 Agent 架构建议](dsh-cloud-agent-architecture-recommendation.md)、[云端 SaaS Agent 研究](dsh-cloud-saas-agent-research.md)、[部署与租户隔离参考](dsh-deployment-and-tenancy-deep-dive.md)、[Agent 管理与 Watchdog 研究](dsh-herdr-agent-management-research.md)和[Agent 协作研究](dsh-agent-collaboration-research.md)。

## Dev Note

本文是基于指定 checkout 和页面日期整理的研究草稿。若公开原型、文章归档或 DSH 当前架构发生变化，应重新核对对应源码和实验材料；不要将文章中的内部系统描述自动视为公开原型现状。
