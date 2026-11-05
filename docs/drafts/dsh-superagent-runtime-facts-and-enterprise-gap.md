---
description: "核实 dsh-superagent 原型的运行边界与 BYOM 缺口，逐项评估外部材料和开源替代，并给出企业化差距与可验证的下一步。"
---

# Super-agent 运行事实、BYOM 模型与企业化差距

## Summary

结论先行：公开的 `dsh-superagent` 是**单个 DSH 进程内两个平级 Session** 的应用，不是跨进程执行系统。Router（`orchestrator-<stateDir 哈希>`）与 Worker（`worker-<ticketId>`）都由同一进程内的 `sessionController` 创建，共享 `ctx.agents` 注册表，二者没有 Subagent 父子关系。原型没有端侧 daemon、没有云端控制面、没有跨机发现与认领，也没有任何远程执行配置项。

BYOM 所需的三个部分中，原型只有“大脑”的一部分（本地常驻 Session 加 SQLite 状态）和“手”的执行动作；它缺“手”的独立进程、离线语义与人工接管，也缺“账本”的授权、归属、审批、验收、审计与撤销。员工机器间歇在线时“分配→掉线→待恢复或改派”的任务模型，原型无法表达。

外部材料的架构描述基本可信，但把文章第 5 节的设计图当成了系统现状图，并放大了规模与落地状态；几处关键数字也脱离了原文语境。七个可比较的开源项目逐项核对后，“用现成开源实现替代”的前提不成立：缺口不在编排原语，而在业务账本与治理，尤其是事件驱动准入。

企业化差距按优先级是身份与权限边界、控制面、状态所有权、副作用语义、组织责任。落点不是缺功能，是缺边界。下一步应先验证三件事：杀进程后 GitHub 副作用是否重复、单 Router 在每分钟 40 条真实输入下是否成瓶颈、无 Mandate 的事件能否被提示词绕过。

## Table of Contents

- [证据等级与写法](#证据等级与写法)
- [运行事实](#运行事实)
- [BYOM 的准确模型](#byom-的准确模型)
- [多进程隔离的三层区分](#多进程隔离的三层区分)
- [企业化差距](#企业化差距)
- [外部材料核查](#外部材料核查)
- [开源方案评估](#开源方案评估)
- [可验证的下一步](#可验证的下一步)
- [局限](#局限)
- [来源](#来源)
- [Dev Note](#dev-note)

-----

## 证据等级与写法

本文把每处判断标成四类：**文章设想**指《Super-agent 设计探索》原文提出的设计；**原型实现**指 `dsh-superagent-prototype` checkout 中的代码和文档；**DSH 已有能力**指 DeepSeek Harness 本仓库当前发布的能力；**本文判断**指在上述材料之上的取舍与推断，不表示任何一方已经承诺。

核查日期为 2026-11-04。原型证据来自该 checkout 的 0.1.0 源码与文档；文章证据来自[本地归档副本](reference-materials/super-agent-design-exploration.md)；DSH 证据来自本仓库的架构文档和包 README；外部项目证据来自公开文档、README 与许可页。

本文没有运行原型的 `pnpm check`，没有接入真实 GitHub/Feishu，也没有复现文章实验。源码阅读能支持结构与机制判断，不能证明所有运行路径都正常。外部项目能力主要来自文档，不能等同于源码审计。

## 运行事实

### Router 与 Worker 是同进程内的两个平级 Session

主 Session 的 ID 由 stateDir 派生：读取 `KV.runtime.masterId`，缺省值由 `orchestrator-` 前缀加 stateDir 的哈希键组成，见 [runtime.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/src/app/runtime.ts#L104-L105)；启动时由 `this.sessions.ensure(this.masterId, ...)` 创建，见 [runtime.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/src/app/runtime.ts#L210)。Worker 的 ID 是 `worker-<ticketId>`，见 [dsh.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/src/executor/dsh.ts#L23-L26)，由同一个 `Sessions.ensure` 创建，见 [dsh.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/src/executor/dsh.ts#L304-L315)。

两者走的是同一个进程内的服务调用：`ctx.sessionController.resolveAgent`、`ctx.workspaceRegistry.create`、`ctx.sessionController.create`，见 [sessions.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/src/app/sessions.ts#L137-L153)。Worker 的后续投递和查询也用 `this.host.context.agents.get(...)`，见 [dsh.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/src/executor/dsh.ts#L314-L315)。

这不是 Subagent 父子关系。Router preset 明确排除了 Subagent、Web 和文件搜索等工具，见 [cordis.patch.yml](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/cordis.patch.yml#L121-L124)；Subagent 只出现在 Worker preset 内部，`tool-subagent` 使用 `provider: spawn`，见 [cordis.patch.yml](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/cordis.patch.yml#L102-L111)。`Sessions` 只对非 Router、非 Ticket 的 Agent 施加 Subagent 限制，见 [sessions.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/src/app/sessions.ts#L237-L237) 和 [sessions.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/src/app/sessions.ts#L303-L303)。

这与文章的描述并不冲突。原文把双层称为“逻辑上的职责划分”，并说明每一层不必局限于单个 Session，见[文章归档](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/reference-materials/super-agent-design-exploration.md#L76-L76)；原型选择的是“单个常驻 LLM Session 作为 Router 核心”的最简实现，见[文章归档](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/reference-materials/super-agent-design-exploration.md#L84-L84)。因此正确的说法是“两个平级 Session 共享一个进程”，不是“Router 拉起 Worker 子 Agent”，也不是“跨进程的双层架构”。

### 没有端侧 daemon，也没有云端控制面

原型 package 没有 `bin` 字段，只声明 `main`、`types`、`exports`、`files` 和 `dsh.bundle`，见 [package.json](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/package.json#L9-L32)。发布物是一个 DSH bundle，不是可安装的系统服务。常驻进程由外部 `dsh` CLI 提供：`start` 在 tmux 会话里运行 `dsh --profile superagent`，见 [006-deployment.md](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/docs/006-deployment.md#L100-L111)。

`scripts/dsh-superagent` 只是运维 CLI，参数只有 `start`、`stop`、`restart`、`status`，见 [dsh-superagent](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/scripts/dsh-superagent#L209-L241)。它没有守护进程、开机自启、崩溃拉起或卸载流程；崩溃恢复依赖用户自己配置的每小时巡检，见 [006-deployment.md](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/docs/006-deployment.md#L133-L141)。

也没有云端控制面。会话创建和驱动都是进程内对象调用；`AgentDelivery.send` 还会校验对象身份，`this.ctx.agents.get(agent.id) !== agent` 时直接拒绝，见 [delivery.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/src/app/delivery.ts#L66-L71)。这意味着不存在“控制面通过 ID 找到远端执行体”的入口，连同一进程内被替换的 Agent 对象都不接受。

对 BYOM 的直接后果是：员工机器上没有一个可部署的 daemon 承担执行、离线和接管；“手”仍然长在运行 DSH 的那台机器上，且与“大脑”是同一个进程。

### Executor 配置是本地单机契约

`ExecutorConfigSchema` 使用 `.strict()`，只有 `model`、`maxWorkers`、`directory`、`prepare`、`blockedCommands` 五个字段，见 [policy.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/src/policy.ts#L91-L97)。没有 endpoint、host、socket、profile 或任何远端执行字段。依赖只有 `proper-lockfile` 和 `zod`，见 [package.json](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/package.json#L58-L60)。

因此增加远程执行不是改一个配置项，而是新增协议、认证、工作区映射和结果回传，并修改这个严格 schema。

### 单 stateDir 单实例，多进程各自为政

Runtime 构造时对 stateDir 加锁，然后打开 `orchestrator.sqlite`，见 [runtime.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/src/app/runtime.ts#L91-L98)。架构文档明确 `Store` 只拥有一个 SQLite 数据库，锁用于阻止第二个进程迁移或写入同一状态，见 [007-architecture.md](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/docs/007-architecture.md#L151-L151)。

不同 stateDir 的多个进程可以各自运行，但每个 stateDir 生成自己的 `masterId`、SQLite 和进程内效果队列。源码中没有跨 stateDir 的发现、认领或结果路由实现；多出来的进程不会互认，也不会分担对方的 Ticket。

### 持久化与接单语义

原型在单机范围内有一套真实的持久化纪律：效果表按 kind 配置并发上限、指数退避和有序执行，失败会阻塞同 kind 的后续行，见 [effects.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/src/app/effects.ts#L28-L34)、[effects.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/src/app/effects.ts#L70-L71) 和 [effects.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/src/app/effects.ts#L108-L112)。这是重启恢复的基础，不应因为“没有跨机能力”而一并否定。

主动接单默认是 `observe`：`mode: z.enum(['off', 'observe', 'auto']).default('observe')`，见 [policy.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/src/policy.ts#L84-L84)；观察模式只记录“若启用本来会接受”，不启动 Worker，见 [policy.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/src/policy.ts#L52-L57)。

并发只有计数，没有资源配额：`maxWorkers` 默认 3、范围 1 到 16，见 [policy.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/src/policy.ts#L93-L93) 和 [limits.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/src/limits.ts#L6-L6)。给人发消息可以额外占用一个槽位，见 [007-architecture.md](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/docs/007-architecture.md#L203-L203)。

部署范围是 github.com 上的单仓库、单团队，明确不支持 GitHub Enterprise Server，见 [006-deployment.md](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/docs/006-deployment.md#L25-L25)。部署文档提供安装、启动停止、升级和故障排查，没有卸载章节，见 [006-deployment.md](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/docs/006-deployment.md#L233-L248)。

### DSH 侧的能力边界

DSH 的 Gateway 是 **Client→Host**，不是 Host→Host：业务服务用 `@Remote` 把方法暴露给 Client，Host 在调用前把 wire 上的 `agentId` 解析成 Host 对象，见 [api-gateway.md](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/api-gateway.md#L9-L11)。它让远程客户端驱动本地 Session，不提供“一个 Host 驱动另一个 Host 的 Session”。

`subagent-dsh-sdk` 的 README 写明“Local child processes only”，并说明远程运行时需要另做 backend，见 [README.md](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/subagent/subagent-dsh-sdk/README.md#L174-L174) 和 [README.md](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/subagent/subagent-dsh-sdk/README.md#L185-L185)。

`ssh` provider 只是把文件、进程、终端和 sandbox 的执行放到远端，Harness 本身仍在本地：SSH 家族 README 说“runs ... on one POSIX SSH host while the Harness stays local”，见 [README.md](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/ssh/README.md#L12-L12)；具体 provider 也说“The host runs the Harness, model transport and Session storage”，见 [README.md](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/ssh/ssh/README.md#L28-L28)。

Sandbox 只做同世界约束：容器、microVM 和远程执行需要替换能力实现，不是加一个 provider 就能得到，见 [README.md](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/sandbox/sandbox/README.md#L167-L167)。

当前发布的 profile 只有 `web`、`headless`、`sdk`、`sdk-minimal` 和 `acp`，见 [architecture.md](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/architecture.md#L43-L43)。没有已发布的 cloud session runtime，也没有“把 Session 执行体放到另一台机器”的产品路径。

### 权限与隔离现状

Router 和 Worker 两个 preset 都以 `danger-full-access` 运行，身份是操作者的 OS 用户；账号 wrapper 只负责选择凭据，不隔离进程，见 [006-deployment.md](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/docs/006-deployment.md#L13-L19)。创建 Session 时也会显式设置这个 preset，见 [sessions.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/src/app/sessions.ts#L152-L152)。

Session 隔离不等于进程、容器或 OS 隔离。两个 Ticket 各自有 Session 和工作目录，但仍在同一 OS 用户、同一进程、同一权限域内；这是原型面向单团队可信仓库的合理简化，也是它不能直接用于多租户的原因。

## BYOM 的准确模型

BYOM 不是“笔记本只是浏览器”，而是机器执行、责任仍属人和组织。准确的分法是三个部分：

| 部分 | 所在位置 | 承担的职责 | 原型现状 |
|---|---|---|---|
| 大脑 | 云端无状态 Loop 加状态库 | 推进 Agent Loop、保存会话与任务状态、水平扩展或重启替换 | 只有本地常驻 Session 和本地 SQLite，没有云端无状态计算 |
| 手 | 员工机器上的 daemon | 真实执行、离线与休眠语义、人工接管入口 | 执行动作存在，但 daemon 不存在 |
| 账本 | 中心 | 授权依据、归属、审批、验收、审计、撤销 | 只有 Ticket、Mandate、Assignment 等应用内记录，没有中心治理面 |

云端 Loop 与状态库、端侧 daemon 的分法来自文章第 5 节的设计，见[文章归档](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/reference-materials/super-agent-design-exploration.md#L202-L210)；把授权与治理单列为账本，是本文为对照原型而做的归纳。两者都不是原型已经落地的结构。

端侧 daemon 至少要承担五件事：执行本体；离线或休眠语义，让中心能判断“中断待恢复”而不是“卡死”；人工接管，允许人打断和接手；凭据不进入模型上下文，文章第 8.4 节明确要求 Agent 在完全不接触凭据本身的情况下使用凭据，见[文章归档](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/reference-materials/super-agent-design-exploration.md#L296-L296)；出口白名单和可回滚的工作区。

员工机器会间歇在线，因此任务模型必须允许“分配→掉线→待恢复或改派”。原型连“Worker 掉线”都无法表达：没有心跳、没有跨进程归属、没有租约，进程消失后只能靠同一 stateDir 的重启恢复提示继续。

必须写清：该 daemon 在原型中不是“打了折扣”，而是**零**。没有可安装的服务、没有开机自启、没有远端注册，也没有控制面去分配它。

## 多进程隔离的三层区分

“隔离”至少有三层，不能合并成一个词：

| 层次 | 定义 | 仅做到哪一步还不够 |
|---|---|---|
| 故障域 | 进程边界加资源配额；一个 Worker 崩溃或耗尽资源不拖垮 Router 和其他 Worker | 独立 Session、独立工作目录不够，它们仍共享进程和内存 |
| 文件与凭据边界 | 独立 OS 账号、容器或 mount，让一个 Worker 读不到另一个的代码与凭据 | 同一 UID 下的不同目录不是安全边界 |
| 租户边界 | 授权链加网络出口，保证一个租户的任务不能借用另一个租户的身份或数据 | 应用层 principal 字段不等于网络和凭据隔离 |

现状三层的完成度都是零：同进程、同权限域（`danger-full-access`）、并发只有计数没有配额。

最小可行形态需要按顺序补齐：Router 保持单进程、单写者对账本；每个 Ticket 一个执行进程或受管环境；目录隔离；凭据按执行节点代理；按配额而不是计数限制并发；崩溃判定为“中断待恢复”；恢复前先核对工作树和远端状态。

顺序判断是**先本机进程/环境隔离，再跨机器**。两者共享同一个“执行节点”契约：assignment 下发、report 回传、status 查询、cancel。先把契约在本机跑通，再把它铺到网络和凭据上；反过来做，等于用未定型的契约同时承担网络故障和凭据泄露风险。

代价也要写清：启动延迟、内存占用、节点生命周期管理（起、等、停、回收、失联判定）。这些成本换来的不是更多功能，而是可判定的故障域。

### 实例归属与锁的粒度

上文记录了原型 stateDir 的锁，但没有区分“实例、会话、目录”三种归属。把三类加进来后，本轮核查得到下面这张表（本节额外使用“dsh-TUI 实现”一类：它是第三方周边项目，不计入 DSH 本体能力）：

| 归属对象 | 保护机制 | 争用时的行为 | 证据类别 |
|---|---|---|---|
| 原型 stateDir | `proper-lockfile` 锁住状态目录，一个 stateDir 一个 orchestrator | 第二个进程拿不到该目录 | 原型实现 |
| 单个 Session | DSH 在会话目录的 `session.lock` 上做非阻塞 `flock(2)`，竞争映射为 `SessionAlreadyOwnedError`，API 层返回 `session/writer-held` | 同一个 Session 的第二个 writer 被拒绝；持有者死亡后内核释放 | DSH 已有能力 |
| 工作目录 | 没有跨进程锁 | 两个 agent 可以并发写同一份源码 | DSH 现状（缺失） |
| 同机多开入口 | `dsh-TUI` 每个终端各自装配一套 Host，共享会话根，用 `~/.dsh-tui/session-mounts.json` 协调挂载 | 新会话不排斥；同一 Session 被账本拒绝，`flock` 兜底 | dsh-TUI 实现（第三方） |

DSH 的会话锁只保护**同一个 Session 日志**：POSIX 上是非阻塞 `flock(2)`，争用抛 `SessionAlreadyOwnedError`，持有者进程死亡时内核释放，活着但卡死的持有者继续持有且没有超时，见 [lease.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/session/session-persistence-jsonl/src/lease.ts#L4-L8)、[lease.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/session/session-persistence-jsonl/src/lease.ts#L40-L40)、[lease.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/session/session-persistence-jsonl/src/lease.ts#L68-L68) 和 [README.md](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/api/session-controller/README.md#L65-L65)。这部分已在 [dsh-agent-collaboration-research.md](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/dsh-agent-collaboration-research.md#L194-L198) 与 [dsh-deployment-and-tenancy-deep-dive.md](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/dsh-deployment-and-tenancy-deep-dive.md#L62-L66) 记录，本节不重复推导，只补“锁的粒度”这一层。

dsh-TUI 的本轮事实（第三方周边，不是 DSH 本体）：同一 cwd 开多个终端跑 `dsh-tui`，每个终端是独立进程；每个进程用 `new host.Context()` 加 `ctx.plugin(Loader)` 在自己进程内装配 Cordis root、agents、Session 持久化和 workspace registry，没有 daemon 或 socket 连接既有实例，见 [host-dsh.ts](file:///Users/yangjiefeng/Documents/ccch1mneyyy/dsh-TUI/src/dsh-adapter/host-dsh.ts#L300-L308) 与 [host-dsh.ts](file:///Users/yangjiefeng/Documents/ccch1mneyyy/dsh-TUI/src/dsh-adapter/host-dsh.ts#L198-L213)。它们共享 `$DSH_HOME/sessions` 会话根（base bundle 把 `session-persistence-jsonl` 的 root 配成 `dshHomePath('sessions')`，见 [cordis.patch.yml](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/bundle/base/cordis.patch.yml#L138-L141)），以及 `~/.dsh-tui/session-mounts.json` 占用账本；账本写入取短跨进程锁、锁内重读、原子替换，记录持有者 pid 和 sessionIds，判活靠 pid，账本本身没有时间戳，另有发布器每 15 秒刷新，见 [sessionMounts.ts](file:///Users/yangjiefeng/Documents/ccch1mneyyy/dsh-TUI/src/sessionMounts.ts#L3-L3)、[sessionMounts.ts](file:///Users/yangjiefeng/Documents/ccch1mneyyy/dsh-TUI/src/sessionMounts.ts#L29-L46)、[sessionMounts.ts](file:///Users/yangjiefeng/Documents/ccch1mneyyy/dsh-TUI/src/sessionMounts.ts#L638-L643) 和 [session-mount-heartbeat.ts](file:///Users/yangjiefeng/Documents/ccch1mneyyy/dsh-TUI/src/dsh-adapter/session-mount-heartbeat.ts#L40-L40)。TUI 的进程模型也写在它自己的文档里：TUI 自己就是终端进程，一台机器可以同时开多个，见 [session-mount-runtime.md](file:///Users/yangjiefeng/Documents/ccch1mneyyy/dsh-TUI/docs/session-mount-runtime.md#L20-L29)。

由此产生两个后果：

- **新会话互不排斥。** 同一 cwd 下两个 agent 可以并发改同一份源码，DSH 不设防；没有文件锁、目录租约或 workspace 级所有权。这不是 dsh-TUI 的缺陷，因为 DSH 本身也只锁会话日志，不锁工作目录。
- **只有同一个 Session 会被拒绝。** dsh-TUI 的账本报告 `mounted by another TUI terminal (pid N)` 并拒绝继续，内核 `flock` 兜底；开新会话不受影响，见 [plugin.ts](file:///Users/yangjiefeng/Documents/ccch1mneyyy/dsh-TUI/src/dsh-adapter/plugin.ts#L3093-L3100)。

workspace 记录还有一处未验证的并发风险：`attachSession` 走应用层写链，写链只在**进程内**串行；storage-json 对每个单元做整文件原子替换，并明确以“每个进程一个 writer、last-write-wins 正确”为前提，见 [entity.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/workspace/workspace/src/entity.ts#L191-L221)、[atomic.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/storage/storage-json/src/atomic.ts#L8-L10) 和 [single-unit.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/storage/storage-json/src/single-unit.ts#L4-L7)。两个进程并发 attach 同一条 workspace 时，理论上后写者会用自己陈旧的 `sessionIds` 覆盖先写者，丢失一条关联；本轮未实测。

对企业级可用而言，结论要落到边界上：**会话隔离 ≠ 目录隔离 ≠ 进程隔离 ≠ 租户隔离。** 会话锁解决的是“一个日志不能有两个 writer”；它不解决“两个人改同一份代码”“一个进程崩了拖垮另一个”“一个租户读到另一个租户的凭据”。多机、多员工场景真正缺的是**执行节点所有权与 lease**：谁拥有哪个执行节点、租约多长、失联如何判定、任务如何改派。再加一把会话锁不会补上这个缺口。

## 企业化差距

按优先级排列，每一项都是边界问题，不是功能清单：

1. **身份与权限边界。** 谁以什么身份发起、哪台机器执行、能读到哪些数据。原型只有一个操作者 OS 用户和 `danger-full-access`，没有执行节点身份。
2. **控制面（租约、配额、审计、租户）。** 谁拥有哪个任务、并发多少、资源上限、操作如何留痕。原型有应用内状态和面板，没有跨进程控制面。
3. **状态所有权（Session log 不等于业务账本）。** Session 记录模型交互事实；Ticket、Mandate、审批和验收属于业务账本。把两者混为一谈，恢复时就会把“模型说过”当成“业务已批准”。
4. **副作用语义（拒绝、已提交、结果未知）。** GitHub 评论、PR、CI 操作必须区分这三种结果，并带幂等键与 receipt。原型的 Outbox 有回执和重试，但没有远端幂等键。
5. **组织责任（谁批、谁验收、冲突谁裁）。** 系统可以保留要求和来源，不能自行赋予裁决权。原型记录 Mandate 与 Decision，但冲突裁决仍要回到人。

落点不是缺功能，是缺边界。功能可以继续加，边界不定义就无法把研究原型交给组织使用。

## 外部材料核查

核查对象是一份关于本主题的 ChatGPT 分享页，共两轮问答。该页面没有本地归档，以下按问答结论转述，不逐字引用；涉及文章的判断均以上面的本地文章副本为准。

整体判定：**架构描述可信，规模与落地状态被放大**。材料对四特征、五模块和双层职责的概括基本准确，但它把文章里的设计图当成了系统现状图。

关键失准如下：

| 材料表述 | 核查结果 | 证据 |
|---|---|---|
| “云端计算 + BYOM 本地环境”是系统现状 | 这是文章第 5 节的设计，不是原型实现 | [文章归档](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/reference-materials/super-agent-design-exploration.md#L202-L210)；原型部署是本地运行时，见 [006-deployment.md](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/docs/006-deployment.md#L100-L107) |
| 暗示存在跨进程或远程 Worker | 原型是同一进程内的两个平级 Session | [runtime.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/src/app/runtime.ts#L104-L105)、[dsh.ts](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/src/executor/dsh.ts#L23-L26) |
| 把 DSH Gateway 当成跨主机通道 | Gateway 是 Client→Host，远程客户端驱动本地 Session | [api-gateway.md](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/api-gateway.md#L9-L11) |
| “Router 不应等于常驻 LLM 进程”被包装成对 DeepSeek 的纠正 | 原文明确选择了单个常驻 LLM Session 作为 Router 核心实现 | [文章归档](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/reference-materials/super-agent-design-exploration.md#L84-L84) |

数字语境错位同样需要纠正：

- 2323 万到 3177 万 token 是“Super-agent 去掉直通”的消融结果，不是与单 Session 的对比，见[文章归档](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/reference-materials/super-agent-design-exploration.md#L254-L254)。
- “每分钟 1 条到 40 条”是 Trigger 的到达速率，属于输入侧；输出侧是平均 batch 从 1.0 到 2.8、单次请求从 2.5 秒到 3.9 秒、单个决定分摊从 6.4 秒降到 1.6 秒，见[文章归档](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/reference-materials/super-agent-design-exploration.md#L258-L264)。
- “Watchdog 还在设计中”不准确。文章说内部主系统外部已经配置了独立的 Watchdog Session，见[文章归档](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/reference-materials/super-agent-design-exploration.md#L226-L226)；没有 Watchdog 的是公开原型，见[原型研究报告](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/dsh-superagent-prototype-research.md#L126-L126)。

可信部分应当保留：连续、高效、主动、持久四个特征；双层架构、事件驱动、面向人的交互、计算与状态和环境分离、Watchdog 五个模块；Router 与 Worker 是职责分层而不是 Subagent 父子关系；公开原型是 research prototype，不等同内部实现（[README.md](file:///Users/yangjiefeng/Documents/deepseek-ai/dsh-superagent-prototype/README.md#L3-L5)）。

## 开源方案评估

以下判断依据各项目的公开文档、README 和许可页，查询日期 2026-11-04。本轮没有逐项阅读源码，能力与许可可能随后续版本变化。

| 项目 | 判定 | 依据与缺口 |
|---|---|---|
| Agno / AgentOS | 勉强 | 有 agent runtime 与控制面雏形，但缺事件驱动准入；控制面闭源，不能作为可自建的企业底座。 |
| Spring AI Alibaba | 单独勉强，配 Temporal 可行 | Java 生态的 agent 编排可用，但常驻调度和持久执行要另接 Temporal 一类持久层。 |
| Temporal | 只适合做持久编排层 | 工作流持久性、重试和定时能力强，但它不是 agent 运行时，也不提供事件准入、任务账本或租户控制面。 |
| LangGraph | 勉强 | 图编排与检查点可用，但缺常驻调度与事件接入；托管 Platform 为专有服务，不能当自建控制面。 |
| Lynxe（原 JManus） | 不合适 | 定位与事件准入、常驻调度和企业治理需求不匹配，公开文档没有提供可作控制面的边界能力。 |
| OpenHands | 勉强 | 通用编码 agent 平台成熟，但作为通用业务平台不合适；多租户能力主要在商业版。 |
| Restate | 次选 | 持久执行与事件驱动原语合适，但 BSL 1.1 许可、无原生 cron、无多租户控制面。 |
| Dify / n8n / AutoGen / CrewAI | 不合适 | 许可限制、维护状态或开源版无常驻执行器；四项按各自命中的限制逐出，不构成统一架构。 |

结论：**“找一个现成开源实现”这个前提不成立。** 缺口不在编排原语，编排原语在 Temporal、Restate、LangGraph 里都有；缺口在业务账本与治理：事件准入、Task Registry、Policy 留痕、租户审计、凭据托管。七个可比较的候选项目里，事件驱动准入没有一个真正开箱即用的实现，而这正是 Super-agent 与多 Agent 框架的分界。

路线立场：基于 DSH 自建，只补最小持久层；Temporal 仅在跨机或多租户需求出现时引入；不 fork 原型，因为它的单机假设已经写进 schema、锁和 ID；不用 Agno 替换后端；不拿 BSL/SUL 项目做对外平台。

## 可验证的下一步

按顺序只做三件事，前一件决定后一件是否值得做：

1. **杀进程后 GitHub 副作用是否重复。** 在 Ticket 已创建 PR 或评论后强杀进程，重启后观察 Outbox 和 Assignment 恢复是否重复副作用。判据是无重复，或重复能被幂等键识别并收敛。它先做，是因为原型已有恢复提示，但远端幂等键还没有证据。
2. **单 Router 在每分钟 40 条真实输入下是否成瓶颈。** 用真实 GitHub/Feishu 事件速率驱动，测 Eval 延迟、batch、单决定耗时和积压。判据是在目标团队规模下没有持续积压，且瓶颈出现时能定位到评估、调度还是执行。文章压测是合成负载且 Worker 用 Mock，必须用真实输入复核。
3. **无 Mandate 的事件能否被提示词绕过。** 构造未授权或未获准事件，检查提示注入能否让 Eval 接受或让 Worker 执行。判据是无 Mandate 不产生 Assignment，绕过尝试被拒绝并留痕。它决定能不能给不可信事件开门。

这三件之后，才谈沙箱、凭据代理和跨节点。顺序反了，就会在未验证的副作用语义上叠加网络和凭据风险。

## 局限

- 未运行原型的 `pnpm check`，未接入真实 GitHub/Feishu，未复现文章实验。
- 文章引用来自本地归档副本；原文页面若变化，以页面为准。
- 外部项目能力多来自文档和 README，没有逐项阅读源码；许可与维护状态需在采购或选型前复核。
- ChatGPT 分享页没有本地归档，本节结论是两轮问答的转述，不是逐字引用。
- Meta Muse 与第三方对比文章没有抓取，未纳入本次评估。

## 来源

- 原型仓库：`dsh-superagent-prototype` 0.1.0，重点阅读 `src/app/runtime.ts`、`src/app/sessions.ts`、`src/app/delivery.ts`、`src/executor/dsh.ts`、`src/policy.ts`、`src/app/effects.ts`、`src/limits.ts`、`package.json`、`cordis.patch.yml`、`docs/006-deployment.md`、`docs/007-architecture.md` 和 `scripts/dsh-superagent`。
- 文章：[《Super-agent 设计探索：迈向更自主的 Agent 系统》本地归档](reference-materials/super-agent-design-exploration.md)，公众号页面日期 2026-10-31。
- DSH：[api-gateway.md](../api-gateway.md)、[architecture.md](../architecture.md)、[subagent-dsh-sdk README](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/subagent/subagent-dsh-sdk/README.md)、[ssh README](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/ssh/README.md) 和 [sandbox README](file:///Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/sandbox/sandbox/README.md)。
- 外部项目：Agno/AgentOS、Spring AI Alibaba、Temporal、LangGraph、Lynxe（原 JManus）、OpenHands、Restate、Dify、n8n、AutoGen、CrewAI 的官方文档、README 与许可页，查询日期 2026-11-04。

## Dev Note

本文是 `docs/drafts/` 中的中文研究草稿，不是稳定架构决策或发布文档。它补充[原型研究报告](dsh-superagent-prototype-research.md)的运行事实与外部评估，不改变该文的团队收益结论与采用建议。若原型源码、文章归档、DSH 能力或外部项目版本变化，应重新核对对应证据。
