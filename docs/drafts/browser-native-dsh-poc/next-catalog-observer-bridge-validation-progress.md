---
description: "记录 Browser-Native DSH 会话目录、只读观察、handoff 幂等和载荷预算验证的实施证据与限制。"
---

# Browser-Native DSH 会话目录与观察交接验证进度

## 当前状态

状态：M1–M4 的 PoC 验证已完成，文档和回归检查收尾中。本批直接在 `research` 主工作区实施；工作区开始时已有 Browser-Native 与 `dsh-TUI` 参考文档 WIP，未清理无关修改。

后续复核表明，原 M1 只证明同一 `handoffId` 不重复提升 epoch 和 rename 前 flush 失败回滚；它未证明凭据不泄露，也未测试 rename 后失败。原结论的安全含义由新的[handoff 安全与恢复验证](next-handoff-security-and-recovery-progress.md)取代，catalog、observer 和载荷测试结果不受影响。

## 里程碑

| 里程碑 | 状态 | 证据 | 下一步 |
| --- | --- | --- | --- |
| M0：候选范围与设计 | `complete` | 计划文档和 TUI 源码阅读 | 实施 M1 |
| M1：原始 handoff 幂等与安全点 | `superseded` | backend 合同测试通过，但只覆盖 receipt 重放和 rename 前失败；未验证 bearer 凭据隔离或 unknown durability | 以新的 handoff 安全与恢复验证为准 |
| M2：Session catalog 分页 | `complete` | backend 合同测试覆盖稳定 id cursor、页边界和无效 cursor | 后续若接入真实目录 UI，再验证 stale/incomplete 呈现 |
| M3：多观察者单写者 | `complete` | `session-observers.e2e.mjs` 真实 Chrome 双页面通过；观察者可读追加事件但 append 返回 409 | 保持 observer 与 owner 协议分离 |
| M4：跨边界载荷预算 | `complete` | backend 合同测试覆盖 append 字节预算和 read 页大小上限；超限显式拒绝 | 后续另行设计 blob 引用/工具结果分页 |
| M5：回归、文档和提交 | `complete` | README、兼容矩阵、目录索引与 change ledger 已更新；相关 backend/Chrome 回归及 docs quick/doc-sync 通过 | handoff 凭据安全与 unknown durability 的后续结论见新验证记录 |

## 证据边界

- 当前计划中的 handoff、catalog、observer 和 payload 结论在实现与测试完成前均为未验证设计。
- 真实 LLM 不适合证明幂等、分页或载荷拒绝；本批优先使用真实 backend、Dedicated Worker 和确定性故障注入。
- 本批不验证跨主机 HA、自然 eviction、OS crash、生产对象存储、云端 Durable Worker 或页面关闭后的后台执行。
- `handoffId` 只在当前 PoC Session JSON store 中提供幂等 receipt；backend 重启可以重建已落盘 receipt，但新执行者仍需重新 `open(access=write)` 取得当前有效 owner。
- Session catalog 使用排序后的 id cursor，不是跨设备变更 feed；`read` 的 owner epoch 和 durable cursor 是诊断元数据，不授予观察者写权。
- 载荷预算验证的是 PoC backend 的 JSON 请求/响应边界，不是模型上下文预算、浏览器 heap SLA 或大工具结果 blob 引用协议。

## 已运行命令

| 命令 | 结果 |
| --- | --- |
| `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs` | 30/30 通过；包含 handoff 幂等重试、重启后 receipt 重放、flush 失败恢复、分页、载荷预算和已有 Workspace/LLM 回归。 |
| `DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/session-observers.e2e.mjs` | 真实 Chrome 双页面通过；observer 看到 `nextSeq=2`，无 owner token 的 append 返回 409 `SESSION_OWNERSHIP_LOST`。 |

上一批命令和证据见[上一批进度记录](next-session-adapter-and-handoff-validation-progress.md)。

## Dev Note

本批实现仍属于 PoC-local backend 和页面测试；不得把它写成多实例 HA、生产 Session query service、跨存储事务或页面关闭后的后台 Agent。
