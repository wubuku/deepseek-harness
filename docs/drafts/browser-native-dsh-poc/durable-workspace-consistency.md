---
description: "Browser-Native durable 路径的附件与 Workspace 写入一致性：durable turn 只携带文本 prompt，因此附件不适用；已提交的 Workspace 写入在 backend 重启后保持相同 hash、字节与 Session 事件。"
---

# durable 附件与 Workspace 写入一致性

## 范围

本文回答两个问题：durable turn 是否携带附件，以及已经提交的 Workspace 写入在 backend 重启后是否仍与 Session 日志一致。

只有 durable host 实际执行的两件事有证据：文本 prompt 与 `read`/`write` 工具。附件由浏览器 Worker 路径处理，不在 durable host 内。

## 附件不适用于 durable 路径

durable turn 的输入是单个文本字段：

- `POST /api/browser-native/session/durable` 只读取 `prompt` 字符串，`durableHost.start()` 把 `prompt` 原样写成 `user/message` 的 `data.content`。该字段是字符串，不是事件块数组。
- 附件引用要求 `user/message` 的 `data.content` 是数组，且块类型为 `file`、`attachment.attachmentId` 形如 `sha256:<64 hex>`。附件 GC 的引用集合也只从这种数组内容构建；durable turn 写出的字符串不产生任何引用。
- durable 工具路径只允许 Workspace 根 `/dsh/home/workspace/`；附件对象位于 `dataDir/attachments-v1/`，不是可读工具路径。

因此不存在需要验证的“durable 附件恢复后一致性”：durable 路径无法表达附件引用，也不会把附件字节交给模型。附件上传、GC、跨 principal 归属与 Worker 崩溃恢复由既有[附件 GC](attachment-gc-validation-progress.md) 与 [附件崩溃恢复](attachment-worker-crash-recovery-validation-progress.md) 记录覆盖。

## 已提交写入在恢复后保持一致

`write` 经审批并通过 `executeDurableTool` 提交后才算完成。提交之后：

- turn 结算时从 running-turn journal 删除自身条目；journal 保持为空。
- 重启时 `recover()` 读到空 journal，返回 `recovered: 0`，不追加事件，也不 bump `ownerEpoch`。
- Workspace manifest 仍返回同一路径、同一 `hash` 与同一 `bytes`；通过 blob 路由读回的字节与原内容一致。
- Session 事件序列与重启前逐项相同；`tool/call` 与 `tool/result` 各 1 条，`turn/end` reason 为 `completed`。
- 新 turn 的 `read` 工具能从同一 Workspace 读回内容，turn 以 `completed`/`turn: 2` 结算。

这与[重启恢复](durable-host-restart.md)的差异在于：恢复文档覆盖“未结算 turn 失败且未获批写入不落盘”；本文覆盖“已结算 turn 的已提交写入在重启后仍一致”。

## 可判定输出

`tests/durable-workspace-recovery.test.mjs` 1/1，fork 子进程 + `SIGKILL`，scripted 模型：

```text
{"result":"passed","scope":"durable-workspace-recovery","pids":[31246,31267],"committedWrite":{"status":"completed","path":"durable-committed.txt","bytes":23,"hash":"b8be2b82380537c8c46e8b47e0783e1f72e19e035b4b345e428b897dee38d9f5"},"durableUserMessage":"text","attachments":"not-applicable","restart":{"recovered":0,"journalCleared":true,"manifestHashStable":true,"sessionEventsStable":11},"postRestartRead":{"status":"completed","turn":2,"isError":false,"bytesMatch":true}}
```

| 断言 | 观测 |
|---|---|
| 审批前不写盘 | manifest 无 `durable-committed.txt` |
| 审批后提交 | turn `completed`，manifest 条目 `hash` 与 23 字节内容匹配 |
| 结算清空 journal | `durable-runs.json` 的 `runs` 为空 |
| 重启无恢复 | 新进程 `recovered: 0`，journal 删除 |
| Workspace 一致 | 重启后 manifest 的 `hash`/`bytes` 不变，blob 字节一致 |
| Session 一致 | 11 条事件类型序列与重启前相同 |
| 恢复后可读 | 下一 turn 的 `read` 返回 `DURABLE_COMMITTED_BODY`，`completed`/`turn: 2` |
| 附件不适用 | `user/message.content` 为字符串，durable 输入无附件块 |

同批复跑 `durable-host-restart`（2）、`durable-multi-host`（2）、`durable-approval`、`durable-cancellation`、`durable-tool-attach`、`observability` 共 8/8。

## 失败场景清单（仍可能成立）

1. **崩溃窗口不回滚**：Workspace commit 已返回但 Session `tool/result` 尚未追加时崩溃，恢复会把该 turn 结算为失败，而已提交文件保留。Session 与 Workspace 不是跨存储事务。
2. **journal 非事务日志**：结算后的 journal 清理是异步写入；进程在清理前被强杀时，journal 可能仍含已结算 turn，`recover()` 扫描到已闭合 turn 后跳过，不重复追加事件。该路径只有静态阅读与实际重启测试覆盖，没有专门注入清理窗口。
3. **附件只在 Worker 路径**：durable turn 不解析、不存储、不引用附件；将来若允许附件的 durable 输入，需要新增事件字段、GC 引用规则与恢复测试。
4. **单 `dataDir` 假设**：Workspace 与 journal 都按单 backend 设计；两个进程共享 `dataDir` 不是受支持配置。
5. **未覆盖真实模型的已提交写入**：真实 provider 只验证审批、取消与未结算恢复，没有在真实模型完成写入后强杀并读回。

## 边界

- 使用 `llmMode: "scripted"`、fork 子进程与 `SIGKILL`；未调用真实 provider。
- 未改 `packages/`，无需 `build:artifacts`/`build:check`。
- 未覆盖附件与 durable 输入的新语义、崩溃窗口注入、磁盘损坏或跨主机 `dataDir`。
