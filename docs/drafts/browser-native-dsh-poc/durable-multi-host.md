---
description: "Browser-Native 多 host 竞争：dataDir 级单写者、Session owner lease 的 fencing token、并发 claim 拒绝与重启后接管；durable turn 运行期间浏览器不能接管。"
---

# 多 host 竞争与租约接管

## 范围

同一 Session 可能被多个页面、多个 backend 进程或 durable host 同时触碰。现有机制分两层：

1. **dataDir 级单写者**：backend 启动时以 `dataDir/.browser-native-backend.lock` 做独占锁。第二个进程无法启动，因此不存在两个 backend 同时改写同一批 Session 文件的情况。
2. **Session owner lease**：持有者用 `ownerToken` 写入，`ownerEpoch` 是租约代数（fencing token）。lease 默认 30 秒，过期或显式 `session/close` 后释放。`session/append`、`session/flush`、LLM 授权都校验 token 与 epoch。

durable turn 也通过同一 lease 写入 Session；运行期间它持有租约，浏览器只能读、不能接管。

## 可判定路径

### 同时启动两个 backend

两个进程同时指向同一 `dataDir` 时，只有一个能完成启动并监听；另一个以非零码退出，stderr 报 `BACKEND_ALREADY_RUNNING`。锁文件由先到者原子创建，后到者读取 pid 后拒绝。极窄的“锁已创建但内容未写完”窗口会报 `BACKEND_LOCK_UNREADABLE`，同样拒绝启动。

### 同时 claim 同一 Session

两个写者不带 `ownerToken` 同时 `POST /session/open`（`access: "write"`）：一个 200 并返回新 `ownerToken`、`ownerEpoch` 加 1；另一个 409 `SESSION_ALREADY_OWNED`，`retryAfterMs` 为剩余租约（约 30 000 ms）。

### 旧 token 拒绝

claim 换代后，旧 token 或任意猜测 token 调用 `session/append` 返回 409 `SESSION_OWNERSHIP_LOST`；新 token 使用 `expectedNextSeq` 继续追加成功。

### 重启后的接管

前一个 backend 被强杀后，新 backend 读取持久化的 `ownerEpoch`，新 claim 再将其加 1。崩溃前的 token 不在新进程中存在，用它追加返回 `SESSION_OWNERSHIP_LOST`；新 token 追加成功。这与重启恢复的清 token、epoch 加 1 是同一套 fencing。

### durable turn 运行期间

- 浏览器 `POST /session/open`（`access: "write"`）→ 409 `SESSION_ALREADY_OWNED`，`retryAfterMs` 约 30 000 ms。
- 任意 token `session/append` → 409 `SESSION_OWNERSHIP_LOST`。
- 同一 Session 再起 durable turn → 409 `SESSION_TURN_ACTIVE`（先做 turn 状态校验，再尝试 claim）。
- `stop` 后 turn 结算为 `cancelled`、租约释放；随后 `session/open` 返回 200 且 epoch 加 1；关闭租约后新的 durable turn 正常完成。

## 可判定输出

`tests/durable-multi-host.test.mjs` 2/2：

```text
{"result":"passed","scope":"multi-host-dataDir-and-session-writer","backend":{"winnerPid":93852,"loserExitCode":1,"loserStartupError":"BACKEND_ALREADY_RUNNING"},"startupRace":{"ready":1,"refused":1},"claimRace":{"statuses":[200,409],"refusedCode":"SESSION_ALREADY_OWNED","refusedRetryAfterMs":29999},"fencing":{"createEpoch":1,"claimEpoch":2,"afterRestartEpoch":3,"staleAppend":"SESSION_OWNERSHIP_LOST","staleAfterRestart":"SESSION_OWNERSHIP_LOST"},"session":{"persistedEvents":1,"liveAppendStatus":200,"takeoverAppendStatus":200}}
{"result":"passed","scope":"durable-lease-takeover-across-writers","backend":{"pid":93857},"duringTurn":{"openStatus":409,"code":"SESSION_ALREADY_OWNED","retryAfterMs":29984,"appendStatus":409,"secondTurnStatus":409,"secondTurnCode":"SESSION_TURN_ACTIVE"},"afterStop":{"turnStatus":"cancelled","openStatus":200,"ownerEpoch":2},"nextTurn":{"status":"completed","turn":2},"cancellationEvents":1}
```

| 断言 | 观测 |
|---|---|
| 同时启动 | `ready: 1`、`refused: 1`，拒绝码 `BACKEND_ALREADY_RUNNING`，退出码 1 |
| 同时 claim | 状态 `[200, 409]`，拒绝码 `SESSION_ALREADY_OWNED`，`retryAfterMs` 29999 |
| fencing token | epoch 1 → 2，重启接管后 3 |
| 旧 token 拒绝 | 同进程换代与重启后都为 `SESSION_OWNERSHIP_LOST` |
| durable 运行中接管 | open 409、append 409、第二个 durable turn 409 `SESSION_TURN_ACTIVE` |
| 结算后接管 | `cancelled` → open 200、epoch 2 → 下一 turn `completed` |
| 事件一致性 | 取消只产生 1 条 `aborted` `turn/end` |

同批复跑 `durable-host-restart`、`durable-approval`、`durable-cancellation`、`durable-tool-attach`、`observability` 6/6。

## 失败场景清单（仍可能成立）

1. **只有目录级互斥**：没有共享数据库或分布式租约；`dataDir` 锁是唯一的跨进程单写者保证，不能用两个 backend 分担同一批 Session。
2. **无自动接管**：租约过期或被释放后需要新的显式 `session/open`；没有租约心跳、接管队列或后台转移。
3. **`retryAfterMs` 只是建议**：客户端可在 lease 未过期前反复重试；服务端没有按 principal 的退避或配额。
4. **锁依赖本机 pid 存活判断**：容器、PID 复用、NFS 等场景下锁的语义会退化；没有跨主机锁。
5. **强杀窗口**：`dataDir` 锁文件可能残留，靠 pid 探测清理；恢复期间的 Session 写入与 journal 删除仍不是同一事务。
6. **`session/handoff` 未在此验证**：正式的 checkpoint handoff 路径存在，但本测试只覆盖 open/close 的接管与拒绝；跨实例 handoff 没有端到端证据。
7. **durable 与浏览器共享 lease 但不是同一写入队列**：浏览器在 turn 结算与租约释放之间仍可能短窗口竞争；`retryAfterMs` 是唯一提示。
8. **Workspace 写租约另算**：测试未验证 Workspace `fencingToken` 与 Session `ownerEpoch` 的联合场景，见第 5 点。

## 边界

- 使用 fork 子进程、`workspace-backend-instance.mjs` 与 `durable-backend-process.mjs`（scripted 模型）。
- 未调用真实 provider；未改 `packages/`，无需 `build:artifacts`/`build:check`。
- 未覆盖跨主机、NFS、容器、`session/handoff` 与 Workspace 写租约组合。
