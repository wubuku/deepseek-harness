---
description: "在注入故障下验证 Browser-Native OPFS 写失败与正式 SQLite KV 存储边界：失败可感知、可恢复、不静默丢数据。"
---

# 存储边界与故障注入验证

## Summary

[opfs-quota-tool-failure.e2e.mjs](tests/opfs-quota-tool-failure.e2e.mjs) 在真实 `write` 工具调用期间注入一次 OPFS 配额失败：工具结果向模型与用户报告 quota 诊断；Workspace store 随后自动重试并恰好提交一次 revision 1，内容完整；由于保存当时被报告为未确认，Worker 撤下全部 Workspace 工具（fail-closed），第二个 turn 无法写入；刷新后 hydrate 到 revision 1 并重新发布工具，重试写入新文件得到 revision 2，首个文件内容保持不变。

[fault-injection.spec.ts](../../../packages/storage/storage-sqlite/tests/fault-injection.spec.ts) 对正式 `storage-sqlite` 做四类注入：页预算耗尽（SQLITE_FULL）、非正常退出的 WAL 快照、损坏数据库、只读数据库。四类都表现为可见失败或可恢复的成功，没有静默提交半份数据，也没有静默重建或覆盖原文件。

## 存储边界划分

| 存储面 | 实现 | 本批处理 |
| --- | --- | --- |
| 浏览器 Workspace（OPFS） | `browser-native-workspace-vfs.ts` + durable store | 新增真实工具路径的配额注入 E2E |
| Browser-Native 持久 Session | backend `dataDir` 下的 JSON 快照，经原子替换与父目录 fsync | 已由既有 `DURABILITY_UNKNOWN` 与 outbox 测试覆盖，本批不重复 |
| 正式 DSH Session 事件 | `packages/session` 的 JSONL 持久化 | 本批未注入；其失败语义由 `DURABILITY_UNKNOWN` 系列测试拥有 |
| 正式 DSH 结构化存储 | `packages/storage/storage-sqlite` 的 SQLite KV | 新增四类故障注入测试 |

用户要求中的 “SQLite/Journal” 指向正式 `storage-sqlite`，因为 Browser-Native PoC 的 Session 不使用 SQLite；文档在此明确该范围，避免把两种存储的结论互相代替。

## 语义决策

| 问题 | 决定 | 理由 |
| --- | --- | --- |
| 配额失败是否对模型可见 | 可见。`write` 工具返回 `isError`，文本包含 quota 原因 | 模型必须知道副作用未确认，才能决定重试；隐藏失败会让模型宣称已写入。 |
| 未确认保存后是否自动重试 | 存储层自动重试一次并提交完整内容；工具结果仍保留失败报告 | 首次 OPFS 写失败但重试成功时，数据不丢；报告失败是诚实描述首次尝试。 |
| 未确认保存后是否继续提供 Workspace 工具 | 否。同一 Worker 生命周期内撤下 `edit`/`glob`/`grep`/`read`/`working_directory`/`write` | 一次未确认保存可能逃过重试；继续写入会叠加未知状态。fail-closed 比静默放宽更安全。 |
| 工具何时恢复 | 刷新页面重新挂载后恢复 | 新 Worker 从已提交 revision 重新 hydrate，重新发布工具；本批验证刷新写入得到 revision 2。 |
| SQLite 页预算耗尽的行为 | 抛错、不部分提交；预算恢复后同一记录可重试成功 | `max_page_count` 触发 SQLITE_FULL，日志与调用方都能观察到；已提交记录不受影响。 |
| WAL 非正常退出的数据归属 | 仅主文件不足以恢复最后一次提交；带 `-wal`/`-shm` 的快照可恢复完整记录 | 证明 journal 是未 checkpoint 提交的载体；丢弃 journal 会丢那次提交，但不会返回半份数据。 |
| 损坏库的打开行为 | 拒绝打开且不重写文件 | 静默重建会掩盖损坏并丢失历史；打开失败是最小可感知契约。 |
| 只读库的写行为 | 打开可成功，首次写显式失败；恢复需要主文件与 `-shm` 都可写 | 文件权限恢复不完整时仍持续失败，不会静默降级为只读成功。 |

## 实现

| 位置 | 变更 |
| --- | --- |
| [opfs-quota-tool-failure.e2e.mjs](tests/opfs-quota-tool-failure.e2e.mjs) | 真实 `write` 工具下的配额注入与恢复 E2E；记录撤下的工具、自动重试提交、刷新恢复与第二次提交。 |
| [backend-v2.mjs](backend-v2.mjs) | 新增 quota、quota retry 与 quota reload retry 三条 scripted 规则。 |
| [fault-injection.spec.ts](../../../packages/storage/storage-sqlite/tests/fault-injection.spec.ts) | 正式 SQLite KV 的四类故障注入测试；只新增测试，未改产品源码。 |
| [change-ledger.md](change-ledger.md) | 登记目录外新增测试。 |

## 证据

浏览器 E2E：

```sh
node docs/drafts/browser-native-dsh-poc/tests/opfs-quota-tool-failure.e2e.mjs
```

Chrome 156.0.8078.79 输出：

```json
{"result":"passed","scope":"OPFS-quota-failure-during-write-tool","armed":{"ok":true},
 "observableFailure":{"isError":true,
  "message":"Error: browser-native local Workspace persistence was not confirmed; the file change may remain only in volatile Worker memory (QuotaExceededError: browser-native workspace: injected OPFS quota failure)",
  "stateAfterFirstTurn":"synced",
  "withdrawnTools":["edit","glob","grep","read","working_directory","write"]},
 "noSilentLoss":{"commitsAfterAutoRetry":1,"revisionAfterAutoRetry":1,
  "contentAfterAutoRetry":"quota-tool-first-attempt\n","firstTurnToolCalls":1},
 "failClosed":{"secondTurnWriteCalls":0,"revisionAfterSecondTurn":1},
 "recovery":{"recoveryRequiresReload":true,"revisionAfterReload":1,"sameWorkspaceId":true,
  "reloadContent":"quota-tool-first-attempt\n","retryIsError":false,"finalRevision":2,
  "finalContent":"quota-tool-retry-succeeded\n","totalCommitRequests":2}}
```

- 首次 `write` 只有 1 次 `tool/call`、1 次 `tool/result`，`isError=true` 且包含 quota 原因。
- 自动重试只提交 1 次，revision 1，文件内容完整为 `quota-tool-first-attempt\n`；没有半份内容。
- 第二个 turn 的 retry 写调用为 0，revision 仍为 1：Workspace 工具在整个 Worker 生命周期内保持撤下。
- 刷新后同一 `workspaceId`、revision 1 与首个文件内容均恢复；再次写入提交 revision 2，首个文件仍为原文，第二个文件为 `quota-tool-retry-succeeded\n`。
- 全程无 `pageerror`、无跨源请求。

正式 SQLite KV：

```sh
pnpm vitest run packages/storage/storage-sqlite/tests/fault-injection.spec.ts
```

```text
Test Files  1 passed (1)
     Tests  4 passed (4)
  Duration  291ms
```

- 页预算耗尽：写入以 `database or disk is full` 拒绝，`loadAll` 仍只有 `before`；提高预算后同一记录写入成功；重新打开后两条记录都在。
- WAL 快照：带 `-wal`/`-shm` 的副本恢复出 `checkpointed` 与 `wal-only`；只复制主文件时只有 `checkpointed`，`wal-only` 不存在，证明未 checkpoint 提交依赖 journal。
- 损坏库：打开以 `not a database`/`malformed` 拒绝，文件字节与失败前完全相同。
- 只读库：打开成功，首次写入以 readonly 拒绝；仅恢复主文件权限仍不够，`-shm` 也可写后同一记录写入成功，既有 `kept` 记录保持完整。

## 限制

OPFS 配额通过 PoC 测试钩子注入，不是真实磁盘写满；SQLITE_FULL 通过 `PRAGMA max_page_count` 注入，不是物理磁盘耗尽；WAL 非正常退出用打开连接下的文件副本模拟，不是真实断电；只读测试依赖 POSIX 权限并在 Windows 跳过。未覆盖：真实 OPFS 配额耗尽后的浏览器行为、SQLite 写入中断进程、`fsync` 失败、磁盘只读挂载、正式 Session JSONL 故障注入、多实例 backend 与跨设备同步。
