---
description: "核实 DSH CLI、Agent 生命周期事件与 Herdr self-report 接口的兼容关系，并给出按运行模式划分的状态上报与恢复集成方案。"
---

# DSH Agent 与 Herdr 集成：CLI 交互模型、状态感知与 Reporter 设计

## Summary

DSH 确实有一个统一的 `dsh` CLI，但当前仓库中的 CLI launcher 不等于 Codex CLI 式的内置终端 UI。它负责选择并启动 profile；随仓库提供的可用入口是 Web、headless、SDK 和 ACP，`tui` 只在 launcher 帮助和 README 中作为“假定已安装的自定义 profile”示例出现。是否存在交互式终端 UI，取决于被启动的 profile 是否安装了相应的应用插件。

DSH 的 Agent runtime 已经提供适合状态集成的生命周期事件：`agent/created`、`agent/status`、`agent/disposed`、`agent/request-error` 和 `agent/assistant-stream`。其中 `agent/status` 只有 `idle | running`，表示整个 Agent 是否仍有活动驱动器，不表示某一个 prompt 的独立完成状态，也不直接表示“等待用户”。因此，第一版 Herdr reporter 应只做 `idle → idle`、`running → working` 的明确映射；不要把 request error、工具执行、模型流式输出或任意空闲状态直接映射为 Herdr `blocked`。

Herdr 已提供面向第三方 Agent 的稳定 self-report 入口：进程从 `HERDR_ENV`、`HERDR_PANE_ID`、`HERDR_BIN_PATH` 和 `HERDR_SOCKET_PATH` 获得运行环境，通过 `pane report-agent`、`pane report-agent-session` 和 `pane release-agent` 上报状态、会话恢复信息和退出。Herdr 对同一 `source` 的 `seq` 采用单调新鲜度判断，旧报告不会覆盖新状态；resume 命令还要求 reporter 先持有 pane，并满足 argv 安全限制。

因此，原建议的总体方向成立，但需要补上两个决定性限定：

1. **对终端型 DSH 进程而言**，一个很小的 DSH 原生 Cordis reporter 插件是比 `dsh-hooks-codex` 更合适的实现。
2. **对 `dsh web` 而言**，Herdr reporter 默认只能表示运行 Web server 的 pane，而不能自动逐个表示浏览器中的多个 DSH Agent。要管理浏览器 Agent，必须增加浏览器会话到 Herdr pane/agent 记录的显式映射，或者把 Herdr 管理对象定义为 Web server/host，而不是每个浏览器 Session。

本报告的推荐顺序是：先为单进程、单 root Agent 的终端 profile 验证状态 reporter；随后再决定是否需要 Web 会话聚合、浏览器控制通道、跨进程 reporter 或 DSH 原生 resume 入口。网络恢复仍应由 DSH 的 `agent/request-error` 扩展点负责，Herdr 只作为外部状态观察器和人工 watchdog。

## Table of Contents

- [调研范围与证据等级](#调研范围与证据等级)
- [结论一：DSH CLI 不等于内置 TUI](#结论一dsh-cli-不等于内置-tui)
- [结论二：DSH Agent 状态可以被原生观察](#结论二dsh-agent-状态可以被原生观察)
- [结论三：Herdr self-report 可以承载基础状态](#结论三herdr-self-report-可以承载基础状态)
- [按运行模式判断可行性](#按运行模式判断可行性)
- [为什么不应使用 dsh-hooks-codex 作为 reporter](#为什么不应使用-dsh-hooks-codex-作为-reporter)
- [推荐架构](#推荐架构)
- [状态、会话和恢复映射](#状态会话和恢复映射)
- [实现细节与失败语义](#实现细节与失败语义)
- [网络中断与 blocked 状态](#网络中断与-blocked-状态)
- [验证方案](#验证方案)
- [实施路线与退出条件](#实施路线与退出条件)
- [限制与未决问题](#限制与未决问题)
- [结论](#结论)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

## 调研范围与证据等级

本文基于 2026 年 10 月 4 日的两个本地 checkout 核验：DSH 当前 `research` 分支，以及 Herdr 当前本地 `master` checkout。DSH 的 CLI 命令、profile 行为、Agent 类型和事件以当前源码、README、测试与实际执行结果为准；Herdr 的 self-report 参数、状态枚举、序列号和 resume 校验以本地文档、Rust API schema、CLI 解析代码、API handler 和集成测试为准。

| 标记 | 含义 |
| --- | --- |
| 当前实现 | 可由当前 checkout 的源码、README、测试或命令执行直接确认 |
| 外部实现 | Herdr checkout 中的接口和行为；对 DSH 来说是外部依赖 |
| 设计判断 | 根据当前实现得出的架构判断，不代表已经实现 |
| 建议目标 | 推荐新增的插件、测试或协议 |

本次执行过的 DSH 核验命令及结果如下：

```text
pnpm dsh --help
  成功；显示 dsh 是 profile launcher，并将 app 参数转交给被启动 profile。

pnpm dsh web --help
  成功；显示 Web profile 的 host、port、trusted-host 和 no-open 参数。

pnpm dsh headless --help
  成功；显示 headless 是单任务、最终答案输出并退出的入口，支持 --json 和 --session-id。
```

`pnpm dsh web --help` 和 `pnpm dsh headless --help` 输出了代理环境提示，因为当前 shell 中存在 `all_proxy=socks5://...`，而 DSH 的配置加载器不支持该 scheme；这不影响本文关于 CLI/profile 结构的判断，但说明运行文档不能假设任意代理变量都会被 DSH 接受。

## 结论一：DSH CLI 不等于内置 TUI

### `dsh` 的职责

当前 `apps/cli` 的 launcher 解析 profile、patch、配置 dump 和 plugin 管理参数，然后启动选定的 profile。它不负责实现对话输入框、终端渲染、光标控制或交互式 Agent UI。CLI README 将这一职责边界写得很清楚：launcher 只解析自己拥有的参数，未识别的参数交给 profile 中的应用插件。

当前随仓库说明的入口模式是：

| 入口 | 当前职责 | 是否等价于 Codex CLI 式交互式终端 UI |
| --- | --- | --- |
| `dsh web` | 启动 Web profile 并提供浏览器 UI | 否；它是浏览器 UI server |
| `dsh headless "task"` | 执行一次任务、输出最终答案并退出 | 否 |
| `dsh --profile sdk` | 通过 JSON-RPC stdio 服务 SDK client | 否；交互 UI 由 client 提供 |
| `dsh --profile acp` | 通过 ACP stdio 服务自动化 client | 否；交互 UI 由 ACP client 提供 |
| `dsh <custom-profile>` | 启动用户组合的自定义 profile | 取决于 profile 中的 app plugin |
| `dsh tui` | launcher 可接受的 profile 名示例 | 不是随仓库提供的内置 TUI 证明 |

`apps/cli/src/args.ts` 的帮助示例包含 `dsh tui --patch ...` 和 `dsh tui --resume ...`，但这只是说明“profile app 参数由下游处理”。它不能推出仓库内存在 `tui` bundle，也不能推出 `--resume` 是 DSH launcher 的统一语义。

因此，对“DSH 有没有 CLI 版本”应分成两个问题回答：

- **有 CLI launcher 和 CLI profile。** 可以用 `dsh web`、`dsh headless`、`dsh --profile sdk` 等方式从命令行启动 DSH。
- **当前没有证据表明仓库自带 Codex CLI 式 TUI。** 若需要终端交互 UI，需要安装或实现一个 profile app，并遵守 DSH 的 plugin/profile 组合机制。

### 为什么这个区别影响 Herdr

Herdr 的 pane 以终端进程为管理对象。对于真正运行在 pane 前台、接收 stdin、具有“用户下一次输入”语义的 TUI，Herdr 可以同时使用：

```text
pane agent report → 状态
pane read        → 输出观察
pane send-keys   → 终端输入
resume_argv      → 重启后的恢复命令
```

对于 `dsh web`，pane 前台运行的是 Node Web server；用户输入进入浏览器，通过 HTTP/WebSocket/Remote 通道到达 server。Herdr 读取 server pane 的输出，不等于读取浏览器 UI；向 pane 注入 Enter 或 prompt，也不等于向某一个浏览器 Agent 发送 follow-up。因此 Web profile 的 Herdr 集成必须单独建模。

## 结论二：DSH Agent 状态可以被原生观察

### 当前公开事件

`packages/core/agent/src/runtime-types.ts` 声明了以下与 reporter 直接相关的事件：

| DSH 事件 | 当前语义 | 是否适合直接上报 Herdr |
| --- | --- | --- |
| `agent/created` | Agent 已完成注册和创建期监听器；创建完成后可使用 | 适合初始化 agent identity 和 `idle` |
| `agent/status` | `idle ⇄ running` 的 whole-agent 活动状态切换 | 适合映射 `idle/working` |
| `agent/disposed` | Agent 已离开 registry；不是一个 `AgentStatus` | 适合在确认无替代 Agent 后 release |
| `agent/request-error` | 某次模型请求失败；监听器可以返回 `{ kind: 'retry' }` | 适合内部恢复策略，不适合直接等同 blocked |
| `agent/assistant-stream` | 当前进程内的 assistant attempt 流式帧 | 适合 UI 观察，不适合作为 whole-agent 状态源 |

当前 `AgentStatus` 明确只有：

```ts
type AgentStatus = 'idle' | 'running'
```

`running` 的开始点是 Agent 唤醒输入并进入可取消的 pre-step 处理；`idle` 表示没有 driver 仍在调度或运行。连续多个 turn 可以共享一个 `running` 区间，因此 reporter 不能假设每次 `followup()` 都产生一对 `running → idle`。

`AgentHandle.whenIdle()` 也不能替代状态事件：它等待 whole-agent activity 达到静止，不标识某一条消息的结算；排队的 follow-up 可能继续运行，取消或 dispose 还可能丢弃尚未启动的工作。

### Agent identity 与生命周期边界

DSH 的 `agent/created` 和 `agent/disposed` 是实时 Agent registry 的生命周期事件。Agent 与 Session 共享 identity；`AgentHandle.dispose()` 是持有者拥有的 teardown 能力。一个 reporter 若监听全局 agent 事件，必须明确自己是在管理：

1. 一个 root Agent；
2. 一个进程内所有 Agent 的聚合状态；还是
3. 一个 pane 中的多个 child Agent。

不能把 `agent.id` 直接当成 Herdr pane identity。Herdr 的 self-report 记录绑定的是 `pane_id`，而一个 pane 同时只有一个当前 reporter/agent presentation。一个 DSH 进程内的多个 Agent 不能无损地映射到同一个 Herdr pane 的多个独立条目。

### `agent/request-error` 的实际职责

当前 DSH 将模型请求恢复设计在 `agent/request-error` waterfall 上。监听器拥有失败时可以执行修复并返回 `{ kind: 'retry' }`；未被处理时返回 `undefined`，失败 turn 终止。这个机制比外部向终端发送“继续”可靠，因为 DSH 仍掌握 provider、turn、step、失败类型和取消信号。

因此，Herdr reporter 的 `agent/request-error` 监听器最多用于：

- 记录诊断或更新短暂的外部观测信息；
- 触发一个受限、明确归属的 retry policy；
- 在最终失败后把 pane 状态保留为 `idle` 或 `unknown`，而不是假装 Agent 仍在 working。

它不应通过 Herdr pane input 注入 prompt 来代替 DSH 内部 retry。

## 结论三：Herdr self-report 可以承载基础状态

### 当前接口

Herdr 当前文档和源码提供以下环境变量：

| 环境变量 | 含义 |
| --- | --- |
| `HERDR_ENV` | 值为 `1` 时表示进程位于 Herdr pane 中 |
| `HERDR_PANE_ID` | 当前 pane identity |
| `HERDR_BIN_PATH` | 管理该 pane 的 Herdr executable |
| `HERDR_SOCKET_PATH` | Herdr API socket |

第三方 Agent 可以通过 CLI 发送：

```sh
"$HERDR_BIN_PATH" pane report-agent "$HERDR_PANE_ID" \\
  --source dsh \\
  --agent dsh \\
  --state working \\
  --seq 1
```

退出时可以发送：

```sh
"$HERDR_BIN_PATH" pane release-agent "$HERDR_PANE_ID" \\
  --source dsh \\
  --agent dsh \\
  --seq 2
```

Herdr pane agent 状态枚举为 `idle`、`working`、`blocked` 和 `unknown`。Herdr CLI 的 parser 还定义了更宽的自动化 Agent 状态 `done`，但 `pane report-agent` 使用的是 pane agent state，不能把两套枚举混写。

### 序列号与乱序

Herdr `PaneReportAgentParams` 接受可选 `seq: u64`。本地 handler 会检查同一 source 的报告是否更新，并在旧报告到达时忽略它。官方第三方集成文档还要求 `seq` 在 agent 重启之间保持递增；使用进程启动时间或随机 UUID 不能直接满足“数值递增”约束，除非 reporter 为每个 source 持久化计数器。

因此，第一版 reporter 有两种选择：

| 方案 | 优点 | 风险 | 建议 |
| --- | --- | --- | --- |
| 单进程内递增计数器 | 实现简单，能处理同一进程内乱序 | 重启后可能从较小值开始，旧状态可能拒绝新报告 | 仅适合一次性 PoC |
| 持久化或时间戳序列号 | 跨重启保持大致单调 | 时钟回拨、并发进程和持久化失败需要处理 | 生产 reporter 应采用 |

报告发送还必须串行化，或实现“只保留最新状态”的单飞队列。不能让 `created`、`running`、`idle` 和 `disposed` 各自独立启动异步 CLI，从而让旧状态在新状态之后到达。

### Resume report

Herdr 的 `pane.report-agent` 和 `pane.report-agent-session` 都支持 `agent_session_id`、`agent_session_path` 和 `resume_argv`。当前校验要求：

- resume argv 的第一个元素必须是 PATH 上的普通命令名，而不是绝对路径；
- 参数不得含 apostrophe 或控制字符；
- 参数数量和总长度有限制；
- reporter 必须先以 state report 持有该 pane，否则返回 `resume_not_accepted`；
- 非法命令返回 `invalid_resume_argv`，该报告不会生效。

这使得“报告 session id”和“报告可恢复命令”成为两个不同责任。DSH 只有在拥有稳定的、公开的、可在独立 shell 中重启的 resume 命令时，才应报告 `resume_argv`。不能因为存在 `AgentHandle` 或 `resumeSessionId` 就拼造一个 Herdr 可执行的 CLI argv。

## 按运行模式判断可行性

### 终端型自定义 profile：最适合

如果之后存在一个真正的 DSH TUI profile，并且它在 Herdr pane 的前台运行，那么 reporter 可以直接绑定这个进程的 root Agent：

```text
Herdr pane
  └── dsh --profile <tui-profile>
        ├── terminal UI
        ├── DSH Agent Loop
        └── native Herdr reporter plugin
```

这时“一个 pane 一个 root Agent”是自然约束；`agent/status` 的 `idle/running` 映射与 Herdr `idle/working` 一致；用户输入也确实由 pane 的 stdin 进入 TUI。这个模式最接近 Codex CLI，也是第一阶段最值得验证的目标。

### `headless`：可上报，但不是交互式 Agent

`dsh headless` 是单任务、最终答案输出并退出的入口，支持 `--json` 和 `--session-id`。它可以在开始、运行、结束时被外部包装器报告给 Herdr，但没有持续的交互式 prompt surface，也不应把 Herdr 的 `pane send-keys` 当成续作机制。

如果需要 Herdr 管理 headless 作业，建议把它看成 job/process：

- 启动前或 Agent 创建时报告 `working`；
- Agent 进入 `idle` 且进程即将退出时，报告 `idle` 或直接 release；
- 通过稳定的 session id 和明确的后续命令恢复，而不是向已退出的 stdin 写入。

### `sdk` / `acp`：管理 client，而不是 launcher

SDK 和 ACP profile 的 stdout 是协议通道。交互式输入由 SDK/ACP client 发送，DSH launcher 本身不提供 TUI。因此 reporter 若要反映 Agent 状态，应放在：

- 持有 Herdr pane 的交互式 client；或
- DSH host 进程中的专用 integration plugin；

并明确由哪一层拥有 `agent_session_id` 和 resume argv。把 Herdr CLI 报告直接写到 ACP stdout 会破坏协议纯度；把 prompt 通过 pane 注入也可能绕过 ACP client 的 session ownership。

### `web`：不能直接等同为 pane 中的一个 Agent

`dsh web` 启动的是长期运行的 Web server。浏览器连接后，可能存在多个用户、多个 browser tab、多个 Session 或多个 live Agent；这些 Agent 的生命周期发生在 DSH host，而不是 Herdr pane 的 stdin/stdout。

因此存在三个不同的集成级别：

| 级别 | Herdr 看到什么 | 是否需要 DSH 新协议 |
| --- | --- | --- |
| Server-level | `dsh web` 进程是否仍在运行 | 否；普通 pane/process 观察即可 |
| Host-level aggregate | Web server 中是否存在 running Agent、是否有未处理交互 | 需要一个聚合 reporter，但只能表示汇总状态 |
| Browser-session-level | 每个浏览器 Session 的 Agent 状态、恢复命令和 pane 对应关系 | 需要 browser-to-Herdr identity bridge，不是简单 Cordis reporter |

对 Web profile 最稳妥的第一版是 server-level 或 host-level aggregate：一个 Web server 对应一个 Herdr pane，状态使用聚合规则，例如“至少一个 root Agent running 则 working；存在可确认的用户决定且没有 running driver 才 blocked；没有 live Agent 则 idle”。但这个规则必须在 DSH Web 的 Session/Agent 连接模型中进一步验证，不能由 `agent/status` 单事件直接推导。

如果产品目标是让 Herdr 的 `agent list` 逐个列出浏览器里的 DSH Agent，那么每个浏览器 Session 必须拥有可传递给 Herdr 的外部 identity，并且需要解决：

- 一个 Herdr pane 是否对应一个 browser tab、一个 Session 还是一个 Web server；
- 浏览器断线后 Agent 是否继续存在；
- 同一 Session 被多个 tab 打开时谁持有报告权；
- `agent/disposed` 是否真的表示浏览器 Session 完成，而不是 Web client 卸载；
- Herdr resume 命令如何重新打开浏览器并选择正确 Session；
- `HERDR_*` 环境变量如何安全地到达浏览器，而不泄露本地 socket 能力。

这些问题不能靠一个 DSH root plugin 自动解决。

## 为什么不应使用 dsh-hooks-codex 作为 reporter

`@deepseek-ai/dsh-hooks-codex` 是 Codex `hooks.json` 的兼容桥接层，当前支持 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse` 和 `Stop` 五类 command hook。它的职责是复用 Codex hook 配置来附加上下文、阻塞 prompt/tool 或强制继续，并不拥有 DSH Agent registry 的专用 reporter 责任。

它不适合承担 Herdr 状态集成的原因是：

| 问题 | 具体原因 |
| --- | --- |
| 状态来源不对 | Codex `Stop` 不是 DSH whole-agent `idle`，hook 事件也没有完整 `agent/disposed` 语义 |
| 多 Agent 不自然 | hook payload 面向一次运行和工具调用，不是 DSH Agent registry identity |
| 错误恢复不对 | DSH 的 request failure retry 属于 `agent/request-error` waterfall，不能由外部 Stop hook 可靠代替 |
| 资源释放不对 | Herdr release 应绑定进程/Agent owner teardown，不应绑定某个 hook 的一次回调 |
| 接口意图不对 | 用 Codex 方言描述 Herdr 集成会让 profile 配置承担本应由 DSH 原生插件完成的生命周期责任 |

`dsh-hooks-codex` 仍然适合它自己的目标：当用户已经拥有 Codex `hooks.json` 且希望在 DSH 运行时复用这些 command hooks 时使用。Herdr reporter 应是一个独立的 DSH native Cordis plugin，或者在最小 PoC 中是一个外部 wrapper。

## 推荐架构

### 第一阶段：单 root Agent、单 pane、CLI reporter

第一阶段只解决最小可靠闭环：一个终端型 DSH profile 在一个 Herdr pane 中运行一个 root Agent，DSH reporter 将生命周期映射到 Herdr。

```text
Herdr pane
   │ environment
   ▼
DSH process
   ├── root Agent
   ├── native Cordis reporter
   │      └── serialized report queue
   │             └── HERDR_BIN_PATH pane report-agent
   └── terminal UI / profile app
```

reporter 不应直接 import Herdr 内部 Rust/API 类型；使用 `HERDR_BIN_PATH` CLI 是跨平台、与 Herdr 版本相对解耦的 portable path。只有在 CLI 进程开销被测量为问题后，才考虑使用 `HERDR_SOCKET_PATH` 直接发送 JSON-RPC。

### 插件职责

建议插件只拥有以下责任：

1. 检查 `HERDR_ENV === '1'`，并确认 pane id、Herdr executable、source 和 agent label 都存在；
2. 为一个 DSH root Agent 绑定稳定 source `dsh` 和显示名 `dsh`；
3. 维护单调递增的报告序列；
4. 将状态变化放入最新值优先的串行队列；
5. 在 `agent/created` 时建立 identity，在 `agent/status` 时更新状态；
6. 只在确认该 reporter 所拥有的 root Agent 结束时 release；
7. 对 Herdr CLI 非零退出、超时或 pane 已消失采用 best-effort 处理，不阻塞 Agent Loop。

reporter 不应：

- 持有 DSH Agent 的 disposal 权限；
- 把 Herdr 发送来的终端输入翻译成 DSH prompt；
- 自己实现 request retry、Session resume 或用户审批；
- 在 Web server 中把所有 child Agent 的状态未经聚合规则直接写成同一个 pane 状态；
- 把 API key、完整 prompt 或 session 内容发送给 Herdr。

### 事件映射

单 root Agent 的建议映射如下：

| DSH 事件/事实 | Herdr 动作 | 说明 |
| --- | --- | --- |
| root `agent/created` | `report-agent --state idle` | 创建完成后建立可观察 identity |
| root `agent/status: running` | `report-agent --state working` | 整个 Agent 有活动 driver |
| root `agent/status: idle` | `report-agent --state idle` | 无活动 driver；不等于某个 follow-up 的结果 |
| root `agent/disposed` | `release-agent` | 仅当没有同 pane 的替代 root Agent |
| `agent/request-error` | DSH 内部 recovery 或诊断 | 不直接映射 blocked |
| 真实用户决定待处理 | `report-agent --state blocked --message ...` | 需要独立、可确认的 pending-interaction 来源 |
| 进程退出且未显式 release | 无 | Herdr 自己的 pane idle-shell safety net 会清理，但不应依赖它 |

### 多 Agent 的处理策略

Herdr 一个 pane 的 self-report 记录不适合承载多个独立 DSH Agent。推荐按优先级选择：

1. **每个 root Agent 一个 Herdr pane/进程。** 最简单、状态和 resume identity 最清晰。
2. **一个 DSH 进程聚合所有 root Agent。** Herdr 只显示一个 DSH aggregate，不声称逐 Agent 管理。
3. **为每个 browser/remote Session 设计外部 bridge。** 只有在 Web 产品明确需要逐 Session Herdr 管理时实现。

不要把 child Agent 的 `agent/status` 直接覆盖 root Agent 的状态；至少要先过滤 root、或者维护明确的聚合计数器。

## 状态、会话和恢复映射

### `idle` 与 `done` 不能互换

DSH 的 `idle` 是 live Agent 仍然存在但当前没有 driver 活动；Herdr 的 `done` 属于另一套自动化 Agent 状态，而 pane self-report API 的 state 参数没有 `done`。因此一次 headless 任务完成后应根据进程生命周期选择：

- 任务仍可接收下一条输入：报告 `idle`；
- 任务进程即将退出且 pane 不再由它管理：release；
- 需要保留完成记录：用 Herdr 的 Agent/job 语义或 metadata，不要把 pane state 写成不受支持的值。

### `blocked` 需要事实来源

Herdr 的 `blocked` 表示 Agent 需要用户决定。DSH 的 `AgentStatus` 没有这个状态；`idle` 也可能只是 Agent 等待新输入、正在等待一个维护任务之后的工作，或尚未收到 follow-up。第一版 reporter 不应把以下事实自动写成 blocked：

- 模型请求失败；
- 工具正在执行；
- 网络重试正在等待；
- Agent 当前 idle；
- 浏览器断开连接；
- `agent/assistant-stream` 暂时没有 chunk。

DSH 已有 `user-approval` 和 `user-questions` capability，但它们的请求状态是各自服务/Session projection 的事实，不是 `AgentStatus` 的别名。实现 blocked reporter 前，需要定义一个能回答“现在是否存在仍可回答的用户决定”的聚合服务或事件源，并处理 request abort、answer、continued、settled 和 Agent dispose 的竞态。

### Resume 命令不应伪造

Herdr resume 需要一个在当前工作目录中可重新执行的普通命令。DSH `AgentHandle.resume()` 是同进程/宿主 runtime 的 factory 操作，不自动产生 shell command；`dsh headless --session-id` 是当前明确可见的 CLI 恢复参数，但它仍是一次任务入口，而不是通用的交互式 TUI resume 语义。

在 DSH 没有稳定的、文档化的终端 profile resume 命令之前：

- 可以只报告状态和 `agent_session_id`；
- 可以把 `agent_session_path` 作为诊断或外部管理元数据，但不要假设 Herdr 能据此恢复 DSH；
- 不要把 `dsh --profile <name> --resume <id>` 写入 `resume_argv`，除非该 profile 明确声明并测试了 `--resume`；
- 不要把 `pnpm`、绝对路径 launcher 或包含 secret 的 argv 写入 Herdr。

## 实现细节与失败语义

### Best-effort 不能阻塞 Agent Loop

Herdr 文档明确建议报告在后台发送、设置短超时、忽略失败，只保留最新状态。reporter 的事件监听器因此不应把 `await $HERDR_BIN_PATH ...` 放进 DSH 生命周期关键路径，尤其不能让 Herdr socket 消失导致 `agent/created` 拒绝、Agent Loop 停止或 profile unload 卡住。

推荐的本地队列模型是：

```text
publish(next report)
  ├── replace pending report with newer state
  ├── if sender idle: start one short-lived send
  └── sender settles, then send newest pending report
```

队列需要特殊处理终止事件：`release-agent` 必须优先于尚未发送的普通状态报告；如果同一个 pane 即将由另一个 DSH Agent 接管，则不应发送旧 Agent 的 release 以清掉新 Agent 的记录，而应先完成 owner handoff 设计。

### Source 与 agent label

Herdr 文档要求 `source` 稳定、唯一，且不要使用 `herdr:` 前缀，因为该前缀由 Herdr 自己的 integrations 使用。建议：

```text
source = dsh
agent  = dsh
```

如果未来需要区分 Web aggregate、TUI 和 SDK client，source 应在协议上固定，例如 `dsh:web`、`dsh:tui`、`dsh:client`，而不是把随机进程 id 拼进 source。进程或 Session identity 应放进 `agent_session_id`、`agent_session_path` 或 message，而不改变 source 的含义。

### CLI 与 socket 直接访问

Herdr 的 `HERDR_BIN_PATH` CLI 是 portable choice，尤其适合 DSH 的跨平台 Node runtime。直接使用 `HERDR_SOCKET_PATH` 可以减少子进程，但需要自己实现 JSON-RPC framing、错误处理、超时和 socket 可用性检查，并跟随 Herdr socket API 的版本变化。建议顺序是：

1. 第一版使用 CLI，验证状态语义和生命周期；
2. 用基准测量每次 report 的进程启动开销；
3. 只有当高频状态报告成为实际瓶颈时，才加入 socket client；
4. socket client 仍保留 CLI fallback 或明确要求匹配的 Herdr 版本。

### 退出与异常

正常 owner teardown 应显式发送 release。异常退出时，Herdr 会在 pane 回到 idle shell prompt 后清理 agent metadata，但这是安全网，不是 reporter 的正常协议。DSH 进程若被 SIGKILL、宿主机断电或 Node runtime 崩溃，不能保证 release 送达；下次进程启动必须使用新的、更大的序列号，并且不应假设旧 pane 状态已经清除。

## 网络中断与 blocked 状态

### 正确的分层

网络故障的推荐处理顺序是：

```text
DSH agent/request-error
        ↓
有限 retry / backoff / failure classification
        ↓
DSH Agent Loop 继续或结束
        ↓
Herdr reporter 反映 working / idle / unknown
```

Herdr 作为外部 watchdog 只负责：

- 发现长时间没有状态变化；
- 读取 pane 输出或报告信息；
- 通知用户；
- 在明确存在交互式 TUI 和稳定输入契约时发送人工恢复动作。

Herdr 不应通过“继续”输入去猜 DSH 当前 turn、step、provider 或取消状态。对于 Web、headless、SDK 和 ACP profile，这种终端输入甚至可能没有目标。

### 有限 retry 的注意事项

如果新增 DSH retry plugin，应使用 `agent/request-error` 的 `{ kind: 'retry' }` 机制，并为可恢复错误设置有限次数、退避和取消优先级。报告本身不应成为 retry policy 的存储位置；否则 Herdr 状态落后、pane 重启或 CLI 调用失败会改变 Agent 的业务语义。

### blocked 的第二阶段

只有在以下信息都能被可靠获得时，才进入 blocked 支持：

- 哪个 root Agent 正在等待；
- 等待的是 approval、user question 还是其他明确的人类决策；
- 问题是否仍可回答，还是已取消/继续/结算；
- answer 送达后怎样把 Herdr 状态恢复为 working；
- Agent dispose、Session close 和浏览器断开时怎样清理 blocked。

如果这些事实只存在于 Web projection 或某个 UI client 本地，单纯监听 core agent events 不足以实现正确 blocked。

## 验证方案

### 第一阶段测试矩阵

最小测试不应只断言“Herdr CLI 被调用”，而应验证状态和所有权语义：

| 场景 | 期待结果 |
| --- | --- |
| 进程在 Herdr 外启动 | 不执行任何 Herdr report |
| root Agent created | 仅发送一次 identity/idle 报告 |
| `idle → running → idle` | Herdr 按序看到 idle、working、idle |
| 连续两个 follow-up | 允许只有一个连续 working 区间，不要求每个 follow-up 一对状态 |
| 重复或过时事件 | 不发送重复状态，或由 Herdr seq 拒绝旧报告 |
| Herdr CLI 超时 | DSH Agent 继续运行；错误只进入诊断日志 |
| Herdr pane 消失 | DSH Agent 继续运行或按自身 owner policy 退出，不因 reporter 抛错而崩溃 |
| root Agent dispose | release 一次 |
| child Agent dispose | 不释放仍由 root Agent 持有的 pane |
| 进程内多个 root Agent | 明确拒绝、聚合或按 pane 分离，不能静默覆盖 |
| SIGTERM | 在可用时间内发送 release，随后正常 teardown |
| SIGKILL | 不要求 release 成功；重启和 Herdr safety net 仍可恢复 |

### Herdr 集成验证

在 Herdr pane 中启动一个最小可交互 DSH profile 后，至少验证：

```sh
herdr pane get "$HERDR_PANE_ID"
herdr agent list
herdr agent wait dsh --until idle --timeout 120000
herdr agent read dsh --source dsh --lines 80
```

这些命令的具体目标名、`agent wait` 过滤条件和 Herdr 版本兼容性应以实际安装版本的 `herdr --help` 与 agent automation 文档为准。报告器测试不应把 `herdr agent wait` 当作 DSH 内部正确性的替代；它只证明外部状态投影可见。

### Web profile 的单独验证

如果目标是 `dsh web`，测试必须覆盖 server-level 与 browser-session-level 两个不同问题：

1. 启动 Web server 后，Herdr 是否只显示一个 `dsh web` host reporter；
2. 创建两个浏览器 Session 时，聚合状态是否稳定且不会互相覆盖；
3. 一个 Session dispose 是否不会释放整个 Web server pane；
4. 浏览器断线、重连和多 tab 是否改变 Agent ownership；
5. Herdr resume 是否能重新启动 server，还是能恢复某个 browser Session；
6. browser 环境是否完全没有继承 `HERDR_SOCKET_PATH` 等本机能力。

如果第 5 点没有明确答案，报告只能声称“Web host 可被 Herdr 观察”，不能声称“Herdr 可以恢复浏览器中的 DSH Agent”。

### 证据和故障注入

建议用 fake Herdr executable 或 fake Unix socket 记录完整请求，覆盖：

- report 调用顺序；
- `source`、`agent`、`state`、`seq` 和 session fields；
- send failure、timeout、非零退出码；
- 状态快速变化时 latest-wins 行为；
- release 与 pending report 的竞态；
- Herdr 重启后序列号和 resume report；
- child Agent 创建/销毁；
- DSH profile teardown 中 Herdr reporter 的 disposer 顺序。

真实 Herdr E2E 再验证 pane state、`agent list`、`agent wait` 和 pane release；不要只靠单元测试模拟 Herdr。

## 实施路线与退出条件

### Phase 0：确认运行模式和 ownership

**范围：** 决定第一阶段是终端型自定义 profile、headless wrapper，还是 Web server aggregate；明确一个 pane 对应什么对象。

**退出条件：** 文档和测试都能回答“谁拥有 Agent、谁拥有 pane、谁发送 release、谁负责 resume”；没有把 browser Session 和 server process 混为一谈。

### Phase 1：最小 native reporter

**范围：** 只处理一个 root Agent；监听 `agent/created`、`agent/status`、`agent/disposed`；CLI best-effort report；不实现 blocked、retry 或 resume argv。

**退出条件：** 在 Herdr pane 内外都通过测试；状态按序可见；Herdr 不可用时 DSH 行为不变；child Agent 不会误释放 root pane；工作区外没有不必要的 DSH core 修改。

### Phase 2：会话引用与 resume

**范围：** 选定稳定 session identity；使用 `agent_session_id` 或 `agent_session_path`；只有已验证的 CLI resume 入口才写 `resume_argv`。

**退出条件：** Herdr 重启后能恢复同一个支持的 DSH process/profile；非法 argv 被测试拒绝；没有 secret 进入 resume command；旧 Herdr 版本至少继续显示状态和 release。

### Phase 3：网络恢复与 watchdog

**范围：** 独立实现 DSH `agent/request-error` retry policy；Herdr 仅显示外部状态和超时诊断。

**退出条件：** retry 次数有限、取消优先、失败不会重复副作用；Herdr report 失败不改变 retry 结果；真实网络故障和模拟故障的恢复路径分别有测试。

### Phase 4：blocked 和多 Agent

**范围：** 只在存在稳定 approval/question projection 后实现 blocked；决定多 Agent 是多 pane、aggregate 还是 Web bridge。

**退出条件：** blocked 的进入、回答、取消、继续、dispose 和重启均有对应状态迁移；每个 Herdr pane 的记录都有明确 owner；聚合状态不冒充逐 Agent 状态。

## 限制与未决问题

### 当前不能直接承诺的能力

- 不能仅凭 `pnpm dsh` launcher 声称 DSH 已经提供 Codex CLI 式 TUI。
- 不能仅凭一个 `ctx.on('agent/status')` plugin 声称能管理 `dsh web` 中的每个浏览器 Agent。
- 不能把 DSH 的 `idle` 直接解释为 Herdr 的 `done` 或 `blocked`。
- 不能把 Herdr `pane send-keys` 作为所有 DSH profile 的通用 follow-up API。
- 不能把 `AgentHandle.resume()` 自动解释成 Herdr 可执行的 `resume_argv`。
- 不能让 Herdr report failure 阻塞 DSH Agent Loop。

### 需要后续源码核验的问题

1. 终端型 TUI profile 的具体实现是否已经存在于另一个插件 checkout 或私有 profile；如果存在，应以该 profile 的输入、输出和 resume contract 为准。
2. Web profile 创建 root Agent 的边界、同一 server 中的并发 Agent 数量和 server teardown 语义；这决定 host-level aggregate 是否可行。
3. `user-approval` 和 `user-questions` 在目标 profile 中是否都有可观察的 pending projection，以及是否存在可用的全局/agent-scoped 事件。
4. Herdr 安装版本是否支持当前 `pane report-agent-session` 字段和 resume restore；若要发布插件，需要定义最低 Herdr 版本。
5. DSH 是否需要增加稳定的终端 profile resume 命令；若需要，这属于 DSH CLI 外部可见接口，应单独更新 CLI 文档、测试和升级记录。

## 结论

对“DSH 是不是有 CLI 版本、是不是像 Codex CLI 那样的交互式 UI”最准确的回答是：**DSH 有 CLI launcher 和多种 CLI profile，但当前仓库本身没有被证实的内置 Codex CLI 式 TUI；Web UI 是一个独立的浏览器入口，headless/SDK/ACP 也不是 TUI。** 自定义 profile 可以提供交互式终端 UI，但那是 profile app 的职责，不是 launcher 自动提供的能力。

对“如何让 Herdr 感知 DSH Agent 状态”最准确的回答是：**对于单进程、单 root Agent 的终端型 DSH profile，做一个很小的原生 Cordis reporter 插件是正确方向；它监听 DSH 已有生命周期事件，并通过 Herdr self-report API 投影 `idle/running`。** `dsh-hooks-codex` 的职责不同，不应承担这个集成。

但若目标是 `dsh web`，需要先承认对象不同：Herdr 管理的是 pane 中的 Web server 进程，而浏览器中可能有多个 DSH Session/Agent。要做到逐 Agent 状态感知，必须新增明确的 browser-session identity bridge 和恢复协议；在此之前只能把 reporter 定义为 Web host aggregate，不能把它宣传成逐浏览器 Agent 管理。

推荐的最小可行路径是：

```text
一个真实 TUI/custom profile
        ↓
一个 Herdr pane
        ↓
一个 DSH root Agent
        ↓
native Cordis reporter
        ↓
Herdr report-agent / release-agent
```

验证该闭环后，再决定是否需要 `blocked`、resume、网络 watchdog、多 Agent 聚合和 Web bridge。这样可以让 DSH 的 Agent Loop、Session 和 retry 语义继续由 DSH 自己拥有，而让 Herdr 专注于 pane 管理、状态观察、通知和外部自动化。

## Further Exploration

- [DSH CLI README](../../apps/cli/README.md) — launcher、profile、app 参数转交和当前入口模式。
- [DSH CLI argument parser](../../apps/cli/src/args.ts) — launcher 自己拥有的参数和 `tui` 示例的实际含义。
- [DSH Agent README](../../packages/core/agent/README.md) — Agent registry、AgentHandle 和 `agent/*` 事件概览。
- [DSH Agent runtime types](../../packages/core/agent/src/runtime-types.ts) — `AgentStatus`、lifecycle event 和 `agent/request-error` 的精确声明。
- [DSH Agent Loop README](../../packages/core/agent-loop/README.md) — whole-agent status、turn、step 和请求恢复语义。
- [DSH user approval README](../../packages/interaction/user-approval/README.md) — approval request 的服务边界和 fail-closed 语义。
- [DSH user questions README](../../packages/interaction/user-questions/README.md) — UI-backed question projection、continued question 和 answer 生命周期。
- Herdr 本地文档：`/Users/yangjiefeng/Documents/herdrdev/herdr/docs/preview/website/src/content/docs/add-herdr-support.mdx`。
- Herdr 本地 Socket API 文档：`/Users/yangjiefeng/Documents/herdrdev/herdr/docs/preview/website/src/content/docs/socket-api.mdx`。
- Herdr self-report schema：`/Users/yangjiefeng/Documents/herdrdev/herdr/src/api/schema/panes.rs`。
- Herdr self-report handlers：`/Users/yangjiefeng/Documents/herdrdev/herdr/src/app/api/panes.rs`。
- Herdr integration tests：`/Users/yangjiefeng/Documents/herdrdev/herdr/src/integration/assets/herdr-agent-state.test.ts` 和 `src/server/headless/tests/mod.rs`。

## Dev Note

本报告是 `docs/drafts` 下的研究稿，不新增 DSH runtime、CLI 或 Herdr 代码。所有关于 DSH 当前行为的操作性结论均来自当前 checkout 的源码、README、测试与本次执行的 `pnpm dsh --help`、`pnpm dsh web --help`、`pnpm dsh headless --help`；所有关于 Herdr self-report 的结论均来自本地 Herdr 文档、schema、handler 和测试。报告没有把本地 Herdr checkout 的实现承诺为 DSH 已有能力，也没有把设计建议表述成已实现功能。

