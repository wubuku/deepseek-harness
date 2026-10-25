---
description: "规划 Browser-Native DSH 的上下文压缩、工具结果裁剪、长 Session 恢复和真实模型持续对话验证。"
---

# Browser-Native DSH 长会话可持续性验证计划

## 目标

Browser-Native DSH 已验证 Worker、VFS、Workspace 和短 Session 的多类恢复路径，但当前 profile 覆盖了标准 preset 的插件列表，没有挂载 Web 标准 preset 使用的 compaction 组。因此当前 Browser profile 没有自动上下文压缩、`/compact` 或工具结果修剪；不能把 Web bundle 中存在这些 package 当作 Browser Host 已启用。另一个实际缺口是 Browser LLM adapter 把所有路由的 `contextWindow` 固定报告为 128,000，而真实容量由 backend 选择的模型决定。当前 24 轮测试只有 202 个 Session 事件；它没有检验模型上下文是否会被裁剪、压缩事件能否恢复，或全量日志冷 hydrate 随会话增长的成本。

本批将 Web 标准 preset 的 compaction 组接入 Browser-native profile，继续由 DSH `token-meter`、`compaction-basic`、tool-result pruner 和 Session checkpoint policy 执行，不自制第二套 compaction 或模型历史。backend 只向 Worker 提供显式配置的非敏感模型 context window；未配置时不猜测容量。通过 validation overlay 和真实 Chrome Worker 触发压力压缩与上下文溢出恢复，使用模型无关故障验证失败收束，再用真实 LLM 验证摘要与刷新后的 sentinel 回忆。所有浏览器证据限定为当前 checkout 的真实 Chrome、Dedicated Worker、DSH Host 和同源 PoC backend。

## 候选范围与取舍

| 候选方向 | 价值 | 本批决定 | 判断依据 |
|---|---:|---|---|
| 默认 Browser profile 是否实际装载 compaction、`/compact` 和工具结果 pruner | P0 | 纳入 M1 | Web 标准 preset 有独立 compaction group；Browser profile 替换标准插件列表时遗漏该 group，造成当前能力缺失。 |
| Browser LLM adapter 是否向 DSH 提供真实而非固定猜测的模型窗口 | P0 | 纳入 M1 | `compaction-basic` 的压力预算依赖 adapter 的 `contextWindow`；backend 已经选择真实模型，Worker 当前却固定收到 128,000。 |
| 工具结果裁剪后自动摘要、Session 事件完整保留且刷新恢复 | P0 | 纳入 M2 | 文件工具可产生较大结果；压缩必须减少模型后续上下文，但不能删掉权威 Session 历史。 |
| 摘要失败、取消和压缩结束事件暂时 append 失败 | P0 | 纳入 M3 | `compaction/start`、摘要、replacement、`compaction/end` 有明确恢复语义；Browser remote append 是异步路径，现有 attempt append 503 不覆盖 compaction settlement。 |
| 真实 LLM 压缩并跨刷新回忆精确事实 | P0 | 纳入 M4 | scripted 模型只能验证协议和时序；真实模型才验证 backend 代理、摘要提示、模型上下文和恢复后的记忆闭环。 |
| 64 轮 Session 冷 hydrate、实际传输字节和压缩后日志大小 | P1 | 纳入 M4 | 现有脚本已支持最多 64 轮，但只记录 24 轮的 hydrate 时间和事件数；需量化完整 event log 仍会被读取且 compaction 不会缩小权威日志。 |
| Session 分页、Projection cache 或事件日志分段 | P1 | 延后 | DSH Session 恢复需要保持完整事实与投影语义；要先测实际长日志成本和确认压缩没有降低 durable log 体积，不能只因全量读取而改协议。 |
| Browser 本地 Session outbox、跨设备恢复、租户权限和多 backend HA | P1 | 延后 | 需要独立的身份、冲突、幂等及共享存储协议；当前验证只针对同源 PoC backend 的单 Session writer。 |
| Browser 端 Session durable outbox / 离线续传 | P1 | 延后 | 需要定义本地 outbox 与服务器权威 seq、身份恢复、重复 append、配额和跨设备结算；不能将 Workspace outbox 直接复用为 Session 真相。 |
| 自然 eviction、OS/磁盘崩溃、Safari、移动浏览器 | P1 | 排除 | 当前环境与既有约束不支持把定向故障注入等同这些平台故障；Chrome 之外另做支持矩阵。 |
| 多租户授权、跨设备 merge、生产数据库/对象存储 HA | P1 | 排除 | 需要真实 SaaS 身份、权限和存储事务合同，不由当前单机 PoC 的 Session/Workspace backend 代替。 |
| Shell/WASI、LSP、插件兼容扩展 | P2 | 排除 | 不回答长 Session 与模型上下文能否持续工作，且已有独立 capability/文件工具验证路线。 |

## 验证交付

### M1：Browser profile compaction 组合和模型容量

- 把 Web standard preset 的 `compaction` cordis group 加入 Browser profile，并将 `compaction-basic`、`command-compact`、`tool-result-pruner` 纳入 Browser capability manifest；保持其余工具 roster 不变。
- v2 backend 的只读 config endpoint 可选择返回显式配置的正整数 `contextWindow`，绝不返回 key、base URL 或请求 header；Worker adapter 缓存并验证该值，未配置时省略模型 context metadata，不再静态声称 128,000。
- 对 backend contract、profile manifest 和真实 Worker 组合分别测试；validation profile 可显式设置低 context window、低 headroom 和小型 pruner 预算，生产 Browser profile 不接受测试阈值。
- 观察 DSH `compaction/*` 事件、prune replacement 和工具 schema；仅有插件加载或 slash command 出现不算自动 compaction 通过。

### M2：大工具结果、压力压缩与冷恢复

- scripted LLM 在真实 DSH Agent Loop 中调用 `read` 获取明显大于 validation pruner 预算的文件；通过配置窗口触发自动 pressure 路径，并单独注入一次 provider context-overflow 验证错误恢复路径。
- 观察原始 `tool/result` 事件仍完整；DSH 记录 `compaction/prune`、replacement、`compaction/start`、`compaction/summary`、`compaction/end`，且所有来源 seq 有效。
- 确认摘要之后的正常模型请求只含 DSH 当前 surface 中的 replacement/summary，不再含未裁剪的大工具结果；Session backend 仍可读取原始结果和全部 append-only 事件。
- 刷新同一 Session 后检查既有事件前缀不变、不会因 hydrate 重复 summary/LLM 请求，随后同一 Session 的新 turn 能继续。

### M3：摘要和 Session append 故障收束

- 摘要流在部分文本后失败时，DSH 记录带 error 的 `compaction/end`；不得记录成功 summary/replacement，已有 prune replacement 的情况下也必须按 DSH recovery 语义结算，不把它冒充完整摘要。
- 对 `compaction/end` 的一次 Session append 注入 503，确认 remote writer 重试后 durable log 中 opening/summary/replacement/closing 事件各自只出现一次、`durableThroughSeq` 连续。
- 每个失败场景刷新 Session 并明确检查 terminal turn、压缩锁状态和可继续的新 turn；检查模型调用数、工具调用数和 Workspace revision，防止恢复路径重放副作用。
- 同时记录模型调用数、工具调用数、Workspace revision、Session event seq 和页面错误，确保失败场景无重复业务副作用。

### M4：真实 LLM 和记忆闭环与较长 Session 诊断

- 真实模型对包含唯一 sentinel 的会话执行若干轮真实问答和 `/compact`；刷新同一 Session 后询问 sentinel，并核对真实模型请求包含 landed summary 而非被 shadow 的原始历史范围。
- 只从 backend 读取本机 `docs/drafts/.env`；真实模型和 context window 配置均留在 backend，测试输出不记录密钥、完整 prompt 或完整摘要。
- 将现有长 Session Chrome E2E 运行到 64 轮，记录 turn/event 数、全量 Session JSON 字节、落盘文件字节、刷新时读取字节和耗时；另记录一次压缩前后 durable log 的大小对比。
- 这些数据只用于揭示全量 hydrate 的单机成本，不构成性能 SLA，也不用于宣称 compaction 会缩小持久化 Session。

## 验收与限制

| 交付面 | 通过条件 | 不等价于 |
|---|---|---|
| Browser 组合 | 默认 Browser profile 的 compaction group、`/compact` 和 pruner 与真实 Worker 运行；context window 仅来自 backend 显式配置 | 未配置容量时自动压力阈值可正确识别真实模型 |
| 自动压缩 | 原 tool result 仍在 append-only log；后续模型请求使用 DSH replacement/summary；refresh 后同一历史可恢复 | durable event log 变小、任意长度 Session 均可接受 |
| 故障收束 | 失败压缩有明确 end error；单次 append 503 重试不重复或伪造 replacement | 永久 backend outage、有本地 Session outbox 或跨存储事务 |
| 真实模型 | Chrome 真实 LLM 完成压缩、刷新和 sentinel 回忆；密钥只留在 backend | 所有 provider/model 的摘要质量、精确 token 计费或 SLA |
| 64 轮诊断 | 记录事件量、Session 字节、hydrate 传输字节和时间，以及压缩前后 durable log 大小 | 生产负载、长期增长上限或已实现分页读取 |

若真实模型凭据不可用或上游超时，本批不得把 scripted 证据写成真实 LLM 通过；其余可独立完成的 Chrome 故障验证仍照常执行，并明确真实模型项未完成。若 64 轮或压缩用例发现性能退化，只记录数据与后续分页/Projection 设计问题，不在本批重写 Session format 或改动正式 DSH packages。

## 实施顺序

1. 更新 Browser profile 与 capability manifest；为 backend/provider 增加经过校验的 context-window 和 auxiliary `purpose` 元数据传输，并覆盖无配置时不猜测容量。
2. 扩展 runtime validation overlay 和 Chrome Worker E2E，覆盖自动压力压缩、context-overflow recovery、大工具结果 pruner、Session replay 和 refresh。
3. 增加摘要流失败及 `compaction/end` append 503 故障 E2E，核对 DSH recovery 状态与无重复副作用。
4. 扩展 64 轮 hydrate 诊断并增加真实 LLM Chrome sentinel 闭环；真实模型只运行配置好的同源 backend proxy。
5. 更新 Browser-Native README、兼容矩阵、`docs/drafts/README.md` 与 `change-ledger.md`；运行 focused tests、preview build、Chrome E2E、真实 LLM E2E、文档门禁和推送前检查。

## 明确不在本批范围

本批不改正式 DSH compaction、Session 或 Agent Loop package，不新增 Session format、分页协议、本地 durable Session outbox、真实云租户授权或多实例服务。PoC backend 只转发由运营者显式配置的 context window；不会从模型名称猜容量。Safari/WebKit 暂停，不把浏览器关闭描述为后台 Agent，也不把单机计时写成生产 SLA。

## 当前 checkout 的实际结果

本计划已在真实 Chrome、Dedicated Worker、DSH Host 和同源 PoC backend 上执行。默认 Browser profile 的 scripted 回归通过 `/compact`；压力、context overflow、摘要失败和一次 `compaction/end` append 503 的故障场景均可刷新后继续。真实 `gpt-5.6-sol` 在显式 `contextWindow=32768` 下生成摘要，刷新后仍能回忆唯一 sentinel。64 轮 scripted Session 刷新前有 522 个事件、落盘 142,006 bytes，hydrate 读取 284,184 bytes，耗时 1,885 ms，刷新没有重放 LLM 请求。

这些结果证明当前 PoC 的 compaction 组合和恢复时序可运行，不证明所有模型的摘要质量、生产性能、分页读取、Session 本地 outbox、自然 eviction、OS crash、Safari 或多实例 backend。详细命令和结果见[进度记录](next-session-sustainability-validation-progress.md)。
