---
description: "Browser-Native durable 重启恢复：backend 重启时未结算 turn 以 `DURABLE_HOST_RESTARTED` 结算，补写工具结果、关闭 step、bump owner epoch；不重放模型或工具。"
---

# durable 重启恢复

## 范围

durable host 的 run 状态只在 backend 进程内存中。进程被强杀时，Session 日志可能停在 `tool/call` 或 `step/start` 之后，既没有 `turn/end`，也没有释放 Session 写租约。重启恢复只负责把这类未结算 turn 明确结算为失败，并让新进程重新取得写权；它不恢复执行。

恢复只处理 durable host 写入的 turn。Worker 自有 turn 的中断恢复由浏览器侧既有链路处理。

## running-turn journal

durable host 创建时传入 `journalPath`，backend 使用 `dataDir/durable-runs.json`。每次 `start()` 在 claim Session 前写入一条 `{turnId, sessionId, principalId, startedAt}`，写入走临时文件加原子 `rename`；turn 结算时删除对应条目。文件格式：

```json
{"version":1,"runs":[{"turnId":"...","sessionId":"...","principalId":"...","startedAt":123}]}
```

journal 只回答“上一个进程可能留下了哪些未结算 turn”，不保存模型消息、工具参数、审批或 owner token。文件损坏、版本不是 `1` 或条目缺少文本字段时，backend 启动直接失败，不以空 journal 继续。

## 启动恢复

backend 在 `store.load()` 与 Workspace 加载之后、开始监听之前调用 `durableHost.recover()`。

对每条 journal 条目：

1. Session 不存在则跳过。
2. 扫描 Session 事件得到当前打开 turn、`step/start` 之后的未闭合 step，以及没有对应 `tool/result` 的 `tool/call`。
3. 没有打开 turn 时跳过（journal 条目陈旧）。
4. 为每个未结算工具调用追加 `isError: true` 的 `tool/result`，文本为 `tool <name> was interrupted by a backend restart; it was not retried`。
5. 存在未闭合 step 时追加 `step/end`。
6. 追加 `turn/end`，reason 为 `{kind:"error", error:{code:"DURABLE_HOST_RESTARTED", message:"the backend restarted before the turn settled"}}`。
7. 在同一次 `store.exclusive` 内把 `ownerEpoch` 加 1、清空 `ownerToken` 与 `ownerExpiresAt`，然后 `flush`。
8. 记录内存中的恢复状态，供后续 `status`/`subscribe`/`cancel` 查询与回放。

全部条目处理完后删除 journal 文件并清空内存条目。恢复完成后 `snapshot()` 的 `recovered` 为该进程恢复的 turn 数，`journalHealthy` 表示 journal 写入是否一直成功。

## 查询与接管

- `GET /session/durable?turnId=`：恢复的 turn 返回 200，`status: "failed"`、`error.code: "DURABLE_HOST_RESTARTED"`、`recovered: true`，并保留原 `turn`、`startSeqs`、`endSeqs`。
- `GET /session/durable/stream?turnId=&fromSeq=`：从 Session 日志回放 `turn/start` 起的全部事件，以 `settled` 行结束；不触发模型或工具。
- `POST /session/durable/stop`：返回同一已结算状态与 `cancelRequested: false`，不追加事件。
- `POST /session/durable/approve`：返回 409 `APPROVAL_NOT_PENDING`；重启后的进程没有待决审批。
- `POST /session/open`（`access: "write"`）：Session 可被重新 claim，`ownerEpoch` 在恢复值上再递增；旧 owner token 已被清空，不能继续写。

## 不重复执行

- 模型：恢复不构造新的模型请求；重启进程的脚本化模型计数保持 0。
- 工具：恢复不为未结算调用执行工具；未获批的 `write` 在重启后仍未写入 Workspace。
- 事件：`assistant/message` 不重复，`tool/call` 数等于 `tool/result` 数，`turn/end` 恰好一条。

## 可判定输出

`tests/durable-host-restart.test.mjs` 2/2，使用 fork 子进程与 `SIGKILL` 模拟真实进程重启：

```text
{"result":"passed","scope":"durable-host-restart","pids":[81916,81917],"recoveredTurns":1,"restored":{"status":"failed","code":"DURABLE_HOST_RESTARTED","turn":1},"settlement":["turn/start","user/message","step/start","assistant/message","step/end","tool/call","tool/result","turn/end"],"journalCleared":true,"modelRequestsAfterRestart":0,"toolCallsAfterRestart":0,"workspaceEntriesAfterRestart":0,"ownerEpoch":{"before":1,"after":2},"nextTurn":{"status":"completed","turn":2}}
{"result":"passed","scope":"durable-host-restart-open-step","pids":[81919,81921],"settlement":["turn/start","user/message","step/start","step/end","turn/end"],"modelRequestsAfterRestart":0}
```

| 断言 | 观测 |
|---|---|
| 重启时存在未结算 turn | journal 有 1 条；Session 停在 `tool/call`；重启 `ready` 报告 `recovered: 1` |
| 状态恢复 | 状态 200 + `failed` + `DURABLE_HOST_RESTARTED` + `recovered: true` + `turn: 1` |
| 工具结果与结算一致 | attach 回放 8 条事件，`tool/result` 引用 `restart-write-1` 且 `isError`；`turn/end` reason 为 `error`/`DURABLE_HOST_RESTARTED` |
| 不重复执行 | 重启后模型请求 0、工具调用 0、`assistant/message` 1 条、`tool/call` 等于 `tool/result`、`turn/end` 1 条 |
| 写租约与 Workspace | 恢复后 Workspace manifest 为空，未获批写入未执行；旧 epoch 1 → 2，新 claim 得到 3 |
| journal 清理 | 恢复后 `durable-runs.json` 为 `ENOENT` |
| 后续可用 | 第二 turn `completed`、`turn: 2`，重启进程只新增 1 次模型请求 |
| 未闭合 step | 第二次重启停在 `step/start`，恢复补 `step/end` 与 `turn/end`，不请求模型 |

同批复跑 `durable-approval`、`durable-cancellation`、`durable-tool-attach`、`observability` 4/4。

## 失败场景清单（仍可能成立）

1. **不恢复执行**：所有重启中的 turn 都失败；没有断点续跑、工具重试或模型重放。
2. **已发生的副作用不回滚**：崩溃前已提交的 Workspace 写入与已执行的外部副作用保留；恢复只补记录，不撤销。
3. **journal 不是事务日志**：`start()` 先写 journal 再 claim；两者之间崩溃时恢复会跳过该条目。Session 与 journal 的写入也不是同一原子操作。
4. **待决审批不可恢复**：重启后审批状态消失，只能以 `APPROVAL_NOT_PENDING` 拒绝决策。
5. **单进程假设**：journal 与 `dataDir` 锁按单 backend 设计，两个进程共享 `dataDir` 会互相覆盖恢复结果。
6. **恢复窗口**：在 `recover()` 完成前 backend 不监听；恢复大量 turn 会延长启动时间。
7. **无真实模型验证**：恢复路径只用 scripted 模型；未确认真实 provider 在 backend 强杀后的计费与断连行为。
8. **指标不持久**：`recovered` 计数只在当前进程内存，重启后再次归零；journal 损坏会使启动直接失败，而不是降级运行。

## 边界

- 使用 `llmMode: "scripted"` 与 fork 子进程；未调用真实 provider。
- 未改 `packages/`，无需 `build:artifacts`/`build:check`。
- 未覆盖双 backend 竞争、SIGTERM 优雅关闭、磁盘故障与恢复期间的并发请求。
