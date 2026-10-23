---
description: "调研 DSH agent 之间如何通信与协作：区分同进程 subagent 委派、同进程 Agent Teams peer、跨进程 DSH 协作与跨厂商互操作，核实 ACP、SDK 与 A2A 的能力边界，并提出尚未实现的跨进程 DSH peer 协作架构方案。"
---

# DSH Agent 协作：能力边界、协议选型与跨进程方案深度调研

## Summary

本报告回答一个具体问题：**两个各自独立运行的 DSH agent（可能是不同进程、不同机器）如何互相通信、协商、共享任务状态并完成协作。**报告区分四种在实现上互不相同的协作形态，给出各自的现状、边界与证据，然后给出跨进程 DSH 协作的推荐架构、协议选型判断和分阶段落地路线。

四个形态是：parent→subagent 的**委派**（含同进程与跨进程两种后端）、同进程内的**peer 团队**（Agent Teams）、跨进程的**独立 root agent 对等协作**、以及跨厂商的 **agent 互操作**。把它们混为一谈是本领域大部分误解的来源：委派有父子权威和单向语义，peer 有对等身份和双向语义，而它们的持久化权威、生命周期和失效规则完全不同。

核心结论是：

1. **DSH 当前的原生 peer 协作能力止步于单进程**（本地源码印证）。Agent Teams 已提供核心 peer 原语——持久 roster、兄弟间持久邮箱、共享任务 DAG、等待与中断——但它刻意只覆盖单进程：Team 协调状态写在 Lead 的 Session 日志里，而 Session 日志是单写者的。
2. **在已核查的 DSH 交付面中，跨进程 root peer 协作需要自建**（范围性源码/文档结论）。现有跨进程 subagent 能力（`subagent-acp`、`subagent-dsh-sdk`）是 parent→child 委派语义，不提供 peer 发现、消息归因、离线邮箱、去重或共享任务板。
3. **ACP 是"控制器驱动 agent"协议，不是 peer 协议**（本地源码与 ACP 官方文档印证）。DSH 已交付的是 ACP server 与"每次委派 spawn 一个子进程"的 ACP subagent 后端；连接一个已存在 peer、保持双向拓扑、离线排队和消息归因仍需要自建控制层。
4. **A2A v1.0/v1.0.1 已有稳定 release、官方 SDK 和广泛产业支持声明，但公开 Agent Card 版本尚未统一**（官方网页与第三方普查印证；产业支持数是项目方口径）。
5. **推荐方案是"中心 durable broker + 两侧 peer 插件"，而不是复用现有 seam**（架构推断，未实现、未运行）。复用 `ctx.subagents` 会继承父子权威假设，复用 `ctx.agentTeams` 则要求把单写者 Session 日志改造成多写者共享存储。新的 `ctx.agentPeers` 域更贴合 peer 的权威与生命周期语义；同时必须显式设计控制面可用性、跨机器工作区、任务租约与授权。

本报告是研究文档，不改变任何已发布运行时行为。除明确说明的联网核查和文档门禁外，本报告没有运行 DSH 产品测试、跨进程 peer 原型或 A2A 互通样例；因此"源码印证"不等于"运行验证"。

## 证据等级与验证边界

本报告使用以下固定等级。正文中的"印证"只表示证据能支持该断言，不自动表示已执行运行时测试。本地证据绑定当前 checkout；外部网页核查日期为 2026-10-21。

| 等级 | 含义 | 已做 | 不代表 |
|---|---|---|---|
| L1 本地源码印证 | 当前 checkout 的源码、类型、package manifest 直接支持结论 | 阅读 Agent Teams、Session lease、subagent、ACP、SDK、Web connection 等相关实现 | 未重跑这些包的行为测试，也未启动真实 profile 做端到端验证 |
| L2 仓库行为声明 | 包 README、subsystem 文档或 Agent Note 声明测试/行为覆盖 | 与源码交叉核对，不把孤立 README 当更强证据 | 未重跑声明中的测试；实现可能随后续提交变化 |
| L3 外部官方核查 | 当天打开并读取官方规范、release、公告或项目文档 | 核查 A2A 与 ACP 的版本、能力和官方 SDK 列表 | 未调用外部服务，也未验证任一具体厂商部署 |
| L4 第三方公开普查 | 第三方公开样本统计 | 核查样本、口径和限制；不同普查不相加 | 不代表企业内部部署、私有服务或全行业采用率 |
| L5 架构推断 | 基于已印证机制做出的方案设计或取舍判断 | 与现有 DSH 边界一致性推理 | 未实现、未测试、未证明性能、可靠性或安全性 |
| L6 明确未知 | 当前证据不足 | 在正文或 Dev Note 标注 | 不把未知写成不支持、已支持或必然失败 |

对应的章节等级如下：

| 章节 | 证据等级 | 关键验证边界 |
|---|---|---|
| 二、协作形态划分 | L1 + L2 | "跨进程 root peer 未发现已交付能力"是范围性结论，不是全仓库形式化穷举 |
| 三、Agent Teams | L1 + L2 | 未重跑 Agent Teams 包测试；单进程与共享 checkout 限制由源码/文档直接声明 |
| 四、Session 写租约 | L1 + L2 | 未实测两个进程争抢同一 Session；锁语义来自实现与决策记录 |
| 五、subagent 后端 | L1 + L2 | 未运行跨进程委派；结论来自 provider 源码与契约文档 |
| 六、ACP | L1 + L3 | 未连接两个 ACP server；ACP PoC 形态是 L5 设计 |
| 七、SDK 协议 | L1 + L2 | 未启动 SDK server；方法与限制来自协议文档和实现 |
| 八、A2A | L3 + L4 + L5 判断 | 未做 A2A 互通测试；支持组织数是项目方口径 |
| 九至十四、方案与验收 | L5 | `ctx.agentPeers`、broker、profile、工具和验收全部未实现 |
| 十、既有扩展点接合 | L1 + L5 | 现有机制是 L1；新增 source 与复用方式是设计 |
| 十五、证据索引 | L1-L4 | 只索引报告实际依据，不扩大证据含义 |

### 不可从本报告外推的结论

- "未发现已交付的跨进程 root peer 能力"只覆盖当前 checkout 中 Agent Teams、subagent、ACP、SDK、Web/API 等已核查面；它不证明外部私有插件或未来分支不存在此类能力。
- 第九节至第十四节不包含性能、吞吐、故障恢复或安全性的实测结论。broker、lease、HA 和授权方案在实现前都是设计要求。
- A2A 的组织支持数、云平台集成和公开 card 普查是三种不同测量；本报告不推导全行业采用率，也不保证任意两个 A2A 实现可以互通。
- PostgreSQL、NATS JetStream、Redis Streams 只是候选存储/队列类别。本报告没有对这些产品做基准测试，也没有做出选型承诺。
- ACP orchestrator 是最小 PoC 设计。它是否能在真实长时间运行中保持稳定，需要单独实现和测试。

## Table of Contents

- [证据等级与验证边界](#证据等级与验证边界)
- [一、问题的原始含义](#一问题的原始含义)
- [二、四种协作形态的划分](#二四种协作形态的划分)
- [三、结论一：Agent Teams 提供了核心 peer 原语，但止步单进程](#三结论一agent-teams-提供了核心-peer-原语但止步单进程)
- [四、结论二：跨进程写入的架构性阻断来自 Session 单写者模型](#四结论二跨进程写入的架构性阻断来自-session-单写者模型)
- [五、结论三：现有跨进程后端都是委派语义，不是 peer 语义](#五结论三现有跨进程后端都是委派语义不是-peer-语义)
- [六、结论四：ACP 是什么、能做什么、不能做什么](#六结论四acp-是什么能做什么不能做什么)
- [七、结论五：SDK 协议为什么不是跨进程控制面的合适选择](#七结论五sdk-协议为什么不是跨进程控制面的合适选择)
- [八、结论六：A2A 的成熟度、覆盖面与真实缺口](#八结论六a2a-的成熟度覆盖面与真实缺口)
- [九、推荐架构：broker + peer 插件](#九推荐架构broker--peer-插件)
- [十、与 DSH 既有扩展点的接合](#十与-dsh-既有扩展点的接合)
- [十一、跨进程协作的固有难题与失败模式](#十一跨进程协作的固有难题与失败模式)
- [十二、方案取舍与不推荐的做法](#十二方案取舍与不推荐的做法)
- [十三、分阶段落地路线](#十三分阶段落地路线)
- [十四、验收清单](#十四验收清单)
- [十五、证据索引](#十五证据索引)
- [Dev Note](#dev-note)

---

<a id="一问题的原始含义"></a>
## 一、问题的原始含义

证据状态：本节整理提问范围和概念区分，不含运行时行为断言。

### 提问的实际范围

提问包含四个逐步放宽的层次，且明确排除了第一层：

1. agent 与它自己的 subagent 之间的通信——**明确排除**。
2. 同一个 DSH 进程内，多个 agent 之间的对等协作。
3. 不同 DSH 进程之间，各自独立运行的 agent 之间的协作。
4. DSH agent 与非 DSH 的外部 agent 之间的互操作。

层次 3 是提问者的核心期望。层次 4 需要跨厂商互操作协议或专门适配层；本报告以 A2A 作为标准协议代表，把主要篇幅放在层次 2 与 3，把层次 4 作为"何时才需要"的边界条件。

### 为什么"委派"与"协作"必须分开

两者的区别不是风格问题，而是影响持久化设计、权限模型和失败恢复方式的结构性差异。

| 维度 | 委派（delegation） | 协作（collaboration） |
|---|---|---|
| 身份 | 父子：父创建子，子是被创建的产物 | 对等：双方各自独立存在 |
| 权威 | 父进程拥有子级生命周期与结果收集 | 无共同权威，或权威在第三方 |
| 方向 | 父→子，子的回报是结果 | 双向，消息是内容而非结果 |
| 生命周期 | 父拥有子，父退出即子失效 | 双方独立存活 |
| 寻址 | 父通过目录（`subagentCatalog`）枚举自己的孩子 | 双方通过成员表互相寻址 |
| 失败语义 | 子失败=任务失败，父可重试 | 对方离线=消息排队，不是失败 |

已核查的 DSH 跨进程 subagent 能力都建立在"委派"语义上。把它们直接当作 peer 方案使用，会在实现中不断遇到"谁拥有这个 agent""消息发到哪里""对方不在线怎么办"这类在委派模型中不存在的问题。

### 术语消歧：两个 ACP

讨论 agent 协议时，ACP 这个缩写有两个不相关的含义，这是公开讨论中最常见的混淆源：

- **Agent Client Protocol**（Zed 生态）：编辑器或客户端 ↔ 编码 agent。DSH 实现的是这个。
- **Agent Communication Protocol**（IBM Research / BeeAI）：agent ↔ agent。该项目在 2025 年 8 月停止独立开发并并入 A2A。

本报告中的 "ACP" 一律指 Agent Client Protocol。提到 IBM 那个时使用全称。

---

<a id="二四种协作形态的划分"></a>
## 二、四种协作形态的划分

证据状态：L1/L2。本节描述当前 checkout 中已核查的交付面；负向结论是范围性结论，不是全仓库形式化穷举。

### 能力矩阵

| 形态 | 现状 | 权威位置 | 消息方向 | 持久化保证 |
|---|---|---|---|---|
| parent→subagent（同进程） | 已交付 | 父进程 | 父→子 | 子 Session 独立持久化 |
| parent→subagent（跨进程） | 已交付 | 父进程 | 父→子，一次性 | 父日志只记委派调用与结果 |
| 同进程 peer 团队 | 实验性 | Lead 的 Session 日志 | 双向、持久、可续接 | 进程内重试 + 目标 Session 去重 |
| **跨进程 DSH root↔root** | **未发现已交付能力** | — | — | — |
| 跨厂商 agent 互操作 | 未发现 DSH 内建 A2A 实现 | 外部服务 | 双向（A2A Task） | 取决于对端实现 |

### DSH 中"跨进程"已有的三种形态

仓库里"跨进程"实际指三件不同的事，容易混淆：

1. **子进程委派**：`subagent-dsh-sdk` 在新进程里跑完整 DSH 运行时，`subagent-acp` 在新进程里跑 ACP 兼容 agent。两者都是父发起、子返回结果。
2. **独立启动的 DSH 实例**：两个 `dsh` 进程，各自拥有自己的 profile、home 和 session 根目录；已核查的协作 seam 未提供它们之间的内建 peer 连接。
3. **多实例共享同一 Harness home**：两个进程共享 `$DSH_HOME`，因此能看到同一批持久 Session，但同一 Session 的写权由内核锁排他。

第 3 种形态是跨进程 peer 协作最重要的现实基础，也是最容易被误解的一点：**共享 home 提供了共享的持久化存储，但同时提供了单写者约束。**共享 Session 日志的方案必须在这两者之间做取舍。

---

<a id="三结论一agent-teams-提供了核心-peer-原语但止步单进程"></a>
## 三、结论一：Agent Teams 提供了核心 peer 原语，但止步单进程

证据状态：L1/L2。源码、包 README 和 Agent Note 相互印证；本报告未重跑 Agent Teams 测试。

### 它提供的 peer 原语

`ctx.agentTeams` 是 DSH 已发布的显式协作 seam，已经覆盖一组核心 peer 原语：

- **持久 roster**：每个普通运行时 root 是隐式 Team 的 Lead（`TeamId` 等于 `SessionId`）。teammate 是具名、不可复用名字的 continuable 直接 child，状态为 `running`／`inactive`／`provisioning`／`failed`。名字由第一条 provisioning 记录永久保留，失败的 teammate 也不释放名字。
- **兄弟间持久邮箱**：`send_message` 对任意成员开放（不只是 Lead→子）。live 目标立即尝试投递，运行中的目标在最近的 step 边界收到，离线目标排队并在恢复后投递。每条消息以 `Team message <id> from <name>:` 进入目标模型历史，`TeamMessageSource` 在目标 Session 中保留消息身份，用于跨 inbox 与历史的折叠去重。
- **共享任务 DAG**：任务带 `blockedBy` 依赖、owner、单调递增的 `revision`（compare-and-set）、`writeScopes` 路径提示。删除保留 tombstone。
- **等待与中断**：`wait_agent` 等待注册之后发生的下一次变化而不轮询；Lead 可 `interrupt` 打断 teammate 当前轮次且保留其 inbox。
- **Web 投影**：成员列表、任务看板、成员会话导航。

模型工具面为 `spawn_teammate`、`send_message`、`list_agents`、`wait_agent`、`interrupt_agent`、`team_task_create`、`team_task_list`、`team_task_get`、`team_task_update`。

### 跨进程为什么被明确排除

包 README 的"何时选择"段落直接写明：当 teammate 需要独立工作目录、**多个进程需要协调同一支团队**、或任务 owner 需要自动释放时，请不要选择——这些都不受支持。已知限制段落则写明"mailbox 不保证跨进程 exactly-once——不支持多个 harness 进程并发操作同一 Team"。

这不是"功能没写"，而是**当前 journal 架构下的结构性排除**。原因在下一节展开。

### 即使去掉跨进程限制，Team 语义仍不等于 peer 语义

即使把存储改成多写者，Agent Teams 的模型仍然与独立进程的 peer 有本质差异：

- **teammate 是父进程拥有的 continuable child**。`spawnTeammate` 先在 Lead 日志追加并 flush `provisioning` 记录，再要求提供方创建预留 child。跨进程 peer 是独立进程的 root agent，没有父子归属，也没有共享的生命周期 owner。
- **Lead 是权威**。只有 Lead 可以 spawn、reassign、interrupt。peer 之间是对等的，任何一方都可以发起。
- **Team 是隐式且扁平的**。`TeamId` 就是 Lead 的 `SessionId`，没有创建事件，不支持嵌套 Team、重命名、删除或名字复用。

因此跨进程 peer 协作不是"把 Agent Teams 的锁去掉"这么简单。

---

<a id="四结论二跨进程写入的架构性阻断来自-session-单写者模型"></a>
## 四、结论二：跨进程写入的架构性阻断来自 Session 单写者模型

证据状态：L1/L2。以下锁语义来自当前源码与决策记录；本报告未用两个进程实测争抢同一 Session。

### 事实链

Agent Teams 的持久协调状态——`team/member`、`team/task`、`team/message/queued`、`team/message/delivered`——都是**追加到 Lead Session 日志的 Session 事件**。而 Session 日志的跨进程写所有权由 `SessionWriteLease` 把守：

- POSIX：通过预编译原生绑定以非阻塞 `flock(2)` 加锁日志旁的 `session.lock`。
- Windows：持有由规范锁路径派生的命名内核信号量（`CreateSemaphoreW`，计数 1），零文件系统足迹。
- 竞争映射为 `SessionAlreadyOwnedError`。持有者进程死亡时内核自动释放锁，因此崩溃的持有者不阻塞后继者。
- **活着但卡死的持有者保有锁直到其进程退出**：设计明确否决了带过期时间的接管，因为持有者复活后的追加会撕坏日志。
- 咨询式 `flock` 在部分网络文件系统（NFSv3）上不可靠，落在此类挂载上的根目录退化为仅进程内排他。

`SessionPersistence` seam 自身也只保证"单个后端实例内的写所有权"，跨进程排他由具体提供方负责。

### 由此得到的硬约束

**两个 DSH 进程不能同时写同一个 Session。**这意味着：

1. "两个进程并发操作同一支 Team"与当前实现不兼容——Team 协调状态由同一份 Lead Session journal 串行写入。
2. 以 Session 日志作为共享协作状态时，不能让两个进程并发写入；需要把共享状态移到支持所需写模型的独立存储。
3. 反过来，**一个 Session 由一个 owner 进程写**这件事与 peer 模型完全兼容：peer 消息由 broker 持有直到目标确认，目标进程只写自己的 Session。

### 这解释了为什么"共享 home + 共享 workspace"适合同机起步

在建议的 broker 方案中，两个 DSH 进程可以共享 `$DSH_HOME`（因此共享持久 Session 存储）并共享工作目录，但各自拥有自己的 Session 集合。peer 消息不直接落在目标 Session 日志里，而是先落在 broker 的存储里。目标进程收到消息后写自己的 Session——写者唯一，租约语义不受影响。这是设计推演，不是现有运行时行为。

这个拓扑只适合同机 PoC，不是通用生产答案。共享 home 会同时共享 profile、凭据和 Session 目录，扩大一个进程的配置错误对其他进程的影响；共享 workspace 也让任意 shell 工具成为并发写入者。跨机器场景还必须解决工作区映射：Git/artifact 交换、远程文件系统，或把协作目标从"共同编辑一棵树"改为"交换结构化结果"。没有这层设计，agent 之间只能通信，不能可靠协作。

---

<a id="五结论三现有跨进程后端都是委派语义不是-peer-语义"></a>
## 五、结论三：现有跨进程后端都是委派语义，不是 peer 语义

证据状态：L1/L2。结论来自当前 provider 源码与契约文档；本报告未运行跨进程委派。

### `ctx.subagents` 提供方注册表

`ctx.subagents` 是具名提供方注册表，接口是 `start(request) → Promise<SubagentRun>`。现有提供方：

| 提供方 | 进程 | 续接能力 | 用途 |
|---|---|---|---|
| `subagent-spawn-in-process` | 同进程 | — | 全新 Session 的子 agent |
| `subagent-fork-in-process` | 同进程 | — | 以父日志前缀初始化的子 agent |
| `subagent-acp` | 跨进程 | 一次性 | 驱动 ACP 兼容子进程 |
| `subagent-dsh-sdk` | 跨进程 | 一次性 | 在新进程跑完整 DSH 运行时 |
| `subagent-codex`、`subagent-claude-code` | 跨进程 | 一次性 | 官方产品进程 |

### 委派语义的具体表现

`subagent-acp` 的实现展示了这种模型的所有特征：

- 父进程 spawn 子进程，握手 `initialize` + `session/new`，拿到远程 `sessionId`。
- 父进程发送任务，子进程返回最终 assistant 文本；**中间消息和工具流量不进入父级对话**。
- 权限请求由父进程按配置策略自动应答（`allow` 或 `reject`），不呈现给人。
- 取消是 best-effort 的 `session/cancel` 通知，真正的权威是进程拆除。
- 没有持久化的远程会话 id 供后续续接，所以"可继续的 ACP 子级"是已记录的未做工作。

`subagent-dsh-sdk` 同样是这个模型：每次运行 spawn 全新进程、无进程池，父级只收到最终文本或安全错误。

### 邻接消息的授权限制

`ctx.subagents` 的 `sendMessage()` 允许**邻接** agent 互发消息，但"邻接"被严格定义为直接 parent↔直接 child 关系：

- 发送方必须是确切的在线 Agent。
- 只能发给自己的直接可继续 child；只有持有驻留可继续 Activation 的发送方可以发给自己直接的 parent。
- 消息通过 Steer 投递：运行中的目标在最近的 step 边界收到，空闲目标启动轮次。
- **没有持久化的 parent mailbox**：parent 不在线时消息被拒绝，而不是接受并排队。

注意 `ctx.subagents` 内部已有 `AgentMessageSource`（`kind: 'agent-message'`，`form: 'relay'`）这一 durable 归因机制——它说明 DSH 已能表达模型编写的 agent 间消息的内容与来源，只是作用域被限制在父子邻接。跨进程 peer 消息可以沿用这一表达方式。

### 结论

在已核查的契约中，现有跨进程后端回答"如何把一件事交给另一个进程里的 agent"，不回答"两个独立 agent 如何互相通信"。前者是一次性任务委派，后者需要持续的对等关系：成员表、消息归因、离线队列、去重、共享状态。

---

<a id="六结论四acp-是什么能做什么不能做什么"></a>
## 六、结论四：ACP 是什么、能做什么、不能做什么

证据状态：ACP 定义与通用传输能力为 L3；DSH 暴露的方法和 `subagent-acp` 行为为 L1/L2；“ACP orchestrator PoC”为 L5 设计，未运行。

### 它是什么

Agent Client Protocol 是编辑器/客户端 ↔ 编码 agent 的标准协议，由 Zed Industries 发起并发展出多编辑器生态；JetBrains 也参与协作。DSH 以**仅自动化子集**实现它，作为独立传输层放在 `packages/acp/acp`（与 `ui` 包组分离），基于 `@agentclientprotocol/sdk` 1.4.0。

ACP 官方文档把本地 JSON-RPC over stdio 作为本地 agent 形态，也描述远程 HTTP/WebSocket 场景，但标明远程支持仍在推进中。DSH 当前交付的 ACP server 使用 stdio；因此本报告讨论跨机器 ACP 时必须区分"ACP 协议的远期/通用能力"与"DSH 当前可部署形态"。

这个"仅自动化"边界是刻意的决策：ACP 桥接层一度演化成第二套交互式产品 UI（编辑器卡片、diff、计划、标题、模式选择器、会话导航），与 TUI 和 Web 客户端重复。决策把这些展示职责移出，只保留自动化控制面。

### DSH ACP 服务器提供的协议方法

| 方法 | 语义 |
|---|---|
| `initialize` | 公布 ACP v1 稳定版本与本部署支持的能力 |
| `session/new` | 新建持久 agent，返回完整配置选项状态 |
| `session/list` | 分页列出可恢复的持久根会话 |
| `session/resume` | 恢复一个持久且非活跃的会话 |
| `session/close` | 停稳式取消、drain、后代释放、flush |
| `session/set_config_option` | 串行更新 `model` 或 `reasoning_effort` |
| `session/prompt` | 每会话一次一个提示词 |
| `session/cancel` | 提示词所属的取消路径 |
| `session/update` | 已提交 assistant 消息、thought、通用工具生命周期、配置、用量 |
| `session/request_permission` | 一次性 allow/deny 权限决定 |

明确不支持：`session/load`、删除、fork、附加目录、SSE、ACP 传输 MCP、mode、命令、计划、终端、客户端文件系统操作、elicitation。

### 作为跨进程 peer 通道的评估

协议本身可以承载控制器与 DSH 之间的自动化请求、更新和权限交互；`subagent-acp` 的源码和契约文档表明 DSH 可以作为 ACP 客户端驱动另一个 ACP 进程。但当前交付形态有一个关键限制：`subagent-acp` **每次运行都 spawn 一个新的子进程**，握手、`session/new`、提示词、取消和进程回收都属于这次一次性委派。它没有"连接到一个已经存在的 peer 并保持会话"的客户端模式。

因此，ACP 互连 PoC 的最小形态不是一个现成配置，而是三部分：

1. 两个 DSH 进程各自运行 `dsh --profile acp`；
2. 一个小的外部 orchestrator 分别持有它们的 stdio 连接；
3. orchestrator 把自建 peer 信封转换成两个方向的 `session/new`／`session/resume`／`session/prompt`／`session/cancel` 调用。

这个 orchestrator 仍然要自己实现成员表、消息去重、离线队列和共享任务板。若要跨机器，还必须在 stdio 外补充传输、认证和进程监督；ACP server 的信任模型是"stdio controller 可信"，不是公网服务模型。

**ACP 协议能提供的基础能力**是：持久会话创建、列举与恢复；每会话一个串行提示词；取消；关闭；语义更新流；机器应答权限请求。这些能力足够验证端到端自动化，但不构成 peer 协作。

**它缺失的**（这些恰是 peer 协议的核心）：

| peer 需求 | ACP 现状 |
|---|---|
| 成员发现 | 无。仍需 broker 或静态配置 |
| 消息归因 | DSH ACP 提示词内容面只有文本、资源链接和受支持图片；没有 DSH peer 成员身份。发送方身份需自行放入内容或资源引用 |
| 邮箱语义 | DSH ACP server 不提供 queued/accepted peer 状态、离线 peer 队列或 peer 消息去重。`session/prompt` 是"每会话一次一个提示词"，忙时阻塞，更接近 Queue 而非 Steer |
| 多方并发投递 | DSH ACP server 不提供成员表或多方 peer fan-out |
| exactly-once | DSH ACP server 与 `subagent-acp` 不提供 peer 消息 exactly-once 语义 |
| 跨机安全 | DSH ACP server 走 stdio 且**信任其 controller**。认证、授权、租户隔离需自行叠加 |
| 共享任务板 | DSH ACP server 不提供共享任务板 |

### 结论

ACP 适合两件事（L5 判断）：作为跨进程协作的 **PoC 通道**，以及作为**接入已有 ACP 兼容 agent** 的标准接口。它不适合直接充当 peer 协议，因为 peer 语义里最关键的部分（发现、归因、离线邮箱、去重、共享状态）在 DSH ACP 交付面中没有对应物，而补齐这些恰好就是 peer 方案本身的工作量。

---

<a id="七结论五sdk-协议为什么不是跨进程控制面的合适选择"></a>
## 七、结论五：SDK 协议为什么不是跨进程控制面的合适选择

证据状态：L1/L2。方法集合和限制来自协议 README 与服务实现；本报告未启动 SDK server。

DSH SDK 协议（`dsh-sdk-protocol`）是换行分帧的 JSON-RPC 2.0，服务端是 `dsh-sdk-jsonrpc-server`，客户端是 TypeScript 的 `dsh-sdk-client` 与 Python SDK。

### 方法集合

| 方向 | 方法 |
|---|---|
| client→server | `initialize`、`session/prompt`、`shutdown` |
| server→client | `session.event`、`session.status`、`subagent.started`、`subagent.finished` |

### 为什么它不适合做跨进程控制面

- **无取消方法**。客户端放弃轮次的方式是关闭运行时进程。
- **无 per-session shutdown**。`shutdown` 是整进程级的。
- **server→client 请求是"未使用的能力"**。传输层支持，但服务器从不发送；Python SDK 的应答接口是为未来审批流程预留。这意味着 agent 无法反向向控制方发起请求。
- **无协议版本协商**。握手只携带 `serverInfo.version`，客户端不校验。

相比之下，ACP 有 `session/cancel`、`session/close`、持久会话列举与恢复。在"两个独立进程互连"这个场景里，ACP 是 DSH 现有协议资产里更强的一个。

---

<a id="八结论六a2a-的成熟度覆盖面与真实缺口"></a>
## 八、结论六：A2A 的成熟度、覆盖面与真实缺口

证据状态：版本、协议能力、SDK 列表和治理/支持声明为 L3；公开 card 统计为 L4；本节最后的选型判断为 L5。未做 A2A 互通测试。

### 版本与治理

- A2A v1.0.0 发布于 2026-03-12，是首个稳定、面向生产的版本。A2A GitHub release 列表当前把 v1.0.1 标为 Latest；该 release 页的 changelog 标注 2026-05-26，GitHub 显示发布时间为 5 月 28 日。
- v1.0 发布时项目由 Linux Foundation 治理，官方公告列出的 Technical Steering Committee 成员包括 AWS、Cisco、Google、IBM Research、Microsoft、Salesforce、SAP、ServiceNow。
- 2026-08-17，Axios 报道 A2A 将转入 Agentic AI Foundation，与 MCP 处于同一基金会生态。后续 A2A 官方页面也列出该迁移。

### v1.0 的能力面

- **多传输**：JSON-RPC、HTTP+JSON/REST、gRPC 三种绑定，附版本协商。
- **发现**：Agent Card，标准路径 `/.well-known/agent-card.json`（RFC 8615）。v1.0 把 `url`、`protocolBinding`、`protocolVersion` 移到每条 `supportedInterfaces[]` 条目上。
- **任务模型**：Task 生命周期，支持同步请求/响应、SSE 流式、异步 push notification。
- **企业特性**：多租户（单端点安全托管多 agent）、签名 Agent Card（跨组织边界前建立信任）。
- **官方 SDK**：Python、Go、JavaScript、Java、.NET、Rust 六种语言。

### 支持度的真实状态

项目方在 2026-04-09 的一周年公告中声称超过 150 个支持组织，并点名 Google Cloud、Microsoft、AWS 的平台集成以及多个行业的企业生产用例。**这是项目方自己的统计口径，不是独立测量。**

第三方公开 Agent Card 普查给出了更保守的画面：

| 普查 | 结果 |
|---|---|
| Agenstry（2026-09-01） | 1,910 个声明 `protocolVersion` 的 card 中，65.5% 仍是 `0.3.x`，仅 25.5% 是 `1.0.x` |
| Emissar（2026-10-02） | Tranco 百万强站群中 276 个 card：205 个 v1.0 形状，71 个 v0.3 形状，**0 个带签名** |
| APIs.io / Kin Lane（2026-09-21） | 探测 4,718 个主机、27,840 个提供方，解析出 421 个可用 card |

这些普查测的是公开 Agent Card 和公开站点样本，不直接测量企业内部部署、私有网关后的服务或 SDK 下载量；不同普查的域名集合和判定规则也不同，不能相加或互相校准。它们的价值在于显示公开生态尚未统一到 v1.0，而不是给出全行业采用率。

### 缺口

- **版本混杂**：v0.3 → v1.0 有真实的 breaking change（`text`/`file`/`data` 统一为 `Part`，card 结构变化）。AgentCard 本身向后兼容（可同时声明 v0.3 与 v1.0 行为），但交互协议不是。
- **"支持 A2A"不等于互通**：不保证传输、交互模式、版本一致。
- **安全责任在部署方**：认证、授权、租户隔离、信任链不会因为协议标准化而自动获得。
- **注册中心不是协议核心**：标准规定 well-known 发现路径；通用注册中心 API 仍在生态提案/路线图范围，不能把"发现 card"等同于已有统一注册中心服务。
- **成熟度不等于一致性**：A2A 生态仍在演进，roadmap 上还有 elicitation、多轮协商、CLI 与 coding harness 集成等未完成项。

### 判断

**跨厂商、跨组织互操作**（L5 建议）：以 A2A v1.0.1 为目标。理由是 v1.0 已有稳定 release、官方 SDK 覆盖六种语言、云平台和多个组织声明支持；这不表示所有对端已升级到 v1.0，也不免除认证与兼容性测试。

**DSH 内部同构协作**（L5 建议）：优先不引入 A2A。引入 A2A 层会为一个同构问题增加跨组织互操作成本（Agent Card 托管、版本协商、信任链、多租户），而跨厂商发现能力在 DSH-only 场景用不上。

---

<a id="九推荐架构broker--peer-插件"></a>
## 九、推荐架构：broker + peer 插件

证据状态：L5。本节是未实现的设计建议；引用的现有 DSH 机制为 L1，broker、`ctx.agentPeers`、profile、工具和投递协议均无代码。

设计假设如下；超出这些假设的部署需要重新审查安全与故障模型：

| 假设 | 适用范围 | 超出假设时需要补充 |
|---|---|---|
| broker 与 peer 由同一部署方管理 | 阶段 1 至 4 | 跨组织参与方、第三方租户或公网暴露需要额外信任链 |
| 阶段 1 只使用本机 Unix socket／命名管道 | 同机 PoC | 跨机器需要 TLS/mTLS、证书轮换和网络安全策略 |
| peer 可能失败、重发或迟到提交，但不抵抗部署方控制的认证 | 单一管理域 | 恶意租户或 Byzantine 参与者需要更强隔离与审计设计 |
| Session 仍保持单写者 | 本报告全部方案 | 任何共享 Session 写入都超出当前 DSH 存储模型 |
| broker 只保存控制信封、任务状态和 artifact 引用 | 全部方案 | 大 payload 需要独立对象存储与内容治理 |

### 拓扑

```text
                    Control plane
              ┌────────────────────────┐
              │      peer broker       │
              │  durable queue         │
              │  member registry       │
              │  task board (optional) │
              └────┬──────────┬────────┘
             ┌─────┘          └─────┐
        ┌────▼────┐              ┌────▼────┐
        │  DSH A  │              │  DSH B  │   peer plugin + peer tools
        └────┬────┘              └────┬────┘
             └──── data plane ─────────┘
```

Data plane 按部署选择，而不是隐藏在 broker 里：

| 部署 | 数据面 | 风险 |
|---|---|---|
| 同机 | 共享工作目录 | 任意 shell 工具和外部进程都可以绕过写范围提示 |
| 跨机器 | Git/artifact 交换 | 需要显式 merge、review 和冲突处理 |
| 跨机器实时协作 | 远程文件系统或远端 workspace provider | 网络分区、缓存一致性和权限必须单独设计 |

如果没有 data plane 设计，两个 agent 可以交换消息，但不能可靠地共同修改同一棵工作树。控制面可用性不能替代数据面一致性。

### 非目标

这个方案不应被描述成以下任一系统：

- **分布式 Agent Teams**：Team 的 durable 事件仍在单进程 Lead Session 中；新方案使用 broker 存储，不把同一份 Team journal 搬到多进程。
- **分布式文件锁**：任务 board 的 `writeScopes` 和 owner 不授予文件系统互斥。
- **强一致多主任务数据库**：第一阶段可以使用单写者 broker；在引入多副本或主备前，不做多写者任务状态承诺。
- **通用公网 agent 目录**：成员发现先限定在部署内 allowlist，不默认暴露到互联网。

### 为什么是 broker 而不是直接的 peer-to-peer

直接 P2P 需要解决成员发现、离线投递、消息持久化和成员存活判断——这四个问题都需要一个所有参与者都能观察到的共同点。broker 就是那个共同点。相比之下：

- **静态直连列表**能免掉发现，但本身无法解决离线投递和消息持久化；引入共享消息目录后，它就演化为另一种集中存储。
- **纯 P2P 协议**（如某些 gossip 方案）能免掉 broker 部署，但把可靠性责任推给每个 agent，且需要处理 NAT 和进程重启后的补投。

对一个"多个 DSH 进程在同一台机器或同一集群内协作"的场景，中心 broker 的成本最低、语义最清晰。

### broker 作为逻辑角色，不指定唯一存储实现

broker 是逻辑控制面，不等于"必须手写一个通用消息系统"。它的职责可以落在不同实现上：

| 阶段／规模的候选实现 | 示例 | 取舍 |
|---|---|---|
| 同机 PoC | 单进程 DSH profile + 本地持久队列 | 部署简单；broker 停机即协作暂停 |
| 小规模服务 | PostgreSQL | 事务、审计和任务 CAS 直接；连接与运维成本较高 |
| 高吞吐异步 | NATS JetStream／Redis Streams | 队列和重投成熟；成员表与任务 CAS 仍需单独存储 |
| 多副本 HA | 仲裁日志或托管消息系统 | 必须解决 leader fencing 与双写；不要用手写内存状态模拟 |

选择依赖时应遵守仓库规则：只有当维护中的队列／数据库实现确实删除自有代码和测试时才引入；否则先实现窄协议与本地存储，让传输与存储提供方可替换。broker 不应复制大文件或工具输出，它只保存控制信封、任务状态和 artifact 引用。

### 为什么新开 `ctx.agentPeers` 而不是复用现有 seam

复用 `ctx.subagents` 会继承父子权威假设：续接由父拥有、发现走父目录、消息只能发邻接。复用 `ctx.agentTeams` 则要求把 Lead 日志改造成多写者共享存储——即推翻 Agent Teams 的 journal、projection 和 invariant 设计。

peer 的权威在 broker 的成员表；生命周期是各自独立；消息是内容而非结果。这四点都与现有两个 seam 不同，所以新开一个域更干净：

按仓库的 capability seam 规则，至少拆成四个交付物：

| 角色 | 建议交付物 | 职责 |
|---|---|---|
| Service Definition | `dsh-agent-peer` | peer 记录、消息信封、投递状态与错误词汇 |
| Service Provider | `dsh-agent-peer-broker-client` | 连接 broker、注册实例、收发与确认消息 |
| Consumer | `dsh-tool-agent-peer` | `peer_list`、`peer_send`、`peer_wait` 的模型工具 |
| Broker app | `peer-broker` profile/bundle | 受 `dsh` 启动的独立控制面应用 |

共享任务板是否属于 `ctx.agentPeers`，或独立成 `ctx.peerTasks`，应在设计决策中单独裁定；它的存储、租约和 CAS 语义足以独立演进。

### 身份模型

```ts
/** Durable membership record owned by the broker. */
interface PeerRecord {
  /** Deployment-stable identity of one logical peer. */
  readonly peerId: string
  /** Model- and UI-visible label; labels are routing hints, not credentials. */
  readonly name: string
  /** Optional default conversation target. */
  readonly defaultSessionId?: string
}

/** One running process claiming a durable peer identity. */
interface PeerInstance {
  /** Ephemeral identity generated for this process start. */
  readonly instanceId: string
  /** Logical peer whose process claims to be running. */
  readonly peerId: string
  /** Broker-visible transport endpoint, when the broker initiates delivery. */
  readonly endpoint?: string
  /** Monotonic value rejecting stale registrations after restart. */
  readonly registrationEpoch: number
}
```

身份必须分三层：`peerId` 是跨重启的成员身份；`instanceId` 是一次进程启动；`sessionId` 是该 peer 内一个可寻址对话。消息目标应使用稳定的 `peerId`；模型可以继续看到人类可读 name，但 name 不是权威键。`registrationEpoch` 用于区分同 peer 的新旧进程；没有它，broker 无法安全判断迟到的旧连接和重复注册。

认证凭据不属于这些结构。`peerId` 只命名身份；进程注册时必须另行出示部署授予的凭据，授权策略再决定该 peer 能否发送、接收、claim 任务或查看成员表。

### 发现的两档方案

1. **静态注册**：peer 列表写在 `cordis.yml` 配置里。简单、可预测、零基础设施，适合先跑通端到端。
2. **动态注册**：peer 启动时向 broker 注册 endpoint、名字与心跳，broker 广播成员变化。适合长期运行的集群。

建议第一阶段用静态，第二阶段再上动态——动态注册引入的是存活判断与注册过期问题，与投递语义正交。

### 消息投递流程

这个流程与 Agent Teams mailbox 的源码/文档模型同构，区别是持久队列从 Lead 的 Session 日志换成了 broker 持有的存储。该跨进程流程本身未实现、未测试：

```text
sender process                    broker                     target process
     │                              │                              │
     │ 1. append local outbox      │                              │
     ├─────────────────────────────►│                              │
     │ 2. append broker queue      │                              │
     ├─────────────────────────────►│                              │
     │                              │ 3. deliver at least once    │
     │                              ├─────────────────────────────►│
     │                              │                              │ 4. validate
     │                              │                              │ 5. dedupe vs
     │                              │                              │    session inbox/history
     │                              │                              │ 6. steer()/followup()
     │                              │                              │    with logged source
     │                              │                              │ 7. flush session
     │                              │ 8. delivery receipt          │
     │                              │◄─────────────────────────────┤
     │ 9. delivery status          │                              │
     │◄─────────────────────────────┤                              │
```

图中的第 2 步包含 broker durable accept response；发送方收到该响应后删除本地 outbox 行。第 9 步只是可查询或订阅的 delivery status，不是本地 outbox 的删除条件。

关键点：

- **本地 outbox 与 broker 队列是两段持久化**。发送方在 broker durable accept 后即可删除本地 outbox 行；不能等目标处理完成，否则发送方重启后会对已由 broker 承担的消息重复发布。
- **broker durable accept 也必须幂等**。发送方在收到 accept 前崩溃会重发同一 `messageId`；broker 用它去重并返回同一接受结果。
- **至少一次投递 + 目标去重**，两者缺一不可。Agent Teams 的做法是"进程内重试 + 目标 Session 去重"；跨进程版本把重试移到 broker，把去重保留在目标侧。
- **delivery receipt 必须在目标 Session flush 后发出**。Agent Teams 的 `checkpointDelivered` 正是这个顺序：先 flush，再确认目标已记录，最后写 delivered 事件。receipt 丢失时 broker 重发，目标用消息身份折叠重复。
- **顺序需要显式定义**。建议 broker 对每个 target 按 durable accept 顺序分配单调序列，并按该序列重发；多发送方之间的全序就是 broker 的接受顺序。不要把网络到达顺序、发送方本地时间或进程重启后的注册顺序当作协作顺序。
- **目标 Session 恢复有前置条件**。`ctx.agents.resume({ resumeSessionId })` 只适用于目标进程能读到该持久 Session 且 Session 不活跃；如果另一个进程持有写租约，新实例必须把消息保留 queued 并报告冲突，不能强行接管。
- **缺少 `sessionId` 时的策略必须显式**。可以由目标 peer 插件选择默认会话、创建新会话或拒绝消息；隐式总是创建新会话会让跨轮上下文和状态审计变得不可预测。

### 消息语义不是 RPC

`peer_send` 的成功只能表示 broker durable accept，最多加上后续可查询的 delivery 状态；它不表示目标 agent 已经回复，也不表示目标轮次完成。若把工具阻塞到对端完成，会出现跨进程分布式 RPC 的超时、取消和重复副作用问题，而这些并不是消息协作本身需要的。

如果需要请求／响应，信封应显式增加 `correlationId` 或 `inReplyTo`，由接收方在完成后发送另一条 peer 消息；取消也是一条显式控制消息，或由目标侧调用本地取消能力。发送方在 broker accept 前可以本地取消；accept 之后只能发送 cancel 请求，不能假设远端工作已经停止。请求深度、响应等待和互唤醒次数必须有上限，避免两个 agent 互相唤醒形成环。

### 协作原语与工具面

建议的模型工具面只有三个：

- `peer_list` — 列出当前可见的 peer 及其状态。
- `peer_send` — 向一个 peer 发送消息。
- `peer_wait` — 等待下一次 peer 相关变化（类似 `wait_agent`），避免轮询。

**共享任务板建议放在 broker 侧**，而不是任何一方的 Session 日志里：任务状态是共享事实，其权威不应属于任何一个可能离线的 peer。这也避开了 Team 那种"任务写在 Lead 日志里"的结构性限制。

任务板至少需要四类状态，而不只是任务快照：

| 状态 | 语义 | 关键规则 |
|---|---|---|
| task revision | CAS 前提 | 每次变更递增；过期 revision 拒绝 |
| assignment | 逻辑 owner，通常是 `peerId` | 不随进程重启自动消失 |
| lease | 当前实例的工作时限 | 新 instance 必须续租；过期只允许显式 release/reclaim 流程 |
| result | 结构化完成事实或 artifact 引用 | 不把大文件塞进消息或任务描述 |

没有 lease，进程退出后的任务会永远保留 owner；只有 TTL 也不够，因为旧进程可能在租约误判后继续写入。生产设计至少要有 fencing token，让旧实例的迟到提交被任务 revision 或 lease epoch 拒绝。依赖图还必须在 broker 侧保持无环，避免多个等待中的 owner 形成静默死锁。

### 传输层

| 范围 | 传输 | 信任边界 |
|---|---|---|
| 同机 | Unix domain socket | 文件系统权限 |
| 同机（Windows） | 命名管道 | 命名空间 ACL |
| 跨机 | HTTPS / WSS | TLS + 应用层 token 或 mTLS |
| 跨机、需要高可靠 | NATS JetStream、Redis Streams、Postgres | 各自的服务端认证 |

broker 本身按仓库规则必须是 `dsh` profile 启动的受支持应用，不能是包 bin 或独立 Node 脚本。建议为它新增一个 profile（例如 `dsh --profile peer-broker`），与随附的 `web`／`headless`／`sdk`／`acp` profile 并列。

### broker 可用性与故障模型

第一阶段可以使用单写者 broker，但必须把它当作控制面关键依赖，而不是进程内对象：

- **durable accept 的定义要具体**。broker 只有在队列、成员表和任务变更落到有持久提交语义的存储后才返回 accept；内存队列不能承载这个语义。
- **broker 不可用时的行为要显式**。推荐发送方把 `peer_send` 记为本地 queued 并让工具调用失败或返回 unavailable，由调用方决定等待；不能让模型把发送失败误解为目标拒绝。
- **broker 重启必须恢复队列和成员表**。未 delivery 的消息继续按原 target sequence 投递；已 delivery 的状态幂等恢复。重启后未收到的旧 delivery receipt 允许重发。
- **消息和任务更新都要限额**。peer 数、每 target backlog、消息大小、任务数、租约时长和心跳间隔必须是配置项；超过上限时明确失败，防止失控 agent 把共享控制面写满。
- **多副本 broker 不是简单重启**。生产 HA 需要仲裁提交、leader fencing 和旧 leader 隔离；否则 failover 会出现双写队列或双任务 owner。没有这些能力前，部署应使用单活 broker 并接受暂停。

### 授权与安全模型

安全设计至少覆盖六条规则：

1. **peer 名不是凭据**。注册必须出示部署配置的 mTLS 客户端证书、本地 socket 权限、签名 token 或等价凭据；`peerId` 与 `name` 只在授权通过后进入成员表。
2. **授权是矩阵，不是连通性**。策略要显式声明每个 peer 可以 message 哪些 peer、查看哪些成员、claim 哪些任务、读哪些结果；跨租户默认拒绝。
3. **接收方保留自己的工具权限**。peer 消息是外部输入，不继承发送方的授权。目标 agent 的 sandbox、审批和工具策略仍由接收进程独立执行；高风险操作不应因为"来自另一个 agent"而自动放行。
4. **唤醒和 token 消耗需要授权**。外部 peer 消息可以唤醒目标并触发模型请求，因此成员表、消息速率、每个 target 的 backlog 和请求深度必须受策略限制；未允许被远程唤醒的 peer 应保持只读或离线。
5. **消息内容需要数据治理**。限制大小与内容类型，附件使用内容寻址引用；诊断和 broker 日志不得复制凭据、环境值或完整 payload。持续注入还会膨胀目标上下文，必须与压缩和保留策略一起测试。
6. **审计必须可重放**。broker 至少记录消息 accept、投递、delivery receipt、任务 revision 和租约转换。目标 Session 只记录模型可见消息；共享控制面的完整状态必须从 broker 存储导出和审计。

如果 broker 只部署在单机 Unix socket 后，传输层信任可以依赖文件系统权限；跨机器后，TLS/mTLS、证书轮换、租户隔离和公网暴露边界都成为发布前置条件。端到端消息签名可以延迟引入，但它引入密钥分发、轮换与撤销，不能作为省略传输认证的理由。

### 投递模式：Steer 还是 Queue

Agent Teams 的 `send_message` 始终尝试 Steer 投递：运行中的目标在最近的 step 边界收到消息，空闲目标启动一个轮次，否则冷恢复。这个决策的理由记录在团队 Steer 消息决策笔记中。

跨进程必须显式决定继承哪一种，因为两者对"目标繁忙时的响应"完全不同：

- **Steer**：目标在下一个 step 边界看到消息。响应快，但消息会打断目标的当前推理节奏。
- **Queue**：消息等待一个空闲轮次。目标能完成当前工作再处理，但响应延迟可能很长。

建议默认 Steer（与 Team 一致），并在消息协议中保留显式指定的能力。

---

<a id="十与-dsh-既有扩展点的接合"></a>
## 十、与 DSH 既有扩展点的接合

证据状态：表中现有机制为 L1；“新增 source kind”和各复用方式是 L5 设计，尚未接合测试。

### 可复用的候选机制

| 机制 | 来源 | 复用方式 |
|---|---|---|
| Agent 消息的 durable 归因 | `ctx.subagents` 的 `AgentMessageSource`（`kind: 'agent-message'`） | 新增 `peer-message` source kind，携带 `peerId`、`messageId`、`senderName` |
| 模型可见的发送者前缀 | Team 的 `Team message <id> from <name>:` | 改为 `Peer message <id> from <name>:` |
| 投递原语 | `agent.steer()` / `agent.followup()` | 直接使用，无需新抽象 |
| 冷恢复 | `ctx.agents.resume({ resumeSessionId })` | 目标不在线时恢复后投递 |
| 会话刷新 | `ctx.sessions.flush(session)` | 目标持久化确认后再发 delivery receipt |
| 外部事件入口 | `ctx.webhookRuntime`（已认证规则 → 新建 Workspace 会话） | broker 可复用其"已认证 ingress → 创建会话"模式 |
| 凭据与授权 | `ctx.credentials`、`ctx.authorization` | peer token 存储与轮换 |
| 应用启动约束 | `dsh --profile <name>` | broker 作为独立 profile |

### 消息必须是"模型可见即已记录"

DSH 的核心不变式是"模型可见 ⟺ 已记录"：任何进入模型请求的输入都必须能从 Session 日志重建。目标 peer 插件必须通过 `agent.steer()` 或 `agent.followup()` 提交消息，让目标自己的 Session 记录一条携带 `peer-message` source 的 `user/message` 事件。发送方和 broker 绝不直接 append 目标 Session；它们只传递消息信封。

新增 source kind 属于模型可见且持久化的协议变化，必须同时更新 TypeScript 与 Python SDK 的投影、Session 读取器、测试和快照，不能只在插件里声明一个本地接口。它还要经过持久化类型变更审查；是否需要 Session 格式迁移由类型兼容规则和生成 catalog 决定，不能凭感觉跳过。

这条约束也解释了为什么 Agent Teams 的 Team 事件（`team/member`、`team/task`、mailbox 记录）**从不进入模型历史**：它们是协作记录而非对话内容，不消耗模型 token。跨进程 peer 方案应保持同样的划分。

### 不应复用的 Web UI API

Web 的 Remote API 不是 service-to-service agent 接口。它的信任模型是：每个进程生成随机启动令牌，浏览器在根路径交换得到绑定 authority 的签名 cookie（host-only、`HttpOnly`、`SameSite=Strict`），请求还必须通过 `Host` 必须为 loopback 或匹配 `trustedHosts`、`Origin` 必须等于 `Host`、`sec-fetch-site: cross-site` 一律拒绝的检查。`dsh web --host 0.0.0.0` 不受支持。

这是面向操作者的浏览器会话模型，不是 agent 之间的服务接口。

---

<a id="十一跨进程协作的固有难题与失败模式"></a>
## 十一、跨进程协作的固有难题与失败模式

证据状态：Team 与 Session 的既有限制为 L1/L2；跨进程后果和缓解方案为 L5 推断。

### 1. 共享工作目录的写冲突

Agent Teams 的共享 checkout 边界在同进程下已经是一个公开问题：`writeScopes` 只是规范化路径前缀的**提示性诊断**，永不阻止 claim 或授予写权限；Bash、formatter、代码生成器和直接外部写入可以绕过文件版本检查。Lead 必须协调 owner 并检查最终 diff。

跨进程会增加并发写入者。主要缓解手段是 prompt/策略层（切分任务、声明写范围、加依赖、最终 diff 审查）和部署层（独立 worktree 或外部协调机制）。DSH 的 Team 领域不推断 branch、merge 或改变 cwd。

### 2. 进程间同一 Session 的写冲突

如第四节所述，同一 Session 的写权由内核锁排他。跨进程 peer 协作必须遵守"一个 Session 一个 owner 进程"。peer 模型可以与这条规则兼容，但前提是显式指定每个 Session 的 owner 进程；不能指望两个进程都往同一份持久对话里追加。

### 3. 消息重复与丢失

- **重复**：至少一次投递必须按"目标崩溃于已投递未 receipt 窗口后会重发"处理。去重依靠目标 Session 里的消息身份。
- **丢失**：delivery receipt 之后 broker 才能把消息移出 active queue。若目标 Session 的 flush 实际未落盘就 receipt 了，消息会丢。receipt 必须在目标 flush 成功之后发出；broker 仍应保留 delivered audit 记录，而不是删除所有历史。

### 4. 目标离线与长时间不在线

Agent Teams 的已知限制写着：不会自动释放 owner——成员不活动、interrupt、进程退出与工作失败都不会释放任务 owner；failed member 永久占用名字与 member slot。跨进程版本不应直接继承这个行为。它需要区分持久 `peerId`、短暂 `instanceId` 和任务 lease：peer 离线时消息排队；任务 owner 可以保留，但工作 lease 必须到期或被显式释放；新 instance 以新的 lease epoch 接手，旧 instance 的迟到提交要被拒绝。

### 5. 身份不是授权

peer 名字只是寻址符。任何跨进程方案都需要独立的授权层：谁能给谁发消息、谁能读共享任务板、谁能代表某个 peer 发言。DSH 现有可用的原语是 `ctx.credentials`（凭据存储）与 `ctx.authorization`（人引导授权 flow），但没有现成的"agent 对 agent"授权模型。

### 6. 锁死持有者

Session 写租约的设计明确选择"活着但卡死的持有者保有锁直到进程退出"。在 peer 协作场景下，一个卡死的 peer 进程会阻塞该 Session 的其他写入方——这在共享 home 场景下是真实风险，需要进程监督。

---

<a id="十二方案取舍与不推荐的做法"></a>
## 十二、方案取舍与不推荐的做法

证据状态：L5。本节是基于第一至第十节证据的架构取舍，不是已实施的选型结果。

### 三条候选路线对比

| | A：broker + peer 插件 | B：ACP orchestrator PoC | C：A2A sidecar |
|---|---|---|---|
| 目标范围 | DSH↔DSH | DSH↔DSH，也可接外部 ACP agent | DSH↔非 DSH agent |
| 发现 | broker 成员表 | 需自建 | Agent Card |
| 归因 | 显式消息源 | 需塞进内容 | A2A Part |
| 离线队列 | broker 持久队列 | DSH ACP 交付面不提供 | 对端实现决定 |
| 去重 | 目标 Session 折叠 | DSH ACP 交付面不提供 peer 去重 | 对端实现决定 |
| 共享任务板 | broker 侧 CAS | 需自建 | 需自建 |
| 认证 | 部署设计 | 需自建 | 需自建 |
| 标准化 | 无（自有协议） | ACP | A2A |
| 实施成本 | 中 | 中（需要自建双向 orchestrator） | 高 |

### 建议

**主路线是 A。**在三条路线中，它最直接地覆盖跨进程 DSH peer 协作所需的成员、投递、离线与共享状态语义，且不需要先引入外部互操作协议。

**B 作为 PoC 通道有独立价值**：它验证"两个 DSH 进程能通过标准自动化协议被同一个控制器驱动"这件事本身，而且如果将来需要接非 DSH 的 ACP 兼容 agent，这套接入是必需的。PoC 应当明确标注它不提供 peer 语义，也不是现成的持久互连功能。

**C 保留为后置选项**：只在需要与非 DSH agent 互操作时实现。架构上它是一个把 A2A `Task` 映射到 DSH 会话的 sidecar：

```text
Remote A2A agents ──A2A──▶ A2A gateway/sidecar ──ACP──▶ dsh --profile acp
```

映射关系需要注意：**A2A `Task` 不等于 DSH `turn`**——一个 A2A task 可能跨多个 DSH turn；A2A `contextId` 可以映射到 DSH Session。

### 明确不推荐的做法

| 做法 | 不推荐的原因 |
|---|---|
| 把两个 DSH 进程直接接到同一份 Agent Teams Team 状态 | Team 状态在 Lead 的 Session 日志里，而 Session 是单写者的（`SessionAlreadyOwnedError`） |
| 用 Web Remote API 做 agent 间通信 | 浏览器 cookie + loopback 信任模型，面向操作者 |
| 用 SDK JSON-RPC 做跨进程控制面 | 无取消、无 per-session shutdown、server→client 请求未启用 |
| 由发送方或 broker 直接 append 目标 Session 日志 | 违反单写者；绕过目标 inbox、审批与模型可见事实记录。目标 peer 插件应通过 `steer()`/`followup()` 让目标 Session 自己记录消息 |
| 把 task owner 或 write scope 当作文件锁 | 外部写入会绕过；崩溃的 owner 持久占用；路径前缀重叠不证明语义独立 |
| 为 DSH 内部协作引入 A2A 层 | 为同构问题承担跨组织互操作的完整成本 |
| 让 peer 名字直接充当授权凭据 | 名字是寻址符，不是身份凭据 |

---

<a id="十三分阶段落地路线"></a>
## 十三、分阶段落地路线

证据状态：L5。以下是建议的实施顺序；当前没有对应包、profile、测试或迁移。

### 阶段 0：设计决策

在动代码之前，先写一份 Agent Note，记录 `ctx.agentPeers` 的身份模型、`peer-message` source、投递与顺序语义、Session 选择/恢复策略、broker 权威边界、任务租约、授权矩阵、控制面故障模型和 data plane 选择。这决定后续所有包的契约。仓库规则要求这类决策有持久记录，而不是只存在于实现里。

### 阶段 1：同机控制面闭环

- 一个同机 broker（`dsh --profile peer-broker`），Unix domain socket 传输与文件权限。
- 静态 allowlist 写在配置里。
- 三个工具：`peer_list`、`peer_send`、`peer_wait`。
- broker durable accept、目标 Session 去重和 delivery receipt。
- `peer-message` source 的 Session 记录与 SDK 投影。
- 两个 DSH 进程共享工作目录，各自拥有自己的 Session。
- 本阶段不做共享任务板和跨机器 HA。

### 阶段 2：可靠性

- 发送方本地 outbox 与 broker active queue 的恢复。
- 目标进程冷恢复后投递（`ctx.agents.resume`）。
- broker 重启后按 target sequence 补投。
- accept receipt 丢失、delivery receipt 丢失和目标重复处理的测试。
- backpressure、消息大小和成员数上限。

### 阶段 3：共享任务板

- broker 侧任务快照与 CAS revision。
- 依赖 DAG 校验与任务结果/artifact 引用。
- `peerId` owner、`instanceId` lease 和 fencing epoch。
- 旧实例迟到提交、租约到期与显式 reclaim 的测试。

### 阶段 4：跨机与安全

- HTTPS/WSS 传输。
- mTLS 或受轮换的 peer token，以及授权矩阵。
- 多租户隔离（如果需要）。
- data plane 选择：Git/artifact 交换、远程 workspace，或明确禁止共同写入。
- 进程监督，处理"卡死持有者保留 Session 锁"的情形。
- 单活 broker 的启停与备份恢复；多副本 HA 只有在 leader fencing 设计完成后才进入本阶段。

### 阶段 5：A2A 互操作（按需）

- A2A sidecar：Agent Card 托管、A2A Task ↔ DSH 会话映射、push notification。
- 只在确有非 DSH 对端时做。

### 每阶段应验证的行为

见下节验收清单。

---

<a id="十四验收清单"></a>
## 十四、验收清单

证据状态：L5。这些是未来实现必须满足的验收目标，当前没有任何一项因本报告而通过。

跨进程协作最容易在"看起来能跑"的路径上留下缺陷。以下行为应当在对应阶段被测试覆盖：

**投递正确性**

- 发送方在 broker durable accept 前崩溃并重试，broker 只保留一条消息。
- 目标崩溃于"已投递未 receipt"窗口后收到重发，不产生重复模型消息。
- 目标进程离线时消息持久排队，重新上线后投递。
- 消息在目标 Session flush 成功之前不产生 delivery receipt。
- broker 重启后按每个 target 的 durable accept 顺序补投。
- 并发多个发送方时，目标侧仍按 broker 分配的可定义顺序处理。
- 目标 Session 被其他进程持有时，消息保持 queued 并报告冲突。

**生命周期**

- 发送方进程在本地 outbox 持久化后立即退出，消息不丢。
- broker 在 durable commit 后立即退出，重启后消息不丢。
- 目标 Session 不存在或已删除时的失败语义明确（拒绝还是排队）。
- 目标进程重启后 in-flight 投递状态可恢复。
- 同一 `peerId` 的新 instance 注册后，旧 instance 的迟到投递和任务提交被 epoch 拒绝。

**共享任务**

- 过期 task revision 的更新被拒绝，且不会覆盖新状态。
- 依赖图拒绝环，等待中的任务不会形成静默死锁。
- lease 到期后只能通过显式 reclaim 规则接手。
- 任务结果引用的 artifact 可验证，且不会把大 payload 塞进消息或任务快照。

**边界**

- peer 名字未注册时的错误明确。
- 消息超过大小上限时的错误明确。
- 未授权的 peer 不能发消息。
- broker 不可用时，`peer_send` 的本地 queued／unavailable 状态可区分，且不会伪装成目标拒绝。
- 跨租户成员、消息和任务默认不可见。

**可观测性**

- 消息在 Session 日志中可归因到发送方（source kind 明确）。
- broker audit 可重放 accept、投递、receipt、任务 revision 和 lease 转换。
- 投递失败有结构化诊断，不泄露消息内容或凭据。

---

<a id="十五证据索引"></a>
## 十五、证据索引

本节只列出报告实际读取过的证据。仓库内路径绑定当前 checkout；外部页面读取日期为 2026-10-21。

### 仓库内

| 事实 | 等级 | 来源 |
|---|---|---|
| Agent Teams 的 peer 语义、跨进程排除、共享 checkout 边界 | L1/L2 | [agent-team README](../../packages/experimental/agent-team/README.zh.md)、[session-message.ts](../../packages/experimental/agent-team/src/session-message.ts)、[types.ts](../../packages/experimental/agent-team/src/types.ts) |
| Team 持久类型、服务 API、投影 | L1/L2 | [agent-team subsystem](../subsystems/agent-team.zh.md) |
| Team 身份、mailbox、任务事务、测试声明与拒绝的替代方案 | L1/L2 | [Agent Teams Agent Note](../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md) |
| Team 工具与模型策略 | L1/L2 | [tool-agent-team README](../../packages/experimental/tool-agent-team/README.zh.md) |
| Session 跨进程写租约 | L1 | [lease.ts](../../packages/session/session-persistence-jsonl/src/lease.ts)、[跨进程写租约 Agent Note](../../.agents/notes/implemented/feature/2026-08-31-cross-process-session-write-lease.zh.md) |
| Session 持久化 seam 的写所有权保证 | L1/L2 | [session-persistence README](../../packages/session/session-persistence/README.zh.md) |
| subagent 提供方注册表、一次性/continuable 形态与邻接消息限制 | L1/L2 | [subagent README](../../packages/subagent/subagent/README.zh.md)、[continuation-messages.ts](../../packages/subagent/subagent/src/continuation-messages.ts) |
| ACP 后端委派语义 | L1 | [subagent-acp README](../../packages/subagent/subagent-acp/README.zh.md)、[run.ts](../../packages/subagent/subagent-acp/src/run.ts) |
| DSH ACP 服务器协议方法与限制 | L1/L2 | [dsh-acp README](../../packages/acp/acp/README.zh.md)、[package.json](../../packages/acp/acp/package.json) |
| ACP 仅自动化边界决策 | L1/L2 | [ACP 自动化协议 Agent Note](../../.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.zh.md) |
| SDK 协议方法与缺口 | L1/L2 | [SDK protocol README](../../packages/sdk/protocol/README.zh.md)、[SDK server README](../../packages/sdk/server/README.zh.md) |
| DSH subagent 委派能力与提供方模型 | L1/L2 | [subagent README](../../packages/subagent/subagent/README.zh.md)、[subagent subsystem](../subsystems/subagent.zh.md) |
| Web Remote 信任模型 | L1/L2 | [client connection README](../../packages/client/connection/README.zh.md) |
| 已有外部事件入口 | L1/L2 | [webhook README](../../packages/experimental/webhook/README.zh.md)、[webhook-github README](../../packages/experimental/webhook-github/README.zh.md) |

### 外部

| 事实 | 等级 | 来源 |
|---|---|---|
| A2A v1.0 发布、传输绑定、签名 Agent Card、多租户 | L3 | [A2A v1.0 公告](https://a2a-protocol.org/dev/blog/2026/03/12/a2a-protocol-ships-v10-production-ready-standard-for-agent-to-agent-communication/) |
| A2A 操作、Task/Part、versioning 和 Agent Card 模型 | L3 | [A2A Specification](https://a2a-protocol.org/latest/specification/) |
| v1.0.0/v1.0.1 release 状态与 breaking changes | L3 | [A2A Releases](https://github.com/a2aproject/A2A/releases) |
| v1.1、CLI、elicitation、双向流和 SDK 路线图 | L3 | [A2A Roadmap](https://a2a-protocol.org/latest/roadmap/) |
| 支持组织数与云平台集成（项目方口径） | L3 | [Linux Foundation 一周年公告](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year) |
| A2A 转入 Agentic AI Foundation | L3 | [Axios 报道](https://www.axios.com/2026/08/17/a2a-agentic-ai-foundation-open-ai-standards)、[A2A 官方迁移文章](https://a2a-protocol.org/latest/blog/2026/08/27/a-new-chapter-for-a2a-joining-the-agentic-ai-foundation/) |
| Agent Card 公开样本与版本分布 | L4 | [Agenstry](https://agenstry.com/blog/state-of-the-agent-card)、[Emissar](https://emissar.ai/learn/a2a-adoption-2026)、[APIs.io / Kin Lane](https://apievangelist.com/2026/09/21/a2a-adoption-is-421-of-27840-and-most-of-them-arrived-with-the-card/) |
| 官方 SDK 语言覆盖 | L3 | [A2A SDK 页](https://a2a-protocol.org/latest/sdk/) |
| ACP 的编辑器/agent 定位、本地 stdio 与远程支持状态 | L3 | [Agent Client Protocol](https://agentclientprotocol.com/) |

### 证据分级

本报告的结论按以下方式成立：

1. 当前 DSH 行为以 L1 源码为主，L2 只用于测试声明、设计意图和文档化契约。
2. A2A/ACP 协议事实以 L3 官方页面为主；项目方采用声明明确标注口径。
3. 公开生态状态使用 L4 普查，只解释公开 card 样本。
4. 第九节至第十四节是 L5 设计判断，尚未实现、尚未测试。
5. 文档门禁只验证 Markdown、链接和示例类型，不验证产品运行时行为。

---

<a id="dev-note"></a>
## Dev Note

本节是维护者的工作上下文，明确不具权威性。

- **待决问题**：peer 消息默认 Steer 还是 Queue；broker 是单点还是需要主备；共享任务板是否属于 peer seam 的一部分，还是独立 seam。
- **可能的替代路径**：若 broker 的角色被认为过重，可以先做"静态 peer 列表 + 每对进程直连 + 共享消息目录"的方案，但离线投递与去重会退化到每个发送方各自实现。
- **未验证的部分**：本报告没有实机验证跨进程 peer 原型、ACP 双进程 orchestrator、A2A 互通、SDK server 或 Agent Teams 包测试；第九节至第十四节是基于既有 mailbox 模型和 DSH 扩展点的设计推演。
- **与 A2A 的关系**：如果 DSH 未来要作为 A2A 客户端或服务端，第九节的 peer 消息模型应当与 A2A 的 `Part`/`Task` 概念对齐，而不是先建立一套平行词汇再转换。
