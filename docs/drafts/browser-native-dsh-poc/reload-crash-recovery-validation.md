---
description: "验证页面刷新与 Dedicated Worker 崩溃期间存在在途 turn 时的 hydrate 一致性、工具不重复执行与结算不丢失，并给出与标签页关闭语义的差异。"
---

# 刷新与 Worker 崩溃时的在途 turn 恢复

## Summary

[reload-during-tool.e2e.mjs](tests/reload-during-tool.e2e.mjs) 在真实 DSH turn 执行 `bash sleep 8` 期间刷新页面，证明刷新后的 Worker 在同一文档内自动恢复同一 Session，持久化事件前缀逐字节不变，只追加 `tool/result`、`step/end`、`turn/end` 三个 closer 与一个 `session/end-seed`，不重放工具调用、不重发模型请求、不让延迟写入落地，并能在同一 Session 继续下一轮。

[worker-crash-during-tool.e2e.mjs](tests/worker-crash-during-tool.e2e.mjs) 用 CDP 在 Worker target 内执行 `self.close()` 制造真正的 Worker 崩溃（不触发 pagehide）：崩溃后 1 秒内 Session event 数不变，刷新后以 `ownerEpoch` 与 writer fencing token 各递增一次完成恢复，同样只结算一次。

两者共同给出与[标签页关闭](tab-close-background-agent-semantics.md)的差异：刷新和 Worker 崩溃都能在同一页面重新挂载并结算；关闭标签没有自动重开路径，Session 与 Workspace 由 pagehide 释放或 TTL 兜底，结算发生在下一次拥有者打开 Session 时。

## 语义决策

| 问题 | 决定 | 理由 |
| --- | --- | --- |
| 刷新是否恢复在途 turn | 恢复 Session 与文档，但不继续 turn；开放 turn 结算为 `interrupted` | Worker 已随旧文档销毁，工具执行不可复活；恢复必须依据持久化日志一次性收尾，避免重放有副作用的工具。 |
| 刷新后的结算时机 | 挂载时立即结算，不等待用户新 prompt | Session 恢复路径（`agentLoop.resume` → `interruptedTurnClosers`）在 hydrate 时追加 closer；等待新 prompt 会让 Session 长时间处于半开状态。 |
| 历史事件是否重写 | 不重写。已持久化前缀保持相同 seq、类型与内容，只追加 closer | hydrate 是读取加尾追加，不是重新投影；改写前缀会破坏跨请求读取与审计。 |
| 是否重放未完成工具 | 不重放。工具结果以 `TOOL_OUTCOME_UNKNOWN` 结算，并提示模型按工具语义决定是否重试 | 崩溃时副作用是否已发生未知；自动重试可能重复写入。 |
| Worker 崩溃与页面刷新是否等价 | 恢复路径等价，租约路径不等价：崩溃不触发 pagehide，旧 owner 记录保留到新页面用 recovery record 接管 | 刷新是正常页面生命周期，可主动释放；Worker 崩溃只能依靠 recovery record 或 TTL。 |
| 关闭标签是否与刷新等价 | 不等价。关闭没有自动重开；刷新自动重新打开同一 Session | 产品语义上“刷新应恢复”“关页应终止”，本批证据支持该区分。 |
| 延迟工具副作用 | 刷新与崩溃都不得落地；Workspace revision 不变 | 否则日志记录“结果未知”但文件已改变，恢复后无法判断外部状态。 |

## 实现

| 位置 | 变更 |
| --- | --- |
| [reload-during-tool.e2e.mjs](tests/reload-during-tool.e2e.mjs) | 新增刷新 harness：慢工具执行中 reload，断言 hydrate 前缀、closer 集合、工具与 turn 结算次数、模型请求数、延迟写入、Workspace revision、UI 投影与后续 turn。 |
| [worker-crash-during-tool.e2e.mjs](tests/worker-crash-during-tool.e2e.mjs) | 新增 Worker 崩溃 harness：通过 CDP `Target.attachToTarget` + `Runtime.evaluate('self.close()')` 终止 Dedicated Worker，绕过 pagehide；断言崩溃后无写入、恢复后 `ownerEpoch` 与 fencing token 各增加一次。 |
| [backend-v2.mjs](backend-v2.mjs) | 新增 `BROWSER_NATIVE_RELOAD_DURING_TOOL_E2E` 慢工具规则与 `BROWSER_NATIVE_RELOAD_CONTINUE_E2E` 后续轮规则。 |

未修改 Worker 恢复、Session 结算或 lease 产品代码；本批只补充语义与证据。

## 证据

运行：

```sh
node docs/drafts/browser-native-dsh-poc/tests/reload-during-tool.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/worker-crash-during-tool.e2e.mjs
```

Chrome 156.0.8078.79 输出摘要：

```json
{"result":"passed","scope":"reload-during-tool-execution","settleAfterReloadMs":2083,
 "leaseDurationMs":5000,"settledBeforeTtl":true,
 "leaseAfterReload":{"fencingToken":2,"accessMode":"writer","state":"active"},
 "sessionEventsBeforeReload":26,"sessionEventsAfterSettlement":30,
 "appendedCloserEvents":["tool/result","step/end","turn/end"],"hydrateSeedEvents":1,
 "persistedPrefixIdentical":true,"interruptedToolOutcome":"TOOL_OUTCOME_UNKNOWN",
 "interruptedTurnSettled":"interrupted","modelRequestsDuringSettlement":0,
 "replayedToolCallEvents":0,"residualWrites":0,
 "workspaceRevisionBeforeReload":0,"workspaceRevisionAfterSettlement":0,
 "projectedAssistantTextOccurrences":1,"continuationCompleted":true}
```

```json
{"result":"passed","scope":"worker-crash-during-tool-execution","crashToSettlementMs":2959,
 "settleAfterReloadMs":1956,"leaseDurationMs":5000,"settledBeforeTtl":true,
 "sessionEventsBeforeCrash":26,"sessionEventsOneSecondAfterCrash":26,
 "sessionEventsAfterSettlement":30,
 "appendedCloserEvents":["tool/result","step/end","turn/end"],
 "ownerEpochBeforeCrash":1,"ownerEpochAfterRecovery":2,
 "fencingTokenBeforeCrash":1,"fencingTokenAfterRecovery":2,
 "persistedPrefixIdentical":true,"interruptedToolOutcome":"TOOL_OUTCOME_UNKNOWN",
 "interruptedTurnSettled":"interrupted","modelRequestsDuringSettlement":0,
 "replayedToolCallEvents":0,"residualWrites":0,
 "workspaceRevisionBeforeCrash":0,"workspaceRevisionAfterSettlement":0,
 "projectedAssistantTextOccurrences":1,"continuationCompleted":true}
```

- 刷新在 2083 ms 内完成接管与结算，小于 5000 ms lease TTL；`fencingToken` 从 1 变为 2。
- 刷新后事件数从 26 变为 30：恰好 3 个 closer 与 1 个 `session/end-seed`；前缀 `seq`、类型与完整事件内容逐项相同。
- 旧 `tool/call` 仍只有 1 条，`tool/result` 与 `turn/end` 各只有 1 条；结算期间模型请求为 0。
- 延迟工具在 8 秒睡眠结束后仍未写入 `reload-residual.txt`，Workspace revision 保持 0。
- 崩溃后 1 秒事件数保持 26，无模型请求；刷新恢复使 `ownerEpoch` 1→2、fencing token 1→2，并从崩溃到结算共 2959 ms。
- 两条路径都只有 1 个已持久化 assistant 文本投影，后续 prompt 在同一 Session 正常完成。

## 与标签页关闭的差异

| 场景 | Worker | Session 归属 | 在途 turn | 用户可见结果 |
| --- | --- | --- | --- | --- |
| 刷新 | 旧 Worker 销毁，新文档创建新 Worker | pagehide 释放；新 Worker 在同一文档内立即恢复 | 挂载时结算为 `interrupted`，工具结果 `TOOL_OUTCOME_UNKNOWN` | 自动回到同一 Session，可直接继续 |
| Worker 崩溃 | Worker 无预警销毁 | 不触发 pagehide；新页面用 recovery record 接管，否则等 TTL | 恢复挂载时结算一次 | 页面需刷新后才能继续；旧页面控件失去 Worker |
| 关闭标签 | Worker 随页面销毁 | pagehide 释放或 TTL 到期；无自动重开 | 下一次拥有者打开 Session 时结算一次 | 没有后台续跑；必须重新打开 |

刷新与崩溃的恢复语义共享同一条 `agentLoop.resume` 收尾路径；差异只在租约释放方式与是否需要显式重开页面。

## 限制

只覆盖 Chrome 156、Playwright Chromium、`bash sleep 8` 的 scripted 模型、single-instance PoC backend 与 5 秒测试 TTL。未覆盖浏览器进程崩溃（见 [chrome-process-crash-recovery.e2e.mjs](tests/chrome-process-crash-recovery.e2e.mjs) 的独立场景）、OS 崩溃、真实模型在途工具、刷新期间的模型流重连、多实例 backend 接管、Service Worker 接管与 Safari/WebKit。
