---
description: "规划验证 Browser-Native DSH 文件工具是否会把本地 durable 写入失败误报为成功，并验证同会话重试恢复。"
---

# Browser-Native DSH 文件工具持久化确认验证计划

## Summary

本批验证 DSH 文件工具的成功结果是否严格晚于浏览器本地 durable Workspace 保存。当前 PoC 的 `tools/execute` 包装器调用 `flushWorkspace()` 后捕获所有错误并仍返回原工具结果；这可能把 IndexedDB snapshot 失败表现成工具成功。实现将区分本地持久化失败与远端同步失败：本地保存失败不得返回成功工具结果，远端暂时未同步但本地已 durable 时仍可保留本地操作并报告待同步状态。

## 验证点

### P1：真实 DSH 写工具遇到本地保存失败

- 使用真实 Chrome、Dedicated Worker、Browser-Native DSH Agent Loop 和 scripted LLM；通过现有测试 MessagePort 注入一次 IndexedDB transaction abort。
- 让 Agent 调用真实 `write` 工具，检查 Session 中该调用的 `tool/result` 是否为错误，错误信息是否表明本地 Workspace 持久化未确认。
- 确认该失败工具调用没有产生 Workspace commit 或成功 receipt；Worker 内存可能仍含有写入，不能把它说成已回滚。

### P2：Worker 重建后的同会话显式重试与持久化恢复

- 第一次工具结果失败后刷新页面，重建 Worker 并确认恢复到最后一个 durable Workspace 状态；再由用户在同一 Session 重新提出相同幂等 `write` 操作。
- 验证第二次写入先完成本地 OPFS/IndexedDB 持久化，再完成一次远端 commit 和 Session receipt。
- 刷新后检查文件内容、manifest revision、receipt 和 commit 计数；不得重放已完成的操作。

## 实施范围

- 只修改 `docs/drafts/browser-native-dsh-poc/` 内的 PoC provider、scripted backend、E2E 与文档。
- 复用 `flushLocalWorkspace()` 和已有 IndexedDB abort 测试 hook；不修改正式 `MemoryVfs`、Agent Loop、Session format 或默认 Web profile。
- 将本地 durable 保存与云端 Workspace commit 分别处理。不得把远端网络失败一概转换成文件工具失败，也不得把本地持久化失败仅记录为日志。

## 退出条件

- IndexedDB abort 后，真实 DSH `write` 的 Session 工具结果为错误，且没有远端 commit/成功 receipt。
- Worker 重建后，同 Session 用户重试使本地 durable snapshot、远端 manifest 和 Session receipt 一致，commit 恰好一次，后续刷新无副作用重放。
- 记录真实 Chrome 命令、Session 事件、OPFS/IndexedDB、manifest 与工具执行证据；明确这是注入式事务失败，不是浏览器真实 quota exhaustion 或 OS 级崩溃。
- 更新 PoC README、进度、change ledger 和 drafts 索引；不提交或推送。
