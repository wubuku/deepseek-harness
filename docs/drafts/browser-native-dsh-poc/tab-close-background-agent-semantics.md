---
description: "定义并验证标签页关闭时 Dedicated Worker、Session 控制权、Workspace writer lease 与在途 turn 的去向，给出无后台续跑、无残留写入和恢复结算的证据。"
---

# 标签页关闭后的后台 Agent 语义

## Summary

[tab-close-during-tool.e2e.mjs](tests/tab-close-during-tool.e2e.mjs) 在真实 DSH turn 执行 `bash sleep 8` 期间关闭标签，证明：Dedicated Worker 随页面终止，没有后台 Agent 接管或挂起续跑；Session 与 Workspace writer lease 在 pagehide 阶段释放，存活标签在 TTL 到期前接管并取得新 fencing token；已关闭标签不再追加 Session event、不再请求模型、延迟工具写入永不落地；下一次拥有者打开时，未完成工具恰好结算一次为 `TOOL_OUTCOME_UNKNOWN`，turn 恰好结算一次为 `interrupted`，不重放也不自动续跑。

## 语义决策

| 问题 | 决定 | 理由 |
| --- | --- | --- |
| 标签关闭后 Agent 继续、挂起还是回收 | 回收。Worker 是唯一执行者，关闭页面即终止执行，不提供后台 Agent 或 Service Worker 续跑 | 浏览器 Dedicated Worker 没有独立生命周期；声称“后台继续”会产生无法在 Session 日志中证明的副作用。durable Session 是事实来源，恢复必须是显式的重新打开。 |
| Session 控制权何时释放 | pagehide 屏障尽力释放；失败时按 `ownerLeaseMs` 到期 | 正常关闭必须让存活标签快速接管；进程级消失只能靠租约超时兜底。 |
| Workspace writer lease 何时释放 | pagehide 屏障尽力释放；失败时按 `workspaceWriterLeaseMs` 到期 | 与 Session 控制权同步，避免关闭标签继续占写权限；新标签必须获得新 fencing token。 |
| 在途 turn 如何收尾 | 不在关闭时伪造终态；下一次拥有者打开时把开放工具结算为 `TOOL_OUTCOME_UNKNOWN`，把开放 turn 结算为 `interrupted` | 关闭标签没有机会写终态；由新拥有者在恢复路径上一次性结算，避免重复结果和自动重放。 |
| 延迟工具副作用是否可能后到 | 不。Worker 终止后工具执行停止，延迟写入不会落地；Workspace revision 不变 | 落地的迟到写入会破坏“日志没有结果但文件已改变”的一致性。测试把工具睡眠跨越关闭窗口来验证该不变量。 |
| 恢复后是否重试未完成 turn | 不。用户必须显式发送新 prompt；恢复只结算开放调用，不重新请求模型 | 与 open-tool fork 及 Session outbox 语义一致。 |

## 实现

| 位置 | 变更 |
| --- | --- |
| [tab-close-during-tool.e2e.mjs](tests/tab-close-during-tool.e2e.mjs) | 新增双标签 harness：owner 执行慢工具时关闭页面，存活克隆标签在 pagehide 后 reload 接管；断言 Session event 数、工具结果、turn 终态、模型请求数、Workspace revision、延迟写入和接管 lease。 |
| [backend-v2.mjs](backend-v2.mjs) | 新增 `BROWSER_NATIVE_TAB_CLOSE_DURING_TOOL_E2E` scripted 规则，返回 8 秒延迟后再写入 Workspace 的 `bash` 调用，使关闭窗口覆盖工具执行期。 |

未修改 Worker 生命周期、Session 恢复或 lease 产品代码；本批定义语义并补充证据。

## 证据

运行：

```sh
node docs/drafts/browser-native-dsh-poc/tests/tab-close-during-tool.e2e.mjs
```

Chrome 156.0.8078.79 输出摘要：

```json
{"result":"passed","takeoverAfterMs":2949,"leaseDurationMs":5000,"takeoverReleasedBeforeTtl":true,
 "takeoverLease":{"fencingToken":2,"accessMode":"writer","state":"active"},
 "sessionEventsAtClose":26,"sessionEventsOneSecondAfterClose":26,"eventsBetweenCloseAndTakeover":0,
 "toolCompletedAfterClose":false,"turnEndedAfterClose":false,"interruptedToolOutcome":"TOOL_OUTCOME_UNKNOWN",
 "modelRequestsAfterClose":0,"residualWrites":0,"workspaceRevisionBeforeClose":0,"workspaceRevisionAfterTakeover":0,
 "interruptedTurnSettled":"interrupted","continuationCompleted":true,
 "pageErrors":[],"externalRequests":[]}
```

- 关闭后 1 秒 Session event 数不变（26→26），关闭到接管之间新增 0 个事件。
- 延迟工具在 8 秒后仍未写入 `tab-close-residual.txt`，Workspace revision 保持 0；关闭后模型请求数不增。
- 接管在 2949 ms 内完成，小于 5000 ms TTL，说明 pagehide 释放了 Session 控制权与 writer lease；接管 lease 为 `fencingToken=2`。
- 接管后旧工具调用恰好 1 条 `TOOL_OUTCOME_UNKNOWN` 结果，旧 turn 恰好 1 条 `interrupted` 终态；随后新 prompt 正常完成。

## 限制

只覆盖 Chrome 156 中 Playwright `page.close()`（仍触发 pagehide 屏障）与 5 秒测试 TTL，scripted LLM 和 single-instance PoC backend。未覆盖进程被强杀、浏览器崩溃、OS 休眠、pagehide 超时后后台写回、真实模型在途工具、多实例 backend 接管、Safari/WebKit，以及关闭后由 Service Worker 或其他设备继续执行的产品形态。
