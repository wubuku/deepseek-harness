---
description: "记录 Browser-Native DSH 在 WebKit/Safari 与进程挂起场景的能力探测结果、可判定证据和不可测边界。"
---

# WebKit/Safari 与 OS 级挂起能力结论

## Summary

本批回答两个问题：Browser-Native preview 能否在 WebKit 系浏览器中启动；以及页面所在进程被挂起超过 Workspace writer lease TTL 后，写入权和恢复语义是否仍然安全。结论是：当前 Playwright WebKit（WebKit 26.4）无法启动 preview，原因是 `navigator.storage.getDirectory()` 在页面和 Dedicated Worker 中都以 `UnknownError` 失败、且不提供 OPFS sync access handle；Safari 26.6.2 在本机未开启远程自动化，无法建立 WebDriver 会话，因此只能落档为环境不可测。作为对照，同一 harness 在 Chromium 147 上通过完整 durable/ephemeral Workspace 与 scripted turn。进程挂起方面，用 `SIGSTOP` 冻结 Chrome renderer 超过 lease TTL 后，backend 与页面都判定写入权失效，冻结期间与恢复后都没有发出续租请求，也没有落盘写入；刷新后以更高 fencing token 重新取得写权。

## 环境

| 项 | 值 |
|---|---|
| OS | macOS 26.6.2（build 25G83） |
| Safari | 26.6.2（`/Applications/Safari.app`） |
| safaridriver | 随系统提供；需要在非沙箱进程内运行才能监听端口 |
| Playwright | 1.59.1 |
| Playwright WebKit | 26.4（`webkit-2272`） |
| Playwright Chromium | 147.0.7727.15（对照） |

## 1. WebKit 能力探测

测试：[tests/webkit-capability.e2e.mjs](tests/webkit-capability.e2e.mjs)。默认引擎为 `webkit`，可用 `DSH_POC_BROWSER_ENGINE=chromium` 运行同一 harness 作对照。

```sh
node docs/drafts/browser-native-dsh-poc/tests/webkit-capability.e2e.mjs
DSH_POC_BROWSER_ENGINE=chromium node docs/drafts/browser-native-dsh-poc/tests/webkit-capability.e2e.mjs
```

WebKit 输出摘要：

```json
{"result":"probe","engine":"webkit","browserVersion":"26.4",
 "capabilities":{"secureContext":true,
   "page":{"opfs":true,"syncAccessHandle":false,"failure":"The operation failed for an unknown transient reason (e.g. out of memory)."},
   "worker":{"opfs":true,"syncAccessHandle":false,"failure":"The operation failed for an unknown transient reason (e.g. out of memory)."},
   "dedicatedWorker":true,"moduleWorker":true,"cryptoSubtle":true,
   "sharedArrayBuffer":false,"broadcastChannel":true,"locks":true},
 "ephemeralWorkspace":{"available":false,"error":"page.waitForFunction: Timeout 45000ms exceeded."},
 "ephemeralTurn":{"completed":false,"skipped":true},
 "durableWorkspace":{"available":false,"startupBlocked":"Error: browser-native startup blocked: OPFS_SYNC_ACCESS_UNAVAILABLE"},
 "pageErrors":["Error: web-preview tunnel: boot payload failed with HTTP 503: UnknownError: The operation failed for an unknown transient reason (e.g. out of memory).",
   "Error: browser-native startup blocked: OPFS_SYNC_ACCESS_UNAVAILABLE"],
 "verdict":"webkit-unavailable"}
```

判定：WebKit 暴露 `Worker`、module worker、Web Locks、BroadcastChannel 和 `crypto.subtle`，但 OPFS `getDirectory()` 在页面和 Worker 中都失败；此时即便不启用 durable Workspace，preview 的 boot payload 也已因同一 OPFS 错误失败，页面无法进入任何 Workspace 状态。`OPFS_SYNC_ACCESS_UNAVAILABLE` 是 Browser-Native 启动门给出的明确 fail-closed 诊断，而不是静默降级。

Chromium 对照输出摘要：

```json
{"result":"probe","engine":"chromium","browserVersion":"147.0.7727.15",
 "capabilities":{"page":{"opfs":true,"syncAccessHandle":false},
   "worker":{"opfs":true,"syncAccessHandle":true},"locks":true},
 "ephemeralWorkspace":{"available":true,"accessMode":"writer","leaseState":"active","fencingToken":1,"writeReadBack":true},
 "ephemeralTurn":{"completed":true,"turn":1,"events":19},
 "durableWorkspace":{"available":true,"state":{"state":"synced","revision":1},"readBack":true},
 "verdict":"chromium-durable-and-ephemeral-supported"}
```

对照证明 harness 本身可判定：同一脚本、同一 backend、同一 URL 参数在 Chromium 上完成 Workspace 写入/回读、durable 重载回读和一次 scripted turn。差异来自浏览器实现，而不是测试路径。

### Safari

`safaridriver -p 4444` 在沙箱外可启动并返回 `ready:true`；创建会话被拒绝：

```json
{"value":{"error":"session not created","message":"Could not create a session: You must enable 'Allow remote automation' in the Developer section of Safari Settings to control Safari via WebDriver."}}
```

启用该项需要用户在 Safari 设置或管理员授权中操作，属于交互式环境变更，本批不执行。因此 Safari 在本机是“能力未知/不可测”，不能按 WebKit 结果直接推断 Safari 的 OPFS 行为；Playwright WebKit 只是同引擎的另一构建。

## 2. OS 级挂起与 writer lease

测试：[tests/os-suspend-lease.e2e.mjs](tests/os-suspend-lease.e2e.mjs)。启动 durable Workspace 与 `browser-native-workspace-lease=1`，把 writer lease 调成 4 秒；页面同步后找到该浏览器 profile 下的 Chrome renderer 进程并发送 `SIGSTOP`。renderer 同时承载页面 JavaScript 和 Dedicated Worker，因此续租 timer 与写入路径都被冻结，而 Node backend 继续按真实时钟运行，等价于机器休眠时浏览器侧计时器停摆。

```sh
node docs/drafts/browser-native-dsh-poc/tests/os-suspend-lease.e2e.mjs
```

输出摘要：

```json
{"result":"passed","scope":"renderer-process-suspension-beyond-writer-lease-ttl",
 "leaseDurationMs":4000,"frozenDurationMs":6078,"frozenRendererCount":1,
 "staleRenewStatus":409,"staleRenewCode":"WORKSPACE_OWNERSHIP_LOST",
 "takeoverClaimStatus":200,"takeoverFencingToken":2,"releaseAfterTakeover":200,
 "renewalsSentDuringFreeze":0,"renewalsSentAfterResume":0,
 "resumedWorkspaceState":"error",
 "resumedWorkspaceMessage":"Workspace writer lease was lost; reload before using Workspace files (Workspace writer lease is unavailable; reload to reacquire write access)",
 "writerLeaseAfterResume":{"ok":false,"state":"lost","renewalScheduled":false,"accessMode":"writer"},
 "writeAfterResume":{"ok":false,"error":"browser-native workspace: local writer was invalidated; reload before using Workspace files"},
 "reloadFencingToken":3,"writeAfterReload":"persisted after reload\n","pageErrors":[]}
```

判定：

1. **冻结期间不续租**：页面 timer 被 SIGSTOP 停住，backend 在 4 秒后把旧 lease 判为过期；冻结后由 Node 用旧 token 续租得到 `409 WORKSPACE_OWNERSHIP_LOST`。
2. **归属唯一且可接管**：其他客户端可在旧 lease 过期后 claim 成功，fencing token 递增到 2；释放后同一标签刷新取得 3。任意时刻只有一个有效 writer。
3. **恢复后不写旧数据**：`SIGCONT` 后页面自身用单调时钟判定 deadline 已过，状态进入 `error`，test port 的写入被本地拒绝；`renewalsSentAfterResume=0` 表示它连续租请求都不发，不会用过期 token 碰 backend。
4. **恢复路径显式**：刷新重新 claim 后才允许写入，写入成功落盘；不存在自动续用旧 writer 的静默恢复。
5. **无页面异常与无残留**：`pageErrors=[]`，恢复前 Workspace revision 未因冻结写入推进。

### 语义决策

- Workspace writer lease 是物理时间契约：租约到期以 backend 时钟为准，页面侧的单调时钟只用于尽早 fail closed，二者不要求严格同步。
- 挂起恢复后**不自动续租**：页面进入 `error` 并要求 reload；刷新是重新 claim 的唯一入口。
- 冻结期间的未完成操作不自动重放；工具与 turn 的结算沿用[标签页关闭语义](tab-close-background-agent-semantics.md)的 `TOOL_OUTCOME_UNKNOWN` / `interrupted` 规则。
- 该语义同样适用于 OS 休眠、长时间 CPU starvation 和调试器断点；实际实现通过 SIGSTOP 探测，而不是等待真实 sleep。

## 限制与未覆盖

- `SIGSTOP`/`SIGCONT` 冻结 renderer 是进程级模拟，不等于真实 macOS 休眠：系统休眠还可能暂停 backend 主机时钟、网络栈和 Chromium browser 进程；本测试中 backend 时钟始终运行。
- 只冻结 renderer；browser 与 GPU 进程仍运行。未验证待决审批、在途工具和模型流与挂起同时发生的组合态。
- 未验证 `pagehide`/BFCache 与挂起的交叉路径，也未验证 Safari 或 iOS 的 timer/OPFS 行为。
- Safari 远程自动化未启用，WebDriver 会话不可建立；启用需要交互式授权，因此 Safari 结论是环境限制而非能力否定。
- Playwright WebKit 的 OPFS 失败可能与该构建或 headless 模式有关；Safari 真机行为仍未知。

## 复跑提示

- WebKit/Chromium 对照需要已安装的 Playwright 浏览器；无显示环境也可运行。
- 挂起测试需要 POSIX `ps` 与 `SIGSTOP`，不能在 Windows 运行；`DSH_POC_DATA_DIR` 可复用固定数据目录，profile 目录每次新建并清理。
