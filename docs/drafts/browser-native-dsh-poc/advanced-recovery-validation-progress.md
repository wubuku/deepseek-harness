---
description: "记录 Browser-Native DSH 离线 retry、Workspace CAS 冲突保留和 writer lease 过期接管的真实 Chrome 验证结果与限制。"
---

# Browser-Native DSH 进阶恢复验证进度

## 当前状态

状态：P1、P2、P3 均已通过真实 Chrome；验证目标和退出条件见[进阶恢复验证计划](advanced-recovery-validation-plan.md)。三项测试使用真实 Dedicated Worker 和 PoC Workspace backend；离线与冲突测试覆盖 OPFS/IndexedDB，未调用真实 LLM。

| 验证点 | 状态 | 证据 | 未覆盖项 |
|---|---|---|---|
| 离线本地 retry 与刷新恢复 | `passed` | `durable-workspace-offline-recovery.e2e.mjs`：离线写入后保留 durable retry；恢复网络并刷新，沿用原 `operationId`，最终 revision 为 1 且仅 commit 一次 | 不模拟真实网络断连之外的浏览器进程崩溃、存储驱逐或设备离线重启 |
| 本地 retry 与远端 CAS 竞争 | `passed` | `durable-workspace-conflict-retention.e2e.mjs`：相同 base revision 的远端版本先提交；本地随后进入 `conflict`，本地文件可读、远端内容未覆盖，重试仍使用原 `operationId` | 不实现自动合并、冲突副本或用户冲突解决 UI |
| writer lease 过期与旧 writer fencing | `passed` | `workspace-writer-expiry.e2e.mjs`：真实 Worker/tab 的租约过期后第二 tab 获得 fencing token 2；旧 resume/renew/commit 被拒；释放后旧 tab 以 token 3 重新 claim | 当前旧 tab 在活动租约期间恢复会收到 boot HTTP 503；没有只读/等待界面；不覆盖 backend 重启或多实例 lease 协调 |

## 实际验证

以下命令已在本机真实 Chrome 执行通过：

```sh
export DSH_POC_BROWSER=chrome
export DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js

node docs/drafts/browser-native-dsh-poc/tests/durable-workspace-offline-recovery.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/durable-workspace-conflict-retention.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/workspace-writer-expiry.e2e.mjs
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts
```

离线恢复的结果为 4 次失败请求后保留本地 retry，刷新后用同一 `operationId` 提交一次，revision 为 1；CAS E2E 观察到远端 revision 为 1、本地进入 `conflict`，两份内容均可验证，两个本地 commit 请求的 `operationId` 相同。租约 E2E 使用 1,200 ms 测试租期，fencing token 依次为 1、2、3；stale resume、renew 和 commit 均返回 409，第二 tab 持有租约时旧 tab boot 被 HTTP 503 拒绝，释放后可重新 claim。三条脚本均未发出跨源请求；离线和冲突脚本无页面错误，租约脚本只记录了预期的活动 writer 冲突 boot 错误。

附加检查：`backend-v2.test.mjs` 15/15 通过；Browser-Native Workspace 单测 11/11 通过。运行单测时 Vite 输出 `vite-tsconfig-paths` 可由原生 `resolve.tsconfigPaths` 替代的提示；该提示与本次验证无关，未改动项目配置。

## 经验与限制

- 离线恢复必须分别检查本地 OPFS/IndexedDB retry、backend manifest 与 operation receipt；页面状态或单独一次成功响应不足以证明恢复只提交一次。
- CAS 冲突的验收同时检查本地 VFS 内容和远端 blob；只检查 UI 的 `conflict` 状态无法排除本地 bytes 已丢失或远端已被覆盖。
- `requestId` 与 `operationId` 作用不同：每次网络请求的 `requestId` 可变化；一次业务提交重试必须保留原 `operationId`。
- 租约测试使用 `testHooks.workspaceWriterLeaseMs` 缩短测试租期，默认租期仍为 30 秒；测试参数没有暴露为产品配置。
- 旧 tab 使用过期凭据启动时，当前 PoC 会安全拒绝写入并清除旧 lease 状态，但 preview boot 把 503 作为页面错误暴露。下一轮高价值工作是将该分支呈现为可恢复的“等待/只读/重新获取写权”状态，而不是弱化 backend fencing。
- 本轮没有验证真实 LLM、Safari/WebKit、quota/eviction、OS 级浏览器崩溃、backend 多实例/重启后的 lease 所有权或生产级认证授权。此处的 Workspace backend 仍是 PoC，不代表生产云存储。

## Dev Note

当前行为以三个 E2E、backend contract tests 和 Workspace 单测为准。改变租约、重试、冲突状态或刷新恢复时，保留原 operation identity、远端 CAS 和本地 dirty 内容断言，并同步更新[PoC README](README.md)、[验证计划](advanced-recovery-validation-plan.md)与[变更清单](change-ledger.md)。
