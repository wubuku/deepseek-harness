---
description: "规划 Browser-Native DSH 本地持久化失败后的 Agent 文件状态隔离与 Worker 重建恢复验证。"
---

# Browser-Native DSH 易失文件状态隔离验证计划

## Summary

本批验证真实 DSH 文件工具在 OPFS/IndexedDB 本地持久化失败后，是否会继续把只存在于 Worker 内存的文件内容提供给 Agent，以及 Worker 重建后能否恢复最后确认的文件并在同一 Session 安全重试。重点是维护“工具报错、文件当前可读、文件已持久化”这三者之间的区别，不把内存可见误报为持久化成功。

## 验证点

### P1：Agent 文件工具隔离未确认的本地变更

- 先在真实 Chrome Worker 中建立一个已本地持久化、已云端提交的文件基线。
- 让真实 DSH `edit` 工具修改文件，并对多次 IndexedDB metadata transaction 注入 abort，确保无法在测试窗口内静默恢复。
- 验证 `edit` 的 Session 工具结果为错误，随后同一 Agent turn 的 `read`、`grep` 和 `write` 不得把内存中的未确认内容作为普通成功结果或继续修改它。
- 通过仅供测试的 VFS 观察口确认故障后内存可能仍包含编辑结果；同时确认 OPFS/IndexedDB durable 状态及远端 manifest 没有确认该修改。

### P2：Worker 重建与同 Session 安全重试

- 在本地持久化失败后刷新页面，终止旧 Dedicated Worker；新的 Worker 必须从最近确认的 Workspace 状态启动，而不是继承或声称恢复易失变更。
- 验证失败 `edit` 的 Session 事件仍保留为错误，重开同一 Session 不重放其工具副作用。
- 对相同文件修改发起新的、显式的同 Session 重试；解除故障后确认本地 durable 状态先于云端 commit，最终仅新增一次 revision 和与重试 call 关联的一条 receipt。
- 对比失败和重试的 tool call id、Workspace operation id、Session 事件和 manifest，说明失败操作与新重试不是同一副作用的隐式重放。

## 实施范围

- 新增 PoC 专用的持久化事务故障计数及真实 Chrome Agent E2E；不修改正式 DSH Agent Loop、Session 格式或正式文件工具。
- 先运行 E2E 复现 Agent 在持久化失败后的行为；若 `read` 仍暴露未确认内容，则仅在 Browser-Native PoC provider 中增加 fail-closed 文件工具保护，并用该 E2E 验收。
- 覆盖标准 Browser-Native roster 中实际启用的 `read`、`write`、`edit`、`grep` 和 `glob`；不假定 rename、append 或其他未启用工具是模型可调用能力。
- 使用真实 Chrome、Dedicated Worker、OPFS、IndexedDB、DSH Host/Agent Loop 和 scripted LLM；不依赖上游模型服务。

## 退出条件

- 故障期间，Agent 收到持久化失败后不能通过后续文件读写或搜索工具读取、发现或继续修改未确认的 Workspace 内存状态。
- 刷新后，Workspace 恢复到最近已确认的本地/远端基线；失败操作没有被写成成功或自动重放。
- 显式同 Session 重试成功后，Session tool result、Workspace receipt、OPFS/IndexedDB、manifest revision 和文件内容一致，且 commit 只发生一次。
- 保留真实 Chrome 命令、Session/Workspace 证据、故障注入范围和限制；更新 PoC README、进度、变更清单与 drafts 索引。

## 限制

- 重复 `IDBTransaction.abort()` 是确定性的故障注入，不等价于真实磁盘耗尽、浏览器 eviction、浏览器进程崩溃或设备断电。
- 页面刷新验证 Dedicated Worker 被销毁并重建，不证明页面关闭后 Agent 继续运行。
- scripted LLM 验证工具与 Session 协议，不代表真实模型会选择相同工具或生成相同恢复话术。
