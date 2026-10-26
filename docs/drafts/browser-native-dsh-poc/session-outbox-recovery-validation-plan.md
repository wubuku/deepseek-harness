---
description: "规划 Browser-Native DSH 的本地 Session outbox、Worker 重启恢复、写者 fencing 与 Workspace 回执对账验证。"
---

# Browser-Native DSH Session Outbox 恢复验证计划

## 目标

验证 Dedicated Worker 被终止或同源 Session backend 暂时不可用时，浏览器本地 IndexedDB 能否保存已由 DSH Session 接受、但尚未被 backend 确认 durable 的连续事件前缀，并在同一 Session 重新取得写者 lease 后安全对账。Remote Session 仍是恢复后 DSH Agent 的唯一事件日志；IndexedDB 只暂存待确认事件，不能成为第二份 transcript，也不能触发 prompt、工具或 HITL 的自动重放。

本批将本地 outbox、Session writer epoch、Workspace operation receipt 和 `session/flush` durability watermark 作为一个恢复路径验证。若当前 Worker Host 的 `session/flush` 调度不能保证模型请求和顶层工具副作用先等待本地 journal 与远端 durable，则本批必须 fail closed 并记录契约缺口，不能降低 DSH 持久化语义。

## 源码事实与设计约束

- `Session.append()` 先把事件加入内存日志，再同步发布 `session/event`；该通知是 post-commit、fire-and-forget，观察者无法让 append 等待 IndexedDB 写入。
- `ctx.sessions.flush(session)` 等待所有 `session/flush` 监听器。当前 `session-checkpoint-policy` 在模型适配器开始读取首个 chunk 前，以及顶层工具执行前刷新 Session，因此 Browser provider 可在这些检查点拒绝未本地 journal 或未远端 durable 的操作。
- `SessionHandle.append()` 的公共契约只承诺事件已被接受并可读；`SessionHandle.flush()` 才承诺 backend durability。Browser provider 另检查 backend 返回的 `durableThroughSeq`。
- Browser provider 的 `RemoteSessionHandle.pendingLive` 目前只在 Worker 内存中保留；远程 append 与 flush 的处理已有单飞、批量限额、未知响应核对和 writer lease。
- 当前 Workspace IndexedDB 使用独立数据库 `dsh-browser-native-workspace-v1`，存放本地快照、重试批次和 operation receipt；Session outbox 使用独立数据库，避免隐式升级或重写 Workspace schema。
- Workspace 写入通过稳定 `operationId` 与 backend receipt 恢复；Session/Workspace 没有跨存储原子事务。恢复代码必须查询和核对原 receipt，不能重做业务工具。
- Worker 终止与网络中断由 Chrome E2E 显式注入；这不代表操作系统崩溃、自然 storage eviction 或浏览器后台执行已经得到验证。

## 候选范围与批次选择

| 验证方向 | 价值 | 本批决定 | 验收焦点 |
|---|---:|---|---|
| Session 事件本地 durable outbox 与 Worker 重启后续传 | P0 | 纳入 | 事件先写 IndexedDB，再发送 backend；只在 backend watermark 确认后清理。 |
| append 已提交但 response 丢失、flush 已 durable 但本地清理前 Worker 终止 | P0 | 纳入 | 重启后按 seq 和完整事件内容对账，不重复追加，确认 durable 后清理。 |
| 同一 Session 的 writer epoch 与旧 Worker 延迟写入 | P0 | 纳入 | 新 epoch 接管后，旧 epoch 不能追加或清理 outbox；冲突数据保留并 fail closed。 |
| Session outbox 与 Workspace operation receipt 联合恢复 | P0 | 纳入 | 找回同一个 operation receipt 与 Session receipt，不重复调用写工具、不产生第二个 Workspace revision。 |
| IndexedDB abort、配额上限、损坏记录与不同内容复用 seq | P0 | 纳入 | 失败不丢记录、不截断事件、不继续发起模型请求或工具副作用。 |
| 断网时继续运行模型并在稍后后台同步 | P1 | 排除 | Session checkpoint 失败时停止模型/工具；Worker 不承担后台任务。 |
| 多设备冲突合并、压缩、清除策略与敏感数据加密 | P1 | 延后 | 需要账户身份、服务器恢复策略、密钥管理和 retention 产品决策。 |
| 真实自然 eviction、OS 级崩溃和 Safari/WebKit 生命周期 | P1 | 延后 | 本批只使用 Chrome Worker 终止、IDB transaction abort 和请求故障注入。 |

## 实施范围

### M0：确认持久化与恢复入口

- 核对 `session-checkpoint-policy`、Browser `session/event` listener 和 `RemoteSessionHandle.open/append/flush` 的实际调用顺序。
- 确认 `open(id, 'write')` 获得 server owner epoch 后，能在 Session 暴露给 Agent Loop 前完成本地 outbox 对账。
- 记录 Worker 终止前不能保证的内存状态，以及恢复后 DSH `resume` 对未结束 turn、未完成工具和 HITL 的处理方式。

### M1：有界 IndexedDB Session outbox

- 新增 PoC 专属 IndexedDB 数据库，按 `sessionId + seq` 保存待确认事件和按 Session 统计的字节/事件用量。
- 记录前验证事件可无损 JSON 编码、seq 连续、容量未超限；相同 seq 与相同事件幂等，不同事件冲突。
- `claim(sessionId, ownerEpoch, writerId)` 拒绝旧 server epoch，并用当前 epoch 的随机 writer ID fence 同 epoch 的旧 Worker。只存 epoch 和随机 ID，不存 owner bearer token。
- outbox 按每 Session 与整个 browser profile 限制 pending event 数和 UTF-8 JSON 字节数，并限制 writer fence 记录数。达到 fence 上限时只淘汰没有 pending event 的记录；所有记录都有 pending event 时拒绝新 claim。
- outbox schema 从 v1 升至 v2 时保留已有 event rows，并从 Session metadata 重建全局用量；损坏 metadata 会中止升级，不清除旧数据库。
- 超限、IDB abort 或 quota 错误均保留原状态并拒绝 checkpoint。
- outbox 仅暂存未获 backend durable watermark 覆盖的记录；不代替远端 Session 历史，不缓存 prompt 以供自动重跑。

### M2：接入远程 Session writer 和恢复路径

- `session/event` 只把事件加入 Worker 内存待处理队列；实际远程 append 前先将同一有序批次写入 IndexedDB 并等待事务完成。
- backend `append` 成功只推进远端可见 seq；`flush` 返回有效 durable watermark 后，才按 seq 删除本地 outbox 记录。
- 重启后的 write `open` 取得新 owner epoch 后，读取待处理记录并从 seq 0 起验证其内部连续性；逐条读取 backend 重叠范围并比较事件，填补 backend 缺失的连续尾部，再执行 flush 与 watermark 清理。
- backend 同 seq 内容不一致、本地前缀有缺口、owner epoch 过期、outbox 超限或持久化失败时保留记录并拒绝 Session 恢复写入；不选择 last-write-wins。
- 完成 Workspace receipt 恢复后再清理关联 receipt；Workspace 已提交但 Session receipt 尚未 durable 时，只补 receipt，不重跑原业务工具。
- Agent Loop 恢复只修复中断的 DSH turn；本批不自动重新提交用户 prompt、不重放未完成工具 Promise 或 HITL 答案。

### M3：真实 Chrome Worker 故障矩阵

- 在 Session outbox 成功写入后、backend append 到达前终止 Worker；重启后验证本地记录上传、seq 连续且原 prompt 未进入 LLM 请求。
- 让 backend durable flush 已完成但拦截其 response，然后终止 Worker；重启后逐事件核对远端前缀并清除本地记录，append 和副作用计数均不增加。
- 在 append response 丢失后重启，覆盖 remote 可见与 remote durable 的分离状态。
- 注入 IDB transaction abort、单 Session 与全局 outbox 超限、writer fence 容量、同 seq 不同事件、旧 writer epoch 和 v1→v2 schema 升级；确认 fail-closed、记录保留和迁移后计数正确。
- 在 Workspace write 已 commit、Session receipt 尚未 durable 的窗口终止 Worker；恢复同一 operation receipt 并验证工具调用与 revision 均恰一次。
- 输出 event seq、local pending count/bytes、backend `nextSeq`/`durableThroughSeq`、LLM 请求数、工具调用数、Workspace revision 和 receipt count；不得输出 prompt 原文或凭据。

### M4：真实模型冒烟与交付

- 真实 Chrome 通过同源 backend 从 `docs/drafts/.env` 读取凭据，运行多轮短对话、一次 Browser Workspace 文件工具及刷新恢复。
- 验证 prompt、tool call/result 和 assistant response 的 Session 序号连续；所有可完成 turn 的 durable watermark 覆盖其事件；刷新后不重放已完成 prompt 或工具副作用。
- 记录实际模型请求数、工具调用数、Session watermark 和脱敏失败；不把 scripted 测试当作真实 LLM 结果。
- 更新本目录 README、兼容矩阵、变更清单、progress 与 drafts 登记；列清楚浏览器终止与存储故障注入的证据边界。

## 验收矩阵

| 情况 | 预期状态 | 必须观察 | 不代表 |
|---|---|---|---|
| 本地 journal 成功，远端 append 尚未完成 | local pending | Worker 终止后新 Worker 上传原有事件，seq 不重复 | 页面关闭后继续运行 Agent |
| append 响应未知 | unknown，outbox 保留 | backend 按 seq 内容比较；相同事件可认领，不同事件拒绝 | requestId 提供业务幂等或原 prompt 自动重放 |
| backend durable，客户端未收到 flush response | remote durable，local pending | 重启后精确核对事件，再依据 watermark 清理本地副本 | 两个存储具备原子事务 |
| IndexedDB abort、quota 或容量上限 | local persistence failed | `session/flush` 拒绝，模型请求和顶层工具均未执行 | 可无限离线缓存 |
| 新 writer epoch 接管 | 新 owner | 旧 epoch 无法写入或清理；冲突 outbox 保留 | 多标签页自动合并内容 |
| Workspace commit 已成功、Session receipt 未确认 | Workspace committed / Session pending | 只恢复原 `operationId` 的 receipt，revision 与工具计数不增加 | 工具可安全地任意重放 |
| 未结束 turn、工具或 HITL 等待 | interrupted/unknown | 记录恢复后的 DSH 状态，不自动继续原 prompt 或副作用 | Worker 终止后恢复任意异步栈 |

## 预期限制

- IndexedDB 与 remote Session backend 不共享事务；outbox 依赖 server seq 对账与 durable watermark 清理。
- PoC 当前每 Session 上限为 8,192 events/16 MiB，profile 汇总上限为 32,768 events/64 MiB，最多跟踪 256 个有 pending event 或保留 writer fence 的 Session。实际浏览器 quota 可能更低；empty fence 可回收，pending event 不可因容量回收。
- 浏览器可清除或驱逐 IndexedDB；本地 outbox 不等同云端备份，也不保证持久存储授权。
- 本地记录包含 Session 事件正文，可能包含用户 prompt、工具参数和模型输出；本批不实现加密或账户隔离，PoC 必须明确同源浏览器 profile 的敏感数据风险。
- Worker 终止后只恢复持久化事件；未完成的 JS promise、模型流、工具进程和 HITL 等待者不可恢复。
- 本批 Chrome 故障注入不能证明自然 eviction、操作系统断电、跨浏览器兼容或生产后端的一致性。
