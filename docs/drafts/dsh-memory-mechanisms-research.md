---
description: "对默认 DSH 组合中模型可见历史、Session surface、工具结果保留、图片卸载、压缩、运行时上下文和跨会话引用的实现核查；数字、事件和失败语义均以当前源码为准。"
---

# 默认模式下 DSH 的“记忆”机制：从事件日志到请求预算

## Summary

DSH 没有一个把信息写入向量库、再按相似度召回的通用长期记忆服务。当前实现把“记住什么”拆成三件可回放的事情：Session 事件日志保存事实，surface 投影决定哪些消息仍在当前模型历史中，token meter 和各个策略插件决定这些消息如何适应路由预算。

本文以仓库当前的 `dsh` base 组合为默认观察对象：它挂载 `dsh-compaction-basic`、`dsh-token-meter`、`dsh-spill-policy`（`maxInlineTokens: 12500`）、`dsh-compaction-tool-result-pruner`（8192/4096/1024）和 `dsh-compaction-image-offload`。SDK minimal、Web preset 等其他 profile 会改变这些行的组合，不能把本文的“默认”数字外推到所有 profile。

实现核查得到以下结论：

- `Session` 是只追加的事件日志；`surface` 是从日志折叠出来的有序、可替换的模型历史。`deriveMessages()` 读取当前 surface 的全部节点，没有按最近 N 轮或 offset/limit 截断的通用窗口。
- 模型请求由日志中的 surface 消息、当前 `request/header`、工具历史以及请求时解析的路由能力共同构成。模型可见内容必须可以从日志和已注册的投影定义重建，但日志事件并不都进入模型历史。
- 工具结果溢出、工具结果剪裁、图片卸载和会话压缩是四种不同触发点的预算治理机制，不是严格串行的“四级阀门”。溢出策略在工具结果接受时运行；剪裁只在压缩策略已经因压力或溢出被调用后运行；图片卸载由 provider 的图片预算错误触发；压缩由步边界压力、上下文溢出或手动命令触发。
- 压缩不是删除日志。它追加 `compaction/start`、成功时的 `compaction/summary`、一个携带 `surfaceOp: replace` 的摘要 `user/message`，最后追加 `compaction/end`；旧事件保留，当前 surface 用摘要节点替代被遮蔽区间。
- 预算数字是路由相关的估算。token meter 在有可用且足够保守的 provider usage 锚点时使用锚点加 surface 的有符号变化，否则使用字符密度和结构开销估算；图片在声明了图片计价的路由上按路由价格计算。
- 技能目录、`AGENTS.md`、运行时上下文、Session reference 和子 Agent 都能把信息带进模型，但它们的持久化、边界和隔离方式不同。它们不能统称为共享记忆。

## Table of Contents

- [核查范围与证据](#核查范围与证据)
- [一、模型请求的事实源](#一模型请求的事实源)
- [二、surface 如何决定当前历史](#二surface-如何决定当前历史)
- [三、没有通用滑动窗口，但存在显式有界投影](#三没有通用滑动窗口但存在显式有界投影)
- [四、一次请求如何装配](#四一次请求如何装配)
- [五、四种预算治理机制](#五四种预算治理机制)
- [六、压缩策略的阈值、选区与事务](#六压缩策略的阈值选区与事务)
- [七、token meter 为什么是估算](#七token-meter-为什么是估算)
- [八、相邻机制的真实边界](#八相邻机制的真实边界)
- [九、如何从日志核对一次会话](#九如何从日志核对一次会话)
- [十、引入跨会话长期记忆需要补什么](#十引入跨会话长期记忆需要补什么)
- [核查后的常见误读](#核查后的常见误读)
- [证据索引](#证据索引)

## 核查范围与证据

本文是对当前 checkout 的实现核查，不把旧报告、配置名称或 package 目录名当作行为证据。没有使用外部资料来推断运行时语义；外部 provider 的实际上限仍以 provider 返回的错误和 usage 为准。

核心证据包括 [`Session.deriveMessages()`](../../packages/core/session/src/index.ts)、[`surface.ts`](../../packages/core/session/src/surface.ts)、[`agent.ts`](../../packages/core/agent-loop/src/agent.ts)、[`compaction-basic/config.ts`](../../packages/compaction/compaction-basic/src/config.ts)、[`compaction-basic/index.ts`](../../packages/compaction/compaction-basic/src/index.ts)、[`compaction-basic/region.ts`](../../packages/compaction/compaction-basic/src/region.ts)、[`spill-policy`](../../packages/spill/spill-policy/src/index.ts)、[`tool-result-pruner`](../../packages/compaction/compaction-tool-result-pruner/src/index.ts)、[`image-offload`](../../packages/compaction/compaction-image-offload/src/index.ts) 和 [`token-meter`](../../packages/llm/token-meter/src/index.ts)。对应的子系统合同见 [`session.md`](../subsystems/session.md)、[`compaction.md`](../subsystems/compaction.md)、[`token-meter.md`](../subsystems/token-meter.md) 与 [`spill.md`](../subsystems/spill.md)。

数字只在它们是当前源码或 base patch 的默认值时使用。某个值来自 profile 配置、adapter model catalog 或 provider 返回值时，本文会明确标出来源，不把它写成 DSH 全局常量。

## 一、模型请求的事实源

### Session 日志保存什么

`Session` 在进程内维护连续的 `SessionEvent` 日志。事件追加后不可就地改写；持久化由 `SessionPersistence` 等插件负责。`turn/*`、`step/*`、`request/header`、`request/context`、`assistant/attempt`、`llm/retry*` 等事件可以只用于边界、审计和恢复，不会自动成为模型消息。

五类带 surface 标记的事件可以产生模型历史：`system/message`、`developer/message`、`user/message`、`assistant/message` 和 `tool/result`。`assistant/attempt` 保存失败、取消或流错误的结算信息，但不增加模型历史；已结算的 `assistant/message` 保存模型消息和紧凑流记录，便于回放。

“模型可见等于已记录”是可重建性约束，不是“日志等于上下文”。当前请求还会读取 `request/header` 中的规范化工具定义和 `Session.toolHistory()` 中的工具变更历史；这些信息有各自的日志来源。运行时投影或插件定义必须在 detached replay 中可用，否则带该投影的历史不能安全派生。

### 日志事实与模型历史的分层

可以把一次模型请求的可重建输入写成：

```text
logged Session events
  ├─ current surface → messages
  ├─ latest request/header → route config + current tool schemas
  ├─ tool-history fold → historical tool additions/removals
  └─ registered message projections → projected message content
```

这里的 `messages` 是 `Session.deriveMessages()` 的返回值；工具 schema 位于请求 envelope，而不是被隐式拼进普通消息。某个事件可以被日志查询、UI 或 telemetry 使用，却仍然不进入模型历史。

## 二、surface 如何决定当前历史

surface 是按事件顺序折叠的当前消息节点列表。普通消息事件以 `surfaceOp: 'append'` 进入尾部；替换事件以 `{ op: 'replace', startSeq, endSeq }` 取代当前 surface 中的一段节点。替换只改变当前投影，原始事件仍在日志里。

`deriveMessages()` 遍历当前 surface 节点并调用 `deriveEventMessage()`。空内容的 system、developer 和 assistant 节点保留其事件语义，但不产生 wire message；插件拥有的 message projection 可以改变已有节点的派生内容，却不必改变节点成员关系。图片卸载属于这种“内容投影”：`image/offload` 没有 `surfaceOp`，它让同一消息中的指定图片在派生时变成占位文本。

surface 顺序是位置顺序，不是 seq 数字排序。一次 replace 会在旧位置放入新事件，因此新摘要节点的 seq 可能大于它后面的节点。任何选区、token 定价或回放代码都必须使用 surface 位置和 `shadowedSeqs`，不能把 `{ startSeq, endSeq }` 当作连续数值区间。

压缩和工具结果剪裁都使用 replace，但粒度不同：压缩可以替换多条平衡的消息节点，工具结果剪裁只允许替换一个当前 `tool/result` 节点。两者都追加新事件，不能把它们描述成“修改原消息”。

## 三、没有通用滑动窗口，但存在显式有界投影

当前 Session 派生没有按最近 N 条、最近 N 轮或 token offset/limit 截断的通用窗口。`deriveMessages()` 的参数只有 Session 自身，缓存按 surface 尾部增长；replace 或 message projection 发生时才重建受影响的派生缓存。因此，在没有显式 replace 或内容投影时，当前 surface 的所有消息都会进入下一次请求。

这不等于所有上下文都无限增长。工具结果可以在进入日志前由 spill policy 变成预览，工具结果 pruner 可以之后追加 replacement，压缩可以把一段历史换成摘要，Session reference 可以为被引用会话生成有界快照，技能和 `AGENTS.md` 也有自己的预算。它们是有名字、有事件或有输入边界的显式机制，不是隐藏的全局滑动窗口。

provider 仍然可能拒绝超出上下文的请求。`compaction-basic` 通过 `CONTEXT_WINDOW_EXCEEDED_CODE` 的 `agent/request-error` 恢复路径处理这种事实错误；如果没有可替换的平衡区间、没有取得压缩进展，或达到溢出重试上限，原始错误会继续向下游传播。

## 四、一次请求如何装配

请求装配不是一次函数调用，而是 agent-loop 在一个 step 中完成的多阶段提交：

1. `agent/pre-step` 先让 inbox、系统提示组装器、技能目录、workspace instructions 和其他 context provider 提议本步要进入的消息；`dsh-compaction-basic` 的压力监听器也在这个 waterfall 上运行。
2. `prepareRequest()` 解析当前 provider/model、继承或清理 adapter defaults，并调用 `llm.prepareCall()` 得到路由能力，例如 `contextWindow`、system prompt 更新方式和工具更新能力。
3. 系统提示投影提交 `system/message`；本步进入的直接用户消息、技能正文、workspace instructions 和运行时上下文提交为独立的 `user/message`。首个请求或 prompt/route 变化会追加或替换 system 节点，不能假定系统提示永远只有一个不可变字符串。
4. `buildRequest()` 持久化变化的 `request/header` 和 `request/context`。`request/header` 保存规范化 route config、adapter defaults 和当前工具 schema；`request/context` 保存 provider/model 以及 adapter 提供的 context window 和 system prompt update 元数据。它们是审计事实，不是 provider 的实际 usage 回报。
5. 最后调用 `deriveMessages()`、`toolHistory()`，冻结当前消息数组，组装 `messages`、工具历史和当前工具 schema，才把不可变 request 交给 adapter。发生在此前的取消不会提交对应的 system/user 输入。

因此，“一次请求带了哪些内容”应当同时检查 surface、request header、tool history 和投影定义；只看 `assistant/message` 或只看 UI transcript 都不完整。

## 五、四种预算治理机制

这四种机制没有固定的先后链路。它们的触发时点、是否保留完整内容、是否发送额外模型请求如下：

| 机制 | 触发点 | 当前请求看到的内容 | 日志/持久化语义 | 额外模型请求 |
| --- | --- | --- | --- | --- |
| 工具结果 spill | `tools/post-execute` 接受工具结果时，估算值超过 `maxInlineTokens` | 有序 head/tail、遗漏提示和 spill locator | 绑定后的结果直接作为后续 `tool/result` 内容；完整文本由 `ctx.spillStore` 保存，失败则保留原内容 | 无摘要调用；会有存储 I/O |
| 工具结果 pruner | compaction-basic 已因 `pressure` 或 `context-overflow` 运行，且挂载了 pruner | 头部、固定 marker、尾部；非文本块保持顺序 | `compaction/prune` 紧邻 replacement `tool/result`；原始事件仍在日志 | 无 |
| 图片卸载 | provider 返回 `IMAGE_OFFLOAD_REQUIRED` 并带 `offloadImages` 数量 | 指定旧图片变为带附件路径的占位文本 | 追加 `image/offload`；projection 改变派生内容，消息 seq 不变 | agent 会重发一次请求；该路径不记录 `llm/retry`，但并非“没有模型请求” |
| 会话压缩 | 步边界压力、上下文溢出恢复或手动 `compact` | 摘要 user message 替换一段旧 surface | `compaction/start` → 成功时 `compaction/summary` + replacement → `compaction/end` | 默认 summarizer 使用一次独立 `ctx.llm.stream()`；仍可能因 recovery 再试 |

### 5.1 工具结果 spill：在日志进入 surface 前做保留

base profile 将 `maxInlineTokens` 配为 12500。spill policy 只处理它能识别的 text/image 结果；结果在预算内、`read`、被阻止的决定、已有 value replacement 或包含不支持 block 的结果会保持原样。图片需要当前路由的图片计价器和 execution-readable attachment path。

成功 spill 时，完整文本和图片位置说明写入 spill store；模型得到按原顺序保留的片段、遗漏字节/图片数量和读取提示。保存失败、路由图片计价失败或路径不可读时，插件记录 warning 并保留 inline 内容，因此“超过 12500 就必然移出上下文”不是可靠断言。

spill policy 改的是工具结果被接受时的内容，不是对既有 surface 节点追加一次 replace。这个区别决定了日志里通常只会看到已经绑定的 `tool/result`；完整值是否可恢复取决于 spill backend 的生命周期和 locator。

### 5.2 工具结果 pruner：压缩前的确定性 replacement

base profile 的 pruner 默认按 Unicode code point 计数：`thresholdChars = 8192`，保留 `headChars = 4096` 和 `tailChars = 1024`，中间插入 `\n\n[... tool result middle pruned ...]\n\n`。这些是字符预算，不是 token 预算；token meter 重新定价后才决定是否还需要摘要。

它只在 compaction-basic 已被调用后运行。压力路径先检查 route-priced `totalTokens` 是否达到阈值，达到后执行 pruner 并重新测量；剪裁后若压力已经低于阈值，则本轮不会发起摘要调用。溢出路径则先剪裁，并以 `retainTokens = 0` 选择一个平衡区间继续恢复。

每个 replacement 前追加一个 `compaction/prune` shadow-price 事件，随后同步追加带 `surfaceOp: replace` 的 `tool/result`。replacement 只能改变原 tool result 的 content，并通过 `sourceEventSeqs` 引用被遮蔽节点；原始完整结果仍可从日志审计和回放。

### 5.3 图片卸载：provider 错误驱动的持久内容投影

图片卸载插件不预先猜测图片预算。只有 provider 明确返回 `IMAGE_OFFLOAD_REQUIRED` 和需要卸载的数量时，它才按当前请求顺序选择最旧的输入图片，跳过 assistant 节点和已经标记的 occurrence，追加一个 `image/offload` 决策。

该事件没有 `surfaceOp`；Session projection 根据消息 seq 和深度优先 image index 把图片变成占位文本。agent/request-error 随后返回 retry，下一次请求携带占位符。这个 retry 不走普通 `llm/retry` 事件和 provider retry budget，但它确实会再发送一次模型请求；因此原稿中“图片卸载不产生模型调用”已修正为“图片卸载不产生摘要调用，修复本身会重发模型请求”。

压缩摘要失败时，插件还可以通过 `compaction/summary-error` 只对摘要选区记录新的图片卸载，再让 compaction-basic 重新派生和定价。已经记录的卸载即使摘要最终失败或取消也会保留。

## 六、压缩策略的阈值、选区与事务

### 6.1 路由相关的压力公式

对一次已经解析出 adapter model info 的路由，令：

- `W` 为 adapter 声明的 `contextWindow`；
- `O` 为当前 request envelope 的 `maxTokens`，没有显式值时使用 adapter default，没有 reservation 时为 0；
- `H` 为 compaction policy 的 `headroomTokens`，默认 65536；
- `r` 为 `thresholdRatio`，默认 0.8；
- `q` 为 `retainRatio`，默认 0.16。

压力阈值和保留量的实际计算是：

```text
messageBudget = W - O
pressureBudget = messageBudget - H
thresholdTokens = floor(min(W × r, pressureBudget))
retainTokens = floor(messageBudget × q)
```

源码允许用 `retainTokens` 替代 `retainRatio`，并拒绝非整数、负数、保留量不小于阈值或没有压力预算的配置。`maxTokens` 默认继承 `headroomTokens`，但它是摘要调用的 generation cap；不能把它简单等同为每个请求的 `O`。

压力触发比较的是 token meter 的 `totalTokens`。达到阈值后，compaction-basic 先运行可选 pruner，再测量；只有仍然达到阈值才选择摘要区间。`compactionRetries` 表示首次摘要之后压力仍超阈值时允许的额外摘要尝试，默认 1，不是 provider 的通用 retry 次数。

### 6.2 两种自动触发和一种手动触发

`pressure` 在 `agent/pre-step`、本步 request 尚未派生前运行。它解析当前 durable route，读取 context capacity，按公式决定是否压缩。

`context-overflow` 在 provider 已确认 `CONTEXT_WINDOW_EXCEEDED_CODE` 后运行。它先执行 pruner，然后以 `retainTokens = 0` 选择一个仍然平衡的区间；它不依赖正常压力阈值，目的是对已失败的请求做一次有用的减少。如果没有 surface replacement generation 的进展，恢复 listener 会继续原始错误；达到 `maxOverflowRetries`（默认 1）后也不再恢复。

手动 `compactNow()` 由 `/compact` 等 consumer 调用，要求 agent idle，可以在压力阈值以下选择有用区间，并在关闭 bracket 后 flush。它不是自动压力的别名，也不能在有活动 turn 或未结束的 compaction lock 时并行进入。

### 6.3 选区不是“最后 16% 的字符”

`selectCompactableRange()` 读取 token meter 的 surface nodes，从尾部累计 route-priced tokens，直到达到 `retainTokens`，然后向前调整到不拆分 assistant tool-call/result pair 的平衡边界。surface node 0 若是 system prompt，则永远不被自动摘要区间覆盖；系统头之外的旧 system 节点可以被选入区间。

自动压缩可以覆盖同一个大 turn 中已经闭合的早期 step，不保证按完整 turn 边界切分。摘要必须严格小于被遮蔽区间的 route-priced 估算，否则事务失败而不提交 replacement。

### 6.4 摘要输入和持久化事务

默认 summarizer 会重放最近请求的 system head、当前工具 schema 和被选 surface 区间，再追加固定的 compaction instruction 作为最后一个 user message，通过 `purpose: 'compaction'` 调用 `ctx.llm.stream()`。它不是只把“被遮蔽文本”直接丢给模型，也不是复用父请求的完整历史。

一次成功事务的日志顺序是：

```text
compaction/start       # 先取得日志锁
compaction/summary     # 摘要内容、选区、路由、usage/rawOutput（若适用）
user/message           # 带 compact checkpoint source 的 replace
compaction/end         # 最后释放锁
```

失败的摘要可能只有 `compaction/start` 和带 error 的 `compaction/end`，不一定存在 `compaction/summary`。进程在 bracket 中途退出会留下 unmatched `compaction/start`；下一次进入会把它视为活动锁并拒绝新的压缩，而不是自动续跑上次模型调用。较新的 `session/end-seed` 才能证明旧生命周期的 unmatched marker 已过期。

replace 只改变 surface 拓扑，旧 user/assistant/tool 事件仍在日志里。回放要使用同一 compaction event、surface fold 和已注册 projection，才能得到与原请求相同的当前历史。

## 七、token meter 为什么是估算

token meter 使用一次 session replay fold 得到当前 header、surface、step 状态和最近成功 assistant call 的 anchor。每次 `measure()` 都复制当前 positional nodes；它不是把一个固定 token 数永久累加在内存里。

没有可复用 usage anchor 时，文本采用固定密度近似（当前实现按约 4 字符/token，并加 block/role framing 开销），工具 schema 也按 JSON 长度估算。声明了图片 request pricing 的路由会把图片视觉 token 和发送给模型的 descriptor text 纳入 node price；没有路由计价时保留固定结构估算。

如果最新 assistant message 的 usage 与当前 canonical request header 匹配，且 usage 总量不低于同一请求 envelope 的完整启发式价格，meter 才把它作为 conservative usage baseline；surface 相对于 anchor 的增长或收缩以有符号 delta 加回。header 变化、usage 不足以覆盖估算或没有成功 assistant message 时，会退回完整 envelope + surface 的 estimated baseline。

因此 UI 的“上下文占用百分比”是压力趋势，不是 provider tokenizer 的精确余量。压缩、pruner、图片 projection 或 route/tool schema 变化会让测量跳变；接近上限时仍可能先收到 provider overflow，再进入恢复路径。

## 八、相邻机制的真实边界

### 技能目录与技能正文

`dsh-tool-skill` 把当前可供模型调用的技能发布为 durable catalog user message，目录条目只有名称和截短后的 description。模型调用 `skill` 工具后，完整正文以 tool result 进入后续请求；用户显式 `/name` 调用则把完整正文作为 `skill-invocation` user context 注入。技能不是“已经被模型永久记住”，正文也不是目录字段。

### `AGENTS.md` / `CLAUDE.md`

base profile 以 `maxBytes: 65536` 挂载 agent-instructions，但该预算是插件配置而非全局常量。加载器按 user-global、项目根到工作目录的 broad-to-specific 顺序收集候选；预算不足时先省略更宽范围文件，再截断最具体文件，并生成预算说明。

基线、嵌套目录更新和删除通知都是带 `agent-instructions` source 的 `user/message`，会进入 Session surface、参与压缩并在 resume 时重建。它们不是每轮自动覆写的隐式 system prompt；内容未变化时插件会抑制重复注入，外部文件变化也不会由常驻 watcher 自动变成模型消息。

### 运行时上下文

agent-loop 的 `RuntimeContextProjection` 保存最近一个 `runtime-context` user message 的可见值。当前值与上次不同才追加新的 snapshot；当前值为空时使用 `Current runtime context: none. Earlier runtime-context snapshots no longer apply.` 清除标记。若 replacement 遮蔽了旧 snapshot，projection 会失去 retained seq，下一次需要时可再次追加当前值。

运行时上下文并非“只在压缩之后变化才落日志”。它可能因工作目录、审批策略、时间、Harness 进程信息或其他 context provider 的变化在普通下一步追加；压缩只是会遮蔽旧 snapshot、使后续状态需要重新投影的一个场景。

### 跨会话引用

`session-reference` 读取目标会话当前 surface 的 detached snapshot，默认只挑选普通 user/assistant conversation，排除 system、developer、tool 结果和注入型上下文；每个来源按字节预算删消息或截断文本，并把 omission 统计和不可信背景标记写入新的 user message。引用是发起方显式请求生成的一次快照，目标会话后续追加不会自动流入当前会话。

这是一种有界、可审计的跨会话输入，不是共享 mutable context，也不是语义相似度召回。仓库另有 `session-query` 的显式读取工具，但没有内置 embedding/vector memory index。

### 子 Agent

子 Agent 总是拥有自己的 Agent/Session 生命周期，但上下文是否为空取决于 provider：spawn 类型的本地 child 从新 Session 开始；fork 类型可以用父会话已完成 turn 的前缀 seed child。两者都不是父子共享同一 surface。

父会话是否收到结果取决于 `delivery`：`parent` 会追加结算通知或工具结果使父模型看见，`caller` 只把结果返回给调用程序。子 Agent 的中间 tool traffic 留在 child session；“父只收到结论”适用于常见 parent-delivery 摘要，不适用于所有 fork seed、消息控制和显式跨会话查询场景。

## 九、如何从日志核对一次会话

建议按以下顺序核对，而不是只看 UI transcript：

1. 检查 `request/header`：确认当前 provider/model、`maxTokens`、工具 schema 是否发生了 change/series，以及工具数量变化是否来自真实 schema 变化。
2. 检查 `request/context`：确认 adapter 是否声明了 `contextWindow` 和 system prompt update 能力；这不是本次 provider usage。
3. 按 surface fold 查看当前 node seq 顺序，再用 `deriveMessages()` 确认 replacement 和 message projection 后的实际消息。
4. 检查 `tool/result` 是否已经由 spill policy 在首次接受时绑定了预览；检查 `compaction/prune` 后紧邻的 replacement，区分“初始保留”与“压缩前剪裁”。
5. 检查 `image/offload` 的 target seq 和 image index，确认占位符来自持久 projection，而不是 provider 临时忽略图片。
6. 检查 `compaction/start`、`compaction/summary`、摘要 replacement 和 `compaction/end` 的完整 bracket。只有看到成功 summary 和 replace，才能说本次确实完成了摘要压缩。
7. 检查 `assistant/attempt`、`assistant/message`、`llm/retry*` 和 `turn/end`，区分 provider 失败、普通 retry、图片卸载 retry、压缩 recovery 与最终 turn 结算。`agent/assistant-stream` 的 chunk 是进程内 live event，不是持久模型历史。

## 十、引入跨会话长期记忆需要补什么

当前仓库已经有 session 查询、显式 session reference、spill 和 durable projection，但没有一个默认的“提炼长期事实—按语义召回—注入当前请求”闭环。若增加该能力，至少需要明确以下四个角色：

1. **存储与索引。** 规定条目的 owner、生命周期、删除/更正和检索索引；embedding/vector 只是可选实现，不应取代权限和版本规则。
2. **写入策略。** 定义哪些 user/assistant/tool 事实可提炼、何时写入、如何处理模型猜测、冲突和撤销；压缩摘要不能自动等同于长期事实。
3. **模型可见事件。** 每个进入 request 的召回结果必须有可重建的 Session event 或 projection source，记录查询条件、候选版本和 omission，避免旁路注入造成不可回放的模型上下文。
4. **预算与安全。** 召回结果必须使用同一 token meter/route pricing 参与压力治理，明确不可信内容、租户/Session 授权、敏感字段和失败时的 fail-closed 行为。

更合适的扩展方式是增加一个完整 capability seam：服务定义声明检索和写入接口，provider 负责索引/存储，consumer 在 agent/pre-step 或显式 tool 中产生有来源的 durable context。直接在 `buildRequest()` 旁路拼接一段字符串会破坏“model-visible means logged”和 replay/compaction 的既有假设。

## 核查后的常见误读

| 误读 | 当前实现中的准确说法 |
| --- | --- |
| Session 就是数据库或快照 | Session 是内存中的事件日志；物理持久化是独立 provider，surface 和各种 projection 从事件折叠出来 |
| 存在最近 N 轮滑动窗口 | 通用 `deriveMessages()` 没有窗口参数；上下文缩小来自显式 replace、内容 projection 或有界输入机制 |
| 压缩等于删除历史 | 摘要 replacement 遮蔽当前 surface 区间，旧事件仍可审计和回放 |
| 四种减压按固定顺序执行 | spill、pruner、image offload 和 compaction 在不同生命周期触发，pruner 只在 compaction 调用后运行 |
| 图片卸载不产生模型请求 | 它不走 `llm/retry`，但 agent 会携带占位符重新发送请求；摘要 recovery 也可能重新调用 summarizer |
| `request/context` 就是精确 token usage | 它记录 route/capability 元数据；压力由 token meter 估算或 usage anchor 计算，provider usage 另在 assistant settlement/measurement 中体现 |
| runtime context 只在压缩后变化时记录 | 它在可见值改变时追加 durable user snapshot；压缩遮蔽旧 snapshot 后可能促成再次投影 |
| skill catalog 已包含技能全文 | catalog 只有 name/description；正文在 skill tool result 或显式 invocation user message 中出现 |
| 子 Agent 与父 Agent 共享记忆或永远只回传结论 | child 有自己的 Session；spawn/fork 的 seed 规则、parent/caller delivery 和显式消息决定实际可见内容 |
| 上下文百分比是精确余量 | meter 使用固定密度、结构开销、路由图片计价和有条件 usage anchor；临界时仍可能先收到 provider overflow |

## 证据索引

- Session 日志、surface fold、`deriveMessages()`：[`packages/core/session/src/index.ts`](../../packages/core/session/src/index.ts)、[`packages/core/session/src/surface.ts`](../../packages/core/session/src/surface.ts)、[`packages/core/session/README.md`](../../packages/core/session/README.md)。
- 请求提交顺序和 request/header/context：[`packages/core/agent-loop/src/agent.ts`](../../packages/core/agent-loop/src/agent.ts)。
- 压力公式、路由解析和 overflow/retry：[`packages/compaction/compaction-basic/src/config.ts`](../../packages/compaction/compaction-basic/src/config.ts)、[`packages/compaction/compaction-basic/src/index.ts`](../../packages/compaction/compaction-basic/src/index.ts)。
- 选区、摘要输入、summary replacement 和 lock bracket：[`packages/compaction/compaction-basic/src/region.ts`](../../packages/compaction/compaction-basic/src/region.ts)、[`packages/compaction/compaction/src/types.ts`](../../packages/compaction/compaction/src/types.ts)。
- spill、工具结果剪裁、图片投影：[`packages/spill/spill-policy/src/index.ts`](../../packages/spill/spill-policy/src/index.ts)、[`packages/compaction/compaction-tool-result-pruner/src/index.ts`](../../packages/compaction/compaction-tool-result-pruner/src/index.ts)、[`packages/compaction/compaction-image-offload/src/index.ts`](../../packages/compaction/compaction-image-offload/src/index.ts)。
- token pressure 与 route pricing：[`packages/llm/token-meter/src/index.ts`](../../packages/llm/token-meter/src/index.ts)、[`packages/llm/token-meter/src/estimate.ts`](../../packages/llm/token-meter/src/estimate.ts)、[`docs/subsystems/token-meter.md`](../subsystems/token-meter.md)。
- 技能、workspace instructions、Session reference、subagent：[`packages/skill/tool-skill/src/index.ts`](../../packages/skill/tool-skill/src/index.ts)、[`packages/context/agent-instructions/src/index.ts`](../../packages/context/agent-instructions/src/index.ts)、[`packages/context/session-reference/src/index.ts`](../../packages/context/session-reference/src/index.ts)、[`docs/subsystems/subagent.md`](../subsystems/subagent.md)。
- base profile 默认组合：[`packages/bundle/base/cordis.patch.yml`](../../packages/bundle/base/cordis.patch.yml)。

## Dev Note

本文是随当前 checkout 校正后的研究草稿。若未来新增 memory provider、改变 Session surface 事件、调整 compaction policy 或修改 base profile，应先更新对应 package contract 和测试，再重新核对本文中的数字、事件顺序与“默认模式”范围。
