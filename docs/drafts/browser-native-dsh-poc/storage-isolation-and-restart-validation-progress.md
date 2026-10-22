---
description: "记录 Browser-Native DSH OPFS quota 错误、backend 重启 lease 恢复和同源 Workspace 隔离验证的执行进度、证据与限制。"
---

# Browser-Native DSH 存储隔离与重启验证进度

## 当前状态

状态：P1、P2、P3 均已通过真实 Chrome。验证范围和明确不作结论的边界见[验证计划](storage-isolation-and-restart-validation-plan.md)。基线为 2026-10-22 的 `research` 分支 checkout；实际使用真实 Chrome、Dedicated Worker、OPFS/IndexedDB 与 scripted runtime，未调用真实 LLM。

| 验证点 | 状态 | 当前证据 | 下一步 |
|---|---|---|---|
| OPFS quota 错误与 durable retry | `passed` | `durable-workspace-quota-recovery.e2e.mjs`：首次 VFS 写入得到 quota 类错误；恢复后 retry batch 与 OPFS blob 已 durable 才允许 commit，最终 revision 1、commit 一次 | 使用 fault-injected `QuotaExceededError`，未触发真实浏览器 quota exhaustion |
| backend 重启后的 lease fencing | `passed` | `workspace-backend-restart-lease.e2e.mjs`：同一 dataDir backend 重启后旧 token renew 返回 409，刷新后 fencing token 从 1 提升到 2，revision/file 保持且 commit 未重放 | 只验证单进程 PoC JSON store，不覆盖多实例/HA |
| 同源多身份存储隔离 | `passed` | `workspace-browser-storage-isolation.e2e.mjs`：同一 Chrome context 保留同源 OPFS/IndexedDB、切换 cookie 身份；两 Workspace 的 IDB 记录和 OPFS namespace 独立，交叉 manifest/blob 均返回 403，刷新恢复身份 B 内容 | 不构成生产多租户安全审计 |

## 验证记录

以下命令已在本机真实 Chrome 运行通过：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview

export DSH_POC_BROWSER=chrome
export DSH_POC_PLAYWRIGHT_MODULE=/Users/yangjiefeng/node_modules/playwright/index.js

node docs/drafts/browser-native-dsh-poc/tests/durable-workspace-quota-recovery.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/workspace-backend-restart-lease.e2e.mjs
node docs/drafts/browser-native-dsh-poc/tests/workspace-browser-storage-isolation.e2e.mjs
```

quota E2E 观察到第一次写返回 quota 类错误，后续单次 commit 前 OPFS 内容和 IndexedDB retry batch 已可读取；backend revision 最终从 0 到 1，commit 数为 1。backend 重启 E2E 保持原 Workspace revision 1 和文件内容，旧 fencing token renew 为 409，刷新后新 token 为 2，commit 数仍为 1。身份隔离 E2E 在同一 Chrome context 顺序使用两个身份、同一相对路径和不同内容；Workspace ID 与 OPFS 目录不同，IDB snapshot 各自保留，跨身份 manifest/blob 返回 403，刷新后第二身份只读回自己的内容。三条脚本无非同源请求或页面错误。

实现过程中首次运行没有重建 `apps/web/dist`，旧 preview bundle 不认识新增的 Worker fault action，测试请求一直等待；重建 preview 后通过。该 PoC 的 E2E 在源代码改变 Worker 入口后必须先运行 `build:preview`，不能把 Vite 构建缓存当作即时源码。

## 其他检查

- `pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview` 通过，生成当前 preview Worker 与 VFS image。
- `node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs`：15/15 通过。
- `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/browser-native-workspace.spec.ts`：11/11 通过。
- `pnpm exec vitest run --config docs/drafts/browser-native-dsh-poc/vitest.config.ts docs/drafts/browser-native-dsh-poc/tests/durable-workspace.spec.ts`：8/8 通过。
- `pnpm run doc-sync`：42 个门禁通过；repository references 因进度文档引用了基线提交哈希而失败。改为分支与日期描述后，`pnpm run verify-repository-references` 单独复跑通过；未在该纯文本修正后重跑完整 `doc-sync`。
- `git diff --check` 与三条 E2E 的 `node --check` 均通过。

## 限制

- Fault-injected `QuotaExceededError` 只验证错误传播与恢复语义，不证明真实 Chrome quota exhaustion、eviction 或用户磁盘满时的具体行为。
- Worker fault injection 仅在 PoC test MessagePort 下启用；它在真实 Chrome OPFS store 写入前抛出 `DOMException`，不改变普通页面默认行为。
- backend 重启测试针对单进程 PoC JSON store；不证明跨实例 lease fencing 或生产级高可用。
- 同源隔离通过同一 Chrome context 先后更换身份 cookie 验证存储命名与 backend ACL，不构成生产多租户安全审计。
- 真实 LLM、Safari/WebKit、真实配额耗尽、浏览器 eviction 和 OS 级浏览器进程崩溃不在本批范围。

## Dev Note

只记录本批实际执行结果。`QuotaExceededError` 注入、真实 quota exhaustion、backend restart 和同源身份隔离必须分开命名，不可用一种结果代替另一种。当前记录以真实 Chrome E2E 为准；更改 OPFS store、lease persistence 或身份 cookie 路径时，重跑三条测试并核对[PoC README](README.md)、[变更清单](change-ledger.md)及[drafts 索引](../README.md)。
