---
description: "规划 Browser-Native DSH 下一批 Chrome 验证：本地缓存清除后的云端重建、Agent edit receipt 和支持响应丢失重试的 Workspace writer lease 刷新恢复。"
---

# Browser-Native DSH 下一批验证计划

## Summary

本批验证的重点是确认 Browser-Native DSH 在常见的浏览器恢复路径中不会把本地缓存误当成权威数据：已提交 Workspace 的 OPFS/IndexedDB 缓存被清除后，Worker 必须从同源 backend 重建；Agent 连续执行 `write`、`read`、`edit` 和第二次 `write` 时，Session receipt 必须准确关联每次实际修改；启用 Workspace writer lease 时，同一标签页刷新应安全恢复写权并使旧 fencing token 失效。

本轮使用真实 Chrome 和 scripted LLM，不依赖上游模型可用性。测试只验证浏览器 Worker、DSH Agent Loop、PoC backend 和现有 Session/Workspace 协议，不扩展 SaaS 集成或聊天 UI。

## 验证范围

### P1-1：清除本地缓存后从远端重建

- 在真实 Worker 中写入并提交一个 Workspace 文件，记录远端 revision、blob hash 和内容。
- 关闭页面以终止 Worker；清除该 origin 的 OPFS 与 PoC IndexedDB 数据，但保留同源身份 cookie 和 backend `dataDir`。
- 重新打开同一 Browser-Native 入口，确认新 Worker 从远端 manifest/blob 重建文件，内容与 hash 一致，状态为已同步，且没有额外 Workspace commit。
- 该测试模拟“本地缓存完全丢失、云端已有完整提交”，不宣称能从完整 origin 清除中恢复尚未提交的本地 dirty/outbox 数据。

### P1-2：Agent edit 与多次文件变更的 receipt 关联

- 用 scripted LLM 驱动真实 DSH Agent Loop 按序执行 `write → read → edit → write`，覆盖同一 turn 内的多次修改与多路径结果。
- 每个修改工具调用必须有唯一的 `callId`、`operationId` 和同一 Session 内的 PoC receipt；只读 `read` 不得产生 Workspace commit 或 mutation receipt。
- 核对最终 VFS、远端 manifest、Workspace operation receipt、Session tool events 和 `browser-native/workspace-receipt` 内容一致。
- 刷新并读取同一 Session 后，不得重复工具副作用、Workspace commit 或 Session receipt。

### P1-3：同一标签页刷新时恢复 Workspace writer lease

- 在启用 Workspace lease 的真实 Chrome 页面获取 lease，刷新同一标签页并复用 tab-scoped `sessionStorage` 中的恢复凭据。
- 若凭据来自旧版页面、尚无 `resumeId`，页面先生成并持久化该 ID，再向 Worker 发送 lease 恢复消息。
- backend 原子轮换 writer token/fencing token；刷新后的 Worker 可继续写入，旧 Worker/旧 token 的 renew 和 commit 必须被拒绝。
- 故意让 backend 完成一次 resume 后丢弃响应；刷新后的 Worker 必须用同一个稳定 `resumeId` 重试并取得同一 lease，不能重复提升 fencing token，也不能因 unknown response 把有效 lease 遗失。
- 第二个未持有恢复凭据的标签页在 lease 有效时仍不得获得写权。
- 若恢复凭据缺失或已失效，系统必须走显式 claim/冲突路径，不得绕过 fencing 或把 stale writer 当作有效写者。

## 实施边界

- 仅修改 Browser-Native PoC backend、Worker/page 控制、测试和 `docs/drafts/` 文档；不修改正式 Agent Loop、Session 格式或正式 Workspace API。
- lease 恢复凭据只在同源页面与 Worker 之间传递，存于当前标签页 `sessionStorage`；服务端恢复操作须旋转 token 并提升 fencing epoch，避免旧 worker 继续写入。
- OPFS/IndexedDB 完全清除后的本地未提交数据没有可重建副本。本批明确测试云端已提交数据的恢复，不伪称解决该数据丢失场景。
- 真实浏览器 quota exhaustion、浏览器自动 eviction 策略和操作系统级浏览器进程崩溃不属于本轮通过条件；它们需要单独、可重复的注入环境。

## 退出条件

- 三项均有可直接运行的真实 Chrome E2E，并保留结构化输出。
- 清除 OPFS/IndexedDB 后，已提交文件从 backend 重建且没有多余 commit。
- Agent `edit` 与连续文件变更能按 Session tool-call 身份去重并恢复。
- 刷新后新 lease 可写，旧 token 被 fencing 拒绝，第二标签页冲突语义仍成立。
- resume 响应丢失后以同一 `resumeId` 重试，backend 返回原 lease 且 fencing epoch 仅提升一次。
- README、progress、change-ledger 和 drafts 索引均记录命令、结果、限制及 browser evidence 等级。
