---
description: "记录 Browser-Native DSH 下一批 P0 验证的实施进度、实际证据和未验证限制。"
---

# Browser-Native DSH 下一批 P0 验证进度

## 当前状态

P0-2 的 scripted DSH 文件工具与 Workspace/Session receipt 闭环已通过真实 Chrome Worker E2E，且已验证在 Workspace commit 成功、Session receipt append 未到达 backend 时终止 Worker，刷新并重开同一 Session 后只补写一条 receipt。P0-1 和 P0-3 仍为部分完成；本批次没有使用真实 LLM，也不把 Worker 页面关闭后的行为描述为后台 Agent。

| 验证面 | 状态 | 当前证据 | 未完成项 |
|---|---|---|---|
| 本地 durable store 崩溃一致性 | `partial` | 真实 Chrome 验证 IndexedDB transaction abort 返回 `error`、pending retry 保留且远端 manifest 不提交；损坏 snapshot、缺失 OPFS blob、blob hash mismatch 均显示 `local-corrupt` | 未覆盖 quota/eviction 或浏览器强制崩溃；没有自动修复损坏本地数据 |
| 真实 DSH Agent Loop receipt 闭环 | `scripted / passed` | Worker Host 中真实 DSH `write` 工具生成 Workspace commit；Session 记录工具调用、结果和 PoC receipt；receipt append 503 重试与 Worker 终止后的同 Session 恢复均不重复 commit，outbox 最终清空 | 仅验证 `write`，未覆盖 `edit`、多文件单 turn、并发工具或真实 provider |
| Worker/页面生命周期恢复 | `partial` | Chrome 验证 Worker 终止后的 durable retry，以及 Workspace commit 后、Session receipt append 被中断时刷新并重开同一 Session | 未覆盖等待 LLM 时的 Worker 强制终止、Workspace writer lease 的正常 unload/release 及浏览器进程崩溃；不提供页面关闭后的后台 Agent |

## 本轮实现

- `browser-native-session-events.ts` 为 PoC 声明 `browser-native/workspace-receipt` 事件；远程 Session provider 仅在持久化时添加 `ignorable: true`，不修改正式事件目录、Session format version 或 Agent Loop。
- `write`/`edit` 执行适配器从同一 Session 的 `tool/call` 事件取得 `turn`、`step`、`callId`、工具名和事件序号，将关联信息写入 Workspace mutation batch；backend commit 协议不接收这些 Agent 标识。
- Workspace commit receipt 先进入 OPFS/IndexedDB 本地 outbox；追加同一 Session 的 receipt event 并 flush 成功后才确认清除。append 失败保留 outbox；恢复以 operation receipt 和已有 Session event 去重，不回滚已提交 Workspace，也不宣称跨存储原子事务。
- durable snapshot/blob 损坏时以 `local-corrupt` 诊断状态 fail closed；Web preview 仅增加对应的本地化文案和状态显示，默认 Browser-Native 入口行为不变。
- `browser-native-test=workspace-recovery` 的 Worker test port 可仅对下一次 IndexedDB metadata transaction 执行真实 `IDBTransaction.abort()`；事务状态等待 abort 事件以保留明确错误信息。
- 新增 `agent-workspace-receipt-recovery.e2e.mjs`，故意暂停首次 receipt append，确认 OPFS/IndexedDB outbox 已持久化后终止 Worker，再刷新并重开同一 Session。

## 实际验证

以下检查在 2026-10-22 的 `research` 工作区按顺序运行。全仓 build 与 preview build 共用生成目录，必须串行执行；并行构建曾造成 preview VFS image 缺失，串行重建后恢复。

```sh
pnpm run build
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
```

结果：两项均通过。构建报告既有的 chunk-size 提示；preview VFS image 成功生成。

```sh
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts \
  docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts
node --test \
  docs/drafts/browser-native-dsh-poc/tests/session-workspace-reconciliation.test.mjs \
  docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
```

结果：Vitest `19/19` 通过；Node `18/18` 通过。覆盖本地状态校验、receipt 关联、幂等、Session/Workspace reconciliation 和 backend protocol。

```sh
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
node docs/drafts/browser-native-dsh-poc/tests/durable-workspace-corruption.e2e.mjs
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
node docs/drafts/browser-native-dsh-poc/tests/worker-lifecycle-recovery.e2e.mjs
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-receipt.e2e.mjs
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-receipt-recovery.e2e.mjs
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
node docs/drafts/browser-native-dsh-poc/tests/durable-workspace-idb-abort.e2e.mjs
```

结果：五项均在真实 Chrome 运行并通过脚本断言，全部使用 scripted LLM。

- corruption E2E 覆盖 invalid snapshot、missing blob、hash mismatch；每种情况均显示 `local-corrupt`。启动错误是预期的 fail-closed 诊断，不是恢复成功。
- Worker lifecycle E2E 覆盖同一 `operationId` 的 commit retry；两次 commit 请求后 revision 为 1，恢复的 VFS 内容一致。
- Agent receipt E2E 覆盖真实 DSH `write`、Session tool events、Workspace manifest/operation receipt，并注入首次 Session receipt append 503；retry 后仅一次 Workspace commit、Session backend 只读到一条 receipt、outbox 清空。页面无 `pageerror`；运行日志另外观察到四条资源 404 和两条被取消的 LLM 请求，本用例未将它们作为通过条件。
- crash-recovery E2E 在 receipt append 到达 backend 前终止真实 Worker，刷新后实际重开同一 Session；结果为 `receiptCountAfterRecovery=1`、`workspaceCommitCount=1`、`outboxAfterRecovery=[]`、`pageErrors=[]`。一轮早期运行曾因测试错误地拦截所有 receipt retry 而超时；改为只中断首次 append、放行恢复重试后通过。
- IndexedDB abort E2E 在真实 Worker 发起包含 metadata `put` 的 read-write transaction 后调用 `IDBTransaction.abort()`；初次 VFS 写入明确收到 `IndexedDB transaction aborted`，稍后的 retry batch 保留在本地，阻断 blob 上传后确认远端 manifest 未包含该文件、没有 commit。

## 经验与限制

- 先验证故障发生在哪个持久化点：Workspace commit 成功不代表 Session receipt 已持久化，Session append 请求启动也不代表 backend 已接受。恢复断言应分别读取 backend operation、Session event 和本地 outbox。
- 故障注入必须只拦截目标的首次请求。若测试继续拦截恢复请求，测试装置会阻止系统恢复，造成假失败。
- IndexedDB 的 request error 事件可能早于 transaction abort 事件；若仅在 `transaction.onerror` 立刻拒绝，Chrome 会把真实 abort 降级成含糊的 transaction failure。等待 transaction 完成或 abort，再向上层报告持久化结果。
- `browser-native/workspace-receipt` 是 PoC-only、ignorable 的 Session event；未知事件消费者可跳过它。它不是 DSH 正式事件 schema，不构成稳定 API，也不意味着 Session 与 Workspace 有原子提交。
- 本地 `local-corrupt` 目前是明确停止同步的诊断状态，不会自动从云端覆盖本地文件；恢复/导出策略仍需设计，不能静默丢弃本地 pending bytes。
- 真实 Chrome 尚未验证 quota/eviction 和浏览器进程崩溃。fake store 单测的 transaction failure 不能替代真实浏览器证据；本批新增 E2E 已单独执行真实 IndexedDB abort。
- Worker 生命周期测试只证明已持久化状态可在刷新后恢复；Dedicated Worker 仍受页面生命周期约束，不是后台 Agent。
- 本批未运行真实 LLM，也未运行 Safari/WebKit；真实 provider 延迟、模型工具选择及多标签写权在此结果中均不作结论。

## 下一批建议

1. 分开验证 OPFS/IndexedDB 被清除时的两条恢复路径：无本地 dirty/outbox 时从云端重建；存在 dirty/outbox 时保留可导出的本地状态并明确提示冲突，不静默覆盖。
2. 在 `browser-native-workspace-lease=1` 下测试刷新与强制 Worker 终止：确认 writer release、lease expiry、fencing token 和同 Session 恢复顺序。
3. 扩大 Agent receipt 矩阵至 `edit`、rename/delete 及一次工具操作影响多个路径；仍使用 scripted LLM，避免把 provider 波动混入协议验收。
4. 增加真实 Chrome quota/eviction 与浏览器进程崩溃注入；明确区分浏览器本地数据被清除与可恢复的远端状态。
