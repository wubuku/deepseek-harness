---
description: "Browser-Native DSH 下一批高价值 PoC 验证计划，聚焦 durable Workspace 故障、并发写权、Session 协调和文件能力。"
---

# Browser-Native DSH 高价值验证计划

## Summary

本批次不扩展 SaaS 或聊天 UI，优先验证 Browser-Native DSH 在浏览器 Worker 中保持文件状态和 Session 事实的能力。

当前已通过一次 `commit 503 → 刷新 → 同一 operationId 重试`，但还没有覆盖上传失败、commit 结果未知、多标签页写权、跨存储 receipt 和完整文件操作矩阵。

本批次分为四个验证面：

1. **故障矩阵**：上传失败、commit 响应丢失和幂等查询不能丢失或重复提交。
2. **并发写权**：两个浏览器 Worker 不能静默覆盖同一 Workspace；旧 writer 迟到后必须被 fencing 拒绝。
3. **Session/Workspace 协调**：验证 Workspace receipt 能否与 Session event 关联，并记录尚未接入 Agent Loop 的缺口。
4. **文件能力矩阵**：验证 Worker VFS 对 DSH 常用读写、append、rename、remove、stat、list、chmod、二进制和 atomic-write staging 的行为。

## 退出条件

- 模型无关的真实 Chrome E2E 通过上传失败和 commit unknown 两种恢复路径。
- Workspace writer lease 具备 claim、renew、release、fencing 和迟到 writer 拒绝测试。
- Session/Workspace receipt 协调测试明确成功、pending、unknown 和冲突四种状态；未接入的生产路径不能被宣称为已完成。
- 文件能力矩阵对每个操作给出 `通过`、`明确不支持` 或 `未验证`，并保留 Session/Workspace 证据边界。
- 更新 README、进度、变更账本和总索引；所有真实运行命令和限制留档。

## 非目标

- 不实现 chunk-level delta、CRDT 或多用户实时协同。
- 不把 Dedicated Worker 宣称为页面关闭后的后台 Agent。
- 不把本地 JSON backend 宣称为生产云存储或 HA 服务。
- 不使用真实 LLM 证明可由模型无关故障测试证明的协议语义。
