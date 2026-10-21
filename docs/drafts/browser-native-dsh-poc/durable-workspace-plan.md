---
description: "规划 Browser-Native DSH durable Workspace PoC，验证浏览器本地文件持久化、恢复和 DSH 文件工具兼容性。"
---

# Browser-Native DSH Durable Workspace PoC 规划

## Summary

本批次在既有文件级 Workspace 同步 PoC 之上，验证 DSH Agent 在浏览器 Worker 中写入的文件是否可以获得可恢复的本地持久化，而不是只存在于 `MemoryVfs`。主要目标是解决浏览器环境对宿主机文件系统的依赖；云端同步仍是外部结果，不把本批次扩大为生产对象存储或多端协同实现。

本批次采用增量方式：`MemoryVfs` 继续作为 DSH 运行时的 Node-compatible 工作副本，OPFS 保存文件 bytes，IndexedDB 保存本地 Workspace snapshot、pending operation 和状态元数据。既有 Workspace backend、manifest CAS 和 Session backend 不替换，只在浏览器端增加本地 durable store 和恢复路径。

## 验证问题

1. Worker 重建前已经进入本地 outbox 的文件修改是否可以恢复。
2. DSH 真实 `tool-fs` 的读写、atomic-write、rename、remove 和 metadata 操作是否仍通过 Browser-Native VFS。
3. OPFS/IndexedDB 不可用、内容损坏或本地缓存被清除时，是否能明确失败并从云端重建，而不是静默覆盖云端状态。
4. 失败或响应不明时，Workspace operation 是否保留原 `operationId` 和原内容。
5. `local durable`、`cloud pending`、`cloud committed` 和 `conflict` 是否能被 UI 与后续 Agent 上下文区分。

## 实施里程碑

### M0：固定既有基线

- 不改变默认 Browser-Native Workspace PoC 的启动方式。
- 保留文件级 SHA-256 blob、manifest revision、CAS 和 stale-writer conflict。
- 记录现有 `VfsMutationSink` 的 post-commit 限制，不把它改名为事务日志。

### M1：浏览器本地 durable store

- 增加 OPFS blob store 和 IndexedDB metadata store。
- 持久化 workspace head、pending changes、retry batch、`operationId` 和 content hash。
- OPFS blob 写入完成后再提交 IndexedDB snapshot；孤儿 blob 允许后续 GC。
- 启动时先打开本地 store，再由远端 manifest hydrate `MemoryVfs`，最后重放 pending changes。
- 不能读取本地 pending blob 时返回明确的本地损坏错误，不把空目录当成干净状态。

### M2：本地恢复与幂等

- Worker 重建后恢复 pending change 和 retry batch。
- 上传失败、commit 冲突和响应不明均保留原 operation。
- 新内容覆盖同一路径时只保留当前可见版本，但不丢失当前 operation 的 retry 语义。
- `flushWorkspace()` 等待本地 snapshot 持久化，并单独等待云端 receipt。

### M3：真实 DSH 文件工具验证

- 使用真实 Browser-Native profile 验证 `read`、`write`、`append`、`edit`、`list`、`stat`、`mkdir`、`rename`、`remove`、`chmod`。
- 验证 DSH atomic-write staging directory 不进入最终 Workspace manifest。
- 通过真实 Worker Host 的 `prepareVfs` 确认恢复发生在 Cordis boot 前。
- 对不支持的宿主能力记录明确错误，不用模拟 bash 或宿主机路径制造成功假象。

### M4：故障注入与证据

- 注入 upload 失败、commit 超时、OPFS blob 缺失、IndexedDB snapshot 损坏和本地缓存清除。
- 记录恢复后的文件内容、Workspace revision、operation 状态和 Session 事实。
- 真实 Chrome 作为本批次主验收环境；Safari/WebKit 延后，不用一次 OPFS 探针代替完整浏览器兼容性结论。

## 明确边界

- 本批次不实现完整 OPFS-backed Node 文件系统；OPFS 是 durable bytes store，`MemoryVfs` 仍是运行时文件系统。
- 本批次不宣称 post-commit `VfsMutationSink` 已经提供 journal-first 原子性；必须在进度和验收中记录 VFS commit 与 local snapshot commit 之间的剩余窗口。
- 本批次不实现 chunk-level delta、VCDIFF、CRDT、生产对象存储、真实租户授权或多标签 writer lease。
- 页面关闭后没有 Service Worker/background Agent 语义；页面生命周期结束前只能尽力完成本地 snapshot，未落盘的内存 mutation 仍需明确标记为未恢复。

## 退出条件

- M1/M2 有单测覆盖 snapshot round-trip、pending 恢复、retry operationId 和损坏拒绝。
- M3 至少有真实 Chrome Worker/DSH 工具闭环或明确记录无法自动化的部分。
- M4 的每个故障都有可观察状态和恢复动作，没有把 pending/unknown 写成 cloud committed。
- README、progress、change-ledger 和本批次结果文档均记录实际命令、结果、限制和后续工作。
