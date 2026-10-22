---
description: "规划 Browser-Native DSH 下一批 Chrome 验证：离线期间的本地 outbox 恢复、并发远端更新冲突保留，以及过期 Workspace writer lease 的安全接管。"
---

# Browser-Native DSH 进阶恢复验证计划

## Summary

本批次继续验证 Browser-Native DSH 的浏览器本地文件状态与同源 Workspace backend 如何在离线、并发和租约失效时协同，不扩展 SaaS 联动或聊天 UI。重点从“Worker 能否重建”推进到“浏览器离线时是否保留已落本地的写入、远端版本变化时是否明确拒绝覆盖、旧标签页失去租约后是否不能复活为写者”。所有自动化使用真实 Chrome、Dedicated Worker、DSH Host 与 scripted LLM；协议故障不依赖真实模型。

## 验证点

### P1：离线写入与重连恢复

- Worker 和 durable Workspace 完成初始化后，将 Chrome context 切换为 offline，再通过真实 Worker 的 DSH VFS 写入文件。
- 等待 OPFS/IndexedDB 本地状态明确保存，确认写操作存在于 retry/outbox、远端 manifest 未变化，页面没有报告 `synced`。
- 恢复网络并刷新页面，让新的 Worker 从远端基线与本地 retry 状态重建；确认同一 `operationId` 最终只提交一次、文件内容/hash 一致且本地 dirty/outbox 清空。
- 若当前实现不能在网络失败时确认本地快照已 durable，记录并修复状态报告或写入顺序，不得把内存 VFS 写入称为已保存。

### P2：本地 retry 遇到远端并发更新

- 让本地变更持久化到 durable retry batch，并阻断首次提交。
- 使用第二个同源客户端基于相同远端 revision 提交同一路径的不同内容，制造真实 CAS 竞争。
- 刷新第一个客户端，验证旧 `baseRevision` 被 backend 拒绝后页面显示 conflict，而不是 synced；本地版本仍可从 VFS/OPFS 读取，远端仍保留第二个客户端提交的版本。
- 确认 retry batch 与 operation identity 保留供显式恢复；系统不执行 last-write-wins、不自动覆盖远端，也不静默丢弃本地 bytes。

### P3：writer lease 过期、接管与旧标签页恢复

- 通过 backend 测试配置缩短 lease TTL；首个真实 Worker 获得写权后被强制终止，停止续租但保留该标签页的 `sessionStorage` 恢复凭据。
- 等待租约过期，由第二标签页取得新 fencing token；随后刷新旧标签页，验证旧凭据 resume 被拒、旧标签不能覆盖或续租新租约。
- 第二标签页持有租约时，旧标签页不得静默 claim 写权；第二标签释放后，旧标签页可在重新加载时走新的 claim，并取得更高 epoch。
- 保留真实 `requestId`、`resumeId`、writer token/fencing token 与 backend 状态作为断言证据；测试只在 PoC 中调整租约时长，不改变生产 DSH API。

## 实施范围

- 新增三个真实 Chrome E2E 和必要的 PoC backend 测试配置；不修改正式 Agent Loop、Session 格式、Workspace API 或默认 profile。
- 仅当 E2E 暴露错误恢复/状态语义时，才对 PoC Worker/backend 做最小修复，并在 `change-ledger.md` 记录。
- 真实浏览器 quota/eviction、OS 级浏览器进程崩溃和 Safari/WebKit 不纳入本批验收；不能用 Playwright 网络离线模拟冒充这些环境故障。
- 当前 `MemoryVfs` mutation sink 是同步 post-commit observer；本批不能据此宣称消除了 mutation 到本地 durable snapshot 之间的崩溃窗口。所有断言只对已确认写入本地 durable store 的 retry batch 作恢复承诺。

## 退出条件

- 离线期间 retry batch 和 OPFS blob 可从真实 Worker/浏览器存储读取，网络恢复刷新后按原 `operationId` 成功提交且仅一次。
- 并发修改产生明确 conflict；本地版本可读并保留，远端版本不被覆盖，状态不会显示 synced。
- lease 过期后 fencing 阻止旧 Worker/标签页写入；租约持有者释放后，恢复标签页只能通过新 claim 获取新 epoch。
- 三项脚本记录 Chrome、operation/revision/fencing 结果、page errors 和跨源请求；更新 README、进度、change-ledger 与 `docs/drafts` 索引。
