---
description: "规划 Browser-Native DSH Session 远程写入的批量上限、未知结果对账、持续故障恢复和真实模型冒烟验证。"
---

# Browser-Native DSH Session 传输可靠性验证计划

## 目标

Browser provider 目前把 live Session events 放入 `pendingLive`，每个新事件都可能向串行写链加入一次 drain；一次 drain 会把整个 pending 数组作为一个 append 请求发送。backend 对每批事件数量和 JSON 字节数都有上限，因此长 turn、较大工具结果或短时断网可能让请求超限、积压重试，或使已提交但响应丢失的 append 进入不确定状态。本批验证并收敛这些远程写入语义，不改变 DSH Session event log 的权威性，不新增第二份 Session 历史。

目标是让 Chrome Dedicated Worker 中的远程写入满足：有界单批传输、同一 writer 单飞排空、失败时保留有序待写事件、flush/close 明确报告未确认状态；backend 已接收但响应丢失时，按 seq 读取并核对原事件，既不重复 append，也不把未知结果报成成功。测试通过后，再以真实 LLM 完成最小多轮工具调用冒烟，确认可靠性修改没有破坏实际 DSH turn。

## 事实与证据边界

- [Browser provider](browser-native-providers.ts) 当前 checkout 中的 `RemoteSessionHandle` 自行实现 Session handle；live event listener 同步入队，append、flush 和 close 经 `writeChain` 串行化。
- 当前 `pendingLive` 没有显式批次数量/字节上限；一次排空会把全部 pending events 放入一个 append 请求。每次 `enqueueLive()` 都会调用 `startLiveDrain()`，即使此前已有 drain 正在等待。
- 同一 provider 已有 `SEQ_CONFLICT` 后读取原 seq 范围并逐事件 JSON 比较的对账逻辑；本批须用“backend 已 append、HTTP 成功响应被丢弃”的真实 Worker 请求验证它，而不是把预写入 503 当作未知提交。
- [backend-v2.mjs](backend-v2.mjs) 当前 checkout 将单次 append 限制为最多 1,024 个事件及 1 MiB JSON events；这些是当前 PoC 协议限制，不是 DSH Session 格式限制。
- 正式 [JSONL Session provider](../../../packages/session/session-persistence-jsonl/src/storage.ts) 在 live write 失败后保留事件顺序、暂停自动 timer，并由显式 flush/close 再排空；该实现是行为参考，不代表 Browser provider 已继承同一语义。
- 之前的单次 `assistant/attempt` append 503 测试覆盖请求未提交时的故障，不覆盖已提交响应丢失、持续拒绝后的显式恢复或 append batch 超限。

## 候选范围与选择

| 验证方向 | 价值 | 本批决定 | 判断依据 |
|---|---:|---|---|
| append 已提交、响应丢失、重试遇到 `SEQ_CONFLICT` 后精确对账 | P0 | 纳入 | 这是最容易造成 Session 重复或假成功的未知结果路径；现有逻辑有实现但没有对应 Chrome Worker 证据。 |
| 依 backend 字节数/事件数上限切分 append batch | P0 | 纳入 | 当前 provider 把整个 pending 数组一次发送；backend 明确拒绝超限批次，失败会把同一超大数组留在队列中，后续 flush 无法推进。 |
| 单飞 drain、同一 writer 的事件合并、自动重试与显式 flush 恢复 | P0 | 纳入 | 当前每个事件可能向 `writeChain` 排队一个 drain；持续故障期间可能形成重复排空工作，恢复语义必须由真实 Writer 验证。 |
| `flush()` / `close()` 与 durable acknowledgement 的逐 seq 核对 | P0 | 纳入 | 用户可见 turn 不能仅凭 HTTP 成功推断 durable prefix；必须确认 flush 回执覆盖本地待写末尾 seq，且失败不被吞掉。 |
| Session 与 Workspace 工具 receipt 在 Session append 故障后的联合恢复 | P0 | 纳入定向测试 | 文件副作用可能已提交而 Session receipt 仍待写；需要确认 refresh 后恢复 receipt 不重放业务工具。 |
| 浏览器本地 durable Session outbox、离线继续和跨设备同步 | P1 | 延后 | 需要另行确定身份、IndexedDB journal、server seq 对账、配额与多设备 owner 协议；本批只保证 Worker 存活期间保留并明确报告 pending。 |
| 永久网络分区后的后台运行、页面关闭后继续写入 | P1 | 排除 | Dedicated Worker 受页面生命周期约束；本批不得宣称后台 Agent 或 Worker 终止后仍有内存队列。 |
| Session format、正式 Session packages 或 production backend 改造 | P1 | 排除 | 本批针对 PoC 的远程适配器与 backend fault harness，不改变正式包和持久化格式。 |

## 实施范围

### M1：远程 Session writer 的有界单飞排空

- 让 live event 入队只保留事件并启动/加入一个排空任务，不为每个事件额外排入 drain promise。
- 按 backend 的最大事件数和 UTF-8 JSON 字节数切分连续批次；单个事件超过请求预算时拒绝该 flush，保留事件并返回明确错误，不丢弃或截断事件。
- 每批成功后只推进到已确认的 next seq；失败时将未确认批次放回队首，后续事件仍保持原序。
- 自动重试使用有限次数；自动重试停止后，显式 `flush()` 和 `close()` 可再次排空，失败必须冒泡。
- append response 表示接收，不等同 durable；只有 flush 回执确认 `durableThroughSeq` 覆盖已提交前缀后，provider 才完成 durability barrier。

### M2：不确定 append、持续 503 和恢复 E2E

- backend test hook 在 Session append 已更新可见 event log 后丢弃 HTTP response；Chrome Worker 重试收到 `SEQ_CONFLICT`，读取原 seq 并确认事件完全相同。
- 在用户输入持久化时注入连续 append 503，确认 DSH 在发起模型请求前以错误收束，不伪造已接受的用户输入或成功 turn；刷新后显式提交新 turn，验证同一 Session 可继续。未确认的原输入不保证跨 Worker 恢复。
- 在 Session 有足够多事件时验证多批 append 都不超过 backend 的事件数/字节数上限，事件只出现一次且 seq 连续。
- 对单事件超预算路径检查明确失败、队列仍待处理、没有伪造 durable receipt；该事件不可被自动截断。

### M3：Workspace side effect 与 Session receipt 联合恢复

- 在已有真实 DSH `write` 工具闭环中注入 receipt/Session append 响应丢失或短时 503，记录 Workspace operation id、revision、Session event seq 和 receipt。
- 刷新后只查询/恢复原 Workspace operation receipt；不得再次调用写工具或产生第二个 revision。
- 区分 Workspace commit、Session append acknowledgement、Session flush durable receipt 三种确认，不把其中任一种代替另外两种。

### M4：真实模型冒烟与交付记录

- 使用同源 backend 从 `docs/drafts/.env` 读取凭据，在真实 Chrome Worker 中完成至少两轮真实模型对话，并至少一次调用 Browser Workspace 文件工具。
- 检查工具 call/result、Workspace revision 和 Session seq/flush；刷新同一 Session 后确认历史可读，后续一轮不重放旧 prompt 或副作用。
- 只记录模型名、轮数、工具次数、Session/Workspace 计数、耗时和脱敏错误；不打印凭据、完整 prompt 或模型响应原文。
- 若真实上游超时，保留实际失败证据并标记真实 LLM 冒烟未通过；scripted E2E 不能替代此项。

## 验收矩阵

| 交付面 | 必须观察 | 通过条件 | 不等价于 |
|---|---|---|---|
| Batch framing | 每个 append 的事件数、UTF-8 payload 字节、首末 seq | 所有可提交批次在 backend 限额内；单事件超限明确失败 | 任意大小的 Session event 都可存储 |
| Single-flight | append 同时数、drain 数、入队数、重试数 | 同一 writer 至多一个活动 drain；失败不为每个事件放大请求数 | 多标签页共享同一 write owner |
| Unknown append | 后端已接收但 response dropped、重试 conflict、readback 内容 | 原始事件逐项相同后认领成功；event count 和 seq 不重复 | 请求 id 提供服务端幂等记录 |
| Sustained outage | 503 次数、模型请求数、失败 turn、刷新与显式新 turn | 不持久化输入时不请求模型；turn 以错误收束；显式新 turn 可继续且不伪称原输入恢复 | Worker/page 关闭后内存 pending 可恢复，或原 prompt 自动重放 |
| Workspace receipt | operationId、revision、receipt count、tool invocation count | 刷新恢复同一 receipt，工具副作用恰一次 | Session 与 Workspace 跨存储原子事务 |
| Real LLM smoke | 真实模型请求、两轮交互、一次文件工具、刷新恢复 | 同域代理闭环通过，旧 turn 不重放，浏览器无凭据/外站请求 | 所有模型、生产 SLA 或自然网络故障分布 |

## 执行顺序

1. 先增加本计划和进度文件，固定候选范围、限额、失败判据及真实 LLM 冒烟要求。
2. 实现并测试 Browser `RemoteSessionHandle` 的单飞排空、限额切批、顺序保留和 durable receipt 校验；不修改正式 Session package。
3. 为 backend 增加仅供测试注入的“append commit 后断开响应”钩子，编写 backend contract test 与真实 Chrome Worker 故障 E2E。
4. 验证 503、恢复、Workspace receipt、刷新、重复调用计数和 durable seq；每个里程碑后更新进度记录。
5. 运行 Browser provider focused tests、backend tests、Chrome scripted E2E、真实 LLM Chrome smoke、预览构建、文档门禁及推送前检查。
6. 更新 PoC README、兼容矩阵、目录索引和 change ledger；确认无未解决失败后，在 `research` 提交并推送，核验远端和工作区状态。

## 限制

Session pending events 目前只保存在 Worker 内存和 DSH 活动 Session 中；backend 不可用期间 Worker 存活可保留待写前缀，但 Worker 或页面终止后未确认事件没有独立 durable outbox 保证。本批不把这项限制包装成可恢复能力，也不把 flush 成功外推为 Session 与 Workspace 的原子事务。Chrome 是唯一浏览器验收目标，Safari/WebKit 暂停。
