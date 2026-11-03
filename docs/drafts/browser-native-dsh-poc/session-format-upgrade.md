---
description: "Browser-Native PoC 的 Session 日志格式版本判定：旧版本落盘数据被新 backend 读取时明确拒绝，不做静默迁移。"
---

# Session 格式升级路径

## 问题

Browser-Native 的持久 Session 由 backend 写入 `sessions/<id>.json`，事件由真实 DSH Worker 产生。此前 `FormalSessionStore.load()` 只核对 `header.id` 与 `events` 是否为数组，不检查 `header.version`；durable 路由的默认 header 还固定写 `version: 1`，而当前运行时是 `SESSION_FORMAT_VERSION = 4`（[types.ts](../../../packages/core/session/src/types.ts)）。结果是新 backend 会把旧代 harness 落盘的日志当作当前格式读取，可能重建出错误的对话；反过来，durable 路由会写出下一代 harness 拒绝的 header。

## 行为

- backend 侧常量镜像 `SESSION_FORMAT_VERSION = 4`；load 时 header 版本不等于当前值的记录不进入可读集合，只登记到内存 `unsupported` 表，并向 stderr 写一行告警。该 Session 不出现在 `list`，`stat`、`open`、`read`、`create` 与 durable turn 均被拒绝。
- 拒绝使用 `SESSION_FORMAT_UNSUPPORTED`（HTTP 422），`error.details` 携带 `storedVersion` 与 `expectedVersion`；header 完全没有版本号时只给 `expectedVersion`。
- 拒绝按 principal 限权：不属于该 Session principal 的请求仍得到 404 `SESSION_NOT_FOUND`，不泄露旧日志存在。
- `create` 拒绝任何非当前版本的 header，且不会覆盖 `unsupported` 表中的文件；被拒绝后落盘字节保持不变。
- Worker 侧 `mapSessionError` 把该错误映射为正式 `SessionFormatUnsupportedError`，文案用 `sessionFormatVersionRefusal()` 按版本方向生成：更高版本提示升级 harness，更低版本说明本构建没有升级路径。
- durable 路由的默认 header 改为当前版本。

## 证据

`tests/session-format-upgrade.test.mjs`（Node 合同测试）：

```text
browser-native Session format upgrade path
  ✔ refuses a stored older-format Session instead of reading it
  ✔ refuses to create a Session stamped with a foreign format version
ℹ pass 2  fail 0
```

第一条用例写入 header `version: 3` 的同 principal 会话，随后重启 backend：`list` 返回空、`stat`/`open` 返回 422 且 `details = { storedVersion: 3, expectedVersion: 4 }`，另一 principal 收到 404，用当前版本 header 重建同 id 仍被 422 拒绝且文件字节不变。第二条用例证明 `version: 1` 的 `create` 被 422 拒绝，而当前版本 `create`、`stat`、`list` 正常。

既有合同测试复跑 80/80：`backend-v2.test.mjs`、`durable-host.test.mjs`、`principal-isolation.test.mjs`、`attachment-gc.backend.test.mjs`、`cross-store-operation-ledger.test.mjs`、`shared-state-authority.test.mjs`、`shared-authority-concurrency.test.mjs`、`session-workspace-reconciliation.test.mjs`。测试内的 Session header 字面量已统一为当前版本；`version: 1` 仅保留在 Workspace layout、identity、download journal 等其它记录类型。

## 边界

- 不提供迁移或降级：旧日志原样保留，由对应代 harness 打开；本构建只拒绝。
- `unsupported` 表在每次启动时重建，不持久化拒绝清单；告警只写 stderr。
- durable 路由的 422 不带 `details`，因为 `DurableTurnError` 只保留 code/message/status；效果仍是拒绝，但不参与 Worker 的版本方向文案。
- 本批验证的是 backend 落盘 Session 的跨版本读取；未模拟旧版浏览器 OPFS/cache 数据、跨主机共享 `dataDir` 或并发多实例下的版本竞争。
- 未改动 `packages/`，因此不需要 `build:artifacts` / `build:check`；未改 LLM 请求语义，未跑真实模型 smoke。
