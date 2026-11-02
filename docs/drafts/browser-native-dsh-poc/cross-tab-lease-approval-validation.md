---
description: "定义并验证 Session 归属与 Workspace writer lease 同时开启时的审批语义：控制权属于 Session 拥有者，写入权属于 lease 持有者，二者正交且交接不重放。"
---

# 跨标签 lease 与审批组合验证

## Summary

双页 harness [cross-tab-lease-approval.e2e.mjs](tests/cross-tab-lease-approval.e2e.mjs) 在同一个 PoC 中同时开启 durable Session、审批与 Workspace writer lease，证明两类权威各自唯一、互不越权：只有 Session 拥有者能结算审批，只有 writer lease 持有者能提交 Workspace 变更。lease 持有者可以位于后台标签并完成审批；并发前台标签不触达后端、不显示可操作卡片、不持有 writer token；拥有者关闭后，接管的标签取得新的 fencing token，待决审批只结算一次为 `TOOL_OUTCOME_UNKNOWN`，且不重放工具或改写 Workspace。

## 语义决策

| 问题 | 决定 | 理由 |
| --- | --- | --- |
| 审批决策权与 Workspace 写入权是否同一权威 | 否。审批权属于 Session recovery lock 拥有者；写入权属于 Workspace writer lease 持有者 | 两个锁的保护对象不同：前者防止重复结算运行中 Worker 的 HITL，后者防止并发提交 Workspace revision。合并会迫使观察者或过期 lease 持有者获得副作用权限。 |
| lease 持有者在后台时能否审批 | 能。审批 UI 操作不要求页面可见 | 审批是 Session 控制面操作；后台标签仍持有 Session 锁，且 Worker lease 心跳继续。 |
| 前台并发标签能否审批或写入 | 不能。必须在触达后端前失败关闭，且不获得 writer token | 重新打开同一 Session 会先被 Session recovery lock 拒绝；即使绕过，Workspace lease 也会拒绝第二个 writer。 |
| 审批通过后由谁执行写入 | 由 Session 拥有者标签的 Worker 执行，并使用它当前持有的 writer lease | 工具执行和 Workspace mutation 发生在同一 Worker；若 lease 已丢失，写入必须失败而不是借用其他标签的租约。 |
| 拥有者关闭后的 lease 与审批 | 新标签 reload 接管 Session 并取得新 fencing token；待决审批结算为未知，不重问、不重放 | 与既有 open tool fork 语义一致；旧 Worker 的未完成副作用不可安全恢复。 |
| 观察者标签是否可能产生审批 | 当前不能：observer 工具集只有 `read`/`grep`/`glob`，没有需要审批的写工具 | 因此“非 lease 持有者审批写工具”的组合在当前工具 schema 下不可构造；若未来为 observer 开放写工具审批，仍须先做 durable 原子 claim 并由 writer lease 执行。 |

## 实现

| 位置 | 变更 |
| --- | --- |
| [cross-tab-lease-approval.e2e.mjs](tests/cross-tab-lease-approval.e2e.mjs) | 新增双页 harness：启用 `browser-native-workspace-lease=1` 与 `approval-integrity`，断言 owner/duplicate 的 `lease-info`、后台审批、Workspace revision、接管后的新 fencing token 与审批投影。 |
| [backend-v2.mjs](backend-v2.mjs) | 审批 fixture 的写路径改为 `/dsh/home/workspace/approval-result.txt` 与 `approval-recovery-result.txt`，使获批分支产生可观察的 Workspace commit；拒绝或中断分支仍不写文件。 |

未修改 Workspace 或审批结算产品代码；本批验证既有语义并补充组合态证据。

## 证据

运行：

```sh
node docs/drafts/browser-native-dsh-poc/tests/cross-tab-lease-approval.e2e.mjs
```

Chrome 156.0.8078.79 输出摘要：

```json
{"result":"passed","concurrentTabState":"recovery-conflict","concurrentTabBackendRequests":0,"concurrentTabWriterLease":false,
 "ownerLease":{"fencingToken":1,"accessMode":"writer","state":"active"},"approvedWhileOwnerBackground":true,
 "approvalFileWritten":true,"workspaceRevisionAfterApproval":1,"decisions":1,"requests":2,
 "interruptedOutcome":"TOOL_OUTCOME_UNKNOWN","interruptedToolExecuted":false,
 "takeoverLease":{"fencingToken":2,"accessMode":"writer","state":"active"},"recoveredPromptCompleted":true,
 "pageErrors":[],"workerErrors":[],"externalRequests":[]}
```

- 并发前台标签：`recovery-conflict`，0 个后端请求，`lease-info.ok=false`，writer token 不等于 owner。
- 后台 owner 仍 `state=active`、`renewalScheduled=true`；审批恰好 1 次 `approval/asked`、1 次 `approval/decided`，工具结果非错误，Workspace revision 从 0 到 1。
- owner 关闭后接管：新 `fencingToken=2`；待决审批结果 `TOOL_OUTCOME_UNKNOWN`、未执行工具、Workspace revision 不变、无新模型请求、后续 prompt 完成。

回归：`permission-approval-lifecycle.e2e.mjs`、`cross-tab-approval.e2e.mjs`、`approval-integrity-recovery.e2e.mjs` 均通过。

## 限制

只覆盖 Chrome 156 同 BrowserContext 的 `window.open` 克隆标签、durable Session、scripted 审批和 single-instance PoC backend。未覆盖真实模型审批、observer 写工具审批、lease TTL 到期与审批待决重叠、跨设备接管、Safari/WebKit、浏览器崩溃或 OS 挂起。
