---
description: "记录 Browser-Native DSH 本地持久化失败后的 Agent 文件状态隔离和 Worker 重建恢复验证。"
---

# Browser-Native DSH 易失文件状态隔离验证进度

## 当前状态

状态：P1、P2 已通过真实 Chrome Worker E2E，fail-closed 工具保护已加入 PoC provider。范围和退出条件见[验证计划](volatile-workspace-isolation-plan.md)。基线为 2026-10-22 的 `research` 分支；使用真实 DSH Host/Agent Loop、OPFS、IndexedDB 和 scripted LLM，未调用真实模型。

| 验证点 | 状态 | 当前证据 | 下一步 |
|---|---|---|---|
| 本地保存失败后读写/搜索工具隔离 | `passed` | `agent-workspace-volatile-failure.e2e.mjs`：IndexedDB abort 后真实 `edit` 返回工具错误；后续 `read`、`grep`、`glob`、`write` 均被 Browser-Native provider 拒绝，Session 保存错误结果 | 条件注册的 `read_image` 受同一 guard 保护，但未在 Agent 序列中单独调用 |
| Worker 重建后的文件状态与 Session 恢复 | `passed` | 故障后刷新并重建真实 Worker；Session 保留失败 `edit`/后续工具结果，VFS 与远端 manifest 恢复为此前已提交的 `before` 内容，revision 不变 | 不覆盖浏览器进程崩溃、设备断电或存储 eviction |
| 同 Session 显式重试的完整闭环 | `passed` | 同一 Session 发起新的 `edit` call；成功 receipt 关联新 call，revision 只增加一次至 2，最终远端文件为 `after`，本地 pending/retry/receipt outbox 清空 | 使用 scripted LLM，未验证真实模型工具选择 |

## 已有基线

durable-ack 测试在本批之前验证 `write` 本地保存失败与同 Session 重试；本批重新运行后，因新增 fail-closed 保护，测试改为刷新 Worker 后再在同一 Session 重试。当前测试证据以本节“实际验证”为准。

```sh
DSH_POC_BROWSER=chrome \
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-durable-ack.e2e.mjs
```

结果：`real-DSH-write-local-durable-error-worker-reload-and-same-session-retry` 通过；真实 DSH `write` 的本地 IndexedDB abort 被记为工具错误，刷新后同一 Session 的显式 `write` 重试完成一次远端 commit 并写入 receipt。输出还确认页面无错误、没有非同源请求。此结果只验证 `write`，不能替代本批 `edit` 失败后的读写隔离验收。

## 实施记录

| 阶段 | 状态 | 结果 |
|---|---|---|
| 规划与代码考古 | `completed` | 确认 `tool-fs` 的 Browser-Native roster 包含 `read`、`write`、`edit`；provider 当前只在 `write`/`edit` 返回成功后等待本地 durable flush。`MemoryVfs` mutation 先于异步 store 保存，因此失败后同一 Worker 的内存副本可能领先于 durable snapshot。 |
| 故障复现与最小保护 | `completed` | E2E 观察到 VFS 内存已变为 `after`，而 durable metadata 和远端 manifest 仍为 `before`；provider 对文件读取、搜索和写入 fail closed，要求刷新后恢复。 |
| Worker 重建与重试 | `completed` | 刷新后回到 revision 1 的 `before`；Session 保留原失败结果；新的显式 `edit` 只提交一次并产生 revision 2 receipt。 |
| 文档与门禁 | `completed` | README、变更清单和 drafts 索引已更新；Vitest 21/21、backend tests 15/15、`test:docs` 21/21 与 `doc-sync` 43/43 通过。 |

## 实际验证

真实 Chrome E2E 使用以下命令：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome \
DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js \
node docs/drafts/browser-native-dsh-poc/tests/agent-workspace-volatile-failure.e2e.mjs
```

preview build 通过。E2E 结果为 `passed`：失败 `edit` 后 VFS 测试口观察到易失内容 `after`，Agent 的 `read`、`grep`、`glob` 和 `write` 均记录为错误；刷新后恢复到 `before`；同 Session 新 `edit` call 取得 receipt，最终 revision 为 2，新增 Workspace commit 恰好一次。Chrome 输出中的调用 ID 分别为 `browser-native-durable-edit-follow-up-read`、`browser-native-durable-edit-follow-up-grep`、`browser-native-durable-edit-follow-up-glob`、`browser-native-durable-edit-follow-up-write` 和 `browser-native-durable-edit-retry`。页面无 `pageerror`，没有非同源请求。

同一环境还单独复跑 `agent-workspace-durable-ack.e2e.mjs`，确认第一次真实 `write` 报错、刷新回到 revision 0 后，同 Session 新 `write` call 可 durable、commit 一次并获得 receipt；`agent-workspace-edit-receipt.e2e.mjs` 的正常 `write → read → edit → write` 路径也通过。

本批最终验证结果：`durable-workspace.spec.ts` 与 `browser-native-workspace.spec.ts` 为 21/21，`backend-v2.test.mjs` 为 15/15；`test:docs` 为 21/21，`doc-sync` 为 43/43。`build:preview`、两个新增/修改 E2E 的 Node 语法检查，以及 `git diff --check` 均通过。以上测试使用 scripted LLM，不是模型服务验收。

聚焦单测、backend tests 和文档门禁命令：

```sh
pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts \
  docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts \
  docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
pnpm run test:docs
pnpm run doc-sync
```

## 经验与限制

- DSH 的 `edit` 默认要求当前 Session 先读取目标文件；scripted E2E 必须先调用真实 `read`，否则它验证的是 `FS_NOT_OBSERVED`，不是本地 durable 失败。
- 失败的 mutation 可以留在存活 Worker 的 `MemoryVfs`，即使 Session tool result 已明确失败、IndexedDB snapshot 和远端 manifest 仍是旧内容。provider 在 durable 保存仍 pending 或失败时拒绝文件读、写和搜索；若 E2E 持续注入故障，则需刷新 Worker 才能回到已确认基线。
- `localPersistVersion` 与已持久化版本共同覆盖保存进行中与失败两种状态；不能在入队新保存时提前清除错误，否则并行 Agent 工具可能在保存完成前读取易失数据。
- `read`、`grep`、`glob`、`write` 的拒绝均以真实 DSH `tool/result` 验证；条件注册的 `read_image` 使用同一 provider 检查，但本 E2E 没有单独调用它。
- E2E 通过页面刷新终止并重建 Worker；不等同于 OS 级崩溃、真实配额耗尽或 eviction。没有真实 LLM/Safari 验证。
- 修改 Worker/provider 后必须先重建 preview；否则 E2E 会运行旧的 Worker bundle，造成误判。

## 限制

- 本批只使用真实 Chrome 和 scripted LLM，不覆盖 Safari/WebKit、真实模型、真实 quota exhaustion、浏览器 eviction 或 OS 级崩溃。
