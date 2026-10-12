---
description: "DSH 研究草稿的目录级导读：按 Agentic UI、Browser-Native、Cloud/Durable Agent 和工程运营分组，说明研究结论、证据层级、推荐阅读路径与 PoC 入口。"
---

# DSH 研究草稿导读

## Summary

`docs/drafts/` 保存 DSH 当前阶段的跨包研究、架构判断、实施方案、PoC 和工程备忘。本文是这个目录的入口，不替代各专题文档，也不是 DSH 已发布运行时行为的权威说明。

如果只想理解最近关于 Agentic UI 和 Browser-Native DSH 的大图景，先读本文的[研究总览](#研究总览)，再读[综合报告](dsh-browser-native-agentic-ui-research.md)，最后查看[browser-native-dsh-poc](browser-native-dsh-poc/README.md)。

当前最重要的事实边界是：v2 PoC 已经证明真实 DSH Agent Loop 可以在 Dedicated Worker 中运行，并通过同源 LLM proxy 和远程 Session persistence 工作；它还没有证明业务 UI capability、业务 action 授权或完整 Agentic UI 已经实现。

## Table of Contents

- [如何使用这个目录](#如何使用这个目录)
- [研究总览](#研究总览)
- [推荐阅读路径](#推荐阅读路径)
- [Agentic UI 与 Browser-Native](#agentic-ui-与-browser-native)
- [Cloud Agent、Durability 与隔离](#cloud-agentdurability-与隔离)
- [工程实现与运营](#工程实现与运营)
- [Browser-Native PoC 目录地图](#browser-native-poc-目录地图)
- [证据层级与状态标记](#证据层级与状态标记)
- [当前统一结论](#当前统一结论)
- [维护规则](#维护规则)
- [Dev Note](#dev-note)

-----

## 如何使用这个目录

### 五分钟了解大图景

1. 阅读本文的[研究总览](#研究总览)和[当前统一结论](#当前统一结论)。
2. 阅读[Browser-Native 环境下实现 Agentic UI：DSH 综合深度调研报告](dsh-browser-native-agentic-ui-research.md)的 Summary、[PoC 事实核查](dsh-browser-native-agentic-ui-research.md#dsh-与-poc-的事实核查)和[最终判断](dsh-browser-native-agentic-ui-research.md#最终判断)。
3. 阅读 [Browser-native DSH PoC README](browser-native-dsh-poc/README.md) 的当前实现快照和验证章节。

### 三十分钟形成技术判断

按下面顺序阅读：

1. [DSH Agentic UI 事实核查](dsh-agentic-ui-research.md)：理解既有 SaaS GUI、DSH Tool view、Conversation Node 和业务 API 的关系。
2. [Browser-Native Agent Loop 研究](dsh-browser-native-agent-loop-research.md)：理解 Agent Loop 驻留位置、浏览器 Tool、同源 LLM proxy 和相关生态。
3. [Browser-Native Runtime 研究](dsh-browser-native-runtime-research.md)：理解 Worker、Cloud Workspace、本机桥接、持久化和 owner handoff 的运行时限制。
4. [Browser-Native 实施方案](dsh-browser-native-agent-implementation-plan.md)：查看协议、包归属、测试矩阵、迁移和上线限制。
5. [Browser-Native PoC v2 规划与进度](browser-native-dsh-poc/browser-native-dsh-plan-v2.md)和[进度记录](browser-native-dsh-poc/browser-native-dsh-progress-v2.md)：区分设计提案与实际验证。

### 需要实现或审查代码时

优先阅读[实施方案](dsh-browser-native-agent-implementation-plan.md)，再读 [PoC 协议](browser-native-dsh-poc/protocol.md)、[PoC v2 规划](browser-native-dsh-poc/browser-native-dsh-plan-v2.md)和对应的实现、测试文件。研究报告解释为什么这样设计；协议、代码和测试才分别拥有字段、行为和验证事实。

### 研究 Cloud Agent 或 Durable Workspace 时

从[Cloud Agent 架构建议](dsh-cloud-agent-architecture-recommendation.md)开始，按需要进入[Cloud Agent OSS 全景](dsh-cloud-agent-oss-landscape-review.md)、[Cloud 项目本地代码阅读备忘](dsh-cloud-projects-local-code-reading-memo.md)、[部署与租户隔离](dsh-deployment-and-tenancy-deep-dive.md)和[Remote Durable Workspace](dsh-remote-durable-workspace-pgfs-research.md)。E2B/CubeSandbox 的对比文档用于具体基础设施选型，不是 Browser-Native Agentic UI 的前置阅读。

-----

## 研究总览

### 三条研究轴

当前研究围绕三个相互连接、但不能互相替代的轴展开：

| 研究轴 | 回答的问题 | 主要成果 |
|---|---|---|
| Interaction plane：Agentic UI | 用户在 Chat UI 中看到什么、操作什么，怎样复用已有 SaaS GUI | `dsh-agentic-ui-research.md`、`dsh-browser-native-agentic-ui-research.md` |
| Execution plane：Browser-Native | Agent Loop 在哪里运行，怎样访问浏览器状态和前端 Tool | `dsh-browser-native-agent-loop-research.md`、`dsh-browser-native-runtime-research.md`、PoC v2 |
| Durability plane：Cloud/Durable Agent | 页面退出、机器故障或长任务发生后，谁继续执行以及状态如何恢复 | Cloud Agent 系列、Remote Durable Workspace、实施方案中的 handoff 章节 |

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
  → Browser-Native Agent Loop 研究
  → Browser-Native Runtime 研究
  → Browser-Native 实施方案
  → Browser-Native DSH PoC v2
  → 综合 Agentic UI 方案
```

这不是严格的提交或实现顺序，而是读者理解问题的推荐顺序。综合报告把前四层的产品命题、运行时边界和 PoC 事实合并；PoC 仍然是“已实现/已验证”最重要的证据入口。

-----

## 推荐阅读路径

### 路径 A：产品和交互设计

适合回答“为什么要把已有 SaaS GUI 带进 Chat UI、这和 Generative UI 有什么区别”。

1. [DSH Agentic UI 事实核查](dsh-agentic-ui-research.md)
2. [综合 Agentic UI 报告](dsh-browser-native-agentic-ui-research.md)
3. [综合报告中的 Typed UI Capability 设计](dsh-browser-native-agentic-ui-research.md#typed-ui-capability-设计)
4. [综合报告中的客户创建时序](dsh-browser-native-agentic-ui-research.md#完整业务时序客户创建)

### 路径 B：运行时和协议实现

适合回答“怎样把 Agent Loop 放进 Worker、怎样调用模型、怎样持久化和恢复”。

1. [Browser-Native Agent Loop 研究](dsh-browser-native-agent-loop-research.md)
2. [Browser-Native Runtime 研究](dsh-browser-native-runtime-research.md)
3. [Browser-Native 实施方案](dsh-browser-native-agent-implementation-plan.md)
4. [PoC v2 协议](browser-native-dsh-poc/protocol.md)
5. [PoC v2 进度](browser-native-dsh-poc/browser-native-dsh-progress-v2.md)

### 路径 C：直接复现 PoC

适合需要运行、修改或审查现有实验代码的开发者。

1. [PoC README](browser-native-dsh-poc/README.md)：入口、运行命令和当前边界。
2. [v2 规划](browser-native-dsh-poc/browser-native-dsh-plan-v2.md)：为什么选择现有 preview、Worker profile 和 provider injection。
3. [v2 协议](browser-native-dsh-poc/protocol.md)：wire DTO、错误码、幂等、owner 和持久化语义。
4. [v2 backend](browser-native-dsh-poc/backend-v2.mjs)、[Worker](browser-native-dsh-poc/browser-native-worker.ts)和[providers](browser-native-dsh-poc/browser-native-providers.ts)：实现入口。
5. [backend contract tests](browser-native-dsh-poc/tests/backend-v2.test.mjs)和[browser E2E](browser-native-dsh-poc/tests/browser-native-v2.e2e.mjs)：行为证据。

### 路径 D：Cloud Agent 和长期执行

适合回答“浏览器不在线时谁继续工作、Cloud Workspace 怎样和 Agent 工具保持一致”。

1. [Cloud Agent 架构建议](dsh-cloud-agent-architecture-recommendation.md)
2. [Cloud SaaS Agent 研究](dsh-cloud-saas-agent-research.md)
3. [部署与租户隔离深度调研](dsh-deployment-and-tenancy-deep-dive.md)
4. [Remote Durable Workspace](dsh-remote-durable-workspace-pgfs-research.md)
5. [E2B 与 CubeSandbox 深度对比](dsh-e2b-vs-cubesandbox-deep-comparison.md)
6. [CubeSandbox 深度调研](dsh-cubesandbox-deep-research.md)

-----

## Agentic UI 与 Browser-Native

| 文档 | 角色 | 读者应带走的结论 |
|---|---|---|
| [dsh-agentic-ui-research.md](dsh-agentic-ui-research.md) | 产品命题、外部事实核查、DSH 代码考古 | Agent 应复用既有 SaaS 能力和 UI，而不是生成第二套业务系统；当前 DSH 有 Tool、Session、Tool view 和 Conversation Node 扩展点，但没有现成 CRM Agentic UI 协议。 |
| [dsh-browser-native-agent-loop-research.md](dsh-browser-native-agent-loop-research.md) | Browser-Native 定义、生态比较、DSH 缺口 | 完整 Browser-Native Agent 要让 Loop 驻留 Dedicated Worker；同源 LLM proxy、结构化 UI state、前端 Tool 和 owner 语义都必须明确。 |
| [dsh-browser-native-runtime-research.md](dsh-browser-native-runtime-research.md) | Worker、Cloud Workspace、本机桥接、持久化和恢复 | Worker 不是 durable daemon，浏览器隔离不是业务授权；执行世界、存储、owner 和 handoff 必须分别建模。 |
| [dsh-browser-native-agent-implementation-plan.md](dsh-browser-native-agent-implementation-plan.md) | 工程实施方案 | 复用 DSH Loop 和 Session；用独立 `/api/llm`、Main/Worker typed bridge、profile 分类、owner fencing 和 durable handoff 逐阶段落地。 |
| [dsh-browser-native-agentic-ui-research.md](dsh-browser-native-agentic-ui-research.md) | 两类研究的综合报告 | UI capability 是连接既有 SaaS UI 和 Browser Worker Agent Loop 的关键缺口；PoC runtime substrate 已有，业务 capability seam 尚未完成。 |

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
| [dsh-research-branch-push-memo.md](dsh-research-branch-push-memo.md) | 研究分支提交、推送和文档登记流程 | 需要把新的研究草稿安全存档到当前研究分支时。 |

这些文档不是 Browser-Native Agentic UI 的产品设计，但提供了实现研究所需的代码阅读、外部状态观察和研究分支维护入口。

-----

## Browser-Native PoC 目录地图

### 当前 v2 的事实入口

| 文件 | 事实所有权 |
|---|---|
| [README.md](browser-native-dsh-poc/README.md) | 运行入口、v2 当前快照、验证命令、目录边界和历史版本说明。 |
| [browser-native-dsh-plan-v2.md](browser-native-dsh-poc/browser-native-dsh-plan-v2.md) | v2 实施规格、接入决策、profile、backend 协议和完成定义。 |
| [browser-native-dsh-progress-v2.md](browser-native-dsh-poc/browser-native-dsh-progress-v2.md) | 当前人工验收、测试结果、已修复缺口和未完成范围。 |
| [protocol.md](browser-native-dsh-poc/protocol.md) | PoC wire DTO、错误码、禁止字段、幂等、owner 和持久性语义的协议 owner。 |
| [change-ledger.md](browser-native-dsh-poc/change-ledger.md) | PoC 目录外接线、upstream 重放和删除条件。 |

### v2 实现和测试入口

| 文件 | 用途 |
|---|---|
| [browser-native-worker.ts](browser-native-dsh-poc/browser-native-worker.ts) | 在 Dedicated Worker 中启动真实 DSH Host。 |
| [browser-native-providers.ts](browser-native-dsh-poc/browser-native-providers.ts) | Worker 侧远程 `SessionPersistence` 和 `LlmAdapter` provider。 |
| [backend-v2.mjs](browser-native-dsh-poc/backend-v2.mjs) | Session backend、durability、owner fencing 和 LLM proxy。 |
| [run-v2.mjs](browser-native-dsh-poc/run-v2.mjs) | 构建产物上的 v2 launcher。 |
| [tests/backend-v2.test.mjs](browser-native-dsh-poc/tests/backend-v2.test.mjs) | backend contract tests。 |
| [tests/browser-native-v2.e2e.mjs](browser-native-dsh-poc/tests/browser-native-v2.e2e.mjs) | 真实 DSH Web UI + Chromium + backend 的组合 E2E。 |

### 历史实验和阅读注意事项

旧版 [implementation-plan.md](browser-native-dsh-poc/implementation-plan.md)、[progress.md](browser-native-dsh-poc/progress.md)、[protocol.mjs](browser-native-dsh-poc/protocol.mjs)、`public/` 和对应测试用于追溯独立协议实验。它们不能证明 v2 已经运行真实 DSH `ctx.agentLoop`；判断当前实现时以 `README.md`、`*-v2.md`、`protocol.md`、v2 实现和 v2 测试为准。

-----

## 证据层级与状态标记

### 证据优先级

阅读任一研究文档时，按下面顺序判断“这件事是否已经实现”：

1. 当前 checkout 的源代码和实际测试结果。
2. PoC README、progress、protocol 和 change ledger 中的已验证记录。
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

对外描述当前成果时，推荐使用：“Browser-Native DSH runtime substrate 已通过 v2 PoC 验证；Agentic UI 的 typed business capability seam 仍在设计和实现阶段。”

-----

## 当前统一结论

- Agentic UI 的正确目标是复用既有 SaaS 的业务能力和 GUI，而不是让模型生成任意 HTML、JavaScript 或第二套 CRM。
- Browser-Native 的严格含义是 Agent Loop 驻留 Dedicated Worker，并通过同源、受限的 LLM proxy 请求模型；Backend callback 不能被误写成 Browser-Native Loop。
- Main Thread 负责真实 UI、结构化 state adapter、用户手势和受控 action；Worker 负责 DSH Loop、Tool orchestration 和 Session projection；Backend 负责身份、租户、业务授权、权威副作用和 durable job。
- DSH 当前已有 Agent Loop、Tool lifecycle、Session persistence、Tool view、Conversation Node 和 Worker runtime 基座；它们需要通过新的 typed UI capability seam 组合，而不是复制一个 Browser Agent Loop。
- v2 PoC 已验证真实 DSH Worker Host、`ctx.agentLoop`、远程 Session persistence、同源 LLM proxy、flush durability 和 owner fencing；它尚未验证业务 UI state、业务 action、业务 API 授权或完整 UI continuation。
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
- 新增 PoC 文件时，先更新 [PoC README](browser-native-dsh-poc/README.md) 的目录边界和验证入口；协议字段以 [protocol.md](browser-native-dsh-poc/protocol.md) 为 owner。
- 研究文档中的“已验证”和“建议”必须显式区分；运行时行为以源码和测试为准，设计目标以实施方案为准。
- `docs/drafts/` 当前不在 VitePress 网站的公开页面清单中；不要把这里的研究草稿误当作已发布用户文档。需要正式发布时，应先迁移到合适的 `docs/` owner，并按双语和网站 manifest 规则处理。
- 不在本文复制专题文档的完整协议、代码或历史；本文只维护目录关系、阅读顺序、证据边界和跨主题综述。

## Dev Note

本文是 `docs/drafts/` 的目录级 scratch 入口，不是稳定架构决策、包 README 或发布文档。它只索引当前研究成果并总结跨文档关系；具体事实仍由链接到的专题文档、源码、测试和 PoC 协议各自拥有。
