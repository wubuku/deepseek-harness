---
description: "记录真实 DSH 文件工具遇到本地 durable Workspace 保存失败时的确认语义与同会话恢复测试。"
---

# Browser-Native DSH 文件工具持久化确认验证进度

## 当前状态

状态：P1、P2 均已通过真实 Chrome。基线为 2026-10-22 的 `research` 分支 checkout。使用真实 Dedicated Worker、DSH Agent Loop、Workspace OPFS/IndexedDB 和 scripted LLM；未调用真实模型。

| 验证点 | 状态 | 证据 | 下一步 |
|---|---|---|---|
| IndexedDB 保存失败时的真实 DSH `write` 结果 | `passed` | `agent-workspace-durable-ack.e2e.mjs`：首次真实 DSH `write` 遇到 IDB abort 后，Session tool result 是 `isError: true`；远端 revision 仍为 0，未生成成功 receipt | 暂无；继续扩大到其他变更工具前，先为每种工具定义持久化结果语义 |
| Worker 重建后的同一 Session 显式重试 | `passed` | 第一次 `write` 失败后刷新，确认 Worker 恢复到 revision 0 且未确认文件不存在；同一 Session 的新 `write` call 在 commit 前已写入匹配 operationId/retry batch 与 OPFS bytes，最终 revision 1、receipt 关联新 call | 未验证真实 quota exhaustion、eviction 或浏览器进程崩溃 |

## 已核实实现事实

- `MemoryVfs` 在内存 mutation 完成后同步调用 `VfsMutationSink.record()`；durable 保存通过异步队列进行。
- Browser-Native provider 对 `write`/`edit` 包装工具执行，先运行工具，再等待本地 Workspace 持久化，最后尝试远端 Workspace commit。
- 基线真实 Chrome E2E 证明：IDB abort 时，旧实现仍会向 Session 写入 `isError: false` 的成功 tool result。修复后本地持久化失败抛出明确错误，DSH tool dispatch 将它记录为 `isError: true`；远端 commit 仍只在本地保存成功后开始。
- Workspace 已提供分离的 `flushLocalWorkspace()`；Worker 测试端口已支持一次性 `abort-next-metadata-transaction`。
- DSH tool dispatch 会把 `tools/execute` 抛出的错误转换成 `isError: true` 的工具结果；本批通过真实 Session event 验证实际消费路径，而非仅根据工具包单测推断。

## 运行记录

真实 Chrome E2E 的基线复现先观察到 IndexedDB abort 后工具结果仍为成功。随后 provider 在 `flushLocalWorkspace()` 失败时抛出说明持久化未确认的错误；云端 `flushWorkspace()` 仍单独 best-effort，避免把“本地文件已 durable、云端暂时离线”误报成本地写入失败。

修复后的 E2E 观察到第一次工具结果为 `isError: true`，提示写入可能仍只存在于 Worker 内存；远端 manifest revision 为 0、无 receipt。Provider 后续对文件工具 fail closed，因此脚本先刷新并确认易失文件未被恢复，再在同一 Session 显式重试。E2E 在 commit 请求放行前读取 IndexedDB retry batch 与 OPFS blob，确认 operationId 和内容已 durable；随后 revision 到 1、receipt 关联重试的 tool call。再次刷新后文件内容仍在，commit 数维持 1。无页面错误或非同源请求。

初次测试设计曾只检查 LLM request 中最后一条 user 消息；实际上下文还包含运行时 user context，导致 scripted marker 未命中。脚本改为按显式验收标记定位当前 prompt 与其后的 tool result，之后稳定复现并通过。

以下命令均已运行。durable-ack E2E 在新增 fail-closed 保护后调整为先刷新 Worker，再在同一 Session 显式重试；同一存活 Worker 不会在本地 durable 状态仍未确认时接受新的 Agent 文件工具。

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
export DSH_POC_BROWSER=chrome
export DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js
node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-durable-ack.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-edit-receipt.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-receipt-recovery.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/durable-workspace-idb-abort.e2e.mjs
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts
```

结果：新增 durable-ack E2E、既有 Agent write/edit receipt E2E、receipt crash recovery E2E 和 IDB abort E2E 均通过；backend 15/15，Workspace 与 durable Workspace Vitest 19/19。E2E 与 backend 脚本通过 `node --check`。

`pnpm run doc-sync` 43/43 通过；`git diff --check` 通过。

## 限制

- IndexedDB abort 是测试注入，不代表真实 Chrome quota exhaustion、浏览器 eviction 或进程级崩溃。
- 写入失败发生在同步 MemoryVfs mutation 之后；工具返回错误表示“本地持久化未确认”，不保证当前 Worker 内存中的变更已回滚。Browser-Native provider 在 durable 保存 pending/失败时拒绝 Agent 文件读、写和搜索；E2E 持续注入故障并验证刷新重建 Worker 后恢复最后确认状态。
- 只验证真实 DSH `write` 工具与刷新后同 Session 的显式重试，不外推到 `append`、并发工具、真实 quota exhaustion、eviction 或生产级持久化。
- 远端 Workspace commit 失败与本地 durable 保存失败分开处理；本轮证明了 IDB abort 不会启动远端 commit，但未重新评估所有网络/冲突失败下的模型可见解释。
- 测试使用 scripted LLM，不证明真实模型会读取错误后采取何种后续策略。

## Dev Note

验证命令与实际结果以此处追加的记录和 E2E JSON 输出为准。若源码行为与预期不符，先修正工具结果语义，再重跑真实 Chrome E2E、相关单测及文档检查。
