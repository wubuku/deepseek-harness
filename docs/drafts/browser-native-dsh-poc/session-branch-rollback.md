# 会话分支与 turn 回滚的数据模型

本项给出从某个 turn 分叉新 Session、以及回滚到指定 turn 的持久化模型，并验证事件序号、附件与 Workspace 版本一致、原 Session 不被修改。PoC 采用与正式 Session fork 相同的只追加语义：分支与回滚都不删除、不改写源日志，而是生成一个从边界 turn 继承前缀的新 Session。

## 数据模型

`POST /api/browser-native/session/branch` 接受：

- `sessionId`：源 Session；必须属于请求 principal，且持有其 owner lease。
- `newSessionId`：子 Session id；不得等于源 id，也不得已存在。
- `atTurn` 或 `atSeq`：二选一；两者同时给出时必须指向同一位置。边界必须是 `turn/end`，即只能“从某个已完成的 turn”分叉或回滚。
- `intent`：`branch`（默认）或 `rollback`；仅为来源标注，读写语义相同。

子 Session 的持久化字段：

- `header.parentSession = 源 id`、`header.isSeeded = true`，其余头字段从源复制；`createdAt` 取当前时间，`id` 取新 id。
- `inheritedEventCount = boundarySeq + 1`，等于被继承的源事件数。
- 事件为源前缀 `0..boundarySeq` 的完整拷贝，随后追加 child-owned `session/end-seed`，`seq = boundarySeq + 1`、`time = 边界事件 time`、`data = { inherited: true }`。
- `nextSeq = boundarySeq + 2`；之后的追加从该位置继续，序号连续。
- `branch` 元数据与 Session 记录一起持久化并从 `read` 返回：`{ intent, parentSessionId, boundarySeq, boundaryTurn, workspaceRevision }`。`workspaceRevision` 是分叉时的 Workspace revision，不是写操作；分支不修改 Workspace，因此该值在分支前后保持不变。
- 附件不复制字节：子 Session 事件中的 attachment 引用仍指向同一 content-addressed 对象（`sha256:<hash>`），导出子 Session 时会重新打包这些附件。

回滚按“生成截断到目标 turn 的新世代”实现。append-only 存储不删除已提交事件，因此不提供原地截断；`intent: 'rollback'` 的子 Session 从目标 turn 之后继续，源 Session 仍保留其后续 turn，可审计、可再次分叉。

## 验证

[`session-branch-rollback.test.mjs`](tests/session-branch-rollback.test.mjs) 使用真实 backend、Workspace store 与附件上传：

1. 源 Session 写入 7 个事件（一条带 `note.txt` 附件的用户消息，以及两个完整 turn），上传附件到 Workspace。
2. 从 turn 1 分叉：子事件 `[0..3]` 与源逐项相等，新增 `session/end-seed` 在 seq 4，`inheritedEventCount = 4`、`nextSeq = 5`，头 `parentSession`/`isSeeded` 正确，`branch.workspaceRevision` 等于分叉前 revision。
3. 用同一 `requestId` 重放分叉请求，返回完全相同响应且不产生第二个 Session。
4. 回滚到 turn 2：子 Session 继承 7 个事件、`nextSeq = 8`，`branch.intent = 'rollback'`。
5. 源 Session 在分叉与回滚后事件逐项不变、`nextSeq` 仍为 7、头不变；Workspace revision 不变。
6. 子 Session 取得 owner 后继续追加新 turn，事件序号保持 `0..8` 连续。
7. 导出子 Session：1 个附件，`sha256` 与上传内容一致，字节内容逐字节相同。
8. 边界错误：`atSeq` 指向 assistant 事件、`atTurn` 指向不存在 turn 均返回 400 `SESSION_BRANCH_BOUNDARY_INVALID`；共享 viewer 分叉返回 403 `SESSION_READ_ONLY`。

测试结果：

```text
✔ Session branch and turn rollback keep sequence, attachment, and workspace consistency
```

同一提交前还复跑了相关回归：

```text
✔ 5/5 attachment-backend tests
{"result":"passed","scope":"session-export-import", ...}
```

## 限制

- 分支只在 UI 之外暴露为 API；preview 尚无“从此 turn 分叉”的按钮。
- 分支不复制附件字节，依赖同 Workspace 的 content-addressed 对象；跨 Workspace 迁移需要导出/导入。
- 分支不挂载 Session，不消耗 `maxMountedSessions`；打开子 Session 时才取 owner lease 并挂载。
- 回滚是“新世代”，不是原地删除；读取源 Session 仍会看到边界后的 turn。
- 未覆盖分叉进行中的 turn（边界要求 `turn/end`），也未覆盖多 host 同时分叉同一 Session 的竞争。

复跑：

```sh
node --test docs/drafts/browser-native-dsh-poc/tests/session-branch-rollback.test.mjs
```
